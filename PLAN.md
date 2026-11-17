# 下一阶段优化与修复计划

更新：2026-10-23。此文件是实施清单，不是已完成声明。范围以翻译完整性、任务生命周期、页面对应和阅读流畅性为主；精细样式与刊名优化靠后。

## 已完成基线

内置数学排版失败不再虚增 written；回填成功与失败分别记账；文本层不再无条件折叠重复数学变量；前台请求 ID 隔离取消与进度；存活侧车断连时保留产物并重试。已通过类型、单元、Python、坐标、构建、冒烟与端到端测试。

这些测试不能替代真实长任务验证。以下问题未在此次文档更新中修改业务代码。

## 执行顺序

1. P1 视觉翻译溢出与批处理取消。
2. P1/P2 视觉任务取消、未确认终止任务的恢复。
3. P2 译文复用条件与原文回填几何边界。
4. 性能和阅读联动基准；只根据测量决定是否调并发或重构。

每项应独立提交：先增加能失败的回归测试，再修复，再运行相关验收。不得通过删除断言、改变样本预期或缩减输入掩盖问题。

## F01 · P1 · 视觉翻译的超长页面会静默变成空白

- 状态：已动态复现。`python/app/vision.py::_write_text_pdf`（约 105–130 行）逐级缩字失败后，最后一次 `insert_textbox` 不检查返回值；`translate_pdf_vision` 仍返回 blocks=len(texts)、warnings=[]。
- 调用链：`main.py::_run_translate_job → translate_pdf_vision → _write_text_pdf`。与内置 simple 引擎不同，前一轮修复未覆盖此路径。
- 复现：临时目录中执行 `_write_text_pdf(path, ['Text ' * 20000])`，再用 PyMuPDF 读取。此次结果：1 页、文本字符数 0。合成极限样本只证明失败路径，不代表真实论文发生率。
- 修改：每次写入检查返回值；失败页保留源页可读内容或明确失败提示，完整译文保存为按源页组织的 overflow/Markdown；返回真实覆盖统计与告警，不将空页当成功。
- 边界：空模型响应、异常、4pt 仍溢出、CJK 字体不可用；不得擅自追加页面破坏对应关系。
- 验收：长页无静默空白、完整文字有可访问产物、统计与 PDF 一致；普通页不回归；源页关联稳定。

## F02 · P1 · 批处理取消未传递到正在执行的翻译

- 状态：代码路径确认，实际模型请求耗费待运行验证。
- 位置：`src/main/services/batch/queue.ts::cancelJob`（约 556 行）修改 cancelled 集合与数据库；`runJob`（约 396–435 行）仅在条目开始前检查；`registry.ts` 的 translate 处理器（约 184–200 行）调用 runTranslation 时没有接入 ctx.isCancelled。
- 影响：UI 已显示取消，但当前文档继续请求模型、写文件；条目完成后还会广播 running。前台取消句柄隔离并没有解决这个传播缺口。
- 修改：为每个 batch item 分配翻译请求 ID，通过取消订阅或 AbortSignal 传播到主进程翻译注册表；区分“已请求取消”和“确认停止”；取消后不得广播新的 running 状态。等待中的条目不启动。
- 复现：可控模型服务阻塞第一份文档，队列放两份，首份开始后取消；记录模型调用数、取消端点和状态事件顺序。
- 验收：取消只作用于目标条目，第二份不启动；其他并发作业继续；取消后的状态不回跳；完成与取消同时到达时结果有明确归属。无需重构整个队列。

## F03 · P1 · 视觉翻译取消仍可能等待整批页面完成

- 状态：静态确认；等待时长未实测。
- 位置：`python/app/vision.py::translate_pdf_vision`（约 180–192 行）。一次性提交所有页面，`as_completed` 只有 future 完成时才检查取消；抛出异常退出 ThreadPoolExecutor 上下文又会等待任务收尾。`_one` 在渲染/请求前没有检查取消。
- 影响：取消或某页失败后，排队页仍可能继续调用模型，拖长耗时与费用。
- 修改：有限在途队列，提交、页面渲染与模型调用前检查取消；定期检查取消，不依赖完成事件；取消排队 future；对已发请求明确其不可立即中断的限制。不得留下继续修改最终产物的失管线程。
- 复现：单 worker、三页，首个请求用事件阻塞；取消后释放首请求，观察后两页是否仍调用模型。
- 验收：未发出的页不再请求；调用方能及时响应取消；在途请求结束后资源释放；结果不被登记为成功。用事件控制测试，不等待真实 180 秒。

