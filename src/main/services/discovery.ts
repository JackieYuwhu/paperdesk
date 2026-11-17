import { getDb } from '../db'
import { effective } from './settings'
import { generate } from './llm'
import type {
  DiscoveryDiagnosis,
  DiscoveryGraph,
  DiscoverySource,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  Item
} from '../../shared/types'

const WORK_SELECT = 'id,doi,display_name,publication_year,cited_by_count,primary_location'
const LIMITS = { references: 50, citations: 40, related: 50, topic: 30 }

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** OpenAlex 端点（可用环境变量覆盖，便于镜像/离线测试） */
function oaBase(): string {
  return process.env.PAPERDESK_OPENALEX_BASE ?? 'https://api.openalex.org'
}

/** polite pool 邮箱：设置 > 环境变量 > 默认 */
export function oaMailto(): string {
  return effective('openalex.mailto', 'PAPERDESK_OPENALEX_MAILTO', 'paperdesk@example.com')
}

/** OpenAlex API Key（可选；填了配额大幅提升，避免 429） */
export function oaApiKey(): string {
  return effective('openalex.apikey', 'PAPERDESK_OPENALEX_APIKEY', '')
}

function oaUrl(path: string, params: Record<string, string | number> = {}): string {
  const u = new URL(oaBase().replace(/\/$/, '') + path)
  u.searchParams.set('mailto', oaMailto())
  const key = oaApiKey()
  if (key) u.searchParams.set('api_key', key)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v))
  return u.toString()
}

/** OpenAlex 全局串行队列 + 限速，避免瞬时并发触发 429 */
let oaChain: Promise<unknown> = Promise.resolve()
const oaSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function oaSerialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = oaChain.then(fn, fn)
  oaChain = run.catch(() => undefined)
  return run as Promise<T>
}

async function oaGetRaw(path: string, params: Record<string, string | number> = {}): Promise<any> {
  const url = oaUrl(path, params)
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await oaSleep(1200 * attempt)
    let res: Response
    try {
      res = await fetch(url, { headers: { 'User-Agent': `PaperDesk/0.1.0 (mailto:${oaMailto()})` } })
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      continue
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'))
      if (ra > 0 && ra < 30) await oaSleep(ra * 1000)
      lastErr = new Error(
        'OpenAlex 限流（429）。匿名配额很小，建议在「设置 → 其他」填写 OpenAlex API Key（免费），或稍后重试'
      )
      continue
    }
    if (res.status >= 500) {
      lastErr = new Error(`OpenAlex 服务异常（${res.status}）`)
      continue
    }
    if (!res.ok) throw new Error(`OpenAlex ${res.status}`)
    return res.json()
  }
  throw lastErr ?? new Error('OpenAlex 请求失败')
}

export async function oaGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
  const data = await oaSerialize(() => oaGetRaw(path, params))
  await oaSleep(120) // 请求间隔，进一步降低 429 概率
  return data
}

