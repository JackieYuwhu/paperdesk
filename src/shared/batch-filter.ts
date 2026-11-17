// 批处理作业列表筛选（纯函数）：按状态分组 + 标题关键词过滤，保持输入顺序。
import type { BatchJob } from './types'

export type JobStatusFilter = 'all' | 'active' | 'done' | 'failed'

/** `active` 覆盖的作业状态：排队 / 等待低峰 / 执行中 */
const ACTIVE_STATUSES = new Set(['queued', 'scheduled', 'running'])

/** 合法的状态筛选值（用于持久化时校验）。 */
const JOB_STATUS_FILTERS: readonly JobStatusFilter[] = ['all', 'active', 'done', 'failed']

/** 作业筛选持久化所用的 localStorage 键。 */
export const BATCH_JOB_FILTER_KEY = 'paperdesk.batch.jobFilter'

/**
 * 解析持久化的作业筛选。非法输入（null / 空串 / JSON 解析失败 / 非对象）回退默认值；
 * 未知状态一律回退为 `all`；关键词强制转字符串并 trim。
 */
export function parseBatchJobFilter(raw: string | null): {
  status: JobStatusFilter
  keyword: string
} {
  const fallback = { status: 'all' as const, keyword: '' }
  if (raw == null || raw === '') return fallback
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback
  const { status, keyword } = parsed as { status?: unknown; keyword?: unknown }
  return {
    status: JOB_STATUS_FILTERS.includes(status as JobStatusFilter)
      ? (status as JobStatusFilter)
      : 'all',
    keyword: String(keyword ?? '').trim()
  }
}

/** 序列化作业筛选，用于写入 localStorage。 */
export function serializeBatchJobFilter(status: JobStatusFilter, keyword: string): string {
  return JSON.stringify({ status, keyword })
}

/**
 * 过滤批处理作业。
 * - `all` 返回全部（含 cancelled）；`active` 仅 queued/scheduled/running；
 *   `done` / `failed` 精确匹配同名状态。
 * - `keyword` 经 trim + 小写后做子串匹配（对 `job.title` 不区分大小写）；
 *   空关键词不过滤。
 * - 两项条件为「与」关系，结果保持输入顺序。
 */
export function filterJobs(jobs: BatchJob[], status: JobStatusFilter, keyword: string): BatchJob[] {
  const kw = keyword.trim().toLowerCase()
  return jobs.filter((j) => {
    const statusOk =
      status === 'all' ||
      (status === 'active' ? ACTIVE_STATUSES.has(j.status) : j.status === status)
    if (!statusOk) return false
    if (!kw) return true
    return j.title.toLowerCase().includes(kw)
  })
}
