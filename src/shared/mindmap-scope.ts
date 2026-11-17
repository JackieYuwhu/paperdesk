/**
 * 思维地图分级（全部 / 分组 / 单篇）的共享纯逻辑。
 *
 * 这里只做类型定义、scope 校验与聚合图构建：不 import electron / fs / 数据库，
 * 这样 `scripts/test-unit.ts` 能直接跑确定性布局、截断、去重与唯一 id 的单测。
 * 真正的数据查询在 `src/main/services/mindmap-scope.ts`。
 */
import type { MindMapDoc, MindMapNode } from './types'
// @ts-expect-error TS5097：测试用 `node scripts/test-unit.ts` 直接加载本文件，Node ESM 需要显式扩展名
import { measureMindmapNode, stripMarkdownForMap } from './mindmap-ai.ts'

/** 地图范围：全部论文 / 某个分组 / 单篇文献 */
export type MindmapScope =
  | { kind: 'all' }
  | { kind: 'group'; group: string }
  | { kind: 'item'; itemId: number }

/** 聚合图节点指回源范围（PD49 点击下钻用；本轮仅产生 item 级） */
export interface MindmapScopeNodeRef {
  level: 'all' | 'group' | 'item'
  itemId?: number
  group?: string
}

/** 聚合地图：只读，不回写任何单篇地图 */
export interface MindmapScopeDoc extends MindMapDoc {
  scope: MindmapScope
  label: string
  readOnly: true
  paperCount: number
  missingCount: number
}

/** 参与聚合的一篇论文（doc 为 null 表示还没有地图） */
export interface MindmapScopePaper {
  itemId: number
  title: string | null
  group: string | null
  doc: MindMapDoc | null
}

// shared 侧独立定义布局常量（与 renderer 的 mindmap-model 同值，但不跨层 import）
export const MINDMAP_ROOT_X = 48
export const MINDMAP_ROOT_Y = 48
export const MINDMAP_CHILD_DX = 248
export const MINDMAP_CHILD_DY = 72
/** PD57：节点全文显示后，聚合图列距按最大节点宽 420px + 56px 间距放列 */
export const MINDMAP_SCOPE_COL_W = 476
/** PD57：单行节点高 46px，行距 26px，正好保持原来的 72px 节奏 */
export const MINDMAP_SCOPE_ROW_GAP = 26

/** 聚合图根节点固定 id */
export const MINDMAP_SCOPE_ROOT_ID = 'scope:root'
/** 每列论文数（网格布局） */
export const MINDMAP_SCOPE_PAPERS_PER_COLUMN = 6
/** @deprecated PD57 起节点全文显示，不再按字数截断；保留导出仅为兼容旧引用 */
export const MINDMAP_SCOPE_PAPER_MAX_CHARS = 80
/** @deprecated PD57 起节点全文显示，不再按字数截断；保留导出仅为兼容旧引用 */
export const MINDMAP_SCOPE_CHILD_MAX_CHARS = 60
/** 每篇论文最多复制多少个子节点 */
export const MINDMAP_SCOPE_CHILD_LIMIT = 6
/** 无地图论文的标题后缀 */
export const MINDMAP_SCOPE_MISSING_SUFFIX = '（暂无内容）'
/** 标题兜底 */
export const MINDMAP_SCOPE_UNTITLED = '未命名文献'

function cleanTitle(value: string | null | undefined): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return stripMarkdownForMap(text) || MINDMAP_SCOPE_UNTITLED
}

/** 冲突 id 追加 -2 / -3 …，保证聚合图内 node id 全局唯一 */
function uniqueNodeId(base: string, used: Set<string>): string {
  let id = base
  let suffix = 2
  while (used.has(id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  used.add(id)
  return id
}

function paperInScope(paper: MindmapScopePaper, scope: MindmapScope): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'group') return paper.group === scope.group
  return paper.itemId === scope.itemId
}

/**
 * 校验并归一化渲染层传来的 scope（不可信输入）。
 * 非法时抛中文可读错误；服务层 `loadScopedMindMap` 直接复用它。
 */
