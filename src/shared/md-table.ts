/**
 * 从 markdown 里提取**第一张表格**并转成 CSV（纯函数，便于单测）。
 *
 * 说明：
 *  - 只取第一段连续的 `| ... |` 表格；遇到第一行非表格即停止；
 *  - 自动跳过分隔行（`|---|---|`）；
 *  - 去掉单元格里的 `**粗体**` 与反引号，含逗号/引号/换行的单元格按 CSV 规则加引号转义；
 *  - 找不到表格时返回 `''`。
 */
export interface MdTable {
  header: string[]
  rows: string[][]
}

/** 从 markdown 里提取第一张表格为「表头 + 数据行」，纯函数（便于单测）。 */
export function markdownTableToRows(markdown: string): MdTable {
  const rows = parseMarkdownTable(markdown)
  if (rows.length === 0) return { header: [], rows: [] }
  const [header, ...body] = rows
  return { header, rows: body }
}

export function markdownTableToCsv(markdown: string): string {
  const rows = parseMarkdownTable(markdown)
  if (rows.length === 0) return ''
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
}

/** 把「表头 + 数据行」转成 CSV（纯函数，便于单测）。表头为空时返回 `''`。 */
export function tableRowsToCsv(header: string[], rows: string[][]): string {
  if (!header || header.length === 0) return ''
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
}

/**
 * 计算可见列索引：返回 `0..header.length-1` 中不在 `hiddenIndexes` 里的索引（按顺序）。
 * `hiddenIndexes` 里越界的项忽略；若结果为空则返回 `[0]`（不隐藏全部列）。
 */
export function visibleColumnIndexes(header: string[], hiddenIndexes: number[]): number[] {
  const len = Array.isArray(header) ? header.length : 0
  const hidden = new Set(Array.isArray(hiddenIndexes) ? hiddenIndexes : [])
  const out: number[] = []
  for (let i = 0; i < len; i++) {
    if (!hidden.has(i)) out.push(i)
  }
  return out.length > 0 ? out : [0]
}

/** 按给定索引从每行取单元格（缺失的补 `''`），纯函数（便于单测）。 */
export function projectRows(rows: string[][], indexes: number[]): string[][] {
  const idx = Array.isArray(indexes) ? indexes : []
  return (Array.isArray(rows) ? rows : []).map((r) => idx.map((j) => r?.[j] ?? ''))
}

// ---------- 生成侧：把模型输出（表格图片 → Markdown）规范化成 GitHub 风格表格 ----------

/** 去掉整段文本外层的 Markdown 代码围栏（```lang ... ```）；无围栏时原样返回。 */
export function stripCodeFence(text: string): string {
  const t = String(text ?? '').trim()
  if (!t.includes('```')) return t
  const m = /```[^\n]*\r?\n([\s\S]*?)```/.exec(t)
  if (m) return m[1].trim()
  // 只有起始（或只有结尾）围栏：把围栏标记本身去掉
  return t
    .replace(/^```[^\n]*\r?\n?/, '')
    .replace(/\r?\n?```$/, '')
    .trim()
}

/** 单元格文本 → GFM 单元格：竖线转义为 `\|`，换行转 `<br>`。 */
function markdownCell(s: string): string {
  return String(s ?? '')
    .trim()
    .replace(/\\\|/g, '|')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
}

/** 按「未转义的竖线」切分，`\|` 视为单元格内容。 */
function splitTableLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '\\|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur)
  return cells
}

/** 一行 `| a | b |`（首尾竖线可省略）→ 单元格数组；不含竖线时返回 null。 */
function tableLineCells(line: string): string[] | null {
  const t = String(line ?? '').trim()
  if (!t.includes('|')) return null
  let s = t
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  if (s.trim() === '') return null
  return splitTableLine(s)
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(String(c ?? '').trim()))
}

/** 找到第一张「表头 + 分隔行」结构完整的表；没有则返回 null。 */
function findFirstTable(markdown: string): { header: string[]; body: string[][] } | null {
  const lines = String(markdown ?? '').split(/\r?\n/)
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = tableLineCells(lines[i])
    if (!header) continue
    const sep = tableLineCells(lines[i + 1])
    if (!sep || sep.length !== header.length || !isSeparatorRow(sep)) continue
    const body: string[][] = []
    for (let j = i + 2; j < lines.length; j++) {
      const cells = tableLineCells(lines[j])
      if (!cells) break
      if (isSeparatorRow(cells)) continue
      body.push(cells)
    }
    return { header, body }
  }
  return null
}

