/**
 * 整图 AI 优化（PD58）的纯逻辑：把模型给的「分组 + 要点」变成可预览、可逐组接受的改动。
 *
 * 设计约束：
 *  - 只是纯函数（不碰 React / IPC），供 MindMapPanel 与 scripts/test-unit.ts 共用；
 *  - 非破坏性：用户手写的节点永不被删，只有 AI / 同步生成的重复节点会被合并掉；
 *  - 复用优先：已有根子节点与某个分组标题足够相似时，直接复用它，避免地图越叠越乱；
 *  - 结果确定：同一输入永远得到同一份预览（id 连续、坐标按行号排布）。
 */
import type { MindMapDoc, MindMapNode } from '../../../../shared/types'
import type { MindmapMapOptimizeResult } from '../../../../shared/mindmap-ai.ts'
// @ts-expect-error TS5097 —— 单元测试用 node 直接跑，需要显式扩展名
import { MINDMAP_AI_SOURCE, MINDMAP_CHILD_DX, MINDMAP_CHILD_DY, MINDMAP_ROOT_X, MINDMAP_ROOT_Y, childrenOf, findNode, settleMindMapLayout } from './mindmap-model.ts'
// @ts-expect-error TS5097 —— 同上
import { MINDMAP_MERGE_SIMILARITY, textSimilarity } from './mindmap-optimize.ts'

/** 整图优化生成的节点来源标记（复用 AI 生成标记，节点来源枚举已含该值） */
export const MINDMAP_MAP_SOURCE = MINDMAP_AI_SOURCE

/** 可以被整图优化合并掉的来源（用户手写节点不在其中） */
const GENERATED_SOURCES = new Set<string>([MINDMAP_MAP_SOURCE, 'digest', 'sync'])

export interface MindmapMapOptimizePreviewGroup {
  /** 预览内稳定 id（应用时按它过滤） */
  id: string
  title: string
  points: string[]
  /** 复用的现有根子节点 id；新建时为空 */
  reuseId: string | null
  /** 这些要点已存在于地图里，应用时不会重复添加 */
  reusedPoints: string[]
  /** 这些要点会新增成子节点 */
  newPoints: string[]
}

export interface MindmapMapOptimizePreview {
  groups: MindmapMapOptimizePreviewGroup[]
  /** 新增节点数（含新建的分组节点） */
  added: number
  /** 复用/跳过数 */
  reused: number
  /** 会被合并掉的重复节点数 */
  merged: number
  rationale: string
  /** 合并时会删除的节点 id（应用时执行，可整份撤销） */
  dropIds: string[]
}

export interface MindmapMapOptimizeApplyResult {
  doc: MindMapDoc
  /** 本次新增的节点 id */
  addedIds: string[]
  /** 本次删除的节点 id（撤销靠整份文档快照） */
  removedIds: string[]
}

function uniqueId(doc: MindMapDoc, prefix: string, used: Set<string>): string {
  const existing = new Set(doc.nodes.map((node) => node.id))
  let index = doc.nodes.length + 1
  for (;;) {
    const id = `${prefix}-${index}`
    if (!existing.has(id) && !used.has(id)) {
      used.add(id)
      return id
    }
    index += 1
  }
}

