/**
 * 发表信息（期刊／会议／预印本）与被引记录的纯逻辑（阶段四：论文详情）。
 *
 * 这里只做**映射与判定**：Crossref / OpenAlex 响应 → PublicationInfo、用户手改字段的
 * 保护规则、被引候选的匹配打分。不做网络请求、不读写数据库，便于单测。
 */
import type { WorkHit } from './types'

/**
 * 标题归一化：小写、去标点、压缩空白（与 shared/scholar.ts 的 normalizeTitle 同规则）。
 * 这里内联实现是为了让本文件在 Node 类型擦除下可直接 import（不依赖扩展名解析）。
 */
function normalizeTitle(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type PublicationType = 'journal' | 'conference' | 'preprint' | 'unknown'

export const PUBLICATION_TYPE_LABEL: Record<PublicationType, string> = {
  journal: '期刊论文',
  conference: '会议论文',
  preprint: '预印本',
  unknown: '发表类型待确认'
}

export type PublicationSource = 'crossref' | 'openalex' | 'pdf' | 'arxiv' | 'user' | 'none'

export const PUBLICATION_SOURCE_LABEL: Record<PublicationSource, string> = {
  crossref: 'Crossref',
  openalex: 'OpenAlex',
  pdf: 'PDF 正文',
  arxiv: 'arXiv 标识',
  user: '手动填写',
  none: '暂无'
}

export interface PublicationInfo {
  type: PublicationType
  /** 期刊名 / 会议名 / 预印本平台名 */
  venue: string | null
  venueShort: string | null
  /** 会议事件名（Crossref event.name / OpenAlex 会议来源） */
  event: string | null
  /** 论文集名称 */
  proceedings: string | null
  volume: string | null
  issue: string | null
  pages: string | null
  publisher: string | null
  year: number | null
  /** 预印本平台（如 arXiv）与标识 */
  preprintPlatform: string | null
  preprintId: string | null
  /** 预印本已有正式发表版本时的 DOI */
  formalDoi: string | null
  source: PublicationSource
  updatedAt: string | null
  /** 用户明确修正过的字段名；自动补全与识别都不得覆盖 */
  userFixed: string[]
}

export const PUBLICATION_FIELDS = [
  'type',
  'venue',
  'venueShort',
  'event',
  'proceedings',
  'volume',
  'issue',
  'pages',
  'publisher',
  'year',
  'preprintPlatform',
  'preprintId',
  'formalDoi'
] as const

export type PublicationField = (typeof PUBLICATION_FIELDS)[number]

export function emptyPublicationInfo(): PublicationInfo {
  return {
    type: 'unknown',
    venue: null,
    venueShort: null,
    event: null,
    proceedings: null,
    volume: null,
    issue: null,
    pages: null,
    publisher: null,
    year: null,
    preprintPlatform: null,
    preprintId: null,
    formalDoi: null,
    source: 'none',
    updatedAt: null,
    userFixed: []
  }
}

/** 把任意输入归一成发表类型（未知一律 unknown，绝不猜成期刊） */
export function normalizePublicationType(raw: unknown): PublicationType {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return 'unknown'
  if (s === 'journal' || s === 'journal-article' || s === 'journal_article') return 'journal'
  if (s === 'conference' || s === 'proceedings' || s === 'proceedings-article') return 'conference'
  if (s === 'preprint' || s === 'posted-content' || s === 'posted_content') return 'preprint'
  return 'unknown'
}

function text(v: unknown): string | null {
  if (Array.isArray(v)) {
    const hit = v.find((x) => typeof x === 'string' && x.trim())
    return hit ? String(hit).replace(/<[^>]+>/g, '').trim() || null : null
  }
  return typeof v === 'string' && v.trim() ? v.replace(/<[^>]+>/g, '').trim() : null
}

function yearOf(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 1000 && n < 3000 ? Math.trunc(n) : null
}

/** Crossref work → 发表信息（判定依据：type + container-title + event + institution） */
export function publicationFromCrossref(m: any): PublicationInfo {
  const info = emptyPublicationInfo()
  if (!m || typeof m !== 'object') return info
  const type = normalizePublicationType(m.type)
  const container = text(m['container-title'])
  const eventName = text(m.event?.name)
  const institution = text(m.institution?.name)
  const proceedings = text(m['container-title']) && type === 'conference' ? container : null
  info.type = type
  info.venue = type === 'journal' ? container : type === 'conference' ? container ?? eventName : container
  info.event = eventName
  info.proceedings = proceedings
  info.venueShort = text(m['short-container-title']) ?? (eventName ? text(m.event?.acronym) : null)
  info.volume = text(m.volume)
  info.issue = text(m.issue)
  info.pages = text(m.page)
  info.publisher = text(m.publisher) ?? institution
  info.year = yearOf(m.issued?.['date-parts']?.[0]?.[0])
  info.formalDoi = typeof m.DOI === 'string' ? m.DOI.trim().toLowerCase() : null
  if (type === 'preprint') {
    info.preprintPlatform = detectorPlatform(m)
    info.preprintId = typeof m.DOI === 'string' && /arxiv/i.test(m.DOI) ? m.DOI : null
  }
  info.source = 'crossref'
  return info
}

function detectorPlatform(m: any): string | null {
  const group = text(m?.group?.title)
  if (group) return group
  const institution = text(m?.institution?.name)
  if (institution) return institution
  const doi = typeof m?.DOI === 'string' ? m.DOI : ''
  if (/arxiv/i.test(doi)) return 'arXiv'
  if (/10\.1101\//.test(doi)) return 'bioRxiv'
  if (/10\.21203\//.test(doi)) return 'Research Square'
  return null
}

/** OpenAlex work → 发表信息（来源类型取 primary_location.source.type） */
export function publicationFromOpenAlex(w: any): PublicationInfo {
  const info = emptyPublicationInfo()
  if (!w || typeof w !== 'object') return info
  const src = w.primary_location?.source ?? null
  const srcType = String(src?.type ?? '')
  const rawType = String(w.type ?? '')
  info.type =
    rawType === 'preprint' || srcType === 'repository'
      ? 'preprint'
      : rawType === 'proceedings-article' || srcType === 'conference'
        ? 'conference'
        : srcType === 'journal' || rawType === 'article'
          ? 'journal'
          : 'unknown'
  info.venue = text(src?.display_name)
  info.venueShort = text(src?.abbreviated_title) ?? text(src?.short_name)
  info.event = text(w.event?.name) ?? null
  info.publisher = text(src?.host_organization_name)
  info.year = yearOf(w.publication_year)
  info.pages = text(w.biblio?.first_page)
    ? text(w.biblio?.last_page)
      ? `${text(w.biblio?.first_page)}-${text(w.biblio?.last_page)}`
      : text(w.biblio?.first_page)
    : null
  info.volume = text(w.biblio?.volume)
  info.issue = text(w.biblio?.issue)
  // arXiv 识别：location 里 landing_page_url / doi 含 arxiv
  const locations = Array.isArray(w.locations) ? w.locations : []
  for (const loc of locations) {
    const urls = [loc?.landing_page_url, loc?.pdf_url].filter((x) => typeof x === 'string')
    const doi = typeof loc?.doi === 'string' ? loc.doi : ''
    const arxiv = [...urls, doi].join(' ').match(/arxiv\.org\/(?:abs\/)?([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?)/i)
    if (arxiv) {
      info.preprintPlatform = 'arXiv'
      // 去掉版本号：同一个 arXiv 号的 v1/v2 是同一篇，便于与 Crossref/DOI 对齐
      info.preprintId = arxiv[1].replace(/v[0-9]+$/i, '')
      if (info.type === 'unknown' || info.type === 'journal') info.type = 'preprint'
      if (!info.venue) info.venue = 'arXiv'
      break
    }
  }
  info.source = 'openalex'
  return info
}

/** 从 PDF 首屏/正文文本识别 arXiv 预印本标识（只认显式 arXiv 号） */
export function publicationFromPdfText(raw: string): PublicationInfo {
  const info = emptyPublicationInfo()
  const s = String(raw ?? '')
  const m = s.match(/arXiv:\s*([0-9]{4}\.[0-9]{4,5})(v[0-9]+)?/i)
  // 预印本 PDF 常常自报「Published as a conference paper at ICLR 2026」——这是论文自己写的
  // 发表去向，属于可靠的正文证据；但也只用于补空，不覆盖 Crossref/用户值。
  const published = s.match(
    /published\s+as\s+an?\s+(conference|journal|workshop)\s+paper\s+at\s+([^\n]{1,60})/i
  )
  if (published) {
    const kind = published[1].toLowerCase()
    // 「ICLR 2026」→ 会议名 ICLR + 年份 2026；整行只取到行尾，避免吞掉正文
    const line = published[2].replace(/\s+/g, ' ').trim()
    const ym = line.match(/^(.*?)[\s,]*((?:19|20)\d{2})\s*$/)
    info.type = kind === 'journal' ? 'journal' : 'conference'
    info.venue = (ym ? ym[1] : line).trim() || null
    info.year = ym ? Number(ym[2]) : null
    info.source = 'pdf'
  }
  if (m) {
    info.preprintPlatform = 'arXiv'
    info.preprintId = m[1]
    if (!info.type || info.type === 'unknown') {
      info.type = 'preprint'
      info.venue = info.venue ?? 'arXiv'
    }
    info.source = 'pdf'
  }
  return info
}

function isBlank(v: unknown): boolean {
  if (v == null) return true
  if (typeof v === 'string') return !v.trim()
  return false
}

/**
 * 合并发表信息：**只补空**，且 `userFixed` 里的字段永不覆盖。
 * `type` 单独处理：已有明确类型时保留；未知时才采用来源判定。
 */
export function mergePublicationInfo(
  base: PublicationInfo,
  incoming: PublicationInfo | null | undefined
): PublicationInfo {
  if (!incoming) return base
  const fixed = new Set(base.userFixed)
  const next: PublicationInfo = { ...base }
  for (const field of PUBLICATION_FIELDS) {
    if (field === 'type') continue
    if (fixed.has(field)) continue
    const cur = (base as any)[field]
    const val = (incoming as any)[field]
    if (isBlank(cur) && !isBlank(val)) (next as any)[field] = val
  }
  if (!fixed.has('type')) {
    const curType = base.type
    const incType = incoming.type
    if ((curType === 'unknown' || !curType) && incType && incType !== 'unknown') next.type = incType
  }
  if (base.source === 'none' || base.source === 'pdf') next.source = incoming.source
  return next
}

/**
 * 预印本升级为正式发表：Crossref/OpenAlex 确认了正式期刊/会议版本时，
 * 类型改判为 journal/conference，并保留 arXiv 编号作为来源线索（formalDoi 记录正式版 DOI）。
 * 只在 pre-print 来自自动判定（非用户手改）时升级，用户修正过的类型永远不动。
 */
export function upgradePreprintToFormal(
  base: PublicationInfo,
  formal: PublicationInfo | null | undefined
): PublicationInfo {
  if (!formal) return base
  if (base.type !== 'preprint' || base.userFixed.includes('type')) return base
  if (formal.type !== 'journal' && formal.type !== 'conference') return base
  const merged = mergePublicationInfo(base, formal)
  return {
    ...merged,
    type: formal.type,
    venue: formal.venue ?? base.venue,
    venueShort: formal.venueShort ?? base.venueShort,
    event: formal.event ?? base.event,
    proceedings: formal.proceedings ?? base.proceedings,
    // 正式版的年份才是「发表年份」；arXiv 年份属于预印本
    year: formal.year ?? base.year,
    formalDoi: base.formalDoi ?? formal.formalDoi ?? null,
    preprintPlatform: base.preprintPlatform ?? formal.preprintPlatform,
    preprintId: base.preprintId ?? formal.preprintId,
    // 来源跟着「类型从哪来」走：Crossref/OpenAlex/PDF 正文
    source:
      formal.source === 'crossref' || formal.source === 'openalex' || formal.source === 'pdf'
        ? formal.source
        : merged.source
  }
}

/** 用户手动修正：写入字段值并记为 userFixed */export function applyManualPublication(
  base: PublicationInfo,
  patch: Partial<PublicationInfo>
): PublicationInfo {
  const next: PublicationInfo = { ...base }
  const fixed = new Set(base.userFixed)
  for (const field of PUBLICATION_FIELDS) {
    if (!(field in patch)) continue
    const val = (patch as any)[field]
    if (field === 'type') {
      next.type = normalizePublicationType(val)
      fixed.add('type')
      continue
    }
    ;(next as any)[field] = isBlank(val) ? null : val
    fixed.add(field)
  }
  next.userFixed = [...fixed]
  next.source = 'user'
  return next
}

/** 详情页「发表出处」一行文案；未知时明确写待确认，不猜 */
export function formatPublicationLine(info: PublicationInfo | null | undefined): string {
  if (!info) return '暂无发表信息'
  const year = info.year ? `（${info.year}）` : ''
  const kind = PUBLICATION_TYPE_LABEL[info.type] ?? PUBLICATION_TYPE_LABEL.unknown
  if (info.type === 'journal' && info.venue) {
    const vol = info.volume ? ` ${info.volume}` : ''
    const iss = info.issue ? `(${info.issue})` : ''
    const pages = info.pages ? `: ${info.pages}` : ''
    const pre = info.preprintId ? ` · 预印本：${info.preprintPlatform ?? 'arXiv'}:${info.preprintId}` : ''
    return `期刊：${info.venue}${year}${vol}${iss}${pages}${pre}`.trim()
  }
  if (info.type === 'conference') {
    const name = info.venue ?? info.event
    if (name) {
      const extra = info.proceedings && info.proceedings !== name ? ` · 论文集：${info.proceedings}` : ''
      // 有正式会议版本、同时存在 arXiv 版本的：正文按会议写，arXiv 作为来源线索附后（不写成正式会议）
      const pre = info.preprintId ? ` · 预印本：${info.preprintPlatform ?? 'arXiv'}:${info.preprintId}` : ''
      return `会议：${name}${year}${extra}${pre}`
    }
    return `会议论文${year}（会议名称缺失）`
  }
  if (info.type === 'preprint') {
    const platform = info.preprintPlatform ?? info.venue ?? '预印本平台'
    const id = info.preprintId ? `:${info.preprintId}` : ''
    const formal = info.formalDoi ? ` · 已正式发表（DOI ${info.formalDoi}）` : ''
    return `预印本：${platform}${id}${formal}`
  }
  return info.venue ? `发表类型待确认（${info.venue}）` : '暂无发表信息'
}

/** 目录匹配状态：内部没有期刊/会议目录时只能说「暂无目录匹配」，不能说「未收录」 */
export function catalogLabel(matched: boolean): string {
  return matched ? '目录已匹配' : '暂无目录匹配'
}

/** 从数据库行还原（兼容只有 venue 的老数据） */
export function publicationFromRow(
  venue: string | null,
  rawJson: string | null,
  doi?: string | null
): PublicationInfo {
  let info: PublicationInfo | null = null
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson)
      if (parsed && typeof parsed === 'object') {
        info = {
          ...emptyPublicationInfo(),
          ...parsed,
          userFixed: Array.isArray(parsed.userFixed) ? parsed.userFixed : []
        }
      }
    } catch {
      /* 坏 JSON：退回 venue */
    }
  }
  if (!info) {
    info = emptyPublicationInfo()
    if (venue && venue.trim()) {
      info.venue = venue.trim()
      info.type = 'unknown'
    }
  }
  // 确定性的预印本证据：venue 就是 arXiv，或 DOI 落在 arXiv 前缀（10.48550 = arXiv DataCite）。
  // 这不是猜测——两者都能唯一定位到预印本；其它只有 venue 的情况仍标「发表类型待确认」。
  // 已保存的记录也可能缺编号（早期补全写坏过），这里只补空字段，不覆盖已存值。
  const v = (venue ?? info.venue ?? '').trim()
  const d = (doi ?? '').trim().toLowerCase()
  const arxivDoi = d.match(/^10\.48550\/arxiv\.(.+)$/)
  if (/^arxiv\b/i.test(v) || arxivDoi) {
    if (info.type === 'unknown' || info.type === 'preprint') info.type = 'preprint'
    if (!info.preprintPlatform) info.preprintPlatform = 'arXiv'
    if (!info.preprintId && arxivDoi) info.preprintId = arxivDoi[1].replace(/v[0-9]+$/i, '')
    if (!info.venue) info.venue = 'arXiv'
    if (info.source === 'none') info.source = 'arxiv'
  }
  if (info.type === 'preprint' && !info.formalDoi && d && !arxivDoi && /^10\./.test(d)) {
    info.formalDoi = d
  }
  // 类型已升级为期刊/会议、来源还停留在「arXiv 标识」：说明刊名来自 PDF 自报（旧记录写法），归一到 PDF 正文
  if ((info.type === 'journal' || info.type === 'conference') && info.source === 'arxiv') {
    info.source = 'pdf'
  }
  return info
}

/* ============================ 被引记录 ============================ */

export type CitationStatus =
  | 'ok'
  | 'no_count'
  | 'not_found'
  | 'ambiguous'
  | 'failed'
  | 'unconfigured'
  | 'never'

export interface CitationCandidate {
  id: string
  title: string
  count: number | null
  year: number | null
  authors: string[]
  venue: string | null
  doi: string | null
}

export interface CitationRecord {
  itemId: number
  status: CitationStatus
  count: number | null
  /** 例：Google Scholar，经 SerpAPI */
  source: string
  matchedTitle: string | null
  matchedId: string | null
  queriedAt: string | null
  lastError: string | null
  /** 最近一次尝试时间（失败也更新，用于「本次失败」提示） */
  lastAttemptAt: string | null
  candidates: CitationCandidate[]
}

export const CITATION_SOURCE_LABEL = 'Google Scholar，经 SerpAPI'

export function emptyCitationRecord(itemId: number): CitationRecord {
  return {
    itemId,
    status: 'never',
    count: null,
    source: CITATION_SOURCE_LABEL,
    matchedTitle: null,
    matchedId: null,
    queriedAt: null,
    lastError: null,
    lastAttemptAt: null,
    candidates: []
  }
}

/** 状态文案：四种结果必须区分，不能都写成 0 */
export function describeCitation(record: CitationRecord | null | undefined): string {
  if (!record || record.status === 'never') return '尚未查询'
  switch (record.status) {
    case 'ok':
      return record.count == null ? '接口未提供被引次数' : `被引 ${record.count} 次`
    case 'no_count':
      return '已匹配到论文，但接口未提供被引次数'
    case 'not_found':
      return '未找到匹配的论文'
    case 'ambiguous':
      return '有多个候选，需要你确认是哪一篇'
    case 'unconfigured':
      return '未配置 SerpAPI Key，无法查询'
    case 'failed':
      return '查询失败'
    default:
      return '尚未查询'
  }
}

export interface CitationTarget {
  title: string | null
  doi: string | null
  year: number | null
  authors: string[]
}

/**
 * 给 Scholar 候选打分：DOI 精确 > 标题完全相同 > 标题包含；作者/年份用于加分与纠偏。
 * 返回 0–1，>=0.9 视为可确定。
 */
export function scoreCitationCandidate(hit: WorkHit, target: CitationTarget): number {
  const wantDoi = (target.doi ?? '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim()
  const hitDoi = (hit.doi ?? '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim()
  if (wantDoi && hitDoi && wantDoi === hitDoi) return 1
  const want = normalizeTitle(target.title)
  const cand = normalizeTitle(hit.title)
  if (!want || !cand) return 0
  let score = 0
  if (cand === want) score = 0.95
  else if (cand.includes(want) || want.includes(cand)) score = 0.8
  else {
    const a = new Set(want.split(' ').filter((w) => w.length > 2))
    const b = new Set(cand.split(' ').filter((w) => w.length > 2))
    let inter = 0
    for (const w of a) if (b.has(w)) inter++
    score = a.size && b.size ? inter / Math.max(a.size, b.size) : 0
  }
  // 年份：一致 +0.05，明显冲突 -0.25
  if (target.year != null && hit.year != null) {
    if (Math.abs(hit.year - target.year) <= 1) score += 0.05
    else score -= 0.25
  }
  // 作者：至少一位同名 +0.05
  if (target.authors.length && hit.authors.length) {
    const norm = (n: string) => n.toLowerCase().replace(/[^a-z\u4e00-\u9fff ]+/g, '').trim()
    const targetNames = new Set(target.authors.map(norm).filter(Boolean))
    const overlap = hit.authors.map(norm).some((n) => targetNames.has(n))
    if (overlap) score += 0.05
  }
  return Math.max(0, Math.min(1, Number(score.toFixed(3))))
}

export interface CitationMatch {
  kind: 'matched' | 'ambiguous' | 'none'
  best: (WorkHit & { score: number }) | null
  candidates: Array<WorkHit & { score: number }>
}

/** 多个候选无法区分时返回 ambiguous，让用户选，绝不写入可能属于别的论文的次数 */
export function resolveCitationMatch(hits: WorkHit[], target: CitationTarget): CitationMatch {
  const scored = (hits ?? [])
    .map((hit) => ({ ...hit, score: scoreCitationCandidate(hit, target) }))
    .sort((a, b) => b.score - a.score)
  const best = scored[0] ?? null
  if (!best || best.score < 0.6) return { kind: 'none', best: null, candidates: scored.slice(0, 5) }
  const second = scored[1] ?? null
  const normDoi = (v: string | null | undefined) =>
    (v ?? '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim()
  const wantDoi = normDoi(target.doi)
  const bestDoiOk = !!wantDoi && normDoi(best.doi) === wantDoi
  // 没有 DOI 可核对、标题又几乎一样时（同名/续篇），不能替用户拍板
  const twinTitles =
    !bestDoiOk &&
    !!second &&
    second.score >= 0.8 &&
    second.score >= best.score - 0.2 &&
    !normDoi(second.doi)
  const clearWinner =
    !twinTitles &&
    (bestDoiOk || best.score >= 0.9 || (best.score >= 0.75 && (!second || second.score <= best.score - 0.15)))
  return {
    kind: clearWinner ? 'matched' : 'ambiguous',
    best: clearWinner ? best : null,
    candidates: scored.slice(0, 5)
  }
}

/** Scholar 结果 → 候选（详情页让用户挑选用） */
export function candidateFromHit(hit: WorkHit): CitationCandidate {
  return {
    id: hit.id,
    title: hit.title ?? '（无标题）',
    count: Number.isFinite(hit.citedBy) ? hit.citedBy : null,
    year: hit.year ?? null,
    authors: hit.authors ?? [],
    venue: hit.venue ?? null,
    doi: hit.doi ?? null
  }
}
