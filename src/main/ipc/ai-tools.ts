/**
 * AI 工具库 IPC：aiTools:list / update / reset。
 *
 * update / reset 之后向所有窗口广播 EVT.aiToolsChanged —— 思维地图有独立窗口，
 * 只靠发起窗口的本地状态更新会漏掉它，所以统一走广播。
 */
import { BrowserWindow, ipcMain } from 'electron'
import { CH, EVT } from '../../shared/channels'
import type { AiToolsResult } from '../../shared/ai-tools'
import { listAiTools, resetAiTools, updateAiTool } from '../services/ai-tools'

/** 广播最新状态；已销毁的窗口跳过（关闭中的思维地图窗口会命中这里） */
function emitAiToolsChanged(result: AiToolsResult): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(EVT.aiToolsChanged, result)
  }
}

export function registerAiToolsHandlers(): void {
  ipcMain.handle(CH.aiTools.list, (): AiToolsResult => listAiTools())
  ipcMain.handle(CH.aiTools.update, (_event, input: unknown): AiToolsResult => {
    const result = updateAiTool(input)
    emitAiToolsChanged(result)
    return result
  })
  ipcMain.handle(CH.aiTools.reset, (): AiToolsResult => {
    const result = resetAiTools()
    emitAiToolsChanged(result)
    return result
  })
}
