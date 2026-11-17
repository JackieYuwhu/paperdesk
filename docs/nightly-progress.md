# 夜间迭代进度记录 · 第一夜

对应任务：《PaperReader AI Agent 改造任务书》第一夜 · 阶段 0 只读审计（`pdf-pipeline-audit`）。
基线 commit：`911758b8`。审计正文见 `docs/audit-pdf-pipeline.md`。

## 日期与本轮目标

2026-11-10（Asia/Shanghai）。本轮目标：**只做取证，不改功能**。把三条链路（上传→解析→统一结构化结果；结构化文本与双语渲染；按块翻译）逐层切开，判定用户 7 条症状各自的「错误首现层」，给出 `文件:行号 函数名` 级的函数调用链，并给一份最小 PoC 计划。硬约束：只允许新增 `docs/` 下两个文件，不改业务代码、数据库结构、上传路径与用户数据。

## 识别到的技术栈与相关文件

- 桌面壳 / 渲染：Electron + React 19；PDF 渲染用 pdf.js（`pdfjs-dist ^6.4.299`，`package.json:78`，worker 装配在 `src/renderer/src/lib/pdf.ts`），只画位图与文本层，不参与结构化。
- 主进程：`src/main/services/extract.ts`（解析编排）、`src/main/services/modules.ts`（结构化缓存与公式明细）、`src/main/services/translate.ts`（翻译编排）、`src/main/db/schema.sql`（`paper_modules` / `document_formulas` / `translations`）。
- IPC 面：`src/preload/index.ts`（`window.api`）、`src/shared/channels.ts`、`src/shared/api.ts`、`src/main/ipc/{library,metadata,reader,translate}.ts`。
- Sidecar：Python 3 + FastAPI，`python/app/main.py`（端点）、`python/app/extract.py`（文本解析）、`python/app/modules.py`（结构化）、`python/app/formula.py`（公式树）、`python/app/structure.py`（另一条结构线）、`python/app/translate.py`（按块翻译，5378 行）。
- 结构化渲染：`src/shared/chat-md.ts`（Markdown→HTML，无 KaTeX）、`src/shared/text-reflow.ts`（`pd` 标记与段落重排）、`src/renderer/src/features/reader/CompareView.tsx`（对照视图）。
- 版本锁定：`python/requirements.txt`（pymupdf 1.27.2.3 / fastapi 0.141.1 / uvicorn 0.34.0 / httpx 0.28.1 / pydantic 2.13.4）。

## 已经确认的根因

全部用合成 PDF 复现（`repro.pdf` + `repro_modules.py`），不依赖用户文档，也没有模型参与：

