import type { ItemInsight } from './types'

/**
 * 从条目笔记正文里提取「已保存的论文拆解」小节。
 *
 * `upsertSectionInItemNote` 写入的格式：
 *   <!-- paperdesk:论文拆解（fine） -->
 *   ## 论文拆解（fine）
 *   ...正文...
 *   <!-- /paperdesk:论文拆解（fine） -->
 *
 * 兼容旧笔记：没有注释块时，取第一个 `## 论文拆解…` 到下一个二级标题。
 * 纯函数（无 IO），便于单测与渲染层复用。
 */
export function extractAnalysisSection(body: string | null | undefined): ItemInsight | null {
  const text = body ?? ''
  if (!text) return null

  const beginRe = /<!--\s*paperdesk:(论文拆解[^>]*?)\s*-->/g
  let m: RegExpExecArray | null
  let found: ItemInsight | null = null
  while ((m = beginRe.exec(text)) !== null) {
    const title = m[1].trim()
    const endMark = `<!-- /paperdesk:${title} -->`
    const start = m.index + m[0].length
    const end = text.indexOf(endMark, start)
    const inner = (end >= 0 ? text.slice(start, end) : text.slice(start))
      .split(/\r?\n/)
      .filter((line) => !/^\s*##\s+/.test(line))
      .join('\n')
      .trim()
    if (inner) found = { title, markdown: inner, source: 'analysis' }
  }
  if (found) return found

  // 兼容旧笔记 / 「论文拆解」面板归档（无注释块，只有 `## 论文拆解…` 标题）：
  // 取**最后一个**，因为面板每次归档都追加新小节，最后一份才是最新。
  const heads = [...text.matchAll(/^##\s+(论文拆解[^\n]*)$/gm)]
  for (let i = heads.length - 1; i >= 0; i--) {
    const h = heads[i]
    const start = (h.index ?? 0) + h[0].length
    const rest = text.slice(start)
    const next = rest.search(/^##\s+/m)
    const inner = (next >= 0 ? rest.slice(0, next) : rest).trim()
    if (inner) return { title: h[1].trim(), markdown: inner, source: 'analysis' }
  }
  return null
}
