import { getDb } from '../db'
import { searchHybrid } from './search'
import { groupScopeFromPaperIds, SCOPE_ITEM_LIMIT } from '../../shared/knowledge-query'
import { llmConfig, modelHeaders, openCodeEndpointHint, sessionFor } from './settings'
import { chatResponseText, chatStreamText } from '../../shared/model-protocol'
import { requestModel } from './model-request'
import { extractApiError } from './llm'
import { ensureSidecar } from '../sidecar/manager'
import { getModules } from './modules'
import { parseCitations, resolveCitationTargets } from '../../shared/citations'
import { matchChunkToModule } from '../../shared/modules'
import { normalizeMarkdownTable } from '../../shared/md-table'
import { groupPapers } from './library-groups'
import { GROUP_CONTEXT_BUDGET, buildGroupContext } from '../../shared/ai-group'
import type { GroupContext, GroupHit, GroupPaper } from '../../shared/ai-group'
import type {
  AskProgress,
  AskResult,
  AskSelection,
  AskTask,
  AskWebMode,
  Citation,
  KnowledgeHitRef,
  RetrievalMode
} from '../../shared/types'
import { effective, mtConfig } from './settings'
import { webAnswerFromSources, webOfflineNote } from '../../shared/paper-hits'
import {
  getWebSearchMode,
  webForAnswer,
  type WebForAnswer,
  type WebProgress
} from './web-search'
import { translateTexts } from './translate'
import { searchKnowledge } from './knowledge-search'
import type { KnowledgeSearchHit } from '../../shared/knowledge-query'
import {
  detectRequestedLang,
  detectTargetLang,
  detectTranslateIntent,
  inlineSource,
  looksLikeSourceText,
  parseWebMode,
  splitForTranslation,
  wantsWebSearch
} from '../../shared/ask-intent'
import { appendToItemNote } from './notes'
import {
  AI_CHAT_MAX_TOOL_CALLS,
  AI_CHAT_MAX_TOOL_ROUNDS,
  CHAT_TOOL_PROTOCOL,
  buildToolResultsBlock,
  executeToolCalls,
  isToolCallLine,
  parseToolCalls,
  stripToolCallLines,
  type AiChatToolIo
} from './ai-chat-tools'

export type { AskTask } from '../../shared/types'

function chunkText(id: number): string {
  const row = getDb().prepare('SELECT text FROM chunks WHERE id = ?').get(id) as
    | { text: string }
    | undefined
  return row?.text ?? ''
}

/** 批量取正文：分组问答一次要拼很多命中块，避免逐条查库 */
function chunkTexts(ids: number[]): Map<number, string> {
  const map = new Map<number, string>()
  const uniq = [...new Set(ids)]
  if (uniq.length === 0) return map
  const marks = uniq.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT id, text FROM chunks WHERE id IN (${marks})`)
    .all(...uniq) as Array<{ id: number; text: string | null }>
  for (const r of rows) map.set(Number(r.id), r.text ?? '')
  return map
}

/** 统一的 /chat/completions 调用（含 OpenCode 合规头与可读错误） */
async function chat(system: string, user: string, signal?: AbortSignal): Promise<string> {
  const { baseUrl, apiKey, model } = llmConfig()
  if (!baseUrl || !apiKey) throw new Error('未配置 AI：请在「设置」里填写 Base URL 与 API Key')
  const hint = openCodeEndpointHint(baseUrl, model)
  if (hint) throw new Error(hint)
  const res = await requestModel(baseUrl, apiKey, {
      model: model || 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    }, sessionFor.chat(), signal)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${extractApiError(await res.text())}`)
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return chatResponseText(data).trim() || '(空回答)'
}

/** 流式调用回调回的内容 */
interface ChatStreamRound {
  /** 给用户看的文本（工具模式下已剔除 TOOL_CALL 行） */
  text: string
  /** 模型原始输出（含 TOOL_CALL 行，供解析调用） */
  raw: string
}

/**
 * 流式 /chat/completions（SSE）。
 * guardTools=false：与旧版 chatStream 一致，逐 delta 透传。
 * guardTools=true（工具协议）：按行缓冲，TOOL_CALL 行不给用户看，
 * 其余行照常透传，避免「读论文的指令」闪现在回答里。
 */
