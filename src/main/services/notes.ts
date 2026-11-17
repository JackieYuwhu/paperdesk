import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { getDataDir, getDb } from '../db'
import { generateKey } from '../db/keys'
import type { Note } from '../../shared/types'
import { slugifyHeading } from '../../shared/slug'

/** data/notes/ 目录 */
export function notesDir(): string {
  const dir = join(getDataDir(), 'notes')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 某条笔记的 md 文件绝对路径 */
export function mdPathFor(key: string): string {
  return join(notesDir(), `${key}.md`)
}

/** 笔记文件绝对路径：优先用库里的 md_path（可读文件名），否则回退到 key.md */
export function noteAbsPath(mdPath: string | null | undefined, key: string): string {
  const rel = (mdPath ?? '').trim() || `notes/${key}.md`
  const p = join(getDataDir(), ...rel.split('/'))
  try {
    mkdirSync(dirname(p), { recursive: true })
  } catch {
    /* 忽略：目录已存在或不可创建 */
  }
  return p
}

/** 生成可读的笔记文件名（标题 → 安全文件名）；同名时加 key 短后缀保证唯一 */
export function noteFileName(title: string, key: string): string {
  const base = (title || '阅读笔记')
    .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  const safe = base || '阅读笔记'
  const cand = `notes/${safe}.md`
  if (!existsSync(noteAbsPath(cand, key))) return cand
  return `notes/${safe}-${key.slice(0, 4)}.md`
}

/** 读取笔记正文（按 md_path，回退 key） */
export function readNoteBodyAt(mdPath: string | null | undefined, key: string): string {
  const p = noteAbsPath(mdPath, key)
  if (!existsSync(p)) return ''
  return parseFrontMatter(readFileSync(p, 'utf8')).body
}

/** 写入笔记正文（按 md_path，回退 key） */
export function writeNoteBodyAt(
  mdPath: string | null | undefined,
  key: string,
  body: string
): void {
  writeFileSync(noteAbsPath(mdPath, key), (body ?? '').replace(/^\n+/, ''), 'utf8')
}

/** 删除笔记文件（按 md_path，回退 key） */
export function removeNoteFileAt(mdPath: string | null | undefined, key: string): void {
  const p = noteAbsPath(mdPath, key)
  if (existsSync(p)) rmSync(p, { force: true })
}

export type FrontMatter = Record<string, string>

/** 解析 YAML front-matter（仅支持我们写出的简单 key: value） */
export function parseFrontMatter(raw: string): { meta: FrontMatter; body: string } {
  if (raw.startsWith('---\n')) {
    const end = raw.indexOf('\n---\n', 4)
    if (end > 0) {
      const meta: FrontMatter = {}
      for (const line of raw.slice(4, end).split('\n')) {
        const i = line.indexOf(':')
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      return { meta, body: raw.slice(end + 5) }
    }
  }
  return { meta: {}, body: raw }
}

export function buildFile(meta: FrontMatter, body: string): string {
  const lines = Object.entries(meta).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`
}

/** 读取笔记正文（不含 front-matter） */
export function readNoteBody(key: string): string {
  const p = mdPathFor(key)
  if (!existsSync(p)) return ''
  return parseFrontMatter(readFileSync(p, 'utf8')).body
}

/** 写入笔记文件：**纯 Markdown**（不再写 YAML front-matter，元数据只在库里，方便直接用编辑器/黑曜石打开） */
export function writeNoteFile(key: string, _meta: FrontMatter, body: string): void {
  writeFileSync(mdPathFor(key), (body ?? '').replace(/^\n+/, ''), 'utf8')
}

export function removeNoteFile(key: string): void {
  const p = mdPathFor(key)
  if (existsSync(p)) rmSync(p, { force: true })
}

/** 重建 notes_fts（rowid = note.id） */
function reindexNote(id: number, title: string, body: string): void {
  const db = getDb()
  db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(id)
  db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(id, title, body)
}

/** 取（或创建）某条目的笔记 */
/**
 * 论文改名后，把自动生成的「XXX - 阅读笔记」跟着改成新标题；
 * 用户自定义过的笔记标题不动。
 */
function syncAutoNoteTitle(note: Note, itemTitle: string | null): Note {
  if (!note.title) return note
  const auto = note.title === '阅读笔记' || note.title.endsWith(' - 阅读笔记')
  if (!auto) return note
  const desired = itemTitle ? `${itemTitle} - 阅读笔记` : '阅读笔记'
  const mdPath = noteFileName(desired, note.key)
  // 标题已正确、但文件名还是随机 key（旧数据）时也要迁移
  if (note.title === desired && note.md_path === mdPath) return note
  const body = readNoteBodyAt(note.md_path, note.key).replace(/^# .*$/m, `# ${desired}`)
  writeNoteBodyAt(mdPath, note.key, body)
  const oldPath = noteAbsPath(note.md_path, note.key)
  const db = getDb()
  db.prepare('UPDATE notes SET title = ?, md_path = ?, date_modified = ? WHERE id = ?').run(
    desired,
    mdPath,
    new Date().toISOString(),
    note.id
  )
  if (oldPath !== noteAbsPath(mdPath, note.key)) rmSync(oldPath, { force: true })
  reindexNote(note.id, desired, body)
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id) as Note
}

/** 条目标题变化后，同步它自动创建的笔记标题/文件名。 */
export function syncItemNoteTitle(itemId: number): void {
  const db = getDb()
  const note = db
    .prepare('SELECT * FROM notes WHERE item_id = ? ORDER BY id LIMIT 1')
    .get(itemId) as Note | undefined
  if (!note) return
  const item = db.prepare('SELECT title FROM items WHERE id = ?').get(itemId) as
    | { title: string | null }
    | undefined
  syncAutoNoteTitle(note, item?.title ?? null)
}

/** 旧数据迁移：把「论文标题 - 阅读笔记」对应的随机 key 文件名改成可读标题。 */
export function migrateNoteFilenames(): void {
  const rows = getDb()
    .prepare(
      `SELECT n.*, i.title AS item_title
         FROM notes n JOIN items i ON i.id = n.item_id
        ORDER BY n.id`
    )
    .all() as Array<Note & { item_title: string | null }>
  for (const note of rows) {
    try {
      syncAutoNoteTitle(note, note.item_title)
    } catch {
      /* 单条失败不影响启动 */
    }
  }
}

/** 首屏后的文件名整理分批让出主线程；退出时中止，避免数据库关闭后继续访问。 */
export async function migrateNoteFilenamesInBackground(signal: AbortSignal): Promise<void> {
  const rows = getDb().prepare(
    'SELECT n.*, i.title AS item_title FROM notes n JOIN items i ON i.id = n.item_id ORDER BY n.id'
  ).all() as Array<Note & { item_title: string | null }>
  for (let i = 0; i < rows.length; i++) {
    if (signal.aborted) return
    try { syncAutoNoteTitle(rows[i], rows[i].item_title) } catch { /* 单篇失败不影响其余笔记 */ }
    if (i % 20 === 19) await new Promise<void>((resolve) => setTimeout(resolve, 8))
  }
}

function ensureItemNote(itemId: number): Note {
  const db = getDb()
  const existing = db
    .prepare('SELECT * FROM notes WHERE item_id = ? ORDER BY id LIMIT 1')
    .get(itemId) as Note | undefined
  if (existing) {
    const row = db.prepare('SELECT title FROM items WHERE id = ?').get(itemId) as
      | { title: string | null }
      | undefined
    return syncAutoNoteTitle(existing, row?.title ?? null)
  }
  const key = generateKey()
  const ts = new Date().toISOString()
  const item = db.prepare('SELECT title FROM items WHERE id = ?').get(itemId) as
    | { title: string | null }
    | undefined
  const title = item?.title ? `${item.title} - 阅读笔记` : '阅读笔记'
  const mdPath = noteFileName(title, key)
  const res = db
    .prepare(
      'INSERT INTO notes (key, item_id, title, md_path, date_added, date_modified) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(key, itemId, title, mdPath, ts, ts)
  const id = Number(res.lastInsertRowid)
  const body = `# ${title}\n`
  writeNoteBodyAt(mdPath, key, body)
  reindexNote(id, title, body)
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Note
}

/** 把一段 Markdown 追加到某条目的笔记末尾（不存在则创建），返回该笔记 */
export function appendToItemNote(itemId: number, sectionTitle: string, content: string): Note {
  const db = getDb()
  const note = ensureItemNote(itemId)
  const body = readNoteBodyAt(note.md_path, note.key)
  const appended = `${body.replace(/\s*$/, '')}\n\n## ${sectionTitle}\n\n${content.trim()}\n`
  const ts = new Date().toISOString()
  db.prepare('UPDATE notes SET date_modified = ? WHERE id = ?').run(ts, note.id)
  writeNoteBodyAt(note.md_path, note.key, appended)
  reindexNote(note.id, note.title ?? '', appended)
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id) as Note
}

/**
 * 写入或**替换**笔记里的同名小节（用注释标记包住，重复归档不会无限追加）。
 * 不存在同名小节时等价于追加。同时维护顶部的「目录」。
 */
export function upsertSectionInItemNote(
  itemId: number,
  sectionTitle: string,
  content: string
): Note {
  const db = getDb()
  const note = ensureItemNote(itemId)
  const next = upsertSectionInto(readNoteBodyAt(note.md_path, note.key), sectionTitle, content)
  return persistNoteBody(note, next)
}

/** 小节替换的核心（含顶部目录维护） */
function upsertSectionInto(body: string, sectionTitle: string, content: string): string {
  const begin = `<!-- paperdesk:${sectionTitle} -->`
  const end = `<!-- /paperdesk:${sectionTitle} -->`
  const block = `${begin}\n\n## ${sectionTitle}\n\n${content.trim()}\n\n${end}\n`
  const s = body.indexOf(begin)
  let next: string
  if (s >= 0) {
    const e = body.indexOf(end, s)
    const before = body.slice(0, s).replace(/\s*$/, '')
    const after = e >= 0 ? body.slice(e + end.length).replace(/^\s*/, '') : ''
    next = `${before ? before + '\n\n' : ''}${block}${after ? '\n' + after : ''}`
  } else {
    next = `${body.replace(/\s*$/, '')}\n\n${block}`
  }
  return syncToc(next)
}

function persistNoteBody(note: Note, next: string): Note {
  const db = getDb()
  const ts = new Date().toISOString()
  db.prepare('UPDATE notes SET date_modified = ? WHERE id = ?').run(ts, note.id)
  writeNoteBodyAt(note.md_path, note.key, next)
  reindexNote(note.id, note.title ?? '', next)
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id) as Note
}