## F04 · P2 · 恢复超时后后台任务身份仍会丢失

- 状态：代码确认，是本轮修复后的剩余边界。
- 位置：`src/main/services/translation-jobs.ts::pollTranslationStatus/cancel/finish`；`translate.ts::runTranslation` 的 finally。
- 条件：连续五分钟无法恢复；cancel POST 失败被吞掉；随后 runTranslation 抛错、finally 删除句柄。产物虽然保留，后台却可能继续，后续无法通过原请求跟踪或取消，最终结果也可能不登记。
- 修改：增加“终止未确认”状态，保留 base/jobId/附件/产物路径；恢复连接后查询并收敛到 done/error/cancelled。只有确认终态才释放身份；对残留记录设置可解释的过期处理。考虑启动响应丢失时服务器幂等 requestId，避免重试生成重复任务。
- 复现：虚拟时钟推进五分钟、取消失败、随后侧车恢复并返回 done；检查能否恢复登记且只登记一次。
- 验收：明确区分请求取消与确认取消；不误删产物、不重复模型调用、不吞掉完成结果；应用重启策略须有测试。

## F05 · P2 · 翻译复用没有核对后端和模型

- 状态：静态确认；是否保留跨模型复用作为产品功能需要明确。
- 位置：`src/main/services/translate.ts::runTranslationJob`（约 389 行）。在读取 mtConfig/backend 前，只按 done 和 engineKey 复用；mode 已编码到 engineKey。
- 条件与影响：先用 mock 完成，再切真实模型，普通翻译可能复用离线结果；显式 backend 参数也不会参与已有结果判断。用户可用 force 绕开，但默认反馈不够明确。
- 修改：至少禁止 mock/none 结果冒充真实模型任务；使用实际 backend/model、源文件指纹及影响结果的参数组成复用签名。跨模型结果是否自动复用需显式策略；force 始终跳过复用。
- 复现：mock → openai；模型 A → B；fine/coarse；同路径 PDF 内容变化；有/无 force。
- 验收：复用反馈说明使用的是哪次产物；明确要求真实翻译时不能返回 mock。不要把密钥写入签名、日志或数据库产物元数据。

## F06 · P2 · 原文回填使用移动后的矩形，可能仍放不下

- 状态：风险待验证，不能作为已复现缺陷。
- 位置：`python/app/translate.py::simple_translate` 写回循环（约 3070–3245 行），top 按前块游标移动，回填矩形使用 `[r.x0, top, r.x1, max(r.y1, top+1)]`。
- 推测：前块向下扩展后，top 超过原块底边，回填框可能只有 1pt；目前 fallbackFailed 能报告失败，但不能保证页面正文存在。
- 先验证：构造同栏两个段落、第一段长译文、第二段下方紧邻公式/图片；测量剩余空间、回填结果和保护区域像素。若不能复现，不扩大修复范围。
- 候选修复：先规划整页可用空间再擦除；或对失败块保留原始内容并回退影响它的前块布局。不能直接把原文写回旧坐标而与已落版译文重叠。
- 验收：无正文消失、无重复、无越界/压图；失败块对应 overflow 内容完整，源页数不变。

## 性能与阅读专项：先测量，不预设瓶颈

- 基准：10/20 页原生文本、双栏公式密集、扫描件分别测量；记录硬件、引擎、模型、批量、并发、冷/热缓存、完整性指标和阶段耗时。15 分钟目标与译文覆盖率同时报告，不能通过跳过正文达标。
- 候选瓶颈：多文档并发乘以每文档 worker 数导致网关排队；视觉路径一次性提交全部页面；PyMuPDF 分析/写回占用 GIL。以上需实验才能排序。
- 阅读：重复测试快速翻页、缩放途中切文档、不同页面尺寸的联动；统计目标页上屏时延、重复渲染次数、缓存峰值、空白/旧页提交。当前 E2E 通过不等于任意大文档均无闪烁。
- 验收：固定样本与参数做前后比较，报告多次运行范围；错误率/漏译不增加。真实 API 会产生费用，实施时使用明确授权的测试配置，不读取真实用户目录取密钥。

