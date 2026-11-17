import { copyFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir, getDb } from '../db'
import { ensureSidecar } from '../sidecar/manager'
import { resolveStoragePath } from './storage'

/**
 * 页面编辑（删除页）+ 版本/撤销。
 *
 * 设计要点（对应本轮需求「删除页面及撤销／恢复」）：
 * - 原文件永不就地覆盖：删除前把当前文件备份到 `data/edits/<附件key>/<时间戳>.pdf`，
 *   先写 `*.tmp.pdf` 再 `rename`，写入失败者保留原版本。
 * - 页码用**旧页 → 新页**映射记录（`page_map_json`），批注按映射迁移；落在被删页上的
 *   批注不迁移、不改挂到别的页，而是留在版本快照里（`annotations_json`），
 *   撤销时按快照原样恢复。
 * - 删页后该附件的译文与原文页数不再对应：直接删除译文记录并提示需要重新生成，
 *   避免左右页码错配。
 * - 有进行中的批处理/翻译任务引用该附件时拒绝编辑，避免任务读到一半变化的文件。
 */

export interface PdfEditRow {
  id: number
  attachmentId: number
  kind: string
  removed: number[]
  pageMap: number[]
  pageCountFrom: number
  pageCountTo: number
  annotations: { id: number; page: number }[]
  chunks: { id: number; page: number | null }[]
  createdAt: string
  undoneAt: string | null
}

export interface PdfEditResult {
  attachmentId: number
  versionId: number
  pageCount: number
  removed: number[]
  /** 删页导致译文失效时提示 */
  translationRegenerated: boolean
  warnings: string[]
}

interface AttachmentRow {
  id: number
  key: string
  item_id: number | null
  path: string
  page_count: number | null
}

function attachmentOf(attachmentId: number): AttachmentRow {
  const row = getDb()
    .prepare('SELECT id, key, item_id, path, page_count FROM attachments WHERE id = ?')
    .get(attachmentId) as AttachmentRow | undefined
  if (!row) throw new Error('附件不存在')
  return row
}

function ensureEditTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS pdf_edits (
      id              INTEGER PRIMARY KEY,
      attachment_id   INTEGER NOT NULL,
      kind            TEXT NOT NULL,
      removed_json    TEXT NOT NULL,
      page_map_json   TEXT NOT NULL,
      page_count_from INTEGER NOT NULL,
      page_count_to   INTEGER NOT NULL,
      annotations_json TEXT,
      chunks_json     TEXT,
      backup_path     TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      undone_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pdf_edits_attachment ON pdf_edits(attachment_id, created_at);
  `)
}

/** 该附件是否有正在跑的任务（翻译/批处理），有则不允许改文件 */
function activeTaskOf(attachmentId: number): string | null {
  const db = getDb()
  try {
    const tr = db
      .prepare(
        "SELECT id FROM translations WHERE attachment_id = ? AND status IN ('running','pending') LIMIT 1"
      )
      .get(attachmentId) as { id: number } | undefined
    if (tr) return '该附件正在翻译'
  } catch {
    /* 表结构缺失时忽略 */
  }
  // 批处理的目标在 batch_items(attachment_id) 里，batch_jobs 本身没有 attachment_ids 列；
  // 先查 batch_items，再回退到「params 里带了这个附件 id」的旧作业，避免漏判。
  try {
    const item = db
      .prepare(
        `SELECT bj.key AS key
           FROM batch_items bi
           JOIN batch_jobs bj ON bj.id = bi.job_id
          WHERE bi.attachment_id = ?
            AND bj.status IN ('running','pending')
          LIMIT 1`
      )
      .get(attachmentId) as { key: string } | undefined
    if (item) return `该论文正在批处理队列中（${item.key}）`
  } catch {
    /* batch_items 缺失时忽略 */
  }
  const jobs = db
    .prepare(
      "SELECT id FROM batch_jobs WHERE status IN ('running','pending') AND params LIKE ? LIMIT 1"
    )
    .get(`%${attachmentId}%`) as { id: number } | undefined
  if (jobs) return '该论文正在批处理队列中'
  return null
}

/** 调 sidecar 渲染缩略图（只读，用于删除前核对） */
export async function pdfPageThumbs(
  attachmentId: number,
  pages: number[] = []
): Promise<{ pageCount: number; thumbs: { page: number; png: string }[] }> {
  const att = attachmentOf(attachmentId)
  const abs = resolveStoragePath(att.path)
  if (!existsSync(abs)) throw new Error('附件文件不存在')
  const base = await ensureSidecar()
  const res = await fetch(`${base}/pdf/thumbs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: abs, pages, width: 132 })
  })
  if (!res.ok) throw new Error(`缩略图渲染失败：${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as { pageCount: number; thumbs: { page: number; png: string }[] }
}

function backupDir(key: string): string {
  const dir = join(getDataDir(), 'edits', key)
  mkdirSync(dir, { recursive: true })
  return dir
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** 把当前文件复制进版本目录，返回相对 data/ 的路径（供撤销恢复） */
function backupCurrent(att: AttachmentRow, abs: string): string {
  const name = `${stamp()}.pdf`
  const dest = join(backupDir(att.key), name)
  copyFileSync(abs, dest)
  return ['edits', att.key, name].join('/')
}

/**
 * 删除指定页（0 基）。至少保留 1 页；原文件先备份后替换，失败不影响原版本。
 */
export async function deletePdfPages(attachmentId: number, pages: number[]): Promise<PdfEditResult> {
  ensureEditTable()
  const block = activeTaskOf(attachmentId)
  if (block) throw new Error(`${block}，请等任务结束后再编辑页面（避免任务读到一半变化的文件）`)

  const att = attachmentOf(attachmentId)
  const abs = resolveStoragePath(att.path)
  if (!existsSync(abs)) throw new Error('附件文件不存在')
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('请选择要删除的页面')

  const db = getDb()
  const from = att.page_count ?? 0
  const uniq = [...new Set(pages.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p >= 0))]
  if (from > 0 && uniq.length >= from) throw new Error('不能删除全部页面，至少保留 1 页')

  const backupPath = backupCurrent(att, abs)
  const backupAbs = resolveStoragePath(backupPath)

  const tmp = `${abs}.${Date.now()}.tmp.pdf`
  const base = await ensureSidecar()
  let removed: number[] = []
  let pageMap: number[] = []
  let to = 0
  try {
    const res = await fetch(`${base}/pdf/delete-pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: backupAbs, outPath: tmp, pages: uniq })
    })
    if (!res.ok) {
      const detail = await res.text()
      throw new Error(`删除页面失败：${detail.slice(0, 200)}`)
    }
    const data = (await res.json()) as { pageCount: number; removed: number[]; pageMap: number[] }
    removed = data.removed ?? []
    pageMap = data.pageMap ?? []
    to = data.pageCount
    if (!existsSync(tmp) || statSync(tmp).size === 0) throw new Error('删除页面失败：输出文件为空')
    // 原子替换：先换文件，再更新数据库，任何一步失败都还留着备份
    renameSync(tmp, abs)
  } catch (e) {
    try {
      if (existsSync(tmp)) renameSync(tmp, `${tmp}.failed`)
    } catch {
      /* 清理失败无妨 */
    }
    throw e
  }

  // 批注与块页号快照（删页前）：撤销时按它原样恢复，绝不把删页上的批注改挂到别的页
  const annotations = (
    db
      .prepare('SELECT id, page_index AS page FROM annotations WHERE attachment_id = ?')
      .all(attachmentId) as { id: number; page: number }[]
  ).map((a) => ({ id: a.id, page: a.page }))
  const chunkPages = (
    db
      .prepare('SELECT id, page_index AS page FROM chunks WHERE attachment_id = ?')
      .all(attachmentId) as { id: number; page: number | null }[]
  ).map((c) => ({ id: c.id, page: c.page }))

  const tx = db.transaction(() => {
    db.prepare('UPDATE attachments SET page_count = ? WHERE id = ?').run(to, attachmentId)
    // 页级定位的映射：被删页的块直接移出（不再指向任何页），其余整体前移
    const chunks = db
      .prepare('SELECT id, page_index AS page FROM chunks WHERE attachment_id = ?')
      .all(attachmentId) as { id: number; page: number | null }[]
    const updChunk = db.prepare('UPDATE chunks SET page_index = ? WHERE id = ?')
    for (const c of chunks) {
      if (c.page == null) continue
      const mapped = pageMap[c.page]
      if (mapped === undefined || mapped < 0) updChunk.run(-1, c.id)
      else updChunk.run(mapped, c.id)
    }
    const updAnn = db.prepare('UPDATE annotations SET page_index = ? WHERE id = ?')
    for (const a of annotations) {
      const mapped = pageMap[a.page]
      // 被删页上的批注：置为 -1（保留内容、不显示、不挂到别的页），撤销时按快照恢复
      updAnn.run(mapped === undefined || mapped < 0 ? -1 : mapped, a.id)
    }
    db.prepare(
      'INSERT INTO pdf_edits (attachment_id, kind, removed_json, page_map_json, page_count_from, page_count_to, annotations_json, chunks_json, backup_path, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(
      attachmentId,
      'delete-pages',
      JSON.stringify(removed),
      JSON.stringify(pageMap),
      from || pageMap.length,
      to,
      JSON.stringify(annotations),
      JSON.stringify(chunkPages),
      backupPath,
      new Date().toISOString()
    )
  })
  tx()

  const versionId = Number(
    (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id
  )

  // 译文与原文页数不再 1:1：删掉译文记录，界面会提示重新生成，避免页码错配
  let translationRegenerated = false
  try {
    const del = db.prepare('DELETE FROM translations WHERE attachment_id = ?').run(attachmentId)
    if ((del.changes ?? 0) > 0) translationRegenerated = true
  } catch {
    /* 无译文表时忽略 */
  }

  const warnings: string[] = []
  if (translationRegenerated) warnings.push('页面已变更，译文需要重新生成（已移除旧译文，避免页码错配）')
  const orphan = annotations.filter((a) => (pageMap[a.page] ?? -1) < 0).length
  if (orphan > 0) warnings.push(`${orphan} 条批注位于被删页面，已随历史版本保留，不会挂到其他页面`)

  return {
    attachmentId,
    versionId,
    pageCount: to,
    removed,
    translationRegenerated,
    warnings
  }
}

