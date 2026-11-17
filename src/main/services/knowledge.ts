import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CreateKnowledgeBatchInput,
  CreateKnowledgeProposalInput,
  DigestSyncResult,
  KnowledgeBatch,
  KnowledgeBatchCounts,
  KnowledgeBatchOrigin,
  KnowledgeBatchScopeType,
  KnowledgeBatchStatus,
  KnowledgeContent,
  KnowledgeEntryDetail,
  KnowledgeEntryState,
  KnowledgeEntrySummary,
  KnowledgeEvidenceInput,
  KnowledgeEvidenceLink,
  KnowledgeEvidencePrecision,
  KnowledgeImportResult,
  KnowledgeImportSourceType,
  KnowledgeKind,
  KnowledgeNature,
  KnowledgeProposalDetail,
  KnowledgeProposalFilter,
  KnowledgeProposalOp,
  KnowledgeProposalReview,
  KnowledgeProposalStatus,
  KnowledgeProposalSummary,
  KnowledgePublishConflict,
  KnowledgePublishResult,
  KnowledgeReviewAction,
  KnowledgeSourceType,
  KnowledgeStatus,
  KnowledgeVerification,
  BatchDigestPaper,
  BatchSyncItemResult,
  BatchSyncResult,
  BatchSyncSkippedPaper,
  KnowledgeBatchPaper
} from '../../shared/types'
import type { BatchKnowledgePlan, DigestKnowledgePlan } from '../../shared/api'

/**
 * 知识库占位（PD31）：只保证数据目录下有一个空的 knowledge 目录，
 * 不实现索引 / 向量化 / 检索 / 上传解析，也不发起任何网络请求。
 *
 * 刻意不 import electron 或 ../db：本文件必须能被 `node scripts/test-unit.ts`
 * 直接导入（与 src/shared/* 纯函数同样的可测性），真实数据目录由
 * `services/settings.ts::getKnowledgeStatus` 用 getDataDir() 注入。
 */
export function knowledgeStatusAt(dataDir: string): KnowledgeStatus {
  const root = join(dataDir, 'knowledge')
  // recursive 且已存在时是 no-op：重复读取不会清空/改写目录内容
  mkdirSync(root, { recursive: true })
  return { enabled: false, status: 'placeholder', root }
}

/* ============================================================================
 * 知识库阶段 1a（PD33）
 *
 * 写权限边界：
 *   - 本文件是**唯一**能写 knowledge_entries / knowledge_versions / evidence_links
 *     的地方，入口只有 publishBatch（用户经 IPC 触发）；
 *   - 提案（proposal_batches / knowledge_proposals / proposal_reviews）由
 *     createBatch / createProposal / accept|reject|editAndAccept 写；
 *   - services/knowledge-ai.ts 只调用 createProposal，不导出任何发布/删除/SQL/文件/密钥入口。
 *
 * 事务：统一用 exec('BEGIN IMMEDIATE') / COMMIT / ROLLBACK，而不是 better-sqlite3
 * 专有的 db.transaction()，这样单测可以用 node:sqlite 的 DatabaseSync 注入同一份代码。
 * ========================================================================== */

/** 可注入的最小数据库接口（better-sqlite3 与 node:sqlite 的 DatabaseSync 都满足） */
export interface KnowledgeStmt {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
}

export interface KnowledgeDb {
  exec(sql: string): void
  prepare(sql: string): KnowledgeStmt
}

/** 提案单次发布入参；proposalIds 省略 = 发布该批次全部「已接受」提案 */
export interface PublishBatchInput {
  batchId: number
  proposalIds?: number[] | null
}

/** 编辑后接受时允许改写的字段（其余字段保持提案原样） */
export interface EditAcceptPatch {
  content?: KnowledgeContent
  evidence?: KnowledgeEvidenceInput[]
  reason?: string
}

const KINDS: readonly KnowledgeKind[] = [
  'paper',
  'concept',
  'method',
  'result',
  'dataset',
  'metric',
  'claim',
  'note',
  'decision',
  'question'
]

const NATURES: readonly KnowledgeNature[] = [
  'user_decision',
  'user_hypothesis',
  'author_claim',
  'observation',
  'ai_inference',
  'ai_suggestion'
]

const SOURCE_TYPES: readonly KnowledgeSourceType[] = [
  'paper',
  'translation',
  'note',
  'annotation',
  'conversation',
  'user',
  /** PD38：论文拆解结果（拆解要点不是原文，证据精度固定 document） */
  'digest',
  /** PD44：批处理产物（同样来自拆解要点，但来源标记为「批处理」） */
  'batch'
]

const PRECISIONS: readonly KnowledgeEvidencePrecision[] = ['module', 'page', 'document', 'message']

const PROPOSAL_STATUSES: readonly KnowledgeProposalStatus[] = [
  'draft',
  'pending_review',
  'approved',
  'needs_edit',
  'rejected',
  'published',
  'withdrawn'
]

const BATCH_STATUSES: readonly KnowledgeBatchStatus[] = [
  'draft',
  'ready',
  'partially_published',
  'published',
  'abandoned'
]

const ORIGINS: readonly KnowledgeBatchOrigin[] = ['user', 'ai_workflow', 'import']

const SCOPE_TYPES: readonly KnowledgeBatchScopeType[] = [
  'library',
  'item',
  'conversation',
  'selection',
  'manual'
]

const ENTRY_STATES: readonly KnowledgeEntryState[] = ['active', 'archived']

/** 来源定位/证据里绝不允许出现的字段（API Key 不得写入提案、日志或测试断言） */
const SECRET_KEY = /(api[_-]?key|authorization|secret|password|passwd|bearer|access[_-]?token|refresh[_-]?token|private[_-]?key)/i

const REF_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
const ENTRY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

type Row = Record<string, unknown>

function bad(message: string): never {
  throw new Error(message)
}

function nowIso(): string {
  return new Date().toISOString()
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function bool(value: unknown): boolean {
  return Number(value) === 1
}

function lastId(info: { lastInsertRowid: number | bigint }): number {
  return Number(info.lastInsertRowid)
}

/** 单事务包装：BEGIN IMMEDIATE 立即拿写锁，失败整体 ROLLBACK 后原样抛出 */
export function runInTransaction<T>(db: KnowledgeDb, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 事务可能已被 SQLite 自动回滚；保留原始错误更有价值
    }
    throw e
  }
}

export function sha256(parts: readonly string[]): string {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest('hex')
}

/**
 * 知识内容指纹（PD41）：kind + 标题 + 正文的 NFKC 规范化哈希。
 *
 * 提案侧（mapProposal 派生 contentHash）与正式条目侧（publishBatch 落库 content_hash）
 * 共用本函数，因此「接受并发布后 knowledge_entries.content_hash === 提案的 contentHash」
 * 是恒等关系，而不是两次独立计算碰巧相等。
 * 只做规范化，不做唯一约束（同一论断可能合法地出现在两篇论文里，见 §6.4）。
 */
export function knowledgeContentHash(kind: unknown, title: unknown, body: unknown): string {
  const norm = (value: unknown): string => String(value ?? '').normalize('NFKC')
  return sha256([norm(kind), '\n', norm(title).trim(), '\n', norm(body).trim()])
}

/* ------------------------------- 入参校验 -------------------------------- */

function requireText(raw: unknown, label: string, max: number): string {
  if (typeof raw !== 'string') bad(`无效的${label}`)
  const value = raw.trim()
  if (!value) bad(`无效的${label}：不能为空`)
  if (value.length > max) bad(`无效的${label}：超过 ${max} 字符`)
  return value
}

/**
 * 可选文本：null / undefined / **纯空白串** 都按「未提供」处理（返回 null）。
 * 非字符串仍按非法类型拒绝，超长仍报错——与 requireText 的必填语义保持互不干扰。
 */
function optionalText(raw: unknown, label: string, max: number): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') bad(`无效的${label}`)
  const value = raw.trim()
  if (!value) return null
  if (value.length > max) bad(`无效的${label}：超过 ${max} 字符`)
  return value
}

function positiveInt(raw: unknown, label: string): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) bad(`无效的${label}`)
  return n
}

function optionalPositiveInt(raw: unknown, label: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  return positiveInt(raw, label)
}

function optionalNonNegativeInt(raw: unknown, label: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) bad(`无效的${label}`)
  return n
}

function pickEnum<T extends string>(raw: unknown, allowed: readonly T[], label: string): T {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value || !(allowed as readonly string[]).includes(value)) {
    bad(`无效的${label}：${value || String(raw)}`)
  }
  return value as T
}

function assertNoSecret(value: unknown, label: string, depth = 0): void {
  if (value === null || typeof value !== 'object' || depth > 4) return
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecret(item, label, depth + 1)
    return
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) bad(`${label}不得包含敏感字段：${key}`)
    assertNoSecret(inner, label, depth + 1)
  }
}

function normalizeRef(raw: unknown, label: string): Record<string, string | number | boolean | null> {
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) bad(`无效的${label}`)
  assertNoSecret(raw, label)
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!REF_KEY.test(key)) bad(`无效的${label}字段名：${key}`)
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    } else {
      bad(`无效的${label}字段值：${key}`)
    }
  }
  return out
}

function normalizeContent(raw: unknown): KnowledgeContent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('无效的提案内容')
  const obj = raw as Record<string, unknown>
  const kind = pickEnum(obj.kind, KINDS, '知识类型')
  const title = requireText(obj.title, '标题', 300)
  if (typeof obj.body !== 'string') bad('无效的提案正文')
  const body = obj.body.trim()
  if (body.length > 200_000) bad('提案正文超过 200000 字符')
  return { kind, title, body }
}

/** 模块级证据成立条件：模块 id + 合法的模块正文字符区间（PD40）。 */
function hasModuleSpan(input: {
  moduleId: string | null
  charStart: number | null
  charEnd: number | null
}): boolean {
  return (
    Boolean(input.moduleId) &&
    input.charStart !== null &&
    input.charEnd !== null &&
    input.charEnd > input.charStart
  )
}

/**
 * 按可用定位推导精度（PD40 起显式化）：
 * module 必须「模块 id + 字符区间」同时成立；否则有页码→page，有消息→message，
 * 再否则 document。缺区间的模块证据一律降级为页级，不再默认当成模块级。
 */
