# PaperDesk 交接文档（上下文压缩）

> 精简记录：目标、架构、设计决策、踩过的坑、当前状态、待办。续做时先读本文件。

## 0. 一句话

自研桌面工具：**论文阅读 / 批注 / Markdown 笔记 / 作者与引用识别 / 相关论文 / 保版式翻译(含 HTML) / 全文检索与问答(含语义) / 批处理**。
位置：`C:\Users\YOUR_USER\paperdesk`（Electron + React + TS；Python sidecar）。

## 1. 运行与测试

```powershell
cd C:\Users\YOUR_USER\paperdesk
npm run dev            # 开发（会开 DevTools）
npm run sample         # 生成样例论文 samples/sample-paper.pdf

npm run typecheck      # TS 类型
npm run test:coords    # 坐标转换单测
npm run test:py        # IMPORT + EXTRACT + TRANSLATE + EXPORT 自测
npm run smoke          # DB：关键表齐全 + 增删/FTS 可用（ELECTRON_RUN_AS_NODE）
npm run test:e2e       # 端到端（真实 App + CDP，M1–M12），期望 E2E_OK
npm run test:net       # 真实 OpenAlex 连通（可能 429）
npm run shots          # 各界面截图到 .shots/
npm run build / dist
```
环境：Node 25 / npm 11；Python 3.13 + fastapi/uvicorn/pymupdf/httpx（已装）；Electron 二进制已用 npmmirror 镜像装好。
数据目录：`%APPDATA%\paperdesk\data`（`library.sqlite`、`storage/`、`notes/`、`translated/`、`batch/`）。

## 2. 目录与模块

```
src/main/
  db/         schema.sql（全部 IF NOT EXISTS）+ index.ts（含 migrate() 补列）+ keys.ts
  modules/    模块注册中心（新增功能加一行）
  ipc/        library attachments reader notes metadata discovery translate search batch system settings app
  services/   storage extract discovery translate search ai embed export llm settings / batch/{types,registry,queue}
  sidecar/    Python 进程管理（懒启动/随机端口/健康检查/PAPERDESK_PARENT_PID 看门狗）
src/preload/  contextBridge 暴露 window.api（类型契约在 src/shared/api.ts）
src/renderer/src/
  modules/registry.tsx        面板注册表（PANELS）
  features/  library reader notes metadata discovery ai translate batch settings
  components/Icon.tsx         内联 SVG 图标
python/app/  main.py extract.py translate.py export.py embed.py grobid.py crossref.py mineru_engine.py pdf2zh_engine.py
python/tests/ test_import.py test_extract.py test_translate.py test_export.py
scripts/     smoke.cjs e2e.cjs shot.cjs devcheck.cjs make-sample.py net-check.cjs test-coords.ts
docs/EXTENDING.md   扩展指南（加模块/面板/批处理任务的步骤）
```

**主进程模块**：library / attachments / reader / notes / metadata / discovery / translate / search / batch / system / settings / app / files / authors
**右侧面板（8 个）**：笔记 | 元数据 | 相关论文 | 问答 | 翻译 | 作者 | 文件 | 批处理
**左栏**：品牌 + 设置 + 导入 + 全文搜索 + 文库列表（划词翻译已移出到右侧「翻译」面板）
**阅读器**：`pdf.js`（canvas + TextLayer + 自绘批注层），顶部 sticky 工具条（翻页/缩放，默认按宽度自适应），视图三态 原文 / 译文PDF / 网页(HTML)

## 3. 数据模型要点

- 对外一律用 `key`（8 位），不用自增 id。
- 批注**存库不存 PDF**：`annotations(type,text,prefix,suffix,comment,color,page_index,position JSON{rects},sort_index)`；
  坐标存 **PDF 用户空间点**（与缩放/DPR 无关）：存 `PageViewport.convertToPdfPoint`，渲染 `convertToViewportPoint`（v6 无 Rectangle 版）。
- 笔记正文落 `data/notes/<key>.md`（YAML front-matter）；深链 `paperdesk://open?attachment=KEY&page=N&annotation=KEY`；已注册系统协议。
- 统一 ID 层：`works(doi/openalex_id/s2_paper_id)` + `item_works`；`citations(source_item_id,target_work_id,target_raw,ref_index,resolved)`。
- 检索：`items_fts` / `chunks_fts` / `notes_fts`（FTS5）；语义：`chunk_embeddings(chunk_id,model,dim,vector BLOB)`。
- 翻译：`translations(..., path=PDF, html_path=HTML)`；批处理：`batch_jobs` / `batch_items`。
- 设置：`settings(key,value)`；密钥用 Electron `safeStorage` 加密（`enc:` 前缀）。
- **`CREATE TABLE IF NOT EXISTS` 不会加列** → `db/index.ts` 的 `migrate()` 负责补列。

## 4. 关键设计与已做的取舍

- **统一模型服务**：设置里「模型服务」一处配置（`provider.baseUrl/apiKey/chatModel/embedModel/mtModel/mode`）。
  解析顺序：设置 > 环境变量 > 默认；`mode=auto` 时**配了 key 就自动走真模型，否则离线 mock**。
- **OpenCode Go 合规**：识别 `opencode.ai` 或 `/zen/go` 路径后自动加
  `User-Agent: PaperDesk/0.1 (research-paper-desktop-app)` + `x-opencode-session`（会话按用途：`tr-<附件key>` / `selection` / `chat` / `batch-<jobId>` / `embed`）；
  走 `/responses`（grok-*、gpt-*luna、muse-spark）或 `/messages`（claude-haiku*、minimax-*、qwen3.*）的模型会在**每条路径提前报错**并给出替代建议。
  设置里有「填入 OpenCode Go 预设」。
- **翻译**：整篇翻译走 **sidecar 后台任务 + 轮询**（`/translate/start|status|cancel`），避免长请求触发 Node fetch 超时（`fetch failed`）；
  加载动画为**真实进度条**（分析版面→翻译中 n/total→重排版面→生成网页）+ 已用时长 + 取消；
  产物：保版式 PDF + **自包含 HTML**（可「浏览器打开」「另存为 HTML」）；真模型按 24 段/批调用。
