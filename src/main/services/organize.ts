/**
 * 批处理后的「智能整理」（阶段三）：草稿预览 → 校验 → 应用 → 撤销。
 *
 * 设计约束（与需求一一对应）：
 * - 先出草稿，不直接写库；用户确认后才落盘。
 * - 模型不可用 / 输出不合法时退回规则整理，并明确标注「规则整理」，不伪装成 AI 结果。
 * - 结构、来源、推断三项校验在 shared/organize.ts 里做；这里只负责取数、调用与落盘。
 * - 写入思维地图时保护用户改过的节点；写入知识库走「待审提案」，不自动发布。
 * - 每次应用前存一份快照，支持撤销与版本恢复。
 */

import { getDb } from '../db'
import { generateStrict } from './llm'
import { loadMindMap, saveMindMap } from './mindmap'
import {
  collectBatchDigestPapers,
  createBatch,
  createProposal,
  getEntryRowByKey,
  listEntries
} from './knowledge'
import { buildRuleSkeleton, type MindmapSkeletonNode } from '../../shared/mindmap-skeleton'
import {
  buildOrganizePrompt,
  diffDraftNodes,
  extractJsonObject,
  knowledgeKindOf,
  normalizeOrganizeDraft,
  summarizeDraft,
  type OrganizeApplyResult,
  type OrganizeDraft,
  type OrganizeDraftNode,
  type OrganizeEngine,
  type OrganizePaperRef,
  type OrganizePaperSource,
  type OrganizePreviewRequest,
  type OrganizePreviewResult,
  type OrganizePurpose,
  type OrganizeSkippedPaper,
  type OrganizeTarget,
  type OrganizeVersionRow
} from '../../shared/organize'
import type { MindMapDoc, MindMapNode } from '../../shared/types'

export type {
  OrganizeApplyResult,
  OrganizePreviewRequest,
  OrganizePreviewResult,
  OrganizeVersionRow
} from '../../shared/organize'

const LAYOUT = { rootX: 0, rootY: 0, levelDx: 220, topicDy: 88, pointDy: 62 }

function newDoc(itemId: number, title: string): MindMapDoc {
  return {
    version: 1,
    itemId,
    rootId: 'root',
    nodes: [
      {
        id: 'root',
        parentId: null,
        text: title || `文献 #${itemId}`,
        x: LAYOUT.rootX,
        y: LAYOUT.rootY
      }
    ],
    updatedAt: new Date().toISOString()
  }
}

function itemRow(itemId: number): { title: string; attachmentId: number | null; abstract: string } | null {
  const row = getDb()
    .prepare(
      `SELECT i.title AS title, i.abstract AS abstract,
              (SELECT a.id FROM attachments a WHERE a.item_id = i.id ORDER BY a.id LIMIT 1) AS attachment_id
         FROM items i WHERE i.id = ?`
    )
    .get(itemId) as
    | { title: string | null; abstract: string | null; attachment_id: number | null }
    | undefined
  if (!row) return null
  return {
    title: String(row.title ?? '').trim() || `文献 #${itemId}`,
    attachmentId: row.attachment_id == null ? null : Number(row.attachment_id),
    abstract: String(row.abstract ?? '')
  }
}

function chunkText(itemId: number, limit = 40): { text: string; pages: number } {
  const rows = getDb()
    .prepare(
      `SELECT c.text AS text, c.page_index AS page_index
         FROM chunks c
         JOIN attachments a ON a.id = c.attachment_id
        WHERE a.item_id = ?
        ORDER BY COALESCE(c.page_index, 0) ASC, c.id ASC
        LIMIT ?`
    )
    .all(itemId, limit) as { text: string | null; page_index: number | null }[]
  const text = rows.map((row) => String(row.text ?? '')).join('\n')
  const maxPage = rows.reduce((max, row) => Math.max(max, Number(row.page_index ?? 0) + 1), 0)
  return { text, pages: maxPage }
}

