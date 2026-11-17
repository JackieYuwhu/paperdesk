import { ipcMain } from 'electron'
import { writeFileSync } from 'node:fs'
import { CH } from '../../shared/channels'
import {
  MINDMAP_EXPORT_EMPTY,
  exportFileBaseName,
  hasExportableContent,
  serializeMindmapExport
} from '../../shared/mindmap-export'
import type { MindmapExportFormat } from '../../shared/mindmap-export'
import {
  expandNode,
  findSupport,
  loadMindMap,
  optimizeMap,
  optimizeNode,
  saveMindMap,
  summarizeNode,
  syncDigestToItemMindMap
} from '../services/mindmap'
import {
  loadScopedMindMap,
  openPaperMindmapWindow
} from '../services/mindmap-scope'
import type { MindmapScope } from '../../shared/mindmap-scope'
import type {
  MindMapDoc,
  MindMapNode,
  MindMapNodeProvenance,
  MindMapSyncState,
  MindmapSyncInput
} from '../../shared/types'
import { normalizeMindmapAnchor } from '../../shared/mindmap-anchor'

function validateItemId(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error('无效的文献 id')
  }
  return raw
}

function validateNodeId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('请先在思维地图里选中一个节点')
  }
  return raw.trim()
}

/** 导出格式白名单：渲染层传来的值不可信，未知格式直接拒绝 */
function validateExportFormat(raw: unknown): MindmapExportFormat {
  if (raw === 'markdown' || raw === 'mermaid') return raw
  throw new Error('导出格式不受支持（仅支持 markdown / mermaid）')
}

/** 覆盖式同步凭据：只认识 source='sync'，其余字段按类型清洗后透传 */
function validateProvenance(raw: unknown): MindMapNodeProvenance | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<MindMapNodeProvenance>
  if (value.source !== 'sync') return null
  const out: MindMapNodeProvenance = { source: 'sync' }
  if (typeof value.syncId === 'string' && value.syncId.trim()) out.syncId = value.syncId.trim()
  if (typeof value.batchId === 'string' && value.batchId.trim()) out.batchId = value.batchId.trim()
  else if (value.batchId === null) out.batchId = null
  if (typeof value.contentHash === 'string' && value.contentHash.trim()) {
    out.contentHash = value.contentHash.trim()
  }
  if (typeof value.originText === 'string') out.originText = value.originText
  if (typeof value.originX === 'number' && Number.isFinite(value.originX)) out.originX = value.originX
  if (typeof value.originY === 'number' && Number.isFinite(value.originY)) out.originY = value.originY
  if (typeof value.userEdited === 'boolean') out.userEdited = value.userEdited
  if (Array.isArray(value.topicPath)) {
    out.topicPath = value.topicPath.filter((item): item is string => typeof item === 'string')
  }
  return out
}

/** 地图级同步水位：老文件没有该字段，损坏时直接丢弃（不影响保存） */
function validateSyncState(raw: unknown): MindMapSyncState | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<MindMapSyncState>
  if (typeof value.syncId !== 'string' || !value.syncId.trim()) return null
  const nodeIds = Array.isArray(value.nodeIds)
    ? value.nodeIds.filter((item): item is string => typeof item === 'string')
    : []
  return {
    syncId: value.syncId.trim(),
    ...(typeof value.batchId === 'string' ? { batchId: value.batchId } : {}),
    ...(value.mode === 'ai' || value.mode === 'rule' ? { mode: value.mode } : {}),
    nodeIds,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {})
  }
}

/** 渲染进程传来的地图是不可信输入：保存前校验结构，坏数据不落盘 */
function validateDoc(raw: unknown): MindMapDoc {
  if (!raw || typeof raw !== 'object') throw new Error('思维地图数据无效')
  const doc = raw as Partial<MindMapDoc>
  if (doc.version !== 1) throw new Error('思维地图版本不受支持')
  if (typeof doc.itemId !== 'number' || !Number.isInteger(doc.itemId) || doc.itemId <= 0) {
    throw new Error('思维地图缺少所属文献')
  }
  if (typeof doc.rootId !== 'string' || !doc.rootId.trim()) throw new Error('思维地图缺少根节点')
  if (!Array.isArray(doc.nodes) || doc.nodes.length === 0) throw new Error('思维地图没有节点')

  const ids = new Set<string>()
  const nodes: MindMapNode[] = []
  for (const rawNode of doc.nodes) {
    if (!rawNode || typeof rawNode !== 'object') throw new Error('思维地图节点无效')
    const node = rawNode as Partial<MindMapNode>
    if (typeof node.id !== 'string' || !node.id.trim()) throw new Error('思维地图节点 id 为空')
    if (ids.has(node.id)) throw new Error('思维地图节点 id 重复')
    if (node.parentId !== null && typeof node.parentId !== 'string') {
      throw new Error('思维地图节点父级无效')
    }
    if (typeof node.text !== 'string') throw new Error('思维地图节点文本无效')
    if (
      typeof node.x !== 'number' ||
      !Number.isFinite(node.x) ||
      typeof node.y !== 'number' ||
      !Number.isFinite(node.y)
    ) {
      throw new Error('思维地图节点坐标无效')
    }
    ids.add(node.id)
    const source =
      node.source === 'ai-generated' || node.source === 'digest' ? node.source : undefined
    const provenance = validateProvenance(node.provenance)
    const anchor = normalizeMindmapAnchor(node.anchor)
    nodes.push({
      id: node.id,
      parentId: node.parentId,
      text: node.text,
      x: node.x,
      y: node.y,
      // 来源标记必须透传：渲染层靠它给 AI 节点加角标并一次性撤销本次展开
      ...(source ? { source } : {}),
      ...(provenance ? { provenance } : {}),
      ...(anchor ? { anchor } : {})
    })
  }

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const root = byId.get(doc.rootId)
  if (!root) throw new Error('思维地图根节点不存在')
  if (root.parentId != null) throw new Error('思维地图根节点不能有父级')
  for (const node of nodes) {
    if (node.id === root.id) continue
    if (!node.parentId || !byId.has(node.parentId)) throw new Error('思维地图存在孤立节点')
  }
  // 防环：沿 parentId 向上必须能在节点数内到达根
  for (const node of nodes) {
    const seen = new Set<string>([node.id])
    let cur: MindMapNode | undefined = node
    let guard = 0
    while (cur && cur.parentId != null) {
      if (guard++ > nodes.length) throw new Error('思维地图存在环')
      if (seen.has(cur.parentId)) throw new Error('思维地图存在环')
      seen.add(cur.parentId)
      cur = byId.get(cur.parentId)
    }
  }

  const sync = validateSyncState(doc.sync)
  return {
    version: 1,
    itemId: doc.itemId,
    rootId: root.id,
    nodes,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date().toISOString(),
    ...(sync ? { sync } : {})
  }
}

