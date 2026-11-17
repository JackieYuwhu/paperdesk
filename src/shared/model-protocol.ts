import { authProtocolForUrl, modelAuthHeaders, type AuthProtocol } from './model-auth'

export interface ChatBody {
  model: string
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>
  temperature?: number
  max_tokens?: number
  stream?: boolean
  [key: string]: unknown
}

/** Accept a service root, /v1 root, or a complete endpoint without duplicating paths. */
export function modelEndpoint(base: string, protocol: AuthProtocol = authProtocolForUrl(base)): string {
  const url = new URL(base.trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型服务地址必须使用 HTTP 或 HTTPS')
  const root = url.pathname.replace(/\/(?:chat\/completions|messages)\/?$/, '').replace(/\/+$/, '') || '/v1'
  url.pathname = root + (protocol === 'anthropic' ? '/messages' : '/chat/completions')
  return url.toString()
}

function anthropicContent(content: ChatBody['messages'][number]['content']): unknown {
  if (typeof content === 'string') return content
  return content.map((part) => {
    if (part.type !== 'image_url') return part
    const source = (part.image_url as { url: string }).url
    const match = /^data:(image\/[^;]+);base64,([\s\S]+)$/.exec(source)
    return { type: 'image', source: match
      ? { type: 'base64', media_type: match[1], data: match[2] }
      : { type: 'url', url: source } }
  })
}

export function chatRequest(base: string, apiKey: string, body: ChatBody) {
  const protocol = authProtocolForUrl(base)
  const url = modelEndpoint(base, protocol)
  if (protocol === 'openai') return { url, headers: modelAuthHeaders(url, apiKey, protocol), body }
  const system = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  return {
    url,
    headers: { ...modelAuthHeaders(url, apiKey, protocol), 'anthropic-version': '2023-06-01' },
    body: {
      model: body.model,
      max_tokens: body.max_tokens ?? 8192,
      ...(system ? { system } : {}),
      ...(body.stream ? { stream: true } : {}),
      messages: body.messages.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role, content: anthropicContent(m.content)
      }))
    }
  }
}

export function chatResponseText(data: unknown): string {
  const d = data as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ type: string; text?: string }> }
  return d.choices?.[0]?.message?.content ?? d.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') ?? ''
}

export function chatStreamText(data: unknown): string {
  const d = data as { type?: string; error?: { message?: string }; choices?: Array<{ delta?: { content?: string } }>; delta?: { type?: string; text?: string } }
  if (d.type === 'error') throw new Error(d.error?.message || '模型流式响应出错')
  return d.choices?.[0]?.delta?.content ?? (d.delta?.type === 'text_delta' ? d.delta.text ?? '' : '')
}
