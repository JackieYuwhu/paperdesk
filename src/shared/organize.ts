/**
 * 批处理后「智能整理」的纯逻辑层（不碰数据库、不发请求，便于单测）。
 *
 * 职责：
 * 1. 生成整理提示词（单篇结构 / 跨论文主题 / 知识条目整理）。
 * 2. 解析并**校验**模型输出：结构（父子、层级）、来源（itemId 必须来自纳入论文、
 *    页码必须在页数内、引文必须能在正文里核对到），核对不了的标为推断。
 * 3. 与已有内容做增量比对（新增 / 更新 / 保持不变 / 受保护），并给出合并建议。
 *
 * 约定：页码一律 1 基（与界面「p.3」一致），落库前由调用方转 0 基。
 */

import type { KnowledgeKind } from './types'

export type OrganizeTarget = 'mindmap' | 'knowledge'
export type OrganizePurpose = 'structure' | 'theme' | 'evidence'
export type OrganizeEngine = 'model' | 'rules'

export type OrganizeNodeKind =
  | 'root'
  | 'topic'
  | 'method'
  | 'conclusion'
  | 'gap'
  | 'concept'
  | 'evidence'

export type OrganizeEntryKind = 'concept' | 'method' | 'result' | 'claim' | 'question'

export const ORGANIZE_NODE_KINDS: readonly OrganizeNodeKind[] = [
  'root',
  'topic',
  'method',
  'conclusion',
  'gap',
  'concept',
  'evidence'
]

export const ORGANIZE_ENTRY_KINDS: readonly OrganizeEntryKind[] = [
  'concept',
  'method',
  'result',
  'claim',
  'question'
]

export const ORGANIZE_MAX_NODES = 60
export const ORGANIZE_MAX_NODE_CHARS = 100
export const ORGANIZE_MAX_ENTRIES = 24
export const ORGANIZE_MAX_ENTRY_BODY = 1200
export const ORGANIZE_MIN_QUOTE_CHARS = 8

export interface OrganizePaperRef {
  itemId: number
  title: string
}

/** 没能纳入整理的论文及原因：跨论文整理必须交代清楚 */
export interface OrganizeSkippedPaper {
  itemId: number | null
  title: string
  reason: string
}

export interface OrganizeDraftNode {
  id: string
  parentId: string | null
  text: string
  kind: OrganizeNodeKind
  /** 该节点对应的论文；跨论文归纳的共同结论可能为 null */
  itemId: number | null
  /** 1 基页码；null = 不精确到页（不得编造） */
  page: number | null
  quote: string | null
  /** 无法由证据直接确认（模型推断 / 引文核对失败） */
  inferred: boolean
  /** 用户已手改：应用同步时不得覆盖 */
  userEdited: boolean
}

export interface OrganizeDraftEvidence {
  itemId: number | null
  page: number | null
  quote: string
}

export interface OrganizeDraftEntry {
  key: string
  kind: OrganizeEntryKind
  title: string
  body: string
  itemId: number | null
  evidence: OrganizeDraftEvidence[]
  inferred: boolean
  /** 建议合并到的条目（已有条目 key 或本草稿内另一条目 key）；空 = 不合并 */
  mergeInto: string
  mergeReason: string
}

export interface OrganizeDraft {
  target: OrganizeTarget
  purpose: OrganizePurpose
  title: string
  summary: string
  nodes: OrganizeDraftNode[]
  entries: OrganizeDraftEntry[]
  included: OrganizePaperRef[]
  skipped: OrganizeSkippedPaper[]
  warnings: string[]
  issues: string[]
  engine: OrganizeEngine
}

/** 校验用的上下文：纳入论文的页数与正文（用于核对页码与引文） */
export interface OrganizeValidateContext {
  papers: OrganizePaperRef[]
  pageCounts?: Record<number, number>
  textByItem?: Record<number, string>
}