async function chatSSE(
  system: string,
  user: string,
  onDelta: ((delta: string) => void) | null,
  guardTools: boolean,
  signal?: AbortSignal
): Promise<ChatStreamRound> {
  const { baseUrl, apiKey, model } = llmConfig()
  if (!baseUrl || !apiKey) throw new Error('未配置 AI：请在「设置」里填写 Base URL 与 API Key')
  const hint = openCodeEndpointHint(baseUrl, model)
  if (hint) throw new Error(hint)
  const res = await requestModel(baseUrl, apiKey, {
      model: model || 'gpt-4o-mini',
      temperature: 0,
      stream: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    }, sessionFor.chat(), signal)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${extractApiError(await res.text())}`)
  if (!res.body) throw new Error('响应没有数据流')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let raw = ''
  let out = ''
  let lineBuf = ''
  const emitLine = (line: string) => {
    if (guardTools && isToolCallLine(line)) return
    out += `${line}\n`
    onDelta?.(`${line}\n`)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const j = JSON.parse(payload)
        if (j.type === 'error') throw new Error(j.error?.message || '模型流式响应出错')
        const d = chatStreamText(j)
        if (!d) continue
        raw += d
        if (!guardTools) {
          out += d
          onDelta?.(d)
          continue
        }
        lineBuf += d
        let idx = lineBuf.indexOf('\n')
        while (idx >= 0) {
          emitLine(lineBuf.slice(0, idx))
          lineBuf = lineBuf.slice(idx + 1)
          idx = lineBuf.indexOf('\n')
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        /* 不完整片段：忽略 */
      }
    }
  }
  if (lineBuf.length > 0) emitLine(lineBuf)
  return { text: out.trim(), raw: raw.trim() }
}

/** 旧版透传流式（非工具模式）：等价 guard=false 的 chatSSE */
async function chatStream(
  system: string,
  user: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const r = await chatSSE(system, user, onDelta, false, signal)
  return r.text || '(空回答)'
}

/**
 * 证据分层提示词（阶段一）。
 * 旧版「ONLY the numbered context」会让翻译/术语解释在文库无命中时直接失效，
 * 这里改为：论文证据优先并保留引用 → 通用知识可回答但必须标注【模型知识】→
 * 网页证据单独标注 [Wn]/【网页来源】→ 冲突时解释差异。严格模式另行叠加。
 */
const EVIDENCE_RULES =
  'Evidence rules: numbered blocks [n] are excerpts from the user\'s own papers, [Kn] are published ' +
  'knowledge-base entries, [Wn] are web pages. Cite library evidence as [n] or [Kn] and web evidence as [Wn]. ' +
  'Never invent a citation, page number, quotation or URL. When the question is about these papers, ground the ' +
  'answer in the retrieved excerpts first. Statements that come from your own general knowledge (not from any ' +
  'context block) must be prefixed with 【模型知识】. If the context has nothing relevant but the question asks ' +
  'about a general concept, still answer using your knowledge with that prefix and say it is not from the ' +
  'library. If the question is about a specific claim in a paper and the excerpts do not contain it, say the ' +
  'library does not cover it instead of guessing. If paper and web sources conflict, explain the difference.'

const QA_SYSTEM = `${EVIDENCE_RULES} Reply in the language of the question.`

/** 「严格依据文献」模式：不给模型通用知识，无依据就明确说没有 */
const STRICT_SYSTEM_SUFFIX =
  '\n\nSTRICT MODE: Use ONLY the provided context blocks. Do NOT use outside knowledge. ' +
  'If the blocks do not answer the question, reply exactly: 文献中没有检索到足够依据，无法回答。'

const TERM_SYSTEM =
  'You are a research-paper assistant. Explain the given term. First give a precise definition, then — only if ' +
  'paper context is present — describe how the term is used in these papers with [n] citations. If the term ' +
  'does not appear in the library, say so in one short sentence and continue with a general explanation ' +
  'marked 【模型知识】. Reply in Chinese (中文). ' +
  EVIDENCE_RULES

const WEB_SYSTEM_SUFFIX =
  '\n\n联网检索到的网页上下文以 [W1]、[W2] 标注（与论文引用 [n]、知识库 [Kn] 区分）。引用网页时写 [W1] 这样的标记，' +
  '并在答案末尾列出所用网页的完整 URL（每行一个）。网页内容属于【网页来源】，不要与论文原文混为一谈；' +
  '网页与论文内容冲突时以论文为准，并说明差异。'

/** 严格模式下的固定拒答（无任何依据时不再调用模型，避免它自由发挥） */
const STRICT_NO_EVIDENCE = '（严格依据文献）文献库中没有检索到足够依据，无法回答。'

const TRANSLATE_EMPTY = '没有可翻译的原文：请先选中一段文字，或粘贴要翻译的内容后再提问。'
const TRANSLATE_NO_MODEL =
  '未配置模型服务，无法翻译：请在「设置 → 模型服务」填写 Base URL 与 API Key 后重试（本轮未发送翻译请求）。'

/**
 * 模型调用错误的人话映射：把 HTTP 状态、超时、DNS/连接失败区分开，
 * 不把「模型拒绝/鉴权失败」混成「检索没有结果」或「联网失败」。
 * 未知错误原样返回，避免掩盖上游信息。
 */
export function friendlyModelError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '')
  const text = raw.trim() || '未知错误'
  const status = /HTTP\s+(\d{3})/i.exec(text)?.[1] ?? ''
  if (status === '401' || status === '403') {
    return (
      `模型服务鉴权失败（HTTP ${status}）：API Key 无效、已过期或无权限。` +
      '请在「设置 → 模型服务」重新填写密钥后重试。'
    )
  }
  if (status === '429') return '模型服务限流（HTTP 429）：请求过于频繁，请稍后重试。'
  if (status) return `模型服务返回错误（HTTP ${status}）：${text}`
  if (/timeout|timed out|超时/i.test(text)) {
    return '模型请求超时：模型服务在该时间段内没有响应，请重试或换一个模型。'
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network/i.test(text)) {
    return '无法连接到模型服务（网络不通或 Base URL / 代理配置有误）：请检查网络与设置。'
  }
  return text
}

/** 网页上下文块（仅联网成功且拿到内容时才有） */
function webPrompt(web: WebForAnswer): string {
  return web.status === 'on' && web.text ? `\n\nWeb context:\n${web.text}` : ''
}

/** 回传给渲染层的联网状态字段 */
function webResult(web: WebForAnswer): Pick<AskResult, 'web' | 'webError' | 'webSources'> {
  return {
    web: web.status,
    webError: web.status === 'failed' ? web.error : null,
    webSources: web.sources
  }
}

/** 联网失败：回答开头注明「未联网」，正文照常返回（不阻塞问答） */
function annotateWeb(answer: string, web: WebForAnswer): string {
  return web.status === 'failed' ? `${webOfflineNote(web.error)}\n\n${answer}` : answer
}

/** 离线（mock）名词解释：从命中段落里挑出包含术语的句子，组成“上下文释义” */
function mockExplain(term: string, citations: Citation[]): string {
  if (citations.length === 0) {
    return `没有在全文里检索到与「${term}」相关的内容，无法结合本文解释。`
  }
  const low = term.toLowerCase()
  const excerpts: string[] = []
  for (const c of citations) {
    const text = chunkText(c.chunkId).replace(/\s+/g, ' ')
    const sentences = text.split(/(?<=[.!?。！？])\s+/)
    const hit = sentences.filter((s) => s.toLowerCase().includes(low)).slice(0, 2)
    const picked = (hit.length ? hit : sentences.slice(0, 1)).join(' ')
    if (picked) excerpts.push(`[${c.index}] ${picked.slice(0, 260)}`)
    if (excerpts.length >= 3) break
  }
  return (
    `（离线释义：未配置模型，以下为结合本文检索到的上下文）\n\n` +
    `「${term}」在本文相关段落中的用法：\n\n` +
    excerpts.join('\n\n') +
    `\n\n提示：在「设置」里配置模型服务可获得更完整的术语解释。`
  )
}

/**
 * 检索 -> 引用/上下文（QA 与名词解释共用）。
 * attachmentId 非空时把范围下推到检索 SQL（先范围、后排序、再 LIMIT），不做事后过滤。
 */
async function retrieve(
  query: string,
  opts: {
    limit: number
    mode: RetrievalMode
    attachmentId?: number | null
    /** 是否允许「文内兜底」：仅在论文问答时为真，术语解释不能拿无关片段充数 */
    fallback?: boolean
  }
): Promise<{ citations: Citation[]; context: string; mode: string; primary: number }> {
  const { hits, mode } = await searchHybrid(query, {
    limit: opts.limit * 2,
    mode: opts.mode,
    scope: opts.attachmentId != null ? { attachmentId: opts.attachmentId } : null
  })
  const chunkHits = hits.filter((h) => h.kind === 'chunk').slice(0, opts.limit)

  // 文内兜底：中文泛问（如「这篇论文的主要贡献」）在英文全文里可能一条词面命中都没有。
  // 单篇范围内直接取正文最前面的几块作为上下文（仍带页级引用），
  // 避免把「检索词没命中」当成「论文里没有内容」。
  let fallbackChunks: Array<{ id: number; page: number | null; attachmentId: number }> = []
  if (opts.fallback !== false && chunkHits.length === 0 && opts.attachmentId != null) {
    try {
      fallbackChunks = getDb()
        .prepare(
          `SELECT id, page_index AS page, attachment_id AS attachmentId
             FROM chunks WHERE attachment_id = ?
            ORDER BY COALESCE(page_index, 0) ASC, id ASC LIMIT ?`
        )
        .all(opts.attachmentId, Math.min(3, opts.limit)) as typeof fallbackChunks
    } catch {
      fallbackChunks = []
    }
  }

  // 结构化模块（同一篇论文内）：用于
  //  ①「结构性提问」直接命中模块（图 3 / Table 2 / [1,3] / 公式 (5)）
  //  ②把检索块映射到模块（页码 + 精确矩形 + 类型）
  let doc: Awaited<ReturnType<typeof getModules>> | null = null
  if (opts.attachmentId != null) {
    try {
      const d = await getModules(opts.attachmentId)
      if (d.pageCount > 0 && d.modules.length) doc = d
    } catch {
      doc = null
    }
  }

  type Structural = { page: number; text: string; moduleId: string; moduleKind: string; rect: [number, number, number, number] | null }
  const structural: Structural[] = []
  if (doc) {
    // 三步式引用解析：类型识别 → 编号解析 → 目标匹配（图/表题注、公式编号、参考文献条目）
    const targets = resolveCitationTargets(
      {
        captions: doc.captions,
        refs: doc.refs,
        formulas: doc.formulas,
        modules: doc.modules.map((m) => ({ id: m.id, text: m.text }))
      },
      parseCitations(query)
    )
    for (const t of targets) {
      structural.push({
        page: t.page,
        text: t.text,
        moduleId: t.moduleId,
        moduleKind: t.kind,
        rect: t.rect
      })
    }
  }

  const seenMod = new Set<string>()
  const citations: Citation[] = []
  for (const s of structural) {
    if (seenMod.has(s.moduleId)) continue
    seenMod.add(s.moduleId)
    citations.push({
      index: 0,
      chunkId: 0,
      itemId: null,
      attachmentId: opts.attachmentId ?? null,
      page: s.page,
      snippet: s.text.replace(/\s+/g, ' ').slice(0, 200),
      moduleId: s.moduleId,
      moduleKind: s.moduleKind,
      rect: s.rect
    })
  }
  for (const h of chunkHits) {
    const c: Citation = {
      index: 0,
      chunkId: h.id,
      itemId: h.itemId,
      attachmentId: h.attachmentId,
      page: h.page ?? 1,
      snippet: h.snippet
    }
    if (doc) {
      const m = matchChunkToModule(doc.modules, c.page, chunkText(h.id))
      if (m) {
        if (seenMod.has(m.id)) continue
        seenMod.add(m.id)
        c.moduleId = m.id
        c.moduleKind = m.type
        c.rect = m.rect
        c.page = m.page
      }
    }
    citations.push(c)
  }
  // 兜底块同样进入引用列表（标注为文内兜底，仍可点页码跳转）
  for (const f of fallbackChunks) {
    const text = chunkText(f.id).replace(/\s+/g, ' ')
    if (!text) continue
    citations.push({
      index: 0,
      chunkId: f.id,
      itemId: null,
      attachmentId: f.attachmentId,
      page: (f.page ?? 0) + 1,
      snippet: text.slice(0, 200)
    })
  }
  citations.forEach((c, i) => {
    c.index = i + 1
  })

  const context = citations
    .map((c) => {
      const body = c.chunkId
        ? chunkText(c.chunkId)
        : (c.snippet ?? '')
      return `[${c.index}] ${body.replace(/\s+/g, ' ').slice(0, 1200)}`
    })
    .join('\n\n')
  return {
    citations,
    context,
    // primary = 真正的检索命中（结构化模块 + 检索块），不含文内兜底块。
    // 自动联网据此判断「本地是否真的有依据」，兜底片段不算证据。
    primary: citations.length - fallbackChunks.filter((f) => chunkText(f.id)).length,
    mode: fallbackChunks.length > 0 ? `${mode}+fallback` : mode
  }
}

const GROUP_QA_SYSTEM =
  'You answer questions about a GROUP of research papers, using ONLY the numbered context. ' +
  'Each block 【论文 n】 begins with the paper title and its item id. Cite claims as [n]; when a ' +
  'statement comes from a specific paper, also name it as 《title》(条目 #id). If the context holds ' +
  'two or more papers, cover at least two different papers and compare them where the question allows. ' +
  'State explicitly which papers lack enough context. Reply in the question language.'

interface GroupRetrieval extends GroupContext {
  /** 分组内参与（被纳入上下文）的论文 */
  papers: GroupPaper[]
  /** 实际参与检索的命中块数（用于离线回答/调试） */
  hitCount: number
  /** 形如 group:hybrid、group:lexical+truncated */
  mode: string
}

/** 多轮问答的历史压缩：最近 8 条、每条 400 字 */
function formatHistory(
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
): string {
  return (history ?? [])
    .slice(-8)
    .map(
      (h) =>
        `${h.role === 'user' ? '用户' : '助手'}: ${(h.content ?? '').replace(/\s+/g, ' ').slice(0, 400)}`
    )
    .join('\n')
}

/**
 * 分组检索：先取分组内全部论文（标题/摘要兜底），再把「本组条目」作为范围下推到检索 SQL，
 * 最后按预算拼上下文。即使检索不到正文，标题+摘要也能保证多篇论文可被引用。
 */
async function retrieveGroup(
  query: string,
  opts: { groupName: string; mode: RetrievalMode; limit: number }
): Promise<GroupRetrieval> {
  const papers = groupPapers(opts.groupName)
  let hits: GroupHit[] = []
  let searchMode = 'none'
  if (papers.length > 0 && query) {
    // 分组问答要覆盖多篇论文：候选池比单篇大，但仍设上限
    const searchLimit = Math.min(80, Math.max(24, opts.limit * 12))
    // 范围参数上限内的条目；真正进入上下文的论文远少于该上限（GROUP_MAX_PAPERS）
    const scope = groupScopeFromPaperIds(
      papers.slice(0, SCOPE_ITEM_LIMIT).map((p) => p.itemId)
    )
    const found = await searchHybrid(query, { limit: searchLimit, mode: opts.mode, scope })
    searchMode = found.mode
    const chunkHits = found.hits
      .filter((h) => h.kind === 'chunk' && h.itemId != null)
      .slice(0, searchLimit)
    const texts = chunkTexts(chunkHits.map((h) => h.id))
    hits = chunkHits.map((h) => ({
      chunkId: h.id,
      itemId: Number(h.itemId),
      attachmentId: h.attachmentId,
      page: h.page,
      snippet: h.snippet,
      text: texts.get(h.id) ?? ''
    }))
  }
  const ctx = buildGroupContext(
    papers.map((p) => ({ itemId: p.itemId, title: p.title, abstract: p.abstract, attachmentId: p.attachmentId })),
    hits,
    GROUP_CONTEXT_BUDGET
  )
  const truncated = ctx.truncatedBody || ctx.truncatedPapers
  return {
    ...ctx,
    papers,
    hitCount: hits.length,
    mode: `group:${searchMode}${truncated ? '+truncated' : ''}`
  }
}

/** 离线（mock）分组回答：逐篇列出「标题（条目 #id）+ 可引用片段」，保证至少两篇可见 */
function mockGroupAnswer(
  question: string,
  g: GroupRetrieval & { groupName: string }
): string {
  const q = (question ?? '').trim()
  if (g.citations.length === 0) {
    return `分组「${g.groupName}」里没有可用于回答的论文，或没有检索到与「${q}」相关的内容。`
  }
  const lines: string[] = []
  const seen = new Set<number>()
  for (const paper of g.papers) {
    if (seen.has(paper.itemId)) continue
    const c = g.citations.find((x) => x.itemId === paper.itemId)
    if (!c) continue
    seen.add(paper.itemId)
    const body = (c.chunkId ? chunkText(c.chunkId) : c.snippet ?? '').replace(/\s+/g, ' ').trim()
    lines.push(
      `- 《${paper.title || '（无标题）'}》（条目 #${paper.itemId}）[${c.index}]：${body.slice(0, 180)}…`
    )
    if (lines.length >= 6) break
  }
  const parts: string[] = []
  parts.push(
    `（离线分组回答：未配置模型，以下为分组内检索到的论文要点）\n\n` +
      `分组「${g.groupName}」共 ${g.paperCount} 篇论文，本次纳入 ${g.usedPapers} 篇。`
  )
  if (g.truncatedPapers) parts.push(`（论文数超过上限，只取了前 ${g.usedPapers} 篇。）`)
  if (g.truncatedBody) parts.push('（上下文超出预算，后面的正文片段已截断。）')
  parts.push(lines.join('\n'))
  parts.push(`引用：${g.citations.map((c) => `[${c.index}]`).join(' ')}`)
  parts.push('提示：在「设置」里配置模型服务可获得跨论文的对比与归纳。')
  return parts.join('\n\n')
}

