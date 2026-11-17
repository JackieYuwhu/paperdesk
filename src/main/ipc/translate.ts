import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { CH, EVT } from '../../shared/channels'
import {
  archiveAll,
  archiveQaToNote,
  archiveToNote,
  cancelTranslation,
  diagnoseTranslation,
  exportQa,
  exportZip,
  getTranslation,
  getTranslationById,
  listTranslations,
  deleteTranslation,
  pruneTranslations,
  setPinned,
  previewPrune,
  rollbackTranslation,
  type PruneItem,
  readTranslationMarkdown,
  scanOrphanFiles,
  cleanOrphanFiles,
  saveReport,
  type OrphanReport,
  markdownAbsPath,
  readTranslationBytes,
  readTranslationMap,
  retranslatePage,
  readTranslationHtml,
  readTranslationHtmlMarked,
  readTranslationBilingual,
  readTranslationBilingualMarked,
  runTranslation,
  saveBilingualSnapshot,
  saveTranslationHtml,
  saveTranslationMarkdown,
  translateTexts,
  translationByPath,
  translationHtmlAbsPath
} from '../services/translate'
import type {
  TranslateDiagnosis,
  TranslateOptions,
  Translation,
  TranslationTarget
} from '../../shared/types'

export function registerTranslateHandlers(): void {
  ipcMain.handle(
    CH.translate.run,
    (event: IpcMainInvokeEvent, attachmentId: number, opts?: TranslateOptions): Promise<Translation> => {
      const requestId = opts?.requestId ?? randomUUID()
      if (!requestId || typeof requestId !== 'string') throw new Error('缺少翻译请求 ID')
      return runTranslation(attachmentId, { ...opts, requestId: `${event.sender.id}:${requestId}` }, (p) => {
        try {
          event.sender.send(EVT.translateProgress, { ...p, requestId })
        } catch {
          /* 窗口可能已关闭 */
        }
      })
    }
  )

  ipcMain.handle(
    CH.translate.retranslatePage,
    (_e, id: number, page: number): Promise<Translation> => retranslatePage(id, page)
  )

  ipcMain.handle(CH.translate.cancel, (event, requestId: string): Promise<void> =>
    cancelTranslation(`${event.sender.id}:${requestId}`))

  ipcMain.handle(CH.translate.get, (_e, attachmentId: number, lang: string): Translation | null => {
    return getTranslation(attachmentId, lang)
  })

  ipcMain.handle(
    CH.translate.history,
    (_e, attachmentId: number, lang: string): Translation[] => listTranslations(attachmentId, lang)
  )

  ipcMain.handle(CH.translate.getById, (_e, id: number): Translation | null => {
    return getTranslationById(id)
  })

  ipcMain.handle(
    CH.translate.remove,
    (_e, id: number, removeFiles?: boolean): void => deleteTranslation(id, removeFiles !== false)
  )

  ipcMain.handle(
    CH.translate.prune,
    (_e, attachmentId: number, lang: string, keep: number): number =>
      pruneTranslations(attachmentId, lang, keep)
  )

  ipcMain.handle(
    CH.translate.setPinned,
    (_e, id: number, pinned: boolean): void => setPinned(id, !!pinned)
  )

  ipcMain.handle(
    CH.translate.previewPrune,
    (_e, attachmentId: number, lang: string, keep: number): PruneItem[] =>
      previewPrune(attachmentId, lang, keep)
  )

  ipcMain.handle(CH.translate.rollback, (_e, id: number): void => rollbackTranslation(id))

  ipcMain.handle(
    CH.translate.readMarkdown,
    (_e, id: number, which: 'translation' | 'bilingual'): string =>
      readTranslationMarkdown(id, which)
  )

  ipcMain.handle(CH.translate.orphans, (): OrphanReport => scanOrphanFiles())

  ipcMain.handle(
    CH.translate.cleanOrphans,
    (_e, names?: string[]): number => cleanOrphanFiles(names)
  )

  ipcMain.handle(
    CH.translate.saveReport,
    (_e, defaultName: string, content: string): Promise<string | null> =>
      saveReport(defaultName, content)
  )

  ipcMain.handle(CH.translate.getByPath, (_e, path: string): TranslationTarget | null => {
    return translationByPath(path)
  })

  ipcMain.handle(
    CH.translate.diagnose,
    (_e, attachmentId: number): Promise<TranslateDiagnosis> => diagnoseTranslation(attachmentId)
  )

  ipcMain.handle(CH.translate.read, (_e, id: number): Uint8Array => {
    return readTranslationBytes(id)
  })

  // 块级映射：原文选区 -> 译文实际落版矩形（旧译文没有映射时返回 null）
  ipcMain.handle(CH.translate.map, (_e, id: number) => readTranslationMap(id))

  ipcMain.handle(
    CH.translate.text,
    async (_e, text: string, lang?: string): Promise<{ text: string; backend: string }> => {
      const r = await translateTexts([text ?? ''], lang ?? 'zh')
      return { text: r.texts[0] ?? '', backend: r.backend }
    }
  )

  ipcMain.handle(CH.translate.readHtml, (_e, id: number): string => readTranslationHtml(id))
  ipcMain.handle(CH.translate.readHtmlMarked, (_e, id: number, query: string): string =>
    readTranslationHtmlMarked(id, query)
  )

  ipcMain.handle(CH.translate.readBilingual, (_e, id: number): string =>
    readTranslationBilingual(id)
  )

  ipcMain.handle(CH.translate.readBilingualMarked, (_e, id: number, query: string): string =>
    readTranslationBilingualMarked(id, query)
  )

  // 用系统默认浏览器打开 HTML 译文
  ipcMain.handle(CH.translate.openHtml, async (_e, id: number): Promise<void> => {
    const p = translationHtmlAbsPath(id)
    if (!p) throw new Error('该译文还没有 HTML 版本')
    const { shell } = await import('electron')
    await shell.openPath(p)
  })

  // 另存为 HTML 文件
  ipcMain.handle(CH.translate.saveHtml, async (_e, id: number): Promise<string | null> => {
    const p = translationHtmlAbsPath(id)
    if (!p) throw new Error('该译文还没有 HTML 版本')
    const { dialog } = await import('electron')
    const res = await dialog.showSaveDialog({
      title: '另存译文 HTML',
      defaultPath: p.split(/[\\/]/).pop() ?? 'translation.html',
      filters: [{ name: 'HTML', extensions: ['html'] }]
    })
    if (res.canceled || !res.filePath) return null
    saveTranslationHtml(id, res.filePath)
    return res.filePath
  })

  // 把译文/对照 Markdown 归档进该条目的笔记
  ipcMain.handle(
    CH.translate.exportToNote,
    (_e, id: number, which: 'translation' | 'bilingual'): { noteKey: string } =>
      archiveToNote(id, which)
  )

  // 一键归档：译文 + 对照入笔记 + 打包 ZIP
  ipcMain.handle(
    CH.translate.archiveAll,
    (_e, id: number): Promise<{ noteKey: string; zip: string }> => archiveAll(id)
  )

  ipcMain.handle(CH.translate.exportZip, (_e, id: number): Promise<string> => exportZip(id))

  ipcMain.handle(CH.translate.exportQa, (_e, id: number): string => exportQa(id))

  ipcMain.handle(
    CH.translate.exportQaToNote,
    (_e, id: number): { noteKey: string } => archiveQaToNote(id)
  )

  ipcMain.handle(
    CH.translate.saveSnapshot,
    (_e, id: number, query: string, theme: string, kind?: 'bilingual' | 'html'): Promise<string | null> =>
      saveBilingualSnapshot(id, query, theme, kind ?? 'bilingual')
  )

  // 另存为 Markdown（译文 / 中英对照）
  ipcMain.handle(
    CH.translate.saveMarkdown,
    async (
      _e,
      id: number,
      which: 'translation' | 'bilingual'
    ): Promise<string | null> => {
      const p = markdownAbsPath(id, which)
      if (!p) throw new Error('该译文还没有 Markdown 版本，请重新翻译')
      const { dialog } = await import('electron')
      const res = await dialog.showSaveDialog({
        title: which === 'bilingual' ? '另存中英对照 Markdown' : '另存译文 Markdown',
        defaultPath: p.split(/[\\/]/).pop() ?? 'translation.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (res.canceled || !res.filePath) return null
      saveTranslationMarkdown(id, which, res.filePath)
      return res.filePath
    }
  )
}