/** 生成草稿的请求：批处理批次或指定论文 */
export interface OrganizePreviewRequest {
  runId?: string | null
  itemIds?: number[] | null
  target: OrganizeTarget
  purpose: OrganizePurpose
  title?: string | null
  groupName?: string | null
}

export interface OrganizePreviewResult {
  drafts: OrganizeDraft[]
  included: OrganizePaperRef[]
  skipped: OrganizeSkippedPaper[]
  engine: OrganizeEngine
  warnings: string[]
  /** 本次整理的范围键：用于版本列表与撤销 */
  scopeKey: string
  /** 逐篇与现有思维地图的差异（仅思维地图目标）：新增/更新/未变/受保护 */
  diffs?: Record<number, { added: number; changed: number; unchanged: number; protected: number }>
}

export interface OrganizeApplyResult {
  applied: number
  nodesAdded: number
  nodesUpdated: number
  protectedNodes: number
  entriesCreated: number
  batchId: number | null
  versionId: number
  scopeKey: string
  summary: string
}

export interface OrganizeVersionRow {
  id: number
  scopeKey: string
  label: string
  target: string
  createdAt: string
}

export interface OrganizePaperSource extends OrganizePaperRef {
  markdown: string
}

export function organizeTargetLabel(target: OrganizeTarget): string {
  return target === 'mindmap' ? '思维地图' : '知识库'
}

export function organizePurposeLabel(purpose: OrganizePurpose): string {
  if (purpose === 'theme') return '跨论文主题归纳'
  if (purpose === 'evidence') return '证据整理'
  return '单篇结构整理'
}

export function organizeNodeKindLabel(kind: OrganizeNodeKind): string {
  switch (kind) {
    case 'root':
      return '主题'
    case 'method':
      return '方法'
    case 'conclusion':
      return '结论'
    case 'gap':
      return '研究空白'
    case 'concept':
      return '概念'
    case 'evidence':
      return '证据'
    default:
      return '要点'
  }
}

export function organizeEntryKindLabel(kind: OrganizeEntryKind): string {
  switch (kind) {
    case 'method':
      return '方法'
    case 'result':
      return '结论'
    case 'claim':
      return '主张'
    case 'question':
      return '问题'
    default:
      return '概念'
  }
}

/** 知识条目类型 → 知识库 kind（沿用既有枚举，不新增类型） */
export function knowledgeKindOf(entry: OrganizeDraftEntry): KnowledgeKind {
  switch (entry.kind) {
    case 'method':
      return 'method'
    case 'result':
      return 'result'
    case 'claim':
      return 'claim'
    case 'question':
      return 'question'
    default:
      return 'concept'
  }
}

