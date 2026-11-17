// Zotero 精简版：从链接 / DOI / arXiv 嗅探并下载 PDF，然后入库。
// 无浏览器扩展：仅用纯逻辑嗅探 + OpenAlex 解析 + 直接下载。
import { closeSync, createWriteStream, openSync, readSync, rmSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImportPdfResult } from '../../shared/types'
import type { ImportManyOutcome, ImportUrlOutcome } from '../../shared/api'

export type FetchKind = 'doi' | 'arxiv' | 'url'

/** 与 shared/types.ImportPdfResult 结构一致（避免渲染层直接依赖主进程类型） */
export type ImportResultLike = ImportPdfResult

const UA = 'PaperDesk/0.1.0'
const RESOLVE_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 60_000
const MAX_BYTES = 80 * 1024 * 1024 // ~80MB

/** OpenAlex 端点（可用环境变量覆盖，便于镜像/离线测试） */
function oaBase(): string {
  return process.env.PAPERDESK_OPENALEX_BASE ?? 'https://api.openalex.org'
}

/** polite pool 邮箱（可用环境变量覆盖） */
function oaMailto(): string {
  return process.env.PAPERDESK_OPENALEX_MAILTO ?? 'paperdesk@example.com'
}

/** Unpaywall 端点（可用环境变量覆盖，便于镜像/离线测试） */
function unpaywallBase(): string {
  return process.env.PAPERDESK_UNPAYWALL_BASE ?? 'https://api.unpaywall.org'
}

/**
 * 批量导入输入切分（纯函数）：
 * 按换行 / 逗号 / 分号切分（不按空格，标题不在此接受），trim 后
 * 丢弃空项与以 `#` 开头的注释行，并按出现顺序去重。
 */