/** 文本里是否包含一张可识别的 Markdown 表格（表头 + 分隔行）。 */
export function looksLikeMarkdownTable(markdown: string): boolean {
  return findFirstTable(stripCodeFence(markdown)) !== null
}

/**
 * 把（模型输出的）文本规范成第一张 GitHub 风格 Markdown 表格：
 *  - 可带 ``` 代码围栏，前后可有解释文字；
 *  - 按表头列数补齐短行 / 截断长行；
 *  - 单元格里的 `|` 转义为 `\|`，换行转 `<br>`；
 *  - 输出「表头行 + `| --- |` 分隔行 + 数据行」，无表时返回 `''`。
 */
export function normalizeMarkdownTable(markdown: string): string {
  const table = findFirstTable(stripCodeFence(markdown))
  if (!table) return ''
  const width = table.header.length
  const format = (cells: string[]): string => {
    const out: string[] = []
    for (let i = 0; i < width; i++) out.push(markdownCell(cells[i] ?? ''))
    return `| ${out.join(' | ')} |`
  }
  const body = table.body.filter((cells) => cells.some((c) => String(c ?? '').trim() !== ''))
  const sep = `| ${table.header.map(() => '---').join(' | ')} |`
  return [format(table.header), sep, ...body.map(format)].join('\n')
}

/** 只取第一段连续的 `| ... |` 表格；跳过分隔行；去掉单元格里的 `**粗体**` 与反引号。 */
function parseMarkdownTable(markdown: string): string[][] {
  const lines = String(markdown ?? '').split(/\r?\n/)
  const rows: string[][] = []
  let started = false
  for (const line of lines) {
    const t = line.trim()
    if (/^\|.*\|$/.test(t)) {
      const cells = t
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(stripCell)
      if (cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))) continue // 分隔行
      rows.push(cells)
      started = true
    } else if (started) {
      break
    }
  }
  return rows
}