- **划词翻译**：选中文字 → **自动切到右侧「翻译」面板**并在顶部显示原文+译文（防抖 450ms）。
- **失败不再静默**：模型 4xx/5xx 会把 `error.message` 提取出来显示；不再"看起来成功其实是原文"。
- **相关论文**：OpenAlex（429 会重试）→ 失败回退 **Crossref**（仅参考文献）→ 仍失败给明确提示；设置里可填 OpenAlex 邮箱。
- **批处理**：任务可注册（translate/export-doc/find-related/decompose/compare/embed），`paramFields` 支持 select/text/**textarea+presets**，可选 **`finalize(ctx, results)`** 跨条目汇总（对比表 md+csv）；
  队列含并发、进度事件、持久化恢复、**低峰时段调度**（`batch.offPeakStart/End/offPeakOnly`，支持跨午夜）。
- **UI**：设计令牌 + `html[data-theme]` 明暗主题；右侧面板**懒挂载+保活**（切标签不丢状态）；阅读器按宽度自适应。
- **向量**：默认 `embed.mode=local`（sidecar 离线哈希向量，64 维），与「模型服务」解耦；OpenCode Go 无 embedding，不要默认走 provider。
- **文件**：所有 `fs:*` 路径都经 `resolveSafe` 限制在 `data/` 根内；`code` 打开失败自动回退系统方式。
- **作者**：OpenAlex 为主，失败/离线回退本地 `authors`+`item_authors`；`local:<id>` 表示本地作者。

## 5. 踩过的坑（务必避免重复）

1. **编辑时把换行吃掉**（发生过两次）：`-- 注释` 与 `CREATE TABLE` 合并 → 表被注释掉；`@app.post(...)` 与 `def` 合并 → Python 语法错误。
   → 教训：**不要做只删一个换行的编辑**；改完必须跑 `npm run smoke`（表清单）与 `npm run test:py`（含 `IMPORT_OK` 路由自检）。
2. `CREATE TABLE IF NOT EXISTS` 不加列 → 用 `migrate()`。
3. pdf.js v6：`render()` 的 `canvas` 必填；销毁用 `loadingTask.destroy()`；TextLayer 需要 `--total-scale-factor`。
4. `react-markdown` 默认过滤非白名单协议 → 自定义协议要 `urlTransform={(u)=>u}`。
5. Node `fetch` 默认超时导致长请求 `fetch failed` → 改后台任务+轮询。
6. 我曾在用户真实配置里写入过测试值（已清理，但**用户的 provider.apiKey 需要重新填**）。
7. **PyMuPDF `get_text("blocks")` 的块序本身即内容流/阅读顺序**（单栏时若再按 y 排序，会把「写在上方的标题」排到正文前面，导致 References 被推到末尾而切不出条目）→ 只有**双栏**才按「列桶 + 列内 y」重排。
8. **相关论文合并**：在线图的参考文献 id（OpenAlex `Wxxx`）与本地 `citations` 的 `doi:` id 体系不同，直接并入会**重复节点** → 联网成功时只并入「同作者」本地节点。
9. **Crossref 默认开启**要配**总时间预算**，否则离线时 12×超时会拖死每次导入后的自动识别。

## 6. 当前状态

M1 批注 / M2 笔记深链 / M3 作者引用 / M4 相关论文 / M5 翻译(HTML+进度+取消) / M6 检索RAG / M7 模块化+设置 / M8 UI / M9 语义检索 / M10 批处理 / M11 划词翻译(确认后译+部分翻译) / M12 失败可见性+数据源回退 / M13 名词解释+本地兜底+文件树+向量默认 / M14 文件↔阅读器 + 作者关联本地 / M15 笔记↔文件 + 作者整理(ORCID) + Crossref 并发 / M16 译文定位 + 按 ORCID 导入作者 / M17 层级空间 + 元数据条目预览/删除 + 公式定理提取 / M18 视觉识别翻译 + 视觉元数据
—— **全部实现**，`typecheck / coords / py / smoke / build / e2e` 全绿（`E2E_OK`，含 M1–M18 断言）。

## 7. 已完成（上一轮 6 条待办，全部落地）

1. **批注不透明度**：`.ann--highlight` 加 `opacity:.32`（hover 提到 `.5`），正文不再被盖住。
2. **元数据提取质量**：
   - `extract.py` 改为**按分栏阅读顺序**取文本（`page_reading_text`：双栏按「左栏→右栏 + 列内 y」重排；单栏保持 PyMuPDF 原块序，避免破坏内容流顺序）。
   - 加**标题/作者启发式**（`infer_title_authors`：首页最大字号块=标题，其下方首个「姓名风格」行=作者），仅在 Info 缺字段时启用；`parse_authors` 兼容 `A, B`（人名）与 `Zhang, Alice`（姓,名）。
   - **Crossref 消解默认开启**（`metadata.crossref=1`，`crossrefLimit=12`，单次超时 5s + 总预算 15s；离线自动跳过），`resolvedCount` 不再为 0；设置里可关。
   - **向量默认本地**：新增 `embed.mode = local(默认) | provider | off`；`local` 走 sidecar 离线哈希向量，**永不因缺 embedding 报 400**；UI 增加「向量服务」选择。
3. **相关论文**：`discovery.graph(itemId, source)`，`source = auto | openalex | ai`；
   - **本地库兜底**（`localGraph`：`citations`+`works`+同作者条目）——任何数据源都会并入，列表不再为空；
   - **AI 辅助**（`aiGraph`/`aiSuggest`：标题+摘要+片段 → 模型建议 JSON → 尽力 Crossref 解析 DOI，节点标「AI 建议」）；
   - 面板加**数据源切换**（自动 / OpenAlex / AI 辅助），新增节点类型 `ai` / `library`。
   - 注意：联网成功时**只并入「同作者」本地节点**（`mergeLocal(..., false)`），避免与 OpenAlex 参考文献重复。
4. **问答加「名词解释」**：AI 面板任务切换（问答 / 名词解释）；`ai.ask(q,{task:'term'})` 结合论文上下文解释术语；离线 mock 用命中的句子组「上下文释义」。
5. **VSCode 式打开 + 文件可视化**：新「文件」面板（`fs:list/open/reveal/vscode`，`data/` 目录树，双击进入/打开，行内「打开/VS Code/资源管理器」按钮）；
   - `code <path>` 打开，找不到时回退系统方式（`openInVSCode` 返回 `{ok,fallback}`）；路径限制在 `data/` 内；
   - **双击库内 PDF 直接在本应用阅读器打开**（`attachments.getByPath` 按 `attachments.path` 反查 → `onOpenTarget`），非库内文件交给系统；
   - 左栏新增「批量导入文件夹」（递归收集 PDF，逐个导入 + 后台识别）。
6. **作者信息搜索**：新「作者」面板 + `authors` 服务（OpenAlex `/authors?search=` + `/authors/{id}/works?sort=cited_by_count:desc`），展示 h 指数/被引/工作数/代表作；离线用本地 `authors`+`item_authors` 兜底；代表作可一键「加入文库」。
   - **关联/合并本地作者**：`authors.link` 把 OpenAlex 作者按 `openalex_id` → ORCID → 同名写入本地 `authors`，并把同名重复记录的论文合并到主记录后删除重复项；搜索结果标「本地已有」。

## 8. 已完成（第三轮 3 条）

- **文件面板 → 笔记面板**：`notes.getByPath` 反查 `md_path`；双击 `.md` → 切到「笔记」面板并选中其条目（`onOpenPanel` 注入面板上下文）。
- **整理本地作者**：`authors.cleanup` 合并同名（大小写不敏感，优先保留带 ORCID 的一条）重复记录，并对有 ORCID 但缺 `openalex_id` 的作者按 `filter=orcid:` 从 OpenAlex 补齐（联网限量、失败即停）；作者面板「整理」按钮触发。
- **Crossref 并发化**：`extract` 里参考文献消解改为 `ThreadPoolExecutor`（最多 6 并发、单次 5s、总预算 15s），离线时不再串行累加超时。

## 9. 已完成（第四轮 2 条）

- **文件面板 → 译文视图**：`translate.getByPath` 按译文产物路径（`translated/<key>.<lang>.pdf|html`，兼容裸文件名）反查 `translations` 并带出所属条目；双击 `translated/` 下的 PDF/HTML → `onOpenTranslation(target, 'pdf'|'html')` + 切到「翻译」面板；App 用 `pendingView` ref 让视图切换在附件变更后仍生效（不会被重置为原文）。
- **按 ORCID 批量导入本地作者**：`authors.importByOrcid` 解析逗号/分号/空白/换行的 ORCID，逐个用 OpenAlex `/authors?filter=orcid:` 查询并写入本地 `authors`（已存在则补 `openalex_id`）；含格式校验、幂等、网络失败即停；作者面板新增输入框 + 「导入 ORCID」按钮。

## 10. 已完成（第五轮 3 条）

- **翻译：全文 + 部分，且确认后才译**：阅读器选中文字后不再自动翻译——浮动条上出现「翻译选中」，点击后把文本送到「翻译」面板；面板需再点「翻译」确认才调用模型。工具栏新增「译本页」（部分翻译当前页）。`PanelContext` 用 `partial:{text,kind}` 取代 `selectedText`。
- **层级「空间」+ 预览 + 删除**：
  - DB 加 `items.parent_id` / `items.space_path`（含 `migrate()` 补列）。
  - 每个条目一个空间目录：顶层 `spaces/<key>/`，**相关论文/AI 建议加入文库时归入父空间** `spaces/<父>/children/<key>/`；写入 `item.md`（元数据/DOI/摘要/参考文献/子条目/笔记链接），由 `services/spaces.ts` 维护。
  - 左栏文库改为 **Obsidian 式层级树**（展开/收起、缩进、悬停删除）。
  - `library.delete`（级联附件/批注/引用/分块 + 删除空间目录；子条目上移父级）；`library.addMetadata` 支持 `parentId`。
  - 无 PDF 的元数据条目在主视图显示 **预览卡片**（`ItemPreview`）：标题/作者/摘要（`library.enrich` 从 Crossref/OpenAlex 补齐）/DOI/参考文献/子条目/删除/Scholar 搜索。
- **公式 & 定理快速提取**：新增 `python/app/structure.py` + `/structure` 路由（识别公式行/编号、Theorem|Lemma|Definition|… 环境及陈述），TS `metadata.structure`，元数据面板新增「公式/定理」按钮与可复制列表。新增 `python/tests/test_structure.py` 并接入 `test:py`。

## 11. 已完成（第六轮 1 条：视觉识别，解决扫描件）

用户反馈「全文翻译 / 元数据用不了」——根因多为 PDF **无文本层（扫描件）**，本地文本抽取拿不到内容。新增**多模态视觉通路**（用支持视觉的模型，如 deepseek-v4.1-flash）：

- `python/app/vision.py`：
  - `render_pages_b64`：页 → PNG(base64, 150dpi)
  - `chat_vision`：OpenAI 兼容 `/chat/completions`，`content` 数组（文本 + `image_url` data URL）
  - `translate_pdf_vision`：逐页「模型看图 → 输出译文 Markdown」→ 组装为文本 PDF（字号自适应，CJK 用 `china-s`），返回 `engine=vision`；后续 HTML 导出沿用既有流水线
  - `extract_metadata_vision`：读首页图片 → 严格 JSON {title,authors,abstract,year,venue,doi}
- `main.py`：`/translate` 与后台任务支持 `engine=vision`；新增 `/vision/metadata`
- `extract.ts`：本地抽取后若**缺标题/作者**（或显式 `forceVision`）且已配置模型 → 调 `/vision/metadata` 补齐（`persist` 现在也会写入 abstract/year/venue）
- 设置里引擎新增「视觉识别（模型读图，适合扫描件）」；翻译面板也加了下拉可直接选；元数据面板加「视觉识别」按钮
- 内置引擎在**检测不到文本层**时会给出「建议改用视觉识别」的告警
- 新增 `python/tests/test_vision.py`（monkeypatch `chat_vision`，离线验证）并接入 `test:py`

## 12. 已完成（第七轮：翻译/元数据故障定位）

用户反馈「全文翻译 / 元数据用不了」，且 PDF 来自网络/学术网站（非扫描件）。E2E 证明**链路本身是通的**（mock 模型可跑），因此问题多在**配置/端点/PDF 结构**。做了两件事：

- **翻译自检**：sidecar 新增 `POST /inspect`（页数 / 文本层字符数 / 文本块数 / 是否扫描件）；主进程 `translate.diagnose` 汇总成体检报告：文本层统计 + 是否已配置模型 + 引擎 + 模型 + **端点兼容性**（走 `/responses`·`/messages` 的模型会被点名）+ 结论。翻译面板加「翻译自检」按钮，**翻译失败时自动体检**；译文结果处显示「引擎 / 后端」，`backend=mock` 时明确警告「离线占位（未调用模型）」。
- **不再静默输出原文**：
  - `simple_translate` 逐页比较覆盖前后的文本量，若原文基本没被覆盖（典型：文本在 **Form XObject** 嵌套对象里），给出告警并建议「视觉识别」。
  - 模型返回**空内容**时不再静默保留原文，而是显式报错（提示可能是模型/端点不兼容）。

### 已知常见原因（自检会直接点出）
1. **未配置模型**：`mtConfig().backend=mock` → 译文是「[ZH] + 原文」的占位，看起来像没翻译。
2. **模型端点不兼容**：OpenCode Go 上 `grok-4.*` / `gpt-*-luna` / `muse-spark` 走 `/responses`，`claude-haiku*` / `minimax-*` / `qwen3.*` 走 `/messages`；本应用只实现 `/chat/completions` → 会被 `openCodeEndpointHint` 提前拦下并给替代建议。
3. **PDF 文本在 Form XObject**（部分出版社排版）：`apply_redactions` 覆盖不掉原文 → 译文与原文重叠。
4. **模型返回空/截断**：批量 JSON 数量不符会回退逐条；仍失败即报错（不再吞掉）。

## 14. 已完成（第八轮：UI/翻译质量/并发，7 项反馈）

1. **批处理"消失"**：`rightcol__tabs` 用了 `overflow-x:auto` + 隐藏滚动条，8 个标签时末尾（批处理/文件）被滚出视野 → 改为 `flex-wrap: wrap`（全部可见）。
2. **译文丢失 / 网页排版差**：`_fit_text` 放不下时退化成「单点写入」→ 长译文只留一行、大量丢字。改为**按行数估算 + 逐级缩小字号 + 向下扩展盒子**（不再丢字）；并**由译文直接生成结构化 HTML**（标题层级按原字号推断，`_write_translation_html`），vision 引擎也用 markdown→HTML（`_write_vision_html`）。`translate.ts` 优先采用 sidecar 产出的 HTML，缺失才回退从 PDF 反解。
3. **公式渲染 + 滑块**：元数据面板公式改用轻量 **LaTeX→HTML 渲染**（上下标 `<sub>/<sup>`、希腊字母、`\frac`、运算符转 Unicode），加**字号滑块**与**折叠**；定理区同理。
4. **定理中英对照**：每条定理有「译」按钮，「翻译定理」可批量（走统一模型服务，离线为占位）。
5. **框架 & 菜单**：Electron + React + TS（electron-vite）；Python FastAPI sidecar。"File Edit View Window" 是 **Electron 默认菜单**；已 `buildMenu()` 替换为精简中文菜单（PaperDesk / 编辑 / 视图）。
6. **翻译提速**：内置引擎批量翻译改 **ThreadPoolExecutor 并发**（默认 4，`mt.workers` / `PAPERDESK_MT_WORKERS` 可调）；视觉引擎逐页**并发**（默认 4）。
7. **页面看不全**：面板工具条不换行导致控件被裁 → `.panel__bar { flex-wrap: wrap }`；`.toolbar` 同理；`.viewer` 居中溢出裁剪改 `justify-content: safe center`。

## 16. 已完成（第九轮：译文 PDF 空白根因）

用户反馈「自检正常（12 页 / 66197 字符 / 340 块 / 引擎 simple / deepseek-flash / chat/completions），但译文文件所有文本似乎全部丢失」。

**根因（真 bug）**：内置引擎回填中文用的是 **PyMuPDF 内置 `china-s` 字体，它是不嵌入的 CID 字体**——文字能被抽取（所以自检文本层正常），但 **pdf.js 等查看器渲染为空白**，表现为「文本全丢」。E2E 只校验 `.textLayer` 文本内容，没校验字形渲染，所以没暴露。

**修复**：
- `translate.py` 新增 `cjk_fontfile()` / `cjk_fontname(page)`：自动找系统 CJK 字体（Windows 微软雅黑/黑体、macOS PingFang、Linux Noto/文泉驿），用 `page.insert_font(fontfile=…)` **嵌入**，`save` 前 `doc.subset_fonts()` 子集化（12MB → ~43KB）；找不到系统字体才回退 `china-s`。
- `_fit_text` 与 `vision._write_text_pdf` 都改用该字体。
- 新增 `python/tests/test_cjk_font.py`（断言页面字体 `ext != 'n/a'` 且渲染出非空像素）并接入 `test:py`。

## 17. 已完成（第十轮：6 项反馈）

1. **译文 PDF 版式**：`_fit_text` 新增 `max_h`（= 到下一块之间的空隙），回填时按纵向排序、只向下扩展到空隙、不再压到下一块；字号档位重排（优先可读字号）。
2. **OpenAlex「没作用」根因 = 429 限流**：实测 `/works/doi:` 200（拿到 36 条引用），但随后 `/works?filter=` 直接 **429**。修复：新增 `openalex.apikey` 设置 + 请求带 `api_key`；`oaGet` 全局**串行队列 + 间隔 + 尊重 Retry-After**（重试 4 次）；OpenAlex 参考文献为空时**用 Crossref reference 补充**；新增 `discovery.diagnose` + 面板「自检」按钮。
3. **作者改「外部/AI 搜索」**：新增 `authors.forItem`——优先 OpenAlex（DOI→标题），其次**视觉识别首页（AI）**，最后本地兜底；作者面板初始填充用它 + 本文作者可点击 chips。
4. **批处理多选**：`CreateBatchInput.scope` 新增 `'select'` + `itemIds[]`；面板加「多选条目」+ 筛选/全选/清空/勾选列表。
5. **划词浮条加 AI**：选区浮条新增「问 AI」「名词解释」；经 `PanelContext.aiRequest` 送 AI 面板并自动执行。
6. **译文网页排版**：`_write_translation_html` 重做（标题层级/公式块/段落合并/分页/衬线排版）；vision 也用 markdown→HTML。

## 18. 已完成（第十一轮：UI/交互，7 项反馈）

1. **阅读器**：工具栏加**缩放滑块**（50–400%，与翻页并存）、**页码跳转**（输入+回车/按钮）、**本页词语查找**（高亮 + 上/下一个 + 命中计数）。
2. **可拖拽分栏**：左/右栏之间加 `.splitter`（VSCode 式），宽度存 localStorage（`paperdesk.ui.sbW/rcW`）。
3. **相关论文**：结果**缓存**到 `api_cache`（`discovery:<itemId>`，打开即读缓存，一篇查一次即可）；把「数据源选择」与「查询」解耦——改为显式**「开始查询」**按钮（切数据源不再自动查）。
4. **Office 式两层功能区**：`PANEL_GROUPS`（阅读 / 研究 / 数据）+ 每个面板 `group`；右栏两行（第一层分组、第二层该组面板），两行均可横向滚动。
5. **窗口主题**：`nativeTheme.themeSource` 跟随应用明暗（浅色模式不再黑边框/黑标题栏），窗口 `backgroundColor` 同步。
6. **边缘代理 502（真 bug）**：`httpx` 默认 `trust_env=True` 会把连 `127.0.0.1` 的请求也走系统代理 → 502（本地 sidecar/模型端点全挂）。新增 `python/app/_http.py`：**本地地址禁用 trust_env**，远程保持默认；translate/embed/vision/crossref/grobid 全部改用。新增 `python/tests/test_http.py`。
7. 原「功能栏两行但无关」「浅色黑边框」由 4、5 覆盖。

## 20. 已完成（第十二轮：连续滚动阅读）

用户澄清：不是要「缩放滑块」，而是要**页面上下滑动**的阅读方式；缩放滑块去掉。

- **去掉**工具栏的缩放滑块（`readerbar__slider` / `zoom-slider`）。
- 阅读器新增**模式切换：翻页 / 滚动**。
  - `滚动` 模式 `ScrollPages`：所有页面**纵向堆叠**，`IntersectionObserver` **懒渲染**（canvas + 文本层），可上下滑动连续阅读；支持**文本选择→翻译/问AI、批注层、词语查找（跨页）、批注点击弹层**；滚动时**页码指示条同步**；页码跳转/深链会滚动到目标页；按宽度自适应。
  - 修了一个切换坑：`scrollMode` 变化需让单页渲染 effect 重跑（否则切回翻页时画布/文本层空白）。
- E2E **M20** 改为：分栏分隔条、切滚动模式（`.scrollpages .scrollpage` 数=页数、可滚动容器）、切回翻页、页码跳转、跨页查找。

## 22. 已完成（第十三轮：滚动与翻页共存 + 手势缩放）

用户澄清：不要「滚动/翻页」二选一的开关，要**同一视图里两者都能用**；并且要**手势缩放**。

- **合并为单一阅读视图**：去掉模式开关；阅读器**始终是连续滚动**（所有页纵向堆叠、懒渲染），同时**页码导航完全可用**——上/下一页、页码跳转、深链都会**滚动定位**到目标页；滚动时**页码自动同步**。即"滚动 + 翻页"共存。
- **手势缩放**：`.reader` 上挂**非 passive 的 `wheel` 监听**，`Ctrl+滚轮`（触控板捏合会映射为 ctrl+wheel）按比例缩放；与 `−/百分比/+` 共存；拖动/滚轮（不加 Ctrl）仍是滚动。
- **自适应比例显示修正**：自适应宽度时，百分比显示真实的 fit 比例（`onFitScale`），修复"显示 130% 实际 97%"导致的缩放不变性测试偏差。
- **渲染健壮性**：把「页面尺寸 + 自适应比例」一次算好（`layout`），渲染只跑一轮；**首屏页（1、2）立即渲染**，其余懒加载；用 `gen` 代际避免并发渲染竞争。
- **闪烁定位修复**：`onOpenAnn`/`onSelection` 改为 `useCallback` 稳定引用（原来内联箭头导致批注层每次渲染重建、闪烁类被清掉）。
- 切换原文/译文时页码重置为 1。
- E2E 相应更新：注释计数/盒子定位到 `[data-ann="0"]`；**M20** 改为「连续滚动 + 页码导航共存、Ctrl+滚轮手势缩放生效、跳页、查找、分栏」。

## 23. 已完成（第十四轮：连续滚动的空白/裁切修复）

用户截图显示「每页只有一条（只露出页眉 Article）」。真因：`.scrollpages` 是 `flex-column` 且设了 `max-height`，**flex 子项默认 `flex-shrink:1`**，页面被压成扁条、内容被 `overflow:hidden` 裁掉。逐项修复：

1. `.scrollpage { flex: 0 0 auto }` —— 禁止收缩，保留纸张比例（**关键修复**）。
2. `.scrollpages { overflow-y: scroll; scrollbar-gutter: stable }` —— 固定滚动条占位，避免"出现滚动条→宽度变→重算→抖动"导致渲染被反复取消（表现为空白）。
3. 懒渲染：页数 ≤ 40 **一次性全部渲染**（3 并发），>40 才用 IntersectionObserver（rootMargin 1500px）。
4. `ResizeObserver`（去抖）在容器宽度变化时重算「适应宽度」。
5. 页码跳转/深链：程序化滚动期间**持续抑制「滚动同步」直到到位**，避免与同步互相打架（深链跳页失败）；闪烁改用即时滚动。
6. E2E M20 增加断言：`页面未被压扁（h/w > 0.4）`。

## 24. 已完成（第十五轮：手势缩放流畅度）

用户反馈「手势缩放反馈太慢」。根因：**每一下 Ctrl+滚轮都会触发整轮页面重渲染**（12 页 → 每次都重画所有 canvas）。

- 拆成两个比例：**`liveScale`（即时）** 与 **`renderScale`（防抖提交）**。
  - 滚轮/按钮先即刻改 `liveScale`，通过外层 `.scrollpages__inner` 的 `transform: scale(k)`（k=live/render）**纯 CSS 即时缩放**，不重渲染；
  - 手势停止 **180ms** 后防抖提交 `renderScale`，才做一次**清晰重渲染**（k→1）。
- 修复过程中还踩到两处：`.scrollpages` 的 `flex-shrink`（页面被压扁）+ 滚动条出现导致的宽度抖动（用 `overflow-y: scroll; scrollbar-gutter: stable` 稳定），以及深链与滚动同步互相打架（跳页期间持续抑制同步直到到位）。
- 注意：**不要用 PowerShell `-replace`+`Set-Content` 改本仓库源文件**——会把 UTF-8 中文注释/字符串转成乱码并吞换行（本次 `PdfViewer.tsx` 因此重写）。

## 26. 已完成（第十六轮：笔记/对照/复用/翻译稳定性，5 项）

1. **笔记 = 纯 Markdown**：`notes/<key>.md` **不再写 YAML front-matter**（元数据只在库里），可直接用 VS Code / 黑曜石打开；笔记面板顶部显示文件路径 + 「VS Code 打开 / 在文件夹中显示 / 用默认程序打开」按钮。
2. **译文切换不再消失**：切换附件时**保留旧 `translation`** 直到新查询返回（不再先置 null），原文/译文/网页/对照 切换按钮不会短暂丢失；仍会先把视图重置为原文，避免显示错配的译文。
3. **中英对照**：内置引擎新增 `_write_bilingual_html` → `<key>.<lang>.bilingual.html`（每块「原文 | 译文」，宽屏两栏）；`translations.bilingual_path`（migrate 补列）；`translate.readBilingual`；视图新增「对照」（App 顶栏 + 翻译面板结果区 + `HtmlViewer kind`）。
4. **翻译复用**：`runTranslation` 默认**复用已有译文**（不发模型请求）；翻译面板按钮文案变「复用已有译文」，并新增 **「重新翻译」**（`force:true`）。
5. **按块类型翻译（提升 PDF 稳定性）**：simple 引擎先把块分类为 `formula / heading / body`：**公式块不翻译**（保持原样）、**标题**用「短译」system prompt、**正文**常规译；`_openai_translate_many` 增加 `system` 参数；并顺带改进译文网页与对照页的排版。E2E/`test_translate` 增加对照/复用断言。

## 28. 已完成（第十七轮：可配置翻译技能 skills）

把「按内容类型分策略」做成**可配置的 skills 目录**：

- `python/app/skills.py`：默认技能 5 种（`body/heading/caption/formula/reference`），每个一个 JSON：`{label, match, skip, system}`；`ensure_defaults / load_skills / list_skills / save_skill / reset_skills`。目录 `data/skills/translate/`，首次自动写入默认文件，用户可自行编辑。
- `simple_translate` 新增 `skills_dir` 参数：先 `_classify_block` 分类（formula/reference/caption/heading/body），再按类型用对应技能的 `system`（`{lang}` 占位）分组批量翻译；`skip=true` 的类型（公式、参考文献默认）保持原样不译。
- sidecar 新增 `/skills/list | /skills/save | /skills/reset`；主进程 `services/skills.ts` + `ipc/skills.ts`（`skillsDir()` 传给翻译请求）；`translate.ts` 传 `skillsDir`。
- 设置弹窗新增 **「翻译技能（按内容类型，可编辑）」**：每种类型一个文本框 + 「跳过翻译」勾选 + 保存，另有「恢复默认技能」，文件在 `data/skills/translate/*.json`。
- 新增 `python/tests/test_skills.py`（默认写入/分类齐全/保存生效/恢复默认）并接入 `test:py`；E2E M7 增加「设置里有翻译技能编辑器」断言。

## 29. 已完成（第十八轮：页眉页脚 + 变量 + 复用修正）

1. **页眉/页脚/页码默认不翻译**（新增 `margin` 技能，`skip=true`）：`_classify_block` 增加区域判定——位于上下页边 6% 内、≤2 行、≤90 字、**且字号不大于正文**（排除顶部大标题）→ `margin`；纯页码（`3`、`Page 3`、`3/12`、罗马数字）也归 `margin`。避免把页眉/页码翻进正文。`test_translate` 增加断言（页眉保持原样、正文照译）。
2. **prompt 变量**：`{lang}`（目标语言）+ 新增 `{title}`（论文标题，主进程从 items.title 取）。设置里的技能编辑器说明同步更新。
3. **复用修正（真 bug）**：切换引擎后仍会复用旧译文 → 现在**仅当 `existing.engine` 与请求引擎一致**才复用（否则重译）。
4. **跳过类型完全不动原页**：翻译回填时只对「非 skip」块做 redact+refill；公式/参考文献/页眉页脚**原样保留、零改动**（更稳，避免任何改写风险）。`blocks` 计数相应只计已翻译块。

## 30. 已完成（第十九轮：4 项自主优化）

1. **视觉引擎也规避页码**：prompt 明确「不要输出页码、页眉、页脚」。
2. **`1. 作者 … 年份` 参考文献条目**：进入 `References/Bibliography/参考文献` 段后（`refsec` 标记），形如 `\d+\. … (19|20)\d\d` 的块识别为 `reference`（默认不译）；`[n]` 条目不变。
3. **`{authors}` 变量**：prompt 可用 `{lang}` / `{title}` / `{authors}`（作者串）；主进程从 `item_authors` 取；技能编辑器说明更新。
4. **对照页三态切换**：对照 HTML 顶部加了 **原文 / 对照 / 译文** 三个 CSS-only 切换（`input[name=m]` + `body:has(...)`,`HtmlViewer` 沙箱无脚本也能切）；宽屏两栏、窄屏堆叠。

新增/加强测试：`test_skills` 分类启发式断言（reference/margin/页码/大标题/formula/caption）、`test_translate` 参考文献条目不翻译断言。

## 31. 已完成（第二十轮：摘要区 / 公式LaTeX选项 / 导出Markdown / 技能预览）

1. **摘要/标题区识别（新 `abstract` 技能）**：首页 `Abstract/摘要` 之后、遇到编号章节或 `Keywords/Introduction` 之前，归为 `abstract`，用更贴合的学术译法（默认参与翻译）。
2. **公式 LaTeX 选项**：`formula` 技能默认 `skip=true`，但其 prompt 改为「把公式转成 LaTeX（`$...$`）」——用户把「跳过翻译」取消勾选，即可让模型把公式 LaTeX 化。
3. **导出 Markdown**：内置/视觉引擎都产出 **译文 `.md`**；内置另出 **中英对照 `.md`**（`> 原文` + 译文）；存入 `translations.md_path / bilingual_md_path`（migrate 补列）。翻译面板新增「**另存 Markdown / 另存对照 MD**」按钮（`translate.saveMarkdown`）。
4. **技能编辑器**：说明列出可用变量 `{lang}/{title}/{authors}`；每个技能加「**预览**」按钮，显示变量替换后的实际 prompt；`.skill__preview` 样式。
5. 对照 HTML 三态切换（原文/对照/译文）已在前一轮加入，本轮补测试。

测试：`test_skills` 增加 `abstract/caption` 等分类断言；`test_translate` 增加「对照页三态」「译文/对照 Markdown」断言；E2E M5 增加「生成译文/对照 Markdown」。

## 33. 已完成（第二十一轮：公式渲染 / 进度按类型 / 归档到笔记 / 技能 scope）

1. **公式免依赖渲染**：译文/对照 HTML 里的 `$...$` 用内置轻量 LaTeX→HTML 渲染（`_mathify`/`_latex_to_html`：`\frac`、希腊字母、`_`/`^` → `<sub>/<sup>`），无网络无依赖。修了一个真 bug：`v.join(s.split(k))` 之前写反成 `s.split(k).join(v)`，导致对照 HTML 生成失败。
2. **翻译进度按类型**：sidecar 按类型上报阶段 `translating:<kind>`，TS `stageMessage` 显示「翻译中·正文 12/40 段」；完成后消息为「完成：正文 x · 标题 y · 摘要 z …」（App 不再覆盖该消息）。结果附带 `counts`。
3. **归档到笔记**：`services/notes.appendToItemNote(itemId, 标题, md)`（无笔记则创建，追加小节并更新文件/索引）；`translate.exportToNote(id, which)`；翻译面板新增「译文归档到笔记 / 对照归档」，归档后刷新笔记面板（`PanelContext.onNotesChanged`）。
4. **技能 scope**：每个技能 `.json` 新增 `scope`（`all` 全文 / `first` 仅首页 / `rest` 第 2 页起）；超出 scope 的类型回退为 `body`；设置里每个技能加下拉；`/skills/save` 支持 scope。

测试：`test_skills` 增加 scope 持久化断言；`test_translate` 增加「内联公式渲染（含上下标）」断言；E2E 增加「译文可归档到笔记」「技能有 scope」断言。

## 35. 已完成（第二十二轮：段落对齐 / {section} / ZIP / 页码锚点）

1. **笔记 ↔ 译文联动（页码锚点）**：归档译文到笔记时，把 `<!-- 第 N 页 -->` 转成 `> [↓ 第 N 页](paperdesk://open?attachment=KEY&page=N)`，点开即跳回阅读器对应页。
2. **对照页按段落对齐**：`_merge_paragraphs` 把「同页、同栏（x 范围重叠）、正文尺寸、块间距很小」的相邻块合并成一段（对照 HTML/Markdown 均生效），读起来更顺。
3. **`{section}` 变量 + 更学术的默认 prompt**：按当前章节对块分组（组键 = 类型 + 章节），`{section}` 在 prompt 里替换为当前章节名；正文/摘要/图注默认 prompt 改为更明确的学术译法（保留 [n] 引用、数字、单位、符号）。
4. **一键导出 ZIP**：sidecar `/zip` 打包（PDF+HTML+对照+Markdown）；`translate.exportZip` + 面板「打包 ZIP」按钮（生成后自动在文件管理器中定位）。

测试：`test_translate` 增加「对照页按段落合并」断言；E2E 增加「归档笔记带页码锚点」「一键导出 ZIP」。

## 37. 已完成（第二十三轮：批处理技能化 / 一键归档 / 译文检索 / 技能导入导出）

1. **批处理翻译走 skills 产物**：批处理 `translate` 任务改为**直接用引擎产出的 HTML/对照/Markdown**（不再从 PDF 反解），并新增参数「**重新翻译**」（默认复用已有译文）与格式「中英对照 HTML / 打包 ZIP」。
2. **一键归档**：`translate.archiveAll(id)` = 译文 + 对照写入笔记（带页码锚点）+ 打包 ZIP；面板「一键归档（笔记+ZIP）」按钮。
3. **译文全文检索**：新增 `translations_fts`（rowid=translations.id）；翻译完成时用译文 Markdown 建索引；`search()` 增加 `kind='translation'` 来源；左栏搜索能直接搜到译文（标签「译文」）。
4. **技能导入/导出**：sidecar `/skills/import`；`skills.exportFile()/importFile()`（JSON 文件读写，走系统对话框）；设置里「导出技能/导入技能」按钮，便于分享一套技能。

测试：`smoke` 纳入 `translations_fts`；`test_skills` 增加导入断言；`test_import` 增加 `/skills/import`；E2E 增加「一键归档按钮」「全文检索能搜到译文」。

## 39. 已完成（第二十四轮：批处理复合任务 / 检索跳译文 / 质量自检 / 技能版本化）

1. **批处理「翻译并归档」复合任务**：新增任务 `translate-archive`（翻译 → 归档到笔记（带页码锚点）→ 打包 ZIP 到输出目录）。
2. **搜索结果直接跳「译文」视图**：`SearchHit` 增加 `translationLang`；点译文命中会拉取该译文并切到 **HTML/中英对照** 视图（不再只定位到论文）。
3. **翻译质量自检**：内置引擎产出 `qa`（已译 / 跳过 / 疑似未译〔目标中文但 CJK 占比过低〕），存入 `translations.qa`；翻译面板显示「质量自检：已译 N · 跳过 M · 疑似未译 K」。
4. **技能版本化**：技能 JSON 增加 `version` / `updated_at`（保存自增）；`list/save/import` 支持版本；导入时若本地版本更高则**冲突保留本地**并在界面提示。

测试：`test_skills` 增加导入/版本冲突断言；E2E 增加「translate-archive 任务」「译文带质量自检」「面板显示质量自检」「技能可导入/导出」。

## 40. 已完成（第二十五轮：命中高亮 / 归档另存 / 自检定位 / 冲突覆盖）
1. **译文命中高亮**：搜索结果点「译文」命中后，直接切到**中英对照/网页**视图，并把命中词用 `<mark class="hit-mark">` **高亮**（`translate.readBilingualMarked(id, query)`，主进程对对照 HTML 做转义后精确替换）。`SearchHit` 命中项带 `data-kind` 便于定位。
2. **批处理「翻译并归档」可另存**：`translate-archive` 任务新增参数 **另存目录（copyTo）**，ZIP 除写入输出目录外，额外复制到用户指定目录（存在才复制，否则记日志跳过）；产出列表显示另存路径。
3. **质量自检可定位**：`qa` 增加 `items`（疑似未译/未改动段落的页码 + 原文片段，上限 40 条）；翻译面板「查看 N 条明细」展开后，点 `p.N` **跳回原文对应页**（`onOpenTarget`）。
4. **技能冲突可覆盖**：主进程缓存最近一次导入载荷；设置里出现冲突时展示「**覆盖冲突项（N）**」按钮，`skills.applyImport(force=true)` 强制覆盖本地高版本技能。导出技能时携带 `version`，便于版本流转。

测试：`test_translate` 增加「质量自检存在 / 含已译·跳过·明细字段」断言；E2E 增加「质量自检可展开明细」「译文命中携带语言与附件定位」「点译文命中切到译文网页视图」「译文命中高亮」断言（并在其后还原原文视图）。

## 41. 可选后续

- 滚动模式：滚动到底自动预取更多页（现 rootMargin 900px）。
- 设置 UI 暴露翻译并发数（`mt.workers`）。

## 42. 已完成（第二十六轮：E2E 就绪等待 / 命中高亮对比度）

1. **E2E 等待逻辑（确认到具体缺陷）**：`openPanel()` 在点分组后仅 `sleep(60)` 就点面板按钮；分组切换 + 面板懒挂载未完成时按钮不存在 → 点空、面板未打开，在 dev/测试实例并发或慢机上偶发失败（历史上 10 处）。
   最小修复：新增 `waitFor(cdp, expr, {timeout,interval})` 轮询等待**真实就绪信号**——先等「目标面板按钮出现」再点击，再等「按钮带 `primary`（已激活）」后返回；并把几处纯靠固定 `sleep` 的断言改为等 DOM 就绪：设置弹窗、元数据作者、相关论文列表、批处理作业列表、文件树、作者面板。**未加长固定延迟、未放宽断言。**
2. **命中高亮对比度**：用 Electron（`nativeTheme=dark`，`prefers-color-scheme: dark`）实测，中英对照 iframe 由 `_BI_CSS` 固定白底，故原文命中 `<mark class="hit-mark">` **无深色主题分叉**；但原文列灰字 `#6b7280` 落在 `#ffe58a` 上仅 **3.87:1**（< AA）。
   - `python/app/translate.py` `_BI_CSS`：`mark.hit-mark` 由 `color:inherit` 改为显式深色 `#241a00`（**13.76:1**）。
   - `src/renderer/src/styles.css`：搜索命中 `.list__item mark` 在深色主题下 `color:inherit`（浅字）叠半透明黄底仅 **3.52:1** → 新增 `html[data-theme='dark'] .list__item mark { background:#f5c518; color:#1a1a1a }`（**10.68:1**）；浅色主题样式不变。

验证：`typecheck / test:coords / test:py(IMPORT·HTTP·EXTRACT·STRUCTURE·SKILLS·VISION·CJKFONT·TRANSLATE·EXPORT) / smoke(44 表) / build` 全绿；`test:e2e` **一次运行 E2E_OK**（含「译文命中高亮」断言）。本轮未在 dev 并发下复跑（避免额外资源占用），改动已从根因移除固定延迟依赖。

下一步（可选）：需要时在 `PAPERDESK_DEBUG_PORT` 下并发跑一次 dev+e2e 复现验证等待逻辑；其余见 §41。

## 43. 已完成（第二十七轮：高亮可访问性 / 自检导出 / 技能逐项合并 / 另存目录）
1. **命中高亮可访问 + 导航**：对照页 iframe 改为 `sandbox="allow-same-origin"`（**仍无脚本**，`allow-scripts` 未开），使父文档可读取高亮；`HtmlViewer` 载入后统计 `mark.hit-mark` 并把首个高亮滚到视野中央，新增「命中 i/n · 上一个/下一个」（`hit-prev`/`hit-next`，平滑滚动）。深色主题下由渲染层向页面注入深色配色（`DARK_CSS`：深底、浅字、`mark` 用 `#8a6d00`/`#fff3c4`），对照页不再固定白底。
2. **质量自检可导出**：新增 `translate.exportQa(id)` → 生成 `<key>.<lang>.qa.md`（含统计 + 待复核段落清单，每段带 `paperdesk://open?...&page=N` 跳转链接 + 复选框）；面板新增「导出清单」按钮。
3. **技能导入「升级 + 逐项采用」**：`import_skills` 增加 `updates`（导入方版本更高）与 `only`（仅处理指定 match）；`/skills/import` 与 `services.importSkillsFile` 返回 `updates`；`skills.applyImport(force, only?)` 支持逐项。设置里冲突不再只有「全部覆盖」，而是**逐项列出 `技能名 → 采用导入版`**，并显示「已升级到更高版本：…」。
4. **另存目录更友好**：`translate-archive` 的 `copyTo` 支持 `~`（家目录）展开，且**相对路径按输出目录解析**；占位提示更新。

测试：`test_skills` 增加「更高版本记入 updates」「only 逐项采用导入版」断言；`test_translate` 维持质量自检断言；E2E 增加「可导出质量自检清单（Markdown）」「译文命中在对照页高亮」「命中高亮支持上/下一个」断言（高亮断言已改为**严格**，不再退化）。

验证：`typecheck / build / test:py(EXPORT_OK) / smoke / test:coords / test:e2e(E2E_OK)` 全绿。

## 44. 已完成（第二十八轮：自检入笔记 / 命中键盘导航 / manifest / 导入脏检查）
1. **质量自检一键入笔记**：把 `exportQa` 的构造抽成 `buildQaMarkdown(id)`；新增 `archiveQaToNote(id)` → 以「翻译质量自检（lang）」小节**追加进该论文笔记**（复用页码锚点）；IPC `translate:exportQaToNote`；面板新增「入笔记」按钮（归档后刷新笔记面板）。
2. **命中导航增强**：`HtmlViewer` 支持 **F3 下一个 / Shift+F3 上一个**命中（`window` keydown，仅对照视图有高亮时生效）；并**记忆滚动位置**（`sessionStorage`，按「译文 ID + 视图」区分），无高亮时载入恢复上次位置、有高亮时定位首个命中。
3. **批处理产出 manifest**：`translate-archive` 除 ZIP 外，额外在输出目录生成 **`<key>.<lang>.qa.md`（自检清单）** 与 **`<key>.<lang>.manifest.md`（产出清单：PDF/HTML/对照/两种 Markdown/自检/ZIP + 生成时间）**，并把它们列入 job 产出。
4. **技能导入脏检查**：设置里对比「草稿 vs 已保存」的 system/skip/scope；若有未保存改动，导入前用 `confirm` 提示「会用文件内容覆盖这些草稿」，可取消。

测试：E2E 增加「自检清单可归档到笔记」「翻译归档任务含『另存目录』参数」。

验证：`typecheck / build / test:py(EXPORT_OK) / smoke / test:coords / test:e2e(E2E_OK)` 全绿。

## 45. 已完成（第二十九轮：ZIP README / 笔记小节幂等 / 命中记忆 / 导入预览）
1. **ZIP 附带 README + manifest 统计**：`exportZip(id)` 额外生成 `<key>.<lang>.README.md`（标题/作者/目标语言/引擎/**翻译统计**/生成时间 + 文件清单）并纳入 ZIP；批处理 `manifest.md` 增加「翻译统计」行。（修：`items` 表无 `authors` 列 → 作者改由 `item_authors JOIN authors.display_name` 取；SQLite 分隔符必须用单引号，双引号会被当作标识符。）
2. **笔记小节幂等**：`notes.upsertSectionInItemNote(itemId, title, content)` 用 `<!-- paperdesk:title -->…<!-- /paperdesk:title -->` 标记包住小节，重复归档**替换而非追加**；归档译文/对照/自检清单都改走它。
3. **命中索引记忆**：`HtmlViewer` 把「第几个命中」写入 `sessionStorage`（按译文+视图），再次打开自动回到上次命中位置。
4. **技能导入预览**：导入改为**先预览后应用**——`pickSkillsFile()` 只选择并解析（不写入），界面按「新增/升级/降级/无变化」列出每个技能的**变更字段**（system/skip/scope/version），默认勾选新增与升级项，可逐项勾选后「应用所选」。（脏检查提示保留。）

