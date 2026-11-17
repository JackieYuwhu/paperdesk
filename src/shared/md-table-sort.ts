/**
 * 对比表「按列排序」（纯函数，便于单测）。
 *
 * 说明：
 *  - 排序**稳定**：键相等时保持原始行序（用原始下标兜底）；
 *  - 数值感知：`2` 排在 `10` 前面（`localeCompare` + `numeric`）；
 *  - 空 / 空白单元格始终排在最后（与升/降序无关）；
 *  - 返回**新数组**，不修改入参。
 */
export type SortDir = 'asc' | 'desc'

export interface SortState {
  col: number
  dir: SortDir
}

/** 按第 `colIndex` 列排序；稳定、数值感知、空值末尾，返回新数组。 */
export function sortRowsByColumn(rows: string[][], colIndex: number, dir: SortDir): string[][] {
  const indexed = (Array.isArray(rows) ? rows : []).map((r, i) => ({ r, i }))
  indexed.sort((a, b) => {
    const av = a.r?.[colIndex] ?? ''
    const bv = b.r?.[colIndex] ?? ''
    const aBlank = av.trim() === ''
    const bBlank = bv.trim() === ''
    if (aBlank && bBlank) return a.i - b.i
    if (aBlank) return 1 // 空值始终排最后
    if (bBlank) return -1
    const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' })
    if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
    return a.i - b.i // 稳定：相等时保持原始顺序
  })
  return indexed.map((x) => x.r)
}

/**
 * 计算点击某列后的排序状态：
 *  - 首次点击某列 → `{col, dir:'asc'}`；
 *  - 点击同一列 → 在 `asc` / `desc` 间切换；
 *  - 点击不同列 → 重置为新列 `asc`。
 * 始终返回一个 `SortState`（`| null` 仅为语义清晰）。
 */
export function nextSortState(current: SortState | null, clickedCol: number): SortState | null {
  if (current && current.col === clickedCol) {
    return { col: clickedCol, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  }
  return { col: clickedCol, dir: 'asc' }
}
