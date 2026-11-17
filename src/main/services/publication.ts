/**
 * 发表信息（期刊／会议／预印本）读写与补全（阶段四：论文详情）。
 *
 * 分工：
 *  - `readPublication`：只读库，不联网（详情页每次打开都走这里）。
 *  - `enrichPublication`：导入/识别/手动点「补全」时才联网，Crossref 优先、OpenAlex 兜底；
 *    DOI 精确匹配优先，无 DOI 时用标题 + 作者 + 年份验证，绝不取第一条了事。
 *  - `savePublicationManual`：用户手改，写 `userFixed`，之后自动补全不再覆盖这些字段。
 */
import { getDb } from '../db'
import type { Item } from '../../shared/types'
import {
  applyManualPublication,
  catalogLabel,
  emptyPublicationInfo,
  formatPublicationLine,
  mergePublicationInfo,
  publicationFromCrossref,
  publicationFromOpenAlex,
  publicationFromPdfText,
  publicationFromRow,
  upgradePreprintToFormal,
  type PublicationInfo
} from '../../shared/publication'
import { normalizeTitle } from '../../shared/scholar'
import { effective } from './settings'

const UA = 'PaperDesk/0.1.0 (mailto:paperdesk@example.com)'
const TIMEOUT_MS = 8000

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function crossrefBase(): string {
  return effective('crossref.base', 'PAPERDESK_CROSSREF_BASE', 'https://api.crossref.org')
}
function oaBase(): string {
  return effective('openalex.base', 'PAPERDESK_OPENALEX_BASE', 'https://api.openalex.org')
}

async function getJson(url: string | URL): Promise<any | null> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

const cleanDoi = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim()
  return s || null
}

/** 只读：条目 → 发表信息（含老数据 venue 兜底）与目录匹配状态 */
export function readPublication(itemId: number): {
  info: PublicationInfo
  line: string
  catalog: string
} {
  const row = getDb()
    .prepare('SELECT venue, doi, publication_json FROM items WHERE id = ?')
    .get(itemId) as
    | { venue: string | null; doi: string | null; publication_json: string | null }
    | undefined
  const info = publicationFromRow(row?.venue ?? null, row?.publication_json ?? null, row?.doi ?? null)
  return { info, line: formatPublicationLine(info), catalog: catalogLabel(false) }
}

function authorNames(itemId: number): string[] {
  const rows = getDb()
    .prepare(
      'SELECT a.display_name AS name FROM item_authors ia JOIN authors a ON a.id = ia.author_id WHERE ia.item_id = ?'
    )
    .all(itemId) as Array<{ name: string | null }>
  return rows.map((r) => r.name ?? '').filter(Boolean)
}

function savePublication(itemId: number, info: PublicationInfo): void {
  const db = getDb()
  const ts = new Date().toISOString()
  const payload: PublicationInfo = { ...info, updatedAt: ts }
  db.prepare('UPDATE items SET venue = ?, publication_json = ?, date_modified = ? WHERE id = ?').run(
    payload.venue ?? null,
    JSON.stringify(payload),
    ts,
    itemId
  )
}

/** 用户手动修正：标记 userFixed，自动补全不再覆盖这些字段 */
export function savePublicationManual(
  itemId: number,
  patch: Partial<PublicationInfo>
): { info: PublicationInfo; line: string; catalog: string } {
  const cur = readPublication(itemId).info
  const next = applyManualPublication(cur, patch)
  savePublication(itemId, next)
  return { info: next, line: formatPublicationLine(next), catalog: catalogLabel(false) }
}

/**
 * 联网补全发表信息：Crossref（DOI → 标题检索）→ OpenAlex 兜底。
 * 已有明确类型/字段不覆盖；用户手改字段永不覆盖。
 */
