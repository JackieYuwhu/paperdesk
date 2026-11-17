import { ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { CH } from '../../shared/channels'
import { getDb } from '../db'
import { resolveStoragePath } from '../services/storage'
import type { Attachment } from '../../shared/types'

export function registerAttachmentHandlers(): void {
  ipcMain.handle(CH.attachments.readBytes, (_e, id: number): Uint8Array => {
    const row = getDb()
      .prepare('SELECT * FROM attachments WHERE id = ?')
      .get(id) as Attachment | undefined
    if (!row) throw new Error(`附件不存在: ${id}`)
    const abs = resolveStoragePath(row.path)
    return readFileSync(abs)
  })

  ipcMain.handle(CH.attachments.getByKey, (_e, key: string): Attachment | null => {
    return (
      (getDb().prepare('SELECT * FROM attachments WHERE key = ?').get(key) as Attachment) ?? null
    )
  })

  ipcMain.handle(CH.attachments.getByPath, (_e, path: string): Attachment | null => {
    const norm = String(path ?? '').replace(/\\/g, '/')
    return (
      (getDb()
        .prepare('SELECT * FROM attachments WHERE path = ? OR path = ?')
        .get(norm, norm.replace(/^data\//, '')) as Attachment) ?? null
    )
  })
}
