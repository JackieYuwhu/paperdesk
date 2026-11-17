-- PaperDesk schema (M0)
-- 设计要点:
--  * 对外一律用 key（不用自增 id），深链/文件目录稳定
--  * 批注存库不存 PDF；rects 视觉锚 + text/prefix/suffix 语义锚
--  * works 表是统一 ID 层（DOI / OpenAlex / Semantic Scholar 归并）

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============ 论文条目 ============
CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY,
  key           TEXT UNIQUE NOT NULL,
  doi           TEXT,
  title         TEXT,
  abstract      TEXT,
  year          INTEGER,
  venue         TEXT,
  type          TEXT,
  language      TEXT,
  domain        TEXT,
  -- 文库分组（用户自建，NULL = 未分组）
  group_name    TEXT,
  parent_id     INTEGER,
  space_path    TEXT,
  extra         TEXT,
  -- 完整发表信息 JSON（类型/期刊/会议/预印本/卷期页/来源/用户修正字段）；
  -- 老库只有 venue，读时由 publicationFromRow 兜底还原
  publication_json TEXT,
  date_added    TEXT NOT NULL,
  date_modified TEXT NOT NULL
);

-- 被引次数「手动查询 + 本地记录」：打开详情只读这张表，绝不联网。
-- status: ok（有次数，含 0）/ no_count（已匹配但接口未提供次数）/ not_found /
--         ambiguous（多候选待用户选择）/ failed / unconfigured
CREATE TABLE IF NOT EXISTS item_citations (
  item_id         INTEGER PRIMARY KEY,
  status          TEXT NOT NULL,
  count           INTEGER,
  source          TEXT NOT NULL DEFAULT 'Google Scholar，经 SerpAPI',
  matched_title   TEXT,
  matched_id      TEXT,
  queried_at      TEXT NOT NULL,
  last_attempt_at TEXT,
  last_error      TEXT,
  candidates_json TEXT
);

-- 文库分组树：name 是完整路径（如 大模型/推理），parent_name 为父路径
-- 允许空分组存在；items.group_name 指向这里的 name
CREATE TABLE IF NOT EXISTS library_groups (
  name          TEXT PRIMARY KEY,
  parent_name   TEXT,
  date_created  TEXT NOT NULL,
  date_modified TEXT,
  description   TEXT,
  -- 同层手动顺序（1 起）；NULL = 尚未手动排序，按名称兜底
  sort_order    INTEGER
);

-- ============ 作者 ============
CREATE TABLE IF NOT EXISTS authors (
  id            INTEGER PRIMARY KEY,
  display_name  TEXT NOT NULL,
  orcid         TEXT UNIQUE,
  openalex_id   TEXT,
  s2_author_id  TEXT
);

CREATE TABLE IF NOT EXISTS item_authors (
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  author_id   INTEGER NOT NULL REFERENCES authors(id),
  position    INTEGER NOT NULL,
  affiliation TEXT,
  PRIMARY KEY (item_id, author_id)
);

