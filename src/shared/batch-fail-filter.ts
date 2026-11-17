// 批处理失败原因筛选（纯函数）：汇总各作业失败原因供下拉选择，并按原因筛选作业。
// 注：此处只做类型导入（编译期擦除）；聚合逻辑内联实现，避免运行时相对导入
// （扩展名省略的 ESM 相对导入无法被 scripts/test-unit.ts 直接运行），
// 其分组/排序规则与 `batch-fail.ts` 的 `topFailReasons` 保持一致。
import type { BatchItemRow } from './types'

/** 失败项无可用错误信息时的占位文案（与 `batch-fail.ts` 一致）。 */
const NO_FAIL_MESSAGE = '（无信息）'

/**
 * 汇总所有作业失败项的「原因 → 次数」，供筛选下拉使用。
 * 拼接全部作业的失败明细后，按出现次数降序、次数相同按消息升序排序，
 * 仅返回前 `top` 条（等价于对所有失败项调用 `topFailReasons`）。
 */
export function collectFailReasonOptions(
  itemsByJob: Array<{ jobId: number; items: BatchItemRow[] }>,
  top = 5
): Array<{ message: string; count: number }> {
  const buckets = new Map<string, number>()
  for (const job of itemsByJob) {
    for (const it of job.items) {
      if (it.status !== 'failed') continue
      const message = String(it.message ?? '').trim() || NO_FAIL_MESSAGE
      buckets.set(message, (buckets.get(message) ?? 0) + 1)
    }
  }
  return [...buckets.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
    .slice(0, top)
}

/**
 * 按失败原因（多选）筛选作业 id。
 * - `reasons` 为空/全部为纯空白：返回全部作业 id（保持输入顺序）；
 * - 否则返回 `reasonByJob[id]` 与任一选中原因（trim 后精确匹配）相交的作业 id；
 * - `reasonByJob` 中缺失的作业直接跳过。
 */
export function selectJobIdsByFailureReasons(
  jobs: Array<{ id: number }>,
  reasonByJob: Record<number, string[]>,
  reasons: string[]
): number[] {
  const targets = new Set(reasons.map((r) => r.trim()).filter((r) => r.length > 0))
  if (targets.size === 0) return jobs.map((j) => j.id)
  return jobs
    .filter((j) => (reasonByJob[j.id] ?? []).some((m) => targets.has(m)))
    .map((j) => j.id)
}

/**
 * 按单个失败原因筛选作业 id（`selectJobIdsByFailureReasons` 的兼容薄封装）。
 */
export function selectJobIdsByFailureReason(
  jobs: Array<{ id: number }>,
  reasonByJob: Record<number, string[]>,
  reason: string
): number[] {
  return selectJobIdsByFailureReasons(jobs, reasonByJob, [reason])
}
