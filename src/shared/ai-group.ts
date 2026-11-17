/**
 * 分组级 AI 问答：把「一个分组下的全部论文」拼成一份带编号的上下文。
 *
 * 纯函数、零依赖（只依赖 shared/types 的类型），便于单元测试与主进程复用。
 *
 * 上下文结构（按论文分块，引用编号全局连续）：
 *   【论文 1】《标题》（条目 #12）
 *   [1] 摘要：……
 *   [2] 正文 p.3：……
 *   【论文 2】《标题》（条目 #13）
 *   [3] 摘要：……
 *
 * 截断策略（显式、可观察）：
 *  - 论文数超过 GROUP_MAX_PAPERS → 只取前 N 篇，truncatedPapers = true；
 *  - 单篇摘要只保留 GROUP_ABSTRACT_CHARS，正文片段只保留 GROUP_CHUNK_CHARS；
 *  - 每篇最多 GROUP_CHUNKS_PER_PAPER 段正文（按检索相关度顺序轮转，避免单篇淹没全局）；
 *  - 写入前按字符预算检查，超预算立刻停止，truncatedBody = true。
 */
import type { Citation } from './types'

/** 分组问答题面：每篇论文最多纳入几段正文 */
export const GROUP_CHUNKS_PER_PAPER = 2
/** 分组问答：单段正文片段的字符上限 */
export const GROUP_CHUNK_CHARS = 800
/** 分组问答：单篇摘要的字符上限 */
export const GROUP_ABSTRACT_CHARS = 400
/** 分组问答：一次最多纳入多少篇论文 */
export const GROUP_MAX_PAPERS = 12
/** 分组问答：上下文总字符预算 */
export const GROUP_CONTEXT_BUDGET = 12000

export interface GroupPaper {
  itemId: number
  title: string
  abstract?: string | null
  attachmentId?: number | null
}

export interface GroupHit {
  chunkId: number
  itemId: number
  attachmentId?: number | null
  page?: number | null
  snippet?: string | null
  text?: string | null
  score?: number
}

export interface GroupContext {
  /** 编号连续（1..n）的引用；chunkId = 0 表示该条来自「论文标题/摘要」而不是正文片段 */
  citations: Citation[]
  /** 交给模型的上下文正文 */
  context: string
  /** 分组里的论文总数（去重后） */
  paperCount: number
  /** 实际写进上下文的论文数 */
  usedPapers: number
  /** 是否因预算不足提前停止了正文拼接 */
  truncatedBody: boolean
  /** 是否因论文数超过上限而丢弃了后面的论文 */
  truncatedPapers: boolean
}

/** 折叠空白：把任意输入变成单行文本（空值一律变 ''） */
function clean(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim()
}

/** 截断到 max 个字符，超出则以省略号结尾 */
function clip(text: string, max: number): string {
  if (!text) return ''
  if (text.length <= max) return text
  if (max <= 1) return '…'.slice(0, Math.max(0, max))
  return `${text.slice(0, max - 1)}…`
}

function posInt(raw: unknown): number | null {
  const n = Math.trunc(Number(raw))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 分组名只做空白归一（折行/首尾空格）。
 * 完整规范化（截断到 GROUP_NAME_MAX 等）由调用方用 `library-groups.normalizeGroupName`
 * 完成：本模块要保持可被 `node scripts/test-unit.ts` 直接执行，不引入运行期跨模块 import。
 */
function scopeName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/\s+/g, ' ').trim()
  return s === '' ? null : s
}

/**
 * 统计某个分组（含全部子分组）下的论文数量；groupName 为空表示不统计（返回 0）。
 * 供 AI 面板展示「分组「X」· N 篇」。
 */
export function groupPaperCount(
  items: ReadonlyArray<{ group_name?: string | null }>,
  groupName: string | null | undefined
): number {
  const root = scopeName(groupName)
  if (!root || !Array.isArray(items)) return 0
  const prefix = `${root}/`
  let count = 0
  for (const item of items) {
    const name = scopeName(item?.group_name)
    if (name && (name === root || name.startsWith(prefix))) count += 1
  }
  return count
}

/**
 * 构建分组问答上下文。
 *
 * @param papers 分组内论文（按期望展示顺序；重复 itemId 自动去重）
 * @param hits   这些论文的检索命中（按相关度降序；不属于 papers / 重复 chunkId 的会被忽略）
 * @param budget 上下文字符预算
 */
