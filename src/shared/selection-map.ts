import type { TranslationMap, TranslationMapBlock } from './types'

/** PDF 坐标矩形（左下原点，与选区/批注一致）；与 renderer 的 `Rect` 结构相同。 */
export type SelectionRect = [number, number, number, number]

/** 一侧的选区：页码 + 若干行矩形（一行一个，来自 clientRects）。 */
export interface SelectionRects {
  page: number
  rects: SelectionRect[]
}

/**
 * 映射阈值。三个数都经过「宁可不高亮，也不要整块兜底」的取舍：
 * - `BLOCK_MIN_RECALL`：选区落在块内的比例，低于它只是相邻块的边界误差；
 * - `SEG_MIN_RECALL`：句级命中阈值，两种形态都算命中——选区大部分落在该句片段内
 *   （选中半句/一句），或该句片段大部分被选区覆盖（多行多句整段选中）；
 * - `SEG_REL_SCORE`：句级得分 = selCov × fragCov。片段远大于选区（多行并集框）
 *   时，用相对分排除只是被框顺带盖住的邻句；
 * - `WHOLE_BLOCK_COVER`：只有选中范围真的覆盖整块时，才允许输出块矩形。
 */
export const BLOCK_MIN_RECALL = 0.5
export const SEG_MIN_RECALL = 0.5
export const SEG_REL_SCORE = 0.6
export const WHOLE_BLOCK_COVER = 0.8

function rectArea(r: SelectionRect): number {
  return Math.max(1e-6, (r[2] - r[0]) * (r[3] - r[1]))
}

/** 两矩形交集面积（无交叠为 0）。 */
function rectInter(a: SelectionRect, b: SelectionRect): number {
  const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
  const iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
  return ix > 0 && iy > 0 ? ix * iy : 0
}

/** 选区矩形的并集包围盒（用于判断「用户是不是整段全选了」）。 */
function unionRects(rects: SelectionRect[]): SelectionRect | null {
  if (!rects.length) return null
  let [x0, y0, x1, y1] = rects[0]
  for (const r of rects.slice(1)) {
    x0 = Math.min(x0, r[0])
    y0 = Math.min(y0, r[1])
    x1 = Math.max(x1, r[2])
    y1 = Math.max(y1, r[3])
  }
  return [x0, y0, x1, y1]
}

/** 块内句级配对：[选区一侧矩形, 目标一侧矩形]。 */
type SegPair = [SelectionRect, SelectionRect]

/**
 * 取块的句级配对。
 * - `segs`（新译文）：已是 `[源句矩形, 译句矩形]`，按方向翻转；
 * - 旧译文：`srcSegs`/`dstSegs` 等长时一一对应（句数不一致时不做猜测）。
 */
function segPairs(block: TranslationMapBlock, dir: 'src2dst' | 'dst2src'): SegPair[] {
  if (block.segs?.length) {
    return block.segs.map(([s, d]) =>
      dir === 'src2dst' ? ([s, d] as SegPair) : ([d, s] as SegPair)
    )
  }
  const fromSegs = dir === 'src2dst' ? block.srcSegs : block.dstSegs
  const toSegs = dir === 'src2dst' ? block.dstSegs : block.srcSegs
  if (fromSegs?.length && toSegs?.length && fromSegs.length === toSegs.length) {
    return fromSegs.map((s, i) => [s, toSegs[i]] as SegPair)
  }
  return []
}

/**
 * 对照视图「选区 → 另一侧高亮」的纯函数映射（双向）。
 *
 * 规则：
 * 1. 没有 `sel` → `null`；**完全没有 map**（旧译文没有 `.map.json`）→ 原样回声，
 *    保持「同页同矩形近似」的旧行为。
 * 2. 有 map：按**选区落进块的比例**（recall）挑块，recall 相同时选 `from` 矩形
 *    更小的块（标题/图注不被更大的正文块抢走）。
 * 3. 块内按句级片段打分（selCov × fragCov），命中条件为「选区大部分落在该片段内」
 *    或「该片段大部分被选区覆盖」：选中半句 / 一句只落在对应译文上，多行/多句
 *    选区映射成多个句级片段，每个都与选区真实相交。
 * 4. 映射不到（图/公式/被保护块/旧译文没有句级字段）**不再整块兜底**：
 *    只有选区确实覆盖整块（`WHOLE_BLOCK_COVER`）才给块矩形，否则返回空数组。
 */
export function mapSelectionRects(
  map: TranslationMap | null | undefined,
  sel: SelectionRects | null,
  dir: 'src2dst' | 'dst2src'
): SelectionRects | null {
  if (!sel) return null
  if (!map?.blocks?.length) return sel
  const fromKey = dir === 'src2dst' ? 'src' : 'dst'
  const toKey = dir === 'src2dst' ? 'dst' : 'src'
  const out: SelectionRect[] = []
  const seen = new Set<string>()
  const push = (p: SelectionRect): void => {
    const k = p.map((v) => Math.round(v * 10) / 10).join(',')
    if (seen.has(k)) return
    seen.add(k)
    out.push(p)
  }

  for (const r of sel.rects) {
    const rArea = rectArea(r)
    let best: TranslationMapBlock | null = null
    let bestRecall = 0
    let bestFromArea = Number.POSITIVE_INFINITY
    for (const b of map.blocks) {
      if (b.page !== sel.page) continue
      const a = b[fromKey]
      const recall = rectInter(r, a) / rArea
      if (recall < BLOCK_MIN_RECALL) continue
      const fromArea = rectArea(a)
      const better =
        recall > bestRecall + 1e-9 ||
        (Math.abs(recall - bestRecall) <= 1e-9 && fromArea < bestFromArea)
      if (better) {
        best = b
        bestRecall = recall
        bestFromArea = fromArea
      }
    }
    if (!best) continue

    // ---- 句级：选哪句映射哪句 ----
    const pairs = segPairs(best, dir)
    if (pairs.length) {
      const scored = pairs.map(([f, t], idx) => {
        const i = rectInter(r, f)
        const selCov = i / rArea
        const fragCov = i > 0 ? i / rectArea(f) : 0
        return { idx, selCov, fragCov, score: selCov * fragCov, to: t }
      })
      // 强命中有两种形态：选区基本落在该句片段内（选中半句/一句），或该句片段
      // 基本被选区覆盖（多行多句整段选中）。都算「这句话被选中了」。
      const strong = scored.filter(
        (x) => x.selCov >= SEG_MIN_RECALL || x.fragCov >= SEG_MIN_RECALL
      )
      if (strong.length) {
        let bestScore = 0
        for (const x of strong) bestScore = Math.max(bestScore, x.score)
        const keep = new Set<number>()
        for (const x of strong) {
          // 片段整体被选中 → 一定是用户要的；片段远大于选区时，用相对分排除
          // 只是被多行并集框顺带盖住的邻句。
          if (x.fragCov >= SEG_MIN_RECALL || x.score >= SEG_REL_SCORE * bestScore) {
            keep.add(x.idx)
          }
        }
        for (const x of scored) if (keep.has(x.idx)) push(x.to)
        continue
      }
    }

    // ---- 兜底：只有「确实整段选中」才允许块矩形 ----
    const inBlock = sel.rects.filter((q) => rectInter(q, best![fromKey]) > 0)
    const ub = unionRects(inBlock)
    if (ub) {
      const cover = Math.min(1, rectInter(ub, best[fromKey]) / rectArea(best[fromKey]))
      if (cover >= WHOLE_BLOCK_COVER) push(best[toKey])
    }
  }
  return { page: sel.page, rects: out }
}