export const shortId = (full: string | undefined): string =>
  (full ?? '').replace(/^https?:\/\/openalex\.org\//, '')

export const stripDoi = (d: string | null | undefined): string | null =>
  d ? d.replace(/^https?:\/\/(dx\.)?doi\.org\//, '') : null

function toNode(w: any, kind: GraphNodeKind): GraphNode {
  return {
    id: shortId(w.id),
    doi: stripDoi(w.doi),
    title: w.display_name ?? w.title ?? null,
    year: w.publication_year ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    citedBy: w.cited_by_count ?? 0,
    kind
  }
}

/** Crossref 端点（可用环境变量覆盖，便于离线测试） */
function crossrefBase(): string {
  return process.env.PAPERDESK_CROSSREF_BASE ?? 'https://api.crossref.org'
}

const crHeaders = (): Record<string, string> => ({
  'User-Agent': `PaperDesk/0.1.0 (mailto:${oaMailto()})`
})

async function crossrefByTitle(title: string): Promise<string | null> {
  try {
    const u = new URL(`${crossrefBase().replace(/\/$/, '')}/works`)
    u.searchParams.set('query.bibliographic', title)
    u.searchParams.set('rows', '1')
    const r = await fetch(u, { headers: crHeaders() })
    if (!r.ok) return null
    const j = (await r.json()) as any
    return j?.message?.items?.[0]?.DOI ?? null
  } catch {
    return null
  }
}

/** Crossref 解析：找到 DOI 与其记录（含 reference 列表） */
async function crossrefResolve(
  item: Item
): Promise<{ doi: string | null; work: any | null }> {
  const base = crossrefBase().replace(/\/$/, '')
  let doi = item.doi ?? null
  if (!doi && item.title) doi = await crossrefByTitle(item.title)
  if (!doi) return { doi: null, work: null }
  try {
    const r2 = await fetch(`${base}/works/${encodeURIComponent(doi)}`, { headers: crHeaders() })
    if (!r2.ok) return { doi, work: null }
    const j2 = (await r2.json()) as any
    return { doi, work: j2?.message ?? null }
  } catch {
    return { doi, work: null }
  }
}

/** OpenAlex 不可用时的 Crossref 回退图（仅参考文献，无施引/相关） */
async function crossrefGraph(item: Item): Promise<DiscoveryGraph> {
  const { doi, work } = await crossrefResolve(item)
  if (!work) {
    return emptyGraph([
      'OpenAlex 不可用，Crossref 也未找到该论文（可先「识别元数据」补全标题 / DOI，或在设置里填邮箱）'
    ])
  }
  const titleArr = work.title
  const venueArr = work['container-title']
  const seed: GraphNode = {
    id: String(work.DOI ?? doi),
    doi: String(work.DOI ?? doi).toLowerCase(),
    title: Array.isArray(titleArr) ? titleArr[0] : (titleArr ?? null),
    year: work.issued?.['date-parts']?.[0]?.[0] ?? null,
    venue: Array.isArray(venueArr) ? venueArr[0] : (venueArr ?? null),
    citedBy: work['is-referenced-by-count'] ?? 0,
    kind: 'seed'
  }

  const nodes = new Map<string, GraphNode>([[seed.id, seed]])
  const edges: GraphEdge[] = []
  const refs: any[] = Array.isArray(work.reference) ? work.reference : []
  let n = 0
  for (const r of refs) {
    if (n >= LIMITS.references) break
    const id = r?.DOI
      ? `doi:${String(r.DOI).toLowerCase()}`
      : `raw:${String(r?.['article-title'] ?? r?.unstructured ?? '').slice(0, 48)}`
    if (!id.trim() || nodes.has(id)) continue
    nodes.set(id, {
      id,
      doi: r?.DOI ? String(r.DOI).toLowerCase() : null,
      title: r?.['article-title'] ?? r?.unstructured ?? r?.DOI ?? null,
      year: r?.year ? Number(r.year) : null,
      venue: null,
      citedBy: 0,
      kind: 'reference'
    })
    edges.push({ source: seed.id, target: id, type: 'cites' })
    n += 1
  }

  return {
    seed,
    nodes: [...nodes.values()],
    edges,
    warnings: ['OpenAlex 不可用，已回退 Crossref（只含参考文献，暂无施引/相关论文）'],
    stats: { references: n, citations: 0, related: 0 }
  }
}

/** 解析种子论文：优先 DOI；仅当「找不到」(404) 才回退标题检索；限流/异常则上抛给 Crossref 回退 */
async function resolveSeed(item: Item): Promise<any | null> {
  const select = `${WORK_SELECT},referenced_works,related_works`
  let doiErr: unknown = null
  if (item.doi) {
    try {
      const w = await oaGet(`/works/doi:${encodeURIComponent(item.doi)}`, { select })
      if (w?.id) return w
    } catch (e) {
      if (!/404/.test(msg(e))) doiErr = e
    }
  }
  if (doiErr) throw doiErr
  if (item.title) {
    const data = await oaGet('/works', { search: item.title, per_page: 1, select })
    return data?.results?.[0] ?? null
  }
  return null
}

async function fetchByIds(ids: string[], limit: number): Promise<any[]> {
  const uniq = [...new Set(ids.filter(Boolean))].slice(0, limit)
  if (uniq.length === 0) return []
  const out: any[] = []
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50)
    const data = await oaGet('/works', {
      filter: `openalex_id:${chunk.join('|')}`,
      per_page: chunk.length,
      select: WORK_SELECT
    })
    out.push(...(data?.results ?? []))
  }
  return out
}