function derivePrecision(input: {
  pageIndex: number | null
  moduleId: string | null
  charStart: number | null
  charEnd: number | null
  sourceRef: Record<string, string | number | boolean | null>
}): KnowledgeEvidencePrecision {
  if (hasModuleSpan(input)) return 'module'
  if (input.pageIndex !== null) return 'page'
  if (input.sourceRef.messageId !== undefined || input.sourceRef.message_id !== undefined) {
    return 'message'
  }
  return 'document'
}

/** 一条证据是否定位到了真实原文（否则=待核验，绝不编造页码/引文） */
export function isEvidenceVerified(evidence: KnowledgeEvidenceInput): boolean {
  if (evidence.quote.trim().length < 2) return false
  const ref = evidence.sourceRef ?? {}
  const span = {
    moduleId: evidence.moduleId ?? null,
    charStart: evidence.charStart ?? null,
    charEnd: evidence.charEnd ?? null
  }
  switch (evidence.precision ?? derivePrecision({
    pageIndex: evidence.pageIndex ?? null,
    ...span,
    sourceRef: ref
  })) {
    case 'page':
      return evidence.pageIndex !== null && evidence.pageIndex !== undefined
    case 'module':
      return hasModuleSpan(span)
    case 'message':
      return ref.messageId !== undefined || ref.conversationId !== undefined
    case 'document':
      return (
        evidence.itemId !== null && evidence.itemId !== undefined
          ? true
          : evidence.attachmentId !== null && evidence.attachmentId !== undefined
            ? true
            : ref.documentId !== undefined ||
              ref.noteId !== undefined ||
              ref.translationId !== undefined ||
              ref.itemId !== undefined
      )
    default:
      return false
  }
}

function normalizeEvidence(raw: unknown): KnowledgeEvidenceInput[] {
  if (raw === null || raw === undefined) return []
  if (!Array.isArray(raw)) bad('无效的来源证据：必须是数组')
  if (raw.length > 50) bad('来源证据过多（最多 50 条）')
  return raw.map((item, index) => normalizeOneEvidence(item, index + 1))
}

function normalizeOneEvidence(raw: unknown, index: number): KnowledgeEvidenceInput {
  const label = `第 ${index} 条来源证据`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad(`无效的${label}`)
  const obj = raw as Record<string, unknown>
  const sourceType = pickEnum(obj.sourceType, SOURCE_TYPES, `${label}的来源类型`)
  const quote = typeof obj.quote === 'string' ? obj.quote : bad(`无效的${label}的原文片段`)
  const trimmed = quote.trim()
  if (trimmed.length > 4000) bad(`${label}的原文片段超过 4000 字符`)
  const pageIndex = optionalNonNegativeInt(obj.pageIndex, `${label}的页码`)
  const pageEnd = optionalNonNegativeInt(obj.pageEnd, `${label}的结束页码`)
  if (pageIndex !== null && pageEnd !== null && pageEnd < pageIndex) {
    bad(`${label}的页码范围无效`)
  }
  const moduleId = optionalText(obj.moduleId, `${label}的模块 id`, 200)
  const sectionPath = optionalText(obj.sectionPath, `${label}的章节路径`, 500)
  const rectText = optionalText(obj.rect, `${label}的坐标`, 200)
  const sourceRef = normalizeRef(obj.sourceRef, `${label}的来源定位`)
  const itemId = optionalPositiveInt(obj.itemId, `${label}的文献 id`)
  const attachmentId = optionalPositiveInt(obj.attachmentId, `${label}的附件 id`)
  const charStart = optionalNonNegativeInt(obj.charStart, `${label}的起始字符`)
  const charEnd = optionalNonNegativeInt(obj.charEnd, `${label}的结束字符`)
  if (charStart !== null && charEnd !== null && charEnd < charStart) {
    bad(`${label}的字符范围无效`)
  }
  const explicit =
    obj.precision === null || obj.precision === undefined
      ? null
      : pickEnum(obj.precision, PRECISIONS, `${label}的定位精度`)
  const derived = derivePrecision({ pageIndex, moduleId, charStart, charEnd, sourceRef })
  let precision = explicit ?? derived
  // 声明的精度与可用定位不符时**降级**而不是补占位值
  if (explicit === 'page' && pageIndex === null) precision = derived === 'page' ? 'document' : derived
  // PD40：模块级必须同时有模块 id 与字符区间，否则按实际定位降级为页级
  if (explicit === 'module' && !hasModuleSpan({ moduleId, charStart, charEnd })) {
    precision = derived === 'module' ? 'document' : derived
  }
  if (explicit === 'message' && sourceRef.messageId === undefined) {
    precision = derived === 'message' ? 'document' : derived
  }
  return {
    sourceType,
    sourceRef,
    itemId,
    attachmentId,
    pageIndex,
    pageEnd,
    moduleId,
    rect: rectText,
    charStart,
    charEnd,
    quote: trimmed,
    sectionPath,
    precision
  }
}

/** 提案的程序检查：缺来源→待核验（不是伪造定位） */
function buildChecks(
  evidence: readonly KnowledgeEvidenceInput[]
): { needsVerification: boolean; problems: string[] } {
  const problems: string[] = []
  if (evidence.length === 0) {
    problems.push('缺少来源证据：提案标为待核验，补齐后可接受并发布')
  } else {
    const unverified = evidence.filter((e) => !isEvidenceVerified(e)).length
    if (unverified > 0) problems.push(`${unverified} 条来源未定位到原文，提案标为待核验`)
  }
  return { needsVerification: problems.length > 0, problems }
}

/* ------------------------------- 行映射 -------------------------------- */

interface PatchShape {
  content: KnowledgeContent
  evidence: KnowledgeEvidenceInput[]
}

function parsePatch(raw: unknown): PatchShape {
  let parsed: unknown
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return { content: { kind: 'note', title: '', body: '' }, evidence: [] }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { content: { kind: 'note', title: '', body: '' }, evidence: [] }
  }
  const obj = parsed as Record<string, unknown>
  const contentRaw = (obj.content ?? {}) as Record<string, unknown>
  const kind = KINDS.find((k) => k === contentRaw.kind) ?? 'note'
  const evidence = Array.isArray(obj.evidence)
    ? (obj.evidence as KnowledgeEvidenceInput[]).filter((e) => e && typeof e === 'object')
    : []
  return {
    content: { kind, title: text(contentRaw.title), body: text(contentRaw.body) },
    evidence
  }
}

function parseJsonObject(raw: unknown): Record<string, string | number | boolean | null> {
  if (typeof raw !== 'string' || !raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, string | number | boolean | null>
  } catch {
    return {}
  }
}

