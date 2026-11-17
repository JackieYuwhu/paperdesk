import { BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { getDb } from '../db'

/** 每篇论文最多一个独立地图窗口：itemId -> window */
const paperWindows = new Map<number, BrowserWindow>()

interface ItemTitleRow {
  id: number
  title: string | null
}

function itemTitle(itemId: number): string | null {
  const row = getDb()
    .prepare('SELECT id, title FROM items WHERE id = ?')
    .get(itemId) as ItemTitleRow | undefined
  if (!row) return null
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  return title || '未命名文献'
}

/**
 * 打开某篇论文的思维地图窗口。
 * 同一 itemId 已开窗时 restore + focus 并复用；关闭后再次调用会新建（windowId 变化）。
 */
export function openPaperMindmapWindow(itemId: number): {
  ok: boolean
  windowId: number | null
  error?: string
} {
  if (typeof itemId !== 'number' || !Number.isInteger(itemId) || itemId <= 0) {
    return { ok: false, windowId: null, error: '文献 id 无效' }
  }

  const title = itemTitle(itemId)
  if (title === null) {
    return { ok: false, windowId: null, error: '文献不存在，无法打开思维地图' }
  }

  const existing = paperWindows.get(itemId)
  if (existing) {
    if (existing.isDestroyed()) {
      paperWindows.delete(itemId)
    } else {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return { ok: true, windowId: existing.id }
    }
  }

  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    title: `思维地图 · ${title}`,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17191e' : '#f7f8fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  paperWindows.set(itemId, win)

  // 页面里的 document.title 默认会覆盖 BrowserWindow 标题（PaperDesk 会把它写成应用名），
  // 这里禁止页面改标题，窗口标题始终保留「思维地图 · 论文名」。
  win.on('page-title-updated', (event) => {
    event.preventDefault()
  })

  win.on('closed', () => {
    if (paperWindows.get(itemId) === win) paperWindows.delete(itemId)
  })

  // 与主窗口一致：外链交给系统浏览器，窗口内一律不开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch(() => undefined)
    }
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const loading = devUrl
    ? win.loadURL(`${devUrl}?mwindow=${itemId}`)
    : win.loadFile(join(__dirname, '../renderer/index.html'), {
        search: `?mwindow=${itemId}`
      })
  void loading.catch((err: unknown) => {
    console.warn(
      '[mindmap-window] 加载失败:',
      err instanceof Error ? err.message : String(err)
    )
  })

  return { ok: true, windowId: win.id }
}
