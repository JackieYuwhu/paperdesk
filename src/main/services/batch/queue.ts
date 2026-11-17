import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { getDataDir, getDb } from '../../db'
import { generateKey } from '../../db/keys'
import { EVT } from '../../../shared/channels'
import { effective } from '../settings'
import { getTask, taskInfos, type BatchTaskInfoLite } from './registry'
import { retryTargets } from './retry'
import { migrateAnalysisFilenames } from './filenames'
import { migrateBatchFolderNames, newBatchFolder } from './folder-name'
import { listLibraryGroups } from '../library-groups'
import { itemIdsForTag } from '../item-tags'
import { groupWithDescendants } from '../../../shared/library-groups'
import { estimateBatch, type BatchEstimate } from '../../../shared/batch-estimate'
import { selectRetryAllPlan } from '../../../shared/batch-retry-all'
import type { BatchContext, BatchInput, BatchItemResult } from './types'
import type {
  Attachment,
  BatchItemRow,
  BatchJob,
  BatchJobStatus,
  BatchProgress,
  BatchWindowStatus,
  CreateBatchInput,
  Item
} from '../../../shared/types'

const running = new Set<number>()
const cancelled = new Set<number>()
let timer: NodeJS.Timeout | null = null

function batchRoot(): string {
  const d = join(getDataDir(), 'batch')
  mkdirSync(d, { recursive: true })
  return d
}

function jobDir(key: string): string {
  const d = join(batchRoot(), key)
  mkdirSync(d, { recursive: true })
  return d
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

function toMin(hhmm: string, def: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '')
  if (!m) return def
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]))
}

/** 低峰时段状态（默认 00:30–08:30，可用设置/环境变量改） */
export function batchWindowStatus(now = new Date()): BatchWindowStatus {
  const start = effective('batch.offPeakStart', 'PAPERDESK_BATCH_PEAK_START', '00:30')
  const end = effective('batch.offPeakEnd', 'PAPERDESK_BATCH_PEAK_END', '08:30')
  const enabled = effective('batch.offPeakOnly', 'PAPERDESK_BATCH_OFFPEAK_ONLY', '0') === '1'
  const mins = now.getHours() * 60 + now.getMinutes()
  const s = toMin(start, 30)
  const e = toMin(end, 510)
  const inWindow = s <= e ? mins >= s && mins < e : mins >= s || mins < e
  return {
    inOffPeak: inWindow,
    enabled,
    start,
    end,
    label: inWindow ? '低峰时段' : '高峰时段'
  }
}

function broadcast(p: BatchProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send(EVT.batchProgress, p)
    } catch {
      /* 窗口可能已关闭 */
    }
  }
}

function getJob(id: number): BatchJob | undefined {
  return getDb().prepare('SELECT * FROM batch_jobs WHERE id = ?').get(id) as BatchJob | undefined
}

