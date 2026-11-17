# PaperDesk 知识库与 AI 工作流：阶段 0 现状核查与落地方案

> 任务：PD32（阶段 0）。本文件只做核查与设计，**不改业务代码**。
> 核查基线：`c8aa89c`（PD30 已合并；`docs/CODE-MAP.md` 上次核对停在 PD29）。
> 核查日期：2026-11-03。行号是本次阅读源码时的实际行号；实现落地后行号会漂移，请以函数名/表名定位。
> 设计输入：《PaperDesk 知识库、暂存审核与可配置 AI 工作流实施说明》第 1、2、3、6、8、11、14、15 节。

---

## 0. 结论摘要（实施说明 §3 五问）

| # | 关注点 | 现状结论 | 关键证据 |
|---|---|---|---|
| ① | FTS5 中文分词现状 | **不可用于中文子串/词组召回**：四张 FTS 表全部 `tokenize='unicode61'`，连续汉字（含整句）被当成一个 token；查询只按空白切词、每词加引号做前缀匹配并 `AND` 连接，因此只能命中「以查询词开头」的超长 token，句中词、词序变化、同义说法都查不到。地图/问答因此另写 `LIKE` 兜底。 | `src/main/db/schema.sql:242-246,260-262,275-277,280-282`；`src/main/services/search.ts:6-13`；`src/main/services/mindmap.ts:127-158` |
| ② | 范围过滤是否进 SQL | **没有**。词法检索先按全局 `LIMIT` 取回，再在 JS 里按 `attachmentId` 过滤（`searchHybrid`），因此目标论文的命中可能已被别篇挤掉；单篇/分组问答同样先全库检索再后置过滤。只有语义检索把附件条件写进了 SQL。 | `src/main/services/search.ts:201-205`；`src/main/services/ai.ts:185-194,331-335`；对照 `src/main/services/embed.ts:98-106` |
| ③ | 检索块与原文模块的关联 | **没有入库，只在检索后启发式反查**。`chunks` 只有 `attachment_id/page_index/section/bbox/text`，且抽取时 `section/bbox` 恒写 `NULL`，没有 `module_id`、字符偏移、内容哈希；命中后再用同页 40 字符窗口与模块文本比对（score≥24 才认），不可靠时返回空，`Citation.moduleId` 因此是可选的。 | `src/main/db/schema.sql:162-169`；`src/main/services/extract.ts:298-310`；`src/shared/modules.ts:159-197`；`src/main/services/ai.ts:250-269`；`src/shared/types.ts:484-496` |
| ④ | 原文/译文/笔记/AI 内容的来源区分 | **分散在四类表、没有统一来源模型**。原文=`chunks.text`；译文=`translations`（文件路径 + `lang`）；笔记=`notes.body`（Markdown 文件 + FTS）；AI 产出没有独立表——问答引用塞在 `ai_messages.citations_json`，分析结果以 `<!-- paperdesk:… -->` 小节归档进笔记。`SearchHitKind` 只有 `item/note/chunk/translation` 四类，没有 `sourceType/contentHash`，无法可靠去重或标注「这是 AI 建议」。 | `src/main/db/schema.sql:93-101,162-169,186-202,308-316`；`src/shared/types.ts:469-482`；`src/main/services/notes.ts:232-247`；`src/main/services/batch/registry.ts:444-480` |
| ⑤ | 无向量时链路是否完整 | **能跑通但语义是假的**。无嵌入时 `searchHybrid` 会回退 `lexical(no-index)`，单篇问答仍可用；但默认配置是 `embed.mode='local'` → `local-hash-64` 哈希向量，且 Python 侧分词正则是 `[a-z0-9]+`，纯中文文本没有 token、向量退化成 `vec[0]=1.0`，所有中文块向量完全相同。这属于实施说明 §2.2 明令禁止的「哈希/模拟向量当语义检索」。 | `src/main/services/search.ts:209-215`；`src/main/services/embed.ts:125-135`；`src/main/services/settings.ts:245-274`；`python/app/embed.py:15-30,56-71` |

一句话结论：**知识库必须自建词法检索层（中文 bigram 索引 + 范围条件进 SQL + 证据关联入库），不能复用现有 `unicode61` FTS 与默认哈希向量；AI 侧只允许写提案，发布由用户在 UI 触发的程序流程执行。**

---

## 1. 核查范围与方法

- 阅读了主进程 `src/main/db/*`、`services/*`、`ipc/*`、`modules/index.ts`，共享层 `src/shared/*`，预加载 `src/preload/index.ts`，渲染层 `src/renderer/src/{App.tsx,modules/registry.tsx,features/settings/SettingsDialog.tsx}`，脚本 `scripts/test-unit.ts`，文档 `docs/CODE-MAP.md`、`docs/EXTENDING.md`，以及 `python/app/embed.py`、`python/app/main.py` 的嵌入路由。
- **未执行**：没有启动 Electron/GUI、没有运行 `SELECT sqlite_version()`（本角色不加载原生模块）。SQLite 版本依据构建依赖 `node_modules/better-sqlite3/deps/sqlite3/sqlite3.h:149` 的 `#define SQLITE_VERSION "3.53.4"` 判定；trigram 分词器自 3.34 起可用，但**运行时可用性仍需实现工程师用 `SELECT sqlite_version()` 与一次建表验证**（见 §10 风险 R1）。
- 本文件不做全量回归；`typecheck / test:unit / test:coords / build / check-isolation` 的结果记录在本次任务证据中（本任务只改文档，预期全绿）。

---

## 2. 五问逐条核查

### 2.1 FTS5 中文分词现状

**事实链**

1. 四张 FTS5 表全部使用默认 `unicode61`：`items_fts(title, abstract)`（`schema.sql:242-246`，tokenize 在 245）、`chunks_fts(text)`（`schema.sql:260-262`，261）、`notes_fts(title, body)`（`schema.sql:275-277`，276）、`translations_fts(title, body)`（`schema.sql:280-282`，281）。`unicode61` 把字母/数字类字符都算 token 字符，汉字属于字母类，所以**一段没有空格的中文（甚至整句、整段）就是一个 token**。
2. 查询构造只做「按空白切词 → 去特殊字符 → 每词 `"词"*` → `AND`」：`search.ts:6-13`，`join(' AND ')` 在第 12 行。它既没有中文分词，也没有同义词/别名扩展（实施说明要求同义扩展用 OR，不能把同义词塞进 AND）。
3. 四条查询分别是 `WHERE items_fts MATCH ? ORDER BY score LIMIT ?`（`search.ts:40`）、`chunks_fts`（71）、`notes_fts`（99）、`translations_fts`（127）；四个来源都绑定同一个 `limit`（42/73/101/128），最后统一排序再 `slice(0, limit)`（147-148）。
4. 每条查询都包在 `try/catch` 里静默跳过（`search.ts:55-57,86-88,114-116,143-145`）：FTS 语法错误、表缺失都表现为「这一类没有结果」，调用方无法区分「没命中」与「检索坏了」。
5. 因为中文查不到，思维地图只能另写兜底：`likeKeywords` 把 CJK 长 token 截首尾 4 字（`mindmap.ts:127-142`），`likePassages` 用 `LIKE '%…%'` 全表扫（144-158），`passagesForItem` 串起 `searchHybrid → LIKE → 正文首块`（174-187）。

**后果（按严重度）**

