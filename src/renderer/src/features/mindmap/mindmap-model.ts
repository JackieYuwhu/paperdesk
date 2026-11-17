/**
 * 思维地图纯函数模型（无 React / 无 Electron 依赖）。
 *
 * 设计约定：
 * - 一棵树用扁平 nodes 数组 + parentId 表达，rootId 指向根；
 * - 坐标是画布内节点左上角像素，拖动只改 x/y；
 * - 所有“写”操作都返回新对象，方便 React 更新与单元测试。
 */
import type {
  MindMapDoc,
  MindMapNode,
  MindMapNodeProvenance,
  MindMapSyncState
} from '../../../../shared/types'
// @ts-expect-error TS5097：测试用 `node scripts/test-unit.ts` 直接加载本文件，Node ESM 需要显式扩展名
import { normalizeMindmapAnchor } from '../../../../shared/mindmap-anchor.ts'
// @ts-expect-error TS5097
import { measureMindmapNode } from '../../../../shared/mindmap-ai.ts'

/** PD57：节点全文显示后，自动排布的最小列间距 / 行间距 */
export const MINDMAP_COL_GAP = 28
export const MINDMAP_ROW_GAP = 18

export const MINDMAP_ROOT_ID = 'root'
export const MINDMAP_DEFAULT_TEXT = '新节点'
export const MINDMAP_UNTITLED = '未命名文献'
export const MINDMAP_ROOT_X = 48
export const MINDMAP_ROOT_Y = 48
export const MINDMAP_CHILD_DX = 248
export const MINDMAP_CHILD_DY = 72

/* ------------------------------------------------------------------ */
/* 画布缩放（PD56）：比例夹在 0.4–2.0，步进 0.1，缩放以光标为锚点      */
/* ------------------------------------------------------------------ */

export const MINDMAP_ZOOM_MIN = 0.4
export const MINDMAP_ZOOM_MAX = 2
export const MINDMAP_ZOOM_STEP = 0.1
export const MINDMAP_ZOOM_DEFAULT = 1

/** 比例归一到 0.1 的整数倍并夹在 [0.4, 2.0]；非法值回落到 100% */
export function clampMindmapZoom(value: unknown): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : MINDMAP_ZOOM_DEFAULT
  const stepped = Math.round(raw * 10) / 10
  return Math.min(MINDMAP_ZOOM_MAX, Math.max(MINDMAP_ZOOM_MIN, stepped))
}

/** 步进方向：+1 放大、-1 缩小；到边界后返回同一个比例 */
export function nextMindmapZoom(current: unknown, direction: 1 | -1): number {
  return clampMindmapZoom(clampMindmapZoom(current) + direction * MINDMAP_ZOOM_STEP)
}

/** 缩放的滚动补偿输入：视口/光标都是屏幕坐标，scroll 是视口当前滚动量 */
export interface MindmapZoomAnchor {
  scrollLeft: number
  scrollTop: number
  /** 视口左上角（getBoundingClientRect） */
  viewportLeft: number
  viewportTop: number
  /** 缩放锚点（通常是鼠标位置；键盘/按钮时用视口中心） */
  pointerX: number
  pointerY: number
  zoom: number
  nextZoom: number
}

/** 缩放后的滚动量与光标下的内容坐标（内容坐标用于绘制选框/命中测试） */
export interface MindmapZoomResult {
  contentX: number
  contentY: number
  scrollLeft: number
  scrollTop: number
}

/**
 * 保持「光标下的内容点」不动：先把光标换算成内容坐标，再按新比例反推滚动量。
 * 这是缩放锚点误差 ≤ 2px 的唯一来源，直接单测。
 */