/** 解析作业目标（按附件 / 按条目 / 全部） */
function resolveTargets(
  input: CreateBatchInput,
  taskInput: 'attachment' | 'item'
): Array<{ itemId: number | null; attachmentId: number | null; label: string }> {
  const db = getDb()
  const out: Array<{ itemId: number | null; attachmentId: number | null; label: string }> = []

  if (input.scope === 'attachment' && input.attachmentId != null) {
    const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(input.attachmentId) as
      | Attachment
      | undefined
    if (a) out.push({ itemId: a.item_id, attachmentId: a.id, label: a.filename ?? `att#${a.id}` })
    return out
  }

  if (input.scope === 'group' && input.group) {
    const names = groupWithDescendants(listLibraryGroups(), input.group)
    if (!names.length) return out
    const placeholders = names.map(() => '?').join(',')
    const its = db
      .prepare(`SELECT * FROM items WHERE group_name IN (${placeholders}) ORDER BY id`)
      .all(...names) as Item[]
    for (const it of its) {
      if (taskInput === 'item') {
        out.push({ itemId: it.id, attachmentId: null, label: it.title ?? `item#${it.id}` })
      } else {
        const atts = db
          .prepare('SELECT * FROM attachments WHERE item_id = ? ORDER BY id')
          .all(it.id) as Attachment[]
        if (atts.length === 0) {
          out.push({ itemId: it.id, attachmentId: null, label: it.title ?? `item#${it.id}` })
        } else {
          for (const a of atts) {
            out.push({ itemId: a.item_id, attachmentId: a.id, label: a.filename ?? `att#${a.id}` })
          }
        }
      }
    }
    return out
  }

  if (input.scope === 'tag' && input.tag) {
    const ids = itemIdsForTag(input.tag)
    if (!ids.length) return out
    const marks = ids.map(() => '?').join(',')
    const its = db
      .prepare(`SELECT * FROM items WHERE id IN (${marks}) ORDER BY id`)
      .all(...ids) as Item[]
    for (const it of its) {
      if (taskInput === 'item') {
        out.push({ itemId: it.id, attachmentId: null, label: it.title ?? `item#${it.id}` })
      } else {
        const atts = db
          .prepare('SELECT * FROM attachments WHERE item_id = ? ORDER BY id')
          .all(it.id) as Attachment[]
        if (atts.length === 0) {
          out.push({ itemId: it.id, attachmentId: null, label: it.title ?? `item#${it.id}` })
        } else {
          for (const a of atts) {
            out.push({ itemId: a.item_id, attachmentId: a.id, label: a.filename ?? `att#${a.id}` })
          }
        }
      }
    }
    return out
  }

  if (input.scope === 'select' && input.itemIds?.length) {
    for (const id of input.itemIds) {
      if (taskInput === 'item') {
        const it = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Item | undefined
        if (it) out.push({ itemId: it.id, attachmentId: null, label: it.title ?? `item#${it.id}` })
      } else {
        const atts = db
          .prepare('SELECT * FROM attachments WHERE item_id = ? ORDER BY id')
          .all(id) as Attachment[]
        if (atts.length === 0) {
          const it = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Item | undefined
          if (it) out.push({ itemId: it.id, attachmentId: null, label: it.title ?? `item#${it.id}` })
        } else {
          for (const a of atts) {
            out.push({ itemId: a.item_id, attachmentId: a.id, label: a.filename ?? `att#${a.id}` })
          }
        }
      }
    }
    return out
  }

  if (input.scope === 'item' && input.itemId != null) {
    if (taskInput === 'item') {
      const it = db.prepare('SELECT * FROM items WHERE id = ?').get(input.itemId) as Item | undefined
      if (it) out.push({ itemId: it.id, attachmentId: null, label: it.title ?? `item#${it.id}` })
    } else {
      const atts = db
        .prepare('SELECT * FROM attachments WHERE item_id = ? ORDER BY id')
        .all(input.itemId) as Attachment[]
      for (const a of atts) out.push({ itemId: a.item_id, attachmentId: a.id, label: a.filename ?? `att#${a.id}` })
    }
    return out
  }

  if (taskInput === 'item') {
    const its = db.prepare('SELECT * FROM items ORDER BY id').all() as Item[]
    for (const it of its) out.push({ itemId: it.id, attachmentId: null, label: it.title ?? `item#${it.id}` })
  } else {
    const atts = db.prepare('SELECT * FROM attachments ORDER BY id').all() as Attachment[]
    for (const a of atts) out.push({ itemId: a.item_id, attachmentId: a.id, label: a.filename ?? `att#${a.id}` })
  }
  return out
}

/** 仅估算（不创建作业）：目标数量 + 预计模型调用次数（粗略） */
export function estimateJob(input: CreateBatchInput): BatchEstimate {
  const task = getTask(input.task)
  const count = task ? resolveTargets(input, task.input).length : 0
  return estimateBatch(input.task, input.params, count)
}

/**
 * 「立即执行」：复用**同一个** `task.run`（与批处理核心逻辑一致，避免两份实现）。
 * 单次执行不进入队列、不占用批处理并发；产物写入按 jobKey 隔离的目录，避免与批量输出冲突。
 * 规则：重复提交各自独立（按 jobKey 分目录）；失败即抛错，由调用方显示。
 */