- 用户输入「知识库」在正文「…构建知识库管理系统…」中**完全查不到**（token 是整句，查询词不是 token 前缀）。
- 输入整句只会做前缀匹配，且必须与原文 token 前缀逐字一致。
- 多词查询是 AND，任一中文词失败即整条失败；同义词、繁简、全半角都不处理。
- `bm25` 排序只对 `items.title/abstract` 这类短字段有效；正文块召回失败时排序无从谈起。

**结论**：知识库不能复用 `items_fts/chunks_fts/notes_fts/translations_fts` 的写法。新表必须使用**应用层中文 bigram 分词 + 索引列存 token 串**，查询端用**相邻 bigram 短语**还原子串语义（见 §6）。trigram 可作为备选（SQLite ≥3.34），但其对 1–2 字查询、索引体积和 `LIKE` 优化的行为需实测，不作为阶段 1 的唯一依赖。

### 2.2 范围过滤是否进 SQL

**事实链**

1. `search(raw, limit)` 没有 `itemId/attachmentId/groupId` 参数（`search.ts:25`），四条 SQL 也没有范围条件；`searchHybrid` 先 `search(query, limit*2)`（201），再对结果 `filter(h => h.kind === 'chunk' && h.attachmentId === opts.attachmentId)`（203-205）。**过滤发生在 LIMIT 之后**：若前 `2*limit` 条都是别的论文，目标论文一条不剩。
2. 单篇问答 `retrieve` 同样如此：`searchHybrid(..., {attachmentId, limit: limit*2})` 后又在 JS 里 `filter` 一次再 `slice`（`ai.ts:185-194`）。
3. 分组问答 `retrieveGroup` 先全库 `searchHybrid(question, {limit: 80})`，再按 `paperIds` 后置过滤（`ai.ts:320-358`，过滤在 331-335）。分组越大、越冷门，目标论文越容易被挤出前 80。
4. 对照：语义检索把附件条件写进了 SQL——`semanticSearch` 在 `WHERE` 里拼 `attachment_id = ?`（`embed.ts:92-122`，过滤在 98-106）。这证明「进 SQL」在本项目可行，只是词法链路没做。

**结论**：知识库检索一律**先范围、后排序、再 LIMIT**，范围条件必须以参数化 SQL 片段进入 `WHERE`；禁止在结果集上后置过滤。阶段 1 只在新 `knowledge-search` 里实现；对既有 `search()/searchHybrid` 的改造列为阶段 2（见 §10 D1），避免本批次扩大改动面。

### 2.3 检索块与原文模块的关联

**事实链**

1. `chunks` 表只有 `attachment_id/page_index/section/bbox/text`（`schema.sql:162-169`），没有 `module_id`、`char_start/char_end`、`content_hash`。
2. 抽取写入时显式把 `section/bbox` 写成 `NULL`：`INSERT INTO chunks(attachment_id,page_index,section,bbox,text) VALUES(?,?,NULL,NULL,?)`（`extract.ts:305`，上下文 298-310），所以即使列存在也没有值。
3. 模块信息另存整篇 JSON：`paper_modules.doc_json`（`schema.sql:286-297`），模块 id/rect 只在 JSON 内部。
4. 关联是检索后的启发式：`matchChunkToModules` 要求同页、在 chunk 文本上取 40 字符窗口到模块文本里找、`score >= 24` 才认，并按栏/阅读顺序排序，**不可靠时返回 `[]`**（`shared/modules.ts:159-188`，返回空在 183）；`matchChunkToModule` 只取第一个（191-197）。
5. 使用点在 `services/ai.ts::retrieve`：chunk 命中后逐条反查模块，`moduleId` 可选（250-269）。`Citation.moduleId/moduleKind/rect` 在类型上都是可选（`shared/types.ts:484-496`）。

**结论**：现阶段「检索块 → 原文模块」不是数据关系，而是每次查询现算的猜测。知识库要求引用可复核，必须把证据落库：`evidence_links` 保存 `attachment_id/page_index/module_id/rect/char_start/char_end/quote/content_hash`，并优先在**写入时**用模块 JSON 解析出的证据区间固化；解析不到就只存页级证据并标 `precision='page'`，不得伪造成模块级。历史 `chunks` 的 `module_id` 回填列为阶段 2（`matchChunkToModules` 尽力回填、允许为空，UI 显示「页级证据」）。

### 2.4 原文/译文/笔记/AI 内容的来源区分

**事实链**

1. 原文块：`chunks.text`（`schema.sql:162-169`），按附件/页存，无来源字段（它默认就是 PDF 原文）。
2. 译文：`translations` 表有 `attachment_id/lang/path/md_path/...`（`schema.sql:186-202`），正文实际在 Markdown 文件里，检索时由应用层写入 `translations_fts`（`schema.sql:279-282` 注释说明）。
3. 笔记：`notes(id,item_id,title,body)`（`schema.sql:93-101`），正文也是 Markdown 文件，保存后 `reindexNote` 同步 `notes_fts`（`notes.ts:249-256`）。
4. AI 内容：`ai_messages.citations_json` 存引用（`schema.sql:308-316`，313）；论文拆解结果写成 `.analysis.md`，`archiveNote!=='0'` 时以 `<!-- paperdesk:标题 -->` 小节并入条目笔记（`batch/registry.ts:444-480`，归档在 465-473；标记逻辑 `notes.ts:232-247`，标记在 233-235）。
5. 检索结果类型只有四类：`SearchHitKind = 'item' | 'note' | 'chunk' | 'translation'`（`shared/types.ts:469`），`SearchHit` 没有 `sourceType/contentHash`（471-482）。

**结论**：现有模型无法回答「这句话是作者原文、译者译文、我的笔记，还是 AI 建议」。知识库必须新增统一的 `source_type + source_ref(JSON) + content_hash`，且 `content_nature`（用户决定/作者论断/AI 建议）单独成列；同一段文字从原文与译文各命中一次时，靠 `(attachment_id, lang, content_hash)` 去重并保留两条 `evidence_links`。不得把 AI 产出继续混进笔记正文当作唯一来源（笔记仍可作为证据来源之一，但要有 `source_type='note'`）。

### 2.5 无向量时链路是否完整

**事实链**

1. 无嵌入时 `semanticSearchQuery` 返回 `[]`（`embed.ts:125-135`，返回在 130）；`searchHybrid` 见 `sem.length===0` 直接返回 `lexical(no-index)`（`search.ts:215`）。所以「没有向量」不会让问答崩掉。
2. 但默认配置不是「关掉向量」：`embedConfig` 默认 `mode='local'` → `backend='mock'`、`model='local-hash-64'`（`settings.ts:245-274`，赋值在 270/273）；provider 未配置时也回退哈希（260-271）；只有 `embed.mode='off'` 才 `backend='none'`（257-259）。
3. 哈希实现：`DIM=64`、`TOKEN_RE=[a-z0-9]+`、`md5(token)` 组成向量并 L2 归一化（`python/app/embed.py:15-30`）；**纯中文文本没有 `[a-z0-9]+` token，norm=0 时直接把 `vec[0]=1.0`**（26-29），于是所有中文块向量相同。`embed_texts` 对 local/mock 返回 `model='local-hash-64'`（56-71），未知后端也回退 local（82-88）。
4. `embeddingsAvailable` 只看索引里有没有行（`embed.ts:84-89`），不校验模型是否真语义；索引一旦跑过 mock，hybrid 就会把哈希相似度当语义分参与 RRF（K=60，`search.ts:226`）。

