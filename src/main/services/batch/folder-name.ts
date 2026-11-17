import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getDataDir, getDb } from '../../db'
import type { BatchJob } from '../../../shared/types'

const TASK_SHORT: Record<string, string> = {
  translate: '翻译',
  'analyze-paper': '拆解',
  'translate-analyze': '翻译+拆解'
}

/** 文件夹名里不能出现的 Windows 字符；顺带压缩连续空白。 */
export function safeFolderSegment(raw: string, max = 48): string {
  const s = (raw || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  return (s.length > max ? s.slice(0, max).replace(/[. ]+$/g, '') : s) || '未命名'
}

function stamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '00000000-0000'
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/**
 * 可读的批次目录：日期-时间_任务_篇数/短标题_短编号。
 * 例如 `20261028-2028_翻译+拆解_5篇_EETRV6QQ`。
 * key 仍放在末尾，保证唯一且能和数据库里的 job.key 对应。
 */
export function batchFolderName(opts: {
  key: string
  task: string
  title: string
  total: number
  dateCreated: string
  firstLabel?: string | null
  subject?: string | null
}): string {
  const task = TASK_SHORT[opts.task] ?? safeFolderSegment(opts.title, 18)
  const subject = opts.subject
    ? safeFolderSegment(opts.subject, 52)
    : opts.total === 1 && opts.firstLabel
      ? safeFolderSegment(opts.firstLabel, 52)
      : `${Math.max(1, opts.total)}篇`
  return `${stamp(opts.dateCreated)}_${task}_${subject}_${opts.key}`
}

function batchRoot(): string {
  const dir = join(getDataDir(), 'batch')
  mkdirSync(dir, { recursive: true })
  return dir
}

function uniqueDir(name: string): string {
  const root = batchRoot()
  let target = join(root, name)
  let n = 2
  while (existsSync(target)) {
    target = join(root, `${name}-${n}`)
    n += 1
  }
  mkdirSync(target, { recursive: true })
  return target
}

/** 为新建作业生成可读目录。key 唯一，所以正常不会撞名。 */
export function newBatchFolder(opts: {
  key: string
  task: string
  title: string
  total: number
  dateCreated: string
  firstLabel?: string | null
  subject?: string | null
}): string {
  return uniqueDir(batchFolderName(opts))
}

/**
 * 把旧版 8 位随机 key 目录整理成可读目录。
 * 只处理终态、目录仍叫 key、且目录真实存在的作业；失败就跳过，下次再试。
 * 不改文件名，只改父目录，并同步 batch_jobs.out_dir。
 */
export function migrateBatchFolderNames(): void {
  const db = getDb()
  const rows = db
    .prepare(
      "SELECT * FROM batch_jobs WHERE status IN ('done','failed','cancelled') ORDER BY id"
    )
    .all() as BatchJob[]
  for (const job of rows) {
    const current = job.out_dir
    if (!current || basename(current) !== job.key || !existsSync(current)) continue
    const first = db
      .prepare(
        "SELECT label FROM batch_items WHERE job_id = ? AND item_id IS NOT NULL ORDER BY id LIMIT 1"
      )
      .get(job.id) as { label?: string } | undefined
    const name = batchFolderName({
      key: job.key,
      task: job.task,
      title: job.title,
      total: job.total,
      dateCreated: job.date_created,
      firstLabel: first?.label
    })
    const root = batchRoot()
    let target = join(root, name)
    let n = 2
    while (existsSync(target)) {
      target = join(root, `${name}-${n}`)
      n += 1
    }
    try {
      renameSync(current, target)
      db.prepare('UPDATE batch_jobs SET out_dir = ? WHERE id = ?').run(target, job.id)
    } catch {
      /* 目录被占用/权限问题：跳过，下次打开批处理再试 */
    }
  }
}