export async function runTaskOnce(
  taskId: string,
  target: { attachmentId?: number | null; itemId?: number | null },
  params: Record<string, string> = {}
): Promise<{ ok: boolean; message: string; outputs: string[] }> {
  const task = getTask(taskId)
  if (!task) throw new Error(`未知批处理任务: ${taskId}`)
  const db = getDb()
  const item =
    target.itemId != null
      ? ((db.prepare('SELECT * FROM items WHERE id = ?').get(target.itemId) as Item) ?? null)
      : null
  const attachment =
    target.attachmentId != null
      ? ((db.prepare('SELECT * FROM attachments WHERE id = ?').get(target.attachmentId) as Attachment) ??
        null)
      : null
  const key = generateKey()
  const outDir = jobDir(key)
  mkdirSync(outDir, { recursive: true })
  const ctx: BatchContext = {
    jobId: 0,
    jobKey: key,
    params,
    outDir,
    log: () => undefined,
    isCancelled: () => false
  }
  const out = await task.run(
    { itemId: item?.id ?? null, attachmentId: attachment?.id ?? null, item, attachment },
    ctx
  )
  return { ok: true, message: out.message ?? '完成', outputs: out.outputs }
}

function loadInput(it: BatchItemRow): BatchInput {
  const db = getDb()
  const item =
    it.item_id != null
      ? ((db.prepare('SELECT * FROM items WHERE id = ?').get(it.item_id) as Item) ?? null)
      : null
  const attachment =
    it.attachment_id != null
      ? ((db.prepare('SELECT * FROM attachments WHERE id = ?').get(it.attachment_id) as Attachment) ??
        null)
      : null
  return { itemId: it.item_id, attachmentId: it.attachment_id, item, attachment }
}

/** PD43：一次批处理（含重试/追加作业）的批次标识；批处理产物的提案批次按它幂等 */
export function generateRunId(): string {
  return `br-${generateKey()}`
}

