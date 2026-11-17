import { oaGet, shortId, stripDoi } from './discovery'
import { getDb } from '../db'
import { effective } from './settings'
import { writeFileSync } from 'node:fs'
import type { WorkHit } from '../../shared/types'
import {
  CITATION_SOURCE_LABEL,
  emptyCitationRecord,
  resolveCitationMatch,
  type CitationCandidate,
  type CitationRecord,
  type CitationStatus,
  type CitationTarget
} from '../../shared/publication'
import { mapScholarResults, pickBestWork } from '../../shared/scholar'
import { mapSemanticResults, semanticYearParam } from '../../shared/semantic-scholar'

export interface WorkSearchOptions {
  yearFrom?: number | null
  yearTo?: number | null
  minCited?: number | null
  oaOnly?: boolean
  /** 页码（从 1 开始）；每页 25 */
  page?: number
  /** 检索方式：关键词 / 作者 / DOI（精确） */
  mode?: 'keyword' | 'author' | 'doi'
  /**
   * 排序：
   * - relevance（默认）：按相关度/OpenAlex 默认排序
   * - cited：按被引降序（经典/影响力优先）
   * - recent：按发表时间降序（找最新论文；Google 用 sort_by=date，Crossref sort=published）
   */
  sort?: 'relevance' | 'cited' | 'recent'
  /**
   * 检索来源：
   * - auto（默认）：OpenAlex 为主，Crossref 兜底
   * - google：Google Scholar（需要 SerpAPI Key；没有 Key 时返回空 + 提示）
   * - openalex：只用 OpenAlex
   */
  provider?: 'auto' | 'google' | 'semantic' | 'openalex'
}

export interface WorkSearchResult {
  results: WorkHit[]
  total: number
  source: 'openalex' | 'crossref' | 'google' | 'semantic'
  warnings: string[]
}

const PER_PAGE = 25
const SELECT =
  'id,doi,display_name,publication_year,cited_by_count,primary_location,authorships,open_access,best_oa_location,abstract_inverted_index'

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 还原 OpenAlex 的摘要（倒排索引 → 文本） */
function abstractFromInverted(inv: Record<string, number[]> | null | undefined): string | null {
  if (!inv || typeof inv !== 'object') return null
  const pairs: Array<[number, string]> = []
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions ?? []) pairs.push([Number(p), word])
  }
  if (pairs.length === 0) return null
  pairs.sort((a, b) => a[0] - b[0])
  return pairs.map(([, w]) => w).join(' ')
}

function toHit(w: any): WorkHit {
  const authors = (w.authorships ?? [])
    .map((a: any) => a?.author?.display_name)
    .filter(Boolean)
    .slice(0, 8) as string[]
  const best = w.best_oa_location ?? null
  const oaUrl = best?.pdf_url ?? best?.landing_page_url ?? w.open_access?.oa_url ?? null
  return {
    id: shortId(w.id),
    doi: stripDoi(w.doi),
    title: w.display_name ?? w.title ?? null,
    year: w.publication_year ?? null,
    venue: w.primary_location?.source?.display_name ?? w.host_venue?.display_name ?? null,
    citedBy: w.cited_by_count ?? 0,
    authors,
    oaUrl: typeof oaUrl === 'string' ? oaUrl : null,
    isOa: !!w.open_access?.is_oa || !!best,
    abstract: abstractFromInverted(w.abstract_inverted_index),
    source: 'openalex'
  }
}




const S2_FIELDS =
  'title,year,venue,citationCount,authors,externalIds,openAccessPdf,abstract,url'