/** 整理提示词：结构、来源、推断三条硬约束都写在里面，模型换不掉 */
export function buildOrganizePrompt(
  request: { target: OrganizeTarget; purpose: OrganizePurpose; title: string },
  papers: readonly OrganizePaperSource[]
): { system: string; user: string } {
  const system = [
    '你是文献整理助手。你把论文内容整理成结构化的思维地图或知识条目。',
    '只输出一个 JSON 对象，不要输出解释、不要用 Markdown 代码块包裹。',
    '硬规则：',
    '1. 层次：思维地图必须有 1 个根节点，根下至少 2 个主题，主题下再有要点（至少两层，不要把所有要点平铺在根下）。',
    '2. 来源：每个节点/条目尽量给出 itemId（来自输入论文）与 page（1 基页码）和 quote（原文片段）。',
    '   只有确实来自原文时才写 page/quote；不确定就留空，**绝不编造页码或原文**。',
    '3. 推断：跨论文归纳出来的共同点、差异、研究空白，或没有直接原文支撑的判断，必须标 "inferred": true。',
    '4. 主题归纳必须同时给出: 共同方法、不同结论、研究空白（kind 分别为 method / conclusion / gap）。',
    '5. 知识条目按 概念(concept) / 方法(method) / 结论(result) / 主张(claim) / 问题(question) 分类，body 写 1-3 句。',
    'JSON 结构：',
    '{"summary":"一句话概述","nodes":[{"id":"n1","parentId":null,"text":"根主题","kind":"root","itemId":null,"page":null,"quote":null,"inferred":false}],',
    ' "entries":[{"key":"method-xxx","kind":"method","title":"…","body":"…","itemId":1,"page":2,"quote":"…","inferred":false}]}'
  ].join('\n')

  const paperBlocks = papers.map((paper, index) => {
    const markdown = String(paper.markdown ?? '').slice(0, 6000)
    return `### 论文 ${index + 1}（itemId=${paper.itemId}）${paper.title}\n${markdown}`
  })

  const goal =
    request.target === 'mindmap'
      ? request.purpose === 'theme'
        ? '把这些论文归纳成一张「跨论文主题」思维地图：根节点是主题，其下分「共同方法」「不同结论」「研究空白」，再往下挂具体论文的要点，并尽量标注来源。'
        : '为每篇论文各生成一棵多级思维地图（根节点是论文主题，其下按方法/结论/证据分层）。'
      : '把这些论文整理成知识库条目（概念/方法/结论/证据），给出可追溯的来源。'

  const user = [`整理目的：${goal}`, `标题：${request.title}`, '', ...paperBlocks].join('\n')
  return { system, user }
}

