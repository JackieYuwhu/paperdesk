# PD59 测试版全量验收走查（2026-11-06）

- 基线：`82602a83cfd7fc57bad1e74053e43e27afbcba34`
- 工作区：隔离测试副本（`.nightshift/ISOLATED_TEST_COPY` 存在），数据目录 `.testprofile/data` 未清空、未改动。
- 角色边界：本任务由 integration/advanced 角色执行，permittedTools 不含 `computer` / `tool_gui`，**因此真实窗口点击走查与 PNG 截图未由本角色执行**；本角色完成代码审查、缺陷修复、自动化断言与六项回归，真实窗口结论待 GUI 验收岗位补录（见文末「未执行 / 未修复」）。不得把本文件的自动化结论当作 GUI 截图证据。

## 一、逐项结论

| # | 走查项 | 结论 | 证据 | 修复说明 |
|---|--------|------|------|----------|
| 1 | 知识库：按论文分组、组头完整论文名与条数、Markdown 成文、引用 chip | 通过（代码 + e2e） | `e2e-run2-full.log`：知识库按论文分组 / 组头完整标题与条数 / react-markdown 成文 / 无 `**`、`##`、`|---|` / 引用 chip（Tab.3 · 第 7 页）/ 外链走 openExternal | `.knowledge-group__title` 原 `line-clamp:2` 会把长论文名截成省略号，已删除 clamp 与 `overflow:hidden`，改为 `overflow-wrap:anywhere` 完整换行；`scripts/test-unit.ts` 增断言「PD59：知识库组头显示完整论文名（无 clamp/ellipsis，长名换行）」 |
| 2 | 暂存区：一键批准整批 + 二次确认 + 回显；单条批准不整表 loading、滚动 ≤4px | 通过（e2e） | `e2e-run2-full.log`：一键批准按钮显示待审数、二次确认含条数与未核验风险、回显「已发布 12 · 跳过 1 · 失败 2」并可展开；逐条接受 500ms 内无整表 loading、scrollTop 变化 ≤4px | 无需改代码，PD51 断言已覆盖 |
| 3 | 批处理：同步区仅两按钮、无大段说明、结果内联（成功/跳过/失败与原因） | 通过（修复后 e2e） | `e2e-run2-full.log`：作业卡同时提供知识库与思维地图两个同步按钮；知识库同步内联「成功 N · 跳过 M · 失败 K」；明细可展开；按钮在 1280×800 / 1080×720 不重叠不溢出 | 思维地图同步的 `window.confirm` 文案仍说「只追加」，与按钮 title「覆盖上一次同步」矛盾。已改为「按本次结果覆盖上一次同步到地图的节点（你改过名的节点会保留，手工建的节点不删）」；e2e 增断言文案含「覆盖上一次同步」「改过名」且不含「追加新节点」 |
| 4 | 批处理 → 思维地图：连续同步两次不翻倍（覆盖式，手工节点不删） | 通过（单测；e2e 未直接连点两次） | `scripts/test-unit.ts` 骨架幂等组（applySkeletonToMindMap 二次应用 added=0/removed=0、改名节点保留、手工节点保留）；`src/main/services/mindmap.ts` 以 `syncId` 早退，重复同步返回 added=0/removed=0 | 无需改代码；真实窗口连点两次由 GUI 岗位复核 |
| 5 | 思维地图：三级切换、缩放 −/+/重置 与 Ctrl+滚轮、框选计数、节点文本完整无省略号无 Markdown | 通过（e2e） | `e2e-run2-full.log` M24/PD56/PD57：三级切换与分组禁用原因、100%→110%→100%、Ctrl+滚轮锚点误差 ≤2px、框选 ≥4 且计数与高亮一致、长标题完整显示 scrollWidth≤clientWidth+1、节点正文去除 Markdown 标记 | 无需改代码，PD56/PD57 断言覆盖 |
| 6 | 聚合视图点论文节点开独立窗口，标题含论文名，重复点击复用同一窗口 | **未验证（窗口复用计数）** | e2e 仅断言 `openPaper` 返回 ok + window id、主窗口提示「已在新窗口打开」并含论文标题；未断言重复点击后窗口数不增 | 复用实现位于 `src/main/windows/mindmap-window.ts`，不在 PD59 ownedPaths，本角色未改；见「未修复 / 未执行」 |
| 7 | AI 工具库：分类页签与总数一致、关闭联网搜索后 AI 面板按钮置灰且 title 说明、恢复默认可还原 | 通过（e2e） | `e2e-run2-full.log`：设置里 AI 工具库列出全部工具卡片/开关/分类计数；切「知识库」只显示 2 个工具、翻译分类空态；关闭联网检索后 AI 视图开关禁用并提示「已在 AI 工具库关闭联网检索」，重开立即恢复；一键恢复默认全部启用、权限全开 | 无需改代码。分类计数与工具总数都由 `AI_TOOLS` 派生，`translation` 分类 0 条是设计如此，不构成总数不一致 |
| 8 | AI 入口（未配置模型）：点「AI 优化」「AI 摘要」等给可读提示，不崩溃、不改地图 | 通过（修复后 e2e） | `e2e-run2-full.log`：未配置模型时「AI 优化」仍可点击且 title 含原因；点击后 `mindmap-ai-error` 显示「尚未配置模型服务…」，节点数前后不变；配置模型后按钮恢复可用 | 原先按钮 `disabled` 含 `!modelReady`，导致无法点击、拿不到提示。已移除 4 个 AI 按钮的 `!modelReady` 禁用条件，并在 `runAi` 开头加守卫：未配置模型时只 `setAiError(aiDisabledReason)` + `setAiResult(null)` 后返回，不发 IPC、不改地图；e2e 既有「未配模型即禁用」断言按新契约改写并注明 |

