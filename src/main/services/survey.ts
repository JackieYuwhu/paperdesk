/**
 * 领域调研（Survey）：几篇种子论文 + Google Scholar/OpenAlex 检索 → 并发快速拆解 → 多视角路由推荐。
 *
 * 设计取舍：
 * - 拆解只读「标题/来源/摘要」，不下载全文：20–30 篇能在几十秒内完成，适合快速调研；
 *   真正精读仍走「拆解论文」面板（全文 map-reduce）。
 * - 拆解与路由都走统一 `generate()`（未配置模型时自动离线占位），并发数可配置。
 * - 路由不是「一个模型排全部」，而是 3–6 个视角并行打分后合并：方法创新 / 证据强度 /
 *   领域相关性 / 入门价值 / 可复现性 / 写作清晰度；避免单次长上下文排序的偏见。
 */
import { getDb } from '../db'
import { generate } from './llm'
import { searchWorks, type WorkSearchOptions } from './works'
import type { WorkHit } from '../../shared/types'
import type {
  SurveyCandidate,
  SurveyCard,
  SurveyRecommendation,
  SurveyResult,
  SurveyRunOptions,
  SurveySeed
} from '../../shared/survey'

const clampInt = (n: unknown, def: number, min: number, max: number): number => {
  const v = Number(n)
  if (!Number.isFinite(v)) return def
  return Math.max(min, Math.min(max, Math.trunc(v)))
}

/** 保序、限制并发的 map（单项失败返回 fallback，不中断整体） */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  fallback: (item: T, index: number) => R
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Math.max(1, Math.min(limit, items.length || 1))
  const run = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try {
        out[i] = await fn(items[i], i)
      } catch {
        out[i] = fallback(items[i], i)
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => run()))
  return out
}

function norm(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sameWork(a: { doi?: string | null; title?: string | null }, b: { doi?: string | null; title?: string | null }): boolean {
  const da = (a.doi ?? '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase()
  const db = (b.doi ?? '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase()
  if (da && db && da === db) return true
  const ta = norm(a.title)
  const tb = norm(b.title)
  if (!ta || !tb) return false
  return ta === tb || (ta.length >= 24 && tb.length >= 24 && (ta.includes(tb) || tb.includes(ta)))
}

function pickByTitle(results: WorkHit[], title: string): WorkHit | null {
  const t = norm(title)
  if (!t) return null
  for (const r of results) {
    const rt = norm(r.title)
    if (!rt) continue
    if (rt === t || (t.length >= 24 && (rt.includes(t) || t.includes(rt)))) return r
  }
  return null
}

function seedRows(ids: number[]): SurveySeed[] {
  const clean = [...new Set(ids.filter((n) => Number.isFinite(n) && n > 0))].slice(0, 12)
  if (clean.length === 0) return []
  const db = getDb()
  const ph = clean.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, title, year, venue, doi, abstract FROM items WHERE id IN (${ph})`)
    .all(...clean) as Array<{
    id: number
    title: string | null
    year: number | null
    venue: string | null
    doi: string | null
    abstract: string | null
  }>
  const byId = new Map(rows.map((r) => [r.id, r]))
  return clean
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => ({
      itemId: r.id,
      title: (r.title ?? '').trim() || `#${r.id}`,
      year: r.year,
      venue: r.venue,
      doi: r.doi,
      abstract: r.abstract
    }))
}

/** 用种子标题 + 研究方向生成检索词（Google Scholar 对超长 OR 查询不友好） */
function buildQuery(seeds: SurveySeed[], opts: SurveyRunOptions): string {
  const explicit = (opts.query ?? '').trim()
  if (explicit) return explicit
  const first = seeds[0]?.title ?? ''
  const base = first.replace(/\s*[:：].*$/, '').trim() || first
  const focus = (opts.focus ?? '').trim()
  return [base, focus].filter(Boolean).join(' ').slice(0, 300)
}

