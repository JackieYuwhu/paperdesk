// 块高亮坐标换算（纯函数，无 DOM / 无框架依赖；Node 脚本可直接导入运行）
//
// 输入约定（与 src/shared/blocks.ts 的 SourceRegion 一致，底边原点、y 向上，
// 见 python/app/blocks_adapter.py 的 to_bottom：rect = [x0, y0, x1, y1]）：
//   region = { page(1 基), rect = [x0, y0, x1, y1] } —— 处于「页面坐标系」：
//     对应未旋转页面宽 W × 高 H，原点在左下角、y 向上。
//   page   = { width, height } —— 未旋转页面尺寸（与区域同一坐标系）。
//   opts   = { scale, rotation } —— scale 为渲染缩放；rotation 为页面顺时针旋转角
//     （只支持 0 / 90 / 180 / 270）。
//
// 输出 { left, top, width, height }：相对**旋转后**页面容器左上角（CSS 像素，
// y 向下），已乘 scale。
//
// 换算公式（与 pdf.js PageViewport 的顺时针旋转约定一致）：
// 未旋转点 (x, y)（y 向上）在旋转后展示坐标里（左上原点、y 向下）为：
//   r=0   →  X = x,      Y = H - y
//   r=90  →  X = y,      Y = x            （展示宽 = H，展示高 = W，宽高互换）
//   r=180 →  X = W - x,  Y = y
//   r=270 →  X = H - y,  Y = W - x
// 矩形两个角 (x0, y1)/(x1, y0) 分别映射为展示矩形的 (左, 上)/(右, 下) 角：
//   r=0   : left = x0,        top = H - y1,  width = x1 - x0, height = y1 - y0
//   r=90  : left = y0,        top = x0,      width = y1 - y0, height = x1 - x0
//   r=180 : left = W - x1,    top = y0,      width = x1 - x0, height = y1 - y0
//   r=270 : left = H - y1,    top = W - x1,  width = y1 - y0, height = x1 - x0
// （全部乘以 scale 输出。）

/** 结构化块的高亮区域（1 基页码 + 页面坐标系矩形，底边原点、y 向上） */
export interface OverlayRegion {
  page: number
  rect: readonly [number, number, number, number]
}

/** 页面尺寸（未旋转页面坐标系，与 OverlayRegion.rect 同系） */
export interface PageSize {
  width: number
  height: number
}

/** 换算选项：scale 为缩放比例，rotation 为页面顺时针旋转角（0/90/180/270） */
export interface OverlayOptions {
  scale: number
  rotation?: number
}

/** CSS 矩形（相对旋转后页面容器左上角，y 向下，已乘 scale） */
export interface CssRect {
  left: number
  top: number
  width: number
  height: number
}

/** region 的页码（1 基）是否就是当前展示页 currentPage（1 基）；输入异常时返回 false */
export function pageMatches(
  region: OverlayRegion | null | undefined,
  currentPage: number | null | undefined
): boolean {
  if (
    !region ||
    typeof region.page !== 'number' ||
    !Number.isFinite(region.page) ||
    typeof currentPage !== 'number' ||
    !Number.isFinite(currentPage)
  ) {
    return false
  }
  return Math.round(region.page) === Math.round(currentPage) && region.page > 0
}

/**
 * 把块区域 sourceRegion 换算成 CSS 矩形（见文件头注释的四组公式）。
 * 不做越界裁剪——裁剪交给 clampRect；输出可能超出页面边界（用于暴露而不是隐藏错位）。
 */