async function fetchCitations(seedId: string, limit: number): Promise<any[]> {
  const data = await oaGet('/works', {
    filter: `cites:${seedId}`,
    per_page: limit,
    // 施引文献按时间倒序：新领域里「最新引用」比「高被引旧文」更有价值
    sort: 'publication_date:desc',
    select: WORK_SELECT
  })
  return data?.results ?? []
}

/** 按种子标题补一轮最近 2 年的论文（避免 related_works 全是旧文） */
async function fetchRecentByTitle(item: Item, limit: number): Promise<any[]> {
  const title = (item.title ?? '').trim()
  if (!title) return []
  // 长标题整句检索命中率低：去掉副标题，取前 12 个词
  const query = title
    .replace(/\s*[:：].*$/, '')
    .split(/\s+/)
    .slice(0, 12)
    .join(' ')
  if (!query) return []
  const from = `${new Date().getFullYear() - 2}-01-01`
  try {
    const data = await oaGet('/works', {
      search: query,
      filter: `from_publication_date:${from}`,
      sort: 'publication_date:desc',
      per_page: limit,
      select: WORK_SELECT
    })
    return data?.results ?? []
  } catch {
    return []
  }
}

const emptyGraph = (warnings: string[]): DiscoveryGraph => ({
  seed: null,
  nodes: [],
  edges: [],
  warnings,
  stats: { references: 0, citations: 0, related: 0 }
})

/**
 * 按「研究方向」检索（OpenAlex）：把方向词做全文检索，按被引排序返回最有影响力的论文。
 * 结果以「方向」为种子节点，复用相关论文面板的图谱与列表。
 * 不依赖本地库，因此本地没有该方向的数据也能用。
 */
export async function topicGraph(
  query: string,
  limit = LIMITS.topic,
  sort: 'recent' | 'cited' = 'recent'
): Promise<DiscoveryGraph> {
  const q = (query ?? '').trim()
  if (!q) return emptyGraph(['请输入研究方向（例如：蛋白质结构预测 / graph neural network）'])
  const warnings: string[] = []
  let topicName = q
  let topicId: string | null = null
  // 先用 /topics 解析标准主题名（失败不影响检索）
  try {
    const t = await oaGet('/topics', { search: q, per_page: 1 })
    const first = t?.results?.[0]
    if (first?.display_name) {
      topicName = String(first.display_name)
      topicId = shortId(first.id)
    }
  } catch (e) {
    warnings.push(`主题解析失败（不影响检索）：${msg(e)}`)
  }
  let works: any[] = []
  try {
    const data = await oaGet('/works', {
      search: q,
      sort: sort === 'recent' ? 'publication_date:desc' : 'cited_by_count:desc',
      per_page: limit,
      select: WORK_SELECT
    })
    works = data?.results ?? []
  } catch (e) {
    return emptyGraph([`检索失败：${msg(e)}`])
  }
  const seed: GraphNode = {
    id: topicId ? `topic:${topicId}` : `topic:${q}`,
    doi: null,
    title: `研究方向：${topicName}`,
    year: null,
    venue: null,
    citedBy: 0,
    kind: 'seed'
  }
  const nodes: GraphNode[] = [seed]
  const edges: GraphEdge[] = []
  const seen = new Set<string>([seed.id])
  for (const w of works) {
    const n = toNode(w, 'related')
    if (!n.id || seen.has(n.id)) continue
    seen.add(n.id)
    nodes.push(n)
    edges.push({ source: seed.id, target: n.id, type: 'related' })
  }
  if (nodes.length === 1) {
    warnings.push('没有检索到该方向的论文：换个说法，或用英文关键词再试')
  }
  return {
    seed,
    nodes,
    edges,
    warnings,
    stats: { references: 0, citations: 0, related: nodes.length - 1 }
  }
}

