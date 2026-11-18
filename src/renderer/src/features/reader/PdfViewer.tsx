import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { pdfjsLib } from '../../lib/pdf'
import { clientRectsToPdfRects, pdfRectToViewportRect, type Rect } from './coords'
import { normalizeSelectionText } from './selection-text'
import { halfPageScrollTop, locateByMid, readScrollPageBoxes, scrollEdgeFlags } from './scroll-locate'
import { figureCropRegion, parseRefNums } from '@shared/figref'
import { pickCaptionModule, pickRefModules, type FormulaModule, type Rect4, type StructuredDoc } from '@shared/modules'
import type { FormulaValidation } from '@shared/formula-validate'
import { pickCandidate } from '@shared/formula-ocr'
import { seedFindQuery } from '@shared/find-request'
import { Icon } from '../../components/Icon'
import type { Annotation, AnnotationPosition, AnnotationType } from '@shared/types'
import type { StructuredBlock } from '@shared/blocks'
import { clampRect, pageMatches, toCssRect, hitBlockAt } from './block-overlay'
import { highlightColorValues, resolveHighlight } from '@shared/annotation-colors'
import { PageEditDialog } from './PageEditDialog'

/** 联动诊断：记录最近几次「发送/应用」的锚点（只在 window 上留十几条，便于排查页面对应） */
function pushSyncDebug(kind: 'send' | 'apply', a: { page: number; frac: number }): void {
  const w = window as unknown as { __syncDebug?: { send: unknown[]; apply: unknown[] } }
  if (!w.__syncDebug) w.__syncDebug = { send: [], apply: [] }
  const arr = w.__syncDebug[kind]
  arr.push({ page: a.page, frac: Math.round(a.frac * 100) / 100, t: Date.now() })
  if (arr.length > 12) arr.shift()
}

interface Props {
  attachmentId: number
  /** 非空表示正在查看译文（只读：不加载/不显示批注） */
  translationId: number | null
  /** 译文重译后递增，强制重新读取 PDF（不清空原视图状态） */
  reloadKey?: number
  /** 页面删除/恢复后通知外层重新加载（页数已变） */
  onPagesEdited?: () => void
  itemId: number | null
  /** 深链定位：跳到某页并高亮某条批注 */
  focus: {
    page: number
    annotationKey: string | null
    nonce: number
    /** 引用命中的模块矩形（底边原点）：跳页后高亮该区域 */
    rect?: [number, number, number, number] | null
  } | null
  onAddToNote?: (annotationId: number) => void | Promise<void>
  /** 划词翻译：用户点「翻译选中」后才回调（不自动翻译） */
  /** 划词翻译：带上页码（1 起），供「翻译上面这段」等后续追问定位原文 */
  onTranslateSelection?: (text: string, page: number) => void
  /** 部分翻译：翻译当前页文本 */
  onTranslatePage?: (text: string) => void
  /** 划词后直接向 AI 提问 / 名词解释（带页码，1 起） */
  onAskSelection?: (text: string, task: 'qa' | 'term', page: number) => void
  /** 划词「文件检索」：打开左侧「文献检索」面板并以该词检索 */
  onSearchWorks?: (text: string) => void
  /** 打开「设置」对话框（LaTeX 未配置模型时的直达入口） */
  onOpenSettings?: () => void
  /** 受控页码（并排对照用）：非空且与内部页不同时跳转到该页 */
  syncPage?: number | null
  /** 内部页码变化时回调（并排对照用） */
  onPageChangeExternal?: (p: number) => void
  /** 划词选中后回传「页码 + PDF 矩形」；清空选择时回传 null（跨窗联动高亮） */
  onSelectionRects?: (v: { page: number; rects: Rect[] } | null) => void
  /** 外部传入的联动高亮矩形（只读叠加层）：按页 + 矩形近似定位 */
  syncRects?: { page: number; rects: Rect[] } | null
  /** 文档加载后回调总页数（对照视图合并工具栏的页码指示用） */
  onNumPages?: (n: number) => void
  /** 隐藏顶部工具栏条（对照视图合并工具栏时用；不影响滚动渲染与 Ctrl+滚轮缩放） */
  hideToolbar?: boolean
  /** 外部受控缩放（1.0 = 100%）：非空时视图跟随该比例（zoomMode='fit' 时让位给适应宽度） */
  scale?: number | null
  /** 有效缩放变化时回调（按钮 / Ctrl+滚轮 / 适应宽度），供外部公共工具栏显示
   *  opts.fit=true 表示该值是「适应宽度」计算所得（非用户手势），外部据此保持适应状态 */
  onScaleChange?: (scale: number, opts?: { fit?: boolean }) => void
  /** 递增该计数以请求「适应宽度」（命令式触发） */
  onFitRequest?: number
  /** 'fit' = 适应宽度；'custom' = 使用 scale；空则沿用内部行为 */
  zoomMode?: 'custom' | 'fit' | null
  /** 切换文档（sourceKey）时恢复的页码（缺省回第 1 页） */
  initialPage?: number | null
  /** 切换文档（sourceKey）时恢复的缩放比例（缺省沿用「适应宽度」） */
  initialScale?: number | null
  /** 外部查找词（公共工具栏驱动）；变化时同步到内部查找框 */
  externalFindQuery?: string
  /** 递增计数 → 跳下一处命中 */
  findNextTick?: number
  /** 递增计数 → 跳上一处命中 */
  findPrevTick?: number
  /** 查找命中数 / 当前序号回调（公共工具栏显示） */
  onFindStatus?: (count: number, index: number) => void
  /** 内部查找词变化回传（如「查找选中」），供公共工具栏同步输入框 */
  onFindQueryChange?: (q: string) => void
  /** 文库全文命中跳页的一次性请求：把命中词带入查找框，并优先定位到 page（1 基） */
  findRequest?: { query: string; page: number; nonce: number } | null
  /** 是否为当前查找属主（可见视图）。document 级 CSS.highlights 是全局的，非属主不得覆盖 */
  findOwner?: boolean
  /** 滚动锚点：**源页 index（0 基）+ 页内比例**。对照阅读按源页对齐，不能用全文档比例 */
  onScrollAnchor?: (a: { page: number; frac: number }) => void
  /** 用户主动滚动（滚轮/拖动/触摸）的通知，用于双向对照时判定联动方向 */
  onUserScroll?: () => void
  /** 外部锚点（带 nonce，仅 nonce 变化时应用） */
  syncAnchor?: { page: number; frac: number; nonce: number } | null
  /** 只跟随（译文侧）：不做内部页码检测与跳页，仅通过 syncAnchor 跟随另一侧 */
  followOnly?: boolean
  /** 每页的矢量图形区域（用于精确裁剪图表预览） */
  figureRegions?: Array<{ page: number; rects: number[][] }>
  /** 解析检查选中的结构化块（含 sourceRegion）：存在时在匹配页上画块区域高亮遮罩 */
  selectedBlock?: StructuredBlock | null
  /** 结构化块列表（解析检查面板同源数据）：页面点选命中用；缺省时关闭点选 */
  blocks?: readonly StructuredBlock[] | null
  /** 页面点选命中块后回调（反向联动）：上报命中最小包含块的 stableId */
  onBlockPicked?: (stableId: string) => void
}

const COLORS = highlightColorValues()
const NOTE_COLOR = '#ffd400'

/**
 * 已解析 PDF 文档的会话级缓存。
 *
 * 目的：切换 原文/译文/对照/网页 时不再重复「读盘 + pdf.js 解析」，
 * 消除每次切视图都会闪现的「正在载入…」空白（对照要同时加载两份 PDF，最明显）。
 *
 * 安全性：
 * - 译文每次（重新）翻译都会**新建一行**（旧行标 superseded），故 `t:<id>` 不会指向被覆盖的旧文件；
 *   原文附件不可变；因此按 sourceKey 缓存不会读到过期内容。
 * - 引用计数：仅当 refs===0（无任何视图在用）时才可能被 LRU 淘汰并 destroy，
 *   绝不销毁仍在使用中的文档（避免历史黑屏问题）。
 */
interface DocEntry {
  promise: Promise<PDFDocumentProxy>
  doc: PDFDocumentProxy | null
  refs: number
  last: number
  destroy: (() => void) | null
}
const docCache = new Map<string, DocEntry>()
const DOC_CACHE_MAX = 2

function evictDocs(): void {
  if (docCache.size <= DOC_CACHE_MAX) return
  const idle = [...docCache.entries()]
    .filter(([, e]) => e.refs === 0)
    .sort((a, b) => a[1].last - b[1].last)
  for (const [k, e] of idle) {
    if (docCache.size <= DOC_CACHE_MAX) break
    docCache.delete(k)
    try {
      e.destroy?.()
    } catch {
      /* 忽略销毁失败 */
    }
  }
}

function acquireDoc(
  key: string,
  load: () => Promise<{ doc: PDFDocumentProxy; destroy: () => void }>
): Promise<PDFDocumentProxy> {
  const hit = docCache.get(key)
  if (hit) {
    hit.refs++
    hit.last = Date.now()
    return hit.promise
  }
  const entry: DocEntry = {
    promise: Promise.resolve(null as unknown as PDFDocumentProxy),
    doc: null,
    refs: 1,
    last: Date.now(),
    destroy: null
  }
  entry.promise = load()
    .then((r) => {
      entry.doc = r.doc
      entry.destroy = r.destroy
      if (!docCache.has(key)) r.destroy()
      return r.doc
    })
    .catch((e: unknown) => {
      if (docCache.get(key) === entry) docCache.delete(key)
      throw e
    })
  docCache.set(key, entry)
  evictDocs()
  return entry.promise
}

function releaseDoc(key: string): void {
  const hit = docCache.get(key)
  if (!hit) return
  hit.refs = Math.max(0, hit.refs - 1)
  hit.last = Date.now()
  evictDocs()
}

let preloadedTranslationKey: string | null = null

/**
 * 预解析译文 PDF（只保留最近一份）：翻译完成/拿到译文时后台读盘 + pdf.js 解析。
 * 译文内嵌 CJK 字体，首次打开「中英对照」通常比原文更慢；预解析后切视图可立即出页。
 * 注意：预加载会占用一个 ref，避免刚解析完就被 LRU 淘汰；切换到另一份译文时释放上一份。
 */
export function preloadTranslationDoc(translationId: number, reloadKey = 0): void {
  if (!Number.isFinite(translationId) || translationId <= 0) return
  const key = `t:${translationId}${reloadKey ? `:${reloadKey}` : ''}`
  if (preloadedTranslationKey === key) return
  const prev = preloadedTranslationKey
  preloadedTranslationKey = key
  acquireDoc(key, async () => {
    const bytes = await window.api.translate.read(translationId)
    const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) })
    const doc = await task.promise
    return { doc, destroy: () => void task.destroy() }
  }).catch(() => {
    if (preloadedTranslationKey === key) preloadedTranslationKey = null
  })
  if (prev && prev !== key) releaseDoc(prev)
}


interface SelectionInfo {
  pageIndex: number
  x: number
  y: number
  rects: Rect[]
  text: string
  prefix: string | null
  suffix: string | null
}

const TYPE_LABEL: Record<string, string> = {
  highlight: '高亮',
  underline: '下划线',
  note: '批注'
}