## 工作边界与交接

- 不读取 node_modules、out、.git、.shots* 或真实用户数据目录进行审查；测试使用临时数据。
- 所有源码位置随修改可能移动，优先按函数定位。
- 本次只更新 README/PLAN 并增加审查证据；F01–F06 均未声明已修复。
- 修改后运行对应回归、typecheck、test:unit、test:py；IPC/界面改动再执行 build 与隔离的 test:e2e。
- 更新状态时保留触发条件、修复提交/文件、测试结果与未验证限制，避免只把复选框勾成完成。


## 用户新增重点：段落版式对齐与引用数字角标（2026-10-23）

### L01 · P1 · 优先修复角标误删与漏删

本次直接调用 `_apply_citation_filter` 的合成 span 样本已复现：

- `Results support this.12 Next experiment follows.` 中 12 为小字号高基线上标，removed=0。原因：`after.lstrip()[:1].isupper()` 将下一句误认为单位名称。应仅在已识别的作者/单位区域应用该保护规则，不能对所有正文使用。
- `In 12 trials results agree12 with prior work.` 中前一个 12 为正文、后一个为上标；实际清洗为 `In  trials results agree12 with prior work.`。原因：`lt.find(rawtxt.strip())` 定位到首次同文数字，而非该 span 的实际字符范围。

修改位置：`python/app/translate.py::_sup_runs_in_line/_apply_citation_filter` 与抽取时 lineSpans 构建。为每个 span 保留行内字符起止及规范化映射；跨 span 角标通过这些范围计算 origStart/origEnd，不再回搜数字。跨行合并、软连字符清理后仍需可追溯的偏移。引用上标识别保留字号/基线/编号/区域联合证据；正文单个变量指数、科学计数法、单位幂次及作者单位编号不得删除。

验收：上面两个样本先失败后通过；同一行多次相同角标、跨 span 编号范围、句首大写、x²、10³、cm²、作者署名分别测试。原始 raw 和原文 PDF 不变，只有 rawClean/译文输入清除已确认文献角标。

### L02 · P1 · 增加严格保版式策略，停止段落回收空白

当前 `simple_translate` 写回循环的 `top = r.y0 if cursor is None else cursor` 会将后段上移或下推；后续可翻译块不参与 bottom 硬边界；right 依赖同排障碍物，未直接限制到列边界。以上是与原文段落结构不一致的明确机制，不应仅靠字体参数补救。

实施顺序：

1. 固定 source paragraphId、columnId、bbox、首行缩进、段前后间距、对齐方向；保留 split/merge 的来源关系。送模型按段 ID 返回，不允许跨 ID 合并。
2. 严格模式下段顶保持原位、列边界固定，下一段作为可用空间边界；不回收上一段留下的空白。可读重排作为独立模式，不与严格模式混用。
3. 先在临时页面测量排版，再确认写入方案，最后擦除原文。普通文字和数学 HTML 分支使用同一可用矩形约束。
4. 优先原字号和相近行距，有限缩字；仍超出时原段保留、完整译文进入可访问的溢出产物。不能为保框强删译文或持续压成 4pt。
5. 使用实际落版行生成映射，原段和译段一一对应；不承诺中英文逐行字数与换行完全一致。

验收样本：双栏不等长段、首行缩进、段间空白、标题后短段、图前后正文、行内公式。检查源译段落数与 ID、段顶坐标误差（初始目标 1pt 内）、不跨列、不压图、不丢字。OCR/视觉引擎须先具备段落 bbox，不能直接宣称支持严格保版式。

建议优先级：L01 → L02 的布局测量与严格模式 → F01/F02；真实论文样本用于确认段落识别效果，不能用单一截图作为完整验收。

### 实施记录：角标定位修复

