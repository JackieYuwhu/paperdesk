import { getDb } from '../db'
import type { LibraryTag } from '../../shared/types'

const MAX_NAME = 24
const MAX_PER_ITEM = 8

/** 规范化用户输入：去空白、去重、限长、限量 */
export function normalizeTagNames(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const name = String(item ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_NAME)
    if (!name) continue
    const key = name.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= MAX_PER_ITEM) break
  }
  return out
}

/** 文库手动标签（按使用次数倒序） */
export function listLibraryTags(kind = 'manual'): LibraryTag[] {
  return getDb()
    .prepare(
      `SELECT t.id, t.name, t.kind, COUNT(DISTINCT it.item_id) AS count
         FROM tags t
         LEFT JOIN item_tags it ON it.tag_id = t.id
        WHERE t.kind = ?
        GROUP BY t.id, t.name, t.kind
        ORDER BY count DESC, t.name COLLATE NOCASE`
    )
    .all(kind) as LibraryTag[]
}

export function tagsForItem(itemId: number): string[] {
  return (
    getDb()
      .prepare(
        `SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
          WHERE it.item_id = ? AND t.kind = 'manual'
          ORDER BY t.name COLLATE NOCASE`
      )
      .all(itemId) as Array<{ name: string }>
  ).map((r) => r.name)
}

/** 批量取标签，避免文库列表 N+1 查询 */
export function tagsForItems(itemIds: number[]): Record<number, string[]> {
  const ids = [...new Set(itemIds.filter((id) => Number.isInteger(id) && id > 0))]
  const out: Record<number, string[]> = {}
  if (ids.length === 0) return out
  const marks = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT it.item_id, t.name
         FROM item_tags it JOIN tags t ON t.id = it.tag_id
        WHERE it.item_id IN (${marks}) AND t.kind = 'manual'
        ORDER BY t.name COLLATE NOCASE`
    )
    .all(...ids) as Array<{ item_id: number; name: string }>
  for (const row of rows) (out[row.item_id] ??= []).push(row.name)
  return out
}

/** 替换某个条目的手动标签；keyword 标签（领域/关键词）保持不动 */
export function setItemTags(itemId: number, raw: unknown): string[] {
  const db = getDb()
  const names = normalizeTagNames(raw)
  const item = db.prepare('SELECT id FROM items WHERE id = ?').get(itemId)
  if (!item) throw new Error('条目不存在')
  const tx = db.transaction((): void => {
    db.prepare(
      `DELETE FROM item_tags
        WHERE item_id = ?
          AND tag_id IN (SELECT id FROM tags WHERE kind = 'manual')`
    ).run(itemId)
    const upsert = db.prepare(
      `INSERT INTO tags (name, kind) VALUES (?, 'manual')
       ON CONFLICT(name) DO NOTHING`
    )
    const find = db.prepare('SELECT id FROM tags WHERE name = ?')
    const attach = db.prepare(
      'INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)'
    )
    for (const name of names) {
      upsert.run(name)
      const tag = find.get(name) as { id: number } | undefined
      if (tag) attach.run(itemId, tag.id)
    }
    db.prepare('UPDATE items SET date_modified = ? WHERE id = ?').run(
      new Date().toISOString(),
      itemId
    )
  })
  tx()
  return tagsForItem(itemId)
}

/** 标签范围内的条目 id（用于批处理 scope=tag） */
export function itemIdsForTag(raw: unknown): number[] {
  const name = String(raw ?? '').trim()
  if (!name) return []
  return (
    getDb()
      .prepare(
        `SELECT i.id FROM items i
           JOIN item_tags it ON it.item_id = i.id
           JOIN tags t ON t.id = it.tag_id
          WHERE t.name = ? AND t.kind = 'manual'
          ORDER BY i.date_added DESC, i.id DESC`
      )
      .all(name) as Array<{ id: number }>
  ).map((r) => r.id)
}
