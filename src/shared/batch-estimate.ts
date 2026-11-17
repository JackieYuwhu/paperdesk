/**
 * 批处理「预计模型调用」估算（纯函数，便于单测与 UI 复用）。
 *
 * 只做数量级提示（用于低峰调度/成本感知），不追求精确：
 *  - 拆解按篇幅档位估算每篇调用次数（长文会「分段分析 → 合并」，调用数上升）；
 *  - 翻译/导出等按每篇 1 次估算（分段译文会更多）；
 *  - 纯本地任务（如 embed 本地向量）为 0。
 */
export interface BatchEstimate {
  /** 目标篇/项数 */
  count: number
  /** 预计模型调用次数（粗略） */
  calls: number
  /** 说明（含「粗略」字样，避免被当作承诺） */
  note: string
}

/** 每篇/项的模型调用次数（按任务与参数） */
export function callsPerUnit(task: string, params?: Record<string, string | undefined>): number {
  switch (task) {
    case 'analyze-paper': {
      const depth = params?.depth ?? 'standard'
      // 速览多为一次性；标准/深入更可能触发分段合并
      return depth === 'brief' ? 1 : depth === 'deep' ? 3 : 2
    }
    case 'translate':
    case 'translate-archive':
    case 'translate-snapshot':
      return 1
    case 'compare':
      return 1 // 每篇精简卡；汇总另算 1 次
    case 'decompose':
    case 'find-related':
      return 1
    case 'export-doc':
    case 'embed':
      return 0
    default:
      return 1
  }
}

export function estimateBatch(
  task: string,
  params: Record<string, string | undefined> | undefined,
  count: number
): BatchEstimate {
  const n = Math.max(0, count)
  let calls = n * callsPerUnit(task, params)
  if (task === 'compare' && n > 0) calls += 1 // 汇总成对比表
  const note =
    task === 'analyze-paper'
      ? `粗略：按篇幅档位估算（长文分段合并会更多）；共 ${n} 篇`
      : task === 'embed'
        ? `本地向量，无需模型调用；共 ${n} 项`
        : `粗略：按每项约 ${callsPerUnit(task, params)} 次估算；共 ${n} 项`
  return { count: n, calls, note }
}