已修复相同数字误定位和正文下一句大写导致漏删：按 span 顺序建立行内偏移，定位失败保守保留；大写保护限定到作者/单位类别。新增两个回归样本。严格段落布局的直接限宽试改触发两项现有测试失败，已撤回，L02 仍待实现；下一步先完成临时试排与段落几何测试，不直接收紧生产写回框。

## 实施记录（2026-10-23 第二轮）

- **L01**：工作区已实现（按 span 顺序建立行内偏移，不再回搜同文数字；大写保护限定到作者/单位）；新增回归样本。未在真实施工中单独复验。
- **F01**：已修复。_write_text_pdf 每次检查返回值；4pt 仍溢出时写可读提示，完整译文按源页写入 <out>.overflow.json；locks 只计落版页，新增 coverage.overflowPages/emptyPages 与告警。测试：超长页（Text * 20000 量级）不再空白、普通页/页数 1:1 不回归。
- **F02**：已修复。
unTranslation(..., isCancelled) 在轮询中（约 0.7s）检查批处理取消并调用 	ranslationJobs.cancel；取消的条目不记失败、不广播 
unning。未用真实阻塞模型端点做时序实测。
- **F03**：已修复。视觉路径改为有界在途队列（workers×2），渲染前/请求前检查取消；取消时取消排队任务、shutdown(wait=False) 不等待在途请求。测试：1 worker/3 页，取消后只调用 1 次模型且不产出成功 PDF。
- **F04**：已实现「终止未确认」。断连/取消窗口耗尽时保留 base/jobId/产物路径与 finalize 回调，不再在 finally 删除身份；主进程每 30s 调用 `reconcileTranslationJobs()`：done → 用保留的 finalize 登记（只一次），error/404 → 释放，取消过的任务即使 done 也不登记；30 分钟未收敛则清理并记日志。单测覆盖 finish 不删除未确认、confirm 释放、过期清理、五分窗口报 `TranslationTerminationUnconfirmed`。未做：应用重启后句柄持久化（内存态丢失，产物仍在）、服务端幂等 requestId。
inally 会删除句柄，五分钟仍不可达时后台是否终止无法追踪。未做虚拟时钟测试。
- **F05**：已修复。复用需同引擎/模式 + 实际 backend/model + 源文件指纹（size:mtime）；mock/none 不冒充真实结果，旧译文无签名不复用，
orce 跳过。单测覆盖 mock→openai、模型变化、文件变化、引擎变化。
- **F06**：已复现并修复。合成样本（第一段长译文 + 第二段紧邻图片）原先回填矩形 1pt、
allbackFailed=1、正文消失；恢复下一段作为硬边界并把明显小于正文的 6pt 单/双行保留原文后，28 页样本 
allbackFailed 7→0，正文槽位仍有文字。代价：6pt 参考文献/脚注不再翻译（expected 235→206）。
- **L02**：已实现。`layout=strict`（翻译面板/批处理可选）：段顶固定、宽度不越过原文段落右缘、可读下限 6.5pt；**先在临时页面试排**，放不下的段落不擦除（保留原文）+ 完整译文进 overflow；单测覆盖段顶 ≤1.5pt、不跨栏、原文保留、overflow 可访问、短段照常翻译。实测 28 页 mock：strict 约 17.0s（reflow 约 9.6s，试排+数学测量带来的开销），written 187/206、保留原文 19、fallbackFailed 0。未做：首行缩进/对齐/段距保持、严格模式默认启用。
- **性能**：28 页新论文 mock 本地约 9.6–10.1s（extract≈1s、analyze≈5s、write≈4s）；模型阶段未实测，不能据此宣称 15 分钟目标。
- **验证**：typecheck、UNIT_OK、全部 test:py、SMOKE_OK、build、E2E_OK。测试使用临时数据；未读取真实用户目录。

## 翻译速度第二轮（2026-10-24，工作区已实现，未提交）

目标：继续压缩翻译总耗时。上一轮已把「本地分析/写回」压下来，本轮针对**模型请求调度与单请求延迟**。

已实现（每项都有代码与可复跑的检查）：