export async function enrichPublication(
  itemId: number,
  opts: { force?: boolean } = {}
): Promise<{ info: PublicationInfo; line: string; catalog: string; warnings: string[] }> {
  const warnings: string[] = []
  const db = getDb()
  const item = db
    .prepare('SELECT id, title, doi, year, venue, publication_json FROM items WHERE id = ?')
    .get(itemId) as
    | Pick<Item, 'id' | 'title' | 'doi' | 'year' | 'venue'> & { publication_json: string | null }
    | undefined
  if (!item) throw new Error(`条目不存在: ${itemId}`)

  let info = publicationFromRow(item.venue ?? null, item.publication_json ?? null, item.doi ?? null)
  const title = (item.title ?? '').trim()
  const doi = cleanDoi(item.doi)
  const authors = authorNames(itemId)

  // 0) PDF 正文：arXiv 编号 + 论文自报的「Published as a conference paper at …」
  //    预印本也读一次（用于发现已有正式发表版本），用户手改过的类型不参与。
  const wantPdf = info.type === 'unknown' || (info.type === 'preprint' && !info.formalDoi)
  if (wantPdf && !opts.force && !info.userFixed.includes('type')) {
    try {
      const chunk = db
        .prepare(
          `SELECT c.text AS text FROM chunks c JOIN attachments a ON a.id = c.attachment_id
           WHERE a.item_id = ? ORDER BY COALESCE(c.page_index, 0) ASC, c.id ASC LIMIT 1`
        )
        .get(itemId) as { text: string | null } | undefined
      if (chunk?.text) {
        const fromPdf = publicationFromPdfText(chunk.text)
        if (fromPdf.type !== 'unknown') info = upgradePreprintToFormal(info, fromPdf)
      }
    } catch {
      /* 老库可能没有 chunks；忽略 */
    }
  }

  // 1) Crossref：DOI 精确优先
  const base = crossrefBase().replace(/\/$/, '')
  let crossrefChecked = false
  if (doi) {
    const data = await getJson(`${base}/works/${encodeURIComponent(doi)}`)
    const m = data?.message
    if (m) {
      crossrefChecked = true
      // 预印本若已在 Crossref 记录正式版本关系，记下 formalDoi
      const rel = Array.isArray(m.relation?.['is-preprint-of']) ? m.relation['is-preprint-of'] : []
      const formal = rel.find((r: any) => typeof r?.id === 'string')
      if (formal && info.type === 'preprint') {
        info = mergePublicationInfo(info, { ...emptyPublicationInfo(), formalDoi: cleanDoi(formal.id) })
      }
      // Crossref 给出正式期刊/会议版本时，预印本升级为正式发表（arXiv 编号保留为来源线索）
      info = upgradePreprintToFormal(info, publicationFromCrossref(m))
    } else {
      warnings.push('Crossref 未返回该 DOI 的记录')
    }
  }
  // 2) 仍缺类型/刊名：标题 + 作者 + 年份验证后检索（不取第一条）
  if (!crossrefChecked || info.type === 'unknown' || !info.venue || (info.type === 'preprint' && !info.formalDoi)) {
    if (title) {
      const u = new URL(`${base}/works`)
      u.searchParams.set('query.bibliographic', title)
      u.searchParams.set('rows', '8')
      const data = await getJson(u)
      const items = (data?.message?.items ?? []) as any[]
      const pick = pickCrossrefRecord(items, title, doi, authors, item.year ?? null)
      if (pick) {
        const incoming = publicationFromCrossref(pick.record)
        // 预印本已有正式版本：同标题的期刊/会议记录 → 升级为正式发表
        if (info.type === 'preprint' && !incoming.preprintId) {
          incoming.preprintPlatform = info.preprintPlatform
          incoming.preprintId = info.preprintId
        }
        info = upgradePreprintToFormal(info, incoming)
      } else if (items.length > 0) {
        warnings.push('标题检索有结果，但作者/年份对不上，未自动采用')
      }
    }
  }

  // 3) OpenAlex 兜底（Crossref 全空或仍未知类型时）
  if (info.type === 'unknown' || !info.venue) {
    const oa = oaBase().replace(/\/$/, '') + '/works'
    const u = new URL(oa)
    if (doi) u.searchParams.set('filter', `doi:${doi.toLowerCase()}`)
    else if (title) u.searchParams.set('search', title)
    u.searchParams.set('per_page', doi ? '1' : '8')
    u.searchParams.set('select', 'title,publication_year,type,primary_location,locations,biblio,event,doi')
    const data = await getJson(u)
    const results = (data?.results ?? []) as any[]
    const pick = doi
      ? results[0] ?? null
      : pickOpenAlexRecord(results, title, authors, item.year ?? null)
    if (pick) info = upgradePreprintToFormal(info, publicationFromOpenAlex(pick))
  }

  savePublication(itemId, info)
  return { info, line: formatPublicationLine(info), catalog: catalogLabel(false), warnings }
}