function stripCell(s: string): string {
  return String(s ?? '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
}

function csvCell(s: string): string {
  const t = stripCell(s)
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

// ---------- 表格块识别：表格不送翻译，译文视图里原样保留 ----------

/** 文本块：`table=true` 表示表格块（不进翻译请求，原样回填）。 */
export interface TextBlock {
  text: string
  table: boolean
}

interface RowInfo {
  /** 单元格（已按分隔方式切分） */
  cells: string[]
  /** 分隔方式：竖线 / 制表符 / 多空格对齐 */
  mode: 'pipe' | 'tab' | 'space'
  /** GFM 分隔行（|---|---|）或纯横线分隔行（---- ----） */
  separator: boolean
}

/** 纯横线单元格（`----` / `:---:`）。 */
function isDashCells(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^[:=-]{2,}$/.test(String(c ?? '').trim()))
}

/** 一行按「制表符 / 连续两个以上空格」切列；不足两列返回 null。 */
function alignedCells(line: string, mode: 'tab' | 'space'): string[] | null {
  const re = mode === 'tab' ? /\t+/g : / {2,}/g
  if (!re.test(line)) return null
  const cells = (mode === 'tab' ? line.split(/\t+/) : line.split(/ {2,}/)).map((s) => s.trim())
  // 去掉行首缩进/行尾留白造成的空列
  while (cells.length > 0 && cells[0] === '') cells.shift()
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
  if (cells.length < 2) return null
  return cells
}

/** 单行 → 表格行（竖线表 / 制表符对齐 / 多空格对齐）；不像表格行返回 null。 */
function classifyRow(line: string): RowInfo | null {
  const raw = String(line ?? '').replace(/\r$/, '')
  if (raw.trim() === '') return null
  const pipe = tableLineCells(raw)
  if (pipe && pipe.filter((c) => String(c ?? '').trim() !== '').length >= 2) {
    return { cells: pipe, mode: 'pipe', separator: isSeparatorRow(pipe) }
  }
  if (raw.includes('\t')) {
    const tab = alignedCells(raw, 'tab')
    if (tab) return { cells: tab, mode: 'tab', separator: isDashCells(tab) }
  }
  const sp = alignedCells(raw, 'space')
  if (sp) return { cells: sp, mode: 'space', separator: isDashCells(sp) }
  return null
}

/** 一段连续行是否够格算表格：列数 >= 2，且不是「两行普通文字碰巧有双空格」。 */
function acceptRun(first: RowInfo, dataRows: number, hasSeparator: boolean): boolean {
  if (first.cells.length < 2) return false
  if (first.mode === 'pipe') return dataRows >= 2 || (dataRows >= 1 && hasSeparator)
  if (first.mode === 'tab') return dataRows >= 2
  // 多空格对齐：3 行以上，或 3 列以上且有 2 行以上
  return dataRows >= 3 || (first.cells.length >= 3 && dataRows >= 2)
}

/** 找出一段文本里的表格行区间（行号闭区间，基于传入的行数组）。 */
function findTableRuns(lines: string[]): Array<{ start: number; end: number }> {
  const rows = lines.map(classifyRow)
  const runs: Array<{ start: number; end: number }> = []
  let i = 0
  while (i < lines.length) {
    const row = rows[i]
    if (!row) {
      i++
      continue
    }
    let end = i + 1
    let dataRows = row.separator ? 0 : 1
    let hasSeparator = row.separator
    while (end < lines.length) {
      const next = rows[end]
      if (!next || next.mode !== row.mode || next.cells.length !== row.cells.length) break
      if (next.separator) hasSeparator = true
      else dataRows++
      end++
    }
    if (dataRows > 0 && acceptRun(row, dataRows, hasSeparator)) {
      runs.push({ start: i, end: end - 1 })
    }
    i = Math.max(end, i + 1)
  }
  return runs
}

/** 整段文本是否就是一张表格（多行多列，且所有非空行都属于表格区间）。 */
export function isTableBlock(text: string): boolean {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '')
  if (lines.length < 2) return false
  const runs = findTableRuns(lines)
  return runs.length === 1 && runs[0].start === 0 && runs[0].end === lines.length - 1
}

/** 按空行切块（保留块内空白），并判断整块是否是表格。 */
export function splitTextBlocks(text: string): TextBlock[] {
  const src = String(text ?? '').replace(/\r\n?/g, '\n')
  const out: TextBlock[] = []
  for (const raw of src.split(/\n{2,}/)) {
    const t = raw.trim()
    if (t) out.push({ text: t, table: isTableBlock(t) })
  }
  return out
}

/** 把「段落 + 紧跟表格」的混合块按表格行区间拆开，表格段单独成块（原样保留）。 */
function splitBlockByTableRuns(blockText: string): TextBlock[] {
  const lines = blockText.split('\n')
  const runs = findTableRuns(lines)
  if (runs.length === 0) return [{ text: blockText, table: false }]
  const out: TextBlock[] = []
  let cursor = 0
  for (const run of runs) {
    const before = lines.slice(cursor, run.start).join('\n').trim()
    if (before) out.push({ text: before, table: false })
    out.push({ text: lines.slice(run.start, run.end + 1).join('\n'), table: true })
    cursor = run.end + 1
  }
  const tail = lines.slice(cursor).join('\n').trim()
  if (tail) out.push({ text: tail, table: false })
  return out
}

/** 待翻译块切分：表格块 `table=true`，文字块 `table=false`（用于只把文字块送翻译）。 */
export function splitTranslatableBlocks(text: string): TextBlock[] {
  const out: TextBlock[] = []
  for (const block of splitTextBlocks(text)) {
    if (block.table) out.push(block)
    else out.push(...splitBlockByTableRuns(block.text))
  }
  return out
}

/** 按块回填译文：表格块原样保留（行列与数字不变），文字块按顺序取译文，缺译文时回退原文。 */
export function mergeTranslatedBlocks(blocks: TextBlock[], translations: string[]): string {
  const list = Array.isArray(translations) ? translations : []
  let k = 0
  return (Array.isArray(blocks) ? blocks : [])
    .map((b) => {
      if (b.table) return b.text
      const t = list[k++]
      return typeof t === 'string' && t.trim() !== '' ? t : b.text
    })
    .join('\n\n')
}
