// 批处理失败原因聚合（纯函数）：把失败项的错误信息按文案分组计数，便于面板展示 Top N。
// 另提供失败清单的 Markdown / CSV 导出（纯函数，便于单测）。
// 注：CSV 转义规则与 `md-table.ts` 保持一致；此处内联实现，避免 node 直接运行 .ts
// 单测时无法解析扩展名省略的运行时相对导入。

export interface FailReason {
  message: string
  count: number
}

/** 失败项无可用错误信息时的占位文案。 */
export const NO_FAIL_MESSAGE = '（无信息）'

/**
 * 归一化失败原因文案：去除首尾空白，空/纯空白（含 null/undefined）折叠为 `NO_FAIL_MESSAGE`。
 */
export function normalizeFailMessage(msg: string | null | undefined): string {
  return String(msg ?? '').trim() || NO_FAIL_MESSAGE
}

/**
 * 汇总失败项的原因分布。
 * - 仅 `status === 'failed'` 的项计入 `total` 与分组；
 * - 消息经 `normalizeFailMessage` 归一，空/纯空白折叠为「（无信息）」；
 * - 按出现次数降序、次数相同按消息升序（localeCompare）排序；
 * - 仅返回前 `top` 条，但 `total` 仍统计全部失败项。
 */
export function topFailReasons(
  items: Array<{ status?: string | null; message?: string | null }>,
  top = 5
): { reasons: FailReason[]; total: number } {
  const failed = items.filter((it) => it.status === 'failed')
  const buckets = new Map<string, number>()
  for (const it of failed) {
    const message = normalizeFailMessage(it.message)
    buckets.set(message, (buckets.get(message) ?? 0) + 1)
  }
  const reasons = [...buckets.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
    .slice(0, top)
  return { reasons, total: failed.length }
}

const NO_LABEL = '（未命名）'

/** 失败清单导出为 Markdown（纯函数）。无失败项时返回 `''`。 */
export function failedItemsToMarkdown(
  items: Array<{ label?: string | null; status?: string | null; message?: string | null }>
): string {
  const failed = items.filter((it) => it.status === 'failed')
  if (failed.length === 0) return ''
  const { reasons } = topFailReasons(items)
  const lines = [
    '# 批处理失败清单',
    '',
    `## 失败原因（Top ${reasons.length}）`,
    ...reasons.map((r) => `- ${r.message} ×${r.count}`),
    '',
    '## 明细',
    ...failed.map((it) => `- ${it.label ?? NO_LABEL}：${it.message ?? ''}`)
  ]
  return lines.join('\n') + '\n'
}

/** 失败清单导出为 CSV（纯函数，转义规则同 `md-table.ts`）。无失败项时返回 `''`。 */
export function failedItemsToCsv(
  items: Array<{ label?: string | null; status?: string | null; message?: string | null }>
): string {
  const failed = items.filter((it) => it.status === 'failed')
  if (failed.length === 0) return ''
  const rows = [
    ['标签', '失败原因'],
    ...failed.map((it) => [it.label ?? NO_LABEL, it.message ?? ''])
  ]
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
}

/** CSV 单元格转义（与 `src/shared/md-table.ts` 的规则一致）。 */
function csvCell(s: string): string {
  const t = String(s ?? '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}
