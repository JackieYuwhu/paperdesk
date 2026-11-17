import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import { getDb } from '../db'
import { generateKey } from '../db/keys'
import {
  readNoteBody,
  removeNoteFile,
  writeNoteFile,
  mdPathFor,
  noteFileName,
  readNoteBodyAt,
  writeNoteBodyAt,
  removeNoteFileAt,
  type FrontMatter
} from '../services/notes'
import type { Annotation, Attachment, Note, NoteWithContent } from '../../shared/types'

const nowIso = (): string => new Date().toISOString()

function noteMeta(note: Note): FrontMatter {
  return {
    key: note.key,
    title: note.title ?? '',
    item_id: note.item_id != null ? String(note.item_id) : '',
    date_added: note.date_added,
    date_modified: note.date_modified
  }
}

function getNoteById(id: number): Note | undefined {
  return getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id) as Note | undefined
}

function createNoteForItem(itemId: number, title?: string): Note {
  const db = getDb()
  const key = generateKey()
  const ts = nowIso()
  const item = db.prepare('SELECT title FROM items WHERE id = ?').get(itemId) as
    | { title: string | null }
    | undefined
  const t = title ?? (item?.title ? `${item.title} - 阅读笔记` : '阅读笔记')
  const mdPath = noteFileName(t, key)
  const res = db
    .prepare(
      'INSERT INTO notes (key, item_id, title, md_path, date_added, date_modified) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(key, itemId, t, mdPath, ts, ts)
  const note = getNoteById(Number(res.lastInsertRowid))!
  const body = `# ${t}\n`
  writeNoteBodyAt(mdPath, key, body)
  reindexNote(note, body)
  return note
}

function ensureItemNote(itemId: number): Note {
  const existing = getDb()
    .prepare('SELECT * FROM notes WHERE item_id = ? ORDER BY id LIMIT 1')
    .get(itemId) as Note | undefined
  return existing ?? createNoteForItem(itemId)
}

function withContent(note: Note): NoteWithContent {
  return { note, content: readNoteBodyAt(note.md_path, note.key) }
}

/** 同步笔记的全文索引（notes_fts 用显式 rowid = note.id） */
function reindexNote(note: Note, body: string): void {
  const db = getDb()
  db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(note.id)
  db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(
    note.id,
    note.title ?? '',
    body ?? ''
  )
}

export function registerNotesHandlers(): void {
  ipcMain.handle(CH.notes.listByItem, (_e, itemId: number): Note[] => {
    return getDb()
      .prepare('SELECT * FROM notes WHERE item_id = ? ORDER BY date_modified DESC')
      .all(itemId) as Note[]
  })

  ipcMain.handle(CH.notes.getForItem, (_e, itemId: number): NoteWithContent | null => {
    const note = getDb()
      .prepare('SELECT * FROM notes WHERE item_id = ? ORDER BY id LIMIT 1')
      .get(itemId) as Note | undefined
    return note ? withContent(note) : null
  })

  ipcMain.handle(CH.notes.getByPath, (_e, path: string): Note | null => {
    const norm = String(path ?? '').replace(/\\/g, '/')
    return (
      (getDb()
        .prepare('SELECT * FROM notes WHERE md_path = ? OR md_path = ?')
        .get(norm, norm.replace(/^data\//, '')) as Note) ?? null
    )
  })

  ipcMain.handle(CH.notes.create, (_e, itemId: number, title?: string): NoteWithContent => {
    return withContent(createNoteForItem(itemId, title))
  })

  ipcMain.handle(CH.notes.save, (_e, id: number, body: string): Note => {
    const note = getNoteById(id)
    if (!note) throw new Error(`笔记不存在: ${id}`)
    const ts = nowIso()
    getDb().prepare('UPDATE notes SET date_modified = ? WHERE id = ?').run(ts, id)
    const updated = getNoteById(id)!
    writeNoteBodyAt(updated.md_path, updated.key, body ?? '')
    reindexNote(updated, body ?? '')
    return updated
  })

  ipcMain.handle(CH.notes.delete, (_e, id: number): void => {
    const note = getNoteById(id)
    if (!note) return
    getDb().prepare('DELETE FROM notes WHERE id = ?').run(id)
    getDb().prepare('DELETE FROM notes_fts WHERE rowid = ?').run(id)
    removeNoteFileAt(note.md_path, note.key)
  })

  // 把某条批注追加进「该条目的笔记」（不存在则创建），并建立双向关联
  ipcMain.handle(
    CH.notes.addAnnotation,
    (_e, itemId: number, annotationId: number): NoteWithContent => {
      const db = getDb()
      const ann = db.prepare('SELECT * FROM annotations WHERE id = ?').get(annotationId) as
        | Annotation
        | undefined
      if (!ann) throw new Error(`批注不存在: ${annotationId}`)
      const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(ann.attachment_id) as
        | Attachment
        | undefined
      if (!att) throw new Error(`附件不存在: ${ann.attachment_id}`)

      const note = ensureItemNote(itemId)
      const page = ann.page_index + 1
      const label = ann.type === 'note' ? '批注' : ann.type === 'underline' ? '下划线' : '高亮'
      const lines: string[] = []
      lines.push(`> **${label}**：${(ann.text ?? '').trim() || '(无文本)'}`)
      if (ann.comment) lines.push(`> ${ann.comment}`)
      lines.push(
        `> — p.${page} [↗ 原文](paperdesk://open?attachment=${encodeURIComponent(
          att.key
        )}&page=${page}&annotation=${encodeURIComponent(ann.key)})`
      )

      const body = readNoteBodyAt(note.md_path, note.key)
      const newBody = `${body.replace(/\s*$/, '')}\n\n${lines.join('\n')}\n`

      const ts = nowIso()
      db.prepare('UPDATE notes SET date_modified = ? WHERE id = ?').run(ts, note.id)
      db.prepare(
        'INSERT OR IGNORE INTO note_annotations (note_id, annotation_id) VALUES (?, ?)'
      ).run(note.id, annotationId)

      const updated = getNoteById(note.id)!
      writeNoteBodyAt(updated.md_path, updated.key, newBody)
      reindexNote(updated, newBody)
      return withContent(updated)
    }
  )
}

export { mdPathFor }
