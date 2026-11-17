/**
 * 阅读器滚动几何的纯函数层：滚动位置 ↔ 页码 / 页内偏移换算、半页步进取值、边缘标记。
 *
 * 供 PdfViewer 的「视口中线判页」与「上一页/下一页连续滚动」复用，便于纯逻辑单测（含边界）。
 * 所有函数不碰 DOM：调用方把 `.scrollpage` 的 offsetTop / offsetHeight 读成数组传入。
 */

/** 一个 `.scrollpage` 的布局快照（0 基页码来自 data-page） */
export interface ScrollPageBox {
  /** 0 基页码（.scrollpage 的 data-page） */
  page: number
  /** 相对滚动容器的 offsetTop（含页间留白） */
  offsetTop: number
  /** 页面元素高度 */
  offsetHeight: number
}

/** 滚动位置 → 页码 + 页内比例 */
export interface ScrollLocate {
  /** 0 基页码；boxes 为空时返回 0 */
  page: number
  /** 相对页面顶边的页内比例，夹取到 0..1 */
  frac: number
}

/** 半页步进比例：翻页按钮按半个视口推进，边界处同屏可见「上一页下半 + 下一页上半」 */
export const HALF_PAGE_STEP_RATIO = 0.5

/**
 * 视口中线位置 → 页码 + 页内比例。
 *
 * 规则与旧内联循环完全一致：按文档序取**最后一个 offsetTop <= mid** 的页；
 * mid 恰好等于下一页 offsetTop 时算进下一页（frac 0）。
 * 边界夹取：mid 高于所有页顶边 → 按首页 frac 0；越过末页尾部 → 末页 frac 1。
 * 高度非正防御：按 max(1, height) 计算比例，避免除以 0。
 */
export function locateByMid(mid: number, boxes: ScrollPageBox[]): ScrollLocate {
  const midNum = Number(mid)
  if (!Array.isArray(boxes) || boxes.length === 0 || !Number.isFinite(midNum)) {
    return { page: 0, frac: 0 }
  }
  let page = boxes[0].page
  let top = Number.NaN
  let height = 1
  for (const b of boxes) {
    const off = Number(b.offsetTop)
    const h = Number(b.offsetHeight)
    // 无效页框（隐藏视图 / 未布局 / 零高度）跳过，不参与判页与比例
    if (!Number.isFinite(off) || !Number.isFinite(h) || h <= 0) continue
    if (off <= midNum) {
      page = b.page
      top = off
      height = h
    } else {
      break
    }
  }
  if (!Number.isFinite(top)) {
    // mid 低于所有有效页的顶边：按第一个有效页顶边处理
    const first = boxes.find((b) => Number.isFinite(Number(b.offsetTop)) && Number(b.offsetHeight) > 0)
    if (!first) return { page: 0, frac: 0 }
    return { page: first.page, frac: 0 }
  }
  return { page, frac: Math.min(1, Math.max(0, (midNum - top) / Math.max(1, height))) }
}

/**
 * 半页步进：翻页按钮把滚动位置推进半个视口（连续阅读），并夹取在 [0, scrollMax]。
 *
 * - dir = 1 → 下一半页；dir = -1 → 上一半页
 * - 隐藏视图（viewport <= 0）或无滚动余量（scrollMax <= 0）→ 原值不动
 * - 步进后越出文档范围 → 夹取到 0 / scrollMax
 */
export function halfPageScrollTop(input: {
  scrollTop: number
  viewport: number
  scrollMax: number
  dir: 1 | -1
  ratio?: number
}): number {
  const ratio = input.ratio ?? HALF_PAGE_STEP_RATIO
  const scrollTop = Number(input.scrollTop)
  const viewport = Number(input.viewport)
  const scrollMax = Number(input.scrollMax)
  const dir = input.dir === -1 ? -1 : 1
  if (!Number.isFinite(scrollTop)) return 0
  if (!Number.isFinite(viewport) || !Number.isFinite(scrollMax)) return scrollTop
  const max = Math.max(0, scrollMax)
  if (viewport <= 0 || max <= 0) return Math.min(max, Math.max(0, scrollTop))
  const step =
    viewport * (Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : HALF_PAGE_STEP_RATIO)
  const target = scrollTop + dir * step
  return Math.min(max, Math.max(0, target))
}

/**
 * 滚动容器的边缘标记：`top` = 已在文档顶端、`bottom` = 已在文档底端。
 * 供翻页按钮禁用态使用（连续步进下页码不再与「还能不能翻」一一对应）。
 * 判定容差 1px；隐藏视图 / 空容器（viewport 或 scrollHeight <= 0）返回两个 false（不打断按钮）。
 */