export function zoomScrollAfterZoom(anchor: MindmapZoomAnchor): MindmapZoomResult {
  const zoom = clampMindmapZoom(anchor.zoom)
  const nextZoom = clampMindmapZoom(anchor.nextZoom)
  const viewportLeft = Number.isFinite(anchor.viewportLeft) ? anchor.viewportLeft : 0
  const viewportTop = Number.isFinite(anchor.viewportTop) ? anchor.viewportTop : 0
  const offsetX = (Number.isFinite(anchor.pointerX) ? anchor.pointerX : 0) - viewportLeft
  const offsetY = (Number.isFinite(anchor.pointerY) ? anchor.pointerY : 0) - viewportTop
  const scrollLeft = Number.isFinite(anchor.scrollLeft) ? anchor.scrollLeft : 0
  const scrollTop = Number.isFinite(anchor.scrollTop) ? anchor.scrollTop : 0
  const contentX = (scrollLeft + offsetX) / zoom
  const contentY = (scrollTop + offsetY) / zoom
  return {
    contentX,
    contentY,
    scrollLeft: Math.max(0, contentX * nextZoom - offsetX),
    scrollTop: Math.max(0, contentY * nextZoom - offsetY)
  }
}

/** 屏幕坐标 → 内容坐标（不含缩放时等同于加滚动量的相对坐标） */
export function mindmapContentPoint(
  clientX: number,
  clientY: number,
  viewportLeft: number,
  viewportTop: number,
  scrollLeft: number,
  scrollTop: number,
  zoom: number
): { x: number; y: number } {
  const z = clampMindmapZoom(zoom)
  const left = Number.isFinite(viewportLeft) ? viewportLeft : 0
  const top = Number.isFinite(viewportTop) ? viewportTop : 0
  const sx = Number.isFinite(scrollLeft) ? scrollLeft : 0
  const sy = Number.isFinite(scrollTop) ? scrollTop : 0
  return {
    x: (clientX - left + sx) / z,
    y: (clientY - top + sy) / z
  }
}

/* ------------------------------------------------------------------ */
/* 框选与批量变换（PD56）：只做纯数据变换，交互细节留在面板组件        */
/* ------------------------------------------------------------------ */

export interface MindmapRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * 矩形相交判断（用于框选命中）。触摸到边也算命中，
 * 这样只拖出半个节点宽度的选框也能选中它。
 */
export function rectsIntersect(a: MindmapRect, b: MindmapRect): boolean {
  if (!a || !b) return false
  if (![a.left, a.top, a.right, a.bottom, b.left, b.top, b.right, b.bottom].every(Number.isFinite)) {
    return false
  }
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top
}

/**
 * 整体平移选中节点（多选拖动）：
 * - 所有选中节点共用同一个取整后的位移，相对位置保持不变；
 * - 任一节点会被推到负数时，整组一起停下（不改变组内相对位置）；
 * - 没有可移动节点 / 位移为 0 时返回同一引用。
 */
export function moveNodesBy(
  doc: MindMapDoc,
  ids: ReadonlyArray<string>,
  dx: number,
  dy: number
): MindMapDoc {
  const wanted = new Set(Array.isArray(ids) ? ids : [])
  const moving = doc.nodes.filter((node) => wanted.has(node.id))
  if (moving.length === 0) return doc
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return doc
  const minX = Math.min(...moving.map((node) => node.x))
  const minY = Math.min(...moving.map((node) => node.y))
  const stepX = Math.round(Math.max(dx, -minX))
  const stepY = Math.round(Math.max(dy, -minY))
  if (stepX === 0 && stepY === 0) return doc
  return {
    ...doc,
    nodes: doc.nodes.map((node) =>
      wanted.has(node.id) ? { ...node, x: node.x + stepX, y: node.y + stepY } : node
    )
  }
}

/**
 * 批量删除：跳过根节点、自动去重子树（删父节点时不再重复删子节点）、
 * 忽略不存在的 id；没有可删节点时返回同一引用。
 */
export function removeNodes(doc: MindMapDoc, ids: ReadonlyArray<string>): MindMapDoc {
  const targets = new Set<string>()
  for (const id of Array.isArray(ids) ? ids : []) {
    if (id === doc.rootId) continue
    if (!findNode(doc, id)) continue
    targets.add(id)
  }
  if (targets.size === 0) return doc
  const doomed = new Set(targets)
  let changed = true
  while (changed) {
    changed = false
    for (const node of doc.nodes) {
      if (node.parentId && doomed.has(node.parentId) && !doomed.has(node.id)) {
        doomed.add(node.id)
        changed = true
      }
    }
  }
  return { ...doc, nodes: doc.nodes.filter((node) => !doomed.has(node.id)) }
}

