/**
 * 思维地图节点级 AI 的纯逻辑模块（提示词 + 结果解析 + 可读错误）。
 *
 * 设计约束：
 * - 不 import electron / db / React，只依赖类型，供 `scripts/test-unit.ts` 用 strip-types 直接跑；
 * - 模型调用由外部注入 `MindmapAiComplete`（主进程里是 llm.ts 的严格调用），
 *   这样「未配置 / 请求失败 / 返回坏格式」都能在单测里覆盖，且绝不产生假结果；
 * - 支撑段落必须能在给定原文片段里逐字核对（忽略空白与引号差异），
 *   页码只用命中片段的真实页码，**绝不采用模型给出的页码**，核对不上就返回「未找到」。
 */
import type { MindMapDoc, MindMapNode, MindmapAnchor } from './types'
// @ts-expect-error TS5097：测试用 `node scripts/test-unit.ts` 直接加载本文件，Node ESM 需要显式扩展名
import { locateAnchor, locateQuoteSpan } from './mindmap-anchor.ts'

export type MindmapAiErrorCode = 'not-configured' | 'request-failed' | 'bad-response'

/** 思维地图 AI 的可读错误：code 供渲染层区分「去设置」还是「重试」 */
export class MindmapAiError extends Error {
  readonly code: MindmapAiErrorCode

  constructor(code: MindmapAiErrorCode, message: string) {
    super(message)
    this.name = 'MindmapAiError'
    this.code = code
  }
}

/** 未配置 provider 的统一文案（主进程与渲染层共用，避免两处漂移） */
export const MINDMAP_AI_NOT_CONFIGURED =
  '未配置 AI：请在「设置 → 模型服务」里填写 Base URL 与 API Key'

/** 注入的补全函数：system + user → 模型原始输出 */
export type MindmapAiComplete = (system: string, user: string) => Promise<string>

/** 参与提示词的原文片段（页码为 PDF 真实页码，已 +1） */
export interface MindmapPassage {
  page: number
  /** 折叠空白并截断后的提示词片段 */
  text: string
  /** chunk 正文原文（锚点偏移只在原文上计算；老调用方不传时退化为 text） */
  chunkText?: string
  /** chunks.id（便于回查；不参与提示词） */
  chunkId?: number
  /** chunks.bbox 原始 TEXT（可能为 null） */
  bbox?: string | null
  /** chunks.module_id */
  moduleId?: string | null
}

/** 构造提示词所需的上下文：论文标题 + 选中节点 + 祖先路径 + 已有子节点 + 原文片段 */
export interface MindmapPromptContext {
  paperTitle: string
  nodeText: string
  ancestors: string[]
  children: string[]
  passages: MindmapPassage[]
}

export interface MindmapSummaryResult {
  summary: string
}

export interface MindmapExpansionResult {
  /** 2–4 条子节点文本（已去重、截断） */
  texts: string[]
}

export interface MindmapSupportResult {
  found: boolean
  /** 命中片段的真实页码；未命中为 null */
  page: number | null
  /** 命中时是从原文片段里截出的逐字引用；未命中为空串 */
  quote: string
  /** 面向用户的说明（未命中原因 / 命中说明） */
  reason: string
  /** PD55：点锚点（chunk 正文里的字符区间 + bbox/module 透传）；未命中为 null */
  anchor: MindmapAnchor | null
}

/** AI 优化结果：分组（兼容旧契约）+ 精简措辞 / 新增子节点 / 合并重复 / 改动理由（PD57） */
export interface MindmapOptimizeTopic {
  text: string
  points: string[]
}

export interface MindmapOptimizeResult {
  topics: MindmapOptimizeTopic[]
  /** 对选中节点本身的精简措辞（可空） */
  summary?: string
  /** 建议新增的 1–3 个有依据的子节点 */
  children?: string[]
  /** 建议合并的重复子节点 id（模型给不出 id 时由渲染层按文本相似度补） */
  mergedIds?: string[]
  /** 每个改动的理由（面向用户展示，避免黑盒） */
  rationale?: string
}

/** 整图优化的一个分组：标题 + 要点（PD58） */
export interface MindmapMapOptimizeGroup {
  title: string
  points: string[]
}

/** 整图优化结果：把整张地图重新整理成若干分组，附带一句理由 */
export interface MindmapMapOptimizeResult {
  groups: MindmapMapOptimizeGroup[]
  rationale?: string
}

/** 整图优化上下文：论文标题 + 现有地图大纲（按层级缩进）+ 原文片段 */
export interface MindmapMapPromptContext {
  paperTitle: string
  outline: string
  passages: MindmapPassage[]
}

export interface MindmapPrompt {
  system: string
  user: string
}

