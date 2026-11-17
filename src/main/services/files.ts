import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getDataDir } from '../db'
import type { FsEntry, FsListing, OpenInResult } from '../../shared/types'

/** data/ 根目录（绝对路径） */
function dataRoot(): string {
  return resolve(getDataDir())
}

const toPosix = (p: string): string => p.split(sep).join('/')

/** 把「相对 data/ 的路径（或绝对路径）」解析为安全的绝对路径，禁止越出 data/ 根 */
function resolveSafe(input: string): string {
  const raw = (input ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  const root = dataRoot()
  const abs = isAbsolute(input ?? '') ? resolve(input) : resolve(root, raw)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error('路径越界：只能访问应用数据目录内的文件')
  }
  return abs
}

/** 列出 data/ 下某个目录（Obsidian 式文件树数据源） */
export function listDir(relPath = ''): FsListing {
  const root = dataRoot()
  const abs = resolveSafe(relPath)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    return { path: '', parent: null, entries: [] }
  }
  const entries: FsEntry[] = readdirSync(abs, { withFileTypes: true }).map((d) => {
    const childAbs = join(abs, d.name)
    let size = 0
    let mtime = 0
    try {
      const st = statSync(childAbs)
      size = st.size
      mtime = st.mtimeMs
    } catch {
      /* 忽略无法读取的条目 */
    }
    return {
      name: d.name,
      path: toPosix(relative(root, childAbs)),
      absPath: childAbs,
      isDir: d.isDirectory(),
      size,
      mtime
    }
  })
  entries.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
  )
  const rel = toPosix(relative(root, abs))
  const parent = abs === root ? null : (toPosix(relative(root, resolve(abs, '..'))) || '')
  return { path: rel, parent, entries }
}

/** 用系统默认程序打开一个文件/文件夹 */
export async function openPath(input: string): Promise<void> {
  const abs = resolveSafe(input)
  if (!existsSync(abs)) throw new Error('文件不存在')
  const err = await shell.openPath(abs)
  if (err) throw new Error(err)
}

/** 在系统文件管理器中定位（文件会选中，目录会打开） */
export function revealPath(input: string): void {
  const abs = resolveSafe(input)
  if (!existsSync(abs)) throw new Error('文件不存在')
  if (statSync(abs).isDirectory()) shell.openPath(abs)
  else shell.showItemInFolder(abs)
}

/** 尝试用 `code <path>` 打开；找不到 VS Code 时回退系统默认程序 */
export async function openInVSCode(input: string): Promise<OpenInResult> {
  const abs = resolveSafe(input)
  if (!existsSync(abs)) throw new Error('文件不存在')
  const launched = await tryVSCode(abs)
  if (launched) return { ok: true, fallback: false }
  // 回退：目录用资源管理器，文件用默认程序
  try {
    if (statSync(abs).isDirectory()) shell.openPath(abs)
    else shell.showItemInFolder(abs)
  } catch (e) {
    return { ok: false, fallback: true, error: e instanceof Error ? e.message : String(e) }
  }
  return { ok: false, fallback: true, error: '未找到 `code` 命令，已回退系统默认方式打开' }
}

/** 调用 code CLI；2 秒内未报错即视为成功（code 打开后会很快返回） */
function tryVSCode(target: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let settled = false
    const done = (v: boolean): void => {
      if (!settled) {
        settled = true
        resolvePromise(v)
      }
    }
    try {
      const child = spawn('code', [target], { shell: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => done(false))
      child.on('exit', (code) => done(code === 0))
      setTimeout(() => {
        try {
          child.unref()
        } catch {
          /* noop */
        }
        done(true)
      }, 2000)
    } catch {
      done(false)
    }
  })
}
