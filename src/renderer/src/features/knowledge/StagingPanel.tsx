import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  KnowledgeBatch,
  KnowledgeBatchPaper,
  KnowledgeEvidenceInput,
  KnowledgeKind,
  KnowledgeProposalDetail,
  KnowledgeProposalSummary
} from '@shared/types'
import {
  applyProposalStatus,
  applyPublishedProposals,
  approveAllDisabledTitle,
  BATCH_DIGEST_BATCH_TASK,
  batchSourceLabel,
  buildApproveAllOutcome,
  buildApproveAllPlan,
  buildEditAcceptPatch,
  buildPublishPlan,
  describeApproveAllConfirm,
  describeApproveAllResult,
  describeImportResult,
  describePublishConflicts,
  describePublishResult,
  DIGEST_BATCH_TASK,
  evidenceTarget,
  groupProposalsByOp,
  isProposalReviewable,
  proposalNeedsAttention,
  proposalStatusLabel,
  proposalStatusTone,
  resolveStagingImportTarget,
  selectStagingProposals,
  stagingEmptyState,
  type StagingApproveAllOutcome,
  type StagingApproveAllOutcomeKind,
  type StagingConflictView,
  type StagingImportTargetResult,
  type StagingPublishNotice
} from '@shared/api'
import { docStateKey, parseDocState } from '@shared/doc-state'
import { Icon } from '../../components/Icon'
import { ProposalDiff } from './ProposalDiff'
import { evidencePrecisionLabel, evidencePrecisionTone } from './evidence-precision'

/** 跳转原文：page 为 1 基页码，rect 为底边原点（与 reader 的 openTarget 一致） */
export interface StagingEvidenceJump {
  itemId: number | null
  attachmentId: number | null
  page: number | null
  rect: [number, number, number, number] | null
}

export interface StagingPanelProps {
  onClose: () => void
  /** 论文类证据跳原文；未提供时按钮禁用（例如独立测试渲染） */
  onOpenEvidence?: (target: StagingEvidenceJump) => void
}

const KIND_LABEL: Record<KnowledgeKind, string> = {
  paper: '论文',
  concept: '概念',
  method: '方法',
  result: '结果',
  dataset: '数据集',
  metric: '指标',
  claim: '论断',
  note: '笔记',
  decision: '决定',
  question: '问题'
}

const SOURCE_LABEL: Record<string, string> = {
  paper: '论文',
  translation: '译文',
  note: '笔记',
  annotation: '批注',
  conversation: '对话',
  user: '用户结论',
  digest: '论文拆解',
  batch: '批处理'
}

const NATURE_LABEL: Record<string, string> = {
  user_decision: '用户决定',
  user_hypothesis: '用户假设',
  author_claim: '作者主张',
  observation: '观察',
  ai_inference: 'AI 推断',
  ai_suggestion: 'AI 建议'
}

const REVIEW_LABEL: Record<string, string> = {
  accept: '接受',
  reject: '拒绝',
  edit_accept: '编辑后接受',
  publish: '发布'
}

const BATCH_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  ready: '待发布',
  partially_published: '部分发布',
  published: '已发布',
  abandoned: '已放弃'
}

/** PD51：一键批准明细里的结果标签 */
const APPROVE_ALL_OUTCOME_LABEL: Record<StagingApproveAllOutcomeKind, string> = {
  published: '已发布',
  skipped: '跳过',
  failed: '失败'
}

/** IPC 错误会带 "Error invoking remote method 'x': Error:" 前缀，去掉后才是给用户看的文案 */
function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/u, '')
    .replace(/^Error:\s*/u, '')
    .trim()
}

/** 在对话原文里高亮证据引文（找不到就原样显示，不编造位置） */
function highlightQuote(text: string, quote: string): React.ReactNode {
  const needle = (quote || '').trim()
  if (!needle) return text
  const at = text.indexOf(needle)
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark className="stage-mark">{needle}</mark>
      {text.slice(at + needle.length)}
    </>
  )
}