function batchCounts(db: KnowledgeDb, batchId: number): KnowledgeBatchCounts {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT item_id) AS papers,
              SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
         FROM knowledge_proposals WHERE batch_id = ?`
    )
    .get(batchId) as Row | undefined
  return {
    total: Number(row?.total ?? 0),
    papers: Number(row?.papers ?? 0),
    pending: Number(row?.pending ?? 0),
    approved: Number(row?.approved ?? 0),
    published: Number(row?.published ?? 0),
    rejected: Number(row?.rejected ?? 0)
  }
}

function mapBatch(db: KnowledgeDb, row: Row): KnowledgeBatch {
  const id = Number(row.id)
  return {
    id,
    key: text(row.key),
    title: text(row.title),
    task: text(row.task),
    status: pickEnum(row.status, BATCH_STATUSES, '批次状态'),
    scopeType: pickEnum(row.scope_type, SCOPE_TYPES, '批次范围类型'),
    scopeRef: textOrNull(row.scope_ref),
    origin: pickEnum(row.origin, ORIGINS, '批次来源'),
    aiConfigRef: textOrNull(row.ai_config_ref),
    workflowVersion: textOrNull(row.workflow_version),
    skillVersion: textOrNull(row.skill_version),
    counts: batchCounts(db, id),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at)
  }
}

function mapProposal(row: Row): KnowledgeProposalSummary {
  const patch = parsePatch(row.patch_json)
  const checks = parseJsonObject(row.checks_json)
  const problems = Array.isArray((checks as { problems?: unknown }).problems)
    ? ((checks as { problems?: unknown }).problems as unknown[]).filter(
        (p): p is string => typeof p === 'string'
      )
    : []
  return {
    id: Number(row.id),
    key: text(row.key),
    batchId: Number(row.batch_id),
    itemId: numberOrNull(row.item_id),
    op: pickEnum(row.op, ['create', 'update'] as const, '提案操作'),
    status: pickEnum(row.status, PROPOSAL_STATUSES, '提案状态'),
    verification: pickEnum(row.verification, ['pending', 'verified'] as const, '来源可信度'),
    kind: patch.content.kind,
    title: patch.content.title,
    /** 来源论文标题（PD43 起 listProposals 会 LEFT JOIN items 带出） */
    itemTitle: textOrNull(row.item_title),
    contentNature: pickEnum(row.content_nature, NATURES, '内容性质'),
    sourceType: pickEnum(row.source_type, SOURCE_TYPES, '来源类型'),
    sourceRef: parseJsonObject(row.source_ref),
    /** 与发布时写入 knowledge_entries.content_hash 同源（PD41 起恒等） */
    contentHash: knowledgeContentHash(
      patch.content.kind,
      patch.content.title,
      patch.content.body
    ),
    targetEntryId: numberOrNull(row.target_entry_id),
    targetKey: textOrNull(row.target_key),
    baseVersion: numberOrNull(row.base_version),
    reason: text(row.reason),
    needsVerification: row.verification !== 'verified',
    problems,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at)
  }
}

/**
 * 条目的「归属论文」（PD50）：知识库列表必须能标出某条知识来自哪篇论文，
 * 否则四篇论文拆解出来的相似条目无法区分。
 *
 * 兜底顺序（与验收一致）：
 *   1. `knowledge_entries.item_id` 命中 items → 该论文的 id/title；
 *   2. `item_id` 为空时用 `attachment_id → attachments.item_id` 的论文；
 *   3. 两者都没有（含指向已删除文献的孤儿引用）→ null/null，前端归入「未关联论文」。
 *
 * 孤儿 item_id 刻意**不**回退到 attachment：归属要么是真的，要么就没有，
 * 不能把「这条记录曾经属于某篇已删除的论文」显示成当前归属。
 */
function entryPaper(row: Row): { paperItemId: number | null; paperTitle: string | null } {
  const directId = numberOrNull(row.item_id)
  const directTitle = textOrNull(row.item_title)
  if (directId !== null && directTitle !== null) {
    return { paperItemId: directId, paperTitle: directTitle }
  }
  if (directId === null) {
    const fallbackId = numberOrNull(row.attachment_item_id)
    const fallbackTitle = textOrNull(row.attachment_item_title)
    if (fallbackId !== null && fallbackTitle !== null) {
      return { paperItemId: fallbackId, paperTitle: fallbackTitle }
    }
  }
  return { paperItemId: null, paperTitle: null }
}

/**
 * 条目查询统一走这份 SELECT：条目行 + 直接论文标题 + 附件所属论文标题。
 * `listEntries` 与 `getEntry` 必须用同一份，否则 Detail 与 Summary 的归属字段会不一致。
 */
const ENTRY_SELECT = `SELECT e.*,
         i.title   AS item_title,
         a.item_id AS attachment_item_id,
         ai.title  AS attachment_item_title
    FROM knowledge_entries e
    LEFT JOIN items i       ON i.id = e.item_id
    LEFT JOIN attachments a ON a.id = e.attachment_id
    LEFT JOIN items ai      ON ai.id = a.item_id`

function mapEntrySummary(row: Row): KnowledgeEntrySummary {
  return {
    id: Number(row.id),
    key: text(row.key),
    kind: pickEnum(row.kind, KINDS, '知识类型'),
    title: text(row.title),
    contentNature: pickEnum(row.content_nature, NATURES, '内容性质'),
    itemId: numberOrNull(row.item_id),
    ...entryPaper(row),
    version: Number(row.version ?? 1),
    state: pickEnum(row.state, ENTRY_STATES, '条目状态'),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at)
  }
}

function mapEvidenceLink(row: Row): KnowledgeEvidenceLink {
  return {
    id: Number(row.id),
    entryId: Number(row.entry_id),
    proposalId: numberOrNull(row.proposal_id),
    sourceType: pickEnum(row.source_type, SOURCE_TYPES, '来源类型'),
    sourceRef: parseJsonObject(row.source_ref),
    itemId: numberOrNull(row.item_id),
    attachmentId: numberOrNull(row.attachment_id),
    pageIndex: numberOrNull(row.page_index),
    pageEnd: numberOrNull(row.page_end),
    moduleId: textOrNull(row.module_id),
    quote: text(row.quote),
    sectionPath: textOrNull(row.section_path),
    precision: pickEnum(row.precision, PRECISIONS, '定位精度'),
    contentHash: text(row.content_hash),
    verified: bool(row.verified),
    createdAt: text(row.created_at)
  }
}

/* ------------------------------- 批次 ---------------------------------- */

export function getBatch(db: KnowledgeDb, batchId: number): KnowledgeBatch | null {
  const id = positiveInt(batchId, '批次 id')
  const row = db.prepare('SELECT * FROM proposal_batches WHERE id = ?').get(id) as Row | undefined
  return row ? mapBatch(db, row) : null
}

export function listBatches(db: KnowledgeDb, limit = 50): KnowledgeBatch[] {
  const capped = Math.min(Math.max(positiveInt(limit, '数量上限'), 1), 200)
  const rows = db
    .prepare('SELECT * FROM proposal_batches ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(capped) as Row[]
  return rows.map((row) => mapBatch(db, row))
}

export function createBatch(db: KnowledgeDb, input: CreateKnowledgeBatchInput): KnowledgeBatch {
  if (!input || typeof input !== 'object') bad('无效的批次入参')
  const title = requireText(input.title, '批次标题', 200)
  const task = requireText(input.task, '批次任务', 120)
  const scopeType =
    input.scopeType === undefined || input.scopeType === null
      ? 'library'
      : pickEnum(input.scopeType, SCOPE_TYPES, '批次范围类型')
  const scopeRef = optionalText(input.scopeRef, '批次范围', 500)
  const origin =
    input.origin === undefined || input.origin === null
      ? 'user'
      : pickEnum(input.origin, ORIGINS, '批次来源')
  const aiConfigRef = optionalText(input.aiConfigRef, 'AI 配置引用', 200)
  const workflowVersion = optionalText(input.workflowVersion, '工作流版本', 100)
  const skillVersion = optionalText(input.skillVersion, '技能版本', 100)
  const idempotencyKey = optionalText(input.idempotencyKey, '幂等键', 200)

  if (idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM proposal_batches WHERE idempotency_key = ?')
      .get(idempotencyKey) as Row | undefined
    if (existing) return mapBatch(db, existing)
  }

  const ts = nowIso()
  const key = `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const info = db
    .prepare(
      `INSERT INTO proposal_batches
         (key, title, task, scope_type, scope_ref, status, origin, ai_config_ref,
          workflow_version, skill_version, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      key,
      title,
      task,
      scopeType,
      scopeRef,
      origin,
      aiConfigRef,
      workflowVersion,
      skillVersion,
      idempotencyKey,
      ts,
      ts
    )
  const row = db
    .prepare('SELECT * FROM proposal_batches WHERE id = ?')
    .get(lastId(info)) as Row | undefined
  if (!row) bad('批次创建失败')
  return mapBatch(db, row)
}

/* ------------------------------- 条目 ---------------------------------- */

function assertItemExists(db: KnowledgeDb, itemId: number): void {
  const row = db.prepare('SELECT id FROM items WHERE id = ?').get(itemId) as Row | undefined
  if (!row) bad(`无效的文献 id：${itemId} 不存在`)
}

export function getEntryRowById(db: KnowledgeDb, entryId: number): Row | undefined {
  return db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(entryId) as Row | undefined
}

export function getEntryRowByKey(db: KnowledgeDb, entryKey: string): Row | undefined {
  return db.prepare('SELECT * FROM knowledge_entries WHERE key = ?').get(entryKey) as Row | undefined
}

export function listEntries(
  db: KnowledgeDb,
  filter: { itemId?: number | null; kind?: KnowledgeKind; state?: KnowledgeEntryState; limit?: number } = {}
): KnowledgeEntrySummary[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.itemId !== undefined && filter.itemId !== null) {
    clauses.push('e.item_id = ?')
    params.push(positiveInt(filter.itemId, '文献 id'))
  }
  if (filter.kind !== undefined) {
    clauses.push('e.kind = ?')
    params.push(pickEnum(filter.kind, KINDS, '知识类型'))
  }
  if (filter.state !== undefined) {
    clauses.push('e.state = ?')
    params.push(pickEnum(filter.state, ENTRY_STATES, '条目状态'))
  }
  const capped = Math.min(Math.max(positiveInt(filter.limit ?? 200, '数量上限'), 1), 500)
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  // state/kind/limit 语义不变：只是把过滤与排序改成带表别名的写法，好让归属 JOIN 生效
  const rows = db
    .prepare(`${ENTRY_SELECT} ${where} ORDER BY e.updated_at DESC, e.id DESC LIMIT ?`)
    .all(...params, capped) as Row[]
  return rows.map(mapEntrySummary)
}

/** 取条目 + 归属论文（与 listEntries 同一份 SELECT，保证 Summary/Detail 字段一致） */
function getEntryJoinedRow(db: KnowledgeDb, entryId: number): Row | undefined {
  return db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(entryId) as Row | undefined
}

export function getEntry(db: KnowledgeDb, entryId: number): KnowledgeEntryDetail | null {
  const id = positiveInt(entryId, '条目 id')
  const row = getEntryJoinedRow(db, id)
  if (!row) return null
  const summary = mapEntrySummary(row)
  const evidenceRows = db
    .prepare('SELECT * FROM evidence_links WHERE entry_id = ? ORDER BY id ASC')
    .all(id) as Row[]
  const versionRows = db
    .prepare(
      'SELECT version, change_reason, proposal_id, created_at FROM knowledge_versions WHERE entry_id = ? ORDER BY version ASC'
    )
    .all(id) as Row[]
  return {
    ...summary,
    body: text(row.body),
    attachmentId: numberOrNull(row.attachment_id),
    sourceType: pickEnum(row.source_type, SOURCE_TYPES, '来源类型'),
    sourceRef: parseJsonObject(row.source_ref),
    contentHash: text(row.content_hash),
    evidence: evidenceRows.map(mapEvidenceLink),
    versions: versionRows.map((v) => ({
      version: Number(v.version),
      changeReason: text(v.change_reason),
      proposalId: numberOrNull(v.proposal_id),
      createdAt: text(v.created_at)
    }))
  }
}

/* ------------------------------- 提案 ---------------------------------- */

export function mustGetProposalRow(db: KnowledgeDb, proposalId: number): Row {
  const id = positiveInt(proposalId, '提案 id')
  const row = db.prepare('SELECT * FROM knowledge_proposals WHERE id = ?').get(id) as Row | undefined
  if (!row) bad(`提案不存在：${id}`)
  return row
}

export function getProposalSummary(db: KnowledgeDb, proposalId: number): KnowledgeProposalSummary {
  return mapProposal(mustGetProposalRow(db, proposalId))
}

export function listProposals(
  db: KnowledgeDb,
  filter: KnowledgeProposalFilter = {}
): KnowledgeProposalSummary[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.batchId !== undefined && filter.batchId !== null) {
    clauses.push('p.batch_id = ?')
    params.push(positiveInt(filter.batchId, '批次 id'))
  }
  if (filter.itemId !== undefined && filter.itemId !== null) {
    clauses.push('p.item_id = ?')
    params.push(positiveInt(filter.itemId, '文献 id'))
  }
  if (filter.op !== undefined) {
    clauses.push('p.op = ?')
    params.push(pickEnum(filter.op, ['create', 'update'] as const, '提案操作'))
  }
  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
    if (statuses.length === 0) bad('无效的提案状态过滤')
    const picked = statuses.map((s) => pickEnum(s, PROPOSAL_STATUSES, '提案状态'))
    clauses.push(`p.status IN (${picked.map(() => '?').join(', ')})`)
    params.push(...picked)
  }
  const capped = Math.min(Math.max(positiveInt(filter.limit ?? 200, '数量上限'), 1), 500)
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db
    .prepare(
      `SELECT p.*, i.title AS item_title
         FROM knowledge_proposals p
         LEFT JOIN items i ON i.id = p.item_id
         ${where}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ?`
    )
    .all(...params, capped) as Row[]
  return rows.map(mapProposal)
}

/**
 * 提案内容的规范化文本（用于行级差异展示）。
 * 导出给 ipc/knowledge.ts 复用：本文件刻意不 import shared/diff（保持可被
 * `node scripts/test-unit.ts` 直接导入），差异行由 IPC 层用同一个函数生成。
 */
export function proposalContentText(content: KnowledgeContent): string {
  return `[${content.kind}] ${content.title}\n${content.body}`
}

function mapReview(row: Row): KnowledgeProposalReview {
  let edited: unknown = null
  if (typeof row.edited_patch_json === 'string' && row.edited_patch_json) {
    try {
      edited = JSON.parse(row.edited_patch_json) as unknown
    } catch {
      edited = null
    }
  }
  return {
    id: Number(row.id),
    action: pickEnum(row.action, ['accept', 'reject', 'edit_accept', 'publish'] as const, '审核动作') as KnowledgeReviewAction,
    reason: text(row.reason),
    reviewer: text(row.reviewer),
    editedPatch: edited,
    createdAt: text(row.created_at)
  }
}

export function getProposalDetail(db: KnowledgeDb, proposalId: number): KnowledgeProposalDetail | null {
  const id = positiveInt(proposalId, '提案 id')
  const row = db.prepare('SELECT * FROM knowledge_proposals WHERE id = ?').get(id) as Row | undefined
  if (!row) return null
  const summary = mapProposal(row)
  const patch = parsePatch(row.patch_json)

  let before: (KnowledgeContent & { version: number }) | null = null
  if (typeof row.before_json === 'string' && row.before_json) {
    try {
      const parsed = JSON.parse(row.before_json) as Record<string, unknown>
      before = {
        kind: KINDS.find((k) => k === parsed.kind) ?? 'note',
        title: text(parsed.title),
        body: text(parsed.body),
        version: Number(parsed.version ?? 0)
      }
    } catch {
      before = null
    }
  }

  const reviews = (
    db
      .prepare('SELECT * FROM proposal_reviews WHERE proposal_id = ? ORDER BY id ASC')
      .all(id) as Row[]
  ).map(mapReview)

  return {
    ...summary,
    content: patch.content,
    before,
    evidence: patch.evidence,
    reviews
  }
}

/** 提案幂等键：同一批次、同一操作、同一目标与同一补丁 → 同一条提案 */
function proposalIdempotencyKey(input: {
  batchKey: string
  op: KnowledgeProposalOp
  target: string
  baseVersion: number | null
  patchJson: string
  nature: KnowledgeNature
  sourceType: KnowledgeSourceType
  sourceRefJson: string
}): string {
  return sha256([
    input.batchKey,
    input.op,
    input.target,
    String(input.baseVersion ?? ''),
    input.patchJson,
    input.nature,
    input.sourceType,
    input.sourceRefJson
  ])
}

export function createProposal(
  db: KnowledgeDb,
  batchId: number,
  input: CreateKnowledgeProposalInput
): KnowledgeProposalSummary {
  if (!input || typeof input !== 'object') bad('无效的提案入参')
  const id = positiveInt(batchId, '批次 id')
  const batchRow = db.prepare('SELECT * FROM proposal_batches WHERE id = ?').get(id) as Row | undefined
  if (!batchRow) bad(`批次不存在：${id}`)

  const op = pickEnum(input.op, ['create', 'update'] as const, '提案操作')
  const content = normalizeContent(input.content)
  const contentNature = pickEnum(input.contentNature, NATURES, '内容性质')
  const sourceType = pickEnum(input.sourceType, SOURCE_TYPES, '来源类型')
  const sourceRef = normalizeRef(input.sourceRef, '来源定位')
  const evidence = normalizeEvidence(input.evidence)
  const reason = optionalText(input.reason, '提案理由', 2000) ?? ''
  const itemId = optionalPositiveInt(input.itemId, '文献 id')
  if (itemId !== null) assertItemExists(db, itemId)

  let targetEntryId: number | null = null
  let targetKey: string | null = null
  let baseVersion: number | null = null
  let beforeJson: string | null = null

  if (op === 'update') {
    const explicitId = optionalPositiveInt(input.targetEntryId, '目标条目 id')
    const explicitKey = optionalText(input.targetKey, '目标条目 key', 120)
    if (explicitId === null && explicitKey === null) bad('修改提案必须指定目标条目')
    const entryRow =
      explicitId !== null ? getEntryRowById(db, explicitId) : getEntryRowByKey(db, explicitKey as string)
    if (!entryRow) bad(`目标条目不存在：${explicitKey ?? explicitId}`)
    targetEntryId = Number(entryRow.id)
    targetKey = text(entryRow.key)
    baseVersion = positiveInt(input.baseVersion, '基线版本')
    beforeJson = JSON.stringify({
      kind: text(entryRow.kind),
      title: text(entryRow.title),
      body: text(entryRow.body),
      version: Number(entryRow.version)
    })
  } else {
    const requestedKey = optionalText(input.targetKey, '条目 key', 120)
    if (requestedKey !== null && !ENTRY_KEY.test(requestedKey)) bad(`无效的条目 key：${requestedKey}`)
    targetKey = requestedKey
    if (input.baseVersion !== undefined && input.baseVersion !== null) {
      bad('新增提案不能带基线版本')
    }
  }

  const patchJson = JSON.stringify({ content, evidence })
  const sourceRefJson = JSON.stringify(sourceRef)
  const checks = buildChecks(evidence)
  const verification: KnowledgeVerification =
    evidence.length > 0 && evidence.every(isEvidenceVerified) ? 'verified' : 'pending'
  const idempotencyKey = proposalIdempotencyKey({
    batchKey: text(batchRow.key),
    op,
    target: targetEntryId !== null ? `id:${targetEntryId}` : `key:${targetKey ?? ''}`,
    baseVersion,
    patchJson,
    nature: contentNature,
    sourceType,
    sourceRefJson
  })

  const existing = db
    .prepare('SELECT * FROM knowledge_proposals WHERE idempotency_key = ?')
    .get(idempotencyKey) as Row | undefined
  if (existing) return mapProposal(existing)

  const ts = nowIso()
  const info = db
    .prepare(
      `INSERT INTO knowledge_proposals
         (key, batch_id, item_id, op, target_entry_id, target_key, base_version, patch_json,
          before_json, reason, content_nature, source_type, source_ref, status, verification,
          checks_json, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?)`
    )
    .run(
      `prop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      id,
      itemId,
      op,
      targetEntryId,
      targetKey,
      baseVersion,
      patchJson,
      beforeJson,
      reason,
      contentNature,
      sourceType,
      sourceRefJson,
      verification,
      JSON.stringify({ needsVerification: checks.needsVerification, problems: checks.problems }),
      idempotencyKey,
      ts,
      ts
    )
  db.prepare('UPDATE proposal_batches SET updated_at = ? WHERE id = ?').run(ts, id)
  return getProposalSummary(db, lastId(info))
}

