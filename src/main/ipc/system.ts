import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import { ensureSidecar } from '../sidecar/manager'
import { embedConfig, getPublicSettings, llmConfig } from '../services/settings'
import { testConnection } from '../services/llm'
import type { ProviderTestResult, SystemHealth } from '../../shared/types'

/** 服务自检：Python 解析服务是否可用、可选引擎是否就绪、模型服务是否已配置 */
export function registerSystemHandlers(): void {
  ipcMain.handle(CH.system.health, async (): Promise<SystemHealth> => {
    const p = llmConfig()
    const e = embedConfig()
    const pub = getPublicSettings()
    const providerInfo = {
      configured: !!p.baseUrl && !!p.apiKey,
      mode: pub.provider.mode,
      baseUrl: p.baseUrl,
      chatModel: p.model,
      embedModel: e.model
    }

    try {
      const base = await ensureSidecar()
      const r = await fetch(`${base}/health`)
      const j = (await r.json()) as { status?: string; mineru?: boolean; pdf2zh?: boolean }
      return {
        python: { ok: r.ok && j.status === 'ok', mineru: !!j.mineru, pdf2zh: !!j.pdf2zh },
        provider: providerInfo
      }
    } catch (err) {
      return {
        python: { ok: false, error: err instanceof Error ? err.message : String(err) },
        provider: providerInfo
      }
    }
  })

  ipcMain.handle(CH.system.testProvider, (): Promise<ProviderTestResult> => testConnection())
}