async function searchSemanticScholar(
  q: string,
  opts: WorkSearchOptions
): Promise<WorkSearchResult> {
  const base = effective(
    'semantic.base',
    'PAPERDESK_S2_BASE',
    'https://api.semanticscholar.org/graph/v1'
  ).replace(/\/$/, '')
  const key = effective('semantic.apiKey', 'PAPERDESK_S2_KEY', '').trim()
  const headers: Record<string, string> = {}
  if (key) headers['x-api-key'] = key
  const warnings: string[] = []

  // DOI 精确：/paper/DOI:<doi>
  if ((opts.mode ?? 'keyword') === 'doi') {
    const doi = q.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim()
    const u = new URL(`${base}/paper/DOI:${encodeURIComponent(doi)}`)
    u.searchParams.set('fields', S2_FIELDS)
    const res = await fetch(u.toString(), { headers })
    if (res.status === 404) {
      return { results: [], total: 0, source: 'semantic', warnings: ['没有找到该 DOI 对应的论文'] }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const one = (await res.json()) as Record<string, unknown>
    const results = mapSemanticResults([one])
    return { results, total: results.length, source: 'semantic', warnings }
  }

  const page = Math.max(1, opts.page ?? 1)
  const per = 20
  const u = new URL(`${base}/paper/search`)
  u.searchParams.set('query', q)
  u.searchParams.set('limit', String(per))
  u.searchParams.set('offset', String((page - 1) * per))
  u.searchParams.set('fields', S2_FIELDS)
  const year = semanticYearParam(opts.yearFrom, opts.yearTo)
  if (year) u.searchParams.set('year', year)

  let res = await fetch(u.toString(), { headers })
  // 免费额度下 429 很常见：短暂退避后重试一次
  if (res.status === 429) {
    warnings.push('Semantic Scholar 触发限流（429），已重试一次；配置 API Key 可提高配额')
    await new Promise((r) => setTimeout(r, 1500))
    res = await fetch(u.toString(), { headers })
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { total?: number; data?: unknown[] }
  let results = mapSemanticResults(data.data ?? [])
  if (opts.minCited) {
    results = results.filter((r) => r.citedBy >= (opts.minCited as number))
    warnings.push('Semantic Scholar 不支持服务端「最少被引」筛选：已按当前页结果过滤')
  }
  if (opts.oaOnly) {
    results = results.filter((r) => r.isOa)
    warnings.push('Semantic Scholar 的开放获取只来自 openAccessPdf：已按当前页过滤')
  }
  // Semantic 的免费搜索接口不提供服务端排序：在当前页内按年份/被引重排。
  if (opts.sort === 'recent') {
    results = [...results].sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    warnings.push('Semantic Scholar 不支持服务端「最新」排序：已按当前页结果按年份重排')
  } else if (opts.sort === 'cited') {
    results = [...results].sort((a, b) => (b.citedBy ?? 0) - (a.citedBy ?? 0))
  }
  return {
    results,
    total: Number(data.total ?? 0) || results.length,
    source: 'semantic',
    warnings
  }
}

async function searchGoogleScholar(
  q: string,
  opts: WorkSearchOptions
): Promise<WorkSearchResult> {
  const key = effective('scholar.apiKey', 'PAPERDESK_SERPAPI_KEY', '').trim()
  if (!key) {
    return {
      results: [],
      total: 0,
      source: 'google',
      warnings: [
        '未配置 Google Scholar（SerpAPI）Key；可先点「在 Google Scholar 打开」用浏览器检索，' +
          '或到「设置 → 其他」填入 SerpAPI Key。'
      ]
    }
  }
  const base = effective(
    'scholar.base',
    'PAPERDESK_SERPAPI_BASE',
    'https://serpapi.com/search.json'
  )
  const u = new URL(base)
  const page = Math.max(1, opts.page ?? 1)
  const per = 20
  u.searchParams.set('engine', 'google_scholar')
  u.searchParams.set('q', q)
  u.searchParams.set('api_key', key)
  u.searchParams.set('num', String(per))
  u.searchParams.set('start', String((page - 1) * per))
  if (opts.yearFrom) u.searchParams.set('as_ylo', String(opts.yearFrom))
  if (opts.yearTo) u.searchParams.set('as_yhi', String(opts.yearTo))
  // Google Scholar 只支持 relevance/date 两种排序；找最新论文时用 date
  if (opts.sort === 'recent') u.searchParams.set('sort_by', 'date')

  const res = await fetch(u.toString())
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as {
    organic_results?: any[]
    search_information?: { total_results?: number }
    error?: string
  }
  if (data.error) throw new Error(String(data.error))
  let results = mapScholarResults(data.organic_results ?? [])
  const warnings: string[] = []
  if (opts.minCited) {
    results = results.filter((r) => r.citedBy >= (opts.minCited as number))
    warnings.push('Google Scholar 不支持服务端「最少被引」筛选：已按当前页结果过滤')
  }
  if (opts.oaOnly) {
    results = results.filter((r) => r.isOa)
    warnings.push('Google Scholar 的开放获取标记只来自结果中的 PDF 链接：已按当前页过滤')
  }
  const total = Number(data.search_information?.total_results ?? 0) || results.length
  return { results, total, source: 'google', warnings }
}

/** 关键词检索论文（OpenAlex 为主，失败回退 Crossref） */
export async function searchWorks(
  query: string,
  opts: WorkSearchOptions = {}
): Promise<WorkSearchResult> {
  const q = (query ?? '').trim()
  if (!q) return { results: [], total: 0, source: 'openalex', warnings: ['请输入检索内容'] }
  const warnings: string[] = []
  const mode = opts.mode ?? 'keyword'

  // ---- Google Scholar（SerpAPI）----
  // Google Scholar 没有官方 API；直接抓取会被 CAPTCHA/封 IP，且违反 ToS。
  // 这里只走用户自己配置的 SerpAPI Key；没有 Key 时明确提示去浏览器打开。
  if ((opts.provider ?? 'auto') === 'google') {
    try {
      return await searchGoogleScholar(q, opts)
    } catch (e) {
      return {
        results: [],
        total: 0,
        source: 'google',
        warnings: [`Google Scholar 检索失败：${msg(e)}`]
      }
    }
  }

  // ---- Semantic Scholar（免费 API；有 Key 时配额更高）----
  if ((opts.provider ?? 'auto') === 'semantic') {
    try {
      return await searchSemanticScholar(q, opts)
    } catch (e) {
      return {
        results: [],
        total: 0,
        source: 'semantic',
        warnings: [`Semantic Scholar 检索失败：${msg(e)}`]
      }
    }
  }

  // ---- DOI 精确检索 ----
  if (mode === 'doi') {
    const doi = q.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim()
    try {
      const data = await oaGet('/works', { filter: `doi:${doi}`, select: SELECT })
      const results = (data?.results ?? []).map(toHit)
      if (results.length === 0) warnings.push('没有找到该 DOI 对应的论文')
      return { results, total: results.length, source: 'openalex', warnings }
    } catch (e) {
      warnings.push(`DOI 检索失败：${msg(e)}`)
      return { results: [], total: 0, source: 'openalex', warnings }
    }
  }

  const filters: string[] = []

  // ---- 作者检索：先解析作者 id，再取其论文（按被引） ----
  if (mode === 'author') {
    try {
      const a = await oaGet('/authors', { search: q, per_page: 1 })
      const author = a?.results?.[0]
      if (!author?.id) {
        warnings.push('没有找到该作者')
        return { results: [], total: 0, source: 'openalex', warnings }
      }
      const authorId = shortId(author.id)
      filters.push(`authorships.author.id:${authorId}`)
      warnings.push(`作者：${author.display_name ?? q}`)
    } catch (e) {
      warnings.push(`作者解析失败：${msg(e)}`)
      return { results: [], total: 0, source: 'openalex', warnings }
    }
  }

  if (opts.yearFrom) filters.push(`from_publication_date:${opts.yearFrom}-01-01`)
  if (opts.yearTo) filters.push(`to_publication_date:${opts.yearTo}-12-31`)
  if (opts.minCited) filters.push(`cited_by_count:>${Math.max(0, opts.minCited - 1)}`)
  if (opts.oaOnly) filters.push('is_oa:true')
  const page = Math.max(1, opts.page ?? 1)
  const sortParam =
    opts.sort === 'recent'
      ? 'publication_date:desc'
      : opts.sort === 'cited'
        ? 'cited_by_count:desc'
        : ''

  try {
    const data = await oaGet('/works', {
      ...(mode === 'keyword' ? { search: q } : {}),
      filter: filters.join(','),
      ...(sortParam ? { sort: sortParam } : {}),
      page,
      per_page: PER_PAGE,
      select: SELECT
    })
    const results = (data?.results ?? []).map(toHit)
    return { results, total: Number(data?.meta?.count ?? results.length), source: 'openalex', warnings }
  } catch (e) {
    warnings.push(`OpenAlex 检索失败，改用 Crossref：${msg(e)}`)
  }

  // Crossref 回退（无摘要/被引细节，字段尽量补齐）
  try {
    const base = effective('crossref.base', 'PAPERDESK_CROSSREF_BASE', 'https://api.crossref.org')
    const mailto = effective('openalex.mailto', 'PAPERDESK_OPENALEX_MAILTO', '')
    const u = new URL(base.replace(/\/$/, '') + '/works')
    u.searchParams.set('query.bibliographic', q)
    u.searchParams.set('rows', String(PER_PAGE))
    u.searchParams.set('offset', String((page - 1) * PER_PAGE))
    if (mailto) u.searchParams.set('mailto', mailto)
    if (opts.sort === 'recent') {
      u.searchParams.set('sort', 'published')
      u.searchParams.set('order', 'desc')
    } else if (opts.sort === 'cited') {
      u.searchParams.set('sort', 'is-referenced-by-count')
      u.searchParams.set('order', 'desc')
    }
    const res = await fetch(u.toString())
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { message?: { items?: any[]; 'total-results'?: number } }
    const results = (data.message?.items ?? []).map(
      (w: any): WorkHit => ({
        id: String(w.DOI ?? w.URL ?? ''),
        doi: w.DOI ?? null,
        title: (w.title ?? [])[0] ?? null,
        year: w.issued?.['date-parts']?.[0]?.[0] ?? null,
        venue: (w['container-title'] ?? [])[0] ?? null,
        citedBy: w['is-referenced-by-count'] ?? 0,
        authors: (w.author ?? [])
          .map((a: any) => [a.given, a.family].filter(Boolean).join(' '))
          .filter(Boolean)
          .slice(0, 8),
        oaUrl: w.link?.find((l: any) => l['content-type'] === 'application/pdf')?.URL ?? null,
        isOa: false,
        source: 'crossref'
      })
    )
    return {
      results,
      total: Number(data.message?.['total-results'] ?? results.length),
      source: 'crossref',
      warnings
    }
  } catch (e) {
    warnings.push(`Crossref 检索失败：${msg(e)}`)
    return { results: [], total: 0, source: 'crossref', warnings }
  }
}

/** 导出某条结果的 PDF：选择保存位置 → 下载 → 写入（不加入文库） */
export async function saveWorkPdf(url: string, defaultName: string): Promise<string | null> {
  const u = (url ?? '').trim()
  if (!u) throw new Error('该条没有可下载的 PDF 链接')
  const { dialog } = await import('electron')
  const safe = (defaultName || 'paper').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
  const res = await dialog.showSaveDialog({
    title: '导出 PDF',
    defaultPath: `${safe}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (res.canceled || !res.filePath) return null
  const r = await fetch(u, { headers: { 'User-Agent': 'PaperDesk/0.1.0' } })
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  writeFileSync(res.filePath, buf)
  return res.filePath
}

/* ==================== 单篇被引：手动查询 + 本地记录（阶段四） ==================== */

/**
 * 契约：
 *  - `getCitationRecord`：**只读本地**，详情页打开/切换/重启都只调它，绝不联网。
 *  - `queryCitation`：只有用户点「查询被引次数 / 刷新」才调用，只走 SerpAPI 的
 *    Google Scholar 接口（不抓网页），结果写 `item_citations`。
 *  - 失败不覆盖上次成功记录：`queryCitation` 返回合并后的记录，`lastError` 单独标注。
 *  - 未配置 Key 时不发请求，状态 unconfigured，提示去设置。
 *  - 多候选无法确定时状态 ambiguous，候选一并存下，由用户点选；绝不写入别篇的次数。
 */
const citationPending = new Map<number, Promise<CitationRecord>>()

const CITATION_SOURCE = 'Google Scholar，经 SerpAPI'

interface CitationRow {
  item_id: number
  status: string
  count: number | null
  source: string | null
  matched_title: string | null
  matched_id: string | null
  queried_at: string | null
  last_attempt_at: string | null
  last_error: string | null
  candidates_json: string | null
}

function parseCandidates(raw: string | null): CitationCandidate[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as CitationCandidate[]).slice(0, 5) : []
  } catch {
    return []
  }
}

function rowToRecord(row: CitationRow): CitationRecord {
  const status = String(row.status ?? 'never') as CitationStatus
  return {
    itemId: row.item_id,
    status: status === ('pending' as CitationStatus) ? 'never' : status,
    count: row.count == null ? null : Number(row.count),
    source: row.source ?? CITATION_SOURCE,
    matchedTitle: row.matched_title ?? null,
    matchedId: row.matched_id ?? null,
    queriedAt: row.queried_at ?? null,
    lastError: row.last_error ?? null,
    lastAttemptAt: row.last_attempt_at ?? null,
    candidates: parseCandidates(row.candidates_json)
  }
}

/** 只读本地被引记录；没有记录时 status='never'（界面显示「尚未查询」） */
export function getCitationRecord(itemId: number): CitationRecord {
  const row = getDb()
    .prepare('SELECT * FROM item_citations WHERE item_id = ?')
    .get(itemId) as CitationRow | undefined
  return row ? rowToRecord(row) : emptyCitationRecord(itemId)
}

function saveCitationRecord(rec: CitationRecord): CitationRecord {
  getDb()
    .prepare(
      `INSERT INTO item_citations
        (item_id, status, count, source, matched_title, matched_id, queried_at, last_attempt_at, last_error, candidates_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         status=excluded.status, count=excluded.count, source=excluded.source,
         matched_title=excluded.matched_title, matched_id=excluded.matched_id,
         queried_at=excluded.queried_at, last_attempt_at=excluded.last_attempt_at,
         last_error=excluded.last_error, candidates_json=excluded.candidates_json`
    )
    .run(
      rec.itemId,
      rec.status,
      rec.count,
      rec.source,
      rec.matchedTitle,
      rec.matchedId,
      rec.queriedAt ?? new Date().toISOString(),
      rec.lastAttemptAt ?? new Date().toISOString(),
      rec.lastError,
      rec.candidates.length ? JSON.stringify(rec.candidates) : null
    )
  return getCitationRecord(rec.itemId)
}

/** SerpAPI 原始 organic_results → 候选（保留「接口未提供次数」这一状态） */
export function scholarCandidatesFromResults(raw: unknown[]): CitationCandidate[] {
  const hits = mapScholarResults(raw)
  return (raw ?? []).map((item, i) => {
    const hit = hits[i]
    const r = (item ?? {}) as {
      result_id?: string
      inline_links?: { cited_by?: { total?: number } }
      link?: string
    }
    const rawTotal = r.inline_links?.cited_by?.total
    const count = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : null
    return {
      id: hit?.id ?? `scholar:${r.result_id ?? r.link ?? i}`,
      title: hit?.title ?? '（无标题）',
      count,
      year: hit?.year ?? null,
      authors: hit?.authors ?? [],
      venue: hit?.venue ?? null,
      doi: hit?.doi ?? null
    }
  })
}

function candidateAsHit(c: CitationCandidate): WorkHit {
  return {
    id: c.id,
    doi: c.doi,
    title: c.title,
    year: c.year,
    venue: c.venue,
    citedBy: c.count ?? 0,
    authors: c.authors,
    oaUrl: null,
    isOa: false,
    source: 'google'
  }
}

function errorText(e: unknown): string {
  const s = msg(e)
  const status = /HTTP (\d{3})/.exec(s)?.[1]
  if (status === '401' || status === '403') return `SerpAPI 鉴权失败（HTTP ${status}）：Key 无效或无权限，请在「设置 → 其他」重新填写`
  if (status === '429') return 'SerpAPI 限流（HTTP 429）：请稍后再试'
  if (status && status.startsWith('5')) return `SerpAPI 服务异常（HTTP ${status}）：请稍后再试`
  if (/abort|timeout|timed out/i.test(s)) return '查询超时：请检查网络或代理后重试'
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(s)) return `网络错误，未能连接 SerpAPI：${s}`
  return `被引查询失败：${s}`
}

export interface CitationQueryOutcome {
  record: CitationRecord
  /** 本次未发起请求时的原因（未配置 Key / 正在查询） */
  skipped?: string
}

/**
 * 联网查询被引次数（仅 SerpAPI Google Scholar）。
 * 并发保护：同一篇正在查询时复用同一个 Promise，避免连点打满配额。
 */
export function queryCitation(
  itemId: number,
  opts: { force?: boolean; candidateId?: string } = {}
): Promise<CitationRecord> {
  const running = citationPending.get(itemId)
  if (running) return running
  const task = runQuery(itemId, opts).finally(() => citationPending.delete(itemId))
  citationPending.set(itemId, task)
  return task
}

async function runQuery(
  itemId: number,
  opts: { force?: boolean; candidateId?: string }
): Promise<CitationRecord> {
  const db = getDb()
  const item = db
    .prepare('SELECT title, doi, year FROM items WHERE id = ?')
    .get(itemId) as { title: string | null; doi: string | null; year: number | null } | undefined
  if (!item) throw new Error('条目不存在')
  const prev = getCitationRecord(itemId)
  const title = (item.title ?? '').trim()
  const doi = (item.doi ?? '').trim() || null
  const authors = authorNamesOf(itemId)
  const target: CitationTarget = { title: title || null, doi, year: item.year ?? null, authors }

  // 未配置 Key：不发任何请求，明确提示去设置
  const key = effective('scholar.apiKey', 'PAPERDESK_SERPAPI_KEY', '').trim()
  if (!key) {
    return saveCitationRecord({
      ...emptyCitationRecord(itemId),
      status: 'unconfigured',
      lastError: '未配置 SerpAPI Key，无法查询被引次数；请在「设置 → 其他」填写后重试',
      queriedAt: prev.queriedAt,
      count: prev.count,
      matchedTitle: prev.matchedTitle,
      matchedId: prev.matchedId,
      lastAttemptAt: new Date().toISOString()
    })
  }
  if (!title && !doi) {
    return saveCitationRecord({
      ...emptyCitationRecord(itemId),
      status: 'not_found',
      lastError: '缺少标题与 DOI，无法匹配论文',
      lastAttemptAt: new Date().toISOString(),
      queriedAt: prev.queriedAt,
      count: prev.count
    })
  }
  const query = doi ? `"${doi}"` : title
  const baseUrl = effective('scholar.base', 'PAPERDESK_SERPAPI_BASE', 'https://serpapi.com/search.json')
  const u = new URL(baseUrl)
  u.searchParams.set('engine', 'google_scholar')
  u.searchParams.set('q', query)
  u.searchParams.set('num', '10')
  u.searchParams.set('api_key', key)

  try {
    const res = await fetch(u.toString(), { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { organic_results?: unknown[]; error?: string }
    if (data.error) throw new Error(String(data.error))
    const candidates = scholarCandidatesFromResults(data.organic_results ?? [])
    if (candidates.length === 0) {
      return saveCitationRecord({
        itemId,
        status: 'not_found',
        count: prev.count,
        source: CITATION_SOURCE,
        matchedTitle: prev.matchedTitle,
        matchedId: prev.matchedId,
        queriedAt: prev.queriedAt,
        lastAttemptAt: new Date().toISOString(),
        lastError: null,
        candidates: []
      })
    }
    const picked = opts.candidateId
      ? candidates.find((c) => c.id === opts.candidateId) ?? null
      : null
    const resolved: {
      kind: 'matched' | 'ambiguous' | 'none'
      chosen: CitationCandidate | null
      candidates: CitationCandidate[]
    } = picked
      ? { kind: 'matched', chosen: picked, candidates: [] }
      : resolveFromCandidates(candidates, target)
    if (resolved.kind === 'ambiguous') {
      return saveCitationRecord({
        itemId,
        status: 'ambiguous',
        count: prev.count,
        source: CITATION_SOURCE,
        matchedTitle: prev.matchedTitle,
        matchedId: prev.matchedId,
        queriedAt: prev.queriedAt,
        lastAttemptAt: new Date().toISOString(),
        lastError: null,
        candidates: resolved.candidates.slice(0, 5)
      })
    }
    if (resolved.kind === 'none' || !resolved.chosen) {
      return saveCitationRecord({
        itemId,
        status: 'not_found',
        count: prev.count,
        source: CITATION_SOURCE,
        matchedTitle: prev.matchedTitle,
        matchedId: prev.matchedId,
        queriedAt: prev.queriedAt,
        lastAttemptAt: new Date().toISOString(),
        lastError: '未找到匹配的论文（标题/作者/年份均不吻合）',
        candidates: candidates.slice(0, 5)
      })
    }
    const chosen = resolved.chosen
    const now = new Date().toISOString()
    return saveCitationRecord({
      itemId,
      status: chosen.count == null ? 'no_count' : 'ok',
      count: chosen.count,
      source: CITATION_SOURCE,
      matchedTitle: chosen.title,
      matchedId: chosen.id,
      queriedAt: now,
      lastAttemptAt: now,
      lastError: null,
      candidates: []
    })
  } catch (e) {
    // 失败保留上次成功记录（count/queriedAt 不变），只写本次错误
    return saveCitationRecord({
      itemId,
      status: 'failed',
      count: prev.count,
      source: CITATION_SOURCE,
      matchedTitle: prev.matchedTitle,
      matchedId: prev.matchedId,
      queriedAt: prev.queriedAt,
      lastAttemptAt: new Date().toISOString(),
      lastError: errorText(e),
      candidates: prev.candidates
    })
  }
}

function resolveFromCandidates(
  candidates: CitationCandidate[],
  target: CitationTarget
): { kind: 'matched' | 'ambiguous' | 'none'; chosen: CitationCandidate | null; candidates: CitationCandidate[] } {
  const match = resolveCitationMatch(candidates.map(candidateAsHit), target)
  if (match.kind === 'matched' && match.best) {
    const chosen = candidates.find((c) => c.id === match.best!.id) ?? null
    return { kind: 'matched', chosen, candidates: [] }
  }
  if (match.kind === 'ambiguous') {
    const ids = new Set(match.candidates.map((c) => c.id))
    return { kind: 'ambiguous', chosen: null, candidates: candidates.filter((c) => ids.has(c.id)) }
  }
  return { kind: 'none', chosen: null, candidates: candidates.slice(0, 5) }
}

function authorNamesOf(itemId: number): string[] {
  const rows = getDb()
    .prepare(
      'SELECT a.display_name AS name FROM item_authors ia JOIN authors a ON a.id = ia.author_id WHERE ia.item_id = ?'
    )
    .all(itemId) as Array<{ name: string | null }>
  return rows.map((r) => r.name ?? '').filter(Boolean)
}