/* =========================================================
   本地库兜底：无论能否联网，都给出「参考文献 + 同作者条目」
   ========================================================= */
interface LocalResult {
  seed: GraphNode
  nodes: GraphNode[]
  edges: GraphEdge[]
  references: number
  library: number
}

function seedFromItem(item: Item): GraphNode {
  return {
    id: item.doi ? `doi:${item.doi.toLowerCase()}` : `item:${item.id}`,
    doi: item.doi ? item.doi.toLowerCase() : null,
    title: item.title,
    year: item.year,
    venue: item.venue,
    citedBy: 0,
    kind: 'seed'
  }
}

function localGraph(item: Item): LocalResult {
  const db = getDb()
  const seed = seedFromItem(item)
  const nodes = new Map<string, GraphNode>([[seed.id, seed]])
  const edges: GraphEdge[] = []

  // 参考文献（含未解析出 DOI 的，用原始串做标题）
  const refs = db
    .prepare(
      `SELECT c.target_raw AS raw, w.doi AS doi, w.title AS title, w.year AS year
       FROM citations c LEFT JOIN works w ON w.id = c.target_work_id
       WHERE c.source_item_id = ? ORDER BY c.ref_index`
    )
    .all(item.id) as Array<{ raw: string | null; doi: string | null; title: string | null; year: number | null }>
  let refN = 0
  for (const r of refs) {
    const doi = r.doi ? r.doi.toLowerCase() : null
    const id = doi ? `doi:${doi}` : `raw:${(r.raw ?? '').slice(0, 64)}`
    if (!id.replace(/^raw:/, '') || id === 'raw:' || nodes.has(id)) continue
    nodes.set(id, {
      id,
      doi,
      title: r.title ?? r.raw ?? doi,
      year: r.year ?? null,
      venue: null,
      citedBy: 0,
      kind: 'reference'
    })
    edges.push({ source: seed.id, target: id, type: 'cites' })
    refN++
  }

  // 同作者条目（本地文库）
  const sameAuthor = db
    .prepare(
      `SELECT DISTINCT i.id AS id, i.title AS title, i.year AS year, i.venue AS venue, i.doi AS doi
       FROM item_authors ia1
       JOIN item_authors ia2 ON ia1.author_id = ia2.author_id AND ia2.item_id <> ia1.item_id
       JOIN items i ON i.id = ia2.item_id
       WHERE ia1.item_id = ?
       LIMIT 20`
    )
    .all(item.id) as Array<{ id: number; title: string | null; year: number | null; venue: string | null; doi: string | null }>
  let libN = 0
  for (const it of sameAuthor) {
    const id = `item:${it.id}`
    if (nodes.has(id)) continue
    nodes.set(id, {
      id,
      doi: it.doi ? it.doi.toLowerCase() : null,
      title: it.title,
      year: it.year,
      venue: it.venue,
      citedBy: 0,
      kind: 'library'
    })
    edges.push({ source: seed.id, target: id, type: 'related' })
    libN++
  }

  return { seed, nodes: [...nodes.values()], edges, references: refN, library: libN }
}

/**
 * 把本地兜底节点并入已有图（去重，且不与种子重复）。
 * includeReferences=false 时只并入「本地库（同作者）」节点——避免与 OpenAlex/Crossref
 * 已给出的参考文献重复（它们 id 体系不同）。
 */
