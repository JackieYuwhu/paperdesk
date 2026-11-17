/**
 * 结构化文本段落重建（text-reflow）。
 *
 * PDF 抽取天然按**物理行**切块：左对齐/参差不齐的正文（摘要、标题、图表说明）
 * 每一行右侧都到不了栏右缘，几何合并判据会把它当成段末，于是结构化文本里出现
 * 「ADAS（Hu et al., 2024b）及其后续工作（Zhang」这种句子中间断开的短行。
 *
 * 这里按文本规则把被硬拆的行接回自然段，**同时保留原始行号与页内坐标**
 * （`lineFrom`/`lineTo`/`rect`），供对照视图双向联动定位。
 *
 * 判定规则（与验收口径一致）：
 * - 上一行行尾无句末标点，且下一行以小写字母或中文开头 → 合并；
 * - 上一行行尾有句号/问号/冒号等句末标点 → 不合并；
 * - 下一行是标题、编号小节、列表项、图表题注 → 不合并；
 * - 中英混排：中文与中文直接相接，英文单词之间补一个空格，
 *   中文与英文之间按排版习惯补空格，标点前后不补空格 —— 不把单词粘在一起。
 *
 * 坐标约定：`rect = [x0, y0, x1, y1]`，单位 pt，**原点在页面左下角**（与
 * `shared/modules.ts` 的 `Rect4` 一致）。
 */

import type { Rect4 } from './modules'

/** 一条 PDF 物理行（行号 = 该页按抽取顺序的 1 基物理行号） */
export interface PhysicalLine {
  text: string
  /** 1 基页码 */
  page: number
  /** 页内原始行号（1 基） */
  line: number
  rect: Rect4
  /** 调用方可选的稳定标识，用于把结果映射回输入块 */
  ref?: number
}

/** 重建后的自然段：保留首末原始行号与覆盖矩形 */
export interface ReflowParagraph {
  page: number
  lineFrom: number
  lineTo: number
  rect: Rect4
  /** 合并前的各行文本（按原顺序） */
  lines: string[]
  text: string
  /** 合并了多少条输入行（1 = 未合并） */
  merged: number
  /** 对应输入的 `PhysicalLine.ref`（按原顺序） */
  refs: number[]
}

export interface ReflowOptions {
  /** 同一段内相邻两行的最大垂直空白（pt），超过即视为换段 */
  maxLineGap?: number
  /** 上一行至少多少字符才允许跨行合并（避免把短标签连进正文） */
  minTailChars?: number
}

/** 一个自然段的原始位置：行号区间 + 覆盖矩形 */
export interface ParaGeometry {
  page: number
  lineFrom: number
  lineTo: number
  rect: Rect4
}

/** 结构化文本里的一个块（md 段落 / 标题 / 公式行），可能带原始位置 */
export interface TextBlock {
  text: string
  page: number
  geometry?: ParaGeometry
}

/** 块级重建结果：文本 + 合并后的位置信息 */
export interface ReflowBlock {
  text: string
  /** 合并后的原始位置；输入块都没有位置信息时为 null */
  geometry: ParaGeometry | null
  merged: number
  /** 合并前的各块文本（按原顺序） */
  blocks: string[]
}

const EMPTY_RECT: Rect4 = [0, 0, 0, 0]

const CJK_CLASS = '\\u2e80-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef'
const CJK_RE = new RegExp(`[${CJK_CLASS}]`)
const CJK_END_RE = new RegExp(`[${CJK_CLASS}]$`)
const CJK_START_RE = new RegExp(`^[${CJK_CLASS}]`)

/** 句末/段末标点：出现在行尾即认为本句结束 */
const SENTENCE_END_RE = /[.!?。！？…‥:：;；]\s*["'”’）)\]】》」』]?\s*$/

/** 下一行以这些字符开头时不需要补空格 */
const NO_SPACE_BEFORE_RE = /^[,.;!?%)\]}>，。；：！？、）】》”’…]/

