import type { Item } from '../../shared/types'

const crossrefBase = (): string =>
  process.env.PAPERDESK_CROSSREF_BASE ?? 'https://api.crossref.org'
const oaBase = (): string => process.env.PAPERDESK_OPENALEX_BASE ?? 'https://api.openalex.org'
const UA = 'PaperDesk/0.1.0 (research-paper-desktop-app)'

/** 单次元数据请求超时：网络慢 / 被墙时快速降级，不阻塞抽取与 UI */
const TIMEOUT_MS = 8000
/** 按标题检索时接受的归一化相似度下限（DOI 精确命中不受此限） */
export const TITLE_MATCH_THRESHOLD = 0.9

/** OpenAlex 需要的字段；host_venue 是旧字段，部分部署会 400，故保留降级选择 */
const OA_SELECT = 'title,publication_year,abstract_inverted_index,primary_location,host_venue,doi'
const OA_SELECT_BASIC = 'title,publication_year,abstract_inverted_index,primary_location,doi'
/**
 * host_venue 在部分 OpenAlex 部署已不是合法 select 字段（实测 400: "host_venue is not
 * a valid select field"）。首次被拒后在本进程内记住，后续直接走 basic，避免每次多一次 400。
 */
let hostVenueSelectable: boolean | null = null

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' '
}

/** 解码 XML/HTML 常见实体（Crossref 的 JATS 摘要里很常见） */
function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
}

/** 去掉 JATS/HTML 标签，得到纯文本摘要 */
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** OpenAlex 的倒排摘要 → 正常文本 */
function invertAbstract(inv: Record<string, number[]>): string {
  const arr: Array<[number, string]> = []
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions) arr.push([p, word])
  }
  arr.sort((a, b) => a[0] - b[0])
  return arr.map(([, w]) => w).join(' ')
}

/**
 * 标题归一化：去标签/实体、小写、非字母数字（保留中文）转空格、压缩空白。
 * 纯函数（导出便于单测）：Crossref/OpenAlex 的标题拼写、标点、大小写差异都靠它对齐。
 */
export function normalizeTitle(input: string | null | undefined): string {
  if (!input) return ''
  return stripTags(String(input))
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 编辑距离（只用于标题，长度有限；两行滚动数组足够） */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = new Array<number>(b.length + 1)
  let cur = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = cur
    cur = swap
  }
  return prev[b.length]
}

/**
 * 标题相似度（0–1）：归一化后完全相同 = 1；否则取「字符编辑距离相似度」与「词集合 Dice」
 * 的较大者；当一方标题被另一方完整包含（如 Crossref 带副标题 "Foo: a survey"）且较短标题
 * 至少 3 个词时按 0.95 计（略低于完全相同）。阈值见 TITLE_MATCH_THRESHOLD。
 */
export function titleSimilarity(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  const x = normalizeTitle(a)
  const y = normalizeTitle(b)
  if (!x || !y) return 0
  if (x === y) return 1

  const charSim = 1 - editDistance(x, y) / Math.max(x.length, y.length)

  const ta = new Set(x.split(' ').filter(Boolean))
  const tb = new Set(y.split(' ').filter(Boolean))
  let dice = 0
  if (ta.size && tb.size) {
    let inter = 0
    for (const w of ta) if (tb.has(w)) inter++
    dice = (2 * inter) / (ta.size + tb.size)
    // 一方完整包含另一方：常见于「主标题 | 副标题」差异
    const minTokens = Math.min(ta.size, tb.size)
    if (inter === minTokens && minTokens >= 3) dice = Math.max(dice, 0.95)
  }
  return Math.max(0, Math.min(1, Math.max(charSim, dice)))
}

/** 候选作品的可匹配字段（Crossref / OpenAlex 的检索结果都归一到这个形状） */
export interface TitleCandidate {
  title?: string | null
  doi?: string | null
}

/**
 * 从若干检索结果里挑出「同一篇论文」：DOI 精确优先，其次标题相似度最高者（须 >= minScore）。
 * 纯函数（导出便于单测）；相似度不够就返回 null，宁可不补也不写错期刊。
 */
export function pickBestByTitle<T extends TitleCandidate>(
  candidates: readonly T[] | null | undefined,
  title: string | null | undefined,
  doi?: string | null,
  minScore = TITLE_MATCH_THRESHOLD
): T | null {
  const list = candidates ?? []
  if (!list.length) return null
  const wantDoi = cleanDoi(doi)?.toLowerCase() ?? null
  if (wantDoi) {
    const exact = list.find((c) => cleanDoi(c.doi)?.toLowerCase() === wantDoi)
    if (exact) return exact
  }
  let best: T | null = null
  let bestScore = 0
  for (const c of list) {
    const s = titleSimilarity(c.title, title)
    if (s > bestScore) {
      bestScore = s
      best = c
    }
  }
  return best && bestScore >= minScore ? best : null
}