1. **`| {z}` 类残留来自 PDF 文本层（L1），结构化层不还原**。`python/app/modules.py:105` 的 `_raw_blocks` 用 `page.get_text("dict")`，一行文本直接 `"".join(span)`（`python/app/modules.py:113-115`），没有公式语义；复现里 `p1-t0` 的文本与原文逐字相同。翻译侧 `_mask_math`（`python/app/translate.py:2457`）只保护 PUA/U+FFFD 乱码段，ASCII 的 `|` `{` `}` 原样进入模型输入（`repro_mask.py` 三例均为 `model_input == raw`）。
2. **公式编号脱离正文是块切分 + 缺跨块回挂**。编号与公式同一基线时 PyMuPDF 合成一行，`eqNo` 正常（`python/app/modules.py:598-603`）；编号独占一行时变成独立 `paragraph` 模块（复现 `p1-t3`，`eqNo: null`），与公式模块 `p1-t2` 无任何关联。仓库里已有正确回挂逻辑（`python/app/structure.py:93-99` + `EQ_NUMBER_ONLY_RE`），但只服务 `/structure` 端点，`extract_modules` 未复用。
3. **行内数学不受保护**。公式判定是行级（`_formula_text_only` `python/app/translate.py:1595`、`_split_formula_lines` `python/app/translate.py:1656`），夹在正文里的片段不切分、不占位，逐字进模型。
4. **上下标在 L2 无法表达**。`StructuredModule`（`src/shared/modules.ts:18-40`）没有 sub/sup 字段；复现里 `x²`/`H₂O` 被拍平成 `x2`、`H 2O`。HTML 里 `.math sub/sup`（`python/app/translate.py:2203`）只有样式、没有生产者。整块公式的上下标则由 `build_formula` 正常产出 `^{...}`/`_{...}`（既有测试覆盖）。
5. **段落碎裂是块粒度决定**。`_order_and_merge`（`python/app/modules.py:179`）合并条件保守，翻译侧 `_split_coarse_paragraph`（`python/app/translate.py:2733`）再按几何切；Markdown 一块一段（`python/app/translate.py:2355-2356` 的 `"\n\n".join`），前端 `reflowTextBlocks`（`src/shared/text-reflow.ts:285`）只合并段内硬换行，不跨段合并 → 块数等于 `<p>` 数。
6. **对照只能页对页**：`CompareView` 按页号 + 锚点同步（`src/renderer/src/features/reader/CompareView.tsx:164-190`），`map.json` 的 blockMap 只做选区矩形映射（`src/main/services/translate.ts:1497`）；`reflow` 落版改变页数后必然错位（视觉比对待验证）。
7. **分组侧栏过挤是纯 L5 布局**：`--sidebar-w: 276px`（`src/renderer/src/styles.css:109`）、组名省略号截断（`src/renderer/src/styles.css:1034`）、子组只能悬浮飞出（`src/renderer/src/styles.css:1041`），上下分栏高度下限写死（`src/renderer/src/features/library/group-split.ts:13-19`）。

一句话口径：**S1-S4 首错在 L1→L2（PyMuPDF 块 + 结构化模型表达能力），L3 只是放大器，L5 只是忠实显示；S6/S7 才是渲染/布局问题。**

## 实际修改的文件与用途

本轮**没有改任何业务代码、schema、上传路径或用户数据**。新增两个文件：

| 文件 | 用途 |
| --- | --- |
| `docs/audit-pdf-pipeline.md` | 阶段 0 审计正文：技术栈与运行方式、五条函数级调用链、7 条症状的分层归因（已确认/待验证）、测试与迁移风险 R1-R7、解析与渲染库清单、最小 PoC 计划（适配层路径 + 三个必填字段 + 环境变量开关） |
| `docs/nightly-progress.md` | 本文件，按任务书第 9 节十项填写，结论与审计正文逐条对齐 |

## 执行的测试、命令与结果

工作目录 `python/`，`PYTHONPATH` 指向仓库的 `python/`，编码 `UTF-8`；日志与产物在 artifact 目录（`stdout.log`、`result.json`）。

| 命令 | 结果 |
| --- | --- |
| `python/tests/test_modules.py` 与 `python/tests/test_structure.py` | exit 0，37 条 PASS，末尾 `MODULES_OK`（含双栏、图注绑定、公式上标/下标/\frac/\sqrt、`_is_equation_like`、跨页参考文献） |
| `python tests/test_translate.py` | exit 0，`TRANSLATE_OK`，约 15.7s，约 200 条 PASS（含「HTML 译文已移除：不再返回 htmlPath/bilingualPath」「公式逐字保留（PDF 文本层）」「公式行：正文/公式/正文被拆成三段」） |
| `python repro_modules.py repro.pdf` | exit 0，5 个模块（`p1-t0`…`p1-t4`），`extractorVersion: formula-tree-2` |
| `python repro_mask.py` | exit 0，三例 `model_input == raw`、`placeholders == []` |

**未执行**（不在本任务包授权内，`desktop: none`）：`npm run typecheck` / `test:unit` / `test:coords` / `smoke` / `test:e2e`、GUI 走查、真实论文 PDF 的解析回归。这些留给 verifier 与后续轮次，不宣称通过。

## 视觉检查或截图对比结果

