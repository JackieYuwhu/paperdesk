---
name: paperdesk-translate
description: PaperDesk PDF 翻译的开发手册：结构化文本对象、精译/粗译两种模式、统一保护规则、分阶段计时、验收命令与排查路径。修改翻译流程、调整角色/保护、优化耗时、排查排版或漏译问题时使用。
---

# PaperDesk PDF 翻译（开发 Skill）

## 何时用

- 改 `python/app/translate.py`、`src/main/services/translate.ts`、翻译面板 / 批处理
- 出现「标题/DOI/正文混在一起」「图内文字被翻译」「字号忽大忽小」「译文压字」
- 要调速度（目标：10–20 页原生文本论文 **15 分钟内**）
- 要新增产物、模式或角色

## 数据流（只记这条主线）

```
PDF
 └─ 结构化文本对象（行 → span → 按样式切段 → 按栏/阅读顺序成段）
     ├─ roleHint/role: title | body | abstract | caption | doi | url | authors |
     │                  affiliation | article-type | figure | formula | reference | margin
     ├─ action: translate | preserve        ← 保护规则的唯一出口
     └─ id : p{page}-o{n}                   ← 送模型只带 id/role/text
 └─ 翻译（按 id 分批；校验缺失/重复/空串，逐级回退）
 └─ 写回（只擦除 action=translate 的对象；字号从原字号起，放不下才缩）
 └─ PDF（+ Markdown）。HTM​L 译文已移除。
```

关键文件：

| 文件 | 职责 |
|---|---|
| `python/app/translate.py` | 全部：对象构建、角色、保护、翻译批次、写回、计时 |
| `python/app/main.py` | `/translate*` 请求模型（含 `mode`） |
| `src/main/services/translate.ts` | 模式默认值、模块 skipRects、产物登记、进度文案 |
| `src/renderer/src/features/translate/TranslationPanel.tsx` | 精译/粗译选择 |
| `src/main/services/batch/registry.ts` | 批处理参数（mode/format） |
| `python/tests/test_translate.py` | 回归样例（含验收断言） |

## 结构化文本对象（不要退回「整块翻译」）

每个对象至少包含：
`id, page, text, bbox, rect, fontSize, fontFamily, color, bold, spans, blockId, columnId, paragraphId, roleHint, role, action`

规则：

1. **按行收集 span**，按 `字号 / 字色 / 字体家族` 突变切段。DOI、栏目名、标题因此各自成段。
2. **段内多样式保留在 `spans`**（粗体、斜体、链接），不拆成多个翻译片段。
3. **样式取字符数众数**，绝不取第一个 span（这是「整块继承 DOI 蓝色」的根因）。
4. 合并只发生在：同栏、同角色、同字色、同字体、字号相近、间距合理；合并时保留 spans。
5. 参考文献/摘要状态按**抽取顺序**推进（几何顺序会把条目排到 `References` 标题之前）。

## 两种模式

| | 精译 `fine` | 粗译 `coarse` |
|---|---|---|
| 用途 | 精读、交付 | 个人快速通读 |
| 底色/字色还原 | 逐页采样 | 跳过（白底假设） |
| 重试 | `retries`（默认 2） | 最多补试 1 次 |
| 批次 | `pick_batch_size` 自适应（≤16 段/批） | 同左 |
| 并发 | OpenCode 32 / 其它 24（上限 32） | 同左 |
| 思考 | 默认关闭（`mt.thinking=0`） | 同左 |
| 顺序 | 原顺序 | **摘要/首页先，其次结论** |
| 允许瑕疵 | 否 | 是（少量排版问题可接受） |

两种模式**共用**同一套对象、角色和保护规则；粗译不允许降低保护强度。

### 吞吐调度（不要退回「按章节拆请求」）

- 请求分组按**内容类型**（body/heading/caption/abstract）；只有自定义 skill 的 prompt 真的引用
  `{section}` 时才按章节拆组（`group_translation_items`）。按章节拆组会把请求数放大到
  「章节数 × 类型数」，每个请求都白付一次单请求延迟。
