import { nativeTheme, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { getDataDir, getDb } from '../db'
import { exportSettingsPayload } from '../../shared/api'
import { clampInt } from './concurrency'
import { knowledgeStatusAt } from './knowledge'
import { authProtocolForUrl, isOpenCodeBaseUrl } from '../../shared/model-auth'
import type { KnowledgeStatus, PublicSettings, SettingsPatch } from '../../shared/types'

import { modelEndpoint } from '../../shared/model-protocol'

const ENC_PREFIX = 'enc:'
const RAW_PREFIX = 'raw:'

function readRow(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined
  return row?.value ?? null
}

export function getRaw(key: string, fallback: string | null = null): string | null {
  return readRow(key) ?? fallback
}

export function setRaw(key: string, value: string | null): void {
  const db = getDb()
  if (value == null || value === '') {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    return
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

/** 读取密钥（自动解密 safeStorage 加密值） */
export function getSecret(key: string): string | null {
  const v = readRow(key)
  if (!v) return null
  if (v.startsWith(ENC_PREFIX)) {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null
      return safeStorage.decryptString(Buffer.from(v.slice(ENC_PREFIX.length), 'base64'))
    } catch {
      return null
    }
  }
  if (v.startsWith(RAW_PREFIX)) return v.slice(RAW_PREFIX.length)
  return v
}

/** 写入密钥（可用时加密） */
export function setSecret(key: string, value: string | null): void {
  if (value == null || value === '') {
    setRaw(key, null)
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    setRaw(key, ENC_PREFIX + safeStorage.encryptString(value).toString('base64'))
  } else {
    setRaw(key, RAW_PREFIX + value)
  }
}

/** 有效值：设置 > 环境变量 > 默认 */
export function effective(settingsKey: string, envName: string, def = ''): string {
  return readRow(settingsKey) ?? process.env[envName] ?? def
}

/** 有效密钥：设置 > 环境变量 */
export function effectiveSecret(settingsKey: string, envName: string): string | undefined {
  return getSecret(settingsKey) ?? process.env[envName] ?? undefined
}

/* =========================================================
   统一的「模型服务」配置
   一个 Base URL + 一个 Key，AI / 翻译 / 向量 全部共用；
   未配置时自动使用离线 mock，配置后自动切换为真模型。
   ========================================================= */
export interface ModelConfig {
  backend: string
  baseUrl: string
  apiKey?: string
  model: string
}

/** 是否 OpenCode Go / Zen 端点（按域名或 /zen/go 路径判定） */
export function isOpenCode(baseUrl: string): boolean {
  return isOpenCodeBaseUrl(baseUrl)
}

/** 稳定的会话 ID（OpenCode Go 要求 x-opencode-session 做路由/缓存） */
export function modelSessionId(): string {
  let id = readRow('provider.sessionId')
  if (!id) {
    id = randomUUID()
    setRaw('provider.sessionId', id)
  }
  return id
}

/**
 * 模型请求头：
 *  - 自报家门的 User-Agent（OpenCode 明确要求，不能是通用 SDK 名）
 *  - 对 OpenCode 端点附加 x-opencode-session（按「会话」维度，便于路由与提示缓存）
 */
export function modelHeaders(baseUrl: string, session?: string): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': 'PaperDesk/0.1.0 (research-paper-desktop-app)' }
  if (isOpenCode(baseUrl)) h['x-opencode-session'] = session || modelSessionId()
  return h
}

/** 会话 ID 生成：同一「会话」（一篇论文的翻译 / 一次问答 / 一个批处理作业）保持一致 */
export const sessionFor = {
  translate: (attachmentKey: string) => `tr-${attachmentKey}`,
  selection: () => 'selection',
  chat: () => 'chat',
  batch: (jobId: number) => `batch-${jobId}`,
  embed: () => 'embed'
}

/** OpenCode 路由提示；Messages 可通过设置中的 Anthropic 协议启用 */
export function openCodeEndpointHint(baseUrl: string, model: string): string | null {
  if (!isOpenCode(baseUrl)) return null
  if (/\/messages(?:[/?#]|$)/i.test(baseUrl)) return null
  const m = (model || '').toLowerCase()
  if (['grok-4.7', 'grok-4.6', 'gpt-6-luna', 'gpt-5.6-luna', 'muse-spark'].some((p) => m.startsWith(p))) {
    return `模型 ${model} 需要 Responses 接口；请选择支持 Chat Completions 的模型。`
  }
  if (['claude-', 'minimax-', 'qwen3.8', 'qwen3.7'].some((p) => m.startsWith(p))) {
    return `模型 ${model} 可能需要 Anthropic Messages 接口，请在设置中选择 Anthropic 协议。`
  }
  return null
}

/**
 * 把设置界面里常见的「展示名」归一成服务端模型 ID。
 * 用户从文档/截图里抄模型名时经常带空格/大写，直接发给 OpenAI 兼容端点会得到
 * `400 Model is unavailable`；batch 的「翻译」「翻译+拆解」都会因此整批失败。
 * 只映射已知别名，未知模型保持原样，避免破坏自定义部署。
 */
const MODEL_ID_ALIASES: Record<string, string> = {
  'deepseek v4.1 flash': 'deepseek-v4.1-flash',
  'deepseek v4.1': 'deepseek-v4.1',
  'deepseek flash': 'deepseek-v4.1-flash',
  'deepseek-flash': 'deepseek-v4.1-flash',
  'deepseek chat': 'deepseek-v4.1-flash',
  'deepseek-chat': 'deepseek-v4.1-flash'
}

export function normalizeModelId(raw: string): string {
  const trimmed = (raw || '').trim()
  if (!trimmed) return ''
  return MODEL_ID_ALIASES[trimmed.toLowerCase()] ?? trimmed
}

function provider(): {
  baseUrl: string
  apiKey?: string
  chatModel: string
  embedModel: string
  mtModel: string
  mode: string
  protocol: 'openai' | 'anthropic'
} {
  return {
    protocol: effective('provider.protocol', 'PAPERDESK_PROVIDER_PROTOCOL', '') === 'anthropic' ? 'anthropic' :
      effective('provider.protocol', 'PAPERDESK_PROVIDER_PROTOCOL', '') === 'openai' ? 'openai' :
      authProtocolForUrl(effective('provider.baseUrl', 'PAPERDESK_LLM_BASEURL', '') || process.env.PAPERDESK_MT_BASEURL),
    mode: effective('provider.mode', 'PAPERDESK_PROVIDER_MODE', 'auto'),
    baseUrl:
      effective('provider.baseUrl', 'PAPERDESK_LLM_BASEURL', '') ||
      process.env.PAPERDESK_MT_BASEURL ||
      '',
    apiKey: getSecret('provider.apiKey') ?? process.env.PAPERDESK_MT_APIKEY ?? undefined,
    chatModel: normalizeModelId(
      effective('provider.chatModel', 'PAPERDESK_CHAT_MODEL', '') ||
        process.env.PAPERDESK_MT_MODEL ||
        ''
    ),
    embedModel: effective('provider.embedModel', 'PAPERDESK_EMBED_MODEL', ''),
    mtModel: normalizeModelId(effective('provider.mtModel', 'PAPERDESK_MT_MODEL', ''))
  }
}

function resolve(mode: string, baseUrl: string, apiKey: string | undefined, model: string, protocol: 'openai' | 'anthropic'): ModelConfig {
  const ready = mode !== 'mock' && !!baseUrl && !!apiKey
  return { backend: ready ? 'openai' : 'mock', baseUrl: baseUrl ? modelEndpoint(baseUrl, protocol) : '', apiKey, model }
}

/** 对话 / 问答 */
export function llmConfig(): ModelConfig {
  const p = provider()
  return resolve(p.mode, p.baseUrl, p.apiKey, p.chatModel || (p.protocol === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o-mini'), p.protocol)
}

/* =========================================================
   论文拆解：并发与模型路由
   ========================================================= */

/** 长文分段 map 阶段的并发（设置 > 环境变量 > 默认 4；限制 1–8） */
export function analysisWorkers(): number {
  return clampInt(effective('analysis.workers', 'PAPERDESK_ANALYSIS_WORKERS', ''), 4, 1, 8)
}

/** 多篇对比「卡片阶段」的并发（设置 > 环境变量 > 默认 4；限制 1–8） */
export function analysisCardWorkers(): number {
  return clampInt(
    effective('analysis.cardWorkers', 'PAPERDESK_ANALYSIS_CARD_WORKERS', ''),
    4,
    1,
    8
  )
}

/**
 * 拆解用的模型路由配置：快速模型 / 强模型（都可留空 = 用默认对话模型）。
 * 选择规则见 `analysis-chunk.ts` 的 `chooseAnalysisModel`（纯函数）。
 */
export function analysisModelRoute(): {
  fastModel: string
  strongModel: string
  defaultModel: string
} {
  return {
    fastModel: normalizeModelId(
      effective('analysis.fastModel', 'PAPERDESK_ANALYSIS_FAST_MODEL', '')
    ),
    strongModel: normalizeModelId(
      effective('analysis.strongModel', 'PAPERDESK_ANALYSIS_STRONG_MODEL', '')
    ),
    defaultModel: llmConfig().model
  }
}

/** 翻译 */
export function mtConfig(): ModelConfig {
  const p = provider()
  return resolve(p.mode, p.baseUrl, p.apiKey, p.mtModel || p.chatModel || (p.protocol === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o-mini'), p.protocol)
}

/**
 * 向量（语义检索）。
 * 关键取舍：**默认 local（离线哈希向量）**，绝不会因为服务端不提供 embedding 而报 400。
 * mode: local（默认，离线）| provider（走真模型 /embeddings）| off（关闭）
 */
export function embedConfig(): ModelConfig {
  const p = provider()
  // 历史开关：embed.enabled=0 仍视为关闭
  if (effective('embed.enabled', 'PAPERDESK_EMBED_ENABLED', '1') === '0') {
    return { backend: 'none', baseUrl: '', apiKey: undefined, model: 'none' }
  }
  const mode = effective('embed.mode', 'PAPERDESK_EMBED_MODE', 'local')
  if (mode === 'off') {
    return { backend: 'none', baseUrl: '', apiKey: undefined, model: 'none' }
  }
  if (mode === 'provider' && p.protocol === 'openai') {
    // 只有真配好（非 mock 模式 + 有 baseUrl/key）才走服务端，否则自动退回本地，避免报错
    if (p.mode !== 'mock' && p.baseUrl && p.apiKey) {
      return {
        backend: 'openai',
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.embedModel || 'text-embedding-3-small'
      }
    }
    return { backend: 'mock', baseUrl: '', apiKey: undefined, model: 'local-hash-64' }
  }
  // local（默认）：sidecar 本地哈希向量，离线可用
  return { backend: 'mock', baseUrl: '', apiKey: undefined, model: 'local-hash-64' }
}

/**
 * 语义重排开关（PD42）：默认关闭。只有 embedding 后端真的是语义向量时才可能生效，
 * 具体降级判定在 shared/api.ts::resolveRetrievalMode（主进程与渲染层共用）。
 */
export function retrievalRerankEnabled(): boolean {
  return effective('retrieval.rerank', 'PAPERDESK_RETRIEVAL_RERANK', '0') === '1'
}

/**
 * 结构化解析适配层（blocks）开关：默认 false（关闭）。
 * 只认严格 '1'：设置库有值就以设置库为准（设置 > 环境变量 > 默认），
 * 与 retrievalRerankEnabled 同一套取值方式；侧车启动时据此注入
 * PAPERDESK_BLOCKS_ADAPTER=1（关闭时绝不注入 '0'，保持与旧版一致）。
 */
export function blocksAdapterEnabled(): boolean {
  // 默认 false：设置库与环境变量都没有值时返回 false（侧车不注入任何变量）
  const raw = effective('ai.blocksAdapter', 'PAPERDESK_BLOCKS_ADAPTER', '')
  return raw === '1'
}

export function getPublicSettings(): PublicSettings {
  const p = provider()
  return {
    provider: {
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKeySet: !!p.apiKey,
      chatModel: p.chatModel,
      embedModel: p.embedModel,
      mtModel: p.mtModel,
      mode: p.mode
    },
    mt: {
      engine: effective('mt.engine', 'PAPERDESK_MT_ENGINE', 'simple'),
      keepVersions: effective('mt.keepVersions', 'PAPERDESK_MT_KEEP_VERSIONS', '0'),
      glossary: effective('mt.glossary', 'PAPERDESK_MT_GLOSSARY', ''),
      autoGlossary: effective('mt.autoGlossary', 'PAPERDESK_MT_AUTO_GLOSSARY', '1'),
      thinking: effective('mt.thinking', 'PAPERDESK_MT_THINKING', '0'),
      // 译文正文字号增量（pt）：0 = 与原文同字号；默认 +1.5
      fontDelta: effective('mt.fontDelta', 'PAPERDESK_MT_FONT_DELTA', '1.5')
    },
    embed: {
      enabled: effective('embed.enabled', 'PAPERDESK_EMBED_ENABLED', '1'),
      mode: effective('embed.mode', 'PAPERDESK_EMBED_MODE', 'local')
    },
    batch: {
      concurrency: effective('batch.concurrency', 'PAPERDESK_BATCH_CONCURRENCY', '1'),
      offPeakOnly: effective('batch.offPeakOnly', 'PAPERDESK_BATCH_OFFPEAK_ONLY', '0'),
      offPeakStart: effective('batch.offPeakStart', 'PAPERDESK_BATCH_PEAK_START', '00:30'),
      offPeakEnd: effective('batch.offPeakEnd', 'PAPERDESK_BATCH_PEAK_END', '08:30')
    },
    analysis: {
      // 读出来就是「实际生效值」（已按 1–8 规整），避免 UI 显示 20 实际只跑 8
      workers: String(analysisWorkers()),
      cardWorkers: String(analysisCardWorkers()),
      fastModel: effective('analysis.fastModel', 'PAPERDESK_ANALYSIS_FAST_MODEL', ''),
      strongModel: effective('analysis.strongModel', 'PAPERDESK_ANALYSIS_STRONG_MODEL', '')
    },
    openalex: {
      mailto: effective('openalex.mailto', 'PAPERDESK_OPENALEX_MAILTO', ''),
      // PD42：状态接口只回传布尔，明文 Key 不出主进程（导出同样删除）
      apiKeySet: effective('openalex.apikey', 'PAPERDESK_OPENALEX_APIKEY', '') !== ''
    },
    scholar: {
      // SerpAPI 的 Google Scholar 引擎 Key（Google Scholar 没有官方 API）
      apiKeySet: effective('scholar.apiKey', 'PAPERDESK_SERPAPI_KEY', '') !== ''
    },
    semantic: {
      // Semantic Scholar 免费 API；Key 可选（配额更高）
      apiKeySet: effective('semantic.apiKey', 'PAPERDESK_S2_KEY', '') !== ''
    },
    retrieval: {
      // 语义重排（PD42）：默认关闭；哈希后端即使打开也会降级为词法
      rerank: retrievalRerankEnabled() ? '1' : '0'
    },
    metadata: {
      crossref: effective('metadata.crossref', 'PAPERDESK_CROSSREF', '1'),
      crossrefLimit: effective('metadata.crossrefLimit', 'PAPERDESK_CROSSREF_LIMIT', '12')
    },
    grobid: { url: effective('grobid.url', 'GROBID_URL', '') },
    // 联网检索：三态（'1' 始终 / 'auto' 自动 / 其他 关闭，缺省关）；代理留空 = 先试系统代理，再直连。
    // 键与 services/web-search.ts 的 WEB_KEY / PROXY_KEY 保持一致。
    websearch: {
      enabled: effective('ai.webSearch', 'PAPERDESK_WEBSEARCH_ENABLED', '0'),
      proxy: effective('ai.searchProxy', 'PAPERDESK_WEBSEARCH_PROXY', '')
    },
    // 「严格依据文献」：'1' 开启；缺省 '0'（允许模型通用知识，但必须标注【模型知识】）
    strictEvidence: effective('ai.strictEvidence', 'PAPERDESK_STRICT_EVIDENCE', '0'),
    ui: { theme: effective('ui.theme', 'PAPERDESK_THEME', 'light') },
    // 结构化解析（实验）：读出来就是「实际生效值」，默认 false
    blocksAdapter: blocksAdapterEnabled()
  }
}

/**
 * 知识库占位状态（PD31）：薄封装，真实数据目录由本模块注入。
 * 逻辑全在 services/knowledge.ts（该文件不 import electron，可被单测直接导入）。
 */
export function getKnowledgeStatus(): KnowledgeStatus {
  return knowledgeStatusAt(getDataDir())
}

/** OpenCode Go 预设 */
export const OPENCODE_GO_BASE = 'https://opencode.ai/zen/go/v1'

/** 导出设置到 JSON（**不含 API Key**，仅暴露「已设置」状态） */
export async function exportSettingsFile(): Promise<string | null> {
  const { dialog } = await import('electron')
  // PD42：导出前统一脱敏（深拷贝后删掉明文 Key，只留 apiKeySet 布尔）
  const data = exportSettingsPayload(getPublicSettings())
  const res = await dialog.showSaveDialog({
    title: '导出设置',
    defaultPath: 'paperdesk-settings.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePath) return null
  writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8')
  return res.filePath
}

/** 从 JSON 导入设置（未知字段忽略；API Key 不会随文件导入） */
export async function importSettingsFile(): Promise<PublicSettings | null> {
  const { dialog } = await import('electron')
  const res = await dialog.showOpenDialog({
    title: '导入设置',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (res.canceled || res.filePaths.length === 0) return null
  const raw = readFileSync(res.filePaths[0], 'utf8')
  let parsed: SettingsPatch
  try {
    parsed = JSON.parse(raw) as SettingsPatch
  } catch {
    throw new Error('文件不是合法 JSON')
  }
  return savePublicSettings(parsed ?? {})
}

export function savePublicSettings(patch: SettingsPatch): PublicSettings {
  if (patch.provider) {
    const g = patch.provider
    if (g.baseUrl?.trim()) modelEndpoint(g.baseUrl.trim(), g.protocol ?? provider().protocol)
    if (g.protocol !== undefined) {
      if (g.protocol !== 'openai' && g.protocol !== 'anthropic') throw new Error('请选择 OpenAI 或 Anthropic 协议')
      setRaw('provider.protocol', g.protocol)
    }
    if (g.baseUrl !== undefined) setRaw('provider.baseUrl', g.baseUrl.trim())
    if (g.apiKey !== undefined) setSecret('provider.apiKey', g.apiKey)
    if (g.chatModel !== undefined) setRaw('provider.chatModel', g.chatModel)
    if (g.embedModel !== undefined) setRaw('provider.embedModel', g.embedModel)
    if (g.mtModel !== undefined) setRaw('provider.mtModel', g.mtModel)
    if (g.mode !== undefined) setRaw('provider.mode', g.mode)
  }
  if (patch.mt?.engine !== undefined) setRaw('mt.engine', patch.mt.engine)
  if (patch.mt?.keepVersions !== undefined) setRaw('mt.keepVersions', patch.mt.keepVersions)
  if (patch.mt?.glossary !== undefined) setRaw('mt.glossary', patch.mt.glossary)
  if (patch.mt?.autoGlossary !== undefined) setRaw('mt.autoGlossary', patch.mt.autoGlossary)
  if (patch.mt?.thinking !== undefined) setRaw('mt.thinking', patch.mt.thinking)
  if (patch.mt?.fontDelta !== undefined) {
    // 只接受 0–4pt 的合法数字，避免脏值让排版崩掉
    const n = Number(patch.mt.fontDelta)
    setRaw('mt.fontDelta', String(Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : 1.5))
  }
  if (patch.embed?.enabled !== undefined) setRaw('embed.enabled', patch.embed.enabled)
  if (patch.embed?.mode !== undefined) setRaw('embed.mode', patch.embed.mode)
  if (patch.openalex?.mailto !== undefined) setRaw('openalex.mailto', patch.openalex.mailto)
  // PD42：三个可选 Key 留空 = 不修改（状态接口只回传 apiKeySet，渲染层拿不到明文）
  if ((patch.openalex?.apiKey ?? '').trim() !== '')
    setRaw('openalex.apikey', (patch.openalex?.apiKey ?? '').trim())
  if ((patch.scholar?.apiKey ?? '').trim() !== '')
    setRaw('scholar.apiKey', (patch.scholar?.apiKey ?? '').trim())
  if ((patch.semantic?.apiKey ?? '').trim() !== '')
    setRaw('semantic.apiKey', (patch.semantic?.apiKey ?? '').trim())
  if (patch.retrieval?.rerank !== undefined)
    setRaw('retrieval.rerank', patch.retrieval.rerank === '1' ? '1' : '0')
  if (patch.metadata?.crossref !== undefined) setRaw('metadata.crossref', patch.metadata.crossref)
  if (patch.metadata?.crossrefLimit !== undefined)
    setRaw('metadata.crossrefLimit', patch.metadata.crossrefLimit)
  if (patch.grobid?.url !== undefined) setRaw('grobid.url', patch.grobid.url)
  // 联网三态：'1' 始终 / 'auto' 自动 / 其他关闭（兼容旧值：任何非 '1'/'auto' 都写 '0'）
  if (patch.websearch?.enabled !== undefined) {
    const v = patch.websearch.enabled
    setRaw('ai.webSearch', v === '1' ? '1' : v === 'auto' ? 'auto' : '0')
  }
  // 空串 = 删除该行 → 回到「系统代理 → 直连」的自动策略
  if (patch.websearch?.proxy !== undefined) setRaw('ai.searchProxy', patch.websearch.proxy.trim())
  // 「严格依据文献」模式：'1' 开启；缺省 '0'（允许通用知识但必须标注【模型知识】）
  if (patch.strictEvidence !== undefined)
    setRaw('ai.strictEvidence', patch.strictEvidence === '1' ? '1' : '0')
  if (patch.ui?.theme !== undefined) {
    setRaw('ui.theme', patch.ui.theme)
    try {
      nativeTheme.themeSource = patch.ui.theme === 'dark' ? 'dark' : 'light'
    } catch {
      /* 忽略 */
    }
  }
  // 结构化解析（实验）：true → 设置库记 '1'（下次启动侧车注入 PAPERDESK_BLOCKS_ADAPTER=1）；
  // false → 记 '0'（不注入）。只影响新解析的文档，已有文档需重新解析。
  if (patch.blocksAdapter !== undefined)
    setRaw('ai.blocksAdapter', patch.blocksAdapter ? '1' : '0')
  if (patch.batch) {
    const b = patch.batch
    if (b.concurrency !== undefined) setRaw('batch.concurrency', b.concurrency)
    if (b.offPeakOnly !== undefined) setRaw('batch.offPeakOnly', b.offPeakOnly)
    if (b.offPeakStart !== undefined) setRaw('batch.offPeakStart', b.offPeakStart)
    if (b.offPeakEnd !== undefined) setRaw('batch.offPeakEnd', b.offPeakEnd)
  }
  if (patch.analysis) {
    const a = patch.analysis
    // 并发统一规整到 1–8 再存；模型名留空 = 删除该项（回退默认模型）
    if (a.workers !== undefined) setRaw('analysis.workers', String(clampInt(a.workers, 4, 1, 8)))
    if (a.cardWorkers !== undefined)
      setRaw('analysis.cardWorkers', String(clampInt(a.cardWorkers, 4, 1, 8)))
    if (a.fastModel !== undefined) setRaw('analysis.fastModel', a.fastModel.trim())
    if (a.strongModel !== undefined) setRaw('analysis.strongModel', a.strongModel.trim())
  }
  return getPublicSettings()
}
