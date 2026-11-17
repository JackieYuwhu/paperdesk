import { BrowserWindow, ipcMain } from 'electron'
import { CH, EVT } from '../../shared/channels'
import { buildBatchKnowledgePlan, buildDigestKnowledgePlan, BATCH_SYNC_BATCH_TASK } from '../../shared/api'
import { diffStats, lineDiff } from '../../shared/diff'
import type {
  BatchSyncInput,
  BatchSyncItemResult,
  BatchSyncResult,
  BatchSyncTarget,
  CreateKnowledgeBatchInput,
  CreateKnowledgeProposalInput,
  DigestSyncInput,
  KnowledgeBatchOrigin,
  KnowledgeBatchScopeType,
  KnowledgeContent,
  KnowledgeEvidenceInput,
  KnowledgeImportInput,
  KnowledgeImportResult,
  KnowledgeImportSourceType,
  KnowledgeKind,
  KnowledgeNature,
  KnowledgeProposalFilter,
  KnowledgeProposalOp,
  KnowledgeProposalStatus,
  KnowledgePublishResult,
  KnowledgeSourceType
} from '../../shared/types'
import { getDataDir, getDb } from '../db'
import {
  acceptProposal,
  buildImportKnowledgePlan,
  collectBatchDigestPapers,
  collectItemImportSources,
  createBatch,
  createProposal,
  editAndAccept,
  getBatch,
  getEntry,
  getProposalDetail,
  knowledgeValidation,
  listBatchPapers,
  listBatches,
  listEntries,
  listProposals,
  proposalContentText,
  publishBatch,
  rejectProposal,
  runInTransaction,
  syncBatchProposalsByPaper,
  syncDigestProposals,
  syncImportProposals
} from '../services/knowledge'
import { syncDigestToItemMindMap } from '../services/mindmap'

/**
 * 知识库 IPC（PD33 阶段 1a）。
 *
 * 分层约定：
 *   - 这里只做「不可信输入」的浅校验（正整数 id、固定枚举、长度上限、结构存在），
 *     深校验与业务规则在 services/knowledge.ts（AI 适配层也走同一层，因此两条路都不会漏）；
 *   - 发布通道 `knowledge:publishBatch` 只有渲染层（用户点击）能调用；AI 工具适配层
 *     不 import 本文件，也不存在任何 IPC 通道映射（见 services/knowledge-ai.ts）；
 *   - 本层不记录任何入参内容到日志，避免 API Key 等敏感信息落盘。
 */

const {
  positiveInt,
  optionalPositiveInt,
  requireText,
  optionalText,
  pickEnum,
  enums
} = knowledgeValidation

function asRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`无效的${label}`)
  return raw as Record<string, unknown>
}

function asObjectArray(raw: unknown, label: string): Record<string, unknown>[] {
  if (raw === null || raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`无效的${label}：必须是数组`)
  if (raw.length > 50) throw new Error(`无效的${label}：最多 50 条`)
  return raw.map((item, index) => asRecord(item, `第 ${index + 1} 条${label}`))
}

/** 批处理同步入参：兼容 PD43 的裸 jobId；勾选论文 id 去重后交给 SQL */
function validateBatchSyncInput(raw: unknown): BatchSyncInput {
  if (typeof raw === 'number') {
    return { jobId: positiveInt(raw, '批处理作业 id'), target: 'knowledge', itemIds: [] }
  }
  const obj = asRecord(raw, '批处理同步入参')
  const jobId = positiveInt(obj.jobId, '批处理作业 id')
  const target = pickEnum(
    obj.target ?? 'knowledge',
    ['knowledge', 'mindmap'],
    '同步目标'
  ) as BatchSyncTarget
  if (obj.itemIds === undefined || obj.itemIds === null) return { jobId, target }
  if (!Array.isArray(obj.itemIds)) throw new Error('无效的勾选论文：必须是数组')
  if (obj.itemIds.length > 1000) throw new Error('无效的勾选论文：一次最多 1000 篇')
  const itemIds = [...new Set(obj.itemIds.map((id) => positiveInt(id, '文献 id')))]
  return { jobId, target, itemIds }
}

