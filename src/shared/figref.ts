/**
 * 图表裁剪区域计算（脚本，纯函数）。
 *
 * 坐标约定：**底边原点、y 向上**（与 pdf.js 一致）。题注 rect = [x0, y0, x1, y1]，
 * y1 是题注的**上边**；图在题注上方 → 图区域的 y 比 y1 更大。
 *
 * 多子图（如 2a/2b/2c 堆叠）会把「题注上方、彼此相邻且水平重叠」的多个矢量区域
 * 合并成一个包围盒，避免只截到最下面一块。
 */
export type Rect4 = [number, number, number, number]

/**
 * 解析引用编号串 → 编号数组。
 * "1" → [1]；"1-3" / "1–3" → [1,2,3]；"1, 3, 5" → [1,3,5]；去重且最多 60 个。
 */
export function parseRefNums(s: string): number[] {
  const nums: number[] = []
  for (const part of String(s ?? '').split(',')) {
    const r = /(\d+)\s*[-–]\s*(\d+)/.exec(part)
    if (r) {
      const a = Number(r[1])
      const b = Number(r[2])
      for (let k = a; k <= b && nums.length < 60; k++) nums.push(k)
    } else {
      const d = /(\d+)/.exec(part)
      if (d) nums.push(Number(d[1]))
    }
  }
  return Array.from(new Set(nums)).slice(0, 60)
}

export function figureCropRegion(
  regions: Rect4[],
  capRect: Rect4,
  pageW: number,
  pageH: number,
  margin: number,
  aboveFallback?: number,
  /** 题注块的下边界（含图注文字）；不传则只到题注上边 */
  capBottom?: number
): Rect4 {
  const capTop = capRect[3]
  const bottom = typeof capBottom === 'number' ? Math.max(margin, capBottom) : capTop
  const capX0 = capRect[0]
  const capX1 = capRect[2]
  // 题注上方、水平与题注有重叠的候选区域
  const cands = regions
    .filter(
      (r) =>
        r[1] >= capTop - 16 &&
        r[1] <= capTop + pageH * 0.85 &&
        r[0] < capX1 + 40 &&
        r[2] > capX0 - 40
    )
    .sort((a, b) => a[1] - b[1]) // 由下（靠近题注）到上

  let union: Rect4 | null = null
  for (const r of cands) {
    if (!union) {
      union = [r[0], r[1], r[2], r[3]]
      continue
    }
    const gap = r[1] - union[3] // 与当前并集的垂直间隙
    const overlapX = Math.min(union[2], r[2]) - Math.max(union[0], r[0])
    // 相邻（间隙小）且水平重叠 → 视为同一多子图，合并
    if (gap <= 60 && overlapX > 0) {
      union = [
        Math.min(union[0], r[0]),
        Math.min(union[1], r[1]),
        Math.max(union[2], r[2]),
        Math.max(union[3], r[3])
      ]
    } else break
  }

  if (union) {
    const x0 = Math.max(margin, union[0] - 4)
    const x1 = Math.min(pageW - margin, union[2] + 4)
    const y0 = Math.min(union[1], bottom)
    const y1 = Math.min(pageH - margin, Math.max(union[3], y0 + 24))
    return [x0, Math.min(y0, y1), x1, Math.max(y0, y1)]
  }
  // 回退：题注上方固定高度（或给定的上边界）；下边界包含图注
  const upper = Math.min(Math.max(aboveFallback ?? capTop + pageH * 0.35, capTop + 24), pageH - margin)
  return [margin, Math.min(bottom, upper), pageW - margin, Math.max(bottom, upper)]
}