/** 插入作业行 + 明细行（同一事务）；返回新作业 id。createJob / createRetryJob 共用 */
function insertJob(opts: {
  taskId: string
  title: string
  params: Record<string, string>
  targets: Array<{ itemId: number | null; attachmentId: number | null; label: string }>
  status: BatchJobStatus
  offPeakOnly: boolean
  folderSubject?: string | null
  batchRunId?: string | null
}): number {
  const db = getDb()
  const key = generateKey()
  const batchRunId = (opts.batchRunId ?? '').trim() || generateRunId()
  const dateCreated = new Date().toISOString()
  const outDir = newBatchFolder({
    key,
    task: opts.taskId,
    title: opts.title,
    total: opts.targets.length,
    dateCreated,
    firstLabel: opts.targets[0]?.label,
    subject: opts.folderSubject
  })
  const tx = db.transaction((): number => {
    const res = db
      .prepare(
        `INSERT INTO batch_jobs
           (key, batch_run_id, task, title, params, status, off_peak_only, total, done, out_dir, date_created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        key,
        batchRunId,
        opts.taskId,
        opts.title,
        JSON.stringify(opts.params),
        opts.status,
        opts.offPeakOnly ? 1 : 0,
        opts.targets.length,
        outDir,
        dateCreated
      )
    const jobId = Number(res.lastInsertRowid)
    const ins = db.prepare(
      "INSERT INTO batch_items (job_id, item_id, attachment_id, label, status) VALUES (?, ?, ?, ?, 'pending')"
    )
    for (const t of opts.targets) ins.run(jobId, t.itemId, t.attachmentId, t.label)
    return jobId
  })
  return tx()
}

export function createJob(input: CreateBatchInput): BatchJob {
  const task = getTask(input.task)
  if (!task) throw new Error(`未知批处理任务: ${input.task}`)
  const params = input.params ?? {}
  const targets = resolveTargets(input, task.input)
  const win = batchWindowStatus()
  const offPeakOnly = input.offPeakOnly ?? win.enabled
  const status: BatchJobStatus = offPeakOnly && !win.inOffPeak ? 'scheduled' : 'queued'

  const jobId = insertJob({
    taskId: task.id,
    title: task.title,
    params,
    targets,
    status,
    offPeakOnly,
    batchRunId: generateRunId(),
    folderSubject:
      input.scope === 'group' && input.group
        ? `分组-${input.group}`
        : input.scope === 'tag' && input.tag
          ? `标签-${input.tag}`
          : null
  })
  const job = getJob(jobId)!
  broadcast({
    jobId,
    status: job.status,
    done: 0,
    total: job.total,
    message: status === 'scheduled' ? `高峰时段，将在 ${win.start} 之后执行` : '已入队'
  })
  if (status === 'queued') void pump()
  return job
}

/** 目标标签：优先附件名，其次条目名，最后回退 #id */
function labelFor(t: { itemId: number | null; attachmentId: number | null }): string {
  const db = getDb()
  if (t.attachmentId != null) {
    const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(t.attachmentId) as
      | Attachment
      | undefined
    if (a) return a.filename ?? `att#${a.id}`
  }
  if (t.itemId != null) {
    const it = db.prepare('SELECT * FROM items WHERE id = ?').get(t.itemId) as Item | undefined
    if (it) return it.title ?? `item#${it.id}`
  }
  return `#${t.attachmentId ?? t.itemId}`
}

/** 为某个已结束作业新建「只重试失败项」作业；无可重试目标时抛错 */
export function createRetryJob(jobId: number): BatchJob {
  const src = getJob(jobId)
  const plan = retryTargets(src, src ? listItems(jobId) : [])
  if (!plan) throw new Error('该作业没有可重试的失败项')
  const task = getTask(plan.task)
  if (!task) throw new Error(`未知批处理任务: ${plan.task}`)

  const win = batchWindowStatus()
  const offPeakOnly = src!.off_peak_only === 1
  const status: BatchJobStatus = offPeakOnly && !win.inOffPeak ? 'scheduled' : 'queued'
  const targets = plan.targets.map((t) => ({ ...t, label: labelFor(t) }))

  const newId = insertJob({
    taskId: task.id,
    title: `重试失败项 · 原 #${jobId}`,
    params: plan.params,
    targets,
    status,
    offPeakOnly,
    // PD43：重试是同一批处理的续跑，沿用源作业的批次标识（老库缺失时退回作业 key）
    batchRunId: src?.batch_run_id || src?.key || ''
  })
  const job = getJob(newId)!
  broadcast({
    jobId: newId,
    status: job.status,
    done: 0,
    total: job.total,
    message: status === 'scheduled' ? `高峰时段，将在 ${win.start} 之后执行` : '已入队（重试）'
  })
  if (status === 'queued') void pump()
  return job
}

/** 跨作业「一键重跑全部失败项」：按任务聚合所有终态作业中的失败项，各建一个新作业；无可重跑项时抛错 */
export function createRetryAllJobs(): BatchJob[] {
  const jobs = listJobs()
  const itemsByJob = jobs.map((j) => ({ jobId: j.id, items: listItems(j.id) }))
  const plans = selectRetryAllPlan(jobs, itemsByJob)
  if (plans.length === 0) throw new Error('该批处理没有可重跑失败项')

  const win = batchWindowStatus()
  const offPeakOnly = win.enabled
  const status: BatchJobStatus = offPeakOnly && !win.inOffPeak ? 'scheduled' : 'queued'

  const created: BatchJob[] = []
  for (const plan of plans) {
    const task = getTask(plan.task)
    if (!task) continue
    const targets = plan.targets.map((t) => ({ ...t, label: labelFor(t) }))
    const newId = insertJob({
      taskId: task.id,
      title: `重跑全部失败项 · ${plan.task}`,
      params: plan.params,
      targets,
      status,
      offPeakOnly,
      batchRunId: plan.batchRunId
    })
    const job = getJob(newId)!
    broadcast({
      jobId: newId,
      status: job.status,
      done: 0,
      total: job.total,
      message: status === 'scheduled' ? `高峰时段，将在 ${win.start} 之后执行` : '已入队（重跑全部失败项）'
    })
    if (status === 'queued') void pump()
    created.push(job)
  }
  return created
}

async function runJob(job: BatchJob): Promise<void> {
  if (running.has(job.id)) return
  if (cancelled.has(job.id)) {
    // 取消请求先于真正启动到达：不发起任何翻译/模型请求，直接落终态
    const db = getDb()
    db.prepare(
      "UPDATE batch_items SET status = 'cancelled', message = '已取消' WHERE job_id = ? AND status IN ('pending','running')"
    ).run(job.id)
    db.prepare(
      "UPDATE batch_jobs SET status = 'cancelled', message = '已取消', date_finished = ? WHERE id = ?"
    ).run(new Date().toISOString(), job.id)
    cancelled.delete(job.id)
    broadcast({ jobId: job.id, status: 'cancelled', done: job.done, total: job.total, message: '已取消' })
    void pump()
    return
  }
  running.add(job.id)

  const db = getDb()
  const task = getTask(job.task)
  db.prepare("UPDATE batch_jobs SET status = 'running', date_started = COALESCE(date_started, ?) WHERE id = ?").run(
    new Date().toISOString(),
    job.id
  )
  broadcast({ jobId: job.id, status: 'running', done: job.done, total: job.total, message: '开始执行' })

  const params = safeJson<Record<string, string>>(job.params, {})
  const items = db
    .prepare("SELECT * FROM batch_items WHERE job_id = ? AND status != 'done' ORDER BY id")
    .all(job.id) as BatchItemRow[]

  let done = job.done
  let failed = 0
  // 续跑/重启场景：把此前已完成的条目也带入汇总，避免批次索引漏掉它们。
  const results: BatchItemResult[] = (
    db
      .prepare(
        "SELECT * FROM batch_items WHERE job_id = ? AND status = 'done' AND item_id IS NOT NULL ORDER BY id"
      )
      .all(job.id) as BatchItemRow[]
  ).map((row) => ({
    itemId: row.item_id,
    attachmentId: row.attachment_id,
    label: row.label ?? `#${row.id}`,
    ok: true,
    outputs: safeJson<string[]>(row.output ?? '[]', []),
    message: row.message ?? undefined
  }))

  /** 取消请求存在时不再广播 running（避免界面从「已取消」回跳到运行中）；终态广播不受限 */
  const emitRunning = (message?: string): void => {
    if (!shouldBroadcastRunning(cancelled.has(job.id))) return
    broadcast({ jobId: job.id, status: 'running', done, total: job.total, ...(message ? { message } : {}) })
  }

  const ctx: BatchContext = {
    jobId: job.id,
    jobKey: job.key,
    params,
    outDir: job.out_dir ?? jobDir(job.key),
    log: (m: string) => emitRunning(m),
    isCancelled: () => cancelled.has(job.id)
  }

  try {
    // 条目循环与「取消 / 完成」归属判定抽成纯函数，单测可直接对同一份实现跑真实并发用例。
    const plans: BatchItemPlan[] = items.map((it) => ({
      start: () => {
        db.prepare("UPDATE batch_items SET status = 'running' WHERE id = ?").run(it.id)
      },
      run: () => task!.run(loadInput(it), ctx),
      done: (out) => {
        db.prepare("UPDATE batch_items SET status = 'done', output = ?, message = ? WHERE id = ?").run(
          JSON.stringify(out.outputs),
          out.message ?? '',
          it.id
        )
        results.push({
          itemId: it.item_id,
          attachmentId: it.attachment_id,
          label: it.label ?? `#${it.id}`,
          ok: true,
          outputs: out.outputs,
          message: out.message
        })
      },
      cancelled: () => {
        // 取消不是失败：条目标记为 cancelled，且不登记为完成
        db.prepare("UPDATE batch_items SET status = 'cancelled', message = '已取消' WHERE id = ?").run(it.id)
      },
      failed: (msg) => {
        db.prepare("UPDATE batch_items SET status = 'failed', message = ? WHERE id = ?").run(msg, it.id)
        results.push({
          itemId: it.item_id,
          attachmentId: it.attachment_id,
          label: it.label ?? `#${it.id}`,
          ok: false,
          outputs: [],
          message: msg
        })
      }
    }))

    const loop = await runBatchItemLoop({
      items: plans,
      isCancelled: ctx.isCancelled,
      broadcastRunning: () => emitRunning(),
      progress: (state) => {
        done = job.done + state.processed
        failed = state.failed
        db.prepare('UPDATE batch_jobs SET done = ?, message = ? WHERE id = ?').run(
          done,
          `已完成 ${done}/${job.total}${failed ? `（失败 ${failed}）` : ''}`,
          job.id
        )
      }
    })
    done = job.done + loop.processed
    failed = loop.failed

    if (loop.cancelled) {
      // 取消后等待中的条目一律不再启动：显式落为 cancelled，重启恢复逻辑也不会再排队
      db.prepare(
        "UPDATE batch_items SET status = 'cancelled', message = '已取消' WHERE job_id = ? AND status IN ('pending','running')"
      ).run(job.id)
    }

    // 防御：若作业仍有未处理条目，绝不能标记为完成。
    // 旧版本在分组批量里出现过「只跑 1 篇就 done」的竞态，这里把剩余条目重新排队继续跑。
    const remaining = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM batch_items WHERE job_id = ? AND status IN ('pending','running')"
        )
        .get(job.id) as { n: number }
    ).n
    if (remaining > 0 && !cancelled.has(job.id)) {
      db.prepare(
        "UPDATE batch_jobs SET status = 'queued', done = ?, message = ?, date_finished = NULL WHERE id = ?"
      ).run(done, `继续执行剩余 ${remaining} 篇`, job.id)
      broadcast({
        jobId: job.id,
        status: 'queued',
        done,
        total: job.total,
        message: `继续执行剩余 ${remaining} 篇`
      })
      return
    }

    // 收尾：跨条目汇总（如对比表）
    let finalizeMsg = ''
    if (!cancelled.has(job.id) && task?.finalize) {
      ctx.log('正在汇总…')
      try {
        const out = await task.finalize(ctx, results)
        if (out) {
          finalizeMsg = out.message ?? ''
          db.prepare(
            "INSERT INTO batch_items (job_id, item_id, attachment_id, label, status, output, message) VALUES (?, NULL, NULL, '(汇总)', 'done', ?, ?)"
          ).run(job.id, JSON.stringify(out.outputs), finalizeMsg)
        }
      } catch (e) {
        db.prepare(
          "INSERT INTO batch_items (job_id, item_id, attachment_id, label, status, message) VALUES (?, NULL, NULL, '(汇总)', 'failed', ?)"
        ).run(job.id, e instanceof Error ? e.message : String(e))
        finalizeMsg = '汇总失败'
      }
    }

    const wasCancelled = cancelled.has(job.id)
    const allFailed = items.length > 0 && failed === items.length
    const status: BatchJobStatus = wasCancelled ? 'cancelled' : allFailed ? 'failed' : 'done'
    db.prepare('UPDATE batch_jobs SET status = ?, done = ?, message = ?, date_finished = ? WHERE id = ?').run(
      status,
      done,
      status === 'done'
        ? [`完成（失败 ${failed}）`, finalizeMsg].filter(Boolean).join(' · ')
        : status === 'failed'
          ? '全部失败'
          : '已取消',
      new Date().toISOString(),
      job.id
    )
    broadcast({ jobId: job.id, status, done, total: job.total, message: status })
  } finally {
    running.delete(job.id)
    cancelled.delete(job.id)
    void pump()
  }
}