export function parseBulkInput(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of (text ?? '').split(/[\n\r,;]+/)) {
    const s = part.trim()
    if (!s || s.startsWith('#')) continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/** 解析输入标识符：DOI / arXiv / 普通网址 */
export function normalizeIdentifier(input: string): { kind: FetchKind; value: string } | null {
  const raw = (input ?? '').trim()
  if (!raw) return null

  // DOI：裸 DOI / doi: 前缀 / doi.org 链接（dx. 兼容）
  const doi = /^(?:doi:\s*)?(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i.exec(raw)
  if (doi) return { kind: 'doi', value: doi[1].toLowerCase() }

  // arXiv：arXiv:<id> / arxiv.org/abs/<id> / arxiv.org/pdf/<id>[.pdf]
  const arx = /^arxiv:\s*([\w.\-/]+)$/i.exec(raw)
  if (arx) return { kind: 'arxiv', value: arx[1] }
  const arxUrl = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([\w.\-/]+?)(?:\.pdf)?$/i.exec(raw)
  if (arxUrl) return { kind: 'arxiv', value: arxUrl[1] }

  // 普通网址
  if (/^https?:\/\/\S+$/i.test(raw)) return { kind: 'url', value: raw }

  return null
}

/**
 * 从 HTML 中提取候选 PDF 链接（绝对化 + 去重，按优先级返回）：
 *  (a) <meta name="citation_pdf_url" content="...">（属性顺序任意）
 *  (b) <link rel="alternate" type="application/pdf" href="...">
 *  (c) <a href="...pdf">（忽略 query/fragment）
 * 纯函数、零依赖，便于单元测试。
 */
export function extractPdfLinks(html: string, baseUrl: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (href: string | undefined): void => {
    if (!href) return
    let abs: string
    try {
      abs = new URL(href.trim(), baseUrl).toString()
    } catch {
      return
    }
    if (seen.has(abs)) return
    seen.add(abs)
    out.push(abs)
  }

  // (a) citation_pdf_url（两种属性顺序都覆盖）
  const metaNameFirst =
    /<meta\b[^>]*\bname\s*=\s*["']citation_pdf_url["'][^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*>/gi
  const metaContentFirst =
    /<meta\b[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*\bname\s*=\s*["']citation_pdf_url["'][^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = metaNameFirst.exec(html))) push(m[1])
  while ((m = metaContentFirst.exec(html))) push(m[1])

  // (b) link rel=alternate type=application/pdf
  const linkRe = /<link\b[^>]*>/gi
  while ((m = linkRe.exec(html))) {
    const tag = m[0]
    if (!/\brel\s*=\s*["']alternate["']/i.test(tag)) continue
    if (!/\btype\s*=\s*["']application\/pdf["']/i.test(tag)) continue
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)
    if (href) push(href[1])
  }

  // (c) 以 .pdf 结尾的普通链接（忽略 query / fragment）
  const aRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi
  while ((m = aRe.exec(html))) {
    const href = m[1]
    const path = href.split(/[?#]/)[0]
    if (/\.pdf$/i.test(path)) push(href)
  }

  return out
}

/** 一次解析尝试的记录：失败时把这些原因汇总给用户，而不是只给一句「未找到」 */
export interface ResolveStep {
  /** 步骤名，如「OpenAlex」「doi.org 落地页」 */
  step: string
  ok: boolean
  /** 失败原因 / 补充说明 */
  detail?: string
}

export interface ResolveOutcome {
  url: string | null
  steps: ResolveStep[]
}

/** 判断字节流开头是否是 PDF（`%PDF` 魔数，容忍前导空白）——纯函数，便于单元测试 */
export function isPdfHeader(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.length < 4) return false
  const head = Array.from(bytes.subarray(0, Math.min(bytes.length, 16)))
    .map((b) => String.fromCharCode(b))
    .join('')
  return head.replace(/^\s+/, '').startsWith('%PDF')
}

/**
 * 从网页头部元信息里找出 DOI（`citation_doi` / `DC.Identifier` 等）——纯函数。
 * 命中后可以接着走 DOI 解析，覆盖「落地页本身没有 PDF 链接」的情况。
 */
export function extractDoiFromHtml(html: string): string | null {
  const s = html ?? ''
  const nameFirst =
    /<meta\b[^>]*\bname\s*=\s*["'](?:citation_doi|dc\.identifier|DC\.Identifier)["'][^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*>/i.exec(
      s
    )
  const contentFirst =
    /<meta\b[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*\bname\s*=\s*["'](?:citation_doi|dc\.identifier|DC\.Identifier)["'][^>]*>/i.exec(
      s
    )
  const raw = (nameFirst?.[1] ?? contentFirst?.[1] ?? '').trim()
  if (!raw) return null
  const id = normalizeIdentifier(raw)
  return id && id.kind === 'doi' ? id.value : null
}

/** 把解析失败的原因压缩成一句可读的提示（纯函数） */
export function summarizeResolveFailure(
  kind: FetchKind,
  steps: ResolveStep[]
): string {
  const failed = (steps ?? []).filter((s) => !s.ok)
  if (failed.length === 0) return '未找到可下载的 PDF'
  const isNetwork = failed.every((s) =>
    /网络|超时|fetch failed|ENOTFOUND|EAI_AGAIN|aborted|ECONN|ETIMEDOUT|ECONNRESET|socket/i.test(
      s.detail ?? ''
    )
  )
  if (isNetwork) {
    return `网络请求失败：${failed[0]?.detail ?? '无法连接'}${
      kind === 'url' ? '（请检查链接是否可访问）' : '（请检查网络或代理后重试）'
    }`
  }
  return `未找到可下载的 PDF（${failed.map((s) => `${s.step}：${s.detail ?? '无结果'}`).join('；')}）`
}

/** 用户可读的错误文本（区分超时）。导出给联网检索复用，保证错误文案一致 */
export function errText(e: unknown): string {
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

/**
 * 统一 HTTP 请求：优先走 Electron 的 `net.fetch`。
 * 原因：Node 内置 fetch 不读系统代理，用户挂代理 / VPN 访问国外站点时，
 * 内置 fetch 会直接失败（表现为「导入按钮没反应」）；`net.fetch` 走系统代理与系统证书。
 * 纯 Node 环境（scripts/test-unit.ts）没有 electron，自动回退到内置 fetch。
 */
export async function httpFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    // 兼容两种打包形态：ESM 命名导出 / CJS 的 default 导出
    type NetLike = { fetch?: (u: string, o?: unknown) => Promise<Response> }
    const mod = (await import('electron')) as unknown as { net?: NetLike; default?: { net?: NetLike } }
    const net = mod.net ?? mod.default?.net
    if (net && typeof net.fetch === 'function') {
      return await net.fetch(url, init as unknown)
    }
  } catch {
    /* 非 Electron 环境（单测脚本）：走内置 fetch */
  }
  return fetch(url, init)
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await httpFetch(url, { redirect: 'follow', ...(init ?? {}), signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

type AttemptResult = string | null | { url: string | null; detail?: string }

/** 执行一次解析尝试：成功返回 URL，失败/异常都记一条 step，不向外抛 */
async function attempt(
  steps: ResolveStep[],
  step: string,
  fn: () => Promise<AttemptResult>
): Promise<string | null> {
  try {
    const r = await fn()
    const url = typeof r === 'string' ? r : (r?.url ?? null)
    const detail = r && typeof r === 'object' ? r.detail : undefined
    steps.push({ step, ok: !!url, detail: url ? (detail ?? '找到 PDF') : (detail ?? '无 PDF 链接') })
    return url ?? null
  } catch (e) {
    steps.push({ step, ok: false, detail: errText(e) })
    return null
  }
}

/** 通过 OpenAlex 解析 DOI 对应的开放获取 PDF 链接 */
async function openAlexPdf(doi: string): Promise<AttemptResult> {
  const u = new URL(`${oaBase().replace(/\/$/, '')}/works/https://doi.org/${doi}`)
  const mail = oaMailto()
  if (mail) u.searchParams.set('mailto', mail)
  const res = await fetchWithTimeout(u.toString(), RESOLVE_TIMEOUT_MS, {
    headers: { 'User-Agent': `${UA} (mailto:${mail})` }
  })
  if (!res.ok) return { url: null, detail: `HTTP ${res.status}` }
  const j = (await res.json()) as {
    best_oa_location?: { pdf_url?: string | null } | null
    locations?: Array<{ pdf_url?: string | null }> | null
  }
  const best = j?.best_oa_location?.pdf_url
  if (typeof best === 'string' && best) return best
  for (const loc of j?.locations ?? []) {
    if (typeof loc?.pdf_url === 'string' && loc.pdf_url) return loc.pdf_url
  }
  return { url: null, detail: '没有开放获取 PDF' }
}

/** Semantic Scholar 端点（可用环境变量覆盖） */
function s2Base(): string {
  return process.env.PAPERDESK_S2_BASE ?? 'https://api.semanticscholar.org'
}

/** Semantic Scholar 的 openAccessPdf（IEEE/ACM/中文期刊偶尔能命中作者自存版） */
async function semanticScholarPdf(doi: string): Promise<AttemptResult> {
  const u = `${s2Base().replace(/\/$/, '')}/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=openAccessPdf`
  const res = await fetchWithTimeout(u, RESOLVE_TIMEOUT_MS, {
    headers: { 'User-Agent': UA, Accept: 'application/json' }
  })
  if (!res.ok) return { url: null, detail: `HTTP ${res.status}` }
  const j = (await res.json()) as { openAccessPdf?: { url?: string | null } | null }
  const url = j?.openAccessPdf?.url
  return typeof url === 'string' && url ? url : { url: null, detail: '没有开放获取 PDF' }
}

/**
 * Unpaywall 要求**真实邮箱**（占位邮箱会 422），因此只在显式配置时启用，
 * 避免每次导入都白跑一次必然失败的请求。
 */
function unpaywallEmail(): string | null {
  const raw = (process.env.PAPERDESK_UNPAYWALL_EMAIL ?? '').trim()
  if (!raw || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) return null
  return raw
}

/** 通过 Unpaywall 兜底解析 DOI 的开放获取 PDF 链接 */
async function unpaywallPdf(doi: string): Promise<AttemptResult> {
  const mail = unpaywallEmail()
  if (!mail) {
    return { url: null, detail: '未配置邮箱（可用 PAPERDESK_UNPAYWALL_EMAIL 启用）' }
  }
  const u = new URL(`${unpaywallBase().replace(/\/$/, '')}/v2/${encodeURIComponent(doi)}`)
  u.searchParams.set('email', mail)
  const res = await fetchWithTimeout(u.toString(), RESOLVE_TIMEOUT_MS, {
    headers: { 'User-Agent': `${UA} (mailto:${mail})`, Accept: 'application/json' }
  })
  if (!res.ok) return { url: null, detail: `HTTP ${res.status}` }
  const j = (await res.json()) as {
    best_oa_location?: { url_for_pdf?: string | null } | null
    oa_locations?: Array<{ url_for_pdf?: string | null }> | null
  }
  const best = j?.best_oa_location?.url_for_pdf
  if (typeof best === 'string' && best) return best
  for (const loc of j?.oa_locations ?? []) {
    if (typeof loc?.url_for_pdf === 'string' && loc.url_for_pdf) return loc.url_for_pdf
  }
  return { url: null, detail: '没有开放获取 PDF' }
}

/** Crossref 端点（可用环境变量覆盖） */
function crossrefBase(): string {
  return process.env.PAPERDESK_CROSSREF_BASE ?? 'https://api.crossref.org'
}

/** Crossref 元数据里的 `link`（部分出版社给出可直接下载的 PDF 链接） */
async function crossrefPdf(doi: string): Promise<AttemptResult> {
  const u = `${crossrefBase().replace(/\/$/, '')}/works/${encodeURIComponent(doi)}`
  const res = await fetchWithTimeout(u, RESOLVE_TIMEOUT_MS, {
    headers: { 'User-Agent': `${UA} (mailto:${oaMailto()})`, Accept: 'application/json' }
  })
  if (!res.ok) return { url: null, detail: `HTTP ${res.status}` }
  const j = (await res.json()) as {
    message?: { link?: Array<{ URL?: string; 'content-type'?: string }> | null } | null
  }
  for (const l of j?.message?.link ?? []) {
    if (l?.URL && /pdf/i.test(l['content-type'] ?? '')) return l.URL
  }
  return { url: null, detail: '元数据里没有 PDF 链接' }
}

/**
 * DOI 落地页：跟随 doi.org 重定向到出版社页面后嗅探 PDF 链接。
 * 出版社普遍提供 `citation_pdf_url`（Zotero/浏览器插件也靠它），
 * 即使需要机构权限，也能把「正确地址」交给下载步骤，由下载步骤给出明确错误。
 */
async function doiLandingPdf(doi: string): Promise<AttemptResult> {
  const res = await fetchWithTimeout(`https://doi.org/${doi}`, RESOLVE_TIMEOUT_MS, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }
  })
  if (!res.ok) return { url: null, detail: `HTTP ${res.status}` }
  const ct = res.headers.get('content-type') ?? ''
  if (/pdf/i.test(ct)) return { url: res.url, detail: '落地页直接返回 PDF' }
  const html = await res.text()
  const links = extractPdfLinks(html, res.url)
  return links.length
    ? { url: links[0], detail: '页面内 citation_pdf_url / PDF 链接' }
    : { url: null, detail: '页面未发现 PDF 链接' }
}

/** DOI 内容协商：`Accept: application/pdf` 直接要求 PDF（部分出版社支持） */
async function doiNegotiatedPdf(doi: string): Promise<AttemptResult> {
  const res = await fetchWithTimeout(`https://doi.org/${doi}`, RESOLVE_TIMEOUT_MS, {
    method: 'HEAD',
    headers: { 'User-Agent': UA, Accept: 'application/pdf' }
  })
  if (!res.ok) return { url: null, detail: `HTTP ${res.status}` }
  const ct = res.headers.get('content-type') ?? ''
  return /pdf/i.test(ct) ? res.url : { url: null, detail: '出版社不返回 PDF' }
}

/** DOI → 依次尝试各来源，返回第一个可下载链接 + 每个来源的尝试记录 */
async function resolveDoiDetailed(doi: string): Promise<ResolveOutcome> {
  const steps: ResolveStep[] = []
  let url = await attempt(steps, 'OpenAlex', () => openAlexPdf(doi))
  if (!url) url = await attempt(steps, 'Semantic Scholar', () => semanticScholarPdf(doi))
  if (!url) url = await attempt(steps, 'Unpaywall', () => unpaywallPdf(doi))
  if (!url) url = await attempt(steps, 'doi.org 落地页', () => doiLandingPdf(doi))
  if (!url) url = await attempt(steps, 'DOI 内容协商', () => doiNegotiatedPdf(doi))
  if (!url) url = await attempt(steps, 'Crossref 链接', () => crossrefPdf(doi))
  return { url, steps }
}

/** 网页链接 → 抓页面嗅探；页面只给了 DOI 时再走 DOI 解析 */
async function resolveUrlDetailed(value: string): Promise<ResolveOutcome> {
  const steps: ResolveStep[] = []
  if (/\.pdf(?:[?#].*)?$/i.test(value)) {
    steps.push({ step: '直链', ok: true, detail: '输入即为 PDF 链接' })
    return { url: value, steps }
  }
  let pageDoi: string | null = null
  const direct = await attempt(steps, '页面嗅探', async () => {
    const res = await fetchWithTimeout(value, RESOLVE_TIMEOUT_MS, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' }
    })
    if (!res.ok) return { url: null, detail: `HTTP ${res.status}` }
    const ct = res.headers.get('content-type') ?? ''
    if (/pdf/i.test(ct)) return { url: res.url, detail: '响应即 PDF' }
    const html = await res.text()
    pageDoi = extractDoiFromHtml(html)
    const links = extractPdfLinks(html, res.url)
    if (links.length) return { url: links[0], detail: '页面内找到 PDF 链接' }
    return {
      url: null,
      detail: pageDoi ? `页面元数据 DOI ${pageDoi}` : '页面未发现 PDF 链接'
    }
  })
  if (direct) return { url: direct, steps }
  if (pageDoi) {
    const doiOutcome = await resolveDoiDetailed(pageDoi)
    for (const s of doiOutcome.steps) steps.push({ ...s, step: `DOI ${pageDoi} · ${s.step}` })
    return { url: doiOutcome.url, steps }
  }
  return { url: null, steps }
}

/** 解析可下载的 PDF 链接，并保留每一步的尝试记录（失败原因可展示） */
export async function resolvePdfUrlDetailed(input: string): Promise<ResolveOutcome> {
  const id = normalizeIdentifier(input)
  if (!id) {
    return { url: null, steps: [{ step: '识别输入', ok: false, detail: '无法识别的 DOI / arXiv / 链接' }] }
  }
  if (id.kind === 'arxiv') {
    return {
      url: `https://arxiv.org/pdf/${id.value}`,
      steps: [{ step: 'arXiv', ok: true, detail: 'arxiv.org/pdf' }]
    }
  }
  if (id.kind === 'doi') return resolveDoiDetailed(id.value)
  return resolveUrlDetailed(id.value)
}

/** 解析可下载的 PDF 链接；任何失败都返回 null（不向外抛出） */
export async function resolvePdfUrl(input: string): Promise<string | null> {
  try {
    return (await resolvePdfUrlDetailed(input)).url
  } catch {
    return null
  }
}

/** 下载到 os.tmpdir() 下的临时文件（限制大小/时长/跟随重定向），失败清理部分产物 */
async function downloadToTemp(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS, {
    headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!res.body) throw new Error('响应体为空')

  const tmp = join(tmpdir(), `paperdesk-${randomUUID()}.pdf`)
  let total = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb): void {
      total += chunk.length
      if (total > MAX_BYTES) {
        cb(new Error('PDF 文件过大（超过 80MB）'))
        return
      }
      cb(null, chunk)
    }
  })
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      limiter,
      createWriteStream(tmp)
    )
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  // 校验内容确实是 PDF：出版社常把「登录页 / 反爬拦截页」以 200 返回 HTML，
  // 直接入库会得到损坏的 PDF，且用户完全看不出原因。
  if (!fileLooksLikePdf(tmp)) {
    rmSync(tmp, { force: true })
    throw new Error(
      `下载到的内容不是 PDF（可能被出版商拦截、需要机构登录，或链接已失效）：${url}`
    )
  }
  return tmp
}

/** 读文件头 16 字节判断是否是 PDF（读取失败按「不是」处理，避免把 HTML 入库） */
function fileLooksLikePdf(path: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(16)
    const n = readSync(fd, head, 0, 16, 0)
    return isPdfHeader(head.subarray(0, Math.max(n, 0)))
  } catch {
    return false
  } finally {
    if (fd != null) {
      try {
        closeSync(fd)
      } catch {
        /* 忽略 */
      }
    }
  }
}

/**
 * 从链接 / DOI 导入 PDF：解析 → 下载 → 入库，返回结果消息。
 * 非 PDF 内容会由 importPdfFromPath 抛出，这里统一转为「下载失败」。
 * DOI 已存在或文件内容重复时直接跳过（skipped: true），不改动既有条目的分组。
 */
export type ImportFromUrlResult = ImportUrlOutcome

/** 归一化 DOI 用于去重比较：去掉 doi.org 前缀并小写 */
function normalizeDoiForLookup(doi: string): string {
  return doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase()
}

/** 查询文库中是否已有该 DOI 的条目（失败则视为不存在，不阻断导入） */
async function findExistingItemByDoi(doi: string): Promise<number | null> {
  try {
    const { getDb } = await import('../db')
    const row = getDb()
      .prepare("SELECT id FROM items WHERE lower(replace(doi,'https://doi.org/','')) = ?")
      .get(normalizeDoiForLookup(doi)) as { id: number } | undefined
    return row ? row.id : null
  } catch {
    return null
  }
}

export async function importFromUrl(
  input: string,
  group?: string | null
): Promise<ImportFromUrlResult> {
  const id = normalizeIdentifier(input)
  if (!id) {
    return {
      ok: false,
      message: '无法识别的链接或 DOI（支持 10.xxxx/… DOI、arXiv 编号、http(s) 链接）',
      itemIds: []
    }
  }

  // DOI 去重：文库中已有同 DOI 的条目则跳过下载
  if (id.kind === 'doi') {
    const existingId = await findExistingItemByDoi(id.value)
    if (existingId != null) {
      return {
        ok: true,
        message: '已存在（跳过下载）',
        skipped: true,
        itemId: existingId,
        itemIds: [],
        result: { skipped: true, itemId: existingId }
      }
    }
  }

  const outcome = await resolvePdfUrlDetailed(input)
  const attempts = outcome.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.step}：${s.detail ?? ''}`)
  if (!outcome.url) {
    // 不再静默失败：把每个来源的具体原因（HTTP 状态 / 无 OA / 未发现链接）告诉用户
    return { ok: false, message: summarizeResolveFailure(id.kind, outcome.steps), attempts, itemIds: [] }
  }
  const pdfUrl = outcome.url

  let tmp: string | undefined
  try {
    tmp = await downloadToTemp(pdfUrl)
    const { importPdfFromPath, extractAndAutoRename } = await import('../ipc/library')
    const result = importPdfFromPath(tmp, group)
    // 同一文件内容已入库：按跳过处理，既不重复建条目也不改旧条目分组（PD02）
    if (result.duplicate) {
      return {
        ok: true,
        message: '已存在（跳过重复文件）',
        skipped: true,
        itemId: result.item.id,
        itemIds: [],
        pdfUrl,
        attempts,
        result
      }
    }
    // 等标题/领域识别完成再返回，单条链接导入也能立即显示标签
    await extractAndAutoRename(result.attachment.id, result.item.title, '自动识别元数据失败')
    return {
      ok: true,
      message: '已导入',
      itemId: result.item.id,
      itemIds: [result.item.id],
      pdfUrl,
      attempts,
      result
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { ok: false, message: `下载失败：${reason}`, pdfUrl, attempts, itemIds: [] }
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* 忽略清理失败 */
      }
    }
  }
}

/** 批量导入结果（itemIds 只含本次新增条目，见 shared/api.ts 的 PD02 口径） */
export type ImportManyResult = ImportManyOutcome

/**
 * 批量导入：从多行文本解析出多个 DOI / arXiv / 链接，逐个调用 importFromUrl。
 * 采用有界并发（2）避免瞬时打满网络；未知输入计为失败。
 */
export async function importManyFromUrls(
  text: string,
  group?: string | null
): Promise<ImportManyResult> {
  const inputs = parseBulkInput(text)
  if (inputs.length === 0) {
    return {
      ok: false,
      total: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      message: '没有可导入的链接或 DOI',
      itemIds: [],
      results: []
    }
  }

  const results = new Array<ImportManyOutcome['results'][number]>(inputs.length)
  // 并发完成顺序不参与归属：按输入下标暂存，最后按原顺序汇总（PD02）
  const idsByIndex = new Array<number[]>(inputs.length)
  let imported = 0
  let skipped = 0
  let failed = 0
  let next = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= inputs.length) return
      const input = inputs[i]
      let ok = false
      let message = ''
      let wasSkipped = false
      let itemId: number | undefined
      let newIds: number[] = []
      try {
        const r = await importFromUrl(input, group)
        ok = r.ok
        message = r.message
        wasSkipped = !!r.skipped || !!(r.result as { skipped?: boolean } | undefined)?.skipped
        itemId = r.itemId
        newIds = r.itemIds ?? []
      } catch (e) {
        message = `导入失败：${e instanceof Error ? e.message : String(e)}`
      }
      if (ok && wasSkipped) skipped++
      else if (ok) imported++
      else failed++
      idsByIndex[i] = ok && !wasSkipped ? newIds : []
      results[i] = {
        input,
        ok,
        message,
        ...(itemId != null ? { itemId } : {}),
        ...(ok && wasSkipped ? { skipped: true } : {})
      }
    }
  }

  const lanes = Math.min(2, inputs.length)
  await Promise.all(Array.from({ length: lanes }, () => worker()))

  const firstFailure = results.find((r) => !r.ok)
  // 汇总本次新增 id（按输入顺序去重；本文件要能被 node 直接执行，避免运行时依赖 shared/api）
  const seenIds = new Set<number>()
  const itemIds: number[] = []
  for (const ids of idsByIndex) {
    for (const id of ids ?? []) {
      if (!Number.isInteger(id) || id <= 0 || seenIds.has(id)) continue
      seenIds.add(id)
      itemIds.push(id)
    }
  }
  return {
    ok: failed === 0 && imported + skipped > 0,
    total: inputs.length,
    imported,
    skipped,
    failed,
    // 失败时带一条例子的具体原因，避免只看到「失败 3」却不知道为什么
    message: `成功 ${imported} · 跳过 ${skipped} · 失败 ${failed}${
      firstFailure ? `（例：${firstFailure.message}）` : ''
    }`,
    itemIds,
    results
  }
}