/**
 * 单篇问答的工具 Io：页数/页文本来自 chunks（0 基库内页码，对外 1 基），
 * 翻译与划词翻译共用同一后端配置，写入类工具落阅读笔记。
 */
function createChatToolIo(attachmentId: number): AiChatToolIo {
  let pageCache: number | null = null
  const pageCount = async (): Promise<number> => {
    if (pageCache != null) return pageCache
    try {
      const d = await getModules(attachmentId)
      if (d.pageCount > 0) {
        pageCache = d.pageCount
        return pageCache
      }
    } catch {
      /* 结构化模块失败：退回按 chunks 里的最大页号 */
    }
    const row = getDb()
      .prepare('SELECT MAX(page_index) AS maxPage FROM chunks WHERE attachment_id = ?')
      .get(attachmentId) as { maxPage: number | null } | undefined
    pageCache = row?.maxPage != null ? Number(row.maxPage) + 1 : 0
    return pageCache
  }
  return {
    pageCount,
    pageText: async (page) => {
      const rows = getDb()
        .prepare(
          'SELECT text FROM chunks WHERE attachment_id = ? AND page_index = ? ORDER BY id'
        )
        .all(attachmentId, Math.max(0, Math.floor(page) - 1)) as Array<{ text: string | null }>
      return rows.map((r) => r.text ?? '').filter(Boolean).join('\n')
    },
    translate: async (text, lang) => {
      const out = await translateTexts([text], lang)
      return { backend: out.backend, text: out.texts[0] ?? '' }
    },
    appendNote: async (section, content) => {
      const row = getDb()
        .prepare('SELECT item_id AS itemId FROM attachments WHERE id = ?')
        .get(attachmentId) as { itemId: number | null } | undefined
      if (!row?.itemId) throw new Error('当前论文没有关联的文献条目，无法写入笔记')
      const note = appendToItemNote(Number(row.itemId), section, content)
      return { noteTitle: note.title ?? '' }
    }
  }
}

