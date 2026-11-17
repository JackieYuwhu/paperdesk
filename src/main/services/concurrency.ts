/**
 * 并发工具（纯逻辑，无外部依赖）——供长文分段、多篇卡片与单元测试共用。
 *
 * 关键约定：
 *  - **保序**：结果数组与输入顺序一一对应（而非完成顺序）；
 *  - **限流**：任意时刻在跑的任务数 ≤ limit；
 *  - **失败隔离**：单项失败可走 fallback（不影响其它项）；不给 fallback 时抛出第一个错误；
 *  - **取消**：可选 AbortSignal——已取消后不再领取新任务，未执行项按 fallback 占位
 *    （没有 fallback 则抛取消错误）。
 *
 * 注意：这里只负责「调度」，失败重试与占位文案由调用方（`runWithRetryMap`）决定。
 */

/** 把任意输入规整为 [min, max] 内的整数；非法/缺省用 def */
export function clampInt(value: unknown, def: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function abortError(reason: unknown): Error {
  const e = reason instanceof Error ? reason : new Error('已取消')
  if (e.name !== 'AbortError') e.name = 'AbortError'
  return e
}

export interface MapWithConcurrencyOptions<T, R> {
  /** 可选取消信号：已取消则不再领取新任务（在跑的任务会跑完） */
  signal?: AbortSignal
  /** 单项失败时的回退值（给则失败隔离，不给则整体抛出） */
  fallback?: (item: T, index: number, error: unknown) => R
}

/**
 * 并发 map：保序 + 限流 + 可选失败隔离/取消。
 *
 * @param items  输入项（只读，不改动）
 * @param limit  并发上限（非法值按 1 处理，且不超过 items.length）
 * @param fn     单项处理（可异步）
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => R | Promise<R>,
  opts: MapWithConcurrencyOptions<T, R> = {}
): Promise<R[]> {
  const n = items.length
  if (n === 0) return []

  const workers = Math.min(clampInt(limit, 1, 1, n), n)
  const out: R[] = new Array(n)
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) return
      const index = next
      next += 1
      if (index >= n) return
      try {
        out[index] = await fn(items[index], index)
      } catch (error) {
        if (opts.fallback) out[index] = opts.fallback(items[index], index, error)
        else throw error
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()))

  // 只有「还没领取到任务」的剩余项才算被取消；已跑完的不受影响
  if (opts.signal?.aborted && next < n) {
    if (!opts.fallback) throw abortError(opts.signal.reason)
    const reason = abortError(opts.signal.reason)
    for (let i = next; i < n; i++) out[i] = opts.fallback(items[i], i, reason)
  }
  return out
}

export interface RetryMapOptions<T, R> {
  items: readonly T[]
  /** 并发上限 */
  limit: number
  /** 每项最多尝试几次（默认 2 = 失败后重试 1 次） */
  attempts?: number
  /** 一次尝试（= 一次真实的模型/网络调用） */
  run: (item: T, index: number) => Promise<R>
  /** 每次尝试开始前回调（用于统计调用次数与进度） */
  onAttempt?: (item: T, index: number, attempt: number) => void
  /** 重试用尽后的占位结果（不中断其它项） */
  fallback: (item: T, index: number, error: unknown) => R
  signal?: AbortSignal
}

export interface RetryMapResult<R> {
  /** 与输入同序的结果（失败项为 fallback 占位） */
  results: R[]
  /** 实际发起的调用次数（含失败与重试），与 AnalysisResult.calls 对齐 */
  calls: number
  /** 重试用尽后走占位的项数 */
  failures: number
}

/**
 * 带「重试 + 占位」的并发 map（长文分段用）。
 * 失败重试 attempts-1 次；仍失败则写占位，绝不中断整篇。
 */
export async function runWithRetryMap<T, R>(
  opts: RetryMapOptions<T, R>
): Promise<RetryMapResult<R>> {
  const attempts = clampInt(opts.attempts ?? 2, 2, 1, 5)
  let calls = 0
  let failures = 0

  const results = await mapWithConcurrency(
    opts.items,
    opts.limit,
    async (item, index) => {
      let lastError: unknown = null
      for (let attempt = 1; attempt <= attempts; attempt++) {
        calls += 1
        opts.onAttempt?.(item, index, attempt)
        try {
          return await opts.run(item, index)
        } catch (error) {
          lastError = error
        }
      }
      failures += 1
      return opts.fallback(item, index, lastError)
    },
    {
      signal: opts.signal,
      fallback: (item, index, error) => {
        failures += 1
        return opts.fallback(item, index, error)
      }
    }
  )

  return { results, calls, failures }
}