export function toCssRect(
  region: OverlayRegion,
  page: PageSize,
  opts: OverlayOptions
): CssRect {
  const { scale, rotation = 0 } = opts
  if (typeof scale !== 'number' || !Number.isFinite(scale)) {
    throw new Error(`block-overlay: 无效 scale ${scale}`)
  }
  const r = ((Math.round(rotation) % 360) + 360) % 360
  const [rx0, ry0, rx1, ry1] = region.rect
  const W = page.width
  const H = page.height
  let left: number
  let top: number
  let width: number
  let height: number
  switch (r) {
    case 90: // 顺时针 90°：X=y、Y=x，展示宽高与未旋转宽高互换
      left = ry0
      top = rx0
      width = ry1 - ry0
      height = rx1 - rx0
      break
    case 180: // 顺时针 180°：X=W-x、Y=y
      left = W - rx1
      top = ry0
      width = rx1 - rx0
      height = ry1 - ry0
      break
    case 270: // 顺时针 270°：X=H-y、Y=W-x，展示宽高互换
      left = H - ry1
      top = W - rx1
      width = ry1 - ry0
      height = rx1 - rx0
      break
    case 0: // 未旋转：X=x、Y=H-y（底边原点 y 向上 → 展示左上原点 y 向下就是翻 y）
      left = rx0
      top = H - ry1
      width = rx1 - rx0
      height = ry1 - ry0
      break
    default:
      throw new Error(`block-overlay: 不支持的 rotation ${rotation}（只支持 0/90/180/270）`)
  }
  // 输入矩形可能不归一化（x0>x1 或 y0>y1），归一化到正宽高，保证输出 width/height ≥ 0
  if (width < 0) {
    left += width
    width = -width
  }
  if (height < 0) {
    top += height
    height = -height
  }
  return {
    left: left * scale,
    top: top * scale,
    width: width * scale,
    height: height * scale
  }
}

/**
 * 把 CSS 矩形裁剪到页面边界内（相对左上原点，pageSize 为展示后的 CSS 尺寸）：
 * 与页面矩形求交集，left/top ≥ 0，width/height ≥ 0；完全在页面外时宽或高为 0。
 * 输入负宽高会先归一化。
 */
export function clampRect(rect: CssRect, pageSize: PageSize): CssRect {
  let { left, top, width, height } = rect
  if (width < 0) {
    left += width
    width = -width
  }
  if (height < 0) {
    top += height
    height = -height
  }
  const W = Math.max(0, pageSize.width)
  const H = Math.max(0, pageSize.height)
  const x0 = Math.max(0, Math.min(W, left))
  const x1 = Math.max(0, Math.min(W, left + width))
  const y0 = Math.max(0, Math.min(H, top))
  const y1 = Math.max(0, Math.min(H, top + height))
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 }
}

// ---------------------------------------------------------------------------
// 反向联动（页面点选 → 块命中）：toCssRect 的点级逆映射 + 最小包含块命中。
// 与上面正向换算共用同一套公式约定，保证 fromCssPoint 与 toCssRect 互为逆运算。
// ---------------------------------------------------------------------------

/** CSS 页面内点（相对旋转后页面容器左上角，y 向下，已乘 scale） */
export interface CssPoint {
  x: number
  y: number
}

/** hitBlockAt 的命中点输入：页面内 CSS 坐标 + 所属页（1 基） */
export interface CssPagePoint {
  x: number
  y: number
  page: number
}

/** hitBlockAt 需要的最小块形状（与 src/shared/blocks.ts 的 StructuredBlock 结构兼容，按需只读） */
export interface OverlayBlockLike {
  stableId: string
  sourceRegion?: OverlayRegion | null
}

/** 页面点击命中结果 */
export interface BlockHit {
  stableId: string
}

/**
 * fromCssPoint：把「页面内 CSS 点」（相对旋转后页面容器左上角、y 向下、已乘 scale）
 * 反算回页面坐标系点（底边原点、y 向上）。与文件头的正向公式逐条互逆：
 *   r=0   →  x = X,      y = H - Y
 *   r=90  →  x = Y,      y = X            （展示宽 = H，展示高 = W）
 *   r=180 →  x = W - X,  y = Y
 *   r=270 →  x = W - Y,  y = H - X
 * （X / Y 为先除回 scale 的展示坐标；page 仍是未旋转页面尺寸。）
 * scale / rotation / 点坐标非法时抛错（与 toCssRect 的口径一致）。
 */