export const MINDMAP_EXPAND_MIN = 2
export const MINDMAP_EXPAND_MAX = 4
/** AI 优化：整理成 2–6 个分组，每组 1–4 条要点 */
export const MINDMAP_OPTIMIZE_MIN_TOPICS = 2
export const MINDMAP_OPTIMIZE_MAX_TOPICS = 6
export const MINDMAP_OPTIMIZE_MAX_POINTS = 4
/** 整图优化：整理成 2–6 个分组，每组 1–5 条要点 */
export const MINDMAP_MAP_OPTIMIZE_MIN_GROUPS = 2
export const MINDMAP_MAP_OPTIMIZE_MAX_GROUPS = 6
export const MINDMAP_MAP_OPTIMIZE_MAX_POINTS = 5
export const MINDMAP_MAP_OPTIMIZE_MAX_TITLE = 40
export const MINDMAP_MAP_OPTIMIZE_MAX_POINT = 60
export const MINDMAP_MAP_OUTLINE_MAX_LINES = 80
export const MINDMAP_MAX_SUMMARY_CHARS = 320
export const MINDMAP_MAX_NODE_CHARS = 120
export const MINDMAP_MAX_TITLE_CHARS = 300
export const MINDMAP_SUPPORT_MIN_QUOTE = 6
export const MINDMAP_CONTEXT_MAX_CHARS = 6000
export const MINDMAP_PASSAGE_MAX_CHARS = 900
export const MINDMAP_MAX_PASSAGES = 6

const SYSTEM_PROMPT = [
  '你是论文阅读助手，帮用户整理一篇论文的思维地图。',
  '只能使用用户给出的材料（论文标题、思维地图节点、原文片段），不要引入外部知识，不要编造引用、页码或数据。',
  '回答一律用简体中文，简洁、具体；只输出要求的格式，不要解释你的思考过程。'
].join('\n')

/* ------------------------------------------------------------------ */
/* 文本工具                                                            */
/* ------------------------------------------------------------------ */

/** 折叠所有空白为单个空格并去掉首尾空白 */
export function collapseText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

/** 折叠行内多余空白，但保留换行（大纲/多行文本用） */
export function collapseMultiline(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && index < all.length - 1))
    .join('\n')
    .trim()
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * PD57：思维地图节点显示的纯文本化。
 *
 * 节点文字是用户识别节点的唯一依据，所以这里只去掉 Markdown 记号、保留全部文字：
 * **粗体** / *斜体* / `代码` / # 标题 / - 与 1. 列表 / > 引用 / [文字](链接) /
 * ![图片](地址) / ~~删除线~~ / 表格竖线 / 水平线。列表符统一换成「· 」，
 * 链接只留标题，其余标记直接去掉；行结构（换行）保留，供 white-space: pre-wrap 渲染。
 */
