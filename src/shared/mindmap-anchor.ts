/**
 * 思维地图点锚点（PD55）：把「找支撑」命中的引文精确指回某个 chunk 的字符区间。
 *
 * 设计约束：
 * - 纯函数，不 import electron / db / React，`scripts/test-unit.ts` 可直接用 strip-types 跑；
 * - 匹配规则与 `shared/mindmap-ai.ts` 的 locateQuote 完全一致（忽略空白与引号、忽略大小写），
 *   因此 quoteStart/quoteEnd 一定能在 chunk 原文里复现同一段引用；
 * - rect/moduleId 只是透传 chunks.bbox / chunks.module_id；bbox 为空时 rect=null，
 *   绝不编造坐标。
 */
import type { MindmapAnchor } from './types'

/** 校验锚点所需的最小 chunk 形状（主进程按 chunks 行组装） */
export interface AnchorChunk {
  /** chunk 正文原文（不是折叠 / 截断后的提示词片段） */
  text: string
  /** 真实页码（从 1 开始） */
  page: number
  /** chunks.bbox 的原始 TEXT（通常是 JSON 数组串，也可能为 NULL） */
  bbox?: string | null
  /** chunks.module_id */
  moduleId?: string | null
}

/** 引文最短长度：太短的串（如单个字）不作为可核对引用 */
export const MINDMAP_ANCHOR_MIN_QUOTE = 6

interface CompactText {
  value: string
  index: number[]
}

const SPACE_RE = /[\s\u00a0\u3000]/u
const QUOTE_RE = /["'“”‘’「」『』]/u

/** 把正文压成可匹配串，并记住每个字符在原始正文里的下标 */
function compactText(text: string): CompactText {
  let value = ''
  const index: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (SPACE_RE.test(ch)) continue
    if (QUOTE_RE.test(ch)) continue
    value += ch.toLowerCase()
    index.push(i)
  }
  return { value, index }
}

/**
 * 在正文里定位引文，返回含首尾的原始字符区间；定位失败返回 null。
 * 与 locateQuote 共用同一套压缩匹配规则，保证 offset 与引用文本可互相复现。
 */
export function locateQuoteSpan(
  text: string,
  quote: string,
  minChars = MINDMAP_ANCHOR_MIN_QUOTE
): { start: number; end: number } | null {
  if (typeof text !== 'string' || typeof quote !== 'string') return null
  const needle = compactText(quote)
  if (needle.value.length < Math.max(1, Math.floor(minChars))) return null
  const haystack = compactText(text)
  const at = haystack.value.indexOf(needle.value)
  if (at < 0) return null
  const start = haystack.index[at]
  const end = haystack.index[at + needle.value.length - 1]
  if (start === undefined || end === undefined) return null
  return { start, end }
}

/** 解析 chunks.bbox：只接受 4 个有限数字的数组（JSON 串或数组），否则 null */
export function parseChunkRect(raw: unknown): [number, number, number, number] | null {
  let value: unknown = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return null
    try {
      value = JSON.parse(text)
    } catch {
      return null
    }
  }
  if (!Array.isArray(value) || value.length !== 4) return null
  const rect = value.map((item) => (typeof item === 'number' ? item : Number(item)))
  if (rect.some((item) => !Number.isFinite(item))) return null
  return [rect[0], rect[1], rect[2], rect[3]]
}

/**
 * 在 chunk 原文里定位引文并生成点锚点。
 * page 用 chunk 的真实页码；rect/moduleId 只从 chunk 透传，缺省为 null。
 */
export function locateAnchor(text: string, quote: string, chunk: AnchorChunk): MindmapAnchor | null {
  if (!chunk || typeof chunk !== 'object') return null
  const span = locateQuoteSpan(text, quote)
  if (!span) return null
  const page = Math.floor(Number(chunk.page))
  if (!Number.isFinite(page) || page < 1) return null
  return {
    page,
    quoteStart: span.start,
    quoteEnd: span.end,
    rect: parseChunkRect(chunk.bbox),
    moduleId: typeof chunk.moduleId === 'string' && chunk.moduleId ? chunk.moduleId : null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 校验并归一化一个锚点；字段缺失/类型不对返回 null（渲染层与 IPC 共用） */
export function normalizeMindmapAnchor(raw: unknown): MindmapAnchor | null {
  if (!isPlainObject(raw)) return null
  const page = Math.floor(Number(raw.page))
  const quoteStart = Math.floor(Number(raw.quoteStart))
  const quoteEnd = Math.floor(Number(raw.quoteEnd))
  if (!Number.isFinite(page) || page < 1) return null
  if (!Number.isFinite(quoteStart) || quoteStart < 0) return null
  if (!Number.isFinite(quoteEnd) || quoteEnd < quoteStart) return null
  let rect: [number, number, number, number] | null = null
  if (raw.rect !== null && raw.rect !== undefined) {
    rect = parseChunkRect(raw.rect)
    if (!rect) return null
  }
  const moduleId =
    typeof raw.moduleId === 'string' && raw.moduleId.trim() ? raw.moduleId.trim() : null
  return { page, quoteStart, quoteEnd, rect, moduleId }
}

/** 序列化锚点（稳定字段顺序，便于落盘对比） */
export function serializeMindmapAnchor(anchor: MindmapAnchor): string {
  const normalized = normalizeMindmapAnchor(anchor)
  if (!normalized) throw new Error('点锚点数据无效，无法保存')
  return JSON.stringify({
    page: normalized.page,
    quoteStart: normalized.quoteStart,
    quoteEnd: normalized.quoteEnd,
    rect: normalized.rect,
    moduleId: normalized.moduleId
  })
}

/** 反序列化锚点；损坏数据返回 null，不抛错（老地图兼容） */
export function parseMindmapAnchor(raw: unknown): MindmapAnchor | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'string') {
    try {
      return normalizeMindmapAnchor(JSON.parse(raw))
    } catch {
      return null
    }
  }
  return normalizeMindmapAnchor(raw)
}

/** 按锚点从 chunk 原文里取回逐字引用（用于「再次定位到同一个点」的核对） */
export function anchorQuote(text: string, anchor: MindmapAnchor | null | undefined): string | null {
  const normalized = normalizeMindmapAnchor(anchor)
  if (!normalized || typeof text !== 'string') return null
  if (normalized.quoteEnd >= text.length) return null
  return text.slice(normalized.quoteStart, normalized.quoteEnd + 1)
}