/* ---------------------- 论文拆解结果同步（PD38） ----------------------- */

function countBatchProposals(db: KnowledgeDb, batchId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM knowledge_proposals WHERE batch_id = ?')
    .get(batchId) as Row | undefined
  return Number(row?.n ?? 0)
}

/**
 * 把一个拆解同步计划写成「1 个批次 + N 条待审提案」，整体单事务：
 * - 批次与提案各自带幂等键，重复同步同一份拆解不会新增任何行；
 * - 提案状态恒为 pending_review，绝不写 knowledge_entries / evidence_links；
 * - 任一条失败整体回滚，既有数据不受影响。
 */
export function syncDigestProposals(
  db: KnowledgeDb,
  plan: DigestKnowledgePlan
): DigestSyncResult {
  if (!plan || typeof plan !== 'object') bad('无效的拆解同步计划')
  const batch = createBatch(db, plan.batch)
  const before = countBatchProposals(db, batch.id)
  for (const proposal of plan.proposals) {
    createProposal(db, batch.id, proposal)
  }
  const after = countBatchProposals(db, batch.id)
  const pointCount = plan.points.length
  const createdProposals = Math.max(0, after - before)
  return {
    itemId: plan.itemId,
    batchId: batch.id,
    batchKey: batch.key,
    fingerprint: plan.fingerprint,
    pointCount,
    createdProposals,
    reusedProposals: Math.max(0, pointCount - createdProposals)
  }
}

/**
 * 拆解同步的调用约定：调用方（IPC 与本文件的使用方）先用 shared/api.ts 的
 * `buildDigestKnowledgePlan` 生成确定性的计划，再用 `runInTransaction` 包住
 * `syncDigestProposals`。本文件刻意不在运行时 import shared/api（Node 直接执行
 * `scripts/test-unit.ts` 时需要显式扩展名），只引用它的类型。
 */

/* ---------------------- 批处理产物同步（PD43） ------------------------ */

/** 会产出拆解报告、可同步的批处理任务（范围条件必须留在 SQL 里） */
export const BATCH_DIGEST_SOURCE_TASKS = ['analyze-paper', 'translate-analyze'] as const

/** 从 batch_items.output（JSON 文件名数组）里取该篇的拆解报告文件名 */
function digestReportName(output: unknown): string | null {
  if (typeof output !== 'string' || !output) return null
  try {
    const parsed = JSON.parse(output) as unknown
    if (!Array.isArray(parsed)) return null
    const name = parsed.find(
      (n): n is string => typeof n === 'string' && n.toLowerCase().endsWith('.analysis.md')
    )
    return name ?? null
  } catch {
    return null
  }
}