/** DOI 归一化：去 doi.org 前缀与首尾空白（存储时保留原始大小写，比较时再小写） */
function cleanDoi(doi: string | null | undefined): string | null {
  const s = String(doi ?? '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .trim()
  return s ? s : null
}

function isEmptyText(v: string | null | undefined): boolean {
  return !v || !v.trim()
}

/** 条目当前（可与来源合并的）元数据字段 */
interface MetaFields {
  title: string | null
  abstract: string | null
  year: number | null
  venue: string | null
  doi: string | null
}

/** 只补空：已有非空值绝不覆盖 */
function fillMissing(target: MetaFields, from: Partial<MetaFields>): void {
  const keepText = (cur: string | null, next: string | null | undefined): string | null =>
    !isEmptyText(cur) ? cur : isEmptyText(next) ? (next ?? null) : String(next).trim()

  target.title = keepText(target.title, from.title)
  target.abstract = keepText(target.abstract, from.abstract)
  target.venue = keepText(target.venue, from.venue)
  if (target.year == null && from.year != null && Number.isFinite(from.year)) {
    target.year = Math.trunc(from.year)
  }
  if (isEmptyText(target.doi)) {
    const doi = cleanDoi(from.doi)
    if (doi) target.doi = doi
  }
}

function hasMissingField(m: MetaFields): boolean {
  return (
    isEmptyText(m.title) ||
    isEmptyText(m.abstract) ||
    m.year == null ||
    isEmptyText(m.venue) ||
    isEmptyText(m.doi)
  )
}

interface JsonResult {
  ok: boolean
  status: number
  data: any | null
}

/**
 * 带超时的 JSON GET：超时 / DNS / 断网 / 4xx 一律返回 ok=false（不抛异常），
 * 保证元数据补全失败绝不会冒泡到 UI 或中断抽取。
 */
async function requestJson(url: string | URL): Promise<JsonResult> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!r.ok) return { ok: false, status: r.status, data: null }
    return { ok: true, status: r.status, data: await r.json() }
  } catch {
    return { ok: false, status: 0, data: null }
  }
}

/** 取 Crossref 里的「第一个非空字符串」（title/container-title 都是字符串数组） */
function firstText(v: unknown): string | null {
  if (Array.isArray(v)) {
    const hit = v.find((x) => typeof x === 'string' && x.trim())
    return hit ? stripTags(String(hit)) : null
  }
  return typeof v === 'string' && v.trim() ? stripTags(v) : null
}

/** Crossref work → 元数据字段（只取有值的，缺失的保持 null） */
function crossrefMeta(m: any): Partial<MetaFields> {
  if (!m || typeof m !== 'object') return {}
  const rawYear = Number(m.issued?.['date-parts']?.[0]?.[0])
  return {
    title: firstText(m.title),
    abstract: typeof m.abstract === 'string' && m.abstract.trim() ? stripTags(m.abstract) : null,
    year: Number.isFinite(rawYear) && rawYear > 0 ? rawYear : null,
    venue: firstText(m['container-title']),
    doi: typeof m.DOI === 'string' ? m.DOI : null
  }
}

/** OpenAlex work → 元数据字段；venue 优先 primary_location.source.display_name */
function openalexMeta(w: any): Partial<MetaFields> {
  if (!w || typeof w !== 'object') return {}
  let abstract: string | null = null
  const inv = w.abstract_inverted_index
  if (inv && typeof inv === 'object') {
    try {
      abstract = invertAbstract(inv) || null
    } catch {
      abstract = null
    }
  }
  const venue =
    (typeof w.primary_location?.source?.display_name === 'string' &&
      w.primary_location.source.display_name.trim()) ||
    (typeof w.host_venue?.display_name === 'string' && w.host_venue.display_name.trim()) ||
    null
  return {
    title: typeof w.title === 'string' && w.title.trim() ? stripTags(w.title) : null,
    abstract,
    year: typeof w.publication_year === 'number' ? w.publication_year : null,
    venue: venue ? String(venue) : null,
    doi: typeof w.doi === 'string' ? w.doi : null
  }
}

/**
 * 为条目补齐「缺失」的元数据：标题 / 摘要 / 年份 / 来源(期刊) / DOI 各自独立判断，
 * 已有非空值一律不覆盖。
 *
 * 数据来源（每次请求 8s 超时，失败静默降级）：
 *  1. Crossref：有 DOI 按 /works/{doi}；无 DOI 或仍缺来源时用 query.bibliographic 标题检索
 *     （rows=5），按归一化标题相似度 >= 0.9（DOI 精确优先）选最佳，取 container-title / issued / DOI。
 *  2. OpenAlex：有 DOI 用 filter=doi:..，否则 search=<title>；venue 取
 *     primary_location.source.display_name，其次 host_venue.display_name。
 * 新查到的 DOI 会写回 items.doi（items.doi 无唯一约束，写入安全），并补 works 表。
 * 用于「无 PDF 的元数据条目」（相关论文/AI 建议加入文库后的预览）与抽取后的自动补全。
 */