export function PdfViewer({
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
  syncPage,
  onPageChangeExternal,
  onSelectionRects,
  syncRects,
  onNumPages,
  hideToolbar,
  scale,
  onScaleChange,
  onFitRequest,
  zoomMode,
  initialPage,
  initialScale,
  externalFindQuery,
  findNextTick,
  findPrevTick,
  onFindStatus,
  onFindQueryChange,
  findRequest,
  findOwner = true,
  onScrollAnchor,
  onUserScroll,
  syncAnchor,
  followOnly,
  selectedBlock,
  blocks,
  onBlockPicked,
  onPagesEdited
}: Props): React.JSX.Element {
  // 页面管理（删除页 + 版本恢复）：弹窗打开时才加载缩略图
  const [pagesOpen, setPagesOpen] = useState(false)
  const readOnly = translationId != null
  const sourceKey =
    translationId != null
      ? `t:${translationId}${reloadKey ? `:${reloadKey}` : ''}`
      : `a:${attachmentId}`
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)

  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(1)
  // liveScale：手势/按钮即时反馈；renderScale：实际用于渲染（防抖提交）
  const [liveScale, setLiveScale] = useState(1.3)
  const [renderScale, setRenderScale] = useState(1.3)
  const [autoFit, setAutoFit] = useState(true)
  const [fitDisplay, setFitDisplay] = useState(1)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  /** 选区浮层：跟随实际选区（滚动/缩放后重新计算），离开视口时隐藏 */
  const selectionAnchorRef = useRef<
    ((page: number, rects: Rect[]) => { x: number; y: number } | null) | null
  >(null)
  const [popupPos, setPopupPos] = useState<{ left: number; top: number } | null>(null)
  const [popupVisible, setPopupVisible] = useState(false)
  const popupRef = useRef<HTMLDivElement | null>(null)
  // 浮层实测修正：动作按钮多时浮层比预设高度更高，只靠常量会在窗口底部溢出，
  // 表现为「问 AI / 名词解释 / 查找 / 保存批注」被窗口下沿挡住、鼠标点不到。
  const [popupNudge, setPopupNudge] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 })
  const [noteText, setNoteText] = useState('')
  const [activeAnn, setActiveAnn] = useState<{ ann: Annotation; x: number; y: number } | null>(null)
  const [pageInput, setPageInput] = useState('')
  // 查找框初值：文库全文命中带入的词优先（见 seedFindQuery），其次父级已同步的查找词。
  // 挂载即带入是必须的（命中行打开「尚未打开」的文档时 PdfViewer 是新建的）：否则挂载首帧
  // 回传 '' 会把父级 openHit 刚设置的命中词打回空，待定位请求随之被「已改词」判定丢弃，
  // 结果是查找框空、命中计数 0、页面无高亮。
  const seededFindQueryRef = useRef<string>(seedFindQuery(findRequest, externalFindQuery))
  const [findQuery, setFindQuery] = useState<string>(seededFindQueryRef.current)
  const [findCount, setFindCount] = useState(0)
  const [findIdx, setFindIdx] = useState(-1)
  // 只记录「命中的文字范围」（Range），不整段染色
  const findHitsRef = useRef<{ range: Range; el: HTMLElement }[]>([])
  /** 全文命中带入、等待目标页文本层就绪后重放的查找（page 为 1 基） */
  const pendingFindRef = useRef<{ query: string; page: number; nonce: number } | null>(null)
  const lastFindReqNonceRef = useRef(0)

  // 公共工具栏驱动的查找：回调始终引用最新值
  const onFindStatusRef = useRef(onFindStatus)
  useEffect(() => {
    onFindStatusRef.current = onFindStatus
  }, [onFindStatus])
  const lastFindTickRef = useRef(0)
  const lastFindPrevTickRef = useRef(0)
  const onFindQueryChangeRef = useRef(onFindQueryChange)
  useEffect(() => {
    onFindQueryChangeRef.current = onFindQueryChange
  }, [onFindQueryChange])

  // 跨窗联动高亮：始终引用最新的回调，避免 setSelection 各处调用时依赖不稳定
  const onSelectionRectsRef = useRef(onSelectionRects)
  useEffect(() => {
    onSelectionRectsRef.current = onSelectionRects
  }, [onSelectionRects])

  // 文档总页数回调：用 ref 持有以避免把 onNumPages 加入加载依赖导致重复加载
  const onNumPagesRef = useRef(onNumPages)
  useEffect(() => {
    onNumPagesRef.current = onNumPages
  }, [onNumPages])

  // 缩放回调：用 ref 持有，避免加入渲染依赖
  const onScaleChangeRef = useRef(onScaleChange)
  useEffect(() => {
    onScaleChangeRef.current = onScaleChange
  }, [onScaleChange])

  // 反馈环防护：
  // - pendingEmitRef：只有「源自视图内部」的变化（按钮/Ctrl+滚轮/适应宽度）才置位 → 才会回调外部
  // - applyingExternalRef：正在应用外部 scale 期间不回调
  // - lastEmittedScaleRef：与上次已发出的值比较，避免重复回调
  const pendingEmitRef = useRef(false)
  const applyingExternalRef = useRef(false)
  const lastEmittedScaleRef = useRef<number | null>(null)

  const emitScale = useCallback((s: number, fit?: boolean): void => {
    const rounded = +s.toFixed(3)
    if (
      lastEmittedScaleRef.current != null &&
      Math.abs(lastEmittedScaleRef.current - rounded) < 0.001
    ) {
      return
    }
    lastEmittedScaleRef.current = rounded
    onScaleChangeRef.current?.(rounded, { fit })
  }, [])

  // 上一次的「适应宽度」请求计数（用于识别父级递增）
  const lastFitReqRef = useRef<number | undefined>(onFitRequest)

  // autoFit 的最新值（供「仅响应 zoomMode 切换」的 effect 读取，避免与手势缩放打架）
  const autoFitRef = useRef(autoFit)
  useEffect(() => {
    autoFitRef.current = autoFit
  }, [autoFit])

  // 即时缩放反馈：内部 DOM 引用（.scrollpages__inner）+ 状态镜像 + rAF 合并。
  // 手势/按钮缩放时直接写 CSS transform，不必等 React 提交 → 反馈零延迟；
  // React 渲染随后会用同一公式覆盖，二者一致，不会打架。
  const innerRef = useRef<HTMLDivElement | null>(null)
  const liveScaleRef = useRef(liveScale)
  const renderScaleRef = useRef(renderScale)
  const fitDisplayRef = useRef(fitDisplay)
  // 缩放手势的锚点（像素级：以「内容点」的百分比表示，跨清晰重渲染仍指向同一内容）
  const zoomOriginRef = useRef<{ x: number; y: number } | null>(null)
  const [zoomOrigin, setZoomOrigin] = useState<{ x: number; y: number } | null>(null)
  // 最近一次「本视图内部」缩放（手势/按钮）的时间戳：用于忽略父级滞后回灌的受控 scale
  const gestureAtRef = useRef(0)
  useEffect(() => {
    liveScaleRef.current = liveScale
  }, [liveScale])
  useEffect(() => {
    renderScaleRef.current = renderScale
  }, [renderScale])
  useEffect(() => {
    fitDisplayRef.current = fitDisplay
  }, [fitDisplay])

  const liveTransformPendingRef = useRef(false)
  /** 把「即时比例」+「锚点」立即写成 CSS transform（rAF 合并，避免一帧内多次写） */
  const applyLiveTransform = useCallback((): void => {
    if (liveTransformPendingRef.current) return
    liveTransformPendingRef.current = true
    requestAnimationFrame(() => {
      liveTransformPendingRef.current = false
      const el = innerRef.current
      if (!el) return
      const render = renderScaleRef.current
      const live = liveScaleRef.current
      const k = render > 0 ? Math.max(0.2, Math.min(5, live / render)) : 1
      el.style.transform = `scale(${k})`
      const o = zoomOriginRef.current
      // 百分比锚点：布局尺寸随 DPR/比例变化时仍锁定同一「内容点」（无跳变）
      el.style.transformOrigin = o ? `${o.x * 100}% ${o.y * 100}%` : 'top center'
    })
  }, [])

  /** 计算手势锚点（相对内容框的 0..1 比例）。未给坐标（按钮缩放）时取可视区中心。 */
  const computeFocal = useCallback((clientX?: number, clientY?: number): void => {
    const el = innerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    let cx = clientX
    let cy = clientY
    if (cx == null || cy == null) {
      const cr = scrollRef.current?.getBoundingClientRect()
      cx = cr ? cr.left + cr.width / 2 : r.left + r.width / 2
      cy = cr ? cr.top + cr.height / 2 : r.top + r.height / 2
    }
    const o = {
      x: Math.max(0, Math.min(1, (cx - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (cy - r.top) / r.height))
    }
    zoomOriginRef.current = o
    setZoomOrigin(o)
  }, [])

  /** 若当前处于「适应宽度」，切到手势/按钮缩放前先把 fit 值种进 renderScale，
   *  并以它为基准，避免跳到陈旧的 liveScale/renderScale（表现为一次突兀跳动）。返回缩放基准值。 */
  const beginZoomFromFit = useCallback((): number => {
    if (!autoFitRef.current) return liveScaleRef.current
    const f = fitDisplayRef.current
    renderScaleRef.current = f
    setAutoFit(false)
    setRenderScale(f)
    return f
  }, [])

  /** 提交一次「即时比例」：先写 DOM（即时反馈 + 锚点）再更新状态（触发防抖清晰重渲染）
   *  focal：手势事件的指针坐标（客户端坐标）；缺省则以可视区中心为锚点 */
  const commitZoom = useCallback(
    (next: number, focal?: { x: number; y: number }): void => {
      gestureAtRef.current = performance.now()
      computeFocal(focal?.x, focal?.y)
      liveScaleRef.current = next
      applyLiveTransform()
      setLiveScale(next)
    },
    [applyLiveTransform, computeFocal]
  )

  /** 退出缩放锚点（回到「适应宽度」时清掉，避免遗留的百分比原点影响居中） */
  const clearZoomOrigin = useCallback((): void => {
    zoomOriginRef.current = null
    setZoomOrigin(null)
  }, [])

  /** 适应宽度计算完成：记录为内部变化并更新显示值（触发 onScaleChange） */
  const handleFitScale = useCallback((s: number): void => {
    pendingEmitRef.current = true
    fitDisplayRef.current = s
    setFitDisplay(s)
  }, [])

  /** 同步设置/清空内部选择，并把「页码 + 矩形」回传给外部（跨窗联动） */
  const setSelectionSynced = useCallback((s: SelectionInfo | null): void => {
    setSelection(s)
    setPopupVisible(!!s)
    if (!s) setPopupPos(null)
    onSelectionRectsRef.current?.(s ? { page: s.pageIndex + 1, rects: s.rects } : null)
  }, [])

  // CSS Custom Highlight API（Chromium 105+）：只给命中范围上色，不改 DOM
  // 选区浮层跟随：滚动（容器/窗口）、缩放、尺寸变化时按选区矩形重算位置；
  // 选区离开视口就隐藏，避免工具栏停在无关位置。
  useEffect(() => {
    if (!selection) {
      setPopupVisible(false)
      return
    }
    const inner = innerRef.current
    const c = inner?.parentElement
    if (!inner || !c) {
      setPopupPos({ left: selection.x, top: selection.y + 6 })
      return
    }
    let raf = 0
    const update = (): void => {
      raf = 0
      const a = selectionAnchorRef.current?.(selection.pageIndex, selection.rects)
      if (!a) {
        // 页/视口还没准备好（首次选中、虚拟化重建）：保留鼠标位置，不要因此隐藏
        setPopupPos({ left: selection.x, top: selection.y + 6 })
        setPopupVisible(true)
        return
      }
      const cr = c.getBoundingClientRect()
      const x = cr.left + a.x
      const y = cr.top + a.y
      // a.y 是选区相对滚动容器的坐标：只有选区真正离开视口（留 120px 余量）才隐藏，
      // 避免首次布局/缩放瞬间误判，同时不要停在被滚走的旧位置。
      const visible = a.y > -120 && a.y < c.clientHeight + 120
      setPopupVisible(visible)
      if (visible) {
        const popupH = 230
        let top = y + 6
        if (top + popupH > window.innerHeight - 8) top = Math.max(8, y - popupH - 6)
        setPopupPos({
          left: Math.max(8, Math.min(x - 40, window.innerWidth - 330)),
          top
        })
      }
    }
    const onMove = (): void => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    c.addEventListener('scroll', onMove, { passive: true })
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, { passive: true })
    update()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      c.removeEventListener('scroll', onMove)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove)
    }
  }, [selection])

  // 浮层必须落在窗口内：按实测尺寸把溢出的部分推回可视区（选区在页面底部时尤其明显）。
  // 用 layout effect 在绘制前修正，避免用户看到「先溢出、再跳回来」的闪动。
  useLayoutEffect(() => {
    if (!popupVisible || !selection) {
      setPopupNudge((prev) => (prev.dx === 0 && prev.dy === 0 ? prev : { dx: 0, dy: 0 }))
      return
    }
    const el = popupRef.current
    if (!el) return
    const margin = 8
    const rect = el.getBoundingClientRect()
    let delta = 0
    let dx = 0
    const overflowBottom = rect.bottom - (window.innerHeight - margin)
    if (overflowBottom > 0) delta = -overflowBottom
    if (rect.top + delta < margin) delta = margin - rect.top
    const overflowRight = rect.right - (window.innerWidth - margin)
    if (overflowRight > 0) dx = -overflowRight
    if (rect.left + dx < margin) dx = margin - rect.left
    if (delta === 0 && dx === 0) return
    setPopupNudge((prev) => ({ dx: prev.dx + dx, dy: prev.dy + delta }))
  }, [popupVisible, selection, popupPos])

  const hlRegistry = (CSS as unknown as { highlights?: { set(k: string, h: unknown): void; delete(k: string): void } })
    .highlights
  const HighlightCtor = (
    globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }
  ).Highlight
  const canHighlight = !!hlRegistry && !!HighlightCtor
  const HL_ALL = 'paperdesk-find'
  const HL_CUR = 'paperdesk-find-cur'

  const clearFind = useCallback((): void => {
    if (hlRegistry) {
      try {
        hlRegistry.delete(HL_ALL)
        hlRegistry.delete(HL_CUR)
      } catch {
        /* 忽略 */
      }
    }
    scrollRef.current?.querySelectorAll('.find-hit, .find-hit--cur').forEach((el) => {
      el.classList.remove('find-hit', 'find-hit--cur')
    })
  }, [hlRegistry])

  const focusHit = useCallback(
    (i: number, opts?: { scroll?: boolean }): void => {
      const hits = findHitsRef.current
      const hit = hits[i]
      if (!hit) return
      if (canHighlight && hlRegistry && HighlightCtor) {
        hlRegistry.set(HL_CUR, new HighlightCtor(hit.range))
      } else {
        hits.forEach((h) => h.el.classList.remove('find-hit--cur'))
        hit.el.classList.add('find-hit--cur')
      }
      // 全文命中跳页时只切换当前命中，不 scrollIntoView：否则视图会被拉回前面的命中页
      if (opts?.scroll !== false) hit.el.scrollIntoView({ block: 'center' })
      setFindIdx(i)
    },
    [canHighlight, hlRegistry, HighlightCtor]
  )

  /** 在已挂载的文本层里收集 needle（小写）的所有命中 Range */
  const collectHits = useCallback((needle: string): { range: Range; el: HTMLElement }[] => {
    const layer = scrollRef.current
    if (!layer || !needle) return []
    const hits: { range: Range; el: HTMLElement }[] = []
    layer.querySelectorAll<HTMLElement>('.textLayer span').forEach((span) => {
      span.childNodes.forEach((node) => {
        if (node.nodeType !== Node.TEXT_NODE) return
        const text = (node.textContent ?? '').toLowerCase()
        let from = text.indexOf(needle)
        while (from !== -1) {
          const range = document.createRange()
          range.setStart(node, from)
          range.setEnd(node, from + needle.length)
          hits.push({ range, el: span })
          from = text.indexOf(needle, from + needle.length)
        }
      })
    })
    return hits
  }, [])

  const applyFind = useCallback(
    (q: string, opts?: { preferPage?: number; scroll?: boolean }): void => {
      const layer = scrollRef.current
      if (!layer) return
      // 非属主视图（隐藏的原文/译文栏）不参与查找：HL_ALL 是 document 级全局注册，
      // 隐藏视图在 numPages/renderScale 变化时重跑会把可见视图的高亮覆盖/清掉。
      if (!findOwner) {
        findHitsRef.current = []
        setFindCount(0)
        setFindIdx(-1)
        return
      }
      clearFind()
      findHitsRef.current = []
      setFindCount(0)
      setFindIdx(-1)
      const needle = q.trim().toLowerCase()
      if (!needle) return

      const hits = collectHits(needle)
      findHitsRef.current = hits
      setFindCount(hits.length)
      if (canHighlight && hlRegistry && HighlightCtor) {
        if (hits.length) hlRegistry.set(HL_ALL, new HighlightCtor(...hits.map((h) => h.range)))
      } else {
        hits.forEach((h) => h.el.classList.add('find-hit'))
      }
      if (hits.length > 0) {
        // 全文命中跳页：当前命中优先取目标页上的那一个，且不滚动（保持跳页后的目标页）
        let idx = 0
        if (opts?.preferPage != null) {
          const prefer = opts.preferPage
          const found = hits.findIndex(
            (h) => Number(h.el.closest('.scrollpage')?.getAttribute('data-page')) === prefer - 1
          )
          if (found >= 0) idx = found
        }
        focusHit(idx, { scroll: opts?.scroll })
      }
    },
    [canHighlight, clearFind, collectHits, focusHit, hlRegistry, HighlightCtor, findOwner]
  )

  useEffect(() => {
    // 用户改了查找词 → 之前的「命中带入」待定位请求失效
    if (pendingFindRef.current && pendingFindRef.current.query !== findQuery) {
      pendingFindRef.current = null
    }
    const pending = pendingFindRef.current
    const opts =
      pending && pending.query === findQuery
        ? { preferPage: pending.page, scroll: false }
        : undefined
    applyFind(findQuery, opts)
    const t = window.setTimeout(() => applyFind(findQuery, opts), 500)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery, numPages, renderScale, findOwner])

  // 组件卸载时清掉全局高亮注册（避免残留）
  useEffect(() => () => clearFind(), [clearFind])

  const findStep = (dir: 1 | -1): void => {
    const hits = findHitsRef.current
    if (hits.length === 0) return
    const next = (findIdx + dir + hits.length) % hits.length
    focusHit(next)
  }

  // 公共工具栏驱动：同步外部查找词 → 内部查找框
  useEffect(() => {
    if (externalFindQuery !== undefined) setFindQuery(externalFindQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalFindQuery])

  // 文库全文命中：把命中词带入查找框，并记录待定位页（等该页文本层就绪后重放）
  useEffect(() => {
    if (!findRequest || findRequest.nonce === lastFindReqNonceRef.current) return
    lastFindReqNonceRef.current = findRequest.nonce
    // 已切到别的文档或用户已改查找词：过期请求不得覆盖当前查找框
    if (externalFindQuery !== undefined && externalFindQuery.trim() !== findRequest.query.trim()) {
      return
    }
    pendingFindRef.current = { ...findRequest }
    setFindQuery(findRequest.query)
    const nonce = findRequest.nonce
    // 兜底：文本层就绪信号没等到（例如目标页已缓存/未重建文本层）时，3s 后按当前 DOM 重放一次
    const t = window.setTimeout(() => {
      if (pendingFindRef.current?.nonce !== nonce) return
      pendingFindRef.current = null
      applyFind(findRequest.query, { preferPage: findRequest.page, scroll: false })
    }, 3000)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findRequest?.nonce])

  /** 目标页文本层就绪：重放命中带入的查找（文本层异步建好，早跑的查找会是 0 命中） */
  const handleTextLayerReady = useCallback(
    (pageIndex: number): void => {
      const pending = pendingFindRef.current
      if (!pending || pending.page !== pageIndex + 1) {
        if (findQuery.trim()) applyFind(findQuery, { preferPage: page, scroll: false })
        return
      }
      // 用户已改查找词 / 已切文档：丢弃这次待定位请求，别把旧词塞回查找框
      if (externalFindQuery !== undefined && externalFindQuery.trim() !== pending.query.trim()) {
        pendingFindRef.current = null
        return
      }
      const host = scrollRef.current?.querySelector<HTMLElement>(
        `[data-page="${pageIndex}"] [data-text]`
      )
      if (!host || !host.textContent) return
      pendingFindRef.current = null
      applyFind(pending.query, { preferPage: pending.page, scroll: false })
    },
    [applyFind, externalFindQuery, findQuery, page]
  )

  // 公共工具栏驱动：下一处 / 上一处
  useEffect(() => {
    if (!findNextTick || findNextTick === lastFindTickRef.current) return
    lastFindTickRef.current = findNextTick
    findStep(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findNextTick])
  useEffect(() => {
    if (!findPrevTick || findPrevTick === lastFindPrevTickRef.current) return
    lastFindPrevTickRef.current = findPrevTick
    findStep(-1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findPrevTick])

  // 公共工具栏驱动：回传命中状态
  useEffect(() => {
    onFindStatusRef.current?.(findCount, findIdx)
  }, [findCount, findIdx])

  // 内部查找词变化（如「查找选中」）→ 回传，供公共工具栏同步输入框
  // 挂载首帧不回传：此时内部值还只是带入的初值（父级 findRequest/externalFindQuery 的镜像），
  // 父级 findQuery 才是权威值；回传它会把 openHit 刚设置的命中词打回空（同一 bug 的第二处覆盖源）。
  // 用「已回传/已带入」的值做去重：值没变就不回传，StrictMode 双跑也不会把父级打回空。
  const lastEmittedFindQueryRef = useRef<string | null>(seededFindQueryRef.current)
  useEffect(() => {
    if (lastEmittedFindQueryRef.current === findQuery) return
    lastEmittedFindQueryRef.current = findQuery
    onFindQueryChangeRef.current?.(findQuery)
  }, [findQuery])

  // 1) 加载文档（带会话级缓存：同一 sourceKey 复用已解析文档，切视图不再重复读盘/解析）
  useEffect(() => {
    let cancelled = false
    // 若该 sourceKey 已有已解析文档（缓存命中），立即呈现，避免切视图闪一下「正在载入」
    const cached = docCache.get(sourceKey)?.doc ?? null
    if (cached) {
      docRef.current = cached
      setNumPages(cached.numPages)
      onNumPagesRef.current?.(cached.numPages)
    } else {
      setNumPages(0)
      onNumPagesRef.current?.(0)
    }
    setAnnotations([])
    setSelectionSynced(null)
    setActiveAnn(null)
    setAutoFit(true)
    // 不在这里 setPage(1)：切文档时的首帧页码统一由下方 sourceKey effect 决定
    // （initialPage = 打开/命中页的快照）。无条件重置会在同一次提交里先渲染第 1 页，
    // 并把错误页码经 onPageChangeExternal 回传，覆盖父级刚写入的命中页。
    setError(null)

    acquireDoc(sourceKey, async () => {
      const bytes =
        translationId != null
          ? await window.api.translate.read(translationId)
          : await window.api.attachments.readBytes(attachmentId)
      const data = new Uint8Array(bytes)
      const task = pdfjsLib.getDocument({ data })
      const doc = await task.promise
      return { doc, destroy: () => void task.destroy() }
    })
      .then((doc) => {
        if (cancelled) return
        docRef.current = doc
        setNumPages(doc.numPages)
        onNumPagesRef.current?.(doc.numPages)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })

    return () => {
      cancelled = true
      docRef.current = null
      // 释放引用（不 destroy：文档留给缓存，供下次切换瞬间复用；由 LRU 在无人使用时回收）
      releaseDoc(sourceKey)
    }
  }, [sourceKey])

  const [figRegions, setFigRegions] = useState<Array<{ page: number; rects: number[][] }>>([])
  const figRegionsCache = useRef<Map<number, Array<{ page: number; rects: number[][] }>>>(new Map())
  useEffect(() => {
    if (readOnly || attachmentId == null) {
      setFigRegions([])
      return
    }
    const cached = figRegionsCache.current.get(attachmentId)
    if (cached) {
      setFigRegions(cached)
      return
    }
    let cancelled = false
    void window.api.reader
      .figures(attachmentId)
      .then((rs) => {
        if (cancelled) return
        figRegionsCache.current.clear()
        figRegionsCache.current.set(attachmentId, rs)
        setFigRegions(rs)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [attachmentId, readOnly])

  // 结构化模块层（章节/段落/图表/图注/参考文献 + 关联关系）：预览与跳转的**首选**来源
  const [structured, setStructured] = useState<StructuredDoc | null>(null)
  const structuredCache = useRef<Map<number, StructuredDoc>>(new Map())
  useEffect(() => {
    if (readOnly || attachmentId == null) {
      setStructured(null)
      return
    }
    const cached = structuredCache.current.get(attachmentId)
    if (cached) {
      setStructured(cached.pageCount > 0 ? cached : null)
      return
    }
    let cancelled = false
    void window.api.reader
      .modules(attachmentId)
      .then((d) => {
        if (cancelled) return
        structuredCache.current.clear()
        structuredCache.current.set(attachmentId, d)
        setStructured(d && d.pageCount > 0 ? d : null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [attachmentId, readOnly])

  // 2) 加载批注（译文模式下不加载）
  useEffect(() => {
    if (attachmentId == null) {
      setAnnotations([])
      return
    }
    let cancelled = false
    void window.api.reader.listAnnotations(attachmentId, translationId).then((list) => {
      if (!cancelled) setAnnotations(list)
    })
    return () => {
      cancelled = true
    }
  }, [attachmentId, translationId, reloadKey])

  // 点击非弹层区域时关闭弹层（含点击正文：点击即取消划词，工具条随之消失）
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.popup')) return
      setActiveAnn(null)
      setSelectionSynced(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [setSelectionSynced])

  // 深链：跳转到指定页（仅在 nonce 变化时，避免切换原文/译文时被旧深链重置）
  const lastFocusNonce = useRef(0)
  useEffect(() => {
    if (!focus || focus.nonce === lastFocusNonce.current) return
    lastFocusNonce.current = focus.nonce
    setPage(focus.page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce])

  // 切换文档（原文 / 译文）时回到该文档记住的页码/缩放（缺省回第 1 页 + 适应宽度）
  useEffect(() => {
    // 首帧页码只在这里决策一次：优先本次切换的 initialPage 快照（父级在 openTarget 里已把命中页同步写入
    // readPage，因此新视图挂载时拿到的就是命中页），其次同一次打开携带的 focus.page，最后回第 1 页。
    // 注意声明顺序：上方 focus effect 先执行（可能在挂载时写入同一页），本 effect 随后以同一决策来源落定，
    // 不会出现「先写命中页、再被旧 initialPage 覆盖」。
    setPage(
      initialPage != null && initialPage >= 1
        ? initialPage
        : focus && focus.page >= 1
          ? focus.page
          : 1
    )
    if (initialScale != null && initialScale >= 0.2 && initialScale <= 4) {
      setAutoFit(false)
      liveScaleRef.current = initialScale
      renderScaleRef.current = initialScale
      setLiveScale(initialScale)
      setRenderScale(initialScale)
    } else {
      setAutoFit(true)
    }
    // 仅在切换文档（sourceKey）时执行；initialPage/initialScale 作为该次切换的快照读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey])

  // 受控同步（并排对照）：外部页码变化时跳转（文档就绪后才生效）
  const externalSkipRef = useRef<number | null>(null)
  /** 文档加载完成并应用初始页后，才允许「对外回传页码」——否则初始化竞态会导致 1↔N 振荡 */
  const readyRef = useRef(false)
  const lastReportedRef = useRef<number | null>(null)
  /** 最近上报给父级的页码（页 → 上报时刻）：用于识别「父级慢一拍的回灌」 */
  const recentReportsRef = useRef<Map<number, number>>(new Map())
  /** 上一次从父级消费掉的 syncPage：同一个值重复下发只处理一次 */
  const lastSyncPropRef = useRef<number | null>(null)
  /** 最近一次「本视图自己换页」的时刻：判断父级回灌是否还慢一拍（见 syncPage effect） */
  const lastLocalChangeAtRef = useRef(0)
  /** 距最后一次本视图换页多久算「正在连续翻页」（毫秒）：回灌丢弃窗口 */
  const SYNC_ECHO_WINDOW_MS = 240
  useEffect(() => {
    if (numPages > 0) {
      const id = window.setTimeout(() => {
        readyRef.current = true
        lastReportedRef.current = null
      }, 0)
      return () => window.clearTimeout(id)
    }
    readyRef.current = false
    lastReportedRef.current = null
  }, [numPages, sourceKey])

  // 换文档：回灌识别用的历史必须清零，否则新文档里的同一页码会被当成旧回声忽略
  useEffect(() => {
    recentReportsRef.current.clear()
    lastSyncPropRef.current = null
  }, [sourceKey, numPages])

  useEffect(() => {
    if (numPages <= 0) return
    if (syncPage == null) return
    if (syncPage < 1 || syncPage > numPages) return
    // 同一个值重复下发（父级重渲染、文档页数变化后 effect 重跑）只处理一次。
    // 否则「已经消费过的旧值」会在用户继续滚动后又把页面拽回去。
    if (lastSyncPropRef.current === syncPage) return
    lastSyncPropRef.current = syncPage
    if (syncPage === page) return
    // 回声/滞后守卫：父级把**本视图刚上报过**的页码回灌回来时，如果用户正在连续翻页，
    // 那一定是父级 state 还慢一拍（我们已翻到 N，父级仍是 N-1）。
    // 旧实现无条件 setPage 会立刻把页面拽回上一页，再由跳页 effect 硬改 scrollTop →
    // 「旧页 / 新页交替抖动」。这里直接丢弃这一次回灌，等父级追平即可。
    if (Date.now() - lastLocalChangeAtRef.current < SYNC_ECHO_WINDOW_MS) {
      if (recentReportsRef.current.has(syncPage)) return
    }
    // 记录这是「外部同步」造成的换页，回传时跳过，避免左右互相回传形成振荡
    externalSkipRef.current = syncPage
    setPage(syncPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncPage, page, numPages])

  // 通知外部本视图页码变化（并排对照）
  useEffect(() => {
    if (!readyRef.current) return
    if (externalSkipRef.current === page) {
      // 该次变化源自外部同步，不回传（防振荡）
      externalSkipRef.current = null
      return
    }
    if (lastReportedRef.current === page) return
    lastReportedRef.current = page
    lastLocalChangeAtRef.current = Date.now()
    // 记住「这个页码是本视图上报的」：父级慢一拍把它当 syncPage 回灌时据此丢弃
    recentReportsRef.current.set(page, Date.now())
    if (recentReportsRef.current.size > 8) {
      let oldestPage = page
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [p, at] of recentReportsRef.current) {
        if (at < oldestAt) {
          oldestAt = at
          oldestPage = p
        }
      }
      if (oldestPage !== page) recentReportsRef.current.delete(oldestPage)
    }
    onPageChangeExternal?.(page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  // 缩放提交策略：手势/按钮先改 liveScale（纯 CSS transform 即时反馈）；停止后 ~120ms
  // 防抖提交 renderScale 做一次清晰重渲染。
    // 关键：连续手势期间「不做」清晰重渲染——每个滚轮 tick 都重渲染可见页正是卡顿来源。
    // 仅在偏离极大（>3.5x / <0.28x）时中途补一次，避免长时间极度模糊。
    useEffect(() => {
      if (Math.abs(liveScale - renderScale) < 0.001) return
      const ratio = liveScale / renderScale
      const delay = ratio > 3.5 || ratio < 0.28 ? 0 : 120
      const t = window.setTimeout(() => setRenderScale(liveScale), delay)
      return () => window.clearTimeout(t)
    }, [liveScale, renderScale])

  // 内部变化 → 回调外部有效缩放（去重；应用外部 scale 期间不回调）
  useEffect(() => {
    if (!pendingEmitRef.current) return
    pendingEmitRef.current = false
    if (applyingExternalRef.current) return
    emitScale(autoFit ? fitDisplay : liveScale, autoFit)
  }, [autoFit, fitDisplay, liveScale, emitScale])

  // 外部受控缩放：非空时视图跟随（zoomMode='fit' 时让位给适应宽度）
  useEffect(() => {
    if (scale == null || zoomMode === 'fit') return
    // 关键：忽略「自身回调的回环」。视图把内部变化 emit 给父级，父级把同一个值
    // 原样回传为 scale。若这里直接 setRenderScale(scale)，每次手势/每个滚轮 tick
    // 都会绕过 120ms 防抖、触发整轮页面重渲染 → 缩放卡顿（并加剧画布并发渲染）。
    // 仅当 scale 与当前 liveScale 不同（真正来自外部工具栏）时才立即应用。
    // 手势/防抖期间父级是滞后的：此时回传的任何值都不可信（会把手势打回旧值 → 抖动/抖动重渲染）。
    if (performance.now() - gestureAtRef.current < 500) return
    if (!autoFitRef.current && Math.abs(scale - liveScaleRef.current) < 0.001) return
    applyingExternalRef.current = true
    pendingEmitRef.current = false
    setAutoFit(false)
    // 同步镜像，供手势缩放基准值使用（避免 React 提交前的短暂陈旧读数）
    liveScaleRef.current = scale
    renderScaleRef.current = scale
    setLiveScale(scale)
    setRenderScale(scale)
    // 本次提交的副作用跑完后解除「正在应用外部值」标记，避免误吞后续内部回调
    const t = window.setTimeout(() => {
      applyingExternalRef.current = false
    }, 0)
    return () => window.clearTimeout(t)
  }, [scale, zoomMode, sourceKey])

  // 命令式「适应宽度」：父级递增 onFitRequest 计数即触发
  useEffect(() => {
    if (onFitRequest === undefined || onFitRequest === lastFitReqRef.current) return
    lastFitReqRef.current = onFitRequest
    if (!autoFit) {
      pendingEmitRef.current = true
      clearZoomOrigin()
      setAutoFit(true)
    }
  }, [onFitRequest, autoFit, clearZoomOrigin])

  // zoomMode='fit'：切换到适应宽度（复用现有 fit 路径）
  // 仅在 zoomMode 切换时响应；不因手势缩放将 autoFit 置 false 而反复抢回（否则 Ctrl+滚轮会失效）
  useEffect(() => {
    if (zoomMode !== 'fit' || autoFitRef.current) return
    pendingEmitRef.current = true
    clearZoomOrigin()
    setAutoFit(true)
  }, [zoomMode, clearZoomOrigin])

  // 手势/快捷键缩放：Ctrl+滚轮（触控板捏合会映射为 ctrl+wheel）
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      pendingEmitRef.current = true
      const base = beginZoomFromFit()
      const factor = e.deltaY < 0 ? 1.12 : 0.89
      const next = Math.min(4, Math.max(0.5, +(base * factor).toFixed(3)))
      commitZoom(next, { x: e.clientX, y: e.clientY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [beginZoomFromFit, commitZoom])

  const createAnnotation = useCallback(
    async (type: AnnotationType, color: string, comment?: string): Promise<void> => {
      if (!selection) return
      const created = await window.api.reader.createAnnotation({
        attachmentId,
        translationId,
        type,
        pageIndex: selection.pageIndex,
        rects: selection.rects,
        color,
        text: selection.text,
        prefix: selection.prefix,
        suffix: selection.suffix,
        comment: comment && comment.trim() ? comment.trim() : null
      })
      setAnnotations((prev) => [...prev, created])
      setSelectionSynced(null)
      setNoteText('')
      window.getSelection()?.removeAllRanges()
    },
    [selection, attachmentId, translationId]
  )

  /** 划词「查找」：把选中文本填进查找框并在本文中查找 */
  const findForSelection = useCallback((): void => {
    const raw = (selection?.text ?? '').replace(/\s+/g, ' ').trim()
    if (!raw) return
    // 选中的可能是跨行整句，整句在单行文本里搜不到 → 退而取「能命中的最长前缀」
    let q = raw
    if (collectHits(raw.toLowerCase()).length === 0) {
      const words = raw.split(' ')
      for (let n = words.length - 1; n >= 1; n--) {
        const cand = words.slice(0, n).join(' ')
        if (collectHits(cand.toLowerCase()).length > 0) {
          q = cand
          break
        }
      }
    }
    setFindQuery(q)
    applyFind(q)
    setSelectionSynced(null)
    window.getSelection()?.removeAllRanges()
    requestAnimationFrame(() => {
      const el =
        rootRef.current?.querySelector<HTMLInputElement>('[data-testid="find-input"]') ??
        document.querySelector<HTMLInputElement>('[data-testid="find-input"]')
      el?.focus()
      el?.select()
    })
  }, [selection, applyFind, collectHits])

  /** 划词「LaTeX」：把选中内容交给模型转成 LaTeX，结果显示在浮条里（可复制） */
  const [latexBusy, setLatexBusy] = useState(false)
  const [latexOut, setLatexOut] = useState('')
  const [latexMsg, setLatexMsg] = useState('')
  /** 划词「复制」的短暂反馈（不改变选区，只提示） */
  const [copyMsg, setCopyMsg] = useState('')
  /** 失败状态：区分「未配置模型」（给出直达设置入口）与普通失败（可重试） */
  const [latexFailed, setLatexFailed] = useState(false)
  const [latexNeedsConfig, setLatexNeedsConfig] = useState(false)
  const toLatexForSelection = useCallback(async (): Promise<void> => {
    const raw = (selection?.text ?? '').trim()
    if (!raw) return
    setLatexBusy(true)
    setLatexMsg('转换中…')
    setLatexOut('')
    setLatexFailed(false)
    setLatexNeedsConfig(false)
    try {
      const r = await window.api.ai.latex(raw)
      setLatexOut(r.latex || '')
      setLatexMsg(r.latex ? '转换完成（可复制）' : '没有可转换的数学内容')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setLatexMsg('转换失败：' + msg)
      setLatexFailed(true)
      setLatexNeedsConfig(/未配置|Base URL|API ?Key|模型/i.test(msg))
    } finally {
      setLatexBusy(false)
    }
  }, [selection])

  /** 划词「文件检索」：打开左侧「文献检索」面板并自动检索选中内容 */
  const searchWorksForSelection = useCallback((): void => {
    const raw = (selection?.text ?? '').replace(/\s+/g, ' ').trim()
    if (!raw) return
    onSearchWorks?.(raw)
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [selection, onSearchWorks])

  const deleteAnnotation = useCallback(async (id: number): Promise<void> => {
    await window.api.reader.deleteAnnotation(id)
    setAnnotations((prev) => prev.filter((a) => a.id !== id))
    setActiveAnn(null)
  }, [])

  const handleOpenAnn = useCallback((ann: Annotation, x: number, y: number): void => {
    setActiveAnn({ ann, x, y })
  }, [])

  const handleScrollSelection = useCallback(
    (s: SelectionInfo | null): void => {
      if (!s) {
        // 划词取消（点击别处 / 选择塌陷）→ 工具条随之消失
        setSelectionSynced(null)
        return
      }
      setNoteText('')
      setActiveAnn(null)
      setSelectionSynced(s)
    },
    [setSelectionSynced]
  )

  const jumpTo = (n: number): void => {
    if (Number.isFinite(n) && n >= 1 && n <= numPages) setPage(n)
  }

  /** 滚动是否已贴到文档顶/底边（连续步进下，翻页按钮禁用与此挂钩而与页码解耦） */
  const [scrollAtEdge, setScrollAtEdge] = useState({ top: true, bottom: false })
  const handleScrollEdges = useCallback(
    (e: { top: boolean; bottom: boolean }): void => {
      setScrollAtEdge((prev) => (prev.top === e.top && prev.bottom === e.bottom ? prev : e))
    },
    []
  )

  /**
   * 「上一页/下一页」改为翻**半个视口**的连续滚动：
   * 边界处同屏可见上一页下半 + 下一页上半，阅读不再在有界断点处整页停住。
   * 页码/预制/对照联动仍由现有 midline 判页与锚点机制自然跟随。
   */
  const stepScroll = (dir: 1 | -1): void => {
    const c = scrollRef.current
    if (!c || c.clientHeight <= 0) return
    const max = c.scrollHeight - c.clientHeight
    if (max <= 0) return
    c.scrollTop = halfPageScrollTop({
      scrollTop: c.scrollTop,
      viewport: c.clientHeight,
      scrollMax: max,
      dir
    })
  }

  if (error) {
    return <div className="empty">渲染失败：{error}</div>
  }

  const pageAnnCount = annotations.filter((a) => a.page_index === page - 1).length

  return (
    <div className="reader" ref={rootRef}>
      {!hideToolbar && (
      <div className="readerbar">
        <div className="group">
          <button
            className="icon ghost"
            title="上一页"
            disabled={scrollAtEdge.top}
            onClick={() => stepScroll(-1)}
          >
            <Icon name="left" size={16} />
          </button>
          <span className="toolbar__zoom" data-testid="page-indicator">
            {page} / {numPages}
          </span>
          <button
            className="icon ghost"
            title="下一页"
            disabled={scrollAtEdge.bottom}
            onClick={() => stepScroll(1)}
          >
            <Icon name="right" size={16} />
          </button>
        </div>

        <span className="readerbar__jumpwrap">
          <input
            className="readerbar__jump"
            type="number"
            min={1}
            max={numPages}
            placeholder="页码"
            value={pageInput}
            data-testid="page-jump"
            title="输入页码后回车跳转"
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') jumpTo(Number(pageInput))
            }}
          />
          <button className="icon ghost" title="跳转" onClick={() => jumpTo(Number(pageInput))}>
            <Icon name="right" size={15} />
          </button>
        </span>

        <span className="readerbar__info">本页批注 {pageAnnCount}</span>

        <span className="readerbar__findwrap group">
          <Icon name="search" size={13} />
          <input
            className="readerbar__find"
            placeholder="查找（全文）…"
            value={findQuery}
            data-testid="find-input"
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') findStep(1)
            }}
          />
          <span className="readerbar__info" data-testid="find-count">
            {findCount > 0 ? `${findIdx + 1}/${findCount}` : '0'}
          </span>
          <button className="icon ghost" title="上一个" onClick={() => findStep(-1)}>
            <Icon name="left" size={14} />
          </button>
          <button className="icon ghost" title="下一个" onClick={() => findStep(1)}>
            <Icon name="right" size={14} />
          </button>
        </span>

        <button
          className="ghost"
          title="翻译当前页（部分翻译）"
          data-testid="translate-page"
          onClick={() => {
            const layer = scrollRef.current?.querySelector<HTMLElement>(`[data-text="${page - 1}"]`)
            onTranslatePage?.(layer?.textContent ?? '')
          }}
        >
          <Icon name="translate" size={14} />
          译本页
        </button>
        <button
          className="ghost"
          title="页面管理：删除页面（可撤销，原文件保留）"
          data-testid="page-edit-open"
          onClick={() => setPagesOpen(true)}
          disabled={attachmentId == null}
        >
          <Icon name="trash" size={14} />
          页面
        </button>
        <span className="toolbar__spacer" />

        <div className="group" title="缩放（也可用 Ctrl+滚轮 / 触控板捏合）">
          <button
            className="icon ghost"
            title="缩小"
            data-testid="zoom-out"
            onClick={() => {
              pendingEmitRef.current = true
              commitZoom(Math.max(0.5, +(beginZoomFromFit() - 0.2).toFixed(2)))
            }}
          >
            <Icon name="minus" size={16} />
          </button>
          <button
            className="toolbar__zoom"
            title="适应宽度"
            data-testid="zoom-level"
            onClick={() => {
              if (!autoFit) {
                pendingEmitRef.current = true
                clearZoomOrigin()
                setAutoFit(true)
              }
            }}
            style={{ minWidth: 46 }}
          >
            {Math.round((autoFit ? fitDisplay : liveScale) * 100)}%
          </button>
          <button
            className="icon ghost"
            title="放大"
            data-testid="zoom-in"
            onClick={() => {
              pendingEmitRef.current = true
              commitZoom(Math.min(4, +(beginZoomFromFit() + 0.2).toFixed(2)))
            }}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>
      </div>
      )}

      {numPages > 0 && docRef.current ? (
        <ScrollPages
          doc={docRef.current}
          numPages={numPages}
          scale={renderScale}
          liveScale={liveScale}
          autoFit={autoFit}
          readOnly={false}
          searchQuery={findOwner ? findQuery : ''}
          annotations={annotations}
          containerRef={scrollRef}
          currentPage={page}
          flashKey={focus?.annotationKey ?? null}
          flashNonce={focus?.nonce ?? 0}
          focusRect={focus?.rect ?? null}
          focusPage={focus?.page ?? 0}
          onFitScale={handleFitScale}
          onSelection={handleScrollSelection}
          onOpenAnn={handleOpenAnn}
          onPageChange={setPage}
          syncRects={syncRects}
          innerRef={innerRef}
          selectionAnchorRef={selectionAnchorRef}
          zoomOrigin={zoomOrigin}
          onScrollAnchor={onScrollAnchor}
          onUserScroll={onUserScroll}
          syncAnchor={syncAnchor}
          onScrollEdges={handleScrollEdges}
          onSelectionRectsRef={onSelectionRectsRef}
          followOnly={followOnly}
          figureRegions={figRegions}
          structured={structured}
          attachmentId={attachmentId}
          onTextLayerReady={handleTextLayerReady}
          selectedBlock={selectedBlock}
          blocks={blocks}
          onBlockPicked={onBlockPicked}
        />
      ) : (
        <div className="empty">
          <span className="spinner" />
          <span>正在载入…</span>
        </div>
      )}

      {selection && popupVisible && (
        <div
          ref={popupRef}
          className="popup"
          style={{
            left:
              popupPos?.left ??
              Math.max(8, Math.min(selection.x, window.innerWidth - 320)) + popupNudge.dx,
            top:
              popupPos?.top ??
              Math.max(8, Math.min(selection.y + 6, window.innerHeight - 220)) + popupNudge.dy
          }}
        >

          {selection.text && (
            <div className="popup__sel" title={selection.text}>
              {selection.text.length > 140 ? `${selection.text.slice(0, 140)}…` : selection.text}
            </div>
          )}
          <div className="popup__row">
            <label>下划线</label>
            <div className="popup__swatches">
              {COLORS.map((c) => (
                <button
                  key={c}
                  className="swatch"
                  style={{ background: c }}
                  title="下划线"
                  onClick={() => void createAnnotation('underline', c)}
                />
              ))}
            </div>
          </div>
          <div className="popup__row">
            <button
              data-testid="translate-selection"
              onClick={() => onTranslateSelection?.(selection.text, selection.pageIndex + 1)}
            >
              <Icon name="translate" size={14} />
              翻译选中
            </button>
            <span className="popup__meta">确认后到「翻译」面板翻译</span>
          </div>
          <div className="popup__row">
            <button
              data-testid="ask-ai-selection"
              onClick={() => onAskSelection?.(selection.text, 'qa', selection.pageIndex + 1)}
            >
              <Icon name="sparkles" size={14} />
              问 AI
            </button>
            <button
              data-testid="explain-selection"
              onClick={() => onAskSelection?.(selection.text, 'term', selection.pageIndex + 1)}
            >
              <Icon name="info" size={14} />
              名词解释
            </button>
            <button
              data-testid="find-selection"
              title="在本文中查找选中文字"
              onClick={findForSelection}
            >
              <Icon name="search" size={14} />
              查找
            </button>
            <button
              data-testid="copy-selection"
              title="复制选中文本"
              onClick={() => {
                void navigator.clipboard
                  .writeText(selection.text)
                  .then(() => {
                    setCopyMsg('已复制')
                    window.setTimeout(() => setCopyMsg(''), 1200)
                  })
                  .catch(() => setCopyMsg('复制失败'))
              }}
            >
              <Icon name="copy" size={14} />
              复制
            </button>
            {copyMsg ? <span className="popup__meta">{copyMsg}</span> : null}
          </div>
          <div className="popup__row">
            <button
              data-testid="latex-selection"
              title="把选中内容转换为 LaTeX"
              disabled={latexBusy}
              onClick={() => void toLatexForSelection()}
            >
              <Icon name="sigma" size={14} />
              LaTeX
            </button>
            <button
              data-testid="works-selection"
              title="以选中内容检索相关文献（打开左侧「文献检索」）"
              onClick={searchWorksForSelection}
            >
              <Icon name="search" size={14} />
              文件检索
            </button>
          </div>
          {(latexOut || latexMsg) && (
            <div className="meta__section" data-testid="latex-selection-result">
              {latexMsg && <div className="meta__muted">{latexMsg}</div>}
              {latexNeedsConfig && (
                <div className="popup__row">
                  <button data-testid="latex-open-settings" onClick={() => onOpenSettings?.()}>
                    <Icon name="settings" size={14} />
                    去设置
                  </button>
                  <span className="popup__meta">配置对话模型后即可转换</span>
                </div>
              )}
              {latexFailed && (
                <div className="popup__row">
                  <button data-testid="latex-retry" onClick={() => void toLatexForSelection()}>
                    <Icon name="refresh" size={14} />
                    重试
                  </button>
                  <span className="popup__meta">选中内容已保留</span>
                </div>
              )}
              {latexOut && (
                <>
                  <textarea
                    className="meta__textarea"
                    readOnly
                    value={latexOut}
                    data-testid="latex-selection-out"
                  />
                  <div className="popup__row">
                    <button onClick={() => void navigator.clipboard.writeText(latexOut)}>
                      <Icon name="copy" size={14} />
                      复制 LaTeX
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <textarea
            placeholder="写点批注…（可留空）"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
          />
          <div className="popup__row">
            <button
              className="primary"
              onClick={() => void createAnnotation('note', NOTE_COLOR, noteText)}
            >
              <Icon name="notes" size={14} />
              保存批注
            </button>
          </div>
        </div>
      )}

      {activeAnn && (
        <div
          className="popup"
          style={{
            left: Math.max(8, Math.min(activeAnn.x, window.innerWidth - 320)),
            top: Math.max(8, Math.min(activeAnn.y + 6, window.innerHeight - 200))
          }}
        >
          <div className="popup__row">
            <span style={{ fontWeight: 600 }}>{TYPE_LABEL[activeAnn.ann.type] ?? activeAnn.ann.type}</span>
            <button className="popup__quit" title="关闭" onClick={() => setActiveAnn(null)}>
              <Icon name="close" size={14} />
            </button>
          </div>
          {activeAnn.ann.comment && <div className="popup__comment">{activeAnn.ann.comment}</div>}
          {activeAnn.ann.text && <div className="popup__meta">{activeAnn.ann.text}</div>}
          <div className="popup__row">
            <button
              disabled={itemId == null || !onAddToNote}
              onClick={() => {
                void onAddToNote?.(activeAnn.ann.id)
                setActiveAnn(null)
              }}
            >
              <Icon name="notes" size={14} />
              加入笔记
            </button>
            <button onClick={() => void deleteAnnotation(activeAnn.ann.id)}>
              <Icon name="trash" size={14} />
              删除
            </button>
          </div>
        </div>
      )}
      {pagesOpen && attachmentId != null && (
        <PageEditDialog
          attachmentId={attachmentId}
          pageCount={numPages}
          onClose={() => setPagesOpen(false)}
          onApplied={() => onPagesEdited?.()}
        />
      )}
    </div>
  )
}

interface ScrollPagesProps {
  searchQuery?: string
  doc: PDFDocumentProxy
  numPages: number
  /** 实际渲染比例（防抖后的） */
  scale: number
  /** 即时比例（手势/按钮），用于 CSS 变换即时反馈 */
  liveScale: number
  autoFit: boolean
  readOnly: boolean
  annotations: Annotation[]
  containerRef: { current: HTMLDivElement | null }
  currentPage: number
  flashKey: string | null
  flashNonce: number
  onFitScale: (s: number) => void
  onSelection: (s: SelectionInfo | null) => void
  onOpenAnn: (ann: Annotation, x: number, y: number) => void
  onPageChange: (page: number) => void
  /** 外部传入的联动高亮矩形（只读叠加层） */
  syncRects?: { page: number; rects: Rect[] } | null
  /** .scrollpages__inner 的引用：供父级在手势缩放时立即写 CSS transform（即时反馈） */
  innerRef: { current: HTMLDivElement | null }
  /** 暴露「选区 → 视图坐标」计算（浮层跟随滚动/缩放用） */
  selectionAnchorRef?: {
    current:
      | ((page: number, rects: Rect[]) => { x: number; y: number } | null)
      | null
  }
  /** 手势缩放锚点（0..1 比例，相对内容框）：让指针下的内容在缩放中保持不动 */
  zoomOrigin: { x: number; y: number } | null
  /** 滚动锚点（源页 + 页内比例）→ 供并排对照同步 */
  onScrollAnchor?: (a: { page: number; frac: number }) => void
  /** 用户主动滚动（滚轮/拖动/触摸）的通知，用于双向对照时判定联动方向 */
  onUserScroll?: () => void
  /** 外部锚点（带 nonce） */
  syncAnchor?: { page: number; frac: number; nonce: number } | null
  /** 滚动是否贴到文档顶/底边（外层翻页按钮禁用依据，与页码解耦） */
  onScrollEdges?: (e: { top: boolean; bottom: boolean }) => void
  /** 只跟随：不做页码检测/跳页 */
  followOnly?: boolean
  /** 每页矢量图形区域（精确裁剪图表预览用） */
  figureRegions?: Array<{ page: number; rects: number[][] }>
  /** 结构化模块层：图表预览与引用跳转的**首选**来源（正则/坐标作为回退） */
  structured?: StructuredDoc | null
  /** 附件 id（公式按需识别需要按区域渲染位图） */
  attachmentId: number
  /** 某页文本层建好（查找/选区依赖它；全文命中跳页后据此重放高亮） */
  onTextLayerReady?: (pageIndex: number) => void
  /** 引用命中的模块矩形（底边原点）+ 所在页：跳页后高亮 */
  focusRect?: [number, number, number, number] | null
  focusPage?: number
  /** 解析检查选中的结构化块（透视透给页面遮罩：匹配页画块区域高亮） */
  selectedBlock?: StructuredBlock | null
  /** 结构化块列表：页面点选命中用（与 selectedBlock 同源） */
  blocks?: readonly StructuredBlock[] | null
  /** 页面点选命中块后回调：上报 stableId 给外层选块 */
  onBlockPicked?: (stableId: string) => void
  /** 跨窗联动高亮回传（只读译文窗格也要能触发） */
  onSelectionRectsRef?: {
    current: ((v: { page: number; rects: Rect[] } | null) => void) | undefined
  }
}

/** 连续滚动阅读：所有页面纵向堆叠、懒渲染；页码导航通过滚动定位实现。 */
function ScrollPages({
  searchQuery = '',
  doc,
  numPages,
  scale,
  liveScale,
  autoFit,
  readOnly,
  annotations,
  containerRef,
  currentPage,
  flashKey,
  flashNonce,
  onFitScale,
  onSelection,
  onOpenAnn,
  onPageChange,
  syncRects,
  innerRef,
  selectionAnchorRef,
  zoomOrigin,
  onScrollAnchor,
  onUserScroll,
  syncAnchor,
  onScrollEdges,
  onSelectionRectsRef,
  followOnly,
  figureRegions,
  structured,
  attachmentId,
  onTextLayerReady,
  focusRect,
  focusPage,
  selectedBlock,
  blocks,
  onBlockPicked
}: ScrollPagesProps): React.JSX.Element {
  // 文本层就绪回调：用 ref 持有最新值，避免 renderPage 的闭包拿到旧回调
  const onTextLayerReadyRef = useRef(onTextLayerReady)
  useEffect(() => {
    onTextLayerReadyRef.current = onTextLayerReady
  }, [onTextLayerReady])

  // 滚动边缘回调：同上用 ref 持有，避免滚动监听 effect 因回调身份变化频繁重挂
  const onScrollEdgesRef = useRef(onScrollEdges)
  useEffect(() => {
    onScrollEdgesRef.current = onScrollEdges
  }, [onScrollEdges])
  const lastScrollEdgesRef = useRef({ top: true, bottom: false })

  // 设备像素比（dpr）：页面位图与弹窗位图都按「CSS 尺寸 × dpr」渲染，
  // 高分屏 / 系统缩放下面才不会发虚。换显示器或改系统缩放时 dpr 会变，
  // 此时必须重建可见页位图，否则已上屏的页面会一直停留在旧像素密度的位图上。
  // 注意：dpr 只影响**位图分辨率**，绝不能乘进 viewport.scale（文本层 / 批注层 /
  // 选区高亮都按 viewport.scale 定位，乘进去会整体错位）。
  const [dpr, setDpr] = useState<number>(() => {
    const v = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    return Number.isFinite(v) && v > 0 ? v : 1
  })
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const sync = (): void => {
      const next = window.devicePixelRatio || 1
      if (Number.isFinite(next) && next > 0) setDpr(next)
    }
    // (resolution: Ndppx) 只在 dpr 变化时触发；窗口 resize 兜底（部分平台改缩放不派发媒体查询事件）
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`)
    window.addEventListener('resize', sync)
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', sync)
    else mq.addListener(sync)
    return () => {
      window.removeEventListener('resize', sync)
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', sync)
      else mq.removeListener(sync)
    }
  }, [dpr])

  // 版面：只依赖「第一页尺寸 + 适应宽度」。其余页先按第一页尺寸占位，
  // 渲染/预取到真实页面时再修正 —— 避免打开大文档前先 getPage 全部页面导致长时间空白。
  const [layout, setLayout] = useState<{ fit: number; firstW: number } | null>(null)
  const [pageSizes, setPageSizes] = useState<Array<{ w: number; h: number }>>([])
  const pageSizeRef = useRef<Map<number, { w: number; h: number }>>(new Map())
  /** 上一次已初始化版面的文档：切文档时清空占位，避免用上一篇的尺寸先画一帧 */
  const lastDocRef = useRef<PDFDocumentProxy | null>(null)
  const viewports = useRef<Map<number, ReturnType<PDFPageProxy['getViewport']>>>(new Map())
  const rendered = useRef<Set<number>>(new Set())
  // 每页当前进行中的 render 任务：换比例/换文档前必须 cancel，
  // 否则同一画布并发 render 会被 pdf.js 拒绝（→ 黑屏，详见 renderPage 注释）
  const renderTasks = useRef<Map<number, RenderTask>>(new Map())
  // 每页复用的「离屏」画布：先渲染到这里，成功后再原子提交到可见画布，
  // 因此被取消/被文档销毁打断的渲染绝不会把可见画布留成黑屏。
  // 缓存键 = 页码 : 缩放 : 旋转 : 像素比（影响渲染结果的参数都进 key）。
  const offscreenRef = useRef<
    Map<string, { canvas: HTMLCanvasElement; bytes: number; used: number; ready: boolean }>
  >(new Map())
  const cacheBytesRef = useRef(0)
  const cacheClockRef = useRef(0)
  /** 导航版本：每次翻页/跳页递增；过期任务不得提交画面 */
  const navVersion = useRef(0)
  /** 上一页（判断翻页方向，用于定向预取） */
  const prevPageRef = useRef(currentPage)
  /** 上一次真正执行「定位」的页码：只有页码变化才允许再次程序化滚动 */
  const lastNavPageRef = useRef<number | null>(null)
  /** 预取窗口内的页（IntersectionObserver，rootMargin 3200px） */
  const visibleRef = useRef<Set<number>>(new Set())
  /** **真正落在视口内**的页（rootMargin 0）：连续滚动时可能有多页 */
  const viewportRef = useRef<Set<number>>(new Set())
  /** 验收用计数（开销可忽略） */
  const statsRef = useRef({ renders: 0, commits: 0, cacheHits: 0, evictions: 0, stale: 0 })
  // 本文件内「至少成功渲染过一次」的页：空闲补齐只需覆盖这些之外的页
  // （已有旧比例位图/文本层的页，滚动到时会由 IntersectionObserver 按新比例重渲染）。
  const everRenderedRef = useRef<Set<number>>(new Set())
  // 真正的渲染失败（非取消/非文档销毁）：按页显示「渲染失败 + 重试」，不静默、不涂白。
  const [pageErrors, setPageErrors] = useState<Record<number, string>>({})
  const renderPageRef = useRef<((i: number) => Promise<void>) | null>(null)
  /** 入队（可见页 → 翻页方向 → 距离）：跳页时用它把目标页插到最前 */
  const enqueueRef = useRef<((i: number) => void) | null>(null)
  /** 跳页时裁剪队列、取消无关的在途渲染 */
  const pruneQueueRef = useRef<((target: number) => void) | null>(null)
  /** 内存超预算时释放远处页面的可见位图（回滚到该页时再重渲染） */
  const releaseDistantRef = useRef<(() => void) | null>(null)
  /** 翻页方向：+1 向后、-1 向前（决定预取哪一侧） */
  const dirRef = useRef(1)
  /** 文本层当前对应的渲染比例（避免重复重建） */
  const textScaleRef = useRef<Map<number, number>>(new Map())
  const currentPageRef = useRef(currentPage)
  const suppress = useRef(false)
  /** 「程序化滚动」（翻页跳转/外部同步）期间：不回传滚动比例，避免左右互相拉扯 */
  const programmaticRef = useRef(false)
  /** 本次页码变化是否由「用户滚动」引起：是则不做跳页，避免与滚动抢位置（抖动） */
  const scrollDrivenRef = useRef(false)
  /**
   * 「用户滚动」在滚动回调里算出的目标页。
   * scrollDrivenRef 是布尔 + 250ms 超时，主线程被渲染占住时超时可能先触发，
   * 这个页码变化就会被误判成显式翻页，然后被 scrollTop 硬拽到页首（旧页/新页交替）。
   * 用「页码本身」做键不依赖定时窗口：只有当前页正好等于滚动算出的页才算滚动驱动。
   */
  const scrollDrivenPageRef = useRef<number | null>(null)
  /** 滚动停止判定：给容器打 data-scrolling，CSS 据此关掉未出图页的骨架动画 */
  const scrollIdleTimerRef = useRef<number | null>(null)
  /** 用户主动交互计数（滚轮/触摸/按下）：抑制窗口内若用户已接管，就不要再校正位置 */
  const userNavRef = useRef(0)
  /** 最近一次滚动时间：翻页/换页期间暂停后台整篇补渲染，避免抢主线程 */
  const lastScrollAtRef = useRef(0)
  /** 跳页后的「延迟上报比例」定时器：只保留最新的一个（快速翻页时不产生过期上报） */
  const jumpTimerRef = useRef<number | null>(null)
  /** 本次程序化跳页的落点 scrollTop：滚动事件据此判断用户是否已接管 */
  const jumpTopRef = useRef(0)
  const gen = useRef(0)

  useEffect(() => {
    currentPageRef.current = currentPage
  }, [currentPage])

  // 选区 → 滚动容器视口坐标（浮层跟随用；缩放/布局变化后重新注册）
  useEffect(() => {
    if (!selectionAnchorRef) return
    selectionAnchorRef.current = (pageIndex, rects) => {
      const c = containerRef.current
      const el = c?.querySelector<HTMLElement>(`[data-page="${pageIndex}"]`)
      const vp = viewports.current.get(pageIndex)
      if (!c || !el || !vp || rects.length === 0) return null
      const box = pdfRectToViewportRect(rects[0], vp)
      return {
        x: el.offsetLeft + box.left + box.width / 2,
        y: el.offsetTop - c.scrollTop + box.top + box.height
      }
    }
    return () => {
      selectionAnchorRef.current = null
    }
  }, [selectionAnchorRef, containerRef])
  // 验收/诊断用：渲染统计（体积极小，不参与 UI）
  useEffect(() => {
    ;(window as unknown as { __pdfStats?: typeof statsRef.current }).__pdfStats =
      statsRef.current
  }, [])

  useEffect(
    () => () => {
      // 释放离屏位图（width/height 置 0 才会真正还内存）
      for (const ent of offscreenRef.current.values()) {
        ent.canvas.width = 0
        ent.canvas.height = 0
      }
      offscreenRef.current.clear()
      cacheBytesRef.current = 0
      textScaleRef.current.clear()
    },
    []
  )
  useEffect(() => {
    everRenderedRef.current = new Set()
    // 位图缓存、文本层都与「文档」强绑定：
    // cacheKey 只有 页码:缩放:旋转:DPR，不含文档身份。两篇同尺寸 PDF 会命中同一 key，
    // 换文档时若不清空，就会显示上一篇的画面/文本层。
    for (const ent of offscreenRef.current.values()) {
      ent.canvas.width = 0
      ent.canvas.height = 0
    }
    offscreenRef.current.clear()
    cacheBytesRef.current = 0
    textScaleRef.current.clear()
    // 重译单页后会换成一个全新的 PDFDocumentProxy；可见 canvas 的 rendered 标记也必须清掉，
    // 否则同一页会命中 rendered 直接 return，继续显示旧页（典型：重译本页后右栏仍显示原文）。
    for (const task of renderTasks.current.values()) {
      try {
        task.cancel()
      } catch {
        /* 已结束的 render 任务取消会抛，忽略 */
      }
    }
    renderTasks.current.clear()
    rendered.current.clear()
    viewports.current.clear()
    setPageErrors({})
    for (const canvas of containerRef.current?.querySelectorAll<HTMLCanvasElement>(
      'canvas[data-rendered="1"]'
    ) ?? []) {
      delete canvas.dataset.rendered
      const ctx = canvas.getContext('2d')
      if (ctx && canvas.width > 0 && canvas.height > 0) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
    }
  }, [doc, containerRef])
  const setPageError = useCallback((i: number, msg: string | null): void => {
    setPageErrors((prev) => {
      if (msg == null) {
        if (!(i in prev)) return prev
        const next = { ...prev }
        delete next[i]
        return next
      }
      if (prev[i] === msg) return prev
      return { ...prev, [i]: msg }
    })
  }, [])
  const retryPage = useCallback(
    (i: number): void => {
      setPageErrors((prev) => {
        if (!(i in prev)) return prev
        const next = { ...prev }
        delete next[i]
        return next
      })
      rendered.current.delete(i)
      void renderPageRef.current?.(i)
    },
    []
  )
  /**
   * 每页的画布容器：React 只拥有这个空 div，**画布由我们自己按双缓冲方式替换**。
   *
   * 为什么不直接写 `<canvas />`：双缓冲需要 replaceChild 换掉可见画布，
   * 而 React 会记着它创建的那个 canvas 节点（fiber.stateNode）。被我们换掉之后，
   * 该节点已不在 DOM 里，React 后续的插入/删除会拿到失效锚点（NotFoundError）。
   * 让 React 只拥有一个稳定的容器，画布的替换就完全由我们自己负责。
   */
  const ensurePageCanvas = useCallback((el: HTMLDivElement | null): void => {
    if (!el || el.firstElementChild) return
    el.appendChild(document.createElement('canvas'))
  }, [])

  const effRender = autoFit ? (layout?.fit ?? 1) : scale
  const effLive = autoFit ? (layout?.fit ?? 1) : liveScale
  const zoomK = effRender > 0 ? Math.max(0.2, Math.min(5, effLive / effRender)) : 1

  // Search needs text, not a full-document bitmap cache. Build missing text layers
  // only on demand, sequentially, and stop immediately when the query/document changes.
  useEffect(() => {
    if (!searchQuery.trim() || !layout) return
    let stopped = false
    let activeLayer: InstanceType<typeof pdfjsLib.TextLayer> | null = null
    const timer = window.setTimeout(() => void (async () => {
      for (let i = 0; i < numPages && !stopped; i++) {
        const target = containerRef.current?.querySelector<HTMLElement>(`[data-page="${i}"] [data-text]`)
        if (!target || target.childNodes.length) continue
        try {
          const p = await doc.getPage(i + 1)
          if (stopped) break
          const viewport = p.getViewport({ scale: effRender })
          const detached = document.createElement('div')
          detached.style.setProperty('--total-scale-factor', String(viewport.scale))
          activeLayer = new pdfjsLib.TextLayer({ textContentSource: p.streamTextContent(), container: detached, viewport })
          await activeLayer.render()
          if (stopped) break
          if (!target.childNodes.length) {
            target.style.setProperty('--total-scale-factor', String(viewport.scale))
            target.replaceChildren(...Array.from(detached.childNodes))
            textScaleRef.current.set(i, effRender)
            onTextLayerReadyRef.current?.(i)
          }
        } catch { if (stopped) break }
      }
    })(), 200)
    return () => { stopped = true; window.clearTimeout(timer); activeLayer?.cancel() }
  }, [searchQuery, doc, numPages, effRender, layout, containerRef])

  // 只取「第一页」尺寸并计算适应宽度：**不要**在打开文档时 for 1..numPages 顺序 getPage。
  // 大文档 / 译文（内嵌 CJK 字体）解析全部页面要很久，期间没有 layout → 整页空白。
  // 现在第一页一就绪就上屏，其余页按第一页尺寸占位，渲染到真实页面时再修正高度。
  useEffect(() => {
    let cancelled = false
    if (lastDocRef.current !== doc) {
      lastDocRef.current = doc
      pageSizeRef.current.clear()
      setPageSizes([])
      setLayout(null)
    }
    void (async () => {
      try {
        const first = await doc.getPage(1)
        if (cancelled) return
        const v = first.getViewport({ scale: 1 })
        const uniform = { w: v.width, h: v.height }
        pageSizeRef.current.clear()
        pageSizeRef.current.set(0, uniform)
        setPageSizes(Array.from({ length: numPages }, () => ({ ...uniform })))
        const avail = Math.max(320, (containerRef.current?.clientWidth ?? 800) - 10)
        const fit = Number(Math.max(0.5, Math.min(2, avail / v.width)).toFixed(2))
        setLayout({ fit, firstW: v.width })
        onFitScale(fit)
      } catch {
        /* 文档已销毁/取消：交给上层错误态 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc, numPages, containerRef, onFitScale])

  // 容器宽度变化（拖分栏 / 改窗口）时重算「适应宽度」（去抖，避免滚动条抖动循环）
  useEffect(() => {
    const c = containerRef.current
    const firstW = layout?.firstW
    if (!c || !firstW) return
    let raf = 0
    const apply = (): void => {
      const avail = Math.max(320, c.clientWidth - 10)
      const fit = Number(Math.max(0.5, Math.min(2, avail / firstW)).toFixed(2))
      if (Math.abs(fit - (layout?.fit ?? 0)) > 0.02) {
        setLayout({ fit, firstW })
        onFitScale(fit)
      }
    }
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(apply)
    })
    ro.observe(c)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [layout?.fit, layout?.firstW, containerRef, onFitScale])

  // 渲染：effRender 变化时只重渲染「可见页」；其余页面在空闲时逐个补齐。
  // 关键：每页先渲染到「离屏」画布，成功后再**双缓冲**提交到页面（新建 canvas → 画好 →
  // 同一帧 replaceWith 旧 canvas），因此被取消/被文档销毁打断的渲染绝不会把可见画布留成
  // 黑屏，提交过程中也不存在「已清空但还没画上」的中间帧。
  useEffect(() => {
    const c = containerRef.current
    if (!c || !layout) return
    const myGen = ++gen.current
    rendered.current = new Set()
    viewports.current = new Map()

    /** 预期内失败：被取消 / 被新代际接管 / 文档已销毁（切文档、切模式、卸载）。 */
    const isAbortError = (err: unknown): boolean => {
      const name = (err as { name?: string } | null)?.name ?? ''
      const msg = err instanceof Error ? err.message : String(err)
      if (/cancel/i.test(name) || /cancel/i.test(msg)) return true
      if ((doc as unknown as { destroyed?: boolean }).destroyed === true) return true
      if (/sendWithPromise|transport|destroyed|Worker was destroyed/i.test(msg)) return true
      return false
    }

    // 真正的偶发失败只自愈一次；仍失败 → 暴露错误态（可重试），不再涂白遮黑。
    const retryCount = new Map<number, number>()
    const scheduleRetry = (i: number): boolean => {
      const n = retryCount.get(i) ?? 0
      if (n >= 1) return false
      retryCount.set(i, n + 1)
      window.setTimeout(() => {
        if (gen.current === myGen) void renderPage(i)
      }, 120)
      return true
    }

    // 位图缓存预算（离屏缓冲）：超出后按 LRU 释放，避免长文档内存线性增长
    const CACHE_LIMIT_BYTES = 48 * 1024 * 1024

    /**
     * 双缓冲提交：把离屏位图换成页面上的可见画布。
     *
     * 为什么不再「就地改可见 canvas 的 width/height 再 drawImage」：
     * 给 canvas 赋 width/height 会**立刻清空位图**，并换掉合成层的后备存储；
     * 缩放后重渲染（尺寸变化）时哪怕只差一帧，也会看到白纸/黑块闪一下。
     * 现在新 canvas 先完整画好（尺寸/位图/style/dataset 全部就绪），再在同一任务内
     * replaceChild 换掉旧 canvas —— 旧画面一直保留到替换的那一刻，没有任何空白帧。
     */
    const commitBitmap = (
      i: number,
      off: HTMLCanvasElement,
      viewport: ReturnType<PDFPageProxy['getViewport']>,
      cssW: number,
      cssH: number
    ): void => {
      const host = c.querySelector<HTMLElement>(`[data-page="${i}"]`)
      const holder = host?.querySelector<HTMLElement>('[data-canvas]')
      if (!host || !holder) return
      const prev = holder.querySelector<HTMLCanvasElement>('canvas')
      const next = document.createElement('canvas')
      next.width = off.width
      next.height = off.height
      const ctx = next.getContext('2d', { alpha: false })
      if (!ctx) return
      ctx.drawImage(off, 0, 0)
      // CSS 尺寸与 renderPage 里算位图时用的是同一组 cssW/cssH：
      // 位图 = CSS × dpr，显示尺寸不变、只提升像素密度（绝不靠 CSS 拉伸位图）。
      next.style.width = `${cssW}px`
      next.style.height = `${cssH}px`
      // 先带好 data-rendered 再入 DOM：不会出现「已插入但还没标记」的一帧（那是 opacity:0）
      next.dataset.rendered = '1'
      if (prev) holder.replaceChild(next, prev)
      else holder.appendChild(next)
      if (prev) { prev.width = 0; prev.height = 0 }
      // 这一页已出过图：CSS 用它把骨架动画换成静态纸面。之后无论重渲染还是内存回收，
      // 都不会再反复播放动画（快速跳页时反复出现/消失的动画本身就是「闪烁」）。
      host.dataset.ever = '1'
      viewports.current.set(i, viewport)
      everRenderedRef.current.add(i)
      statsRef.current.commits++
    }

    /** 超出预算：淘汰最久未用的离屏位图（保留当前页与刚提交的页） */
    const evictCache = (keepPage: number): void => {
      if (cacheBytesRef.current <= CACHE_LIMIT_BYTES) return
      const cur = currentPageRef.current - 1
      const items = [...offscreenRef.current.entries()]
        .filter(([k]) => !k.startsWith(`${keepPage}:`) && !k.startsWith(`${cur}:`))
        .sort((a, b) => a[1].used - b[1].used)
      for (const [k, ent] of items) {
        if (cacheBytesRef.current <= CACHE_LIMIT_BYTES) break
        ent.canvas.width = 0
        ent.canvas.height = 0
        offscreenRef.current.delete(k)
        cacheBytesRef.current -= ent.bytes
        statsRef.current.evictions++
      }
    }

    const renderPage = async (i: number): Promise<void> => {
      if (gen.current !== myGen || rendered.current.has(i)) return
      const host = c.querySelector<HTMLElement>(`[data-page="${i}"]`)
      // 画布容器存在即可：可见画布由 commitBitmap 在提交时创建/替换，不在这里取旧画布
      const holder = host?.querySelector<HTMLElement>('[data-canvas]')
      const textDiv = host?.querySelector<HTMLElement>('[data-text]')
      if (!holder || !textDiv) return
      rendered.current.add(i)
      // 同一画布上若还有上一轮未完成的 render，先 cancel
      // （pdf.js 静态 #canvasInUse：同一 canvas 并发 render 会被拒绝）。
      const prevTask = renderTasks.current.get(i)
      if (prevTask) {
        try {
          prevTask.cancel()
        } catch {
          /* 已结束/已取消，忽略 */
        }
        renderTasks.current.delete(i)
      }
      const navAtStart = navVersion.current
      /** 导航已变时：这一页还值不值得提交（视口内 / 目标附近） */
      const stillRelevant = (): boolean =>
        visibleRef.current.has(i) || Math.abs(i - (currentPageRef.current - 1)) <= 2
      /** 本任务未产出可用位图时移除自己的缓存条目（在 catch 里也要能调用） */
      let dropEntry: (() => void) | null = null
      try {
        const page = await doc.getPage(i + 1)
        if (gen.current !== myGen) return
        // 真实页面尺寸与占位不同时修正（混合页面尺寸的 PDF）：只改占位高度，不重启渲染代次
        const baseVp = page.getViewport({ scale: 1 })
        const known = pageSizeRef.current.get(i)
        if (
          !known ||
          Math.abs(known.w - baseVp.width) > 0.5 ||
          Math.abs(known.h - baseVp.height) > 0.5
        ) {
          pageSizeRef.current.set(i, { w: baseVp.width, h: baseVp.height })
          setPageSizes((arr) => {
            if (arr.length === 0) return arr
            const cur = arr[i]
            if (
              cur &&
              Math.abs(cur.w - baseVp.width) < 0.5 &&
              Math.abs(cur.h - baseVp.height) < 0.5
            ) {
              return arr
            }
            const next = arr.slice()
            next[i] = { w: baseVp.width, h: baseVp.height }
            return next
          })
        }
        const viewport = page.getViewport({ scale: effRender })
        // 严格等式：位图尺寸 = CSS 尺寸 × dpr。
        // 先按 CSS 像素取整（与 .scrollpage 容器宽高一致），再乘 dpr 取整。
        // 若直接 floor(viewport.width × dpr)，dpr 为 1.25 / 1.5 时位图与 CSS 宽的比值
        // 会略小于 dpr（613.33 → 919 vs 613 × 1.5 = 919.5），画面被拉伸 ≤1px、边缘发虚。
        const cssW = Math.max(1, Math.floor(viewport.width))
        const cssH = Math.max(1, Math.floor(viewport.height))
        const pw = Math.max(1, Math.round(cssW * dpr))
        const ph = Math.max(1, Math.round(cssH * dpr))
        // 缓存键：页码 + 缩放 + 旋转 + 像素比（任一不同都不能复用位图）
        const rotation =
          (page as unknown as { rotate?: number }).rotate ??
          ((page as unknown as { rotation?: number }).rotation || 0)
        const cacheKey = `${i}:${effRender.toFixed(3)}:${rotation}:${dpr}`
        let ent = offscreenRef.current.get(cacheKey)
        if (ent && (ent.canvas.width !== pw || ent.canvas.height !== ph)) {
          ent.canvas.width = 0
          ent.canvas.height = 0
          cacheBytesRef.current -= ent.bytes
          offscreenRef.current.delete(cacheKey)
          ent = undefined
        }
        // 只有「成功渲染完成」的位图才算命中。被取消/被打断的半成品仍留在缓存里的话，
        // 下次会直接提交成黑屏/半张图（快速翻页后返回最容易触发）。
        const hit = !!ent && ent.ready
        if (!ent) {
          const cv = document.createElement('canvas')
          cv.width = pw
          cv.height = ph
          ent = { canvas: cv, bytes: pw * ph * 4, used: 0, ready: false }
          offscreenRef.current.set(cacheKey, ent)
          cacheBytesRef.current += ent.bytes
        }
        const entry = ent
        /** 本任务没有产出可用位图 → 移除自己的未完成缓存（不误删他人已完成的） */
        dropEntry = (): void => {
          const cur = offscreenRef.current.get(cacheKey)
          if (cur && cur.canvas === entry.canvas && !cur.ready) {
            cur.canvas.width = 0
            cur.canvas.height = 0
            offscreenRef.current.delete(cacheKey)
            cacheBytesRef.current -= cur.bytes
          }
        }
        entry.used = ++cacheClockRef.current
        if (hit) {
          // 同参数位图已在缓存里：直接提交，省掉一次 pdf.js 渲染
          statsRef.current.cacheHits++
        } else {
          const off = ent.canvas
          const offCtx = off.getContext('2d', { alpha: false })
          // 哨兵：pdf.js 在「页面/文档已销毁」时会静默 resolve（不绘制任何内容）。
          // 整张贴上哨兵色，才能区分「真的画了」和「什么都没画」。
          if (offCtx) {
            offCtx.fillStyle = '#010203'
            offCtx.fillRect(0, 0, pw, ph)
          }
          statsRef.current.renders++
          const task = page.render({
            canvas: off,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
          })
          renderTasks.current.set(i, task)
          await task.promise
          if (gen.current !== myGen) return
          if ((page as unknown as { destroyed?: boolean }).destroyed === true) {
            rendered.current.delete(i)
            renderTasks.current.delete(i)
            dropEntry?.()
            return
          }
          if (offCtx) {
            const px = offCtx.getImageData(0, 0, 1, 1).data
            if (px[0] === 1 && px[1] === 2 && px[2] === 3) {
              rendered.current.delete(i)
              renderTasks.current.delete(i)
              dropEntry?.()
              return
            }
          }
          entry.ready = true
        }
        // 过期任务：导航已经切走、这一页也不再相关 → 不提交（避免旧页闪回/浪费）
        if (navVersion.current !== navAtStart && !stillRelevant()) {
          statsRef.current.stale++
          rendered.current.delete(i)
          renderTasks.current.delete(i)
          return
        }
        commitBitmap(i, ent.canvas, viewport, cssW, cssH)
        renderTasks.current.delete(i)
        retryCount.delete(i)
        setPageError(i, null)
        evictCache(i)
        releaseDistant()
        // 文本层（选区 / 查找 / 批注定位）：同一比例只建一次。
        // 位图已经提交、用户已能看到这一页；文本层放到当前任务之后建，避免它占住
        // 渲染并发位（译文页 CJK span 很多，会把后续页的位图明显拖慢）。
        if (textScaleRef.current.get(i) !== effRender) {
          textScaleRef.current.set(i, effRender)
          window.setTimeout(() => {
            if (gen.current !== myGen) {
              // 这一代已被缩放/换文档取代：清掉标记，让下一次渲染还能重建文本层
              textScaleRef.current.delete(i)
              return
            }
            const hostNow = c.querySelector<HTMLElement>(`[data-page="${i}"]`)
            const textNow = hostNow?.querySelector<HTMLElement>('[data-text]')
            if (!textNow) {
              textScaleRef.current.delete(i)
              return
            }
            void (async () => {
              try {
                textNow.replaceChildren()
                textNow.style.setProperty('--total-scale-factor', String(viewport.scale))
                const tl = new pdfjsLib.TextLayer({
                  textContentSource: page.streamTextContent(),
                  container: textNow,
                  viewport
                })
                await tl.render()
                // 文本层就绪后再通知父级（全文命中跳页靠这个信号重放查找高亮）
                if (gen.current === myGen) onTextLayerReadyRef.current?.(i)
              } catch {
                /* 取消/文档销毁/元素替换：文本层缺失不影响位图显示；下次渲染可重试 */
                textScaleRef.current.delete(i)
              }
            })()
          }, 0)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // 被新轮接管 → 不动新一代状态。
        if (gen.current !== myGen) return
        rendered.current.delete(i)
        renderTasks.current.delete(i)
        dropEntry?.()
        // 取消 / 文档已销毁 → 非本页错误：画布保持原样（交给新轮或不显示）。
        if (isAbortError(err)) return
        // 真正的渲染失败：短暂自愈一次，仍失败 → 显示错误态（可重试）。
        if (!scheduleRetry(i)) setPageError(i, msg)
      }
    }
    renderPageRef.current = renderPage

    // 渲染队列：pdf.js 的 canvas 渲染跑在主线程，快速翻页时若同时开很多页，
    // 真正需要看的「当前页」会被其它页拖慢 → 露出空白纸面（看起来就是闪一下）。
    // 这里限制并发 2，并让离当前页最近的页先渲染。
    let activeRenders = 0
    const queue: number[] = []
    const queued = new Set<number>()
    /** 队列优先级：真正可见的页 > 预取窗口内的页 > 翻页方向 > 距离 */
    const rank = (p: number): number => {
      const cur = currentPageRef.current - 1
      const onScreen = viewportRef.current.has(p) ? 0 : 1
      const inWindow = visibleRef.current.has(p) ? 0 : 1
      const ahead = (p - cur) * dirRef.current >= 0 ? 0 : 1
      return onScreen * 10000 + inWindow * 1000 + ahead * 100 + Math.abs(p - cur)
    }
    const pump = (): void => {
      while (activeRenders < 2 && queue.length > 0) {
        const i = queue.shift() as number
        queued.delete(i)
        if (gen.current !== myGen || rendered.current.has(i)) continue
        activeRenders++
        void renderPage(i).finally(() => {
          activeRenders--
          pump()
        })
      }
    }
    const enqueue = (i: number): void => {
      if (i < 0 || i >= numPages) return
      if (rendered.current.has(i) || queued.has(i)) return
      queued.add(i)
      queue.push(i)
      queue.sort((a, b) => rank(a) - rank(b))
      pump()
    }
    enqueueRef.current = enqueue
    /**
     * 可见画布的内存上限：所有页的位图都驻留在 DOM 里，页数多 + 高 DPI 时会很可观。
     * 只在超过预算时释放「离当前页很远且不在视口内」的页；回到附近会重新渲染。
     *
     * 这里刻意做得「抠」：只释放刚好够用的部分，且从离当前页最远的页开始，
     * 并带迟滞。原来的实现一旦超预算就把窗口外的**所有**已上屏页全部清空，
     * 快速在多页之间循环跳动时，回到刚看过的那页就已经变成白纸 + 骨架动画 →
     * 看上去就是整片闪白。
     */
    const RELEASE_LIMIT_BYTES = 96 * 1024 * 1024
    let releasedOnce = false
    /** 滚动中推迟的回收：停稳后再补一次，避免「刚离开的页变空白 → 回看先白后图」 */
    let releaseTimer = 0
    const releaseDistant = (): void => {
      // 翻页/滚动进行中先不回收：回收会把刚离开的页弄成空白，用户往回翻一页时
      // 先白后图，视觉上就是闪一下。停稳 500ms 后补做一次，内存照样能降下来。
      if (Date.now() - lastScrollAtRef.current < 400) {
        if (!releaseTimer) {
          releaseTimer = window.setTimeout(() => {
            releaseTimer = 0
            if (gen.current === myGen) releaseDistant()
          }, 500)
        }
        return
      }
      let bytes = 0
      const canvases = c.querySelectorAll<HTMLCanvasElement>('.scrollpage canvas')
      for (const cv of canvases) bytes += cv.width * cv.height * 4
      if (bytes < RELEASE_LIMIT_BYTES) {
        releasedOnce = false
        return
      }
      // 迟滞：刚释放过就要求再涨 15% 才允许下一轮，避免在阈值附近
      // 「释放 → 重渲染 → 再释放」地抖动。
      if (releasedOnce && bytes < RELEASE_LIMIT_BYTES * 1.15) return
      const cur = currentPageRef.current - 1
      const candidates: number[] = []
      for (let p = 0; p < numPages; p++) {
        if (Math.abs(p - cur) <= 2 || visibleRef.current.has(p)) continue
        const cv = c.querySelector<HTMLCanvasElement>(`[data-page="${p}"] canvas`)
        if (!cv || cv.dataset.rendered !== '1') continue
        candidates.push(p)
      }
      if (candidates.length === 0) return
      candidates.sort((a, b) => Math.abs(b - cur) - Math.abs(a - cur))
      // 释放到「低于预算」即可，多留 10% 余量（否则下一次提交又立刻触发）
      let need = bytes - RELEASE_LIMIT_BYTES + RELEASE_LIMIT_BYTES * 0.1
      for (const p of candidates) {
        if (need <= 0) break
        const cv = c.querySelector<HTMLCanvasElement>(`[data-page="${p}"] canvas`)
        if (!cv || cv.dataset.rendered !== '1') continue
        // 换成 1/4 尺寸的低清海报，而不是把画布 width/height 置 0（那样整页纯白，
        // 只剩 data-ever 的静态白纸）。海报保留 data-rendered=1，所以：
        //   · 回看这一页时先看到低清画面，再由 commitBitmap 双缓冲换成清晰版，
        //     整个过程没有任何空白帧；
        //   · 内存降到 1/16，仍由 evictCache / 下次提交按预算回收。
        const holder = cv.parentElement
        const poster = document.createElement('canvas')
        poster.width = Math.max(1, Math.floor(cv.width / 4))
        poster.height = Math.max(1, Math.floor(cv.height / 4))
        const pctx = poster.getContext('2d', { alpha: false })
        if (!holder || !pctx) continue
        pctx.drawImage(cv, 0, 0, poster.width, poster.height)
        poster.style.width = cv.style.width
        poster.style.height = cv.style.height
        poster.dataset.rendered = '1'
        need -= cv.width * cv.height * 4
        holder.replaceChild(poster, cv)
        // 源位图必须真正归零才会还内存
        cv.width = 0
        cv.height = 0
        rendered.current.delete(p)
        textScaleRef.current.delete(p)
      }
      releasedOnce = true
    }
    releaseDistantRef.current = releaseDistant

    /**
     * 跳页：合并中间请求（丢弃与目标无关的排队项），取消离目标很远的在途渲染。
     * 离屏渲染被取消不会影响可见画面，只是不再浪费主线程。
     *
     * 保留窗口不能太窄：快速在多页之间循环跳动时，刚离开的那页往往马上又被跳回来，
     * 它的在途渲染一旦被取消，回来时就得从零重渲染（目标页停在白纸上 = 闪白）。
     * 所以排队项保留 ±4、在途渲染保留 ±6（在途的已经付过 getPage/解析成本，丢掉最亏）。
     */
    const pruneQueue = (target: number): void => {
      for (let k = queue.length - 1; k >= 0; k--) {
        const p = queue[k]
        if (visibleRef.current.has(p) || Math.abs(p - target) <= 4) continue
        queued.delete(p)
        queue.splice(k, 1)
      }
      for (const [p, task] of [...renderTasks.current.entries()]) {
        if (visibleRef.current.has(p) || Math.abs(p - target) <= 6) continue
        try {
          task.cancel()
        } catch {
          /* 忽略 */
        }
        renderTasks.current.delete(p)
        rendered.current.delete(p)
      }
      enqueue(target)
      pump()
    }
    pruneQueueRef.current = pruneQueue

    /** 取消本轮仍在进行的所有 render（换比例 / 换文档 / 卸载时调用，防止画布上叠加并发 render） */
    const cancelInFlight = (): void => {
      for (const t of renderTasks.current.values()) {
        try {
          t.cancel()
        } catch {
          /* 忽略 */
        }
      }
      renderTasks.current.clear()
    }

    // 可见页优先（IntersectionObserver 预取 ~1500px）；当前页邻页立即渲染。
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const idx = Number((en.target as HTMLElement).dataset.page)
          // 连续滚动模式下可能同时有多页可见：按视口维护集合，不能只保留「最后一页」
          if (en.isIntersecting) {
            visibleRef.current.add(idx)
            enqueue(idx)
          } else {
            visibleRef.current.delete(idx)
          }
        }
      },
      { root: c, rootMargin: '3200px 0px' }
    )
    c.querySelectorAll<HTMLElement>('.scrollpage').forEach((el) => io.observe(el))
    // 第二个观察器只报「真正在视口内」的页：连续滚动/高缩放下可能同时有多页，
    // 这些页必须优先渲染，不能只保留「当前页」。
    const ioViewport = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const idx = Number((en.target as HTMLElement).dataset.page)
          if (en.isIntersecting) viewportRef.current.add(idx)
          else viewportRef.current.delete(idx)
        }
      },
      { root: c }
    )
    c.querySelectorAll<HTMLElement>('.scrollpage').forEach((el) => ioViewport.observe(el))
    // 当前页 + 翻页方向优先，再补反方向（快速连翻时目标页大概率已就绪）
    const cur0 = currentPageRef.current - 1
    const dir0 = dirRef.current
    for (let d = 0; d <= 2; d++) {
      enqueue(cur0 + d * dir0)
      enqueue(cur0 - d * dir0)
    }

    // Only viewport and nearby pages are rendered. Full-document search uses the text index.
    return () => {
      io.disconnect()
      ioViewport.disconnect()
      viewportRef.current.clear()
      visibleRef.current.clear()
      cancelInFlight()
    }
  }, [doc, layout?.fit, effRender, containerRef, numPages, dpr])

  // 批注层
  useEffect(() => {
    const c = containerRef.current
    if (!c || readOnly) return
    let cancelled = false
    void (async () => {
      for (let i = 0; i < numPages; i++) {
        const layer = c.querySelector<HTMLElement>(`[data-ann="${i}"]`)
        if (!layer) continue
        const pageAnns = annotations.filter((a) => a.page_index === i)
        if (pageAnns.length === 0) {
          layer.replaceChildren()
          continue
        }
        let vp = viewports.current.get(i)
        if (!vp) {
          const p = await doc.getPage(i + 1)
          vp = p.getViewport({ scale: effRender })
          viewports.current.set(i, vp)
        }
        if (cancelled) return
        layer.replaceChildren()
        for (const a of pageAnns) {
          let pos: AnnotationPosition
          try {
            pos = JSON.parse(a.position) as AnnotationPosition
          } catch {
            continue
          }
          const rects = pos.rects ?? []
          if (rects.length === 0) continue
          if (a.type === 'note') {
            const box = pdfRectToViewportRect(rects[0], vp)
            const el = document.createElement('div')
            el.className = 'ann ann--note'
            el.dataset.key = a.key
            el.style.left = `${box.left}px`
            el.style.top = `${box.top}px`
            el.style.background = a.color ?? NOTE_COLOR
            el.textContent = '🗒'
            el.title = a.comment ?? ''
            el.addEventListener('click', (ev) => {
              ev.stopPropagation()
              onOpenAnn(a, ev.clientX, ev.clientY)
            })
            layer.appendChild(el)
          } else {
            for (const r of rects) {
              const box = pdfRectToViewportRect(r, vp)
              const el = document.createElement('div')
              el.className = `ann ann--${a.type === 'highlight' ? 'underline' : a.type}`
              el.dataset.key = a.key
              el.style.left = `${box.left}px`
              el.style.top = `${box.top}px`
              el.style.width = `${box.width}px`
              el.style.height = `${box.height}px`
              if (a.type === 'underline' || a.type === 'highlight') el.style.borderBottomColor = resolveHighlight(a.color).hex
              else {
                // 逐色高亮：颜色与不透明度都由色板给出，叠加时 multiply 只加深不糊字
                const spec = resolveHighlight(a.color)
                el.style.setProperty('--ann-color', spec.hex)
                el.style.setProperty('--ann-alpha', String(spec.alpha))
                el.style.setProperty('--ann-alpha-dark', String(spec.darkAlpha))
              }
              el.addEventListener('click', (ev) => {
                ev.stopPropagation()
                onOpenAnn(a, ev.clientX, ev.clientY)
              })
              layer.appendChild(el)
            }
          }
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [annotations, layout, effRender, numPages, containerRef, doc, onOpenAnn, readOnly])

  // 跨窗联动高亮层（只读覆盖）：按页 + 矩形近似定位，跟随缩放/布局重绘
  useEffect(() => {
    const c = containerRef.current
    if (!c) return
    let cancelled = false
    void (async () => {
      // 先清空所有 sync 层（切换页/清空选择时也要清）
      c.querySelectorAll<HTMLElement>('[data-sync]').forEach((l) => l.replaceChildren())
      if (!syncRects || syncRects.rects.length === 0) return
      const i = syncRects.page - 1
      if (i < 0 || i >= numPages) return
      const layer = c.querySelector<HTMLElement>(`[data-sync="${i}"]`)
      if (!layer) return
      let vp = viewports.current.get(i)
      if (!vp) {
        const p = await doc.getPage(i + 1)
        vp = p.getViewport({ scale: effRender })
        viewports.current.set(i, vp)
      }
      if (cancelled) return
      layer.replaceChildren()
      for (const r of syncRects.rects) {
        const box = pdfRectToViewportRect(r, vp)
        const el = document.createElement('div')
        el.className = 'sync-rect'
        el.style.left = `${box.left}px`
        el.style.top = `${box.top}px`
        el.style.width = `${box.width}px`
        el.style.height = `${box.height}px`
        layer.appendChild(el)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [syncRects, layout, effRender, numPages, containerRef, doc])

  /**
   * 当前滚动位置 → 「源页 + 页内比例」锚点（对照阅读按页对齐，不按全文档比例）。
   * 用**视口中线**判定：末页无法滚到顶部（scrollTop 被 clamp），
   * 按顶边会把末页误判成上一页（页码/联动来回跳）。
   */
  const scrollAnchor = (c: HTMLElement): { page: number; frac: number } => {
    // 隐藏的视图没有真实布局：offsetTop 全为 0，按中线推导只会得到末页。
    // 直接返回当前页码，避免把错误锚点发给另一侧。
    if (c.clientHeight === 0) return { page: currentPageRef.current, frac: 0 }
    const mid = c.scrollTop + c.clientHeight / 2
    // 纯函数层：最后一个 offsetTop <= mid 的页胜出（与旧内联循环逐项等价），用于单测覆盖
    return locateByMid(mid, readScrollPageBoxes(c))
  }

  // 滚动时同步当前页码 + **按源页的锚点**（供「中英对照」联动另一侧）
  useEffect(() => {
    const c = containerRef.current
    if (!c) return
    let raf = 0
    const onScroll = (): void => {
      lastScrollAtRef.current = Date.now()
      // 隐藏（display:none）的一侧 clientHeight 为 0，所有 .scrollpage 的 offsetTop 也都是 0：
      // 这时候按视口中线推导必然算出末页，再把末页写回共享页码，会把另一侧一起拽到末页
      // （表现为「切回原文跳到 12/12」）。隐藏期间不参与页码推导，等可见后再对齐。
      if (c.clientHeight === 0) return
      // 页面尚未完成布局时（刚切进/切出对照，.scrollpage 全部还叠在 offsetTop=0），
      // 按视口中线推导会算出「末页」并写回共享页码，把另一侧一起拽到末页。
      // 此时只跳过页码推导，等布局就绪后的下一次滚动或 align() 再接管。
      if (c.querySelectorAll('.scrollpage').length > 1) {
        const cells = Array.from(c.querySelectorAll<HTMLElement>('.scrollpage'))
        if (cells.every((el) => el.offsetTop === 0)) return
      }
      // 滚动中标记：CSS 据此把「从未出图的页」的骨架动画换成静态占位，
      // 否则连续翻页会扫过一串仍在渐变动画的骨架块，看起来就是整页闪白。
      if (c.dataset.scrolling !== '1') c.dataset.scrolling = '1'
      if (scrollIdleTimerRef.current) window.clearTimeout(scrollIdleTimerRef.current)
      scrollIdleTimerRef.current = window.setTimeout(() => {
        scrollIdleTimerRef.current = null
        delete c.dataset.scrolling
      }, 300)
      // 边缘标记：翻页按钮「还能不能翻」与页码解耦，只看滚动是否贴顶/贴底
      // （值不变时不外发，避免每个滚动事件都触发一次工具栏重渲染）
      const nextEdges = scrollEdgeFlags({
        scrollTop: c.scrollTop,
        viewport: c.clientHeight,
        scrollHeight: c.scrollHeight
      })
      if (nextEdges.top !== lastScrollEdgesRef.current.top || nextEdges.bottom !== lastScrollEdgesRef.current.bottom) {
        lastScrollEdgesRef.current = nextEdges
        onScrollEdgesRef.current?.(nextEdges)
      }
      // 锚点上报给另一侧（幂等）。
      // 但若本次滚动正是「由另一侧同步而来」，则不再回传——否则两侧会互相拉扯成振荡。
      if (onScrollAnchor && !raf && !applyingScrollRef.current && !programmaticRef.current) {
        raf = requestAnimationFrame(() => {
          raf = 0
          if (applyingScrollRef.current || programmaticRef.current) return
          const _a = scrollAnchor(c)
          pushSyncDebug('send', _a)
          onScrollAnchor(_a)
        })
      }
      if (suppress.current) {
        // 跳页后的抑制窗口内，如果滚动位置已经离开落点，说明用户自己接管了
        // （滚轮/拖动滚动条/键盘 PageDown 都可能不触发 wheel/pointerdown）。
        // 这时立即解除抑制并同步页码，避免工具栏在 600ms 内一直显示旧页，
        // 用户此时点「下一页」会从错误页码起跳。
        if (Math.abs(c.scrollTop - jumpTopRef.current) > 4) {
          suppress.current = false
          programmaticRef.current = false
        } else {
          return
        }
      }
      // 用视口中线判定当前页：末页无法滚到顶部时，按顶边会误判成上一页
      const mid = c.scrollTop + c.clientHeight / 2
      const cur = locateByMid(mid, readScrollPageBoxes(c)).page + 1
      if (cur !== currentPage) {
        // 记录：这次页码变化来自用户滚动 → 只更新页码/预取，不做程序化定位
        // （否则自然滚动跨过页中点时会被强行吸到下一页页首）。
        scrollDrivenRef.current = true
        // 按「页码」记账（见 scrollDrivenPageRef 注释）：不依赖定时窗口，
        // 慢帧下也不会把滚动带来的换页误判成显式翻页。
        scrollDrivenPageRef.current = cur
        // 防残留：滚动未能真正触发页码 effect 时（父级归一化等），布尔标志必须在短窗口内失效，
        // 否则下一次「显式翻页」会被误判成滚动驱动而跳过定位。
        window.setTimeout(() => {
          scrollDrivenRef.current = false
        }, 250)
        onPageChange(cur)
      }
    }
    c.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      c.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
      if (scrollIdleTimerRef.current) {
        window.clearTimeout(scrollIdleTimerRef.current)
        scrollIdleTimerRef.current = null
        delete c.dataset.scrolling
      }
    }
  }, [containerRef, currentPage, onPageChange, layout, onScrollAnchor, followOnly])

  // 用户主动交互：跳页后的抑制窗口内，若用户已经接管滚动，就不再“自愈”拽回页首
  useEffect(() => {
    const c = containerRef.current
    if (!c) return
    const bump = (): void => {
      onUserScroll?.()
      userNavRef.current++
      // 用户已经主动接管：立即解除跳页抑制，避免随后 600ms 内
      // 的滚动不改页码/被“自愈”拽回目标页。
      if (programmaticRef.current) {
        programmaticRef.current = false
        suppress.current = false
      }
    }
    c.addEventListener('wheel', bump, { passive: true })
    c.addEventListener('touchstart', bump, { passive: true })
    c.addEventListener('pointerdown', bump, { passive: true })
    return () => {
      c.removeEventListener('wheel', bump)
      c.removeEventListener('touchstart', bump)
      c.removeEventListener('pointerdown', bump)
    }
  }, [containerRef, onUserScroll])

  // 外部锚点（源页 + 页内比例）→ 同步到该位置（期间不回传，避免两侧互相拉扯振荡）
  const lastSyncNonce = useRef(0)
  const applyingScrollRef = useRef(false)
  useEffect(() => {
    if (!syncAnchor || syncAnchor.nonce === lastSyncNonce.current) return
    lastSyncNonce.current = syncAnchor.nonce
    const c = containerRef.current
    if (!c) return
    const max = c.scrollHeight - c.clientHeight
    if (max <= 0) return
    const el = c.querySelector<HTMLElement>(`[data-page="${syncAnchor.page}"]`)
    if (!el) return
    pushSyncDebug('apply', syncAnchor)
    applyingScrollRef.current = true
    const frac = Math.min(1, Math.max(0, syncAnchor.frac))
    // 发送端 frac 相对「视口中线」；接收端必须减去目标视口半高，否则同页也会偏半屏。
    const target = el.offsetTop + frac * el.offsetHeight - c.clientHeight / 2
    c.scrollTop = Math.max(0, Math.min(max, target))
    const started = Date.now()
    const settle = (): void => {
      if (Date.now() - started > 150) {
        applyingScrollRef.current = false
        return
      }
      requestAnimationFrame(settle)
    }
    requestAnimationFrame(settle)
  }, [syncAnchor, containerRef])

  // 视图从隐藏恢复（原文 ↔ 中英对照切换、分栏显隐）时按共享页码重新对齐一次：
  // 隐藏期间 clientHeight 为 0，scrollTop/offsetTop 都不可信，恢复后必须 seek 回去，
  // 否则会出现「页码 12/12 但内容停在第 1 页」或「页码 5/12 内容却是第 12 页」。
  useEffect(() => {
    const c = containerRef.current
    if (!c || typeof ResizeObserver === 'undefined') return
    let wasHidden = c.clientHeight === 0
    const align = (): void => {
      const el = c.querySelector<HTMLElement>(`[data-page="${currentPageRef.current - 1}"]`)
      if (!el) return
      if (Math.abs(el.offsetTop - c.scrollTop) <= 8) return
      applyingScrollRef.current = true
      c.scrollTop = el.offsetTop
      window.setTimeout(() => {
        applyingScrollRef.current = false
      }, 150)
    }
    const ro = new ResizeObserver(() => {
      const hidden = c.clientHeight === 0
      if (wasHidden && !hidden) align()
      wasHidden = hidden
    })
    ro.observe(c)
    if (!wasHidden) align()
    return () => ro.disconnect()
  }, [containerRef])

  // 页码跳转 / 深链 → 滚动到目标页（只跟随侧不做跳页）
  useEffect(() => {
    if (!layout || followOnly) return
    const c = containerRef.current
    const el = c?.querySelector<HTMLElement>(`[data-page="${currentPage - 1}"]`)
    if (!c || !el) return
    // 页码没变、只是布局/缩放变了 → 不要重新定位。
    // 否则 ResizeObserver 改 fit 时会反复把滚动位置吸到页首（表现为「页面抽动」）。
    const pageChanged = lastNavPageRef.current !== currentPage
    lastNavPageRef.current = currentPage
    // 页码是「用户滚动」带来的变化 → 只更新方向/预取，绝不做程序化定位。
    // 判定同时看布尔标志与「滚动算出的目标页」：后者不依赖 250ms 定时窗口，
    // 主线程被在位图渲染占住、超时先触发时也不会把滚动换页误判成显式翻页。
    const driven = scrollDrivenRef.current || scrollDrivenPageRef.current === currentPage
    scrollDrivenRef.current = false
    scrollDrivenPageRef.current = null
    // 翻页方向：决定预取哪一侧
    const jumpDelta = currentPage - prevPageRef.current
    const dir = jumpDelta >= 0 ? 1 : -1
    dirRef.current = dir
    prevPageRef.current = currentPage
    // 导航版本 +1：此前的在途渲染若已过期，不再提交画面（避免旧页闪回）
    navVersion.current++
    const cur = currentPage - 1
    if (Math.abs(jumpDelta) >= 2) {
      // 多页跳转（跳页/连按）：合并中间请求，取消远处的在途渲染
      pruneQueueRef.current?.(cur)
    } else {
      // 逐页翻/连续滚动：不要取消预取，否则窗口内的页会停在空白
      enqueueRef.current?.(cur)
    }
    enqueueRef.current?.(cur + dir)
    enqueueRef.current?.(cur + dir * 2)
    releaseDistantRef.current?.()
    if (pageChanged && !driven && Math.abs(el.offsetTop - c.scrollTop) > 8) {
      // 「上一页/下一页」按钮经共享受控页码产生 **±1** 的页码变化：
      // 阅读停在一页中部/尾部时不再整页吸顶，而是按**半个视口**连续推进/回退，
      // 页边界处自然呈现「上一页下半 + 下一页上半」的连续视图；
      // 页码指示与对照联动随后由 onScroll 的 midline 判页与锚点机制继续校正。
      // 输入框/目录等显式跳页（页差 ≥2）与「已对齐页首」的 ±1 仍走整页定位。
      if (Math.abs(jumpDelta) === 1) {
        c.scrollTop = halfPageScrollTop({
          scrollTop: c.scrollTop,
          viewport: c.clientHeight,
          scrollMax: Math.max(0, c.scrollHeight - c.clientHeight),
          dir: jumpDelta >= 0 ? 1 : -1
        })
      } else {
        suppress.current = true
        // 程序化滚动期间不回传滚动比例（否则会与另一侧的比例同步互相拉扯）
        programmaticRef.current = true
        // 直接设置 scrollTop（瞬时定位，避免任何平滑滚动/轮询带来的滞后）
        c.scrollTop = el.offsetTop
        const navAtJump = userNavRef.current
        // 跳页落点：用于区分「布局/重排导致 offsetTop 变化」与「用户真的滚走了」。
        // 键盘 PageUp/PageDown 和拖动滚动条不一定触发 wheel/pointerdown，
        // 只看 userNavRef 会把用户的滚动误判成布局变化，然后硬拽回目标页。
        const jumpTop = c.scrollTop
        jumpTopRef.current = jumpTop
        // 固定 600ms 抑制窗口：覆盖「适应宽度/布局重排」导致的 offsetTop 变化，
        // 避免跳页后页码检测读到相邻页而"逐页下滑"（1↔N 振荡/漂移）
        if (jumpTimerRef.current) window.clearTimeout(jumpTimerRef.current)
        jumpTimerRef.current = window.setTimeout(() => {
          jumpTimerRef.current = null
          jumpTopRef.current = 0
          programmaticRef.current = false
          suppress.current = false
          const scrolledByUser = Math.abs(c.scrollTop - jumpTop) > 4
          const userTookOver = userNavRef.current !== navAtJump || scrolledByUser
          // 自愈：跳页后的 600ms 内如果布局变了（适应宽度/字体/分栏），
          // 目标页的 offsetTop 会变化 → 页码与内容脱节（工具栏 2/2，内容还在第 1 页）。
          // 但用户已经自己滚动时不得拽回（那会打断阅读）。
          const el2 = c.querySelector<HTMLElement>(`[data-page="${currentPage - 1}"]`)
          if (!userTookOver && el2 && Math.abs(el2.offsetTop - c.scrollTop) > 8) {
            c.scrollTop = el2.offsetTop
          }
          // 不论是否用户接管，都用实际滚动位置校正页码：
          // 旧实现在抑制窗口内滚动后不校正，工具栏会一直停在跳页前的页码，
          // 出现「内容在 PDF 第 2 页、页码却显示第 3 页」的错位。
          const mid = c.scrollTop + c.clientHeight / 2
          const cur2 = locateByMid(mid, readScrollPageBoxes(c)).page + 1
          if (cur2 !== currentPage) onPageChange(cur2)
          // 跳页完成后主动上报一次锚点：让「联动」的另一侧跟到**同一源页**（单向同步）
          if (onScrollAnchor) {
            const _a = scrollAnchor(c)
            pushSyncDebug('send', _a)
            onScrollAnchor(_a)
          }
        }, 600)
      }
    }
  }, [currentPage, layout, containerRef, effRender, followOnly, onPageChange, onScrollAnchor])

  // 文档重载/版面首次就绪时，页码状态可能已是第 N 页，但新增的页面元素 offsetTop 仍是 0：
  // 上一次跳页在布局完成前执行，之后 page 没变就不会再对齐，表现为「页码 11 / 内容却是第 1 页」。
  // 跟随侧（followOnly）平时由 syncAnchor 驱动，只在**换文档**时补一次定位，
  // 否则重译后译文窗会停在第 1 页。
  const seenDocRef = useRef<PDFDocumentProxy | null>(null)
  useEffect(() => {
    if (!layout || numPages <= 0) return
    if (followOnly && seenDocRef.current === doc) return
    const c = containerRef.current
    const el = c?.querySelector<HTMLElement>(`[data-page="${currentPage - 1}"]`)
    if (!c || !el) return
    seenDocRef.current = doc
    if (Math.abs(el.offsetTop - c.scrollTop) <= 8) return
    suppress.current = true
    programmaticRef.current = true
    c.scrollTop = el.offsetTop
    const top = c.scrollTop
    jumpTopRef.current = top
    const navAtJump = userNavRef.current
    window.setTimeout(() => {
      if (userNavRef.current === navAtJump && Math.abs(c.scrollTop - top) < 40) {
        jumpTopRef.current = 0
        suppress.current = false
        programmaticRef.current = false
      }
    }, 650)
  }, [layout, numPages, doc, containerRef, followOnly, currentPage])

  // 卸载时清掉「跳页延迟上报」定时器
  useEffect(
    () => () => {
      if (jumpTimerRef.current) window.clearTimeout(jumpTimerRef.current)
    },
    []
  )

  // 深链：批注闪烁定位
  useEffect(() => {
    if (!flashKey) return
    let stopped = false
    let tries = 0
    const attempt = (): void => {
      if (stopped) return
      const el = containerRef.current?.querySelector<HTMLElement>(`[data-key="${flashKey}"]`)
      if (el) {
        el.scrollIntoView({ block: 'center' })
        // 选中态（比悬停更明确）：闪烁期间保持描边，结束后清掉
        el.classList.add('ann--flash', 'is-active')
        window.setTimeout(() => el.classList.remove('ann--flash', 'is-active'), 2600)
        return
      }
      if (tries++ < 20) window.setTimeout(attempt, 250)
    }
    attempt()
    return () => {
      stopped = true
    }
  }, [flashKey, flashNonce, containerRef, annotations])

  const handleMouseUp = useCallback(async (): Promise<void> => {
    const hlReg = (CSS as unknown as { highlights?: { set(k: string, h: unknown): void; delete(k: string): void } })
      .highlights
    const HLC = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      // 只读（译文）窗格：清空跨窗高亮；可编辑窗格：关闭划词工具条
      hlReg?.delete('paperdesk-sel')
      if (readOnly) onSelectionRectsRef?.current?.(null)
      else onSelection(null)
      return
    }
    const anchor = sel.anchorNode
    const host = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest(
      '.scrollpage'
    ) as HTMLElement | null
    if (!host) return
    const i = Number(host.dataset.page)
    const textDiv = host.querySelector<HTMLElement>('[data-text]')
    if (!textDiv || !textDiv.contains(sel.anchorNode) || !textDiv.contains(sel.focusNode)) return
    // 文本层会把同一个数学符号画成多个重叠 span，原生 toString() 会输出 𝒯𝒯/𝒫𝒫 这类重复，
    // 与高亮范围和浮层预览不一致（复制出来的公式也是坏的）→ 统一走清理入口。
    const text = normalizeSelectionText(sel.toString()).trim()
    if (!text) return
    const range = sel.getRangeAt(0)
    // 保持选中可见：弹层获得焦点后浏览器原生高亮会消失 → 用 Custom Highlight 上色
    if (hlReg && HLC && !readOnly) {
      try {
        hlReg.set('paperdesk-sel', new HLC(range.cloneRange()))
      } catch {
        /* 忽略 */
      }
    }
    const rawRects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1)
    if (rawRects.length === 0) return
    let vp = viewports.current.get(i)
    if (!vp) {
      const p = await doc.getPage(i + 1)
      vp = p.getViewport({ scale: effRender })
      viewports.current.set(i, vp)
    }
    const cr = host.getBoundingClientRect()
    const rects = clientRectsToPdfRects(rawRects, cr.left, cr.top, vp)
    // 只读（译文）窗格：只回传「页码 + 矩形」用于跨窗联动高亮，不弹出划词工具条
    if (readOnly) {
      onSelectionRectsRef?.current?.({ page: i + 1, rects })
      return
    }
    const full = textDiv.textContent ?? ''
    const idx = full.indexOf(text)
    const prefix = idx >= 0 ? full.slice(Math.max(0, idx - 40), idx) : null
    const suffix = idx >= 0 ? full.slice(idx + text.length, idx + text.length + 40) : null
    const bounds = range.getBoundingClientRect()
    ;(window as unknown as { __lastSel?: unknown }).__lastSel = {
      text: text.slice(0, 40),
      n: rects.length,
      page: i,
      bounds: { x: bounds.left, y: bounds.bottom }
    }
    onSelection({ pageIndex: i, x: bounds.left, y: bounds.bottom, rects, text, prefix, suffix })
  }, [readOnly, doc, effRender, onSelection])

  // ---- 图表引用：点击 "Fig. 2a" / "图 3" 之类 → 弹出对应图表（纯脚本定位，不调 AI）----
  const [figPop, setFigPop] = useState<{
    n: number
    letter: string
    kind: 'figure' | 'table'
    label: string
    left: number
    top: number
    w: number
    h: number
    region: [number, number, number, number]
    pageIndex: number
    pageH: number
    scale: number
  } | null>(null)
  const figCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [figZoom, setFigZoom] = useState(1)

  // 换图表时恢复 1x，避免上一个图表的放大倍率带过来
  useEffect(() => {
    setFigZoom(1)
  }, [figPop?.pageIndex, figPop?.n])

  /** 在已加载的 PDF 里找 "Fig/Figure/Table N[letter]" 题注（脚本匹配，无需网络） */
  const findCaption = useCallback(
    async (
      n: number,
      letter: string,
      kind: 'figure' | 'table' | 'any' = 'any'
    ): Promise<{ pageIndex: number; page: PDFPageProxy; item: { str: string; transform: number[] }; kind: 'figure' | 'table' } | null> => {
      for (let i = 0; i < numPages; i++) {
        let p: PDFPageProxy
        try {
          p = await doc.getPage(i + 1)
        } catch {
          continue
        }
        const tc = await p.getTextContent()
        for (const raw of tc.items as Array<{ str?: string; transform?: number[] }>) {
          const t = String(raw.str ?? '').trim()
          if (!t || !raw.transform) continue
          const m = /^(fig(?:ure)?|tab(?:le)?|图|表)\.?\s*0*(\d+)\s*([a-z])?/i.exec(t)
          if (!m) continue
          if (Number(m[2]) !== n) continue
          if (letter && m[3] && m[3].toLowerCase() !== letter) continue
          const kw = m[1].toLowerCase()
          const capKind: 'figure' | 'table' = kw.startsWith('tab') || kw === '表' ? 'table' : 'figure'
          // 关键：区分表格与图 —— 引用「Table 1」不能匹配到「Figure 1」
          if (kind !== 'any' && capKind !== kind) continue
          return { pageIndex: i, page: p, item: { str: t, transform: raw.transform }, kind: capKind }
        }
      }
      return null
    },
    [doc, numPages]
  )

  // ---- 原文引用角标 → 文末参考文献跳转（脚本匹配，不用 AI）----
  const [refPick, setRefPick] = useState<{
    x: number
    y: number
    items: Array<{ n: number; pageIndex: number; text: string }>
  } | null>(null)

  /** 在文末「References / 参考文献」区查找编号对应的条目 */
  const findRefEntries = useCallback(
    async (nums: number[]): Promise<Array<{ n: number; pageIndex: number; text: string }>> => {
      const items: Array<{ pageIndex: number; str: string }> = []
      for (let i = 0; i < numPages; i++) {
        let p: PDFPageProxy
        try {
          p = await doc.getPage(i + 1)
        } catch {
          continue
        }
        const tc = await p.getTextContent()
        for (const raw of tc.items as Array<{ str?: string }>) {
          const t = String(raw.str ?? '')
          if (t.trim()) items.push({ pageIndex: i, str: t })
        }
      }
      // References 区起点（找不到标题则退化为全文查找）
      let start = 0
      for (let i = 0; i < items.length; i++) {
        if (/^\s*(references|bibliography|literature cited|参考文献)\s*$/i.test(items[i].str)) {
          start = i
          break
        }
      }
      const out: Array<{ n: number; pageIndex: number; text: string }> = []
      for (const n of nums) {
        const re = new RegExp(`^\\s*\\[?\\s*0*${n}\\s*[\\].)]`)
        const hit = items.slice(start).find((it) => re.test(it.str))
        if (hit) out.push({ n, pageIndex: hit.pageIndex, text: hit.str.trim() })
      }
      return out
    },
    [doc, numPages]
  )

  /** 跳到某条参考文献并闪烁（切页 → 等渲染后按文本前缀定位 span） */
  const jumpToRef = useCallback(
    (item: { pageIndex: number; text: string }): void => {
      onPageChange(item.pageIndex + 1)
      const key = item.text.replace(/\s+/g, ' ').slice(0, 14)
      let tries = 0
      const tick = (): void => {
        const c = containerRef.current
        const span = c
          ? Array.from(c.querySelectorAll<HTMLElement>('.textLayer span')).find((s) =>
              (s.textContent ?? '').replace(/\s+/g, ' ').trim().startsWith(key)
            )
          : null
        if (span) {
          span.scrollIntoView({ block: 'center', behavior: 'smooth' })
          span.classList.add('fn-flash')
          window.setTimeout(() => span.classList.remove('fn-flash'), 1600)
        } else if (tries++ < 24) {
          window.setTimeout(tick, 150)
        }
      }
      window.setTimeout(tick, 250)
    },
    [onPageChange, containerRef]
  )

  // ---- 原文定位：跳到某页并高亮该区域（图表/公式预览的「定位原文」）----
  const [flashBox, setFlashBox] = useState<{
    pageIndex: number
    rect: Rect4
    pageH: number
  } | null>(null)
  const flashToRegion = useCallback(
    (pageIndex: number, rect: Rect4, pageH: number): void => {
      onPageChange(pageIndex + 1)
      setFlashBox({ pageIndex, rect, pageH })
      window.setTimeout(() => setFlashBox(null), 2200)
    },
    [onPageChange]
  )

  // ---- 引用定位：跳页后高亮命中的模块区域（与图表/公式的「定位原文」同一机制）----
  useEffect(() => {
    if (!focusRect || !focusPage) return
    let cancelled = false
    void (async () => {
      try {
        const p = await doc.getPage(focusPage)
        const vb = p.view as number[]
        const h = vb[3] - vb[1]
        if (!cancelled) flashToRegion(focusPage - 1, focusRect, h)
      } catch {
        /* 忽略 */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flashNonce])

  // ---- 解析检查联动：选中块 → PDF 高亮遮罩（坐标换算走 block-overlay 纯函数）----
  // 坐标系说明：blocks 适配层（python/app/blocks_adapter.py to_bottom）的 sourceRegion.rect
  // 与 PyMuPDF page.rect 同系（已含页面 rotation 的展示坐标、底边原点、y 向上），
  // 因此换算时 rotation 恒为 0；页面尺寸用该页的展示尺寸（pageSizes，scale=1 已含 rotation）。
  // 选中块缺失/区域无效/页码不匹配当前页时都不画（不改变默认阅读行为）。
  const highlightPageIndex = ((): number => {
    const region = selectedBlock?.sourceRegion
    if (
      !region ||
      !Number.isFinite(region.page) ||
      !Array.isArray(region.rect) ||
      region.rect.length !== 4
    ) {
      return -1
    }
    if (!region.rect.every((v) => Number.isFinite(v))) return -1
    return Math.round(region.page) - 1
  })()
  // 跨页跳转：选中的块不在当前页时先把页码切过去（页码变化驱动滚动定位），矩形随后再画
  const highlightRequestedRef = useRef<number>(-1)
  useEffect(() => {
    if (highlightPageIndex < 0 || highlightRequestedRef.current === highlightPageIndex) return
    highlightRequestedRef.current = highlightPageIndex
    onPageChange(highlightPageIndex + 1)
  }, [highlightPageIndex, onPageChange])
  // 当前页已占位时换算 CSS 矩形（clamp 到页面边界；未选中/无效时为 null，不渲染遮罩）
  const highlightRegion = highlightPageIndex >= 0 ? (selectedBlock?.sourceRegion ?? null) : null
  const highlightPageSize = highlightPageIndex >= 0 ? pageSizes[highlightPageIndex] : undefined
  const highlightBox =
    highlightRegion && highlightPageSize
      ? clampRect(
          toCssRect(
            { page: highlightPageIndex + 1, rect: highlightRegion.rect },
            { width: highlightPageSize.w, height: highlightPageSize.h },
            { scale: effRender, rotation: 0 }
          ),
          {
            width: Math.max(0, highlightPageSize.w) * effRender,
            height: Math.max(0, highlightPageSize.h) * effRender
          }
        )
      : null

  // ---- 反向联动：页面点选 → hitBlockAt 命中最小包含块 → 上报 stableId ----
  // 划词守卫：有非空文本选区时不派发块命中，避免选中文字被误判成块点选。
  const handlePagePickClick = useCallback(
    (pageNo: number, e: React.MouseEvent<HTMLDivElement>): void => {
      if (!onBlockPicked || !blocks || blocks.length === 0) return
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed && sel.toString().length > 0) return
      const r = e.currentTarget.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return
      // .scrollpages__inner 以 top center 为原点做 transform: scale(zoomK)：
      // 原点项在差值里相消，clientX - r.left 恰为页内布局坐标 × zoomK，除回去即得
      // 「页面内 CSS 坐标」（与 effRender 同一展示坐标系）。
      const zoom = zoomK > 0 ? zoomK : 1
      const cssX = (e.clientX - r.left) / zoom
      const cssY = (e.clientY - r.top) / zoom
      const pageSize = pageSizes[pageNo]
      if (!pageSize || pageSize.w <= 0 || pageSize.h <= 0) return
      // pageSizes 是 scale=1 的展示尺寸（已含旋转），与 selectedBlock 高亮遮罩
      // 的换算约定一致：scale=effRender、rotation=0。
      const hit = hitBlockAt(
        { x: cssX, y: cssY, page: pageNo + 1 },
        blocks,
        pageSizes.map((p) => ({ width: p.w, height: p.h })),
        { scale: effRender, rotation: 0 }
      )
      if (hit) onBlockPicked(hit.stableId)
    },
    [onBlockPicked, blocks, pageSizes, effRender, zoomK]
  )

  // ---- 公式模块：点击公式 → 弹窗查看/复制/下载 LaTeX（按需识别并缓存）----
  const [formulaPop, setFormulaPop] = useState<{
    id: string
    pageIndex: number
    pageH: number
    rect: Rect4
    n: string | null
    text: string
    latex: string
    source: 'extracted' | 'recognized' | null
    left: number
    top: number
    busy: boolean
    msg: string
    /** 质量标记（来自公式明细表）：是否为公式 / 还原是否可靠 / 状态 */
    det: number | null
    rec: number | null
    status: 'accepted' | 'needs_review' | 'failed' | null
    raw: string
    validation: FormulaValidation | null
  } | null>(null)

  const showFormula = useCallback(
    (f: FormulaModule, cx: number, cy: number): void => {
      const pg = structured?.pages.find((p) => p.page === f.page)
      setFormulaPop({
        id: f.id,
        pageIndex: f.page - 1,
        pageH: pg?.h && pg.h > 0 ? pg.h : 792,
        rect: f.rect,
        n: f.n,
        text: f.text,
        latex: f.latex ?? '',
        source: f.latexSource ?? null,
        left: Math.max(8, Math.min(cx + 12, window.innerWidth - 360)),
        top: Math.max(8, Math.min(cy + 12, window.innerHeight - 240)),
        busy: false,
        msg: f.latex
          ? ''
          : f.status === 'failed'
            ? '未能可靠还原（已保留原文，可对照原公式）'
            : '尚未提取/识别 LaTeX',
        det: f.detectionConfidence ?? null,
        rec: f.reconstructionConfidence ?? null,
        status: f.status ?? null,
        raw: f.rawText ?? f.text ?? '',
        validation: (f.validationResults as FormulaValidation | null) ?? null
      })
    },
    [structured]
  )

  const formulaCanvasRef = useRef<HTMLCanvasElement | null>(null)
  // 公式截图（原公式，供核对）：用 pdf.js 只画该区域
  useEffect(() => {
    const f = formulaPop
    if (!f) return
    let cancelled = false
    void (async () => {
      const canvas = formulaCanvasRef.current
      if (!canvas) return
      try {
        const page = await doc.getPage(f.pageIndex + 1)
        // 位图按 dpr 放大（高分屏清晰）；viewport 同步乘 dpr，p1/p2 与 transform
        // 都在同一个视口空间里，缩放后位置不变。
        const scale = Math.max(1, Math.min(3, effRender || 2)) * dpr
        const viewport = page.getViewport({ scale })
        const [rx0, ry0, rx1, ry1] = f.rect
        const p1 = viewport.convertToViewportPoint(rx0, ry1)
        const p2 = viewport.convertToViewportPoint(rx1, ry0)
        const minX = Math.min(p1[0], p2[0])
        const minY = Math.min(p1[1], p2[1])
        canvas.width = Math.max(1, Math.round(Math.abs(p2[0] - p1[0])))
        canvas.height = Math.max(1, Math.round(Math.abs(p2[1] - p1[1])))
        // 位图按 dpr 放大后必须把 CSS 宽度写回 1/dpr：否则弹窗会被放大 dpr 倍。
        // 高度交给 .figpop__canvas 的 height:auto 按位图比例还原（max-width 收缩时也不变形）。
        canvas.style.width = `${Math.max(1, Math.round(canvas.width / dpr))}px`
        canvas.style.height = ''
        const ctx2d = canvas.getContext('2d')
        if (!ctx2d) return
        await page.render({
          canvasContext: ctx2d,
          viewport,
          transform: [1, 0, 0, 1, -minX, -minY]
        } as Parameters<PDFPageProxy['render']>[0]).promise
      } catch {
        /* 忽略 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [formulaPop, doc, effRender, dpr])

  const downloadFormulaLatex = useCallback(async (latex: string): Promise<void> => {
    try {
      await window.api.translate.saveReport('formula.tex', latex)
    } catch {
      /* 用户取消或写入失败：忽略 */
    }
  }, [])

  const recognizeFormula = useCallback(async (): Promise<void> => {
    if (!formulaPop || attachmentId == null) return
    const f = formulaPop
    setFormulaPop({ ...f, busy: true, msg: '识别中…' })
    try {
      const shot = await window.api.reader.figureImage(
        attachmentId,
        f.pageIndex + 1,
        f.rect,
        Math.max(1, Math.min(3, effRender || 2))
      )
      if (!shot) {
        setFormulaPop({ ...f, busy: false, msg: '无法渲染该公式区域' })
        return
      }
      // 多引擎候选：各自置信度**分别记录**，按引擎阈值选择；选不出可信候选则保留原文
      const res = await window.api.ai.formulaCandidates(shot.png, f.raw || f.text)
      const pick = pickCandidate(res.candidates)
      if (!pick.chosen) {
        const why = [
          ...pick.rejected.map((r) => `${r.engine}: ${r.reason}`),
          ...res.unavailable.map((u) => `${u}: 不可用`),
          ...res.errors.map((e) => `${e.engine}: ${e.error}`)
        ].join('；')
        await window.api.reader.saveModuleLatex(attachmentId, f.id, '', 'recognized', {
          ok: false,
          issues: [`无可信候选（${why || '无引擎可用'}）`],
          missingSymbols: [],
          balanced: false,
          garbleRatio: 0
        })
        setFormulaPop({
          ...f,
          busy: false,
          latex: '',
          source: null,
          status: 'needs_review',
          msg: `无可信识别结果，已保留原文（${why || '无引擎可用'}）`,
          validation: null
        })
        return
      }
      const chosen = pick.chosen
      const ok = await window.api.reader.saveModuleLatex(
        attachmentId,
        f.id,
        chosen.latex,
        'recognized',
        chosen.validation ?? undefined
      )
      if (ok) {
        setFormulaPop({
          ...f,
          busy: false,
          latex: chosen.latex,
          source: 'recognized',
          status: 'needs_review',
          msg: `已选用「${chosen.engine}」结果（置信度 ${(chosen.confidence ?? 0).toFixed(2)}，待复核）`,
          validation: chosen.validation
        })
      } else {
        setFormulaPop({
          ...f,
          busy: false,
          latex: '',
          source: null,
          status: 'needs_review',
          msg: '候选未通过验证，已保留原文',
          validation: chosen.validation
        })
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setFormulaPop({ ...f, busy: false, msg: `识别失败：${m}` })
    }
  }, [formulaPop, attachmentId, effRender])

  const handleFigureRefClick = useCallback(
    async (e: React.MouseEvent): Promise<void> => {
      const target = e.target as HTMLElement | null
      if (!target?.closest('.textLayer')) return
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return // 正在划词，不弹图
      const anyDoc = document as unknown as { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      const range = anyDoc.caretRangeFromPoint ? anyDoc.caretRangeFromPoint(e.clientX, e.clientY) : null
      if (!range || range.startContainer.nodeType !== 3) return
      const nodeText = range.startContainer.textContent ?? ''
      const off = range.startOffset

      // ---- 方括号引用 [1] / [1-3] / [1, 3, 5]：跳到文末对应参考文献（多篇先列出供选择）----
      const brackets = [...nodeText.matchAll(/\[([0-9][0-9,\s\-–]*)\]/g)]
      const bm = brackets.find((m) => off >= (m.index ?? 0) && off <= (m.index ?? 0) + m[0].length)
      if (bm) {
        const nums = parseRefNums(bm[1])
        if (nums.length) {
          const entries = structured
            ? pickRefModules(structured.refs, nums).map((r) => ({
                n: r.n,
                pageIndex: r.page - 1,
                text: r.text
              }))
            : await findRefEntries(nums)
          if (entries.length === 1) {
            jumpToRef(entries[0])
            return
          }
          if (entries.length > 1) {
            setRefPick({ x: e.clientX, y: e.clientY, items: entries })
            return
          }
        }
      }

      // ---- 公式：点击公式所在文本行 → 弹窗查看/复制/下载 LaTeX（按需识别并缓存）----
      if (structured && structured.formulas.length) {
        const spanF = target.closest('.textLayer span') as HTMLElement | null
        const probe = (spanF?.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (probe.length >= 4) {
          const pageElF = target.closest('.scrollpage') as HTMLElement | null
          const pnoF = pageElF ? Number(pageElF.dataset.page) + 1 : -1
          const hitF = structured.formulas.find(
            (f) => f.page === pnoF && (f.text.includes(probe) || probe.includes(f.text))
          )
          if (hitF) {
            showFormula(hitF, e.clientX, e.clientY)
            return
          }
        }
      }

      // ---- 上标数字角标：先试参考文献，再回退到本页底部脚注（脚本判定字号，不用 AI）----
      const spanEl = target.closest('.textLayer span') as HTMLElement | null
      const ch = nodeText[off] ?? ''
      if (spanEl && /^[0-9]$/.test(ch)) {
        const fs = parseFloat(window.getComputedStyle(spanEl).fontSize || '0')
        const pageEl = target.closest('.scrollpage') as HTMLElement | null
        if (pageEl && fs > 0) {
          const spans = Array.from(pageEl.querySelectorAll<HTMLElement>('.textLayer span'))
          const sizes = spans
            .map((s) => parseFloat(window.getComputedStyle(s).fontSize || '0'))
            .filter((x) => x > 0)
            .sort((a, b) => a - b)
          const bodySize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : fs
          if (fs < bodySize * 0.86) {
            // 先按引用编号找文末参考文献（上标数字多为引用角标）
            const supText = (spanEl.textContent ?? '').trim()
            const supNum = /^\d{1,3}$/.test(supText) ? Number(supText) : Number(ch)
            const refEntries = structured
              ? pickRefModules(structured.refs, [supNum]).map((r) => ({
                  n: r.n,
                  pageIndex: r.page - 1,
                  text: r.text
                }))
              : await findRefEntries([supNum])
            if (refEntries.length >= 1) {
              if (refEntries.length === 1) {
                jumpToRef(refEntries[0])
                return
              }
              setRefPick({ x: e.clientX, y: e.clientY, items: refEntries })
              return
            }
            const pageRect = pageEl.getBoundingClientRect()
            const fn = spans.find((s) => {
              const t = (s.textContent ?? '').trim()
              const r = s.getBoundingClientRect()
              return (
                new RegExp(`^${ch}[.\\s)]`).test(t) && r.top > pageRect.top + pageRect.height * 0.55
              )
            })
            if (fn) {
              fn.scrollIntoView({ block: 'center', behavior: 'smooth' })
              fn.classList.add('fn-flash')
              window.setTimeout(() => fn.classList.remove('fn-flash'), 1600)
              return
            }
          }
        }
      }
      const ctx = nodeText.slice(Math.max(0, off - 26), Math.min(nodeText.length, off + 14))
      const withKw = /(?:fig(?:ure)?|tab(?:le)?|图|表)\.?\s*0*(\d+)([a-z])?/i.exec(ctx)
      const before = nodeText.slice(Math.max(0, off - 60), off)
      const bare = /(?:^|[^\w])0*(\d+)([a-z])(?![a-z])/i.exec(ctx)
      let n = 0
      let letter = ''
      let kind: 'figure' | 'table' | 'any' = 'any'
      if (withKw) {
        n = Number(withKw[1])
        letter = (withKw[2] ?? '').toLowerCase()
        kind = /^(tab|表)/i.test(withKw[0]) ? 'table' : 'figure'
      } else if (bare && /fig|tab|图|表/i.test(before)) {
        n = Number(bare[1])
        letter = (bare[2] ?? '').toLowerCase()
        kind = /tab|表/i.test(before) ? 'table' : 'figure'
      }
      if (!n) return
      await showFigure(n, letter, kind, e.clientX, e.clientY)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [findCaption, figureRegions, findRefEntries, jumpToRef, structured, showFormula]
  )

  /** 定位并显示某个图表（点击引用、弹窗的「上一个/下一个」都走这里） */
  const showFigure = useCallback(
    async (
      n: number,
      letter: string,
      kind: 'figure' | 'table' | 'any',
      cx: number,
      cy: number
    ): Promise<void> => {
      // ---- 结构化模块优先：题注类型/编号已消歧，且已绑定真实的图/表区域 ----
      if (structured && structured.captions.length) {
        const cap = pickCaptionModule(structured.captions, n, letter, kind)
        if (cap) {
          const pg = structured.pages.find((p) => p.page === cap.page)
          const mPageW = pg?.w && pg.w > 0 ? pg.w : 612
          const mPageH = pg?.h && pg.h > 0 ? pg.h : 792
          const mRegs = (pg?.rects ?? []) as Array<[number, number, number, number]>
          const capBottom = cap.rect[1]
          const capTop = cap.rect[3]
          // 绑定区域（图/表）优先；否则回退到「题注上方 + 含题注」
          const region: [number, number, number, number] = cap.figureRect
            ? [
                cap.figureRect[0],
                Math.min(cap.figureRect[1], capBottom),
                cap.figureRect[2],
                Math.max(cap.figureRect[3], capTop)
              ]
            : figureCropRegion(
                mRegs,
                [cap.rect[0], capTop, cap.rect[2], capTop],
                mPageW,
                mPageH,
                Math.max(20, mPageW * 0.055),
                undefined,
                capBottom
              )
          const mScale = Math.max(0.4, Math.min(3, effRender || 1))
          const mw = Math.round((region[2] - region[0]) * mScale)
          const mh = Math.round((region[3] - region[1]) * mScale)
          setFigPop({
            n,
            letter,
            kind: cap.kind,
            label: `${cap.kind === 'table' ? '表' : '图'} ${n}${letter}`,
            left: Math.max(8, Math.min(cx + 12, window.innerWidth - mw - 16)),
            top: Math.max(8, Math.min(cy + 12, window.innerHeight - mh - 16)),
            w: mw,
            h: mh,
            region,
            pageIndex: cap.page - 1,
            pageH: mPageH,
            scale: mScale
          })
          return
        }
      }
      const found = await findCaption(n, letter, kind)
      if (!found) return
      const { page, pageIndex, item } = found
      const [, b, , d, ex, fy] = item.transform
      const fontSize = Math.hypot(b, d) || 10
      const view = page.view as number[]
      const pageW = view[2] - view[0]
      const pageH = view[3] - view[1]
      const capX = ex
      const capTop = fy + fontSize * 0.9
      const tc = await page.getTextContent()
      const above = (tc.items as Array<{ str?: string; transform?: number[] }>)
        .filter(
          (x) =>
            String(x.str ?? '').trim() &&
            x.transform &&
            x.transform[5] > capTop + 1 &&
            Math.abs(x.transform[4] - capX) < pageW * 0.7
        )
        .sort((p, q) => (p.transform as number[])[5] - (q.transform as number[])[5])[0]
      const margin = Math.max(20, pageW * 0.055)
      // 图注块的下边界：把题注下方、间隙很小的连续文本行（多行图注 / 符号解释）一并纳入
      let capBottom = fy - fontSize * 0.35
      {
        const below = (tc.items as Array<{ str?: string; transform?: number[] }>)
          .filter(
            (x) =>
              String(x.str ?? '').trim() &&
              x.transform &&
              x.transform[5] < fy - 1 &&
              Math.abs(x.transform[4] - capX) < pageW * 0.6
          )
          .sort((a, b) => (b.transform as number[])[5] - (a.transform as number[])[5])
        let prevY = fy
        for (const l of below) {
          const t = l.transform as number[]
          const fs2 = Math.hypot(t[1], t[3]) || fontSize
          if (prevY - t[5] > fs2 * 1.9) break // 间隙过大 → 不属于同一图注块
          capBottom = Math.min(capBottom, t[5] - fs2 * 0.4)
          prevY = t[5]
        }
      }
      // 优先用侧车算出的「矢量图形区域」精确裁剪（多子图会合并）；没有则回退到启发式
      const regs = ((figureRegions ?? []).find((r) => r.page === pageIndex + 1)?.rects ?? []) as Array<
        [number, number, number, number]
      >
      const aboveBottom =
        above && above.transform
          ? above.transform[5] - Math.hypot(above.transform[1], above.transform[3])
          : undefined
      const region = figureCropRegion(
        regs,
        [capX, capTop, capX + pageW * 0.5, capTop],
        pageW,
        pageH,
        margin,
        aboveBottom,
        capBottom
      )
      // 与原始页面一致的缩放：直接用当前页面的渲染比例（所见即页面上的分辨率）
      const scale = Math.max(0.4, Math.min(3, effRender || 1))
      const w = Math.round((region[2] - region[0]) * scale)
      const h = Math.round((region[3] - region[1]) * scale)
      setFigPop({
        n,
        letter,
        kind: found.kind,
        label: `${found.kind === 'table' ? '表' : '图'} ${n}${letter}`,
        left: Math.max(8, Math.min(cx + 12, window.innerWidth - w - 16)),
        top: Math.max(8, Math.min(cy + 12, window.innerHeight - h - 16)),
        w,
        h,
        region,
        pageIndex,
        pageH,
        scale
      })
    },
    [findCaption, figureRegions, effRender, structured]
  )

  // 图表引用高亮（提示"可点"）：扫描文本层，用 Custom Highlight API 上色（不改 DOM）
  useEffect(() => {
    const reg = (
      CSS as unknown as {
        highlights?: { set(k: string, h: unknown): void; delete(k: string): void }
      }
    ).highlights
    const HC = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    const c = containerRef.current
    if (!reg || !HC || !c) return
    const NAME = 'paperdesk-figref'
    let timer = 0
    const scan = (): void => {
      const ranges: Range[] = []
      const re = /(?:fig(?:ure)?|tab(?:le)?|图|表)\.?\s*\d+[a-z]?/gi
      for (const layer of c.querySelectorAll<HTMLElement>('.textLayer')) {
        if (!layer.childNodes.length) continue
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
        let n: Node | null
        while ((n = walker.nextNode())) {
          const t = n.textContent ?? ''
          if (t.length < 3) continue
          re.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = re.exec(t))) {
            try {
              const r = document.createRange()
              r.setStart(n, m.index)
              r.setEnd(n, m.index + m[0].length)
              ranges.push(r)
            } catch {
              /* 忽略非法 range */
            }
          }
        }
      }
      try {
        if (ranges.length) reg.set(NAME, new HC(...ranges))
        else reg.delete(NAME)
      } catch {
        /* 忽略 */
      }
    }
    const schedule = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(scan, 350)
    }
    schedule()
    const mo = new MutationObserver(schedule)
    mo.observe(c, { childList: true, subtree: true, characterData: true })
    return () => {
      window.clearTimeout(timer)
      mo.disconnect()
      try {
        reg.delete(NAME)
      } catch {
        /* 忽略 */
      }
    }
  }, [containerRef])

  // 把裁剪区域渲染到弹窗画布（用 pdf.js 的 transform 只画该区域，速度快）
  useEffect(() => {
    if (!figPop) return
    let cancelled = false
    void (async () => {
      const canvas = figCanvasRef.current
      if (!canvas) return
      try {
        const page = await doc.getPage(figPop.pageIndex + 1)
        // 放大时按真实倍率重渲染，而不是把低分辨率画布拉伸糊掉。
        // 再乘 dpr：弹窗位图与屏幕物理像素一一对应，高分屏上不再比页面画布更糊。
        // viewport 的 scale 乘了 dpr，p1/p2 也随之等比放大，因此下面的
        // transform 仍用该 viewport 内的 -minX/-minY（不要对它们再乘一次 dpr）。
        const viewport = page.getViewport({ scale: figPop.scale * figZoom * dpr })
        canvas.width = Math.max(1, Math.round(figPop.w * figZoom * dpr))
        canvas.height = Math.max(1, Math.round(figPop.h * figZoom * dpr))
        const ctx2d = canvas.getContext('2d')
        if (!ctx2d) return
        const [rx0, ry0, rx1, ry1] = figPop.region
        const p1 = viewport.convertToViewportPoint(rx0, ry1)
        const p2 = viewport.convertToViewportPoint(rx1, ry0)
        const minX = Math.min(p1[0], p2[0])
        const minY = Math.min(p1[1], p2[1])
        await page.render({
          canvasContext: ctx2d,
          viewport,
          transform: [1, 0, 0, 1, -minX, -minY]
        } as Parameters<PDFPageProxy['render']>[0]).promise
      } catch {
        /* 渲染失败则保持空白 */
      }
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
  }, [figPop, doc, figZoom, dpr])

  // 点击别处 / 滚动时关闭弹窗（图表预览 / 参考文献选择）
  useEffect(() => {
    if (!figPop && !refPick) return
    const onDown = (ev: MouseEvent): void => {
      const t = ev.target as HTMLElement | null
      if (t?.closest('.figpop')) return
      setFigPop(null)
      setRefPick(null)
    }
    const c = containerRef.current
    const onScroll = (): void => {
      setFigPop(null)
      setRefPick(null)
    }
    document.addEventListener('mousedown', onDown)
    c?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      document.removeEventListener('mousedown', onDown)
      c?.removeEventListener('scroll', onScroll)
    }
  }, [figPop, refPick, containerRef])

  return (
    <div
      className="scrollpages"
      ref={containerRef}
      onMouseUp={() => void handleMouseUp()}
      onClick={(e) => void handleFigureRefClick(e)}
    >
      {/* 手势缩放期间用 transform 即时反馈；停下后 effRender 追上、zoomK→1（清晰重渲染） */}
      <div
        ref={innerRef}
        className="scrollpages__inner"
        style={{
          transform: `scale(${zoomK})`,
          transformOrigin: zoomOrigin ? `${zoomOrigin.x * 100}% ${zoomOrigin.y * 100}%` : 'top center'
        }}
      >
        {pageSizes.length === 0 ? (
          <div className="empty">
            <span className="spinner" />
            <span>正在准备版面…</span>
          </div>
        ) : (
          pageSizes.map((s, i) => (
            <div
              key={i}
              className="scrollpage"
              data-page={i}
              data-pageno={i + 1}
              onClick={(e) => handlePagePickClick(i, e)}
              style={{ width: Math.floor(s.w * effRender), height: Math.floor(s.h * effRender) }}
            >
            <div className="pageCanvas" data-canvas={i} ref={ensurePageCanvas} />
            {pageErrors[i] && (
              <div
                className="page-error"
                data-testid={`page-error-${i}`}
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 5,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: 12,
                  textAlign: 'center',
                  background: 'rgba(255,255,255,0.94)',
                  color: '#333',
                  fontSize: 12,
                  lineHeight: 1.5
                }}
              >
                <div style={{ fontWeight: 600 }}>第 {i + 1} 页渲染失败</div>
                <div style={{ color: '#666', maxWidth: '92%', wordBreak: 'break-word' }}>
                  {pageErrors[i]}
                </div>
                <button type="button" data-testid={`page-retry-${i}`} onClick={() => retryPage(i)}>
                  重试
                </button>
              </div>
            )}
            <div className="textLayer" data-text={i} />
            <div className="annotationLayer" data-ann={i} />
            <div className="syncLayer" data-sync={i} />
            {flashBox && flashBox.pageIndex === i && (
              <div
                className="figflash"
                data-testid="fig-flash"
                style={{
                  left: flashBox.rect[0] * effRender,
                  top: (flashBox.pageH - flashBox.rect[3]) * effRender,
                  width: Math.max(4, (flashBox.rect[2] - flashBox.rect[0]) * effRender),
                  height: Math.max(4, (flashBox.rect[3] - flashBox.rect[1]) * effRender)
                }}
              />
            )}
            {highlightBox && highlightPageIndex === i && (
              <div
                className="block-highlight"
                data-testid="block-highlight"
                style={{
                  position: 'absolute',
                  left: highlightBox.left,
                  top: highlightBox.top,
                  width: highlightBox.width,
                  height: highlightBox.height,
                  border: '2px solid rgba(94,168,255,0.95)',
                  background: 'rgba(94,168,255,0.16)',
                  borderRadius: 3,
                  zIndex: 6,
                  pointerEvents: 'none'
                }}
              />
            )}
          </div>
          ))
        )}
      </div>
      {refPick && (
        <div
          className="figpop refpick"
          data-testid="ref-pick"
          style={{ left: Math.max(8, refPick.x - 20), top: Math.max(8, refPick.y + 8) }}
        >
          <div className="figpop__bar">
            <span className="figpop__label">选择要跳转的参考文献</span>
            <span className="toolbar__spacer" />
            <button
              className="icon ghost"
              title="关闭"
              data-testid="ref-pick-close"
              onClick={() => setRefPick(null)}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
          <div className="refpick__list">
            {refPick.items.map((it) => (
              <button
                key={it.n}
                className="refpick__item"
                data-testid={`ref-pick-${it.n}`}
                title={`第 ${it.pageIndex + 1} 页`}
                onClick={() => {
                  jumpToRef(it)
                  setRefPick(null)
                }}
              >
                <span className="refpick__n">[{it.n}]</span>
                <span className="refpick__t">
                  {it.text.replace(/^\s*\[?\s*\d+\s*[\].)]\s*/, '').slice(0, 120)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {formulaPop && (
        <div
          className="figpop formulapop"
          data-testid="formula-pop"
          style={{ left: formulaPop.left, top: formulaPop.top }}
        >
          <div className="figpop__bar">
            <span className="figpop__label">公式{formulaPop.n ? ` (${formulaPop.n})` : ''}</span>
            <span className="toolbar__spacer" />
            <button
              className="ghost"
              title={`定位原文（第 ${formulaPop.pageIndex + 1} 页）`}
              data-testid="formula-goto"
              onClick={() => {
                flashToRegion(formulaPop.pageIndex, formulaPop.rect, formulaPop.pageH)
                setFormulaPop(null)
              }}
            >
              <Icon name="external" size={12} />
              定位原文
            </button>
            <button
              className="icon ghost"
              title="关闭"
              data-testid="formula-close"
              onClick={() => setFormulaPop(null)}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
          <div className="figpop__body">
            <canvas ref={formulaCanvasRef} className="figpop__canvas" />
          </div>
          <div className="formulapop__body">
            {formulaPop.status && (
              <div className="formulapop__badge" data-testid="formula-status">
                {formulaPop.status === 'accepted'
                  ? '结构还原可靠'
                  : formulaPop.status === 'needs_review'
                    ? '结构还原不确定（建议核对原公式）'
                    : '未能可靠还原'}
                {formulaPop.det != null && formulaPop.rec != null
                  ? ` · 检测 ${Math.round(formulaPop.det * 100)}% / 还原 ${Math.round(formulaPop.rec * 100)}%`
                  : ''}
              </div>
            )}
            <div className="meta__muted" data-testid="formula-msg">
              {formulaPop.msg}
            </div>
            {!formulaPop.latex && formulaPop.raw && (
              <div className="formulapop__raw" data-testid="formula-raw" title="原文（保留供核对）">
                {formulaPop.raw}
              </div>
            )}
            {formulaPop.latex && (
              <textarea
                className="meta__textarea"
                readOnly
                value={formulaPop.latex}
                data-testid="formula-latex"
              />
            )}
            <div className="popup__row">
              {!formulaPop.latex && (
                <button
                  data-testid="formula-recognize"
                  disabled={formulaPop.busy}
                  onClick={() => void recognizeFormula()}
                >
                  <Icon name="sparkles" size={13} />
                  识别公式
                </button>
              )}
              {formulaPop.latex && (
                <>
                  <button
                    data-testid="formula-copy"
                    onClick={() => void navigator.clipboard.writeText(formulaPop.latex)}
                  >
                    <Icon name="copy" size={13} />
                    复制
                  </button>
                  <button
                    data-testid="formula-download"
                    onClick={() => void downloadFormulaLatex(formulaPop.latex)}
                  >
                    <Icon name="file" size={13} />
                    下载 .tex
                  </button>
                </>
              )}
            </div>
            {formulaPop.source && (
              <div className="meta__muted" data-testid="formula-source">
                {formulaPop.source === 'extracted'
                  ? '来源：源文件直接提取'
                  : '来源：模型识别生成（请核对原公式）'}
              </div>
            )}
            {formulaPop.validation && formulaPop.validation.issues.length > 0 && (
              <div className="meta__muted" data-testid="formula-validation">
                验证：{formulaPop.validation.issues.join('；')}
              </div>
            )}
          </div>
        </div>
      )}
      {figPop && (
        <div
          className="figpop"
          data-testid="fig-pop"
          style={{ left: figPop.left, top: figPop.top }}
        >
          <div className="figpop__bar">
            <span className="figpop__label">{figPop.label}</span>
            <span className="toolbar__spacer" />
            <button
              className="icon ghost"
              title="缩小图表"
              data-testid="fig-pop-zoom-out"
              disabled={figZoom <= 0.5}
              onClick={() => setFigZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))}
            >
              <Icon name="minus" size={12} />
            </button>
            <span className="figpop__zoom" data-testid="fig-pop-zoom-label">
              {Math.round(figZoom * 100)}%
            </span>
            <button
              className="icon ghost"
              title="放大图表"
              data-testid="fig-pop-zoom-in"
              disabled={figZoom >= 3}
              onClick={() => setFigZoom((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100))}
            >
              <Icon name="plus" size={12} />
            </button>
            <button
              className="icon ghost"
              title="上一个图表"
              data-testid="fig-pop-prev"
              disabled={figPop.n <= 1}
              onClick={() => void showFigure(figPop.n - 1, '', figPop.kind, figPop.left - 12, figPop.top - 12)}
            >
              <Icon name="left" size={12} />
            </button>
            <button
              className="icon ghost"
              title="下一个图表"
              data-testid="fig-pop-next"
              onClick={() => void showFigure(figPop.n + 1, '', figPop.kind, figPop.left - 12, figPop.top - 12)}
            >
              <Icon name="right" size={12} />
            </button>
            <button
              className="ghost figpop__goto"
              title={`跳到该图表所在页（第 ${figPop.pageIndex + 1} 页）`}
              data-testid="fig-pop-goto"
              onClick={() => {
                flashToRegion(figPop.pageIndex, figPop.region, figPop.pageH)
                setFigPop(null)
              }}
            >
              <Icon name="external" size={12} />
              p.{figPop.pageIndex + 1}
            </button>
            <button
              className="icon ghost"
              title="关闭"
              data-testid="fig-pop-close"
              onClick={() => setFigPop(null)}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
          <div className="figpop__body">
            <canvas
              ref={figCanvasRef}
              className="figpop__canvas"
              style={{
                width: Math.round(figPop.w * figZoom),
                maxWidth: figZoom > 1 ? 'none' : undefined
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
