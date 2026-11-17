/**
 * AI 问答的纯逻辑：任务判定、翻译意图、原文选取与分段、联网三态、证据标注。
 *
 * 为什么单独成文件：这些规则同时被渲染层（决定发什么任务）与主进程（兜底判定）
 * 使用，并且必须能脱离 Electron / 网络单测（scripts/test-unit.ts）。
 * 设计约定：
 *   - 翻译不依赖检索命中：只要用户明确要求翻译，就进入 translate 任务；
 *   - 「翻译上面这段」的原文来自**选区上下文或完整的上一条用户消息**，
 *     不读被 formatHistory 截断的历史；
 *   - 长文按段落 → 句子 → 硬切三级分段，供主进程逐段翻译并上报进度。
 */
import type { AskSelection, AskTask, AskWebMode } from './types'

/** 单段上限（字符）：超过就分段，避免一次请求超模型上下文或超时 */
export const TRANSLATE_MAX_CHARS = 1500

const TRANSLATE_RE = /(翻译|译成|译为|译一下|翻成|翻一下|英译中|中译英|\btranslate\b|\btranslation\b)/i
/**
 * 明确的「执行翻译」指令标志：只有出现这些说法才真的进入翻译任务。
 * 反例（只是讨论翻译这个概念）：「什么是机器翻译？」「解释一下翻译模型的原理」。
 */
const TRANSLATE_CMD_RE =
  /(?:翻译|译|翻)\s*(?:成|为|一下|一遍|这段|这封|这句|这篇|上面|下面|以下|下列|本段|全文|该段|此段)|英译中|中译英|(?:把|将)[^。！？\n]{1,60}(?:翻译|译成|译为|翻成)|translate\s+(?:this|the\s+(?:text|following|paragraph|sentence|abstract|content|passage))|translate[\s\S]{0,40}\binto\s+(?:chinese|english)/i
/** 「翻译」作名词被讨论的短语（机器翻译 / 翻译模型 / 翻译质量 …） */
const TRANSLATE_CONCEPT_RE =
  /(?:机器|神经|统计|自动|人工|在线|实时|声学|文学|诗歌)?翻译(?:模型|系统|质量|技术|理论|研究|记忆|工具|功能|任务|能力|效果|软件|方法|策略|过程|历史|教学|专业|行业|产业|引擎|服务|领域|方向)/i