**结论**：链路「不崩」但「语义不可信」。知识库阶段 1 必须**显式声明词法模式**：`embed.mode` 为 `off` 或新增 `lexical` 语义时，检索结果 `mode` 标注 `lexical`、UI 显示「词法检索（无向量）」；`local-hash-64` 不得标记为 semantic、不得参与排序或 RRF。知识库检索本身**不读 chunk_embeddings**，无向量不影响功能完整（搜索/证据/提案/发布均可用）；将来接真正的嵌入服务时只作为可选重排，且必须在 UI 标明模型与模式。

### 2.6 其他影响设计的事实

| 事实 | 证据 | 对设计的影响 |
|---|---|---|
| 主模型调用只有文本 `/chat/completions`，无 tools/function-calling、无图片消息 | `services/llm.ts:48-80`（URL 60、messages 70-73）、`98-142`（`generateStrict` 无 mock） | AI 工具适配层只能用「提示词 + 结构化 JSON + 主进程强校验」，不能依赖模型原生 tool calling；不得假设模型能读图 |
| provider 配置唯一来源是 `provider.mode/baseUrl/apiKey/chatModel/embedModel/mtModel` | `settings.ts:164-192`（读取 164-187、`resolve` 189-192） | 知识库不新增密钥/模型 ID；提案只记录非敏感 `ai_config_ref` |
| 公开设置把 Key 变成布尔 | `settings.ts:276-336`（`apiKeySet` 281）；导出不含 Key（349-361） | 提案/日志/测试断言禁止出现明文 Key；状态接口只能返回布尔 |
| 初始化顺序：`initDb` → `migrate` → `registerAllModules` | `db/index.ts:19-30`（exec 25、migrate 26）；`main/index.ts:204-217`（initDb 207、registerAllModules 215） | 新表由 `schema.sql` 的 `IF NOT EXISTS` 自动补建；`migrateKnowledge()` 必须在 `initDb` 内、模块注册前完成 |
| 迁移只有 `ALTER TABLE ADD COLUMN`，无版本表/事务 | `migrate.ts:20-50,58-73`（表不存在跳过 63-66、失败只 warn 69-71） | 新增数据回填/建 FTS 需要独立的幂等 `migrateKnowledge()`（见 §7） |
| 主进程模块注册表 21 项，退出统一 `onShutdown` | `modules/index.ts:46-86` | 新 knowledge 模块需登记并在 `onShutdown` 清理（关 DB 前） |
| IPC 通道按命名空间集中声明，preload 逐命名空间镜像 | `shared/channels.ts:2-236`（search 131-134、ai 135-151、settings 152-162）；`preload/index.ts:58-66,165-173` | 新增 `CH.knowledge.*`、`EVT.knowledgeChanged`，同步 api/preload |
| 渲染面板由 `PANELS` 注册，`App.tsx` 只做标题/分组/覆盖层接线 | `renderer/src/modules/registry.tsx:103-117,119`；`App.tsx:897,910-917,1227-1255` | 知识库/暂存区作为两个 panel 注册；不必改 `App.tsx` 的渲染主循环 |
| 设置页知识库区块还是「仅占位、尚不可用」 | `features/settings/SettingsDialog.tsx:154,507-510,1212-1227` | PD31 文案与入口需随阶段 1 更新，但保留占位纯函数的单测 |

---

## 3. 建模原则（四个维度必须分开）

实施说明 §6.2/§14 要求以下四件事**分别存储**，不能揉成一个 `type` 或一个 `status`：

1. **知识类型 `kind`**：这条知识是什么（paper/concept/method/dataset/metric/claim/note/decision/question）。用于分类与展示。
2. **内容性质 `content_nature`**：这条内容的认知来源——`user_decision`（用户决定）、`user_hypothesis`（用户假设）、`author_claim`（作者论断）、`observation`（观察/实验）、`ai_inference`（AI 推断）、`ai_suggestion`（AI 建议）。**决定这条内容能不能当作事实引用**，只能由内容产生方在创建时标注，后续不可被审核动作改写。
3. **审核状态 `review_status`**：提案在暂存区的工作流位置——`draft/checking/pending_review/needs_edit/rejected/published/withdrawn`。它描述**提案**，不描述知识本身。
4. **来源类型 `source_type` + `source_ref`**：这段内容从哪来——`paper/translation/note/annotation/conversation/user/ai`，`source_ref` 存对应主键（JSON），再配 `content_hash` 做去重与版本比对。

**为什么内容性质与审核状态必须分列**

- 一条 `ai_suggestion` 被用户「接受」后，性质仍然是 AI 建议（可追溯、可批量撤销），审核状态才变成 `published`。若只存一个 `status='accepted'`，接受动作会把「这是 AI 说的」覆盖成「已接受」，provenance 永久丢失——正是实施说明 §6.2 要避免的。
- 同一条目的两次修改可能来自不同性质（用户决定 vs AI 建议），分列后 `knowledge_versions` 能保留每次变更的性质；合并成一列则后写覆盖前写。
- 审核状态是**可变的流程状态**（拒绝后可重开），内容性质是**不可变的语义标签**；两者生命周期不同，放同一列必然产生非法组合（如「已拒绝的 AI 建议」与「已发布的 AI 建议」在单列里无法共存）。

---

## 4. 复用 vs 新增清单

### 4.1 数据表

| 表 | 决策 | 现有对应物 | 理由 |
|---|---|---|---|
| `knowledge_entries` | **新增** | `items`（书目）、`notes`（Markdown 正文）、`ai_messages`（对话） | 现有三表分别是「论文元数据」「自由笔记」「对话消息」，都无法承载带 `kind/content_nature/source/version` 的结构化知识条目；`items` 一篇论文一行，不能存多条知识 |
| `knowledge_relations` | **新增** | `citations`/`citation_contexts`（书目引用） | 引用关系是「论文引论文」，知识关系是「论断支持/反驳/派生自」，语义与主体都不同 |
| `evidence_links` | **新增** | `citation_contexts`（`schema.sql:152-159`，citation_id+attachment+page+rect+text） | 形状接近，但它绑定 `citation_id` 且只服务引文；知识证据需要 `entry_id/module_id/char offsets/content_hash`，且要支持笔记/译文/对话来源。阶段 1 不迁移 `citation_contexts`，避免动既有引文功能 |
| `knowledge_versions` | **新增** | 无（`translations.pinned/status` 不是版本历史；`paper_modules` 是解析缓存） | 发布要可审计、可回滚，必须有逐版本快照 |
| `proposal_batches` | **新增** | `batch_jobs`/`batch_items`（`schema.sql:206-232`） | `batch_jobs` 是「执行队列」（翻译/拆解），状态是 queued/running；暂存批次是「待审内容分组」，状态是 draft/ready/published。可加 `source_batch_job_id` 溯源，**不复用为审核状态机** |
| `knowledge_proposals` | **新增** | `batch_items`（只有 item_id/status/output/message） | 提案需要 `op/target/base_version/patch/reason/checks/idempotency`，`batch_items` 承载不了；且提案必须能脱离批处理单独存在 |
| `proposal_reviews` | **新增** | 无 | 审核动作要留痕（谁、何时、接受/拒绝/编辑后接受、理由），不能只改提案状态 |
| `knowledge_fts` | **新增** | `items_fts/chunks_fts/notes_fts/translations_fts`（`schema.sql:242-282`） | 可以复用「外部内容表 + 触发器」的形态，**不能复用 `unicode61` 分词与查询构造**（见 §2.1、§6） |