/**
 * 采集一次批处理里「每篇论文最新的拆解结果」（PD43）：
 * - run / task / status / 每题最新明细全部由 SQL 决定，不在结果集上后置过滤；
 * - 优先取最近的 done 明细（重试成功会覆盖更早的失败），没有 done 的论文进 skipped；
 * - markdown 从该题产出的 `*.analysis.md` 读取，文件缺失/为空同样进 skipped 并说明原因。
 */
export function collectBatchDigestPapers(
  db: KnowledgeDb,
  runId: string,
  options: { itemIds?: number[] } = {}
): { papers: BatchDigestPaper[]; skipped: BatchSyncSkippedPaper[] } {
  const run = requireText(runId, '批处理批次标识', 120)
  const taskPlaceholders = BATCH_DIGEST_SOURCE_TASKS.map(() => '?').join(', ')
  const itemIds = Array.isArray(options?.itemIds)
    ? [...new Set(options.itemIds.map((id) => Math.floor(Number(id) || 0)).filter((id) => id > 0))]
    : []
  const itemFilter = itemIds.length > 0 ? `AND bi.item_id IN (${itemIds.map(() => '?').join(', ')})` : ''
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT bi.id AS batch_item_id,
                bi.job_id AS batch_job_id,
                bi.item_id AS item_id,
                bi.attachment_id AS attachment_id,
                bi.label AS label,
                bi.status AS item_status,
                bi.output AS output,
                bi.message AS item_message,
                bj.batch_run_id AS batch_run_id,
                bj.out_dir AS out_dir,
                i.title AS item_title,
                ROW_NUMBER() OVER (
                  PARTITION BY bi.item_id
                  ORDER BY CASE WHEN bi.status = 'done' THEN 0 ELSE 1 END, bi.id DESC
                ) AS rn
           FROM batch_items bi
           JOIN batch_jobs bj ON bj.id = bi.job_id
           LEFT JOIN items i ON i.id = bi.item_id
          WHERE bj.batch_run_id = ?
            AND bj.task IN (${taskPlaceholders})
            AND bi.item_id IS NOT NULL
            ${itemFilter}
       )
       WHERE rn = 1
       ORDER BY item_id, batch_item_id`
    )
    .all(run, ...BATCH_DIGEST_SOURCE_TASKS, ...itemIds) as Row[]

  const papers: BatchDigestPaper[] = []
  const skipped: BatchSyncSkippedPaper[] = []
  for (const row of rows) {
    const itemId = numberOrNull(row.item_id)
    const batchItemId = Number(row.batch_item_id ?? 0)
    const title =
      textOrNull(row.item_title) ?? textOrNull(row.label) ?? `论文 #${itemId ?? '?'}`
    if (itemId == null) {
      skipped.push({ itemId: null, batchItemId, title, reason: '该明细没有关联文献' })
      continue
    }
    const status = text(row.item_status)
    if (status !== 'done') {
      skipped.push({
        itemId,
        batchItemId,
        title,
        reason: `这篇在批处理里还没有完成（${status || '未知状态'}）`
      })
      continue
    }
    const outDir = textOrNull(row.out_dir)
    const reportName = digestReportName(row.output)
    if (!outDir || !reportName) {
      skipped.push({
        itemId,
        batchItemId,
        title,
        reason: '这篇没有生成拆解报告（*.analysis.md）'
      })
      continue
    }
    const path = join(outDir, reportName)
    let markdown = ''
    try {
      if (!existsSync(path)) {
        skipped.push({ itemId, batchItemId, title, reason: '拆解报告文件缺失，未同步' })
        continue
      }
      markdown = readFileSync(path, 'utf8')
    } catch {
      skipped.push({ itemId, batchItemId, title, reason: '拆解报告读取失败，未同步' })
      continue
    }
    if (!markdown.trim()) {
      skipped.push({ itemId, batchItemId, title, reason: '拆解报告内容为空，未同步' })
      continue
    }
    papers.push({
      itemId,
      attachmentId: numberOrNull(row.attachment_id),
      batchRunId: text(row.batch_run_id) || run,
      batchJobId: Number(row.batch_job_id ?? 0),
      batchItemId,
      title,
      markdown
    })
  }
  return { papers, skipped }
}

/**
 * 把一个「批处理 → 知识库」计划写成一个提案批次（PD43），整体单事务：
 * - 按 (item_id, digestPointId) 预查批次内已有提案，重跑/重试/追加都不重复插入；
 * - 只新建缺失的提案，绝不覆盖已有提案（也可能已被用户接受/编辑）；
 * - 只写 pending_review 提案，绝不发布正式条目。
 */
export function syncBatchProposals(
  db: KnowledgeDb,
  plan: BatchKnowledgePlan
): BatchSyncResult {
  if (!plan || typeof plan !== 'object') bad('无效的批处理同步计划')
  const runId = requireText(plan.runId, '批处理批次标识', 120)
  const batch = createBatch(db, plan.batch)

  const existing = db
    .prepare('SELECT item_id, source_ref FROM knowledge_proposals WHERE batch_id = ?')
    .all(batch.id) as Row[]
  const seen = new Set<string>()
  for (const row of existing) {
    const itemId = numberOrNull(row.item_id)
    const ref = parseJsonObject(row.source_ref)
    const pointId = textOrNull(ref.digestPointId)
    if (itemId != null && pointId) seen.add(`${itemId}:${pointId}`)
  }

  const before = countBatchProposals(db, batch.id)
  for (const proposal of plan.proposals) {
    const ref = proposal.sourceRef ?? {}
    const pointId = textOrNull(ref.digestPointId)
    const key = proposal.itemId != null && pointId ? `${proposal.itemId}:${pointId}` : ''
    if (key && seen.has(key)) continue
    createProposal(db, batch.id, proposal)
    if (key) seen.add(key)
  }
  const after = countBatchProposals(db, batch.id)
  const createdProposals = Math.max(0, after - before)
  const pointCount = plan.papers.reduce((sum, paper) => sum + paper.pointCount, 0)
  return {
    runId,
    batchId: batch.id,
    batchKey: batch.key,
    papers: plan.papers.length,
    pointCount,
    createdProposals,
    reusedProposals: Math.max(0, pointCount - createdProposals),
    skippedPapers: plan.skippedPapers ?? []
  }
}

/**
 * 批处理产物 → 知识库（PD44）：逐篇独立事务，一篇失败不影响其余论文。
 * - 一个 runId 只创建一个提案批次（batch:<runId> 幂等）；
 * - 每篇按 (item_id, digestPointId) 跳过已有提案，只新增缺失的 pending_review；
 * - 绝不写 knowledge_entries / 不发布，已发布条目不受影响。
 */
export function syncBatchProposalsByPaper(db: KnowledgeDb, plan: BatchKnowledgePlan): BatchSyncResult {
  if (!plan || typeof plan !== 'object') bad('无效的批处理同步计划')
  const runId = requireText(plan.runId, '批处理批次标识', 120)
  const batch = createBatch(db, plan.batch)
  const items: BatchSyncItemResult[] = []
  let createdProposals = 0
  let reusedProposals = 0

  for (const paper of plan.papers) {
    const proposals = plan.proposals.filter((proposal) => proposal.itemId === paper.itemId)
    let created = 0
    let reused = 0
    try {
      const before = countBatchProposals(db, batch.id)
      runInTransaction(db, () => {
        const existing = db
          .prepare('SELECT item_id, source_ref FROM knowledge_proposals WHERE batch_id = ?')
          .all(batch.id) as Row[]
        const seen = new Set<string>()
        for (const row of existing) {
          const itemId = numberOrNull(row.item_id)
          const ref = parseJsonObject(row.source_ref)
          const pointId = textOrNull(ref.digestPointId)
          if (itemId != null && pointId) seen.add(`${itemId}:${pointId}`)
        }
        for (const proposal of proposals) {
          const ref = proposal.sourceRef ?? {}
          const pointId = textOrNull(ref.digestPointId)
          const key = proposal.itemId != null && pointId ? `${proposal.itemId}:${pointId}` : ''
          if (key && seen.has(key)) continue
          createProposal(db, batch.id, proposal)
          if (key) seen.add(key)
        }
      })
      const after = countBatchProposals(db, batch.id)
      created = Math.max(0, after - before)
      reused = Math.max(0, proposals.length - created)
      createdProposals += created
      reusedProposals += reused
      items.push({
        itemId: paper.itemId,
        batchItemId: paper.batchItemId,
        title: paper.title,
        status: created > 0 ? 'success' : 'skipped',
        reason:
          created > 0
            ? `已提交 ${created} 条待审提案${reused > 0 ? `，${reused} 条已存在` : ''}`
            : '这些要点已经在暂存区，没有重复写入',
        createdProposals: created,
        added: 0,
        reused: 0
      })
    } catch (error) {
      items.push({
        itemId: paper.itemId,
        batchItemId: paper.batchItemId,
        title: paper.title,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error ?? '未知错误'),
        createdProposals: 0,
        added: 0,
        reused: 0
      })
    }
  }

  for (const skipped of plan.skippedPapers ?? []) {
    items.push({
      itemId: skipped.itemId,
      batchItemId: skipped.batchItemId,
      title: skipped.title,
      status: 'skipped',
      reason: skipped.reason,
      createdProposals: 0,
      added: 0,
      reused: 0
    })
  }

  const pointCount = plan.papers.reduce((sum, paper) => sum + paper.pointCount, 0)
  return {
    runId,
    batchId: batch.id,
    batchKey: batch.key,
    target: 'knowledge',
    papers: plan.papers.length,
    pointCount,
    createdProposals,
    reusedProposals,
    skippedPapers: plan.skippedPapers ?? [],
    success: items.filter((item) => item.status === 'success').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    failed: items.filter((item) => item.status === 'failed').length,
    items
  }
}

/** 批次内按论文聚合（PD43 暂存区「按论文筛选」）：数量统计全部在 SQL 里做 */
export function listBatchPapers(db: KnowledgeDb, batchId: number): KnowledgeBatchPaper[] {
  const id = positiveInt(batchId, '批次 id')
  const rows = db
    .prepare(
      `SELECT p.item_id AS item_id,
              i.title AS title,
              COUNT(*) AS total,
              SUM(CASE WHEN p.status = 'pending_review' THEN 1 ELSE 0 END) AS pending
         FROM knowledge_proposals p
         LEFT JOIN items i ON i.id = p.item_id
        WHERE p.batch_id = ? AND p.item_id IS NOT NULL
        GROUP BY p.item_id
        ORDER BY MIN(p.id)`
    )
    .all(id) as Row[]
  return rows.map((row) => ({
    itemId: Number(row.item_id),
    title: textOrNull(row.title),
    total: Number(row.total ?? 0),
    pending: Number(row.pending ?? 0)
  }))
}