/** 一次问答里工具循环的实际执行情况（用于 mode 标注与调试） */
interface ToolLoopRounds {
  executed: number
  names: string[]
}

/**
 * 带工具循环的问答：模型先答（可 TOOL_CALL）→ 服务端执行工具 →
 * 把结果块回灌补答。最多 AI_CHAT_MAX_TOOL_ROUNDS 轮工具执行，
 * 总调用数不超过 AI_CHAT_MAX_TOOL_CALLS。
 */
async function qaWithTools(
  system: string,
  basePrompt: string,
  io: AiChatToolIo | null,
  onDelta: ((delta: string) => void) | null,
  signal?: AbortSignal
): Promise<{ answer: string; rounds: ToolLoopRounds }> {
  const rounds: ToolLoopRounds = { executed: 0, names: [] }
  let prompt = basePrompt
  let answer = ''
  for (let pass = 0; pass <= AI_CHAT_MAX_TOOL_ROUNDS; pass++) {
    let raw = ''
    if (onDelta) {
      const r = await chatSSE(system, prompt, onDelta, true, signal)
      raw = r.raw
      answer = r.text || '(空回答)'
    } else {
      raw = await chat(system, prompt, signal)
      answer = stripToolCallLines(raw).trim() || '(空回答)'
    }
    if (pass >= AI_CHAT_MAX_TOOL_ROUNDS) return { answer, rounds }
    const calls = parseToolCalls(raw)
    const budget = AI_CHAT_MAX_TOOL_CALLS - rounds.executed
    const todo = calls.slice(0, Math.max(0, budget))
    if (calls.length === 0 || todo.length === 0) return { answer, rounds }
    const records = await executeToolCalls(todo, io, { allowWrite: false })
    for (const r of records) {
      rounds.executed++
      if (!rounds.names.includes(r.name)) rounds.names.push(r.name)
    }
    prompt = `${basePrompt}\n\n${buildToolResultsBlock(pass + 1, records)}`
  }
  return { answer, rounds }
}

/* =========================================================
   阶段一：翻译任务、知识库检索、取消与进度
   ========================================================= */

/** 进行中的问答（key = 渲染层生成的 requestId），用于取消与 AbortController 复用 */
const askControllers = new Map<string, AbortController>()
/** 取消请求比 ask 先到时的标记（避免「点了取消但请求还没开始」丢事件） */
const cancelledAsks = new Set<string>()

/**
 * 取消一次进行中的问答/翻译。返回 true 表示命中正在进行的请求并已 abort；
 * 返回 false 但仍登记了取消标记，ask 启动时会立刻看到。
 */
export function cancelAsk(requestId?: string | null): boolean {
  const id = (requestId ?? '').trim()
  if (!id) return false
  const c = askControllers.get(id)
  if (c) {
    c.abort()
    askControllers.delete(id)
    return true
  }
  cancelledAsks.add(id)
  return false
}

function isAbortError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? ''
  return name === 'AbortError' || /aborted|abort/i.test((e as Error)?.message ?? '')
}

/** 翻译前检查模型配置：未配置就明确失败，不拿离线占位文本冒充译文 */
function translationModelReady(): boolean {
  if (mtConfig().backend === 'openai') return true
  return effective('provider.mode', 'PAPERDESK_PROVIDER_MODE', 'auto') === 'mock'
}

/** 空联网结果（不请求搜索） */
function offWeb(): WebForAnswer {
  return { status: 'off', error: null, sources: [], text: '', fetched: 0, reason: 'off' }
}

