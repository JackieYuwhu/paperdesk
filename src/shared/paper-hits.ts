/**
 * 「用 AI 找论文」的纯逻辑：同一篇论文去重、来源标注、入库/打开链接、检索词提取，
 * 以及联网结果的上下文/降级文案。
 *
 * 全部是纯函数（无网络、无数据库），便于单测；主进程的 `services/paper-finder.ts`
 * 与 `services/web-search.ts` 直接复用，保证「界面看到的」和「模型读到的」一致。
 */
import type { WebSource, WorkHit, WorkSource } from './types'

/**
 * 标题归一化：与 `scholar.ts` 的 `normalizeTitle` 完全一致。
 * 这里本地实现（而不是 import）是为了让本模块保持**零运行时依赖**——
 * `scripts/test-unit.ts` 用 Node 原生类型擦除直接跑它，跨文件值导入会要求 `.ts` 扩展名。
 */
function normalizeTitle(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const DOI_PREFIX = /^https?:\/\/(dx\.)?doi\.org\//i

/** DOI 归一化：去 doi.org 前缀 / 首尾空白 / 末尾标点，统一小写 */
export function normalizeDoi(doi: string | null | undefined): string {
  return (doi ?? '')
    .trim()
    .replace(DOI_PREFIX, '')
    .replace(/[.,;]+$/, '')
    .toLowerCase()
}

/**
 * 一条结果的去重键：DOI 优先（最可靠），其次标题归一化，最后退回 id。
 * 同一篇论文在 OpenAlex / Crossref / Semantic 里的 DOI 写法可能不同，所以先归一化。
 */
export function workKey(w: Pick<WorkHit, 'doi' | 'title' | 'id'> | null | undefined): string {
  if (!w) return ''
  const doi = normalizeDoi(w.doi)
  if (doi) return `doi:${doi}`
  const title = normalizeTitle(w.title)
  if (title) return `title:${title}`
  const id = String(w.id ?? '').trim()
  return id ? `id:${id}` : ''
}

/** 两条结果是否指同一篇论文（DOI 或标题任一相同即可；标题用归一化后比较） */
export function isSameWork(
  a: Pick<WorkHit, 'doi' | 'title' | 'id'> | null | undefined,
  b: Pick<WorkHit, 'doi' | 'title' | 'id'> | null | undefined
): boolean {
  if (!a || !b) return false
  const da = normalizeDoi(a.doi)
  const db = normalizeDoi(b.doi)
  if (da && db && da === db) return true
  const ta = normalizeTitle(a.title)
  const tb = normalizeTitle(b.title)
  return !!ta && ta === tb
}

/** 把 extra 的信息补进 into（只填缺失字段；被引取较大值；作者取并集） */
function mergeWork(into: WorkHit, extra: WorkHit): void {
  if (!into.doi && extra.doi) into.doi = extra.doi
  if (!into.title && extra.title) into.title = extra.title
  if (!into.year && extra.year) into.year = extra.year
  if (!into.venue && extra.venue) into.venue = extra.venue
  if (!into.oaUrl && extra.oaUrl) into.oaUrl = extra.oaUrl
  if (!into.abstract && extra.abstract) into.abstract = extra.abstract
  into.citedBy = Math.max(into.citedBy ?? 0, extra.citedBy ?? 0)
  into.isOa = !!into.isOa || !!extra.isOa
  if (extra.authors?.length) {
    const seen = new Set(into.authors ?? [])
    for (const a of extra.authors) {
      if (a && !seen.has(a)) {
        seen.add(a)
        into.authors = [...(into.authors ?? []), a].slice(0, 8)
      }
    }
  }
  const sources = [...(into.sources ?? []), ...(extra.sources ?? []), extra.source, into.source]
    .filter((s): s is WorkSource => !!s)
  into.sources = [...new Set(sources)]
  if (!into.source && extra.source) into.source = extra.source
}

/**
 * 去重：同一 DOI / 同一（归一化）标题只保留一条，缺失字段从重复项补齐。
 * 结果顺序稳定（保留首次出现的顺序）。
 */
export function dedupeWorks(works: WorkHit[]): WorkHit[] {
  const out: WorkHit[] = []
  const byDoi = new Map<string, WorkHit>()
  const byTitle = new Map<string, WorkHit>()
  const byId = new Map<string, WorkHit>()
  for (const raw of works ?? []) {
    if (!raw) continue
    const w: WorkHit = { ...raw, authors: [...(raw.authors ?? [])] }
    if (w.source) w.sources = [...new Set([...(w.sources ?? []), w.source])]
    const doi = normalizeDoi(w.doi)
    const title = normalizeTitle(w.title)
    const hit =
      (doi ? byDoi.get(doi) : undefined) ??
      (title ? byTitle.get(title) : undefined) ??
      (w.id ? byId.get(w.id) : undefined)
    if (hit) {
      mergeWork(hit, w)
      // 合并后可能补上了 DOI / 标题：登记索引，后续同 DOI（不同标题）的结果也能命中
      const mergedDoi = normalizeDoi(hit.doi)
      const mergedTitle = normalizeTitle(hit.title)
      if (mergedDoi && !byDoi.has(mergedDoi)) byDoi.set(mergedDoi, hit)
      if (mergedTitle && !byTitle.has(mergedTitle)) byTitle.set(mergedTitle, hit)
      if (hit.id && !byId.has(hit.id)) byId.set(hit.id, hit)
      continue
    }
    out.push(w)
    if (doi) byDoi.set(doi, w)
    if (title) byTitle.set(title, w)
    if (w.id) byId.set(w.id, w)
  }
  return out
}

/** 一条结果的全部来源（去重、保持顺序） */
export function workSources(w: WorkHit | null | undefined): WorkSource[] {
  const list = [...(w?.sources ?? []), w?.source].filter((s): s is WorkSource => !!s)
  return [...new Set(list)]
}

const SOURCE_NAMES: Record<WorkSource, string> = {
  openalex: 'OpenAlex',
  crossref: 'Crossref',
  google: 'Google Scholar',
  semantic: 'Semantic Scholar'
}

/** 来源展示文案：`OpenAlex + Crossref` */
export function sourceLabel(w: WorkHit | null | undefined): string {
  const names = workSources(w).map((s) => SOURCE_NAMES[s] ?? s)
  return names.length ? names.join(' + ') : '未知来源'
}

/** 入库后「打开原文」的链接：DOI 优先，其次开放获取 PDF/落地页 */
export function workOpenUrl(w: WorkHit | null | undefined): string | null {
  if (!w) return null
  const doi = normalizeDoi(w.doi)
  if (doi) return `https://doi.org/${doi}`
  const oa = (w.oaUrl ?? '').trim()
  return /^https?:\/\//i.test(oa) ? oa : null
}

/** 下载 PDF 的链接（只接受 http(s)） */
export function workPdfUrl(w: WorkHit | null | undefined): string | null {
  const oa = (w?.oaUrl ?? '').trim()
  return /^https?:\/\//i.test(oa) ? oa : null
}

/**
 * 「用 AI 找论文」的检索词启发式提取：去掉「帮我找…的论文」这类口语外壳。
 * 模型可用时优先用模型关键词，这里只是无模型/失败时的兜底（纯函数、可预测）。
 */
export function paperQueryFromQuestion(question: string): string {
  const q = (question ?? '').replace(/\s+/g, ' ').trim()
  if (!q) return ''
  const stripped = q
    .replace(/^(请|麻烦)?\s*(帮我|帮忙|给我|我想)?\s*(用\s*ai\s*)?(找|搜|检索|查|推荐)(一下|一找|些)?\s*/i, '')
    .replace(/\s*(相关|有关)?的?\s*(论文|文献|文章|paper|papers|literature|works?)\s*$/i, '')
    .replace(/^[，。！？、,:：;；\s]+|[，。！？、,:：;；\s]+$/g, '')
    .trim()
  return stripped || q
}

/** 联网结果 → 模型上下文（[W1] 编号，带完整 URL 便于模型原样引用） */
export function webContextBlock(sources: WebSource[] | null | undefined): string {
  return (sources ?? [])
    .filter((s) => s && typeof s.url === 'string' && s.url)
    .map((s) => {
      const body = (s.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200)
      return `[W${s.index}] ${s.title || s.url}\nURL: ${s.url}${body ? `\n${body}` : ''}`
    })
    .join('\n\n')
}

/** 联网失败时的回答前缀（明确告知「未联网」，但继续用论文回答） */
export function webOfflineNote(error?: string | null): string {
  const why = (error ?? '').replace(/\s+/g, ' ').trim()
  return why ? `（未联网：${why}）` : '（未联网）'
}

/**
 * 离线 / 无模型时，用联网结果拼一个确定性的回答（**必须带 URL**，保证可点击）。
 * 有模型时不会走这里；它同时是「mock 分支要给出 URL」的兜底。
 */
export function webAnswerFromSources(
  question: string,
  sources: WebSource[] | null | undefined
): string {
  const list = (sources ?? []).filter((s) => s && s.url)
  const q = (question ?? '').replace(/\s+/g, ' ').trim()
  if (list.length === 0) return `没有检索到与「${q}」相关的网页内容。`
  const lines = list
    .slice(0, 4)
    .map((s) => {
      const brief = (s.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 180)
      return `- [W${s.index}] ${s.title || s.url}：${s.url}${brief ? `\n  ${brief}` : ''}`
    })
  return (
    `（联网检索结果，未使用模型）关于「${q}」找到 ${list.length} 个网页来源：\n\n` +
    lines.join('\n') +
    `\n\n以上链接可直接打开；需要更完整的归纳请在「设置」里配置模型服务。`
  )
}