/** Crossref 候选验证：标题相似度 + 作者/年份一致性；返回 null 表示不敢采用 */
export function pickCrossrefRecord(
  records: any[],
  title: string,
  doi: string | null,
  authors: string[],
  year: number | null
): { record: any; score: number } | null {
  const want = normalizeTitle(title)
  if (!want) return null
  let best: { record: any; score: number } | null = null
  for (const r of records) {
    if (!r) continue
    const rDoi = cleanDoi(r.DOI)
    if (doi && rDoi && rDoi.toLowerCase() === doi.toLowerCase()) return { record: r, score: 1 }
    const rTitle = Array.isArray(r.title) ? String(r.title[0] ?? '') : String(r.title ?? '')
    const cand = normalizeTitle(rTitle)
    if (!cand) continue
    let score = cand === want ? 0.95 : cand.includes(want) || want.includes(cand) ? 0.8 : 0
    if (!score) continue
    const rYear = Number(r.issued?.['date-parts']?.[0]?.[0])
    if (year != null && Number.isFinite(rYear)) {
      if (Math.abs(rYear - year) <= 1) score += 0.05
      else score -= 0.2
    }
    const rAuthors = (r.author ?? [])
      .map((a: any) => `${a?.given ?? ''} ${a?.family ?? ''}`.trim().toLowerCase())
      .filter(Boolean)
    const wantAuthors = authors.map((a) => a.toLowerCase().replace(/[^a-z ]+/g, '').trim()).filter(Boolean)
    if (wantAuthors.length && rAuthors.length) {
      const hit = wantAuthors.some((w) => rAuthors.some((x: string) => x && (x.includes(w) || w.includes(x))))
      if (hit) score += 0.05
    }
    if (!best || score > best.score) best = { record: r, score }
  }
  return best && best.score >= 0.85 ? best : null
}

function pickOpenAlexRecord(
  records: any[],
  title: string,
  authors: string[],
  year: number | null
): any | null {
  const want = normalizeTitle(title)
  if (!want) return null
  let best: { record: any; score: number } | null = null
  for (const r of records) {
    const cand = normalizeTitle(typeof r?.title === 'string' ? r.title : '')
    if (!cand) continue
    let score = cand === want ? 0.95 : cand.includes(want) || want.includes(cand) ? 0.8 : 0
    if (!score) continue
    const rYear = Number(r.publication_year)
    if (year != null && Number.isFinite(rYear)) {
      if (Math.abs(rYear - year) <= 1) score += 0.05
      else score -= 0.2
    }
    if (!best || score > best.score) best = { record: r, score }
  }
  return best && best.score >= 0.85 ? best.record : null
}

/** 供 enrichItem 复用的轻量入口：把已拿到的 Crossref/OpenAlex 记录并入发表信息 */
export function applyPublicationRecords(
  itemId: number,
  records: { crossref?: any[]; openalex?: any[] },
  ctx: { title: string | null; doi: string | null; year: number | null; authors: string[] }
): void {
  const cur = readPublication(itemId).info
  let info = cur
  const cross = pickCrossrefRecord(
    records.crossref ?? [],
    ctx.title ?? '',
    ctx.doi,
    ctx.authors,
    ctx.year
  )
  if (cross) info = mergePublicationInfo(info, publicationFromCrossref(cross.record))
  if (records.openalex?.length) {
    const oa = ctx.doi
      ? records.openalex[0]
      : pickOpenAlexRecord(records.openalex, ctx.title ?? '', ctx.authors, ctx.year)
    if (oa) info = mergePublicationInfo(info, publicationFromOpenAlex(oa))
  }
  if (info !== cur) savePublication(itemId, info)
}

export function publicationSummaryForLog(e: unknown): string {
  return `发表信息补全失败：${msg(e)}`
}
