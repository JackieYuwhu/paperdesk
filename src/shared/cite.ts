/**
 * 引用标识解析（PD50）：把 AI 拆解产物里的 `[p.7]`、`[p.7, Tab.3]`、`[p.7–9]`
 * 这类定位标记解析成中文可读的页/表标签，交给渲染层画成 chip。
 *
 * 为什么单独一个文件：知识库正文、证据引言与单测必须共用同一份实现；
 * 本文件只做纯字符串计算，**不 import 任何运行时模块**，因此
 * `node scripts/test-unit.ts` 可以用 Node 原生 TS 类型擦除直接导入。
 *
 * 语法与 `src/shared/md-html.ts::inlineHtml` 的定位记号保持一致：
 * p./§/Fig./Tab(le)./Eq.。无法识别的写法一律原样保留，绝不抛异常。
 */

/** 一段引用里的单个定位：页（p.）或其它标签（Tab./Fig./§/Eq.） */
export interface CitePart {
  /** 页 = 有页码范围；label = 表/图/节/式等原样保留的标签 */
  kind: 'page' | 'label'
  /** 用户在正文里写的原始片段（如 `p.7`、`Tab.3`） */
  raw: string
  /** 页码（1 基，与正文 `[p.N]` 一致）；label 时为 null */
  pageStart: number | null
  pageEnd: number | null
  /** 中文可读标签（如 `第 7 页`、`Tab.3`） */
  label: string
}

/** 一段正文切分后的片段：普通文本或已解析的引用 */
export interface CiteSegment {
  kind: 'text' | 'cite'
  /** 原文（cite 片段含中括号） */
  text: string
  /** 仅 cite 片段：中文可读标签 */
  label?: string
}

/** `p.7` / `P7` / `p.7–9` / `pp.7-9` */
const PAGE_RE = /^(?:p|pp)\.?\s*(\d+)(?:\s*[–—~-]\s*(\d+))?$/iu

/** `§2.1` / `Fig.2` / `Table 3` / `Tab.3` / `Eq.4`（编号可带子级与范围） */
const LABEL_RE =
  /^(?:§|Fig\.?|Tab(?:le)?\.?|Eq\.?)\s*\d+(?:\.\d+)?(?:\s*[–—~-]\s*\d+(?:\.\d+)?)?$/iu

/** 正文里的候选中括号片段（不跨行、限长，避免把整段当引用） */
const CITE_RE = /\[([^[\]\n]{1,120})\]/gu

/**
 * 解析中括号内部内容，例如 `p.7, Tab.3`。
 * 任何一段识别不了就整体返回 null（调用方原样保留 `[....]`）。
 */
export function parseCiteInner(inner: string): CitePart[] | null {
  const raw = String(inner ?? '').trim()
  if (!raw) return null
  const pieces = raw
    .split(/[,，;；]/u)
    .map((piece) => piece.trim())
    .filter(Boolean)
  if (pieces.length === 0) return null

  const parts: CitePart[] = []
  for (const piece of pieces) {
    const page = PAGE_RE.exec(piece)
    if (page) {
      const start = Number(page[1])
      const end = page[2] === undefined ? start : Number(page[2])
      // 页码必须是非负整数，且范围不能倒序（`[p.9-3]` 视为非法写法）
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start) {
        return null
      }
      parts.push({
        kind: 'page',
        raw: piece,
        pageStart: start,
        pageEnd: end,
        label: end > start ? `第 ${start}–${end} 页` : `第 ${start} 页`
      })
      continue
    }
    if (LABEL_RE.test(piece)) {
      parts.push({ kind: 'label', raw: piece, pageStart: null, pageEnd: null, label: piece })
      continue
    }
    return null
  }
  return parts
}

/**
 * 把中括号内部内容格式化成 chip 文案：
 * `p.7` → `第 7 页`；`p.7, Tab.3` → `Tab.3 · 第 7 页`；`p.7–9` → `第 7–9 页`。
 * 非页标签排在前、页排在后（验收示例 `Tab.3 · 第 7 页` 的顺序）。
 * 无法识别时返回 null。
 */
export function formatCiteLabel(inner: string): string | null {
  const parts = parseCiteInner(inner)
  if (!parts) return null
  const labels = parts.filter((part) => part.kind === 'label').map((part) => part.label)
  const pages = parts.filter((part) => part.kind === 'page').map((part) => part.label)
  return [...labels, ...pages].join(' · ')
}

/**
 * 把一段纯文本切成「文本 / 引用」片段，供渲染层逐段画 chip。
 * 不可识别的中括号保持文本原样（不吞字符、不崩溃）。
 */
export function splitCiteText(text: string): CiteSegment[] {
  const src = String(text ?? '')
  if (!src) return []
  const out: CiteSegment[] = []
  let last = 0
  CITE_RE.lastIndex = 0
  let match = CITE_RE.exec(src)
  while (match) {
    const label = formatCiteLabel(match[1])
    if (label) {
      if (match.index > last) out.push({ kind: 'text', text: src.slice(last, match.index) })
      out.push({ kind: 'cite', text: match[0], label })
      last = match.index + match[0].length
    }
    match = CITE_RE.exec(src)
  }
  if (last < src.length) out.push({ kind: 'text', text: src.slice(last) })
  return out
}

/** 文本里是否含至少一处可识别的引用（渲染层可据此决定要不要走 chip 路径） */
export function hasCite(text: string): boolean {
  return splitCiteText(text).some((segment) => segment.kind === 'cite')
}