测试：E2E 增加「重复归档不重复追加（幂等）」「ZIP 附带 README 清单」。

验证：`typecheck / build / test:py(EXPORT_OK) / smoke / test:coords / test:e2e(E2E_OK)` 全绿。

## 46. 已完成（第三十轮：导入 diff / 笔记目录 / manifest 环境 / 对照快照）
1. **导入预览字符级 diff**：`SkillDiff` 带上 `prev`；对 system 变更渲染 `CharDiff`（去公共前后缀，`<del>`/`<ins>` 高亮变化片段），设置里导入预览可直接看到「旧 → 新」。
2. **笔记自动目录**：`notes.syncToc(body)` 在正文顶部维护 `<!-- paperdesk:toc -->…<!-- /paperdesk:toc -->` 的「目录」小节（列出所有 `## ` 小节的可点击锚点，中文做 best-effort slug）；每次 upsert 小节都会重建目录。
3. **manifest 环境信息**：批处理 `manifest.md` 增加「引擎 / 后端 / 模型（`mtConfig().model`）/ 创建时间」。
4. **对照页快照**：新增 `translate.saveSnapshot(id, query, theme)` → 以「当前视图 + 命中高亮（含深色主题）」另存为自包含 `snapshot.html`；`HtmlViewer` 对照视图右上角新增「另存快照」按钮（`snapshot-save`）。

测试：E2E 增加「笔记自动维护『目录』小节」「对照视图提供『另存快照』」。