export function scrollEdgeFlags(input: { scrollTop: number; viewport: number; scrollHeight: number; epsilon?: number }): {
  top: boolean
  bottom: boolean
} {
  const scrollTop = Number(input.scrollTop)
  const viewport = Number(input.viewport)
  const scrollHeight = Number(input.scrollHeight)
  const epsilon = input.epsilon ?? 1
  if (!Number.isFinite(scrollTop) || !Number.isFinite(viewport) || !Number.isFinite(scrollHeight)) {
    return { top: false, bottom: false }
  }
  const max = scrollHeight - Math.max(0, viewport)
  if (max <= 0) return { top: false, bottom: false }
  return {
    top: scrollTop <= epsilon,
    bottom: scrollTop >= max - epsilon
  }
}

/**
 * 从滚动容器读取页框布局快照（仅组件内使用；纯单测直接构造数组）。
 * selector 默认 `.scrollpage`（PDF 页）；对照视图的结构化文本页传 `.tpage` 复用同一换算规则。
 * 返回按 DOM 顺序排列的页框列表。
 */
export function readScrollPageBoxes(c: HTMLElement | null, selector = '.scrollpage'): ScrollPageBox[] {
  if (!c || typeof c.querySelectorAll !== 'function' || typeof selector !== 'string' || !selector) return []
  return Array.from(c.querySelectorAll<HTMLElement>(selector)).map((el) => ({
    page: Number(el.dataset.page),
    offsetTop: el.offsetTop,
    offsetHeight: el.offsetHeight
  }))
}

/**
 * 锚点（0 基页码 + 页内比例）→ 滚动偏移。`locateByMid` 的逆运算，双向联动的另一半。
 *
 * - 页码越界夹取到有效页框的页码范围；frac 越界夹取到 0..1
 * - 目标 = 页顶 + frac × 页高 − 半个视口，再夹取到 [0, scrollMax]，
 *   与 PdfViewer 的 syncAnchor apply 同一套规则，保证两侧可互逆往返
 * - 无效输入（无有效页框 / viewport 或 scrollMax 非有限值）返回 null，调用方跳过本次锚点
 */
export function anchorToScrollTop(input: {
  page: number
  frac: number
  boxes: ScrollPageBox[]
  viewport: number
  scrollMax: number
}): number | null {
  const viewport = Number(input.viewport)
  const scrollMax = Number(input.scrollMax)
  if (!Number.isFinite(viewport) || !Number.isFinite(scrollMax)) return null
  const valid = (Array.isArray(input.boxes) ? input.boxes : []).filter(
    (b) => Number.isFinite(Number(b.page)) && Number.isFinite(Number(b.offsetTop)) && Number(b.offsetHeight) > 0
  )
  if (valid.length === 0) return null
  const pages = valid.map((b) => Number(b.page))
  const minPage = Math.min(...pages)
  const maxPage = Math.max(...pages)
  const page = Math.min(maxPage, Math.max(minPage, Math.round(Number(input.page))))
  const frac = Math.min(1, Math.max(0, Number(input.frac)))
  if (!Number.isFinite(page) || !Number.isFinite(frac)) return null
  const heads = valid.filter((b) => Number(b.page) === page)
  const box = heads[heads.length - 1]
  if (!box) return null
  const max = Math.max(0, scrollMax)
  const raw = Number(box.offsetTop) + frac * Number(box.offsetHeight) - Math.max(0, viewport) / 2
  return Math.min(max, Math.max(0, raw))
}

/** 能取中心线做「最近块」判定的块矩形（相对滚动内容坐标） */
export interface PaneBlockBox {
  offsetTop: number
  offsetHeight: number
}

/**
 * 给定内容坐标 y（如视口中线），在候选块里挑中心最近的块。
 * 无有效候选（空数组 / 全部高度或坐标无效）返回 -1。
 */
export function pickBlockIndex(blocks: PaneBlockBox[], y: number): number {
  const yNum = Number(y)
  if (!Array.isArray(blocks) || !Number.isFinite(yNum)) return -1
  let best = -1
  let bestDist = Number.POSITIVE_INFINITY
  for (let i = 0; i < blocks.length; i++) {
    const off = Number(blocks[i].offsetTop)
    const h = Number(blocks[i].offsetHeight)
    if (!Number.isFinite(off) || !Number.isFinite(h) || h <= 0) continue
    const dist = Math.abs(off + h / 2 - yNum)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}