/**
 * 批量对齐：按当前 y 从上到下排序，取最上方选中节点的 x 作为列坐标，
 * 其余选中节点只横向移动、y 不变（用于把骨架整理成一列）。少于 2 个节点不动。
 */
export function alignNodesToColumn(doc: MindMapDoc, ids: ReadonlyArray<string>): MindMapDoc {
  const wanted = new Set(Array.isArray(ids) ? ids : [])
  const targets = doc.nodes.filter((node) => wanted.has(node.id))
  if (targets.length < 2) return doc
  const anchor = [...targets].sort((a, b) => a.y - b.y || a.x - b.x)[0]
  const columnX = anchor.x
  if (targets.every((node) => node.x === columnX)) return doc
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (wanted.has(node.id) ? { ...node, x: columnX } : node))
  }
}

/** 折叠状态（纯 UI，不落盘）下被隐藏的节点：折叠节点的所有后代 */
export function hiddenByCollapse(
  doc: MindMapDoc,
  collapsed: ReadonlyArray<string> | ReadonlySet<string> | null | undefined
): Set<string> {
  const hidden = new Set<string>()
  if (!collapsed) return hidden
  const folded = collapsed instanceof Set ? collapsed : new Set(collapsed)
  if (folded.size === 0) return hidden
  const byId = new Map(doc.nodes.map((node) => [node.id, node]))
  for (const node of doc.nodes) {
    let guard = 0
    let current = node.parentId ? byId.get(node.parentId) : undefined
    while (current && guard++ <= doc.nodes.length) {
      if (folded.has(current.id)) {
        hidden.add(node.id)
        break
      }
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
  }
  return hidden
}

function cleanText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function cleanCoord(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
}

/** 覆盖式同步凭据（PD55）：只保留 source='sync' 的合法字段，坏数据丢弃 */
function cleanProvenance(raw: unknown): MindMapNodeProvenance | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Partial<MindMapNodeProvenance>
  if (value.source !== 'sync') return undefined
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

/** 地图级同步水位：损坏时丢弃，不影响其余节点渲染 */
function cleanSyncState(raw: unknown): MindMapSyncState | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Partial<MindMapSyncState>
  if (typeof value.syncId !== 'string' || !value.syncId.trim()) return undefined
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

export function findNode(doc: MindMapDoc, id: string | null | undefined): MindMapNode | null {
  if (!id) return null
  return doc.nodes.find((node) => node.id === id) ?? null
}

export function childrenOf(doc: MindMapDoc, parentId: string): MindMapNode[] {
  return doc.nodes.filter((node) => node.parentId === parentId)
}

export function countDescendants(doc: MindMapDoc, id: string): number {
  let count = 0
  const queue = [id]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const node of doc.nodes) {
      if (node.parentId === current) {
        count++
        queue.push(node.id)
      }
    }
  }
  return count
}

export function isRootNode(doc: MindMapDoc, id: string): boolean {
  return doc.rootId === id
}

/** 新建地图：根节点即当前文献标题，保证新文献也有可用根 */
export function createMindMap(itemId: number, title?: string | null): MindMapDoc {
  return {
    version: 1,
    itemId,
    rootId: MINDMAP_ROOT_ID,
    nodes: [
      {
        id: MINDMAP_ROOT_ID,
        parentId: null,
        text: cleanText(title, MINDMAP_UNTITLED),
        x: MINDMAP_ROOT_X,
        y: MINDMAP_ROOT_Y
      }
    ],
    updatedAt: new Date().toISOString()
  }
}