/* ---------------------- 笔记 / 译文导入（PD41） ------------------------ */

/**
 * 导入批次的 task 标记。用字面量而不是从 shared/api.ts 取常量，是因为本文件
 * 保持零运行时 import（Node 直接执行 scripts/test-unit.ts 需要显式扩展名）。
 * shared/api.ts 的 batchSourceLabel 必须为这两个值提供中文标签。
 */
export const NOTE_IMPORT_BATCH_TASK = 'note-import'
export const TRANSLATION_IMPORT_BATCH_TASK = 'translation-import'

/** 短于该长度的碎片并入上一段（「见下图」这类噪声不该单独成条） */
export const IMPORT_MIN_CHARS = 20
/** 单批最多生成多少条提案，避免长译文一次刷出上百条待审 */
export const IMPORT_MAX_POINTS = 40
/** 单段正文上限，与拆解同步的 DIGEST_POINT_MAX_CHARS 对齐 */
export const IMPORT_POINT_MAX_CHARS = 1200
/** 提案标题上限（normalizeContent 的标题上限是 300，这里留足余量） */
const IMPORT_TITLE_MAX_CHARS = 160

/** 一条可导入的原文：某条笔记的正文，或某篇译文的 Markdown 全文 */
export interface KnowledgeImportSource {
  sourceType: KnowledgeImportSourceType
  /** notes.id 或 translations.id */
  refId: number
  title: string
  body: string
  attachmentId: number | null
  lang: string | null
}

export interface CollectedImportSources {
  sources: KnowledgeImportSource[]
  /** 有数据库记录但文件缺失 / 正文为空，已跳过（不阻塞整体导入） */
  skippedEmpty: number
}

export interface KnowledgeImportPlan {
  itemId: number
  source: KnowledgeImportSourceType
  fingerprint: string
  batch: CreateKnowledgeBatchInput
  proposals: CreateKnowledgeProposalInput[]
  /** 计划阶段因跨来源同内容而跳过的段数 */
  skippedDuplicates: number
}

/**
 * 最小 front-matter 剥离。notes.ts 里的 parseFrontMatter 依赖 ../db（electron），
 * 本文件是纯模块不能复用，因此这里只实现「---\n … \n---\n」这一种笔记实际写出的形式，
 * 与 notes.ts 的行为保持一致（不是第二套规则，是同一规则的本地最小实现）。
 */
function stripFrontMatter(raw: string): string {
  const text = String(raw ?? '').replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return text.trim()
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) return text.trim()
  return text.slice(end + 5).trim()
}

