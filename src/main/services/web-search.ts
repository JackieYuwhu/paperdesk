/**
 * 联网检索（AI 问答用）：搜索若干网页 → 抓正文摘要 → 作为 `[W1]` 来源交给模型。
 *
 * 设计约束（对应验收）：
 * - **永不抛错**：超时 / DNS / 非 2xx / 代理不可用都收敛成 `{ ok: false, error, reason }`，
 *   由 ai.ts 降级为只读论文，并在回答开头写「（未联网：…）」；
 * - **有界预算**：总预算 8s（搜索 5s，抓正文单页 3s 并发），超出立即返回可读原因，
 *   问答流程不空等、不阻塞；进度经 onProgress 推给界面；
 * - **代理**：设置项 `ai.searchProxy`（如 http://127.0.0.1:7993）显式指定；留空先试系统代理，
 *   系统也没有就直连。Electron 下用独立的 session 分区承载代理，不污染默认会话；
 * - 设置三态 `ai.webSearch`：'1'=始终、'auto'=自动（本地无依据才联网）、其他=关闭（缺省）；
 *   关闭时 ai.ts 完全走旧路径（不发任何外网请求）；
 * - `PAPERDESK_WEBSEARCH_BASE` 可把搜索端点指向本地 fixture，单测/E2E 因此无需真实网络。
 * - 纯 Node 单测没有 settings/db，所以 settings 只在 Electron 主进程里**动态**加载。
 */
import type { AskWebMode, WebSource } from '../../shared/types'

/*
 * 联网模式归一化：**故意本地复制** `shared/ask-intent.ts::parseWebMode` 的逻辑。
 * 原因同上：本文件被 `scripts/test-unit.ts` 用 Node 原生类型擦除直接 import，
 * 任何运行时 import（含 shared 模块）都会 ERR_MODULE_NOT_FOUND。
 * 两边语义必须一致：'1'/'on'/'always'/true → always；'auto' → auto；其余 → off。
 */
function parseMode(raw: unknown): AskWebMode {
  if (raw === true) return 'always'
  if (raw === false || raw == null) return 'off'
  const v = String(raw).trim().toLowerCase()
  if (v === '1' || v === 'on' || v === 'true' || v === 'always') return 'always'
  if (v === 'auto') return 'auto'
  return 'off'
}

/*
 * 这里的 HTTP 小工具与 `fetch-pdf.ts` 的实现一致，但**故意本地复制**：
 * 本文件被 `scripts/test-unit.ts` 用 Node 原生类型擦除直接 import，
 * 而 Node ESM 不会为无扩展名的相对导入补 `.ts`（Electron/Vite 打包才支持）。
 * 所以联网模块必须做到零运行时 import，才能被真实地单测。
 */
function errText(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') return '请求超时'
    if (e.name === 'TypeError' && /fetch failed/i.test(e.message)) {
      const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause
      return `网络错误 ${cause?.code ?? ''}${cause?.message ? `（${cause.message}）` : ''}`
    }
    return `${e.name}: ${e.message}`
  }
  return String(e)
}

/** 失败原因分类（回答/界面据此给可操作提示） */
export type WebFailReason = 'timeout' | 'network' | 'proxy' | 'http' | 'empty' | 'off'

/** 异常里取错误码：Node fetch 放在 cause，Electron net.fetch 常直接写进 message */
function errorCodeOf(e: unknown): string {
  const box = e as { code?: unknown; cause?: { code?: unknown } } | null
  const direct = box && typeof box.code === 'string' ? box.code : ''
  const causeCode = box && typeof box.cause?.code === 'string' ? box.cause.code : ''
  if (direct || causeCode) return direct || causeCode
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e ?? '')
  const m =
    /\b(ERR_[A-Z_]+|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ETIMEDOUT|ABORT_ERR|PROXY_UNSUPPORTED)\b/.exec(
      text
    )
  return m ? m[1] : ''
}

