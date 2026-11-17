/** 行级差异（LCS）。`key` 用于比较（可实现忽略大小写/空白），显示仍用原始行。 */
export interface DiffRow {
  type: '=' | '-' | '+'
  left?: string
  right?: string
}

/**
 * 行级差异（LCS）；超大文本退化为简单「集合差异」以免占用过多内存。
 */
export function lineDiff(
  a: string[],
  b: string[],
  key: (s: string) => string = (s) => s
): DiffRow[] {
  const n = a.length
  const m = b.length
  if (n * m > 250000) {
    const setB = new Set(b.map(key))
    const setA = new Set(a.map(key))
    const rows: DiffRow[] = []
    for (const l of a) if (!setB.has(key(l))) rows.push({ type: '-', left: l })
    for (const l of b) if (!setA.has(key(l))) rows.push({ type: '+', right: l })
    return rows
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        key(a[i]) === key(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) {
      rows.push({ type: '=', left: a[i], right: b[j] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: '-', left: a[i] })
      i++
    } else {
      rows.push({ type: '+', right: b[j] })
      j++
    }
  }
  while (i < n) rows.push({ type: '-', left: a[i++] })
  while (j < m) rows.push({ type: '+', right: b[j++] })
  return rows
}

/** 差异统计（用于一行摘要） */
export function diffStats(rows: DiffRow[]): { added: number; removed: number; same: number } {
  let added = 0
  let removed = 0
  let same = 0
  for (const r of rows) {
    if (r.type === '+') added++
    else if (r.type === '-') removed++
    else same++
  }
  return { added, removed, same }
}
