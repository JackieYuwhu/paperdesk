// 冒烟测试：在 Electron 的 Node 运行时下验证 better-sqlite3 + schema
// 用法: set ELECTRON_RUN_AS_NODE=1 && npx electron scripts/smoke.cjs
const path = require('node:path')
const fs = require('node:fs')
const Database = require('better-sqlite3')

const schemaPath = path.join(__dirname, '..', 'src', 'main', 'db', 'schema.sql')
const schema = fs.readFileSync(schemaPath, 'utf8')

const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
db.exec(schema)

// 关键表必须全部存在（防止注释/语法问题导致某张表被漏建）
const REQUIRED = [
  'items',
  'authors',
  'item_authors',
  'attachments',
  'annotations',
  'notes',
  'note_annotations',
  'collections',
  'tags',
  'works',
  'item_works',
  'citations',
  'citation_contexts',
  'chunks',
  'chunk_embeddings',
  'api_cache',
  'translations',
  'settings',
  'items_fts',
  'chunks_fts',
  'notes_fts',
  'translations_fts'
]
const names = db
  .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
  .all()
  .map((r) => r.name)
const missing = REQUIRED.filter((n) => !names.includes(n))

const ts = new Date().toISOString()
db.prepare(
  'INSERT INTO items (key, title, type, date_added, date_modified) VALUES (?, ?, ?, ?, ?)'
).run('ABC23456', '测试论文 A Study', 'document', ts, ts)

const items = db.prepare('SELECT * FROM items').all()
const fts = db.prepare('SELECT rowid, title FROM items_fts WHERE items_fts MATCH ?').all('Study')

// 笔记索引（独立表，rowid 显式写入）
db.prepare(
  "INSERT INTO notes (key,item_id,title,md_path,date_added,date_modified) VALUES ('NOTE1',1,'t','notes/NOTE1.md',?,?)"
).run(ts, ts)
db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(1, 't', 'body text')
const notesFts = db
  .prepare('SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?')
  .all('body')

// 分块 + 向量
db.prepare('INSERT INTO chunks (attachment_id, page_index, text) VALUES (1,0,?)').run('hello world')
const chunkRow = db.prepare('SELECT id FROM chunks').get()
db.prepare(
  'INSERT INTO chunk_embeddings (chunk_id, model, dim, vector, created_at) VALUES (?,?,?,?,?)'
).run(chunkRow.id, 'mock', 3, Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer), ts)
const emb = db.prepare('SELECT count(*) c FROM chunk_embeddings').get().c

console.log('tables  :', names.length)
console.log('missing :', missing.length === 0 ? 'none' : missing.join(','))
console.log('items   :', items.length, JSON.stringify(items[0] && items[0].title))
console.log('items_fts/chunks/notes_fts/emb:', fts.length, emb, notesFts.length)

const ok = missing.length === 0 && items.length === 1 && fts.length === 1 && notesFts.length === 1 && emb === 1
console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL')
process.exitCode = ok ? 0 : 1
