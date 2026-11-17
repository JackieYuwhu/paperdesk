# PaperDesk PDF 解析与渲染链路 · 阶段 0 只读审计

> 审计范围：① 上传 → PDF 解析（文本/版面/公式）→ 统一结构化结果；② 结构化文本与双语渲染；③ 按块翻译（Node → Python sidecar → 模型网关）。
> 基线：commit `911758b8`。本轮**不改任何业务代码/数据库结构/上传路径/用户数据**，只新增 `docs/` 下两个文件。
> 方法：静态读码定位到 `文件:行号 函数名`；两个最小复现脚本（现场合成 PDF，不碰用户私有文档）；实跑现有测试套件。复现产物与原始日志在 artifact 目录：`repro_modules.py`、`repro.pdf`、`repro_mask.py`、`result.json`、`stdout.log`（绝对路径见交付清单）。
> 归因约定：把链路切成 5 层——**L1** PDF 文本层（PyMuPDF 原始 span）→ **L2** 统一结构化结果（`StructuredDoc`）→ **L3** 模型输入（sidecar 组装的段落文本）→ **L4** 模型输出与回填（Markdown / 译文 PDF）→ **L5** 前端渲染。「错误首次出现在哪一层」按此编号。

## 1. 技术栈与运行方式

四个层次的进程拓扑（依据 `docs/CODE-MAP.md` §1 与各入口文件）：

| 层 | 组件 | 关键事实 | 锁定位置 |
| --- | --- | --- | --- |
| 渲染进程 | React 19 + pdf.js（pdfjs-dist ^6.4.299） | 只画位图 + 文本层，从不直接读 Python | `package.json:78`、`src/renderer/src/lib/pdf.ts` |
| 预加载/IPC | contextBridge → ipcMain 通道表 | 渲染层唯一入口是 `window.api` | `src/preload/index.ts`、`src/shared/channels.ts` |
| 主进程 | Electron main + better-sqlite3 | 编排、缓存、持久化都在这里 | `src/main/services/extract.ts`、`src/main/services/modules.ts`、`src/main/db/schema.sql` |
| Sidecar | Python 3 + FastAPI + PyMuPDF | HTTP 调用，懒启动，可独立跑测试 | `python/app/main.py`、`python/requirements.txt` |

运行方式（可复现的最小事实）：

- 桌面端脚本：`package.json:11-33` 里 `dev` / `build` / `typecheck` / `test:unit` / `test:coords` / `test:py` / `test:e2e` / `smoke` / `preflight`；不引入新依赖。
- Sidecar 启动命令由主进程拼装，见 python/app/main.py:4：`python -m uvicorn app.main:app --host 127.0.0.1 --port <port>`；懒启动与端口探测在 `src/main/sidecar/manager.ts`（`ensureSidecar`）。
- 应用**不自带 Python**，需部署环境提供 3.10+（python/requirements.txt:2）；依赖锁定 fastapi 0.141.1 / uvicorn 0.34.0 / pymupdf 1.27.2.3 / httpx 0.28.1 / pydantic 2.13.4（python/requirements.txt:4-8）。
- 纯本地能力：解析、结构化、公式树重建、PDF 落版都不联网；只有翻译（模型网关）与公式视觉识别（python/app/main.py:344 `/vision/formula` → `python/app/vision.py`）需要外部模型。
- 数据落盘：单个 SQLite 库，建表见 `src/main/db/schema.sql`；PDF 原文件按 attachment key 存放，由 `src/main/ipc/library.ts` 的 `importPdfFromPath`（398 行）写入。

依赖与运行时的边界很重要：**渲染层没有数学排版引擎**（`src/shared/chat-md.ts` 里没有 KaTeX/MathJax 依赖），公式只能以原文或 `$...$` 纯文本出现——这一条直接决定了第 3 节的结论。

## 2. 端到端链路

下面五段调用链都是从真实代码里读出来的，每跳写成 `文件路径:行号 函数名`（含行号，便于逐跳核对）。

**A. 上传 → 文本解析 → 元数据（L0→L1）**

```
src/main/ipc/library.ts:398 importPdfFromPath
src/main/ipc/library.ts:393 sha256File
src/main/ipc/library.ts:455 extractAndAutoRename
src/main/services/extract.ts:56 runExtraction
src/main/services/extract.ts:211 persist
python/app/main.py:530 extract
python/app/extract.py:243 extract_local
python/app/extract.py:126 page_reading_text
python/app/extract.py:176 infer_title_authors
```