/** 知识库命中 → 界面用的轻量引用 */
function knowledgeRefs(hits: KnowledgeSearchHit[]): KnowledgeHitRef[] {
  return hits.map((h) => ({
    id: h.id,
    key: h.key,
    kind: h.kind,
    title: h.title,
    snippet: h.snippet,
    itemId: h.itemId,
    attachmentId: h.attachmentId
  }))
}

/** 知识库命中 → 提示词上下文（[K1]…，与论文 [n]、网页 [Wn] 区分） */
function kbContext(hits: KnowledgeSearchHit[]): string {
  if (hits.length === 0) return ''
  const blocks = hits
    .slice(0, 4)
    .map((h, i) => `[K${i + 1}] 《${h.title || h.key}》（${h.kind}）${h.snippet}`)
  return `知识库命中（已发布条目）：\n${blocks.join('\n')}`
}

/** 离线（未配置模型）时的知识库摘要 */
function kbSummary(hits: KnowledgeSearchHit[]): string {
  if (hits.length === 0) return ''
  const lines = hits
    .slice(0, 4)
    .map((h, i) => `[K${i + 1}] 《${h.title || h.key}》（${h.kind}）：${h.snippet}`)
  return `知识库相关条目：\n${lines.join('\n')}`
}

/**
 * 检索已发布知识库（knowledge_entries, state='active'）。
 * 范围与论文检索保持一致：单篇 → attachmentId；分组 → itemIds；否则全库。
 * 任何异常都降级为空命中（知识库不该阻断问答）。
 */
function knowledgeFor(
  query: string,
  opts: { attachmentId?: number | null; itemIds?: number[] | null }
): { hits: KnowledgeSearchHit[]; context: string; refs: KnowledgeHitRef[] } {
  const empty = { hits: [] as KnowledgeSearchHit[], context: '', refs: [] as KnowledgeHitRef[] }
  const q = (query ?? '').trim()
  if (!q) return empty
  try {
    const itemIds = (opts.itemIds ?? []).filter((n) => Number.isFinite(n) && n > 0)
    const hits = searchKnowledge(getDb(), q, {
      limit: 4,
      scope: itemIds.length
        ? { itemIds }
        : opts.attachmentId != null
          ? { attachmentId: opts.attachmentId }
          : null
    })
    return { hits, context: kbContext(hits), refs: knowledgeRefs(hits) }
  } catch {
    return empty
  }
}

/**
 * 翻译任务：原文 → 分段 → 逐段调用翻译服务，段间上报进度，支持取消。
 * 与问答完全解耦：不做检索、不要求命中，也不受「只能依据检索内容」提示词影响。
 */
async function translateTask(
  sourceText: string,
  targetLang: 'zh' | 'en',
  opts: { requestId?: string; selection?: AskSelection | null; signal?: AbortSignal },
  onDelta: ((delta: string) => void) | null,
  onProgress: ((p: AskProgress) => void) | null
): Promise<AskResult> {
  const src = (sourceText ?? '').trim()
  if (!src) throw new Error(TRANSLATE_EMPTY)
  if (!translationModelReady()) throw new Error(TRANSLATE_NO_MODEL)
  const chunks = splitForTranslation(src)
  if (chunks.length === 0) throw new Error(TRANSLATE_EMPTY)
  const signal = opts.signal ?? (opts.requestId ? askControllers.get(opts.requestId)?.signal : undefined)
  const langLabel = targetLang === 'zh' ? '中文' : '英文'
  // 先推标题：长文分段翻译时界面立刻有反馈，不必等最后一段
  onDelta?.(`【译文 · ${langLabel}】\n\n`)
  const out: string[] = []
  let cancelled = false
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) {
      cancelled = true
      break
    }
    onProgress?.({
      phase: 'translate',
      done: i,
      total: chunks.length,
      message: `正在翻译第 ${i + 1}/${chunks.length} 段…`
    })
    let piece = ''
    try {
      // 取消信号传到底层请求：正在飞的那一段会立即中断，而不是等它返回
      const r = await translateTexts([chunks[i]], targetLang, { signal })
      piece = (r.texts[0] ?? '').trim()
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) {
        cancelled = true
        break
      }
      throw e
    }
    out.push(piece)
    // 每完成一段立刻显示一段（渲染层按追加处理，最终答案会整体覆盖）
    if (piece) onDelta?.(`${piece}\n\n`)
    onProgress?.({
      phase: 'translate',
      done: i + 1,
      total: chunks.length,
      message: `已翻译 ${i + 1}/${chunks.length} 段`
    })
    if (signal?.aborted) {
      cancelled = true
      break
    }
  }
  const completed = out.filter(Boolean).length
  const body = out.filter(Boolean).join('\n\n')
  const head =
    `【译文 · ${langLabel}】` +
    (chunks.length > 1
      ? `（共 ${chunks.length} 段${cancelled ? `，已取消，完成 ${completed}/${chunks.length} 段` : ''}）`
      : '')
  const parts: string[] = []
  if (body) parts.push(body)
  else parts.push(cancelled ? '（已取消，尚未完成任何段落）' : '（译文为空：模型没有返回内容）')
  if (cancelled) {
    parts.push(
      `（已取消：完成 ${completed}/${chunks.length} 段，以上为已完成部分；再次发送可继续翻译剩余内容。）`
    )
  }
  const answer = `${head}\n\n${parts.join('\n\n')}`
  // 离线/mock 后端：结果不是模型译文，必须明确标注，不能当真实翻译展示
  const notice =
    mtConfig().backend === 'openai'
      ? ''
      : '\n\n（离线占位：本轮没有调用真实翻译模型。配置「设置 → 模型服务」的 Base URL 与 API Key 后即为真实译文。）'
  return {
    answer: answer + notice,
    citations: [],
    backend: mtConfig().backend,
    mode: `translate:${chunks.length}${cancelled ? ':cancelled' : ''}`,
    web: 'off',
    webMode: 'off',
    translation: {
      sourceText: src,
      targetLang,
      chunks: chunks.length,
      cancelled,
      completed
    }
  }
}

/**
 * 检索增强回答：task=qa 回答问题；task=term 解释名词；task=translate 翻译原文。
 * 统一入口，便于渲染层复用同一套引用/跳转。
 */
/** 失败时也要带回渲染层的元信息（检索结果与来源在模型失败时依然有效） */
interface AskMetaInfo {
  web?: AskResult['web']
  webError?: string | null
  webHint?: string | null
  webSources?: AskResult['webSources']
  webMode?: AskWebMode
  strict?: boolean
  knowledgeHits?: KnowledgeHitRef[]
  scopeLabel?: string
}

