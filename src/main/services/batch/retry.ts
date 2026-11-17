import type { BatchJob, BatchItemRow } from '../../../shared/types'

/** 「只重试失败项」计划：从已结束作业中挑出可重放的失败目标 */
export interface RetryPlan {
  task: string
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
 * 依据源作业 + 明细计算重试计划（纯函数）。
 * 返回 null 表示：作业缺失 / 尚未结束 / 没有失败项。
 * 仅保留 item_id 或 attachment_id 至少有一个非空的失败项。
 */
export function retryTargets(
  job: BatchJob | undefined | null,
  items: BatchItemRow[]
): RetryPlan | null {
  if (!job) return null
  if (!TERMINAL.includes(job.status)) return null
  const failed = (items ?? []).filter((it) => it.status === 'failed')
  if (failed.length === 0) return null
  const targets = failed
    .filter((it) => it.item_id != null || it.attachment_id != null)
    .map((it) => ({ itemId: it.item_id, attachmentId: it.attachment_id }))
  return { task: job.task, params: parseParams(job.params), targets }
}
