import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import { resolveDataDir } from './paths'
import { migrate } from './migrate'
import { migrateKnowledgeBackfill, type ChunkEvidenceDb } from '../services/knowledge-index'
import { configureBackupBackend, type SqliteProbe } from '../services/backup'
import schema from './schema.sql?raw'

let db: Database.Database | null = null

/** 用户数据根目录：<userData>/data（可用 PAPERDESK_DATA 覆盖，测试隔离用） */
export function getDataDir(): string {
  const dir = resolveDataDir(app.getPath('userData'))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 打开（并按需初始化）数据库，单例 */
export function initDb(): Database.Database {
  if (db) return db
  const file = join(getDataDir(), 'library.sqlite')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(schema)
  migrate(db)
  // 老库的 tags 表在 migrate 之后才有 kind 列，索引必须放到迁移后创建
  db.exec('CREATE INDEX IF NOT EXISTS idx_tags_kind ON tags(kind)')
  // PD40：历史 chunks 的模块级证据回填。失败只降级告警，不阻止启动。
  try {
    const backfill = migrateKnowledgeBackfill(db as unknown as ChunkEvidenceDb, {
      warn: (message, error) => console.warn(message, error)
    })
    if (backfill.status === 'degraded') {
      console.warn('[paperdesk] knowledge backfill degraded:', backfill.errors.join('; '))
    }
  } catch (e) {
    console.warn('[paperdesk] knowledge backfill failed (degraded, startup continues):', e)
  }
  return db
}

/** 轻量迁移：老库缺列时补上（CREATE TABLE IF NOT EXISTS 不会加列） */
export function getDb(): Database.Database {
  if (!db) throw new Error('DB 未初始化，请先调用 initDb()')
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

/** 只读打开一个 SQLite 文件用于恢复前校验（不写入、不建 WAL） */
function openReadonlyProbe(file: string): SqliteProbe {
  const probe = new Database(file, { readonly: true, fileMustExist: true })
  return {
    prepare(sql: string) {
      const statement = probe.prepare(sql)
      const all = statement.all.bind(statement) as (...params: unknown[]) => unknown[]
      return { all: (...params: unknown[]) => all(...params) }
    },
    close: () => probe.close()
  }
}

/**
 * 把真实数据库实现注入备份服务（backup.ts 本身不 import electron / better-sqlite3，
 * 以便单元测试用 node:sqlite 直接验证恢复失败路径）。
 */
configureBackupBackend({
  dataDir: getDataDir,
  snapshotLive(dest) {
    initDb().exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  },
  backupLive(dest) {
    return initDb().backup(dest)
  },
  openProbe: openReadonlyProbe,
  close: closeDb,
  init: () => {
    initDb()
  }
})
