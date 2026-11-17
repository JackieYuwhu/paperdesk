/**
 * 轻量列迁移：老库缺列时补上（`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列）。
 *
 * 这里只依赖一个**结构化最小接口**（不 import better-sqlite3 / electron），
 * 因此可被零依赖单元测试直接验证——这是「旧库升级不丢数据」的回归保护。
 */

export interface MigrationDb {
  prepare(sql: string): { all(): unknown[] }
  exec(sql: string): void
}

export interface ColumnMigration {
  table: string
  column: string
  ddl: string
}

/** 需要保证存在的列（顺序即执行顺序） */
export const COLUMN_MIGRATIONS: ColumnMigration[] = [
  { table: 'translations', column: 'html_path', ddl: 'TEXT' },
  { table: 'translations', column: 'bilingual_path', ddl: 'TEXT' },
  { table: 'translations', column: 'md_path', ddl: 'TEXT' },
  { table: 'translations', column: 'bilingual_md_path', ddl: 'TEXT' },
  { table: 'translations', column: 'qa', ddl: 'TEXT' },
  { table: 'translations', column: 'pinned', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'items', column: 'parent_id', ddl: 'INTEGER' },
  { table: 'items', column: 'space_path', ddl: 'TEXT' },
  { table: 'items', column: 'domain', ddl: 'TEXT' },
  // 文库分组（NULL = 未分组）；老库升级时补齐
  { table: 'items', column: 'group_name', ddl: 'TEXT' },
  // 多层分组：介绍 + 修改时间；老库的 library_groups 只有创建时间
  { table: 'library_groups', column: 'date_modified', ddl: 'TEXT' },
  { table: 'library_groups', column: 'description', ddl: 'TEXT' },
  // 分组同层手动顺序；老库补列后由 BACKFILLS 给出稳定初始顺序
  { table: 'library_groups', column: 'sort_order', ddl: 'INTEGER' },
  // 手动标签与自动关键词分开，避免分组/标签互相覆盖
  { table: 'tags', column: 'kind', ddl: "TEXT NOT NULL DEFAULT 'keyword'" },
  { table: 'tags', column: 'color', ddl: 'TEXT' },
  // 版本失效：命中缓存需同时校验 内容指纹 / 提取器版本 / 配置哈希 / OCR 模型版本
  { table: 'paper_modules', column: 'document_fingerprint', ddl: 'TEXT' },
  { table: 'paper_modules', column: 'extractor_version', ddl: 'TEXT' },
  { table: 'paper_modules', column: 'config_hash', ddl: 'TEXT' },
  { table: 'paper_modules', column: 'ocr_model_version', ddl: 'TEXT' },
  { table: 'paper_modules', column: 'stale', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  // 公式结果来源与验证（低置信度回退为「候选」，不覆盖原文）
  { table: 'document_formulas', column: 'selected_text', ddl: 'TEXT' },
  { table: 'document_formulas', column: 'selected_source', ddl: 'TEXT' },
  { table: 'document_formulas', column: 'fallback_reason', ddl: 'TEXT' },
  { table: 'document_formulas', column: 'validation_results', ddl: 'TEXT' },
  { table: 'document_formulas', column: 'engine_version', ddl: 'TEXT' },
  // PD40 证据字段：历史 chunks 缺列时原地补齐（可空；回填由 migrateKnowledgeBackfill 负责）
  { table: 'chunks', column: 'module_id', ddl: 'TEXT' },
  { table: 'chunks', column: 'char_start', ddl: 'INTEGER' },
  { table: 'chunks', column: 'char_end', ddl: 'INTEGER' },
  { table: 'chunks', column: 'content_hash', ddl: 'TEXT' },
  // PD43 批次标识：一次批处理里的所有作业（含重试/追加）共享；老库用 key 兜底回填
  { table: 'batch_jobs', column: 'batch_run_id', ddl: "TEXT NOT NULL DEFAULT ''" },
  // 阶段一：提问时附带的选区上下文（完整原文 + 附件 + 页码），跨轮/重启后「翻译上面这段」仍可用
  { table: 'ai_messages', column: 'context_json', ddl: 'TEXT' },
  // 论文详情：完整发表信息（类型/期刊/会议/预印本/卷期页…）；老库保留 venue，读时按 JSON 还原
  { table: 'items', column: 'publication_json', ddl: 'TEXT' },
  // 论文详情：被引记录来源与状态（手动查询结果落地，详情页只读本地，不自动联网）
  { table: 'item_citations', column: 'last_attempt_at', ddl: 'TEXT' },
  { table: 'item_citations', column: 'candidates_json', ddl: 'TEXT' },
  { table: 'item_citations', column: 'matched_title', ddl: 'TEXT' },
  { table: 'item_citations', column: 'matched_id', ddl: 'TEXT' }
]

/** 列补齐后的历史数据回填（纯 SQL，可重复执行；表不存在时跳过） */
export const BACKFILLS: Array<{ table: string; sql: string }> = [
  {
    table: 'batch_jobs',
    // 老库的每个作业自成一批：用作业 key 兜底，避免升级后不同旧作业被合并进同一提案批次
    sql: "UPDATE batch_jobs SET batch_run_id = \"key\" WHERE batch_run_id IS NULL OR batch_run_id = ''"
  },
  {
    table: 'library_groups',
    // 老库没有顺序列：按同层（parent_name 相同，含根层 NULL）+ 名称字典序补一个稳定初始顺序
    sql:
      'UPDATE library_groups SET sort_order = 1 + (SELECT COUNT(*) FROM library_groups s ' +
      'WHERE s.parent_name IS library_groups.parent_name AND s.name < library_groups.name) ' +
      'WHERE sort_order IS NULL'
  }
]

/**
 * 依赖新增列的索引：必须在 COLUMN_MIGRATIONS 之后执行。
 * 老库 `batch_jobs` 表已存在但没有 `batch_run_id`，若把该索引写在 schema.sql 里，
 * `db.exec(schema)` 阶段就会抛 `SqliteError: no such column: batch_run_id`（PD43 实测）。
 */
export const POST_COLUMN_INDEXES: Array<{ name: string; table: string; column: string }> = [
  { name: 'idx_batch_jobs_run', table: 'batch_jobs', column: 'batch_run_id' }
]

export interface MigrationLog {
  info?: (message: string) => void
  warn?: (message: string, error: unknown) => void
}

/** 执行迁移。单个列失败只告警、不中断（与历史行为一致）。 */
export function migrate(d: MigrationDb, log: MigrationLog = {}): void {
  const info = log.info ?? ((m: string): void => console.log(m))
  const warn = log.warn ?? ((m: string, e: unknown): void => console.warn(m, e))
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    try {
      const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      // 表不存在（cols 为空）时不动——建表由 schema.sql 负责
      if (cols.length > 0 && !cols.some((c) => c.name === column)) {
        d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
        info(`[paperdesk] migrated: ${table}.${column}`)
      }
    } catch (e) {
      warn(`[paperdesk] migrate ${table}.${column} failed:`, e)
    }
  }
  for (const { table, sql } of BACKFILLS) {
    try {
      const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (cols.length === 0) continue
      d.exec(sql)
    } catch (e) {
      warn(`[paperdesk] migrate backfill ${table} failed:`, e)
    }
  }
  // 只能在本轮补列之后创建的索引：老库的表已存在但没有新列，
  // 若放在 schema.sql 里会在 db.exec(schema) 阶段就报 no such column。
  for (const { name, table, column } of POST_COLUMN_INDEXES) {
    try {
      const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === column)) continue
      d.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${column})`)
    } catch (e) {
      warn(`[paperdesk] migrate index ${name} failed:`, e)
    }
  }
}