`page_reading_text` 用 `page.get_text("blocks")` 取块，按左右半页计数判断是否双栏并重排（python/app/extract.py:126）。产物只有 `pages[{page,text}]` + `fullText`，**不带 block id，也不带坐标**——所以「结构化文本」不是这条链的产物。本段代码分布在 `src/main/services/extract.ts` 与 `python/app/extract.py`；`persist`（`src/main/services/extract.ts` 211 行起）在返回前写回标题/摘要/年份/会议并插入 chunks（233 / 242 / 246 / 253 / 308 行），后续 chunk 补齐另见 `src/main/services/analysis.ts`。

**B. 结构化统一结果（L1→L2，缓存与公式明细）**

```
src/main/services/modules.ts:263 getModules
src/main/services/modules.ts:195 readCache
src/main/services/modules.ts:222 writeCache
src/main/services/modules.ts:88 writeFormulas
src/main/services/modules.ts:130 getFormulas
python/app/main.py:241 modules
python/app/modules.py:370 extract_modules
python/app/modules.py:105 _raw_blocks
python/app/modules.py:149 _detect_columns
python/app/modules.py:179 _order_and_merge
python/app/modules.py:598 _is_equation_like
python/app/formula.py:697 build_formula
python/app/formula.py:573 render
```

关键实现事实（解析器 `python/app/modules.py`，缓存与公式明细 `src/main/services/modules.ts`）：

- `_raw_blocks`（python/app/modules.py:105）用 `page.get_text("dict")`，一行文本是 `"".join(span 文本)`（python/app/modules.py:113-115），span 的 `size/x/y` 另存（python/app/modules.py:127-135）。**没有插空格、没有上下标标记、没有数学语义还原**——文本层是什么样，结构化结果就是什么样。
- 模块 id 是 `p{页码}-t{序号}`（python/app/modules.py:587 附近），矩形统一转成底边原点四元组（python/app/modules.py:420）。所以「stable id / block type / source region」三件套在 L2 **已经具备**，缺的是更细的块类型与行内数学概念（见 §6）。
- 公式只在「编号与公式在同一个 PyMuPDF 块内」时被识别：`_is_equation_like` → `EQ_TRAILING_NUM_RE` → `mod["eqNo"]`（python/app/modules.py:598-603），LaTeX 由 `build_formula` 用文本 + 矢量线重建（python/app/formula.py:697），并把尾部编号从 LaTeX 里剥掉（python/app/formula.py:715）。

**C. 按块翻译（L2→L3→L4）**

```
src/main/services/translate.ts:528 runTranslationJob
src/main/services/modules.ts:263 getModules
python/app/main.py:807 translate_start
python/app/translate.py:3180 simple_translate
python/app/translate.py:1656 _split_formula_lines
python/app/translate.py:1767 _classify_block
python/app/translate.py:2733 _split_coarse_paragraph
python/app/translate.py:2457 _mask_math
python/app/translate.py:2317 _write_translation_md
```

`runTranslationJob` 先用 L2 的 `rect` 组出 `skipRects`（跳过 `figure` / `table` / `equation` / `reference`，页码转 0 基，见 src/main/services/translate.ts:641），再 POST 给 sidecar（同文件 681 行）。sidecar 侧重新从 PDF 抽块、按样式分组、拆公式行、分类、再按几何切成段落（`_split_coarse_paragraph`），最后对数学垃圾串打 `⟦n⟧` 占位（`_mask_math`）后送模型。编排在 `src/main/services/translate.ts`，逐块实现在 `python/app/translate.py`。

**D. 结构化文本渲染（L4→L5，就是用户截图里的「结构化文本」面）**

```
src/main/services/translate.ts:233 readTranslationMarkdown
src/shared/chat-md.ts:260 translationMarkdownToHtml
src/shared/chat-md.ts:179 translationInline
src/shared/chat-md.ts:294 flushPara
src/shared/text-reflow.ts:285 reflowTextBlocks
src/shared/text-reflow.ts:317 parsePdGeom
```

右侧「文本」面不是 HTML 译文：`rightMode === 'text'` 时读的是译文 **Markdown**（src/renderer/src/features/reader/CompareView.tsx:133-152），由 `translationMarkdownToHtml` 转 HTML。对照容器在 `src/renderer/src/features/reader/CompareView.tsx`，选区翻译用的表格块识别在 `src/shared/md-table.ts`。旧的 `HtmlViewer`（src/renderer/src/features/translate/HtmlViewer.tsx:43）在 `src/` 内**没有任何 importer**，是死代码；而 sidecar 也已不再写 HTML 译文（python/app/translate.py:5180-5183 把 `html_path`/`bilingual_path` 置 None）。

