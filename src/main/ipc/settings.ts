import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import {
  exportSettingsFile,
  getKnowledgeStatus,
  getPublicSettings,
  importSettingsFile,
  savePublicSettings
} from '../services/settings'
import type { KnowledgeStatus, PublicSettings, SettingsPatch } from '../../shared/types'
import type { AskWebMode } from '../../shared/types'
import { getWebSearchMode, setWebSearchMode } from '../services/web-search'

export function registerSettingsHandlers(): void {
  ipcMain.handle(CH.settings.get, (): PublicSettings => getPublicSettings())
  ipcMain.handle(CH.settings.save, (_e, patch: SettingsPatch): PublicSettings =>
    savePublicSettings(patch ?? {})
  )
  ipcMain.handle(CH.settings.export, (): Promise<string | null> => exportSettingsFile())
  ipcMain.handle(CH.settings.import, (): Promise<PublicSettings | null> => importSettingsFile())
  // 联网检索三态（独立键 ai.webSearch：'1' 始终 / 'auto' 自动 / 其他关闭，与 API Key 等设置解耦）
  ipcMain.handle(CH.settings.webSearchGet, (): Promise<AskWebMode> => getWebSearchMode())
  ipcMain.handle(CH.settings.webSearchSet, (_e, mode: AskWebMode): Promise<AskWebMode> =>
    setWebSearchMode(mode === 'always' ? 'always' : mode === 'auto' ? 'auto' : 'off')
  )
  // 「严格依据文献」：与设置页同键（ai.strictEvidence），问答请求也会携带本轮选择
  ipcMain.handle(CH.settings.strictEvidenceGet, (): boolean => {
    const s = getPublicSettings()
    return (s.strictEvidence ?? '0') === '1'
  })
  ipcMain.handle(CH.settings.strictEvidenceSet, (_e, on: boolean): boolean => {
    const next = savePublicSettings({ strictEvidence: on === true ? '1' : '0' })
    return (next.strictEvidence ?? '0') === '1'
  })
  // 知识库占位状态（PD31）：只读，首次读取会创建空目录；不实现检索/索引
  ipcMain.handle(CH.settings.knowledgeStatus, (): KnowledgeStatus => getKnowledgeStatus())
}
