import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getDataDir, getDb } from '../../db'
import { safeBatchStem } from '../../../shared/batch-filename'

const ANALYSIS_EXT = '.analysis.md'

/** 在输出目录内取一个不冲突的 `<stem> (n)<ext>` 名称。 */
export function uniqueBatchOutput(
  dir: string,
  stem: string,
  ext: string,
  reserved: Set<string> = new Set()
): string {
  const base = safeBatchStem(stem)
  let name = `${base}${ext}`
  let n = 2
  while (reserved.has(name) || existsSync(join(dir, name))) {
    name = `${base} (${n})${ext}`
    n += 1
  }
  reserved.add(name)
  return name
}

/**
 * 旧版本用附件 key 命名拆解报告（如 `TD6GICAG.analysis.md`）。
 * 这里在读取作业列表时幂等迁移成论文标题名，并同步 batch_items.output 与 index.md。
 */
export function migrateAnalysisFilenames(): void {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT bi.id AS item_row_id, bi.output, bj.out_dir, bj.id AS job_id,
              i.title AS item_title, a.key AS attachment_key
         FROM batch_items bi
         JOIN batch_jobs bj ON bj.id = bi.job_id
         LEFT JOIN items i ON i.id = bi.item_id
         LEFT JOIN attachments a ON a.id = bi.attachment_id
        WHERE bi.output IS NOT NULL
          AND bj.task IN ('analyze-paper', 'translate-analyze')
          AND bj.status IN ('done', 'failed', 'cancelled')
        ORDER BY bi.id`
    )
    .all() as Array<{
    item_row_id: number
    output: string | null
    out_dir: string
    job_id: number
    item_title: string | null
    attachment_key: string | null
  }>

  const reservedByDir = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!row.out_dir) continue
    let files: string[]
    try {
      const parsed = JSON.parse(row.output || '[]') as unknown
      if (!Array.isArray(parsed)) continue
      files = parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      continue
    }
    const dir = resolveOutDir(row.out_dir, files)
    if (!dir) continue
    if (dir !== row.out_dir) {
      db.prepare('UPDATE batch_jobs SET out_dir = ? WHERE id = ?').run(dir, row.job_id)
    }
    const title = row.item_title || row.attachment_key || '未命名论文'
    const reserved = reservedByDir.get(dir) ?? new Set<string>()
    let changed = false
    const next = files.map((oldName) => {
      if (!oldName.endsWith(ANALYSIS_EXT)) return oldName
      const oldPath = join(dir, oldName)
      if (!existsSync(oldPath)) return oldName
      const desired = `${safeBatchStem(title)}${ANALYSIS_EXT}`
      if (oldName === desired) {
        reserved.add(desired)
        return oldName
      }
      const newName = uniqueBatchOutput(dir, title, ANALYSIS_EXT, reserved)
      if (newName === oldName) return oldName
      const newPath = join(dir, newName)
      renameSync(oldPath, newPath)
      rewriteIndexLink(dir, oldName, newName)
      changed = true
      return newName
    })
    reservedByDir.set(dir, reserved)
    if (changed) {
      db.prepare('UPDATE batch_items SET output = ? WHERE id = ?').run(
        JSON.stringify(next),
        row.item_row_id
      )
    }
  }
}

/**
 * 旧数据库可能保存了另一台机器/另一份数据目录的绝对 out_dir
 * （例如测试 profile 复制了正式库）。优先原路径，缺失时回退到当前数据目录下的同名批次。
 */
function resolveOutDir(stored: string, files: string[]): string | null {
  const candidates = [stored]
  try {
    candidates.push(join(getDataDir(), 'batch', basename(stored)))
  } catch {
    /* getDataDir 在极早期可能不可用 */
  }
  for (const dir of candidates) {
    if (files.some((name) => existsSync(join(dir, name)))) return dir
  }
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  return null
}

function rewriteIndexLink(dir: string, oldName: string, newName: string): void {
  const indexPath = join(dir, 'index.md')
  if (!existsSync(indexPath)) return
  try {
    const body = readFileSync(indexPath, 'utf8')
    const next = body
      .split(`\`${oldName}\``)
      .join(`\`${newName}\``)
      .split(`](${oldName})`)
      .join(`](${newName})`)
    if (next !== body) writeFileSync(indexPath, next, 'utf8')
  } catch {
    /* 索引不可写不影响报告本体 */
  }
}