function validateContent(raw: unknown): KnowledgeContent {
  const obj = asRecord(raw, '提案内容')
  if (typeof obj.body !== 'string') throw new Error('无效的提案正文')
  if (obj.body.length > 200_000) throw new Error('提案正文超过 200000 字符')
  return {
    kind: pickEnum(obj.kind, enums.kinds, '知识类型') as KnowledgeKind,
    title: requireText(obj.title, '标题', 300),
    body: obj.body
  }
}

function validateEvidence(raw: unknown): KnowledgeEvidenceInput[] {
  return asObjectArray(raw, '来源证据').map((obj) => ({
    sourceType: pickEnum(obj.sourceType, enums.sourceTypes, '来源类型') as KnowledgeSourceType,
    sourceRef: obj.sourceRef as KnowledgeEvidenceInput['sourceRef'],
    itemId: optionalPositiveInt(obj.itemId, '文献 id'),
    attachmentId: optionalPositiveInt(obj.attachmentId, '附件 id'),
    pageIndex: obj.pageIndex as number | null | undefined,
    pageEnd: obj.pageEnd as number | null | undefined,
    moduleId: optionalText(obj.moduleId, '模块 id', 200),
    rect: optionalText(obj.rect, '坐标', 200),
    charStart: obj.charStart as number | null | undefined,
    charEnd: obj.charEnd as number | null | undefined,
    quote: typeof obj.quote === 'string' ? obj.quote : '',
    sectionPath: optionalText(obj.sectionPath, '章节路径', 500),
    precision: obj.precision as KnowledgeEvidenceInput['precision']
  }))
}

function validateBatchInput(raw: unknown): CreateKnowledgeBatchInput {
  const obj = asRecord(raw, '批次入参')
  return {
    title: requireText(obj.title, '批次标题', 200),
    task: requireText(obj.task, '批次任务', 120),
    scopeType:
      obj.scopeType === undefined || obj.scopeType === null
        ? 'library'
        : (pickEnum(obj.scopeType, enums.scopeTypes, '批次范围类型') as KnowledgeBatchScopeType),
    scopeRef: optionalText(obj.scopeRef, '批次范围', 500),
    origin:
      obj.origin === undefined || obj.origin === null
        ? 'user'
        : (pickEnum(obj.origin, enums.origins, '批次来源') as KnowledgeBatchOrigin),
    aiConfigRef: optionalText(obj.aiConfigRef, 'AI 配置引用', 200),
    workflowVersion: optionalText(obj.workflowVersion, '工作流版本', 100),
    skillVersion: optionalText(obj.skillVersion, '技能版本', 100),
    idempotencyKey: optionalText(obj.idempotencyKey, '幂等键', 200)
  }
}

function validateProposalInput(raw: unknown): CreateKnowledgeProposalInput {
  const obj = asRecord(raw, '提案入参')
  const op = pickEnum(obj.op, ['create', 'update'] as const, '提案操作') as KnowledgeProposalOp
  const input: CreateKnowledgeProposalInput = {
    op,
    itemId: optionalPositiveInt(obj.itemId, '文献 id'),
    targetEntryId: optionalPositiveInt(obj.targetEntryId, '目标条目 id'),
    targetKey: optionalText(obj.targetKey, '目标条目 key', 120),
    baseVersion: optionalPositiveInt(obj.baseVersion, '基线版本'),
    content: validateContent(obj.content),
    contentNature: pickEnum(obj.contentNature, enums.natures, '内容性质') as KnowledgeNature,
    sourceType: pickEnum(obj.sourceType, enums.sourceTypes, '来源类型') as KnowledgeSourceType,
    sourceRef: obj.sourceRef as KnowledgeEvidenceInput['sourceRef'],
    evidence: validateEvidence(obj.evidence),
    reason: optionalText(obj.reason, '提案理由', 2000) ?? ''
  }
  if (op === 'update') {
    if (input.targetEntryId === null && !input.targetKey) {
      throw new Error('修改提案必须指定目标条目（id 或 key）')
    }
    if (input.baseVersion === null) throw new Error('修改提案必须带基线版本')
  } else if (input.targetEntryId !== null) {
    throw new Error('新增提案不能指定目标条目 id')
  }
  return input
}

