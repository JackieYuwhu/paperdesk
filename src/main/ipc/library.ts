import type { IpcMainInvokeEvent } from 'electron'
import { BrowserWindow, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, extname, join, relative, sep } from 'node:path'
import { CH, EVT } from '../../shared/channels'
import { getDataDir, getDb } from '../db'
import { generateKey } from '../db/keys'
import { resolveStoragePath, storePdf } from '../services/storage'
import { runExtraction } from '../services/extract'
import { enrichItem } from '../services/enrich'
import { syncItemNoteTitle } from '../services/notes'
import {
  createLibraryGroup,
  deleteLibraryGroup,
  ensureGroupPath,
  getLibraryGroup,
  listLibraryGroups,
  updateLibraryGroup
} from '../services/library-groups'
import {
  listLibraryTags,
  setItemTags,
  tagsForItems
} from '../services/item-tags'
import { importFromUrl, importManyFromUrls } from '../services/fetch-pdf'
import { newlyImportedItemIds, summarizeFolderImport } from '../../shared/api'
import type {
  DeleteGroupResult,
  FolderImportEntry,
  ImportFolderOutcome,
  ImportManyOutcome,
  ImportPdfsOutcome,
  ImportUrlOutcome
} from '../../shared/api'
import { computeSpaceRel, refreshSpaceIndex, removeSpace } from '../services/spaces'
import type {
  AddMetadataInput,
  Attachment,
  ImportPdfResult,
  Item,
  LibraryGroup,
  LibraryTag
} from '../../shared/types'

const nowIso = (): string => new Date().toISOString()

function notifyLibraryChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send(EVT.libraryChanged)
    } catch {
      /* 窗口可能已关闭 */
    }
  }
}

