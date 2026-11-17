import type { WorkHit } from './types'

/**
 * Semantic Scholar `graph/v1/paper/search` 的 data[] → WorkHit。
 * 纯映射（无网络），便于单测。
 */
export function mapSemanticResults(items: unknown[]): WorkHit[] {
  return (items ?? []).map((raw): WorkHit => {
    const r = (raw ?? {}) as {
      paperId?: string
      title?: string
      year?: number | null
      venue?: string | null
      citationCount?: number | null
      authors?: Array<{ name?: string }>
      externalIds?: { DOI?: string | null } | null
      openAccessPdf?: { url?: string | null } | null
      abstract?: string | null
    }
    const pdf = r.openAccessPdf?.url ?? null
    return {
      id: `s2:${r.paperId ?? r.title ?? 'unknown'}`,
      doi: r.externalIds?.DOI ?? null,
      title: r.title ?? null,
      year: typeof r.year === 'number' ? r.year : null,
      venue: r.venue ?? null,
      citedBy: Number(r.citationCount ?? 0) || 0,
      authors: (r.authors ?? [])
        .map((a) => a?.name)
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
        .slice(0, 8),
      oaUrl: pdf,
      isOa: !!pdf,
      abstract: r.abstract ?? null,
      source: 'semantic'
    }
  })
}

/** 组装 Semantic Scholar 的 year 参数：2020-2024 / 2020- / -2024 */
export function semanticYearParam(
  yearFrom?: number | null,
  yearTo?: number | null
): string | null {
  if (!yearFrom && !yearTo) return null
  return `${yearFrom ?? ''}-${yearTo ?? ''}`
}