const TIMEOUT_CODES = new Set(['ABORT_ERR', 'ERR_TIMED_OUT', 'ETIMEDOUT'])
const PROXY_CODES = new Set([
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_PROXY_AUTH_UNSUPPORTED',
  'ERR_MANDATORY_PROXY_CONFIGURED',
  'ERR_NO_SUPPORTED_PROXIES',
  'PROXY_UNSUPPORTED'
])
const NETWORK_CODES = new Set([
  'ERR_NAME_NOT_RESOLVED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_NETWORK_CHANGED',
  'ERR_NETWORK_IO_SUSPENDED',
  'ERR_SSL_PROTOCOL_ERROR',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNRESET',
  'EPIPE'
])

/**
 * 异常 → 可读原因（纯函数，便于单测）。
 * 有显式代理时优先提示「代理不可用」，否则提示「网络不可达 / 需要代理」。
 */
export function classifyNetError(
  e: unknown,
  proxyRules?: string | null
): { reason: WebFailReason; message: string } {
  const proxy = parseProxyRules(proxyRules)
  const name = e instanceof Error ? e.name : ''
  const code = errorCodeOf(e)
  const timeout = name === 'AbortError' || name === 'TimeoutError' || TIMEOUT_CODES.has(code)
  if (timeout) {
    const secs = Math.round(TOTAL_BUDGET_MS / 1000)
    return {
      reason: 'timeout',
      message: proxy
        ? `检索超时（${secs} 秒内无响应）：代理 ${proxy} 可能不可用，请检查后重试`
        : `检索超时（${secs} 秒内无响应）：本机可能无外网，请在设置里填写代理后重试`
    }
  }
  if (PROXY_CODES.has(code)) {
    return { reason: 'proxy', message: `代理不可用（${code}）：请检查设置里的代理地址` }
  }
  if (NETWORK_CODES.has(code) || /^ERR_/.test(code)) {
    return proxy
      ? { reason: 'proxy', message: `代理不可用（${code}）：请检查设置里的代理地址` }
      : {
          reason: 'network',
          message: `网络不可达（${code}）：本机可能无外网，请在设置里填写代理后重试`
        }
  }
  if (proxy) return { reason: 'proxy', message: `代理不可用：${errText(e)}（${proxy}）` }
  return { reason: 'network', message: `网络不可达：${errText(e)}` }
}

/** HTTP 状态码 → 可读原因（403/429 额外说明反爬/限流） */
export function describeHttpStatus(status: number): string {
  const code = Number(status) || 0
  if (code === 403) return 'HTTP 403（请求被拒绝：可能触发反爬，或需要代理）'
  if (code === 429) return 'HTTP 429（请求过于频繁，被限流）'
  if (code >= 500) return `HTTP ${code}（服务端暂时不可用）`
  if (code >= 400) return `HTTP ${code}（请求被拒绝）`
  return `HTTP ${code}`
}

/** 显式代理 → 规则串；`127.0.0.1:7993` 这类简写补成 `http://127.0.0.1:7993` */
export function parseProxyRules(raw: string | null | undefined): string | null {
  const v = String(raw ?? '').trim()
  if (!v) return null
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`
}

/** Chromium 的 resolveProxy 结果（"PROXY h:p; DIRECT"）→ 代理 URL */
function proxyFromChromium(result: string): string | null {
  for (const part of String(result ?? '').split(';')) {
    const p = part.trim()
    if (!p || /^DIRECT$/i.test(p)) continue
    const m = /^(PROXY|HTTPS|SOCKS4|SOCKS5)\s+(\S+)$/i.exec(p)
    if (!m) continue
    const scheme = /^SOCKS5$/i.test(m[1]) ? 'socks5' : /^SOCKS4$/i.test(m[1]) ? 'socks4' : 'http'
    return `${scheme}://${m[2]}`
  }
  return null
}

/** Chromium setProxy 只认 "http=host:port" 形式（不认 URL scheme） */
function chromiumProxyRules(proxy: string): string {
  try {
    const u = new URL(proxy)
    const scheme = u.protocol.replace(':', '').toLowerCase()
    if (scheme === 'socks5' || scheme === 'socks') return `socks5=${u.host}`
    if (scheme === 'socks4') return `socks4=${u.host}`
    if (scheme === 'https') return `https=${u.host}`
    return `http=${u.host}`
  } catch {
    return proxy
  }
}

type ElectronSession = {
  fetch: (url: string, init?: unknown) => Promise<Response>
  setProxy: (config: { proxyRules?: string; mode?: string }) => Promise<void>
  resolveProxy: (url: string) => Promise<string>
}

