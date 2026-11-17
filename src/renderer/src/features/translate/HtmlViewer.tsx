import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { figureCropRegion } from '@shared/figref'
import type { StructuredBlock } from '@shared/blocks'
import { ParseCheckPanel } from '../reader/ParseCheckPanel'

interface Props {
  translationId: number
  /** html=译文网页；bilingual=中英对照 */
  kind?: 'html' | 'bilingual'
  /** 命中的词（仅对照视图会高亮） */
  highlight?: string
  /** 当前主题（light / dark）：深色时向页面注入深色配色 */
  theme?: string
  /** 原文附件：用于点击网页里的「图 N」时取图表预览 */
  attachmentId?: number | null
  /** 解析检查面板的数据源；不传时打开面板会按 attachmentId 懒加载 */
  blocks?: readonly StructuredBlock[] | null
  /** 解析检查行选中回调（后续接 PDF 高亮） */
  onSelectBlock?: (stableId: string) => void
}

/** 深色主题覆盖（注入到页面 </head> 之前；页面本身无脚本） */
const DARK_CSS = `
body{background:#1b1d21;color:#e6e6e6}
.sw{background:#1b1d21;border-bottom-color:#333}
.sw label{color:#ccc;border-color:#454545}
.pg+.pg{border-top-color:#333}
.pair{border-left-color:#454545}
.pair .src{color:#9aa0a6}
.pair .dst{color:#ececec}
.pgno{color:#7c828a}
.caption{color:#9aa0a6}
mark.hit-mark{background:rgba(255,190,60,.30);color:inherit}
`

// 网页译文的小缓存：同一（译文/视图/高亮/主题）再次打开时同步呈现，避免闪一下「正在载入网页」
const htmlCache = new Map<string, string>()
const HTML_CACHE_MAX = 8
function cacheHtml(key: string, html: string): void {
  htmlCache.set(key, html)
  while (htmlCache.size > HTML_CACHE_MAX) {
    const oldest = htmlCache.keys().next().value
    if (oldest == null) break
    htmlCache.delete(oldest)
  }
}