/** 取整理素材：批处理拆解 markdown 优先，其次正文块 + 摘要 */
function gatherSources(request: OrganizePreviewRequest): {
  papers: OrganizePaperSource[]
  skipped: OrganizeSkippedPaper[]
} {
  const papers: OrganizePaperSource[] = []
  const skipped: OrganizeSkippedPaper[] = []

  if (request.runId) {
    const { papers: digestPapers, skipped: digestSkipped } = collectBatchDigestPapers(
      getDb(),
      request.runId,
      { itemIds: request.itemIds ?? [] }
    )
    for (const paper of digestPapers) {
      const markdown = String(paper.markdown ?? '').trim()
      if (!markdown) {
        skipped.push({ itemId: paper.itemId, title: paper.title, reason: '拆解内容为空' })
        continue
      }
      papers.push({ itemId: paper.itemId, title: paper.title, markdown })
    }
    for (const item of digestSkipped) {
      skipped.push({ itemId: item.itemId, title: item.title, reason: item.reason })
    }
    return { papers, skipped }
  }

  for (const itemId of (request.itemIds ?? []).filter((id) => Number.isFinite(id) && id > 0)) {
    const row = itemRow(itemId)
    if (!row) {
      skipped.push({ itemId, title: `文献 #${itemId}`, reason: '文献不存在' })
      continue
    }
    const chunk = chunkText(itemId)
    const markdown = [row.abstract.trim(), chunk.text.trim()].filter(Boolean).join('\n\n')
    if (!markdown.trim()) {
      skipped.push({ itemId, title: row.title, reason: '没有可用的正文或摘要（可能还没解析）' })
      continue
    }
    papers.push({ itemId, title: row.title, markdown })
  }
  return { papers, skipped }
}

function contextFor(papers: readonly OrganizePaperSource[]): {
  pageCounts: Record<number, number>
  textByItem: Record<number, string>
} {
  const pageCounts: Record<number, number> = {}
  const textByItem: Record<number, string> = {}
  for (const paper of papers) {
    const chunk = chunkText(paper.itemId)
    pageCounts[paper.itemId] = chunk.pages
    textByItem[paper.itemId] = `${paper.markdown}\n${chunk.text}`
  }
  return { pageCounts, textByItem }
}

function ruleDraftForPaper(
  paper: OrganizePaperSource,
  title: string
): OrganizeDraft {
  const skeleton = buildRuleSkeleton({ title: paper.title, markdown: paper.markdown })
  const nodes: OrganizeDraftNode[] = skeleton.nodes.map((node: MindmapSkeletonNode) => ({
    id: node.id,
    parentId: node.parentId,
    text: node.text,
    kind: node.level === 1 ? 'root' : node.level === 2 ? 'topic' : 'evidence',
    itemId: paper.itemId,
    page: null,
    quote: null,
    inferred: true,
    userEdited: false
  }))
  const root = nodes.find((node) => node.parentId === null)
  if (root) root.kind = 'root'
  return {
    target: 'mindmap',
    purpose: 'structure',
    title,
    summary: `${paper.title}：按章节结构生成的规则骨架（未调用模型，全部标为推断）`,
    nodes,
    entries: [],
    included: [{ itemId: paper.itemId, title: paper.title }],
    skipped: [],
    warnings: skeleton.warnings,
    issues: ['模型不可用或输出不合法，已退回规则整理：结构来自章节标题，未做语义归纳'],
    engine: 'rules'
  }
}

function ruleEntriesForPapers(
  papers: readonly OrganizePaperSource[],
  purpose: OrganizePurpose,
  title: string
): OrganizeDraft {
  const entries = papers.slice(0, 12).map((paper, index) => {
    const firstLine = paper.markdown
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find((line) => line.length >= 8) ?? paper.title
    return {
      key: `rules-${paper.itemId}-${index + 1}`,
      kind: (purpose === 'theme' ? 'question' : 'result') as OrganizeDraft['entries'][number]['kind'],
      title: `${paper.title}：${firstLine.slice(0, 40)}`,
      body: `${firstLine.slice(0, 400)}（规则整理：仅截取拆解首段，未经模型归纳）`,
      itemId: paper.itemId,
      evidence: [],
      inferred: true,
      mergeInto: '',
      mergeReason: ''
    }
  })
  return {
    target: 'knowledge',
    purpose,
    title,
    summary: `规则整理：共 ${papers.length} 篇，生成 ${entries.length} 条待审条目（未调用模型）`,
    nodes: [],
    entries,
    included: papers.map((paper) => ({ itemId: paper.itemId, title: paper.title })),
    skipped: [],
    warnings: [],
    issues: ['模型不可用或输出不合法，已退回规则整理：条目只截取拆解首段，全部标为推断'],
    engine: 'rules'
  }
}