- 批大小用 `pick_batch_size`：在「请求数 ≤ 并发数（一波打完）」前提下取最小批，上限 16。
  单请求延迟远快于线性增长（4 段 42s / 8 段 61s / 16 段 127s），所以「小批 + 一波打完」最优。
- 翻译请求默认带 `thinking: {"type":"disabled"}`（`_post_chat`）；服务端 400 且错误信息提到
  thinking/reasoning/unknown parameter 时自动去掉重试一次并在进程内记住。不要把这段降级
  改成「静默忽略错误」——其它 400 仍必须抛给上层。
- 术语抽取在合段完成后就用后台线程发出，与保护区/引用清洗计算重叠；join 期间要响应取消。
- 调优入口：`mt.workers`（1~32）、`mt.batch`（不设=自适应）、`mt.thinking`（0=关，1=服务端默认）。
  改这些不需要改代码；改调度算法必须补 `pick_batch_size` / `group_translation_items` 的单测。

## 数学符号（类别不能丢）

- 抽取到的 Unicode 数学变体（`𝒫 𝓟 ℙ 𝐏 𝑃`）**保留原码位**，不做 `𝒫→P`：
  `_math_run_to_text` 不凭字符重复去重（`𝑥𝑥` 可能是合法乘积）；只有几何证据确认同位置重复绘制时才可去重。
  私用区/U+FFFD 视为**类别未知**，直接丢弃并计入 `formulaApproximated`。
- 绘制：含变体的块走 `_draw_math_box` → `insert_htmlbox`，中文用 `msyh`、
  数学用 `Cambria Math`（`math_fontfile()`）。没有数学字体时退回基础字母。
- 公式密集块（`math_ratio ≥ 0.12`）仍然**整块原样保留**，不动。
- 已知限制：htmlbox 嵌入子集的 ToUnicode 可能偏移，**视觉正确但复制/搜索到的
  码位可能不对**；`spans` 里的数学符号不影响阅读。
- 性能：每个含数学的块约 0.2–0.4s（`insert_htmlbox` 的字体子集开销）。
  12 页样例约 37 个块 ≈ 15s，仍在 15 分钟预算内；要再快需改成手动逐段绘制。

## 保护规则（唯一出口）

`skip_mask` 由以下来源合并，**不依赖调用方是否传 `skipRects`**：

1. 角色为 `doi/url/authors/affiliation/article-type/header/footer/figure/table/formula/reference/code`
2. 模块层 `skipRects`（底边原点 → PDF 坐标，≥60% 覆盖）
3. 图片块、矢量图形区域、`find_tables`（仅当内部文字小于正文）
4. `fig_internal` / `algo`（伪代码）/ 公式占比 ≥ 0.12 的块

必须记住：**送模型、擦除、重绘、HTML/MD 导出都读同一份 `skip_mask`**。
新增入口时先接 `skip_mask`，不要另写判断。

## 验收与验证

```powershell
npm run typecheck
npm run test:unit        # UNIT_OK
npm run test:py          # 全部 *_OK（含 TRANSLATE_OK）
npm test                 # SMOKE_OK
npm run build
npm run test:e2e         # E2E_OK
```

翻译专项（无需 API Key，用 mock）：

```powershell
python python\tests\test_translate.py
```

必须覆盖的断言（已在 `test_translate.py`）：

- DOI/栏目/标题不合并；DOI 保持蓝色原样；标题独立按大字号翻译
- 同段粗体/普通文本只翻译一次
- 不传 `skipRects` 时图内标签仍不进模型；同页正文照常翻译
- 公式密集块整块保留并记 `coverage.formulaPreserved`
- 行内近似有 `coverage.formulaApproximated` + warning（不是静默）
- 输出不含 `?`/豆腐块；不跨栏、不覆盖保护区
- `htmlPath/bilingualPath` 恒为 `None`

## 计时与基准

`simple_translate` 返回：

```json
"timing": {"mode":"coarse","totalSeconds":12.3,
           "stages":{"extract":1.2,"analyze":7.0,"translate":0.0,"write":3.0},
           "requests":4,"requestSeconds":180,"failedBatches":0,
           "batchSize":8,"workers":32,"planRequests":4,"groups":4,"noThink":true}
```

