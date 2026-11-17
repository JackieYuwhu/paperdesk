/**
 * PD57：「AI 优化」的差异预览与逐项应用（纯函数，无 React / Electron）。
 *
 * AI 只给建议，用户逐项勾选后才改地图；应用前由调用方保存整份地图快照，
 * 沿用工具栏「撤销上一步」。合并重复子节点只处理叶子节点，且只在渲染层按
 * 文本相似度匹配，绝不因为模型给错 id 而误删用户内容。
 */
import type { MindMapDoc } from '../../../../shared/types'
import type { MindmapOptimizeResult } from '../../../../shared/mindmap-ai.ts'
// @ts-expect-error TS5097
import { stripMarkdownForMap } from '../../../../shared/mindmap-ai.ts'
// @ts-expect-error TS5097
import { addChild, findNode, removeNode, renameNode } from './mindmap-model.ts'

export type MindmapOptimizeChange =
  | {
      kind: 'rename'
      id: string
      before: string
      after: string
      reason: string
    }
  | {
      kind: 'child'
      id: string
      text: string
      reason: string
    }
  | {
      kind: 'merge'
      id: string
      keepId: string
      keepText: string
      dropIds: string[]
      dropTexts: string[]
      reason: string
    }

export interface MindmapOptimizePreview {
  nodeId: string
  nodeText: string
  changes: MindmapOptimizeChange[]
  rationale: string
}

export interface MindmapOptimizeApplyResult {
  doc: MindMapDoc
  applied: number
}

const DEFAULT_RATIONALE = 'AI 只依据当前节点的标题、子节点与原文片段给建议；可逐项勾选后再应用。'

/** 只保留可读文字并去掉标点/空白，用于相似度比较 */
function normalizeForCompare(text: string): string {
  return stripMarkdownForMap(text)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 二元组 Dice 相似度：0–1，完全一致为 1 */
export function textSimilarity(a: string, b: string): number {
  const left = normalizeForCompare(a)
  const right = normalizeForCompare(b)
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0
  const grams = new Map<string, number>()
  for (let i = 0; i < left.length - 1; i += 1) {
    const gram = left.slice(i, i + 2)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  let hits = 0
  for (let i = 0; i < right.length - 1; i += 1) {
    const gram = right.slice(i, i + 2)
    const count = grams.get(gram) ?? 0
    if (count > 0) {
      hits += 1
      grams.set(gram, count - 1)
    }
  }
  return (2 * hits) / (left.length - 1 + right.length - 1)
}

/** 相似度阈值：≥0.78 且都至少 4 个字才建议合并，避免把相邻概念误判为重复 */
export const MINDMAP_MERGE_SIMILARITY = 0.78

/**
 * 构造差异预览：rename（精简措辞）、child（补有依据的子节点）、merge（合并重复）。
 * 结果只包含真正会改变地图的项；没有可执行项时 changes 为空，UI 提示原因。
 */
export function buildOptimizePreview(
  doc: MindMapDoc,
  nodeId: string,
  result: MindmapOptimizeResult
): MindmapOptimizePreview | null {
  const node = findNode(doc, nodeId)
  if (!node) return null
  const nodeText = stripMarkdownForMap(node.text)
  const children = doc.nodes.filter((child) => child.parentId === node.id)
  const existingKeys = new Set(children.map((child) => normalizeForCompare(child.text)))
  const changes: MindmapOptimizeChange[] = []
  const reason = result.rationale || DEFAULT_RATIONALE

  // 1) 精简选中节点措辞
  const renamed = stripMarkdownForMap(result.summary ?? '')
  if (renamed && renamed !== nodeText && normalizeForCompare(renamed) !== normalizeForCompare(nodeText)) {
    changes.push({
      kind: 'rename',
      id: 'rename',
      before: nodeText,
      after: renamed,
      reason
    })
  }

  // 2) 补子节点：优先 children，其次把旧版 topics 的要点作为候选；跳过已有的
  const candidates: string[] = []
  for (const value of result.children ?? []) candidates.push(value)
  for (const topic of result.topics ?? []) {
    for (const point of topic.points) candidates.push(point)
  }
  let childIndex = 0
  for (const candidate of candidates) {
    const text = stripMarkdownForMap(candidate)
    if (!text) continue
    const key = normalizeForCompare(text)
    if (!key || existingKeys.has(key)) continue
    existingKeys.add(key)
    changes.push({ kind: 'child', id: `child:${childIndex}`, text, reason })
    childIndex += 1
    if (childIndex >= 3) break
  }

  // 3) 合并重复子节点：模型给对 id 就用 id，否则按文本相似度找叶子重复项
  const leafChildren = children.filter(
    (child) => !doc.nodes.some((candidate) => candidate.parentId === child.id)
  )
  const merged = new Set<string>()
  for (const child of leafChildren) {
    if (merged.has(child.id)) continue
    const group = leafChildren.filter(
      (other) =>
        other.id !== child.id &&
        !merged.has(other.id) &&
        (other.id === child.id ||
          (result.mergedIds ?? []).includes(other.id) ||
          (result.mergedIds ?? []).includes(stripMarkdownForMap(other.text)) ||
          textSimilarity(child.text, other.text) >= MINDMAP_MERGE_SIMILARITY)
    )
    if (group.length === 0) continue
    merged.add(child.id)
    for (const item of group) merged.add(item.id)
    changes.push({
      kind: 'merge',
      id: `merge:${child.id}`,
      keepId: child.id,
      keepText: stripMarkdownForMap(child.text),
      dropIds: group.map((item) => item.id),
      dropTexts: group.map((item) => stripMarkdownForMap(item.text)),
      reason: '这些子节点表达的是同一件事（文本高度相似），保留第一条即可。'
    })
  }

  return { nodeId, nodeText, changes, rationale: reason }
}

/**
 * 应用被勾选的改动：按 rename → child → merge 的顺序执行，合并只删仍存在的叶子节点。
 * 从未被接受的项绝不会改动地图。
 */
export function applyOptimizePreview(
  doc: MindMapDoc,
  preview: MindmapOptimizePreview,
  acceptedIds: ReadonlyArray<string>
): MindmapOptimizeApplyResult {
  const accepted = new Set(acceptedIds)
  let next = doc
  let applied = 0
  for (const change of preview.changes) {
    if (!accepted.has(change.id)) continue
    if (change.kind === 'rename') {
      if (!findNode(next, preview.nodeId)) continue
      next = renameNode(next, preview.nodeId, change.after)
      applied += 1
      continue
    }
    if (change.kind === 'child') {
      const grown = addChild(next, preview.nodeId, change.text)
      if (grown === next) continue
      next = grown
      applied += 1
      continue
    }
    for (const dropId of change.dropIds) {
      if (dropId === change.keepId) continue
      if (!findNode(next, dropId)) continue
      if (next.nodes.some((node) => node.parentId === dropId)) continue
      next = removeNode(next, dropId)
      applied += 1
    }
  }
  return { doc: next, applied }
}