## 二、本次修复清单

1. `src/renderer/src/styles.css`：`.knowledge-group__title` 移除 `display:-webkit-box`、`-webkit-box-orient`、`-webkit-line-clamp:2`、`line-clamp:2`、`overflow:hidden`，保留 `flex:1;min-width:0;overflow-wrap:anywhere`。
2. `src/renderer/src/features/batch/BatchPanel.tsx`：思维地图同步确认文案改为覆盖式语义，并说明保留改过名与手工节点。
3. `src/renderer/src/features/mindmap/MindMapPanel.tsx`：4 个 AI 入口去掉 `!modelReady` 禁用；`runAi` 增加未配置模型守卫，依赖数组补 `modelReady`/`aiDisabledReason`；相关注释同步更新。
4. `scripts/test-unit.ts`：新增知识库组头不截断断言（PD59）。
5. `scripts/e2e.cjs`：新增/改写断言——思维地图未配模型点击提示且地图不变；批处理思维地图确认文案覆盖式；并按新契约改写 PD57「未配模型即禁用」的过期断言。知识库组头换行由单测覆盖。

## 三、回归结果（候选工作区真实执行）

| 命令 | 结果 | 日志 |
|------|------|------|
| `npm run typecheck` | exit 0 | `artifacts/543d4de0-e22c-42dc-bf90-702bdacb5252/typecheck.log` |
| `npm run test:unit` | exit 0（UNIT_OK） | `artifacts/.../test-unit.log` |
| `npm run test:coords` | exit 0（COORDS_OK） | `artifacts/.../test-coords.log` |
| `npm run build` | exit 0 | `artifacts/.../build.log` |
| `npm run test:e2e` | exit 0（E2E_OK，665 行完整日志） | `artifacts/.../e2e-run2-full.log` |
| `node .nightshift/check-isolation.cjs` | exit 0（ISOLATION_CHECK_OK） | `artifacts/.../check-isolation.log` |

说明：`check-isolation` 在仓库 `package.json` 中没有对应脚本，实际命令为 `.nightshift/check-isolation.cjs`（只执行、未修改）。首轮 e2e 的唯一失败是一条新断言把文案「改过名」误写成「改名」，修正断言后复跑通过；应用代码未因此变化。

## 四、未执行 / 未修复

- **真实窗口 8 组走查与五个界面 PNG 截图：本角色未执行。** 角色工具集不含 `computer`/`tool_gui`，无法点击真实窗口或截屏；本文件中的「通过」仅指代码审查与 Electron e2e（渲染进程 DOM/几何）证据，不能替代 GUI 验收。截图与逐项人工结论须由 GUI 验收岗位补录。
- **第 6 项窗口复用计数未验证。** e2e 只验证 `openPaper` 成功与窗口 id；复用逻辑在 `src/main/windows/mindmap-window.ts`，不在 PD59 ownedPaths，本角色不能修改。若 GUI 岗位复现「重复点击窗口数增加」，需由持有该路径的任务修复。
- **`docs/CODE-MAP.md` 未更新。** 该文件不在 PD59 ownedPaths；本次改动未新增跨层入口，映射关系不变。
- 测试副本用户数据未清空；e2e 使用独立临时 `--user-data-dir`，不触碰 `.testprofile/data`。
