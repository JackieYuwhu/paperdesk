import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import { getBiblioGraph } from '../services/biblio'
import { toGexf, toPajek } from '../../shared/biblio'
import { saveReport } from '../services/translate'
import type { BiblioGraph, BiblioKind } from '../../shared/biblio'

const KINDS: readonly BiblioKind[] = ['authors', 'keywords', 'coupling', 'cocitation']

export function registerBiblioHandlers(): void {
  ipcMain.handle(
    CH.biblio.get,
    (_e, kind: BiblioKind, limit?: number): BiblioGraph =>
      getBiblioGraph(KINDS.includes(kind) ? kind : 'authors', limit ?? 60)
  )

  ipcMain.handle(
    CH.biblio.export,
    async (_e, kind: BiblioKind, format: 'pajek' | 'gexf'): Promise<string | null> => {
      const k = KINDS.includes(kind) ? kind : 'authors'
      const graph = getBiblioGraph(k, 200)
      const content = format === 'gexf' ? toGexf(graph) : toPajek(graph)
      // 允许导出空图（仍是合法文件）
      return saveReport(`biblio-${k}.${format === 'pajek' ? 'net' : 'gexf'}`, content)
    }
  )
}