/** 从模型回复里取出 JSON 对象（容忍 ```json 包裹与前后废话） */
export function extractJsonObject(raw: string): unknown {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

function asText(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

function asPositiveIntOrNull(value: unknown): number | null {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  const int = Math.floor(num)
  return int > 0 ? int : null
}

function normalizeForMatch(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；：、“”‘’（）()「」【】.,;:!?！？'"-]/g, '')
}

/** 引文是否能在这篇论文的正文里核对到（去空白与标点后再比） */
export function quoteMatchesSource(quote: string, source: string): boolean {
  const q = normalizeForMatch(quote)
  if (q.length < ORGANIZE_MIN_QUOTE_CHARS) return false
  const s = normalizeForMatch(source)
  if (!s) return false
  return s.includes(q) || s.includes(q.slice(0, Math.max(ORGANIZE_MIN_QUOTE_CHARS, Math.floor(q.length * 0.8))))
}

interface RawNode {
  id?: unknown
  parentId?: unknown
  text?: unknown
  kind?: unknown
  itemId?: unknown
  page?: unknown
  quote?: unknown
  inferred?: unknown
}

interface RawEntry {
  key?: unknown
  kind?: unknown
  title?: unknown
  body?: unknown
  itemId?: unknown
  page?: unknown
  quote?: unknown
  inferred?: unknown
  evidence?: unknown
}

/**
 * 校验并收拢模型输出：结构错误就地修（父节点缺失挂到根），来源错误一律降级为推断，
 * 任何「编造」都会被丢掉并记进 issues，而不是照单全收。
 */
export function normalizeOrganizeDraft(
  raw: unknown,
  context: OrganizeValidateContext,
  base: { target: OrganizeTarget; purpose: OrganizePurpose; title: string; engine?: OrganizeEngine }
): OrganizeDraft {
  const issues: string[] = []
  const warnings: string[] = []
  const root = (raw ?? {}) as { summary?: unknown; nodes?: unknown; entries?: unknown }
  const includedIds = new Set(context.papers.map((paper) => paper.itemId))
  const pageCounts = context.pageCounts ?? {}
  const textByItem = context.textByItem ?? {}

  /** 统一核对来源：itemId 不在纳入范围 → 丢掉；页码/引文对不上 → 降级推断 */
  const checkSource = (
    itemIdRaw: unknown,
    pageRaw: unknown,
    quoteRaw: unknown
  ): { itemId: number | null; page: number | null; quote: string | null; inferred: boolean } => {
    let inferred = false
    const itemId = asPositiveIntOrNull(itemIdRaw)
    const resolvedItem = itemId !== null && includedIds.has(itemId) ? itemId : null
    if (itemId !== null && resolvedItem === null) {
      issues.push(`来源论文 #${itemId} 不在本次纳入范围，已改为无来源`)
      inferred = true
    }
    let page = asPositiveIntOrNull(pageRaw)
    if (page !== null) {
      const pages = resolvedItem !== null ? pageCounts[resolvedItem] : undefined
      if (!resolvedItem) {
        page = null
      } else if (typeof pages === 'number' && pages > 0 && page > pages) {
        issues.push(`页码 p.${page} 超出论文 #${resolvedItem} 的 ${pages} 页，已清空`)
        page = null
        inferred = true
      }
    }
    const quote = asText(quoteRaw, 300) || null
    let keptQuote = quote
    if (keptQuote) {
      if (!resolvedItem) {
        keptQuote = null
        inferred = true
      } else {
        const source = textByItem[resolvedItem]
        if (source && !quoteMatchesSource(keptQuote, source)) {
          issues.push(`引文在论文 #${resolvedItem} 正文里找不到，已移除并标为推断`)
          keptQuote = null
          inferred = true
        }
      }
    }
    return { itemId: resolvedItem, page: keptQuote ? page : page, quote: keptQuote, inferred }
  }

  const rawNodes = Array.isArray(root.nodes) ? (root.nodes as RawNode[]) : []
  const nodes: OrganizeDraftNode[] = []
  const seenIds = new Set<string>()
  const usedKeys = new Set<string>()

  rawNodes.slice(0, ORGANIZE_MAX_NODES).forEach((node, index) => {
    const text = asText(node?.text, ORGANIZE_MAX_NODE_CHARS)
    if (!text) return
    let id = asText(node?.id, 40) || `n${index + 1}`
    if (seenIds.has(id)) id = `n${index + 1}`
    seenIds.add(id)
    const source = checkSource(node?.itemId, node?.page, node?.quote)
    const kindRaw = asText(node?.kind, 20) as OrganizeNodeKind
    const kind: OrganizeNodeKind = ORGANIZE_NODE_KINDS.includes(kindRaw)
      ? kindRaw
      : index === 0 && !node?.parentId
        ? 'root'
        : 'topic'
    const parentId = asText(node?.parentId, 40) || null
    nodes.push({
      id,
      parentId,
      text,
      kind,
      itemId: source.itemId,
      page: source.page,
      quote: source.quote,
      inferred: node?.inferred === true || source.inferred,
      userEdited: false
    })
    usedKeys.add(`${parentId ?? ''}|${normalizeForMatch(text)}`)
  })

  if (nodes.length === 0) {
    issues.push('模型没有给出任何节点')
  }

  // 根节点：保证唯一；缺根就补一个；父节点丢失的挂到根下（不丢内容）
  let rootNode = nodes.find((node) => node.parentId === null)
  if (!rootNode && nodes.length > 0) {
    rootNode = {
      id: 'root',
      parentId: null,
      text: base.title || '整理结果',
      kind: 'root',
      itemId: null,
      page: null,
      quote: null,
      inferred: false,
      userEdited: false
    }
    nodes.unshift(rootNode)
    issues.push('模型输出缺少根节点，已按标题补一个')
  }
  if (rootNode) {
    const extraRoots = nodes.filter((node) => node !== rootNode && node.parentId === null)
    if (extraRoots.length > 0) {
      for (const extra of extraRoots) {
        extra.parentId = rootNode.id
        if (extra.kind === 'root') extra.kind = 'topic'
      }
      issues.push(`有 ${extraRoots.length} 个节点没有父节点，已挂到根主题下`)
    }
    const ids = new Set(nodes.map((node) => node.id))
    for (const node of nodes) {
      if (node.parentId && !ids.has(node.parentId)) {
        node.parentId = rootNode.id
        issues.push(`节点「${node.text}」的父节点不存在，已挂到根主题下`)
      }
    }
    // 环与自引用
    for (const node of nodes) {
      if (node.parentId === node.id) node.parentId = rootNode.id
    }
  }

  // 层级检查：只有「根 + 一层」时提示太平，但不阻断保存
  const depthOf = (node: OrganizeDraftNode): number => {
    let depth = 0
    let cursor = node
    const guard = new Set<string>()
    while (cursor.parentId && !guard.has(cursor.id)) {
      guard.add(cursor.id)
      const parent = nodes.find((item) => item.id === cursor.parentId)
      if (!parent) break
      cursor = parent
      depth += 1
    }
    return depth
  }
  const maxDepth = nodes.reduce((max, node) => Math.max(max, depthOf(node)), 0)
  if (nodes.length >= 5 && maxDepth < 2) {
    warnings.push('整理结果的层级偏平（只有根和一层），建议重新生成或手动加一层')
  }

  const rawEntries = Array.isArray(root.entries) ? (root.entries as RawEntry[]) : []
  const entries: OrganizeDraftEntry[] = []
  rawEntries.slice(0, ORGANIZE_MAX_ENTRIES).forEach((entry, index) => {
    const title = asText(entry?.title, 80)
    const body = asText(entry?.body, ORGANIZE_MAX_ENTRY_BODY)
    if (!title || !body) return
    const kindRaw = asText(entry?.kind, 20) as OrganizeEntryKind
    const kind: OrganizeEntryKind = ORGANIZE_ENTRY_KINDS.includes(kindRaw) ? kindRaw : 'concept'
    const source = checkSource(entry?.itemId, entry?.page, entry?.quote)
    const extra = Array.isArray(entry?.evidence) ? (entry.evidence as RawEntry[]) : []
    const evidence: OrganizeDraftEvidence[] = []
    if (source.quote) {
      evidence.push({ itemId: source.itemId, page: source.page, quote: source.quote })
    }
    for (const item of extra.slice(0, 4)) {
      const checked = checkSource(item?.itemId ?? entry?.itemId, item?.page, item?.quote)
      if (checked.quote) {
        evidence.push({ itemId: checked.itemId, page: checked.page, quote: checked.quote })
      }
    }
    const key = asText(entry?.key, 60) || `${kind}-${index + 1}`
    entries.push({
      key,
      kind,
      title,
      body,
      itemId: source.itemId,
      evidence,
      inferred: entry?.inferred === true || source.inferred || evidence.length === 0,
      mergeInto: '',
      mergeReason: ''
    })
  })

  for (const suggestion of suggestMerges(entries)) {
    const target = entries.find((entry) => entry.key === suggestion.key)
    if (target) {
      target.mergeInto = suggestion.mergeInto
      target.mergeReason = suggestion.reason
    }
    warnings.push(`「${suggestion.title}」与「${suggestion.mergeIntoTitle}」内容相近，建议合并（不会自动合并）`)
  }

  return {
    target: base.target,
    purpose: base.purpose,
    title: base.title,
    summary: asText(root.summary, 240),
    nodes,
    entries,
    included: [...context.papers],
    skipped: [],
    warnings,
    issues,
    engine: base.engine ?? 'model'
  }
}

export interface MergeSuggestion {
  key: string
  title: string
  mergeInto: string
  mergeIntoTitle: string
  score: number
  reason: string
}

function titleTokens(text: string): Set<string> {
  const cleaned = String(text ?? '')
    .toLowerCase()
    .replace(/[，。；：、“”‘’（）()「」【】.,;:!?！？'"-]/g, ' ')
  const tokens = new Set<string>()
  for (const part of cleaned.split(/\s+/)) {
    if (part.length >= 2) tokens.add(part)
  }
  // 中文没有空格：按 2-gram 切，避免整句一个 token
  const cjk = cleaned.replace(/\s+/g, '')
  for (let i = 0; i < cjk.length - 1; i += 1) {
    const gram = cjk.slice(i, i + 2)
    if (/[\u4e00-\u9fff]/.test(gram)) tokens.add(gram)
  }
  return tokens
}

export function titleSimilarity(a: string, b: string): number {
  const na = normalizeForMatch(a)
  const nb = normalizeForMatch(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) {
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length)
  }
  const ta = titleTokens(a)
  const tb = titleTokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const token of ta) if (tb.has(token)) shared += 1
  return shared / (ta.size + tb.size - shared)
}

/** 只提出合并建议，不自动合并：语义相近不等于同一概念 */
export function suggestMerges(entries: readonly OrganizeDraftEntry[]): MergeSuggestion[] {
  const suggestions: MergeSuggestion[] = []
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]
      const b = entries[j]
      if (a.kind !== b.kind) continue
      const score = titleSimilarity(a.title, b.title)
      if (score < 0.62) continue
      suggestions.push({
        key: b.key,
        title: b.title,
        mergeInto: a.key,
        mergeIntoTitle: a.title,
        score,
        reason: `标题相似度 ${(score * 100).toFixed(0)}%`
      })
    }
  }
  return suggestions
}

