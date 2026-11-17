interface JobRecord {
  cancelled: boolean
  base?: string
  jobId?: string
  /** 已请求取消/断连超过窗口，但后台是否终止尚未确认 */
  unconfirmedAt?: number
  /** 恢复连接后用于登记已完成任务（捕获附件/产物路径与 DB 上下文） */
  finalize?: (result: any) => Promise<unknown>
}

export interface UnconfirmedJob {
  id: string
  base: string
  jobId: string
  markedAt: number
  /** 用户已请求取消：恢复后即使 done 也不再登记，只释放身份 */
  cancelled: boolean
  finalize?: (result: any) => Promise<unknown>
}

/** One handle per invocation, including cancellation before the sidecar returns its id. */
export class TranslationJobs {
  private jobs = new Map<string, JobRecord>()
  private now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  begin(id: string): void {
    if (this.jobs.has(id)) throw new Error('重复的翻译请求 ID')
    this.jobs.set(id, { cancelled: false })
  }

  async attach(id: string, base: string, jobId: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job) throw new Error('翻译请求已结束')
    Object.assign(job, { base, jobId })
    if (job.cancelled) await this.cancel(id)
  }

  isCancelled(id: string): boolean {
    return this.jobs.get(id)?.cancelled ?? false
  }

  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job) return
    job.cancelled = true
    if (job.base && job.jobId) {
      await fetch(`${job.base}/translate/cancel/${job.jobId}`, {
        method: 'POST', signal: AbortSignal.timeout(5000)
      }).catch(() => undefined)
    }
  }

  /**
   * 断连/取消请求后仍无法确认终态：保留身份与产物路径，
   * 恢复连接后由 reconcileTranslationJobs 收敛（done → 登记；error/cancelled → 释放）。
   */
  markUnconfirmed(
    id: string,
    meta?: { finalize?: (result: any) => Promise<unknown> }
  ): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.unconfirmedAt = this.now()
    if (meta?.finalize) job.finalize = meta.finalize
  }

  unconfirmedAt(id: string): number | null {
    return this.jobs.get(id)?.unconfirmedAt ?? null
  }

  /** 尚未确认终态的任务（只返回已拿到 base/jobId 的） */
  pending(): UnconfirmedJob[] {
    const out: UnconfirmedJob[] = []
    for (const [id, job] of this.jobs) {
      if (job.unconfirmedAt == null || !job.base || !job.jobId) continue
      out.push({
        id,
        base: job.base,
        jobId: job.jobId,
        markedAt: job.unconfirmedAt,
        cancelled: job.cancelled,
        finalize: job.finalize
      })
    }
    return out
  }

  /** 已确认终态（done/error/404）后释放身份 */
  confirm(id: string): void {
    this.jobs.delete(id)
  }

  finish(id: string): void {
    // 终止未确认的任务不能删：否则无法恢复登记，也无法再取消
    if (this.jobs.get(id)?.unconfirmedAt != null) return
    this.jobs.delete(id)
  }

  /** 过期清理：避免内存里永久残留不可恢复的记录 */
  releaseExpired(maxAgeMs = 30 * 60_000): string[] {
    const now = this.now()
    const expired: string[] = []
    for (const [id, job] of this.jobs) {
      if (job.unconfirmedAt != null && now - job.unconfirmedAt >= maxAgeMs) {
        expired.push(id)
        this.jobs.delete(id)
      }
    }
    return expired
  }
}

/** 连接恢复窗口耗尽 / 取消后仍不可达：后台是否终止尚未确认 */
export class TranslationTerminationUnconfirmed extends Error {}

export class TranslationServiceExited extends Error {}

/** Retry transport errors without treating a busy process as dead or deleting its output. */
export async function pollTranslationStatus(
  url: string,
  deps: {
    isRunning: () => boolean
    isCancelled: () => boolean
    cancel: () => Promise<void>
    reconnecting: () => void
    fetcher?: typeof fetch
    now?: () => number
    pause?: (ms: number) => Promise<void>
  }
): Promise<Response> {
  const fetcher = deps.fetcher ?? fetch
  const now = deps.now ?? Date.now
  const pause = deps.pause ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const started = now()
  let failures = 0
  for (;;) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) }).catch(() => null)
    if (response && response.status < 500) return response
    if (!deps.isRunning()) throw new TranslationServiceExited('本地翻译服务已退出，本次任务中断。')
    if (deps.isCancelled()) {
      throw new TranslationTerminationUnconfirmed(
        '已请求取消；服务暂不可达，尚未确认后台终止。'
      )
    }
    if (now() - started >= 300_000) {
      await deps.cancel()
      throw new TranslationTerminationUnconfirmed(
        '五分钟内未能恢复连接，已请求取消；尚未确认后台终止，产物已保留。'
      )
    }
    deps.reconnecting()
    failures++
    await pause(Math.min(5000, 500 * 2 ** Math.min(failures, 4)))
  }
}