function nextNodeId(doc: MindMapDoc): string {
  let max = 0
  for (const node of doc.nodes) {
    const match = /^n(\d+)$/.exec(node.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  let id = `n${max + 1}`
  const used = new Set(doc.nodes.map((node) => node.id))
  while (used.has(id)) id = `n${Number(id.slice(1)) + 1}`
  return id
}

/** 在父节点右侧追加子节点；父节点不存在时原样返回 */
export function addChild(doc: MindMapDoc, parentId: string, text?: string | null): MindMapDoc {
  const parent = findNode(doc, parentId)
  if (!parent) return doc
  const siblings = childrenOf(doc, parentId).length
  const node: MindMapNode = {
    id: nextNodeId(doc),
    parentId,
    text: cleanText(text, MINDMAP_DEFAULT_TEXT),
    x: parent.x + MINDMAP_CHILD_DX,
    y: parent.y + siblings * MINDMAP_CHILD_DY
  }
  return settleMindMapLayout({ ...doc, nodes: [...doc.nodes, node] })
}

/** 改名：去掉首尾空白；空文本视为取消，不覆盖原标题 */
export function renameNode(doc: MindMapDoc, id: string, text: string): MindMapDoc {
  const name = typeof text === 'string' ? text.trim() : ''
  if (!name) return doc
  if (!findNode(doc, id)) return doc
  return settleMindMapLayout({
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === id ? { ...node, text: name } : node))
  })
}

/** 删除节点及其整棵子树；根节点不可删除 */
export function removeNode(doc: MindMapDoc, id: string): MindMapDoc {
  if (id === doc.rootId || !findNode(doc, id)) return doc
  const doomed = new Set<string>([id])
  let changed = true
  while (changed) {
    changed = false
    for (const node of doc.nodes) {
      if (node.parentId && doomed.has(node.parentId) && !doomed.has(node.id)) {
        doomed.add(node.id)
        changed = true
      }
    }
  }
  return { ...doc, nodes: doc.nodes.filter((node) => !doomed.has(node.id)) }
}

/** 拖动落点：坐标取整；非有限值忽略 */
export function setNodePosition(doc: MindMapDoc, id: string, x: number, y: number): MindMapDoc {
  if (!findNode(doc, id)) return doc
  if (!Number.isFinite(x) || !Number.isFinite(y)) return doc
  return {
    ...doc,
    nodes: doc.nodes.map((node) =>
      node.id === id ? { ...node, x: Math.round(x), y: Math.round(y) } : node
    )
  }
}

/**
 * PD57：节点全文显示后的自动避让。
 *
 * 只把「后出现的节点」向右移，绝不左移、不改 y，也不动根节点与已有节点的相对顺序；
 * 因此老地图载入时（不调用本函数）坐标保持原样，而新增/改名/AI 写入后父子、
 * 兄弟与长标题之间不会互相压住。纯函数，渲染层与单测共用同一套测量。
 */
export function settleMindMapLayout(doc: MindMapDoc): MindMapDoc {
  if (!Array.isArray(doc.nodes) || doc.nodes.length < 2) return doc
  const depthOf = new Map<string, number>()
  const byId = new Map(doc.nodes.map((node) => [node.id, node]))
  for (const node of doc.nodes) {
    let depth = 0
    let cursor = node.parentId ? byId.get(node.parentId) : undefined
    const guard = new Set<string>([node.id])
    while (cursor && !guard.has(cursor.id) && depth < doc.nodes.length) {
      guard.add(cursor.id)
      depth += 1
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
    }
    depthOf.set(node.id, depth)
  }
  // 父节点先落位，子节点在后；同一层保持数组顺序，保证结果确定
  const ordered = doc.nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const depthDiff = (depthOf.get(a.node.id) ?? 0) - (depthOf.get(b.node.id) ?? 0)
      return depthDiff !== 0 ? depthDiff : a.index - b.index
    })
  const boxes = new Map(
    doc.nodes.map((node) => [node.id, { x: node.x, y: node.y, ...measureMindmapNode(node.text) }])
  )
  const placed: string[] = []
  const moved = new Set<string>()
  for (const { node } of ordered) {
    if (node.id === doc.rootId) {
      placed.push(node.id)
      continue
    }
    const box = boxes.get(node.id)
    if (!box) continue
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let collided: string | null = null
      for (const otherId of placed) {
        const other = boxes.get(otherId)
        if (!other) continue
        const overlapX =
          Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x)
        const overlapY =
          Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y)
        if (overlapX > 0 && overlapY > 0) {
          collided = otherId
          break
        }
      }
      if (!collided) break
      const other = boxes.get(collided)
      if (!other) break
      const nextX = other.x + other.width + MINDMAP_COL_GAP
      if (nextX <= box.x) break
      box.x = nextX
      moved.add(node.id)
    }
    placed.push(node.id)
  }
  if (moved.size === 0) return doc
  return {
    ...doc,
    nodes: doc.nodes.map((node) => {
      const box = boxes.get(node.id)
      return box && moved.has(node.id) ? { ...node, x: box.x } : node
    })
  }
}

