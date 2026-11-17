# 思维地图 AI 与数据层（PD55）

本文说明思维地图的数据契约：覆盖式同步、AI 结构化骨架、AI 工具注册表、点锚点定位与失败回退。
所有内容均为本地实现，AI 结果不自动发布，不改论文原文，不写正式知识库条目。

## 1. 文件与职责

| 模块 | 职责 |
| --- | --- |
| `src/shared/mindmap-skeleton.ts` | 纯函数：规则骨架、骨架 prompt、AI JSON 解析与校验、覆盖式写图 `applySkeletonToMindMap`、稳定节点 id、Markdown 清洗 |
| `src/main/services/mindmap-skeleton.ts` | `generateItemSkeleton(itemId, opts)`：查条目、取拆解要点、调用注册表生成 AI 骨架，失败回退规则骨架 |
| `src/main/services/mindmap-ai-tools.ts` | 唯一 AI 工具注册表：5 个动作的 promptBuilder / parse / guard，统一执行入口 `runMindmapAiTool` |
| `src/shared/mindmap-ai.ts` | 节点级 prompt、解析、摘要/优化/展开/找支撑，AI 错误文案 |
| `src/shared/mindmap-anchor.ts` | 点锚点：`locateQuoteSpan`、`locateAnchor`、序列化/反序列化、bbox 解析 |
| `src/main/services/mindmap.ts` | `data/mindmap/<items.key>.json` 读写、覆盖式同步编排、原文片段与 anchor 组装、IPC 服务入口 |
| `src/main/ipc/mindmap.ts` | `mindmap:load/save/summarize/optimize/expand/findSupport/syncDigest/export` 参数校验与白名单透传 |
| `src/renderer/src/features/mindmap/mindmap-model.ts` | 渲染端地图归一化；透传 `provenance` / `anchor` / `sync`，不丢字段 |

地图文件仍是 `data/mindmap/<items.key>.json`，不新增数据库表。老文件没有 `provenance` / `sync` 时按「用户节点 + 未同步」读取，可继续编辑与导出。

## 2. 覆盖式同步

入口：

- 单篇：`window.api.mindmap.syncDigest({ itemId, markdown, title?, batchId? })` → `mindmap:syncDigest` → `syncDigestToItemMindMap`。
- 批处理：`knowledge:batchSync`（`target='mindmap'`）逐篇调用同一服务，`batchId` 使用批次 runId。

语义：

1. 同步 id `syncId = sha256(规范化 markdown).slice(0,32)`；规范化只做 BOM 去除、CRLF→LF、去行尾空白、trim，不改正文。
2. 本次同步由 `generateItemSkeleton` 生成骨架（优先 AI，失败规则），写入 3 层结构：根 → 主题 → 要点。
3. 写入前删除「上一次同步写入且未被用户编辑」的节点；判定依据是 `provenance.source='sync'`。
4. 用户节点永不删除：没有 `provenance` 的老节点、用户新建节点、被改过文本或位置的同步节点都保留。
   - `userEdited` 判定：`provenance.userEdited === true`，或 `text !== originText`，或 `x/y !== originX/originY`。
   - 保留下来的同步节点若父节点本轮被删，会重新挂到根节点，避免丢失。
5. 返回值 `MindmapSyncResult`：`{ itemId, points, added, removed, kept, mode, syncId, warnings }`。
   - `added`：本轮新写入的骨架节点数。
   - `removed`：本轮删除的旧同步节点数。
   - `kept`：旧同步节点中因用户编辑而保留的数量。
   - `mode`：`'ai' | 'rule'`，界面据此显示「AI 骨架 / 规则骨架」。
6. 幂等：同一份内容、同一 `syncId` 且节点完整时直接返回 `added=0/removed=0`，不重复调用 AI、不写盘；`applySkeletonToMindMap` 内部再做一次节点集合与文本比对，作为无 `sync` 标记老文件的兜底。
7. 没有新增也没有删除时不写地图文件；失败只返回 warning，不改动原地图。

注意：`shared/api.ts` 的 `mergeDigestPointsIntoMindMap` 保留为 PD44 的旧纯函数（追加语义）与单测锚点，新同步路径不再使用它。

## 3. AI 结构化骨架

### 3.1 输入与输出

`generateItemSkeleton(itemId, { markdown?, title?, points?, useAi? }) → Promise<{ mode, nodes, warnings }>`

- `nodes`：`{ id, parentId, text, level: 1 | 2 | 3, topicPath }[]`，包含根节点。
- 约束：根 → 主题 → 要点三层；节点总数 8–40（材料不足时少给，并给 warning）；单节点 ≤ 80 字；禁止 Markdown 记号与省略号。
- `opts.useAi=false` 时直接走规则骨架（用于离线或用户关闭 AI）。
- `mode='ai'` 只在 AI 返回合法且节点数 ≥ 8 时成立，否则 `mode='rule'`。