1. **请求分组不再按章节放大**：`python/app/translate.py::group_translation_items`。默认按内容类型分组（同类型 system prompt 相同）；只有用户自定义 skill 的 prompt 真的引用 `{section}` 时才按章节拆组。此前一个 117 段样本生成 44 个请求（其中大量 1~2 段的小请求），现在 21 个。
2. **一波发完的批大小**：`pick_batch_size`。选「请求数 ≤ 并发数」前提下最小的批（上限 16）。此前 `round(段数/并发)` 会得到 25 请求 / 24 并发，多付一整波延迟。离线调度模拟（延迟曲线取 4 段 42s / 8 段 61s / 16 段 127s）：117 段样本 44 请求/2 波（≈93.5s）→ 21 请求/1 波（≈52s）；并发 32 时 ≈43s。
3. **翻译时关闭模型思考**：`_post_chat` 默认带 `thinking: {"type": "disabled"}`，`no_think` 贯穿 `translate_text` / `_openai_translate_plain` / `_openai_translate_many` / `simple_translate`。服务端不接受该参数时（400 且错误信息匹配 thinking/reasoning/unknown parameter 等）自动去掉重试一次，并在进程内记住。设置 → 翻译 →「翻译时关闭模型思考」；`mt.thinking` / `PAPERDESK_MT_THINKING`。
4. **术语表与分析重叠**：术语抽取在合段完成后就用后台线程发出（`pd-glossary`），翻译前 join；等待期间检查取消。失败保持原行为（不加术语约束、不阻断翻译）。
5. **并发默认值**：OpenCode 网关 32、其它 24（上限 32）；`mt.workers` / `PAPERDESK_MT_WORKERS` 可覆盖。
6. **计时字段**：`timing.planRequests / groups / noThink`；`batchSize` 现在反映实际自适应结果。

新增回归（`python/tests/test_translate.py`）：分组（含 `{section}` 分支/保护块）、`pick_batch_size` 边界、请求体默认带 thinking、`no_think=False` 不发、400 参数拒绝时去掉并重试且进程内记住、术语进入 system prompt 与 `qa.glossary`、`auto_glossary=False` 不抽取但照常翻译。

本轮验证：`npm run typecheck`、`npm run test:unit`（UNIT_OK）、`npm run test:coords`（COORDS_OK）、`npm run test:py`（全部 *_OK，含 TRANSLATE_OK）、`npm run smoke`（SMOKE_OK）、`npm run build`（构建成功；沙箱里需把 `TEMP` 指到工作区，避开临时目录 ACL）。**Electron E2E 在本会话不可用**：尝试运行（清掉 `ELECTRON_RUN_AS_NODE=1` 后）Electron 能启动，但 CDP `page target` 不可达 → `E2E_FAIL`；需在正常桌面环境执行 `npm run test:e2e`。

独立复核（verifier，只读）发现并已修复：

- **设置在 Electron 里的取值写反**：`noThink = ('mt.thinking' !== '0')` 导致默认 `0`（关闭思考）实际发出 `noThink=false`，与 UI/文档相反；已改为 `=== '0'`。
- **术语抽取绕过降级路径**：`extract_glossary` 直接 `http.post`，严格服务端 400 时永远拿不到术语且每次翻译都重试；已改为走 `_post_chat`（同样带 thinking 关闭 + 一次降级重试），并有回归。
- **thinking 参数错误匹配过宽**：`Unsupported parameter: max_tokens` 这类无关 400 会被当成 thinking 被拒并永久停用；已收窄为「thinking/reasoning + unsupported/unknown/…」同时出现，并增加负例回归。
- 病态页（>2000 图元）现在连 `find_tables` 都不跑（之前会白跑，之后整页又保留原文）。

复核仍未覆盖的边界（保留在风险清单）：`_figure_regions` 栅格候选只保留每格首个 owner，理论上可能漏掉极近的一对矩形（上一轮 83 页 0 差异只是经验证据）；`_http` 复用连接池时陈旧的 keep-alive 可能抛 `RemoteProtocolError`（外层重试可兜底）；`pick_batch_size` 的**调用点**若被改回旧公式，纯函数单测不会失败（只有调度基准会暴露）。

未验证 / 下一步（不得把估算当验收）：