> 备注：实施说明 §14 还提到 `term_aliases`、工作流/技能配置等；它们属于阶段 3，不在本批次 7 张表内。阶段 1 的查询构造预留 `aliases` 参数（空数组即不扩展），不建表。

### 4.2 服务层

| 模块 | 决策 | 位置 | 说明 |
|---|---|---|---|
| 中文分词/查询构造 | **新增纯函数** | `src/shared/cjk.ts`、`src/shared/knowledge-query.ts` | 可被 `scripts/test-unit.ts` 直接导入；不依赖 electron/db |
| 提案校验/发布计划 | **新增纯函数** | `src/shared/knowledge-proposal.ts` | 校验 op/字段/版本/范围；输出可测试的 `PublishPlan` |
| 知识条目/证据读写 | **新增服务** | `src/main/services/knowledge-store.ts` | 只做 DB CRUD + FTS 同步，不做发布决策 |
| 检索 | **新增服务** | `src/main/services/knowledge-search.ts` | 范围进 SQL；词法优先；返回 `mode` |
| 提案生成/审核 | **新增服务** | `src/main/services/knowledge-proposals.ts` | 创建/更新/检查提案；写 `proposal_reviews` |
| 发布 | **新增服务** | `src/main/services/knowledge-publish.ts` | 事务、版本冲突、幂等、快照 |
| AI 工具适配 | **新增服务** | `src/main/services/knowledge-ai-tools.ts` | **只暴露提案能力**；不 import `ipc/`，不接触密钥 |
| 状态 | **演进** | `src/main/services/knowledge.ts` | 保留 `knowledgeStatusAt` 原签名（PD31 单测依赖），新增 DB 版状态查询 |
| LLM 调用 | **复用** | `services/llm.ts::generate/generateStrict` | 不新增 provider；无 function-calling，用 JSON 输出 + 强校验 |
| 设置/密钥 | **复用** | `services/settings.ts::provider/resolve/getSecret` | 不新增 key；不把明文写进提案 |
| 分组范围 | **复用** | `services/library-groups.ts::groupItemIds`（133-147） | 分组 → itemIds 后作为 SQL `IN` 参数 |
| 模块匹配 | **复用（阶段 2）** | `shared/modules.ts::matchChunkToModules` | 仅用于证据模块定位；结果不确定时降级页级证据 |
| 嵌入 | **不复用** | `services/embed.ts`、`python/app/embed.py` | 阶段 1 不做向量；禁止 `local-hash-64` 参与知识检索 |
| 批处理 | **可选复用** | `services/batch/queue.ts`、`batch/registry.ts` | 仅在「从批处理结果生成提案」时记录 `source_batch_job_id`；不把提案塞进 `batch_jobs` 状态机 |

### 4.3 IPC 通道（`src/shared/channels.ts` 新增 `CH.knowledge`）

```ts
CH.knowledge = {
  status:         'knowledge:status',          // 只读：表是否存在/计数/模式（不含 Key）
  search:         'knowledge:search',          // 只读：正式条目检索（范围参数进 SQL）
  entryList:      'knowledge:entryList',
  entryGet:       'knowledge:entryGet',
  batchList:      'knowledge:batchList',       // 暂存批次
  batchGet:       'knowledge:batchGet',        // 含提案摘要与差异
  proposalList:   'knowledge:proposalList',
  proposalGet:    'knowledge:proposalGet',
  proposalCreate: 'knowledge:proposalCreate',  // 仅用户手建（AI 不走 IPC）
  proposalUpdate: 'knowledge:proposalUpdate',
  proposalReview: 'knowledge:proposalReview',  // accept/edit_accept/reject/defer
  proposalCheck:  'knowledge:proposalCheck',   // 重跑自动检查
  publishPreview: 'knowledge:publishPreview',  // 返回可发布/冲突清单，不写库
  publish:        'knowledge:publish'          // 用户确认后执行（服务端再校验）
}
EVT.knowledgeChanged = 'knowledge:changed'     // 发布/生成完成，渲染层刷新
```

同步修改：`shared/api.ts`（`PaperdeskApi.knowledge`）、`preload/index.ts`（逐方法 `invoke` 镜像）、`src/main/ipc/knowledge.ts`（每个 handler 做 scope/参数校验）。

### 4.4 渲染层入口

| 入口 | 文件 | 改动 |
|---|---|---|
| 正式知识库面板 | `src/renderer/src/features/knowledge/KnowledgePanel.tsx` | 新增：条目列表、类型/性质筛选、来源徽标、证据跳转（复用 `openTarget`） |
| 暂存区面板 | `src/renderer/src/features/knowledge/StagingPanel.tsx` | 新增：批次列表 → 提案列表 → 差异视图（before/after、字段级）、证据来源、检查结果、接受/拒绝/编辑后接受、勾选后发布 |
| 差异组件 | `src/renderer/src/features/knowledge/ProposalDiff.tsx` | 新增：纯展示组件；不直接调 IPC |
| 面板注册 | `src/renderer/src/modules/registry.tsx:103-117`（`PanelModule` 类型）、`PANELS` | 新增两项，`group` 建议 `data`（与文库/笔记同组），图标沿用现有集合 |
| 标题/分组/ribbon | `src/renderer/src/App.tsx:897`（面板标题映射）、`1227-1255`（ribbon）、`910-917`（渲染） | 若标题映射由 `PANELS` 自动生成则无需改；新增顶部入口时才在 1364-1371 附近加 overlay |
| 设置页入口 | `features/settings/SettingsDialog.tsx:1212-1227` | 从「仅占位」改为真实计数/模式，并提供「打开暂存区」 |

样式沿用 `styles.css` 的面板/列表/徽标类；若需新增类，集中放在知识库段落，不复用 `.sidebar__title` 等全局选择器（CODE-MAP 已有同类教训）。

---

## 5. 数据模型（阶段 1 的 7 张表 + 1 张 FTS）

> 约定：所有表进 `src/main/db/schema.sql` 且 `IF NOT EXISTS`；时间统一 `TEXT`（ISO8601）；JSON 列存 `TEXT`；外键 `ON DELETE` 明确写出（`db/index.ts:19-30` 打开了 `foreign_keys`）。

### 5.1 表结构（DDL 草案）

