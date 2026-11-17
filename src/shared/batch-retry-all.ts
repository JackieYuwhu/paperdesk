// 「一键重跑全部失败项」（跨作业）纯计划选择器：主进程与单元测试共用。
// 保持零运行时依赖，仅类型导入。
import type { BatchJob, BatchItemRow } from './types'

export interface RetryAllPlan {
  task: string
  /** PD43：同一批处理（batch_run_id）内的失败项合成一个计划，重试作业沿用该批次 */
  batchRunId: string
  params: Record<string, string>
  targets: Array<{ itemId: number | null; attachmentId: number | null }>
}

const TERMINAL: ReadonlyArray<BatchJob['status']> = ['done', 'failed', 'cancelled']

/** job.params 以 JSON 字符串落库；兼容已是对象的情况，解析失败一律回退 {} */
function parseParams(raw: unknown): Record<string, string> {
  if (raw == null) return {}
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw) as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
    } catch {
      return {}
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, string>
  return {}
}

/**
 * 跨作业汇总「可重跑失败项」计划（纯函数）。
 * - 只考虑终态作业（done/failed/cancelled）
 * - 收集每个 job 中 status='failed' 且 item_id / attachment_id 至少一个非空的明细
 * - 按 job.task + job.batch_run_id 分组；一次批处理内同一任务合成一个计划
 * - 同一组使用其首个作业的 params
 * - 组内跨作业对 (itemId, attachmentId) 去重
 * - 无可重跑项时返回 []
 */
export function selectRetryAllPlan(
  jobs: Array<Pick<BatchJob, 'id' | 'status' | 'task' | 'params'> & { batch_run_id?: string }>,
  itemsByJob: Array<{ jobId: number; items: BatchItemRow[] }>
): RetryAllPlan[] {
  const itemsFor = new Map<number, BatchItemRow[]>()
  for (const g of itemsByJob) itemsFor.set(g.jobId, g.items ?? [])

  const order: string[] = []
  const byTask = new Map<
    string,
    {
      task: string
      batchRunId: string
      params: Record<string, string>
      targets: Array<{ itemId: number | null; attachmentId: number | null }>
      seen: Set<string>
    }
  >()

  for (const job of jobs) {
    if (!TERMINAL.includes(job.status)) continue
    const failed = (itemsFor.get(job.id) ?? []).filter(
      (it) => it.status === 'failed' && (it.item_id != null || it.attachment_id != null)
    )
    if (failed.length === 0) continue

    const batchRunId = job.batch_run_id ?? ''
    const groupKey = `${job.task}\u0000${batchRunId}`
    let group = byTask.get(groupKey)
    if (!group) {
      group = {
        task: job.task,
        batchRunId,
        params: parseParams(job.params),
        targets: [],
        seen: new Set<string>()
      }
      byTask.set(groupKey, group)
      order.push(groupKey)
    }
    for (const it of failed) {
      const key = `${it.item_id ?? ''}:${it.attachment_id ?? ''}`
      if (group.seen.has(key)) continue
      group.seen.add(key)
      group.targets.push({ itemId: it.item_id, attachmentId: it.attachment_id })
    }
  }

  const plans: RetryAllPlan[] = []
  for (const groupKey of order) {
    const g = byTask.get(groupKey)
    if (g && g.targets.length > 0) {
      plans.push({
        task: g.task,
        batchRunId: g.batchRunId,
        params: g.params,
        targets: g.targets
      })
    }
  }
  return plans
}