/**
 * 修复磁盘/旧版本里的坏数据：
 * 补根、去重 id、孤立节点挂回根、断环、非法坐标归零、缺文本用默认值。
 * 始终返回一份可直接渲染的地图。
 */
export function normalizeMindMap(
  raw: unknown,
  itemId = 0,
  fallbackTitle?: string | null
): MindMapDoc {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<MindMapDoc>
  const docItemId =
    typeof source.itemId === 'number' && Number.isFinite(source.itemId) ? source.itemId : itemId
  const nodes: MindMapNode[] = []
  const seen = new Set<string>()
  for (const candidate of Array.isArray(source.nodes) ? source.nodes : []) {
    if (!candidate || typeof candidate !== 'object') continue
    const node = candidate as Partial<MindMapNode>
    const id = typeof node.id === 'string' ? node.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const provenance = cleanProvenance(node.provenance)
    const anchor = normalizeMindmapAnchor(node.anchor)
    nodes.push({
      id,
      parentId:
        typeof node.parentId === 'string' && node.parentId.trim() ? node.parentId.trim() : null,
      text: cleanText(node.text, MINDMAP_DEFAULT_TEXT),
      x: cleanCoord(node.x, 0),
      y: cleanCoord(node.y, 0),
      // 来源标记必须保留：撤销与角标都靠它（旧地图没有该字段则忽略）
      ...(node.source === 'ai-generated' || node.source === 'digest' ? { source: node.source } : {}),
      ...(provenance ? { provenance } : {}),
      ...(anchor ? { anchor } : {})
    })
  }

  const wantedRootId =
    typeof source.rootId === 'string' && source.rootId.trim() ? source.rootId.trim() : MINDMAP_ROOT_ID
  let root = nodes.find((node) => node.id === wantedRootId)
  if (!root) {
    if (nodes.length === 0) {
      root = {
        id: wantedRootId,
        parentId: null,
        text: cleanText(fallbackTitle, MINDMAP_UNTITLED),
        x: MINDMAP_ROOT_X,
        y: MINDMAP_ROOT_Y
      }
      nodes.push(root)
    } else {
      root = nodes[0]
    }
  }
  const rootId = root.id
  root.parentId = null

  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    if (node.id === rootId) continue
    if (!node.parentId || !byId.has(node.parentId)) {
      node.parentId = rootId
    }
  }
  // 断环：沿父链走，回到自己就挂到根下
  for (const node of nodes) {
    if (node.id === rootId) continue
    const chain = new Set<string>([node.id])
    let cur = byId.get(node.parentId ?? '')
    let guard = 0
    while (cur && guard++ <= nodes.length) {
      if (chain.has(cur.id)) {
        node.parentId = rootId
        break
      }
      chain.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
  }

  const sync = cleanSyncState(source.sync)
  return {
    version: 1,
    itemId: docItemId,
    rootId,
    nodes,
    updatedAt:
      typeof source.updatedAt === 'string' && source.updatedAt
        ? source.updatedAt
        : new Date().toISOString(),
    ...(sync ? { sync } : {})
  }
}