export function buildGroupContext(
  papers: GroupPaper[],
  hits: GroupHit[],
  budget: number = GROUP_CONTEXT_BUDGET
): GroupContext {
  const limit = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0

  const seenPaper = new Set<number>()
  const all: GroupPaper[] = []
  for (const p of Array.isArray(papers) ? papers : []) {
    if (!p) continue
    const itemId = posInt(p.itemId)
    if (itemId == null || seenPaper.has(itemId)) continue
    seenPaper.add(itemId)
    all.push({
      itemId,
      title: clean(p.title),
      abstract: clean(p.abstract),
      attachmentId: posInt(p.attachmentId)
    })
  }

  const selected = all.slice(0, GROUP_MAX_PAPERS)
  const paperCount = all.length
  const truncatedPapers = all.length > selected.length

  const wanted = new Set(selected.map((p) => p.itemId))
  const byItem = new Map<number, GroupHit[]>()
  const seenChunk = new Set<number>()
  for (const h of Array.isArray(hits) ? hits : []) {
    if (!h) continue
    const chunkId = posInt(h.chunkId)
    const itemId = posInt(h.itemId)
    if (chunkId == null || itemId == null || !wanted.has(itemId)) continue
    if (seenChunk.has(chunkId)) continue
    seenChunk.add(chunkId)
    const list = byItem.get(itemId)
    if (list) list.push(h)
    else byItem.set(itemId, [h])
  }

  interface Pack {
    paper: GroupPaper
    lines: string[]
  }
  const packs: Pack[] = []
  const citations: Citation[] = []
  let used = 0
  let truncatedBody = false

  /** 按预算追加一行；超预算返回 false（不写入、不计费） */
  const tryPush = (pack: Pack, line: string): boolean => {
    const cost = line.length + (pack.lines.length > 0 ? 1 : 0)
    if (used + cost > limit) return false
    pack.lines.push(line)
    used += cost
    return true
  }

  // 第一轮：按论文顺序写「标题 + 摘要」，保证每篇论文至少有一条可引用来源。
  for (const paper of selected) {
    const pack: Pack = { paper, lines: [] }
    const title = paper.title || '（无标题）'
    const header = `【论文 ${packs.length + 1}】《${title}》（条目 #${paper.itemId}）`
    if (!tryPush(pack, header)) {
      truncatedBody = true
      break
    }
    const index = citations.length + 1
    const abstract = clip(paper.abstract ?? '', GROUP_ABSTRACT_CHARS)
    const body = abstract ? `摘要：${abstract}` : `标题：${title}`
    if (!tryPush(pack, `[${index}] ${body}`)) {
      truncatedBody = true
      break
    }
    citations.push({
      index,
      chunkId: 0,
      itemId: paper.itemId,
      attachmentId: paper.attachmentId ?? null,
      page: 1,
      snippet: (abstract || title).slice(0, 200)
    })
    packs.push(pack)
  }

  // 第二轮：按相关度轮转补正文片段，每篇最多 GROUP_CHUNKS_PER_PAPER 段。
  let stopped = false
  for (let round = 0; round < GROUP_CHUNKS_PER_PAPER && !stopped; round += 1) {
    for (const pack of packs) {
      const list = byItem.get(pack.paper.itemId)
      const hit = list ? list[round] : undefined
      if (!hit) continue
      const text = clean(hit.text) || clean(hit.snippet)
      const body = clip(text, GROUP_CHUNK_CHARS)
      if (!body) continue
      const index = citations.length + 1
      const page = posInt(hit.page) ?? 1
      if (!tryPush(pack, `[${index}] 正文 p.${page}：${body}`)) {
        truncatedBody = true
        stopped = true
        break
      }
      const snippet = clean(hit.snippet)
      citations.push({
        index,
        chunkId: posInt(hit.chunkId) ?? 0,
        itemId: pack.paper.itemId,
        attachmentId: posInt(hit.attachmentId) ?? pack.paper.attachmentId ?? null,
        page,
        snippet: (snippet || body).slice(0, 200)
      })
    }
  }

  return {
    citations,
    context: packs.map((pack) => pack.lines.join('\n')).join('\n\n'),
    paperCount,
    usedPapers: packs.length,
    truncatedBody,
    truncatedPapers
  }
}
