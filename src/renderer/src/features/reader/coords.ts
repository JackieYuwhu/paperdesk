// 坐标转换（纯函数，无 DOM 依赖，便于单元测试）
//
// 核心约定：批注坐标一律存 **PDF 用户空间点**（左下为原点、单位 pt），
// 与画布缩放、devicePixelRatio、DOM 布局都无关。
// 页面上显示的坐标（CSS px，左上为原点）与 PDF 点之间的换算交给
// pdf.js 的 PageViewport（convertToPdfPoint / convertToViewportPoint）。

export interface PointConverter {
  /** 视口点(CSS px, 左上原点) -> PDF 点(左下原点) */
  convertToPdfPoint(x: number, y: number): number[]
  /** PDF 点 -> 视口点(CSS px, 左上原点) */
  convertToViewportPoint(x: number, y: number): number[]
}

export type Rect = [number, number, number, number] // x1, y1, x2, y2 （PDF 点）

/** 用两个角点换算矩形，并归一化为 (min, min, max, max) */
export function rectToPdfRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  vp: PointConverter
): Rect {
  const [ax, ay] = vp.convertToPdfPoint(x1, y1)
  const [bx, by] = vp.convertToPdfPoint(x2, y2)
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
}

/** PDF 矩形 -> 视口矩形（用于渲染 CSS 定位） */
export function pdfRectToViewportRect(
  r: Rect,
  vp: PointConverter
): { left: number; top: number; width: number; height: number } {
  const [ax, ay] = vp.convertToViewportPoint(r[0], r[1])
  const [bx, by] = vp.convertToViewportPoint(r[2], r[3])
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay)
  }
}

/** 一组客户端矩形 -> PDF 矩形的便捷封装（减去容器偏移） */
export function clientRectsToPdfRects(
  clientRects: Array<{ left: number; top: number; right: number; bottom: number }>,
  containerLeft: number,
  containerTop: number,
  vp: PointConverter
): Rect[] {
  return clientRects.map((r) =>
    rectToPdfRect(
      r.left - containerLeft,
      r.top - containerTop,
      r.right - containerLeft,
      r.bottom - containerTop,
      vp
    )
  )
}