/** 解析磁盘 JSON；损坏时回退为带标题的新地图 */
export function parseMindMapJson(
  text: string | null | undefined,
  itemId: number,
  title?: string | null
): MindMapDoc {
  if (!text) return createMindMap(itemId, title)
  try {
    return normalizeMindMap(JSON.parse(text), itemId, title)
  } catch {
    return createMindMap(itemId, title)
  }
}

export function serializeMindMap(doc: MindMapDoc): string {
  return JSON.stringify(doc, null, 2)
}

// ---------------------------------------------------------------------------
// 自动骨架（PD28）：把 PDF 大纲 / 正文标题模块展平成带层级的条目，再合并进地图。
// 这里只做纯数据变换，读 PDF 与 sidecar 的 I/O 留在 MindMapPanel。
// ---------------------------------------------------------------------------

/** 一条骨架候选标题（level 从 1 开始，1=一级标题） */
export interface MindMapSkeletonEntry {
  title: string
  level: number
}

/** pdf.js `getOutline()` 返回项的最小形状（title/items 可能缺失或类型不对） */
export interface MindMapOutlineNode {
  title?: unknown
  items?: ReadonlyArray<MindMapOutlineNode> | null
}

/** 单次骨架生成的节点上限（防止超长目录把画布撑爆） */
export const MINDMAP_SKELETON_MAX_NODES = 200
/** 节点标题最大字数（超出截断，保留可读前缀） */
export const MINDMAP_SKELETON_MAX_TITLE = 120
/** 最深层级（更深的层级按最深一级处理，避免坐标跑出画布） */
export const MINDMAP_SKELETON_MAX_LEVEL = 6

/** 清洗骨架标题：折叠连续空白、去首尾空白、超长截断；非字符串/空白返回 '' */
export function cleanSkeletonTitle(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > MINDMAP_SKELETON_MAX_TITLE
    ? text.slice(0, MINDMAP_SKELETON_MAX_TITLE).trim()
    : text
}

/**
 * 展平 PDF 大纲为带层级的条目（DFS 前序，保持原阅读顺序）。
 *
 * - `depth` 从 1 开始，直接对应一级/二级标题；
 * - 空白标题丢弃，但它的子节点仍按 `depth + 1` 计算层级（合并时挂到最近祖先）；
 * - 空大纲 / 非法输入返回 `[]`，调用方据此判定「没有可用的章节结构」。
 */
export function flattenOutline(
  outline: ReadonlyArray<MindMapOutlineNode> | null | undefined,
  depth = 1
): MindMapSkeletonEntry[] {
  const level = Number.isFinite(depth) && depth >= 1 ? Math.floor(depth) : 1
  const entries: MindMapSkeletonEntry[] = []
  for (const node of Array.isArray(outline) ? outline : []) {
    if (!node || typeof node !== 'object') continue
    const title = cleanSkeletonTitle(node.title)
    if (title) entries.push({ title, level })
    entries.push(...flattenOutline(node.items, level + 1))
  }
  return entries
}

/** 根节点下是否已有节点（用于判断「已有手动内容，生成骨架需二次确认」） */
export function hasChildNodes(doc: MindMapDoc): boolean {
  return doc.nodes.some((node) => node.parentId === doc.rootId)
}

/**
 * 把骨架条目**非破坏性**合并到根节点下。
 *
 * - 已有节点（id / text / parentId / 坐标）与根节点文本、坐标完全不动；
 * - 新节点只追加，按层级挂到最近的上级（层级跳级时挂最近祖先，不造中间层）；
 * - `entries` 清洗后为空 → 原样返回**同一引用**，调用方据此提示「没有可用的章节结构」；
 * - 新 id 由 `nextNodeId` 连续分配，x 按层级、y 按行号排布，新节点之间不重叠。
 */