/** 上一行以这些字符结尾时不需要补空格 */
const NO_SPACE_AFTER_RE = /[([{（【《“‘]$/

/** 列表项 / 项目符号 */
const LIST_ITEM_RE = /^(?:[-*+•·●▪◦–—]\s+|\d{1,2}[.)、]\s+|[a-zA-Z][.)]\s+)/

/** 标题类文本（正文段落里出现这些开头时，宁可断开也不合并） */
const HEADING_TEXT_RE = /^(?:#{1,6}\s|第\s*\d+\s*[章节]|摘要|Abstract\b|ABSTRACT\b|引言|Introduction\b|INTRODUCTION\b|结论|Conclusion\b|参考文献|References\b|REFERENCES\b|致谢|Acknowledge?ments?\b|图\s*\d|表\s*\d|Fig\.?\s*\d|Figure\s*\d|Table\s*\d|Algorithm\s*\d)/

/** 英文行尾断词连字符 */
const HYPHEN_END_RE = /[-\u2010\u2011]$/

/** 译文 md 里随段携带的原始位置标记（python `_write_translation_md` 写入） */
export const PD_MARK_RE = /<!--\s*pd\s+p=(\d+)\s+l=(\d+)-(\d+)\s+r=([-0-9.,\s]+?)\s*-->\s*$/

/** 是否中文字符（含全角标点） */
export function isCjkChar(ch: string): boolean {
  return !!ch && CJK_RE.test(ch)
}

/** 行尾是否是句末标点 */
export function endsWithSentencePunctuation(text: string): boolean {
  return SENTENCE_END_RE.test(String(text ?? '').trim())
}

/** 下一行是否以小写拉丁字母开头 */
export function startsLowercase(text: string): boolean {
  return /^[a-z]/.test(String(text ?? '').trim())
}

/** 下一行是否以中文开头 */
export function startsWithCjk(text: string): boolean {
  return CJK_START_RE.test(String(text ?? '').trim())
}

/** 是否是标题 / 编号小节 / 图表题注 */
export function looksLikeHeading(text: string): boolean {
  const s = String(text ?? '').trim()
  if (!s) return false
  if (HEADING_TEXT_RE.test(s)) return true
  // 全大写短行（ABSTRACT / INTRODUCTION）：多见于标题
  return s.length <= 60 && /^[A-Z][A-Z0-9\s.,\-:]{6,}$/.test(s)
}

/** 是否是列表项 */
export function looksLikeListItem(text: string): boolean {
  return LIST_ITEM_RE.test(String(text ?? '').trim())
}

/**
 * 跨行拼接：中文相接不插空格，英文单词之间补空格，标点前后不补空格。
 * 英文行尾连字符按断词处理（去掉连字符直接接上）。
 */
export function joinAcrossLines(prev: string, next: string): string {
  const a = String(prev ?? '').replace(/\s+$/, '')
  const b = String(next ?? '').replace(/^\s+/, '')
  if (!a) return b
  if (!b) return a
  if (HYPHEN_END_RE.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b
  const last = a[a.length - 1]
  const first = b[0]
  if (NO_SPACE_BEFORE_RE.test(b) || NO_SPACE_AFTER_RE.test(a)) return a + b
  if (isCjkChar(last) && isCjkChar(first)) return a + b
  return `${a} ${b}`
}

/** 文本规则：这一行是否可能是上一行的延续（被硬拆的同一句） */
export function canContinueLine(prevText: string, nextText: string, minTailChars = 8): boolean {
  const a = String(prevText ?? '').trim()
  const b = String(nextText ?? '').trim()
  if (a.length < minTailChars || b.length < 2) return false
  if (endsWithSentencePunctuation(a)) return false
  if (looksLikeHeading(a) || looksLikeListItem(a)) return false
  if (looksLikeHeading(b) || looksLikeListItem(b)) return false
  // 下一行以大写字母开头 → 新句子；只有小写或中文才算延续
  return startsLowercase(b) || startsWithCjk(b)
}

/** 两个矩形取并集；都退化时返回零矩形 */
export function unionRect(rects: Rect4[]): Rect4 {
  let out: Rect4 | null = null
  for (const r of rects ?? []) {
    if (!Array.isArray(r) || r.length !== 4 || r.some((v) => !Number.isFinite(Number(v)))) continue
    const rr: Rect4 = [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3])]
    if (!out) {
      out = rr
      continue
    }
    out = [Math.min(out[0], rr[0]), Math.min(out[1], rr[1]), Math.max(out[2], rr[2]), Math.max(out[3], rr[3])]
  }
  return out ?? [...EMPTY_RECT] as Rect4
}

/** 矩形是否有效（有面积或至少不是全 0） */
function rectUsable(r: Rect4): boolean {
  return Array.isArray(r) && r.length === 4 && r.every((v) => Number.isFinite(Number(v))) && !(r[0] === 0 && r[1] === 0 && r[2] === 0 && r[3] === 0)
}

/** 底部原点坐标里的上下行间距：上一行下缘 - 本行上缘 */
function verticalGap(prev: Rect4, cur: Rect4): number {
  return Number(prev[1]) - Number(cur[3])
}

function gapAllowsMerge(prev: Rect4, cur: Rect4, maxGap: number): boolean {
  if (!rectUsable(prev) || !rectUsable(cur)) return true
  const gap = verticalGap(prev, cur)
  return gap <= maxGap && gap >= -12
}

function buildParagraph(lines: PhysicalLine[]): ReflowParagraph {
  let text = ''
  const texts: string[] = []
  const rects: Rect4[] = []
  const refs: number[] = []
  for (const ln of lines) {
    const t = String(ln.text ?? '').trim()
    if (!t) continue
    text = joinAcrossLines(text, t)
    texts.push(t)
    if (rectUsable(ln.rect)) rects.push(ln.rect)
    if (typeof ln.ref === 'number') refs.push(ln.ref)
  }
  const first = lines[0]
  const last = lines[lines.length - 1]
  return {
    page: first.page,
    lineFrom: first.line,
    lineTo: last.line,
    rect: unionRect(rects),
    lines: texts,
    text,
    merged: texts.length,
    refs
  }
}

/**
 * 物理行 → 自然段。保留每条输入的行号与矩形（矩形取并集）。
 * 断段条件：换页、行距过大、行尾句末标点、下一行是标题/列表、下一行大写开头。
 */
export function reflowLines(lines: PhysicalLine[], opts: ReflowOptions = {}): ReflowParagraph[] {
  const maxGap = Number.isFinite(Number(opts.maxLineGap)) ? Number(opts.maxLineGap) : 8
  const minTail = Number.isFinite(Number(opts.minTailChars)) ? Number(opts.minTailChars) : 8
  const out: ReflowParagraph[] = []
  let cur: PhysicalLine[] = []

  const flush = (): void => {
    if (!cur.length) return
    const built = buildParagraph(cur)
    cur = []
    if (built.text) out.push(built)
  }

  for (const raw of lines ?? []) {
    if (!raw || !String(raw.text ?? '').trim()) {
      flush()
      continue
    }
    const ln: PhysicalLine = { ...raw, text: String(raw.text).trim() }
    if (!cur.length) {
      cur = [ln]
      continue
    }
    const prev = cur[cur.length - 1]
    const samePage = ln.page === prev.page
    const ok =
      samePage &&
      gapAllowsMerge(prev.rect, ln.rect, maxGap) &&
      canContinueLine(prev.text, ln.text, minTail) &&
      // 行号必须递增：乱序输入宁可断开，也不产生负的行号区间
      Number(ln.line) >= Number(prev.line)
    if (ok) {
      cur.push(ln)
    } else {
      flush()
      cur = [ln]
    }
  }
  flush()
  return out
}

/**
 * 结构化文本块 → 自然段（块级重建）。
 *
 * 块的文本已经由抽取合并成一行（`lines` 多行），这里按同一套文本规则把
 * 「上一块行尾无标点 + 下一块小写/中文开头」的相邻块接回去，并把各块的
 * 行号区间与矩形合并，双向联动仍能定位到原文位置。
 */
export function reflowTextBlocks(blocks: TextBlock[], opts: ReflowOptions = {}): ReflowBlock[] {
  const list = (blocks ?? []).filter((b) => !!String(b?.text ?? '').trim())
  const lines: PhysicalLine[] = list.map((block, i) => ({
    text: String(block.text).trim(),
    page: Number(block.page) || 0,
    line: block.geometry?.lineFrom ?? i + 1,
    rect: block.geometry?.rect ?? EMPTY_RECT,
    ref: i
  }))
  return reflowLines(lines, opts).map((p) => {
    const refs = p.refs.length ? p.refs : []
    const groups = refs.map((r) => list[r])
    const geos = groups.filter((g) => !!g?.geometry).map((g) => g!.geometry as ParaGeometry)
    const allRects: Rect4[] = [...geos.map((g) => g.rect)]
    if (rectUsable(p.rect)) allRects.push(p.rect)
    return {
      text: p.text,
      merged: p.merged,
      blocks: groups.map((g) => String(g?.text ?? '').trim()),
      geometry: geos.length
        ? {
            page: geos[0].page,
            lineFrom: geos[0].lineFrom,
            lineTo: geos[geos.length - 1].lineTo,
            rect: unionRect(allRects)
          }
        : null
    }
  })
}

/** 解析随段落携带的 `<!--pd ...-->` 标记；返回干净文本与位置 */
export function parsePdGeom(line: string): { text: string; geometry: ParaGeometry | null } {
  const raw = String(line ?? '')
  const m = PD_MARK_RE.exec(raw)
  if (!m) return { text: raw, geometry: null }
  const nums = m[4]
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v))
  const geometry: ParaGeometry | null =
    nums.length === 4
      ? { page: Number(m[1]), lineFrom: Number(m[2]), lineTo: Number(m[3]), rect: [nums[0], nums[1], nums[2], nums[3]] }
      : null
  return { text: raw.slice(0, m.index).replace(/\s+$/, ''), geometry }
}

/** 生成 `<!--pd ...-->` 标记（保留一位小数，够定位且不膨胀） */
export function formatPdGeom(g: ParaGeometry): string {
  const r = g.rect.map((v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : '0.0'))
  return `<!--pd p=${Math.round(Number(g.page) || 0)} l=${Math.round(Number(g.lineFrom) || 0)}-${Math.round(Number(g.lineTo) || 0)} r=${r.join(',')}-->`
}
