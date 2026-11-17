import type { WorkHit } from './types'

/** 从任意链接里提取 DOI（Scholar 的 link 常是 doi.org / 出版商 URL） */
export function doiFromUrl(link: unknown): string | null {
  if (typeof link !== 'string') return null
  const m = link.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/i)
  return m ? m[0].replace(/[.,;]+$/, '') : null
}

/**
 * SerpAPI `google_scholar` 的 organic_results → WorkHit。
 * 纯映射（不做网络请求），便于单测。
 *
 * publication_info.summary 形如：
 *   "A. Author, B. Author - Nature, 2025 - nature.com"
 */
export function mapScholarResults(items: unknown[]): WorkHit[] {
  return (items ?? []).map((raw): WorkHit => {
    const r = (raw ?? {}) as {
      result_id?: string
      link?: string
      title?: string
      snippet?: string
      publication_info?: {
        summary?: string
        authors?: Array<{ name?: string }>
      }
      inline_links?: { cited_by?: { total?: number } }
      resources?: Array<{ link?: string }>
    }
    const summary = String(r.publication_info?.summary ?? '')
    const ym = summary.match(/\b(19|20)\d{2}\b/)
    const year = ym ? Number(ym[0]) : null
    let venue: string | null = null
    if (summary) {
      const parts = summary.split(' - ')
      if (parts.length >= 2) {
        venue = parts[1].replace(/,?\s*(19|20)\d{2}.*$/, '').trim() || null
      }
    }
    const authors = (r.publication_info?.authors ?? [])
      .map((a) => a?.name)
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .slice(0, 8)
    const links = (r.resources ?? [])
      .map((x) => x?.link)
      .filter((x): x is string => typeof x === 'string')
    const pdf = links.find((l) => /\.pdf($|\?)/i.test(l)) ?? links[0] ?? null
    return {
      id: `scholar:${r.result_id ?? r.link ?? r.title ?? 'unknown'}`,
      doi: doiFromUrl(r.link) ?? doiFromUrl(pdf),
      title: r.title ?? null,
      year,
      venue,
      citedBy: Number(r.inline_links?.cited_by?.total ?? 0) || 0,
      authors,
      oaUrl: pdf,
      isOa: !!pdf,
      abstract: r.snippet ?? null,
      source: 'google'
    }
  })
}

/** 标题归一化：小写、去标点、压缩空白；用于跨来源匹配同一篇论文 */
export function normalizeTitle(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从检索结果里挑出「同一篇论文」：DOI 精确匹配优先，其次标题归一化/词集合相似度。
 * 纯函数，便于单测；不联网。
 */
export function pickBestWork(
  results: WorkHit[],
  title: string | null,
  doi: string | null
): WorkHit | null {
  if (!results?.length) return null
  const wantDoi = (doi ?? '')
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .trim()
  if (wantDoi) {
    const hit = results.find(
      (r) =>
        (r.doi ?? '')
          .toLowerCase()
          .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
          .trim() === wantDoi
    )
    if (hit) return hit
  }
  const want = normalizeTitle(title)
  if (!want) return results[0] ?? null
  let best: WorkHit | null = null
  let bestScore = 0
  for (const r of results) {
    const cand = normalizeTitle(r.title)
    let score = 0
    if (cand && cand === want) score = 1
    else if (cand && (cand.includes(want) || want.includes(cand))) score = 0.85
    else {
      const a = new Set(want.split(' ').filter((w) => w.length > 2))
      const b = new Set(cand.split(' ').filter((w) => w.length > 2))
      if (a.size && b.size) {
        let inter = 0
        for (const w of a) if (b.has(w)) inter++
        score = inter / Math.max(a.size, b.size)
      }
    }
    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }
  return bestScore >= 0.6 ? best : null
}