/** 挑出可执行的作业（并发限制 + 低峰门控） */
async function pump(): Promise<void> {
  const concurrency = Math.max(
    1,
    Math.min(4, Number(effective('batch.concurrency', 'PAPERDESK_BATCH_CONCURRENCY', '1')) || 1)
  )
  const win = batchWindowStatus()
  const db = getDb()

  // 进入低峰时段后，把等待中的作业放行
  if (win.inOffPeak) {
    const n = db
      .prepare("UPDATE batch_jobs SET status = 'queued', message = '进入低峰时段' WHERE status = 'scheduled'")
      .run().changes
    if (n > 0) console.log(`[paperdesk] batch: ${n} 个作业进入低峰时段`)
  }

  if (running.size >= concurrency) return
  const candidates = db
    .prepare("SELECT * FROM batch_jobs WHERE status = 'queued' ORDER BY id")
    .all() as BatchJob[]

  for (const job of candidates) {
    if (running.size >= concurrency) break
    if (job.off_peak_only === 1 && !win.inOffPeak) {
      db.prepare("UPDATE batch_jobs SET status = 'scheduled', message = ? WHERE id = ?").run(
        `等待低峰时段（${win.start} 起）`,
        job.id
      )
      broadcast({
        jobId: job.id,
        status: 'scheduled',
        done: job.done,
        total: job.total,
        message: `等待低峰时段（${win.start} 起）`
      })
      continue
    }
    void runJob(job)
  }
}