- `stages` 是本地开销；`requestSeconds / requests` 是模型等待时间。
- `planRequests / groups` 是调度结果（请求数应 ≤ `workers`，除非文档很大触发 cap=16）。
- `noThink` 表示是否请求了「关闭思考」；服务端拒绝该参数时侧车自动降级，但该字段仍为 true。
- `retries` / `failedBatches` / `coverage.failedBlocks` 是失败与重试情况。

**真实 API 基准**（需要 Key，读环境变量，不动数据库）：

```powershell
$env:PAPERDESK_MT_BASEURL="https://opencode.ai/zen/go/v1"
$env:PAPERDESK_MT_APIKEY="<key>"
$env:PAPERDESK_MT_MODEL="deepseek-v4.1-flash"
python python\tests\bench_translate.py "C:\path\paper.pdf" --mode coarse
```

输出 JSON（wall/timing/coverage/warnings）+ 一行摘要。**没有真实 Key 时只能报
本地阶段耗时，不能把估算当验收**。
- mock 基准（12 页论文）：本地约 **9–12 秒**，其中 `analyze` 占大头（`find_tables` + 保护计算）。
- 真实耗时 ≈ `requestSeconds` 主导。97 段 / 批 32 ≈ 4 个请求；单请求 ~60s、并发 8 → 约 1 分钟量级。
- 粗译要压到 15 分钟内，优先调：批大小 → 并发 → （必要时）关掉 `find_tables`。

## 常见问题 → 先看哪里

| 现象 | 先查 |
|---|---|
| 标题/DOI/正文混成一块 | `_group_lines_by_style` 是否被绕过；`_can_merge_flat` 是否漏了 role/color/font |
| 整段继承奇怪的蓝色/字号 | 是否又用「第一个 span」取样式；`dom` 投票是否生效 |
| 图内文字被翻译 | `_classify_block` 里的字体家族/小字号规则；`skip_mask` 是否在所有入口生效 |
| 译文压字 / 跨栏 | `hard_obstacles` vs `text_obstacles`；`right` 夹取；`_x_overlap` |
| 公式变成 `p(h???1)` | `_mask_math` / `_restore_math`；源 PDF 是否本来就没有 ToUnicode |
| 译文出现 `]in` / 反斜杠 | `_latex_to_plain`（元组别少写 `, ""`） |
| 豆腐块 `□` | `_sanitize_text` 里 `has_glyph` 必须传 `int` 码点 |
| 参考文献被翻译 | `refsec` 状态机（按抽取顺序） |
| 翻译卡在 0% | 预检 30s、空闲超时 240s、OpenCode 端点限制 |

## 修改纪律

- **改代码前先读 [docs/CODE-MAP.md](../../../docs/CODE-MAP.md)**（功能 → 文件/函数对照表），按表定位；**改完必须同步更新该表**。
- 不要把 `skipRects` 当可选参数使用；缺省要**自己分析**，不能默认整页可翻译。
- 不要按「字号或颜色」单指标分类；至少结合 位置 + 区域 + 阅读顺序 + 字体。
- 不要为了排版把公式/图表内文字翻掉；**公式优先原样保留**。
- 不要静默把 `𝒫→P`：低占比可以近似，但必须记账 + 告警。
- 不要恢复 HTML 译文产物（AI 侧可直接产出 LaTeX）。
- 改完必须重新翻译才能看到效果（侧车不热重载，且旧译文不会变）。

## 已知限制

- 行内公式**不裁图、不回填原字形**；类别（花体/双线体/粗体）能保留，
  但外观与原 PDF 不同；类别未知的字符只能丢弃并告警。
- 数学变体的**文本层**可能因 htmlbox 子集 ToUnicode 偏移而无法正确复制/搜索
  （视觉正确）。
- 表格内部翻译未开放（默认整块保护）。
- 逐字样式（段内粗体位置）只保留在 `spans`，绘制仍用段落主导样式。
- 扫描件无文本层时不翻译（提示改用视觉识别）。

## 页对应 / 溢出 / 联动（2026-10 起）