export interface OrganizeNodeDiff {
  added: OrganizeDraftNode[]
  changed: OrganizeDraftNode[]
  unchanged: OrganizeDraftNode[]
  /** 用户改过、本次不会被覆盖的节点 */
  protectedNodes: OrganizeDraftNode[]
}

/** 增量比对：同样的父子位置 + 同样的文字视为未变；用户改过的视为受保护 */
export function diffDraftNodes(
  previous: readonly OrganizeDraftNode[],
  next: readonly OrganizeDraftNode[]
): OrganizeNodeDiff {
  const byKey = new Map<string, OrganizeDraftNode>()
  for (const node of previous) {
    byKey.set(`${node.parentId ?? ''}|${normalizeForMatch(node.text)}`, node)
  }
  const added: OrganizeDraftNode[] = []
  const changed: OrganizeDraftNode[] = []
  const unchanged: OrganizeDraftNode[] = []
  const protectedNodes: OrganizeDraftNode[] = []
  for (const node of next) {
    const key = `${node.parentId ?? ''}|${normalizeForMatch(node.text)}`
    const before = byKey.get(key)
    if (!before) {
      added.push(node)
    } else if (before.userEdited && before.text !== node.text) {
      protectedNodes.push(before)
    } else if (before.text === node.text) {
      unchanged.push(node)
    } else {
      changed.push(node)
    }
  }
  return { added, changed, unchanged, protectedNodes }
}

export interface OrganizeSummary {
  text: string
  included: number
  skipped: number
  nodes: number
  inferredNodes: number
  entries: number
  inferredEntries: number
}

export function summarizeDraft(draft: OrganizeDraft): OrganizeSummary {
  const inferredNodes = draft.nodes.filter((node) => node.inferred).length
  const inferredEntries = draft.entries.filter((entry) => entry.inferred).length
  const parts = [`纳入 ${draft.included.length} 篇`]
  if (draft.skipped.length > 0) parts.push(`未纳入 ${draft.skipped.length} 篇`)
  if (draft.target === 'mindmap') {
    parts.push(`节点 ${draft.nodes.length} 个（推断 ${inferredNodes}）`)
  } else {
    parts.push(`条目 ${draft.entries.length} 条（推断 ${inferredEntries}）`)
  }
  if (draft.engine === 'rules') parts.push('规则整理（未调用模型）')
  return {
    text: parts.join(' · '),
    included: draft.included.length,
    skipped: draft.skipped.length,
    nodes: draft.nodes.length,
    inferredNodes,
    entries: draft.entries.length,
    inferredEntries
  }
}
