/**
 * 极简 Markdown → 自包含 HTML（纯函数，无依赖）。
 *
 * 只服务于 PaperDesk 生成的「论文拆解」这类结构（标题 / 无序列表 / 引用 / 代码 / 强调），
 * 刻意不追求完整 CommonMark 兼容：
 *  - `### <小节>` 变成可折叠的 `<details>`（本工具的拆解就是按小节组织的）；
 *  - `[p.N]` 定位渲染成 `<a href="#pN">`，配合页面锚点；
 *  - `**粗体**`、`` `代码` `` 做行内处理；HTML 实体转义，避免注入。
 */

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 行内：先转义，再按顺序还原受控的 Markdown 记号 */
export function inlineHtml(s: string): string {
  let t = escapeHtml(s)
  // 定位 → 锚点
  t = t.replace(/\[p\.(\d+)\]/g, '<a class="loc" href="#p$1">[p.$1]</a>')
  t = t.replace(/\[((?:§|Fig\.?|Tab(?:le)?\.?|Eq\.?)[^\]]+)\]/g, '<span class="loc">[$1]</span>')
  // 链接（仅 http/https，避免 javascript: 等）
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>')
  // 粗体 / 代码
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  return t
}

export interface MdHtmlOptions {
  /** 文档标题（<title> 与页首大标题） */
  title?: string
  /** 额外说明（如「离线占位」提示） */
  note?: string
}

export function markdownToHtml(markdown: string, opts: MdHtmlOptions = {}): string {
  const title = escapeHtml(opts.title || '论文拆解')
  const lines = String(markdown ?? '').split(/\r?\n/)
  const out: string[] = []
  let list: string[] = []
  let section = false
  let inCode = false

  const flushList = (): void => {
    if (list.length) {
      out.push(`<ul>${list.map((li) => `<li>${li}</li>`).join('')}</ul>`)
      list = []
    }
  }
  const closeSection = (): void => {
    flushList()
    if (section) {
      out.push('</div></details>')
      section = false
    }
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim().startsWith('```')) {
      flushList()
      if (!inCode) {
        inCode = true
        out.push('<pre><code>')
      } else {
        inCode = false
        out.push('</code></pre>')
      }
      continue
    }
    if (inCode) {
      out.push(escapeHtml(raw))
      continue
    }
    const sec = /^###\s+(.+)$/.exec(line.trim())
    if (sec) {
      closeSection()
      out.push(
        `<details class="sec" open><summary>${inlineHtml(sec[1])}</summary><div class="sec__body">`
      )
      section = true
      continue
    }
    const h2 = /^##\s+(.+)$/.exec(line.trim())
    if (h2) {
      closeSection()
      out.push(`<h2>${inlineHtml(h2[1])}</h2>`)
      continue
    }
    const h1 = /^#\s+(.+)$/.exec(line.trim())
    if (h1) {
      closeSection()
      out.push(`<h1>${inlineHtml(h1[1])}</h1>`)
      continue
    }
    const li = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (li) {
      list.push(inlineHtml(li[1]))
      continue
    }
    const bq = /^>\s?(.*)$/.exec(line)
    if (bq) {
      flushList()
      out.push(`<blockquote>${inlineHtml(bq[1])}</blockquote>`)
      continue
    }
    if (!line.trim()) {
      flushList()
      continue
    }
    flushList()
    out.push(`<p>${inlineHtml(line)}</p>`)
  }
  flushList()
  closeSection()

  const note = opts.note ? `<p class="note">${escapeHtml(opts.note)}</p>` : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>
:root{color-scheme:light}
body{margin:0;padding:28px 34px 60px;max-width:920px;font:15px/1.75 -apple-system,"Segoe UI","Noto Sans SC",sans-serif;color:#1c1e21;background:#fff}
h1{font-size:20px;margin:0 0 4px} h2{font-size:16px;margin:22px 0 8px}
details.sec{border:1px solid #e6e8eb;border-radius:8px;margin:10px 0;padding:6px 12px;background:#fbfbfc}
details.sec>summary{cursor:pointer;font-weight:600;font-size:15px;padding:4px 0}
.sec__body{padding:2px 0 6px}
ul{margin:6px 0;padding-left:20px} li{margin:3px 0}
blockquote{margin:8px 0;padding:4px 12px;border-left:3px solid #c8ccd2;color:#5b6069;background:#f7f8fa}
code{background:#f0f1f3;padding:1px 5px;border-radius:4px;font-size:13px}
pre{background:#f7f8fa;border:1px solid #e6e8eb;border-radius:8px;padding:12px;overflow:auto}
pre code{background:none;padding:0}
a{color:#2f6feb} .loc{color:#8a5a00;background:#fff6e0;border-radius:4px;padding:0 3px;text-decoration:none;font-size:13px}
.note{color:#8a5a00;background:#fff6e0;border-radius:6px;padding:6px 10px;font-size:13px}
@media print{details.sec{break-inside:avoid}}
</style></head>
<body>
<h1>${title}</h1>
${note}
${out.join('\n')}
</body></html>
`
}

export interface MdSection {
  /** 小节标题（`###` 后面的文本） */
  title: string
  /** 小节正文（不含标题行） */
  body: string
}

/**
 * 按 `### 小节` 把拆解 markdown 切成「引言 + 若干小节」。
 * 面板据此把每个小节渲染成可折叠块；代码块内的 `###` 不计。
 */
export function splitBySections(markdown: string): { lead: string; sections: MdSection[] } {
  const lines = String(markdown ?? '').split(/\r?\n/)
  const lead: string[] = []
  const sections: MdSection[] = []
  let cur: MdSection | null = null
  let inCode = false
  for (const line of lines) {
    if (line.trim().startsWith('```')) inCode = !inCode
    const m = !inCode ? /^###\s+(.+)$/.exec(line.trim()) : null
    if (m) {
      cur = { title: m[1].trim(), body: '' }
      sections.push(cur)
      continue
    }
    if (cur) cur.body += (cur.body ? '\n' : '') + line
    else lead.push(line)
  }
  for (const s of sections) s.body = s.body.trim()
  return { lead: lead.join('\n').trim(), sections }
}

export interface OutlineEntry {
  /** 小节在渲染顺序中的位置（0 起） */
  index: number
  /** 小节标题（`###` 后面的文本） */
  title: string
}

/** 由 splitBySections 派生的小节大纲，供面板生成可点击导航。 */
export function sectionOutline(markdown: string): OutlineEntry[] {
  return splitBySections(markdown).sections.map((s, index) => ({ index, title: s.title }))
}