### 3.2 AI 约定

- prompt 要求严格 JSON：`{"topics":[{"title":"主题","points":["要点A","要点B"]}]}`。
- 只允许使用提供的拆解材料；不得编造观点、数据、方法或引用。
- 主题 2–8 个、每个主题 1–6 条要点；文本自动清洗 Markdown 与省略号。
- 模型返回的节点 id 一律忽略，按 `topicPath` 重算（FNV-1a），因此相同输入两次生成的 id 一致，便于幂等与 diff。

### 3.3 规则骨架

- 优先按拆解 Markdown 的 `##` / `###` 标题分组；主题不足 2 个时，退化为按要点类型分组（概念与背景 / 方法与设计 / 结果与结论 / 数据与样本 / 指标与评测 / 主要观点 / 问题与局限）。
- 文本清洗：去代码围栏、链接语法、强调符、标题符、列表符、省略号；折叠空白；截断到 80 字时**不补省略号**。
- 上限：8 个主题、每个主题 8 条要点、总节点 40。

### 3.4 回退与提示

| 情况 | 行为 | warning（界面提示） |
| --- | --- | --- |
| 未配置模型 / 网络失败 / HTTP 错误 | 规则骨架 | `AI 骨架不可用（<可读原因>），已回退到规则骨架` |
| AI 返回非法 JSON 或节点不足 8 | 规则骨架 | `AI 返回的骨架结构不完整，已回退到规则骨架` |
| 拆解材料为空 | 最小规则骨架 | `拆解材料为空，已生成最小规则骨架；请先在「论文拆解」里生成要点` |
| 用户关闭 AI（`useAi=false`） | 规则骨架 | `已关闭 AI 骨架，按拆解结构生成规则骨架` |

任何 AI 异常都被捕获，不向 IPC/UI 抛未捕获异常；失败时地图文件不改动。

## 4. AI 工具注册表

`src/main/services/mindmap-ai-tools.ts` 是唯一注册点，所有入口必须经 `runMindmapAiTool(id, input, complete)`，不允许各调用点自己拼 prompt。注册表不 import `llm`，由调用方注入 `complete`，因此可在无 Electron、无 API Key 的单测中直接覆盖。

| 动作 id | 用途 | prompt / 解析 | guard |
| --- | --- | --- | --- |
| `map-skeleton` | AI 结构化骨架 | `buildSkeletonPrompt` / `parseSkeletonAiResult` | 拆解材料不能为空 |
| `node-summarize` | 节点摘要 | `buildSummaryPrompt` / `parseSummaryResult` | 必须有节点上下文 |
| `node-optimize` | 「AI 优化」：精简措辞、补 1–3 个有依据的子节点、合并重复子节点（同时兼容旧 `topics`） | `buildOptimizePrompt` / `parseOptimizeResult` | 必须有节点上下文 |
| `node-expand` | 展开 2–4 个子节点 | `buildExpandPrompt` / `parseExpansionResult` | 必须有节点上下文 |
| `node-support` | 找支撑段落并给点锚点 | `buildSupportPrompt` / `parseSupportResult` | 必须有节点且至少一段原文 |

`shared/ai-tools.ts` 增加 5 条细粒度条目（`mindmap-skeleton` / `mindmap-summarize` / `mindmap-optimize` / `mindmap-expand` / `mindmap-support`），分类均为 `mindmap`、`requires: ['model']`；旧 `mindmap-ai` 作为总开关与兼容 id 保留。

执行顺序固定：`guard → promptBuilder（只调用一次）→ complete → 空内容检查 → parse`。parser 抛出 `MindmapAiError` 时由调用点转为可读提示或回退。

### 4.1 「AI 优化」动作（PD57）

工具栏入口文案为「AI 优化」，`data-testid="mindmap-ai-optimize"`；旧 `data-testid="mindmap-ai-expand"` 作为兼容别名保留（同一点击行为、同样反映禁用状态，视觉上不占位）。

- 一次返回 `{ summary?, children?, mergedIds?, rationale?, topics? }`，允许三类调整：`summary` 精简节点措辞；`children` 补 1–3 个材料里有依据的子节点；`mergedIds` 合并重复子节点。
- prompt 仍要求只依据材料、不引入外部知识、返回严格 JSON、每个改动给理由（`rationale`）；解析失败抛可读中文错误，地图保持不变。
- 渲染层用 `features/mindmap/mindmap-optimize.ts` 的 `buildOptimizePreview` 把结果映射成差异预览：原文 vs 建议，逐项勾选；`applyOptimizePreview` 只应用勾选项（最多补 3 个子节点，合并只处理无子节点的重复项，文本相似度阈值 `0.78`）。
- 预览期间不改地图；点「应用所选」后才改图，并写入整图撤销快照（标签「AI 优化」）；点「丢弃」清空预览，地图保持原样。
- 模型服务未配置时入口直接禁用，标题给出「尚未配置模型服务：到 设置 → 模型服务 填写 Base URL、API Key 与模型 ID 后重试」；AI 工具库关闭思维地图 AI 时提示「已在 AI 工具库关闭思维地图 AI」。

