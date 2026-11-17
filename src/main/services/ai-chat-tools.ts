// AI 问答工具注册表（纯逻辑，不依赖 db / translate / llm）。
//
// 与 mindmap-ai-tools.ts（PD55）同一条约定：本文件刻意不 import 数据库或翻译
// 服务， capability 由调用方在 runAiChatTool 里注入（AiChatToolIo），
// 以便单测可以纯内存地验证注册表、参数校验与越权拒绝。
//
// 协议：模型在回答里输出 `TOOL_CALL {"name":"...","args":{...}}` 独立行，
// 服务端 parseToolCalls 解析并执行，然后把结果回灌给模型再答（工具循环）。
//
// 写入类工具默认关闭：AI_CHAT_WRITE_TOOLS_ENABLED 必须显式置 true，
// 且运行侧 allowWrite 也必须显式置 true 才会执行（双重开关）。

export type AiChatToolId = 'read-paper' | 'read-page' | 'translate-text' | 'note-append'

export interface AiChatToolIo {
  /** 当前论文总页数（1 基口径；没有正文文本时可为 0） */
  pageCount: () => Promise<number>
  /** 读指定页文本（page 为 1 基页码，与 reader/检索导出口径一致） */
  pageText: (page: number) => Promise<string>
  /** 翻译一段文本，返回翻译后端与译文 */
  translate: (text: string, lang: string) => Promise<{ backend: string; text: string }>
  /** 写入类工具：把内容追加到当前论文的阅读笔记（标题即小节名） */
  appendNote: (section: string, content: string) => Promise<{ noteTitle: string }>
}

export interface AiChatToolCall {
  name: string
  args: Record<string, unknown>
}

export type AiChatToolValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string }

export interface AiChatToolDef {
  id: AiChatToolId
  /** 展示名（中文，用于错误与提示） */
  title: string
  /** 只读工具（读论文/读页/翻译）；false 即写入类 */
  readonly: boolean
  /** system 协议里的参数说明（一句话） */
  paramsHint: string
  validate: (raw: unknown) => AiChatToolValidation
  run: (io: AiChatToolIo, args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 单次问答里最多执行的工具调用数 */
export const AI_CHAT_MAX_TOOL_CALLS = 4
/** 工具循环的模型追问次数上限（初始回答 + 2 次带结果的补答） */
export const AI_CHAT_MAX_TOOL_ROUNDS = 2
/** read-paper 一次最多连续读几页 */
export const PAPER_READ_MAX_PAGES = 8
/** read-paper 单次返回的正文上限（字符） */
export const PAPER_READ_MAX_CHARS = 5200
/** read-page 单页正文上限（字符） */
export const PAGE_TEXT_MAX_CHARS = 2600
/** 翻译文本长度上限（字符） */
export const TRANSLATE_TEXT_MAX_CHARS = 2000
/** 笔记小节标题长度上限 */
export const NOTE_SECTION_MAX_CHARS = 60
/** 笔记正文长度上限 */
export const NOTE_BODY_MAX_CHARS = 4000
/** 会话里的写入类工具总开关（持久化设置键，写入类工具默认关闭） */
export const AI_CHAT_WRITE_TOOLS_KEY = 'ai.writeToolsEnabled'

// ---------------------------------------------------------------------------
// 参数校验助手
// ---------------------------------------------------------------------------

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v)
  if (typeof v === 'string' && v.trim() !== '' && /^-?\d+$/.test(v.trim())) {
    return Number.parseInt(v.trim(), 10)
  }
  return null
}

function ok(args: Record<string, unknown>): AiChatToolValidation {
  return { ok: true, args }
}