```sql
-- 1) 知识条目（正式库；只有发布流程能写）
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id             INTEGER PRIMARY KEY,
  key            TEXT UNIQUE NOT NULL,          -- 稳定业务键（跨库/导入导出）
  kind           TEXT NOT NULL,                 -- paper|concept|method|dataset|metric|claim|note|decision|question
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  content_nature TEXT NOT NULL,                 -- user_decision|user_hypothesis|author_claim|observation|ai_inference|ai_suggestion
  item_id        INTEGER REFERENCES items(id) ON DELETE SET NULL,
  attachment_id  INTEGER,
  source_type    TEXT NOT NULL,                 -- paper|translation|note|annotation|conversation|user|ai
  source_ref     TEXT NOT NULL DEFAULT '{}',    -- JSON：noteId/messageId/translationId/annotationId…
  content_hash   TEXT NOT NULL,                 -- sha256(normalize(title+body))
  version        INTEGER NOT NULL DEFAULT 1,
  state          TEXT NOT NULL DEFAULT 'published',  -- published|archived（条目生命周期，不是审核状态）
  title_tokens   TEXT NOT NULL DEFAULT '',      -- bigram/拉丁词 token 串（knowledge_fts 内容列）
  body_tokens    TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  published_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_kind ON knowledge_entries(kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_item ON knowledge_entries(item_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_hash ON knowledge_entries(content_hash);

-- 2) 知识关系（发布后才有 id；未解析的 key 保留原文）
CREATE TABLE IF NOT EXISTS knowledge_relations (
  id            INTEGER PRIMARY KEY,
  key           TEXT UNIQUE NOT NULL,
  from_entry_id INTEGER REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  to_entry_id   INTEGER REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  from_key      TEXT NOT NULL,
  to_key        TEXT NOT NULL,
  relation_type TEXT NOT NULL,                  -- supports|contradicts|derived_from|part_of|related_to|same_as
  source_type   TEXT NOT NULL DEFAULT 'ai',
  source_ref    TEXT NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed|proposed
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_rel_from ON knowledge_relations(from_entry_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_rel_to ON knowledge_relations(to_entry_id);

-- 3) 证据（发布时固化；页级/模块级用 precision 区分）
CREATE TABLE IF NOT EXISTS evidence_links (
  id            INTEGER PRIMARY KEY,
  entry_id      INTEGER NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL,                  -- paper|translation|note|annotation|conversation|user
  item_id       INTEGER,
  attachment_id INTEGER,
  page_index    INTEGER,                        -- 0 基，与 chunks 一致
  module_id     TEXT,
  rect          TEXT,                           -- JSON [x0,y0,x1,y1]
  char_start    INTEGER,
  char_end      INTEGER,
  quote         TEXT NOT NULL,
  section_path  TEXT,
  precision     TEXT NOT NULL DEFAULT 'page',   -- module|page|document
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_entry ON evidence_links(entry_id);
CREATE INDEX IF NOT EXISTS idx_evidence_att ON evidence_links(attachment_id, page_index);

-- 4) 版本快照（发布时写；回滚=以旧快照生成新版本）
CREATE TABLE IF NOT EXISTS knowledge_versions (
  id            INTEGER PRIMARY KEY,
  entry_id      INTEGER NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  change_reason TEXT,
  proposal_id   INTEGER,                        -- 一个提案最多产出一个版本 → 天然幂等键
  created_by    TEXT NOT NULL DEFAULT 'user',   -- user|system
  created_at    TEXT NOT NULL,
  UNIQUE(entry_id, version),
  UNIQUE(proposal_id)
);

-- 5) 暂存批次
CREATE TABLE IF NOT EXISTS proposal_batches (
  id                  INTEGER PRIMARY KEY,
  key                 TEXT UNIQUE NOT NULL,
  title               TEXT NOT NULL,
  task                TEXT NOT NULL,            -- chat_organize|paper_analysis|manual|import
  scope_type          TEXT NOT NULL DEFAULT 'all', -- all|item|attachment|group|collection
  scope_ref           TEXT NOT NULL DEFAULT '{}',  -- JSON：itemId/attachmentId/groupName
  status              TEXT NOT NULL DEFAULT 'draft', -- draft|generating|ready|partially_published|published|abandoned
  ai_config_ref       TEXT NOT NULL DEFAULT '{}', -- 非敏感：providerMode/chatModel/baseUrlHost/workflowVersion
  workflow_version    TEXT,
  skill_version       TEXT,
  source_batch_job_id INTEGER,                  -- 可选：来自 batch_jobs，不做外键级联
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- 6) 提案（AI 与用户都只能写这里）
CREATE TABLE IF NOT EXISTS knowledge_proposals (
  id              INTEGER PRIMARY KEY,
  key             TEXT UNIQUE NOT NULL,
  batch_id        INTEGER NOT NULL REFERENCES proposal_batches(id) ON DELETE CASCADE,
  op              TEXT NOT NULL,                -- create|update|add_evidence|add_relation|merge|archive
  target_entry_id INTEGER,
  target_key      TEXT,
  base_version    INTEGER,                      -- update/merge 必填；create 为空
  patch_json      TEXT NOT NULL,                -- 变更内容（含 evidence/relation 草案）
  reason          TEXT NOT NULL DEFAULT '',
  content_nature  TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  source_ref      TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'draft',-- draft|checking|pending_review|needs_edit|rejected|published|withdrawn
  checks_json     TEXT NOT NULL DEFAULT '{}',   -- 程序检查结果（可重跑）
  idempotency_key TEXT UNIQUE,                  -- sha256(batch+op+target+base+patch)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  published_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_batch ON knowledge_proposals(batch_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON knowledge_proposals(status);

-- 7) 审核留痕
CREATE TABLE IF NOT EXISTS proposal_reviews (
  id                 INTEGER PRIMARY KEY,
  proposal_id        INTEGER NOT NULL REFERENCES knowledge_proposals(id) ON DELETE CASCADE,
  action             TEXT NOT NULL,             -- accept|edit_accept|reject|defer|request_edit
  edited_patch_json  TEXT,
  reason             TEXT,
  reviewer           TEXT NOT NULL DEFAULT 'user',
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_proposal ON proposal_reviews(proposal_id);

-- 8) 中文检索（外部内容表；token 列由应用层写入，触发器镜像）
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  title_tokens, body_tokens,
  content='knowledge_entries', content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS knowledge_fts_ai AFTER INSERT ON knowledge_entries BEGIN
  INSERT INTO knowledge_fts(rowid, title_tokens, body_tokens) VALUES (new.id, new.title_tokens, new.body_tokens);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_fts_ad AFTER DELETE ON knowledge_entries BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title_tokens, body_tokens) VALUES ('delete', old.id, old.title_tokens, old.body_tokens);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_fts_au AFTER UPDATE ON knowledge_entries BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title_tokens, body_tokens) VALUES ('delete', old.id, old.title_tokens, old.body_tokens);
  INSERT INTO knowledge_fts(rowid, title_tokens, body_tokens) VALUES (new.id, new.title_tokens, new.body_tokens);
END;
```

**为什么 token 列放在 `knowledge_entries` 而不是触发器里分词**：SQLite 触发器无法调用 JS 分词函数；把 token 串作为普通列写入，FTS 外部内容表与触发器就能沿用 `items_fts`（`schema.sql:248-257`）的成熟形态。代价是 `snippet()/highlight()` 看到的是空格分隔的 token 串，**因此知识库结果不直接用 FTS 的 snippet**，由渲染层用原始 `title/body` + 纯函数高亮（见 §6.3）。

### 5.2 与现有表的对应关系（逐项）

| 新表 | 现有表/字段 | 关系与迁移策略 |
|---|---|---|
| `knowledge_entries.item_id` | `items.id` | 弱引用（`ON DELETE SET NULL`），论文删除不连带知识（条目降级为「无归属」）；不复制 `items` 元数据 |
| `knowledge_entries`（来源=paper） | `chunks` + `paper_modules` | 不复制正文；证据指向 `attachment_id + page + module_id`，正文按需回读 |
| `knowledge_entries`（来源=translation） | `translations.id/lang/md_path` | `source_ref={translationId}`；去重键含 `lang`（原文与译文不互相覆盖） |
| `knowledge_entries`（来源=note） | `notes.id` | `source_ref={noteId, section?}`；笔记仍是正文所有者，知识条目只存提炼结果与证据 |
| `knowledge_entries`（来源=conversation） | `ai_messages.id`（`citations_json` 313） | `source_ref={conversationId,messageId}`；只存消息 id，不复制整段对话 |
| `evidence_links` | `chunks`（162-169）、`paper_modules`（286-297） | 阶段 1 新数据写入时尽量固化 `module_id/char offsets`；历史数据阶段 2 回填，允许 `precision='page'` |
| `evidence_links`（形状参考） | `citation_contexts`（152-159） | 不迁移、不改造既有引文；将来可考虑统一为「证据」视图，属阶段 4 |
| `proposal_batches.source_batch_job_id` | `batch_jobs.id`（206-222） | 只记来源，不建立外键；批处理状态机与审核状态机分离 |
| `knowledge_fts` | `items_fts/chunks_fts/notes_fts/translations_fts`（242-282） | 复用「外部内容表 + 触发器」，不复用 `unicode61` 分词与 `ftsQuery` |
| `knowledge_versions` | 无 | 纯新增；发布时快照 `entry + evidence + relations` 的 JSON |
| `proposal_reviews` | 无 | 纯新增；与 `knowledge_proposals.status` 互为「当前态/历史」 |

