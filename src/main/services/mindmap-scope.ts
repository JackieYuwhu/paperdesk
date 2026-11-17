import { getDb } from '../db'
import {
  buildScopedMindMap,
  normalizeMindmapScope
} from '../../shared/mindmap-scope'
import type {
  MindmapScope,
  MindmapScopeDoc,
  MindmapScopePaper
} from '../../shared/mindmap-scope'
import { loadMindMap } from './mindmap'
import { openPaperMindmapWindow as openPaperWindow } from '../windows/mindmap-window'

interface ScopePaperRow {
  id: number
  title: string | null
  group_name: string | null
}

/** 按 scope 从 items 取论文并按 id 升序读各自地图；排序固定，聚合网格落位才可复现 */
export function listScopePapers(scope: MindmapScope): MindmapScopePaper[] {
  const db = getDb()
  let rows: ScopePaperRow[]
  if (scope.kind === 'group') {
    rows = db
      .prepare('SELECT id, title, group_name FROM items WHERE group_name = ? ORDER BY id ASC')
      .all(scope.group) as ScopePaperRow[]
  } else if (scope.kind === 'item') {
    rows = db
      .prepare('SELECT id, title, group_name FROM items WHERE id = ? ORDER BY id ASC')
      .all(scope.itemId) as ScopePaperRow[]
  } else {
    rows = db
      .prepare('SELECT id, title, group_name FROM items ORDER BY id ASC')
      .all() as ScopePaperRow[]
  }

  return rows.map((row) => ({
    itemId: row.id,
    title: typeof row.title === 'string' ? row.title : null,
    group: typeof row.group_name === 'string' ? row.group_name : null,
    doc: loadMindMap(row.id)
  }))
}

function scopeLabel(scope: MindmapScope, papers: MindmapScopePaper[]): string {
  if (scope.kind === 'all') return '全部论文思维地图'
  if (scope.kind === 'group') return `分组：${scope.group}`
  const title = papers.find((paper) => paper.itemId === scope.itemId)?.title
  const trimmed = typeof title === 'string' ? title.trim() : ''
  return trimmed || '未命名文献'
}

/** 校验 scope 后组装只读聚合地图；非法 scope 抛中文可读错误 */
export function loadScopedMindMap(scope: MindmapScope): MindmapScopeDoc {
  const normalized = normalizeMindmapScope(scope)
  const papers = listScopePapers(normalized)
  return buildScopedMindMap({
    scope: normalized,
    label: scopeLabel(normalized, papers),
    papers
  })
}

/** IPC 只做转发，窗口生命周期全部在 windows/mindmap-window.ts */
export function openPaperMindmapWindow(itemId: number): {
  ok: boolean
  windowId: number | null
  error?: string
} {
  return openPaperWindow(itemId)
}