let webSessionPromise: Promise<ElectronSession | null> | null = null
let proxyChain: Promise<void> = Promise.resolve()
let proxyAppliedKey: string | null = null

/** 联网专用 session 分区：代理只影响检索，不污染默认会话 */
async function getWebSession(): Promise<ElectronSession | null> {
  if (!process.versions.electron) return null
  if (!webSessionPromise) {
    webSessionPromise = (async () => {
      try {
        const mod = (await import('electron')) as unknown as {
          session?: { fromPartition: (name: string) => ElectronSession }
        }
        return mod.session?.fromPartition('paperdesk-websearch') ?? null
      } catch {
        return null
      }
    })()
  }
  return webSessionPromise
}

/** 串行设置分区代理；同一规则只设一次（并发抓正文不会互相覆盖） */
function ensureProxy(ses: ElectronSession, proxy: string | null): Promise<void> {
  const key = proxy ?? ''
  if (proxyAppliedKey === key) return Promise.resolve()
  proxyChain = proxyChain.then(async () => {
    if (proxyAppliedKey === key) return
    try {
      // 显式代理用 fixed_servers；留空用 system（Chromium 走系统代理，没有就直连）
      await ses.setProxy(proxy ? { proxyRules: chromiumProxyRules(proxy) } : { mode: 'system' })
      proxyAppliedKey = key
    } catch {
      /* 代理设置失败：保持当前策略，请求会自行失败并给出可读原因 */
    }
  })
  return proxyChain
}

/** 解析生效代理：显式设置优先 → 系统代理 → null（直连） */
export async function resolveProxyRules(
  explicit: string | null | undefined,
  url: string
): Promise<string | null> {
  const fixed = parseProxyRules(explicit)
  if (fixed) return fixed
  const ses = await getWebSession()
  if (!ses) return null
  try {
    return proxyFromChromium(await ses.resolveProxy(url))
  } catch {
    return null
  }
}

/** 请求头 → 普通对象（Node 代理请求要用） */
function headersToRecord(init: RequestInit['headers'] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!init) return out
  if (typeof (init as Headers).forEach === 'function') {
    ;(init as Headers).forEach((v, k) => {
      out[k] = v
    })
    return out
  }
  if (Array.isArray(init)) {
    for (const pair of init) out[String(pair[0])] = String(pair[1])
    return out
  }
  for (const [k, v] of Object.entries(init as Record<string, string>)) out[k] = String(v)
  return out
}

/**
 * 纯 Node 环境下让 http 目标走 HTTP 代理（absolute-form 请求）。
 * 只用于单测/脚本；Electron 主进程走 session.fetch（支持 https 与 CONNECT）。
 */
async function nodeProxyFetch(url: string, init: RequestInit, proxy: string): Promise<Response> {
  const target = new URL(url)
  const proxyUrl = new URL(proxy)
  const fail = (msg: string): Error => {
    const err = new Error(msg) as Error & { code?: string }
    err.code = 'PROXY_UNSUPPORTED'
    return err
  }
  if (target.protocol !== 'http:') throw fail('Node 环境仅支持 http 目标走显式代理')
  if (proxyUrl.protocol !== 'http:') throw fail(`不支持的代理协议 ${proxyUrl.protocol}`)
  const http = await import('node:http')
  const headers = headersToRecord(init.headers)
  headers.host = target.host
  return await new Promise<Response>((resolve, reject) => {
    const req = http.request(
      {
        host: proxyUrl.hostname,
        port: proxyUrl.port ? Number(proxyUrl.port) : 80,
        method: (init.method ?? 'GET').toUpperCase(),
        // absolute-form：代理据此转发（https 目标需要 CONNECT，这里不支持）
        path: url,
        headers
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)))
        res.on('error', reject)
        res.on('end', () => {
          const out = new Headers()
          for (const [k, v] of Object.entries(res.headers)) {
            if (v != null) out.set(k, Array.isArray(v) ? v.join(', ') : String(v))
          }
          const body = new Uint8Array(Buffer.concat(chunks))
          resolve(new Response(body, { status: res.statusCode ?? 502, headers: out }))
        })
      }
    )
    req.on('error', reject)
    const signal = init.signal
    const abort = (): void => {
      const err = new Error('请求超时') as Error & { name: string }
      err.name = 'AbortError'
      req.destroy(err)
    }
    if (signal) {
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    req.end()
  })
}