### 5.3 PD31 占位如何演进（不推倒）

- **保留** `src/main/services/knowledge.ts:13-18` 的 `knowledgeStatusAt(dataDir)` 原签名与行为（建目录、返回 `{enabled:false,status:'placeholder',root}`）。`scripts/test-unit.ts:4109-4143` 直接测它，本批次不改测试断言。
- **新增** `knowledgeStoreStatus(db, root)`：查 `sqlite_master` 是否存在 7 张表；`status` 返回 `placeholder`（表缺失）/`degraded`（表在但 FTS 或计数异常）/`ready`；`enabled` 在 `ready|degraded` 时为 `true`；附 `entries/proposals/pendingReviews` 计数。
- **演进点**：`services/settings.ts:342-344` 的 `getKnowledgeStatus()` 改为「DB 已初始化时调 `knowledgeStoreStatus(getDb(), getDataDir())`，否则回退 `knowledgeStatusAt`」。`ipc/settings.ts:26`、`preload/index.ts:172`、`shared/api.ts:429-430` 的通道与签名不变。
- **类型扩展**：`shared/types.ts:609-618` 的 `KnowledgeStatus.status` 从 `'placeholder'` 扩为 `'placeholder'|'degraded'|'ready'`；`enabled` 语义保持不变（旧 UI 不会崩）。
- **目录**：`data/knowledge` 继续保留（导出/证据缓存/未来的附件抽屉），但**数据库是唯一事实来源**；不得把条目只写文件。
- **UI**：`SettingsDialog.tsx:1212-1227` 的「当前仅占位、尚不可用」改为真实状态 + 计数 + 「打开暂存区」；`CODE-MAP.md:169/217/244` 三处 PD31 条目改写为「阶段 1 演进」，保留纯函数说明。

---

## 6. 中文检索设计（阶段 1 核心）

### 6.1 分词（`src/shared/cjk.ts`）

- 输入先做 `NFKC` 归一 + 小写化；按 Unicode 脚本切段：CJK 段、拉丁/数字段、标点丢弃。
- CJK 段长度 `n>=2` → 相邻 bigram（`n-1` 个），用空格连接；`n==1` → 该字单独成 token（仅用于标题匹配，正文单字查询在查询端拒绝，见 6.2）。
- 拉丁段 → 词（保留内部连字符/下划线），不做词干化（避免与 `bm25` 冲突）。
- 输出 `tokenize(text): string`，并对同一函数提供 `tokens(text): string[]` 便于测试。
- 复杂度 O(n)，无第三方依赖；索引体积约为原文的 2 倍字符量，文档记录上限：单条 `title+body` 超过 200KB 时截断并记 `checks_json.truncated=true`（阶段 1 允许，UI 明示）。

示例：`"知识库管理"` → `知识 识库 库管 管理`。

### 6.2 查询构造（`src/shared/knowledge-query.ts`）

- 用户输入按空白/标点切成语义组（term）。
- 每个 term：
  - CJK 长度 ≥2 → 生成**相邻 bigram 短语**：`"知识 识库"`（FTS5 中空格分隔的 token 序列被当作 phrase，要求相邻），等价于原文子串匹配；
  - CJK 长度 1 → 返回 `{tooShort:true}`（服务层直接返回空 + `reason='query-too-short'`，不做全表 LIKE）；
  - 拉丁 → `"word"*` 前缀匹配；
  - 含通配/引号等特殊字符：先转义（FTS5 字符串内 `"` 双写），再包裹，**绝不做字符串拼接进 SQL**。
- 多个 term 之间 `AND`；同一 term 的别名组（阶段 3）用 `OR` 包裹：`(phrase1 OR phrase2)`。阶段 1 `aliases` 传空数组，结构先行。
- 返回 `{ok, fts, reason?}`；空查询返回 `ok:false, reason:'empty'`。

### 6.3 检索 SQL（`knowledge-search.ts` + `shared/knowledge-query.ts::buildKnowledgeSearchSql`）

```sql
SELECT e.id, e.key, e.kind, e.title, e.body, e.content_nature, e.source_type,
       bm25(knowledge_fts) AS rank
FROM knowledge_fts
JOIN knowledge_entries e ON e.id = knowledge_fts.rowid
WHERE knowledge_fts MATCH ?
  AND e.state = 'published'
  AND ( ? IS NULL OR e.item_id = ? )                          -- item 范围
  AND ( ? IS NULL OR e.attachment_id = ? OR EXISTS (          -- attachment 范围
        SELECT 1 FROM evidence_links ev
        WHERE ev.entry_id = e.id AND ev.attachment_id = ? ) )
  AND ( ? IS NULL OR e.item_id IN ( /* group 解析后的 id 列表，参数化 */ ) )
ORDER BY rank
LIMIT ?;
```

要点：

- 范围条件全部在 `WHERE`，`LIMIT` 在最后；分组范围先由 `groupItemIds`（`library-groups.ts:133-147`）解析成 id 数组，再用占位符 `IN (?,?,…)` 绑定（列表长度做上限，如 500，超出报 `scope-too-large`）。
- 禁止把用户输入拼进 SQL；`MATCH` 参数只来自 6.2 的纯函数输出。
- 排序：阶段 1 用 `bm25`；标题命中可加权重（`bm25(knowledge_fts, 2.0, 1.0)`）但需实测，默认不加权。
- 结果 `mode` 固定 `'lexical'`；不读 `chunk_embeddings`、不调 `semanticSearchQuery`。UI 在结果头显示「词法检索（无向量）」，若用户配置了真实嵌入服务，阶段 2 再以「可选重排」出现并显式标注模型。

### 6.4 去重与来源合并

- `content_hash = sha256(NFKC(title) + '\n' + NFKC(body))`，去空白差异；索引但**不建唯一约束**（同一论断可能合法地出现在两篇论文中，强唯一会误杀）。
- 提案检查阶段（非 DB 约束）报告 `duplicateCandidates`（同 hash 或标题相似度 ≥0.9 的已发布条目），由用户决定「合并/新建」。
- 原文与译文命中同一段：`content_hash` 不同（语言不同），但可通过 `source_ref` 的 `attachment_id` + 对齐信息在 UI 合并展示；阶段 1 只保证两条证据都能跳回原文页码。

---

## 7. 迁移与回滚

### 7.1 `schema.sql` 改动点

