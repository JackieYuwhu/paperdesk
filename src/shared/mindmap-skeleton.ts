/**
 * AI 结构化骨架（PD55）：把一篇文献的拆解 markdown 变成「根 → 主题 → 要点」三层骨架。
 *
 * 为什么是纯函数：规则骨架、稳定 id、清洗、AI 结果校验都必须能被单测直接 import，
 * 不依赖 Electron/数据库。真正的模型调用在 `main/services/mindmap-skeleton.ts` 里注入。
 *
 * 硬约束：
 * - 3 层（level 1 根 / 2 主题 / 3 要点），总节点 8–40，单节点 ≤80 字；
 * - 禁 Markdown 记号与省略号，节点文本一律中文可读；
 * - 节点 id 由「主题路径」重算，相同输入两次得到同一组 id（覆盖同步才能幂等）；
 * - 材料不足时宁可少给节点并返回可读 warnings，也不编造内容。
 */
import type { MindMapDoc, MindMapNode, MindmapSkeletonMode } from './types'
// @ts-expect-error TS5097：测试用 `node scripts/test-unit.ts` 直接加载本文件，Node ESM 需要显式扩展名
import { digestPointKind, digestPointsFromMarkdown, type DigestPointKind } from './api.ts'

export const MINDMAP_SKELETON_ROOT_ID = 'sk-root'
export const MINDMAP_SKELETON_MIN_NODES = 8
export const MINDMAP_SKELETON_MAX_NODES = 40
export const MINDMAP_SKELETON_MAX_NODE_CHARS = 80
export const MINDMAP_SKELETON_MAX_TOPICS = 8
export const MINDMAP_SKELETON_MAX_POINTS_PER_TOPIC = 8
export const MINDMAP_SKELETON_MAX_MARKDOWN_CHARS = 6000

/** 骨架节点：parentId 为 null 的只有根；level 固定 1/2/3 */
export interface MindmapSkeletonNode {
  id: string
  parentId: string | null
  text: string
  level: 1 | 2 | 3
  /** 根到该节点的文本路径（重算 id 与调试用） */
  topicPath: string[]
}

export interface MindmapSkeletonInput {
  title?: string | null
  markdown: string
  /** 可选的已切分要点；缺省时从 markdown 解析 */
  points?: ReadonlyArray<{ title: string; body?: string }>
}