function formatTime(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function evidenceLocation(evidence: KnowledgeEvidenceInput): string {
  const target = evidenceTarget(evidence)
  if (target.conversationId != null) {
    return `对话 #${target.conversationId}${target.messageId != null ? ` · 消息 #${target.messageId}` : ''}`
  }
  if (target.page != null) return `第 ${target.page} 页`
  if (evidence.moduleId) return `模块 ${evidence.moduleId}`
  return '仅文档级定位'
}

/**
 * 暂存区审核面板（PD34）。
 * 数据全部走 `window.api.knowledge.*`（PD33 已落地）：列表/详情/接受/拒绝/编辑后接受/发布。
 * 渲染层只发起用户显式点击的动作，绝不自动发布；发布前展示受影响条目数并二次确认。
 */
export function StagingPanel({ onClose, onOpenEvidence }: StagingPanelProps): React.JSX.Element {
  const [batches, setBatches] = useState<KnowledgeBatch[]>([])
  const [activeBatchId, setActiveBatchId] = useState<number | null>(null)
  const [proposals, setProposals] = useState<KnowledgeProposalSummary[]>([])
  const [details, setDetails] = useState<Record<number, KnowledgeProposalDetail>>({})
  const [selected, setSelected] = useState<number[]>([])
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<StagingPublishNotice | null>(null)
  const [conflicts, setConflicts] = useState<StagingConflictView[]>([])
  const [confirming, setConfirming] = useState(false)
  const [rejecting, setRejecting] = useState<{ id: number; reason: string } | null>(null)
  const [editing, setEditing] = useState<{ id: number; title: string; body: string; reason: string } | null>(
    null
  )
  const [editErrors, setEditErrors] = useState<string[]>([])
  const [conversationView, setConversationView] = useState<{
    id: number
    messageId: number | null
    quote: string
    role: string
    content: string
    createdAt: string
    missing: boolean
  } | null>(null)

  const panelRef = useRef<HTMLDivElement | null>(null)
  const aliveRef = useRef(true)
  /** 一键批准期间抑制 onKnowledgeChanged 的整表重载（逐条 accept 会广播很多次） */
  const bulkApproveRef = useRef(false)

  // PD51：一键批准的内联结果（已发布 / 跳过 / 失败 + 可展开明细）
  const [approveAllOpen, setApproveAllOpen] = useState(false)
  const [approveAllOutcome, setApproveAllOutcome] = useState<StagingApproveAllOutcome | null>(null)

  // PD41/PD51：笔记 / 译文导入。目标文献由「当前打开的论文」自动推导，不再让用户选。
  const [importItems, setImportItems] = useState<Array<{ id: number; title: string }>>([])
  const [importTarget, setImportTarget] = useState<StagingImportTargetResult | null>(null)
  const [importing, setImporting] = useState<'note' | 'translation' | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<string | null>(null)

  // PD43：批处理批次按论文聚合与筛选（papers 由 knowledge.batchPapers 走 SQL GROUP BY 得到）
  const [papers, setPapers] = useState<KnowledgeBatchPaper[]>([])
  const [paperFilter, setPaperFilter] = useState<number | null>(null)

  useEffect(() => {
    aliveRef.current = true
    panelRef.current?.focus()
    return () => {
      aliveRef.current = false
    }
  }, [])

  const loadBatches = useCallback(async (preferId?: number): Promise<void> => {
    try {
      const list = await window.api.knowledge.listBatches()
      if (!aliveRef.current) return
      setBatches(list)
      setActiveBatchId((prev) => {
        if (preferId != null && list.some((batch) => batch.id === preferId)) return preferId
        if (prev != null && list.some((batch) => batch.id === prev)) return prev
        const withWork = list.find((batch) => batch.counts.pending + batch.counts.approved > 0)
        return (withWork ?? list[0])?.id ?? null
      })
    } catch (err) {
      if (aliveRef.current) setError(ipcErrorMessage(err) || '读取提案批次失败')
    }
  }, [])

  /**
   * PD43：按论文筛选时把 itemId 交给主进程写进 SQL（不做结果集后置过滤）。
   * itemId 为空 = 整批。
   * PD51：opts.silent = 审核后的后台对账——不置整表 loading、不清详情/勾选/展开，
   * 列表滚动位置与展开状态都保持不变。
   */
  const loadProposals = useCallback(
    async (batchId: number, itemId?: number, opts?: { silent?: boolean }): Promise<void> => {
      const silent = opts?.silent === true
      if (!silent) setLoading(true)
      try {
        const list = await window.api.knowledge.listProposals(
          itemId != null ? { batchId, itemId } : { batchId }
        )
        if (!aliveRef.current) return
        setProposals(selectStagingProposals(list))
        if (!silent) {
          setDetails({})
          setSelected([])
          setExpandedId(null)
          setError(null)
        }
      } catch (err) {
        if (aliveRef.current) setError(ipcErrorMessage(err) || '读取待审提案失败')
      } finally {
        if (!silent && aliveRef.current) setLoading(false)
      }
    },
    []
  )

  /** PD43：这一批里每篇论文各有多少条提案（SQL GROUP BY，用于「来自批处理（N 篇）」与论文展开） */
  const loadPapers = useCallback(async (batchId: number): Promise<void> => {
    try {
      const list = await window.api.knowledge.batchPapers(batchId)
      if (!aliveRef.current) return
      setPapers(list)
    } catch {
      // 论文聚合只是辅助信息，失败时保留上一次结果，不影响提案审核
      if (aliveRef.current) setPapers([])
    }
  }, [])

  useEffect(() => {
    void loadBatches()
  }, [loadBatches])

  // PD38/PD43：拆解同步或批处理同步完成后由主进程广播；这里刷新批次、论文聚合与当前批次的提案
  // PD51：广播刷新走 silent——逐条接受时不再整表 loading、不丢滚动位置与展开状态
  useEffect(() => {
    const unsubscribe = window.api.onKnowledgeChanged(() => {
      // 一键批准自己会在结束时统一对账，逐条 accept 的广播不逐个重拉
      if (bulkApproveRef.current) return
      void loadBatches()
      if (activeBatchId != null) {
        void loadProposals(activeBatchId, paperFilter ?? undefined, { silent: true })
        void loadPapers(activeBatchId)
      }
    })
    return unsubscribe
  }, [activeBatchId, paperFilter, loadBatches, loadProposals, loadPapers])

  useEffect(() => {
    if (activeBatchId == null) {
      setProposals([])
      setPapers([])
      setLoading(false)
      return
    }
    void loadProposals(activeBatchId, paperFilter ?? undefined)
    void loadPapers(activeBatchId)
  }, [activeBatchId, paperFilter, loadProposals, loadPapers])

  /** 切换批次时清掉论文筛选，避免拿着上一批的 itemId 去查新批次 */
  const selectBatch = (batchId: number): void => {
    setPaperFilter(null)
    setActiveBatchId(batchId)
  }

  const activeBatch = useMemo(
    () => batches.find((batch) => batch.id === activeBatchId) ?? null,
    [batches, activeBatchId]
  )

  const groups = useMemo(() => groupProposalsByOp(proposals), [proposals])

  /** 空态分支：区分「没有批次 / 未选批次 / 批次内没有提案」，不再一律显示「该批次没有」 */
  const emptyState = useMemo(
    () =>
      stagingEmptyState({
        batchCount: batches.length,
        hasActiveBatch: activeBatchId != null,
        proposalCount: proposals.length
      }),
    [batches.length, activeBatchId, proposals.length]
  )

  const selectedProposals = useMemo(
    () => proposals.filter((proposal) => selected.includes(proposal.id)),
    [proposals, selected]
  )

  const plan = useMemo(() => buildPublishPlan(selectedProposals), [selectedProposals])

  /** PD51：一键批准计划 + 禁用原因（无待审时禁用，title 说明为什么） */
  const approveAllPlan = useMemo(() => buildApproveAllPlan(proposals), [proposals])
  const approveAllDisabled = useMemo(
    () => approveAllDisabledTitle(approveAllPlan),
    [approveAllPlan]
  )

  const refreshAfterChange = useCallback(
    async (batchId: number): Promise<void> => {
      await loadBatches(batchId)
    },
    [loadBatches]
  )

  /** PD51：读当前论文/附件 + 文库标题，推导导入归属（只读，不发业务请求） */
  const resolveImportTarget = useCallback((): StagingImportTargetResult => {
    let activeItemId: number | null = null
    let attachmentId: number | null = null
    try {
      const parsed = Number(window.localStorage.getItem('paperdesk.docs.active'))
      activeItemId = Number.isInteger(parsed) && parsed > 0 ? parsed : null
      if (activeItemId != null) {
        attachmentId =
          parseDocState(window.localStorage.getItem(docStateKey(activeItemId))).attachmentId ?? null
      }
    } catch {
      activeItemId = null
      attachmentId = null
    }
    return resolveStagingImportTarget({ activeItemId, attachmentId, items: importItems })
  }, [importItems])

  // PD41/PD51：文库列表只用于把当前 itemId 映射成论文标题；取不到只影响导入区
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await window.api.library.list()
        if (!alive) return
        setImportItems(list.map((item) => ({ id: item.id, title: item.title ?? item.key })))
      } catch {
        if (alive) setImportItems([])
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 当前论文 / 附件变化（或文库加载完）后重新推导一次归属
  useEffect(() => {
    setImportTarget(resolveImportTarget())
  }, [resolveImportTarget])

  /**
   * PD41/PD51：把我的笔记 / 译文送进知识库。
   * 目标由「当前打开的论文」自动推导（itemId + attachmentId），只调用导入通道
   * （主进程生成 pending_review 提案）；绝不自动接受或发布。
   */
  const runImport = useCallback(
    async (source: 'note' | 'translation'): Promise<void> => {
      const resolved = resolveImportTarget()
      setImportTarget(resolved)
      if (!resolved.ok) {
        setImportError(resolved.reason)
        return
      }
      setImporting(source)
      setImportError(null)
      setImportResult(null)
      try {
        const input = {
          itemId: resolved.target.itemId,
          attachmentId: resolved.target.attachmentId,
          source
        }
        const result =
          source === 'note'
            ? await window.api.knowledge.noteImport(input)
            : await window.api.knowledge.translationImport(input)
        if (!aliveRef.current) return
        setImportResult(describeImportResult(result, resolved.target.title))
        await loadBatches(result.batchId)
      } catch (err) {
        if (aliveRef.current) setImportError(ipcErrorMessage(err) || '导入知识库失败')
      } finally {
        if (aliveRef.current) setImporting(null)
      }
    },
    [loadBatches, resolveImportTarget]
  )

  const loadDetail = useCallback(async (proposalId: number): Promise<void> => {
    try {
      const detail = await window.api.knowledge.getProposal(proposalId)
      if (!aliveRef.current) return
      if (detail) setDetails((prev) => ({ ...prev, [proposalId]: detail }))
    } catch (err) {
      if (aliveRef.current) setError(ipcErrorMessage(err) || '读取提案详情失败')
    }
  }, [])

  const toggleExpand = (proposalId: number): void => {
    setExpandedId((prev) => (prev === proposalId ? null : proposalId))
    if (!details[proposalId]) void loadDetail(proposalId)
  }

  const toggleSelect = (proposalId: number): void => {
    setSelected((prev) =>
      prev.includes(proposalId) ? prev.filter((id) => id !== proposalId) : [...prev, proposalId]
    )
  }

  const toggleSelectAll = (): void => {
    const reviewable = proposals.filter((proposal) => isProposalReviewable(proposal.status))
    setSelected((prev) =>
      prev.length === reviewable.length ? [] : reviewable.map((proposal) => proposal.id)
    )
  }

  // PD51：审核后就地更新该行（已接受灰化 / 已拒绝），不重拉整批、不触发整表 loading；
  // 批次计数用 refreshAfterChange 刷新（只重取批次列表，不碰提案列表与滚动位置）。
  const afterReview = async (proposalId: number, status: 'approved' | 'rejected'): Promise<void> => {
    setProposals((prev) => applyProposalStatus(prev, proposalId, status))
    await loadDetail(proposalId)
    if (activeBatchId != null) await refreshAfterChange(activeBatchId)
  }

  const accept = async (proposal: KnowledgeProposalSummary): Promise<void> => {
    setBusy(`accept-${proposal.id}`)
    setError(null)
    setNotice(null)
    try {
      await window.api.knowledge.acceptProposal(proposal.id)
      if (!aliveRef.current) return
      // 先就地变更，界面立刻从「待审」移到「已接受」，不等广播回包
      setProposals((prev) => applyProposalStatus(prev, proposal.id, 'approved'))
      setNotice({ ok: true, tone: 'ok', message: `已接受「${proposal.title}」，发布前仍不会进入正式条目` })
      await afterReview(proposal.id, 'approved')
    } catch (err) {
      if (aliveRef.current) setError(ipcErrorMessage(err) || '接受提案失败')
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }

  const submitReject = async (): Promise<void> => {
    if (!rejecting) return
    const reason = rejecting.reason.trim()
    if (!reason) {
      setError('拒绝必须填写理由，便于审计')
      return
    }
    setBusy(`reject-${rejecting.id}`)
    setError(null)
    setNotice(null)
    try {
      await window.api.knowledge.rejectProposal(rejecting.id, reason)
      if (!aliveRef.current) return
      setNotice({ ok: true, tone: 'ok', message: '已拒绝该提案（不会写入正式条目）' })
      setRejecting(null)
      await afterReview(rejecting.id, 'rejected')
    } catch (err) {
      if (aliveRef.current) setError(ipcErrorMessage(err) || '拒绝提案失败')
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }

  const submitEdit = async (): Promise<void> => {
    if (!editing) return
    const detail = details[editing.id]
    if (!detail) return
    const built = buildEditAcceptPatch(detail.content, {
      title: editing.title,
      body: editing.body,
      reason: editing.reason
    })
    if (!built.ok || !built.patch) {
      setEditErrors(built.errors)
      return
    }
    setEditErrors([])
    setBusy(`edit-${editing.id}`)
    setError(null)
    setNotice(null)
    try {
      await window.api.knowledge.editAndAccept(editing.id, built.patch)
      if (!aliveRef.current) return
      setNotice({ ok: true, tone: 'ok', message: '已保存修改并接受，发布前仍不会进入正式条目' })
      setEditing(null)
      await afterReview(editing.id, 'approved')
    } catch (err) {
      if (aliveRef.current) setError(ipcErrorMessage(err) || '编辑后接受失败')
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }

  const runPublish = async (): Promise<void> => {
    if (activeBatchId == null) return
    const ids = plan.publishableIds
    if (ids.length === 0) return
    setBusy('publish')
    setError(null)
    setNotice(null)
    setConflicts([])
    try {
      const result = await window.api.knowledge.publishBatch(activeBatchId, ids)
      if (!aliveRef.current) return
      setNotice(describePublishResult(result))
      setConfirming(false)
      if (result.ok) {
        const publishedIds = result.publishedProposalIds
        setProposals((prev) => selectStagingProposals(applyPublishedProposals(prev, publishedIds)))
        setSelected((prev) => prev.filter((id) => !publishedIds.includes(id)))
      } else {
        setConflicts(describePublishConflicts(result.conflicts))
        await loadProposals(activeBatchId, paperFilter ?? undefined)
      }
      await refreshAfterChange(activeBatchId)
    } catch (err) {
      if (aliveRef.current) {
        setError(ipcErrorMessage(err) || '发布失败')
        setConfirming(false)
      }
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }

  /**
   * PD51：一键批准 = 逐条接受（仅待审且来源已核验）→ 一次性发布 → 内联统计。
   * 渲染层编排（不新增 IPC）：acceptProposal 只改状态，publishBatch 仍是单个事务，
   * 发布冲突会整批不写入，失败原因进明细。必须由用户点确认后执行。
   */
  const runApproveAll = async (): Promise<void> => {
    if (activeBatchId == null || busy != null) return
    const batchId = activeBatchId
    const current = approveAllPlan
    if (current.pending === 0) return
    const snapshot = proposals
    bulkApproveRef.current = true
    setBusy('approve-all')
    setApproveAllOpen(false)
    setApproveAllOutcome(null)
    setError(null)
    setNotice(null)
    setConflicts([])
    const failures: Array<{ id: number; reason: string }> = []
    try {
      for (const id of current.acceptIds) {
        try {
          await window.api.knowledge.acceptProposal(id)
        } catch (err) {
          failures.push({ id, reason: ipcErrorMessage(err) || '接受提案失败' })
        }
      }
      const failedIds = new Set(failures.map((failure) => failure.id))
      const publishIds = current.publishableIds.filter((id) => !failedIds.has(id))
      let publishedIds: number[] = []
      if (publishIds.length > 0) {
        const result = await window.api.knowledge.publishBatch(batchId, publishIds)
        if (!aliveRef.current) return
        if (result.ok) {
          publishedIds = result.publishedProposalIds
          setNotice(describePublishResult(result))
        } else {
          const conflictsView = describePublishConflicts(result.conflicts)
          setConflicts(conflictsView)
          for (const conflict of conflictsView) {
            failures.push({ id: conflict.proposalId, reason: conflict.message })
          }
        }
      }
      const outcome = buildApproveAllOutcome(snapshot, current, {
        publishedIds,
        failureReasons: failures
      })
      setApproveAllOutcome(outcome)
      setProposals((prev) => selectStagingProposals(applyPublishedProposals(prev, publishedIds)))
      const publishedSet = new Set(publishedIds)
      setSelected((prev) => prev.filter((id) => !publishedSet.has(id)))
      await refreshAfterChange(batchId)
      // 后台对账：保持滚动位置，只同步状态（未核验的提案仍留在待审队列）
      await loadProposals(batchId, paperFilter ?? undefined, { silent: true })
      await loadPapers(batchId)
    } catch (err) {
      if (aliveRef.current) setError(ipcErrorMessage(err) || '全部批准失败')
    } finally {
      bulkApproveRef.current = false
      if (aliveRef.current) setBusy(null)
    }
  }

  const showConversation = async (
    conversationId: number,
    messageId: number | null,
    quote: string
  ): Promise<void> => {
    setError(null)
    try {
      const result = await window.api.ai.getConversation(conversationId)
      if (!aliveRef.current) return
      if (!result) {
        setConversationView({
          id: conversationId,
          messageId,
          quote,
          role: '',
          content: '',
          createdAt: '',
          missing: true
        })
        return
      }
      const messages = result.messages
      const target =
        (messageId != null ? messages.find((message) => message.id === messageId) : undefined) ??
        messages.find((message) => message.content.includes((quote || '').trim())) ??
        messages.find((message) => message.role === 'assistant') ??
        messages[0]
      setConversationView(
        target
          ? {
              id: conversationId,
              messageId: target.id,
              quote,
              role: target.role,
              content: target.content,
              createdAt: target.createdAt,
              missing: false
            }
          : {
              id: conversationId,
              messageId,
              quote,
              role: '',
              content: '',
              createdAt: '',
              missing: true
            }
      )
    } catch (err) {
      if (aliveRef.current) setError(ipcErrorMessage(err) || '读取对话失败')
    }
  }

  const jumpEvidence = (evidence: KnowledgeEvidenceInput): void => {
    const target = evidenceTarget(evidence)
    if (target.conversationId != null) {
      void showConversation(target.conversationId, target.messageId, evidence.quote)
      return
    }
    if (onOpenEvidence && (target.itemId != null || target.attachmentId != null)) {
      onOpenEvidence({
        itemId: target.itemId,
        attachmentId: target.attachmentId,
        page: target.page,
        rect: target.rect
      })
      onClose()
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (confirming) {
      setConfirming(false)
      return
    }
    if (approveAllOpen) {
      setApproveAllOpen(false)
      return
    }
    if (editing) {
      setEditing(null)
      setEditErrors([])
      return
    }
    if (rejecting) {
      setRejecting(null)
      return
    }
    if (conversationView) {
      setConversationView(null)
      return
    }
    onClose()
  }

  const renderDetail = (proposal: KnowledgeProposalSummary): React.JSX.Element => {
    const detail = details[proposal.id]
    if (!detail) {
      return (
        <div className="stage-detail" data-testid={`staging-detail-${proposal.id}`}>
          <span className="stage-detail__loading">正在读取提案详情…</span>
        </div>
      )
    }
    return (
      <div className="stage-detail" data-testid={`staging-detail-${proposal.id}`}>
        <div className="stage-detail__grid">
          <section className="stage-detail__pane" data-testid="staging-before">
            <h5>目标条目当前内容</h5>
            {detail.before ? (
              <>
                <div className="stage-detail__meta">
                  v{detail.before.version} · {KIND_LABEL[detail.before.kind] ?? detail.before.kind}
                </div>
                <div className="stage-detail__title">{detail.before.title}</div>
                <pre className="stage-detail__body">{detail.before.body}</pre>
              </>
            ) : (
              <div className="stage-detail__empty">新增条目：暂无当前内容（发布后才会写入正式条目）</div>
            )}
          </section>

          <section className="stage-detail__pane" data-testid="staging-suggested">
            <h5>建议内容</h5>
            <div className="stage-detail__meta">
              {KIND_LABEL[detail.content.kind] ?? detail.content.kind} ·{' '}
              {NATURE_LABEL[detail.contentNature] ?? detail.contentNature}
            </div>
            <div className="stage-detail__title">{detail.content.title}</div>
            <pre className="stage-detail__body">{detail.content.body}</pre>
          </section>
        </div>

        <section className="stage-detail__section">
          <h5>差异（左：当前 · 右：建议）</h5>
          <ProposalDiff
            rows={detail.diff ?? []}
            stats={detail.diffStats}
            emptyText={detail.before ? '内容没有变化' : '新增提案没有基线差异，发布后直接写入正式条目'}
          />
        </section>

        <section className="stage-detail__section">
          <h5>理由</h5>
          <p className="stage-detail__reason">{detail.reason || '未填写理由'}</p>
        </section>

        {detail.problems.length > 0 && (
          <section className="stage-detail__section" data-testid="staging-problems">
            <h5>程序检查</h5>
            <ul className="stage-detail__problems">
              {detail.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="stage-detail__section">
          <h5>来源证据（{detail.evidence.length}）</h5>
          {detail.evidence.length === 0 ? (
            <div className="stage-detail__empty">没有来源证据：发布会被拒绝，需补齐可定位的原文</div>
          ) : (
            <ul className="stage-evidence">
              {detail.evidence.map((evidence, index) => {
                const target = evidenceTarget(evidence)
                const canJump =
                  target.conversationId != null ||
                  (onOpenEvidence != null && (target.itemId != null || target.attachmentId != null))
                return (
                  <li className="stage-evidence__item" key={`${proposal.id}-ev-${index}`}>
                    <div className="stage-evidence__head">
                      <span className={`stage-chip stage-chip--${evidence.quote ? 'ok' : 'warn'}`}>
                        {SOURCE_LABEL[evidence.sourceType] ?? evidence.sourceType}
                      </span>
                      {evidencePrecisionLabel(evidence) && (
                        <span
                          className={`stage-chip stage-chip--${evidencePrecisionTone(evidence)}`}
                          data-testid={`staging-evidence-precision-${proposal.id}-${index}`}
                          title="证据定位精度：模块级需同时有模块 id 与字符区间，否则只能定位到页"
                        >
                          {evidencePrecisionLabel(evidence)}
                        </span>
                      )}
                      <span className="stage-evidence__loc">{evidenceLocation(evidence)}</span>
                      {evidence.sectionPath && (
                        <span className="stage-evidence__loc">{evidence.sectionPath}</span>
                      )}
                      <button
                        className="ghost stage-evidence__jump"
                        data-testid={`staging-evidence-jump-${proposal.id}-${index}`}
                        disabled={!canJump}
                        title={canJump ? '打开来源定位' : '该来源没有可跳转的定位'}
                        onClick={() => jumpEvidence(evidence)}
                      >
                        <Icon name="external" size={13} />
                        {target.conversationId != null ? '查看对话' : '跳原文'}
                      </button>
                    </div>
                    <blockquote className="stage-evidence__quote">{evidence.quote || '（引文为空）'}</blockquote>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {conversationView && (
          <section className="stage-convo" data-testid="staging-conversation">
            <div className="stage-convo__head">
              <span>
                对话 #{conversationView.id}
                {conversationView.messageId != null ? ` · 消息 #${conversationView.messageId}` : ''}
              </span>
              <button className="ghost" onClick={() => setConversationView(null)}>
                收起
              </button>
            </div>
            {conversationView.missing ? (
              <div className="stage-detail__empty">对话或消息已不存在，无法高亮（未编造内容）</div>
            ) : (
              <div className="stage-convo__message">
                <div className="stage-convo__meta">
                  {conversationView.role === 'user' ? '用户' : 'AI'} · {formatTime(conversationView.createdAt)}
                </div>
                <div className="stage-convo__text">
                  {highlightQuote(conversationView.content, conversationView.quote)}
                </div>
              </div>
            )}
          </section>
        )}

        <section className="stage-detail__section">
          <h5>审核记录</h5>
          {detail.reviews.length === 0 ? (
            <div className="stage-detail__empty">尚无审核记录</div>
          ) : (
            <ul className="stage-reviews">
              {detail.reviews.map((review) => (
                <li key={review.id}>
                  <span className="stage-reviews__action">{REVIEW_LABEL[review.action] ?? review.action}</span>
                  <span className="stage-reviews__reason">{review.reason || '（无理由）'}</span>
                  <span className="stage-reviews__time">{formatTime(review.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    )
  }

  return (
    <div
      className="stage"
      data-testid="staging-panel"
      role="dialog"
      aria-label="暂存区"
      tabIndex={-1}
      ref={panelRef}
      onKeyDown={onKeyDown}
    >
      <div className="stage__backdrop" onClick={onClose} />
      <div className="stage__dialog">
        <header className="stage__header">
          <div className="stage__heading">
            <Icon name="layers" size={16} />
            <span className="stage__title">暂存区</span>
            <span className="stage__subtitle">AI 只提案，发布由你确认</span>
          </div>
          <button
            className="ghost"
            data-testid="staging-refresh"
            title="刷新批次与提案"
            onClick={() => void loadBatches(activeBatchId ?? undefined)}
          >
            <Icon name="refresh" size={14} />
            刷新
          </button>
          <button className="icon ghost" data-testid="staging-close" title="关闭" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>

        {error && (
          <div className="state state--inline state--error" role="alert" data-testid="staging-error">
            <span className="state__title">操作失败</span>
            <span className="state__detail">{error}</span>
          </div>
        )}
        {notice && (
          <div
            className={`state state--inline state--${notice.tone}`}
            role="status"
            data-testid="staging-notice"
          >
            <span className="state__detail">{notice.message}</span>
          </div>
        )}
        {conflicts.length > 0 && (
          <div className="stage-conflicts" data-testid="staging-conflicts">
            <div className="stage-conflicts__head">以下提案未通过发布检查（整批未写入）：</div>
            <ul>
              {conflicts.map((conflict) => (
                <li
                  key={`${conflict.proposalId}-${conflict.kind}`}
                  data-testid={
                    conflict.kind === 'version_conflict'
                      ? 'staging-conflict-version'
                      : 'staging-conflict'
                  }
                >
                  <span className="stage-conflicts__key">{conflict.key}</span>
                  <span className="stage-conflicts__reason">{conflict.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="stage__body">
          <aside className="stage__batches" data-testid="staging-batches">
            <div className="stage__batches-head">提案批次</div>
            {batches.length === 0 ? (
              <div className="state state--inline state--filtered">
                <span className="state__detail">暂无提案批次</span>
              </div>
            ) : (
              <ul className="stage-batch-list">
                {batches.map((batch) => (
                  <li key={batch.id}>
                    <button
                      className={`stage-batch ${batch.id === activeBatchId ? 'is-active' : ''}`}
                      data-testid={`staging-batch-${batch.id}`}
                      onClick={() => selectBatch(batch.id)}
                    >
                      <span className="stage-batch__title" title={batch.title}>
                        {batch.title}
                      </span>
                      <span
                        className={`stage-batch__source ${
                          batch.task === DIGEST_BATCH_TASK || batch.task === BATCH_DIGEST_BATCH_TASK
                            ? 'is-digest'
                            : ''
                        }`}
                        data-testid={`staging-batch-source-${batch.id}`}
                        title={batchSourceLabel(batch.task)}
                      >
                        {batchSourceLabel(batch.task)}
                        {batch.task === BATCH_DIGEST_BATCH_TASK && (
                          <span data-testid={`staging-batch-papers-${batch.id}`}>
                            （{batch.counts.papers ?? 0} 篇）
                          </span>
                        )}{' '}
                        · 共 {batch.counts.total} 条
                      </span>
                      <span className="stage-batch__meta">
                        {BATCH_STATUS_LABEL[batch.status] ?? batch.status} · 待审 {batch.counts.pending} ·
                        已接受 {batch.counts.approved} · 已发布 {batch.counts.published}
                      </span>
                      <span className="stage-batch__time" title={formatTime(batch.updatedAt)}>
                        {formatTime(batch.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="stage__main" data-testid="staging-proposals">
            <div className="stage__toolbar" data-testid="staging-toolbar">
              <div className="stage__batch-title">
                <span className="stage__batch-name" title={activeBatch?.title}>
                  {activeBatch ? activeBatch.title : '未选择批次'}
                </span>
                {activeBatch && (
                  <span className="stage__batch-counts">
                    共 {activeBatch.counts.total} 条 · 待审 {activeBatch.counts.pending} · 已接受{' '}
                    {activeBatch.counts.approved} · 已拒绝 {activeBatch.counts.rejected}
                  </span>
                )}
              </div>
              <label className="stage__selectall">
                <input
                  type="checkbox"
                  data-testid="staging-select-all"
                  checked={
                    proposals.length > 0 &&
                    selected.length ===
                      proposals.filter((proposal) => isProposalReviewable(proposal.status)).length
                  }
                  onChange={toggleSelectAll}
                />
                全选
              </label>
              <button
                className="btn btn--primary"
                data-testid="staging-publish"
                disabled={plan.publishable === 0 || busy != null}
                title={
                  plan.publishable === 0
                    ? '没有可发布的提案：需先接受，且来源证据已核验'
                    : `发布选中的 ${plan.publishable} 条提案`
                }
                onClick={() => setConfirming(true)}
              >
                发布所选（{plan.publishable}）
              </button>
              <button
                className="btn"
                data-testid="staging-approve-all"
                disabled={approveAllDisabled != null || busy != null}
                title={
                  approveAllDisabled ??
                  `一次接受并发布 ${approveAllPlan.publishableIds.length} 条待审提案`
                }
                onClick={() => {
                  setApproveAllOutcome(null)
                  setApproveAllOpen(true)
                }}
              >
                全部批准（{approveAllPlan.pending}）
              </button>
            </div>

            {approveAllOutcome && (
              <div
                className="stage-approve-result"
                role="status"
                data-testid="staging-approve-all-result"
                title={describeApproveAllResult(approveAllOutcome)}
              >
                <span className="stage-approve-result__count">
                  {describeApproveAllResult(approveAllOutcome)}
                </span>
                {approveAllOutcome.details.length > 0 && (
                  <details data-testid="staging-approve-all-detail">
                    <summary>查看明细（{approveAllOutcome.details.length}）</summary>
                    <ul>
                      {approveAllOutcome.details.map((detail) => (
                        <li
                          key={detail.id}
                          data-testid={`staging-approve-all-detail-${detail.id}`}
                          title={detail.reason}
                        >
                          <span className="stage-approve-result__title">{detail.title}</span>
                          <span className={`stage-approve-result__badge is-${detail.outcome}`}>
                            {APPROVE_ALL_OUTCOME_LABEL[detail.outcome]}
                          </span>
                          <span className="stage-approve-result__reason">{detail.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            {/* PD43：批处理批次按论文筛选。筛选条件交给主进程写进 SQL，不在前端过滤结果集 */}
            {activeBatch && activeBatch.task === BATCH_DIGEST_BATCH_TASK && (
              <div className="stage__papers" data-testid="staging-papers">
                <span className="stage-paper-count" data-testid="staging-batch-papers">
                  来自批处理（{activeBatch.counts.papers ?? papers.length} 篇）
                </span>
                <label className="stage__paper-filter">
                  按论文筛选
                  <select
                    data-testid="staging-paper-filter"
                    value={paperFilter == null ? '' : String(paperFilter)}
                    onChange={(e) =>
                      setPaperFilter(e.target.value === '' ? null : Number(e.target.value))
                    }
                  >
                    <option value="">全部论文（{papers.length} 篇）</option>
                    {papers.map((paper) => (
                      <option key={paper.itemId} value={paper.itemId}>
                        {`${paper.title ?? `论文 #${paper.itemId}`}（${paper.total} 条）`}
                      </option>
                    ))}
                  </select>
                </label>
                {paperFilter != null && (
                  <button
                    className="ghost"
                    data-testid="staging-paper-filter-clear"
                    onClick={() => setPaperFilter(null)}
                  >
                    清除筛选
                  </button>
                )}
              </div>
            )}

            {/* PD43：论文级展开。每篇一个 details，摘要行给出该篇提案数与待审数 */}
            {activeBatch &&
              activeBatch.task === BATCH_DIGEST_BATCH_TASK &&
              paperFilter == null &&
              !loading &&
              papers.length > 0 && (
                <div className="stage__papers-list" data-testid="staging-papers-list">
                  <div className="stage__papers-hint">
                    这一批来自 {papers.length} 篇论文。展开可看每篇的提案；「只看这篇」会把筛选交给后端 SQL。
                  </div>
                  {papers.map((paper) => {
                    const own = proposals.filter((proposal) => proposal.itemId === paper.itemId)
                    return (
                      <details
                        className="stage-paper"
                        key={paper.itemId}
                        data-testid={`staging-paper-${paper.itemId}`}
                      >
                        <summary className="stage-paper__summary">
                          <span className="stage-paper__title">
                            {paper.title ?? `论文 #${paper.itemId}`}
                          </span>
                          <span className="stage-paper__meta">
                            {paper.total} 条 · 待审 {paper.pending}
                          </span>
                        </summary>
                        <div className="stage-paper__body">
                          <button
                            className="ghost"
                            data-testid={`staging-paper-only-${paper.itemId}`}
                            onClick={() => setPaperFilter(paper.itemId)}
                          >
                            只看这篇（{paper.total} 条）
                          </button>
                          {own.length === 0 ? (
                            <span className="meta__muted">
                              这一篇的提案不在当前列表里（可能已被发布或拒绝）
                            </span>
                          ) : (
                            <ul className="stage-paper__items">
                              {own.map((proposal) => (
                                <li key={proposal.id}>
                                  <button
                                    className="link"
                                    data-testid={`staging-paper-open-${proposal.id}`}
                                    onClick={() => setExpandedId(proposal.id)}
                                  >
                                    {proposal.title}
                                  </button>
                                  <span className="meta__muted">
                                    {' '}
                                    · {proposalStatusLabel(proposal.status)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </details>
                    )
                  })}
                </div>
              )}

            {loading ? (
              <div className="state state--loading" role="status" data-testid="staging-loading">
                <span className="spinner" aria-hidden="true" />
                <div className="state__detail">正在读取待审提案…</div>
              </div>
            ) : emptyState ? (
              <div className="state state--empty" data-testid="staging-empty">
                <div className="state__title">{emptyState.title}</div>
                <p className="state__detail">{emptyState.detail}</p>
              </div>
            ) : (
              <div className="stage__groups">
                {groups.map((group) => (
                  <div className="stage-group" key={group.id} data-testid={`staging-group-${group.id}`}>
                    <div className="stage-group__head">
                      <span className="stage-group__label">{group.label}</span>
                      <span className="stage-group__count" data-testid={`staging-group-count-${group.id}`}>
                        {group.count}
                      </span>
                      <span className="stage-group__reviewable">可审核 {group.reviewable}</span>
                    </div>
                    {group.proposals.length === 0 ? (
                      <div className="state state--inline state--filtered">
                        <span className="state__detail">没有{group.label}</span>
                        <div className="state__actions">
                          <button
                            className="btn btn--ghost btn--sm"
                            data-testid={`staging-group-refresh-${group.id}`}
                            onClick={() => void loadBatches(activeBatchId ?? undefined)}
                          >
                            刷新
                          </button>
                        </div>
                      </div>
                    ) : (
                      <ul className="stage-items">
                        {group.proposals.map((proposal) => {
                          const tone = proposalStatusTone(proposal.status)
                          const expanded = expandedId === proposal.id
                          const checked = selected.includes(proposal.id)
                          return (
                            <li
                              className={`stage-item ${checked ? 'is-selected' : ''} ${
                                proposal.status === 'approved' ? 'is-approved' : ''
                              } ${proposalNeedsAttention(proposal.op) ? 'is-attention' : ''}`}
                              key={proposal.id}
                              data-testid={`staging-proposal-${proposal.id}`}
                            >
                              <div className="stage-item__row">
                                <input
                                  type="checkbox"
                                  data-testid={`staging-select-${proposal.id}`}
                                  checked={checked}
                                  onChange={() => toggleSelect(proposal.id)}
                                />
                                <button
                                  className="stage-item__main"
                                  data-testid={`staging-expand-${proposal.id}`}
                                  aria-expanded={expanded}
                                  onClick={() => toggleExpand(proposal.id)}
                                >
                                  <span className="stage-item__title" title={proposal.title}>
                                    {proposal.title}
                                  </span>
                                  <span className="stage-item__chips">
                                    <span className={`stage-chip stage-chip--${tone}`}>
                                      {proposalStatusLabel(proposal.status)}
                                    </span>
                                    <span className="stage-chip stage-chip--muted">
                                      {KIND_LABEL[proposal.kind] ?? proposal.kind}
                                    </span>
                                    {/* PD41：来源类型 + 内容性质，回答「这句话是作者原文/译文/我的笔记/AI 建议」 */}
                                    <span
                                      className="stage-chip stage-chip--muted"
                                      data-testid={`staging-proposal-source-${proposal.id}`}
                                      title="来源类型 · 内容性质"
                                    >
                                      {SOURCE_LABEL[proposal.sourceType] ?? proposal.sourceType}
                                      {NATURE_LABEL[proposal.contentNature]
                                        ? ` · ${NATURE_LABEL[proposal.contentNature]}`
                                        : ''}
                                    </span>
                                    {proposal.verification === 'pending' && (
                                      <span className="stage-chip stage-chip--warn">来源待核验</span>
                                    )}
                                    {proposalNeedsAttention(proposal.op) && (
                                      <span className="stage-chip stage-chip--danger">覆盖现有条目</span>
                                    )}
                                  </span>
                                  <span className="stage-item__reason">{proposal.reason || '未填写理由'}</span>
                                </button>
                                <div className="stage-item__actions">
                                  <button
                                    className="ghost"
                                    data-testid={`staging-accept-${proposal.id}`}
                                    disabled={
                                      (proposal.status !== 'pending_review' &&
                                        proposal.status !== 'needs_edit') ||
                                      busy != null
                                    }
                                    title={
                                      proposal.status === 'approved'
                                        ? '已接受，等待发布'
                                        : undefined
                                    }
                                    onClick={() => void accept(proposal)}
                                  >
                                    {proposal.status === 'approved' ? '已接受' : '接受'}
                                  </button>
                                  <button
                                    className="ghost"
                                    data-testid={`staging-reject-${proposal.id}`}
                                    disabled={!isProposalReviewable(proposal.status) || busy != null}
                                    onClick={() => {
                                      setRejecting({ id: proposal.id, reason: '' })
                                      setEditing(null)
                                      setEditErrors([])
                                    }}
                                  >
                                    拒绝
                                  </button>
                                  <button
                                    className="ghost"
                                    data-testid={`staging-edit-${proposal.id}`}
                                    disabled={!isProposalReviewable(proposal.status) || busy != null}
                                    onClick={() => {
                                      const detail = details[proposal.id]
                                      setEditing({
                                        id: proposal.id,
                                        title: detail?.content.title ?? proposal.title,
                                        body: detail?.content.body ?? '',
                                        reason: ''
                                      })
                                      setEditErrors([])
                                      setRejecting(null)
                                      if (!detail) void loadDetail(proposal.id)
                                    }}
                                  >
                                    编辑后接受
                                  </button>
                                </div>
                              </div>

                              {rejecting?.id === proposal.id && (
                                <div className="stage-inline" data-testid={`staging-reject-form-${proposal.id}`}>
                                  <label className="stage-inline__label">
                                    拒绝理由（必填）
                                    <textarea
                                      data-testid={`staging-reject-reason-${proposal.id}`}
                                      value={rejecting.reason}
                                      onChange={(event) =>
                                        setRejecting({ id: proposal.id, reason: event.target.value })
                                      }
                                      placeholder="例如：来源未定位到原文，退回补充"
                                      rows={2}
                                    />
                                  </label>
                                  <div className="stage-inline__actions">
                                    <button
                                      className="primary"
                                      data-testid={`staging-reject-submit-${proposal.id}`}
                                      disabled={busy != null}
                                      onClick={() => void submitReject()}
                                    >
                                      提交拒绝
                                    </button>
                                    <button className="ghost" onClick={() => setRejecting(null)}>
                                      取消
                                    </button>
                                  </div>
                                </div>
                              )}

                              {editing?.id === proposal.id && (
                                <div className="stage-inline" data-testid={`staging-edit-form-${proposal.id}`}>
                                  <label className="stage-inline__label">
                                    标题
                                    <input
                                      data-testid={`staging-edit-title-${proposal.id}`}
                                      value={editing.title}
                                      onChange={(event) =>
                                        setEditing({ ...editing, title: event.target.value })
                                      }
                                    />
                                  </label>
                                  <label className="stage-inline__label">
                                    正文
                                    <textarea
                                      data-testid={`staging-edit-body-${proposal.id}`}
                                      value={editing.body}
                                      rows={5}
                                      onChange={(event) =>
                                        setEditing({ ...editing, body: event.target.value })
                                      }
                                    />
                                  </label>
                                  <label className="stage-inline__label">
                                    修改理由（可选）
                                    <input
                                      data-testid={`staging-edit-reason-${proposal.id}`}
                                      value={editing.reason}
                                      onChange={(event) =>
                                        setEditing({ ...editing, reason: event.target.value })
                                      }
                                      placeholder="例如：按原文改写措辞"
                                    />
                                  </label>
                                  {editErrors.length > 0 && (
                                    <div className="stage-inline__errors" data-testid="staging-edit-errors">
                                      {editErrors.join('；')}
                                    </div>
                                  )}
                                  <div className="stage-inline__actions">
                                    <button
                                      className="primary"
                                      data-testid={`staging-edit-submit-${proposal.id}`}
                                      disabled={busy != null}
                                      onClick={() => void submitEdit()}
                                    >
                                      保存并接受
                                    </button>
                                    <button
                                      className="ghost"
                                      onClick={() => {
                                        setEditing(null)
                                        setEditErrors([])
                                      }}
                                    >
                                      取消
                                    </button>
                                  </div>
                                </div>
                              )}

                              {expanded && renderDetail(proposal)}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* PD51：导入目标跟随当前打开的论文，用户不再选择条目；只生成待审提案 */}
        <div className="stage-import" data-testid="staging-import">
          <div className="stage-inline" data-testid="staging-import-form">
            <span
              className={`stage-inline__target ${importTarget && !importTarget.ok ? 'is-warn' : ''}`}
              data-testid="staging-import-target"
              title={importTarget && !importTarget.ok ? importTarget.reason : undefined}
            >
              {importTarget == null
                ? '正在确认当前论文…'
                : importTarget.ok
                  ? `导入到「${importTarget.target.title}」${importTarget.target.attachmentId != null ? ` · 当前附件 #${importTarget.target.attachmentId}` : ''}`
                  : importTarget.reason}
            </span>
            <div className="stage-inline__actions">
              <button
                className="ghost"
                data-testid="staging-import-note"
                disabled={importing != null || !importTarget?.ok}
                title={!importTarget?.ok ? '当前没有可归属的论文' : '把这篇论文的笔记导入知识库'}
                onClick={() => void runImport('note')}
              >
                {importing === 'note' ? '导入中…' : '导入笔记'}
              </button>
              <button
                className="ghost"
                data-testid="staging-import-translation"
                disabled={importing != null || !importTarget?.ok}
                title={!importTarget?.ok ? '当前没有可归属的论文' : '把这篇论文的译文导入知识库'}
                onClick={() => void runImport('translation')}
              >
                {importing === 'translation' ? '导入中…' : '导入译文'}
              </button>
            </div>
          </div>
          {importError && (
            <div
              className="state state--inline state--error"
              role="alert"
              data-testid="staging-import-error"
            >
              <span className="state__title">导入失败</span>
              <span className="state__detail">{importError}</span>
            </div>
          )}
          {importResult && (
            <div
              className="state state--inline state--ok"
              role="status"
              data-testid="staging-import-result"
              title={importResult}
            >
              <span className="state__detail">{importResult}</span>
            </div>
          )}
        </div>

        <footer className="stage__footer">
          <span className="stage__footer-hint">
            未审核的提案不会出现在正式检索与知识地图中；发布在单个事务内完成，冲突时整批不写入。
          </span>
          <span className="stage__footer-count" data-testid="staging-selection-count">
            已选 {plan.selected} · 可发布 {plan.publishable} · 阻塞 {plan.blocked}
            {plan.risky > 0 ? ` · 覆盖类 ${plan.risky}` : ''}
          </span>
        </footer>

        {confirming && (
          <div className="stage-confirm" data-testid="staging-publish-confirm" role="dialog" aria-label="确认发布">
            <div className="stage-confirm__box">
              <h4>确认发布</h4>
              <p data-testid="staging-publish-count">
                将写入 {plan.publishable} 条正式条目（来自 {plan.publishable} 条已接受提案）。
              </p>
              {plan.blocked > 0 && (
                <p className="stage-confirm__warn">
                  已选提案中 {plan.blocked} 条未通过检查（未接受或来源待核验），本次不会写入。
                </p>
              )}
              {plan.risky > 0 && (
                <p className="stage-confirm__risk">
                  其中 {plan.risky} 条为修改类提案，会覆盖现有条目；版本不一致时发布会被拒绝。
                </p>
              )}
              <div className="stage-confirm__actions">
                <button
                  className="btn btn--ghost"
                  data-testid="staging-publish-cancel"
                  onClick={() => setConfirming(false)}
                >
                  取消
                </button>
                <button
                  className="btn btn--danger btn--danger--solid"
                  data-testid="staging-publish-confirm-ok"
                  disabled={busy != null}
                  onClick={() => void runPublish()}
                >
                  确认发布
                </button>
              </div>
            </div>
          </div>
        )}
        {approveAllOpen && (
          <div
            className="stage-confirm"
            data-testid="staging-approve-all-confirm"
            role="dialog"
            aria-label="确认全部批准"
          >
            <div className="stage-confirm__box">
              <h4>确认全部批准</h4>
              <p data-testid="staging-approve-all-count">{describeApproveAllConfirm(approveAllPlan)}</p>
              {approveAllPlan.blocked.length > 0 && (
                <p className="stage-confirm__warn">
                  其中 {approveAllPlan.blocked.length} 条来源待核验，会记为失败并保持待审。
                </p>
              )}
              {approveAllPlan.skippedIds.length > 0 && (
                <p className="stage-confirm__risk">
                  另有 {approveAllPlan.skippedIds.length} 条已发布 / 已拒绝 / 已撤回，本次跳过。
                </p>
              )}
              <div className="stage-confirm__actions">
                <button
                  className="btn btn--ghost"
                  data-testid="staging-approve-all-cancel"
                  onClick={() => setApproveAllOpen(false)}
                >
                  取消
                </button>
                <button
                  className="btn btn--danger btn--danger--solid"
                  data-testid="staging-approve-all-confirm-ok"
                  disabled={busy != null}
                  onClick={() => void runApproveAll()}
                >
                  确认全部批准
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