验证：`typecheck / build / test:py(EXPORT_OK) / smoke / test:coords / test:e2e(E2E_OK)` 全绿。

## 47. 已完成（第三十一轮：锚点对齐 / diff 可读 / 模板统一 / 批量快照）
1. **目录锚点可用**：新增 `src/shared/slug.ts`（`slugifyHeading`），主进程生成目录与渲染层标题 id **共用同一规则**；`NotesPanel` 预览时给 `h1/h2/h3` 加 `id`，并把 `#锚点` 链接改为**面板内平滑滚动**（不再误当外链 `openExternal`）。E2E 用「点目录 → 标题 id 对齐」验证。
2. **导入 diff 更可读**：除字符级 system 差异外，`skip` 显示「跳过翻译：否 → 是」，`scope` 显示「适用范围：全文 → 仅首页 / 第 2 页起」。
3. **元信息模板统一**：抽出 `translationInfo(id)`（标题/作者/语言/引擎/后端/模型/统计/文件清单）+ `renderTranslationReadme()` + `renderTranslationManifest()`；`exportZip` 的 README 与批处理 `manifest` 都改用它们，消除三处重复。
4. **批量对照快照**：新增批处理任务 **`translate-snapshot`**（参数：语言 / 重新翻译 / 高亮词 / 主题），把每篇的中英对照导出为自包含 `snapshot.html` 到输出目录；`renderBilingualSnapshot()` 从「另存快照」中抽出复用。

测试：E2E 增加「目录锚点与预览标题 id 对齐」；批处理任务清单断言加入 `translate-snapshot`。

验证：`typecheck / build / test:py(EXPORT_OK) / smoke / test:coords / test:e2e(E2E_OK)` 全绿。

## 48. 已完成（第三十二轮：快照 E2E / 目录层级 / 快照工具条 / 翻译历史）
1. **批量快照 E2E**：M10 真实创建并跑一个 `translate-snapshot` 作业（复用已有译文），校验 `snapshot.html` 落盘且含浮动工具条（`pd-tools`）。
2. **目录层级**：笔记「目录」把 `###` 也纳入，二级项缩进显示。
3. **快照浮动工具条**：`renderBilingualSnapshot` 注入固定右下角工具条（`命中 N 处` + `↑ 回到顶部`），`<body>` 加 `id="pd-top"`；命中数在生成时静态统计。
4. **翻译历史**：同附件同语言**不再删除旧译文**——旧行标记 `status='superseded'`，文件改为**每次唯一**（`<附件key>.<tkey>.<lang>.*`，保留 `.zh.pdf`/`.zh.html` 等后缀）。新增 `listTranslations` / `getTranslationById`（IPC `translate:history` / `translate:getById`）；翻译面板新增**历史版本下拉**（>1 时出现，可切到旧版本查看）。
   - 注意（行为变化）：重译会**累积磁盘产物**（历史保留），如不需要可在文件面板/目录手动清理。

测试：E2E 增加「强制重译生成新版本」「译文历史累积」「旧译文标记为已取代」；`getByPath` 断言改为按当前译文实际路径反查。

验证：`typecheck / build / test:py(EXPORT_OK) / smoke / test:coords / test:e2e(E2E_OK)` 全绿。

## 49. 已完成（第三十三轮：历史管理 / 差异对比 / 清理产物 / 归档清理策略）
1. **历史版本管理**：`deleteTranslation(id, removeFiles)` + `pruneTranslations(attachId, lang, keep)`（IPC `translate:remove` / `translate:prune`）；面板历史区新增「删除此版本」「只保留最近…」（`prompt` 输入 N），删除后自动切到最新版本。
2. **历史差异对比**：模块级 `lineDiff`（LCS，超大文本退化为集合差异）产出并排行差异；`translate:readMarkdown` 读取译文 Markdown；面板「对比最新」打开左右双栏 diff（红/绿高亮增删行）。
3. **清理孤儿产物**：删除历史行时同步删除其磁盘产物（pdf/html/对照/两种 md）并清理 `translations_fts` 索引。
4. **批处理归档清理策略**：`translate-archive` 新增参数**「历史版本：保留全部 / 归档后只保留最新版」**，选后者时归档后 `prune(...,1)`。

测试：E2E 增加「面板显示译文历史版本可切换」「历史差异对比入口存在」「可读取译文 Markdown（用于对比）」。

验证：`typecheck / build / test:py(EXPORT_OK) / smoke / test:coords / test:e2e(E2E_OK)` 全绿。

## 50. 已完成（第三十四轮：词级 diff / 自动保留 / 孤儿巡检 / 报告导出）
1. **差异对比增强**：新增词级差异（`tokenize` 按中文单字/英数词切分 + LCS）；把连续 `-/+` 块**配对成「同一行修改」**并做行内 `<del>/<ins>` 高亮；新增「**只看改动**」开关。
2. **历史自动保留策略**：设置新增 `mt.keepVersions`（不限制 / 1 / 3 / 5）；`runTranslation` 成功后按设置 `pruneTranslations(...,keep)`。
3. **孤儿文件巡检**：`scanOrphanFiles()` / `cleanOrphanFiles()`（IPC `translate:orphans` / `translate:cleanOrphans`）；只把**译文产物**（`.pdf/.html/.md`）视为候选，自动排除 ZIP/README/自检/manifest/快照等派生产物；设置里新增「扫描孤儿文件 / 清理」。
4. **对比导出**：`translate:saveReport`（另存文本）；diff 视图「导出报告」把增删行写成 Markdown 报告。

测试：E2E 增加「打开历史差异对比」「差异对比支持只看改动」「差异对比可导出报告」「设置里有历史版本保留」「设置里有扫描孤儿文件」「可扫描孤儿文件」。

验证：`typecheck / build / test:py(EXPORT_OK) / smoke / test:coords / test:e2e(E2E_OK)` 全绿。

## 51. 已完成（第三十五轮：diff 选项 / 孤儿导出 / 按引擎保留 / 基线）
1. **差异对比体验**：新增「忽略空白 / 忽略大小写 / 折叠相同」选项（`lineDiff` 支持比较键；`collapseEqual` 折叠大段未变并显示「折叠 N 行未变」）。

   > 空白折叠用 `…… 折叠 N 行未变 ……` 占位行；报告导出会跳过该占位行。
2. **孤儿报告导出**：设置里「导出清单」把孤儿文件列表写成 Markdown（`translate:saveReport`）。
3. **按引擎保留**：`pruneTranslations` 改为**按 engine 分组各自保留 N 份**（同语言内不同引擎互不影响）。
4. **基线（pin）**：`translations.pinned` 列（schema + migrate）；`setPinned`（IPC `translate:setPinned`）；面板历史区「设为基线 / 取消基线」，历史下拉用 `★` 标识；**清理时永远保留基线版本**。

测试：E2E 增加「差异对比支持忽略空白/大小写/折叠相同」「可标记译文为基线」「清理时保留基线版本」。

验证：`typecheck / build / test:py(EXPORT_OK) / smoke / test:coords / test:e2e(E2E_OK)` 全绿。

## 52. 已完成（第三十六轮：时间线/回滚 / 清理预览 / 孤儿目录排序 / 设置导入导出）
1. **历史时间线 + 回滚**：面板历史区新增「时间线」开关，按时间列出各版本（时间/引擎/基线/是否已取代），支持「查看 / **回滚为最新** / 删除」；`rollbackTranslation(id)` 把该版本置为 `done`、其余置 `superseded`（IPC `translate:rollback`）。
2. **清理前预览**：`previewPrune(attachId, lang, keep)` 返回将被删除的版本（含各自体积，IPC `translate:previewPrune`）；`只保留最近…` 改为**先预览再确认**（列出条目 + 确认清理/取消）。
3. **孤儿巡检增强**：`scanOrphanFiles` 返回 `{ dir, orphans:[{name,bytes}] }`（**按体积从大到小**）；设置里新增「**打开目录**」，并列出前 12 个大文件。
4. **设置导入/导出**：`settings.exportFile()` / `settings.importFile()`（IPC `settings:export/import`）；导出**不含 API Key**；导入后套用并同步主题。

测试：E2E 增加「清理前可预览将删除的版本」「历史时间线视图」「可回滚旧版本为最新」「设置可导入/导出」；孤儿断言增加 `dir`。

验证：`typecheck / build / test:py(EXPORT_OK) / smoke / test:coords / test:e2e(E2E_OK)` 全绿。

## 53. 已完成（第三十七轮：接入 opencode-plugin-opencoder 自主开发循环）
1. **安装插件与 agents**：克隆 `opencodeco/opencode-plugin-opencoder` 到 `~/.config/opencode/plugins/opencode-plugin-opencoder`，运行其 `postinstall.mjs` → 安装 3 个 agent 到 `~/.config/opencode/agents/`（`opencoder` / `opencoder-planner` / `opencoder-builder`，`opencode debug agents` 可见）。
   - **兼容性说明**：本机 OpenCode 为 **v2.0.26**，要求插件 `default` 导出为 `{ id, setup|effect }`；上游为旧版 V1 导出，运行时会跳过。已额外提供 V2 适配入口 `src/v2.ts`（并把 `package.json` 的 `main`/`exports` 指向它），仅提供 `OPENCODER_DEBUG=1` 时的调试钩子，且全部 try/catch 防御。**全局 `opencode.jsonc`/`package.json` 未做改动（与改动前逐字节一致）**，本机该构建对本地目录/`file:` 插件的激活不稳定，故只启用其“agents”这一实质功能。
2. **初始化 git 仓库**（循环的 commit 依赖）：`paperdesk` 此前非 git 仓库，已 `git init` + 首次提交（`.gitignore` 已覆盖 node_modules/out/dist/data）。
3. **用 planner + builder 执行一轮**：
   - `opencode-planner` 产出 6 项计划。
   - `opencode-builder` 执行并验证 4 项：
     - **Task 1** `fix(sidecar)`：Python 缺失/spawn 失败时**立即**给出可操作错误，不再干等 30s（`src/main/sidecar/manager.ts`）。
     - **Task 3** `fix(batch)`：`batch.create` 增加入参校验，避免 `scope=attachment` 且无 `attachmentId` 时**静默处理全部附件**。
     - **Task 4** `chore`：新增聚合脚本 `npm test`（typecheck+coords+py+smoke）与 `.github/workflows/ci.yml`。
     - **Task 5** `docs`：修正 `docs/EXTENDING.md` 重复章节号；README 说明 `docs/HANDOFF.md` 定位。
   - **Task 6（schema.sql 编码）被 builder 正确证伪**：字节级核验证明该文件本就是 UTF-8（无 BOM、无 U+FFFD），planner 的判断是 PowerShell 控制台显示编码导致的误判，故未改动。
4. 每一步后均跑 `typecheck / build / test:py / smoke / test:coords / test:e2e`，**全绿**；共 4 个签名提交。

后续（可选）：`opencode @opencoder "<目标>"` 可启动持续的 Plan-Build-Commit 循环（默认无终止）；如需在本仓库持续运行，建议先确认是否需要远端以便 `git push`。

## 54. 已完成（第三十八轮：阶段 1「可靠基线」收口）
按 12 周路线图阶段 1 的前三项收口，逐项对齐验收标准：
1. **统一 Node/Python 环境**：`package.json` 增加 `engines.node >= 20`；`python/requirements.txt` 由 `>=` 改为**精确锁定**到已验证组合（fastapi 0.141.1 / uvicorn 0.34.0 / pymupdf 1.27.2.3 / httpx 0.28.1 / pydantic 2.13.4）；README 新增「环境要求与测试」章节，明确 **Python 由外部提供**（≥3.10）。
2. **主进程回归测试**（此前零覆盖）：把两处修复的纯逻辑抽成可测模块并补单测——
   - `src/main/services/batch/validate.ts`（由 `ipc/batch.ts` 调用）：`scope=attachment|item|select` 目标缺失即抛错，**非法请求不会创建作业**；
   - `src/main/sidecar/errors.ts`（由 `manager.ts` 调用）：缺 Python（ENOENT）→ 可操作提示、提前退出→带 code/signal；
   - 新增 `scripts/test-unit.ts` + `npm run test:unit`，并接入 `npm test` / CI。
3. **测试数据隔离（固化 + 可覆盖）**：新增纯函数 `resolveDataDir(userDataPath, env)`（`src/main/db/paths.ts`），支持 **`PAPERDESK_DATA` 覆盖数据目录**；确认并记录隔离现状——e2e 用临时 userData、`smoke` 用内存 SQLite、Python 单测用 `tempfile`，**测试不写真实数据目录**。

其他：新增聚合脚本 `npm run ci`（= `npm test`：typecheck → test:unit → test:coords → test:py → smoke）；`.github/workflows/ci.yml` 增加「Unit tests (main process)」步骤。

验证：`npm test`（含新 `test:unit` 全 PASS → `UNIT_OK`）+ `npm run build` + `npm run test:e2e`（`E2E_OK`）全绿。

> 阶段 1 剩余：CI 尚未在 GitHub Actions 实跑（需远端）；阶段 2（数据安全：迁移测试/备份恢复/崩溃恢复）与阶段 3（样本集/评估/性能）尚未开始。

## 55. 已完成（第三十九轮：阶段 2 数据安全）
1. **数据库迁移测试**：把列迁移抽成纯模块 `src/main/db/migrate.ts`（`COLUMN_MIGRATIONS` + `migrate(db, log)`，只依赖结构化最小接口）；`scripts/test-unit.ts` 增加 5 条断言——旧 `translations` 表会补齐 `html_path/bilingual_path/md_path/bilingual_md_path/qa/pinned`、表不存在时不发 ALTER、列已存在则幂等、单列异常只告警不抛出。
2. **备份与恢复**：新增 `src/main/services/backup.ts` + `src/main/ipc/data.ts`（模块 `data`）：
   - `backupTo(dest)` 用 **SQLite 在线备份**（正确处理 WAL）；`backupDialog()` 走系统对话框。
   - `restoreFrom(src)` 恢复前用 **`VACUUM INTO` 自动安全备份当前库**到 `<data>/backups/pre-restore-*.sqlite`，再关闭连接、替换 `library.sqlite`（含清理 `-wal/-shm`）、重新打开并跑迁移。
   - 设置面板新增「**数据安全**」区（备份数据库 / 从备份恢复）。
3. **历史/基线/清理一致性**：E2E 新增断言——`previewPrune` 的数量与 `prune` 实际删除数量一致；结合前几轮的「基线不被清理」，形成清理链路的回归保护。

测试：`test:unit` 新增迁移断言（`UNIT_OK`）；E2E 新增「可获取备份目录 / 可备份数据库到文件 / 可从备份恢复（含安全备份）/ 恢复后条目数不变 / 清理预览数量==实际删除数量」，`E2E_OK`。

> 阶段 2 剩余：**批处理崩溃恢复**（机制已存在：`batch_jobs`/`batch_items` 持久化 + 启动自动恢复未完成作业，但目前无自动化测试，属"机制存在、待人工验证"）；迁移测试目前为纯逻辑级（不跑真实 better-sqlite3），已在 e2e（Electron 运行时）间接覆盖真实库初始化。

## 56. 已完成（第四十轮：阶段 3 核心体验与质量——样本集 / 评估 / 性能）
1. **样本集**：新增 `scripts/make-corpus.py` → 生成 `samples/corpus/`：`single`（单栏）/ `two-column`（双栏）/ `scanned`（**位图无文本层**，模拟扫描件）/ `formula`（公式行）/ `chinese`（内置 CJK 字体）/ `long-30p`（30 页长文）。`npm run corpus`。
2. **评估与性能测量**：新增 `scripts/eval-corpus.py` → 对每个样本测量「页数 / 文本字符 / 是否有文本层 / 中文占比 / 分块分类计数 / 推断标题 / 参考文献数 / 抽取耗时」，并测「翻译流水线（**mock 离线后端**）块数与耗时」，外加 micro-bench：30 页长文抽取、**FTS5 查询（5000 行中位数）**；结果写入 [`docs/EVAL.md`](EVAL.md)。`npm run eval`。
3. **可复现结论（见 EVAL.md）**：扫描件样本 `有文本层=否`（验证需走视觉/OCR）；公式行被判为 `formula`；双栏样本可正常分块；性能参考值（30 页抽取 ~9ms、FTS ~0.2ms）。

> 阶段 3 剩余：真实**译文质量**评估需配置模型后端（当前用 mock，只能测管道）；「大文库」只做了 FTS micro-bench，未做端到端（导入 1000+ 篇的 UI 交互）测量；阅读体验评估待人工。

## 57. 已完成（第四十一轮：阶段 4 安装与发布）
1. **打包配置**：`package.json` 新增 `build`（electron-builder）：`extraResources` 把 `python/` 随包分发到 `resources/python`（与 `manager.ts` 的 `process.resourcesPath/python` 对应）、Windows `nsis` 目标、产物目录 `release/`（已 gitignore）。（**打包动作未在此环境实跑**，配置已就位。）
2. **安装预检**：新增 `scripts/preflight.cjs` + `npm run preflight` —— 逐项校验 **Node ≥20 / Python ≥3.10 / 依赖可导入 / sidecar 能启动并响应 `/health`**。本机实测 **`PREFLIGHT_OK`**（4 项全过）。
3. **统一使用文档**：新增 [`docs/DEPLOY.md`](DEPLOY.md)——Python 由外部提供（决策 + 后续可选内置）、资源路径（dev vs packaged）、原生依赖（better-sqlite3 需按 Electron ABI 重建）、构建/打包、升级（自动列迁移不丢数据）、卸载与**用户数据位置**（保留数据 + 备份/恢复）、预检排障、已知缺口。

