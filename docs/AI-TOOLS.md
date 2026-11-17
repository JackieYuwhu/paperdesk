# AI 工具库

用户提出：「凡是涉及 AI 的功能都应该提供 skill/工具，可创建工具库按类别与权限管理，分类便于查找。」

PD54 把散落在问答、联网检索、论文拆解、拆解同步、思维地图、批处理同步里的 AI 能力集中成一份**工具清单**：
每个能力都有名字、分类、说明、入口提示、所需能力（权限）与开关。清单是纯数据 + 纯函数
（`src/shared/ai-tools.ts`），主进程负责持久化与 IPC，渲染层只做展示与门控。

注意：这里的「工具库」是**能力清单 + 权限开关**，与 `src/main/services/skills.ts` 的「翻译技能（prompt）」
是两件事，后者语义未改动。

## 工具清单

| id | 名称 | 分类 | 所需能力 | 入口 |
| --- | --- | --- | --- | --- |
| `ai-chat` | AI 问答 | 阅读 | 调用模型 | 阅读 → 问答 |
| `paper-digest` | 论文拆解 | 阅读 | 调用模型 | 阅读 → 拆解论文 |
| `web-search` | 联网检索 | 检索 | 联网 | 问答里的「联网」开关 |
| `digest-sync` | 拆解同步 | 知识库 | 写入知识库 | 拆解论文 → 写入知识库 / 思维地图；批处理 → 同步 |
| `batch-sync` | 批处理同步 | 知识库 | 写入知识库 | 数据 → 批处理 → 作业卡片同步 |
| `mindmap-ai` | 思维地图 AI | 思维地图 | 调用模型 | 思维地图 → AI 摘要 / 展开 / 补充论点 |

## 分类含义

| 分类 | 含义 |
| --- | --- |
| `reading`（阅读） | 面向单篇文献的阅读与理解能力 |
| `translation`（翻译） | 翻译相关能力；当前暂无工具，分类 tab 显示 0（保留占位） |
| `knowledge`（知识库） | 把结果写进知识库 / 暂存区的能力 |
| `mindmap`（思维地图） | 思维地图内的 AI 能力 |
| `search`（检索） | 外部联网检索 |

## 权限含义

| 权限 | 含义 | 生效位置 |
| --- | --- | --- |
| `model`（调用模型） | 该工具会调用大模型 | 工具卡勾选；关闭后工具按「启用但缺权限」处理 |
| `network`（联网） | 该工具会发出外部网络请求 | `web-search`：问答的 `ai-web-toggle` 禁用并提示「已在 AI 工具库关闭联网检索」 |
| `write-knowledge`（写入知识库） | 该工具会写知识库 / 暂存区 | `digest-sync`：批处理的 `batch-sync-knowledge`、拆解面板的 `digest-to-knowledge` / `digest-to-mindmap` 禁用并提示原因 |

判定逻辑只有一条：`isToolUsable(state, need) = state.enabled && state.permissions[need] !== false`。
「入口禁用 + 可读原因」由 `aiToolBlockReason(states, gates)` 统一生成，文案形如：

- 关闭开关：`已在 AI 工具库关闭联网检索`
- 关闭权限：`已在 AI 工具库关闭拆解同步的「写入知识库」权限`

渲染层在 title 后追加「：到 设置 → AI 工具库 重新打开（或恢复默认）」，并把按钮 `disabled`，
点击事件里也直接 return（双击/快捷键也不会绕过）。**不会静默失败，也不会把入口藏起来。**

三处真实生效（都有 e2e 断言，关闭 → 禁用且带 title，重新打开 → 立即恢复，无需重启）：

1. `src/renderer/src/features/ai/AiPanel.tsx`：`web-search` 关闭或 `network` 关闭 → `ai-web-toggle` 禁用；
   同时问答发送路径强制 `web=false`，即使设置里开着联网也不会真的联网。
2. `src/renderer/src/features/batch/BatchPanel.tsx` 与
   `src/renderer/src/features/analysis/PaperAnalysisPanel.tsx`：`digest-sync` 关闭或 `write-knowledge` 关闭 →
   同步入口禁用；知识库同步按 `write-knowledge` 判定，思维地图同步按开关判定。
3. `src/renderer/src/features/mindmap/MindMapPanel.tsx`：`mindmap-ai` 关闭 → 摘要 / 展开 / 补充论点三个按钮禁用。

权限只管**入口可用性**；实际是否联网仍由「设置 → 联网检索」决定，两者都要满足才会真正联网。

## 界面

设置 → AI 工具库（`data-testid="settings-section-ai-tools"`，面板 `ai-tools-panel`）：

- 顶部按分类切换：`ai-tools-category-all|reading|translation|knowledge|mindmap|search`，tab 上带该分类工具数。
- 右侧关键词搜索 `ai-tools-search`，匹配工具名称或说明；清空恢复全部。
- 每个工具一张卡 `ai-tool-<id>`：名称、说明、分类徽章、所需能力徽章、启用开关 `ai-tool-toggle-<id>`、
  权限勾选 `ai-tool-perm-<id>-<permission>`。
- 过滤后无结果：`ai-tools-empty`，内有「清除筛选」按钮 `ai-tools-clear-filters`（分类回「全部」、清空关键词）。
- 底部「恢复默认（全部启用）」`ai-tools-reset`。
- 开关与勾选**即改即存**，没有保存按钮；保存后主进程广播，所有窗口（含思维地图独立窗口）即时刷新。

## 配置文件

路径：数据目录下 `ai-tools.json`（`getDataDir()`，默认 `app.getPath('userData')`，可用环境变量
`PAPERDESK_DATA` 覆盖）。主进程独占读写，渲染层只通过 IPC 访问。

```json
{
  "schemaVersion": 1,
  "tools": {
    "web-search": { "enabled": false },
    "digest-sync": { "permissions": { "write-knowledge": false } }
  }
}
```

- **只记录偏离默认的项**：缺省即「启用 + 权限全开」，全开时 `tools` 为空对象 `{}`。
- 未知 id、未知权限名、非布尔值在读取时忽略 / 回退默认；写入时校验并抛出可读中文错误。
- 原子写：先写 `<file>.<pid>.tmp` 再 `rename`，避免半截文件。
- 文件缺失 → 用默认值（不报错）；文件损坏 / 版本不受支持 → 回退默认并在设置面板顶部显示中文 warning
  （`ai-tools-warning`），不会因此让 AI 功能整体不可用。

## IPC

| 通道 | 说明 |
| --- | --- |
| `aiTools:list` | 返回 `{ tools, warnings }` |
| `aiTools:update` | 入参 `{ id, enabled?, permissions? }`；非法 id / 权限名返回可读中文错误 |
| `aiTools:reset` | 恢复默认（等价删除覆盖项） |
| 事件 `aiTools:changed` | `update` / `reset` 后广播 `{ tools, warnings }`，各窗口据此即时门控 |

## 边界

AI 仍然**没有发布通道**：工具库只控制「可用性 + 权限」，不能批准、发布或跳过人工审核。
暂存区的一键批准、知识库发布都不在 AI 工具库的管理范围内，也不会被 AI 自己触发。
