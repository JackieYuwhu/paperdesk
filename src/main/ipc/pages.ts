import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import { deletePdfPages, listPdfEdits, pdfPageThumbs, restorePdfEdit } from '../services/pdf-edit'

/**
 * 页面编辑 IPC：只读缩略图、删除页（生成新版本）、版本列表、撤销/恢复。
 * 所有写操作都在主进程做备份与原子替换，渲染层拿不到文件路径。
 */
export function registerPageEditHandlers(): void {
  ipcMain.handle(CH.reader.pageThumbs, (_e, attachmentId: number, pages?: number[]) =>
    pdfPageThumbs(attachmentId, pages)
  )
  ipcMain.handle(CH.reader.deletePages, (_e, attachmentId: number, pages: number[]) =>
    deletePdfPages(attachmentId, pages)
  )
  ipcMain.handle(CH.reader.pageEdits, (_e, attachmentId: number) => listPdfEdits(attachmentId))
  ipcMain.handle(CH.reader.restorePageEdit, (_e, versionId: number) => restorePdfEdit(versionId))
}