> 阶段 4 剩余：**干净机器端到端安装**需真机人工执行（见 `docs/TRIAL.md`）；安装包**未签名**、无自动更新；未内置 Python 运行时；仅 Windows 验证。

## 58. 已完成（第四十二轮：阶段 5 小规模试用准备）
- 新增 [`docs/TRIAL.md`](TRIAL.md)：覆盖「单栏/双栏/扫描件/公式/中文」的试用样本类型、**十步完整工作流清单**、反馈记录模板、按「影响×频率」排序与**发布阻断（Blocker）定义**、发布候选判据，以及当前自评（自动化基线具备，真实试用需真机）。
- README 增加「文档」索引，统一指向 DEPLOY / TRIAL / EVAL / EXTENDING / HANDOFF。

> 阶段 5 剩余（**需真实资源，非本环境可完成**）：真实论文的真机试用、干净机器安装验证、真实译文质量评估（需配置模型后端）。

---

## 附：12 周路线图执行状态总览（本仓库视角）
| 阶段 | 状态 | 说明 |
|---|---|---|
| 1 可靠基线 | ✅ 基本完成 | 环境锁定 / 主进程单测 / 数据隔离 / `npm test`+`ci`；**CI 未在远端实跑** |
| 2 数据安全 | ✅ 主要完成 | 迁移测试 / 备份恢复 / 清理一致性；**批处理崩溃恢复无自动化**（机制在） |
| 3 核心体验与质量 | ✅ 主要完成 | 样本集 + EVAL 测量（抽取/分类/翻译管道/性能）；真实译文质量与端到端大文库待补 |
| 4 安装与发布 | 🟡 部分完成 | 打包配置 + 预检 + 部署文档；**干净机器实测/签名/内置 Python 未做** |
| 5 小规模试用 | 🟡 准备完成 | 试用手册与判据就位；**真实试用需真机真人** |

**本环境无法闭环的部分**（需你提供资源）：远端仓库（CI 实跑 + `git push`）、干净 Windows 机器、配置好的模型后端、真实用户试用。

## 59. 已完成（第四十三轮：排查「点翻译→白屏」+ 错误边界加固）
1. **现象**：dev 实例点「翻译」后整页白屏。
2. **排查（CDP 实测）**：
   - 用**当前源码的构建产物** + **真实数据副本**复现：点翻译**完全正常**（复用已有译文、切视图、无异常）。
   - dev 日志显示 Vite 曾报 `Internal server error … PdfViewer.tsx: Unterminated string constant` / `SettingsDialog.tsx: Unexpected token`——是编辑过程中「半写入文件」被 Vite 读到并缓存了错误，**dev 模块图损坏**。
   - 重启 dev 后同样正常（点翻译走真实 sidecar，日志「翻译完成」）。
   - 结论：**不是代码 bug**（源码 `typecheck/build/E2E` 全绿），是 dev 运行态损坏；恢复方式=强制重新加载或重启 `npm run dev`。
3. **加固：错误边界（ErrorBoundary）**——即使将来真有渲染 bug，也不再整页白屏：
   - `src/renderer/src/components/ErrorBoundary.tsx`：捕获渲染/生命周期异常，局部显示「出错了 + 原因 + 重试 / 重新加载」，并 `console.error` 记录；`resetKey` 变化时自动清除错误（切面板/换附件即自愈）。
   - 接入点：**顶层**（`main.tsx`）、**每个右侧面板**、**阅读器/译文视图**（`App.tsx`）。
   - `main.tsx` 增加 `window 'error' / 'unhandledrejection'` 全局日志（边界捕获不到的事件/异步错误也能进日志）。
4. **验证**：临时注入一处渲染异常（验证后已移除）——面板显示错误框且 `.app/.sidebar/.viewer/.toolbar` **全部存活**（`BOUNDARY_OK`），关闭异常点「重试」后**自愈**；E2E 新增「正常流程不触发错误边界」。

验证：`typecheck / npm test(UNIT_OK·SMOKE_OK) / build / test:e2e(E2E_OK)` 全绿。

## 60. 已完成（第四十四轮：设置界面布局与文案修正）
用 CDP 截图 + DOM 实测设置弹窗，修掉两处问题：
1. **设置内容被裁剪、无法滚动（严重）**：`.modal__body` 作为 flex 列的子项缺少 `min-height:0`，被 `.modal__box{overflow:hidden}` 直接裁掉——**大部分设置根本够不着**（E2E 用 querySelector 能命中 DOM，所以一直没暴露）。
   - 修复：`.modal__body { flex: 1 1 auto; min-height: 0; overflow: auto; }`；实测 `clientH 569 / scrollH 2939`、`canScroll=true`。
   - 弹窗宽度 580→600、`max-height` 84vh→88vh；长 URL/`code` 允许换行（`overflow-wrap: anywhere`）。
2. **章节标题像链接 + 翻译技能编辑器很挤**：
   - `h4` 由「大写 + 强调色」改为正常字重 13px 深色，并在章节间加分隔线（不再像可点链接）。
   - 技能卡片改为**两行式**：标题独占一行（含 `vN`），控件在下一行；`match` 做成等宽小标签，`跳过翻译`/按钮/下拉 `white-space: nowrap`，输入框不再被压成 `form ual 1`；prompt 文本域 2→3 行。
3. **文案**：`Crossref 消解 / 消解上限` → `Crossref 解析 / 解析上限`。

测试：E2E 新增回归守卫「**设置内容可滚动、不被裁剪**」（`scrollH > clientH + 50`）。

验证：截图核对（顶部/中部/底部）+ `typecheck / npm test / build / test:e2e(E2E_OK)` 全绿。

## 61. 已完成（第四十五轮：查找高亮遮挡正文）
- **现象**：在阅读器里查找关键词时，高亮太不透明，把正文盖住了。
- **根因**：pdf.js 的文本层 `.textLayer span` 是 `color: transparent` ——**字形由下层 canvas 绘制**，而查找高亮是画在这些 span 的**背景**上的实色（`#ffe58f` / 当前项 `#ffb300`），于是直接盖住 canvas 上的字。
- **修复**（与批注高亮同一套思路）：
  - `.textLayer .find-hit` → `background: color-mix(in srgb, #ffd54a 55%, transparent)` + `mix-blend-mode: multiply`
  - `.textLayer .find-hit--cur`（当前项）→ `#ff9d00 70%` + `multiply`
  - `multiply` 只压暗底色、保留黑色字形，正文透出来可读。
- **验证**：CDP 截图实测——当前项（橙）+ 其余（浅黄）两处高亮下**文字均清晰可读**；全量 `typecheck / npm test / build / test:e2e(E2E_OK)` 全绿。

## 62. 已完成（第四十六轮：高亮再调轻 + 抽成可调变量）
- 反馈「还是太高」→ 再降一档：**去掉 `mix-blend-mode`**（它会让颜色更实），改成**很低不透明度**的纯色；**当前项 = 极浅底 + 细描边**（比整块色更轻，又便于定位）。
- 抽成 CSS 变量（`styles.css` 的 `:root` / 深色主题块），阅读器查找与库搜索命中共用，**一处可调**：
  - 浅色：`--hit-bg: rgba(255,214,74,.16)`、`--hit-cur-bg: rgba(255,160,0,.24)`、`--hit-cur-ring: rgba(219,120,0,.75)`
  - 深色：`--hit-bg: .18`、`--hit-cur-bg: .30`
- 对照页（Python 生成的 HTML）与深色/快照的 `mark.hit-mark` 同步调柔：`rgba(255,214,74,.32)` / 深色 `rgba(255,190,60,.30)`，并改回 `color: inherit`（字形在上层，不再遮挡）。
- **验证**：截图实测「查找」高亮极轻、正文清晰；`typecheck / npm test / build / test:e2e(E2E_OK)` 全绿。
- 调色入口：`src/renderer/src/styles.css` 顶部 `--hit-bg / --hit-cur-bg / --hit-cur-ring`（改一处，阅读器+库搜索同时生效）。

## 63. 已完成（第四十七轮：查找只高亮命中词本身）
- **问题**：查找时「高亮文本太多」——旧实现是给**包含关键词的整个 `<span>`** 加类，而 pdf.js 的 span 常常是一整行/一段文字，于是整段被染色。
- **修复**：改用 **CSS Custom Highlight API**（`CSS.highlights` + `Highlight` + `Range`）——为每个命中构造 **Range**，只给**命中的那段文字**上色，**完全不改 DOM**；`::highlight(paperdesk-find)` / `::highlight(paperdesk-find-cur)` 控制样式（当前项加下划线定位）。不支持该 API 时回退到旧的整段染色。
- **实测**（CDP）：`rangeTexts = ["Translation","translation",…]`（**恰好等于搜索词**），而所在 span 是整句 `"Layout Preserving Translation of Scientific Papers"` —— 证明只染命中的词。
- **测试**：E2E 新增断言「**查找只高亮命中文字（不是整段）**」——直接读取 `CSS.highlights` 里所有 Range 的文本，必须全部等于搜索词。
- 验证：截图 + `typecheck / npm test / build / test:e2e(E2E_OK)` 全绿。

## 64. 已完成（第四十八轮：划词浮条新增「查找」快捷）
- 阅读器**划词浮条**新增「**查找**」按钮（`data-testid="find-selection"`）：把选中文字填入顶部查找框并立即在本文查找（沿用上一轮的「只高亮命中词」）。点完自动聚焦查找框，便于继续编辑/跳下一个。
- **跨行/长选区兜底**：整句选中时在单行文本里搜不到 → 自动退为**「能命中的最长前缀」**（例如整句无果时取前几个词），避免「点了查找却 0 命中」。
- 抽出 `collectHits(needle)` 供「查找」与「划词查找」复用；`.popup__row` 允许换行，三个按钮不会挤爆。
- **测试**：E2E 新增「划词浮条提供『查找』快捷」「划词查找：填入关键词并命中」。
- 验证：截图（浮条含 查找 且排版正常）+ `typecheck / npm test / build / test:e2e(E2E_OK)` 全绿。

## 65. 已完成（第四十九轮：研究区新增「期刊」面板）
- **新增面板 `期刊`（研究分组）**：`src/shared/journals.ts` 内置 12 个常见期刊/会议（Nature/Science/Cell/Nature Methods/Nature Biotechnology/NAR/Bioinformatics/Briefings in Bioinformatics/PLOS Comp Biol/BMC Bioinformatics/NeurIPS/ICML），每个含：
  - **简介**（学科范围）、**定位**（定性，不写会过期的硬数字）、出版社/类型（期刊 / 会议）；
  - **投稿要求要点**：语言/写作、篇幅惯例、摘要、参考文献、图表/补充材料、**数据与代码可用性**、开放获取/费用、审稿与周期；
  - **常见要求 / 易踩坑**（如 NAR 的 Database/Web Server 专刊窗口、Bioinformatics 的 Availability 段、NeurIPS 双盲与页数上限）；
  - **官方链接**：作者指南 + 主页（`window.api.app.openExternal`）；界面明确提示「**以官网 Author Guidelines 为准**」。
- 面板支持**搜索过滤**（名称/中文名/出版社/领域）→ 列表 → 详情（含返回）。
- **关于右栏一级目录**：经实测（构建版截图 + DOM）`阅读/研究/数据` **始终存在**且可见——属 **dev 实例陈旧**（本会话第 3 次），已重启 dev 恢复；并把该断言收紧为「一级分组必须含 阅读/研究/数据」以防回归。
- **测试**：E2E 新增「研究区新增期刊面板并列出条目」「期刊搜索可过滤」「期刊详情含投稿要求与作者指南入口」，并收紧「Office 式两层功能区」断言。
- 验证：截图 + `typecheck / npm test / build / test:e2e(E2E_OK)` 全绿。

## 66. 已完成（第五十轮：期刊面板三连——AI 概括 / 扩充数据 / 与论文联动）
1. **AI 概括要求**：新增 IPC `journals:summarize`（`services/llm.generate`，**离线自动 mock 兜底**）——详情页「AI 概括要求」生成「一、要求摘要 + 二、投稿前 checklist」；结果按 **Markdown 渲染**（引用/标题/真实复选框），并明确标注「AI 可能不准确，务必以官网为准」；离线时提示去设置配置模型。另新增 IPC `app:copyText` →「复制 checklist」按钮（写系统剪贴板）。
2. **数据扩充**：期刊/会议 **12 → 28**（新增 PNAS、Nature Communications、PLOS ONE、Nature Medicine、NEJM、The Lancet、eLife、JACS、Angewandte、PRL、Nature Physics、Advanced Materials、JMLR、TPAMI、CVPR、ACL 等）；每条新增：
   - `keywords`（供推荐匹配）；
   - 可选 `limits`（**参考上限**，如 Nature 摘要 ~200 词、PRL/CVPR/ICML 正文页数；标注「非官方，以官网为准」）。
3. **与论文联动**：
   - **按当前论文推荐**：取打开论文的 `title + abstract + venue` 与各刊 `keywords` 匹配，按命中数排序取 **前 5**，显示命中关键词（如「bioinformatics、pipeline、deep learning」）；
   - **与当前论文对照**：若该刊有参考上限，给出**摘要词数对比**（超出给出 ⚠️ 提示）；无上限则提示按官网核对；并注明「参考值」。
4. **测试**：E2E 新增「按当前论文推荐期刊（关键词匹配）」「期刊可用 AI 概括要求（离线也可返回）」「期刊可复制 checklist」；E2E 样例条目的 `abstract` 补上匹配词以覆盖推荐路径。
- 验证：截图（推荐 5 条 + AI 结果 Markdown 渲染正常）+ `typecheck / npm test / build / test:e2e(E2E_OK)` 全绿。

## 67. 已完成（第五十一轮：翻译「只动正文」的确认与增强）
**结论：图片 / 引用 / 公式 / 页眉页脚**本来就不翻译、不被破坏：
- 回填只针对**非跳过类型**的块（`keep = [i for i in idxs if not skip_mask[i]]`），公式 / 参考文献 / 页眉页脚**完全不动**；
- 覆盖原文用 `page.apply_redactions(images=PDF_REDACT_IMAGE_NONE, graphics=LINE_ART_NONE)` → **图片永不删除**。
- **实测**（临时脚本，构造含图片+公式+参考文献的一页 PDF，mock 翻译后逐条比对）：图片 `1 → 1`；公式行与 `[1] Vaswani …` 原样保留；仅正文/标题被翻译（`[ZH] …`）；`qa.translated=2, skipped=2`。

新增增强：
1. **引用一致性自检**：`qa.citationMismatch` —— 统计正文 `[n]`/`[n,m]`/`[n-m]` 引用在译文中的数量是否与原文一致（模型偶尔会改动引用）。翻译面板显示「引用数不一致 N 段」；`test_translate` 断言该字段存在。
2. **一键预设「仅翻译正文」**（设置 → 翻译技能）：把 `heading/caption/formula/reference/margin` 全部设为「跳过翻译」，只译 `body` —— 版式改动最小；随时可「恢复默认技能」。E2E 新增「技能提供仅翻译正文预设」「预设后仅 body 参与翻译」。

验证：`python tests/test_translate.py`（`TRANSLATE_OK`）+ `typecheck / npm test / build / test:e2e(E2E_OK)` 全绿。

## 68. 已完成（第五十二轮：阅读区新增「拆解论文」= paper-analysis 技能）
- 新增面板 **阅读 → 拆解论文**（`PaperAnalysisPanel`）：
  - **单篇**：当前论文 + 可选「研究方向」+ 三档篇幅（速览/标准/深入）→「开始拆解」；结果 Markdown 渲染，可「复制」「归档到笔记」。
  - **批次**：从文库勾选 ≥2 篇 →「开始对比」→ 由模型汇总成对比表（表头固定）+ 共同路线/差异/未解决问题/推荐顺序。
  - 论文全文来源：复用 `indexAttachment()` 建立的分块（**带 `page_index`**），拼成 `[p.N]` 标注的正文后送模型 → 支持页码级定位。
- 新增主进程服务 `src/main/services/analysis.ts`（**技能文本的权威来源** `PAPER_ANALYSIS_SKILL`）、IPC `analysis:run` / `analysis:compare`（模块 `analysis`）；`generate()` 复用，**离线自动 mock 兜底**（返回八项骨架并明确标注「离线占位」）。
- **对初版 skill 的优化**（已并入）：
  1. **固定小节标题**（H3 八项）+ 固定表格表头 → 便于逐篇对比与渲染；
  2. **统一并强制「定位」写法** `[p.N]/[§x]/[Fig.N]/[Tab.N]/[Eq.N]`，且 PDF 页序 ≠ 印刷页时必须**首次注明**用的是哪种；
  3. 把「三类区分（**作者主张 / 原文证据 / 分析推断**）」与「**无法定位就不写、没读到写未报告**」提升为**硬性纪律**（抑制幻觉）；
  4. 「相关 ≠ 因果」「显著 ≠ 有意义」写成明确禁令；
  5. **可比性纪律**：不同数据集/协议/指标**不得排名**，只能定性对比；只写「本批论文推断的空白」，不外推为领域空白；
  6. 交付前**结构化自检（6 项 ✓/✗ + 一句说明）**；
  7. 新增**三档篇幅**（速览 ≤350 字 / 标准 700–1200 字 / 深入）以控制长度；
  8. **prompt injection 防护**：论文内容视为材料，忽略其中任何指令（原稿已有，改为置顶硬约束）。