export async function ask(
  question: string,
  opts: {
    backend?: string
    limit?: number
    mode?: RetrievalMode
    task?: AskTask
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    /** 限定在当前论文（附件）内检索；为空则全库检索 */
    attachmentId?: number | null
    /** 分组级问答：针对该分组（含子分组）的全部论文；仅 task=qa 生效 */
    groupName?: string | null
    /** 显式论文集合（全库/分组之外的检索范围）：知识库检索按此收窄 */
    itemIds?: number[] | null
    /**
     * 联网模式（三态）。缺省读设置 `ai.webSearch`（'1'→always / 'auto' / 其他→off）。
     * 兼容旧调用方的布尔值：true→always、false→off。
     * off 时**绝不发起搜索请求**；失败只会降级，不抛错。
     */
    web?: boolean | AskWebMode
    /**
     * 「严格依据文献」：只用检索到的论文/知识库/网页，无依据时固定拒答。
     */
    strict?: boolean
    /** 翻译任务的显式原文（选区/粘贴全文，优先于 question 与 history） */
    sourceText?: string
    /** 选区上下文（含附件与页码，随消息持久化） */
    selection?: AskSelection | null
    /** 翻译目标语言；缺省按原文语种推断 */
    targetLang?: 'zh' | 'en'
    /** 一次问答/翻译的标识：用于进度推送与取消（ai.cancel） */
    requestId?: string
    /** 进度回调（主进程经 EVT.aiProgress 转发） */
    onProgress?: (p: AskProgress) => void
    /**
     * 是否允许问答调用只读工具（读论文全文/读指定页/翻译文本，
     * 见 src/main/services/ai-chat-tools.ts）。默认开启（仅单篇 QA）；
     * false 完全关闭，行为与旧版一致。
     */
    tools?: boolean
  } = {},
  /** 传了回调则走**流式**输出（逐段回调），否则一次性返回 */
  onDelta?: (delta: string) => void
): Promise<AskResult> {
  const backend = opts.backend ?? llmConfig().backend
  const task: AskTask = opts.task ?? 'qa'
  const limit = opts.limit ?? (task === 'term' ? 6 : 5)
  const q = (question ?? '').trim()
  const groupName = typeof opts.groupName === 'string' ? opts.groupName.trim() : ''

  const strict = opts.strict === true
  const progress = opts.onProgress ?? null

  // 取消 / 进度登记：requestId 由渲染层生成，一次问答或翻译一个。
  // 若取消请求比 ask 先到（cancelledAsks 里已有标记），立刻 abort，避免白跑一轮模型。
  const requestId = (opts.requestId ?? '').trim()
  const controller = requestId ? new AbortController() : null
  if (controller && requestId) {
    askControllers.set(requestId, controller)
    if (cancelledAsks.delete(requestId)) controller.abort()
  }
  const signal = controller?.signal

  // 联网三态：缺省读设置；'off' 时绝不发起搜索请求
  const requestedWeb: AskWebMode =
    opts.web === undefined ? await getWebSearchMode() : parseWebMode(opts.web)

  /**
   * 统一的结果元信息：联网状态 + 生效模式 + 严格模式 + 知识库命中 + 检索范围。
   * 同时记下最后一次生效的元信息：模型失败时也要把「已搜到的网页来源」带回渲染层，
   * 避免检索成功、模型 401/超时却只看到一行错误。
   */
  let lastMeta: AskMetaInfo | null = null
  const metaOf = (
    web: WebForAnswer,
    refs: KnowledgeHitRef[],
    scope: string,
    hint?: string | null
  ) => {
    const m = {
      ...webResult(web),
      webMode: requestedWeb,
      strict,
      knowledgeHits: refs,
      scopeLabel: scope,
      ...(hint ? { webHint: hint } : {})
    }
    lastMeta = m
    return m
  }

  try {
    // ===== 翻译任务：不检索、不等命中；原文来自选区全文 / 粘贴 / 上一条消息 =====
    if (task === 'translate') {
      // 上一条「翻译：<原文>」只取原文本身，别把「翻译：」一起送进模型
      const fromHistory = (opts.history ?? [])
        .slice()
        .reverse()
        .find((h) => h.role === 'user' && looksLikeSourceText(h.content))
      const historyText = fromHistory
        ? detectTranslateIntent(fromHistory.content)
          ? (inlineSource(fromHistory.content) ?? fromHistory.content)
          : fromHistory.content
        : ''
      const fallbackSource = looksLikeSourceText(q) ? q : historyText
      const sourceText =
        (opts.sourceText ?? '').trim() || opts.selection?.text?.trim() || fallbackSource
      // 目标语言优先级：调用方（界面/显式指定）> 问句里的「翻译成中文/英文」> 原文语种推断
      const targetLang =
        opts.targetLang ??
        detectRequestedLang(q) ??
        detectRequestedLang(sourceText) ??
        detectTargetLang(sourceText || q)
      return await translateTask(
        sourceText,
        targetLang,
        { requestId, selection: opts.selection ?? null, signal },
        onDelta ?? null,
        progress
      )
    }

    progress?.({ phase: 'retrieve', done: 0, total: 1, message: '正在检索论文…' })

    // ===== 分组级问答：上下文来自分组内全部论文，而不是当前一篇 =====
    if (groupName && task === 'qa') {
      const g = await retrieveGroup(q, {
        groupName,
        mode: opts.mode ?? 'hybrid',
        limit
      })
      progress?.({ phase: 'knowledge', done: 0, total: 1, message: '正在检索知识库…' })
      const kb = knowledgeFor(q, { itemIds: g.papers.map((p) => p.itemId) })
      const askedWeb = wantsWebSearch(q)
      const wantWeb =
        requestedWeb === 'always' ||
        (requestedWeb === 'auto' &&
          (askedWeb || (g.citations.length === 0 && kb.hits.length === 0)))
      const web: WebForAnswer = wantWeb
        ? await webForAnswer(q, true, undefined, progress ?? undefined)
        : offWeb()
      const webHint =
        requestedWeb === 'off' && askedWeb
          ? '联网已关闭：本轮没有发送搜索请求（把工具栏「联网」改为「自动」或「始终」后可检索网页）。'
          : null
      const webSuffix = web.status === 'on' ? WEB_SYSTEM_SUFFIX : ''
      const scope =
        `分组「${groupName}」· 纳入 ${g.usedPapers}/${g.paperCount} 篇` +
        ` · 知识库 ${kb.hits.length}` +
        (web.status === 'on' ? ` · 网页 ${web.sources.length}` : '')
      const meta = metaOf(web, kb.refs, scope, webHint)

      if (
        strict &&
        g.citations.length === 0 &&
        kb.hits.length === 0 &&
        web.status !== 'on'
      ) {
        onDelta?.(STRICT_NO_EVIDENCE)
        return { answer: STRICT_NO_EVIDENCE, citations: [], backend, mode: g.mode, ...meta }
      }
      if (backend === 'openai') {
        const hist = formatHistory(opts.history)
        const prompt =
          `分组：${groupName}（共 ${g.paperCount} 篇，本次纳入 ${g.usedPapers} 篇）\n\n` +
          (hist ? `此前的对话（供理解追问，不要重复回答）：\n${hist}\n\n` : '') +
          `Context:\n${g.context}` +
          (kb.context ? `\n\n${kb.context}` : '') +
          `\n\nQuestion: ${q}` +
          webPrompt(web)
        const system = GROUP_QA_SYSTEM + (strict ? STRICT_SYSTEM_SUFFIX : '') + webSuffix
        const answer = onDelta
          ? await chatStream(system, prompt, onDelta, signal)
          : await chat(system, prompt, signal)
        return {
          answer: annotateWeb(answer, web),
          citations: g.citations,
          backend,
          mode: g.mode,
          ...meta
        }
      }
      const groupOffline = mockGroupAnswer(q, { ...g, groupName })
      const offline = annotateWeb(
        [groupOffline, kbSummary(kb.hits)]
          .filter(Boolean)
          .concat(web.status === 'on' ? [webAnswerFromSources(q, web.sources)] : [])
          .join('\n\n'),
        web
      )
      onDelta?.(offline)
      return { answer: offline, citations: g.citations, backend, mode: g.mode, ...meta }
    }

    const { citations, context, mode, primary } = await retrieve(q, {
      limit,
      mode: opts.mode ?? 'hybrid',
      attachmentId: opts.attachmentId ?? null,
      fallback: task !== 'term'
    })
    progress?.({ phase: 'knowledge', done: 0, total: 1, message: '正在检索知识库…' })
    const kb = knowledgeFor(q, {
      attachmentId: opts.attachmentId ?? null,
      itemIds: opts.itemIds ?? null
    })
    // 自动联网看的是「真实命中」：文内兜底片段（截取论文开头）不算依据，
    // 否则本该联网的术语/外部问题会被兜底块永久拦住。
    const askedWeb = wantsWebSearch(q)
    const wantWeb =
      requestedWeb === 'always' ||
      (requestedWeb === 'auto' && (askedWeb || (primary === 0 && kb.hits.length === 0)))
    const web: WebForAnswer = wantWeb
      ? await webForAnswer(q, true, undefined, progress ?? undefined)
      : offWeb()
    const webHint =
      requestedWeb === 'off' && askedWeb
        ? '联网已关闭：本轮没有发送搜索请求（把工具栏「联网」改为「自动」或「始终」后可检索网页）。'
        : null
    const webSuffix = web.status === 'on' ? WEB_SYSTEM_SUFFIX : ''
    const scope =
      (opts.attachmentId != null ? '本文' : '全库') +
      ` · 论文片段 ${citations.length} · 知识库 ${kb.hits.length}` +
      (web.status === 'on' ? ` · 网页 ${web.sources.length}` : '')
    const meta = metaOf(web, kb.refs, scope, webHint)
    const evidenceContext = [context, kb.context].filter(Boolean).join('\n\n')

    if (task === 'term') {
      if (strict && citations.length === 0 && kb.hits.length === 0 && web.status !== 'on') {
        onDelta?.(STRICT_NO_EVIDENCE)
        return { answer: STRICT_NO_EVIDENCE, citations: [], backend, mode, ...meta }
      }
      if (backend === 'openai') {
        const prompt =
          `Term: ${q}\n\n` +
          `Context:\n${evidenceContext || '（本文与知识库都没有检索到该术语；请先说明「文库中未出现该术语」，再用通用知识解释并标注【模型知识】。）'}` +
          webPrompt(web)
        const system = TERM_SYSTEM + (strict ? STRICT_SYSTEM_SUFFIX : '') + webSuffix
        const answer = onDelta
          ? await chatStream(system, prompt, onDelta, signal)
          : await chat(system, prompt, signal)
        return { answer: annotateWeb(answer, web), citations, backend, mode, ...meta }
      }
      // 未配置模型：给出检索片段 + 如实说明，不冒充「模型解释」
      const parts: string[] = []
      if (citations.length > 0) parts.push(mockExplain(q, citations))
      else parts.push(`没有为「${q}」检索到论文原文或知识库条目。`)
      if (kb.hits.length > 0) parts.push(kbSummary(kb.hits))
      if (web.status === 'on' && web.sources.length > 0) {
        parts.push(webAnswerFromSources(q, web.sources))
      }
      parts.push('提示：未配置模型服务，无法用通用知识解释该术语；在「设置」里配置模型后重试。')
      const offline = annotateWeb(parts.join('\n\n'), web)
      onDelta?.(offline)
      return { answer: offline, citations, backend, mode, ...meta }
    }

    // ===== 问答（多轮上下文 + 可选联网 + 知识库 + 单篇只读工具）=====
    const toolsOn =
      task === 'qa' && groupName === '' && opts.attachmentId != null && opts.tools !== false
    if (
      strict &&
      citations.length === 0 &&
      kb.hits.length === 0 &&
      web.status !== 'on' &&
      !toolsOn
    ) {
      onDelta?.(STRICT_NO_EVIDENCE)
      return { answer: STRICT_NO_EVIDENCE, citations: [], backend, mode, ...meta }
    }
    if (backend === 'openai') {
      const hist = formatHistory(opts.history)
      const contextNote =
        evidenceContext ||
        (toolsOn
          ? '（检索没有命中文本；请用 read-paper/read-page 工具读取论文正文后再回答。）'
          : '（检索没有命中论文片段或知识库条目；若问题超出文库范围，请用【模型知识】明确标注后回答。）')
      const prompt =
        (hist ? `此前的对话（供理解追问，不要重复回答）：\n${hist}\n\n` : '') +
        `Context:\n${contextNote}\n\nQuestion: ${q}` +
        webPrompt(web)
      if (toolsOn) {
        // 工具模式：模型可用 TOOL_CALL 读当前论文/指定页/翻译文本，读到的内容会回灌补答
        const toolSystem =
          QA_SYSTEM + (strict ? STRICT_SYSTEM_SUFFIX : '') + webSuffix + CHAT_TOOL_PROTOCOL
        const io = createChatToolIo(Number(opts.attachmentId))
        const { answer, rounds } = await qaWithTools(toolSystem, prompt, io, onDelta ?? null, signal)
        return {
          answer: annotateWeb(answer, web),
          citations,
          backend,
          mode: rounds.executed > 0 ? `${mode}+tools(${rounds.executed})` : mode,
          ...meta
        }
      }
      const system = QA_SYSTEM + (strict ? STRICT_SYSTEM_SUFFIX : '') + webSuffix
      const answer = onDelta
        ? await chatStream(system, prompt, onDelta, signal)
        : await chat(system, prompt, signal)
      return { answer: annotateWeb(answer, web), citations, backend, mode, ...meta }
    }

    // 未配置模型：只给检索片段（明确标注不是模型回答），不再用「没有检索到」一刀切
    const parts: string[] = []
    if (citations.length > 0) {
      const first = chunkText(citations[0].chunkId).replace(/\s+/g, ' ').slice(0, 200)
      parts.push(
        `根据检索到的 ${citations.length} 段内容：\n\n${first}…\n\n` +
          `（引用：${citations.map((c) => `[${c.index}]`).join(' ')}）`
      )
    }
    if (kb.hits.length > 0) parts.push(kbSummary(kb.hits))
    if (web.status === 'on') parts.push(webAnswerFromSources(q, web.sources))
    if (parts.length === 0) parts.push('没有检索到相关内容。')
    parts.push('提示：未配置模型服务，以上只是检索片段，不能替代模型回答；可在「设置」里配置模型。')
    const finalAnswer = annotateWeb(parts.join('\n\n'), web)
    onDelta?.(finalAnswer)
    return { answer: finalAnswer, citations, backend, mode, ...meta }
  } catch (e) {
    if (isAbortError(e)) {
      const partial = '（已取消）'
      onDelta?.(partial)
      return {
        answer: partial,
        citations: [],
        backend,
        mode: 'cancelled',
        webMode: requestedWeb,
        strict
      }
    }
    // 模型/翻译失败：不吞掉已拿到的来源，也不把失败说成「没有检索到」
    const meta = lastMeta as AskMetaInfo | null
    return {
      answer: '',
      error: friendlyModelError(e),
      citations: [],
      backend,
      mode: 'failed',
      web: meta?.web ?? 'off',
      webError: meta?.webError ?? null,
      webSources: meta?.webSources ?? [],
      knowledgeHits: meta?.knowledgeHits ?? [],
      scopeLabel: meta?.scopeLabel ?? '',
      webMode: requestedWeb,
      strict
    }
  } finally {
    if (requestId) askControllers.delete(requestId)
  }
}