export function HtmlViewer({
  translationId,
  kind = 'html',
  highlight = '',
  theme = 'light',
  attachmentId = null,
  blocks = null,
  onSelectBlock
}: Props): React.JSX.Element {
  const [html, setHtml] = useState('')
  const [error, setError] = useState('')
  const [hitTotal, setHitTotal] = useState(0)
  const [hitIndex, setHitIndex] = useState(0)
  /** 解析检查：默认关闭；打开时才按需拉取结构化块（只读，不改渲染管线） */
  const [parseOn, setParseOn] = useState(false)
  const [parseBlocks, setParseBlocks] = useState<readonly StructuredBlock[]>([])
  const [parseLoading, setParseLoading] = useState(false)
  const [parseError, setParseError] = useState('')
  const [selectedBlock, setSelectedBlock] = useState('')
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  // 面板打开且调用方没给 blocks 时，按附件懒加载结构化块；失败只影响面板自身
  useEffect(() => {
    if (!parseOn || blocks || attachmentId == null) return
    let alive = true
    setParseLoading(true)
    setParseError('')
    void (async () => {
      try {
        const doc = await window.api.reader.modules(attachmentId)
        if (!alive) return
        setParseBlocks(doc?.blocks?.blocks ?? [])
      } catch (err) {
        if (!alive) return
        setParseBlocks([])
        setParseError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive) setParseLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [parseOn, blocks, attachmentId])

  const handleSelectBlock = useCallback(
    (stableId: string): void => {
      setSelectedBlock(stableId)
      onSelectBlock?.(stableId)
    },
    [onSelectBlock]
  )
  /** 对照视图「划词/悬停联动高亮」的清理函数（切换译文/视图前须先移除旧监听） */
  const syncCleanupRef = useRef<(() => void) | null>(null)

  const clearSync = useCallback((): void => {
    if (syncCleanupRef.current) {
      try {
        syncCleanupRef.current()
      } catch {
        /* 忽略 */
      }
      syncCleanupRef.current = null
    }
  }, [])

  // 组件卸载时移除 iframe 内的联动监听（避免跨视图泄漏）
  useEffect(() => clearSync, [clearSync])

  /** 网页译文里的图表引用：点击「图 N / Fig. N」→ 弹出图表预览（侧车渲染 PNG） */
  const [figPop, setFigPop] = useState<{ label: string; left: number; top: number; png: string } | null>(
    null
  )
  const figCacheRef = useRef<Array<{
    page: number
    w: number
    h: number
    rects: number[][]
    captions: Array<{ n: number; letter: string; kind: string; rect: number[] }>
  }> | null>(null)
  const figCleanupRef = useRef<(() => void) | null>(null)

  const clearFigRefs = useCallback((): void => {
    if (figCleanupRef.current) {
      try {
        figCleanupRef.current()
      } catch {
        /* 忽略 */
      }
      figCleanupRef.current = null
    }
  }, [])

  const onFigRefClick = useCallback(
    async (ev: MouseEvent): Promise<void> => {
      // ---- 「应用」等处的链接：外部链接交给系统浏览器打开（沙箱 iframe 内默认点不动）----
      const anchor = (ev.target as Element | null)?.closest('a') as HTMLAnchorElement | null
      if (anchor) {
        const href = anchor.getAttribute('href') || ''
        if (/^https?:/i.test(href)) {
          ev.preventDefault()
          void window.api.app.openExternal(href)
          return
        }
      }
      const el = (ev.target as Element | null)?.closest('.figref') as HTMLElement | null
      if (!el) return
      ev.preventDefault()
      const n = Number(el.dataset.n || '0')
      const letter = el.dataset.letter || ''
      const kind = (el.dataset.kind as 'figure' | 'table' | 'any') || 'any'
      if (!n || attachmentId == null) return
      if (!figCacheRef.current) {
        figCacheRef.current = await window.api.reader.figures(attachmentId)
      }
      const pages = figCacheRef.current ?? []
      const caps = pages.flatMap((p) => p.captions.map((c) => ({ ...c, page: p.page })))
      const cap =
        caps.find(
          (c) =>
            c.n === n &&
            (kind === 'any' || c.kind === kind) &&
            (!letter || !c.letter || c.letter === letter)
        ) ?? caps.find((c) => c.n === n && (kind === 'any' || c.kind === kind))
      if (!cap) return
      const pg = pages.find((p) => p.page === cap.page)
      const regs = (pg?.rects ?? []) as Array<[number, number, number, number]>
      const region = figureCropRegion(
        regs,
        [cap.rect[0], cap.rect[3], cap.rect[2], cap.rect[3]],
        pg?.w && pg.w > 0 ? pg.w : 612,
        pg?.h && pg.h > 0 ? pg.h : 792,
        28,
        undefined,
        cap.rect[1]
      )
      const img = await window.api.reader.figureImage(attachmentId, cap.page, region, 1.6)
      if (!img) return
      const fr = frameRef.current?.getBoundingClientRect()
      const cx = (fr?.left ?? 0) + ev.clientX
      const cy = (fr?.top ?? 0) + ev.clientY
      setFigPop({
        label: `${cap.kind === 'table' ? '表' : '图'} ${n}${letter}`,
        left: Math.max(8, Math.min(cx + 12, Math.max(8, window.innerWidth - 460))),
        top: Math.max(8, Math.min(cy + 12, Math.max(8, window.innerHeight - 340))),
        png: img.png
      })
    },
    [attachmentId]
  )

  /** 把网页里的「图 N / Fig. N」包成可点击 span（iframe 同源，可直接改其 DOM） */
  const setupFigRefs = useCallback(
    (doc: Document): void => {
      clearFigRefs()
      if (attachmentId == null) return
      try {
        if (!doc.getElementById('ps-figref-style')) {
          const st = doc.createElement('style')
          st.id = 'ps-figref-style'
          st.textContent =
            '.figref{background:rgba(59,130,246,.22);border-radius:3px;cursor:pointer}'
          doc.head?.appendChild(st)
        }
        // ---- 旧译文兜底：把纯文本 URL / DOI 变成可点外链 ----
        // 只匹配明确形态（http(s):// / www. / doi: / 裸 DOI），不猜测；已在 <a> 或数学片段内的跳过。
        if (!doc.getElementById('ps-link-style')) {
          const st = doc.createElement('style')
          st.id = 'ps-link-style'
          st.textContent =
            'a.ext-link{color:#2f6fed;text-decoration:underline;text-underline-offset:2px}'
          doc.head?.appendChild(st)
        }
        const urlRe =
          /(https?:\/\/[^\s<>'"]+|www\.[^\s<>'"]+|doi:\s*10\.\d{4,9}\/[^\s<>'"]+|10\.\d{4,9}\/[^\s<>'"]+)/gi
        const linkTargets: Array<{ node: Text; m: RegExpExecArray }> = []
        {
          const lw = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
          let ln: Node | null
          while ((ln = lw.nextNode())) {
            const par = (ln as Text).parentElement
            if (par && (par.tagName === 'A' || par.classList.contains('math'))) continue
            const t = ln.textContent ?? ''
            if (t.length < 6 || !/https?:|www\.|doi:|10\.\d{4,9}\//i.test(t)) continue
            urlRe.lastIndex = 0
            let mm: RegExpExecArray | null
            while ((mm = urlRe.exec(t))) linkTargets.push({ node: ln as Text, m: mm })
          }
        }
        for (const { node, m } of linkTargets.reverse()) {
          try {
            let raw = m[0]
            let trail = ''
            while (raw && '.,;:)]}、。，；：）'.includes(raw[raw.length - 1])) {
              trail = raw[raw.length - 1] + trail
              raw = raw.slice(0, -1)
            }
            if (!raw) continue
            const low = raw.toLowerCase()
            const href = low.startsWith('doi:')
              ? 'https://doi.org/' + raw.slice(4).trim()
              : /^10\.\d{4,9}\//.test(raw)
                ? 'https://doi.org/' + raw
                : low.startsWith('www.')
                  ? 'http://' + raw
                  : raw
            const range = doc.createRange()
            range.setStart(node, m.index)
            range.setEnd(node, m.index + m[0].length)
            const a = doc.createElement('a')
            a.className = 'ext-link'
            a.setAttribute('href', href)
            a.setAttribute('target', '_blank')
            a.setAttribute('rel', 'noreferrer noopener')
            a.setAttribute('title', `在浏览器打开：${href}`)
            a.textContent = raw + trail
            range.deleteContents()
            range.insertNode(a)
          } catch {
            /* 跨节点等异常：跳过 */
          }
        }
        const re = /(?:fig(?:ure)?|tab(?:le)?|图|表)\.?\s*(\d+)([a-z])?/gi
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
        const targets: Array<{ node: Text; m: RegExpExecArray }> = []
        let nd: Node | null
        while ((nd = walker.nextNode())) {
          const t = nd.textContent ?? ''
          if (t.length < 3) continue
          re.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = re.exec(t))) targets.push({ node: nd as Text, m })
        }
        for (const { node, m } of targets.reverse()) {
          try {
            const range = doc.createRange()
            range.setStart(node, m.index)
            range.setEnd(node, m.index + m[0].length)
            const span = doc.createElement('span')
            span.className = 'figref'
            span.dataset.n = m[1]
            span.dataset.letter = (m[2] ?? '').toLowerCase()
            span.dataset.kind = /^(tab|表)/i.test(m[0]) ? 'table' : 'figure'
            range.surroundContents(span)
          } catch {
            /* 跨节点等异常：跳过 */
          }
        }
        doc.addEventListener('click', onFigRefClick as unknown as EventListener)
        // 外部链接：给出「点击会打开什么」的提示
        for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
          const href = a.getAttribute('href') || ''
          if (/^https?:/i.test(href)) a.setAttribute('title', `在浏览器打开：${href}`)
        }
        figCleanupRef.current = () => {
          doc.removeEventListener('click', onFigRefClick as unknown as EventListener)
        }
      } catch {
        /* 忽略 */
      }
    },
    [attachmentId, clearFigRefs, onFigRefClick]
  )

  useEffect(() => clearFigRefs, [clearFigRefs])

  // 点击别处关闭图表预览
  useEffect(() => {
    if (!figPop) return
    const onDown = (ev: MouseEvent): void => {
      if ((ev.target as HTMLElement | null)?.closest('.figpop')) return
      setFigPop(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [figPop])

  useEffect(() => {
    let cancelled = false
    setError('')
    setHitTotal(0)
    setHitIndex(0)
    const q = (highlight ?? '').trim()
    const cacheKey = `${translationId}|${kind}|${q}|${theme}`
    const cached = htmlCache.get(cacheKey)
    if (cached) {
      // 命中缓存：同步呈现，避免闪「正在载入网页」
      setHtml(cached)
      return () => {
        cancelled = true
      }
    }
    setHtml('')
    const req =
      kind === 'bilingual'
        ? q.length >= 2
          ? window.api.translate.readBilingualMarked(translationId, q)
          : window.api.translate.readBilingual(translationId)
        : q.length >= 2
          ? window.api.translate.readHtmlMarked(translationId, q)
          : window.api.translate.readHtml(translationId)
    void req
      .then((h) => {
        if (cancelled) return
        const dark = theme === 'dark' && h.includes('</head>')
        const out = dark ? h.replace('</head>', `<style>${DARK_CSS}</style></head>`) : h
        cacheHtml(cacheKey, out)
        setHtml(out)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [translationId, kind, highlight, theme])

  /** 页面载入后统计高亮数量，并把第一个高亮滚到视野中间（或恢复上次滚动位置） */
  const scrollKey = `paperdesk.html.scroll.${translationId}.${kind}`
  const onLoad = useCallback((): void => {
    const f = frameRef.current
    const doc = f?.contentDocument
    if (!f || !doc) return
    // 先移除上一次（同一 iframe 内）挂载的联动监听，再按当前视图决定是否重挂
    clearSync()
    setupFigRefs(doc)
    const marks = doc.querySelectorAll('mark.hit-mark')
    setHitTotal(marks.length)
    if (marks.length > 0) {
      const savedHit = Number(sessionStorage.getItem(`${scrollKey}:hit`) || '0')
      const idx = Math.min(Math.max(0, savedHit), marks.length - 1)
      setHitIndex(idx)
      try {
        marks[idx].scrollIntoView({ block: 'center' })
      } catch {
        /* 忽略 */
      }
    } else {
      setHitIndex(0)
      try {
        const saved = Number(sessionStorage.getItem(scrollKey) || '0')
        if (saved > 0) f.contentWindow?.scrollTo(0, saved)
      } catch {
        /* 忽略 */
      }
    }
    // 记录滚动位置（同一译文/视图再次打开时恢复）
    try {
      f.contentWindow?.addEventListener('scroll', () => {
        try {
          sessionStorage.setItem(scrollKey, String(f.contentWindow?.scrollY || 0))
        } catch {
          /* 忽略 */
        }
      })
    } catch {
      /* 忽略 */
    }
    // 仅对照视图：中英双向「划词/悬停联动高亮」
    if (kind === 'bilingual') {
      try {
        const win = f.contentWindow
        if (!win) return
        // 对照页自带 CSS（无 --hl-find 变量），故用字面量兜底
        if (!doc.getElementById('psync-style')) {
          const st = doc.createElement('style')
          st.id = 'psync-style'
          st.textContent =
            '.psync-hl{background:var(--hl-find,rgba(255,214,102,.55));border-radius:3px}'
          doc.head?.appendChild(st)
        }
        const inPair = (el: Element | null): Element | null => el?.closest('.pair') ?? null
        const counterpart = (el: Element | null): HTMLElement | null => {
          if (!el) return null
          const dst = el.closest('.dst')
          if (dst) return dst.parentElement?.querySelector('.src') ?? null
          const src = el.closest('.src')
          if (src) return src.parentElement?.querySelector('.dst') ?? null
          return null
        }
        let current: HTMLElement | null = null
        const clear = (): void => {
          if (current) current.classList.remove('psync-hl')
          current = null
        }
        const mark = (el: HTMLElement | null): void => {
          clear()
          if (el) {
            el.classList.add('psync-hl')
            current = el
          }
        }
        const onOver = (e: MouseEvent): void => {
          const t = (e.target as Element | null)?.closest('.src, .dst') ?? null
          if (t) mark(counterpart(t))
        }
        const onOut = (e: MouseEvent): void => {
          const t = (e.target as Element | null)?.closest('.src, .dst') ?? null
          if (t) clear()
        }
        const onUp = (): void => {
          const sel = win.getSelection()
          if (!sel || !sel.toString().trim()) return
          const anchor = sel.anchorNode
          const el = anchor ? (anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement) : null
          if (el?.closest('.src, .dst')) mark(counterpart(el))
        }
        const onDown = (e: MouseEvent): void => {
          const t = (e.target as Element | null)?.closest('.src, .dst') ?? null
          // 点击不在当前高亮所在 pair 内 → 清除（保留同 pair 内选择的高亮）
          if (!t || !current || inPair(t) !== current.closest('.pair')) clear()
        }
        doc.addEventListener('mouseover', onOver)
        doc.addEventListener('mouseout', onOut)
        doc.addEventListener('mouseup', onUp)
        doc.addEventListener('mousedown', onDown)
        syncCleanupRef.current = () => {
          doc.removeEventListener('mouseover', onOver)
          doc.removeEventListener('mouseout', onOut)
          doc.removeEventListener('mouseup', onUp)
          doc.removeEventListener('mousedown', onDown)
        }
      } catch {
        /* 忽略（跨域/未就绪） */
      }
    }
  }, [scrollKey, kind, clearSync, setupFigRefs])

  const goto = useCallback(
    (delta: number): void => {
      const doc = frameRef.current?.contentDocument
      if (!doc) return
      const marks = doc.querySelectorAll('mark.hit-mark')
      if (marks.length === 0) return
      const next = (hitIndex + delta + marks.length) % marks.length
      setHitIndex(next)
      try {
        sessionStorage.setItem(`${scrollKey}:hit`, String(next))
      } catch {
        /* 忽略 */
      }
      try {
        marks[next].scrollIntoView({ block: 'center', behavior: 'smooth' })
      } catch {
        /* 忽略 */
      }
    },
    [hitIndex, scrollKey]
  )

  // 键盘导航：F3 下一个命中，Shift+F3 上一个（网页/中英对照均可用）
  useEffect(() => {
    if (hitTotal === 0) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F3') {
        e.preventDefault()
        goto(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [kind, hitTotal, goto])

  const saveSnapshot = useCallback(async (): Promise<void> => {
    try {
      await window.api.translate.saveSnapshot(translationId, highlight.trim(), theme, kind)
    } catch {
      /* 忽略（取消/失败） */
    }
  }, [translationId, highlight, theme, kind])

  if (error) {
    return (
      <div className="empty">
        <Icon name="file" size={26} />
        <span>{error}</span>
      </div>
    )
  }
  if (!html) {
    return (
      <div className="empty">
        <span className="spinner" />
        <span>正在载入网页…</span>
      </div>
    )
  }
  return (
    <div className={`htmlwrap${parseOn ? ' htmlwrap--parse' : ''}`}>
      <div className="htmlfind" data-testid="html-tools">
          <button
            className={`icon ghost${parseOn ? ' is-on' : ''}`}
            title="解析检查：查看结构化块与状态（只读）"
            aria-pressed={parseOn}
            onClick={() => setParseOn((v) => !v)}
            data-testid="parse-check-toggle"
          >
            <Icon name="list" size={14} />
          </button>
          <span className="htmlfind__sep" />
          {hitTotal > 0 && (
            <>
              <span className="meta__muted">
                命中 {hitIndex + 1} / {hitTotal}
              </span>
              <button
                className="icon ghost"
                title="上一个命中（Shift+F3）"
                onClick={() => goto(-1)}
                data-testid="hit-prev"
              >
                <Icon name="chevron-up" size={14} />
              </button>
              <button
                className="icon ghost"
                title="下一个命中（F3）"
                onClick={() => goto(1)}
                data-testid="hit-next"
              >
                <Icon name="chevron-down" size={14} />
              </button>
              <span className="htmlfind__sep" />
            </>
          )}
          <button
            className="icon ghost"
            title="把当前视图（含高亮）另存为 HTML 快照"
            onClick={() => void saveSnapshot()}
            data-testid="snapshot-save"
          >
            <Icon name="upload" size={14} />
          </button>
        </div>
      <iframe
        ref={frameRef}
        className="htmlview"
        data-testid="html-view"
        title="译文网页"
        sandbox="allow-same-origin"
        srcDoc={html}
        onLoad={onLoad}
      />
      {parseOn && (
        <ParseCheckPanel
          blocks={blocks ?? parseBlocks}
          onSelect={handleSelectBlock}
          selectedId={selectedBlock}
          loading={parseLoading}
          error={parseError}
        />
      )}
      {figPop && (
        <div
          className="figpop"
          data-testid="fig-pop-web"
          style={{ left: figPop.left, top: figPop.top }}
        >
          <div className="figpop__bar">
            <span className="figpop__label">{figPop.label}</span>
            <span className="toolbar__spacer" />
            <button
              className="icon ghost"
              title="关闭"
              data-testid="fig-pop-web-close"
              onClick={() => setFigPop(null)}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
          <div className="figpop__body">
            <img
              className="figpop__canvas"
              alt={figPop.label}
              src={`data:image/png;base64,${figPop.png}`}
            />
          </div>
        </div>
      )}
    </div>
  )
}
