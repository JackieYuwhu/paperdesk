# GUI 验收走查（2026-11-06，测试副本）

- 构建：`C:\Users\YOUR_USER\paperdesk_build\stable-c9b72e9`（commit `c9b72e9cca041b9ea5c0d614f2ea92aed31443b1`）
- 启动方式：`node plugins/tools/launch-visible.mjs C:\Users\YOUR_USER\paperdesk_test`（可见窗口，标题带 `[TEST]` 前缀）
- 数据状态：文件库 8 篇论文；知识库无已发布条目；暂存区 0 条待审；批处理作业 1 个（论文拆解 · 3/3 · 批次 BP4C2QRR）
- 证据目录：`C:\Users\YOUR_USER\paperdesk_test\docs\assets\acc-0*.png`（真实 PNG，签名字节 `89 50 4E 47`）

## 逐项结论

| # | 走查项 | 实际现象 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 知识库面板 | 工具条「知识库」可达；空态有标题「知识库里的内容从哪来」、「去暂存区审核」「打开暂存区…」；正文区为 1 段说明 + 3 步引导 | 通过（说明仍略长，见 D1） | `acc-01-knowledge-empty.png` |
| 2 | 暂存区面板 | 顶部**无**解释性长段落；工具条为「选择批次 / 全选 / 发布所选 (0) / 全部批准 (0)」；空态文案可读 | 通过 | `acc-02-staging-toolbar.png` |
| 3 | 批处理同步区 | 作业卡同步区只有「同步到知识库」「同步到思维地图」两个按钮，**无**大段说明；点「同步到思维地图」弹出确认框：「将同步整批已完成的 3 篇论文的拆解要点到思维地图。预计影响：最多 3 篇论文；按本次结果覆盖上一次同步到地图的节点（你改过名的节点会保留，手工建的节点不删）。继续？」——覆盖式语义正确，无「追加」字样 | 通过 | `acc-03-batch-sync-confirm.png` |
| 4 | 思维地图面板 | 工具条 12 个控件齐全未遮挡；节点长标题换行完整、无省略号；`−` 两次后缩放 100% → 80%；点选后显示「已选 1 个」；节点正文无 Markdown 标记 | 通过（底部提示段落过长，见 D2） | `acc-04-mindmap-zoom80-ai-hint.png` |
| 5 | 聚合视图开窗与复用 | 切「全部」级，点论文节点「打开」→ 独立窗口，标题 `[TEST] 思维地图 · Large language models discover complementary heuristics for combinatorial optimization — 独立测试副本`；再次点同一节点 → 窗口列表仍只有 1 个该标题窗口（复用 + 聚焦），主窗口状态行显示「已在新窗口打开: …」 | 通过 | `acc-05-standalone-mindmap-window.png`、`acc-06-aggregate-reuse.png`；`windows list` 两次计数均为 1 |
| 6 | AI 入口（未配置模型） | 点「AI 摘要」→ 内联红字「尚未配置模型服务：到 设置 → 模型服务 填写 Base URL、API Key 与 模型 ID 后重试　地图内容未改动」，无崩溃，节点数不变；按钮为可点击状态（不再灰掉无反馈） | 通过 | `acc-04-mindmap-zoom80-ai-hint.png` |
| 7 | AI 工具库 | 本机设置面板需滚动较深且分区为翻译提示词块，本轮未在窗口内定位到「AI 工具库」区块并截图；该区块由 PD54 的 e2e（分类计数、开关、恢复默认）与 2026-11-05 手工抽查覆盖 | 未覆盖（证据来自自动化，非本轮窗口） | e2e `E2E_OK`、`docs/AI-TOOLS.md` |
| 8 | 文案简洁度 | 知识库/暂存区/批处理已精简到位；思维地图底部仍有一段 3 行长说明，设置 → 模型服务仍有 3 行说明 | 部分通过（D1、D2） | 见 D1、D2 |

## 缺陷清单

- **D1（轻微）** 设置 → 模型服务：说明为 3 行（「填好下面的 Base URL 与 API Key…」「留空则使用离线占位…」「用 OpenCode Go…也可以…」），按要求应压到 1 行，细节移入 README。
- **D2（轻微）** 思维地图底部提示段落：「根节点即当前文献标题；根节点不可删除；可用「从论文结构生成骨架」…；选中节点后可用「AI 摘要 / AI 优化 / 找支撑段落」…；地图按文献分别保存…；需要导出画布时…」共 3 行、6 个分句，按要求应压到 1 行，细节移入 README。
- **D3（数据限制，非缺陷）** 暂存区 0 条、知识库 0 条，因此「一键批准整批」的二次确认与「按论文分组/组头长标题不截断」只能通过空态与代码/单测证据确认；有数据时需复跑第 1、2 组。

## 未修复项

- D1、D2 属文案级改动，本轮只做验收未改代码；补丁建议：把两处段落替换为一行摘要，完整说明移入 `README.md` 对应小节（思维地图 / 设置）。

## 回归

- 本轮为只读验收，未修改 `src/`；`typecheck`、`test-unit`、`test-coords`、`build`、`e2e`、`check-isolation` 的结果见 `c9b72e9` 合并时的记录（全部通过）。

## 走查后修复（2026-11-06 12:40）

- D2 已修：src/renderer/src/features/mindmap/MindMapPanel.tsx 底部提示压成一行「骨架、AI 摘要/优化、点锚定位与导出说明见 README「思维地图」一节。」
- D1 已修：src/renderer/src/features/settings/SettingsDialog.tsx 模型服务说明压成一行「填写 Base URL 与 API Key 即启用真模型，留空走离线占位；OpenCode Go 已内置 User-Agent 与会话头，细节见 README。」
- 细节已移入 README.md 新增「## 界面文案与细节」与「## 思维地图（分级 / AI 优化）」。
- 修复后回归：	ypecheck 0、uild 0（index-CCSDKnzW.js 3,762.68 kB）、UNIT_OK、COORDS_OK、E2E_OK。
