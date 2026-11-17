/**
 * 大纲「搜索小节」过滤（纯函数，便于单测）。
 *
 * 说明：
 *  - 查询词先 trim 再转小写；空 / 全空白 → 返回全部下标（保持原序）；
 *  - 否则返回 `title`（小写后）包含该查询词的小节下标（原始下标，可用于跳转）；
 *  - 依赖无关，返回新数组，不修改入参。
 */
export function filterOutlineIndexes(entries: Array<{ title: string }>, query: string): number[] {
  const list = Array.isArray(entries) ? entries : []
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return list.map((_e, i) => i)
  const out: number[] = []
  list.forEach((e, i) => {
    const title = (e?.title ?? '').toLowerCase()
    if (title.includes(q)) out.push(i)
  })
  return out
}