function scopeKeyOf(request: OrganizePreviewRequest, papers: readonly OrganizePaperRef[]): string {
  if (request.groupName) return `group:${request.groupName}`
  if (request.runId) return `run:${request.runId}`
  const ids = papers.map((paper) => paper.itemId).sort((a, b) => a - b)
  return `items:${ids.join(',')}`
}

export async function previewOrganize(
  request: OrganizePreviewRequest
): Promise<OrganizePreviewResult> {
  const target: OrganizeTarget = request.target === 'knowledge' ? 'knowledge' : 'mindmap'
  const purpose: OrganizePurpose =
    request.purpose === 'theme' || request.purpose === 'evidence' ? request.purpose : 'structure'
  const { papers, skipped } = gatherSources({ ...request, target, purpose })
  const included: OrganizePaperRef[] = papers.map((paper) => ({
    itemId: paper.itemId,
    title: paper.title
  }))
  const scopeKey = scopeKeyOf(request, included)
  const baseTitle =
    String(request.title ?? '').trim() ||
    (purpose === 'theme'
      ? `主题整理 · ${request.groupName ?? `${papers.length} 篇论文`}`
      : purpose === 'evidence'
        ? `证据整理 · ${papers.length} 篇论文`
        : `结构整理 · ${papers[0]?.title ?? '未选择论文'}`)

  const warnings: string[] = []
  if (papers.length === 0) {
    return {
      drafts: [],
      included,
      skipped,
      engine: 'rules',
      warnings: ['没有可整理的论文：请先在批处理里完成拆解，或选择有正文的论文'],
      scopeKey
    }
  }

  const { pageCounts, textByItem } = contextFor(papers)
  const ctx = { papers: included, pageCounts, textByItem }
  const drafts: OrganizeDraft[] = []
  let engine: OrganizeEngine = 'model'

  // 单篇结构：每篇一棵地图；主题/证据：整组合成一份
  const units: OrganizePaperSource[][] =
    target === 'mindmap' && purpose === 'structure'
      ? papers.map((paper) => [paper])
      : [papers]

  for (const unit of units) {
    const unitTitle =
      unit.length === 1 && purpose === 'structure' ? `${unit[0].title} · 结构整理` : baseTitle
    let rawReply = ''
    try {
      const prompt = buildOrganizePrompt({ target, purpose, title: unitTitle }, unit)
      const reply = await generateStrict({ ...prompt, session: 'organize', temperature: 0.2 })
      rawReply = reply.text
      const parsed = extractJsonObject(reply.text)
      if (!parsed) throw new Error('模型没有返回合法 JSON')
      const draft = normalizeOrganizeDraft(parsed, ctx, {
        target,
        purpose,
        title: unitTitle,
        engine: 'model'
      })
      draft.included = unit.map((paper) => ({ itemId: paper.itemId, title: paper.title }))
      if (draft.nodes.length === 0 && draft.entries.length === 0) {
        throw new Error('模型输出为空')
      }
      drafts.push(draft)
    } catch (error) {
      engine = 'rules'
      const reason = error instanceof Error ? error.message : String(error)
      // 排查用：模型回复不合法时把原始回复打到 stderr（PAPERDESK_ORGANIZE_DEBUG=1 时才输出）
      if (process.env.PAPERDESK_ORGANIZE_DEBUG === '1' && rawReply) {
        console.error(
          `[organize] 模型回复 ${rawReply.length} 字符，开头 600：${rawReply.slice(0, 600)}`
        )
      }
      warnings.push(`模型整理失败：${reason}（已退回规则整理）`)
      drafts.push(
        target === 'mindmap'
          ? ruleDraftForPaper(unit[0], unitTitle)
          : ruleEntriesForPapers(unit, purpose, unitTitle)
      )
    }
  }

  for (const draft of drafts) {
    draft.skipped = skipped
    if (draft.engine === 'rules') engine = 'rules'
    warnings.push(...draft.warnings)
  }

  const diffs: NonNullable<OrganizePreviewResult['diffs']> = {}
  if (target === 'mindmap') {
    for (const draft of drafts) {
      const itemId = draft.included[0]?.itemId
      if (!itemId) continue
      const diff = previewDiff(itemId, draft)
      diffs[itemId] = {
        added: diff.added.length,
        changed: diff.changed.length,
        unchanged: diff.unchanged.length,
        protected: diff.protectedNodes.length
      }
    }
  }

  return { drafts, included, skipped, engine, warnings: [...new Set(warnings)], scopeKey, diffs }
}