/** 取（或创建）一篇「独立笔记」（不属于任何论文，item_id 为空），key 固定便于复用 */
function ensureStandaloneNote(key: string, title: string): Note {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM notes WHERE key = ?').get(key) as Note | undefined
  if (existing) return existing
  const ts = new Date().toISOString()
  const res = db
    .prepare(
      'INSERT INTO notes (key, item_id, title, md_path, date_added, date_modified) VALUES (?, NULL, ?, ?, ?, ?)'
    )
    .run(key, title, `notes/${key}.md`, ts, ts)
  const id = Number(res.lastInsertRowid)
  const body = `# ${title}\n`
  writeNoteBodyAt(`notes/${key}.md`, key, body)
  reindexNote(id, title, body)
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Note
}

/**
 * 写入/替换「独立笔记」里的同名小节（用于把批次汇总、拆解索引等沉淀成一篇可长期累积的笔记）。
 * 返回笔记与 md 绝对路径。
 */
export function upsertSectionInStandaloneNote(
  key: string,
  title: string,
  sectionTitle: string,
  content: string
): { note: Note; mdPath: string } {
  const note = ensureStandaloneNote(key, title)
  const next = upsertSectionInto(readNoteBodyAt(note.md_path, note.key), sectionTitle, content)
  const saved = persistNoteBody(note, next)
  return { note: saved, mdPath: noteAbsPath(saved.md_path, saved.key) }
}

