// 隐藏窗口 GUI 冒烟测试：加载构建产物 out/renderer + out/preload，验证渲染进程能起来
// 用法: npx electron scripts/smoke-gui.cjs
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.webContents.on('did-finish-load', () => console.log('GUI_DID_FINISH_LOAD'))
  win.webContents.on('render-process-gone', (_e, d) => console.log('GUI_RENDER_GONE', JSON.stringify(d)))
  win.webContents.on('console-message', (...args) => {
    const first = args[0]
    const msg = typeof args[2] === 'string' ? args[2] : (first && first.message) || ''
    console.log('RENDERER:', msg)
  })

  try {
    await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
    // 给 pdf.js / React 一点时间跑
    await new Promise((r) => setTimeout(r, 2500))
    const title = await win.webContents.executeJavaScript('document.title')
    const hasRoot = await win.webContents.executeJavaScript(
      "!!document.getElementById('root') && document.getElementById('root').children.length > 0"
    )
    console.log('GUI_TITLE:', title)
    console.log('GUI_ROOT_RENDERED:', hasRoot)
    console.log('GUI_SMOKE_OK')
  } catch (e) {
    console.log('GUI_SMOKE_FAIL:', e && e.message)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