function bad(error: string): AiChatToolValidation {
  return { ok: false, error }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

// ---------------------------------------------------------------------------
// 各工具定义
// ---------------------------------------------------------------------------

/** read-paper：分页读当前论文全文（1 基页码，一次最多 PAPER_READ_MAX_PAGES 页） */
const readPaperDef: AiChatToolDef = {
  id: 'read-paper',
  title: '读当前论文全文',
  readonly: true,
  paramsHint: '{"page":1,"pages":3}（1 基起始页码，一次最多 8 页；默认从第 1 页读 3 页）',
  validate(raw) {
    const o = (raw ?? {}) as Record<string, unknown>
    const page = o.page === undefined ? 1 : asInt(o.page)
    if (page === null || page < 1) return bad('read-paper 参数错误：page 必须是 ≥1 的整数页码')
    const pages = o.pages === undefined ? 3 : asInt(o.pages)
    if (pages === null || pages < 1 || pages > PAPER_READ_MAX_PAGES) {
      return bad(`read-paper 参数错误：pages 必须是 1-${PAPER_READ_MAX_PAGES} 的整数`)
    }
    return ok({ page, pages })
  },
  async run(io, args) {
    const pageCount = await io.pageCount()
    if (pageCount <= 0) {
      return { pageCount: 0, empty: true, message: '这篇论文还没有可读的正文文本（可能还没完成解析）' }
    }
    const from = Math.min(Math.max(1, Number(args.page)), pageCount)
    const wanted = Number(args.pages)
    const to = Math.min(pageCount, from + wanted - 1)
    const parts: string[] = []
    let total = 0
    let truncated = false
    for (let p = from; p <= to; p++) {
      const text = (await io.pageText(p)).trim()
      if (!text) continue
      const head = `\n\n【第 ${p} 页】\n${text}`
      const room = PAPER_READ_MAX_CHARS - total
      if (room <= 0) {
        truncated = true
        break
      }
      const piece = head.length > room ? head.slice(0, room) : head
      if (piece.length < head.length) truncated = true
      parts.push(piece)
      total += piece.length
    }
    return {
      pageCount,
      from,
      to,
      hasMore: to < pageCount || truncated,
      text: parts.join('').trim() || `（第 ${from}-${to} 页没有正文文本）`
    }
  }
}

/** read-page：读指定页文本 */
const readPageDef: AiChatToolDef = {
  id: 'read-page',
  title: '读指定页文本',
  readonly: true,
  paramsHint: '{"page":3}（1 基页码）',
  validate(raw) {
    const o = (raw ?? {}) as Record<string, unknown>
    const page = asInt(o.page)
    if (page === null || page < 1) return bad('read-page 参数错误：page 必须是 ≥1 的整数页码')
    return ok({ page })
  },
  async run(io, args) {
    const pageCount = await io.pageCount()
    const page = Number(args.page)
    if (pageCount > 0 && page > pageCount) {
      return { pageCount, page, empty: true, message: `页码超出范围：这篇论文共 ${pageCount} 页` }
    }
    const text = (await io.pageText(page)).trim()
    if (!text) {
      return { pageCount, page, empty: true, message: `第 ${page} 页没有文本内容` }
    }
    const truncated = text.length > PAGE_TEXT_MAX_CHARS
    return {
      pageCount,
      page,
      truncated,
      text: truncated ? text.slice(0, PAGE_TEXT_MAX_CHARS) : text
    }
  }
}

/** translate-text：翻译指定文本（走与「划词翻译」同一的后端配置） */
const translateTextDef: AiChatToolDef = {
  id: 'translate-text',
  title: '翻译指定文本',
  readonly: true,
  paramsHint: '{"text":"...","lang":"zh"}（lang 目标语言，默认中文）',
  validate(raw) {
    const o = (raw ?? {}) as Record<string, unknown>
    const text = asString(o.text)?.trim() ?? ''
    if (!text) return bad('translate-text 参数错误：text 不能为空')
    if (text.length > TRANSLATE_TEXT_MAX_CHARS) {
      return bad(`translate-text 参数错误：text 超过 ${TRANSLATE_TEXT_MAX_CHARS} 字符`)
    }
    const lang = asString(o.lang)?.trim() || 'zh'
    if (lang.length > 20) return bad('translate-text 参数错误：lang 过长')
    return ok({ text, lang })
  },
  async run(io, args) {
    const out = await io.translate(String(args.text), String(args.lang))
    if (!out.text) return { empty: true, message: '翻译服务没有返回内容' }
    return { backend: out.backend, text: out.text }
  }
}

/** note-append（写入类，默认关闭）：把回答要点追加进当前论文的阅读笔记 */
const noteAppendDef: AiChatToolDef = {
  id: 'note-append',
  title: '追加阅读笔记',
  readonly: false,
  paramsHint: '{"section":"小节标题","content":"要点"}（写入当前论文的阅读笔记）',
  validate(raw) {
    const o = (raw ?? {}) as Record<string, unknown>
    const section = asString(o.section)?.trim() ?? ''
    const content = asString(o.content)?.trim() ?? ''
    if (!section) return bad('note-append 参数错误：section 不能为空')
    if (section.length > NOTE_SECTION_MAX_CHARS) {
      return bad(`note-append 参数错误：section 超过 ${NOTE_SECTION_MAX_CHARS} 字符`)
    }
    if (!content) return bad('note-append 参数错误：content 不能为空')
    if (content.length > NOTE_BODY_MAX_CHARS) {
      return bad(`note-append 参数错误：content 超过 ${NOTE_BODY_MAX_CHARS} 字符`)
    }
    return ok({ section, content })
  },
  async run(io, args) {
    const out = await io.appendNote(String(args.section), String(args.content))
    return { ok: true, noteTitle: out.noteTitle }
  }
}

/**
 * 唯一注册表：键即工具 id。
 * 前 3 个是只读工具（默认开放），note-append 是写入类（默认关闭，双重开关）。
 */
export const AI_CHAT_TOOLS: Record<AiChatToolId, AiChatToolDef> = {
  'read-paper': readPaperDef,
  'read-page': readPageDef,
  'translate-text': translateTextDef,
  'note-append': noteAppendDef
}

export const AI_CHAT_TOOL_IDS = Object.keys(AI_CHAT_TOOLS) as AiChatToolId[]

export function getAiChatTool(id: unknown): AiChatToolDef | null {
  if (typeof id !== 'string') return null
  return Object.prototype.hasOwnProperty.call(AI_CHAT_TOOLS, id) ? AI_CHAT_TOOLS[id as AiChatToolId] : null
}

/** 只读工具 id 集合（用于默认开放判断） */
export function isReadonlyAiChatTool(id: string): boolean {
  const def = getAiChatTool(id)
  return def ? def.readonly : false
}

// ---------------------------------------------------------------------------
// system 协议说明（拼在 QA_SYSTEM 后面）
// ---------------------------------------------------------------------------

export const CHAT_TOOL_PROTOCOL =
  '\n\nYou may call tools to read the current paper or translate text BEFORE answering.\n' +
  'To call one, output a SEPARATE line in EXACTLY this form (single line, valid JSON, no extra text):\n' +
  'TOOL_CALL {"name":"<tool>","args":{...}}\n' +
  'Available tools:\n' +
  AI_CHAT_TOOL_IDS.map((id) => {
    const def = AI_CHAT_TOOLS[id]
    return def.readonly ? `- ${id}: ${def.paramsHint}` : ''
  })
    .filter(Boolean)
    .join('\n') +
  '\nRules: use tools only when the numbered context is insufficient to answer; ' +
  `at most ${AI_CHAT_MAX_TOOL_CALLS} tool calls per question; ` +
  'when you cite text you read with tools, mark the page as [p.N]; ' +
  'after tool results are provided, give the FINAL answer and never output new TOOL_CALL lines in it; ' +
  'if no tool is needed, answer directly without any TOOL_CALL line.'

/** 把工具执行结果拼回给模型的补答 prompt 块 */
export function buildToolResultsBlock(
  round: number,
  results: Array<{ name: string; ok: boolean; body: string }>
): string {
  const lines = results.map((r) => {
    const head = `【工具 ${r.name}${r.ok ? '' : '（失败）'}】`
    return `${head}\n${r.body}`
  })
  return (
    `Tool results (round ${round}):\n${lines.join('\n\n')}\n\n` +
    'Based on the tool results above, now give the FINAL answer to the original question. ' +
    'Cite tool-read pages as [p.N]. Do NOT output any TOOL_CALL line in the final answer.'
  )
}

// ---------------------------------------------------------------------------
// 解析与执行
// ---------------------------------------------------------------------------

const TOOL_CALL_LINE = /^\s*(?:-\s*)?TOOL_CALL\s*(\{.*\})\s*:?\s*$/

/** 从模型输出里解析 TOOL_CALL 行（最多 AI_CHAT_MAX_TOOL_CALLS 条，顺序保留） */
export function parseToolCalls(raw: string): AiChatToolCall[] {
  const calls: AiChatToolCall[] = []
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const m = TOOL_CALL_LINE.exec(line)
    if (!m) continue
    try {
      const j = JSON.parse(m[1]) as { name?: unknown; args?: unknown }
      if (typeof j.name !== 'string') continue
      calls.push({
        name: j.name,
        args: (j.args ?? {}) instanceof Object ? (j.args as Record<string, unknown>) : {}
      })
      if (calls.length >= AI_CHAT_MAX_TOOL_CALLS) break
    } catch {
      // 不是合法 JSON 的 TOOL_CALL 行：忽略，不中断解析
    }
  }
  return calls
}

