import { useCallback, useEffect, useRef, useState } from 'react'
import { PdfViewer } from './PdfViewer'
import { anchorToScrollTop, locateByMid, readScrollPageBoxes } from './scroll-locate'
import type { Rect } from './coords'
import { translationMarkdownToHtml } from '@shared/chat-md'
import { mapSelectionRects } from '@shared/selection-map'
import type { TranslationMap } from '@shared/types'

interface CompareProps {
  attachmentId: number
  translationId: number
  /** 重译页后递增，强制右侧译文重新读盘 */
  reloadKey?: number
  itemId: number | null
  focus: { page: number; annotationKey: string | null; nonce: number } | null
  onAddToNote?: (id: number) => void | Promise<void>
  onTranslateSelection?: (text: string) => void
  onTranslatePage?: (text: string) => void
  onAskSelection?: (text: string, task: 'qa' | 'term') => void
  /** 划词「文件检索」：打开左侧「文献检索」面板并以该词检索 */
  onSearchWorks?: (text: string) => void
  /** 打开「设置」对话框（LaTeX 未配置模型时的直达入口） */
  onOpenSettings?: () => void
  /** 受控页码（公共工具栏驱动；左右两侧共用） */
  page: number
  onPageChange: (p: number) => void
  /** 左侧（原文 PDF）总页数，供公共工具栏页码指示 */
  onNumPages?: (n: number) => void
  /** 受控缩放（公共工具栏驱动） */
  scale: number | null
  onScaleChange?: (s: number, opts?: { fit?: boolean }) => void
  /** 'fit' = 适应宽度 */
  zoomFit: boolean
  /** 递增该计数请求「适应宽度」 */
  onFitRequest?: number
  /** 联动开关（受控）：翻页/划词时同步另一侧 */
  sync: boolean
  onSyncChange: (v: boolean) => void
  /** 公共工具栏驱动的查找（作用于左侧原文 PDF） */
  externalFindQuery?: string
  findNextTick?: number
  findPrevTick?: number
  /** 文库全文命中跳页带入的一次性查找请求（左栏原文） */
  findRequest?: { query: string; page: number; nonce: number } | null
  /** 本视图当前是否为查找属主（只有可见视图能写 document 级高亮） */
  findOwner?: boolean
  onFindStatus?: (count: number, index: number) => void
  onFindQueryChange?: (q: string) => void
}

/**
 * 「对照」视图：左侧 **原文 PDF**（可批注）+ 右侧 **译文 PDF（只读）**。
 * - 页/缩放受控于公共工具栏；开启联动时两侧同页联动。
 * - 划词跨窗高亮：译文为「就地覆盖」，故同一页 + 同一矩形可近似对齐（左侧划词 → 右侧同位置高亮，反之亦然）。
 * - 若更想要「可重排网页译文」，用顶栏的「网页」视图。
 */