/** 用模型给对话起个短标题（未配置模型时返回空串，由调用方回退到首问截断） */
export async function aiTitle(text: string): Promise<string> {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  try {
    const raw = await chat(
      '你是标题助手。用不超过 14 个汉字概括用户问题的主题，只输出标题本身：' +
        '不要标点、不要引号、不要解释、不要换行。',
      t.slice(0, 500)
    )
    return raw
      .replace(/^["'「『（(\s]+|["'」』）)\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 30)
  } catch {
    return ''
  }
}

const QUERY_SYSTEM =
  '你是学术检索助手。把用户的自然语言需求转换成一条简洁的文献检索式：' +
  '保留核心方法/任务/领域等可检索名词，去掉「帮我找」「有哪些」「的论文」这类口语；' +
  '中文学术概念可同时给出常见英文术语，用空格分隔。' +
  '只输出检索式本身：不要引号、不要编号、不要解释、不要换行。'

/**
 * 「用 AI 找论文」的第一步：自然语言 → 文献检索式。
 * 未配置模型 / 调用失败时返回空串（调用方回退到启发式提取），不抛错。
 */
export async function aiSearchQuery(question: string): Promise<{ query: string; byAi: boolean }> {
  const q = (question ?? '').replace(/\s+/g, ' ').trim()
  if (!q) return { query: '', byAi: false }
  try {
    const raw = await chat(QUERY_SYSTEM, q.slice(0, 500))
    const line =
      (raw ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean) ?? ''
    const cleaned = line
      .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '')
      .replace(/^(关键词|检索词|检索式|query|keywords?)\s*[:：]\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
    return cleaned ? { query: cleaned, byAi: true } : { query: '', byAi: false }
  } catch {
    return { query: '', byAi: false }
  }
}

const LATEX_SYSTEM =  '你是 LaTeX 转换助手。把用户给出的数学内容（公式、符号表达式、含上下标的变量）转换为标准 LaTeX：\n' +
  '- 只输出 LaTeX 代码本身：不要 $ 或 $$ 包裹，不要 Markdown 代码围栏，不要任何解释文字；\n' +
  '- 尽量保留原有数学含义（上下标、分数、根号、求和/积分、希腊字母、向量、矩阵等）；\n' +
  '- 若输入不含任何数学符号（纯自然语言句子），就原样返回文本。\n'

/** 选中文字 → LaTeX（用对话模型；纯文本转换，无需视觉） */
export async function latexFromText(text: string): Promise<{ latex: string }> {
  const t = (text ?? '').trim()
  if (!t) throw new Error('没有可转换的内容')
  const raw = await chat(LATEX_SYSTEM, t)
  const latex = raw
    .replace(/^\s*```(?:latex|tex)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  return { latex }
}

export interface FormulaResult {
  latex: string
  kind: string
  note?: string | null
}

/**
 * 图片 → 公式 / LaTeX（用视觉模型；脚本不落盘）。
 * 未配置模型时抛错，由调用方提示。
 */
export async function formulaFromImage(imageB64: string, mime = 'image/png'): Promise<FormulaResult> {
  const cfg = llmConfig()
  if (!cfg.baseUrl || !cfg.apiKey) {
    throw new Error('未配置模型服务：请在设置里填写 Base URL 与 API Key（需支持视觉的模型）')
  }
  const hint = openCodeEndpointHint(cfg.baseUrl, cfg.model)
  if (hint) throw new Error(hint)
  const base = await ensureSidecar()
  const res = await fetch(`${base}/vision/formula`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      imageB64,
      mime,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      headers: modelHeaders(cfg.baseUrl, sessionFor.chat())
    })
  })
  if (!res.ok) throw new Error(`公式识别失败: ${res.status} ${extractApiError(await res.text())}`)
  return (await res.json()) as FormulaResult
}

const TABLE_SYSTEM =
  '你是表格识别助手。把图片里的表格转成 GitHub 风格 Markdown 表格：\n' +
  '- 第一行是表头，第二行是分隔行（例如 | --- | --- |），之后每行一条数据；\n' +
  '- 只输出表格本身：不要 $ 或代码围栏，不要任何解释文字；\n' +
  '- 单元格里的竖线写成 \\|，单元格内换行写成 <br>，空单元格留空；\n' +
  '- 若图片里没有任何表格，只输出 NO_TABLE（不要编造表格）。'

export interface TableResult {
  /** GitHub 风格 Markdown 表格；未识别到表格时为空串 */
  markdown: string
  /** 是否识别到表格 */
  found: boolean
  note?: string | null
}

/**
 * 表格图片 → GitHub 风格 Markdown 表格（直接走 /chat/completions 的多模态请求）。
 * 未配置模型时抛错，由调用方提示；无表格时返回 `found: false` 而不是乱输出。
 */
export async function tableFromImage(
  imageB64: string,
  mime = 'image/png'
): Promise<TableResult> {
  if (!imageB64) throw new Error('没有可识别的图片')
  const cfg = llmConfig()
  if (!cfg.baseUrl || !cfg.apiKey) {
    throw new Error('未配置模型服务：请在设置里填写 Base URL 与 API Key（需支持视觉的模型）')
  }
  const hint = openCodeEndpointHint(cfg.baseUrl, cfg.model)
  if (hint) throw new Error(hint)
  const res = await requestModel(cfg.baseUrl, cfg.apiKey, {
      model: cfg.model || 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: TABLE_SYSTEM },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${imageB64}` } }
          ]
        }
      ]
    }, sessionFor.chat(), undefined)
  if (!res.ok) throw new Error(`表格识别失败: ${res.status} ${extractApiError(await res.text())}`)
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const raw = chatResponseText(data).trim() ?? ''
  const markdown = normalizeMarkdownTable(raw)
  if (!markdown || /NO_TABLE/i.test(raw)) {
    return { markdown: '', found: false, note: '该图片不包含表格' }
  }
  return { markdown, found: true }
}