/** 判断一行是否是 TOOL_CALL 协议行（流式输出抑制用） */
export function isToolCallLine(line: string): boolean {
  return TOOL_CALL_LINE.test(String(line ?? ''))
}

/** 去掉模型输出里的 TOOL_CALL 行（给用户的最终文本不出现协议指令） */
export function stripToolCallLines(raw: string): string {
  return String(raw ?? '')
    .split(/\r?\n/)
    .filter((line) => !TOOL_CALL_LINE.test(line))
    .join('\n')
}

/**
 * 执行一条工具调用。
 * 顺序：未知工具拒绝 → 写入类越权拒绝（默认关闭）→ 参数校验 → 执行。
 * 写入类需要双重开关：AI_CHAT_WRITE_TOOLS_ENABLED 且 allowWrite。
 */
export async function runAiChatTool(
  id: string,
  rawArgs: unknown,
  io: AiChatToolIo | null,
  opts: { allowWrite?: boolean; writeToolsEnabled?: boolean } = {}
): Promise<Record<string, unknown>> {
  const def = getAiChatTool(id)
  if (!def) throw new Error(`未知的问答工具：${id}`)
  if (!def.readonly) {
    const enabled = opts.writeToolsEnabled === true
    if (!enabled) throw new Error(`写入类工具已默认关闭：${def.title}（可在设置里开启）`)
    if (opts.allowWrite !== true) throw new Error(`当前对话未授权写入：${def.title}`)
  }
  if (!io) throw new Error('问答工具当前不可用（没有关联的论文）')
  const v = def.validate(rawArgs)
  if (!v.ok) throw new Error(v.error)
  return def.run(io, v.args)
}