## 5. 点锚点定位

`findSupport` 返回值在原有 `{ found, page, quote, reason }` 基础上增加：

```ts
anchor: {
  page: number
  quoteStart: number // 引文首字在 chunk 原文中的 UTF-16 下标
  quoteEnd: number   // 引文末字下标（含）
  rect: [number, number, number, number] | null
  moduleId: string | null
} | null
```

- `quoteStart/quoteEnd` 在 `chunks.text` 原文上匹配得到，忽略空白与引号差异，可在同一 chunk 上复现。
- `rect` 来自 `chunks.bbox`（JSON 数字数组），bbox 为 NULL 或损坏时为 `null`，不猜测坐标。
- `moduleId` 来自 `chunks.module_id`，没有则为 `null`。
- 纯函数 `locateAnchor(text, quote, chunk)` 与 `locateQuoteSpan(text, quote)` 由 `shared/mindmap-anchor.ts` 提供；`findSupport` 只做组装，不在匹配逻辑里做第二套实现。
- 节点持久化 `anchor` 后，可再次用 chunk 文本校验同一区间（`anchorQuote`），不依赖 AI 重跑。
- `ipc/mindmap.ts::validateDoc` 与渲染端 `normalizeMindMap` 都白名单透传 `anchor` 与 `provenance`，保存/加载不丢字段。

## 6. 失败与可撤销

- AI 结果写入地图后仍走原有 `undo` 机制；同步删除只针对同步节点，用户节点不受影响。
- 所有失败文案为中文，包含「回退 / 未找到 / 未配置 / 请稍后重试」等可操作信息。
- 任何 AI 动作都不发布知识库条目、不修改正式数据、不写设置。

## 7. 节点全文显示与去 Markdown（PD57）

### 7.1 全文显示

- 节点文本不再用 `nowrap + ellipsis` 或 `-webkit-line-clamp` 截断：`.mindmap__node` 为 `min-width: 160px; max-width: 420px`，`.mindmap__node-text` 为 `white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word`。
- 节点宽高由 `shared/mindmap-ai.ts` 的 `measureMindmapNode` 按字符宽度估算（中文 1 字宽、西文约 0.55 字宽，行高 17px，最小高 46px），渲染端与聚合地图共用同一函数；自动布局（新增/改名/骨架/同步）按测量宽高放列堆叠，父子重叠时只右移后放置的节点，老地图载入不重排。
- `cleanNodeText` 不再追加省略号，只保留 120 字硬上限；导出同样不再截断出省略号。

### 7.2 `stripMarkdownForMap` 规则

渲染节点正文、`title`、Markdown 大纲与 Mermaid 导出统一调用 `stripMarkdownForMap`，保证所见即所得：

| 写法 | 结果 |
| --- | --- |
| `**粗体**`、`__粗体__` | 粗体 |
| `*斜体*`、`_斜体_` | 斜体 |
| `` `代码` `` | 代码 |
| `# 标题` / `## 标题` | 标题 |
| `- 列表` / `* 列表` / `+ 列表` | · 列表 |
| `1. 列表` / `1、列表` | · 列表 |
| `> 引用` | 引用 |
| `[文本](链接)` | 文本 |
| `![替代](图片)` | 替代 |
| `~~删除线~~` | 删除线 |
| `---` / `***` 水平线 | 删除该行 |
| `\| 表格 \|` | 去掉竖线，保留单元格文字 |
| `- [ ] 任务` / `- [x] 任务` | · 任务 |

解析顺序为：图片 → 链接 → 标题 → 引用 → 水平线 → 任务列表 → 无序/有序列表（换行保留）→ 行内代码 → 粗体 → 斜体 → 删除线 → 表格竖线；不使用正则替换 HTML，始终输出纯文本。

## 8. 针对性验证

```bash
npm run typecheck
npm run test:unit
```

PD55 单测覆盖：锚点句首/句中/句尾/跨句/找不到、bbox 为 NULL、序列化往返、规则骨架三层与 8–40/≤80/无 Markdown、稳定 id、AI 合法 JSON 与非法 JSON 回退、覆盖同步 A→B、同内容 0/0 幂等、改名节点保留并计入 `kept`、老文件节点保留、注册表 5 动作与旧总开关、support anchor 可复现。

完整回归（`test:coords` / `build` / `e2e` / `check-isolation`）由 verifier 执行。
