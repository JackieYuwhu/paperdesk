import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import {
  authorProfile,
  authorsForItem,
  authorsForItemLocal,
  authorsForItemsLocal,
  cleanupAuthors,
  importAuthorsByOrcid,
  linkLocalAuthor,
  searchAuthors
} from '../services/authors'
import type {
  AuthorCleanupResult,
  AuthorProfile,
  AuthorSummary,
  ImportAuthorsResult,
  LinkAuthorInput,
  LinkAuthorResult
} from '../../shared/types'

export function registerAuthorsHandlers(): void {
  ipcMain.handle(
    CH.authors.search,
    (_e, query: string, limit?: number): Promise<{ authors: AuthorSummary[]; warnings: string[] }> =>
      searchAuthors(query ?? '', limit ?? 10)
  )

  ipcMain.handle(CH.authors.profile, (_e, id: string): Promise<AuthorProfile> => authorProfile(id))

  ipcMain.handle(
    CH.authors.forItem,
    (_e, itemId: number): Promise<{ names: string[]; warnings: string[] }> => authorsForItem(itemId)
  )
  ipcMain.handle(CH.authors.forItemLocal, (_e, itemId: number): string[] =>
    authorsForItemLocal(itemId)
  )
  // 批量：文库列表一次取回所有可见条目的作者（避免逐行 IPC 造成卡顿）
  ipcMain.handle(CH.authors.forItemsLocal, (_e, itemIds: number[]): Record<number, string[]> =>
    authorsForItemsLocal(Array.isArray(itemIds) ? itemIds : [])
  )

  ipcMain.handle(CH.authors.link, (_e, input: LinkAuthorInput): LinkAuthorResult =>
    linkLocalAuthor(input ?? { openalexId: '', name: '' })
  )

  ipcMain.handle(CH.authors.cleanup, (): Promise<AuthorCleanupResult> => cleanupAuthors())

  ipcMain.handle(CH.authors.importByOrcid, (_e, orcidText: string): Promise<ImportAuthorsResult> =>
    importAuthorsByOrcid(orcidText ?? '')
  )
}