export function registerMindmapHandlers(): void {
  ipcMain.handle(CH.mindmap.load, (_event, rawItemId: unknown) => {
    return loadMindMap(validateItemId(rawItemId))
  })

  // 聚合地图只读：scope 是不可信输入，交给 service 统一校验（中文可读错误），不写盘
  ipcMain.handle(CH.mindmap.loadScope, (_event, rawScope: unknown) => {
    return loadScopedMindMap(rawScope as MindmapScope)
  })

  // 独立窗口打开单篇地图：窗口生命周期在 windows/mindmap-window.ts，这里只转发
  ipcMain.handle(CH.mindmap.openPaper, (_event, rawItemId: unknown) => {
    return openPaperMindmapWindow(validateItemId(rawItemId))
  })

  ipcMain.handle(CH.mindmap.save, (_event, rawItemId: unknown, rawDoc: unknown) => {
    const itemId = validateItemId(rawItemId)
    const doc = validateDoc(rawDoc)
    if (doc.itemId !== itemId) throw new Error('思维地图与文献不匹配')
    return saveMindMap(itemId, doc)
  })

  // 三个 AI 操作都只读地图（结果由渲染层写入并整份保存），失败时抛可读错误、不动地图
  ipcMain.handle(CH.mindmap.summarize, (_event, rawItemId: unknown, rawNodeId: unknown) =>
    summarizeNode(validateItemId(rawItemId), validateNodeId(rawNodeId))
  )

  ipcMain.handle(CH.mindmap.expand, (_event, rawItemId: unknown, rawNodeId: unknown) =>
    expandNode(validateItemId(rawItemId), validateNodeId(rawNodeId))
  )

  ipcMain.handle(CH.mindmap.findSupport, (_event, rawItemId: unknown, rawNodeId: unknown) =>
    findSupport(validateItemId(rawItemId), validateNodeId(rawNodeId))
  )

  ipcMain.handle(CH.mindmap.optimize, (_event, rawItemId: unknown, rawNodeId: unknown) =>
    optimizeNode(validateItemId(rawItemId), validateNodeId(rawNodeId))
  )

  // 整图优化（PD58）：不需要节点 id，只校验 itemId
  ipcMain.handle(CH.mindmap.optimizeMap, (_event, rawItemId: unknown) =>
    optimizeMap(validateItemId(rawItemId))
  )

  // 拆解 → 地图覆盖式同步：入参是不可信对象，逐字段校验后再进 service（写盘由 service 负责）
  ipcMain.handle(CH.mindmap.syncDigest, (_event, raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('同步参数无效')
    const input = raw as Partial<MindmapSyncInput>
    const itemId = validateItemId(input.itemId)
    if (typeof input.markdown !== 'string') throw new Error('拆解内容无效，无法同步思维地图')
    const title = typeof input.title === 'string' ? input.title : null
    const batchId = typeof input.batchId === 'string' && input.batchId.trim() ? input.batchId.trim() : null
    return syncDigestToItemMindMap(itemId, title, input.markdown, batchId)
  })

  // 导出：序列化在 shared 纯模块里，这里只做校验 + 保存框 + 写用户选中的路径。
  // 只写用户选中的文件，不碰 data/mindmap；空图在弹框前就拦掉，绝不产生空文件。
  ipcMain.handle(
    CH.mindmap.export,
    async (
      _event,
      rawItemId: unknown,
      rawFormat: unknown,
      rawDoc: unknown
    ): Promise<string | null> => {
      const itemId = validateItemId(rawItemId)
      const format = validateExportFormat(rawFormat)
      const doc = validateDoc(rawDoc)
      if (doc.itemId !== itemId) throw new Error('思维地图与文献不匹配')
      if (!hasExportableContent(doc)) throw new Error(MINDMAP_EXPORT_EMPTY)
      const content = serializeMindmapExport(doc, format)
      // 双保险：即便将来序列化规则变了，也不写空文件
      if (!content.trim()) throw new Error(MINDMAP_EXPORT_EMPTY)

      const rootText = doc.nodes.find((node) => node.id === doc.rootId)?.text ?? ''
      const { dialog } = await import('electron')
      const res = await dialog.showSaveDialog({
        title: format === 'mermaid' ? '导出 Mermaid 图' : '导出 Markdown 大纲',
        defaultPath: exportFileBaseName(rootText, format),
        filters:
          format === 'mermaid'
            ? [
                { name: 'Mermaid', extensions: ['mmd'] },
                { name: '文本', extensions: ['txt'] }
              ]
            : [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (res.canceled || !res.filePath) return null
      writeFileSync(res.filePath, content, 'utf8')
      return res.filePath
    }
  )
}