export function normalizeMindmapScope(raw: unknown): MindmapScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('思维地图范围无效：scope 必须是对象')
  }
  const value = raw as { kind?: unknown; group?: unknown; itemId?: unknown }
  if (value.kind === 'all') return { kind: 'all' }
  if (value.kind === 'group') {
    if (typeof value.group !== 'string' || !value.group.trim()) {
      throw new Error('思维地图范围无效：分组名不能为空')
    }
    return { kind: 'group', group: value.group.trim() }
  }
  if (value.kind === 'item') {
    if (typeof value.itemId !== 'number' || !Number.isInteger(value.itemId) || value.itemId <= 0) {
      throw new Error('思维地图范围无效：文献 id 必须是正整数')
    }
    return { kind: 'item', itemId: value.itemId }
  }
  throw new Error('思维地图范围无效：仅支持 all / group / item')
}

/**
 * 把若干篇论文的地图聚合成一张只读的 scope 地图。
 *
 * 规则（确定性）：
 * - 先按 scope 过滤论文，再按 itemId 去重（重复只取第一条）；
 * - 论文节点网格排布，列优先（每列 6 篇）；
 * - 有地图的论文只复制其根的直接子节点（每篇最多 6 个），无地图的论文不产生子节点；
 * - 所有节点 id 全局唯一，重复时追加 -2 / -3 后缀。
 */
export function buildScopedMindMap(input: {
  scope: MindmapScope
  label: string
  papers: MindmapScopePaper[]
}): MindmapScopeDoc {
  const selected: MindmapScopePaper[] = []
  const seenItemIds = new Set<number>()
  for (const paper of input.papers) {
    if (!paperInScope(paper, input.scope)) continue
    if (seenItemIds.has(paper.itemId)) continue
    seenItemIds.add(paper.itemId)
    selected.push(paper)
  }

  const usedIds = new Set<string>()
  const rootId = MINDMAP_SCOPE_ROOT_ID
  usedIds.add(rootId)
  const nodes: MindMapNode[] = [
    {
      id: rootId,
      parentId: null,
      text: input.label,
      x: MINDMAP_ROOT_X,
      y: MINDMAP_ROOT_Y
    }
  ]

  let missingCount = 0
  // 每列当前可用的下一个 y（按节点实际高度累加，长标题换行后不会压住下一篇）
  const columnNextY = new Map<number, number>()
  selected.forEach((paper, index) => {
    const column = Math.floor(index / MINDMAP_SCOPE_PAPERS_PER_COLUMN)
    // 每篇论文占「论文列 + 子节点列」两列宽，避免下一篇论文压住上一组的子节点
    const paperX = MINDMAP_ROOT_X + MINDMAP_CHILD_DX + column * MINDMAP_SCOPE_COL_W * 2
    const paperY = columnNextY.get(column) ?? MINDMAP_ROOT_Y

    let paperText = cleanTitle(paper.title)
    const doc = paper.doc
    if (!doc) {
      missingCount += 1
      paperText += MINDMAP_SCOPE_MISSING_SUFFIX
    }
    const paperSize = measureMindmapNode(paperText)

    const paperNodeId = uniqueNodeId(`paper:${paper.itemId}`, usedIds)
    nodes.push({
      id: paperNodeId,
      parentId: rootId,
      text: paperText,
      x: paperX,
      y: paperY,
      ref: { level: 'item', itemId: paper.itemId }
    })

    let blockBottom = paperY + paperSize.height
    const root = doc?.nodes.find((node) => node.id === doc.rootId)
    if (!doc || !root) {
      columnNextY.set(column, blockBottom + MINDMAP_SCOPE_ROW_GAP)
      return
    }
    const children = doc.nodes
      .filter((node) => node.id !== root.id && node.parentId === root.id)
      .slice(0, MINDMAP_SCOPE_CHILD_LIMIT)
    let childY = paperY
    children.forEach((child) => {
      const text = cleanTitle(child.text)
      const size = measureMindmapNode(text)
      nodes.push({
        id: uniqueNodeId(`paper:${paper.itemId}/${child.id}`, usedIds),
        parentId: paperNodeId,
        text,
        x: paperX + MINDMAP_SCOPE_COL_W,
        y: childY,
        ref: { level: 'item', itemId: paper.itemId }
      })
      childY += size.height + MINDMAP_SCOPE_ROW_GAP
      blockBottom = Math.max(blockBottom, childY - MINDMAP_SCOPE_ROW_GAP)
    })
    columnNextY.set(column, blockBottom + MINDMAP_SCOPE_ROW_GAP)
  })

  return {
    version: 1,
    itemId: 0,
    rootId,
    nodes,
    updatedAt: '',
    scope: input.scope,
    label: input.label,
    readOnly: true,
    paperCount: selected.length,
    missingCount
  }
}