function mergeLocal(g: DiscoveryGraph, l: LocalResult, includeReferences: boolean): DiscoveryGraph {
  const ids = new Set(g.nodes.map((n) => n.id))
  const seedId = g.seed?.id ?? l.seed.id
  const nodes = [...g.nodes]
  const edges = [...g.edges]
  for (const n of l.nodes) {
    if (n.kind === 'seed') continue
    if (n.kind === 'reference' && !includeReferences) continue
    if (ids.has(n.id)) continue
    ids.add(n.id)
    nodes.push(n)
    edges.push({ source: seedId, target: n.id, type: n.kind === 'reference' ? 'cites' : 'related' })
  }
  return {
    ...g,
    nodes,
    edges,
    stats: { ...g.stats, local: l.library }
  }
}

/* =========================================================
   AI 辅助搜寻：把标题/摘要/片段交给模型，建议相关论文
   ========================================================= */
interface AiSuggestion {
  title: string
  authors?: string | null
  year?: number | null
  doi?: string | null
}

function parseSuggestions(text: string): AiSuggestion[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as any[]
    if (!Array.isArray(arr)) return []
    return arr
      .map((x) => ({
        title: typeof x?.title === 'string' ? x.title.trim() : '',
        authors: x?.authors ?? null,
        year: typeof x?.year === 'number' ? x.year : x?.year ? Number(x.year) || null : null,
        doi: typeof x?.doi === 'string' && x.doi ? x.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '').toLowerCase() : null
      }))
      .filter((s) => s.title.length > 3)
      .slice(0, 8)
  } catch {
    return []
  }
}

async function aiSuggest(item: Item): Promise<AiSuggestion[]> {
  const db = getDb()
  const abs = (item.abstract ?? '').replace(/\s+/g, ' ').slice(0, 1200)
  const chunks = db
    .prepare(
      `SELECT c.text AS text FROM chunks c JOIN attachments a ON a.id = c.attachment_id
       WHERE a.item_id = ? ORDER BY c.id LIMIT 3`
    )
    .all(item.id) as Array<{ text: string }>
  const snippet = chunks
    .map((c) => c.text.replace(/\s+/g, ' ').slice(0, 600))
    .join('\n---\n')
    .slice(0, 1800)
  if (!item.title && !abs && !snippet) return []

  const system =
    'You are a scholarly literature assistant. Given a paper, suggest 5-8 closely related works ' +
    '(foundational or follow-up). Reply with ONLY a JSON array; each item is ' +
    '{"title": string, "authors": string, "year": number|null, "doi": string|null}. ' +
    'Prefer real, well-known works; never include the input paper itself. No prose, no markdown fences.'
  const user =
    `Title: ${item.title ?? '(unknown)'}\nYear: ${item.year ?? ''}\n` +
    `Abstract: ${abs || '(none)'}\nExcerpts:\n${snippet || '(none)'}`

  const { text } = await generate({ system, user, mock: () => '[]', session: 'related' })
  return parseSuggestions(text)
}

async function aiGraph(item: Item, local: LocalResult, warnings: string[]): Promise<DiscoveryGraph> {
  const nodes = [...local.nodes]
  const edges = [...local.edges]
  const ids = new Set(nodes.map((n) => n.id))
  let aiN = 0
  try {
    const suggestions = await aiSuggest(item)
    for (const s of suggestions) {
      let doi = s.doi ?? null
      // 没有 DOI 时尽力用 Crossref 解析，便于后续「加入文库」可去重
      if (!doi) doi = await crossrefByTitle(s.title)
      doi = doi ? doi.toLowerCase() : null
      const id = doi ? `doi:${doi}` : `ai:${s.title.slice(0, 56)}`
      if (ids.has(id)) continue
      ids.add(id)
      nodes.push({ id, doi, title: s.title, year: s.year ?? null, venue: null, citedBy: 0, kind: 'ai' })
      edges.push({ source: local.seed.id, target: id, type: 'related' })
      aiN++
    }
  } catch (e) {
    warnings.push(`AI 辅助搜寻失败: ${msg(e)}`)
  }
  if (aiN === 0 && !warnings.length) {
    warnings.push('AI 未给出建议（可用「设置」配置模型服务后重试；已展示本地库结果）')
  }
  return {
    seed: local.seed,
    nodes,
    edges,
    warnings,
    stats: {
      references: local.references,
      citations: 0,
      related: aiN,
      local: local.library,
      ai: aiN
    }
  }
}