async function discover(
  query: string,
  opts: SurveyRunOptions,
  seeds: SurveySeed[]
): Promise<{ results: WorkHit[]; source: string; warnings: string[] }> {
  const limit = clampInt(opts.limit, 24, 4, 40)
  const provider = opts.provider ?? 'auto'
  const searchOpts: WorkSearchOptions = {
    page: 1,
    yearFrom: opts.yearFrom ?? null,
    yearTo: opts.yearTo ?? null,
    sort: opts.sort ?? 'recent'
  }
  const warnings: string[] = []
  const seen = new Set<string>()
  const merged: WorkHit[] = []
  const add = (rs: WorkHit[]): void => {
    for (const r of rs) {
      if (seeds.some((s) => sameWork(s, r))) continue
      const key = norm(r.doi || r.title)
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(r)
    }
  }

  // auto：Google 与 OpenAlex 并行；Google 缺 Key/失败时 OpenAlex 仍能兜底。
  // Google 只有标题/被引/来源，OpenAlex 补摘要与开放获取链接。
  const tasks: Array<Promise<{ results: WorkHit[]; warnings: string[]; source: string }>> = []
  if (provider === 'google' || provider === 'auto') {
    tasks.push(
      searchWorks(query, { ...searchOpts, provider: 'google' })
        .then((r) => ({ results: r.results, warnings: r.warnings, source: 'google' }))
        .catch((e: unknown) => ({
          results: [],
          warnings: [`Google Scholar 检索失败：${e instanceof Error ? e.message : String(e)}`],
          source: 'google'
        }))
    )
  }
  if (provider === 'openalex' || provider === 'auto') {
    tasks.push(
      searchWorks(query, { ...searchOpts, provider: 'openalex' })
        .then((r) => ({ results: r.results, warnings: r.warnings, source: 'openalex' }))
        .catch((e: unknown) => ({
          results: [],
          warnings: [`OpenAlex 检索失败：${e instanceof Error ? e.message : String(e)}`],
          source: 'openalex'
        }))
    )
  }

  if (provider === 'semantic') {
    tasks.push(
      searchWorks(query, { ...searchOpts, provider: 'semantic' })
        .then((r) => ({ results: r.results, warnings: r.warnings, source: 'semantic' }))
        .catch((e: unknown) => ({
          results: [],
          warnings: [`Semantic Scholar 检索失败：${e instanceof Error ? e.message : String(e)}`],
          source: 'semantic'
        }))
    )
  }

  const settled = await Promise.all(tasks)
  const sources = new Set<string>()
  for (const r of settled) {
    warnings.push(...r.warnings)
    add(r.results)
    if (r.results.length > 0) sources.add(r.source)
  }

  // auto：Google 无 Key / 被网络阻断时，OpenAlex 仍可能有结果；两家都空再试 Semantic。
  // Semantic Scholar 免费但 429 较常见，所以只作为兜底，不和前两家并行抢配额。
  if (provider === 'auto' && merged.length === 0) {
    try {
      const r = await searchWorks(query, { ...searchOpts, provider: 'semantic' })
      warnings.push(...r.warnings)
      add(r.results)
      if (r.results.length > 0) sources.add('semantic')
    } catch (e) {
      warnings.push(`Semantic Scholar 兜底失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 结果不足且总数允许时补第二页（Google/OpenAlex 都是 20 条/页）
  if (merged.length < limit && sources.has('openalex')) {
    try {
      const r = await searchWorks(query, { ...searchOpts, provider: 'openalex', page: 2 })
      add(r.results)
      warnings.push(...r.warnings)
    } catch {
      /* 第二页失败不影响第一页 */
    }
  }

  // 默认「最新优先」：新领域里高被引旧文会把近两年的工作挤下去。
  if ((opts.sort ?? 'recent') === 'recent') {
    merged.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.citedBy ?? 0) - (a.citedBy ?? 0))
  } else if ((opts.sort ?? 'recent') === 'cited') {
    merged.sort((a, b) => (b.citedBy ?? 0) - (a.citedBy ?? 0))
  }
  return {
    results: merged.slice(0, limit),
    source: sources.size > 1 ? 'mixed' : sources.values().next().value ?? 'openalex',
    warnings: [...new Set(warnings)].slice(0, 12)
  }
}

/** Google Scholar 结果没有摘要：用 OpenAlex 按 DOI/标题补齐（并发 6，最多 20 篇） */
async function enrichCandidates(
  candidates: SurveyCandidate[],
  workers: number
): Promise<{ candidates: SurveyCandidate[]; warnings: string[] }> {
  const warnings: string[] = []
  const missing = candidates.filter((c) => !c.abstract)
  if (missing.length === 0) return { candidates, warnings }
  const targets = missing.slice(0, 20)
  await mapLimit(
    targets,
    6,
    async (c) => {
      const byDoi = c.doi ? await searchWorks(c.doi, { provider: 'openalex', mode: 'doi' }) : null
      const hit =
        byDoi?.results?.[0] ??
        (c.title ? pickByTitle((await searchWorks(c.title, { provider: 'openalex' })).results, c.title) : null)
      if (hit) {
        c.abstract = hit.abstract ?? c.abstract
        c.citedBy = Math.max(c.citedBy ?? 0, hit.citedBy ?? 0)
        c.venue = c.venue ?? hit.venue
        c.year = c.year ?? hit.year
        c.oaUrl = c.oaUrl ?? hit.oaUrl
        c.doi = c.doi ?? hit.doi
      }
      return c
    },
    (c) => c
  )
  if (targets.some((c) => !c.abstract)) {
    warnings.push(`有 ${targets.filter((c) => !c.abstract).length} 篇候选缺少摘要，拆解卡只能依据标题/来源`)
  }
  return { candidates, warnings }
}

const CARD_FIELDS = ['problem', 'method', 'contribution', 'evidence', 'limits', 'relevance'] as const

function parseJsonObject(text: string): Record<string, unknown> | null {
  const s = (text ?? '').trim()
  const candidates = [s]
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1])
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1))
  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      /* 试下一种 */
    }
  }
  return null
}

function parseJsonArray(text: string): unknown[] | null {
  const s = (text ?? '').trim()
  const candidates = [s]
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1])
  const first = s.indexOf('[')
  const last = s.lastIndexOf(']')
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1))
  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as unknown
      if (Array.isArray(v)) return v
    } catch {
      /* 试下一种 */
    }
  }
  return null
}

function mockCard(c: SurveyCandidate, focus: string): SurveyCard {
  const title = c.title || `候选 #${c.index + 1}`
  return {
    index: c.index,
    title,
    problem: '（离线占位）配置模型服务后可生成基于摘要的问题概括。',
    method: '（离线占位）',
    contribution: c.abstract ? c.abstract.slice(0, 160) : '（摘要缺失）',
    evidence: '（离线占位）',
    limits: '（离线占位）',
    relevance: focus ? `与「${focus}」的相关性需配置模型后判断。` : '未指定研究方向。',
    abstractMissing: !c.abstract
  }
}

async function analyzeCandidate(
  c: SurveyCandidate,
  focus: string
): Promise<SurveyCard> {
  const abstract = (c.abstract ?? '').slice(0, 3200)
  const system =
    '你是严谨的学术调研助手。只输出一个 JSON 对象，不要 Markdown、不要解释。' +
    '所有判断必须来自给定标题/摘要；摘要没有的信息写“摘要未提及”，不得编造。'
  const user = [
    `标题：${c.title || '（未知）'}`,
    `来源：${c.venue || '（未知）'}　年份：${c.year ?? '（未知）'}　被引：${c.citedBy ?? 0}`,
    focus ? `用户研究方向：${focus}` : '用户研究方向：（未指定）',
    '',
    `摘要：${abstract || '（缺失）'}`,
    '',
    '请输出 JSON：{"problem":"研究问题","method":"方法","contribution":"主要贡献",' +
      '"evidence":"证据/结果","limits":"局限","relevance":"与用户方向的关系"}；每项 1–2 句，中文。'
  ].join('\n')
  const r = await generate({
    system,
    user,
    mock: () => JSON.stringify(mockCard(c, focus)),
    temperature: 0.1,
    session: 'survey-analyze'
  })
  const obj = parseJsonObject(r.text)
  const card: SurveyCard = { ...mockCard(c, focus) }
  if (obj) {
    for (const k of CARD_FIELDS) {
      const v = obj[k]
      if (typeof v === 'string' && v.trim()) card[k] = v.trim().slice(0, 600)
    }
    card.index = c.index
    card.title = c.title || card.title
    card.abstractMissing = !c.abstract
  }
  return card
}

interface Lens {
  id: string
  label: string
  weight: number
  system: string
}

const LENSES: Lens[] = [
  {
    id: 'method',
    label: '方法创新',
    weight: 1.2,
    system:
      '你是方法评审。只根据给出的卡片，评估每篇论文的方法新颖性、技术深度与可迁移性；' +
      '不要因为被引高就给高分。只输出 JSON 数组。'
  },
  {
    id: 'evidence',
    label: '证据强度',
    weight: 1.1,
    system:
      '你是实验评审。评估证据是否充分、实验/数据是否可信、结论与证据是否匹配；' +
      '摘要未提及证据的不要臆测。只输出 JSON 数组。'
  },
  {
    id: 'relevance',
    label: '领域相关性',
    weight: 1.3,
    system:
      '你是调研向导。评估每篇论文与种子论文/用户研究方向的直接相关性，优先能补齐知识缺口的论文。' +
      '只输出 JSON 数组。'
  },
  {
    id: 'entry',
    label: '入门价值',
    weight: 1.0,
    system:
      '你是导师。评估每篇论文作为该领域入门/综述阅读的价值（清晰度、背景覆盖、可读性）。' +
      '只输出 JSON 数组。'
  },
  {
    id: 'repro',
    label: '可复现性',
    weight: 0.9,
    system:
      '你是复现评审。评估论文是否给出足够的方法/数据/代码线索，是否容易复现或跟进；' +
      '摘要未提及就写低置信度。只输出 JSON 数组。'
  },
  {
    id: 'writing',
    label: '写作清晰度',
    weight: 0.8,
    system:
      '你是写作评审。评估摘要/标题传达研究问题与贡献的清晰程度。只输出 JSON 数组。'
  }
]

function compactCard(card: SurveyCard, candidate: SurveyCandidate): string {
  return [
    `#${candidate.index}`,
    `标题：${card.title}`,
    `来源：${candidate.venue ?? '—'} ${candidate.year ?? ''}｜被引 ${candidate.citedBy ?? 0}`,
    `问题：${card.problem}`,
    `方法：${card.method}`,
    `贡献：${card.contribution}`,
    `证据：${card.evidence}`,
    `局限：${card.limits}`,
    `相关性：${card.relevance}`
  ].join('｜')
}

async function route(
  cards: SurveyCard[],
  candidates: SurveyCandidate[],
  focus: string,
  seeds: SurveySeed[],
  workers: number
): Promise<{ recommendations: SurveyRecommendation[]; warnings: string[]; used: Lens[] }> {
  const n = clampInt(workers, 4, 3, 6)
  const used = LENSES.slice(0, n)
  const warnings: string[] = []
  const compact = cards.map((c) => compactCard(c, candidates[c.index])).join('\n')
  const seedText = seeds.map((s) => `- ${s.title}（${s.venue ?? '—'}, ${s.year ?? '—'}）`).join('\n')
  const scores = new Map<number, { sum: number; count: number; reasons: string[]; lenses: string[] }>()

  await Promise.all(
    used.map(async (lens) => {
      const user = [
        `种子论文：\n${seedText || '（未提供）'}`,
        focus ? `用户研究方向：${focus}` : '用户研究方向：（未指定）',
        '',
        '候选论文卡片：',
        compact,
        '',
        '请选出最值得优先阅读的至多 12 篇，输出 JSON 数组：',
        '[{"index":编号,"score":0-10,"reason":"一句推荐理由（<=60字）"}]',
        '只输出数组。'
      ].join('\n')
      try {
        const r = await generate({
          system: lens.system,
          user,
          mock: () =>
            JSON.stringify(
              cards
                .slice()
                .sort((a, b) => (candidates[b.index]?.citedBy ?? 0) - (candidates[a.index]?.citedBy ?? 0))
                .slice(0, 12)
                .map((c) => ({
                  index: c.index,
                  score: Math.min(10, Math.log10((candidates[c.index]?.citedBy ?? 0) + 1) * 3),
                  reason: '离线占位：按被引排序，配置模型后给出基于内容的理由'
                }))
            ),
          temperature: 0.1,
          session: `survey-route-${lens.id}`
        })
        const arr = parseJsonArray(r.text)
        if (!arr) {
          warnings.push(`路由视角「${lens.label}」返回格式无法解析，已跳过`)
          return
        }
        for (const it of arr) {
          if (!it || typeof it !== 'object') continue
          const rec = it as { index?: unknown; score?: unknown; reason?: unknown }
          const idx = Number(rec.index)
          if (!Number.isFinite(idx) || !cards.some((c) => c.index === idx)) continue
          const score = Math.max(0, Math.min(10, Number(rec.score) || 0))
          const reason = typeof rec.reason === 'string' ? rec.reason.trim().slice(0, 120) : ''
          const ent = scores.get(idx) ?? { sum: 0, count: 0, reasons: [], lenses: [] }
          ent.sum += score * lens.weight
          ent.count += 1
          if (reason) ent.reasons.push(reason)
          if (!ent.lenses.includes(lens.label)) ent.lenses.push(lens.label)
          scores.set(idx, ent)
        }
      } catch (e) {
        warnings.push(`路由视角「${lens.label}」失败：${e instanceof Error ? e.message : String(e)}`)
      }
    })
  )

  // 路由全部失败（离线/模型不可用）时退化为「被引 + 种子标题相关」的确定性排序
  if (scores.size === 0) {
    warnings.push('智能路由未返回结果：已退化为按被引数与标题相关性排序')
    const seedTerms = new Set(
      seeds
        .flatMap((s) => norm(s.title).split(' '))
        .filter((w) => w.length >= 4)
    )
    for (const c of cards) {
      const cand = candidates[c.index]
      const terms = new Set(norm(cand.title).split(' ').filter((w) => w.length >= 4))
      let overlap = 0
      for (const t of terms) if (seedTerms.has(t)) overlap++
      const base = Math.log10((cand.citedBy ?? 0) + 1) * 25 + overlap * 4
      scores.set(c.index, {
        sum: Math.min(10, base / 10),
        count: 1,
        reasons: ['按被引与种子标题词重合度排序（离线兜底）'],
        lenses: ['离线兜底']
      })
    }
  }

  const recommendations: SurveyRecommendation[] = []
  for (const [index, ent] of scores) {
    const card = cards.find((c) => c.index === index) ?? null
    const candidate = candidates[index]
    if (!candidate) continue
    const score = Math.max(0, Math.min(100, Math.round((ent.sum / Math.max(1, ent.count * 10)) * 100)))
    recommendations.push({
      candidate,
      card,
      score,
      reason: ent.reasons[0] ?? '与种子论文方向相关',
      lenses: ent.lenses
    })
  }
  recommendations.sort((a, b) => b.score - a.score || b.candidate.citedBy - a.candidate.citedBy)
  return { recommendations: recommendations.slice(0, 12), warnings, used }
}

export async function runSurvey(opts: SurveyRunOptions): Promise<SurveyResult> {
  const started = Date.now()
  const seeds = seedRows(opts.seedItemIds ?? [])
  const query = buildQuery(seeds, opts)
  if (!query) throw new Error('请选择至少一篇种子论文，或填写检索词')
  const limit = clampInt(opts.limit, 24, 4, 40)
  const analysisWorkers = clampInt(
    opts.analysisWorkers ?? Number(process.env.PAPERDESK_SURVEY_ANALYSIS_WORKERS ?? 24),
    24,
    1,
    32
  )
  const routerWorkers = clampInt(
    opts.routerWorkers ?? Number(process.env.PAPERDESK_SURVEY_ROUTER_WORKERS ?? 4),
    4,
    3,
    6
  )

  const tDiscover = Date.now()
  const found = await discover(query, opts, seeds)
  const discoverMs = Date.now() - tDiscover

  const tEnrich = Date.now()
  const baseCandidates: SurveyCandidate[] = found.results.map((r, i) => ({
    index: i,
    title: r.title ?? `候选 #${i + 1}`,
    year: r.year ?? null,
    venue: r.venue ?? null,
    doi: r.doi ?? null,
    citedBy: r.citedBy ?? 0,
    authors: r.authors ?? [],
    oaUrl: r.oaUrl ?? null,
    abstract: r.abstract ?? null
  }))
  const enriched = await enrichCandidates(baseCandidates, 6)
  const enrichMs = Date.now() - tEnrich
  // 补完摘要/年份后再排一次：OpenAlex 补出的年份可能让「最新优先」更准确
  const candidates = enriched.candidates.slice()
  if ((opts.sort ?? 'recent') === 'recent') {
    candidates.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.citedBy ?? 0) - (a.citedBy ?? 0))
  } else if ((opts.sort ?? 'recent') === 'cited') {
    candidates.sort((a, b) => (b.citedBy ?? 0) - (a.citedBy ?? 0))
  }
  candidates.forEach((c, i) => (c.index = i))

  const tAnalyze = Date.now()
  const focus = (opts.focus ?? '').trim()
  let failed = 0
  const cards = await mapLimit(
    candidates,
    analysisWorkers,
    async (c) => {
      try {
        return await analyzeCandidate(c, focus)
      } catch {
        failed++
        return mockCard(c, focus)
      }
    },
    (c) => {
      failed++
      return mockCard(c, focus)
    }
  )
  const analyzeMs = Date.now() - tAnalyze

  const tRoute = Date.now()
  const routed = await route(cards, candidates, focus, seeds, routerWorkers)
  const routeMs = Date.now() - tRoute

  return {
    query,
    source: found.source,
    warnings: [...new Set([...found.warnings, ...enriched.warnings, ...routed.warnings])],
    seeds,
    candidates,
    analyzed: cards.filter((c) => !c.problem.startsWith('（离线占位）')).length,
    failed,
    recommendations: routed.recommendations,
    timing: {
      discoverMs,
      enrichMs,
      analyzeMs,
      routeMs,
      totalMs: Date.now() - started
    },
    workers: { analysis: analysisWorkers, router: routerWorkers }
  }
}