export function listPdfEdits(attachmentId: number): PdfEditRow[] {
  ensureEditTable()
  const rows = getDb()
    .prepare(
      'SELECT id, attachment_id AS attachmentId, kind, removed_json, page_map_json, page_count_from, page_count_to, annotations_json, chunks_json, created_at, undone_at FROM pdf_edits WHERE attachment_id = ? ORDER BY id DESC'
    )
    .all(attachmentId) as {
    id: number
    attachmentId: number
    kind: string
    removed_json: string
    page_map_json: string
    page_count_from: number
    page_count_to: number
    annotations_json: string | null
    chunks_json: string | null
    created_at: string
    undone_at: string | null
  }[]
  return rows.map((r) => ({
    id: r.id,
    attachmentId: r.attachmentId,
    kind: r.kind,
    removed: safeParse<number[]>(r.removed_json, []),
    pageMap: safeParse<number[]>(r.page_map_json, []),
    pageCountFrom: r.page_count_from,
    pageCountTo: r.page_count_to,
    annotations: safeParse<{ id: number; page: number }[]>(r.annotations_json, []),
    chunks: safeParse<{ id: number; page: number | null }[]>(r.chunks_json, []),
    createdAt: r.created_at,
    undoneAt: r.undone_at
  }))
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/**
 * 撤销/恢复某个版本：把备份文件写回附件路径，恢复页数与批注页号。
 * 支持连续撤销（每撤一次就回到更早的版本）。
 */
export function restorePdfEdit(versionId: number): PdfEditResult {
  ensureEditTable()
  const db = getDb()
  const row = db
    .prepare(
      'SELECT id, attachment_id AS attachmentId, page_count_from, page_count_to, annotations_json, chunks_json, backup_path, undone_at FROM pdf_edits WHERE id = ?'
    )
    .get(versionId) as
    | {
        id: number
        attachmentId: number
        page_count_from: number
        page_count_to: number
        annotations_json: string | null
        chunks_json: string | null
        backup_path: string
        undone_at: string | null
      }
    | undefined
  if (!row) throw new Error('版本不存在')
  if (row.undone_at) throw new Error('该版本已撤销')

  const att = attachmentOf(row.attachmentId)
  const abs = resolveStoragePath(att.path)
  const backupAbs = resolveStoragePath(row.backup_path)
  if (!existsSync(backupAbs)) throw new Error('版本备份文件缺失，无法恢复')

  // 先写临时文件再替换：恢复失败不破坏当前文件
  const tmp = `${abs}.${Date.now()}.restore.pdf`
  copyFileSync(backupAbs, tmp)
  renameSync(tmp, abs)

  const annotations = safeParse<{ id: number; page: number }[]>(row.annotations_json, [])
  const pageFrom = row.page_count_from
  const pageTo = row.page_count_to
  const tx = db.transaction(() => {
    db.prepare('UPDATE attachments SET page_count = ? WHERE id = ?').run(pageFrom, att.id)
    const updAnn = db.prepare('UPDATE annotations SET page_index = ? WHERE id = ? AND attachment_id = ?')
    for (const a of annotations) updAnn.run(a.page, a.id, att.id)
    // 块页号按删页前快照原样恢复（不按比例猜测，避免检索/引用指到错误页）
    const chunkSnap = safeParse<{ id: number; page: number | null }[]>(row.chunks_json, [])
    const updChunk = db.prepare('UPDATE chunks SET page_index = ? WHERE id = ? AND attachment_id = ?')
    for (const c of chunkSnap) updChunk.run(c.page, c.id, att.id)
    db.prepare('UPDATE pdf_edits SET undone_at = ? WHERE id = ?').run(new Date().toISOString(), versionId)
    // 恢复后译文同样与原文页数不符：移除旧译文，界面提示重新生成
    db.prepare('DELETE FROM translations WHERE attachment_id = ?').run(att.id)
  })
  tx()

  return {
    attachmentId: att.id,
    versionId,
    pageCount: pageFrom,
    removed: [],
    translationRegenerated: true,
    warnings: ['已恢复到该版本；译文需重新生成']
  }
}