-- ============ 附件 (PDF) ============
CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY,
  key          TEXT UNIQUE NOT NULL,
  item_id      INTEGER REFERENCES items(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  filename     TEXT,
  content_type TEXT,
  sha256       TEXT,
  size         INTEGER,
  page_count   INTEGER,
  date_added   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_item ON attachments(item_id);

-- ============ 批注 ============
CREATE TABLE IF NOT EXISTS annotations (
  id            INTEGER PRIMARY KEY,
  key           TEXT UNIQUE NOT NULL,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  text          TEXT,
  prefix        TEXT,
  suffix        TEXT,
  comment       TEXT,
  color         TEXT,
  page_index    INTEGER NOT NULL,
  position      TEXT NOT NULL,
  sort_index    TEXT,
  date_added    TEXT NOT NULL,
  date_modified TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ann_attachment ON annotations(attachment_id, page_index);

-- ============ 笔记 ============
CREATE TABLE IF NOT EXISTS notes (
  id            INTEGER PRIMARY KEY,
  key           TEXT UNIQUE NOT NULL,
  item_id       INTEGER REFERENCES items(id) ON DELETE SET NULL,
  title         TEXT,
  md_path       TEXT,
  date_added    TEXT NOT NULL,
  date_modified TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note_annotations (
  note_id       INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  annotation_id INTEGER NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, annotation_id)
);

-- ============ 集合 / 标签 ============
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY, key TEXT UNIQUE, name TEXT NOT NULL, parent_id INTEGER
);
CREATE TABLE IF NOT EXISTS collection_items (
  collection_id INTEGER NOT NULL, item_id INTEGER NOT NULL, PRIMARY KEY (collection_id, item_id)
);
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  -- keyword = 从论文关键词/领域自动生成的标签；manual = 用户手动加的标签
  kind TEXT NOT NULL DEFAULT 'keyword',
  color TEXT
);
CREATE TABLE IF NOT EXISTS item_tags (
  item_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_items_group ON items(group_name, date_added DESC);
CREATE INDEX IF NOT EXISTS idx_items_date_added ON items(date_added DESC);

-- ============ 统一 ID 层 ============
CREATE TABLE IF NOT EXISTS works (
  id          INTEGER PRIMARY KEY,
  doi         TEXT UNIQUE,
  openalex_id TEXT,
  s2_paper_id TEXT,
  title       TEXT,
  year        INTEGER
);
CREATE TABLE IF NOT EXISTS item_works (
  item_id INTEGER NOT NULL, work_id INTEGER NOT NULL, PRIMARY KEY (item_id, work_id)
);

CREATE TABLE IF NOT EXISTS citations (
  id             INTEGER PRIMARY KEY,
  source_item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  target_work_id INTEGER REFERENCES works(id),
  target_raw     TEXT,
  ref_index      INTEGER,
  resolved       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cit_source ON citations(source_item_id);

CREATE TABLE IF NOT EXISTS citation_contexts (
  id            INTEGER PRIMARY KEY,
  citation_id   INTEGER NOT NULL REFERENCES citations(id) ON DELETE CASCADE,
  attachment_id INTEGER,
  page_index    INTEGER,
  rect          TEXT,
  text          TEXT
);

-- ============ 全文分块 (FTS / RAG) ============
CREATE TABLE IF NOT EXISTS chunks (
  id            INTEGER PRIMARY KEY,
  attachment_id INTEGER NOT NULL,
  page_index    INTEGER,
  section       TEXT,
  bbox          TEXT,
  text          TEXT NOT NULL,
  -- PD40 证据字段：模块级定位（module_id + 模块正文 UTF-16 字符区间）与内容指纹。
  -- module_id 为 NULL 表示该块只有页级定位；content_hash 是归一化正文的 sha256，
  -- 属「内容指纹」而非语义哈希，与 evidence_links.content_hash 口径不同。
  module_id     TEXT,
  char_start    INTEGER,
  char_end      INTEGER,
  content_hash  TEXT
);

-- ============ 分块向量（语义检索） ============
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id   INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- ============ API 缓存 ============
CREATE TABLE IF NOT EXISTS api_cache (
  cache_key TEXT PRIMARY KEY, body TEXT, etag TEXT, expires_at INTEGER
);

-- ============ 译文（保版式翻译产物） ============
CREATE TABLE IF NOT EXISTS translations (
  id            INTEGER PRIMARY KEY,
  key           TEXT UNIQUE NOT NULL,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  lang          TEXT NOT NULL,
  path          TEXT NOT NULL,
  html_path     TEXT,
  bilingual_path TEXT,
  md_path       TEXT,
  bilingual_md_path TEXT,
  engine        TEXT,
  backend       TEXT,
  status        TEXT NOT NULL DEFAULT 'done',
  qa            TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  date_added    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_translations_att ON translations(attachment_id, lang);

-- ============ 批处理 ============
CREATE TABLE IF NOT EXISTS batch_jobs (
  id            INTEGER PRIMARY KEY,
  key           TEXT UNIQUE NOT NULL,
  -- PD43：一次批处理（含它的重试/追加作业）共享一个批次标识，用于「一次批处理 = 一个提案批次」
  batch_run_id  TEXT NOT NULL DEFAULT '',
  task          TEXT NOT NULL,
  title         TEXT NOT NULL,
  params        TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'queued',
  off_peak_only INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  done          INTEGER NOT NULL DEFAULT 0,
  message       TEXT,
  out_dir       TEXT,
  error         TEXT,
  date_created  TEXT NOT NULL,
  date_started  TEXT,
  date_finished TEXT
);
CREATE TABLE IF NOT EXISTS batch_items (
  id            INTEGER PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES batch_jobs(id) ON DELETE CASCADE,
  item_id       INTEGER,
  attachment_id INTEGER,
  label         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  output        TEXT,
  message       TEXT
);
CREATE INDEX IF NOT EXISTS idx_batch_items_job ON batch_items(job_id);
-- batch_run_id 的索引不在这里建：老库的 batch_jobs 表存在但没有该列，
-- 而 migrate 的 ALTER 在 db.exec(schema) 之后才执行，会报 no such column。
-- 该索引由 migrate.ts 的 POST_COLUMN_INDEXES 在补列之后创建。

-- ============ 应用设置 ============
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ============ 全文检索 (FTS5, 外部内容表) ============
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, abstract,
  content='items', content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, abstract) VALUES (new.id, new.title, new.abstract);
END;
CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, abstract) VALUES ('delete', old.id, old.title, old.abstract);
END;
CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, abstract) VALUES ('delete', old.id, old.title, old.abstract);
  INSERT INTO items_fts(rowid, title, abstract) VALUES (new.id, new.title, new.abstract);