1. 在文件末尾「AI 问答」表之后追加 §5.1 的 7 张表 + `knowledge_fts` + 3 个触发器 + 索引；全部 `IF NOT EXISTS`。
2. 不修改任何既有列/表名；不改 `items_fts` 等四张 FTS 的 tokenizer（避免破坏既有检索与测试）。
3. 文件头若存在分节注释，按现有风格加 `-- ============ 知识库（阶段 1） ============`。

### 7.2 `migrate.ts` 改动点

- 既有 `COLUMN_MIGRATIONS`（`migrate.ts:20-50`）**只加**：
  - `chunks`：`module_id TEXT`、`char_start INTEGER`、`char_end INTEGER`、`content_hash TEXT`（阶段 2 回填用；阶段 1 先建列，允许为空；本批次是否建列由实现工程师按「不动业务代码」原则决定——PD32 只记录方案）；
  - `knowledge_entries` 的 `title_tokens/body_tokens` 已在建表 DDL 内，无需 ALTER。
- 新增 `migrateKnowledge(d, log)`（`migrate.ts` 导出，`initDb` 在 `migrate(db)` 之后调用）：
  1. 读 `PRAGMA user_version`；`>= 1` 直接返回（幂等）。
  2. `BEGIN IMMEDIATE`；
  3. 若 `knowledge_entries` 存在但 `title_tokens/body_tokens` 为空（老库/半升级），逐批 `SELECT id,title,body` → 纯函数分词 → `UPDATE`（每 200 行一批，避免长事务）；
  4. `INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')` 重建索引；
  5. `PRAGMA user_version = 1`；`COMMIT`；异常 `ROLLBACK` 并抛出（由 `initDb` 决定是否阻止启动——**建表失败必须阻止**，回填失败可降级但要在状态里报 `degraded`）。
- 不使用 `settings` 表存迁移版本（`user_version` 是 SQLite 原生、无并发歧义）；若团队更倾向 settings key，需在文档与测试中同时固定，二选一，不混用。

### 7.3 老库原地升级步骤

1. 备份：复制 `library.sqlite`（含 `-wal/-shm` 时先 checkpoint 或用 SQLite backup API）到 `library.sqlite.bak-<时间戳>`；备份失败则中止启动并提示。
2. 启动：`initDb` → `db.exec(schema)`（新表/索引/触发器自动创建，`db/index.ts:25`）→ `migrate(db)`（补列，26）→ `migrateKnowledge(db)`（回填 token + 重建 FTS + 置 `user_version=1`）。
3. 校验：`knowledgeStoreStatus` 返回 `ready`；抽 3 条已发布条目做一次检索与证据跳转。
4. 失败：保留备份，回退到升级前版本启动；新表为空不影响旧功能（旧代码不认识新表）。

### 7.4 回滚方式

- **代码回滚**：旧版本代码不读新表，可直接回退二进制；新表保留但不影响旧功能。
- **数据回滚**：`DROP TABLE knowledge_fts; DROP TABLE proposal_reviews; …`（按外键反向顺序）或直接用备份文件替换；**禁止** `ALTER TABLE ... DROP COLUMN` 去动既有列。
- **条目级回滚**：不用删除。发布时写 `knowledge_versions` 快照；「撤销某次发布」= 以目标版本快照为 patch 生成一条新的 `update` 提案，走同一审核/发布流程，产生新版本。历史版本永不物理删除（审计要求）。
- **发布事务回滚**：发布服务用 `db.transaction`；任一提案校验/写入失败 → `ROLLBACK`，不产生半成品；已 `published` 的提案不会因后续失败被改回（同批次其余提案保持 `pending_review`）。

### 7.5 内容性质与审核状态为何分开（承接 §3）

补充三条工程理由：

1. **查询需要**：`WHERE content_nature='author_claim'` 用于「只看作者原话」；`WHERE review_status='pending_review'` 用于暂存区。合并后两类查询互相污染。
2. **权限需要**：AI 只能写 `review_status=draft/pending_review` 且 `content_nature=ai_*`；用户接受后只改 `review_status`，AI 永远不能把 `content_nature` 改成 `user_decision`。分列让这条规则可以用一条 SQL 约束/检查表达。
3. **导入导出需要**：导出知识库时 `content_nature` 是内容属性（随条目走），`review_status` 是流程属性（导出时应为 `published` 或省略）。同列会导致导出文件里混入暂存态。

---

## 8. 阶段 1 最小闭环的接口边界

### 8.1 主进程业务接口（`ipc/knowledge.ts`，用户 UI 专用）

职责：参数/范围校验 → 调服务 → 返回结构化结果。硬性要求：

- **范围检查**：`entryGet/proposalGet` 校验 id 存在且属于当前库；`publish` 校验每个 `proposalId` 属于 `batchId`、批次与提案状态合法；`search` 的 `scope.groupName` 必须存在（`library-groups`）；`attachmentId` 必须属于范围内的 `itemId`。
- **发布只读 DB**：`publish` 的输入只有 `{batchKey, proposalKeys[], expected:[{key, baseVersion}]}`；服务端重新读 `knowledge_proposals.patch_json`（不信任渲染层传来的 patch），重跑检查后写库。
- **不返回敏感信息**：`status` 只返回 `apiKeySet` 类布尔（复用 `getPublicSettings` 语义，`settings.ts:281`）；错误信息不含 Key/完整 URL。
- **审计**：每次 `proposalReview` 写 `proposal_reviews`；`publish` 写 `knowledge_versions`。

### 8.2 AI 工具适配层（`services/knowledge-ai-tools.ts`，主进程内部）

职责：把「AI 想做的变更」转成**提案**，并做机器可做的校验。只暴露：

| 能力 | 输入 | 输出/副作用 |
|---|---|---|
| `searchPublished` | query + scope | 只读正式条目（走 §6 SQL） |
| `getEntry` | entryKey | 只读条目 + 证据 |
| `getEvidence` | entryKey | 只读证据列表（页/模块/引用） |
| `readSourceInScope` | attachmentId/itemId + 页范围 | 只读原文文本/结构化模块（限 scope） |
| `createProposal` | batchKey + op=create + patch + reason + nature + source | 写 `knowledge_proposals`（`status='pending_review'` 或 `draft`） |
| `updateProposal` | proposalKey + patch（仅未发布、未拒绝） | 写提案；不触碰正式条目 |
| `requestChecks` | proposalKey | 重跑程序检查，写 `checks_json` |

实现约束：

- 适配层接收的是**已解析的 JSON**，不接受自由文本 SQL/路径；所有字段按白名单校验（op、kind、nature、source_type、relation_type 枚举；长度上限；id 必须存在）。
- **引文核对**：提案里的 `quote` 必须能在对应页/模块文本中找到（去空白后逐字包含）；找不到 → `checks_json.quoteVerified=false`、提案 `needs_edit`，不得进入 `pending_review`。
- **版本**：`update` 必须带 `base_version`，服务端比对 `knowledge_entries.version`；不一致直接 `needs_edit` 并返回冲突，不合并。
- **幂等**：`idempotency_key=sha256(batchKey|op|targetKey|baseVersion|patchJson)`；重复生成命中唯一键则返回已存在提案（不重复插入）。
- **凭据**：适配层不 import `settings` 的 `getSecret`，不接收 `apiKey`；只接收 model/baseUrl 的非敏感快照用于 `ai_config_ref`，写入前剔除 query/userinfo。

### 8.3 UI 发布接口（`ipc/knowledge.ts::publish` + `services/knowledge-publish.ts`）

**发布只能由用户触发的程序流程执行**，具体为：