/** 工具执行的单条记录（ai.ts 拼结果块与日志用） */
export interface AiChatToolRunRecord {
  name: string
  args: Record<string, unknown>
  ok: boolean
  body: string
}

const RESULT_TEXT_LIMIT = 3000

/** 执行一批工具调用（失败记录错误文本，不抛出，保证循环继续） */
export async function executeToolCalls(
  calls: AiChatToolCall[],
  io: AiChatToolIo | null,
  opts: { allowWrite?: boolean; writeToolsEnabled?: boolean } = {}
): Promise<AiChatToolRunRecord[]> {
  const records: AiChatToolRunRecord[] = []
  for (const c of calls) {
    try {
      const out = await runAiChatTool(c.name, c.args, io, opts)
      records.push({ name: c.name, args: c.args, ok: true, body: JSON.stringify(out) })
    } catch (e) {
      records.push({
        name: c.name,
        args: c.args,
        ok: false,
        body: `错误：${e instanceof Error ? e.message : String(e)}`
      })
    }
  }
  // 给模型的每条结果限长，避免一次读全文把 prompt 撑爆
  return records.map((r) => ({
    ...r,
    body: r.body.length > RESULT_TEXT_LIMIT ? `${r.body.slice(0, RESULT_TEXT_LIMIT)}…` : r.body
  }))
}
