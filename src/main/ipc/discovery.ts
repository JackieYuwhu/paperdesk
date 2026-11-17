import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import {
  buildGraph,
  cachedGraph,
  diagnoseDiscovery,
  saveGraphCache,
  topicGraph
} from '../services/discovery'
import type { DiscoveryDiagnosis, DiscoveryGraph, DiscoverySource } from '../../shared/types'
import { searchWorks, saveWorkPdf, getCitationRecord, queryCitation, type WorkSearchOptions } from '../services/works'
import {
  enrichPublication,
  readPublication,
  savePublicationManual
} from '../services/publication'
import type { PublicationInfo } from '../../shared/publication'

export function registerDiscoveryHandlers(): void {
  ipcMain.handle(
    CH.discovery.graph,
    async (
      _e,
      itemId: number,
      source?: DiscoverySource,
      query?: string,
      sort?: 'recent' | 'cited'
    ): Promise<DiscoveryGraph> => {
      // 「按研究方向」：不依赖具体条目，直接用方向词检索
      if (source === 'topic') return topicGraph(query ?? '', undefined, sort ?? 'recent')
      const g = await buildGraph(itemId, source ?? 'auto')
      if (g.seed) saveGraphCache(itemId, g)
      return g
    }
  )

  ipcMain.handle(
    CH.discovery.cached,
    (_e, itemId: number): { graph: DiscoveryGraph; cachedAt: string } | null =>
      cachedGraph(itemId)
  )

  ipcMain.handle(CH.discovery.diagnose, (_e, itemId: number): Promise<DiscoveryDiagnosis> => {
    return diagnoseDiscovery(itemId)
  })

  ipcMain.handle(CH.works.search, (_e, query: string, opts?: WorkSearchOptions) =>
    searchWorks(query ?? '', opts ?? {})
  )
  ipcMain.handle(CH.works.savePdf, (_e, url: string, name: string) => saveWorkPdf(url, name))
  // 被引：read = 只读本地（详情页默认），query = 用户点击后才联网（SerpAPI）
  ipcMain.handle(CH.works.citation, (_e, itemId: number) => getCitationRecord(itemId))
  ipcMain.handle(
    CH.works.citationQuery,
    (_e, itemId: number, opts?: { force?: boolean; candidateId?: string }) =>
      queryCitation(itemId, opts ?? {})
  )
  // 发表信息：读 / 补全 / 手动修正
  ipcMain.handle(CH.publication.get, (_e, itemId: number) => readPublication(itemId))
  ipcMain.handle(CH.publication.enrich, (_e, itemId: number, opts?: { force?: boolean }) =>
    enrichPublication(itemId, opts ?? {})
  )
  ipcMain.handle(
    CH.publication.save,
    (_e, itemId: number, patch: Partial<PublicationInfo>) => savePublicationManual(itemId, patch)
  )
  ipcMain.handle(CH.works.openScholar, async (_e, query: string): Promise<void> => {
    const { shell } = await import('electron')
    const q = (query ?? '').trim()
    await shell.openExternal(
      'https://scholar.google.com/scholar?q=' + encodeURIComponent(q)
    )
  })
}