/** Crossref 参考文献节点（OpenAlex 限流/为空时的补充来源） */
async function crossrefReferenceNodes(
  item: Item,
  seedId: string
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const { work } = await crossrefResolve(item)
  const refs: any[] = Array.isArray(work?.reference) ? work.reference : []
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  for (const r of refs.slice(0, LIMITS.references)) {
    const id = r?.DOI
      ? `doi:${String(r.DOI).toLowerCase()}`
      : `raw:${String(r?.['article-title'] ?? r?.unstructured ?? '').slice(0, 48)}`
    if (id === 'raw:' || !id.trim()) continue
    nodes.push({
      id,
      doi: r?.DOI ? String(r.DOI).toLowerCase() : null,
      title: r?.['article-title'] ?? r?.unstructured ?? r?.DOI ?? null,
      year: r?.year ? Number(r.year) : null,
      venue: null,
      citedBy: 0,
      kind: 'reference'
    })
    edges.push({ source: seedId, target: id, type: 'cites' })
  }
  return { nodes, edges }
}

/**
 * 构建以某条目为中心的引文/相关论文图。
 * source: auto（默认）| openalex | ai —— 任何情况下都会并入本地库兜底，列表不再为空。
 */
export async function buildGraph(
  itemId: number,
  source: DiscoverySource = 'auto'
): Promise<DiscoveryGraph> {
  const db = getDb()
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Item | undefined
  if (!item) return emptyGraph([`条目不存在: ${itemId}`])

  const local = localGraph(item)

  // AI + 网络：先用网络（OpenAlex/Crossref）取回结果，再叠加 AI 建议并标注来源
  if (source === 'auto-ai') {
    const base = await buildGraph(itemId, 'auto')
    try {
      const ai = await aiGraph(item, local, base.warnings)
      const seedId = base.seed?.id ?? local.seed.id
      const ids = new Set(base.nodes.map((n) => n.id))
      let added = 0
      for (const n of ai.nodes) {
        if (n.kind === 'seed' || ids.has(n.id)) continue
        ids.add(n.id)
        base.nodes.push(n)
        added++
      }
      for (const e of ai.edges) {
        // AI 图的种子 id 可能与网络图不同：端点缺失时把 source 归一到种子，端点仍缺则跳过
        const src = ids.has(e.source) ? e.source : seedId
        const dst = ids.has(e.target) ? e.target : null
        if (!dst || src === dst) continue
        if (base.edges.some((x) => x.source === src && x.target === dst)) continue
        base.edges.push({ source: src, target: dst, type: e.type })
      }
      base.stats.ai = added
    } catch (e) {
      base.warnings.push(`AI 建议失败: ${msg(e)}`)
    }
    return base
  }

  // 直接走 AI 辅助
  if (source === 'ai') {
    return aiGraph(item, local, [])
  }

  const warnings: string[] = []
  let seedWork: any = null
  let seedError = ''
  try {
    seedWork = await resolveSeed(item)
  } catch (e) {
    seedError = `解析种子论文失败: ${msg(e)}`
  }

  // OpenAlex 不可用 / 找不到 -> 回退 Crossref；仍失败 -> 使用本地库兜底图
  if (!seedWork) {
    if (seedError) warnings.push(seedError)
    try {
      const g = await crossrefGraph(item)
      if (g.seed) {
        return mergeLocal(g, local, false)
      }
      warnings.push(...g.warnings)
    } catch (e) {
      warnings.push(`Crossref 回退失败: ${msg(e)}`)
    }
    // 本地库兜底（永不为空：至少种子 + 参考文献/同作者条目）
    warnings.push('未能联网获取相关论文，已展示本地库结果')
    return mergeLocal(
      { seed: local.seed, nodes: [local.seed], edges: [], warnings, stats: { references: local.references, citations: 0, related: 0 } },
      local,
      true
    )
  }

  const seed = toNode(seedWork, 'seed')
  const nodes = new Map<string, GraphNode>([[seed.id, seed]])
  const edges: GraphEdge[] = []

  const refIds = (seedWork.referenced_works ?? []).map((x: string) => shortId(x))
  const relIds = (seedWork.related_works ?? []).map((x: string) => shortId(x))

  const [refWorks, relWorks, citeWorks, recentWorks] = await Promise.all([
    fetchByIds(refIds, LIMITS.references).catch((e) => {
      warnings.push(`拉取参考文献失败: ${msg(e)}`)
      return [] as any[]
    }),
    fetchByIds(relIds, LIMITS.related).catch((e) => {
      warnings.push(`拉取相关论文失败: ${msg(e)}`)
      return [] as any[]
    }),
    fetchCitations(seed.id, LIMITS.citations).catch((e) => {
      warnings.push(`拉取施引文献失败: ${msg(e)}`)
      return [] as any[]
    }),
    fetchRecentByTitle(item, 15).catch(() => [] as any[])
  ])

  for (const w of refWorks) {
    const n = toNode(w, 'reference')
    if (!n.id) continue
    nodes.set(n.id, n)
    edges.push({ source: seed.id, target: n.id, type: 'cites' })
  }
  for (const w of relWorks) {
    const n = toNode(w, 'related')
    if (!n.id || nodes.has(n.id)) continue
    nodes.set(n.id, n)
    edges.push({ source: seed.id, target: n.id, type: 'related' })
  }
  for (const w of citeWorks) {
    const n = toNode(w, 'citation')
    if (!n.id || nodes.has(n.id)) continue
    nodes.set(n.id, n)
    edges.push({ source: n.id, target: seed.id, type: 'cites' })
  }
  // related_works 往往偏旧：补一轮「近两年、标题相近」的最新论文，保证新领域能刷到近期工作
  let recentAdded = 0
  for (const w of recentWorks) {
    const n = toNode(w, 'related')
    if (!n.id || nodes.has(n.id)) continue
    nodes.set(n.id, n)
    edges.push({ source: seed.id, target: n.id, type: 'related' })
    recentAdded++
  }
  if (recentAdded > 0) {
    warnings.push(`已补充近两年相关论文 ${recentAdded} 篇（按发表时间倒序，避免只看旧文献）`)
  }

  // OpenAlex 参考文献为空（例如 429 限流）：用 Crossref 的 reference 列表补充
  if (refWorks.length === 0) {
    try {
      const cr = await crossrefReferenceNodes(item, seed.id)
      let added = 0
      for (const n of cr.nodes) {
        if (nodes.has(n.id)) continue
        nodes.set(n.id, n)
        edges.push({ source: seed.id, target: n.id, type: 'cites' })
        added++
      }
      if (added > 0) warnings.push(`OpenAlex 参考文献不可用，已用 Crossref 补充 ${added} 条`)
    } catch (e) {
      warnings.push(`Crossref 参考文献补充失败: ${msg(e)}`)
    }
  }

  const g: DiscoveryGraph = {
    seed,
    nodes: [...nodes.values()],
    edges,
    warnings,
    stats: {
      references: refWorks.length,
      citations: citeWorks.length,
      related: relWorks.length + recentAdded,
      refsTotal: refIds.length,
      citesTotal:
        typeof (seedWork as { cited_by_count?: number }).cited_by_count === 'number'
          ? (seedWork as { cited_by_count?: number }).cited_by_count
          : undefined,
      relatedTotal: relIds.length
    }
  }
  // 并入本地库兜底（同作者条目等），保证即使在线也有本地视角
  return mergeLocal(g, local, false)
}