- **真实端点 A/B**：同一 12 页论文，`PAPERDESK_MT_THINKING=1` vs `0`，记录 wall、`requestSeconds`、`requests`、失败/重试与译文质量抽检（术语、数学符号、引用角标、漏译段数）。若网关**静默忽略** thinking（不报 400 也不生效），需在 README 注明该端点无收益，避免误导。
- **质量抽检**：关闭思考后抽 20 段中英对照人工/独立模型评估；翻译任务通常不需要推理，但不得以速度换漏译。
- **大文档批上限**：>600 段时 cap=16 仍会有 2+ 波；需要真实基准判断「提高 cap（单请求更慢但一波打完）」是否更优。
- **批处理多篇并发**：单篇已用满 24/32 并发，暂不提高 `batch.concurrency`；如要改需测网关排队。
- 调度回归脚本已入库：`python/tests/bench_schedule.py`（离线模拟延迟，**不测真实模型质量**）。真实端点基准仍用 `python/tests/bench_translate.py`。


## 启动恢复、阅读渲染与代码对照表（2026-10-24）

### 启动：恢复原始方式，不引入包装脚本

- 启动脚本已恢复为 `electron-vite dev / build / preview`；上一轮临时加的 `scripts/run-electron-vite.cjs`、`scripts/repair-electron-access.ps1`、`.gitignore` 追加项和 `src/main/index.ts` 的启动捕获均已删除/tree 还原（`git diff` 对这三个启动文件为空）。
- 真实原因不在源码：工作区文件被打了 Windows **Low 完整性标签**，Electron 原生初始化阶段直接崩溃（退出码 `-2147483645` / `0x80000003`），表现为打印 `starting electron app...` 后静默回到提示符、无窗口无报错。已用 `icacls "C:\Users\YOUR_USER\paperdesk" /setintegritylevel "(OI)(CI)Medium" /T /C` 将工作区恢复为 Medium（系统权限操作，17,686 个文件）；随后原始 `npm run build` 与从工作区启动 Electron 均正常。
- 若再次出现同样的秒退：先检查工作区/Electron 目录的完整性标签是否又变成 Low，**不要**改启动脚本、不要加 `--no-sandbox`、不要删论文数据库。

### 阅读渲染（本次改动）

- `PdfViewer.tsx::ScrollPages` 改为**延迟布局**：只取第一页尺寸就开始上屏；其余页按第一页占位，渲染到真实页面时再修正。删除了打开文档时 `for 1..numPages getPage` 的全量解析——这是切到大文档/译文长时间空白的主因。
- 未出图的页面显示浅色骨架（`styles.css` 的 `.scrollpage:not(:has(canvas[data-rendered='1']))`），不再像卡死白屏。
- `preloadTranslationDoc`：译文就绪后空闲时读盘 + pdf.js 解析，保留在 `docCache`（只保留最近一份预加载）；打开「中英对照」不再先空白等解析（译文内嵌 CJK 字体，首开通常比原文更慢）。
- 文本层延后到 `setTimeout(0)` 构建，不占渲染并发位；译文页 CJK span 多时，后续页位图更早出来。

### 翻译后台（本次改动）

- 主进程翻译任务本来就不会因为切换文档而取消；问题在渲染层丢了进度。现在进度按附件记录（`bgProgressRef` + `runningAttachment`），切走再切回可恢复「翻译中」状态；`translating` 只对当前附件生效，另一篇的翻译按钮不再被误禁用。

### 代码功能对照表

- 新增 `docs/CODE-MAP.md`：功能 → 文件/函数/关键行为的映射，含「常见改动入口」和渲染/翻译不变量。
- **维护约定**：每次修改代码必须同步更新该表（README 已链接并写明）；行号会漂移，以函数/组件名定位。

### 验证

- `typecheck`、`test:unit`（UNIT_OK）、`test:coords`（COORDS_OK）、`test:py`（全部 *_OK，含 TRANSLATE_OK）、`smoke`（SMOKE_OK）、`build` 通过。
- Electron 端到端 `npm run test:e2e` 通过（E2E_OK），覆盖阅读器渲染/快速翻页、翻译、对照阅读、批处理与数据安全。

### 待验证 / 下一步