async function httpFetch(url: string, init: RequestInit, proxy?: string | null): Promise<Response> {
  const ses = await getWebSession()
  if (ses) {
    await ensureProxy(ses, parseProxyRules(proxy))
    return await ses.fetch(url, init as unknown)
  }
  // 纯 Node（单测/脚本）：显式代理走本地实现，其余用内置 fetch（生产路径不经过这里）
  const fixed = parseProxyRules(proxy)
  if (fixed) return await nodeProxyFetch(url, init, fixed)
  return fetch(url, init)
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
  proxy?: string | null
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(100, timeoutMs))
  try {
    return await httpFetch(url, { redirect: 'follow', ...(init ?? {}), signal: ctrl.signal }, proxy)
  } finally {
    clearTimeout(timer)
  }
}

/** 联网结果 → 模型上下文（[W1] 编号 + 完整 URL）；与 shared/paper-hits 同格式（本地实现见上） */
function webContextBlock(sources: WebSource[]): string {
  return sources
    .filter((s) => s && typeof s.url === 'string' && s.url)
    .map((s) => {
      const body = (s.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200)
      return `[W${s.index}] ${s.title || s.url}\nURL: ${s.url}${body ? `\n${body}` : ''}`
    })
    .join('\n\n')
}

/** 设置键：'1' 开启，其他/缺省为关（联网是按需能力，默认不联网） */
const WEB_KEY = 'ai.webSearch'
/** 显式代理键；空 = 系统代理 → 直连（与 settings.ts 的 websearch.proxy 同键） */
const PROXY_KEY = 'ai.searchProxy'
/**
 * 联网时间预算（阶段一：3 秒对真实网络过于苛刻，中文站点/代理下几乎必然超时）。
 * 总预算 8 秒，搜索 5 秒，单页 3 秒；仍是有界预算，超时只降级为「未联网」并给出原因。
 */
export const TOTAL_BUDGET_MS = 8000
const SEARCH_TIMEOUT_MS = 5000
const PAGE_TIMEOUT_MS = 3000
const MAX_PAGES = 3
const MAX_HITS = 5