- **译文与原文页数必须 1:1**：不追加文末补注页。放不下的译文按源页写入同名 .overflow.json，
  并在原位置回填原文（不留空白、不静默截断）；coverage.fellBackToOriginal 记账。
- **对照联动按源页 + 视口中线**：发送 {page, frac}（frac 相对视口中线），
  接收 scrollTop = pageTop + frac*pageHeight - clientHeight/2。不能用全文档比例。
- 联动是**单向**的（原文 → 译文）；译文侧回传会形成回声，把刚翻到的页拉回去。
- 用户滚动导致的页码变化**不得**触发程序化跳页；只有显式翻页/深链才校正 scrollTop。
- 位图缓存 key 不含文档身份 → 换文档必须清空位图/文本层；条目只有 
eady=true 才算命中。
- 参考文献续行合并时，
ects 必须覆盖每个片段（可跨页），否则后半段会被当成正文翻译。
- 写回时图片/图表区域必须同时参与**向上压缩**和**向下扩展**的边界；否则译文变长会压图。

## 版面 / 段落 / 高亮（二轮）

- 遮盖原文用 dd_redact_annot(..., fill=None)：只擦文字、保留原底色。
  旧实现用采样色填充整块，16 级量化把纯白算成 0.97 灰 → 译文页每段一块灰矩形。
- PyMuPDF 常把整栏返回成一个 block：按「行距突增 / 首行缩进+句末标点 / 末行明显短于栏宽」切段。
  不要按字符数切；行距基准用下四分位（行数少时中位数会被段间距带偏）。
- 纯编号（8. / 12 / iv.）原样保留：它们常被切成 1pt 高的小块，送去翻译必然放不下。
- 写回时「待写块」不是底部硬障碍：后续块按 cursor 下推（页内重排）；只有图/公式/保留块/图表区域限界。
- <out>.map.json 的块映射可带 srcSegs/dstSegs（仅当源/译句数一致）。选区优先映射到句级片段，
  否则整段；不做跨语言字符比例换算。
- 选区浮层按选区矩形随滚动/缩放重算；选区移出视口隐藏，靠近底部时翻到选区上方。

## 参考文献 / 强障碍（三轮）

- 
efsec 区内的**所有**块都按 reference 保留（含无编号续行）；只对 
oleHint=heading 和题注例外。
  旧规则只认带编号的行，段落切分后「续行」丢编号 → 被当正文翻译并压到未擦除的英文上。
- in_refs 遇到后置事项标题（作者贡献/致谢/利益冲突/数据可用性…）要结束，否则这些正文会被跳过。
- 参考文献**不参与**段落切分（条目本身是逻辑单位，切开只会丢编号）。
- 写回边界分三级：ottom_blockers（图/公式/保留块，要求完全在下方）、
  strong_obstacles（标题/参考文献/公式，**顶边落在块 bbox 内部也要让开**）、
  待写块靠 cursor 下推。
- 译文框绝不越过 ottom（max_box_h = bottom - y0；第一分支也要 min(bottom, ...)）。
  可用高度不足一行时保留原文（ellBackToOriginal），不硬挤进去压住标题/公式。

## 文献角标（引用上标）

- span 现在保留 box 与基线 origin；每个对象保留 lineSpans（按行），
  切段/合并必须同步切片/拼接（否则上标判定丢失行归属）。
- 两阶段识别，**不要**再用全篇纯文本正则：
  1. 行内局部基准（本行字符数最多的 span）：字号 ≤ 0.85×正文 且基线抬高 ≥ 0.15×正文；
     连续上标 span（含中间的 , –）合并为一个候选，支持 20,21 / 20–23。
  2. 编号形式 + 参考文献编号上限 + 公式/图内区域 + 上下文：
     单字母变量后的上标（x²）保留；^ 后保留；%/° 等保留；
     角标后紧跟大写单词（2Department）视为单位标记，保留；斜体数学字体保留。
- 只从**翻译输入**（
awClean）与译文移除；
aw、原文、MD 原文列保持不变。
- 元数据（citations）写入块映射：text/bbox（左下原点）/origStart/origEnd/cleanPos/context。
- citationsRemoved 计入 coverage；命中示例可在 .map.json 的 citations[].context 查看。