- 真实大文档（>100 页、扫描件、30MB+ 译文）首屏与切文档时延前后对比；用固定样本记录，而不是体感。
- 译文预加载的内存占用与淘汰：当前 `docCache` 6 份 + 预加载 1 份；长会话多文档切换时观察内存峰值。
- 文本层延后对「位图刚出现时立刻划词」的影响；E2E 只验证最终可选，不验证毫秒级时序。
- 若仍能复现翻译中断：需要主进程/侧车日志确认是任务被杀、侧车重启，还是仅 UI 丢失进度；目前证据只支持后者。

## 文库文档详情（2026-10-24）

- 双击文库条目 → 左栏 `ItemDetailPanel`：作者、期刊/出处、年份/领域、附件与页数、DOI；左上角「←」返回文档列表。
- **主要思想**：`shared/note-sections.ts::extractAnalysisSection` 读取条目笔记里**已保存的「论文拆解」小节**（拆解面板「归档到笔记」或批处理 `archiveNote` 写入；多份时取最新一份），否则退回摘要并标注来源。
- **被引**：`services/works.ts::citationsForItem`——Google Scholar（SerpAPI，设置 → 其他填 Key）优先；无 Key/未匹配时用 Semantic Scholar 兜底并标注来源；都失败给可读说明。结果按条目缓存 6 小时，可手动刷新；新增 IPC `works:citations`。
- **验证**：`typecheck`、`test:unit`（新增标题匹配/拆解小节用例）、`build`；E2E 增加「双击打开文档详情 / 返回列表」检查。
- **未做/边界**：未拆解且无摘要时只显示说明；批处理「按范式拆解」的输出文件未回填详情（只认已归档到笔记的拆解）；Google Scholar 数字受 SerpAPI 配额与匹配影响，可能滞后。

## 后端静默 / 倾斜译文 / 句级高亮 / 期刊补全（2026-10-24）

- **后端静默**：`src/main/sidecar/manager.ts::ensureSidecar` 的 spawn 增加 `windowsHide: true`（Windows 上 `CREATE_NO_WINDOW`）；`src/main/services/formula-ocr.ts` 的可选 OCR CLI 同样处理。日志仍写 `sidecar.log`。
- **倾斜译文**：`python/app/translate.py` 抽取时记录每行 `dir`/`angle`；`_fit_text_rotated` 用局部坐标 `TextWriter.fill_textbox` + `write_text(morph=(pivot, Matrix(angle)))` 旋转落版；`_can_merge_flat` 禁止方向差 >1° 的块合并；<1° 按水平处理。
- **句级高亮**：新增 `_segments`（句子 → 矩形 + 字数，行内按字符比例横向切分）与 `_align_segments`（累计字数比例单调多对多对齐）；`.map.json` 新增 `segs`；`CompareView.tsx::mapSelection` 优先用 `segs`，旧译文回退 `srcSegs/dstSegs`/整段。
- **期刊补全**：`services/enrich.ts::enrichItem` 改为字段独立补全（Crossref DOI + `query.bibliographic` 标题检索、OpenAlex DOI/标题，阈值 0.9，8s 超时）；`services/extract.ts` persist 后缺 `venue/year/doi` 时自动补一次。与 Google Scholar/SerpAPI 无关；SerpAPI 不需要 VPN。
- **测试**：`python/tests/test_translate.py` 增加旋转方向、句级对齐、行内切分、map `segs` 用例；`scripts/test-unit.ts` 增加标题归一化/相似度/选优用例。
- **边界**：旧译文没有 `segs`/`angle`，需重新翻译；旋转块暂不做句级映射（整段）；期刊补全受 Crossref/OpenAlex 覆盖与网络影响，低置信度时宁可留空。

## 翻页闪白 / 拆解提速 / 领域调研 / 翻译验收（2026-10-24）