**E. PDF 渲染与对照（L5）**

```
src/renderer/src/features/reader/PdfViewer.tsx:197 pdfjsLib.getDocument
src/renderer/src/features/reader/PdfViewer.tsx:2096 renderPage
src/renderer/src/features/reader/PdfViewer.tsx:2148 getViewport
src/renderer/src/features/reader/PdfViewer.tsx:2265 new pdfjsLib.TextLayer
src/renderer/src/features/reader/PdfViewer.tsx:710 handleTextLayerReady
src/renderer/src/features/reader/scroll-locate.ts:142 anchorToScrollTop
src/renderer/src/features/reader/scroll-locate.ts:37 locateByMid
```

对照联动的事实（渲染在 `src/renderer/src/features/reader/PdfViewer.tsx`）：同步粒度是**页**（`[data-page="N"]` + 锚点），`map.json` 的 blockMap（src/main/services/translate.ts:1497、python/app/translate.py:5155-5176）只用于「原文选区 → 译文版面矩形」的高亮映射，不参与滚动对齐。

## 3. 症状归因

先给总表，再逐条给证据与「已确认 / 待验证」。所有复现均基于同一份合成 PDF（`repro.pdf`，由 `repro_modules.py` 用 PyMuPDF 现场绘制，不含任何用户数据）。

| # | 症状 | 首现层 | 判定 | 一句话证据 |
| --- | --- | --- | --- | --- |
| S1 | 结构化文本里出现 `\| {z}` 残留 | L1（文本层） | 已确认 | 复现 PDF 的该句原样进入 `StructuredDoc`，全链路无合成方 |
| S2 | 单独 `(3)`/`(5)` 公式编号脱离正文 | L1 分块 → L2 未回挂 | 已确认 | 编号独占一行时变成独立 `paragraph` 模块，`eqNo` 为 null |
| S3 | 公式片段散落在段落中 | L1 分块 + L3 无保护 | 已确认（机制） | 行内数学只做「行级公式判定」，行内片段原样进模型 |
| S4 | 数学上下标损坏 | L2 表达能力缺失 | 已确认 | `x²`/`H₂O` 被拍平成 `x2`、`H 2O`，JSON 里没有 sub/sup 字段 |
| S5 | 段落被大面积拆碎 | L1 分块 + L2/L5 一块一元素 | 已确认（机制） | 块级切分直接等于 Markdown 段落数 |
| S6 | 中英 PDF 双栏对齐差 | L4 落版 / L5 对照 | 部分确认 + 待验证 | 对照按页号同步；译文重排后页数与块位会漂移 |
| S7 | 分组侧栏过挤 | L5 布局 | 已确认（代码约束） | 侧栏固定 276px，深层组名截断、子组只能悬浮飞出 |

### S1 `| {z}` 残留 —— L1 已有，L2 无还原通道，L3 无保护（已确认）

- 复现：合成页里写 `We estimate the bias term with | {z} and the remaining terms are negligible.`，`extract_modules` 输出模块 `p1-t0`，`type: paragraph`，`text` 与原文**逐字相同**，`eqNo: null`（见 artifact 的 `result.json`）。
- 机制：L1→L2 只做 span 拼接（python/app/modules.py:113-115），没有任何「把 `| {z}` 还原成 `\left.\right|_{z}`」的代码；翻译侧唯一的数学保护是 `_mask_math`（python/app/translate.py:2457），它只拦 PUA / U+FFFD 等乱码区段（`_MATH_JUNK_RE`，python/app/translate.py:2386），ASCII 的 `|` `{` `}` 不在其中；`_math_run_to_text`（python/app/translate.py:2430）反而**丢弃**这些字符。
- 复现 2（模型输入层）：`_mask_math` 对该句返回 `model_input == raw`、`placeholders == []`、`changed == false`（artifact 的 `repro_mask.py` 输出）。即模型看到的就是 `| {z}`。
- 可验证方法：重跑 artifact 里的 `repro_modules.py`，检查 `p1-t0.text` 是否原样含 `| { z}`；对任意真实 PDF 跑 `/modules` 后搜 `| {` 形态的残留，命中即同一根因（不需要模型参与）。
- 结论：这是**文本层伪影**（PDF 里该公式被拆成 `|` + 下标块，PyMuPDF 按阅读顺序拼出 `| {z}`），不是 CSS、也不是模型幻觉。修复必须发生在 L2（识别行内数学片段并标注），或在 L3 前做公式片段切分——改 CSS 无效。