export function mergeSkeleton(
  doc: MindMapDoc,
  entries: ReadonlyArray<MindMapSkeletonEntry> | null | undefined
): MindMapDoc {
  const root = findNode(doc, doc.rootId)
  if (!root) return doc

  const cleaned: MindMapSkeletonEntry[] = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue
    const title = cleanSkeletonTitle(entry.title)
    if (!title) continue
    const rawLevel = Number.isFinite(entry.level) ? Math.floor(entry.level) : 1
    const level = Math.min(Math.max(1, rawLevel), MINDMAP_SKELETON_MAX_LEVEL)
    cleaned.push({ title, level })
    if (cleaned.length >= MINDMAP_SKELETON_MAX_NODES) break
  }
  if (cleaned.length === 0) return doc

  // 从已有根子节点的行号之后开始排，避免和用户手动建的节点叠在一起
  const rowStart = childrenOf(doc, doc.rootId).length
  let next: MindMapDoc = doc
  const stack: Array<{ level: number; id: string }> = []
  cleaned.forEach((entry, row) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= entry.level) stack.pop()
    const parentId = stack.length > 0 ? stack[stack.length - 1].id : doc.rootId
    const node: MindMapNode = {
      id: nextNodeId(next),
      parentId,
      text: entry.title,
      x: MINDMAP_ROOT_X + entry.level * MINDMAP_CHILD_DX,
      y: MINDMAP_ROOT_Y + (rowStart + row) * MINDMAP_CHILD_DY
    }
    next = { ...next, nodes: [...next.nodes, node] }
    stack.push({ level: entry.level, id: node.id })
  })
  return settleMindMapLayout(next)
}

/* ------------------------------------------------------------------ */
/* 节点级 AI：把「展开子节点」结果写进地图 / 一次性撤销                  */
/* ------------------------------------------------------------------ */

/** 节点来源标记：表示该节点由 AI 展开生成 */
export const MINDMAP_AI_SOURCE = 'ai-generated' as const

/** AI 展开结果：新地图 + 本次新增节点 id（撤销靠这份 id 列表） */
export interface MindMapAiExpansion {
  doc: MindMapDoc
  ids: string[]
}

/**
 * 把 AI 返回的文本写成 parentId 的子节点，全部标记 source='ai-generated'。
 * 空文本跳过、最多 4 条；父节点不存在时原样返回（ids 为空）。
 */
export function applyAiExpansion(
  doc: MindMapDoc,
  parentId: string,
  texts: ReadonlyArray<string>
): MindMapAiExpansion {
  if (!findNode(doc, parentId)) return { doc, ids: [] }
  let next = doc
  const ids: string[] = []
  for (const raw of Array.isArray(texts) ? texts : []) {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (!text) continue
    const grown = addChild(next, parentId, text)
    if (grown === next) continue
    const created = grown.nodes[grown.nodes.length - 1]
    if (!created) continue
    next = {
      ...grown,
      nodes: grown.nodes.map((node) =>
        node.id === created.id ? { ...node, source: MINDMAP_AI_SOURCE } : node
      )
    }
    ids.push(created.id)
    if (ids.length >= 4) break
  }
  return { doc: next, ids }
}

/**
 * 一次性撤销一次 AI 展开：只删「本次生成且仍带 ai-generated 标记」的节点及其子树，
 * 用户手动建的/改名的节点不动；没有可撤销节点时原样返回同一份 doc。
 */
export function undoAiExpansion(doc: MindMapDoc, ids: ReadonlyArray<string>): MindMapDoc {
  const targets = new Set<string>()
  for (const id of Array.isArray(ids) ? ids : []) {
    const node = findNode(doc, id)
    if (!node || node.source !== MINDMAP_AI_SOURCE) continue
    if (node.id === doc.rootId) continue
    targets.add(node.id)
  }
  if (targets.size === 0) return doc
  const doomed = new Set(targets)
  let changed = true
  while (changed) {
    changed = false
    for (const node of doc.nodes) {
      if (node.parentId && doomed.has(node.parentId) && !doomed.has(node.id)) {
        doomed.add(node.id)
        changed = true
      }
    }
  }
  return { ...doc, nodes: doc.nodes.filter((node) => !doomed.has(node.id)) }
}