function clean(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/** 找出与给定文本最相似的现有子节点（阈值同节点级优化；标题允许包含关系） */
function bestMatch(nodes: ReadonlyArray<MindMapNode>, text: string): MindMapNode | null {
  const target = clean(text).toLowerCase()
  let best: MindMapNode | null = null
  let bestScore = 0
  for (const node of nodes) {
    const candidate = clean(node.text).toLowerCase()
    if (!candidate || !target) continue
    let score = textSimilarity(candidate, target)
    // 「背景」与「引言与背景」这类包含关系也算命中，短标题至少 2 字，避免误合并单字节点
    if (
      (candidate.includes(target) || target.includes(candidate)) &&
      Math.min(candidate.length, target.length) >= 2
    ) {
      score = Math.max(score, MINDMAP_MERGE_SIMILARITY + 0.1)
    }
    if (score > bestScore) {
      best = node
      bestScore = score
    }
  }
  return best && bestScore >= MINDMAP_MERGE_SIMILARITY ? best : null
}

/** 生成预览：不修改传入的文档 */
export function buildMapOptimizePreview(
  doc: MindMapDoc,
  result: MindmapMapOptimizeResult
): MindmapMapOptimizePreview {
  const root = findNode(doc, doc.rootId)
  const rootChildren = root ? childrenOf(doc, doc.rootId) : []
  const groups: MindmapMapOptimizePreviewGroup[] = []
  const claimed = new Set<string>()
  let added = 0
  let reused = 0

  result.groups.forEach((group, index) => {
    const title = clean(group.title)
    if (!title) return
    const available = rootChildren.filter((node) => !claimed.has(node.id))
    const matchedGroup = bestMatch(available, title)
    if (matchedGroup) claimed.add(matchedGroup.id)
    const targetChildren = matchedGroup ? childrenOf(doc, matchedGroup.id) : []
    const reusedPoints: string[] = []
    const newPoints: string[] = []
    const seen = new Set<string>()
    for (const rawPoint of group.points) {
      const point = clean(rawPoint)
      if (!point) continue
      const key = point.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      if (
        bestMatch(targetChildren, point) ||
        textSimilarity(title, point) >= MINDMAP_MERGE_SIMILARITY
      ) {
        reusedPoints.push(point)
        reused += 1
        continue
      }
      newPoints.push(point)
    }
    if (!matchedGroup && newPoints.length === 0) return
    if (!matchedGroup) added += 1
    else reused += 1
    added += newPoints.length
    groups.push({
      id: `group-${index + 1}`,
      title,
      points: [...reusedPoints, ...newPoints],
      reuseId: matchedGroup ? matchedGroup.id : null,
      reusedPoints,
      newPoints
    })
  })

  // 合并重复：只处理 AI / 同步生成、且没有子节点的叶子，避免误删用户内容
  const dropIds: string[] = []
  const addedTexts = groups.flatMap((group) => group.newPoints)
  for (const node of doc.nodes) {
    if (node.parentId === doc.rootId) continue
    if (!node.source || !GENERATED_SOURCES.has(node.source)) continue
    if (childrenOf(doc, node.id).length > 0) continue
    const text = clean(node.text)
    if (!text) continue
    const duplicated = addedTexts.some((other) => textSimilarity(text, other) >= 0.9)
    if (duplicated && !dropIds.includes(node.id)) dropIds.push(node.id)
  }

  return {
    groups,
    added,
    reused,
    merged: dropIds.length,
    rationale: result.rationale ?? '',
    dropIds
  }
}

/** 应用预览：按 acceptedIds 过滤分组，重排后返回新文档（不修改入参） */
export function applyMapOptimize(
  doc: MindMapDoc,
  preview: MindmapMapOptimizePreview,
  acceptedIds: ReadonlyArray<string>
): MindmapMapOptimizeApplyResult {
  const root = findNode(doc, doc.rootId)
  if (!root) return { doc, addedIds: [], removedIds: [] }
  const accepted = new Set(acceptedIds)
  const acceptedGroups = preview.groups.filter((group) => accepted.has(group.id))
  if (acceptedGroups.length === 0) return { doc, addedIds: [], removedIds: [] }

  const used = new Set<string>()
  const nodes: MindMapNode[] = [...doc.nodes]
  const addedIds: string[] = []
  let row = childrenOf(doc, doc.rootId).length

  for (const group of acceptedGroups) {
    let groupId = group.reuseId
    if (!groupId) {
      groupId = uniqueId(doc, 'ai-map', used)
      nodes.push({
        id: groupId,
        parentId: doc.rootId,
        text: group.title,
        x: MINDMAP_ROOT_X + MINDMAP_CHILD_DX,
        y: MINDMAP_ROOT_Y + row * MINDMAP_CHILD_DY,
        source: MINDMAP_MAP_SOURCE
      })
      addedIds.push(groupId)
      row += 1
    }
    for (const point of group.newPoints) {
      const id = uniqueId(doc, 'ai-map', used)
      nodes.push({
        id,
        parentId: groupId,
        text: point,
        x: MINDMAP_ROOT_X + MINDMAP_CHILD_DX * 2,
        y: MINDMAP_ROOT_Y + row * MINDMAP_CHILD_DY,
        source: MINDMAP_MAP_SOURCE
      })
      addedIds.push(id)
      row += 1
    }
  }

  const drop = new Set(preview.dropIds)
  const kept = nodes.filter((node) => !drop.has(node.id))
  const next = settleMindMapLayout({ ...doc, nodes: kept, updatedAt: new Date().toISOString() })
  return { doc: next, addedIds, removedIds: [...drop] }
}