### S2 `(3)`/`(5)` 编号脱离 —— L1 分块决定，L2 只在同块内回挂（已确认）

- 复现对照同一页两种排版：
  - 编号与公式**同一基线** → PyMuPDF 合成一行，`p1-t1` 为 `equation`，`text = "L(theta) = sum_i log p(y_i | x_i) (3)"`，`eqNo = "3"`（回挂成功）。
  - 编号**独占一行且靠右** → 生成 `p1-t3`，`type: paragraph`，`text = "(5)"`，`eqNo = null`；公式本身是 `p1-t2`，`eqNo = null`。两者之间没有任何关联字段。
- 机制：`extract_modules` 只在同一块文本尾部匹配编号（python/app/modules.py:598-603）。仓库里**已有**正确的回挂逻辑——python/app/structure.py:93-99 用 `EQ_NUMBER_ONLY_RE`（python/app/structure.py:26）把「只有编号的一行」挂回上一行公式；但它属于 `/structure` 端点（python/app/main.py:231），`extract_modules` 并未复用（python/app/modules.py:23-29 的 import 清单里没有它）。
- 下游：L3 会把这个 `(5)` 当普通短块，`_classify_block` 对短数字块的兜底是判成 `figure`（python/app/translate.py:1791-1803，本意是别把页码送翻译），于是它既不翻译也不与公式合并；L5 一侧再按块输出，编号就永远孤零零一行。
- 可验证方法：同一公式的编号排成「同基线」与「下一行靠右」两版（`repro_modules.py` 已经两种都画），比较 `eqNo` 与模块类型；真实文档里统计 `doc_json` 中匹配 `^\(\d+\)$` 的 `paragraph` 模块占比，即可量出影响面。
- 结论：**L1 的块切分 + L2 缺少跨块回挂**。最小修法是在 `extract_modules` 里复用 `structure.py` 的编号回挂（不改主解析器语义，只在模块层关联），无需动渲染。

### S3 公式片段散在段落里 —— 行级判定，行内片段不做处理（已确认）

- 机制：公式判定是**行级**的——`_formula_text_only`（python/app/translate.py:1595，长度 ≤160、无句末标点、`_looks_formula`、散文词 <2）、`_text_has_prose`（python/app/translate.py:1624）、`_line_is_formula_only`（同文件 1640 行）、`_split_formula_lines`（同文件 1656 行）只把「整行像公式」的行从样式组里切出来。**同一行里夹在正文中间的公式片段不切分**，只按 `_MATH_JUNK_RE` 打乱码占位（python/app/translate.py:2457）。
- 后果：这类片段逐字进入模型输入（L3）；模型若改写/省略，L4 的 `_restore_formula_placeholders`（python/app/translate.py:2480）只能统计「占位符丢了几个」，对没被占位的 ASCII 片段无感知。
- 可验证方法：把某块原文与译文 Markdown 逐字比对，若数学片段在 Markdown 里已被改写/丢失，再用 `repro_mask.py` 判断它当时有没有进 `⟦n⟧` 占位——没占位就说明是 L3 放过去的。
- 结论：L1 的块/行粒度 + L3 缺少「行内数学片段」概念。修复方向与 S1 同源（行内片段标注），不是调 prompt 能解决的。

### S4 上下标损坏 —— L2 没有表达能力（已确认）

- 复现：合成 `x` + 小号 `2` + ` + H` + 小号 `2` + `O is water.`，输出 `p1-t4` 文本为 `x2 + H 2O is water.`——上标被拍平、下标还多出一个空格（span 直接拼接，python/app/modules.py:113-115）。
- 机制：`StructuredModule` 里没有 sub/sup 字段（src/shared/modules.ts:18-40），`FormulaModule` 只有整块 LaTeX（src/shared/modules.ts:62-91）；HTML 侧虽然定义了 `.math sub, .math sup` 样式（python/app/translate.py:2203），但**没有任何代码产出 `<sub>/<sup>`**。也就是说样式是历史遗留，生产者不存在。
- 注意区分：公式**整块**的上下标其实能救——`build_formula` 的树重建会输出 `^{...}`/`_{...}`（现有测试 `python/tests/test_modules.py` 的「上标 → ^{...}」「下标 → _{...}」两条 PASS 就是证据）；坏的是**混在正文段落里**的行内上下标，因为它们根本不进入公式模块。
- 可验证方法：直接查 `StructuredDoc` 的 JSON 里是否存在 `sub`/`sup`/`script` 字段（当前必为无）；再比对 Markdown 中 `x2`/`H 2O` 与原文上下标是否一致。
- 结论：这是 L2 的数据模型缺口，不是渲染 bug；CSS 再改也没用。