function validateProposalFilter(raw: unknown): KnowledgeProposalFilter {
  if (raw === null || raw === undefined) return {}
  const obj = asRecord(raw, '待审过滤条件')
  const statusRaw = obj.status
  let status: KnowledgeProposalStatus | KnowledgeProposalStatus[] | undefined
  if (statusRaw === undefined || statusRaw === null) {
    status = undefined
  } else if (Array.isArray(statusRaw)) {
    if (statusRaw.length === 0) throw new Error('无效的提案状态过滤')
    status = statusRaw.map(
      (s) => pickEnum(s, enums.proposalStatuses, '提案状态') as KnowledgeProposalStatus
    )
  } else {
    status = pickEnum(statusRaw, enums.proposalStatuses, '提案状态') as KnowledgeProposalStatus
  }
  const limit = obj.limit === undefined || obj.limit === null ? 200 : positiveInt(obj.limit, '数量上限')
  return {
    batchId: optionalPositiveInt(obj.batchId, '批次 id'),
    itemId: optionalPositiveInt(obj.itemId, '文献 id'),
    status,
    op:
      obj.op === undefined || obj.op === null
        ? undefined
        : (pickEnum(obj.op, ['create', 'update'] as const, '提案操作') as KnowledgeProposalOp),
    limit
  }
}

function validateEntryFilter(raw: unknown): {
  itemId?: number | null
  kind?: KnowledgeKind
  state?: 'active' | 'archived'
} {
  if (raw === null || raw === undefined) return {}
  const obj = asRecord(raw, '条目过滤条件')
  return {
    itemId: optionalPositiveInt(obj.itemId, '文献 id'),
    kind:
      obj.kind === undefined || obj.kind === null
        ? undefined
        : (pickEnum(obj.kind, enums.kinds, '知识类型') as KnowledgeKind),
    state:
      obj.state === undefined || obj.state === null
        ? undefined
        : (pickEnum(obj.state, enums.entryStates, '条目状态') as 'active' | 'archived')
  }
}

function validateProposalIds(raw: unknown): number[] | null {
  if (raw === null || raw === undefined) return null
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('无效的提案 id 列表')
  if (raw.length > 200) throw new Error('一次最多发布 200 条提案')
  return raw.map((item) => positiveInt(item, '提案 id'))
}

/** 拆解同步入参：只接收文献 id 与拆解正文，其余（要点/指纹/批次）由共享纯函数推导 */
function validateDigestSyncInput(raw: unknown): DigestSyncInput {
  const obj = asRecord(raw, '拆解同步入参')
  const itemId = positiveInt(obj.itemId, '文献 id')
  if (typeof obj.markdown !== 'string' || !obj.markdown.trim()) {
    throw new Error('拆解内容为空，无法同步到知识库')
  }
  if (obj.markdown.length > 400_000) throw new Error('拆解内容超过 400000 字符')
  return {
    itemId,
    markdown: obj.markdown,
    title: optionalText(obj.title, '批次标题', 300)
  }
}

/** 笔记 / 译文导入入参（PD41）：只接收文献 id 与来源种类，切段与指纹由服务层推导 */
function validateImportInput(raw: unknown, source: KnowledgeImportSourceType): KnowledgeImportInput {
  const obj = asRecord(raw, source === 'note' ? '笔记导入入参' : '译文导入入参')
  const itemId = positiveInt(obj.itemId, '文献 id')
  if (obj.source !== undefined && obj.source !== null) {
    const declared = pickEnum(
      obj.source,
      ['note', 'translation'] as const,
      '导入来源'
    ) as KnowledgeImportSourceType
    // 通道名与入参声明必须一致，避免「点笔记按钮却导入译文」这种错位
    if (declared !== source) throw new Error('导入来源与所选入口不一致')
  }
  return { itemId, source }
}

function emitKnowledgeChanged(payload: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(EVT.knowledgeChanged, payload)
  }
}

/**
 * 笔记 / 译文导入的共用流程（PD41）：SQL 侧限定条目读原文 → 生成确定性计划 →
 * 单事务写「1 个批次 + N 条待审提案」。
 * 只创建 pending_review 提案，绝不发布、绝不写 knowledge_entries；
 * 这两个通道没有对应的 AI 工具，只有界面按钮能触发。
 */
