/**
 * 模型服务鉴权头（纯函数，不依赖 electron，主进程与单测共用）。
 *
 * 鉴权方式取决于**接口协议**，而不是网关域名：
 *  - OpenAI 兼容协议（`/chat/completions`）：`Authorization: Bearer <key>`
 *  - Anthropic Messages 协议（`/messages`）：`x-api-key: <key>`
 *
 * 早期版本按 `opencode.ai` / `/zen/go` 域名一律发 `x-api-key`，这是误判：
 * OpenCode Go 的 `/chat/completions` 同样接受 Bearer，它额外要求的是
 * `x-opencode-session`（见 `settings.ts::modelHeaders`）。用域名判定还会把
 * 挂在 opencode.ai 下的其它协议端点一起带错。
 *
 * Python sidecar（`python/app/model_auth.py`）使用同一判定规则。
 */

/** 接口协议：决定用哪种凭据头 */
export type AuthProtocol = 'openai' | 'anthropic'

/** 是否 OpenCode 端点（只用于附加 `x-opencode-session`，与鉴权无关） */
export function isOpenCodeBaseUrl(baseUrl: string | null | undefined): boolean {
  const b = baseUrl || ''
  return /opencode\.ai/i.test(b) || /\/zen\/go(\/|$)/i.test(b)
}

/**
 * 由请求地址判定接口协议。
 *  - 路径以 `/messages`（或 `/messages?...`）收尾 → Anthropic Messages
 *  - `api.anthropic.com` → Anthropic Messages
 *  - 其它（含 `/chat/completions`、`/responses`）→ OpenAI 兼容
 */
export function authProtocolForUrl(url: string | null | undefined): AuthProtocol {
  const u = (url || '').trim()
  if (!u) return 'openai'
  if (/\/chat\/completions(?:[/?#]|$)/i.test(u)) return 'openai'
  if (/^https?:\/\/api\.anthropic\.com(?::\d+)?(?:[/?#]|$)/i.test(u)) return 'anthropic'
  if (/\/messages(?:[/?#]|$)/i.test(u)) return 'anthropic'
  return 'openai'
}

/**
 * 按接口协议生成鉴权头；空 key 返回空对象（调用方负责提前报「未配置」）。
 * `url` 传完整请求地址（含 `/chat/completions`）或 base URL 均可。
 */
export function modelAuthHeaders(
  url: string | null | undefined,
  apiKey: string | null | undefined,
  protocol?: AuthProtocol
): Record<string, string> {
  const key = (apiKey || '').trim()
  if (!key) return {}
  const p = protocol ?? authProtocolForUrl(url)
  if (p === 'anthropic') return { 'x-api-key': key }
  return { Authorization: `Bearer ${key}` }
}