/* ------------------------------------------------------------------ */
/* 应用：思维地图合并（保护用户改动）/ 知识库待审提案                    */
/* ------------------------------------------------------------------ */

interface MergeOutcome {
  doc: MindMapDoc
  added: number
  updated: number
  protectedNodes: number
}

function mergeDraftIntoDoc(doc: MindMapDoc, draft: OrganizeDraft): MergeOutcome {
  const syncId = `org:${draft.nodes.length}:${draft.nodes.map((node) => node.text).join('|').slice(0, 120)}`
  const rootId = doc.rootId
  const nextNodes: MindMapNode[] = doc.nodes.map((node) => ({ ...node }))
  let added = 0
  let updated = 0
  let protectedNodes = 0
  let row = 0
  const now = new Date().toISOString()
  const draftRoot = draft.nodes.find((node) => node.parentId === null)
  if (!draftRoot) return { doc, added: 0, updated: 0, protectedNodes: 0 }

  const ensureNode = (node: OrganizeDraftNode, parentId: string, depth: number): string => {
    const id = `org-${node.id}`.slice(0, 60)
    const pos = {
      x: LAYOUT.rootX + LAYOUT.levelDx * Math.max(1, Math.min(depth, 3)),
      y: LAYOUT.rootY + row * LAYOUT.pointDy
    }
    row += 1
    const provenance = {
      source: 'sync' as const,
      syncId,
      batchId: null,
      contentHash: syncId,
      originText: node.text,
      originX: pos.x,
      originY: pos.y,
      userEdited: false
    }
    const existing = nextNodes.find((item) => item.id === id)
    if (!existing) {
      nextNodes.push({
        id,
        parentId,
        text: node.text,
        x: pos.x,
        y: pos.y,
        source: 'digest',
        provenance
      })
      added += 1
      return id
    }
    // 用户改过（文字或坐标与写入时不同）→ 保留用户版本，绝不覆盖
    const edited =
      existing.provenance?.userEdited === true ||
      (existing.provenance?.originText != null && existing.provenance.originText !== existing.text) ||
      (existing.provenance?.originX != null && existing.provenance.originX !== existing.x)
    if (edited) {
      protectedNodes += 1
      existing.provenance = { ...(existing.provenance ?? provenance), userEdited: true }
      return existing.id
    }
    if (existing.text !== node.text) {
      existing.text = node.text
      existing.provenance = provenance
      updated += 1
    }
    return existing.id
  }

  const idMap = new Map<string, string>([[draftRoot.id, rootId]])
  const walk = (parentDraftId: string, parentDocId: string, depth: number): void => {
    const children = draft.nodes.filter((node) => node.parentId === parentDraftId)
    for (const child of children) {
      const id = ensureNode(child, parentDocId, depth)
      idMap.set(child.id, id)
      walk(child.id, id, depth + 1)
    }
  }
  walk(draftRoot.id, rootId, 1)

  // 清理本次同步里已不复存在的旧节点（用户改过的保留）
  const keepIds = new Set<string>([rootId, ...idMap.values()])
  const finalNodes = nextNodes
    .filter((node) => !(node.provenance?.source === 'sync' && !keepIds.has(node.id)))
    .map((node) =>
      node.parentId && !nextNodes.some((item) => item.id === node.parentId)
        ? { ...node, parentId: rootId }
        : node
    )

  return {
    doc: {
      ...doc,
      nodes: finalNodes,
      updatedAt: now,
      sync: {
        syncId,
        batchId: null,
        mode: 'ai',
        nodeIds: [...idMap.values()].filter((id) => id !== rootId),
        updatedAt: now
      }
    },
    added,
    updated,
    protectedNodes
  }
}

function ensureVersionTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS organize_versions (
      id INTEGER PRIMARY KEY,
      scope_key TEXT NOT NULL,
      label TEXT NOT NULL,
      target TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_organize_versions_scope ON organize_versions(scope_key, id DESC);
  `)
}

function saveVersion(scopeKey: string, label: string, target: OrganizeTarget, payload: unknown): number {
  ensureVersionTable()
  const info = getDb()
    .prepare(
      'INSERT INTO organize_versions (scope_key, label, target, payload, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(scopeKey, label, target, JSON.stringify(payload), new Date().toISOString())
  return Number(info.lastInsertRowid)
}

export function listOrganizeVersions(scopeKey?: string | null, limit = 20): OrganizeVersionRow[] {
  ensureVersionTable()
  const rows = (
    scopeKey
      ? getDb()
          .prepare(
            'SELECT id, scope_key, label, target, created_at FROM organize_versions WHERE scope_key = ? ORDER BY id DESC LIMIT ?'
          )
          .all(scopeKey, limit)
      : getDb()
          .prepare(
            'SELECT id, scope_key, label, target, created_at FROM organize_versions ORDER BY id DESC LIMIT ?'
          )
          .all(limit)
  ) as { id: number; scope_key: string; label: string; target: string; created_at: string }[]
  return rows.map((row) => ({
    id: Number(row.id),
    scopeKey: String(row.scope_key),
    label: String(row.label),
    target: String(row.target),
    createdAt: String(row.created_at)
  }))
}

export async function applyOrganize(
  drafts: readonly OrganizeDraft[],
  opts: { scopeKey: string; label?: string | null }
): Promise<OrganizeApplyResult> {
  if (drafts.length === 0) throw new Error('没有可保存的草稿：请先生成整理结果')
  const scopeKey = String(opts.scopeKey || 'organize').slice(0, 200)
  const target: OrganizeTarget = drafts[0].target
  const label = String(opts.label ?? '').trim() || `${target === 'mindmap' ? '思维地图' : '知识库'}整理`

  const before: { mindmaps: { itemId: number; doc: MindMapDoc | null }[]; batchId: number | null } = {
    mindmaps: [],
    batchId: null
  }

  let applied = 0
  let nodesAdded = 0
  let nodesUpdated = 0
  let protectedNodes = 0
  let entriesCreated = 0
  let batchId: number | null = null

  if (target === 'mindmap') {
    for (const draft of drafts) {
      const itemId = draft.included[0]?.itemId
      if (!itemId) continue
      const existing = loadMindMap(itemId)
      before.mindmaps.push({ itemId, doc: existing })
      const doc = existing ?? newDoc(itemId, draft.included[0].title)
      const merged = mergeDraftIntoDoc(doc, draft)
      if (merged.added > 0 || merged.updated > 0) {
        saveMindMap(itemId, merged.doc)
      }
      applied += 1
      nodesAdded += merged.added
      nodesUpdated += merged.updated
      protectedNodes += merged.protectedNodes
    }
  } else {
    const batch = createBatch(getDb(), {
      title: label,
      task: 'smart-organize',
      scopeType: 'library'
    })
    batchId = batch.id
    for (const draft of drafts) {
      for (const entry of draft.entries) {
        const existingEntry = getEntryRowByKey(getDb(), entry.key)
        const evidence = entry.evidence.map((item) => ({
          sourceType: 'paper' as const,
          itemId: item.itemId,
          pageIndex: item.page != null ? Math.max(0, item.page - 1) : null,
          quote: item.quote
        }))
        createProposal(getDb(), batch.id, {
          op: existingEntry ? 'update' : 'create',
          itemId: entry.itemId,
          targetEntryId: existingEntry ? Number(existingEntry.id) : null,
          targetKey: entry.key,
          baseVersion: existingEntry ? Number(existingEntry.version) : null,
          content: {
            kind: knowledgeKindOf(entry),
            title: entry.title,
            body: entry.mergeInto
              ? `${entry.body}\n\n（合并建议：本条与「${entry.mergeInto}」相似 —— ${entry.mergeReason || '标题相近'}，请人工确认是否合并）`
              : entry.body
          },
          contentNature: entry.inferred ? 'ai_inference' : 'ai_suggestion',
          sourceType: 'batch',
          sourceRef: { scopeKey, draft: draft.title },
          evidence,
          reason: draft.summary || '批处理后智能整理'
        })
        entriesCreated += 1
      }
      applied += 1
    }
  }

  const summary =
    target === 'mindmap'
      ? `写入 ${applied} 张地图：新增 ${nodesAdded} 个节点、更新 ${nodesUpdated} 个、保留用户改动 ${protectedNodes} 个`
      : `生成 ${entriesCreated} 条待审条目（批次 #${batchId ?? '-'}），需在知识库「待审」里确认后才会发布`

  const versionId = saveVersion(scopeKey, label, target, { before, batchId, summary })
  return {
    applied,
    nodesAdded,
    nodesUpdated,
    protectedNodes,
    entriesCreated,
    batchId,
    versionId,
    scopeKey,
    summary
  }
}