### S5 段落被拆碎 —— 块级切分等于段落数（已确认）

- 机制一（合并）：`_order_and_merge`（python/app/modules.py:179）只合并「同栏、字号相近、间距 ≤ max(3, size*0.7) 或（≤ max(4, size*1.6) 且上一块没写完）」的相邻块，条件偏保守，硬换行成块时会留在两块。
- 机制二（再切）：翻译侧 `_split_coarse_paragraph`（python/app/translate.py:2733）又按行距/首行缩进/行尾标点把块切成段落，切分条件写在 python/app/translate.py:2748-2806（`g > max(med*1.9, med+size*0.5)` 等）。
- 机制三（下游放大）：Markdown 产物是**一块一段、段间空行**（python/app/translate.py:2355-2356 的 `"\n\n".join`），`chat-md` 再把每段送进 `reflowTextBlocks`（src/shared/chat-md.ts:294 → src/shared/text-reflow.ts:285）；后者只在段内合并硬换行，**不跨段合并**。所以 L1/L2 的块粒度直接等于用户看到的 `<p>` 数量。
- 附带风险：md 写出时按字号把块升级成 `#`/`##`/`###`（python/app/translate.py:2347-2352，阈值 1.45/1.2/1.08 × 正文字号），碎裂的块若恰好字号偏大就会变成假标题。
- 可验证方法：统计同一文档 `StructuredDoc.modules` 里 `paragraph` 数与 PDF 视觉段落数之比（>2 视为碎裂，阈值需人工抽样确认）；再数 Markdown 里 `<p>` 数是否与模块数一致。
- 结论：L1 分块 + L2 保守合并，L5 只是忠实呈现。要「少拆」必须调 L2 合并阈值（并且要防过度合并），而不是在前端合并 DOM。

### S6 中英 PDF 双栏对齐差 —— 对照粒度是页，重排后必然漂（部分确认，视觉待验证）

- 已确认（代码）：对照视图是左右两块独立渲染——左原文 PDF、右译文 PDF 或译文 Markdown（src/renderer/src/features/reader/CompareView.tsx:104-106）。同步靠页号与锚点（src/renderer/src/features/reader/CompareView.tsx:164-190、src/renderer/src/features/reader/scroll-locate.ts:142），`map.json` 的 blockMap 只做选区矩形映射（src/main/services/translate.ts:1497）。
- 推断（有前提）：译文 PDF 按 `layout` 模式落版（`reflow` / `strict`，透传链路见 src/main/services/translate.ts:681 的 `layout` 字段）。`reflow` 下译文行数/块高变化 → 译文页数与原页数不一致 → 「第 N 页对第 N 页」立刻失效；`strict` 模式理论上保持版位，但中文译文字宽不同，块内仍会挤压。两种情况下，现有的页级同步都只能做到「页对页」，做不到「段对段」。
- 待验证（需要 GUI/视觉比对，本轮未做）：取双栏论文，一是核 `_detect_columns`（python/app/modules.py:149，门槛「每侧 ≥3 块且间隙 >8」）在真实双栏页上是否稳定成两簇；二是渲染译文 PDF 后量同一 block 的位移。现有测试只在样例 PDF 上断言「检测到双栏排版」通过（`python/tests/test_modules.py`），不覆盖对齐误差。
- 结论：对齐问题的主体在 **L4 落版 + L5 对照策略**，不是解析器读错列；但解析列判定不稳会放大它（待验证项）。

### S7 分组侧栏过挤 —— L5 布局约束（已确认，视觉待验证）

