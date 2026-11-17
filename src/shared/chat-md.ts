/**
 * 聊天回答的轻量 Markdown → HTML（安全：**先转义**，再套用行内/块级规则）。
 *
 * 与 `md-html.ts`（拆解论文用，会生成 <details> 折叠章节）不同，这里面向**对话气泡**：
 * 段落 / 有序无序列表 / 标题 / 引用 / 行内 code / 粗体 / 斜体 / 引用标记 [n]。
 * 另外把 http(s) 链接转成**可点击**的 <a>（联网回答要能直接打开来源），
 * 且只允许 http(s)：`javascript:` / `data:` 等协议永远只是普通文本。
 */
// @ts-expect-error TS5097：测试用 `node scripts/test-unit.ts` 直接加载本文件，Node ESM 需要显式扩展名
import { joinAcrossLines, parsePdGeom, reflowTextBlocks, type ParaGeometry } from './text-reflow.ts'

/** 与 md-html.ts 一致的转义（本地实现，避免 ESM 扩展名与 TS 配置冲突） */
function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 裸链接：允许 URL 里的常见字符，遇到空白、尖括号、引号、中文标点即停止 */
const BARE_URL = /\bhttps?:\/\/[^\s<>"'\u3000-\u303f\uff00-\uffef]+/gi

/** 链接末尾常见的句读不属于 URL，需要剔掉（保留括号内的路径/查询） */
function trimUrlTail(url: string): string {
  let u = url
  for (;;) {
    const before = u
    u = u.replace(/[.,;:!?]$/, '')
    u = u.replace(/(&quot;|&#39;|\)|\]|\}|>)$/, '')
    if (u === before) break
  }
  return u
}

function anchorHtml(url: string, text: string): string {
  // 双保险：即使调用方传入了未转义文本，也绝不生成非 http(s) 的 href
  if (!/^https?:\/\//i.test(url)) return text
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
}

/**
 * 把**已转义**的文本里的链接换成 <a>。
 * 链接先占位（\u0000N\u0000）再还原，避免后续规则把 href 里的 URL 又包一层。
 */
function linkifyEscaped(html: string): string {
  const anchors: string[] = []
  const hold = (a: string): string => `\u0000${anchors.push(a) - 1}\u0000`
  let out = html
  // Markdown 链接 [文字](http(s)://…)
  out = out.replace(
    /\[([^\]\n]{1,160})\]\((https?:\/\/[^\s()<>]+)\)/g,
    (_m, label: string, url: string) => hold(anchorHtml(url, label))
  )
  // 裸链接 https://…
  out = out.replace(BARE_URL, (m) => {
    const url = trimUrlTail(m)
    if (!url || !/^https?:\/\//i.test(url)) return m
    return hold(anchorHtml(url, url))
  })
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => anchors[Number(i)] ?? '')
}

/** 文本（未转义）→ 只做转义 + 链接化的 HTML；供聊天以外的场景复用/单测 */
export function linkifyHtml(text: string): string {
  return linkifyEscaped(escapeHtml(text))
}

export function chatMarkdownToHtml(md: string): string {
  const lines = String(md ?? '').split(/\r?\n/)
  const out: string[] = []
  let list: string[] = []
  let ordered = false

  const inline = (s: string): string => {
    // 先转义；链接占位；再套行内格式；最后还原链接
    let html = linkifyEscaped(escapeHtml(s))
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      // 行内引用标记 [1] / [1,3] / [1-3]：渲染成小号标记
      .replace(/\[(\d{1,3}(?:\s*[,\-–]\s*\d{1,3})*)\]/g, '<span class="cite-mark">[$1]</span>')
      // 联网来源 [W1]：同样渲染成小号标记（与论文引用 [n] 区分）
      .replace(/\[W(\d{1,2})\]/g, '<span class="cite-mark">[W$1]</span>')
    // 链接占位符在 linkifyEscaped 内已还原；但引用标记规则可能命中 href 里的 `[1]`（罕见），
    // 这里不再二次处理，避免破坏 <a>。
    html = html.replace(/<span class="cite-mark">\[W(\d{1,2})\]<\/span>/g, '<span class="cite-mark">[W$1]</span>')
    return html
  }

  const flush = (): void => {
    if (!list.length) return
    out.push(
      ordered
        ? `<ol>${list.map((x) => `<li>${x}</li>`).join('')}</ol>`
        : `<ul>${list.map((x) => `<li>${x}</li>`).join('')}</ul>`
    )
    list = []
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    const li = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(trimmed)
    if (li) {
      const isOrdered = /^\d+[.)]\s+/.test(trimmed)
      if (ordered !== isOrdered) flush()
      ordered = isOrdered
      list.push(inline(li[1]))
      continue
    }
    flush()
    if (!trimmed) continue
    const h = /^(#{1,4})\s+(.+)$/.exec(trimmed)
    if (h) {
      const lvl = Math.min(6, h[1].length + 2)
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`)
      continue
    }
    const bq = /^>\s?(.*)$/.exec(trimmed)
    if (bq) {
      out.push(`<blockquote>${inline(bq[1])}</blockquote>`)
      continue
    }
    out.push(`<p>${inline(line)}</p>`)
  }
  flush()
  return out.join('')
}

/* ------------------------------------------------------------------ *
 * 译文 Markdown → 结构化 HTML（PD22）
 *
 * `python/app/translate.py::_write_translation_md` 产出的 md 与聊天 md 不同：
 * - 页与页之间用 `<!-- 第 N 页 -->` 注释分隔，渲染时**不能**当正文输出；
 * - 段落之间是空行，块内可能有多行（抽取时的折行），要并回同一段；
 * - 标题是 `#`/`##`/`###`（按字号推断），另外编号子标题（`2.1 引言`）可能没带 `#`；
 * - 项目符号来自 PDF 字形（`•`/`·`/`●`/`▪`/`◦`），不是标准 md 的 `-`；
 * - 行内公式 `$…$`、`\(…\)`、`\[…\]` 与引用标记必须**原样**保留。
 * 与 `chatMarkdownToHtml` 分开导出，避免影响 AI 气泡的既有排版。
 * ------------------------------------------------------------------ */

/** 页注释：`<!-- 第 3 页 -->` */
const T_PAGE_COMMENT = /^\s*<!--\s*第\s*(\d+)\s*页\s*-->\s*$/
/** 项目符号（PDF 字形 + 标准 md） */
const T_BULLET = /^([ \t]*)([-*+]|[•·●▪◦])\s+(.+)$/
/** 有序列表：`1. xxx` / `1) xxx` */
const T_ORDERED = /^([ \t]*)(\d{1,3})[.)]\s+(.+)$/
/** 标题：`#`~`######` */
const T_HEADING = /^(#{1,6})\s+(.+?)\s*$/
/** 编号子标题：`2.1 标题`（PDF 字号推断漏掉 `#` 时兜底） */
const T_NUMBERED_HEADING = /^(\d{1,2}(?:\.\d{1,2}){1,3})[ \t]+(\S.*)$/

/** 前导空白 → 嵌套层级（2 空格 / 1 tab 视为一级，最多 3 级） */
function translationIndentLevel(ws: string): number {
  const width = (ws ?? '').replace(/\t/g, '  ').length
  return Math.min(3, Math.floor(width / 2))
}

/**
 * 编号子标题的层级：`2.1` → h3、`2.1.1` → h4。
 * 句末带标点或过长的一律当正文，避免把「2.1 我们……」这种段落误判成标题。
 */
function translationNumberedHeadingLevel(text: string): number {
  const m = T_NUMBERED_HEADING.exec(text)
  if (!m) return 0
  const body = m[2]
  if (body.length > 120) return 0
  if (/[.。;；:：,，、]$/.test(body)) return 0
  const dots = (m[1].match(/\./g) ?? []).length
  return Math.min(6, 2 + dots)
}

/**
 * 译文行内渲染：先转义，再把公式/行内 code 占位保护，最后套强调与引用标记。
 * 公式内部含 `*`、`_`、`[1]` 时也不会被误当强调/引用。
 */
function translationInline(s: string): string {
  const holds: string[] = []
  const hold = (html: string): string => `\u0001${holds.push(html) - 1}\u0001`
  let out = escapeHtml(s)
  // 公式与行内 code 先占位（保持原文，不做二次清洗）
  out = out.replace(/\$\$([^$\n]+?)\$\$/g, (m) => hold(`<span class="tex tex--block">${m}</span>`))
  out = out.replace(/\$([^$\n]+?)\$/g, (m) => hold(`<span class="tex">${m}</span>`))
  out = out.replace(/\\\(([\s\S]*?)\\\)/g, (m) => hold(`<span class="tex">${m}</span>`))
  out = out.replace(/\\\[([\s\S]*?)\\\]/g, (m) => hold(`<span class="tex tex--block">${m}</span>`))
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => hold(`<code>${code}</code>`))
  out = linkifyEscaped(out)
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    // 论文引用 [14, 40] / [3]：小号标记，文字内容不变
    .replace(/\[(\d{1,3}(?:\s*[,\-–]\s*\d{1,3})*)\]/g, '<span class="cite-mark">[$1]</span>')
  return out.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => holds[Number(i)] ?? '')
}

interface TranslationListEntry {
  level: number
  ordered: boolean
  num: number
  text: string
}

/** 把连续的列表行渲染成（可嵌套的）`<ul>`/`<ol>`，缩进层级保留 */
function renderTranslationList(entries: TranslationListEntry[]): string {
  const base = Math.min(...entries.map((e) => e.level))
  const items = entries.map((e) => ({ ...e, level: e.level - base }))
  // 层级跳变（0 → 2）时压平到「上一级 + 1」，避免出现无父节点的悬空列表
  for (let i = 1; i < items.length; i++) {
    items[i].level = Math.min(items[i].level, items[i - 1].level + 1)
  }
  if (items.length) items[0].level = 0

  const render = (start: number, level: number, ordered: boolean): [string, number] => {
    const startNum = items[start].num
    const lis: string[] = []
    let i = start
    while (i < items.length) {
      const e = items[i]
      if (e.level !== level || e.ordered !== ordered) break
      let li = `<li>${translationInline(e.text)}`
      i++
      if (i < items.length && items[i].level > level) {
        const [child, next] = render(i, items[i].level, items[i].ordered)
        li += child
        i = next
      }
      lis.push(`${li}</li>`)
    }
    const tag = ordered ? 'ol' : 'ul'
    const attr = ordered && startNum !== 1 ? ` start="${startNum}"` : ''
    return [`<${tag}${attr}>${lis.join('')}</${tag}>`, i]
  }

  const parts: string[] = []
  let i = 0
  while (i < items.length) {
    const [html, next] = render(i, items[i].level, items[i].ordered)
    parts.push(html)
    i = next > i ? next : i + 1
  }
  return parts.join('')
}

/** 折行合并：两侧都是中文时不插空格，否则补一个空格 */
function translationJoinSoft(acc: string, line: string): string {
  if (!acc) return line
  if (!line) return acc
  const cjk = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]$/
  const cjkStart = /^[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/
  return cjk.test(acc) && cjkStart.test(line) ? acc + line : `${acc} ${line}`
}

/**
 * 译文 Markdown → 结构化 HTML（段落 / 标题 / 嵌套列表 / 分页）。
 * 只产出白名单标签：`section`/`h1`~`h6`/`p`/`ul`/`ol`/`li`/`blockquote`/`pre`/`code`/`span`/`strong`/`em`/`a`，
 * 全部文本都先经 `escapeHtml`，可安全用于 `dangerouslySetInnerHTML`。
 */
export function translationMarkdownToHtml(md: string): string {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  const seenHeadings = new Set<string>()
  let sectionOpen = false
  /** 当前 md 段落块（块内折行已并好）；空行结束一个块 */
  let paraText = ''
  let paraGeom: ParaGeometry | null = null
  let pageNo = 0
  /** 本节内相邻的正文块：输出前按「被硬拆的句子」重建自然段 */
  let paraBlocks: { text: string; page: number; geometry?: ParaGeometry }[] = []
  let listEntries: TranslationListEntry[] = []
  let fence: string[] | null = null

  /** 结束当前 md 段落块（空行 / 边界都可能触发） */
  const endParaBlock = (): void => {
    if (!paraText) return
    paraBlocks.push({ text: paraText, page: pageNo, geometry: paraGeom ?? undefined })
    paraText = ''
    paraGeom = null
  }
  /** 段落/标题的原始位置属性（有标记才有；旧 md 行为不变） */
  const pdAttrs = (g: ParaGeometry | null): string => {
    if (!g) return ''
    const rect = g.rect.map((v) => Number(v).toFixed(1)).join(',')
    return (
      ` data-pd-page="${g.page}" data-pd-lines="${g.lineFrom}-${g.lineTo}"` +
      ` data-pd-rect="${rect}"`
    )
  }
  /** 输出本节的正文：块级段落重建保留原始行号与页内坐标（供双向联动） */
  const flushPara = (): void => {
    endParaBlock()
    if (!paraBlocks.length) return
    for (const p of reflowTextBlocks(paraBlocks)) {
      const merged = p.geometry ? ` data-pd-merged="${p.merged}"` : ''
      out.push(
        `<p${pdAttrs(p.geometry)}${merged}>${translationInline(p.text)}</p>`
      )
    }
    paraBlocks = []
  }
  const flushList = (): void => {
    if (!listEntries.length) return
    out.push(renderTranslationList(listEntries))
    listEntries = []
  }
  const closeSection = (): void => {
    if (!sectionOpen) return
    out.push('</section>')
    sectionOpen = false
  }
  const openSection = (no: number): void => {
    flushPara()
    flushList()
    closeSection()
    pageNo = no
    out.push(`<section class="tpage" data-page="${no}">`)
    sectionOpen = true
  }
  /** 标题去重：跨页页眉重复出现时降级成正文，避免每页一个同级大标题 */
  const pushHeading = (level: number, text: string, geom: ParaGeometry | null = null): void => {
    const key = text.replace(/\s+/g, ' ').trim()
    if (seenHeadings.has(key)) {
      out.push(`<p class="tpage__muted"${pdAttrs(geom)}>${translationInline(text)}</p>`)
      return
    }
    seenHeadings.add(key)
    out.push(`<h${level}${pdAttrs(geom)}>${translationInline(text)}</h${level}>`)
  }

  for (const raw of lines) {
    // 代码/公式围栏：内部按原文输出
    if (fence) {
      if (/^\s*```/.test(raw)) {
        out.push(`<pre class="tpage__pre"><code>${escapeHtml(fence.join('\n'))}</code></pre>`)
        fence = null
      } else {
        fence.push(raw)
      }
      continue
    }
    if (/^\s*```/.test(raw)) {
      flushPara()
      flushList()
      fence = []
      continue
    }

    const page = T_PAGE_COMMENT.exec(raw)
    if (page) {
      openSection(Number(page[1]))
      continue
    }

    if (!raw.trim()) {
      endParaBlock()
      flushList()
      continue
    }

    // 段落原始位置标记（`<!--pd p=… l=… r=…-->`）：剥离后随段落进入 data 属性
    const parsed = parsePdGeom(raw)
    const line = parsed.text

    const bullet = T_BULLET.exec(line)
    // 「· · · T(…」这类公式行不是列表：同一个 · 后面还是 ·
    if (bullet && !(bullet[2] === '·' && bullet[3].trimStart().startsWith('·'))) {
      flushPara()
      listEntries.push({
        level: translationIndentLevel(bullet[1]),
        ordered: false,
        num: 1,
        text: bullet[3].trim()
      })
      continue
    }
    const orderedItem = T_ORDERED.exec(line)
    if (orderedItem) {
      flushPara()
      listEntries.push({
        level: translationIndentLevel(orderedItem[1]),
        ordered: true,
        num: Number(orderedItem[2]),
        text: orderedItem[3].trim()
      })
      continue
    }

    const heading = T_HEADING.exec(line.trim())
    if (heading) {
      flushPara()
      flushList()
      pushHeading(heading[1].length, heading[2].trim(), parsed.geometry)
      continue
    }
    const numberedLevel = translationNumberedHeadingLevel(line.trim())
    if (numberedLevel) {
      flushPara()
      flushList()
      pushHeading(numberedLevel, line.trim(), parsed.geometry)
      continue
    }

    // 无空行分隔的列表续行：并回上一条，不拆成新段落
    if (listEntries.length && !paraText) {
      const last = listEntries[listEntries.length - 1]
      last.text = translationJoinSoft(last.text, line.trim())
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line.trim())
    if (quote) {
      flushPara()
      flushList()
      out.push(`<blockquote>${translationInline(quote[1])}</blockquote>`)
      continue
    }

    // 正文：同一个 md 块内先折行并好；空行结束块，块间由 flushPara 重建自然段
    if (!paraText) {
      paraText = line.trim()
      paraGeom = parsed.geometry
    } else {
      paraText = joinAcrossLines(paraText, line.trim())
      if (!paraGeom && parsed.geometry) paraGeom = parsed.geometry
    }
  }
  if (fence) {
    out.push(`<pre class="tpage__pre"><code>${escapeHtml(fence.join('\n'))}</code></pre>`)
  }
  flushPara()
  flushList()
  closeSection()
  return out.join('')
}