export function registerLibraryHandlers(): void {
  ipcMain.handle(CH.library.list, (): Item[] => {
    const items = getDb()
      .prepare('SELECT * FROM items ORDER BY date_added DESC')
      .all() as Item[]
    const tags = tagsForItems(items.map((it) => it.id))
    for (const item of items) item.tags = tags[item.id] ?? []
    return items
  })

  ipcMain.handle(CH.library.get, (_e: IpcMainInvokeEvent, id: number): Item | null => {
    const item = (getDb().prepare('SELECT * FROM items WHERE id = ?').get(id) as Item) ?? null
    if (item) item.tags = tagsForItems([id])[id] ?? []
    return item
  })

  ipcMain.handle(CH.attachments.listByItem, (_e, itemId: number): Attachment[] => {
    return getDb()
      .prepare('SELECT * FROM attachments WHERE item_id = ? ORDER BY id')
      .all(itemId) as Attachment[]
  })

  ipcMain.handle(
    CH.library.importPdf,
    async (_e, group?: string | null): Promise<ImportPdfResult | null> => {
      const { dialog } = await import('electron')
      const res = await dialog.showOpenDialog({
        title: '导入 PDF（可多选）',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (res.canceled || res.filePaths.length === 0) return null
      let first: ImportPdfResult | null = null
      for (const p of res.filePaths) {
        try {
          const imported = importPdfFromPath(p, group)
          first ??= imported
          if (imported.duplicate) continue
          // 等识别完成再返回：单文件导入也必须立即带出领域标签/正确标题
          await extractAndAutoRename(
            imported.attachment.id,
            imported.item.title,
            '自动识别元数据失败'
          )
        } catch (e) {
          console.warn('[paperdesk] 导入失败:', e instanceof Error ? e.message : e)
        }
      }
      return first
    }
  )

  // 多文件入口：返回 { canceled, items, message, itemIds }
  // itemIds 只含本次新增条目；重复文件不算新增，也不参与归组（PD02）
  ipcMain.handle(
    CH.library.importPdfs,
    async (_e, group?: string | null): Promise<ImportPdfsOutcome> => {
      const { dialog } = await import('electron')
      const res = await dialog.showOpenDialog({
        title: '导入 PDF（可多选）',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (res.canceled || res.filePaths.length === 0) {
        return { canceled: true, items: [], message: '已取消导入', itemIds: [] }
      }
      const items: ImportPdfResult[] = []
      const extractJobs: Promise<void>[] = []
      for (const p of res.filePaths) {
        try {
          const imported = importPdfFromPath(p, group)
          items.push(imported)
          if (!imported.duplicate)
            extractJobs.push(
              extractAndAutoRename(
                imported.attachment.id,
                imported.item.title,
                '自动识别元数据失败'
              )
            )
        } catch (e) {
          console.warn('[paperdesk] 导入失败:', e instanceof Error ? e.message : e)
        }
      }
      await Promise.all(extractJobs)
      const itemIds = newlyImportedItemIds(
        items.map((r) => ({ itemId: r.item.id, duplicate: r.duplicate }))
      )
      const duplicates = items.length - itemIds.length
      const message = `导入完成：新增 ${itemIds.length}${duplicates > 0 ? ` · 重复 ${duplicates}` : ''}`
      return { canceled: false, items, itemIds, message }
    }
  )

  // 选择一个文件夹，递归导入其中的所有 PDF（后台逐个识别元数据）
  ipcMain.handle(
    CH.library.importFolder,
    async (_e, group?: string | null): Promise<ImportFolderOutcome | null> => {
      const { dialog } = await import('electron')
      const res = await dialog.showOpenDialog({
        title: '导入文件夹（批量导入其中所有 PDF）',
        properties: ['openDirectory']
      })
      if (res.canceled || res.filePaths.length === 0) return null
      const pdfs = collectPdfs(res.filePaths[0])
      const result: ImportFolderOutcome = { imported: 0, skipped: 0, errors: [], itemIds: [] }
      const entries: FolderImportEntry[] = []
      for (const p of pdfs) {
        try {
          const imported = importPdfFromPath(p, group)
          if (imported.duplicate) {
            entries.push({ duplicate: true })
            continue
          }
          entries.push({})
          result.itemIds.push(imported.item.id)
          // 后台识别，避免阻塞批量导入
          extractAndAutoRename(imported.attachment.id, imported.item.title, '批量导入识别失败')
        } catch (e) {
          entries.push({ error: true })
          if (result.errors.length < 8) {
            result.errors.push(
              `${p.split(/[\\/]/).pop()}: ${e instanceof Error ? e.message : String(e)}`
            )
          }
        }
      }
      // 计数口径与「本次新增」一致：重复与失败都算 skipped
      const summary = summarizeFolderImport(entries)
      result.imported = summary.imported
      result.skipped = summary.skipped
      return result
    }
  )

  // 从链接 / DOI / arXiv 嗅探并下载 PDF 后入库
  ipcMain.handle(
    CH.library.importFromUrl,
    (_e, input: string, group?: string | null): Promise<ImportUrlOutcome> =>
      importFromUrl(input, group)
  )

  // 批量导入：多行 DOI / arXiv / 网页链接（有界并发 + DOI 去重）
  ipcMain.handle(
    CH.library.importManyFromUrls,
    (_e, text: string, group?: string | null): Promise<ImportManyOutcome> =>
      importManyFromUrls(text, group)
  )

  ipcMain.handle(CH.library.listGroups, (): LibraryGroup[] => {
    return listLibraryGroups()
  })

  ipcMain.handle(
    CH.library.createGroup,
    (_e, name: string, parent: string | null): LibraryGroup => {
      const group = createLibraryGroup(name, parent)
      ensureGroupPath(group.name)
      notifyLibraryChanged()
      return group
    }
  )

  ipcMain.handle(CH.library.getGroup, (_e, name: string): LibraryGroup | null =>
    getLibraryGroup(name)
  )

  ipcMain.handle(
    CH.library.updateGroup,
    (
      _e,
      name: string,
      patch: {
        leaf?: string
        parent?: string | null
        description?: string | null
        /** 目标同层第 N 位（1 起）= 移动/重排；不传则不改变顺序 */
        position?: number | null
      }
    ): LibraryGroup => {
      const group = updateLibraryGroup(name, patch ?? {})
      notifyLibraryChanged()
      return group
    }
  )

  ipcMain.handle(
    CH.library.deleteGroup,
    (
      _e,
      name: string,
      options?: {
        /** true = 连同子分组整棵删除；默认拒绝删除带子分组的分组 */
        withDescendants?: boolean
      }
    ): DeleteGroupResult => {
      const result = deleteLibraryGroup(name, options ?? {})
      notifyLibraryChanged()
      return result
    }
  )

  ipcMain.handle(CH.library.listTags, (): LibraryTag[] => listLibraryTags('manual'))

  ipcMain.handle(
    CH.library.tagsForItems,
    (_e, itemIds: number[]): Record<number, string[]> => tagsForItems(itemIds)
  )

  ipcMain.handle(CH.library.setTags, (_e, itemId: number, names: string[]): string[] => {
    const tags = setItemTags(itemId, names)
    notifyLibraryChanged()
    return tags
  })

  ipcMain.handle(CH.library.setGroup, (_e, itemId: number, group: string | null): void => {
    ensureGroupPath(group)
    getDb()
      .prepare('UPDATE items SET group_name = ?, date_modified = ? WHERE id = ?')
      .run(group, nowIso(), itemId)
    syncItemNoteTitle(itemId)
    notifyLibraryChanged()
  })

  ipcMain.handle(CH.library.setGroupMany, (_e, itemIds: number[], group: string | null): void => {
    ensureGroupPath(group)
    const ts = nowIso()
    const db = getDb()
    const tx = db.transaction(() => {
      for (const id of itemIds) {
        db.prepare('UPDATE items SET group_name = ?, date_modified = ? WHERE id = ?').run(
          group,
          ts,
          id
        )
        syncItemNoteTitle(id)
      }
    })
    tx()
    notifyLibraryChanged()
  })

  ipcMain.handle(CH.library.rename, (_e, itemId: number, title: string): Item => {
    return renameItem(itemId, title)
  })

  // 从发现/图谱等处按元数据直接入库（无附件）；可归入某条目的「空间」下
  ipcMain.handle(CH.library.addMetadata, (_e, input: AddMetadataInput): Item => {
    const db = getDb()
    const key = generateKey()
    const ts = nowIso()

    // 计算空间路径（父条目 -> 归入其空间 children 下）
    let spacePath = computeSpaceRel(key, null)
    if (input.parentId != null) {
      const parent = db.prepare('SELECT * FROM items WHERE id = ?').get(input.parentId) as
        | Item
        | undefined
      if (parent) {
        const parentRel = parent.space_path ?? computeSpaceRel(parent.key, null)
        spacePath = computeSpaceRel(key, parentRel)
      }
    }

    const res = db
      .prepare(
        `INSERT INTO items (key, doi, title, year, venue, type, parent_id, space_path, date_added, date_modified)
         VALUES (?, ?, ?, ?, ?, 'document', ?, ?, ?, ?)`
      )
      .run(
        key,
        input.doi ?? null,
        input.title ?? null,
        input.year ?? null,
        input.venue ?? null,
        input.parentId ?? null,
        spacePath,
        ts,
        ts
      )
    const itemId = Number(res.lastInsertRowid)

    if (input.doi) {
      db.prepare('INSERT OR IGNORE INTO works (doi, title, year) VALUES (?, ?, ?)').run(
        input.doi,
        input.title ?? null,
        input.year ?? null
      )
      const w = db.prepare('SELECT id FROM works WHERE doi = ?').get(input.doi) as
        | { id: number }
        | undefined
      if (w) db.prepare('INSERT OR IGNORE INTO item_works (item_id, work_id) VALUES (?, ?)').run(itemId, w.id)
    }

    refreshSpaceIndex(itemId)
    if (input.parentId != null) refreshSpaceIndex(input.parentId)
    return db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Item
  })

  // 删除条目（连带附件/批注/引用/分块与空间目录；子条目上移到其父级）
  ipcMain.handle(CH.library.delete, (_e, itemId: number): void => {
    deleteItem(itemId)
  })

  // 为元数据条目补齐摘要（Crossref / OpenAlex）
  ipcMain.handle(CH.library.enrich, (_e, itemId: number): Promise<Item> => enrichItem(itemId))
}

/** 递归收集一个目录下的所有 PDF（限制深度与数量，避免误选超大目录） */
function collectPdfs(root: string, maxFiles = 500, maxDepth = 6): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (out.length >= maxFiles || depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue
        walk(full, depth + 1)
      } else if (e.isFile() && /\.pdf$/i.test(e.name)) {
        out.push(full)
      }
    }
  }
  walk(root, 0)
  return out
}

/** 文件内容指纹；用于阻止同一 PDF 重复入库（选择多份/文件夹重复导入时很常见） */
function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 把一个 PDF 文件导入库：建 item + attachment，并复制文件进 data/storage */
export function importPdfFromPath(srcPath: string, group?: string | null): ImportPdfResult {
  const db = getDb()
  const hash = sha256File(srcPath)
  const duplicate = db
    .prepare(
      `SELECT a.*, i.id AS existing_item_id
         FROM attachments a JOIN items i ON i.id = a.item_id
        WHERE a.sha256 = ? LIMIT 1`
    )
    .get(hash) as (Attachment & { existing_item_id: number }) | undefined
  if (duplicate) {
    // 已存在：不重复复制文件，也不改旧条目分组。
    // 分组只属于「本次新增」；若在这里给旧条目补分组，重复文件/并发导入
    // 就会把别的导入已归好的条目抢走（PD02）。
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(
      duplicate.existing_item_id
    ) as Item
    return { item, attachment: duplicate, duplicate: true }
  }

  const itemKey = generateKey()
  const attachmentKey = generateKey()
  const ts = nowIso()
  const fallbackTitle = (srcPath.split(/[\\/]/).pop() || '未命名').replace(/\.pdf$/i, '')
  ensureGroupPath(group)

  const tx = db.transaction((): ImportPdfResult => {
    const itemRes = db
      .prepare(
        `INSERT INTO items (key, title, type, group_name, space_path, date_added, date_modified)
         VALUES (?, ?, 'document', ?, ?, ?, ?)`
      )
      .run(itemKey, fallbackTitle, group || null, computeSpaceRel(itemKey, null), ts, ts)
    const itemId = Number(itemRes.lastInsertRowid)

    const { relPath, filename } = storePdf(itemKey, srcPath)
    const attRes = db
      .prepare(
        `INSERT INTO attachments (key, item_id, path, filename, content_type, sha256, date_added)
         VALUES (?, ?, ?, ?, 'application/pdf', ?, ?)`
      )
      .run(attachmentKey, itemId, relPath, filename, hash, ts)
    const attachmentId = Number(attRes.lastInsertRowid)

    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Item
    const attachment = db
      .prepare('SELECT * FROM attachments WHERE id = ?')
      .get(attachmentId) as Attachment
    return { item, attachment }
  })

  const out = tx()
  refreshSpaceIndex(out.item.id)
  return out
}

/** 后台识别；若识别出更合适的标题，同时把磁盘文件名改成标题 */
export async function extractAndAutoRename(
  attachmentId: number,
  oldTitle: string | null,
  label: string
): Promise<void> {
  try {
    const summary = await runExtraction(attachmentId, { forceTitle: true })
    const itemId = summary.itemId
    if (itemId == null) return
    const latest = getDb().prepare('SELECT * FROM items WHERE id = ?').get(itemId) as
      | Item
      | undefined
    if (latest?.title && latest.title !== oldTitle) renameItem(itemId, latest.title)
  } catch (e) {
    console.warn(`[paperdesk] ${label}:`, e instanceof Error ? e.message : e)
  }
}

function safeFileStem(title: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
  return clean || '未命名'
}

function uniqueFilePath(dir: string, stem: string, ext: string): { abs: string; filename: string } {
  let filename = `${stem}${ext}`
  let abs = join(dir, filename)
  for (let i = 2; existsSync(abs) && i < 1000; i++) {
    filename = `${stem} (${i})${ext}`
    abs = join(dir, filename)
  }
  return { abs, filename }
}

/** 重命名文库条目，并同步磁盘上的附件文件名（保留扩展名/目录） */
function renameItem(itemId: number, title: string): Item {
  const nextTitle = title.trim().slice(0, 200)
  if (!nextTitle) throw new Error('文件名不能为空')
  const db = getDb()
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Item | undefined
  if (!item) throw new Error('条目不存在')

  const attachments = db
    .prepare('SELECT id, path, filename FROM attachments WHERE item_id = ?')
    .all(itemId) as Array<{ id: number; path: string; filename: string | null }>

  const tx = db.transaction((): Item => {
    db.prepare('UPDATE items SET title = ?, date_modified = ? WHERE id = ?').run(
      nextTitle,
      nowIso(),
      itemId
    )
    let seq = 1
    for (const att of attachments) {
      const oldAbs = resolveStoragePath(att.path)
      if (!existsSync(oldAbs)) continue
      const ext = extname(att.filename || oldAbs) || '.pdf'
      const stem = safeFileStem(nextTitle) + (attachments.length > 1 ? ` (${seq++})` : '')
      const { abs, filename } = uniqueFilePath(dirname(oldAbs), stem, ext)
      if (abs !== oldAbs) {
        renameSync(oldAbs, abs)
        const rel = relative(getDataDir(), abs).split(sep).join('/')
        db.prepare('UPDATE attachments SET path = ?, filename = ? WHERE id = ?').run(
          rel,
          filename,
          att.id
        )
      }
    }
    return db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Item
  })

  const out = tx()
  syncItemNoteTitle(itemId)
  notifyLibraryChanged()
  return out
}

/** 删除条目：级联清理附件/批注/引用/分块与空间目录；子条目上移到其父级并重算空间 */
function deleteItem(itemId: number): void {
  const db = getDb()
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Item | undefined
  if (!item) return
  const atts = db
    .prepare('SELECT id, path FROM attachments WHERE item_id = ?')
    .all(itemId) as Array<{ id: number; path: string }>
  const children = db.prepare('SELECT id FROM items WHERE parent_id = ?').all(itemId) as Array<{
    id: number
  }>
  const spaceRel = item.space_path ?? computeSpaceRel(item.key, null)

  const tx = db.transaction(() => {
    db.prepare('UPDATE items SET parent_id = ?, space_path = NULL WHERE parent_id = ?').run(
      item.parent_id ?? null,
      itemId
    )
    for (const a of atts) db.prepare('DELETE FROM chunks WHERE attachment_id = ?').run(a.id)
    db.prepare('DELETE FROM items WHERE id = ?').run(itemId)
  })
  tx()

  removeSpace(spaceRel)
  for (const a of atts) {
    try {
      rmSync(join(getDataDir(), ...a.path.split('/')), { force: true })
    } catch {
      /* 忽略 */
    }
  }
  // 重建被上移的子条目空间
  for (const c of children) {
    try {
      refreshSpaceIndex(c.id)
    } catch {
      /* 忽略 */
    }
  }
  if (item.parent_id != null) {
    try {
      refreshSpaceIndex(item.parent_id)
    } catch {
      /* 忽略 */
    }
  }
}