function runKnowledgeImport(raw: unknown, source: KnowledgeImportSourceType): KnowledgeImportResult {
  const input = validateImportInput(raw, source)
  const db = getDb()
  const collected = collectItemImportSources(db, getDataDir(), input.itemId, source)
  if (collected.sources.length === 0) {
    throw new Error(
      source === 'note'
        ? '该条目暂无笔记，无法导入知识库'
        : '该条目暂无已翻译段落，无法导入知识库'
    )
  }
  const plan = buildImportKnowledgePlan({
    itemId: input.itemId,
    source,
    sources: collected.sources
  })
  const result = runInTransaction(db, () => syncImportProposals(db, plan))
  if (result.createdProposals > 0) {
    emitKnowledgeChanged({
      batchId: result.batchId,
      source,
      createdProposals: result.createdProposals
    })
  }
  return result
}

export function registerKnowledgeHandlers(): void {
  ipcMain.handle(CH.knowledge.batchCreate, (_event, raw: unknown) =>
    createBatch(getDb(), validateBatchInput(raw))
  )

  ipcMain.handle(CH.knowledge.batchList, (_event, rawLimit: unknown) =>
    listBatches(getDb(), rawLimit === null || rawLimit === undefined ? 50 : positiveInt(rawLimit, '数量上限'))
  )

  ipcMain.handle(CH.knowledge.batchGet, (_event, rawId: unknown) =>
    getBatch(getDb(), positiveInt(rawId, '批次 id'))
  )

  ipcMain.handle(CH.knowledge.proposalCreate, (_event, rawBatchId: unknown, raw: unknown) => {
    const batchId = positiveInt(rawBatchId, '批次 id')
    return createProposal(getDb(), batchId, validateProposalInput(raw))
  })

  ipcMain.handle(CH.knowledge.proposalList, (_event, rawFilter: unknown) =>
    listProposals(getDb(), validateProposalFilter(rawFilter))
  )

  ipcMain.handle(CH.knowledge.proposalGet, (_event, rawId: unknown) => {
    const detail = getProposalDetail(getDb(), positiveInt(rawId, '提案 id'))
    if (!detail) return null
    // 差异行在这里生成：服务层不依赖 shared/diff（保持可被 node 单测直接导入）
    const beforeText = detail.before ? proposalContentText(detail.before) : ''
    const diff = lineDiff(
      beforeText ? beforeText.split('\n') : [],
      proposalContentText(detail.content).split('\n')
    )
    return { ...detail, diff, diffStats: diffStats(diff) }
  })

  ipcMain.handle(CH.knowledge.proposalAccept, (_event, rawId: unknown, rawReason: unknown) => {
    const proposalId = positiveInt(rawId, '提案 id')
    const summary = acceptProposal(getDb(), proposalId, {
      // 不合成空串：空/缺省理由原样透传为 undefined，由服务层写可识别的审计占位
      reason: optionalText(rawReason, '接受理由', 2000) ?? undefined
    })
    emitKnowledgeChanged({ proposalId, batchId: summary.batchId, status: summary.status })
    return summary
  })

  ipcMain.handle(CH.knowledge.proposalReject, (_event, rawId: unknown, rawReason: unknown) => {
    const proposalId = positiveInt(rawId, '提案 id')
    const summary = rejectProposal(getDb(), proposalId, {
      reason: requireText(rawReason, '拒绝理由', 2000)
    })
    emitKnowledgeChanged({ proposalId, batchId: summary.batchId, status: summary.status })
    return summary
  })

  ipcMain.handle(CH.knowledge.proposalEditAccept, (_event, rawId: unknown, rawPatch: unknown) => {
    const proposalId = positiveInt(rawId, '提案 id')
    const obj = asRecord(rawPatch ?? {}, '编辑内容')
    const patch = {
      content: obj.content === undefined || obj.content === null ? undefined : validateContent(obj.content),
      evidence:
        obj.evidence === undefined || obj.evidence === null
          ? undefined
          : validateEvidence(obj.evidence),
      // 同上：空/缺省编辑理由不合成空串，服务层落「编辑后接受（未填理由）」占位
      reason: optionalText(obj.reason, '编辑理由', 2000) ?? undefined
    }
    const summary = editAndAccept(getDb(), proposalId, patch)
    emitKnowledgeChanged({ proposalId, batchId: summary.batchId, status: summary.status })
    return summary
  })

  ipcMain.handle(CH.knowledge.digestSync, (_event, raw: unknown) => {
    const input = validateDigestSyncInput(raw)
    // 计划由 shared/api.ts 的纯函数生成（与单测同源），批次+提案整体一个事务
    const plan = buildDigestKnowledgePlan(input)
    const db = getDb()
    const result = runInTransaction(db, () => syncDigestProposals(db, plan))
    if (result.createdProposals > 0) {
      emitKnowledgeChanged({
        batchId: result.batchId,
        source: 'digest',
        createdProposals: result.createdProposals
      })
    }
    return result
  })

  ipcMain.handle(CH.knowledge.noteImport, (_event, raw: unknown) =>
    runKnowledgeImport(raw, 'note')
  )

  ipcMain.handle(CH.knowledge.translationImport, (_event, raw: unknown) =>
    runKnowledgeImport(raw, 'translation')
  )

  ipcMain.handle(CH.knowledge.batchPapers, (_event, rawBatchId: unknown) =>
    listBatchPapers(getDb(), positiveInt(rawBatchId, '批次 id'))
  )

  /**
   * 批处理产物同步（PD43/PD44）：入参兼容旧版 jobId，或
   * { jobId, target: 'knowledge' | 'mindmap', itemIds?: number[] }。
   * - 勾选项进 SQL（collectBatchDigestPapers 的 itemIds），不在结果集后置过滤；
   * - 知识库：一次批处理只写一个提案批次，只创建 pending_review，绝不发布；
   * - 思维地图：逐篇合并，digestPointId 幂等，保留用户改名节点；
   * - 两个目标都逐篇隔离，一篇失败不阻塞其余论文。
   */
  ipcMain.handle(CH.knowledge.batchSync, async (_event, raw: unknown): Promise<BatchSyncResult> => {
    const input = validateBatchSyncInput(raw)
    const db = getDb()
    const job = db
      .prepare('SELECT id, key, title, batch_run_id FROM batch_jobs WHERE id = ?')
      .get(input.jobId) as
      | { id: number; key: string; title: string; batch_run_id: string }
      | undefined
    if (!job) throw new Error(`批处理作业不存在：#${input.jobId}`)
    const runId = String(job.batch_run_id || job.key || '').trim()
    if (!runId) throw new Error('该批处理作业缺少批次标识，无法同步')

    const collected = collectBatchDigestPapers(db, runId, { itemIds: input.itemIds })
    const skippedItems: BatchSyncItemResult[] = collected.skipped.map((paper) => ({
      itemId: paper.itemId,
      batchItemId: paper.batchItemId,
      title: paper.title,
      status: 'skipped',
      reason: paper.reason,
      createdProposals: 0,
      added: 0,
      reused: 0
    }))

    if (input.target === 'mindmap') {
      const items: BatchSyncItemResult[] = [...skippedItems]
      let pointCount = 0
      for (const paper of collected.papers) {
        try {
          const result = await syncDigestToItemMindMap(
            paper.itemId,
            paper.title,
            paper.markdown,
            runId
          )
          pointCount += result.points
          const modeLabel = result.mode === 'ai' ? 'AI 骨架' : '规则骨架'
          const warningText = result.warnings.length > 0 ? `；提示：${result.warnings.join('；')}` : ''
          if (result.points === 0 && result.added === 0 && result.removed === 0) {
            items.push({
              itemId: paper.itemId,
              batchItemId: paper.batchItemId,
              title: paper.title,
              status: 'skipped',
              reason: result.warnings[0] ?? '这篇拆解没有可同步的要点',
              createdProposals: 0,
              added: 0,
              reused: 0,
              removed: 0,
              kept: 0,
              mode: result.mode,
              warnings: result.warnings
            })
            continue
          }
          if (result.added > 0 || result.removed > 0) {
            items.push({
              itemId: paper.itemId,
              batchItemId: paper.batchItemId,
              title: paper.title,
              status: 'success',
              reason: `${modeLabel}：新增 ${result.added} 个节点、覆盖 ${result.removed} 个旧节点${
                result.kept > 0 ? `，保留 ${result.kept} 个用户改过的节点` : ''
              }${warningText}`,
              createdProposals: 0,
              added: result.added,
              reused: result.kept,
              removed: result.removed,
              kept: result.kept,
              mode: result.mode,
              warnings: result.warnings
            })
          } else {
            items.push({
              itemId: paper.itemId,
              batchItemId: paper.batchItemId,
              title: paper.title,
              status: 'skipped',
              reason: `${modeLabel}：与上次同步内容一致，没有重复写入${
                result.kept > 0 ? `（保留 ${result.kept} 个用户改过的节点）` : ''
              }${warningText}`,
              createdProposals: 0,
              added: 0,
              reused: result.kept,
              removed: 0,
              kept: result.kept,
              mode: result.mode,
              warnings: result.warnings
            })
          }
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
      return {
        runId,
        batchId: 0,
        batchKey: '',
        target: 'mindmap',
        papers: collected.papers.length,
        pointCount,
        createdProposals: 0,
        reusedProposals: items.reduce((sum, item) => sum + item.reused, 0),
        skippedPapers: collected.skipped,
        success: items.filter((item) => item.status === 'success').length,
        skipped: items.filter((item) => item.status === 'skipped').length,
        failed: items.filter((item) => item.status === 'failed').length,
        items
      }
    }

    if (collected.papers.length === 0) {
      return {
        runId,
        batchId: 0,
        batchKey: '',
        target: 'knowledge',
        papers: 0,
        pointCount: 0,
        createdProposals: 0,
        reusedProposals: 0,
        skippedPapers: collected.skipped,
        success: 0,
        skipped: skippedItems.length,
        failed: 0,
        items: skippedItems
      }
    }

    let plan
    try {
      plan = buildBatchKnowledgePlan({
        runId,
        papers: collected.papers,
        skipped: collected.skipped,
        task: BATCH_SYNC_BATCH_TASK,
        sourceType: 'batch'
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error ?? '未知错误')
      // 全部论文都没有要点：按逐篇「跳过」返回，不编造失败，也不建空批次
      if (reason.startsWith('这一批没有可同步的拆解要点')) {
        const noPointItems: BatchSyncItemResult[] = collected.papers.map((paper) => ({
          itemId: paper.itemId,
          batchItemId: paper.batchItemId,
          title: paper.title,
          status: 'skipped',
          reason: '这篇拆解没有可同步的要点',
          createdProposals: 0,
          added: 0,
          reused: 0
        }))
        const items = [...skippedItems, ...noPointItems]
        return {
          runId,
          batchId: 0,
          batchKey: '',
          target: 'knowledge',
          papers: 0,
          pointCount: 0,
          createdProposals: 0,
          reusedProposals: 0,
          skippedPapers: collected.skipped,
          success: 0,
          skipped: items.length,
          failed: 0,
          items
        }
      }
      return {
        runId,
        batchId: 0,
        batchKey: '',
        target: 'knowledge',
        papers: 0,
        pointCount: 0,
        createdProposals: 0,
        reusedProposals: 0,
        skippedPapers: collected.skipped,
        success: 0,
        skipped: skippedItems.length,
        failed: 1,
        items: [
          ...skippedItems,
          {
            itemId: null,
            batchItemId: null,
            title: '整批',
            status: 'failed',
            reason,
            createdProposals: 0,
            added: 0,
            reused: 0
          }
        ]
      }
    }

    const result = syncBatchProposalsByPaper(db, plan)
    if (result.createdProposals > 0) {
      emitKnowledgeChanged({
        batchId: result.batchId,
        source: 'batch',
        createdProposals: result.createdProposals,
        papers: result.papers
      })
    }
    return result
  })

  ipcMain.handle(CH.knowledge.entryList, (_event, rawFilter: unknown) =>
    listEntries(getDb(), validateEntryFilter(rawFilter))
  )

  ipcMain.handle(CH.knowledge.entryGet, (_event, rawId: unknown) =>
    getEntry(getDb(), positiveInt(rawId, '条目 id'))
  )

  ipcMain.handle(
    CH.knowledge.publishBatch,
    (_event, raw: unknown): KnowledgePublishResult => {
      const obj = asRecord(raw, '发布入参')
      const batchId = positiveInt(obj.batchId, '批次 id')
      const proposalIds = validateProposalIds(obj.proposalIds)
      const result = publishBatch(getDb(), { batchId, proposalIds })
      if (result.ok && result.publishedProposalIds.length > 0) {
        emitKnowledgeChanged({
          batchId,
          status: result.batchStatus,
          publishedProposalIds: result.publishedProposalIds,
          entryIds: result.entryIds
        })
      }
      return result
    }
  )
}