- 已确认（代码）：三栏网格固定侧栏宽度 `--sidebar-w: 276px`（src/renderer/src/styles.css:109 与 665 行的 `grid-template-columns`）。分组树里组名 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`（src/renderer/src/styles.css:1034），深层组名被静默截断；子分组是 `position: absolute` 的**悬浮飞出层**（src/renderer/src/styles.css:1041，仅 `:hover/:focus-within` 显示），不是可展开的内联树（src/renderer/src/features/library/LibraryList.tsx:734 的 `renderGroupNode`、同文件 848 行的子节点容器）。上下分栏的高度下限写死（src/renderer/src/features/library/group-split.ts:13-19：组区最小 120、默认 240、列表最小 160、兜底上限 560），窗口一矮就互相挤。
- 待验证：真实窗口截图（本轮 `desktop: none`，未做 GUI 走查）。
- 可验证方法：真实窗口里量 `.group-picker__name` 的 `scrollWidth > clientWidth` 比例（截断率），并数「需要 hover 才能看到子组」的层级深度。
- 结论：纯 L5 布局问题，与解析链路无关；但**不要**把它和 S1-S5 混在一起归因。

### 归因结论（与 `docs/nightly-progress.md` 的「已经确认的根因」一致）

- 公式/编号类症状（S1-S4）的首次出错点都在 **L1→L2**：PyMuPDF 的块与 span 是唯一事实来源，`modules.py` 只做几何拼接，没有行内数学概念，`StructuredDoc` 也没有承载上下标/行内公式的字段。
- 「送进模型前」这一层（L3）只保护乱码区段，对 ASCII 数学片段零保护；但它是放大器，不是首因。
- 渲染层（L5）对 S1-S5 只是忠实显示；S6/S7 才是真正的渲染/布局问题。**把 S1-S4 归因给 CSS 或模型都是错的**——复现脚本在没有模型、没有前端的条件下已经重现了。

## 4. 测试与迁移风险

### 4.1 本轮实跑的测试（命令 + 结果）

| 命令（cwd=`python/`，`PYTHONPATH` 指向 `python/`） | 结果 | 证据 |
| --- | --- | --- |
| `python tests/test_modules.py`、`python tests/test_structure.py`（runpy 逐文件执行） | exit 0，37 条 PASS，末尾 `MODULES_OK` | artifact `stdout.log` |
| `python tests/test_translate.py` | exit 0，`TRANSLATE_OK`，约 15.7s，约 200 条 PASS | artifact `stdout.log`、`result.json` |
| `python repro_modules.py repro.pdf` | exit 0，产出 `result.json`（5 个模块，见 S1/S2/S4） | artifact `result.json` |
| `python repro_mask.py` | exit 0，三例 `model_input == raw` | artifact `stdout.log` |

上表的用例分别落在 `python/tests/test_modules.py`、`python/tests/test_structure.py` 与 `python/tests/test_translate.py`。值得注意的两条既有测试语义（说明「当前行为是被测试锁定的」）：

- `HTML 译文已移除：不再返回 htmlPath/bilingualPath` —— 与 python/app/translate.py:5180-5183 一致，HTML 面是**有意**下线的。
- `公式逐字保留（PDF 文本层）` —— 现有测试**明确要求**公式按文本层原样保留。任何「还原公式」的改动都会与这条测试冲突，必须同步改测试并在评审里说明，不能偷偷改断言。

未执行（本轮范围外）：`npm run typecheck`、`test:unit`、`test:coords`、`smoke`、`test:e2e`、GUI 走查（任务包 `desktop: none`）。这些由 verifier/回归负责。

### 4.2 迁移风险

- **R1 缓存版本号是双份的**：`readCache` 命中要求 `row.extractor_version === EXTRACTOR_VERSION_FALLBACK`（src/main/services/modules.ts:206），而该常量在 Node 侧写死为 `'formula-tree-2'`（src/main/services/modules.ts:22），与 Python 侧 `EXTRACTOR_VERSION`（python/app/formula.py:57）是两个独立字符串。只改 Python 侧不会让旧 `doc_json` 失效——旧库会继续返回**没有新字段**的结构化结果。任何 L2 结构变更必须同时 bump 这两处（并考虑 `config_hash`，src/main/services/modules.ts:56）。
- **R2 `doc_json` 不存公式**：`writeCache` 写入时把 `formulas` 置空（src/main/services/modules.ts:239），读取时从 `document_formulas` 表回填（`src/main/services/modules.ts` 214 行与 130 行）。所以新增「行内公式」类数据不能只塞进 `doc_json`，要么进 `document_formulas`，要么明确放在 `doc_json` 且不能被这条剥离逻辑吃掉。
- **R3 公式表有唯一约束**：`document_formulas` 上 `UNIQUE(document_id, formula_order)`（src/main/db/schema.sql:333-356）。重算时必须整体替换而不是增量插入，否则唯一键冲突；验证重算幂等性时要覆盖这条。
- **R4 新译文没有 HTML**：新行为下 `html_path`/`bilingual_path` 为 NULL（python/app/translate.py:5180-5183），而 `readTranslationHtml` 在 NULL 时抛错（src/main/services/translate.ts:1220）。preload 仍暴露 `readHtml`（src/preload/index.ts:116）、`HtmlViewer.tsx:43` 仍是可编译但无 importer 的死代码。**风险**：将来谁把它挂回 UI，就必然撞上「该译文还没有 HTML 版本」。清理死代码要单独立项（不在本轮 scope）。
- **R5 跨进程契约是隐式的**：Markdown 里的 `<!--pd p= l= r=-->` 标记由 python/app/translate.py:2280 写、由 src/shared/text-reflow.ts:109（`PD_MARK_RE`）读、由 `src/shared/text-reflow.ts` 317 行的 `parsePdGeom` 解析；`map.json` 由 python/app/translate.py:5155-5176 写、由 src/main/services/translate.ts:1497 读。改任一侧格式都要同步两侧，且没有版本号保护（只能整库重译）。
- **R6 坐标约定不能漂**：`skipRects` 用 0 基页号 + 底边原点矩形（src/main/services/translate.ts:641，Python 侧 `to_bottom` 在 python/app/modules.py:420）。换成任何新解析器/适配器都必须保持同一约定，否则「跳过公式/图注」会错位，把公式当正文送翻译。
- **R7 现有测试锁定了行为**：`test_modules.py` 断言图注绑定、双栏、定理/公式分类；`test_translate.py` 断言分类、占位还原、页角色、句级映射。改块切分规则会大面积红，需要「先加新断言、再改行为」的顺序。

## 5. 已引入的解析与渲染库

| 用途 | 库/组件 | 版本或锁定位置 | 现状 |
| --- | --- | --- | --- |
| PDF 文本/版面抽取 | PyMuPDF（`fitz`） | `pymupdf==1.27.2.3`（python/requirements.txt:6） | 唯一主解析器：`page.get_text("dict"/"blocks")`、`page.get_drawings()` 取公式矢量线、`page.find_tables()` 取表格 |
| PDF 渲染与文本层 | pdf.js（pdfjs-dist） | `^6.4.299`（`package.json:78`），worker 装配在 `src/renderer/src/lib/pdf.ts` | 只用来看图 + 文本层选区；不参与结构化 |
| Sidecar HTTP | fastapi / uvicorn / pydantic / httpx | 0.141.1 / 0.34.0 / 2.13.4 / 0.28.1（python/requirements.txt:4-8） | 全部端点见 `python/app/main.py` |
| 公式结构重建 | 自研 `python/app/formula.py` | `EXTRACTOR_VERSION = "formula-tree-2"`（python/app/formula.py:57） | 纯规则：token 化 + 矢量线 + `build_tree` + `render` 出 LaTeX；**不是**深度学习模型 |
| 公式视觉识别（可选） | 视觉模型（外部网关） | python/app/main.py:344 → `python/app/vision.py` | 把公式截图丢给多模态模型返回 LaTeX；`latex` 为 None 时才用，非本地 OCR |
| Markdown → HTML | 自研 `src/shared/chat-md.ts` | 无第三方 md 引擎 | 白名单标签 + `escapeHtml`；数学只做 `$...$`/`\(...\)` 的 `<span class="tex">` 直出 |
| 行/段重排 | 自研 `src/shared/text-reflow.ts` | — | 读 `pd` 标记、合并硬换行、保留 rect |

**明确没有引入**（避免误判为「差个库就能修」）：docling / unstructured / tesseract / MinerU / pdf2zh 都不是主链路依赖——MinerU 与 pdf2zh 只是可选外部引擎（python/app/mineru_engine.py:20-28 检测 CLI、python/app/pdf2zh_engine.py:19-44），`/health` 会报告可用性（python/app/main.py:508-521），装不装都不影响默认链路（引擎适配分别在 `python/app/mineru_engine.py` 与 `python/app/pdf2zh_engine.py`）；KaTeX/MathJax 完全没有（所以公式在前端只能显示原文）；`requirements.txt` 里没有任何 OCR 依赖。

## 6. 最小 PoC 计划

目标：在**不替换主解析器**的前提下，验证「把统一结构化结果升级到能表达行内数学与块级稳定标识」这条路可行。PoC 只做**标注与分块**，不做公式 LaTeX 重建（那是第二阶段）。

### 6.1 适配层接口文件建议

- 建议新增 Python 适配层：python/app/blocks_adapter.py（当前仓库不存在，属计划）
- 建议新增共享类型：src/shared/blocks.ts（当前仓库不存在，属计划）
- 接入点（都只在**读**侧追加字段，不改写现有函数签名）：
  - python/app/modules.py:370 `extract_modules` 末尾追加 `doc["blocks"] = build_blocks(...)`（try/except 包裹，失败只记 `warnings`，绝不影响 `modules`）。
  - python/app/main.py:241 `/modules` 的响应自然带上该字段。
  - src/main/services/modules.ts:263 `getModules` 透传 `blocks`（可选字段，老缓存为 `undefined` 即视为未启用）。

### 6.2 统一 JSON 的三个必填字段

| 字段 | 类型 | 为什么必填（对应哪条症状） |
| --- | --- | --- |
| `stableId` | `string`，形如 `p{page}-b{seq}`，同一 PDF 同一版本下稳定；跨版本允许变化但必须写进 `extractorVersion` | 现有 id 是渲染时生成的 `p{page}-t{k}`（python/app/modules.py:587），一旦合并/拆分就变；没有稳定标识，S2 的「编号回挂」与 S6 的「段对段对齐」都无处挂载 |
| `blockType` | 枚举，至少 `paragraph` / `heading` / `caption` / `equation` / `equation-number` / `math-inline` / `table` / `figure` / `reference` | 现在只有 8 个粗类型（src/shared/modules.ts:8-16），没有「行内数学」与「公式编号」，S2/S3 无法表达 |
| `sourceRegion` | `{ page: number(1基), rect: [x0,y0,x1,y1](底边原点), rects?: 同形数组 }` | 对齐、跳过翻译、选区高亮都依赖它；必须与现有 `to_bottom` 约定一致（python/app/modules.py:420），否则 R6 的错位会直接发生 |

### 6.3 「不替换主解析器」的开关方案

- 默认关闭：环境变量 `PAPERDESK_BLOCKS_ADAPTER`（`0`/未设置 = 关，`1` = 开）。读取位置放在适配层入口，不放进 `extract_modules` 主流程。
- 开启时：适配层**只读** PDF 再做一次 `page.get_text("dict")`，按 `rect` 与现有 `modules[]` 对齐（矩形重合度 >0.6 即认为同一块），把 `math-inline` / `equation-number` 标注**附加**到对应模块上；对不上任何模块的块，作为新块追加并标 `orphan: true`。
- 关闭时：走今天完全相同的代码路径，产物与现在**逐字节一致**（可用 `python/tests/test_modules.py` 的 37 条断言直接验证）。
- 回退：删掉环境变量即可，无需回滚数据库；不 bump `EXTRACTOR_VERSION` 就永远不会污染老缓存（R1）。
- 缓存：开启后建议在 `doc_json` 里写 `adapterVersion`，并在 `readCache` 命中时校验；PoC 阶段可先用 `opts.refresh` 强制重算（src/main/services/modules.ts:272）。

### 6.4 PoC 验收用例（直接用本轮复现件，不需要用户文档）

1. 用 `repro.pdf` 跑开启/关闭两遍，断言：关闭时输出与本轮 `result.json` 完全一致（逐字段 diff 为空）。
2. `p1-t0` 中的 `| {z}` 必须被标成 `math-inline` 片段（起止 offset + 原文），但**文本本身不得改写**（保住 `公式逐字保留（PDF 文本层）` 这条测试）。
3. `p1-t3`（`(5)`）必须拿到 `blockType: equation-number` 与 `relatedEquationId: p1-t2`（回挂可用的最小证明）；关闭开关时二者均不存在。
4. `p1-t4` 的 `x2`/`H 2O` 必须能给出「疑似上下标」标注（span 的 `y/size` 与基线偏移），同样不改写文本。

### 6.5 明确不在 PoC 范围内

- 公式 LaTeX 重建质量（`build_formula` 已有，不在本轮改）。
- S6 的双栏/双语文档对齐（需要 L4 落版改造 + GUI 视觉验收，单独立项）。
- S7 侧栏布局（纯 L5，与解析链路解耦）。
- 换掉 PyMuPDF（PoC 的前提就是**不换**）。