export function restoreOrganizeVersion(versionId: number): { ok: boolean; message: string } {
  ensureVersionTable()
  const row = getDb().prepare('SELECT * FROM organize_versions WHERE id = ?').get(versionId) as
    | { id: number; target: string; payload: string; label: string }
    | undefined
  if (!row) throw new Error(`版本不存在：${versionId}`)
  let payload: {
    batchId?: number | null
    before?: { mindmaps?: { itemId: number; doc: MindMapDoc | null }[]; batchId?: number | null }
  }
  try {
    payload = JSON.parse(String(row.payload))
  } catch {
    throw new Error('版本内容损坏，无法恢复')
  }
  const before = payload.before
  if (!before) throw new Error('该版本没有可恢复的快照')

  let restored = 0
  for (const item of before.mindmaps ?? []) {
    if (item.doc) {
      saveMindMap(item.itemId, item.doc)
      restored += 1
    } else {
      // 之前没有地图：把本次新建的同步节点清掉，保留用户节点
      const current = loadMindMap(item.itemId)
      if (current) {
        const kept = current.nodes.filter((node) => node.provenance?.source !== 'sync' || node.provenance.userEdited)
        saveMindMap(item.itemId, { ...current, nodes: kept, updatedAt: new Date().toISOString() })
        restored += 1
      }
    }
  }

  // 批次号写在快照顶层（applyOrganize 保存时）；兼容早期写在 before 里的版本
  const batchId = payload.batchId ?? before.batchId ?? null
  let removedProposals = 0
  if (batchId != null) {
    const info = getDb()
      .prepare("DELETE FROM knowledge_proposals WHERE batch_id = ? AND status = 'pending_review'")
      .run(batchId)
    removedProposals = Number(info.changes ?? 0)
    // 批次里没有待审条目了就一并清掉，避免暂存区留下空批次
    const left = getDb()
      .prepare('SELECT COUNT(*) AS c FROM knowledge_proposals WHERE batch_id = ?')
      .get(batchId) as { c: number } | undefined
    if ((left?.c ?? 0) === 0) {
      getDb().prepare('DELETE FROM proposal_batches WHERE id = ?').run(batchId)
    }
  }

  return {
    ok: true,
    message: `已恢复：地图 ${restored} 张，撤回待审条目 ${removedProposals} 条`
  }
}

export function draftSummaryFor(draft: OrganizeDraft): string {
  return summarizeDraft(draft).text
}

/** 预览里展示「与现有内容的差异」：新增/更新/未变/受保护 */
export function previewDiff(
  itemId: number,
  draft: OrganizeDraft
): ReturnType<typeof diffDraftNodes> {
  const existing = loadMindMap(itemId)
  const previous: OrganizeDraftNode[] = (existing?.nodes ?? [])
    .filter((node) => node.parentId !== null)
    .map((node) => ({
      id: node.id,
      parentId: node.parentId,
      text: node.text,
      kind: 'topic',
      itemId,
      page: null,
      quote: null,
      inferred: false,
      userEdited:
        node.provenance?.userEdited === true ||
        (node.provenance?.originText != null && node.provenance.originText !== node.text)
    }))
  return diffDraftNodes(previous, draft.nodes.filter((node) => node.parentId !== null))
}

/** 列出可整理的论文（无批处理时给文库入口用） */
export function listOrganizeCandidates(limit = 200): { itemId: number; title: string; hasText: boolean }[] {
  const rows = getDb()
    .prepare(
      `SELECT i.id AS id, i.title AS title,
              EXISTS(SELECT 1 FROM chunks c JOIN attachments a ON a.id = c.attachment_id WHERE a.item_id = i.id) AS has_text
         FROM items i ORDER BY i.id DESC LIMIT ?`
    )
    .all(limit) as { id: number; title: string | null; has_text: number }[]
  return rows.map((row) => ({
    itemId: Number(row.id),
    title: String(row.title ?? '').trim() || `文献 #${row.id}`,
    hasText: Number(row.has_text) === 1
  }))
}

