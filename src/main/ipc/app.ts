import { clipboard, ipcMain, shell } from 'electron'
import { CH } from '../../shared/channels'

const ALLOWED = /^(https?|mailto):/i

export function registerAppHandlers(): void {
  ipcMain.handle(CH.app.openExternal, async (_e, url: string): Promise<void> => {
    if (!ALLOWED.test(url)) return
    // 来源可追溯：E2E 断言「点击来源 → 真正调用打开外链」，而不真的拉起浏览器
    console.log(`[openExternal] ${url}`)
    if (process.env.PAPERDESK_E2E_NO_EXTERNAL === '1') return
    await shell.openExternal(url)
  })
  ipcMain.handle(CH.app.copyText, (_e, text: string): void => {
    clipboard.writeText(String(text ?? ''))
  })
}