/* ------------------------------------------------------------------ */
/* 论文拆解同步（PD38）：拆解要点写为根节点子节点，幂等且不改用户改名    */
/* ------------------------------------------------------------------ */

/** 节点来源标记：表示该节点由「论文拆解结果同步」写入 */
export const MINDMAP_DIGEST_SOURCE = 'digest' as const

/** 待写入地图的一条拆解要点；id 来自 shared/api 的 digestPointId（同一要点恒定） */
export interface MindMapDigestPoint {
  id?: string
  title: string
  body?: string
}

/** 合并结果：added=本次新增节点数，reused=已存在而跳过数 */
export interface MindMapDigestMerge {
  doc: MindMapDoc
  ids: string[]
  added: number
  reused: number
}

/**
 * 要点 id 兜底：与 shared/api.ts 的 digestPointId 使用同一 FNV-1a，
 * 保证「先同步到知识库、再同步到地图」得到同一个稳定 id。
 */
function digestNodeIdFor(point: MindMapDigestPoint): string {
  const normalized = `${String(point?.title ?? '').trim()}\n${String(point?.body ?? '').trim()}`
  let hash = 0x811c9dc5
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `dg-${hash.toString(16).padStart(8, '0')}`
}

/**
 * 把拆解要点追加为根节点的子节点（source='digest'）：
 * - 节点 id 由要点内容决定，重复同步同一份拆解命中同 id → 跳过，不新增；
 * - 已存在的节点（含用户手工改名过的）绝不 rename、不移动；
 * - 新节点排在根节点现有子节点之后，不覆盖任何已有节点。
 */
export function mergeDigestNodes(
  doc: MindMapDoc,
  points: ReadonlyArray<MindMapDigestPoint>
): MindMapDigestMerge {
  const root = findNode(doc, doc.rootId)
  if (!root) return { doc, ids: [], added: 0, reused: 0 }
  const existing = new Set(doc.nodes.map((node) => node.id))
  const known = new Set<string>()
  const rowStart = doc.nodes.filter((node) => node.parentId === root.id).length
  const created: MindMapNode[] = []
  const ids: string[] = []
  let reused = 0
  for (const raw of Array.isArray(points) ? points : []) {
    const title = cleanText(raw?.title, '')
    if (!title) continue
    const id = (
      typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : digestNodeIdFor(raw)
    ).trim()
    if (!id || known.has(id)) continue
    known.add(id)
    ids.push(id)
    if (existing.has(id)) {
      // 同一要点已经写过：保留既有节点（用户可能已改名），只记录 id 供撤销/角标
      reused += 1
      continue
    }
    created.push({
      id,
      parentId: root.id,
      text: title,
      x: MINDMAP_ROOT_X + MINDMAP_CHILD_DX,
      y: MINDMAP_ROOT_Y + (rowStart + created.length) * MINDMAP_CHILD_DY,
      source: MINDMAP_DIGEST_SOURCE
    })
  }
  if (created.length === 0) return { doc, ids, added: 0, reused }
  return {
    doc: settleMindMapLayout({ ...doc, nodes: [...doc.nodes, ...created] }),
    ids,
    added: created.length,
    reused
  }
}

/**
 * 撤销「拆解同步」写入的节点：只删仍带 digest 标记的节点及其子树，
 * 用户手工建的/改名的节点不动；没有可删节点时原样返回同一份 doc。
 */
export function removeDigestNodes(doc: MindMapDoc): MindMapDoc {
  const doomed = new Set<string>()
  for (const node of doc.nodes) {
    if (node.source === MINDMAP_DIGEST_SOURCE && node.id !== doc.rootId) doomed.add(node.id)
  }
  if (doomed.size === 0) return doc
  let changed = true
  while (changed) {
    changed = false
    for (const node of doc.nodes) {
      if (node.parentId && doomed.has(node.parentId) && !doomed.has(node.id)) {
        doomed.add(node.id)
        changed = true
      }
    }
  }
  return { ...doc, nodes: doc.nodes.filter((node) => !doomed.has(node.id)) }
}