export function CompareView({
  attachmentId,
  translationId,
  reloadKey = 0,
  itemId,
  focus,
  onAddToNote,
  onTranslateSelection,
  onTranslatePage,
  onAskSelection,
  onSearchWorks,
  onOpenSettings,
  page,
  onPageChange,
  onNumPages,
  scale,
  onScaleChange,
  zoomFit,
  onFitRequest,
  sync,
  externalFindQuery,
  findNextTick,
  findPrevTick,
  findRequest,
  findOwner = false,
  onFindStatus,
  onFindQueryChange
}: CompareProps): React.JSX.Element {
  const [leftSel, setLeftSel] = useState<{ page: number; rects: Rect[] } | null>(null)
  const [rightSel, setRightSel] = useState<{ page: number; rects: Rect[] } | null>(null)
  // 块级映射：原文选区 → 译文**实际落版**矩形。
  // 没有它时页内重排后只能按原坐标高亮，译文空白处会出现高亮（对阅读无帮助）。
  const [blockMap, setBlockMap] = useState<TranslationMap | null>(null)
  useEffect(() => {
    let cancelled = false
    setBlockMap(null)
    void window.api.translate
      .map(translationId)
      .then((m) => {
        if (!cancelled) setBlockMap(m)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [translationId, reloadKey])

  // 右窗格呈现方式：PDF 版式（默认，保持原行为）/ 结构化文本（按原文段落、列表、标题重排）。
  // 文本面只读译文 md（translate.py::_write_translation_md 产物），不走 map 通道。
  const [rightMode, setRightMode] = useState<'pdf' | 'text'>('pdf')
  const [mdHtml, setMdHtml] = useState<string | null>(null)
  const [mdState, setMdState] = useState<'idle' | 'loading' | 'ready' | 'missing'>('idle')
  const docRef = useRef<HTMLDivElement | null>(null)
  // 结构化文本面的滚动锚点（源页 + 页内比例）：与 PDF 侧同一规则（可互逆往返）。
  // 页码在 md 的页注释 `<!-- 第 N 页 -->` → `.tpage[data-page]` 上，与 PDF 的 data-page 同源。
  const [docScroll, setDocScroll] = useState<{ page: number; frac: number; nonce: number } | null>(null)
  // 文本面程序化滚动落位期间挡住锚点回传（对应 PDF 侧 apply 的 applyingScrollRef）
  const applyingDocRef = useRef(false)
  const docRafRef = useRef(0)
  const lastDocSyncNonceRef = useRef(0)
  const lastDocPageRef = useRef(0)
  // seek 吸附豁免：最近一次**锚点/联动**驱动到的页码（带时间戳）。
  // 页码 prop 变 to 该值时（锚点换算已把文本面带到精确位置）不再吸附到页顶，防来回抖动；
  // 工具栏翻页等外部驱动不受豁免（翻过去了就该跳到该页顶部）。800ms 窗口防止陈旧豁免打断真实翻页。
  const docSeekSkipRef = useRef<{ page: number; ts: number } | null>(null)
  // 文本面段落高亮（对应 PDF 侧滚动的 2s 定位提示）
  const docHlRef = useRef<{ el: HTMLElement; timer: number } | null>(null)
  const clearDocHighlight = useCallback((): void => {
    const cur = docHlRef.current
    if (cur) {
      cur.el.classList.remove('tpage__loc')
      window.clearTimeout(cur.timer)
      docHlRef.current = null
    }
  }, [])

  useEffect(() => {
    if (rightMode !== 'text') return
    let cancelled = false
    setMdState('loading')
    void window.api.translate
      .readMarkdown(translationId, 'translation')
      .then((md) => {
        if (cancelled) return
        setMdHtml(translationMarkdownToHtml(md))
        setMdState('ready')
      })
      .catch(() => {
        if (cancelled) return
        setMdHtml(null)
        setMdState('missing')
      })
    return () => {
      cancelled = true
    }
  }, [rightMode, translationId, reloadKey])

  // 进入文本模式 / 译文刚就绪时重置文本面联动基线：页码以工具栏当前值为准，
  // 避免进入后就发的第一次滚动把「无变化」误报成页码跳变（deps 不含 page）。
  useEffect(() => {
    if (rightMode !== 'text' || mdState !== 'ready') return
    lastDocPageRef.current = page
    docSeekSkipRef.current = null
    clearDocHighlight()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightMode, mdState, mdHtml, clearDocHighlight])

  // 文本面与公共工具栏页码联动：只有「外部」页码变化（工具栏翻页/初始对齐）才吸附到对应页顶。
  // 由锚点/联动驱动而来的页码变化（docSeekSkipRef 刚豁免过）不吸附——锚点已把文本面带到精确位置，
  // 再吸顶会先精确、后被拉回页顶，来回抖动。
  useEffect(() => {
    if (rightMode !== 'text' || mdState !== 'ready') return
    const wrap = docRef.current
    if (!wrap) return
    const skip = docSeekSkipRef.current
    if (skip && skip.page === page && Date.now() - skip.ts < 800) {
      docSeekSkipRef.current = null
      return
    }
    docSeekSkipRef.current = null
    const el = wrap.querySelector<HTMLElement>(`[data-page="${page}"]`)
    if (!el) return
    applyingDocRef.current = true
    wrap.scrollTop = el.offsetTop
    const started = Date.now()
    const settle = (): void => {
      if (Date.now() - started >= 150) {
        applyingDocRef.current = false
        return
      }
      requestAnimationFrame(settle)
    }
    requestAnimationFrame(settle)
  }, [rightMode, mdState, mdHtml, page])

  // 用户手势接管：wheel / 触摸 / 指针（含拖滚动条）即视为文本面主动滚动，
  // 结束程序化落位抑制，防止旧 suppression 吃掉用户滚动后的联动。
  useEffect(() => {
    const wrap = docRef.current
    if (!wrap) return
    const bump = (): void => {
      originRef.current = 'right'
      applyingDocRef.current = false
    }
    wrap.addEventListener('wheel', bump, { passive: true })
    wrap.addEventListener('touchstart', bump, { passive: true })
    wrap.addEventListener('pointerdown', bump, { passive: true })
    return () => {
      wrap.removeEventListener('wheel', bump)
      wrap.removeEventListener('touchstart', bump)
      wrap.removeEventListener('pointerdown', bump)
    }
  }, [rightMode, mdState, mdHtml])

  // 收到文本面锚点 → 滚到对应页对应位置（anchorToScrollTop：页码/frac/落点三级夹取），
  // 并高亮视口中线附近段落约 2s。程序化落位期间不回传锚点（防回声），与 PDF 侧对称。
  useEffect(() => {
    if (!docScroll || docScroll.nonce === lastDocSyncNonceRef.current) return
    lastDocSyncNonceRef.current = docScroll.nonce
    docSeekSkipRef.current = { page: docScroll.page + 1, ts: Date.now() }
    const wrap = docRef.current
    if (!wrap) return
    const boxes = readScrollPageBoxes(wrap, '.tpage')
    if (!boxes.length) return
    const target = anchorToScrollTop({
      page: docScroll.page,
      frac: docScroll.frac,
      boxes,
      viewport: wrap.clientHeight,
      scrollMax: wrap.scrollHeight - wrap.clientHeight
    })
    if (target === null) return
    applyingDocRef.current = true
    wrap.scrollTop = target
    clearDocHighlight()
    const clientMid = wrap.getBoundingClientRect().top + wrap.clientHeight / 2
    const sec = wrap.querySelector<HTMLElement>(`.tpage[data-page="${docScroll.page}"]`)
    let hl: HTMLElement | null = null
    if (sec) {
      let bestDist = Number.POSITIVE_INFINITY
      for (const k of Array.from(sec.children) as HTMLElement[]) {
        const r = k.getBoundingClientRect()
        if (r.height <= 0) continue
        const dist = Math.abs(r.top + r.height / 2 - clientMid)
        if (dist < bestDist) {
          bestDist = dist
          hl = k
        }
      }
    }
    if (hl) {
      hl.classList.add('tpage__loc')
      const timer = window.setTimeout(() => {
        docHlRef.current = null
        hl?.classList.remove('tpage__loc')
      }, 2000)
      docHlRef.current = { el: hl, timer }
    }
    const started = Date.now()
    const settle = (): void => {
      if (Date.now() - started >= 150) {
        applyingDocRef.current = false
        return
      }
      requestAnimationFrame(settle)
    }
    requestAnimationFrame(settle)
  }, [docScroll, clearDocHighlight])

  // 卸载清理：rAF 与高亮定时器不悬挂
  useEffect(() => {
    return () => {
      if (docRafRef.current) cancelAnimationFrame(docRafRef.current)
      clearDocHighlight()
    }
  }, [clearDocHighlight])

  // 「定位原文」：把文本面当前视口中线换算为锚点，主动驱动左侧原文 PDF 跳到对应页与位置。
  const locateOrigin = useCallback((): void => {
    const wrap = docRef.current
    if (!wrap) return
    const boxes = readScrollPageBoxes(wrap, '.tpage')
    if (!boxes.length) return
    const mid = wrap.scrollTop + wrap.clientHeight / 2
    const anchor = locateByMid(mid, boxes)
    originRef.current = 'right'
    setLeftScroll({ page: anchor.page, frac: anchor.frac, nonce: nextNonce() })
  }, [])

  // 两侧页数：不一致说明是旧版译文（文末带「译文补注」页），页面按源页对齐仍可用，
  // 但要明确提示重新翻译，避免用户以为对应关系错了。
  const [leftPages, setLeftPages] = useState(0)
  const [rightPages, setRightPages] = useState(0)
  // 连续滚动同步（**双向**）：任一侧滚动 → 按**源页 + 页内比例**同步另一侧。
  // 不能按全文档比例：两侧页数/页高一旦不同（旧译文带补注页），同一比例会落到不同页。
  // 程序化滚动由 PdfViewer 内部 applyingScrollRef / programmaticRef 挡住，不会互相拉扯。
  const [rightScroll, setRightScroll] = useState<{
    page: number
    frac: number
    nonce: number
  } | null>(null)
  const [leftScroll, setLeftScroll] = useState<{
    page: number
    frac: number
    nonce: number
  } | null>(null)
  const nonceRef = useRef(0)
  const nextNonce = (): number => {
    nonceRef.current += 1
    return nonceRef.current
  }
  // 双向联动的“主动侧”：只有用户真正滚动的一侧才能驱动另一侧，
  // 避免程序化滚动回传造成来回拉扯（旧实现因此只能单向）。
  const originRef = useRef<'left' | 'right'>('left')
  const lastReloadRef = useRef(reloadKey ?? 0)

  // 重译本页后译文 PDF 会重新加载：followOnly 的右侧不会主动跳页，
  // 若不在文档就绪后补一次同步，会停在第 1 页（页码却仍显示第 N 页）。
  useEffect(() => {
    const rk = reloadKey ?? 0
    if (rk === lastReloadRef.current || rightPages <= 0) return
    const t = window.setTimeout(() => {
      lastReloadRef.current = rk
      setRightScroll({ page: page - 1, frac: 0, nonce: nextNonce() })
    }, 120)
    return () => window.clearTimeout(t)
  }, [reloadKey, rightPages, page])

  // 首次进入对照（右栏译文刚就绪）时必须按当前页对齐一次：
  // followOnly 的右栏从不主动跳页，只等左栏发锚点；刚进入时不会有人发，
  // 于是右栏停在译文第 1 页而工具栏已是第 N 页（用户以为对照没同步）。
  const initialAlignedRef = useRef(false)
  useEffect(() => {
    if (rightPages <= 0 || initialAlignedRef.current) return
    const t = window.setTimeout(() => {
      initialAlignedRef.current = true
      setRightScroll({ page: page - 1, frac: 0, nonce: nextNonce() })
    }, 120)
    return () => window.clearTimeout(t)
  }, [rightPages, page])
  const reportedPageRef = useRef<number | null>(null)

  // 联动：任一侧翻页 → 交给上层受控页码，另一侧通过 syncPage 跟随。
  const onLeftPage = useCallback(
    (p: number): void => {
      // 文本模式下右侧译文 PDF 处于隐藏从属态：此时左侧滚动换页必须继续更新工具栏，
      // 否则左栏「滚动翻到下一页」会与工具栏页码脱节。
      const pass =
        originRef.current === 'left' || (originRef.current === 'right' && rightMode === 'text')
      if (!pass) return
      lastDocPageRef.current = p
      reportedPageRef.current = p
      onPageChange(p)
    },
    [onPageChange, rightMode]
  )
  const onRightPage = useCallback(
    (p: number): void => {
      // 译文页数可能与原文不同，但页码就是它当前所在页；由用户滚右侧时反向驱动左侧。
      if (originRef.current !== 'right') return
      reportedPageRef.current = p
      onPageChange(p)
    },
    [onPageChange]
  )

  // 文本面滚动 → 「源页 + 页内比例」锚点驱动左侧原文 PDF（rAF 节流 + 程序化落位期间静默）。
  // 页码变化跟随：与译文 PDF 侧的滚动换页同语义（mid 中心线判页后上报 +1 页码）。
  const onDocScroll = useCallback((): void => {
    const wrap = docRef.current
    if (!wrap || applyingDocRef.current || docRafRef.current) return
    docRafRef.current = requestAnimationFrame(() => {
      docRafRef.current = 0
      const c = docRef.current
      if (!c || applyingDocRef.current) return
      const boxes = readScrollPageBoxes(c, '.tpage')
      if (!boxes.length) return
      const mid = c.scrollTop + c.clientHeight / 2
      const anchor = locateByMid(mid, boxes)
      if (sync && originRef.current === 'right') {
        setLeftScroll({ page: anchor.page, frac: anchor.frac, nonce: nextNonce() })
      }
      const cur = anchor.page + 1
      if (lastDocPageRef.current !== cur) {
        lastDocPageRef.current = cur
        docSeekSkipRef.current = { page: cur, ts: Date.now() }
        onRightPage(cur)
      }
    })
  }, [sync, onRightPage])

  // 文本面滚动监听：随文本面重建（模式切换 / md 重读）重挂
  useEffect(() => {
    const wrap = docRef.current
    if (!wrap) return
    wrap.addEventListener('scroll', onDocScroll, { passive: true })
    return () => wrap.removeEventListener('scroll', onDocScroll)
  }, [onDocScroll, rightMode, mdState, mdHtml])

  const onLeftScroll = useCallback(
    (a: { page: number; frac: number }): void => {
      if (sync && originRef.current === 'left') {
        // 文本模式下右侧译文 PDF 隐藏：锚点改投文本面（同一 anchor 语义，可互逆）。
        if (rightMode === 'text') {
          setDocScroll({ page: a.page, frac: a.frac, nonce: nextNonce() })
          docSeekSkipRef.current = { page: a.page + 1, ts: Date.now() }
        } else {
          setRightScroll({ page: a.page, frac: a.frac, nonce: nextNonce() })
        }
      }
    },
    [sync, rightMode]
  )

  /** 译文侧反向驱动原文：仅当用户最近在译文侧主动滚动时生效。 */
  const onRightScroll = useCallback(
    (a: { page: number; frac: number }): void => {
      if (sync && originRef.current === 'right') {
        setLeftScroll({ page: a.page, frac: a.frac, nonce: nextNonce() })
      }
    },
    [sync]
  )

  // 工具栏翻页（受控 page 变化）：左侧 PDF 是**程序化**跳页，PdfViewer 在 programmatic 期间
  // 故意不上报滚动锚点，于是译文侧不会跟随（E2E「中英对照：连续滚动同步」曾因此失败）。
  // 这里按受控页码补发一次锚点——页码 prop 是 1 基，锚点里的 page 是 0 基（与 data-page 一致）。
  const lastSyncPageRef = useRef(page)
  useEffect(() => {
    if (lastSyncPageRef.current === page) return
    lastSyncPageRef.current = page
    if (reportedPageRef.current === page) { reportedPageRef.current = null; return }
    if (!sync || page < 1) return
    originRef.current = 'left'
    const anchorPage = page - 1
    // 末页的页首位置常被 scrollTop 上界夹住：此时用 frac 1（对齐到页底）才能让两侧视口中线一致
    const frac = leftPages > 0 && page >= leftPages ? 1 : 0
    setLeftScroll({ page: anchorPage, frac, nonce: nextNonce() })
    if (rightMode === 'text') {
      setDocScroll({ page: anchorPage, frac, nonce: nextNonce() })
      docSeekSkipRef.current = { page, ts: Date.now() }
    } else {
      setRightScroll({ page: anchorPage, frac, nonce: nextNonce() })
    }
  }, [page, sync, rightMode, leftPages])

  /**
   * 选区跨窗映射：用块级映射把「原文选区」换成译文**实际落版区域**。
   * 之前是按同页同矩形叠高亮——页内重排/压缩后就会落在空白处。
   * 具体打分逻辑是纯函数（`@shared/selection-map`，可单测）：块级 recall 选块 +
   * 句级行片段命中（选区落在句内 / 句被选区覆盖）选句；映射不到时**不整块兜底**。
   */
  const mapSelection = useCallback(
    (sel: { page: number; rects: Rect[] } | null, dir: 'src2dst' | 'dst2src') =>
      mapSelectionRects(blockMap, sel, dir),
    [blockMap]
  )

  return (
    <div className="compare-view" data-testid="compare-view">
      {leftPages > 0 && rightPages > 0 && leftPages !== rightPages ? (
        <div className="compare__warn" data-testid="compare-page-mismatch">
          译文 {rightPages} 页 / 原文 {leftPages} 页：这是旧版译文（文末带「译文补注」页）。
          页面对应仍按源页对齐，但建议重新翻译以恢复 1:1 页码。
        </div>
      ) : null}
      {blockMap == null && <div className="compare__warn">此译文尚无可靠的选区对应信息，暂不显示另一侧标记；重译后可更新对应关系。</div>}
      <div className="compare__body">
        <div className="compare__pane" data-testid="compare-pane-original">
          <div className="compare__bar">原文 PDF（可批注）</div>
          <PdfViewer
            attachmentId={attachmentId}
            translationId={null}
            itemId={itemId}
            focus={focus}
            onAddToNote={onAddToNote}
            onTranslateSelection={onTranslateSelection}
            onTranslatePage={onTranslatePage}
            onAskSelection={onAskSelection}
            onSearchWorks={onSearchWorks}
            onOpenSettings={onOpenSettings}
            onSelectionRects={(s) => setLeftSel(mapSelection(s, 'src2dst'))}
            syncRects={rightSel}
            onPageChangeExternal={onLeftPage}
            onNumPages={(n) => {
              setLeftPages(n)
              onNumPages?.(n)
            }}
            syncPage={page}
            initialPage={page}
            scale={scale}
            onScaleChange={onScaleChange}
            zoomMode={zoomFit ? 'fit' : 'custom'}
            onFitRequest={onFitRequest}
            hideToolbar
            externalFindQuery={externalFindQuery}
            findNextTick={findNextTick}
            findPrevTick={findPrevTick}
            findRequest={findRequest}
            findOwner={findOwner}
            onFindStatus={onFindStatus}
            onFindQueryChange={onFindQueryChange}
            onScrollAnchor={onLeftScroll}
            onUserScroll={() => {
              originRef.current = 'left'
            }}
            syncAnchor={leftScroll}
          />
        </div>
        <div className="compare__pane" data-testid="compare-pane-translation">
          <div className="compare__bar">
            <span className="compare__bar-label">
              {rightMode === 'pdf' ? '译文 PDF（可批注）' : '译文（结构化文本）'}
            </span>
            {translationId > 0 ? (
              <div className="seg compare__mode" role="group" aria-label="译文呈现方式">
                <button
                  type="button"
                  className={rightMode === 'pdf' ? 'on' : ''}
                  data-testid="compare-right-mode-pdf"
                  onClick={() => setRightMode('pdf')}
                  title="按原版式显示译文 PDF"
                >
                  PDF 版式
                </button>
                <button
                  type="button"
                  className={rightMode === 'text' ? 'on' : ''}
                  data-testid="compare-right-mode-text"
                  onClick={() => setRightMode('text')}
                  title="按原文段落、列表与标题重排译文（保留公式与引用）"
                >
                  结构化文本
                </button>
              </div>
            ) : null}
          </div>
          {/* PDF 面保持挂载（文本模式下 display:none）：切回来不丢分页/滚动状态 */}
          <div
            className="compare__pdfwrap"
            data-testid="compare-translation-pdf"
            style={rightMode === 'text' ? { display: 'none' } : undefined}
          >
            <PdfViewer
              attachmentId={attachmentId}
              translationId={translationId}
              reloadKey={reloadKey}
              itemId={itemId}
              onAddToNote={onAddToNote}
              onAskSelection={onAskSelection}
              onOpenSettings={onOpenSettings}
              focus={focus}
              onSelectionRects={(s) => setRightSel(mapSelection(s, 'dst2src'))}
              syncRects={leftSel}
              onPageChangeExternal={onRightPage}
              onNumPages={setRightPages}
              syncPage={null}
              initialPage={page}
              scale={scale}
              onScaleChange={onScaleChange}
              zoomMode={zoomFit ? 'fit' : 'custom'}
              onFitRequest={onFitRequest}
              hideToolbar
              findOwner={false}
              syncAnchor={rightScroll}
              onScrollAnchor={onRightScroll}
              onUserScroll={() => {
                originRef.current = 'right'
              }}
              followOnly
            />
          </div>
          {rightMode === 'text' ? (
            <div className="compare__docwrap">
              <div className="compare__doc" ref={docRef} data-testid="compare-translation-doc">
                {mdState === 'ready' && mdHtml ? (
                  <div
                    className="compare__doc-body"
                    data-testid="compare-translation-doc-body"
                    dangerouslySetInnerHTML={{ __html: mdHtml }}
                  />
                ) : mdState === 'missing' ? (
                  <div className="compare__doc-empty" data-testid="compare-translation-doc-missing">
                    该译文还没有 Markdown 版本。重新翻译后即可在此查看按原文段落、列表与标题重排的译文。
                  </div>
                ) : (
                  <div className="compare__doc-empty">正在读取译文…</div>
                )}
              </div>
              {mdState === 'ready' ? (
                <button
                  type="button"
                  className="compare__locate"
                  data-testid="compare-locate-origin"
                  title="把左侧原文 PDF 定位到当前正在读的位置"
                  onClick={locateOrigin}
                >
                  定位原文
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
