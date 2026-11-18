import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { appendFileSync, mkdirSync, readFileSync, statSync, truncateSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { earlyExitMessage, spawnErrorMessage } from './errors'
import { blocksAdapterEnabled } from '../services/settings'

let proc: ChildProcess | null = null
let baseUrl: string | null = null
let starting: Promise<string> | null = null

/** 子进程是否仍在运行（exit 事件/exitCode 是权威信号） */
function processAlive(): boolean {
  return !!proc && proc.exitCode === null && !proc.killed
}

export function isSidecarRunning(url: string): boolean {
  return baseUrl === url && processAlive()
}

/** 结束当前子进程并清空缓存（不改 starting：调用方可能正在它的 promise 里） */
function killProc(): void {
  try {
    proc?.kill()
  } catch {
    /* 已退出 */
  }
  proc = null
  baseUrl = null
}

/** 侧车日志（uvicorn 的异常/崩溃栈都在 stderr；打包后控制台看不到，落盘便于排查） */
function sidecarLogFile(): string {
  return join(app.getPath('userData'), 'data', 'logs', 'sidecar.log')
}

function appendSidecarLog(text: string): void {
  try {
    const f = sidecarLogFile()
    mkdirSync(dirname(f), { recursive: true })
    appendFileSync(f, text)
  } catch {
    /* 写日志失败不影响翻译 */
  }
}

/** 侧车日志末尾若干行（出错时附在提示里，下一次报告可直接定位） */
export function sidecarLogTail(lines = 8): string {
  try {
    const all = readFileSync(sidecarLogFile(), 'utf-8').trim().split('\n')
    return all
      .slice(-lines)
      .map((l) => l.slice(0, 240))
      .join('\n')
  } catch {
    return ''
  }
}

/** Python sidecar 所在目录 */
function pythonDir(): string {
  const root = app.isPackaged ? process.resourcesPath : join(__dirname, '../..')
  return join(root, 'python')
}

function pythonBin(): string {
  return process.env.PAPERDESK_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function waitHealthy(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`sidecar 启动超时 (${timeoutMs}ms)`)
}

/** 启动（或复用）sidecar，返回 baseUrl */
export async function ensureSidecar(): Promise<string> {
  // 并发去重：健康检查与重建必须在同一个 promise 里。
  // 之前两个请求同时检查，一个超时就会把另一个刚确认健康的进程 kill 掉。
  if (starting) return starting

  starting = (async (): Promise<string> => {
    if (baseUrl) {
      if (processAlive()) {
        // 进程还活着就直接复用。**不要**在这里做 /health 超时判定：
        // PyMuPDF 的 find_tables / apply_redactions / 逐页 OCR 会长时间占住 GIL，
        // /health 几秒不响应是正常的；据此 kill 会把正在翻译的侧车杀掉、丢任务。
        return baseUrl
      }
      // 进程确实已退出（exitCode/exit 事件）→ 清理残留后重建
      appendSidecarLog(
        `=== stale sidecar ${new Date().toISOString()} exitCode=${proc?.exitCode ?? 'null'} ===\n`
      )
      killProc()
    }

    const port = await getFreePort()
    const url = `http://127.0.0.1:${port}`
    const child = spawn(
      pythonBin(),
      ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)],
      {
        cwd: pythonDir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows：以 CREATE_NO_WINDOW 启动，避免 python.exe 弹出控制台窗口；
        // 父进程仍通过 pipe 捕获 stdout/stderr（日志逻辑不变）。macOS/Linux 忽略此项。
        windowsHide: true,
        // 结构化解析适配层（设置 → 结构化解析（实验））：只有开关为 true 才注入 '1'。
        // 关闭时整段不出现该键（绝不注入 '0'），侧车环境与旧版逐字节一致。
        env: {
          ...process.env,
          PAPERDESK_PARENT_PID: String(process.pid),
          ...(blocksAdapterEnabled() ? { PAPERDESK_BLOCKS_ADAPTER: '1' } : {})
        }
      }
    )
    proc = child
    try {
      const f = sidecarLogFile()
      mkdirSync(dirname(f), { recursive: true })
      if (statSync(f).size > 2 * 1024 * 1024) truncateSync(f, 0)
    } catch {
      /* 首次运行还没有日志文件 */
    }
    appendSidecarLog(
      `\n=== ${new Date().toISOString()} sidecar pid=${child.pid} port=${port} ===\n`
    )
    child.stdout?.on('data', (d) => process.stdout.write('[sidecar] ' + d))
    child.stderr?.on('data', (d) => {
      process.stdout.write('[sidecar] ' + d)
      appendSidecarLog(String(d))
    })

    const reset = () => {
      if (proc !== child) return
      proc = null
      baseUrl = null
    }

    // 启动阶段：子进程报错或提前退出时立即失败，避免 waitHealthy 干等 30s。
    // 启动成功后，这些事件仍会触发 reset()，用于清理崩溃后的残留状态。
    await new Promise<void>((resolve, reject) => {
      let settled = false
      child.on('error', (err: Error) => {
        console.warn('[sidecar] 启动失败:', err.message)
        reset()
        if (settled) return
        settled = true
        reject(new Error(spawnErrorMessage(err as NodeJS.ErrnoException)))
      })
      child.on('exit', (code, signal) => {
        appendSidecarLog(
          `=== exited ${new Date().toISOString()} code=${code} signal=${signal} ===\n`
        )
        reset()
        if (settled) return
        settled = true
        reject(new Error(earlyExitMessage(code, signal)))
      })
      waitHealthy(url + '/health', 30_000).then(
        () => {
          settled = true
          resolve()
        },
        (e) => {
          settled = true
          if (proc === child) killProc()
          reject(e)
        }
      )
    })

    baseUrl = url
    console.log('[paperdesk] sidecar ready:', url)
    return url
  })()

  try {
    return await starting
  } finally {
    starting = null
  }
}

export function stopSidecar(): void {
  killProc()
  starting = null
}

/**
 * 仅在确认侧车**真的**无响应（进程还在但多次请求失败）时由调用方显式重启。
 * 不要把它接到普通请求路径上：GIL 被重任务占住时的 /health 超时不是死亡。
 */
export function restartSidecar(): void {
  killProc()
  starting = null
}
