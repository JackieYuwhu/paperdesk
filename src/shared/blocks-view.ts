/**
 * 解析检查（阶段 E 第一刀）：结构化块列表的纯函数视图模型。
 *
 * 字段来源与 `src/shared/blocks.ts` 的 `StructuredBlock` 一致（由
 * `python/app/blocks_adapter.py` 的 `build_blocks` 产出）：
 * - 状态判定只读 `orphan` / `text` / `sourceRegion` / `blockType`，不改写任何字段；
 * - 行视图里的 `bbox` 就是 `sourceRegion.rect`（底边原点四元组），只做展平；
 * - 本文件不依赖框架、DOM、IO，可直接被 node 脚本与渲染层共用。
 */
import type { BlockRect, StructuredBlock, StructuredBlockType } from './blocks'

/** 单块状态：正常 / 可疑 / 结构错误 */
export type BlockStatus = 'ok' | 'warn' | 'error'

/** 状态原因码（稳定字符串，便于测试与上层筛选） */
export type BlockReason =
  | 'missing-page'
  | 'missing-bbox'
  | 'unknown-type'
  | 'orphan'
  | 'empty-text'

/** 块类型白名单（与 blocks_adapter.py `_classify` 的返回值一一对应） */
export const BLOCK_TYPES: readonly StructuredBlockType[] = [
  'paragraph',
  'heading',
  'caption',
  'equation',
  'equation-number',
  'reference'
]

const KNOWN_TYPES = new Set<string>(BLOCK_TYPES)

/** 需要有正文的块类型：这些类型文本为空视为可疑（公式/编号允许无文本） */
const BODY_TEXT_TYPES = new Set<string>(['paragraph', 'heading', 'caption', 'reference'])

/** 文本摘要上限（字符） */
export const PREVIEW_MAX = 60

export interface BlockStatusInfo {
  status: BlockStatus
  reasons: BlockReason[]
}

export interface BlockRow {
  /** 1 基序号，按输入阅读顺序 */
  index: number
  stableId: string
  /** 原始 blockType（未知类型按原样保留） */
  type: string
  status: BlockStatus
  reasons: BlockReason[]
  /** 1 基页码；sourceRegion 非法时为 null */
  page: number | null
  /** 即 sourceRegion.rect（底边原点）；缺失或畸形时为 null */
  bbox: BlockRect | null
  /** 折叠空白后截断到 PREVIEW_MAX 字符 */
  preview: string
}

export interface BlocksSummary {
  total: number
  ok: number
  warn: number
  error: number
  /** 按原始 blockType 计数（未知类型记为 'unknown'） */
  byType: Record<string, number>
}

/** 只读地取出 sourceRegion 的两个关键字段（不改动源对象） */
function readRegion(block: StructuredBlock): { page?: unknown; rect?: unknown } | null {
  const region = (block as { sourceRegion?: unknown }).sourceRegion
  if (typeof region !== 'object' || region === null) return null
  return region as { page?: unknown; rect?: unknown }
}

function isRect(value: unknown): value is BlockRect {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

/**
 * 判定单块状态：结构错误（缺页/缺坐标）优先，其次是可疑项（未知类型 / 未对齐 / 正文空）。
 * 纯函数，不抛错：字段缺失一律落到对应 reason。
 */
export function blockStatus(block: StructuredBlock): BlockStatusInfo {
  const reasons: BlockReason[] = []
  const region = readRegion(block)
  const page = region?.page
  const rect = region?.rect
  const type = typeof block.blockType === 'string' ? block.blockType : ''
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) reasons.push('missing-page')
  if (!isRect(rect)) reasons.push('missing-bbox')
  if (!KNOWN_TYPES.has(type)) reasons.push('unknown-type')
  if (block.orphan === true) reasons.push('orphan')
  const text = typeof block.text === 'string' ? block.text : ''
  if (BODY_TEXT_TYPES.has(type) && text.trim() === '') reasons.push('empty-text')
  const status: BlockStatus =
    reasons.includes('missing-page') || reasons.includes('missing-bbox')
      ? 'error'
      : reasons.length > 0
        ? 'warn'
        : 'ok'
  return { status, reasons }
}

/** 折叠全部空白（含换行/不换行空格）为单个半角空格并去首尾 */
export function collapseWhitespace(text: unknown): string {
  return typeof text === 'string' ? text.replace(/[\s\u00a0]+/g, ' ').trim() : ''
}

/** 单行文本摘要：折叠空白后截断到 PREVIEW_MAX 字符（不追加省略号） */
export function previewText(text: unknown): string {
  return collapseWhitespace(text).slice(0, PREVIEW_MAX)
}

/**
 * 展平为视图行：顺序与输入阅读顺序**完全一致**（不做排序，index 从 1 递增）。
 */
export function toRows(blocks: readonly StructuredBlock[] | null | undefined): BlockRow[] {
  if (!Array.isArray(blocks)) return []
  return blocks.map((block, i) => {
    const info = blockStatus(block)
    const region = readRegion(block)
    const rawPage = region?.page
    const page =
      typeof rawPage === 'number' && Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : null
    const rawRect = region?.rect
    const bbox: BlockRect | null = isRect(rawRect)
      ? [rawRect[0], rawRect[1], rawRect[2], rawRect[3]]
      : null
    return {
      index: i + 1,
      stableId: typeof block.stableId === 'string' ? block.stableId : '',
      type: typeof block.blockType === 'string' ? block.blockType : '',
      status: info.status,
      reasons: info.reasons,
      page,
      bbox,
      preview: previewText(block.text)
    }
  })
}

/** 汇总行状态与类型分布（空输入返回全 0，不抛错） */
export function summarize(rows: readonly BlockRow[] | null | undefined): BlocksSummary {
  const summary: BlocksSummary = { total: 0, ok: 0, warn: 0, error: 0, byType: {} }
  if (!Array.isArray(rows)) return summary
  for (const row of rows) {
    summary.total += 1
    if (row.status === 'ok') summary.ok += 1
    else if (row.status === 'warn') summary.warn += 1
    else summary.error += 1
    const type = row.type || 'unknown'
    summary.byType[type] = (summary.byType[type] ?? 0) + 1
  }
  return summary
}