1. 用户在暂存区勾选提案 → `publishPreview` 返回每项 `{ok, conflicts[], diffSummary}`（只读，不写库）。
2. 用户确认 → `publish({batchKey, proposalKeys, expected})`。
3. 服务端事务：
   - 逐项断言 `status='pending_review'`、`base_version` 匹配、patch 通过 schema/scope/quote 检查、目标条目 `state='published'`；
   - 任一项失败 → 整体 `ROLLBACK`，返回 `{ok:false, conflicts}`（默认全有或全无；用户可取消勾选冲突项后重试）；
   - 全部通过 → 应用 patch（create/update/evidence/relation）→ 写 `knowledge_versions` → 提案置 `published` + `published_at` → 批次状态更新 → `COMMIT` → 广播 `EVT.knowledgeChanged`；
   - 幂等：`knowledge_versions.proposal_id UNIQUE`；重复发布同一提案时捕获唯一冲突，返回 `alreadyPublished:true`（视为成功，不重复写）。
4. 事务提交后**才**广播事件；广播失败不影响已提交数据（渲染层可手动刷新）。

### 8.4 AI 明确不可调用的能力（硬边界）

1. 直接发布/接受/拒绝提案（只能创建/修改提案，`publish/review` 仅 UI 通道）。
2. 删除正式条目、删除证据、清空版本历史。
3. 执行任意 SQL、打开任意 DB 连接、改 schema、跑迁移。
4. 任意文件写入/删除（包括 `data/` 与用户目录）；导出只能由用户选路径的既有导出通道完成。
5. 修改系统规则/设置/工作流与技能配置（`provider.*`、`analysis.*`、`mt.*` 等）。
6. 读取 API Key、完整 Base URL 中的凭据、`settings` 明文或 `safeStorage` 解密值。
7. 读取 scope 之外的论文/附件/笔记/对话；跨库访问。
8. 伪造来源：把 AI 内容标成 `author_claim/user_decision`，或伪造 `quote/module_id/page`。
9. 触发批处理/翻译/联网检索等有副作用的任务（阶段 1 不授予）。
10. 通过「生成一个 `op=publish` 的提案」绕过：`op` 枚举里根本没有 publish，发布不是提案类型。

### 8.5 一致性与冲突处理

| 场景 | 处理 |
|---|---|
| 两次 AI 生成同一批内容 | `idempotency_key` 唯一 → 返回已有提案 |
| 用户编辑提案后 AI 又更新 | 提案带 `updated_at`/`checks_json`；AI 只能改 `draft`，`pending_review` 后需用户先「请求修改」 |
| 发布时条目已被别处改过 | `base_version` 不匹配 → 该项 `conflict`，整体回滚，UI 显示「重新生成/手动合并」 |
| 发布中途崩溃 | 事务保证要么全成要么全无；重启后 `pending_review` 仍在，可重试 |
| 证据引文对不上 | `needs_edit`，不阻塞同批其他提案，但不允许勾选发布 |
| 批次只发布一部分 | 批次状态 `partially_published`；剩余提案保持 `pending_review` |

---

## 9. 测试计划（阶段 1 实现时执行；PD32 只列清单）

纯函数单测（加入 `scripts/test-unit.ts` 的 runner，参照 `pd31KnowledgePlaceholderTests` 4109-4143 与 runner 4448-4449）：

1. `knowledgeCjkTests`：中英混排、标点、全半角、emoji、单字、长串 bigram 数量与顺序、幂等（同输入同输出）。
2. `knowledgeQueryTests`：短语相邻、多 term AND、别名 OR、特殊字符转义、空查询、单字拒绝、超长截断。
3. `knowledgeSearchSqlTests`：四种 scope 的 SQL 片段与参数顺序；断言用户输入**不出现**在 SQL 字符串里（防注入）；group ids 上限。
4. `knowledgeProposalTests`：op/枚举白名单、`base_version` 必填规则、patch 大小上限、引文核对、幂等键稳定性、敏感字段（apiKey/authorization）被拒绝。
5. `knowledgePublishPlanTests`：用假 DB（实现 `prepare/exec` 最小接口，仿 `migrate.ts` 的 `MigrationDb`）测冲突清单、全有或全无、重复发布幂等、版本快照 JSON。
6. `knowledgeStatusTests`：表缺失 → `placeholder`；正常 → `ready`；FTS 异常 → `degraded`；`knowledgeStatusAt` 旧断言不变。
7. 断言：`ai_config_ref` 序列化结果不含 `apiKey/authorization/Bearer` 字符串。

集成/验收（由实现与验收岗位执行，不在本任务内）：迁移幂等（连续启动两次 `user_version=1`、`knowledge_fts` 行数不变）、范围检索不泄漏别篇、发布后暂存区不可再改、GUI 在候选构建目录内跑。

---

## 10. 待定项、风险与阶段边界

**阶段边界**（本批次只做阶段 0 与 1）：

- 阶段 2：`chunks.module_id/char offsets/content_hash` 回填、`search()/searchHybrid` 范围参数化改造、真实嵌入可选重排、笔记/译文知识化导入。
- 阶段 3：`term_aliases` 同义词、可配置工作流/技能版本、批量重跑。
- 阶段 4：MCP/外部工具、知识图谱视图、跨库同步。

**待定项**

- **D1**：既有 `search()/searchHybrid` 是否在阶段 1 一并加范围参数？本文建议**不**（本批次范围是知识库；改动会波及阅读器检索、地图、问答三处回归）。
- **D2**：`batch_jobs` 是否复用为提案生成队列？本文建议只记 `source_batch_job_id`，不复用状态机；若实现发现生成任务需要排队/重试，再评估在 `proposal_batches` 上加 `status='generating'` 的轻量队列。
- **D3**：`migrateKnowledge` 的回填失败策略（阻止启动 vs 降级）需团队确认；本文建议「建表失败阻止、回填失败降级并在状态里报 degraded」。

**风险**

- **R1**：trigram/`unicode61` 在 better-sqlite3 13 + Electron 44 的运行时行为未实测；`sqlite3.h:149` 显示 3.53.4，但必须由实现工程师用 `SELECT sqlite_version()` 验证。本文方案不依赖 trigram（bigram 由 JS 完成），只把 trigram 当备选。
- **R2**：bigram 索引体积约为正文 2 倍字符量；需在真实库上量测（10 万块级别），必要时只索引标题+正文前 N 字符并标注 `truncated`。
- **R3**：历史 `chunks` 无模块信息，阶段 2 回填依赖启发式（`matchChunkToModules` 不可靠返回 `[]`），会出现大量页级证据；UI 必须如实显示 `precision`。
- **R4**：LLM 无 function-calling，模型可能输出非法 JSON/越权字段；必须在主进程白名单校验 + 引文核对，禁止「模型说了算」。
- **R5**：PD33/PD34 的最终字段可能与本文草案有差异；实现时以本文的表/接口边界为准，字段名可在不改语义的前提下调整，并同步更新本文件与 CODE-MAP。

---

## 11. 本次核查未执行项（如实标注）

- 未启动 Electron/GUI；未在运行时执行 `SELECT sqlite_version()` 或建表验证 trigram。
- 未运行 `typecheck/test:unit/test:coords/build/check-isolation`（PD32 只改文档；回归结果见任务证据文件；`check-isolation` 在本仓库 `package.json` 中**没有对应脚本**，需由控制器/验收岗位给出实际命令）。
- 未修改任何业务代码、schema、迁移；本文件是阶段 1 的实现依据，不是实现本身。