export function stripMarkdownForMap(value: unknown): string {
  if (typeof value !== 'string') return ''
  let text = value.replace(/\r\n?/gu, '\n').replace(/\u00a0/gu, ' ')
  // 围栏代码块只保留内容，避免三反引号出现在节点里
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/gu, (_all, code: string) => code)
  const lines = text.split('\n').map((line) => {
    let out = line
    // 图片/链接：只保留可读文字
    out = out.replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    out = out.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    out = out.replace(/\[([^\]]*)\]\[[^\]]*\]/gu, '$1')
    // 标题 / 引用
    out = out.replace(/^\s{0,3}#{1,6}\s*/u, '')
    out = out.replace(/^\s{0,3}>\s?/u, '')
    // 水平线整行去掉
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(out)) return ''
    // 任务列表 / 无序列表 / 有序列表
    out = out.replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/u, '$1· ')
    out = out.replace(/^(\s*)[-*+]\s+/u, '$1· ')
    out = out.replace(/^(\s*)\d+[.)]\s+/u, '$1· ')
    // 表格分隔行整行去掉；数据行的竖线换成空格
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/u.test(out)) return ''
    if (out.includes('|')) out = out.replace(/\s*\|\s*/gu, ' ')
    // 行内代码、粗体、斜体、删除线
    out = out.replace(/`+([^`]*)`+/gu, '$1')
    out = out.replace(/\*\*([^*]+)\*\*/gu, '$1')
    out = out.replace(/__([^_]+)__/gu, '$1')
    out = out.replace(/(^|[^\w])\*([^*\n]+)\*(?!\*)/gu, '$1$2')
    out = out.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/gu, '$1$2')
    out = out.replace(/~~([^~]+)~~/gu, '$1')
    // 落单的成对记号直接清掉，避免残留 ** 或 ~~
    out = out.replace(/(\*\*|__|~~)/gu, '')
    return out.replace(/[ \t]+/gu, ' ').trimEnd()
  })
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/* ------------------------------------------------------------------ */
/* 节点尺寸（PD57）：节点全文显示后的统一测量，供渲染、布局与实体单元测试共用 */
/* ------------------------------------------------------------------ */

export const MINDMAP_NODE_MIN_W = 160
export const MINDMAP_NODE_MAX_W = 420
export const MINDMAP_NODE_PAD_X = 24
export const MINDMAP_NODE_PAD_Y = 18
export const MINDMAP_NODE_TEXT_RESERVED_X = 52
export const MINDMAP_NODE_LINE_H = 17
export const MINDMAP_NODE_MIN_H = 46

/**
 * 按文本估算节点盒子：CJK 按 1 字宽、西文按 0.55 字宽，宽度夹在 160–420px；
 * 超过 max-width 自动换行（不再是省略号），高度按真实行数累加。
 * 文本先经 stripMarkdownForMap，保证测量与渲染用同一份文字。
 */
export function measureMindmapNode(text: unknown): { width: number; height: number } {
  const plain = stripMarkdownForMap(text)
  const lines = plain.length > 0 ? plain.split('\n') : ['']
  let maxUnits = 0
  const lineUnits: number[] = []
  for (const line of lines) {
    let units = 0
    for (const glyph of Array.from(line)) {
      units += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(glyph) ? 1 : 0.55
    }
    lineUnits.push(units)
    maxUnits = Math.max(maxUnits, units)
  }
  const contentWidth = Math.max(1, maxUnits * 12.5)
  const width = Math.round(
    Math.min(
      MINDMAP_NODE_MAX_W,
      Math.max(MINDMAP_NODE_MIN_W, contentWidth + MINDMAP_NODE_PAD_X)
    )
  )
  const usable = Math.max(1, width - MINDMAP_NODE_TEXT_RESERVED_X)
  let visualLines = 0
  for (const units of lineUnits) {
    visualLines += Math.max(1, Math.ceil((units * 12.5) / usable))
  }
  const height = Math.max(
    MINDMAP_NODE_MIN_H,
    Math.round(visualLines * MINDMAP_NODE_LINE_H + MINDMAP_NODE_PAD_Y)
  )
  return { width, height }
}

/** 去掉代码围栏（```json ... ```） */
function stripFences(raw: string): string {
  const text = raw.trim()
  const fenced = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/.exec(text)
  return (fenced ? fenced[1] : text).trim()
}

/** 找到第一个平衡的 JSON 对象并解析；解析失败返回 null */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1))
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** 找到第一个 JSON 数组并解析；解析失败返回 null */
export function extractJsonArray(raw: string): unknown[] | null {
  const text = raw
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 清洗一条节点文本：去项目符号/编号/引号，折叠空白，限制长度 */
export function cleanNodeText(value: unknown): string {
  let text = collapseText(value)
  if (!text) return ''
  text = text.replace(/^[-*•·—+]\s*/u, '')
  text = text.replace(/^\d+\s*[.、·)）:：]\s*/u, '')
  text = text.replace(/^[[【(（]\d+[\]】)）]\s*/u, '')
  text = text.replace(/^["'“”‘’「」『』]+/u, '').replace(/["'“”‘’「」『』]+$/u, '')
  text = text.trim()
  text = text.replace(/[。；;，,]$/u, '')
  // PD57：节点全文显示，不再追加省略号；仅用硬上限防止异常超长输出撑爆地图
  return text.length > MINDMAP_MAX_NODE_CHARS ? text.slice(0, MINDMAP_MAX_NODE_CHARS) : text
}

/* ------------------------------------------------------------------ */
/* 提示词                                                              */
/* ------------------------------------------------------------------ */

/** 把上下文渲染成提示词里的「材料」块；片段过多时从尾部裁剪 */
export function buildMindmapContextBlock(ctx: MindmapPromptContext): string {
  const line = (label: string, value: string): string => `${label}${value}`
  const passages = ctx.passages.slice(0, MINDMAP_MAX_PASSAGES)
  while (passages.length > 0) {
    const lines: string[] = []
    lines.push(line('论文标题：', clip(collapseText(ctx.paperTitle), MINDMAP_MAX_TITLE_CHARS) || '（未命名文献）'))
    lines.push(line('选中节点：', clip(collapseText(ctx.nodeText), MINDMAP_MAX_NODE_CHARS) || '（空）'))
    if (ctx.ancestors.length > 0) {
      lines.push(line('上级路径：', ctx.ancestors.map((t) => clip(collapseText(t), 60)).join(' > ')))
    }
    if (ctx.children.length > 0) {
      lines.push(
        line(
          '已有子节点：',
          ctx.children
            .slice(0, 12)
            .map((t) => clip(collapseText(t), 60))
            .join('；')
        )
      )
    }
    if (passages.length === 0) {
      lines.push('原文片段：（无可用原文片段）')
    } else {
      lines.push('原文片段：')
      passages.forEach((passage, index) => {
        lines.push(
          `[片段${index + 1}｜第${passage.page}页] ${clip(collapseText(passage.text), MINDMAP_PASSAGE_MAX_CHARS)}`
        )
      })
    }
    const block = lines.join('\n')
    if (block.length <= MINDMAP_CONTEXT_MAX_CHARS || passages.length === 1) return block
    passages.pop()
  }
  return '原文片段：（无可用原文片段）'
}

export function buildSummaryPrompt(ctx: MindmapPromptContext): MindmapPrompt {
  const user = [
    '请为「选中节点」写一段摘要：说明它在本文里指什么、关键结论/作用是什么。',
    `要求：1–3 句，不超过 180 字；只依据下面的材料，材料不足时就说「依据不足」。`,
    '',
    '材料：',
    buildMindmapContextBlock(ctx)
  ].join('\n')
  return { system: SYSTEM_PROMPT, user }
}

export function buildExpandPrompt(ctx: MindmapPromptContext): MindmapPrompt {
  const user = [
    `请把「选中节点」拆成 ${MINDMAP_EXPAND_MIN}–${MINDMAP_EXPAND_MAX} 个更具体的子节点。`,
    '要求：',
    '1. 每个子节点是一句短语（不超过 30 字），彼此不重复、不包含父节点原文；',
    '2. 必须能在上面的材料（标题 / 节点 / 原文片段）里找到依据，不要引入外部知识；',
    `3. 只输出 JSON 字符串数组，例如 ["要点A","要点B","要点C"]，不要输出其他文字；材料不足时输出 []。`,
    '',
    '材料：',
    buildMindmapContextBlock(ctx)
  ].join('\n')
  return { system: SYSTEM_PROMPT, user }
}

/**
 * AI 优化（PD57）：一次给出三类可逐项接受的调整——精简选中节点措辞、
 * 补 1–3 个有依据的子节点、合并重复子节点；每类都要给理由。
 * topics 字段保留，兼容旧版「整理成 2–6 个分组」的结果。
 */
export function buildOptimizePrompt(ctx: MindmapPromptContext): MindmapPrompt {
  const user = [
    '请优化「选中节点」在思维地图里的表达，只能做下面三类调整：',
    'A. 精简节点措辞：在保留原意的前提下删掉空话、重复词，最长不超过 40 字；',
    'B. 补子节点：只补 1–3 个能从材料里直接找到依据的具体子节点；',
    'C. 合并重复子节点：把现有子节点里意思重复的合并成一条（在 mergedIds 里填重复项的 id 或原文）。',
    '要求：',
    '1. 只能使用用户给出的材料（论文标题、节点、祖先、已有子节点、原文片段），不得引入外部知识，不得编造结论、数据、引用或页码；',
    '2. 每条不超过 40 字、彼此不重复；不要输出 Markdown 记号（#、**、列表符、反引号、链接语法）；',
    `3. children 最多 ${MINDMAP_EXPAND_MAX} 条；没有可补的就给空数组，不要硬凑；`,
    '4. rationale 用一两句中文说明每个改动的依据；没有改动时也要说明原因；',
    '5. 只输出 JSON：{"rationale":"改动理由","summary":"精简后的节点文字","children":["子节点A"],"mergedIds":["重复项的 id 或原文"],"topics":[{"title":"分组标题","points":["要点A"]}]}，不要输出其他文字。',
    '',
    '材料：',
    buildMindmapContextBlock(ctx)
  ].join('\n')
  return { system: SYSTEM_PROMPT, user }
}

/**
 * 整图优化（PD58）：把整张思维地图重新整理成 2–6 个分组，每组 1–5 条要点。
 * 与节点级优化不同，这里看的是整张地图的大纲，目标是消除重复、按主题归类。
 */
export function buildMapOptimizePrompt(ctx: MindmapMapPromptContext): MindmapPrompt {
  const outline = clip(collapseMultiline(ctx.outline), MINDMAP_CONTEXT_MAX_CHARS)
  const lines: string[] = []
  const passages = ctx.passages.slice(0, MINDMAP_MAX_PASSAGES)
  while (true) {
    lines.push(`论文标题：${clip(collapseText(ctx.paperTitle), MINDMAP_MAX_TITLE_CHARS) || '（未命名文献）'}`)
    lines.push('整张地图的现有内容（按层级缩进）：')
    lines.push(outline || '（空）')
    if (passages.length === 0) {
      lines.push('原文片段：（无可用原文片段）')
    } else {
      lines.push('原文片段：')
      passages.forEach((passage, index) => {
        lines.push(
          `[片段${index + 1}｜第${passage.page}页] ${clip(collapseText(passage.text), MINDMAP_PASSAGE_MAX_CHARS)}`
        )
      })
    }
    const block = lines.join('\n')
    if (block.length <= MINDMAP_CONTEXT_MAX_CHARS || passages.length === 0) break
    lines.length = 0
    passages.pop()
  }
  const user = [
    `请把这张思维地图整理成 ${MINDMAP_MAP_OPTIMIZE_MIN_GROUPS}–${MINDMAP_MAP_OPTIMIZE_MAX_GROUPS} 个主题分组，每组 ${1}–${MINDMAP_MAP_OPTIMIZE_MAX_POINTS} 条要点。`,
    '要求：',
    '1. 分组要覆盖现有地图里的主要信息，意思相近的节点合并成一条，不要重复；',
    `2. 分组标题不超过 ${MINDMAP_MAP_OPTIMIZE_MAX_TITLE} 字，每条要点不超过 ${MINDMAP_MAP_OPTIMIZE_MAX_POINT} 字，都是完整的短语或句子；`,
    '3. 只能使用下面的材料，不得引入外部知识，不得编造结论、数据、引用或页码；',
    '4. 不要输出 Markdown 记号（#、**、列表符、反引号、链接语法），也不要省略号；',
    '5. 只输出 JSON：{"rationale":"一句话说明整理思路","groups":[{"title":"分组标题","points":["要点A","要点B"]}]}，不要输出其他文字。',
    '',
    '材料：',
    lines.join('\n')
  ].join('\n')
  return { system: SYSTEM_PROMPT, user }
}

export function buildSupportPrompt(ctx: MindmapPromptContext): MindmapPrompt {
  const user = [
    '请从下面的「原文片段」里找出能直接支撑「选中节点」的原句。',
    '要求：',
    '1. quote 必须是某个片段里的**连续原文**，逐字摘录，可以整句或跨句，但不要改写、翻译、拼接多个片段；',
    '2. page 填该片段标注的页码；',
    '3. 只输出 JSON：{"found":true,"quote":"<原文逐字摘录>","page":<页码>}；',
    '4. 找不到能直接支撑的原文时，只输出 {"found":false}，绝对不要编造句子或页码。',
    '',
    '材料：',
    buildMindmapContextBlock(ctx)
  ].join('\n')
  return { system: SYSTEM_PROMPT, user }
}

/* ------------------------------------------------------------------ */
/* 结果解析                                                            */
/* ------------------------------------------------------------------ */

/** 解析摘要：容忍 JSON / 纯文本 / 带「摘要：」前缀 */
export function parseSummaryResult(raw: string): string {
  const text = stripFences(raw)
  let summary = ''
  const obj = extractJsonObject(text)
  if (obj) {
    for (const key of ['summary', 'text', 'result', 'content']) {
      const value = obj[key]
      if (typeof value === 'string' && value.trim()) {
        summary = value
        break
      }
    }
  }
  if (!summary) summary = text
  summary = collapseText(summary)
  summary = summary.replace(/^(AI)?(摘要|总结|概括)\s*[:：]\s*/u, '')
  return clip(summary, MINDMAP_MAX_SUMMARY_CHARS)
}

const CHATTER = /^(以下是|下面是|根据(上面|材料|原文)|说明[:：]|注[:：]|抱歉|很抱歉|无法|我不能|材料不足)/u

/** 解析展开结果：优先 JSON 数组 / {children:[...]}，退回逐行列表；去重并截断到 2–4 条 */
export function parseExpansionResult(raw: string): string[] {
  const text = stripFences(raw)
  const candidates: unknown[] = []
  const array = extractJsonArray(text)
  if (array) {
    candidates.push(...array)
  } else {
    const obj = extractJsonObject(text)
    if (obj) {
      for (const key of ['children', 'items', 'nodes', 'subnodes', 'texts', 'result']) {
        const value = obj[key]
        if (Array.isArray(value)) {
          candidates.push(...value)
          break
        }
      }
    }
  }
  if (candidates.length === 0) candidates.push(...text.split(/\r?\n/u))

  const plain: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      plain.push(candidate)
      continue
    }
    if (candidate && typeof candidate === 'object') {
      const record = candidate as Record<string, unknown>
      const value = record.text ?? record.title ?? record.name
      if (typeof value === 'string') plain.push(value)
    }
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const item of plain) {
    const cleaned = cleanNodeText(item)
    if (!cleaned) continue
    if (CHATTER.test(cleaned)) continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cleaned)
    if (out.length >= MINDMAP_EXPAND_MAX) break
  }
  return out
}

/** 在片段里定位引文，返回片段中的逐字原文；定位失败返回 null */
export function locateQuote(text: string, quote: string): string | null {
  const span = locateQuoteSpan(text, quote, MINDMAP_SUPPORT_MIN_QUOTE)
  if (!span) return null
  return text.slice(span.start, span.end + 1).trim()
}

/** 解析 AI 优化结果：分组契约向后兼容，同时接受 summary/children/mergedIds/rationale */
export function parseOptimizeResult(raw: string): MindmapOptimizeResult {
  const text = stripFences(raw)
  const obj = extractJsonObject(text)
  const topics: MindmapOptimizeTopic[] = []
  const seen = new Set<string>()
  const source = obj && Array.isArray(obj.topics) ? obj.topics : []
  for (const item of source) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const title = stripMarkdownForMap(collapseText(typeof record.title === 'string' ? record.title : ''))
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    const points: string[] = []
    const pointSeen = new Set<string>()
    const rawPoints = Array.isArray(record.points) ? record.points : []
    for (const value of rawPoints) {
      if (typeof value !== 'string') continue
      const point = stripMarkdownForMap(collapseText(value))
      if (!point) continue
      const pkey = point.toLowerCase()
      if (pointSeen.has(pkey)) continue
      pointSeen.add(pkey)
      points.push(point)
      if (points.length >= MINDMAP_OPTIMIZE_MAX_POINTS) break
    }
    if (points.length === 0) continue
    seen.add(key)
    topics.push({ text: title, points })
    if (topics.length >= MINDMAP_OPTIMIZE_MAX_TOPICS) break
  }

  const summary =
    obj && typeof obj.summary === 'string' ? cleanNodeText(obj.summary) : ''
  const children: string[] = []
  const childSeen = new Set<string>()
  if (obj && Array.isArray(obj.children)) {
    for (const value of obj.children) {
      if (typeof value !== 'string') continue
      const child = cleanNodeText(value)
      if (!child) continue
      const key = child.toLowerCase()
      if (childSeen.has(key)) continue
      childSeen.add(key)
      children.push(child)
      if (children.length >= MINDMAP_EXPAND_MAX) break
    }
  }
  const mergedIds: string[] = []
  if (obj && Array.isArray(obj.mergedIds)) {
    for (const value of obj.mergedIds) {
      if (typeof value !== 'string') continue
      const id = collapseText(value)
      if (id && !mergedIds.includes(id) && mergedIds.length < 20) mergedIds.push(id)
    }
  }
  const rationaleRaw =
    obj && typeof obj.rationale === 'string' ? collapseText(obj.rationale) : ''
  return {
    topics,
    ...(summary ? { summary } : {}),
    children,
    mergedIds,
    ...(rationaleRaw ? { rationale: rationaleRaw.slice(0, MINDMAP_MAX_TITLE_CHARS) } : {})
  }
}

/** 解析整图优化结果：分组标题去重、要点去重并截断，至少 2 组才算可用 */
export function parseMapOptimizeResult(raw: string): MindmapMapOptimizeResult {
  const text = stripFences(raw)
  const obj = extractJsonObject(text)
  const source = obj && Array.isArray(obj.groups) ? obj.groups : []
  const groups: MindmapMapOptimizeGroup[] = []
  const seen = new Set<string>()
  for (const item of source) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const title = stripMarkdownForMap(collapseText(typeof record.title === 'string' ? record.title : ''))
    if (!title) continue
    const clippedTitle = title.slice(0, MINDMAP_MAP_OPTIMIZE_MAX_TITLE)
    const key = clippedTitle.toLowerCase()
    if (seen.has(key)) continue
    const points: string[] = []
    const pointSeen = new Set<string>()
    for (const value of Array.isArray(record.points) ? record.points : []) {
      if (typeof value !== 'string') continue
      const point = stripMarkdownForMap(collapseText(value))
      if (!point) continue
      const clipped = point.slice(0, MINDMAP_MAP_OPTIMIZE_MAX_POINT)
      const pkey = clipped.toLowerCase()
      if (pkey === key || pointSeen.has(pkey)) continue
      pointSeen.add(pkey)
      points.push(clipped)
      if (points.length >= MINDMAP_MAP_OPTIMIZE_MAX_POINTS) break
    }
    if (points.length === 0) continue
    seen.add(key)
    groups.push({ title: clippedTitle, points })
    if (groups.length >= MINDMAP_MAP_OPTIMIZE_MAX_GROUPS) break
  }
  const rationale = obj && typeof obj.rationale === 'string' ? collapseText(obj.rationale) : ''
  return {
    groups,
    ...(rationale ? { rationale: rationale.slice(0, MINDMAP_MAX_TITLE_CHARS) } : {})
  }
}

/** 解析支撑段落：引文必须在给定片段里逐字核对，页码只用片段真实页码 */
export function parseSupportResult(raw: string, passages: MindmapPassage[]): MindmapSupportResult {
  const notFound = (reason: string): MindmapSupportResult => ({
    found: false,
    page: null,
    quote: '',
    reason,
    anchor: null
  })
  const usable = passages.filter((passage) => collapseText(passage.text).length > 0)
  if (usable.length === 0) {
    return notFound('未找到：这篇文献还没有可用的原文片段（可能尚未解析正文）')
  }

  const text = stripFences(raw)
  const obj = extractJsonObject(text)
  let quote = ''
  if (obj) {
    if (obj.found === false) return notFound('未找到：原文里没有能直接支撑该节点的段落')
    for (const key of ['quote', 'text', 'sentence', 'excerpt']) {
      const value = obj[key]
      if (typeof value === 'string' && value.trim()) {
        quote = value
        break
      }
    }
  } else {
    quote = text
  }
  quote = collapseText(quote).replace(/^["'“”‘’「」『』]+/u, '').replace(/["'“”‘’「」『』]+$/u, '')
  if (quote.length < MINDMAP_SUPPORT_MIN_QUOTE) {
    return notFound('未找到：AI 没有给出可核对的原文引用')
  }

  for (const passage of usable) {
    const located = locateQuote(passage.text, quote)
    if (located) {
      const chunkText = passage.chunkText ?? passage.text
      const anchor = locateAnchor(chunkText, quote, {
        text: chunkText,
        page: passage.page,
        bbox: passage.bbox ?? null,
        moduleId: passage.moduleId ?? null
      })
      return {
        found: true,
        page: passage.page,
        quote: located,
        reason: `已在原文第${passage.page}页找到可核对的引用`,
        anchor
      }
    }
  }
  return notFound('未找到：AI 给出的引用无法在原文中核对（已丢弃，避免编造位置）')
}

/* ------------------------------------------------------------------ */
/* 可读错误                                                            */
/* ------------------------------------------------------------------ */

const HTTP_HINT: Record<string, string> = {
  '401': 'API Key 无效或已过期，请检查设置里的 API Key',
  '403': 'API Key 没有该模型的权限，请检查设置里的 Base URL 与 API Key',
  '404': '接口地址或模型不存在，请检查设置里的 Base URL 与模型 ID',
  '429': '请求过于频繁或额度不足，请稍后重试'
}

/** 把任意错误映射成面向用户的一句话（幂等：MindmapAiError 原样返回） */
export function describeMindmapAiError(error: unknown): string {
  if (error instanceof MindmapAiError) return error.message
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw.trim()
  if (!text) return 'AI 调用失败：请稍后重试'
  if (text.includes('未配置')) return MINDMAP_AI_NOT_CONFIGURED
  if (/not\s*configured|no\s*api\s*key|api\s*key\s*(is\s*)?missing/iu.test(text)) {
    return MINDMAP_AI_NOT_CONFIGURED
  }
  const http = /HTTP\s*(\d{3})/u.exec(text)
  if (http) {
    const status = http[1]
    const detail = clip(text, 200)
    const hint = HTTP_HINT[status]
    if (hint) return `AI 请求失败（HTTP ${status}）：${hint}`
    if (Number(status) >= 500) {
      return `AI 请求失败（HTTP ${status}）：模型服务暂时不可用，请稍后重试（${detail}）`
    }
    return `AI 请求失败（HTTP ${status}）：${detail}`
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network/iu.test(text)) {
    return `AI 请求失败：网络不可用，请检查网络或设置里的 Base URL（${clip(text, 160)}）`
  }
  return `AI 调用失败：${clip(text, 200)}`
}

function normalizeThrown(error: unknown): MindmapAiError {
  if (error instanceof MindmapAiError) return error
  return new MindmapAiError('request-failed', describeMindmapAiError(error))
}

async function runComplete(complete: MindmapAiComplete, prompt: MindmapPrompt): Promise<string> {
  let raw: string
  try {
    raw = await complete(prompt.system, prompt.user)
  } catch (error) {
    throw normalizeThrown(error)
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new MindmapAiError('bad-response', 'AI 返回了空内容，请重试')
  }
  return raw
}

/* ------------------------------------------------------------------ */
/* 注入式入口（主进程与单测共用）                                       */
/* ------------------------------------------------------------------ */

/** 生成摘要：调用失败抛 MindmapAiError（带可读 message），不产生假结果 */
export async function summarizeMindMapNode(
  complete: MindmapAiComplete,
  ctx: MindmapPromptContext
): Promise<MindmapSummaryResult> {
  const raw = await runComplete(complete, buildSummaryPrompt(ctx))
  const summary = parseSummaryResult(raw)
  if (!summary) throw new MindmapAiError('bad-response', 'AI 没有返回可用的摘要，请重试')
  return { summary }
}

/** 展开子节点：至少 2 条、最多 4 条，返回文本由调用方写入地图 */
export async function expandMindMapNode(
  complete: MindmapAiComplete,
  ctx: MindmapPromptContext
): Promise<MindmapExpansionResult> {
  const raw = await runComplete(complete, buildExpandPrompt(ctx))
  const texts = parseExpansionResult(raw)
  if (texts.length < MINDMAP_EXPAND_MIN) {
    throw new MindmapAiError(
      'bad-response',
      `AI 没有给出 ${MINDMAP_EXPAND_MIN}–${MINDMAP_EXPAND_MAX} 个可用的子节点，请重试或换个节点`
    )
  }
  return { texts }
}

/** 从本文找支撑段落：核对不上就 found:false，绝不编造位置 */
export async function findSupportingPassage(
  complete: MindmapAiComplete,
  ctx: MindmapPromptContext
): Promise<MindmapSupportResult> {
  if (ctx.passages.filter((passage) => collapseText(passage.text).length > 0).length === 0) {
    return {
      found: false,
      page: null,
      quote: '',
      reason: '未找到：这篇文献还没有可用的原文片段（可能尚未解析正文）',
      anchor: null
    }
  }
  const raw = await runComplete(complete, buildSupportPrompt(ctx))
  return parseSupportResult(raw, ctx.passages)
}

/** AI 优化：把已有子节点整理成分组；材料不足或结果不可用时抛可读错误，由调用方决定保留原结构 */
export async function optimizeMindMapNode(
  complete: MindmapAiComplete,
  ctx: MindmapPromptContext
): Promise<MindmapOptimizeResult> {
  const raw = await runComplete(complete, buildOptimizePrompt(ctx))
  const result = parseOptimizeResult(raw)
  // PD57：新版结果可能只给 summary/children（不再强制 2 组 topics），
  // 但必须至少有一处可执行的改动，否则视为坏结果，由渲染层保持原地图不变。
  const hasChange =
    result.topics.length >= MINDMAP_OPTIMIZE_MIN_TOPICS ||
    (result.summary != null && result.summary.length > 0) ||
    (result.children?.length ?? 0) > 0
  if (!hasChange) {
    throw new MindmapAiError(
      'bad-response',
      `AI 没有给出可用的优化建议（需要 1 条精简措辞或 1–${MINDMAP_EXPAND_MAX} 个有依据的子节点），请重试或先补充子节点`
    )
  }
  return result
}

/**
 * 整图优化（PD58）：把整张地图交给模型重新分组。
 * 结果不足 2 组视为坏结果抛可读错误，调用方据此保持原地图不变。
 */
export async function optimizeWholeMindMap(
  complete: MindmapAiComplete,
  ctx: MindmapMapPromptContext
): Promise<MindmapMapOptimizeResult> {
  if (!collapseMultiline(ctx.outline)) {
    throw new MindmapAiError('bad-response', '这张地图还没有内容，先「从论文结构生成骨架」再优化')
  }
  const raw = await runComplete(complete, buildMapOptimizePrompt(ctx))
  const result = parseMapOptimizeResult(raw)
  if (result.groups.length < MINDMAP_MAP_OPTIMIZE_MIN_GROUPS) {
    throw new MindmapAiError(
      'bad-response',
      `AI 只给出了 ${result.groups.length} 个可用分组（至少需要 ${MINDMAP_MAP_OPTIMIZE_MIN_GROUPS} 个），请重试`
    )
  }
  return result
}

/** 便于主进程构造整图上下文：把地图展平成「缩进 + 文本」的大纲 */
export function mapOutlineFromDoc(doc: MindMapDoc): string {
  const byParent = new Map<string | null, MindMapNode[]>()
  const ids = new Set(doc.nodes.map((node) => node.id))
  for (const node of doc.nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null
    const list = byParent.get(parent) ?? []
    list.push(node)
    byParent.set(parent, list)
  }
  const lines: string[] = []
  const walk = (parentId: string, depth: number, seen: Set<string>): void => {
    if (depth > 6 || lines.length >= MINDMAP_MAP_OUTLINE_MAX_LINES) return
    for (const child of byParent.get(parentId) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      if (lines.length >= MINDMAP_MAP_OUTLINE_MAX_LINES) return
      const body = stripMarkdownForMap(collapseText(child.text)) || '（空节点）'
      lines.push(`${'  '.repeat(depth)}- ${body.slice(0, MINDMAP_MAP_OPTIMIZE_MAX_POINT)}`)
      walk(child.id, depth + 1, seen)
    }
  }
  walk(doc.rootId, 0, new Set<string>())
  return lines.join('\n')
}

/** 便于主进程构造上下文：把文档里的节点关系展开成标题/祖先/子节点/原文片段 */
export function contextFromDoc(
  doc: MindMapDoc,
  nodeId: string,
  paperTitle: string,
  passages: MindmapPassage[]
): MindmapPromptContext {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]))
  const target = byId.get(nodeId)
  if (!target) throw new MindmapAiError('bad-response', '节点不存在，请先在思维地图里选中一个节点')
  const ancestors: string[] = []
  const seen = new Set<string>([target.id])
  let cursor = target.parentId ? byId.get(target.parentId) : undefined
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    ancestors.unshift(cursor.text)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  const children = doc.nodes.filter((node) => node.parentId === target.id).map((node) => node.text)
  return { paperTitle, nodeText: target.text, ancestors, children, passages }
}
