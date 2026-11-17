import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { getDataDir, getDb } from '../db'
import type { Item } from '../../shared/types'

/** 计算某条目「空间」目录（相对 data/）：顶层 spaces/<key>；子条目归入父空间 children/ 下 */
export function computeSpaceRel(key: string, parentSpaceRel?: string | null): string {
  return parentSpaceRel ? `${parentSpaceRel}/children/${key}` : `spaces/${key}`
}

export function spaceAbs(rel: string): string {
  return join(getDataDir(), ...rel.split('/'))
}

export function ensureSpace(rel: string): string {
  const abs = spaceAbs(rel)
  mkdirSync(abs, { recursive: true })
  return abs
}

/** 删除空间目录（含子条目），容错 */
export function removeSpace(rel: string | null | undefined): void {
  if (!rel) return
  try {
    rmSync(spaceAbs(rel), { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

const mdEscape = (s: string): string => s.replace(/[[\]]/g, '')

const toPosix = (p: string): string => p.split(sep).join('/')

/** 计算条目空间相对路径（已存则用，否则按父空间推导并回写） */
function resolveSpaceRel(item: Item): string {
  if (item.space_path) return item.space_path
  const db = getDb()
  let rel = computeSpaceRel(item.key, null)
  if (item.parent_id) {
    const parent = db.prepare('SELECT * FROM items WHERE id = ?').get(item.parent_id) as
      | Item
      | undefined
    if (parent) rel = computeSpaceRel(item.key, resolveSpaceRel(parent))
  }
  db.prepare('UPDATE items SET space_path = ? WHERE id = ?').run(rel, item.id)
  return rel
}

/**
 * 刷新条目的空间：创建目录并写入 `item.md`（元数据 / DOI / 摘要 / 参考文献 / 子条目 / 笔记）。
 */
export function refreshSpaceIndex(itemId: number): string | null {
  const db = getDb()
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Item | undefined
  if (!item) return null
  const rel = resolveSpaceRel(item)

  const authors = db
    .prepare(
      `SELECT a.display_name AS name FROM item_authors ia
       JOIN authors a ON a.id = ia.author_id WHERE ia.item_id = ? ORDER BY ia.position`
    )
    .all(itemId) as Array<{ name: string }>
  const refs = db
    .prepare(
      `SELECT c.ref_index AS refIndex, c.target_raw AS raw, w.doi AS doi, w.title AS title
       FROM citations c LEFT JOIN works w ON w.id = c.target_work_id
       WHERE c.source_item_id = ? ORDER BY c.ref_index LIMIT 80`
    )
    .all(itemId) as Array<{ refIndex: number | null; raw: string | null; doi: string | null; title: string | null }>
  const children = db
    .prepare('SELECT * FROM items WHERE parent_id = ? ORDER BY id')
    .all(itemId) as Item[]
  const notes = db
    .prepare('SELECT title, md_path FROM notes WHERE item_id = ? ORDER BY id')
    .all(itemId) as Array<{ title: string | null; md_path: string | null }>

  const spaceRoot = spaceAbs(rel)
  const linkTo = (abs: string): string => toPosix(relative(spaceRoot, abs))

  const lines: string[] = []
  lines.push(`# ${item.title ?? '未命名'}`)
  lines.push('')
  lines.push(`- key: \`${item.key}\``)
  if (item.doi) lines.push(`- DOI: [${item.doi}](https://doi.org/${item.doi})`)
  if (item.year != null) lines.push(`- 年份: ${item.year}`)
  if (item.venue) lines.push(`- 来源: ${item.venue}`)
  if (authors.length) lines.push(`- 作者: ${authors.map((a) => a.name).join(', ')}`)
  if (item.abstract) {
    lines.push('')
    lines.push('## 摘要')
    lines.push('')
    lines.push(item.abstract)
  }
  if (refs.length) {
    lines.push('')
    lines.push(`## 参考文献（${refs.length}）`)
    lines.push('')
    refs.forEach((r, i) => {
      const label = r.title ?? r.raw ?? '(空)'
      const doi = r.doi ? ` — https://doi.org/${r.doi}` : ''
      lines.push(`${r.refIndex ?? i + 1}. ${mdEscape(label)}${doi}`)
    })
  }
  if (children.length) {
    lines.push('')
    lines.push(`## 衍生论文（${children.length}）`)
    lines.push('')
    for (const c of children) {
      const childRel = c.space_path ?? computeSpaceRel(c.key, rel)
      const link = linkTo(join(spaceAbs(childRel), 'item.md'))
      lines.push(`- [${mdEscape(c.title ?? c.key)}](${link})${c.year ? ` (${c.year})` : ''}`)
    }
  }
  if (notes.length) {
    lines.push('')
    lines.push('## 笔记')
    lines.push('')
    for (const n of notes) {
      const file = (n.md_path ?? '').split('/').pop() ?? ''
      const link = linkTo(join(getDataDir(), 'notes', file))
      lines.push(`- [${mdEscape(n.title ?? '笔记')}](${link})`)
    }
  }
  lines.push('')

  ensureSpace(rel)
  try {
    writeFileSync(join(spaceRoot, 'item.md'), lines.join('\n'), 'utf8')
  } catch {
    /* 忽略写入失败 */
  }
  return rel
}

export function refreshAllSpaceIndexes(): void {
  const ids = getDb().prepare('SELECT id FROM items').all() as Array<{ id: number }>
  for (const { id } of ids) refreshSpaceIndex(id)
}