const EXPLAIN_ONLY_RE = /^(请|帮我|麻烦)?\s*(解释|说明|简述|什么是|何为|啥是|定义|define|explain|what\s+is|what's)/i
const CJK_RE = /[\u4e00-\u9fff]/g
const LATIN_RE = /[A-Za-z]/g

function countOf(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length
}

/**
 * 是否在**要求翻译**（要一段译文），而不是在讨论「翻译」这个概念：
 *   - 「什么是机器翻译？」「解释一下翻译模型的原理」「这篇论文的翻译质量如何」→ false
 *   - 「翻译上面这段」「请翻译成中文：…」「把这段话译成英文」→ true
 */
export function detectTranslateIntent(q: string): boolean {
  const text = (q ?? '').trim()
  if (!text) return false
  if (!TRANSLATE_RE.test(text)) return false
  // 明确的执行指令优先（即使句首是「请/解释」也按指令处理）
  if (TRANSLATE_CMD_RE.test(text)) return true
  // 解释型提问里出现「翻译」：在讨论概念，交给术语解释/问答
  if (EXPLAIN_ONLY_RE.test(text)) return false
  // 名词短语（翻译模型 / 翻译质量 / 翻译工具…）不是指令
  if (TRANSLATE_CONCEPT_RE.test(text)) return false
  return true
}

/**
 * 用户显式指定的目标语言（翻译成中文 / 译成英文 / 英译中 …）。
 * 优先级：本函数结果 > 界面选择的语言 > detectTargetLang 自动推断。
 */
export function detectRequestedLang(q: string): 'zh' | 'en' | null {
  const t = (q ?? '').trim()
  if (!t) return null
  // 先处理对译方向，避免「英译中」被后面的「译成…」规则误判
  if (/中译英|中文译成英文|中文翻译成英文/.test(t)) return 'en'
  if (/英译中|英文译成中文|英文翻译成中文/.test(t)) return 'zh'
  if (
    /(?:翻译|译|翻)\s*(?:成|为)\s*(?:英文|英语)|to\s+english\b|into\s+english\b|in\s+english\b/i.test(
      t
    )
  ) {
    return 'en'
  }
  if (
    /(?:翻译|译|翻)\s*(?:成|为)\s*(?:中文|汉语|简体中文|简体|国语)|to\s+chinese\b|into\s+chinese\b|in\s+chinese\b/i.test(
      t
    )
  ) {
    return 'zh'
  }
  return null
}

/** 目标语言：源文本以中文为主 → 译成英文，否则译成中文 */
export function detectTargetLang(text: string): 'zh' | 'en' {
  return countOf(CJK_RE, text ?? '') > countOf(LATIN_RE, text ?? '') ? 'en' : 'zh'
}

/**
 * 同一句里的内联原文：「请翻译：xxx」「把 xxx 翻译成中文」「翻译 “xxx”」。
 * 返回 null 表示这句话没带原文，需要回溯上文/选区。
 */
export function inlineSource(q: string): string | null {
  const t = (q ?? '').trim()
  if (!t) return null
  const quoted = t.match(/[「“"']([^」”"']{4,})[」”"']/)
  if (quoted && quoted[1].trim()) return quoted[1].trim()
  const ba = t.match(/把([\s\S]{4,}?)(?:翻译|译成|译为|翻成)/)
  if (ba && ba[1].trim()) return ba[1].trim()
  const colon = t.match(/[:：]\s*([\s\S]{4,})$/)
  if (colon) {
    const body = colon[1].trim()
    // 排除「翻译成中文：」后面什么都没有的情况
    if (body && !/^(中文|英文|英语|汉语)$/.test(body)) return body
  }
  return null
}

/** 一段文本是否像「待翻译/待引用的原文」而非提问 */
export function looksLikeSourceText(text: string): boolean {
  const t = (text ?? '').trim()
  if (t.length < 40) return false
  if (/[?？]\s*$/.test(t)) return false
  const cjk = countOf(CJK_RE, t)
  return cjk / t.length < 0.5 || t.length >= 200
}

/**
 * 长文分段：先按空行/换行切段，超长段按句末标点切，仍超长则硬切。
 * 保证每段 ≤ maxChars 且尽量不切断句子。
 */
export function splitForTranslation(text: string, maxChars = TRANSLATE_MAX_CHARS): string[] {
  const limit = Math.max(200, maxChars)
  const src = (text ?? '').replace(/\r\n/g, '\n').trim()
  if (!src) return []
  if (src.length <= limit) return [src]

  const out: string[] = []
  for (const para of src.split(/\n{2,}/)) {
    const p = para.trim()
    if (!p) continue
    if (p.length <= limit) {
      out.push(p)
      continue
    }
    // 句子级切分：英文句号/问号/感叹号后跟空白，中文句号/分号/问号
    const sentences = p.split(/(?<=[.!?。！？；;])\s*/)
    let buf = ''
    for (const s of sentences) {
      if (!s) continue
      if (s.length > limit) {
        if (buf) {
          out.push(buf)
          buf = ''
        }
        for (let i = 0; i < s.length; i += limit) out.push(s.slice(i, i + limit))
        continue
      }
      if (buf.length + s.length > limit) {
        out.push(buf)
        buf = s
      } else {
        buf += (buf ? ' ' : '') + s
      }
    }
    if (buf.trim()) out.push(buf.trim())
  }
  return out.length ? out : [src.slice(0, limit)]
}

/** 历史消息里可用于回溯原文的最小结构 */
export interface SourceMessage {
  role: 'user' | 'assistant'
  content: string
  selection?: AskSelection | null
}

/**
 * 从最近一条用户消息往前找原文：优先带选区元数据的消息，其次看起来像原文的长消息。
 */
export function pickSourceSelection(messages: SourceMessage[]): AskSelection | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const sel = m.selection
    if (sel && sel.text.trim()) {
      return {
        text: sel.text,
        attachmentId: sel.attachmentId ?? null,
        page: sel.page ?? null,
        origin: sel.origin === 'paste' ? 'paste' : 'selection'
      }
    }
    if (looksLikeSourceText(m.content)) {
      // 上一条若是「翻译：<原文>」这种指令，原文要取冒号/引号后的内容，
      // 不能把「翻译：」本身带进译文
      const text = detectTranslateIntent(m.content)
        ? (inlineSource(m.content) ?? m.content.trim())
        : m.content.trim()
      return { text, attachmentId: null, page: null, origin: 'paste' }
    }
  }
  return null
}

/**
 * 从自然语言里看出「这是在问一个术语」：解释/什么是/define/explain 开头，
 * 且不是在问这篇论文本身（那样应走论文问答，保留引用）。
 */
export function detectExplainIntent(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  if (
    !/^(?:请|帮我|麻烦)?\s*(?:解释一下|解释|说明一下|什么是|何为|啥是|定义|define|explain|what\s+is|what's)(?!器|性|力|方|员|层)/i.test(
      t
    )
  ) {
    return false
  }
  if (TRANSLATE_CMD_RE.test(t)) return false
  // 针对论文整体的问题不算术语解释
  if (/这篇|本文(?:的|主要|整体)|论文(?:的|主要|整体)|全文(?:的|总结)|总结(?:这篇|本文)/.test(t)) {
    return false
  }
  return true
}

export interface AskPlan {
  task: AskTask
  /** 翻译目标语言（非翻译任务为 null） */
  targetLang: 'zh' | 'en' | null
  /** 翻译原文及其出处（非翻译任务为 null） */
  source: AskSelection | null
  /** 单段内联原文（与 source 二选一） */
  inlineText: string | null
}

/**
 * 目标语言：用户显式指定 > 界面选择 > 按原文语种自动推断。
 * 中英混合文本同样遵守前两级，不再只看字符比例。
 */