## 侧车存活判定（不要用 /health 超时杀进程）

- ensureSidecar() 只看**进程是否存活**（proc.exitCode === null）；存活就直接复用。
- **禁止**在普通请求路径上用 /health 超时判定死亡：PyMuPDF 的 ind_tables /
  pply_redactions / 逐页分析会长时间占住 GIL，/health 几秒不响应是正常的。
  误杀会丢掉正在写回的任务（曾出现 0 字节 PDF + 完整 map）。
- 健康检查只用于**启动阶段**（waitHealthy）；退出由 exit 事件/exitCode 驱动。
- ensureSidecar() 用单个 starting promise 做并发去重，避免两个请求同时清理/重建。
- 任务失败/侧车重启时删除可能写了一半的输出 PDF（cleanupPartial），避免 0 字节文件被当成译文。

## 角标的署名行例外

- 首页署名列表（逗号分隔、无句末标点）识别为 uthors 并保留，不翻译。
- 署名/单位行内的数字上标是单位编号（1,8 / 2,8），**不是文献引用**：
  行内若 , >= 3 且无句末标点，或含 >= 2 个 NBSP，则整行不做角标移除。

## 翻译任务与失败回填（2026-10-23）

- 每次请求使用独立 requestId；取消和进度按请求隔离，IPC 再加窗口身份。启动前取消也必须生效。
- 数学排版溢出不得计入 written 或成功映射；回填只在实际成功时计入 fellBackToOriginal，失败计入 fallbackFailed 并告警。
- 状态请求网络失败/5xx 时保留产物并有界退避；只根据进程退出或明确任务终止清理。连续五分钟无法恢复时请求取消并明确提示尚未确认终止。

## 倾斜文本 / 句级高亮 / 元数据补全（2026-10-24）

- 抽取阶段保存每行文字方向 `dir` 与 `angle`（`fitz.Matrix` 角）；合并段落时方向差 >1° 不得合并。
- 写回倾斜块用 `_fit_text_rotated`（局部坐标 `TextWriter.fill_textbox` + `write_text(morph=…)`），
  不要退回水平 `insert_textbox`；<1° 的扫描微倾斜按水平处理。旋转块的句级映射暂时只到整段。
- `.map.json` 优先用 `segs`（源句 ↔ 译句多对多，按句长比例对齐）；`srcSegs/dstSegs` 仅两侧句数一致时提供。
  同一行内多句按字符占比横向切分矩形，选区映射到句级后再退回整段。
- 「未收录期刊」优先查 `src/main/services/enrich.ts::enrichItem`（Crossref/OpenAlex，阈值 0.9、8s 超时），
  不要归因于 Google Scholar/SerpAPI：那条链路只负责检索与被引次数，不写 `venue`。
- 侧车 spawn 必须保留 `windowsHide: true`（Windows 无控制台窗口）；日志仍落 `sidecar.log`。

## 翻页 / 拆解 / 领域调研 / 翻译验收（2026-10-24）

- 阅读器可见 canvas 必须**双缓冲提交**（新 canvas 画好再同帧 `replaceChild`）；不要退回「就地改 width/height 再 drawImage」。骨架动画只给从未出图的页（`data-ever`），内存回收用迟滞 + 够用即停。
- 拆解：长文分段/多篇卡片默认 4 并发（`analysis.workers/cardWorkers`）；`analysis-chunk.ts::chooseAnalysisModel` 负责短段快速模型、长段/合并强模型；单段失败重试 1 次后写占位，不中断。
- 领域调研：`services/survey.ts::runSurvey` 只读标题/摘要（默认 24 路拆解 + 3–6 视角路由），不下载全文；候选加入文库后仍需逐篇精读。
- 翻译写完必须按页验收（`qa.verification`）：正文写入比例 < 阈值或 stuck 的页打回重译；重译用单页临时 PDF + `delete_page`/`insert_pdf` 保持 1:1，`verify=False` 防递归；失败保留原页并 warning。