export function initBatch(): void {
  const db = getDb()
  // 上次异常退出时未完成的作业：恢复为排队
  db.prepare("UPDATE batch_jobs SET status = 'queued', message = '已恢复（应用重启）' WHERE status = 'running'").run()
  db.prepare("UPDATE batch_items SET status = 'pending' WHERE status = 'running'").run()
  // 兼容旧版本遗留：表面已完成、实际仍有 pending 条目的作业，重启后继续跑完。
  db.prepare(
    `UPDATE batch_jobs
        SET status = 'queued', date_finished = NULL, message = '发现未完成条目，继续执行'
      WHERE status IN ('done','failed')
        AND EXISTS (
          SELECT 1 FROM batch_items
           WHERE batch_items.job_id = batch_jobs.id
             AND batch_items.status IN ('pending','running')
        )`
  ).run()
  if (timer) clearInterval(timer)
  timer = setInterval(() => void pump(), 60_000)
  void pump()
}

export function stopBatch(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** 「开始执行」：把所有「待办（scheduled）」作业改为排队并立即开始 */
export function startScheduledJobs(): BatchJob[] {
  const db = getDb()
  db.prepare("UPDATE batch_jobs SET status = 'queued' WHERE status = 'scheduled'").run()
  void pump()
  return listJobs()
}

export function listJobs(): BatchJob[] {
  try {
    migrateAnalysisFilenames()
  } catch {
    /* 迁移失败不阻断作业列表；下次读取会重试 */
  }
  try {
    migrateBatchFolderNames()
  } catch {
    /* 目录迁移失败不阻断作业列表；下次读取会重试 */
  }
  return getDb().prepare('SELECT * FROM batch_jobs ORDER BY id DESC').all() as BatchJob[]
}

export function listItems(jobId: number): BatchItemRow[] {
  return getDb().prepare('SELECT * FROM batch_items WHERE job_id = ? ORDER BY id').all(jobId) as BatchItemRow[]
}

export function listTasks(): BatchTaskInfoLite[] {
  return taskInfos()
}

export function cancelJob(jobId: number): void {
  const db = getDb()
  const job = getJob(jobId)
  if (!job) return
  const wasRunning = job.status === 'running' || running.has(jobId)
  // 只有真正在执行的作业才留内存取消标记：未运行作业若留下标记，删除后 rowid 复用
  // 会让之后的新作业一入队就被误判为「已取消」。
  if (wasRunning) cancelled.add(jobId)
  else cancelled.delete(jobId)

  const changed = db
    .prepare(
      "UPDATE batch_jobs SET status = 'cancelled', message = '已取消', date_finished = ? WHERE id = ? AND status IN ('queued','scheduled','running')"
    )
    .run(new Date().toISOString(), jobId).changes
  if (changed === 0) return

  if (!wasRunning) {
    // 尚未开始：等待中的条目直接落为取消，避免重启后被 initBatch 恢复执行
    db.prepare(
      "UPDATE batch_items SET status = 'cancelled', message = '已取消' WHERE job_id = ? AND status IN ('pending','running')"
    ).run(jobId)
  }
  // 保留真实进度：旧实现广播 0/0 会让界面进度条回跳
  broadcast({
    jobId,
    status: 'cancelled',
    done: job.done,
    total: job.total,
    message: wasRunning ? '正在停止当前条目' : '已取消'
  })
}

export function removeJob(jobId: number): void {
  const job = getJob(jobId)
  // 正在运行的作业：加入 cancelled 以便尽快停下（runJob 的 finally 会清理该标记）。
  // 未运行的作业：**不能**把 id 留在 cancelled —— 作业行删除后 SQLite 会复用 rowid，
  // 残留标记会让之后的新作业一入队就被误判为「已取消」而卡在 pending。
  if (job?.status === 'running' || running.has(jobId)) cancelled.add(jobId)
  else cancelled.delete(jobId)
  getDb().prepare('DELETE FROM batch_jobs WHERE id = ?').run(jobId)
}

export async function openOutput(jobId: number): Promise<void> {
  const job = getJob(jobId)
  if (job?.out_dir) await shell.openPath(job.out_dir)
}

/* ============================ 取消传播 / 完成归属（纯逻辑，单测可直接 import） ============================ */

/**
 * 条目处理结果：
 * - done：run 正常返回，登记为完成（取消同时到达也算完成）；
 * - cancelled：run 未完成且取消已请求，不记失败、不登记结果；
 * - skipped：取消后从未启动的等待条目；
 * - failed：未取消但执行失败。
 */
export type BatchItemOutcome = 'done' | 'cancelled' | 'failed' | 'skipped'

export interface BatchItemRunOutput {
  outputs: string[]
  message?: string
}

export interface BatchItemPlan {
  /** 条目真正开始（写 running 状态） */
  start: () => void
  /** 执行条目；抛错表示未完成 */
  run: () => Promise<BatchItemRunOutput>
  /** 确定完成：登记 done 并收集结果 */
  done: (output: BatchItemRunOutput) => void
  /** 取消终止：不记失败、不登记结果 */
  cancelled: () => void
  /** 未取消但失败：记 failed 并收集失败结果 */
  failed: (message: string) => void
}

export interface BatchLoopProgress {
  /** 本次循环已处理条目数（done + failed；取消与跳过不计） */
  processed: number
  /** 本次循环失败条目数 */
  failed: number
}

export interface BatchLoopOptions {
  items: BatchItemPlan[]
  isCancelled: () => boolean
  /** 仅在本条目处理完且仍未取消时调用（取消后禁止广播 running） */
  broadcastRunning: () => void
  /** 每个条目处理完后写进度；取消时也写，保证作业 done 与真实处理数一致 */
  progress?: (state: BatchLoopProgress) => void
}

export interface BatchLoopResult {
  outcomes: BatchItemOutcome[]
  processed: number
  failed: number
  /** 循环结束时取消请求仍然有效 */
  cancelled: boolean
}

/** 取消请求存在时一律抑制 running 广播（UI 不能回跳到运行中） */
export function shouldBroadcastRunning(isCancelled: boolean): boolean {
  return !isCancelled
}

export async function runBatchItemLoop(options: BatchLoopOptions): Promise<BatchLoopResult> {
  const outcomes: BatchItemOutcome[] = []
  let processed = 0
  let failed = 0

  for (const item of options.items) {
    // 取消后等待中的条目一律不启动（不发起新的翻译请求）
    if (options.isCancelled()) {
      outcomes.push('skipped')
      continue
    }

    item.start()
    try {
      const output = await item.run()
      // 完成优先：即使取消同时到达，完成结果照常登记（完成则登记完成）
      item.done(output)
      outcomes.push('done')
      processed += 1
      options.progress?.({ processed, failed })
      // 取消已请求：不再广播 running，也不再启动后续条目
      if (options.isCancelled()) break
      options.broadcastRunning()
    } catch (e) {
      if (options.isCancelled()) {
        // 取消终止：不记失败、不登记结果（取消则不登记）
        item.cancelled()
        outcomes.push('cancelled')
        break
      }
      const message = e instanceof Error ? e.message : String(e)
      item.failed(message)
      outcomes.push('failed')
      processed += 1
      failed += 1
      options.progress?.({ processed, failed })
      options.broadcastRunning()
    }
  }

  // 提前中止后，剩余条目按跳过补齐（它们从未启动）
  while (outcomes.length < options.items.length) outcomes.push('skipped')

  return { outcomes, processed, failed, cancelled: options.isCancelled() }
}