function resolveTargetLang(
  instruction: string,
  sourceText: string,
  preferred?: 'zh' | 'en' | 'auto' | null
): 'zh' | 'en' {
  const explicit = detectRequestedLang(instruction) ?? detectRequestedLang(sourceText)
  if (explicit) return explicit
  if (preferred === 'zh' || preferred === 'en') return preferred
  return detectTargetLang(sourceText)
}

/**
 * 决定本轮任务：明确要求翻译 → translate（原文取自内联 > 选区 > 上下文）；
 * 否则沿用调用方给的任务（qa / term）。
 * preferredLang 是界面上的目标语言选择（'auto' 表示交给自动推断）。
 */
export function planAsk(
  question: string,
  messages: SourceMessage[],
  task: AskTask = 'qa',
  explicitSelection?: AskSelection | null,
  preferredLang?: 'zh' | 'en' | 'auto' | null
): AskPlan {
  const q = (question ?? '').trim()
  // 「解释 beam search」这类问法走术语解释（允许模型通用知识 + 本文用法），
  // 但「解释这篇论文的主要贡献」仍走论文问答，保留引用
  const effectiveTask: AskTask =
    task === 'qa' && detectExplainIntent(q) ? 'term' : task
  if (!detectTranslateIntent(q) || effectiveTask === 'translate') {
    // 显式指定 translate（例如按「翻译选区」按钮）时，优先用选区原文
    if (effectiveTask === 'translate') {
      const inline = inlineSource(q)
      const source = explicitSelection?.text?.trim()
        ? explicitSelection
        : inline
          ? { text: inline, attachmentId: null, page: null, origin: 'paste' as const }
          : pickSourceSelection(messages)
      const text = source?.text ?? q
      return {
        task: 'translate',
        targetLang: resolveTargetLang(q, text, preferredLang),
        source: source ?? null,
        inlineText: null
      }
    }
    return { task: effectiveTask, targetLang: null, source: null, inlineText: null }
  }

  const inline = inlineSource(q)
  // 「翻译上面这段」：上一条/选区才是原文，不要把指令本身当原文
  const fromContext = explicitSelection?.text?.trim()
    ? explicitSelection
    : pickSourceSelection(messages)
  if (inline && (!fromContext || fromContext.text.trim() !== inline)) {
    // 内联原文本身就是「选区」：把它作为 selection 存进消息，
    // 下一轮「翻译上面这段」才有干净的原文可引用（不会把「翻译：」带进去）
    return {
      task: 'translate',
      targetLang: resolveTargetLang(q, inline, preferredLang),
      source: fromContext ?? {
        text: inline,
        attachmentId: null,
        page: null,
        origin: 'paste' as const
      },
      inlineText: inline
    }
  }
  if (fromContext) {
    return {
      task: 'translate',
      targetLang: resolveTargetLang(q, fromContext.text, preferredLang),
      source: fromContext,
      inlineText: null
    }
  }
  // 没有原文：仍进 translate，由主进程给出准确的「没有可翻译原文」提示
  return {
    task: 'translate',
    targetLang: resolveTargetLang(q, q, preferredLang),
    source: null,
    inlineText: null
  }
}

/** 联网三态解析（兼容旧的布尔值 / '0'|'1' 设置） */
export function parseWebMode(raw: unknown): AskWebMode {
  if (raw === true) return 'always'
  if (raw === false || raw === undefined || raw === null) return 'off'
  const v = String(raw).trim().toLowerCase()
  if (v === 'always' || v === 'on' || v === '1' || v === 'true') return 'always'
  if (v === 'auto') return 'auto'
  return 'off'
}

/** 该模式下是否允许发起搜索请求（关闭时绝不发请求） */
export function webModeAllowsRequest(mode: AskWebMode): boolean {
  return mode === 'always' || mode === 'auto'
}

export type EvidenceKind = 'paper' | 'knowledge' | 'web' | 'model'

/** 回答里给证据分层用的中文标签（界面与提示词共用） */
export function evidenceLabel(kind: EvidenceKind): string {
  switch (kind) {
    case 'paper':
      return '论文原文'
    case 'knowledge':
      return '知识库'
    case 'web':
      return '网页来源'
    default:
      return '模型知识'
  }
}

/**
 * 这句话是否**要求联网/要最新信息**（「联网查询」「最新进展」「recent advances」）。
 * 命中时即使本地有检索命中，也应该发起网页搜索；本地检索继续保持可用。
 */
const FRESH_INFO_RE =
  /(联网|上网搜|上网查|网上搜|网上查|搜索网页|网页搜索|搜一下最新|查最新|最新进展|最新研究|最新成果|最近的研究|近期进展|最新论文|最新版本|state\s+of\s+the\s+art|\bSOTA\b|latest\s+(?:work|research|advances?|news)|recent\s+(?:progress|advances?|work|studies)|up[\s-]to[\s-]date)/i

export function wantsWebSearch(text: string): boolean {
  return FRESH_INFO_RE.test((text ?? '').trim())
}
