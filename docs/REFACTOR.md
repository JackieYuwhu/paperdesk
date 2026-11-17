# PaperDesk 渐进式重构方案（模块划分 / 迁移顺序 / 兼容措施）

> 目标：统一现有代码与界面规范；为后续功能建立**声明式接入**；把耗时操作统一到**批处理/任务系统**；界面改为**顶栏功能区 + 左侧功能面板 + 最大化阅读区**。
> 原则：**保留现有功能、已确定的布局与阅读体验**；不做无必要的全项目重写；每批独立可验证、可回退。
> 回退点：tag `refactor-baseline-20261014`，分支 `refactor/gradual`。

## 0. 当前代码地图（事实）

- `src/main/` 主进程
  - `index.ts` 应用生命周期/窗口/菜单；`modules/index.ts` 模块注册（IPC + 服务）。
  - `ipc/*`：按领域注册 IPC 句柄（library/reader/notes/metadata/translate/search/batch/system/settings/data/app/files/authors/skills/journals/analysis/biblio/connector）。
  - `services/*`：领域逻辑（library/attachments/notes/reader/search/translate/extract/analysis/discovery/biblio/journals/backup/settings/skills/connector/fetch-pdf/sidecar/llm/embed…）。
  - `services/batch/`：批处理（`registry.ts` 任务声明 + `queue.ts` 队列/运行 + `validate.ts` 校验 + `retry.ts`/`batch-*` 纯逻辑）。
  - `db/`：schema、migrate、keys。
- `src/renderer/src/`
  - `App.tsx`：整体布局 + 全局状态（当前文档/译文/视图/面板/缩放/页码…）。
  - `modules/registry.tsx`：右侧面板注册表（`PANEL_GROUPS`/`PANELS`）。
  - `features/*`：各功能面板（library/reader/translate/notes/metadata/discovery/ai/batch/journals/analysis/biblio/files/authors/settings）。
  - `components/`：`Icon` 等公共组件。
  - `shared/*`（在 `src/shared/`）：跨进程类型与纯逻辑（api/types/channels/journals/diff/md-html/md-table/biblio/doc-state/…）。
- `python/app/` 侧车：`translate.py`（PDF/网页译文生成）、`extract.py`、`vision.py`、`structure.py`、`main.py`。
- 测试：`scripts/test-unit.ts`（主进程纯逻辑）、`python/tests/*`、`scripts/e2e.cjs`（端到端）、`scripts/smoke-run.cjs`。

## 1. 状态分层（明确边界，杜绝混用）

| 层级 | 例子 | 存放 |
|---|---|---|
| 全局设置 | 模型服务、mt.workers、off-peak、连接器开关/token | `services/settings`（DB/environment），`PublicSettings` |
| 单篇文档状态 | 视图模式、页码、缩放、面板折叠、附件 | `localStorage` `paperdesk.doc.<itemId>`（`shared/doc-state.ts`） |
| 临时界面状态 | 当前标签、左栏功能选择、吉他选择、busy 标记 | 组件内 `useState`（会话内存，不持久化，除非确有必要） |
| 后台任务状态 | 批处理作业/条目状态、进度、产物路径 | DB `batch_jobs`/`batch_items`（`services/batch`） |

规则：**渲染层只读设置/文档状态/任务状态，不直接改任务状态**；任务状态只由主进程任务系统写。

## 2. 模块职责与边界（目标）

- **文件管理**（library/attachments/import/fetch-pdf）：导入、去重、附件解析、空间目录。对外只暴露 `library.*`/`attachments.*`。
- **阅读与渲染**（reader/coords/pdf 渲染/sync）：PDF 加载、缩放、批注、选区、坐标换算。**纯渲染，不含业务**。
- **翻译**（translate 服务 + `python/app/translate.py`）：保版式 PDF + 可重排网页译文 + 对照；输入附件，输出产物路径与自检。
- **网页处理**（translations HTML + HtmlViewer）：简洁排版 + 公式提取（LaTeX/MathML 结构优先）。
- **公式提取**：`translate.py` 的 `_looks_formula`/`_mathify*`，独立为清晰函数，供网页输出复用。
- **笔记**（notes）：条目笔记 + 独立笔记 + 小节 upsert + 目录。
- **批处理/任务**（batch）：统一耗时任务系统（见 §4）。

## 3. 统一规范

- **命名/目录**：主进程 `services/<domain>.ts` + `ipc/<domain>.ts`；渲染层 `features/<domain>/`；跨进程契约集中在 `src/shared/api.ts` + `types.ts`；纯逻辑放 `src/shared/*.ts` 且必测。
- **IPC/错误/日志**：所有 IPC 通过 `CH` 常量；错误统一 `Error(message)`；主进程统一 `console.log('[paperdesk] …')`，渲染层错误统一走 `ErrorBoundary` + 全局 `onerror/unhandledrejection`。
- **配置**：统一 `effective('key', 'PAPERDESK_ENV', 'default')`；不散落 `process.env` 读取。
- **UI 复用**：按钮/图标/间距/字体/工具栏/加载/进度/错误提示统一走 `components/` 与 `styles.css` 的变量与类；**不新增一次性样式**。
- **清理**：删除已确认的重复/废弃逻辑（如无引用的 `SplitPdfView`、过期面板分支），但**不为形式统一引入过度抽象**。