export interface MindmapSkeleton {
  mode: MindmapSkeletonMode
  nodes: MindmapSkeletonNode[]
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* 文本清洗与稳定 id                                                    */
/* ------------------------------------------------------------------ */

const MARKDOWN_MARKS = /(\*\*|__|~~|`|!?\[[^\]]*\]\([^)]*\)|^\s{0,3}#{1,6}\s|^\s*[-*+]\s+|^\s*\d+[.)]\s+)/mu

/** 是否还残留 Markdown 记号或省略号（AI 结果校验与单测用） */
export function hasSkeletonMarkup(text: string): boolean {
  if (typeof text !== 'string') return true
  if (/…|\.{3,}/u.test(text)) return true
  return MARKDOWN_MARKS.test(text)
}

/**
 * 清洗节点文本：去代码块/链接/强调/标题/列表符，折叠空白，硬截断到 80 字。
 * 截断不补省略号（用户明确要求节点不要省略号，显示文本本身就要完整）。
 */
export function cleanSkeletonText(raw: string, maxChars = MINDMAP_SKELETON_MAX_NODE_CHARS): string {
  let text = String(raw ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/…+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  text = text.replace(/[。；;，,、\s]+$/u, '').trim()
  const limit = Math.max(4, Math.floor(maxChars))
  if (text.length > limit) text = text.slice(0, limit).trimEnd()
  return text
}

function fnv1a(input: string, seed: number): string {
  let hash = seed >>> 0
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 稳定节点 id：同一路径永远同一 id；根固定 sk-root */
export function skeletonNodeId(topicPath: ReadonlyArray<string>): string {
  const path = topicPath.map((item) => cleanSkeletonText(item)).filter(Boolean)
  if (path.length === 0) return MINDMAP_SKELETON_ROOT_ID
  return `sk-${fnv1a(path.join(' / '), 0x811c9dc5)}`
}

/* ------------------------------------------------------------------ */
/* 规则骨架                                                            */
/* ------------------------------------------------------------------ */

const KIND_TOPIC: Record<DigestPointKind, string> = {
  concept: '概念与背景',
  method: '方法与设计',
  result: '结果与结论',
  dataset: '数据与样本',
  metric: '指标与评测',
  claim: '主要观点',
  question: '问题与局限'
}

interface TopicDraft {
  title: string
  points: string[]
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*$/
const BULLET_RE = /^\s*(?:[-*+•·]|\d+[.)、])\s+(.+)$/u

function cleanHeading(raw: string): string {
  return cleanSkeletonText(raw)
}

/** 从 markdown 的二级/三级标题切出「主题 → 要点」草稿；解析不出主题返回空数组 */
function topicsFromHeadings(markdown: string): TopicDraft[] {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  const headings = lines
    .map((line, index) => {
      const match = HEADING_RE.exec(line)
      if (!match) return null
      return { level: match[1].length, text: cleanHeading(match[2]), index }
    })
    .filter((row): row is { level: number; text: string; index: number } => !!row && !!row.text)

  for (const topicLevel of [2, 3]) {
    const topics = headings.filter((row) => row.level === topicLevel)
    if (topics.length < 2) continue
    const drafts: TopicDraft[] = []
    for (let i = 0; i < topics.length; i += 1) {
      const topic = topics[i]
      const nextIndex = i + 1 < topics.length ? topics[i + 1].index : lines.length
      const points: string[] = []
      for (let lineIndex = topic.index + 1; lineIndex < nextIndex; lineIndex += 1) {
        const line = lines[lineIndex]
        if (!line || !line.trim()) continue
        if (HEADING_RE.test(line)) continue
        const bullet = BULLET_RE.exec(line)
        const text = cleanSkeletonText(bullet ? bullet[1] : line)
        if (!text) continue
        points.push(text)
        if (points.length >= MINDMAP_SKELETON_MAX_POINTS_PER_TOPIC) break
      }
      if (points.length > 0) drafts.push({ title: topic.text, points })
      if (drafts.length >= MINDMAP_SKELETON_MAX_TOPICS) break
    }
    if (drafts.length >= 2) return drafts
  }
  return []
}

/** 规则骨架：标题层级优先，退化为按要点类型分组；不足 8 个节点时如实警告 */
export function buildRuleSkeleton(input: MindmapSkeletonInput): MindmapSkeleton {
  const title =
    cleanSkeletonText(String(input?.title ?? ''), MINDMAP_SKELETON_MAX_NODE_CHARS) || '未命名文献'
  const markdown = String(input?.markdown ?? '')
  const warnings: string[] = []
  let drafts = topicsFromHeadings(markdown)

  if (drafts.length < 2) {
    const points: Array<{ title: string; body?: string }> = input?.points?.length
      ? input.points.map((point) => ({ title: point.title, body: point.body }))
      : digestPointsFromMarkdown(markdown)
    const byKind = new Map<DigestPointKind, string[]>()
    for (const point of points) {
      const text = cleanSkeletonText(point.title)
      if (!text) continue
      const kind = digestPointKind(point.title)
      const bucket = byKind.get(kind) ?? []
      if (bucket.length >= MINDMAP_SKELETON_MAX_POINTS_PER_TOPIC) continue
      bucket.push(text)
      byKind.set(kind, bucket)
    }
    drafts = [...byKind.entries()]
      .map(([kind, items]) => ({ title: KIND_TOPIC[kind], points: items }))
      .filter((draft) => draft.points.length > 0)
      .slice(0, MINDMAP_SKELETON_MAX_TOPICS)
    if (drafts.length > 0) {
      warnings.push('拆解里没有可用的章节标题，按要点类型生成规则骨架')
    }
  }

  const nodes: MindmapSkeletonNode[] = [
    {
      id: MINDMAP_SKELETON_ROOT_ID,
      parentId: null,
      text: title,
      level: 1,
      topicPath: [title]
    }
  ]
  for (const draft of drafts) {
    if (nodes.length >= MINDMAP_SKELETON_MAX_NODES) break
    const topicText = cleanSkeletonText(draft.title)
    if (!topicText) continue
    if (nodes.some((node) => node.level === 2 && node.text === topicText)) continue
    const topicNode: MindmapSkeletonNode = {
      id: skeletonNodeId([title, topicText]),
      parentId: MINDMAP_SKELETON_ROOT_ID,
      text: topicText,
      level: 2,
      topicPath: [title, topicText]
    }
    nodes.push(topicNode)
    for (const point of draft.points) {
      if (nodes.length >= MINDMAP_SKELETON_MAX_NODES) break
      const pointText = cleanSkeletonText(point)
      if (!pointText || pointText === topicText) continue
      const pointPath = [title, topicText, pointText]
      if (nodes.some((node) => node.id === skeletonNodeId(pointPath))) continue
      nodes.push({
        id: skeletonNodeId(pointPath),
        parentId: topicNode.id,
        text: pointText,
        level: 3,
        topicPath: pointPath
      })
    }
  }

  if (nodes.length < MINDMAP_SKELETON_MIN_NODES) {
    warnings.push(
      `拆解材料不足，只生成了 ${nodes.length} 个节点；补充章节要点后可重新同步生成完整骨架`
    )
  }
  return { mode: 'rule', nodes, warnings }
}

/* ------------------------------------------------------------------ */
/* AI 骨架：prompt 与严格校验                                          */
/* ------------------------------------------------------------------ */

/** AI 骨架必须返回的严格 JSON 形状 */
export interface MindmapSkeletonAiPayload {
  topics: Array<{ title: string; points: string[] }>
}

export function buildSkeletonPrompt(input: MindmapSkeletonInput): { system: string; user: string } {
  const title = cleanSkeletonText(String(input?.title ?? '')) || '未命名文献'
  const material = String(input?.markdown ?? '').slice(0, MINDMAP_SKELETON_MAX_MARKDOWN_CHARS)
  const system = [
    '你是文献阅读助手，负责把一篇文献的拆解材料整理成思维导图骨架。',
    '只能使用用户提供的材料，不得编造材料里没有的观点、数据、方法或引用。',
    '输出必须是严格 JSON，不要 Markdown、不要解释文字。'
  ].join('\n')
  const user = [
    `论文标题：${title}`,
    '任务：按论文自身的章节/主题结构，生成 2–8 个主题分组，每个主题下 1–6 条要点，形成三层骨架（根=论文标题，二层=主题，三层=要点）。',
    '要求：',
    '1. 主题顺序尽量贴合原文结构（如 研究问题 / 方法 / 数据 / 结果 / 局限）；',
    `2. 每个节点不超过 ${MINDMAP_SKELETON_MAX_NODE_CHARS} 字，是一句可读的中文短语，不要用省略号；`,
    '3. 禁止 Markdown 记号（#、**、- 列表符、反引号、链接语法）；',
    '4. 总节点数（含根）控制在 8–40；材料不足时少给，不要补造；',
    '5. 只输出 JSON：{"topics":[{"title":"主题","points":["要点A","要点B"]}]}。',
    '',
    '材料：',
    material || '（无材料）'
  ].join('\n')
  return { system, user }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 校验 AI 返回：非法 JSON / 结构不对 / 节点不足都返回 null（调用方回退规则骨架）。
 * 返回的节点 id 一律按路径重算，不信任模型给的 id。
 */
export function parseSkeletonAiResult(raw: string, input: MindmapSkeletonInput): MindmapSkeletonNode[] | null {
  let payload: unknown = null
  const text = String(raw ?? '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
  if (!text) return null
  try {
    payload = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      payload = JSON.parse(text.slice(start, end + 1))
    } catch {
      return null
    }
  }
  if (!isRecord(payload) || !Array.isArray(payload.topics)) return null

  const title =
    cleanSkeletonText(String(input?.title ?? ''), MINDMAP_SKELETON_MAX_NODE_CHARS) || '未命名文献'
  const nodes: MindmapSkeletonNode[] = [
    { id: MINDMAP_SKELETON_ROOT_ID, parentId: null, text: title, level: 1, topicPath: [title] }
  ]
  const topicSeen = new Set<string>()
  for (const topic of payload.topics) {
    if (nodes.length >= MINDMAP_SKELETON_MAX_NODES) break
    if (!isRecord(topic)) continue
    const topicText = cleanSkeletonText(typeof topic.title === 'string' ? topic.title : '')
    if (!topicText || topicSeen.has(topicText)) continue
    if (hasSkeletonMarkup(topicText)) continue
    topicSeen.add(topicText)
    const topicPath = [title, topicText]
    const topicNode: MindmapSkeletonNode = {
      id: skeletonNodeId(topicPath),
      parentId: MINDMAP_SKELETON_ROOT_ID,
      text: topicText,
      level: 2,
      topicPath
    }
    nodes.push(topicNode)
    const points = Array.isArray(topic.points) ? topic.points : []
    for (const point of points) {
      if (nodes.length >= MINDMAP_SKELETON_MAX_NODES) break
      if (typeof point !== 'string') continue
      const pointText = cleanSkeletonText(point)
      if (!pointText || pointText === topicText || hasSkeletonMarkup(pointText)) continue
      const pointPath = [title, topicText, pointText]
      const id = skeletonNodeId(pointPath)
      if (nodes.some((node) => node.id === id)) continue
      nodes.push({ id, parentId: topicNode.id, text: pointText, level: 3, topicPath: pointPath })
    }
  }
  if (nodes.length < MINDMAP_SKELETON_MIN_NODES) return null
  if (nodes.length > MINDMAP_SKELETON_MAX_NODES) return nodes.slice(0, MINDMAP_SKELETON_MAX_NODES)
  return nodes
}

/** 组合结果：AI 骨架可用则用，否则规则骨架 + 可读 warning（绝不抛异常） */
export function buildSkeletonResult(
  input: MindmapSkeletonInput,
  aiNodes: MindmapSkeletonNode[] | null,
  warning?: string | null
): MindmapSkeleton {
  if (aiNodes && aiNodes.length >= MINDMAP_SKELETON_MIN_NODES) {
    return { mode: 'ai', nodes: aiNodes, warnings: [] }
  }
  const rule = buildRuleSkeleton(input)
  const warnings = [...rule.warnings]
  if (warning && warning.trim()) warnings.unshift(warning.trim())
  if (warnings.length === 0) warnings.push('未使用 AI 骨架，已按拆解结构生成规则骨架')
  return { mode: 'rule', nodes: rule.nodes, warnings }
}

/* ------------------------------------------------------------------ */
/* 覆盖式写入地图                                                      */
/* ------------------------------------------------------------------ */

export interface SkeletonApplyMeta {
  syncId: string
  batchId?: string | null
  mode: MindmapSkeletonMode
  /** 布局参数，默认与拆解布局一致 */
  layout?: { rootX: number; rootY: number; childDx: number; childDy: number }
}

export interface SkeletonApplyResult {
  doc: MindMapDoc
  added: number
  removed: number
  kept: number
  /** 本次写入的节点 id（含主题与要点，不含根） */
  nodeIds: string[]
}

const DEFAULT_LAYOUT = { rootX: 48, rootY: 48, childDx: 248, childDy: 72 }
const TOPIC_ROW_DY = 96
const POINT_ROW_DY = 56

function isEditedSyncNode(node: MindMapNode): boolean {
  const provenance = node.provenance
  if (!provenance || provenance.source !== 'sync') return false
  if (provenance.userEdited) return true
  if (typeof provenance.originText === 'string' && node.text !== provenance.originText) return true
  if (typeof provenance.originX === 'number' && node.x !== provenance.originX) return true
  if (typeof provenance.originY === 'number' && node.y !== provenance.originY) return true
  return false
}

function hashText(text: string): string {
  return fnv1a(text, 0x01000193)
}

/**
 * 把骨架覆盖写入地图：
 * - 先删「上一次同步写入且未被用户改过」的节点（无 provenance 的老节点一律当用户节点保留）；
 * - 用户改过名的同步节点保留下来（kept），父节点被删时重新挂到根，避免丢内容；
 * - 已存在同 syncId 且节点集合一致时直接返回 0/0，保证重复同步幂等；
 * - 返回新的 doc（不修改入参），调用方据 added/removed/kept 与 syncId 写盘。
 */
export function applySkeletonToMindMap(
  doc: MindMapDoc,
  skeleton: ReadonlyArray<MindmapSkeletonNode>,
  meta: SkeletonApplyMeta
): SkeletonApplyResult {
  const layout = meta.layout ?? DEFAULT_LAYOUT
  const syncId = String(meta.syncId ?? '')
  if (!doc || !Array.isArray(doc.nodes)) {
    return { doc, added: 0, removed: 0, kept: 0, nodeIds: [] }
  }
  const rootId = doc.rootId
  const topicNodes = skeleton.filter((node) => node.level === 2)
  const pointNodes = skeleton.filter((node) => node.level === 3)
  const planned = [...topicNodes, ...pointNodes]
  const plannedIds = new Set(planned.map((node) => node.id))

  // 幂等短路：同一份内容已经完整写入且没有待清理的旧同步节点
  if (doc.sync && doc.sync.syncId === syncId) {
    const syncNodes = doc.nodes.filter((node) => node.provenance?.source === 'sync')
    const sameSet =
      syncNodes.length === plannedIds.size && syncNodes.every((node) => plannedIds.has(node.id))
    const sameText = syncNodes.every((node) => {
      const target = planned.find((item) => item.id === node.id)
      return !!target && target.text === node.text
    })
    if (sameSet && sameText) {
      return { doc, added: 0, removed: 0, kept: 0, nodeIds: [] }
    }
  }

  const keptNodes: MindMapNode[] = []
  const removedIds = new Set<string>()
  let kept = 0
  for (const node of doc.nodes) {
    if (node.provenance?.source !== 'sync') continue
    if (isEditedSyncNode(node)) {
      keptNodes.push(node)
      kept += 1
      continue
    }
    removedIds.add(node.id)
  }

  const survivorIds = new Set(doc.nodes.filter((node) => !removedIds.has(node.id)).map((node) => node.id))
  const usedIds = new Set<string>(survivorIds)
  const nextNodes: MindMapNode[] = doc.nodes
    .filter((node) => !removedIds.has(node.id))
    .map((node) => {
      if (removedIds.has(node.parentId ?? '')) return { ...node, parentId: rootId }
      return node
    })

  const now = new Date().toISOString()
  const created: MindMapNode[] = []
  const nodeIds: string[] = []
  let topicRow = 0
  for (const topic of topicNodes) {
    const y = layout.rootY + topicRow * TOPIC_ROW_DY
    const x = layout.rootX + layout.childDx
    // 主题可能是用户改过名而保留下来的节点：此时不再新建，但它的要点仍要补齐。
    if (!usedIds.has(topic.id)) {
      usedIds.add(topic.id)
      created.push({
        id: topic.id,
        parentId: rootId,
        text: topic.text,
        x,
        y,
        source: 'digest',
        provenance: {
          source: 'sync',
          syncId,
          batchId: meta.batchId ?? null,
          contentHash: hashText(topic.text),
          originText: topic.text,
          originX: x,
          originY: y,
          userEdited: false,
          topicPath: [...topic.topicPath]
        }
      })
    }
    nodeIds.push(topic.id)
    const points = pointNodes.filter((node) => node.parentId === topic.id)
    let pointRow = 0
    for (const point of points) {
      if (usedIds.has(point.id)) {
        nodeIds.push(point.id)
        pointRow += 1
        continue
      }
      const pointX = x + layout.childDx
      const pointY = y + pointRow * POINT_ROW_DY
      usedIds.add(point.id)
      created.push({
        id: point.id,
        parentId: topic.id,
        text: point.text,
        x: pointX,
        y: pointY,
        source: 'digest',
        provenance: {
          source: 'sync',
          syncId,
          batchId: meta.batchId ?? null,
          contentHash: hashText(point.text),
          originText: point.text,
          originX: pointX,
          originY: pointY,
          userEdited: false,
          topicPath: [...point.topicPath]
        }
      })
      nodeIds.push(point.id)
      pointRow += 1
    }
    topicRow += 1
  }

  // 保留下来的用户编辑节点若原本挂在被删的同步父节点下，已在上方重新挂到根；
  // 这里再把它们的 provenance 标成 userEdited，避免下次同步再次尝试删除。
  const finalNodes = [...nextNodes, ...created].map((node) => {
    if (node.provenance?.source === 'sync' && keptNodes.some((item) => item.id === node.id)) {
      return { ...node, provenance: { ...node.provenance, userEdited: true } }
    }
    return node
  })

  const nextDoc: MindMapDoc = {
    ...doc,
    nodes: finalNodes,
    updatedAt: now,
    sync: {
      syncId,
      batchId: meta.batchId ?? null,
      mode: meta.mode,
      nodeIds: [...nodeIds],
      updatedAt: now
    }
  }
  return { doc: nextDoc, added: created.length, removed: removedIds.size, kept, nodeIds }
}