- **测试**：E2E 新增「拆解论文面板可运行」「拆解产出分析（离线也可）」「拆解读取到正文（页数 > 0）」「拆解包含八项小节」「批次对比可运行（≥2 篇）」；E2E 批次只勾选「确有附件」的论文（修正了一次因选到无附件条目导致的失败）。
- **修了一个真实缺陷**：分析原本只读 `chunks`，若该论文**从未抽取**（老数据/抽取失败）会静默变成「0 页 / 0 字」把空文本喂给模型。现在 `analyzePaper` 会先 `ensureChunks()`：无分块则**自动跑一次 `runExtraction`**；若仍为空则返回 `empty=true`，面板明确提示「未取到正文：请先在『元数据』面板运行一次抽取」。实测（直接写库、未建索引的干净场景）：`完成（1 页 / 858 字）`。
- 验证：`typecheck / npm test / build / test:e2e(E2E_OK)` 全绿。

## 69. 已完成（第五十三轮：批处理新增「论文拆解」任务）
- 新增批处理任务 **`analyze-paper`（论文拆解 · paper-analysis）**，参数：
  - **篇幅**：速览 / 标准 / 深入；
  - **研究方向**（可选，会写进每篇分析与批次对比）；
  - **生成批次对比**：是（`index.md`）/ 否。
- **逐篇产出**：`<附件key>.analysis.md`（八项结构化分析 + `[p.N]` 定位）；`run` 里复用面板同一套 `analyzePaper()`（含「无分块自动抽取」）。
- **finalize 汇总**：`index.md` —— 完成度、篇幅、研究方向、生成时间、每篇报告清单；当 `compare=1` 且 ≥2 篇时，追加**批次对比表**（共同路线/差异/未解决问题/推荐顺序）。
- **重构**：把「按卡片汇总」抽出为 `compareFromCards()`，**面板与批处理共用**（避免两处 prompt 漂移）。
- 文档/测试：README 批处理任务表新增一行；E2E 任务清单加入 `analyze-paper`，并**真跑一个 `scope=all` 作业**（2 篇）断言「逐篇 done」+「`index.md` 含批次对比」。
- 验证：`typecheck / npm test / build / test:e2e(E2E_OK)` 全绿。

## 70. 已完成（第五十四轮：拆解归档到笔记 + 技能文本可编辑）
1. **批处理「归档到笔记」**：`analyze-paper` 新增参数 **归档到笔记（是/否）**；为「是」时把每篇拆解写入该论文笔记的小节 **`论文拆解（<篇幅>）`**（复用 `notes.upsertSectionInItemNote`，**重复跑是替换而非追加**）。
2. **拆解技能可编辑（文件化）**：技能文本从「写死在代码里」改为 **`data/skills/analysis/paper-analysis.md`** 优先：
   - `services/analysis.ts` 新增 `analysisSkillPath/ensureAnalysisSkill/readAnalysisSkill/saveAnalysisSkill/resetAnalysisSkill`；首次使用自动写入内置文本，**不覆盖用户改动**；读取缺失时回退内置。
   - `analyzePaper` 与 `compareFromCards` 都改用 `readAnalysisSkill()`（**面板与批处理共用同一份**）。
   - IPC `analysis:getSkill / saveSkill / resetSkill`；设置里新增「**论文拆解技能（paper-analysis）**」编辑区（textarea + 保存技能 / 恢复内置 + 状态提示）。
- **测试**：E2E 新增「论文拆解任务含『归档到笔记』参数」「拆解结果自动归档到笔记」「设置里有论文拆解技能编辑区」「技能文本可读取 / 可保存 / 可恢复内置」。
- 验证：`typecheck / npm test / build / test:e2e(E2E_OK)` 全绿。

## 71. 已完成（第五十五轮：维度子集 / 汇总笔记 / 长文分段合并）
1. **分析维度子集**：面板新增 8 个维度勾选框（`analysis-sec-N`）；`analyzePaper({sections})` 把子集写进 prompt（**只输出所选小节，不写占位**），mock 骨架同样只输出所选维度，返回里带 `sections`。批处理参数新增 **分析维度**（全部八项 / 核心四项 3-4-5-6 / 速览三项 1-3-5）。
2. **汇总写入独立笔记**：新增 `notes.upsertSectionInStandaloneNote(key, title, sectionTitle, content)`（`item_id` 为空、key 固定的「独立笔记」，跨多批**长期累积**）；批处理参数 **汇总笔记**（是 → 把 `index.md` 写入「论文拆解汇总」笔记的 `批次 <jobKey>` 小节，产出里附 md 路径）。
3. **长文分段合并（map-reduce）**：`analyzePaper` 在**已配置真实模型**且正文超过该档预算时，按页**切段分析**（每段只给事实与 `[p.N]` 定位）→ 再合并成完整报告，并在「阅读覆盖」写明「共 N 页、按 M 段合并」；返回 `reduced=true`，面板提示「长文分段合并」。切段逻辑抽成**无依赖纯函数** `src/main/services/analysis-chunk.ts`（`splitByBudget`）。
4. **测试**：`scripts/test-unit.ts` 新增 `splitByBudget` 三条断言（预算足够→单段覆盖 1–5 页；预算小→多段且页序不倒退、覆盖完整；空输入→空）；E2E 新增「可只输出所选维度（子集）」「拆解汇总可写入『论文拆解汇总』笔记」。
- 验证：`typecheck / test:unit(UNIT_OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK)` 全绿。

## 72. 已完成（第五十六轮：拆解里的 `[p.N]` 可点击跳原文）
- 面板会把结果里的 `[p.N]` **渲染成原文深链** `paperdesk://open?attachment=<key>&page=N`：点击即在阅读器跳到该页（复用既有深链通道；附件 key 由 `attachments.listByItem` 解析）。
- `urlTransform` 放行自定义协议；`a` 组件里 `paperdesk://` 走 `onDeepLink`，其余走 `openExternal`。
- 离线 mock 骨架里也带一个 `[p.1]` 定位示例，便于直接体验/验证定位格式。
- 测试：E2E 新增「拆解中的 `[p.N]` 可点击跳原文」（轮询 + **读 `href` 属性**，避免 `innerHTML` 把 `&` 转义成 `&amp;` 的误判）。
- 验证：`typecheck / npm test / build / test:e2e(E2E_OK)` 全绿。

## 73. 已完成（第五十七轮：证据自检 / 调用次数 / 总览累积 / 可比性守卫）
1. **证据自检（确定性、可量化）**：新增**纯模块** `src/shared/analysis-check.ts`（`checkAnalysis` / `formatQuality` / `appendOverviewRow`）——统计定位标记数、疑似结论行数、其中带定位的比例、密度（每千字）、缺失定位的示例行、识别到的小节编号（**代码块内不计**）。
   - 面板结果下方显示「定位 N 处 · 结论行 M 条（K 条带定位，X%）· 密度 D/千字」+ 缺定位示例（`data-testid="analysis-quality"`）；
   - 批处理每篇报告的正文前加一行 `> 证据自检：…`，作业消息里也带上 `自检 定位/结论`。
2. **模型调用次数提示**：`analyzePaper` 返回 `calls`（一次性=1；长文分段=N+1），面板提示「模型调用 N 次」，批处理消息同样显示——便于评估成本/低峰调度。
3. **汇总笔记「总览」跨批累积**：`notes.readSectionFromStandaloneNote()` + `appendOverviewRow()`；`finalize` 每次都在「论文拆解汇总」笔记里维护 **总览表**（批次 / 时间 / 篇数 / 篇幅 / 维度 / 定位-结论），并**不重复表头**，可长期演进成综述索引。
4. **对比表可比性守卫**：`compareFromCards` 在多篇卡片里找不到可比信息（数据集/指标/基准）时，**自动追加**「⚠️ 仅供定性参考，不要直接排名」提示（面板与批处理共用同一段逻辑）。
5. **测试**：`test:unit` 新增 7 条断言（`checkAnalysis` 定位/小节/结论/缺定位、`formatQuality` 文案、`appendOverviewRow` 表头与累加）；E2E 新增「拆解给出证据自检」「拆解结果提示模型调用次数」「拆解报告含证据自检」「批次对比含可比性守卫提示」。
- 验证：`typecheck / test:unit(UNIT_OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK)` 全绿。

## 74. 已完成（第五十八轮：拆解差异对比 / 多套技能 / 批处理估算 / 导出 HTML）
1. **拆解「与上次对比」**：`lineDiff` 抽到**纯模块** `src/shared/diff.ts`（`DiffRow`/`lineDiff`/`diffStats`），翻译面板改为复用（渲染逻辑不变）；拆解面板记住同一篇的历次结果（最多 3 次），结果下方出现 **`analysis-diff-toggle`**「与上次对比（+A / −R）」，展开后按 `lineDiff` 渲染统一差异视图（`analysis-diff`，复用 `.diffrow` 样式），并有「只看改动」开关（`analysis-diff-only`）。
2. **多套拆解技能**：`services/analysis.ts` 的技能读写改为**按名字**（`listAnalysisSkills`/`readAnalysisSkill(name)`/`saveAnalysisSkill(text,name)`/`resetAnalysisSkill(name)`/`copyAnalysisSkill(from,to)`/`deleteAnalysisSkill(name)`），文件落在 `data/skills/analysis/<名字>.md`；`analyzePaper`/`comparePapers` 支持 `skill` 参数（面板「技能」下拉切换、批处理同样可指定）。
   - 设置里论文拆解技能区改为：**下拉选择要编辑的技能** + `保存技能` / `恢复内置内容` / `另存为…`（配内联新名字输入 `analysis-skill-newname`）/ `删除`（内置不可删，二次确认，不弹系统框）。
   - IPC 新增 `analysis:listSkills / copySkill / deleteSkill`（`getSkill/saveSkill/resetSkill` 增加可选 `name`）。
3. **批处理「预计模型调用」**：纯函数 `src/shared/batch-estimate.ts`（`callsPerUnit`/`estimateBatch`，拆解按篇幅档位、translate 按每篇 1 次、embed 本地 0、compare 另加 1 次汇总）；`queue.estimateJob(input)` 复用 `resolveTargets` 得到目标数；IPC `batch:estimate`；批处理面板在「创建作业」旁**实时显示**「将处理 N 项 · 预计模型调用 ≈ M 次（粗略…）」。
4. **导出 HTML（可折叠、带页码锚点）**：纯模块 `src/shared/md-html.ts`（`markdownToHtml`）把拆解 markdown 转成**自包含 HTML**——`### 小节` → `<details>` 可折叠，`[p.N]` → `#pN` 锚点，转义防注入，嵌入打印友好样式；面板「导出 HTML」按钮经 `translate.saveReport` 另存 `.html`。
5. **测试**：`test:unit` 新增 `markdownToHtml`（折叠/锚点/粗体代码/防注入/标题说明）、`callsPerUnit`/`estimateBatch` 断言；E2E 新增「拆解支持『与上次对比』」「对比视图渲染差异行」「拆解面板有技能选择器」「拆解结果有『导出 HTML』按钮」「拆解技能可列出/另存为/删除」「批处理估算返回计数与调用次数」「批处理面板显示预计调用提示」。
- 验证：`typecheck / test:unit(UNIT_OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，136 PASS / 0 FAIL)` 全绿。