## 4. 批处理 = 统一耗时任务系统

现状已具备：`registry.ts` 声明任务（id/title/input/paramFields/run/finalize），`queue.ts` 队列（并发、低峰、进度、取消、重试、恢复），`batch_*` 表。目标完善：
- **单次与批量共用核心**：把「单个文件执行」也走同一个 `task.run`（封装 `runTaskOnce(taskId, input)`），批量只是它的多次调用；避免两份实现。
- **任务声明扩展**：`BatchTaskHandler` 增补 `resources?: {cpu:number; model?:boolean}`、`batchable?: boolean`、`supportsPause?: boolean`；并发按资源需求分配；低峰门控保留。
- **入口统一**：面板提供「立即执行 / 加入批处理」两个入口；是否进队列**不只看文件数**（单文件耗时任务也能入队）。
- **与界面解耦**：任务在主进程队列运行，切换文档/关闭面板不中断（已具备）。
- **任务状态机**：`queued|scheduled|running|done|failed|cancelled`；进度/阶段/产物路径/失败原因齐全；**无可靠进度就不显示百分比**（用阶段文本或不确定进度条）。
- **重试/取消/隔离/冲突**：单项失败不影响其他项；重试只针对失败项（已有 `retryTargets`）；重复提交与输出文件名冲突要明确规则（如产物目录按 `jobKey` 隔离）。
- **重启恢复**：启动时 `initBatch` 把 `running` 且能恢复的置回 `queued`；**不能恢复的**标记为失败并给出原因，**不得直接置为 running**。

## 5. 扩展接入方式（声明式）

- 收敛为**功能模块声明**（渲染层）：`FeatureModule { id, title, icon, group, mount(params), actions?, batchTaskId? }`；顶栏功能区、左栏面板、批处理入口都从声明生成，**新增功能不再到处改条件判断**。
- 主进程侧：`Module { id, title, registerIpc() }`（已存在，继续沿用）。
- 批处理任务：在 `registry.ts` 增加一个 `BatchTaskHandler` 即自动出现在批处理面板的「任务」下拉。
- **演示**：以现有「论文拆解（analyze-paper）」为例说明「面板 → 立即执行 / 加入批处理」如何共用核心并只声明一次。

## 6. 迁移顺序（分批，每批都可独立验证/回退）

- **Batch A（本批）：界面结构 —— 顶栏功能区 + 左侧功能面板，去掉右栏**
  - 顶栏两行：① 文件标签；② 公共工具栏（模式/页码/查找/联动/缩放）+ **功能区切换**（分组与面板按钮，来自 `PANELS` 声明）。
  - 左栏 = 功能区：默认「文件库」，可由顶栏切换为 目录/笔记/元数据/问答/翻译/拆解/文献网络/期刊/批处理/设置 等（**复用现有面板组件**）。
  - **移除 `.rightcol`**，阅读区宽度最大化（对照阅读更舒展）。
  - 兼容：保留 `ribbon-groups`/`ribbon-panels`/`openPanel` 语义（只是位置移到顶栏）与所有面板 testid；更新 e2e 中依赖「右栏折叠条」的断言。
- **Batch B：状态分层落地** —— 把 `App.tsx` 里混在组件上的持久化/临时状态按 §1 归位；抽出 `useDocState`/`usePanels` 等 hook，减少巨型组件。
- **Batch C：渲染层功能声明化** —— `features/registry` 声明化，顶栏/左栏/批处理入口由声明生成；接入一个既有功能做示范。
- **Batch D：批处理任务系统完善** —— §4（单次/批量共用、资源并发、暂停能力标注、重启恢复规则、入口统一）。
- **Batch E：规范收口** —— 命名/日志/错误/配置统一；清理废弃逻辑；补开发文档。

## 7. 每批验收（不得只靠单测）
- 阅读、翻译、笔记、文件切换、批处理 功能不回归。
- 单次与批量结果一致；批处理期间仍能正常阅读/缩放/切换论文。
- 取消/失败/重试/重启后的任务状态正确。
- 新增一个功能可通过统一接口接入顶栏与批处理，且无需大范围改旧代码。
- 性能结论必须有测量依据，不以行数减少为证据。

## 8. 新增功能 + 批处理接入（简短开发文档）

**新增一个面板功能**
1. 建 `features/<domain>/<Name>Panel.tsx`（接收 `PanelContext` 字段）。
2. 在 `renderer/src/modules/registry.tsx` 的 `PANELS` 加一行（id/title/icon/group/render）。
3. 顶栏功能区与左栏切换自动生成；无需改 App 的条件分支。

**让一个功能进入批处理**
1. 在主进程 `services/batch/registry.ts` 增加一个 `BatchTaskHandler`：`{ id, title, input:'attachment'|'item', paramFields, run(input, ctx), finalize? }`。
2. 若该功能也有「单次执行」入口，**复用同一个 `run`**（把单次调用也走任务核心，勿写第二份逻辑）。
3. 在面板里提供「立即执行 / 加入批处理」两个按钮：前者直接调服务，后者调 `window.api.batch.create({task:id, scope, params})`。
4. 需要资源/并发/暂停能力时，在任务声明里补 `resources/batchable/supportsPause`。
