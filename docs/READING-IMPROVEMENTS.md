# 阅读修复的实现与验证

## 功能位置

| 功能 | 主要入口 |
| --- | --- |
| AI 浮窗 | `ReadingAssistant`、App 的 `selectTab` 与阅读入口；复用 AiPanel 和已有对话历史 |
| 当前页专注与左栏 | App 的 `applyLayout`、`sidebarLabel`；usePanels 的最近面板与功能历史 |
| 双页对齐 | CompareView 的初始化锚点、显式页码联动与 reloadKey；styles 的固定页头高度 |
| 单页新版本 | translate.ts 的 `retranslatePage` 暂存版本与事务提交；`retranslateWorkingPage` 调用侧车 |
| 译文批注 | reader IPC 的 translationId 校验与 position JSON；PdfViewer 的版本隔离读取 |
| 术语库 | article-glossary 服务、shared/glossary、GlossaryPanel、translate IPC/preload/API |
| 句段对应 | translate.py 的 `_marked_sentences`、`_unmark_sentences`、`_segment_pieces`；selection-map |
| 公式保护 | inline_math.py 的上下标分组；translate.py 的占位符完整性校验 |
| 内存 | PdfViewer 的文档引用缓存、48 MiB 离屏预算、96 MiB 位图阈值、按需搜索文本层 |

## 实现取舍

重译新版本只替换一个页面；PDF 和伴随 map/Markdown 先复制到独立路径，任务失败删除暂存产物，旧版本不变。数据库提交时旧版标为 superseded，新版标为 done。未变页的译文批注复制到新版，重排页的旧标注仍留在旧版，不凭坐标猜测迁移。

术语以“附件＋原词＋词义”区分，同一 pool 可有候选集合和水域两条译法。提示中将词义与例句作为条件，用户锁定优先。搜索结果只作为证据，无法找到支持的译法时使用模型建议并保留待确认状态。持久化正文指纹避免每次重译都重新提取。自动任务使用 INSERT OR IGNORE，不能覆盖用户修改。

句子边界随翻译请求发送并检验顺序及完整性，去除标记后再排版。原译句的每行片段归属于同一句，避免用跨语言字符比例推断词级对应。旧译文没有映射时提示重译。

## 开源候选

- [BabelDOC](https://github.com/funstory-ai/BabelDOC)：保版式翻译、术语约束、公式保护；集成时固定版本并检查 API 兼容性与许可证。
- [PDFMathTranslate-next](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next)：BabelDOC 完整调用参考。
- [MinerU](https://github.com/opendatalab/MinerU)：复杂版面及公式解析；需要评测中文行内公式、Windows 部署和模型内存。
- [Bertalign](https://github.com/bfsujason/bertalign)：已有中英文本的句级多对多对齐；离线运行并缓存结果，避免阅读过程中常驻大模型。
- [SimAlign](https://github.com/cisnlp/simalign)：词级对应候选；仍需页面字形坐标，不能直接替代 PDF 选区层。
- [Zotero Reader](https://github.com/zotero/reader)：PDF 标注与阅读交互参考。

这些项目尚未加入生产依赖。下一步应使用原始问题 PDF 对比分段、公式完整性、排版、选区、耗时和峰值内存，再决定是否接入。

## 验收

`npm test` 运行常规检查，新增 `test-reading.ts` 和 `test_reading_regressions.py` 覆盖术语过滤、多义词提示、术语变化使缓存失效、多字符上下标、句界标记及公式缺失/重复保护。

`npm run test:workspace` 使用临时文库、离线模型和合成 PDF，覆盖实际 IPC、页面重译版本、标注隔离和长文档搜索，截图与测量写入被忽略的 `.tmp-shots/workspace`。

尚未验证真实模型的句界遵循率、权威译名检索准确率，以及原始问题 PDF 上的公式质量。程序总内存与后台模型常驻占用仍需在真实使用会话中进一步测量。
