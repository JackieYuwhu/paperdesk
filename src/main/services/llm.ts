import { llmConfig, openCodeEndpointHint } from './settings'
import { chatResponseText } from '../../shared/model-protocol'
import { requestModel } from './model-request'
import {
  MINDMAP_AI_NOT_CONFIGURED,
  MindmapAiError,
  describeMindmapAiError
} from '../../shared/mindmap-ai'

export interface GenerateOptions {
  system: string
  user: string
  /** 未配置真实模型（或后端为 mock）时返回的确定性结果 */
  mock: () => string
  temperature?: number
  /** OpenCode 会话标识（同一会话保持一致，便于路由/缓存） */
  session?: string
  /**
   * 本次调用指定的模型（覆盖默认对话模型；留空 = 用默认）。
   * 供「模型智能路由」使用：短分段抽取用快速模型，合并/对比用强模型。
   */
  model?: string
}

/** 从错误响应体里提取可读信息（兼容 OpenAI / OpenCode 的错误结构） */
export function extractApiError(body: string): string {
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string; error?: { message?: string } }
      message?: string
      metadata?: { replacement?: string }
    }
    const m = j?.error?.message ?? j?.error?.error?.message ?? j?.message
    const replacement = j?.metadata?.replacement
    if (typeof m === 'string' && m) {
      const modelHint = /model\s+(is\s+)?(unavailable|not\s+found|does\s+not\s+exist)/i.test(m)
        ? '；请检查设置中的模型 ID（要填 deepseek-v4.1-flash 这类 ID，不是展示名）'
        : ''
      return typeof replacement === 'string' && replacement
        ? `${m}；建议改用 ${replacement}`
        : `${m}${modelHint}`
    }
  } catch {
    /* 非 JSON */
  }
  return body.slice(0, 220)
}

/** 调用 LLM；未配置时自动使用 mock，保证离线可用 */
export async function generate(
  opts: GenerateOptions
): Promise<{ text: string; backend: string }> {
  const cfg = llmConfig()
  if (cfg.backend !== 'openai' || !cfg.baseUrl || !cfg.apiKey) {
    return { text: opts.mock(), backend: cfg.backend === 'openai' ? 'mock(fallback)' : 'mock' }
  }
  // 路由指定的模型优先（未配置 / 留空则用默认对话模型）
  const model = (opts.model ?? '').trim() || cfg.model
  const hint = openCodeEndpointHint(cfg.baseUrl, model)
  if (hint) throw new Error(hint)

  const res = await requestModel(cfg.baseUrl, cfg.apiKey, {
      model: model || 'gpt-4o-mini',
      temperature: opts.temperature ?? 0,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user }
      ]
    }, opts.session, undefined)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${extractApiError(await res.text())}`)
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const text = chatResponseText(data).trim()
  return { text: text || opts.mock(), backend: 'openai' }
}

/** 严格调用的参数：与 generate 相同，但没有 mock 兜底 */
export interface StrictGenerateOptions {
  system: string
  user: string
  temperature?: number
  /** OpenCode 会话标识（思维地图固定用 'mindmap'） */
  session?: string
  model?: string
}

/**
 * 严格调用 LLM：未配置 provider / 网络失败 / HTTP 错误 / 空回答都抛 MindmapAiError。
 *
 * 与 generate 的区别：绝不返回 mock 内容。思维地图的 AI 结果会写进地图 JSON，
 * 一旦用假内容兜底就会变成用户眼中的「AI 编造」，所以这里一律报错让上层给出可操作提示。
 */
export async function generateStrict(
  opts: StrictGenerateOptions
): Promise<{ text: string; backend: string }> {
  const cfg = llmConfig()
  if (cfg.backend !== 'openai' || !cfg.baseUrl || !cfg.apiKey) {
    throw new MindmapAiError('not-configured', MINDMAP_AI_NOT_CONFIGURED)
  }
  const model = (opts.model ?? '').trim() || cfg.model
  const hint = openCodeEndpointHint(cfg.baseUrl, model)
  if (hint) throw new MindmapAiError('not-configured', hint)

  type FetchResult = Awaited<ReturnType<typeof fetch>>
  let res: FetchResult
  try {
    res = await requestModel(cfg.baseUrl, cfg.apiKey, {
        model: model || 'gpt-4o-mini',
        temperature: opts.temperature ?? 0.2,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user }
        ]
      }, opts.session, undefined)
  } catch (error) {
    throw new MindmapAiError('request-failed', describeMindmapAiError(error))
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new MindmapAiError(
      'request-failed',
      describeMindmapAiError(new Error(`HTTP ${res.status} ${extractApiError(body)}`))
    )
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const text = chatResponseText(data).trim()
  if (!text) throw new MindmapAiError('bad-response', 'AI 返回了空内容，请重试')
  return { text, backend: 'openai' }
}

export interface ProviderTestResult {
  ok: boolean
  error?: string
  model: string
  baseUrl: string
  latencyMs: number
}

/** 连通性测试：发一个最小请求验证 Base URL / Key / 模型是否可用 */
export async function testConnection(): Promise<ProviderTestResult> {
  const cfg = llmConfig()
  const started = Date.now()
  const fail = (error: string): ProviderTestResult => ({
    ok: false,
    error,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    latencyMs: Date.now() - started
  })

  if (!cfg.baseUrl || !cfg.apiKey) {
    return fail('未配置模型服务（请在设置里填写 Base URL 与 API Key）')
  }
  const hint = openCodeEndpointHint(cfg.baseUrl, cfg.model)
  if (hint) return fail(hint)

  try {
    const res = await requestModel(cfg.baseUrl, cfg.apiKey, {
        model: cfg.model || 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ping' }]
      }, undefined, undefined)
    const latencyMs = Date.now() - started
    if (!res.ok) {
      return {
        ok: false,
        error: `HTTP ${res.status} ${extractApiError(await res.text())}`,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        latencyMs
      }
    }
    return { ok: true, model: cfg.model, baseUrl: cfg.baseUrl, latencyMs }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}
