import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join, resolve } from 'node:path'
import { initDb, closeDb, getDataDir } from './db'
import { registerAllModules, shutdownModules } from './modules'
import { registerMindmapHandlers } from './ipc/mindmap'
import { registerAiToolsHandlers } from './ipc/ai-tools'
import { stopSidecar } from './sidecar/manager'
import { reconcileTranslationJobs } from './services/translate'
import { initBatch, stopBatch } from './services/batch/queue'
import { migrateNoteFilenamesInBackground } from './services/notes'
import { getPublicSettings } from './services/settings'
import { startConnector, stopConnector } from './services/connector'
import { EVT } from '../shared/channels'

const PROTOCOL = 'paperdesk'
const startupAt = performance.now()
const maintenanceAbort = new AbortController()
let maintenanceTimer: ReturnType<typeof setTimeout> | null = null

// 调试用：设置 PAPERDESK_DEBUG_PORT 即可开启 CDP（便于自动化检查 dev 窗口）
if (process.env.PAPERDESK_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.PAPERDESK_DEBUG_PORT)
}

// 规避 Windows 上「Gpu Cache Creation failed / Unable to move the cache」导致窗口空白：
// 关闭 GPU 着色器磁盘缓存（不影响 PDF 渲染画质，只是不做 shader 缓存）。
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

// GPU/子进程崩溃诊断（若渲染/GPU 进程崩溃会打印 reason/type）
app.on('child-process-gone', (_e, details) => {
  console.log(`[child-process-gone] ${JSON.stringify(details)}`)
})

// 需要时（PAPERDESK_DISABLE_GPU=1）强制软件渲染，规避 GPU 合成导致的白屏
if (process.env.PAPERDESK_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
}

let mainWindow: BrowserWindow | null = null
let pendingDeepLink: string | null = null

/** 注册自定义协议，使 paperdesk:// 链接能唤起本应用 */
function registerProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }
}

function extractDeepLink(argv: string[]): string | null {
  return argv.find((a) => a.startsWith(`${PROTOCOL}://`)) ?? null
}

/** 让原生窗口（标题栏/边框/滚动条）跟随应用明暗主题，避免浅色模式下边框发黑 */
function applyNativeTheme(): void {
  try {
    nativeTheme.themeSource = getPublicSettings().ui.theme === 'dark' ? 'dark' : 'light'
  } catch {
    nativeTheme.themeSource = 'light'
  }
}

/** 精简应用菜单（替换 Electron 默认的 File/Edit/View/Window/Help） */
function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'PaperDesk',
      submenu: [
        {
          label: '关于 PaperDesk',
          click: () => {
            void shell.openExternal('https://github.com/')
          }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function dispatchDeepLink(url: string): void {
  if (!mainWindow || mainWindow.webContents.isLoading()) {
    pendingDeepLink = url
    return
  }
  mainWindow.webContents.send(EVT.deeplink, url)
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: 'PaperDesk',
    // 隐藏原生菜单栏（PaperDesk/编辑/视图 那一行）；快捷键仍通过菜单加速器生效，按 Alt 可临时唤出
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17191e' : '#f7f8fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 窗口失焦/被遮挡时仍持续渲染（否则 PDF 画布可能停在空白，表现为黑屏）
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    console.log(`[startup] window-visible ${Math.round(performance.now() - startupAt)}ms`)
    // 笔记路径已可按库内原路径读取，文件名整理不是窗口首屏的前置条件。
    if (!maintenanceTimer) maintenanceTimer = setTimeout(async () => {
      maintenanceTimer = null
      try { await migrateNoteFilenamesInBackground(maintenanceAbort.signal) } catch (e) { console.warn('[paperdesk] 笔记文件名整理失败:', e) }
      console.log(`[startup] maintenance-done ${Math.round(performance.now() - startupAt)}ms`)
    }, 1500)
  })

  // 渲染层诊断：控制台错误 / 加载失败 / preload 失败 / 渲染进程崩溃 → 打到主进程日志
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 1) console.log(`[renderer:${level}] ${String(message).slice(0, 500)} (${sourceId}:${line})`)
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[renderer-fail] ${code} ${desc} ${url}`)
  })
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    console.log(`[preload-error] ${p} ${err && err.message}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[renderer-gone] ${JSON.stringify(details)}`)
  })

  // 渲染进程加载完成后，把待处理的深链发过去
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) {
      mainWindow?.webContents.send(EVT.deeplink, pendingDeepLink)
      pendingDeepLink = null
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// macOS: 通过 open-url 事件接收深链
app.on('open-url', (event, url) => {
  event.preventDefault()
  dispatchDeepLink(url)
})

// 单实例
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    const url = extractDeepLink(argv)
    if (url) dispatchDeepLink(url)
  })

  app.whenReady().then(() => {
    registerProtocol()
    buildMenu()
    initDb()
    console.log(`[startup] database-ready ${Math.round(performance.now() - startupAt)}ms`)
    applyNativeTheme()
    console.log('[paperdesk] db ready:', getDataDir())
    registerAllModules()
    registerMindmapHandlers()
    // PD54：AI 工具库（分类清单 + 权限开关）独立注册，与思维地图一样在 MODULES 之外
    registerAiToolsHandlers()
    initBatch()

    // F04：恢复连接后收敛「终止未确认」的翻译任务（done → 登记；error/404 → 释放）
    const reconcileTimer = setInterval(() => {
      void reconcileTranslationJobs().catch(() => undefined)
    }, 30_000)
    reconcileTimer.unref?.()

    // Zotero 连接器：仅当启用时监听 127.0.0.1（幂等，端口占用不阻塞启动）
    startConnector()

    // 冷启动时命令行里可能带深链
    const initial = extractDeepLink(process.argv)
    if (initial) pendingDeepLink = initial

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    maintenanceAbort.abort()
    if (maintenanceTimer) clearTimeout(maintenanceTimer)
    maintenanceTimer = null
    shutdownModules()
    stopBatch()
    stopSidecar()
    closeDb()
  })

  app.on('will-quit', () => {
    stopConnector()
  })
}