/** 读取「独立笔记」里某个小节的内容（不含注释标记与标题行）；不存在返回 '' */
export function readSectionFromStandaloneNote(key: string, sectionTitle: string): string {
  const db = getDb()
  const note = db.prepare('SELECT * FROM notes WHERE key = ?').get(key) as Note | undefined
  if (!note) return ''
  const body = readNoteBodyAt(note.md_path, note.key)
  const begin = `<!-- paperdesk:${sectionTitle} -->`
  const end = `<!-- /paperdesk:${sectionTitle} -->`
  const s = body.indexOf(begin)
  if (s < 0) return ''
  const e = body.indexOf(end, s)
  const inner = e >= 0 ? body.slice(s + begin.length, e) : body.slice(s + begin.length)
  return inner
    .split(/\r?\n/)
    .filter((l) => !/^\s*##\s/.test(l))
    .join('\n')
    .trim()
}

/** 在笔记正文顶部维护一个「目录」小节（列出所有 ## / ### 小节，便于跳转） */
function syncToc(body: string): string {
  const begin = '<!-- paperdesk:toc -->'
  const end = '<!-- /paperdesk:toc -->'
  let b = body
  const s = b.indexOf(begin)
  if (s >= 0) {
    const e = b.indexOf(end, s)
    b = b.slice(0, s) + (e >= 0 ? b.slice(e + end.length) : '')
  }
  b = b.replace(/^\s*\n/, '').replace(/\s*$/, '')
  const heads: { level: number; text: string }[] = []
  for (const line of b.split(/\r?\n/)) {
    const m3 = /^###\s+(.+?)\s*$/.exec(line)
    if (m3) {
      heads.push({ level: 3, text: m3[1].trim() })
      continue
    }
    const m2 = /^##\s+(.+?)\s*$/.exec(line)
    if (m2 && m2[1].trim() !== '目录') heads.push({ level: 2, text: m2[1].trim() })
  }
  if (heads.length === 0) return `${b}\n`
  const toc = [
    begin,
    '',
    '## 目录',
    '',
    ...heads.map((h) => `${h.level === 3 ? '  ' : ''}- [${h.text}](#${slugifyHeading(h.text)})`),
    '',
    end,
    ''
  ].join('\n')
  return `${toc}\n${b}\n`
}