/** 缓存相关论文结果（同一篇论文的相关论文基本固定，查一次即可） */
export function saveGraphCache(itemId: number, graph: DiscoveryGraph): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO api_cache (cache_key, body, etag, expires_at) VALUES (?, ?, NULL, 0)
         ON CONFLICT(cache_key) DO UPDATE SET body = excluded.body, expires_at = 0`
      )
      .run(`discovery:v2:${itemId}`, JSON.stringify({ graph, at: new Date().toISOString() }))
  } catch {
    /* 忽略缓存失败 */
  }
}

/** 读取缓存的相关论文结果 */
export function cachedGraph(itemId: number): { graph: DiscoveryGraph; cachedAt: string } | null {
  const row = getDb()
    .prepare('SELECT body FROM api_cache WHERE cache_key = ?')
    .get(`discovery:v2:${itemId}`) as { body: string } | undefined
  if (!row) return null
  try {
    const j = JSON.parse(row.body) as { graph: DiscoveryGraph; at: string }
    if (j?.graph) return { graph: j.graph, cachedAt: j.at }
  } catch {
    /* 忽略损坏缓存 */
  }
  return null
}

/** 相关论文自检：定位「OpenAlex 没作用」的原因（限流 / 未找到 / 缺 DOI） */
export async function diagnoseDiscovery(itemId: number): Promise<DiscoveryDiagnosis> {
  const db = getDb()
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Item | undefined
  if (!item) throw new Error(`条目不存在: ${itemId}`)
  const localCitations = (
    db.prepare('SELECT count(*) AS c FROM citations WHERE source_item_id = ?').get(itemId) as {
      c: number
    }
  ).c
  const mailto = oaMailto()
  const hasKey = !!oaApiKey()

  const openalex: DiscoveryDiagnosis['openalex'] = { ok: false, mailto, hasKey }
  try {
    const w = await resolveSeed(item)
    if (w?.id) {
      openalex.ok = true
      openalex.references = (w.referenced_works ?? []).length
      openalex.related = (w.related_works ?? []).length
    } else {
      openalex.error = '未找到该论文（可能缺 DOI/标题，或标题与 OpenAlex 不一致）'
    }
  } catch (e) {
    openalex.error = msg(e)
  }

  const crossref: DiscoveryDiagnosis['crossref'] = { ok: false }
  try {
    const { work } = await crossrefResolve(item)
    if (work) {
      crossref.ok = true
      crossref.references = Array.isArray(work.reference) ? work.reference.length : 0
    } else {
      crossref.error = 'Crossref 未找到该论文'
    }
  } catch (e) {
    crossref.error = msg(e)
  }

  const notes: string[] = []
  notes.push(`条目：${item.title ?? '(无标题)'}${item.doi ? ` · DOI ${item.doi}` : ' · 无 DOI'}`)
  notes.push(`本地已入库参考文献：${localCitations} 条`)
  notes.push(
    openalex.ok
      ? `OpenAlex 可用（参考文献 ${openalex.references ?? 0} · 相关 ${openalex.related ?? 0}）${
          hasKey ? '（已用 API Key）' : '（未设 API Key，易 429 限流）'
        }`
      : `OpenAlex 不可用：${openalex.error ?? '未知'}`
  )
  notes.push(
    crossref.ok
      ? `Crossref 可用（参考文献 ${crossref.references ?? 0} 条）`
      : `Crossref 不可用：${crossref.error ?? '未知'}`
  )
  if (!item.doi) notes.push('建议：先在「元数据 → 识别元数据」补全 DOI/标题，OpenAlex 才能精准匹配')
  if (localCitations === 0) notes.push('本地没有参考文献记录：请在「元数据」里重新「识别元数据」')

  return {
    itemTitle: item.title,
    doi: item.doi,
    localCitations,
    openalex,
    crossref,
    notes
  }
}