export function fromCssPoint(
  point: CssPoint,
  page: PageSize,
  opts: OverlayOptions
): CssPoint {
  const { scale, rotation = 0 } = opts
  if (typeof scale !== 'number' || !Number.isFinite(scale)) {
    throw new Error(`block-overlay: 无效 scale ${scale}`)
  }
  const r = ((Math.round(rotation) % 360) + 360) % 360
  if (r !== 0 && r !== 90 && r !== 180 && r !== 270) {
    throw new Error(`block-overlay: 不支持的 rotation ${rotation}（只支持 0/90/180/270）`)
  }
  if (
    typeof point?.x !== 'number' ||
    typeof point?.y !== 'number' ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  ) {
    throw new Error(`block-overlay: 无效点 (${point?.x}, ${point?.y})`)
  }
  const X = point.x / scale
  const Y = point.y / scale
  const W = page.width
  const H = page.height
  switch (r) {
    case 90: // 顺时针 90°：X=y、Y=x → 逆映射 x=Y、y=X
      return { x: Y, y: X }
    case 180: // 顺时针 180°：X=W-x、Y=y → 逆映射 x=W-X、y=Y
      return { x: W - X, y: Y }
    case 270: // 顺时针 270°：X=H-y、Y=W-x → 逆映射 y=H-X、x=W-Y
      return { x: W - Y, y: H - X }
    default: // r=0：X=x、Y=H-y → 逆映射 x=X、y=H-Y
      return { x: X, y: H - Y }
  }
}

/**
 * hitBlockAt：页面点选 → 命中「包含该点的面积最小」的结构化块（反向联动核心）。
 * - 只考虑 sourceRegion 页码与命中点页码一致（pageMatches）的块；
 * - 用 fromCssPoint 把页面内 CSS 点反算回页面坐标（y 翻回向上），再对
 *   sourceRegion.rect 做包含测试（含边界，矩形先归一化到正宽高）；
 * - 同一点命中多个块时取面积最小的一个（同面积取先出现者，结果稳定）。
 * 点 / 块 / 页尺寸非法时返回 null；scale / rotation 非法则沿用 fromCssPoint 抛错。
 */
export function hitBlockAt(
  point: CssPagePoint,
  blocks: readonly OverlayBlockLike[] | null | undefined,
  pages: readonly (PageSize | null | undefined)[] | null | undefined,
  opts: OverlayOptions
): BlockHit | null {
  if (
    !point ||
    typeof point.x !== 'number' ||
    !Number.isFinite(point.x) ||
    typeof point.y !== 'number' ||
    !Number.isFinite(point.y) ||
    typeof point.page !== 'number' ||
    !Number.isFinite(point.page) ||
    point.page <= 0
  ) {
    return null
  }
  const pageNo = Math.round(point.page)
  const size = pages ? pages[pageNo - 1] : undefined
  if (
    !size ||
    typeof size.width !== 'number' ||
    !Number.isFinite(size.width) ||
    typeof size.height !== 'number' ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    return null
  }
  if (!blocks) return null
  const p = fromCssPoint(point, size, opts)
  let best: OverlayBlockLike | null = null
  let bestArea = 0
  for (const b of blocks) {
    if (!b || typeof b.stableId !== 'string' || !b.stableId) continue
    const region = b.sourceRegion
    if (!pageMatches(region, pageNo)) continue
    const rect = region?.rect
    if (!Array.isArray(rect) || rect.length !== 4) continue
    if (!rect.every((v) => typeof v === 'number' && Number.isFinite(v))) continue
    const x0 = Math.min(rect[0], rect[2])
    const x1 = Math.max(rect[0], rect[2])
    const y0 = Math.min(rect[1], rect[3])
    const y1 = Math.max(rect[1], rect[3])
    if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue
    const area = (x1 - x0) * (y1 - y0)
    if (best === null || area < bestArea) {
      best = b
      bestArea = area
    }
  }
  return best ? { stableId: best.stableId } : null
}