/** 搜索进度（主进程经 EVT.aiProgress 推给界面：搜索中 / 抓取中 / 完成） */
export interface WebProgress {
  phase: 'web'
  done: number
  total: number
  message: string
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 PaperDesk'

export interface WebSearchHit {
  title: string
  url: string
  snippet: string | null
}

export interface WebSearchOutcome {
  ok: boolean
  /** 失败原因（用户可读：请求超时 / HTTP 429 / 网络不可达…） */
  error: string | null
  /** 失败分类：界面与回答据此给「检查网络 / 设置代理」提示 */
  reason?: WebFailReason
  /** 实际命中的搜索引擎名（fixture / DuckDuckGo / Wikipedia） */
  provider: string | null
  hits: WebSearchHit[]
}

export interface WebContextResult {
  ok: boolean
  error: string | null
  reason?: WebFailReason | null
  provider: string | null
  sources: WebSource[]
  /** 拼好的模型上下文（[W1] 标题 + URL + 摘录） */
  text: string
  /** 成功抓到正文的页数 */
  fetched: number
}

export interface WebForAnswer {
  status: 'off' | 'on' | 'failed'
  error: string | null
  reason?: WebFailReason | null
  sources: WebSource[]
  text: string
  fetched: number
}

type SettingsLike = {
  getRaw: (key: string, fallback?: string | null) => string | null
  setRaw: (key: string, value: string | null) => void
}

let settingsPromise: Promise<SettingsLike | null> | null = null

/** 仅 Electron 主进程可加载 settings（纯 Node 单测里它依赖 db，直接 import 会失败） */
async function loadSettings(): Promise<SettingsLike | null> {
  if (!process.versions.electron) return null
  if (!settingsPromise) {
    settingsPromise = import('./settings')
      .then((m) => m as unknown as SettingsLike)
      .catch(() => null)
  }
  return settingsPromise
}

/**
 * 联网检索是否启用。缺省关（读不到设置 / 设置库异常都按不联网处理，失败安全）：
 * 默认问答只走论文上下文，需要联网时由用户显式开启。
 */
export async function getWebSearchEnabled(): Promise<boolean> {
  const store = await loadSettings()
  if (!store) return process.env.PAPERDESK_WEBSEARCH_ENABLED === '1'
  try {
    return store.getRaw(WEB_KEY, '0') === '1'
  } catch {
    return false
  }
}

/** 写入开关；返回写入后的状态（读不到设置时返回入参，界面据此回显） */
export async function setWebSearchEnabled(on: boolean): Promise<boolean> {
  const store = await loadSettings()
  if (!store) return on
  try {
    store.setRaw(WEB_KEY, on ? '1' : '0')
  } catch {
    /* 设置库异常不应打断界面切换 */
  }
  return on
}

/**
 * 联网三态（阶段一）：off 关闭 / auto 自动（本地无依据时才联网）/ always 始终。
 * 存储仍是单键 ai.webSearch：'1'=always、'auto'=auto、其他=off，兼容旧数据。
 */
export async function getWebSearchMode(): Promise<AskWebMode> {
  const store = await loadSettings()
  if (!store) return parseMode(process.env.PAPERDESK_WEBSEARCH_ENABLED ?? '0')
  try {
    return parseMode(store.getRaw(WEB_KEY, '0'))
  } catch {
    return 'off'
  }
}

/** 写入三态；返回写入后的模式（读不到设置时返回入参，界面据此回显） */
export async function setWebSearchMode(mode: AskWebMode): Promise<AskWebMode> {
  const store = await loadSettings()
  if (!store) return mode
  try {
    store.setRaw(WEB_KEY, mode === 'always' ? '1' : mode === 'auto' ? 'auto' : '0')
  } catch {
    /* 设置库异常不应打断界面切换 */
  }
  return mode
}

/** 显式代理（空 = 未配置，交给系统代理 → 直连）；读不到设置时看环境变量 */
export async function getWebSearchProxy(): Promise<string | null> {
  const store = await loadSettings()
  if (!store) return parseProxyRules(process.env.PAPERDESK_WEBSEARCH_PROXY)
  try {
    return parseProxyRules(store.getRaw(PROXY_KEY, ''))
  } catch {
    return null
  }
}

/** 从 URL 取站点名（www. 去掉），失败返回 null */
export function siteOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '')
    return host || null
  } catch {
    return null
  }
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
}

/** HTML → 纯文本（去脚本/样式/标签，解常见实体，压空白） */
export function htmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => {
      try {
        return String.fromCodePoint(parseInt(h, 16))
      } catch {
        return ''
      }
    })
    .replace(/&#(\d+);/g, (_m, d: string) => {
      try {
        return String.fromCodePoint(parseInt(d, 10))
      } catch {
        return ''
      }
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .trim()
}

/** DuckDuckGo 结果页解析（纯函数，便于单测）：result__a + result__snippet */
export function parseDdgHtml(html: string, limit = MAX_HITS): WebSearchHit[] {
  const hits: WebSearchHit[] = []
  const seen = new Set<string>()
  const anchorRe = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>[\s\S]*?<\/a>/gi
  const snippetRe = /<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  const snippets: string[] = []
  for (const m of html.matchAll(snippetRe)) snippets.push(htmlToText(m[1]))
  let i = 0
  for (const m of html.matchAll(anchorRe)) {
    const tag = m[0]
    const hrefM = /href="([^"]+)"/i.exec(tag)
    if (!hrefM) continue
    let url = (hrefM[1] ?? '').replace(/&amp;/g, '&')
    // DDG 用协议相对地址（//duckduckgo.com/l/?uddg=…）
    if (url.startsWith('//')) url = 'https:' + url
    // DDG 会把外链包一层 /l/?uddg=<encoded>
    const wrapped = /[?&]uddg=([^&]+)/i.exec(url)
    if (wrapped) {
      try {
        url = decodeURIComponent(wrapped[1])
      } catch {
        /* 保持原样 */
      }
    }
    if (url.startsWith('//')) url = 'https:' + url
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    const title = htmlToText(tag.replace(/<a\b[^>]*>/i, '').replace(/<\/a>/i, '')) || url
    seen.add(url)
    hits.push({ title, url, snippet: snippets[i] ? snippets[i] : null })
    i += 1
    if (hits.length >= limit) break
  }
  return hits
}