**未做视觉检查**。本轮 `desktop: none`，没有启动 GUI，也没有截图对比；S6（双栏对齐）与 S7（侧栏过挤）的判定因此只到「代码约束已确认 / 视觉表现待验证」。审计正文里这两条都明确标了「待验证」，不冒充实测结论。

## 未解决的失败案例

1. **编号回挂仍是坏的**：在本轮复现件上，`(5)` 依然是与公式分离的 `paragraph` 模块且 `eqNo: null`；修复（复用 `structure.py:93-99`）未实施。
2. **行内上下标依旧丢失**：`x2` / `H 2O` 无任何结构化标记，只有 span 的 `y/size` 留在 L1（`python/app/modules.py:127-135`），未向上暴露。
3. **真实论文未验证**：双栏论文的 `_detect_columns`（`python/app/modules.py:149`，每侧 ≥3 块才判双栏）在窄栏/单栏混排页上的稳定性没有测；对齐误差没有量化。
4. **死代码风险未清理**：`HtmlViewer.tsx:43` 无 importer，但 `preload` 仍暴露 `readHtml`（`src/preload/index.ts:116`），新译文 `html_path` 必为 NULL（`python/app/translate.py:5180-5183`）；一旦有人挂回 UI 就会抛「该译文还没有 HTML 版本」。本轮不清理（超 scope）。
5. **缓存版本双份**（R1）：Node 侧 `EXTRACTOR_VERSION_FALLBACK`（`src/main/services/modules.ts:22`）与 Python 侧 `EXTRACTOR_VERSION`（`python/app/formula.py:57`）相互独立，只 bump 一侧会继续返回旧结构，未修。

## 是否涉及旧数据、成本或外部服务

- **旧数据**：不涉及。本轮只新增文档，没跑重算、没写 `paper_modules` / `document_formulas` / `translations`，没改 `extractorVersion`，老缓存与历史译文全部原样保留。
- **成本**：零。复现脚本纯本地 PyMuPDF 绘制 + 解析，没有调用模型网关；测试套件里翻译用例走内置模拟/本地路径。
- **外部服务**：未使用 GROBID、Crossref、MinerU、pdf2zh、任何模型网关；`/health` 的可用性探测未在本轮触发。
- **只读来源**：解析用合成 PDF（现场生成），不读用户文档；审计只读源码与既有测试。

## 回退方法

本轮改动只有两个新增的 Markdown 文件，回退即删除：

```
git rm docs/audit-pdf-pipeline.md docs/nightly-progress.md
git commit -m "revert: 阶段0 审计文档"
```

因为没有触碰代码、schema、缓存键与用户数据，回退**不需要**清缓存、重跑迁移或重译任何文档。若后续按 PoC 计划开启适配层，回退开关是环境变量 `PAPERDESK_BLOCKS_ADAPTER`（不设置即走现状），且不 bump `EXTRACTOR_VERSION` 不会污染老缓存。

## 下一轮最小安全任务

**只做一件**：在 `extract_modules` 内复用 `python/app/structure.py:93-99` 的编号回挂逻辑，把「独占一行的公式编号」挂回相邻公式模块（写入 `eqNo` + 关联 id），并用本轮 `repro.pdf` 断言 `p1-t3` 回挂到 `p1-t2`。

- 范围的硬边界：只动 `python/app/modules.py` 的模块层（不改 `extract_modules` 的既有输出字段语义、不改 `formula.py`、不改渲染），配套在 `python/tests/test_modules.py` 加一条用例。
- 必须同时做：`extractor_version` 双份（`python/app/formula.py:57` 与 `src/main/services/modules.ts:22`）一起 bump，否则老缓存继续返回 `eqNo: null`（R1）。
- 验收口径：关闭开关/旧缓存命中的行为不变；`python/tests/test_modules.py` 与 `test_translate.py` 全绿；`repro.pdf` 上 `p1-t3` 不再是孤立段落。
- 明确不做：行内数学标注、上下标结构化、双栏对齐、侧栏布局——留给后续轮次，避免一轮改多层。