END;

-- 全文分块索引（供检索 / RAG）
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

-- 笔记全文索引（独立表；rowid = notes.id，正文由应用层在保存时同步）
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, body, tokenize='unicode61'
);

-- 译文全文索引（独立表；rowid = translations.id，正文由应用层写入译文 Markdown）
CREATE VIRTUAL TABLE IF NOT EXISTS translations_fts USING fts5(
  title, body, tokenize='unicode61'
);

-- 论文结构化模块层缓存（按附件保存；避免每次打开/点击引用重复解析）
-- file_key = "<mtimeMs>:<size>"，文件变化时自动失效
CREATE TABLE IF NOT EXISTS paper_modules (
  attachment_id INTEGER PRIMARY KEY,
  doc_json TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  file_key TEXT,
  document_fingerprint TEXT,
  extractor_version TEXT,
  config_hash TEXT,
  ocr_model_version TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- AI 问答：对话历史（标题可由模型生成；记录对应的论文与「第一份附件」）
CREATE TABLE IF NOT EXISTS ai_conversations (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  item_id INTEGER,
  attachment_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  citations_json TEXT,
  -- 阶段一：该轮提问附带的选区上下文（AskSelection JSON：完整原文/附件/页码），可为空
  context_json TEXT,
  sort_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_messages_conv ON ai_messages(conversation_id, sort_index);

-- 公式明细表：逐公式查询/统计/回溯的**唯一数据源**（doc_json 只保留文档视图，不再镜像公式）
CREATE TABLE IF NOT EXISTS document_formulas (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL,
  page_number INTEGER NOT NULL,
  bbox TEXT,
  formula_order INTEGER NOT NULL DEFAULT 0,
  raw_text TEXT,
  latex TEXT,
  latex_source TEXT,
  structure_json TEXT,
  detection_confidence REAL,
  reconstruction_confidence REAL,
  status TEXT,
  extractor_version TEXT,
  selected_text TEXT,
  selected_source TEXT,
  fallback_reason TEXT,
  validation_results TEXT,
  engine_version TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS document_formulas_order
  ON document_formulas(document_id, formula_order);

-- ============ 知识库（PD33 阶段 1a：条目/关系/证据/版本 + 提案批次/提案/审核） ============
-- 写权限边界（docs/KNOWLEDGE-DESIGN.md §8.4）：
--   * AI 只能往 proposal_batches / knowledge_proposals 写「提案」，证据草案存放在
--     knowledge_proposals.patch_json.evidence 里；
--   * knowledge_entries / knowledge_versions / evidence_links 只由
--     services/knowledge.ts::publishBatch 在**用户触发**的单个事务里写；
--   * 本阶段刻意不建 knowledge FTS/触发器：未审核提案与未发布草稿永不进入检索。
-- 内容性质（content_nature）与审核状态（status）、来源可信度（verification）分开存，
-- 不合并成一个状态字段。
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id             INTEGER PRIMARY KEY,
  key            TEXT UNIQUE NOT NULL,
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  content_nature TEXT NOT NULL,
  item_id        INTEGER REFERENCES items(id) ON DELETE SET NULL,
  attachment_id  INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  source_type    TEXT NOT NULL,
  source_ref     TEXT NOT NULL DEFAULT '{}',
  content_hash   TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  state          TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_entries_item ON knowledge_entries(item_id);
CREATE INDEX IF NOT EXISTS knowledge_entries_state ON knowledge_entries(state, kind);

CREATE TABLE IF NOT EXISTS proposal_batches (
  id               INTEGER PRIMARY KEY,
  key              TEXT UNIQUE NOT NULL,
  title            TEXT NOT NULL,
  task             TEXT NOT NULL,
  scope_type       TEXT NOT NULL DEFAULT 'library',
  scope_ref        TEXT,
  status           TEXT NOT NULL DEFAULT 'draft',
  origin           TEXT NOT NULL DEFAULT 'user',
  ai_config_ref    TEXT,
  workflow_version TEXT,
  skill_version    TEXT,
  idempotency_key  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS proposal_batches_idem ON proposal_batches(idempotency_key);
CREATE INDEX IF NOT EXISTS proposal_batches_status ON proposal_batches(status, created_at);

CREATE TABLE IF NOT EXISTS knowledge_proposals (
  id              INTEGER PRIMARY KEY,
  key             TEXT UNIQUE NOT NULL,
  batch_id        INTEGER NOT NULL REFERENCES proposal_batches(id) ON DELETE CASCADE,
  item_id         INTEGER REFERENCES items(id) ON DELETE SET NULL,
  op              TEXT NOT NULL,
  target_entry_id INTEGER REFERENCES knowledge_entries(id) ON DELETE SET NULL,
  target_key      TEXT,
  base_version    INTEGER,
  patch_json      TEXT NOT NULL,
  before_json     TEXT,
  reason          TEXT NOT NULL DEFAULT '',
  content_nature  TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  source_ref      TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending_review',
  verification    TEXT NOT NULL DEFAULT 'pending',
  checks_json     TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL,
  published_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_proposals_idem ON knowledge_proposals(idempotency_key);
CREATE INDEX IF NOT EXISTS knowledge_proposals_batch ON knowledge_proposals(batch_id, status);
CREATE INDEX IF NOT EXISTS knowledge_proposals_item ON knowledge_proposals(item_id, status);
CREATE INDEX IF NOT EXISTS knowledge_proposals_target ON knowledge_proposals(target_entry_id);

CREATE TABLE IF NOT EXISTS knowledge_versions (
  id            INTEGER PRIMARY KEY,
  entry_id      INTEGER NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  change_reason TEXT NOT NULL DEFAULT '',
  proposal_id   INTEGER REFERENCES knowledge_proposals(id) ON DELETE SET NULL,
  created_by    TEXT NOT NULL DEFAULT 'user',
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_versions_entry_version
  ON knowledge_versions(entry_id, version);
-- 一条提案最多产生一个版本：重复发布不会重复写版本
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_versions_proposal ON knowledge_versions(proposal_id);

CREATE TABLE IF NOT EXISTS evidence_links (
  id            INTEGER PRIMARY KEY,
  entry_id      INTEGER NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  proposal_id   INTEGER REFERENCES knowledge_proposals(id) ON DELETE SET NULL,
  source_type   TEXT NOT NULL,
  source_ref    TEXT NOT NULL DEFAULT '{}',
  item_id       INTEGER,
  attachment_id INTEGER,
  page_index    INTEGER,
  page_end      INTEGER,
  module_id     TEXT,
  rect          TEXT,
  char_start    INTEGER,
  char_end      INTEGER,
  quote         TEXT NOT NULL,
  section_path  TEXT,
  precision     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  verified      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_links_entry ON evidence_links(entry_id);
CREATE INDEX IF NOT EXISTS evidence_links_proposal ON evidence_links(proposal_id);

CREATE TABLE IF NOT EXISTS knowledge_relations (
  id            INTEGER PRIMARY KEY,
  from_entry_id INTEGER NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  to_entry_id   INTEGER NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  source_type   TEXT NOT NULL DEFAULT 'user',
  source_ref    TEXT NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_relations_unique
  ON knowledge_relations(from_entry_id, to_entry_id, relation_type);

CREATE TABLE IF NOT EXISTS proposal_reviews (
  id                INTEGER PRIMARY KEY,
  proposal_id       INTEGER NOT NULL REFERENCES knowledge_proposals(id) ON DELETE CASCADE,
  action            TEXT NOT NULL,
  edited_patch_json TEXT,
  reason            TEXT NOT NULL DEFAULT '',
  reviewer          TEXT NOT NULL DEFAULT 'user',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposal_reviews_proposal
  ON proposal_reviews(proposal_id, created_at);

CREATE TABLE IF NOT EXISTS organize_versions (
  id         INTEGER PRIMARY KEY,
  scope_key  TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  target     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_organize_versions_scope
  ON organize_versions(scope_key, created_at);