/** 抓页面正文（只接受 HTML/文本；PDF 与二进制返回 null） */
export async function fetchPageText(
  url: string,
  timeoutMs = PAGE_TIMEOUT_MS,
  proxy?: string | null
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      url,
      Math.max(200, timeoutMs),
      { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.2' } },
      proxy
    )
    if (!res.ok) return null
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    if (ct && !/text\/|html|xml|json/.test(ct)) return null
    const raw = await res.text()
    if (!raw) return null
    const text = htmlToText(raw)
    return text ? text.slice(0, 6000) : null
  } catch {
    return null
  }
}

/** 失败收敛：异常 → 可读 outcome（分类 + 人话） */
function failedOutcome(e: unknown, provider: string, proxy: string | null): WebSearchOutcome {
  const c = classifyNetError(e, proxy)
  return { ok: false, error: c.message, reason: c.reason, provider, hits: [] }
}

/** 单次搜索；fixture 优先（PAPERDESK_WEBSEARCH_BASE），其次 DuckDuckGo + Wikipedia（并发） */
export async function searchWeb(
  query: string,
  opts: { limit?: number; timeoutMs?: number; proxy?: string | null } = {}
): Promise<WebSearchOutcome> {
  const q = (query ?? '').trim()
  if (!q) return { ok: false, error: '检索内容为空', reason: 'empty', provider: null, hits: [] }
  const limit = Math.min(MAX_HITS, Math.max(1, opts.limit ?? MAX_HITS))
  const timeoutMs = Math.max(200, Math.min(SEARCH_TIMEOUT_MS, opts.timeoutMs ?? SEARCH_TIMEOUT_MS))
  const proxy = parseProxyRules(opts.proxy)
  const base = (process.env.PAPERDESK_WEBSEARCH_BASE ?? '').trim().replace(/\/+$/, '')

  if (base) return await searchFixture(base, q, limit, timeoutMs, proxy)

  // 两个来源并发：离线时总耗时 = 单个超时，而不是两个相加（3 秒预算的关键）
  const [ddgR, wikiR] = await Promise.allSettled([
    searchDuckDuckGo(q, limit, timeoutMs, proxy),
    searchWikipedia(q, limit, timeoutMs, proxy)
  ])
  const ddg =
    ddgR.status === 'fulfilled' ? ddgR.value : failedOutcome(ddgR.reason, 'DuckDuckGo', proxy)
  const wiki = wikiR.status === 'fulfilled' ? wikiR.value : failedOutcome(wikiR.reason, 'Wikipedia', proxy)
  if (ddg.ok && ddg.hits.length) return ddg
  if (wiki.ok && wiki.hits.length) return wiki
  if (ddg.ok && wiki.ok) return { ok: true, error: null, provider: null, hits: [] }
  const failed = [ddg, wiki].find((o) => !o.ok && o.error)
  return {
    ok: false,
    error: failed?.error ?? '没有可用的搜索来源',
    reason: failed?.reason ?? 'network',
    provider: null,
    hits: []
  }
}