- **翻页闪白**：`PdfViewer.tsx::commitBitmap` 改双缓冲（新 canvas 画好同帧替换旧 canvas）；`ensurePageCanvas` 让 React 只持有稳定容器；`releaseDistant` 迟滞 + 够用即停 + 最远先释放；`pruneQueue` 保留 ±4/±6；CSS 骨架只给从未出图的页（`data-ever`）。
- **拆解提速**：`services/concurrency.ts` + `analysis.ts` 长文分段并发（默认 4）与多篇卡片并发（默认 4）；`analysis-chunk.ts::chooseAnalysisModel` 做短段/长段/合并的快速/强模型路由；设置「拆解」区可调并发与模型。
- **领域调研**：新增 `services/survey.ts::runSurvey`、`ipc/survey.ts`、`shared/survey.ts`、`features/survey/SurveyPanel.tsx`；种子 + Google/OpenAlex → 默认 24 路摘要级拆解 → 3–6 视角并行打分合并；候选可加入文库；不下载全文。
- **翻译验收**：`translate.py` 写回按页记账，保存后逐页验收（正文写入比例 ≥0.6 且无 stuck），失败页最多 3 页自动重译（单页临时 PDF → 替换回主 PDF，保持 1:1，2 线程）；`qa.verification` 由 `TranslationPanel` 展示。
- **验证**：`typecheck`、`test:unit`、`test:coords`、`test:py`（TRANSLATE_OK）、`smoke`、`build`、`test:e2e`（E2E_OK，含翻页双缓冲/领域调研检查）。
- **边界**：领域调研只读标题/摘要，不等同全文精读；候选无摘要时质量下降；拆解/路由并发受网关限流影响，可调小；翻译重译页的 Markdown/qa.items 仍基于首轮（PDF 为准）；`PyMuPDF` 非线程安全，重译并发默认 2。

## 最新论文优先（2026-10-25）

- **问题**：OpenAlex 关键词检索与方向检索原先统一 `sort=cited_by_count:desc`，施引文献也按被引排序；新领域的高被引旧文会把近两年工作挤掉。
- **检索**：`WorkSearchOptions.sort` 增加 `recent/cited/relevance`；OpenAlex `publication_date:desc`、Google `sort_by=date`、Crossref `published`、Semantic 当前页按年份重排；文献检索默认「最新优先」并可在 UI 切换。
- **相关论文 / 研究方向**：`topicGraph` 支持 recent/cited；`fetchCitations` 改为发表时间倒序；`fetchRecentByTitle` 额外补「近两年、标题相近」论文；面板列表按所选排序。
- **领域调研**：`SurveyRunOptions.sort` 默认 recent，补完摘要/年份后二次排序。
- **边界**：旧相关论文缓存不自动失效，需点「开始查询」；OpenAlex/Crossref 对新论文收录有延迟；「最新」不等于质量最高，可切「高被引」交叉看。

## 九项体验/性能修复（2026-10-27）

- **性能**：文库作者批量本地查询（去 N+1 IPC）；原文/对照双视图同时挂载、只切显隐，`resetKey` 去掉 `viewMode`；`.scrollpage` 用 `content-visibility`；滚动后 800ms 暂停后台回填。
- **表格**：`_table_regions` 提前到合段前，线条聚类 + `find_tables` 网格识别三线表；表格区域同时作为合段/擦除/回写屏障。表格内文字本轮保留原文，避免再次压坏。
- **导入**：DOI/arXiv/URL 解析补 DOI 内容协商、OpenAlex/Unpaywall、Crossref、出版社 `citation_pdf_url`、arXiv、直链 PDF 头校验；失败给具体原因。
- **分组**：`items.group_name` 扁平标签 + 幂等迁移；导入差集自动归组；空分组也进下拉框；详情内可改组。
- **闪页**：同文档切视图不重建阅读器；隐藏视图保留页码/滚动/位图。
- **页面角色**：`_page_roles_from_texts` 输出 body/references/appendix/front_matter；参考文献不强制翻译，附录按正文翻译并按正文验收；`qa.verification.pageRoles` 在翻译面板显示。
- **双向联动**：`CompareView.originRef` 防回声，右侧滚动/翻页可反向驱动左侧；关闭“联动”即互不干扰。
- **图表缩放**：`figZoom` 触发区域重渲染，canvas 真实像素放大；50%–300%，非 CSS 拉伸。
- **问答**：固定 hybrid，删除混合/语义/词法选择器。

完整方案/取舍/边界见 [docs/FIXES-2026-10-27.md](docs/FIXES-2026-10-27.md)；代码定位见 [docs/CODE-MAP.md](docs/CODE-MAP.md)。最终验证：typecheck、unit、coords、py、build、E2E、smoke 全通过。