export async function enrichItem(itemId: number): Promise<Item> {
  const { getDb } = await import('../db')
  const db = getDb()
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Item | undefined
  if (!item) throw new Error(`条目不存在: ${itemId}`)

  const cur: MetaFields = {
    title: item.title ?? null,
    abstract: item.abstract ?? null,
    year: item.year ?? null,
    venue: item.venue ?? null,
    doi: item.doi ?? null
  }

  // 字段都在：不发任何网络请求
  if (!hasMissingField(cur)) return item

  // ---- 1) Crossref ----
  let crossrefRaw: any | null = null
  try {
    const base = crossrefBase().replace(/\/$/, '')
    const doi = cleanDoi(cur.doi)
    if (doi) {
      const r = await requestJson(`${base}/works/${encodeURIComponent(doi)}`)
      crossrefRaw = r.data?.message ?? null
      fillMissing(cur, crossrefMeta(r.data?.message))
    }
    // 仍缺 DOI / 来源 / 摘要等，或本来就没 DOI：按标题做书目检索
    const searchTitle = (cur.title ?? '').trim()
    if (searchTitle && hasMissingField(cur)) {
      const u = new URL(`${base}/works`)
      u.searchParams.set('query.bibliographic', searchTitle)
      u.searchParams.set('rows', '5')
      const r = await requestJson(u)
      const items = (r.data?.message?.items ?? []) as any[]
      const candidates = items.map((m) => ({
        title: firstText(m?.title),
        doi: typeof m?.DOI === 'string' ? m.DOI : null,
        raw: m
      }))
      const best = pickBestByTitle(candidates, searchTitle, cur.doi)
      if (best) {
        crossrefRaw = best.raw
        fillMissing(cur, crossrefMeta(best.raw))
      }
    }
  } catch {
    /* 忽略：Crossref 失败不影响 OpenAlex 与后续入库 */
  }

  // ---- 2) OpenAlex（DOI 优先，否则标题检索） ----
  let openalexRaw: any[] = []
  try {
    if (hasMissingField(cur)) {
      const doi = cleanDoi(cur.doi)
      const searchTitle = (cur.title ?? '').trim()
      if (doi || searchTitle) {
        const base = oaBase().replace(/\/$/, '') + '/works'
        const build = (select: string): URL => {
          const u = new URL(base)
          if (doi) u.searchParams.set('filter', `doi:${doi.toLowerCase()}`)
          else u.searchParams.set('search', searchTitle)
          u.searchParams.set('per_page', doi ? '1' : '5')
          u.searchParams.set('select', select)
          return u
        }
        let r = await requestJson(
          build(hostVenueSelectable === false ? OA_SELECT_BASIC : OA_SELECT)
        )
        // host_venue 在部分 OpenAlex 版本已被移除（400）：去掉它重试一次并记住
        if (!r.ok && r.status === 400 && hostVenueSelectable !== false) {
          hostVenueSelectable = false
          r = await requestJson(build(OA_SELECT_BASIC))
        } else if (r.ok && hostVenueSelectable === null) {
          hostVenueSelectable = true
        }
        const results = (r.data?.results ?? []) as any[]
        openalexRaw = results
        const best = doi
          ? results[0] ?? null
          : pickBestByTitle(
              results.map((w) => ({
                title: typeof w?.title === 'string' ? w.title : null,
                doi: w?.doi,
                raw: w
              })),
              searchTitle
            )
        if (best) fillMissing(cur, openalexMeta(best.raw))
      }
    }
  } catch {
    /* 忽略：拿不到就保持原值（venue 留空比写错期刊好） */
  }

  const ts = new Date().toISOString()
  db.prepare(
    'UPDATE items SET title = ?, abstract = ?, year = ?, venue = ?, doi = ?, date_modified = ? WHERE id = ?'
  ).run(
    cur.title ?? null,
    cur.abstract ?? null,
    cur.year ?? null,
    cur.venue ?? null,
    cur.doi ?? null,
    ts,
    itemId
  )

  // 发表信息（阶段四）：把本轮拿到的 Crossref/OpenAlex 记录并入 publication_json，
  // 判定期刊/会议/预印本；用户手改过的字段不会被覆盖。
  try {
    const { applyPublicationRecords } = await import('./publication')
    const authors = (
      db
        .prepare(
          'SELECT a.display_name AS name FROM item_authors ia JOIN authors a ON a.id = ia.author_id WHERE ia.item_id = ?'
        )
        .all(itemId) as Array<{ name: string | null }>
    )
      .map((r) => r.name ?? '')
      .filter(Boolean)
    applyPublicationRecords(
      itemId,
      { crossref: crossrefRaw ? [crossrefRaw] : [], openalex: openalexRaw },
      { title: cur.title, doi: cur.doi, year: cur.year, authors }
    )
  } catch {
    /* 发表信息补全失败不影响元数据写入 */
  }

  const doi = cleanDoi(cur.doi)
  if (doi) {
    db.prepare('INSERT OR IGNORE INTO works (doi, title, year) VALUES (?, ?, ?)').run(
      doi,
      cur.title ?? null,
      cur.year ?? null
    )
  }

  return db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Item
}