async function searchFixture(
  base: string,
  q: string,
  limit: number,
  timeoutMs: number,
  proxy: string | null
): Promise<WebSearchOutcome> {
  try {
    const res = await fetchWithTimeout(
      `${base}/search?q=${encodeURIComponent(q)}&limit=${limit}`,
      timeoutMs,
      { headers: { 'user-agent': UA, accept: 'application/json' } },
      proxy
    )
    if (!res.ok) {
      return {
        ok: false,
        error: describeHttpStatus(res.status),
        reason: 'http',
        provider: 'fixture',
        hits: []
      }
    }
    const body = (await res.json()) as { results?: unknown } | unknown[]
    const rows = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : []
    const hits: WebSearchHit[] = []
    for (const r of rows as Array<Record<string, unknown>>) {
      const url = String(r?.url ?? '')
      if (!/^https?:\/\//i.test(url)) continue
      hits.push({
        title: String(r?.title ?? url),
        url,
        snippet: r?.snippet == null ? null : String(r.snippet)
      })
      if (hits.length >= limit) break
    }
    return { ok: true, error: null, provider: 'fixture', hits }
  } catch (e) {
    return failedOutcome(e, 'fixture', proxy)
  }
}

async function searchDuckDuckGo(
  q: string,
  limit: number,
  timeoutMs: number,
  proxy: string | null
): Promise<WebSearchOutcome> {
  try {
    const res = await fetchWithTimeout(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
      timeoutMs,
      { headers: { 'user-agent': UA, accept: 'text/html' } },
      proxy
    )
    if (!res.ok) {
      return {
        ok: false,
        error: describeHttpStatus(res.status),
        reason: 'http',
        provider: 'DuckDuckGo',
        hits: []
      }
    }
    const html = await res.text()
    return { ok: true, error: null, provider: 'DuckDuckGo', hits: parseDdgHtml(html, limit) }
  } catch (e) {
    return failedOutcome(e, 'DuckDuckGo', proxy)
  }
}

async function searchWikipedia(
  q: string,
  limit: number,
  timeoutMs: number,
  proxy: string | null
): Promise<WebSearchOutcome> {
  try {
    const url =
      'https://zh.wikipedia.org/w/api.php?action=opensearch&format=json&namespace=0&limit=' +
      `${limit}&search=${encodeURIComponent(q)}`
    const res = await fetchWithTimeout(
      url,
      timeoutMs,
      { headers: { 'user-agent': UA, accept: 'application/json' } },
      proxy
    )
    if (!res.ok) {
      return {
        ok: false,
        error: describeHttpStatus(res.status),
        reason: 'http',
        provider: 'Wikipedia',
        hits: []
      }
    }
    const data = (await res.json()) as [string, string[], string[], string[]]
    const titles = Array.isArray(data?.[1]) ? data[1] : []
    const descs = Array.isArray(data?.[2]) ? data[2] : []
    const urls = Array.isArray(data?.[3]) ? data[3] : []
    const hits: WebSearchHit[] = []
    for (let i = 0; i < urls.length && hits.length < limit; i++) {
      const u = String(urls[i] ?? '')
      if (!/^https?:\/\//i.test(u)) continue
      hits.push({ title: String(titles[i] ?? u), url: u, snippet: descs[i] ? String(descs[i]) : null })
    }
    return { ok: true, error: null, provider: 'Wikipedia', hits }
  } catch (e) {
    return failedOutcome(e, 'Wikipedia', proxy)
  }
}

/**
 * 搜索 + 抓正文，产出可注入模型的上下文。**从不抛错**；
 * 抓正文失败的页面保留搜索结果里的摘要（fetched=false），仍可被引用。
 * `deadline`（时间戳）用于把「搜索 + 抓正文」压在同一个总预算里。
 */
export async function webAnswerContext(
  query: string,
  opts: {
    limit?: number
    timeoutMs?: number
    fetchPages?: boolean
    proxy?: string | null
    deadline?: number
  } = {}
): Promise<WebContextResult> {
  const limit = Math.min(MAX_HITS, Math.max(1, opts.limit ?? MAX_HITS))
  const fetchPages = opts.fetchPages !== false
  const proxy = parseProxyRules(opts.proxy)
  const deadline = opts.deadline ?? Date.now() + TOTAL_BUDGET_MS
  const remaining = (): number => Math.max(200, deadline - Date.now())
  const search = await searchWeb(query, {
    limit,
    timeoutMs: opts.timeoutMs ?? Math.min(SEARCH_TIMEOUT_MS, remaining()),
    proxy
  })
  if (!search.ok) {
    return {
      ok: false,
      error: search.error,
      reason: search.reason ?? 'network',
      provider: search.provider,
      sources: [],
      text: '',
      fetched: 0
    }
  }
  if (!search.hits.length) {
    return {
      ok: true,
      error: null,
      reason: null,
      provider: search.provider,
      sources: [],
      text: '',
      fetched: 0
    }
  }
  const pages = fetchPages
    ? await Promise.all(
        search.hits
          .slice(0, MAX_PAGES)
          .map((h) => fetchPageText(h.url, Math.min(PAGE_TIMEOUT_MS, remaining()), proxy))
      )
    : []
  let fetched = 0
  const sources: WebSource[] = search.hits.map((h, i) => {
    const page = pages[i]
    if (page) fetched += 1
    const snippet = page ? page.slice(0, 1200) : h.snippet ?? null
    return {
      index: i + 1,
      title: h.title,
      url: h.url,
      site: siteOf(h.url),
      snippet,
      fetched: !!page
    }
  })
  return {
    ok: true,
    error: null,
    reason: null,
    provider: search.provider,
    sources,
    text: webContextBlock(sources),
    fetched
  }
}

/**
 * ai.ts 的统一入口：先判断开关（缺省关），再检索。
 * - off：未启用（调用方保持旧行为，不发任何外网请求）
 * - on：有来源
 * - failed：尝试过但失败，error 可读、reason 可分类
 *
 * 整段用总预算硬上限兜底：即使底层连接卡死，也一定在预算内返回可读失败，
 * 问答流程不空等、不阻塞。onProgress 用于把「搜索中 / 抓取中 / 完成」推给界面。
 */
export async function webForAnswer(
  query: string,
  enabled?: boolean,
  proxyOverride?: string | null,
  onProgress?: (p: WebProgress) => void
): Promise<WebForAnswer> {
  try {
    const on = enabled === undefined ? await getWebSearchEnabled() : !!enabled
    if (!on) return { status: 'off', error: null, reason: 'off', sources: [], text: '', fetched: 0 }
    // 显式设置优先；为空则解析系统代理（Chromium resolveProxy），仍无则直连（null）
    const configured =
      proxyOverride === undefined ? await getWebSearchProxy() : parseProxyRules(proxyOverride)
    const proxy = configured ?? (await resolveProxyRules(null, 'https://html.duckduckgo.com/html/'))
    const deadline = Date.now() + TOTAL_BUDGET_MS
    onProgress?.({ phase: 'web', done: 0, total: 1, message: '正在搜索网页…' })
    const run = async (): Promise<WebForAnswer> => {
      const out = await webAnswerContext(query, { limit: MAX_HITS, proxy, deadline })
      if (!out.ok) {
        onProgress?.({
          phase: 'web',
          done: 1,
          total: 1,
          message: `联网检索失败：${out.error ?? '未知原因'}`
        })
        return {
          status: 'failed',
          error: out.error,
          reason: out.reason ?? 'network',
          sources: [],
          text: '',
          fetched: 0
        }
      }
      if (!out.sources.length) {
        onProgress?.({ phase: 'web', done: 1, total: 1, message: '联网检索没有找到相关网页' })
        return {
          status: 'failed',
          error: '没有检索到相关网页',
          reason: 'empty',
          sources: [],
          text: '',
          fetched: 0
        }
      }
      onProgress?.({
        phase: 'web',
        done: 1,
        total: 1,
        message: `已获取 ${out.sources.length} 个网页来源（成功抓取 ${out.fetched} 个）`
      })
      return {
        status: 'on',
        error: null,
        reason: null,
        sources: out.sources,
        text: out.text,
        fetched: out.fetched
      }
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const guard = new Promise<WebForAnswer>((resolve) => {
      timer = setTimeout(() => {
        const secs = Math.round(TOTAL_BUDGET_MS / 1000)
        onProgress?.({
          phase: 'web',
          done: 1,
          total: 1,
          message: `联网检索超时（${secs} 秒）`
        })
        resolve({
          status: 'failed',
          error: proxy
            ? `检索超时（${secs} 秒内未完成）：代理 ${proxy} 可能不可用，请检查后重试`
            : `检索超时（${secs} 秒内未完成）：本机可能无外网，请在设置里填写代理后重试`,
          reason: 'timeout',
          sources: [],
          text: '',
          fetched: 0
        })
      }, TOTAL_BUDGET_MS)
    })
    const work = run().catch((e: unknown): WebForAnswer => {
      const c = classifyNetError(e, proxy)
      return { status: 'failed', error: c.message, reason: c.reason, sources: [], text: '', fetched: 0 }
    })
    try {
      return await Promise.race([work, guard])
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (e) {
    const c = classifyNetError(e, null)
    return { status: 'failed', error: c.message, reason: c.reason, sources: [], text: '', fetched: 0 }
  }
}