function readImportFile(absolutePath: string): string {
  try {
    if (!existsSync(absolutePath)) return ''
    return readFileSync(absolutePath, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 读取某个条目下可导入的原文（PD41）。
 *
 * 范围条件全部下推到 SQL：笔记用 `WHERE item_id = ?`，译文用
 * `JOIN attachments ... WHERE a.item_id = ?`——绝不「先取全库再在 JS 里过滤」。
 * 文件缺失或正文为空只计数跳过，不抛错（单条笔记丢失不该让整批导入失败）。
 */
export function collectItemImportSources(
  db: KnowledgeDb,
  dataDir: string,
  itemId: number,
  source: KnowledgeImportSourceType
): CollectedImportSources {
  const id = positiveInt(itemId, '文献 id')
  const kind = pickEnum(source, ['note', 'translation'] as const, '导入来源')
  const sources: KnowledgeImportSource[] = []
  let skippedEmpty = 0

  if (kind === 'note') {
    const rows = db
      .prepare('SELECT id, key, title, md_path FROM notes WHERE item_id = ? ORDER BY id ASC')
      .all(id) as Row[]
    for (const row of rows) {
      const noteId = Number(row.id)
      const rel = textOrNull(row.md_path) ?? `notes/${text(row.key)}.md`
      const body = stripFrontMatter(readImportFile(join(dataDir, ...rel.split('/'))))
      if (!body) {
        skippedEmpty += 1
        continue
      }
      sources.push({
        sourceType: 'note',
        refId: noteId,
        title: textOrNull(row.title) ?? `笔记 #${noteId}`,
        body,
        attachmentId: null,
        lang: null
      })
    }
    return { sources, skippedEmpty }
  }

  const rows = db
    .prepare(
      `SELECT t.id, t.attachment_id, t.lang, t.md_path
         FROM translations t
         JOIN attachments a ON a.id = t.attachment_id
        WHERE a.item_id = ?
          AND t.status = 'done'
          AND t.md_path IS NOT NULL
          AND t.md_path <> ''
        ORDER BY t.id ASC`
    )
    .all(id) as Row[]
  for (const row of rows) {
    const translationId = Number(row.id)
    const attachmentId = Number(row.attachment_id)
    const lang = text(row.lang)
    const rel = text(row.md_path)
    const body = stripFrontMatter(
      readImportFile(join(dataDir, 'translated', ...rel.split('/')))
    )
    if (!body) {
      skippedEmpty += 1
      continue
    }
    sources.push({
      sourceType: 'translation',
      refId: translationId,
      title: `译文（${lang || '未知语言'}）· #${translationId}`,
      body,
      attachmentId,
      lang: lang || null
    })
  }
  return { sources, skippedEmpty }
}

/** 标题里的 markdown 修饰去掉，留纯文本 */
function cleanImportHeading(raw: string): string {
  return raw
    .replace(/[`*_~]/g, '')
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, IMPORT_TITLE_MAX_CHARS)
}

function importTitleFromText(body: string): string {
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? ''
  const cleaned = firstLine.replace(/^[#>*\-\s]+/, '').trim()
  const sentence = cleaned.split(/[。！？!?]/)[0].trim() || cleaned
  return (sentence || '未命名要点').slice(0, IMPORT_TITLE_MAX_CHARS)
}

/**
 * 切段：有 markdown 标题就按标题分节（标题即段标题），没有标题的节按空行分段。
 * 标题后可能跟着多段正文，此时整节作为一条要点，保留小节内的论证完整性。
 */
function importSegments(body: string): Array<{ title: string; body: string }> {
  const normalized = String(body ?? '').replace(/\r\n/g, '\n').trim()
  if (!normalized) return []
  const sections: Array<{ title: string; lines: string[] }> = []
  let current: { title: string; lines: string[] } | null = null
  for (const line of normalized.split('\n')) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line.trim())
    if (heading) {
      if (current && current.lines.join('\n').trim()) sections.push(current)
      current = { title: cleanImportHeading(heading[2]), lines: [] }
      continue
    }
    if (!current) current = { title: '', lines: [] }
    current.lines.push(line)
  }
  if (current && current.lines.join('\n').trim()) sections.push(current)

  const out: Array<{ title: string; body: string }> = []
  const push = (title: string, raw: string): void => {
    const trimmed = raw.replace(/[ \t]+$/gm, '').trim()
    if (!trimmed) return
    if (trimmed.length < IMPORT_MIN_CHARS) {
      const prev = out[out.length - 1]
      // 碎片并入上一段，避免静默丢内容；并段不超上限
      if (prev && prev.body.length + trimmed.length + 2 <= IMPORT_POINT_MAX_CHARS) {
        prev.body = `${prev.body}\n\n${trimmed}`
        return
      }
      return
    }
    out.push({ title, body: trimmed })
  }

  for (const section of sections) {
    const joined = section.lines.join('\n')
    if (section.title) {
      push(section.title, joined)
      continue
    }
    for (const block of joined.split(/\n{2,}/)) push(importTitleFromText(block), block)
  }
  return out
}

/** 跨来源去重键：只看正文，因此笔记与译文里的同一段内容只会进知识库一次 */
function importBodyKey(body: string): string {
  return sha256([String(body ?? '').normalize('NFKC').trim()])
}

export interface BuildImportKnowledgePlanInput {
  itemId: number
  source: KnowledgeImportSourceType
  sources: readonly KnowledgeImportSource[]
}

/**
 * 把「某条目下的笔记 / 译文」整理成确定性的导入计划（纯函数，不写库）。
 *
 * 去重规则（验收要求）：
 * - 译文：同一 attachment_id + lang + content_hash 只产生一条提案，重复段追加证据；
 * - 笔记：同一 noteId + content_hash 同理；
 * - 跨来源：同一正文（正文哈希相同）在本次计划里只保留一条，计入 skippedDuplicates。
 * 跨批次（历史提案）的同内容去重由 syncImportProposals 负责。
 */
export function buildImportKnowledgePlan(
  input: BuildImportKnowledgePlanInput
): KnowledgeImportPlan {
  if (!input || typeof input !== 'object') bad('无效的导入参数')
  const itemId = positiveInt(input.itemId, '文献 id')
  const source = pickEnum(input.source, ['note', 'translation'] as const, '导入来源')
  const sources = Array.isArray(input.sources) ? input.sources : []
  if (sources.length === 0) {
    bad(
      source === 'note'
        ? '该条目暂无笔记，无法导入知识库'
        : '该条目暂无已翻译段落，无法导入知识库'
    )
  }

  const proposals: CreateKnowledgeProposalInput[] = []
  const bySourceKey = new Map<string, number>()
  const bodyKeys = new Set<string>()
  const sourceKeys: string[] = []
  let skippedDuplicates = 0
  const nature: KnowledgeNature = source === 'note' ? 'observation' : 'author_claim'
  const kind: KnowledgeKind = source === 'note' ? 'note' : 'claim'

  outer: for (const src of sources) {
    if (!src || typeof src !== 'object') continue
    const bodyText = String(src.body ?? '')
    if (!bodyText.trim()) continue
    const refId = positiveInt(src.refId, '来源 id')
    const attachmentId =
      src.sourceType === 'translation' && src.attachmentId !== null
        ? positiveInt(src.attachmentId, '附件 id')
        : null
    const lang = src.sourceType === 'translation' ? (textOrNull(src.lang) ?? null) : null
    const sourceRef: Record<string, string | number | boolean | null> =
      src.sourceType === 'translation'
        ? { translationId: refId, attachmentId, lang }
        : { noteId: refId }

    for (const segment of importSegments(bodyText)) {
      if (proposals.length >= IMPORT_MAX_POINTS) break outer
      const body = segment.body.slice(0, IMPORT_POINT_MAX_CHARS)
      const title = (segment.title || importTitleFromText(body)).slice(0, IMPORT_TITLE_MAX_CHARS)
      const contentHash = knowledgeContentHash(kind, title, body)
      const sourceKey =
        src.sourceType === 'translation'
          ? `${attachmentId ?? 0}:${lang ?? ''}:${contentHash}`
          : `${refId}:${contentHash}`
      const evidence: KnowledgeEvidenceInput = {
        sourceType: src.sourceType,
        sourceRef,
        itemId,
        attachmentId,
        quote: body.slice(0, 300),
        sectionPath: title,
        // 没有页码映射就如实标 document，绝不伪造 pageIndex
        precision: 'document'
      }

      const merged = bySourceKey.get(sourceKey)
      if (merged !== undefined) {
        const target = proposals[merged]
        const list = target.evidence ?? []
        if (list.length < 20) target.evidence = [...list, evidence]
        continue
      }
      const bodyKey = importBodyKey(body)
      if (bodyKeys.has(bodyKey)) {
        skippedDuplicates += 1
        continue
      }
      bySourceKey.set(sourceKey, proposals.length)
      bodyKeys.add(bodyKey)
      sourceKeys.push(sourceKey)
      proposals.push({
        op: 'create',
        itemId,
        content: { kind, title, body },
        contentNature: nature,
        sourceType: src.sourceType,
        sourceRef,
        evidence: [evidence],
        reason:
          source === 'note'
            ? `笔记导入：${title}`
            : `译文导入：${title}`
      })
    }
  }

  if (proposals.length === 0) {
    bad(
      source === 'note'
        ? '该条目的笔记没有可导入的正文段落'
        : '该条目的译文没有可导入的正文段落'
    )
  }

  const fingerprint = sha256([`import:${source}:${itemId}`, ...sourceKeys.slice().sort()])
  const label = source === 'note' ? '笔记导入' : '译文导入'
  const batch: CreateKnowledgeBatchInput = {
    title: `${label} · ${proposals.length} 条`,
    task: source === 'note' ? NOTE_IMPORT_BATCH_TASK : TRANSLATION_IMPORT_BATCH_TASK,
    scopeType: 'item',
    scopeRef: String(itemId),
    origin: 'import',
    idempotencyKey: `import:${source}:${itemId}:${fingerprint}`
  }

  return { itemId, source, fingerprint, batch, proposals, skippedDuplicates }
}

/**
 * 把导入计划写成「1 个批次 + N 条待审提案」，调用方负责事务（runInTransaction）。
 *
 * 与 syncDigestProposals 同构，但多一层跨批次去重：同一文献下已存在同内容提案
 * （无论来自哪个批次、哪种来源）时不再新建，计入 skippedDuplicates。
 * 状态恒为 pending_review，绝不写 knowledge_entries / evidence_links——发布只能由用户点击。
 */
export function syncImportProposals(
  db: KnowledgeDb,
  plan: KnowledgeImportPlan
): KnowledgeImportResult {
  if (!plan || typeof plan !== 'object') bad('无效的导入计划')
  const itemId = positiveInt(plan.itemId, '文献 id')
  const source = pickEnum(plan.source, ['note', 'translation'] as const, '导入来源')

  const batch = createBatch(db, plan.batch)
  const before = countBatchProposals(db, batch.id)

  // 跨批次去重：范围条件（item_id）在 SQL 里，比较用派生哈希而不是 json_extract
  const seenHashes = new Set<string>()
  const seenBodies = new Set<string>()
  const existing = db
    .prepare(
      'SELECT patch_json FROM knowledge_proposals WHERE item_id = ? AND batch_id <> ?'
    )
    .all(itemId, batch.id) as Row[]
  for (const row of existing) {
    const patch = parsePatch(row.patch_json)
    seenHashes.add(
      knowledgeContentHash(patch.content.kind, patch.content.title, patch.content.body)
    )
    seenBodies.add(importBodyKey(patch.content.body))
  }

  let skippedDuplicates = 0
  for (const proposal of plan.proposals) {
    const hash = knowledgeContentHash(
      proposal.content.kind,
      proposal.content.title,
      proposal.content.body
    )
    const bodyKey = importBodyKey(proposal.content.body)
    if (seenHashes.has(hash) || seenBodies.has(bodyKey)) {
      skippedDuplicates += 1
      continue
    }
    seenHashes.add(hash)
    seenBodies.add(bodyKey)
    createProposal(db, batch.id, proposal)
  }

  const after = countBatchProposals(db, batch.id)
  const pointCount = plan.proposals.length
  const createdProposals = Math.max(0, after - before)
  return {
    itemId,
    source,
    batchId: batch.id,
    batchKey: batch.key,
    pointCount,
    createdProposals,
    reusedProposals: Math.max(0, pointCount - createdProposals - skippedDuplicates),
    skippedDuplicates
  }
}

function assertReviewable(row: Row, allowed: readonly KnowledgeProposalStatus[]): KnowledgeProposalStatus {
  const status = pickEnum(row.status, PROPOSAL_STATUSES, '提案状态')
  if (!allowed.includes(status)) {
    bad(`提案当前状态为 ${status}，不可执行该审核动作`)
  }
  return status
}

/**
 * 审核理由占位（PD35）：界面上的「接受 / 编辑后接受」不强制填理由，
 * 但审计记录 proposal_reviews.reason 必须是可识别的人类可读文本，不能是空串或 null。
 * 这两个常量同时是单测与文档的锚点，改文案必须同步测试。
 */
export const ACCEPT_REASON_PLACEHOLDER = '界面接受（未填理由）'
export const EDIT_ACCEPT_REASON_PLACEHOLDER = '界面编辑后接受（未填理由）'

function insertReview(
  db: KnowledgeDb,
  proposalId: number,
  action: KnowledgeReviewAction,
  reason: string,
  editedPatchJson: string | null
): void {
  db.prepare(
    `INSERT INTO proposal_reviews (proposal_id, action, edited_patch_json, reason, reviewer, created_at)
     VALUES (?, ?, ?, ?, 'user', ?)`
  ).run(proposalId, action, editedPatchJson, reason, nowIso())
}

/** 接受提案：只改提案状态与审核记录，**不动正式条目** */
export function acceptProposal(
  db: KnowledgeDb,
  proposalId: number,
  opts: { reason?: string } = {}
): KnowledgeProposalSummary {
  const id = positiveInt(proposalId, '提案 id')
  const row = mustGetProposalRow(db, id)
  assertReviewable(row, ['pending_review', 'needs_edit'])
  const reason = optionalText(opts.reason, '审核理由', 2000) ?? ACCEPT_REASON_PLACEHOLDER
  runInTransaction(db, () => {
    const ts = nowIso()
    db.prepare('UPDATE knowledge_proposals SET status = ?, updated_at = ? WHERE id = ?').run(
      'approved',
      ts,
      id
    )
    insertReview(db, id, 'accept', reason, null)
  })
  return getProposalSummary(db, id)
}

/** 拒绝提案：必须写理由（审计需要），只改提案状态 */
export function rejectProposal(
  db: KnowledgeDb,
  proposalId: number,
  opts: { reason: string }
): KnowledgeProposalSummary {
  const id = positiveInt(proposalId, '提案 id')
  const reason = requireText(opts?.reason, '拒绝理由', 2000)
  const row = mustGetProposalRow(db, id)
  assertReviewable(row, ['pending_review', 'needs_edit', 'approved'])
  runInTransaction(db, () => {
    const ts = nowIso()
    db.prepare('UPDATE knowledge_proposals SET status = ?, updated_at = ? WHERE id = ?').run(
      'rejected',
      ts,
      id
    )
    insertReview(db, id, 'reject', reason, null)
  })
  return getProposalSummary(db, id)
}

/** 编辑后接受：改写提案内容/证据，重新算「待核验」，状态置 approved */
export function editAndAccept(
  db: KnowledgeDb,
  proposalId: number,
  patch: EditAcceptPatch
): KnowledgeProposalSummary {
  const id = positiveInt(proposalId, '提案 id')
  const row = mustGetProposalRow(db, id)
  assertReviewable(row, ['pending_review', 'needs_edit', 'approved'])
  const current = parsePatch(row.patch_json)
  const content =
    patch?.content === undefined || patch?.content === null
      ? current.content
      : normalizeContent(patch.content)
  const evidence =
    patch?.evidence === undefined || patch?.evidence === null
      ? current.evidence
      : normalizeEvidence(patch.evidence)
  const reason = optionalText(patch?.reason, '编辑理由', 2000) ?? EDIT_ACCEPT_REASON_PLACEHOLDER
  const nextPatch = JSON.stringify({ content, evidence })
  const checks = buildChecks(evidence)
  const verification: KnowledgeVerification =
    evidence.length > 0 && evidence.every(isEvidenceVerified) ? 'verified' : 'pending'

  runInTransaction(db, () => {
    const ts = nowIso()
    db.prepare(
      `UPDATE knowledge_proposals
          SET patch_json = ?, verification = ?, checks_json = ?, status = 'approved', updated_at = ?
        WHERE id = ?`
    ).run(
      nextPatch,
      verification,
      JSON.stringify({ needsVerification: checks.needsVerification, problems: checks.problems }),
      ts,
      id
    )
    insertReview(db, id, 'edit_accept', reason, nextPatch)
  })
  return getProposalSummary(db, id)
}

/* ------------------------------- 发布 ---------------------------------- */

function makeEntryKey(db: KnowledgeDb, title: string, ts: string): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'entry'
  const stamp = ts.replace(/[-:.TZ]/g, '').slice(0, 14)
  let candidate = `${base}-${stamp}`
  let suffix = 1
  while (getEntryRowByKey(db, candidate)) {
    suffix += 1
    candidate = `${base}-${stamp}-${suffix}`
  }
  return candidate
}

/**
 * 发布批次：单事务；任何一条冲突（状态未接受 / 来源待核验 / 版本冲突）→ 整批不写。
 * 幂等：已发布的提案直接跳过；knowledge_versions.proposal_id 唯一索引兜底。
 */
export function publishBatch(db: KnowledgeDb, input: PublishBatchInput): KnowledgePublishResult {
  if (!input || typeof input !== 'object') bad('无效的发布入参')
  const batchId = positiveInt(input.batchId, '批次 id')
  const batchRow = db.prepare('SELECT * FROM proposal_batches WHERE id = ?').get(batchId) as Row | undefined
  if (!batchRow) bad(`批次不存在：${batchId}`)
  const batch = mapBatch(db, batchRow)

  let rows = db
    .prepare('SELECT * FROM knowledge_proposals WHERE batch_id = ? ORDER BY id ASC')
    .all(batchId) as Row[]

  const requested = input.proposalIds ?? null
  if (requested !== null) {
    if (!Array.isArray(requested) || requested.length === 0) bad('无效的提案 id 列表')
    const ids = new Set<number>()
    for (const raw of requested) ids.add(positiveInt(raw, '提案 id'))
    const ownIds = new Set(rows.map((r) => Number(r.id)))
    for (const id of ids) {
      if (!ownIds.has(id)) bad(`提案 ${id} 不属于批次 ${batch.key}`)
    }
    rows = rows.filter((r) => ids.has(Number(r.id)))
  }
  if (rows.length === 0) bad('批次内没有可发布的提案')

  const conflicts: KnowledgePublishConflict[] = []
  const todo: Row[] = []
  let alreadyPublished = 0

  for (const row of rows) {
    const status = pickEnum(row.status, PROPOSAL_STATUSES, '提案状态')
    if (status === 'published') {
      alreadyPublished += 1
      continue
    }
    if (status === 'rejected' || status === 'withdrawn') {
      // 用户已明确否决/撤回的提案不再阻塞整批发布；但若调用方点名要发它，
      // 仍落到下面的「尚未接受」冲突里，不静默忽略用户的显式请求。
      if (requested === null) continue
    }
    if (status !== 'approved') {
      conflicts.push({
        proposalId: Number(row.id),
        key: text(row.key),
        reason: `提案尚未接受（当前状态 ${status}），请先在暂存区接受`
      })
      continue
    }
    if (pickEnum(row.verification, ['pending', 'verified'] as const, '来源可信度') !== 'verified') {
      conflicts.push({
        proposalId: Number(row.id),
        key: text(row.key),
        reason: '来源待核验：缺少可定位到原文的来源证据，补齐后才能发布'
      })
      continue
    }
    const op = pickEnum(row.op, ['create', 'update'] as const, '提案操作')
    const patch = parsePatch(row.patch_json)
    if (!patch.content.title || !patch.content.body) {
      conflicts.push({
        proposalId: Number(row.id),
        key: text(row.key),
        reason: '提案内容不完整（标题或正文为空）'
      })
      continue
    }
    if (op === 'update') {
      const targetId = numberOrNull(row.target_entry_id)
      const targetKey = textOrNull(row.target_key)
      const entry =
        targetId !== null ? getEntryRowById(db, targetId) : targetKey ? getEntryRowByKey(db, targetKey) : undefined
      if (!entry) {
        conflicts.push({
          proposalId: Number(row.id),
          key: text(row.key),
          reason: `目标条目已不存在：${targetKey ?? targetId}`
        })
        continue
      }
      const currentVersion = Number(entry.version)
      if (currentVersion !== numberOrNull(row.base_version)) {
        conflicts.push({
          proposalId: Number(row.id),
          key: text(row.key),
          reason: `版本冲突：${text(entry.key)} 已被修改（当前 v${currentVersion}，提案基于 v${String(
            numberOrNull(row.base_version) ?? '?'
          )}）`
        })
        continue
      }
    } else {
      const entryKey = textOrNull(row.target_key)
      if (entryKey && getEntryRowByKey(db, entryKey)) {
        conflicts.push({
          proposalId: Number(row.id),
          key: text(row.key),
          reason: `条目已存在：${entryKey}`
        })
        continue
      }
    }
    todo.push(row)
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      alreadyPublished: false,
      publishedProposalIds: [],
      entryIds: [],
      conflicts,
      batchStatus: batch.status
    }
  }

  if (todo.length === 0) {
    return {
      ok: true,
      alreadyPublished: true,
      publishedProposalIds: [],
      entryIds: [],
      conflicts: [],
      batchStatus: batch.status
    }
  }

  return runInTransaction(db, () => {
    const ts = nowIso()
    const publishedProposalIds: number[] = []
    const entryIds: number[] = []

    for (const row of todo) {
      const proposalId = Number(row.id)
      const patch = parsePatch(row.patch_json)
      const op = pickEnum(row.op, ['create', 'update'] as const, '提案操作')
      const nature = pickEnum(row.content_nature, NATURES, '内容性质')
      const contentHash = knowledgeContentHash(
        patch.content.kind,
        patch.content.title,
        patch.content.body
      )
      const snapshotEvidence = JSON.stringify(patch.evidence)

      let entryId: number
      let version: number
      if (op === 'create') {
        const entryKey =
          textOrNull(row.target_key) ?? makeEntryKey(db, patch.content.title, ts)
        if (getEntryRowByKey(db, entryKey)) bad(`条目已存在：${entryKey}`)
        const info = db
          .prepare(
            `INSERT INTO knowledge_entries
               (key, kind, title, body, content_nature, item_id, attachment_id, source_type,
                source_ref, content_hash, version, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`
          )
          .run(
            entryKey,
            patch.content.kind,
            patch.content.title,
            patch.content.body,
            nature,
            numberOrNull(row.item_id),
            null,
            pickEnum(row.source_type, SOURCE_TYPES, '来源类型'),
            text(row.source_ref) || '{}',
            contentHash,
            ts,
            ts
          )
        entryId = lastId(info)
        version = 1
      } else {
        const targetId = numberOrNull(row.target_entry_id)
        const targetKey = textOrNull(row.target_key)
        const entry =
          targetId !== null
            ? getEntryRowById(db, targetId)
            : targetKey
              ? getEntryRowByKey(db, targetKey)
              : undefined
        if (!entry) bad(`目标条目已不存在：${targetKey ?? targetId}`)
        if (Number(entry.version) !== numberOrNull(row.base_version)) {
          bad(`版本冲突：${text(entry.key)} 已被修改`)
        }
        entryId = Number(entry.id)
        version = Number(entry.version) + 1
        db.prepare(
          `UPDATE knowledge_entries
              SET kind = ?, title = ?, body = ?, content_nature = ?, content_hash = ?,
                  version = ?, updated_at = ?
            WHERE id = ?`
        ).run(
          patch.content.kind,
          patch.content.title,
          patch.content.body,
          nature,
          contentHash,
          version,
          ts,
          entryId
        )
      }

      db.prepare(
        `INSERT INTO knowledge_versions
           (entry_id, version, snapshot_json, change_reason, proposal_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'user', ?)`
      ).run(
        entryId,
        version,
        JSON.stringify({
          entry: {
            key: textOrNull(row.target_key) ?? '',
            kind: patch.content.kind,
            title: patch.content.title,
            body: patch.content.body,
            contentNature: nature
          },
          evidence: patch.evidence
        }),
        text(row.reason),
        proposalId,
        ts
      )

      for (const evidence of patch.evidence) {
        db.prepare(
          `INSERT INTO evidence_links
             (entry_id, proposal_id, source_type, source_ref, item_id, attachment_id, page_index,
              page_end, module_id, rect, char_start, char_end, quote, section_path, precision,
              content_hash, verified, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          entryId,
          proposalId,
          evidence.sourceType,
          JSON.stringify(evidence.sourceRef ?? {}),
          evidence.itemId ?? null,
          evidence.attachmentId ?? null,
          evidence.pageIndex ?? null,
          evidence.pageEnd ?? null,
          evidence.moduleId ?? null,
          evidence.rect ?? null,
          evidence.charStart ?? null,
          evidence.charEnd ?? null,
          evidence.quote,
          evidence.sectionPath ?? null,
          evidence.precision ?? 'document',
          sha256([evidence.quote]),
          isEvidenceVerified(evidence) ? 1 : 0,
          ts
        )
      }

      db.prepare(
        `UPDATE knowledge_proposals SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?`
      ).run(ts, ts, proposalId)
      insertReview(db, proposalId, 'publish', '', snapshotEvidence)
      publishedProposalIds.push(proposalId)
      entryIds.push(entryId)
    }

    const remainingRow = db
      .prepare(
        `SELECT COUNT(*) AS c FROM knowledge_proposals
          WHERE batch_id = ? AND status IN ('draft','pending_review','approved','needs_edit')`
      )
      .get(batchId) as Row | undefined
    const remaining = Number(remainingRow?.c ?? 0)
    const batchStatus: KnowledgeBatchStatus = remaining > 0 ? 'partially_published' : 'published'
    db.prepare('UPDATE proposal_batches SET status = ?, updated_at = ? WHERE id = ?').run(
      batchStatus,
      ts,
      batchId
    )

    return {
      ok: true,
      alreadyPublished: false,
      publishedProposalIds,
      entryIds,
      conflicts: [],
      batchStatus
    }
  })
}

/** 供 IPC 层复用的校验工具（IPC 只做「不可信输入」的浅校验，深校验在服务层） */
export const knowledgeValidation = {
  positiveInt,
  optionalPositiveInt,
  requireText,
  optionalText,
  pickEnum,
  enums: {
    kinds: KINDS,
    natures: NATURES,
    sourceTypes: SOURCE_TYPES,
    precisions: PRECISIONS,
    proposalStatuses: PROPOSAL_STATUSES,
    batchStatuses: BATCH_STATUSES,
    origins: ORIGINS,
    scopeTypes: SCOPE_TYPES,
    entryStates: ENTRY_STATES
  }
}