## 75. 已完成（第五十九轮：小节折叠 / 内置技能模板 / 作业明细汇总 / 对比导出 CSV）
1. **拆解结果按小节折叠**：纯函数 `splitBySections(markdown)`（`src/shared/md-html.ts`，代码块内 `###` 不计）把结果切成「引言 + 小节」；面板用 `mdSections()` 把每个 `###` 渲染成 `<details class="analysis__sec">`（默认展开），并提供 **`analysis-collapse-toggle`「折叠全部小节 / 展开全部」**（通过 `key` 重挂载让 `open` 生效）。`.analysis__md` 内的深链/查找等行为不变。
2. **内置技能模板**：`analysis.ts` 新增 `BUILTIN_ANALYSIS_SKILLS`（`paper-analysis` + `survey` 综述向 / `method` 方法向 / `reviewer` 审稿人视角，三套都**要求输出同样八个 H3 小节**以保证下游一致）；`ensureAllAnalysisSkills()` 首次使用时把四套写入 `data/skills/analysis/`（**不覆盖用户改动**）；`listAnalysisSkills` 内置在前；`readAnalysisSkill(name)` 文件优先、否则回退对应内置模板；`isBuiltinAnalysisSkill` 使**内置不可删除/不可被另存覆盖**。设置里技能下拉标注「（内置）」，删除按钮对内置禁用。
3. **批处理作业明细汇总**：展开作业行时，明细列表上方新增 **`batch-items-summary-<id>`**「共 N · 完成 D · 失败 F（· 其它 M）」，一眼看清成败。
4. **对比表导出 CSV**：纯函数 `markdownTableToCsv(markdown)`（`src/shared/md-table.ts`，取第一张表、跳过分隔行、去粗体、按 CSV 规则转义引号/逗号）；面板「批次对比」新增 **`analysis-compare-csv`「导出 CSV」**；`translate.saveReport` 增加 CSV 过滤器。
5. **测试**：`test:unit` 新增 `splitBySections`（引言/小节/代码块内不计）、`markdownTableToCsv`（跳分隔行/去粗体/逗号加引号/引号转义/无表返回空）断言；E2E 新增「拆解结果按小节渲染为可折叠块」「小节默认展开」「可一键折叠全部小节」「折叠后小节不再展开」「批次对比有『导出 CSV』按钮」「预置三套技能模板」「技能模板可读取」「作业展开显示明细汇总」。
- 验证：`typecheck / test:unit(UNIT_OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿。

## 76. 已完成（第六十轮 · opencode-plugin-opencoder 循环：大纲 / 对比浏览 / 技能差异 / 失败重试 + 一个批处理真 bug）
> 本轮用 opencode-plugin-opencoder 的 **planner → builder → 提交** 循环驱动：planner 出 5 个任务，逐个交给 builder 实现，orchestrator 每任务验证（typecheck/test:unit）后即时提交。
1. **拆解结果「可点击大纲」**（`62c3b94`）：纯函数 `sectionOutline(markdown)`（`src/shared/md-html.ts`，基于 `splitBySections`）返回 `{index,title}[]`；面板在可折叠小节上方渲染 **`analysis-outline`** 目录条（每节 `analysis-outline-<i>`），点击展开对应 `analysis-sec-view-<i>` 并 `scrollIntoView`。
2. **对比表按维度浏览**（`2675d7e`）：纯函数 `markdownTableToRows(markdown)`（`src/shared/md-table.ts`，与 `markdownTableToCsv` 共用解析器）返回 `{header,rows}`；批次对比新增结构化浏览 **`analysis-compare-table`**（`analysis-compare-group` 列选择 + `analysis-compare-filter` 文本筛选 + `analysis-compare-count` 行数），原始 markdown 与 CSV 导出保持不变。
3. **技能模板「预览对比」**（`38804ae`）：面板新增 `analysis-skill-diff-target` 下拉；选中后拉取两份技能文本，用共享 `lineDiff/diffStats` 渲染只含改动行的 **`analysis-skill-diff`** 差异（头部 `技能差异（A → B）：+n / −m`）。
4. **批处理「只重试失败项」**（`2683d95`）：纯函数 `retryTargets(job, items)`（`src/main/services/batch/retry.ts`，仅终态且存在有效失败项）；`queue.createRetryJob` 复用抽出的 `insertJob` 并启动 `pump`；新 IPC **`batch:retryFailed`**（channels/ipc/preload/api 四处同步）；面板对「已结束且有失败」的作业显示 **`batch-retry-<id>`「只重试失败项」**。
5. **顺带修掉一个真 bug**（`1b3d103`，由 E2E 暴露）：`removeJob` 过去对**未运行**的作业也把 id 留在内存 `cancelled` 集合里，而删除行后 SQLite 会**复用 rowid**，导致之后的新作业一入队就被误判「已取消」、明细卡在 `pending`。改为**仅运行中的作业**加入 `cancelled`，否则清除标记。
6. **测试**：`test:unit` 新增 `sectionOutline`(3)、`markdownTableToRows`(4)、`lineDiff/diffStats`(2)、`retryTargets`(7) 断言；E2E 新增「大纲条目数=小节数且可点击展开」「对比表筛选（无匹配=0 行、清空>0 行）」「技能差异块存在且含 +/− 计数」「retryFailed API 存在 / 无失败项被拒绝 / 无附件条目的 embed 作业确定性失败 → 显示重试按钮 → 重试作业仅含原失败项」。
- 验证：`typecheck / test:unit(UNIT_OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿（`batch:retryFailed` 的确定性失败 E2E 在修掉 rowid 复用 bug 后通过）。

## 77. 已完成（第六十一轮 · opencoder 循环：大纲联动 / 失败聚合 / 筛选导出 / 一键套用技能）
> 继续用 opencode-plugin-opencoder 的 planner → builder → 提交 循环；本轮 5 个任务，每任务通过 `typecheck`（+ `test:unit`/`node --check`）后即时提交。
1. **拆解大纲「当前小节高亮」**（`6cf40ed`）：面板根 `.panel`（滚动容器）挂 `IntersectionObserver`（`root` 为该容器、`rootMargin` 偏上），随滚动把「当前可见小节」标到对应大纲按钮 `data-active`；点击大纲按钮即刻置为激活再滚动。
2. **作业详情「失败原因聚合」**（`8341370`）：纯函数 `topFailReasons(items, top)`（`src/shared/batch-fail.ts`，仅计 `failed`、空消息折叠为「（无信息）」、按次数降序取 Top N，`total` 仍计全部失败）；展开作业时显示 **`batch-fail-reasons-<id>`**「失败原因（Top N）」与 **`batch-copy-failed-<id>`「复制失败清单」**。
3. **对比表「导出当前筛选」**（`beec3b4`）：纯函数 `tableRowsToCsv(header, rows)`（`src/shared/md-table.ts`，复用 `csvCell` 转义）；对比浏览新增 **`analysis-compare-csv-filtered`「导出筛选结果（N）」**（筛选为空时禁用）；原有「导出 CSV（全部）」保持不变。
4. **技能差异「一键设为当前技能」**（`50b8ddd`）：`analysis-skill-diff` 内新增 **`analysis-skill-diff-apply`「设为当前技能」**：切换 `skill`（下拉与标签即时更新）并清空差异，**不自动触发模型调用**。
5. **测试**：`test:unit` 新增 `topFailReasons`(4)、`tableRowsToCsv`(4) 断言；E2E 新增「点击大纲后对应项 `data-active` 为真、首项不为真」「展开失败作业出现失败原因块（`×N`）与复制按钮」「筛选为空时导出按钮禁用、清空后可用」「差异块一键套用后技能下拉=目标、标签含目标、差异块消失」。
- 验证：`typecheck / test:unit(UNIT_OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿（本轮未改动主进程，dev 用 HMR 即可）。

## 78. 已完成（第六十二轮 · opencoder 循环：大纲记忆 / 作业筛选 / 失败导出 / 列显隐）
> 继续 opencoder（planner → builder → 提交）循环；5 个任务，每任务验证后即时提交。
1. **拆解大纲「记住上次查看小节」**（`cb7d0a4`）：纯模块 `src/shared/analysis-state.ts`（`analysisSectionKey/parseSectionIndex/clampSectionIndex`）；面板在附件变化时从 `localStorage` 恢复并展开/滚动到该小节，`activeSec` 变化时写回（try/catch，attKey 为空则跳过）。
2. **作业列表「状态 + 关键词」筛选**（`522e352`）：纯函数 `filterJobs(jobs, status, keyword)`（`src/shared/batch-filter.ts`，`active`=queued/scheduled/running，关键词大小写不敏感、空即全部）；面板新增 `batch-filter-status` 下拉与 `batch-filter-keyword` 输入，标题显示「显示 N / 共 M」。
3. **失败清单导出**（`c0a9767`）：纯函数 `failedItemsToMarkdown` / `failedItemsToCsv`（`src/shared/batch-fail.ts`，仅失败项，无失败返回空串）；展开失败作业新增 `batch-export-failed-md` / `batch-export-failed-csv`（经 `translate.saveReport` 另存；E2E 只断言存在，避免弹系统保存框）。
4. **对比表列「显示/隐藏」**（`3d5eeb1`）：纯函数 `visibleColumnIndexes` / `projectRows`（`src/shared/md-table.ts`，隐藏全部时回退首列）；对比浏览新增每列开关 `analysis-compare-col-<i>`（`data-hidden`），隐藏集合持久化到 `localStorage`，表头/表体与「导出筛选 CSV」都按可见列渲染，`compareCol` 不在可见列时回退首列。
5. **测试**：`test:unit` 新增 `analysisState`(4)、`filterJobs`(8)、`failedItemsTo*`(3)、`visibleColumnIndexes/projectRows`(6) 断言；E2E 新增「大纲写回 localStorage」「作业筛选无匹配=0 行、清空>0 行」「失败导出按钮存在」「隐藏列后 th 数减 1 且 `data-hidden`=true、再点恢复」。
- 验证：`typecheck / test:unit(UNIT_OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿（本轮未改动主进程）。

## 79. 已完成（第六十三轮 · opencoder 循环：按失败原因筛选 / 表头首列吸顶 / 大纲键盘导航 / 筛选持久化）
> 继续 opencoder 循环（planner → builder → 提交）；6 个任务合并为 5 次实现提交 + 1 次文档，每任务验证后即时提交。
1. **按失败原因筛选作业**（`bd27633`）：`batch-fail.ts` 导出 `NO_FAIL_MESSAGE`/`normalizeFailMessage`；新增纯模块 `src/shared/batch-fail-filter.ts`（`collectFailReasonOptions` 跨作业合并计数、`selectJobIdsByFailureReason` 空原因返回全部否则精确匹配）；面板缓存终态作业的失败原因并新增 `batch-filter-fail-reason` 下拉。
2. **对比表「表头 + 首列吸顶」**（`6905a0d`）：对比表包一层横向滚动容器；`thead th` 与**首个可见列**（`analysis__table-fixed-col`）`position: sticky`（首列隐藏后自动改钉住新的首可见列）。
3. **大纲键盘导航**（`97c18a1`）：抽出 `jumpToSection(i)`；大纲按钮用 roving tabindex，ArrowUp/Down/Left/Right 在项间移动焦点（越界钳制），Enter/Space 走原生按钮点击；保留点击、`data-active`、滚动联动与持久化。
4. **作业筛选持久化**（`259ef32`）：`batch-filter.ts` 新增 `BATCH_JOB_FILTER_KEY`、`parseBatchJobFilter`、`serializeBatchJobFilter`；面板懒加载 + 变更时写回 `localStorage`。
5. **测试**：`test:unit` 新增 `normalizeFailMessage`/`selectJobIdsByFailureReason`(4)/`collectFailReasonOptions`(3)、`parse/serializeBatchJobFilter`(4) 断言；E2E 新增「失败原因下拉存在」「表头与首列 sticky」「ArrowDown/Up 焦点移动、Enter 展开小节」「筛选值持久化并在切面板后恢复」。
- 验证：`typecheck / test:unit(UNIT_OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿（本轮未改动主进程）。

## 80. 已完成（第六十四轮 · opencoder 循环：跨作业重跑 / 对比列排序 / 大纲搜索 / 失败原因多选）
> 继续 opencoder 循环（planner → builder → 提交）；7 个任务合并为 4 次实现提交 + 1 次测试加固 + 1 次文档。
1. **跨作业「一键重跑全部失败项」**（`ef6ccd1`）：纯函数 `selectRetryAllPlan`（`src/shared/batch-retry-all.ts`，仅终态、按 task 归并、跨作业去重）；`queue.createRetryAllJobs` 复用 `insertJob`/`labelFor`；新 IPC **`batch:retryAllFailed`**（channels/ipc/preload/api 同步）；面板新增 `batch-retry-all`「重跑全部失败项」（无失败作业时禁用）。
2. **对比表「按列排序」**（`06ab145`）：纯函数 `sortRowsByColumn`/`nextSortState`（`src/shared/md-table-sort.ts`，稳定、数字感知、空值置后）；表头可点击 `analysis-compare-sort-<col>`（`data-sort` asc/desc），排序与筛选/隐藏列/导出组合（隐藏列时忽略排序）。
3. **大纲「搜索小节」**（`e006e83`）：纯函数 `filterOutlineIndexes`（`src/shared/outline-search.ts`）；大纲上方 `analysis-outline-search` 输入，仅渲染命中项（保留原索引），键盘导航跟随过滤集，空态 `analysis-outline-empty`。
4. **失败原因「多选」筛选**（`75ee3a5`）：`selectJobIdsByFailureReasons`（ANY 命中；单选函数保留为包装）；面板把下拉改为复选框组 `batch-filter-fail-reason`（`…-opt-<i>`）+ `batch-filter-fail-reason-all` 清空。
5. **测试加固**（`4c07eb5`）：大纲新增搜索输入与既有 `analysis-outline-` 前缀冲突 → 计数仅统计大纲容器内的按钮；把易随滚动联动抖动的「其它项不高亮」改为**「同时只有一项高亮」**不变量。
6. **测试覆盖**：`test:unit` 新增 `selectRetryAllPlan`(6)、`sortRowsByColumn/nextSortState`(11)、`filterOutlineIndexes`(5)、`selectJobIdsByFailureReasons`(5) 断言；E2E 新增「retryAllFailed API/按钮」「排序 asc→desc→换列重置」「大纲搜索过滤与清空」「失败原因多选」。
- 验证：`typecheck / test:unit(UNIT_OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿（本轮**改动了主进程** `batch:retryAllFailed`，需重启 dev）。

## 81. 已完成（第六十五轮 · 需求驱动：翻译提速/交互/联动 + Zotero 精简版 + VOSviewer 精简版）
> 本轮按用户新需求分三阶段落地（opencoder builder 逐任务实现并即时提交）。
### A. 翻译（3 个提交）
1. **提速（`faa6395`）**：`python/app/translate.py` 原先把 `(内容类型, 章节)` 分组**串行**处理（组内并通常只有 1 个 chunk ⇒ 实际接近串行）。改为把**所有组的 chunk 汇总进同一个 `ThreadPoolExecutor`** 全局并行，失败块按指数退避**重试**（`mt.retries` 默认 2）而非丢块；新增可单测的纯函数 `plan_chunks` / `build_chunk_plan`；主进程默认并发 `mt.workers` 4→6。**prompt/分块/QA 未改，质量不降**。
2. **交互（`1e38dcf`）**：点「翻译」立即把右栏切到**翻译面板**；完成后若有对照文档则**默认打开「中英对照」**（否则网页/PDF）。新增 `panel-tab-<id>`、`view-bilingual` testid。
3. **联动高亮（`5a9e78b`）**：对照视图内，悬停/划词 `.src`（英文）↔ `.dst`（译文）**双向**高亮对应段落（同一 `.pair`，单一激活高亮，移出/外点清理）；仅 `bilingual` 类型，不影响命中高亮/滚动/主题/F3。
### B. Zotero 精简版（`704d534`）
- `src/main/services/fetch-pdf.ts`：识别 **DOI / arXiv / 网页 URL** → arXiv 直取 `arxiv.org/pdf`；DOI 走 **OpenAlex** OA location；URL 抓页面**嗅探** `citation_pdf_url` / `rel=alternate application/pdf` / `.pdf` 链接 → 下载（大小/超时受限）→ 复用 `importPdfFromPath` 入库。IPC `library:importFromUrl`（channels/ipc/preload/api 同步），文库面板加「从链接导入」输入。纯函数 `normalizeIdentifier`/`extractPdfLinks` 单测。
### C. VOSviewer 精简版（`13c473a`）
- `src/shared/biblio.ts`：纯函数 `buildCoAuthorGraph`（合作作者）/`buildKeywordGraph`（关键词共现）+ `clusterByLabelPropagation`（确定性标签传播聚类）+ `topSubgraph`；主服务 `biblio.get(kind)` 读 `item_authors`/`item_tags`；新面板 **「文献网络」**（研究组）以 SVG 圆形布局（按聚类分组、边宽=共现次数、聚类配色、Top 标签、节点/边/聚类计数）呈现，支持「作者/关键词」切换。IPC `biblio:get`。
### 测试与验证
- `test:py` 新增 `plan_chunks`/`build_chunk_plan`(5)（`TRANSLATE_OK`）；`test:unit` 新增 `normalizeIdentifier`/`extractPdfLinks`(13)、`buildCoAuthorGraph`/`buildKeywordGraph`/`clusterByLabelPropagation`/`topSubgraph`(11) 断言；E2E 新增「翻译面板自动切换 + 默认对照」「对照双向联动高亮」「从链接导入 API」「文献网络面板/类型选择」。
- 验证：`typecheck / test:unit(UNIT_OK) / test:py(OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿（**主进程与 Python 侧车均有改动，需重启 dev**）。
- 后续（未做）：PDF 原文 ↔ 对照的跨视图联动；Zotero 浏览器扩展连接器；VOSviewer 的 VOS 布局/共被引/文献耦合。

## 82. 已完成（第六十六轮 · 需求驱动：双 PDF 对照 / 修复切换按键丢失 / 网络增强 / Zotero 深化）
> 继续 opencoder builder 逐任务实现并即时提交。
1. **「对照」= 原文PDF + 译文PDF 并排（`cc58789`）**：新增 `SplitPdfView`（左右两个**完整** PdfViewer：原文本可批注、译文只读），界面与既有阅读页一致（各自页码/缩放/查找/批注）；顶栏「对照」→ 新 `split` 视图，翻译完成后**默认进入并排对照**；可选「同步翻页」（PdfViewer 新增可选 `syncPage`/`onPageChangeExternal`，默认关闭不影响原行为）。旧的「逐行中英对照 HTML」不再作为对照视图（仍保留给搜索命中显示）。
2. **修复「原文/译文切换按键经常丢失」（`cc58789`）**：根因是附件切换的 effect 在**重新查询期间把 `translation` 置空**。现按附件**缓存译文**（`translationCache`）并先同步回填，查询返回空时**仅在无缓存时才清空**（纯函数 `pickTranslation` 单测），按键不再闪没。
3. **文献网络增强（`3477d5b`）**：`shared/biblio.ts` 新增 `buildCouplingGraph`（**文献耦合**，节点=条目）/`buildCoCitationGraph`（**共被引**，节点=参考文献）/`vosLayout`（**确定性 VOS 式布局**，无随机）；主服务读 `citations`/`works`；面板 4 种类型、VOS 布局、**点击节点下钻**到对应条目（`onOpenTarget`）。IPC 放行全部 kind。
4. **Zotero 深化（`e8a5a37`）**：`parseBulkInput` 支持**多行/逗号/分号批量** DOI/URL；DOI 无 OA 时 **Unpaywall 兜底**；导入前**按 DOI 去重**（已存在则跳过）；新增 `library:importManyFromUrls`（并发 2，逐条结果汇总），文库面板输入改为多行 textarea + 状态行。
### 测试与验证
- 新增单测：`pickTranslation`(4)、`buildCouplingGraph`/`buildCoCitationGraph`/`vosLayout`(7)、`parseBulkInput`(6)；E2E 更新为「并排对照两侧含页码」「切换按键不丢失（回归守卫）」「耦合/共被引图返回」「类型选择≥4」。
- 验证：`typecheck / test:unit(UNIT_OK) / test:py(OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿（**主进程有改动，需重启 dev**）。
- 后续（未做）：并排视图**跨窗联动高亮**（需块级映射）；Zotero 浏览器扩展连接器；文献网络导出（Pajek/GEXF）。

## 83. 已完成（第六十七轮 · 布局调宽 / 并排联动高亮 / 网络导出 / Zotero 连接器）
1. **左右栏自由调宽 + 默认加大中间区（`0095a29`）**：`App.tsx` 默认 `sbW 276→232`、`rcW 380→300`（中间阅读/对照区更宽），两侧拖拽范围放宽（侧栏 150–520、右栏 200–780），宽度仍持久化。
2. **并排对照「跨窗联动高亮」（`b549bdb`）**：`PdfViewer` 新增 `onSelectionRects`（选区变化时上报 `{page,rects}`）与 `syncRects`（外部只读覆盖层，新增每页 `syncLayer`）；`SplitPdfView` 双向接线：在任一侧划词 → 另一侧**同页同矩形**高亮（译文就地覆盖，故矩形近似对齐）。仅高亮、不强制滚动。
3. **文献网络导出 Pajek/GEXF（`ababd9b`）**：`shared/biblio.ts` 新增纯函数 `toPajek`/`toGexf`（确定性、空图也良构、标签转义）；IPC `biblio:export` 经 `saveReport` 另存；面板「导出 Pajek / 导出 GEXF」+ 状态行。
4. **Zotero 连接器（`96684d2`）**：`connector.ts` 起一个 **127.0.0.1** HTTP 接收端——`GET /ping`、`POST /import`（带 `x-paperdesk-token`；body `{url|doi}`）→ 复用 `importFromUrl` 入库；CORS+OPTIONS、body 上限、绝不抛异常；随 app ready 启动、will-quit 关闭；设置里显示 URL/token/复制与用法示例；`index.html` 的 CSP `connect-src` 放行 `127.0.0.1`。
### 测试与验证
- 新增单测：`toPajek`/`toGexf`(8)、`checkToken`/`parseImportRequest`(6)；E2E 新增「导出 API/按钮」「连接器 status + `/ping` + 缺 token 的 `/import` 401」「并排两侧 sync 层存在且初始为空」。
- 验证：`typecheck / test:unit(UNIT_OK) / test:py(OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿（**主进程有改动，需重启 dev**）。
- 后续（未做）：并排联动高亮可升级为**块级映射**（更精确）；连接器可加「整页 HTML 抓取 PDF 链接」与书签脚本；文献网络导出可加 CSV/JSON。

## 84. 已完成（第六十八轮 · 按「内容对应 + 中文重排」改对照）
> 用户反馈：截图里左右内容不对应、译文排版不适配中文；**优先内容对应 > 译文排版 > 界面**。据此把对照从「双 PDF」改为**左原文 PDF + 右可重排中文阅读区**。
1. **译文「可重排阅读区」（`492fed4`，侧车）**：`_write_translation_html` 重写——**不再把中文塞进原文框**，而是按中文阅读习惯重排（系统 CJK 字体栈、正文 17px/行高 1.95、760px 版心、h1/h2/h3 分级、公式居中、深色模式）；每页 `section.pg[data-page=N][id=pg-N]`、每块 `data-page`/`data-pid` 锚点（供联动）；**图表原图以 base64 内嵌**并按阅读顺序插入（`figure > img`）。译文 PDF / 中英对照 HTML 保持不变。
2. **对照视图改造（`5eb23fb`，渲染层）**：新增 `CompareView` = 左 `PdfViewer`（隐藏内层工具栏）+ 右 `iframe`（可重排译文 HTML）；**单一合并工具栏**（联动开关默认开 / 上一页·下一页·页码 / 查看译文 PDF / 收起侧栏）。**内容级联动双向**：左 PDF 翻页 → 右定位到 `[data-page]` 并高亮该页；点击右侧任一段落 → 左 PDF 跳到其 `data-page`；左侧划词 → 右侧同页联动。进入对照**自动收起右栏**（可一键展开），两页因此更宽。弃用并删除 `SplitPdfView`。
### 测试与验证
- 侧车：`python/tests/test_translate.py` 扩展「figures 内嵌 + data-page/data-pid 锚点」（31 PASS，`TRANSLATE_OK`）；`test_structure`/`test_export` 仍 OK。
- E2E 断言改为：翻译后存在 `compare-view` / `compare-pane-original` / `compare-pane-translation` / `compare-html` / `compare-toolbar`，且 `compare-sync` 默认勾选；保留 `view-split` 回归守卫。
- 验证：`typecheck / test:unit(UNIT_OK) / test:py(OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿（**主进程与侧车均有改动，需重启 dev**）。
- 后续（未做）：联动由「按页」升级为**块级精确映射**（`段落ID → 原文页/矩形 → 译文段`）；「保留版式 PDF」与「阅读版式」两种导出模式；图注与图中文字的单独翻译。

## 85. 已完成（第六十九轮 · 阅读工作区重构：多文档标签 + 固定公共工具栏 + 折叠入口）
> 按用户 8 点要求重构为「稳定外层布局 + 统一工作区」。**先修布局/状态，再谈译文排版**。
### 根因结论（逐条查代码，非猜测）
- **译文切换按钮消失**：它写成 `{translation && <seg/>}`，`translation` 被置空就整排消失 → 改为**公共工具栏里始终渲染**，不可用只**置灰**。
- **一级/二级功能栏消失**：上一轮「进对照自动收起右栏」把 `rcW` 直接设为 **0**，而分组/面板栏都在 `.rightcol{overflow:hidden}` 内 → 被压成 0 宽 = 看不见。**属宽度挤压** → 改为**明确的折叠薄条**（永不 0 宽）。
- **可能被遮挡**：PDF 画布/文本层层级 → 工具栏作为 `.viewer` 的**同级兄弟**置于上方，稳定不遮挡。
### 实现
1. **文件标签栏（`eed815a`）**：`TabsBar` —— 一篇论文一个标签（`doc-tab-<id>`，含关闭、横向滚动、`doc-tabs-menu` 下拉）；打开列表 `paperdesk.docs.open` 与当前文档持久化并恢复。
2. **每篇独立阅读状态（`eed815a`）**：纯模块 `src/shared/doc-state.ts`（`docStateKey/parseDocState/serializeDocState/mergeDocState`）；切换文档恢复 **页码/缩放/阅读模式/侧栏折叠**，切回**复用已有译文**；`PdfViewer` 新增 `initialPage/initialScale`。
3. **固定公共工具栏（`bdefe72`）**：`common-toolbar` 常驻，含 **原文/译文/对照/网页**（始终渲染、不可用置灰+提示）、**页码**（上一页/输入/下一页/`N / M`）、**缩放**（适应宽度 / ± / 百分比）、**联动**开关、**查找**；`PdfViewer` 新增受控 `scale/onScaleChange/onFitRequest/zoomMode`（三处 ref 防抖，避免父子回环）；`CompareView` 改为**完全受控**（自带的比较工具栏移除）。
4. **折叠入口（`eed815a`）**：`rcCollapsed`/`sbCollapsed` + `.side-strip` 薄条与 `rc-collapse/rc-expand/sb-collapse/sb-expand`；对照默认收起右栏，但**永远可通过薄条展开**。
5. **`722a360`**：保持「翻译完成默认进入对照」，同时保证阅读器（切到原文/译文）的选区/查找测试通过。
### 测试与验证
- 新增单测：`doc-state`(8)；E2E 新增「文件标签栏 + 当前标签高亮」「`rc-collapse` 收起 → 出现 `rc-strip` → `rc-expand` 恢复（**功能栏不消失回归守卫**）」「公共工具栏常驻：四种模式按钮始终渲染、页码/缩放/联动可用」。
- 验证：`typecheck / test:unit(UNIT_OK) / test:py(OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿（**主进程有改动，需重启 dev**）。
- 后续（未做）：对照两侧**顶部对齐**与「共同适应宽度」的精调；后台标签按需释放 PDF 渲染以控内存；块级精确联动；译文 PDF 的字体/断行/溢出专项（第 8 点）。

## 86. 已完成（第七十轮 · 阅读工作区精修 + agent team 并行：UI/状态 · 渲染 · 排版）
> 主助手先做**模块依赖检查**再分工：`App.tsx` 是共享热点（import PdfViewer/CompareView/TabsBar/HtmlViewer），**UI 重构无法并行**（串行，主助手做）；`PdfViewer.tsx` 被 App+CompareView 共用（单一 owner）；只有 **Python 排版** 与 **渲染排查** 真正解耦 → **只开 2 个并行 agent**，其余由主助手统一改；CSS/e2e/主进程样式由主助手改，避免同文件冲突。
### A. UI/状态重构（主助手，`4511dcc`）
1. 公共工具栏新增**稳定入口**：`文件库/目录/搜索/笔记`（`entry-library/entry-toc/entry-search/entry-notes`），收起后入口仍在。
2. **左侧改为可切换功能面板**：`文件库/目录/搜索` 同一时间只展示一种；点当前入口即收起为薄条；新增 `TocPanel`（页码目录，点击跳页）。
3. **右侧笔记不再常驻**：由「笔记」入口或薄条展开/收起。
4. **首次进入对照自动收起左右面板**（每篇一次，`panelAdjusted` 持久化，之后尊重手动选择）。
5. 每篇独立状态扩展为 **页码/缩放/模式/面板折叠**；切回复用已有译文。
6. e2e 适配：`openPanel` 面板前自动展开右栏、新增 `ensureLeft`；新增入口/目录断言。
### B. PDF 渲染（agent A2，owner：`PdfViewer.tsx`）
- **黑屏根因**：同一 `<canvas>` 上并发 `page.render()`——pdf.js 静态 `#canvasInUse` 抛错、且 opaque 位图被 `canvas.width` 赋值清成黑色；错误被 `catch{}` 吞掉、无人重画 → 永久黑屏。修：每页记录 `RenderTask`，重渲染前 `cancel()`，effect 清理取消全部；代际守卫。
- **缩放延迟根因**：受控 `scale` 回环把本次 emit 原样回灌，绕过了 `liveScale→renderScale` 防抖 → 每个滚轮 tick 全量重渲染。修：**echo 守卫** + **立即写 CSS transform**（rAF 合并）+ 防抖 180→120ms + 有界模糊。
- **回归与修复（`70afcd5`）**：首版把「写文本层」绑在 **render-task 身份**上，被后续 `cancelInFlight()` 清表后成立失败 → 切模式后 `.textLayer` 为空（选区/查找失效）；主助手用**二分**（回退该文件即 `E2E_OK`）定位并**交回 A2**。改为按**代际**写文本层 + 界内**自愈重试**（≤3）+ 画布白底兜底（绝不黑屏）。
### C. 译文排版（agent A3，`228630f`，owner：`python/`）
- `_TR_CSS` 中文阅读重排（720px 版心/1.9 行高/标题相对分级/避孤行/深色）；**题注 `.caption` 独立成块**、**图 `.fig` 保持原样**、**公式 `.formula` 逐字保留且不并入段落**、行内 `$…$`/`\(…\)` 提取为 `.math`；译文 PDF 与中英对照 HTML/MD 输出不变；`test_translate/structure/export` OK。
### 验收（主助手统一，非“各自通过即算完”）
- `typecheck / test:unit(UNIT_OK) / test:py(OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿；**回归点** 黑屏 / 连续缩放 / 文件切换 / 对照阅读 / 译文排版 均通过。
- 提交：`4511dcc` UI · `228630f` 排版 · `15eb862`+`70afcd5` 渲染。
- 后续（未做）：对照两侧顶部对齐 / 共同适应宽度精调；后台标签按需释放渲染；块级精确联动；译文 PDF 排版专项（单独任务）。

## 87. 已完成（第七十一轮 · PDF 阅读体验：黑屏根因修复 + 缩放实测优化 + 译文视觉质量）
> 继续「主助手做依赖划分 + 2 个解耦 agent 并行 + 主助手统一验收」。owner：渲染=R（`PdfViewer.tsx`/`lib/pdf.ts`）、排版=T（`python/`）、CSS/e2e/整合=主助手。
### A. 黑屏（优先级 1，agent R `01b6881`）——根因而非掩盖
- **根因**：`renderPage` 先给**可见 canvas** 赋 `width/height`（pdfjs 的 `alpha:false` 会把后盾位图清成**不透明黑**），随后 `page.render()` **并未绘制**：① 文档/页在渲染中被销毁 → `sendWithPromise`/`Page was destroyed` 抛错；② pdfjs 对已销毁页 `render()` **静默 complete**（`await` 成功但没画）。旧代码的 `catch{}`+重试+**白底兜底**只是把症状涂白（插桩实测一次切模式后有 7 页靠白底兜底）。
- **修复**：改为**离屏 canvas 渲染成功后原子提交**（一次同步 `width/height`+`drawImage`），新帧就绪前保留旧帧；显式识别 `destroyed`/哨兵像素"未绘制"并放弃；中止类错误静默放弃；**真正失败显示每页错误态 + 「重试」按钮**，删除白底兜底。
- 验证：同一组操作（缩放/滚轮爆发/跳页/滚动/切文档/切模式/对照缩放）插桩 **0 黑屏样本**，`exceptions: []`。
### B. 手势缩放延迟（优先级 2，agent R，含实测）
- **根因**：① 每次 scale 提交**重渲染所有页**（≤40 页全量、主线程）；② 受控 `scale` 的**滞后回显**覆盖 live 缩放 → 提交比例**来回震荡**（实测 1.81↔2.027↔2.27，20 次滚轮触发 ~14 轮全量）；③ 手势中触发清晰提交。
- **修复**：只重渲染**可见页**（IO 预取）+ 当前页±1，删除"全量渲染"；手势期内**拒绝滞后回显**；手势中清晰提交**推迟到手势结束**（仅 >3.5×/<0.28× 提前）；即时反馈用 rAF 合并的 `transform`；**transform-origin 锚定指针**。
- **实测（30 页矢量 PDF，20 次滚轮 @30ms）**：渲染轮次 **14→1**、页渲染 **80→3–5**、重渲页数 **30→2–3**、主线程卡顿 **4242ms→~1.5s**、提交比例 **震荡→单值**；手指锚点漂移 `≤0.014`。
### C. 译文视觉质量（agent T `9ecf6a5`，owner：`python/`）
- 根因：`_fit_text` 用几何重推字号（封顶 11pt）→ 普遍缩 14–30%；**不检查 `insert_textbox` 返回值 → 静默丢字**；无分栏感知；**矢量图形内文字被翻译**；卡页告警误报；网页公式被展平。
- 修复：按**源字号**、向真实空隙扩展、最后才缩且**≥6.5pt**、检查文本框返回**不丢字**；分栏感知重排；`_figure_regions` 识别**矢量图（形状+文字）并原样保留**（图外图注/正文照常翻译，**公式原样**）；网页保留**数学结构 + `data-tex`**。
- 证据（同合成论文）：双栏正文 9.02→**10.50pt**、标题 11→**16pt**、图注 **丢失→保留 9.0pt**、卡页误报 1→**0**、矢量图区域**像素不变**、公式逐字节保留、页/块映射正确。
### D. 主助手整合（`8b3e5f2`）
- **CSS 稳定化**：`.scrollpages` 改为**安全居中**（`align-items:flex-start` + 内层 `margin-inline:auto` + `overflow-x:auto`）——高倍缩放时页面不再因每次清晰提交重新居中而水平跳动，左侧内容也可横向滚到。
- **e2e 守卫**：新增**「画布非全黑」像素采样**，在**首屏 / 译文 PDF / 缩放与查找后**断言（这是回归守卫，不是掩饰）。
### 验收（主助手统一）
- `typecheck / test:unit(UNIT_OK) / test:py(OK) / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿；覆盖**首次打开 / 快速翻页 / 连续放大缩小 / 文件切换 / 双语对照 / 多文档**；黑屏/连续缩放/对照/译文排版无回归。
- 提交：`01b6881` 渲染（黑屏+缩放）· `9ecf6a5` 译文质量 · `8b3e5f2` CSS+e2e 守卫。
- 未做：对照两侧顶部对齐/共同适应宽度精调；后台标签按需释放渲染；块级精确联动；译文 PDF 个别版式细节（仍有）继续观察。

## 88. 已完成（第七十二轮 · 渐进式重构：计划 + 回退点 + Batch A 界面结构 + 单一顶栏）
> 用户要求「渐进式重构、先给计划存回退版本、不用 agent team，并去掉右栏把功能放到顶栏、左栏做功能区」。主助手直接操作。
- **回退点**：tag `refactor-baseline-20261014` + 分支 `refactor/gradual`（基线 `70da3eb`）。
- **方案文档**：`docs/REFACTOR.md`（模块职责边界、状态分层、迁移顺序 A→E、兼容措施、声明式扩展方式、批处理统一系统设计、新增功能+接入批处理的开发文档）。
- **Batch A（`4a7f3ad`）界面结构**：**删除右栏**；功能区（分组+面板按钮）移到**顶栏**（WPS 式）；**左栏升级为功能区**（文件库/目录/搜索/任意面板，复用现有面板组件+keep-alive）；网格变 **3 列**，阅读/对照区最大化。e2e 全量适配（右栏断言→顶栏功能区/左栏面板、库相关步骤前自动切回文件库、分隔条 2→1）。
- **Batch A.1（`c60ec51`）单一控制面**：顶部公共工具栏成为**唯一**控制面（模式/页码/缩放/联动/查找/入口/翻译）；**隐藏阅读器内层工具条**（消除重复与竖排挤压）；**查找并入顶栏**（PdfViewer 增 `externalFindQuery/findNextTick/findPrevTick/onFindStatus/onFindQueryChange`，CompareView 转发）；工具栏/功能区**单行自动换行**，全部控件可见；并用截图（`npm run shots`）逐次核对视觉。
- 验证：每批 `typecheck / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿。
- 后续：Batch B 状态分层（抽 `useDocState/usePanels`）→ C 功能声明化 → D 批处理任务系统完善 → E 规范收口与废弃清理。

## 89. 已完成（第七十三轮 · 去掉原生菜单行 + 对照右侧改为「译文 PDF」）
- **隐藏原生应用菜单**：`BrowserWindow({ autoHideMenuBar: true })` —— 去掉 `PaperDesk / 编辑 / 视图` 那一行；快捷键仍生效，按 Alt 可临时唤出（截图确认窗口从标签栏开始）。
- **对照右侧改为译文 PDF**（`6112c75`）：`CompareView` 右侧由「可重排 HTML iframe」改为**只读译文 PDF 的 `PdfViewer`**（与原文同版式、就地覆盖）；页/缩放仍由公共工具栏受控，**开启联动时两侧同页**；**跨窗划词高亮保留**（同位近似对齐）。**可重排网页译文仍可用「网页」按钮查看**。e2e 断言由 `compare-html` 改为「译文窗格 canvas」。
- 验证：`typecheck / build / test:e2e(E2E_OK，0 FAIL)` 全绿。
- 之后继续 **Batch B→E**（状态分层 / 功能声明化 / 批处理统一 / 规范收口）。

## 90. 已完成（第七十四轮 · 渐进式重构 Batch B–E）
> 按 `docs/REFACTOR.md` 逐批实施：**一批一提交 + 每批全量 e2e 回归**。
- **Batch B 状态分层（`45e3e0b`）**：新增 `hooks/workbench.ts` —— `useDocTabs`（多文档标签 + 持久化 + 关闭切邻）与 `usePanels`（顶栏功能区 + 左侧功能区状态：`selectTab/toggleLeft/collapseForCompare`）。`App.tsx` 以相同名字消费，**行为不变**、组件变小、状态边界清晰（全局设置 / 单篇文档状态 / 临时界面状态 / 后台任务状态）。
- **Batch C 功能声明化（`b9cedb1`）**：`PanelModule` 增加可选 **`batchTaskId`**；为「拆解论文/翻译/相关论文」声明（`analyze-paper`/`translate`/`find-related`）。顶栏据此**自动生成**「加入批处理」入口（`PanelContext.pendingBatchTask` 中转，打开批处理并预选任务）——**新增功能只需在注册表声明一行**，无需到处改条件判断。e2e 演示：打开「拆解论文」→ 出现入口并预选 `analyze-paper`。
- **Batch D 批处理=统一耗时任务系统（`eca28dc`）**：
  - `BatchTaskHandler` 声明 `resources{cpu,model}` / `supportsPause` / `batchable`（声明式并发/暂停/入队语义）；
  - `queue.runTaskOnce(taskId, target, params)` —— **单次执行复用同一个 `task.run`**（无第二份实现），产物按 `jobKey` 分目录隔离（重复提交/输出冲突规则）；IPC `batch:runOnce` 全链打通；
  - 顶栏同类功能提供 **「立即执行 / 加入批处理」双入口**；重启恢复仍为 `running→queued`（不直接置 running）。
- **Batch E 规范收口（`4bc8c16`）**：删除右栏移除后的**确认废弃代码**（`rcW/setRcW` 及其持久化、`startDrag('rc')` 分支、`rcCollapsed` 状态、`focusFind`）；不引入多余抽象。
- 验证：每批 `typecheck / npm test(SMOKE_OK) / build / test:e2e(E2E_OK，0 FAIL)` 全绿。
- 说明：期间 e2e 一度出现「译文 PDF 空/画布黑/选区」一组失败，定位为**我在 e2e 里真的执行了一次 `runOnce('export-doc')`** 的副作用；改为只断言 API 后全绿（与产品无关）。
- 未做/后续：资源并发限制按 `resources` 实际调度（当前声明已就位）、可暂停任务的暂停实现、后台标签按需释放渲染、块级精确联动、译文 PDF 排版细节。
