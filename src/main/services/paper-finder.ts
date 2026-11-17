/**
 * 「用 AI 找论文」：一句话需求 → 论文列表（已去重、带来源标注）。
 *
 * 步骤：模型把口语转成检索式（无模型/失败时启发式提取）→ 学术库检索
 * （OpenAlex 为主，Crossref 兜底）→ 同一 DOI/标题合并 → 截断到 limit。
 * 纯编排，不做网络重试；检索失败由 searchWorks 用 warnings 表达，不抛错。
 */
import type { PaperFindResult, WorkSource } from '../../shared/types'
import { dedupeWorks, paperQueryFromQuestion, workSources } from '../../shared/paper-hits'
import { searchWorks, type WorkSearchOptions } from './works'
import { aiSearchQuery } from './ai'

export interface FindPapersOptions {
  /** 返回条数上限（1-25，默认 8） */
  limit?: number
  provider?: WorkSearchOptions['provider']
  sort?: WorkSearchOptions['sort']
  yearFrom?: number | null
  yearTo?: number | null
  minCited?: number | null
  oaOnly?: boolean
  /** 是否让模型润色检索式（默认 true；模型不可用时自动退回启发式） */
  useAi?: boolean
}

/**
 * 找论文：返回结构化结果（标题/作者/年份/DOI/链接/来源），供界面一键入库。
 * 任何网络异常都收敛为 warnings，界面照常可渲染。
 */
export async function findPapers(
  question: string,
  opts: FindPapersOptions = {}
): Promise<PaperFindResult> {
  const raw = (question ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) {
    return {
      query: '',
      queryByAi: false,
      works: [],
      providers: [],
      warnings: ['请输入要找的论文主题'],
      online: false
    }
  }

  const fallback = paperQueryFromQuestion(raw) || raw
  let query = fallback
  let queryByAi = false
  if (opts.useAi !== false) {
    try {
      const r = await aiSearchQuery(raw)
      const q = (r.query ?? '').trim()
      if (q) {
        query = q
        queryByAi = r.byAi
      }
    } catch {
      /* 模型不可用：用启发式检索式 */
    }
  }

  const limit = Math.max(1, Math.min(25, Math.floor(opts.limit ?? 8)))
  const run = (q: string): ReturnType<typeof searchWorks> =>
    searchWorks(q, {
      page: 1,
      provider: opts.provider ?? 'auto',
      sort: opts.sort ?? 'relevance',
      yearFrom: opts.yearFrom ?? null,
      yearTo: opts.yearTo ?? null,
      minCited: opts.minCited ?? null,
      oaOnly: !!opts.oaOnly
    })

  let res = await run(query)
  let works = dedupeWorks(res.results ?? [])
  let usedQuery = query
  // 模型检索式可能过窄（0 命中）：用启发式结果再试一次
  if (works.length === 0 && query !== fallback) {
    try {
      const alt = await run(fallback)
      const altWorks = dedupeWorks(alt.results ?? [])
      if (altWorks.length > 0) {
        res = alt
        works = altWorks
        usedQuery = fallback
        queryByAi = false
      }
    } catch {
      /* 保留下面的 warnings */
    }
  }
  works = works.slice(0, limit)

  const warnings = [...(res.warnings ?? [])]
  if (works.length === 0 && warnings.length === 0) {
    warnings.push('没有检索到相关论文：可以换个更具体的主题、方法名或作者')
  }
  const providers = [...new Set(works.flatMap((w) => workSources(w)))] as WorkSource[]
  if (providers.length === 0 && res.source) providers.push(res.source)

  return { query: usedQuery, queryByAi, works, providers, warnings, online: works.length > 0 }
}
