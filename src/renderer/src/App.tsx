import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AskSelection,
  AskTask,
  Attachment,
  GraphNodeKind,
  Item,
  PartialText,
  SearchHit,
  TranslateProgress,
  Translation,
  TranslationTarget
} from '@shared/types'
import { LibraryWorkspace } from './features/library/LibraryWorkspace'
import { LibraryList } from './features/library/LibraryList'
import { ItemPreview } from './features/library/ItemPreview'
import { ItemDetailPanel } from './features/library/ItemDetailPanel'
const PdfViewer = lazy(() => import('./features/reader/PdfViewer').then((m) => ({ default: m.PdfViewer })))
const preloadTranslationDoc = (id: number, epoch = 0): void => {
  void import('./features/reader/PdfViewer').then((m) => m.preloadTranslationDoc(id, epoch)).catch(() => undefined)
}
const CompareView = lazy(() => import('./features/reader/CompareView').then((m) => ({ default: m.CompareView })))
const PageEditDialog = lazy(() => import('./features/reader/PageEditDialog').then((m) => ({ default: m.PageEditDialog })))
import { TabsBar } from './features/reader/TabsBar'
import { TocPanel } from './features/reader/TocPanel'
const ParseCheckPanel = lazy(() => import('./features/reader/ParseCheckPanel').then((m) => ({ default: m.ParseCheckPanel })))
import type { StructuredBlock } from '@shared/blocks'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PANELS, PANEL_GROUPS, type PanelContext } from './modules/registry'
import { useDocTabs, usePanels } from './hooks/workbench'
import type { LeftView } from './hooks/workbench'

/** 阶段二：两种界面布局 —— 整理文库（左栏展开）/ 专注阅读（左栏收起、功能区隐藏） */
type Workspace = 'library' | 'reader' | 'knowledge' | 'research' | 'tasks'
type LayoutMode = 'focus' | 'library'
interface LayoutSnap {
  leftView: LeftView
  sbCollapsed: boolean
  sbW: number
}
const LAYOUT_KEY = 'paperdesk.ui.layoutMode'
const SettingsDialog = lazy(() => import('./features/settings/SettingsDialog').then((m) => ({ default: m.SettingsDialog })))
const MindMapPanel = lazy(() => import('./features/mindmap/MindMapPanel').then((m) => ({ default: m.MindMapPanel })))
const StagingPanel = lazy(() => import('./features/knowledge/StagingPanel').then((m) => ({ default: m.StagingPanel })))
const KnowledgePanel = lazy(() => import('./features/knowledge/KnowledgePanel').then((m) => ({ default: m.KnowledgePanel })))
import { Icon } from './components/Icon'
import type { ViewMode } from './features/translate/TranslationPanel'
import { pickTranslation } from '@shared/translation-pick'
import {
  GROUP_ALL,
  GROUP_UNGROUPED,
  groupDisplayName,
  normalizeGroupName
} from '@shared/library-groups'
import {
  docStateKey,
  mergeDocState,
  parseDocState,
  serializeDocState,
  type DocState
} from '@shared/doc-state'

export interface FocusTarget {
  page: number
  annotationKey: string | null
  nonce: number
  /** 引用命中的结构化模块矩形（底边原点）：跳页后高亮 */
  rect?: [number, number, number, number] | null
}

const VIEW_MODES: ViewMode[] = ['original', 'bilingual']

function isViewMode(v: string): v is ViewMode {
  return (VIEW_MODES as string[]).includes(v)
}

/**
 * 校验要恢复的视图：仅在当前文档确有对应译文时生效，否则回退。
 * 兼容历史状态：旧版 'pdf'（译文 PDF）映射到 'bilingual'（左右并排对照）；
 * 旧版 'split' 即现在的 'bilingual'。
 */
function validViewMode(v: ViewMode | 'pdf' | 'split' | 'html', t: Translation | null): ViewMode {
  switch (v) {
    case 'bilingual':
      return t?.path ? 'bilingual' : 'original'
    case 'html':
      // 历史状态里的「网页」已移除，回退到中英对照
      return t?.path ? 'bilingual' : 'original'
    case 'pdf':
      return t?.path ? 'bilingual' : 'original'
    case 'split':
      return t?.path ? 'bilingual' : 'original'
    default:
      return 'original'
  }
}

export default function App(): React.JSX.Element {
  const [workspace, setWorkspace] = useState<Workspace>('library')
  const [readerOpened, setReaderOpened] = useState(false)
  const [compareOpened, setCompareOpened] = useState(false)
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [libraryError, setLibraryError] = useState('')
  const [commandOpen, setCommandOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [readerMore, setReaderMore] = useState(false)
  const [density, setDensity] = useState(() => localStorage.getItem('paperdesk.ui.density') === 'compact' ? 'compact' : 'comfortable')
  const [taskStatus, setTaskStatus] = useState('后台任务')
  const [items, setItems] = useState<Item[]>([])
  const [activeItemId, setActiveItemId] = useState<number | null>(() => {
    const n = Number(localStorage.getItem('paperdesk.docs.active'))
    return Number.isInteger(n) && n > 0 ? n : null
  })
  /** 已打开的文档标签由 useDocTabs 管理（见下方 hooks 调用） */
  /** 当前文档已恢复的阅读状态（公共工具栏受控）与侧栏折叠 */
  const [readPage, setReadPage] = useState(1)
  /** 有效缩放比例（1.0 = 100%）；受控下发到活动 PDF 视图 */
  const [readScale, setReadScale] = useState(1.3)
  /** 是否处于「适应宽度」 */
  const [zoomFit, setZoomFit] = useState(true)
  /** 活动 PDF 视图的总页数（公共工具栏页码指示） */
  const [readNumPages, setReadNumPages] = useState(0)
  /** 递增该计数请求「适应宽度」（命令式触发） */
  const [fitNonce, setFitNonce] = useState(0)
  /** 「中英对照」左右联动开关（默认开） */
  const [sync, setSync] = useState(true)
  /** 页码输入框（回车跳转） */
  const [pageInput, setPageInput] = useState('')
  // 页面管理（删除页 + 版本撤销）：入口在阅读工具栏，弹窗里核对缩略图后再删
  const [pagesOpen, setPagesOpen] = useState(false)
  /** 顶部公共工具栏的查找（驱动活动阅读器的查找高亮） */
  const [findQuery, setFindQuery] = useState('')
  const [findNextTick, setFindNextTick] = useState(0)
  const [findPrevTick, setFindPrevTick] = useState(0)
  const [findStatus, setFindStatus] = useState<{ count: number; index: number }>({ count: 0, index: -1 })
  /** 文库全文命中跳页时的一次性查找请求：把命中词送进可见视图并优先定位到目标页（page 为 1 基） */
  const [findRequest, setFindRequest] = useState<{ query: string; page: number; nonce: number } | null>(
    null
  )
  /** 用户是否已手动调整过面板（用于「首次进入对照只自动收起一次」） */
  const [panelAdjusted, setPanelAdjusted] = useState(false)
  /** 「加入批处理」中转：某功能声明的批处理任务 id（打开批处理面板时预选） */
  const [pendingBatchTask, setPendingBatchTask] = useState<string | null>(null)
  /** 「文献检索 → 按引用展开」中转：要求相关论文面板按类别过滤（如仅看施引文献） */
  const [pendingDiscoveryFilter, setPendingDiscoveryFilter] = useState<GraphNodeKind | null>(null)
  /** 划词「文件检索」中转：打开文献检索面板并自动以该词检索 */
  const [pendingWorksQuery, setPendingWorksQuery] = useState<string | null>(null)

  // ---- Batch B：界面状态抽成 hooks（行为不变）----
  const { openDocIds, closeDoc } = useDocTabs(activeItemId, setActiveItemId)
  const {
    rightTab,
    activeGroup,
    visited,
    leftView,
    setLeftView,
    sbCollapsed,
    setSbCollapsed,
    setActiveGroup,
    selectTab,
    toggleLeft
  } = usePanels(() => setPanelAdjusted(true))
  /** 已完成状态恢复的文档 id：用于避免切换瞬间把上一篇的状态写进新篇 */
  const [hydratedDocId, setHydratedDocId] = useState<number | null>(null)
  /** 切换文档时待应用的视图（待译文就绪后校验并生效） */
  const restoreViewRef = useRef<ViewMode | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [activeAttachmentId, setActiveAttachmentId] = useState<number | null>(null)
  /** 左栏「文档详情」显示的条目（双击文库行进入） */
  const [detailItemId, setDetailItemId] = useState<number | null>(null)
  const [notesRefresh, setNotesRefresh] = useState(0)
  const [focus, setFocus] = useState<FocusTarget | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 打开设置时直接定位的段落（PD50：知识库「配置语义检索」跳进 embed 段） */
  const [settingsSection, setSettingsSection] = useState<'embed' | null>(null)
  /** 统一入口：清掉上一次的定位段，避免第二次直接打开设置时又跳走 */
  const openSettings = useCallback((section: 'embed' | null = null): void => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])
  /** 当前文献的思维地图面板（按活跃条目挂载；切换文献时自动重载/保存） */
  const [mindmapOpen, setMindmapOpen] = useState(false)
  /** 知识库暂存区（PD34）：审核 AI 提案；发布只由用户显式确认触发 */
  const [stagingOpen, setStagingOpen] = useState(false)
  /** 知识库正式条目面板（PD36）：与暂存区互斥，避免同层 overlay 叠加 */
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  const [translation, setTranslation] = useState<Translation | null>(null)
  /** 译文重译页后递增，强制 PdfViewer 丢弃缓存重新读盘 */
  const [translationEpoch, setTranslationEpoch] = useState(0)
  const [rePageBusy, setRePageBusy] = useState(false)
  /** 由「文库全文命中」带入的查找词：普通打开其它文档时只清它，保留用户手输查找词的既有行为 */
  const findFromHitRef = useRef('')
  const findReqNonceRef = useRef(0)
  const [viewMode, setViewMode] = useState<ViewMode>('original')
  /**
   * 解析检查面板（只读）：默认关闭，不改动默认阅读布局。
   * 打开时按当前附件懒加载解析产物里的结构化块（`window.api.reader.modules`），只读展示；
   * 拿不到块时面板显示原因 + 开启方法，不留空白。
   */
  const [parseCheckOpen, setParseCheckOpen] = useState(false)
  const [parseBlocks, setParseBlocks] = useState<readonly StructuredBlock[]>([])
  const [parseLoading, setParseLoading] = useState(false)
  const [parseError, setParseError] = useState('')
  const [parseEmptyReason, setParseEmptyReason] = useState('')
  const [selectedBlockId, setSelectedBlockId] = useState('')
  const toggleParseCheck = useCallback((): void => {
    setParseCheckOpen((open) => !open)
    setParseError('')
    setParseEmptyReason('')
    // 打开前先进入 loading 态，避免「空态文案」闪一下再变列表
    setParseLoading(true)
  }, [])
  const handleSelectBlock = useCallback((stableId: string): void => {
    setSelectedBlockId(stableId)
  }, [])
  /** 解析检查当前选中的结构化块（含 sourceRegion）：传给 PDF 侧画块区域高亮遮罩 */
  const selectedBlock = useMemo(() => {
    if (!selectedBlockId) return null
    return parseBlocks.find((b) => b?.stableId === selectedBlockId) ?? null
  }, [parseBlocks, selectedBlockId])

  // 解析检查：打开时按当前附件懒加载结构化块；失败/缺字段只影响面板自身，不影响阅读
  useEffect(() => {
    if (!parseCheckOpen) {
      setParseLoading(false)
      return
    }
    setSelectedBlockId('')
    if (activeAttachmentId == null) {
      setParseBlocks([])
      setParseLoading(false)
      setParseEmptyReason('当前没有打开的文献附件，无法读取解析产物')
      return
    }
    const reader = window.api?.reader
    if (typeof reader?.modules !== 'function') {
      setParseBlocks([])
      setParseLoading(false)
      setParseEmptyReason('当前版本未提供结构化块接口（reader.modules 不可用）')
      return
    }
    let alive = true
    setParseLoading(true)
    setParseError('')
    setParseEmptyReason('')
    void (async () => {
      try {
        const doc = await reader.modules(activeAttachmentId)
        if (!alive) return
        const blocks = doc?.blocks?.blocks
        if (Array.isArray(blocks) && blocks.length > 0) {
          setParseBlocks(blocks)
          setParseEmptyReason('')
        } else {
          setParseBlocks([])
          setParseEmptyReason(
            Array.isArray(blocks)
              ? '这份文档的块标注为空：解析产物里的 blocks 列表没有任何块'
              : '结构化块未启用：这份解析产物里没有 blocks 字段'
          )
        }
      } catch (err) {
        if (!alive) return
        setParseBlocks([])
        setParseEmptyReason('')
        setParseError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive) setParseLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [parseCheckOpen, activeAttachmentId])
  /** 正在翻译的附件：切到别的文档时任务仍在后台跑，不应把它当成「翻译中断」 */
  const [runningAttachment, setRunningAttachment] = useState<number | null>(null)
  const runningAttachmentRef = useRef<number | null>(null)
  /** 后台翻译进度（按附件保存；切回该文档时恢复显示） */
  const bgProgressRef = useRef<Map<number, { message: string; ratio: number | null }>>(new Map())
  const translating = runningAttachment != null && runningAttachment === activeAttachmentId
  const [progress, setProgress] = useState('')
  const [translateRatio, setTranslateRatio] = useState<number | undefined>(undefined)
  const [theme, setTheme] = useState('light')
  const [partial, setPartial] = useState<PartialText | null>(null)
  const [aiRequest, setAiRequest] = useState<{
    text: string
    task: AskTask
    selection?: AskSelection | null
  } | null>(null)
  /**
   * 左栏当前分组筛选。提升到 App：切到右侧面板（左栏卸载）后仍保留，
   * AI 面板据此提供「分组级问答」作用域。
   */
  const [groupFilter, setGroupFilter] = useState<string>(GROUP_ALL)
  /** AI 分组问答的分组路径（全部/未分组 → null，退回单篇或全库语义） */
  const aiGroupName =
    groupFilter === GROUP_ALL || groupFilter === GROUP_UNGROUPED
      ? null
      : normalizeGroupName(groupFilter)
  const aiGroupLabel = aiGroupName ? groupDisplayName(aiGroupName) : ''
  // 左侧功能区宽度可自由拖拽（持久化）；默认给中间阅读区更大空间，便于并排对照
  const [sbW, setSbW] = useState(() => {
    const saved = Number(localStorage.getItem('paperdesk.ui.sbW'))
    // 旧默认 232 太窄（面板行内控件会被挤成竖排）→ 视为未设置，改用更宽的默认
    return saved && saved !== 232 ? saved : 320
  })
  // 窗口宽度：用于把左栏宽度夹在合理区间，保证主栏始终有足够空间（避免主栏被挤到"看不见"）
  const [winW, setWinW] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  /** 左栏宽度夹取：最小 200；最大不超过窗口宽度 − 主栏最小 420 */
  const clampSbW = (w: number): number => {
    const max = Math.max(200, Math.min(560, window.innerWidth - 420))
    return Math.round(Math.max(200, Math.min(max, w)))
  }
  const effSbW = clampSbW(sbW)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  useEffect(() => {
    localStorage.setItem('paperdesk.ui.sbW', String(sbW))
  }, [sbW])

  // —— 阶段二：布局模式（整理文库 / 专注阅读），两种布局各自记住左栏入口、折叠与宽度 ——
  const layoutKey = (m: LayoutMode): string => `paperdesk.ui.layout.${m}`
  const readLayout = (m: LayoutMode): LayoutSnap | null => {
    try {
      const raw = localStorage.getItem(layoutKey(m))
      if (!raw) return null
      const v = JSON.parse(raw) as Record<string, unknown>
      const lv = v.leftView
      const okLv =
        lv === null || lv === 'library' || lv === 'toc' || lv === 'search' || lv === 'panel' || lv === 'detail'
      if (!okLv) return null
      const w = Number(v.sbW)
      return {
        leftView: lv as LeftView,
        sbCollapsed: v.sbCollapsed === true,
        sbW: Number.isFinite(w) && w > 0 ? Math.round(w) : 320
      }
    } catch {
      return null
    }
  }
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() =>
    localStorage.getItem(LAYOUT_KEY) === 'focus' ? 'focus' : 'library'
  )
  const layoutRestoredRef = useRef(false)
  // 启动时恢复当前布局上次的状态（只做一次，避免覆盖用户本次操作）
  useEffect(() => {
    if (layoutRestoredRef.current) return
    layoutRestoredRef.current = true
    const snap = readLayout(layoutMode)
    if (!snap) return
    setLeftView(snap.leftView)
    setSbCollapsed(snap.sbCollapsed)
    setSbW(clampSbW(snap.sbW))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 持续记住「当前布局」的状态；切换布局时不会串味
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, layoutMode)
      localStorage.setItem(layoutKey(layoutMode), JSON.stringify({ leftView, sbCollapsed, sbW }))
    } catch {
      /* localStorage 不可用时只影响记忆，不影响使用 */
    }
  }, [layoutMode, leftView, sbCollapsed, sbW])
  const applyLayout = (m: LayoutMode): void => {
    if (m === layoutMode) return
    setLayoutMode(m)
    setPanelAdjusted(true)
    const snap = readLayout(m)
    if (snap) {
      setLeftView(snap.leftView)
      setSbCollapsed(snap.sbCollapsed)
      setSbW(clampSbW(snap.sbW))
      return
    }
    if (m === 'focus') {
      // 专注阅读：收起左栏功能区，把横向空间全部留给论文
      setSbCollapsed(true)
      setLeftView(null)
      setSbW(clampSbW(320))
    } else {
      // 整理文库：展开文件库，给分组与列表更宽的栏
      setLeftView('library')
      setSbCollapsed(false)
      setSbW(clampSbW(360))
    }
  }

  // 左侧分隔条拖拽（VSCode 式）
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      const dx = e.clientX - d.startX
      setSbW(clampSbW(d.startW + dx))
    }
    const onUp = (): void => {
      dragRef.current = null
      document.body.classList.remove('resizing')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const startDrag = (e: { clientX: number; preventDefault: () => void }): void => {
    dragRef.current = { startX: e.clientX, startW: sbW }
    document.body.classList.add('resizing')
    e.preventDefault()
  }

  const activeDocId = activeItemId

  // 多文档标签的持久化 / 选中即开标签 / 关闭切邻，均由 useDocTabs 管理（见上方 hooks 调用）。

  // ---- 每篇文档的阅读状态：切换文档时恢复 ----
  useEffect(() => {
    if (activeDocId == null) {
      setHydratedDocId(null)
      restoreViewRef.current = null
      return
    }
    let st: DocState = {}
    try {
      st = parseDocState(localStorage.getItem(docStateKey(activeDocId)))
    } catch {
      st = {}
    }
    setReadPage(st.page != null && st.page >= 1 ? Math.floor(st.page) : 1)
    setReadScale(typeof st.scale === 'number' ? st.scale : 1.3)
    // 兼容旧状态：未记录 zoomFit 时以 scale 是否为空判断
    setZoomFit(typeof st.zoomFit === 'boolean' ? st.zoomFit : st.scale == null)
    // 启动一律展开左侧面板（不恢复历史折叠，避免坏状态导致整窗空白）；会话内再尊重用户手动调整
    setSbCollapsed(false)
    setPanelAdjusted(st.panelAdjusted === true)
    restoreViewRef.current = st.viewMode && isViewMode(st.viewMode) ? st.viewMode : null
    setHydratedDocId(activeDocId)
  }, [activeDocId])

  /** 进入「中英对照」：只切换视图；不再自动收起左栏（收起后只剩一条无用的窄条，且曾触发白屏） */
  const enterBilingual = (): void => {
    setViewMode('bilingual')
  }

  /** Batch D：立即执行（复用批处理同一 task.run；不入队列，不占并发） */
  const runOnceTask = async (taskId: string): Promise<void> => {
    setProgress('立即执行中…')
    try {
      const r = await window.api.batch.runOnce(
        taskId,
        { attachmentId: activeAttachmentId ?? undefined, itemId: activeItemId ?? undefined },
        {}
      )
      setProgress(r.message || '完成')
    } catch (e) {
      setProgress('执行失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  // 持久化当前文档阅读状态（恢复完成前不写，避免把上一篇的状态串到新篇）
  useEffect(() => {
    if (activeDocId == null || hydratedDocId !== activeDocId) return
    try {
      const prev = parseDocState(localStorage.getItem(docStateKey(activeDocId)))
      const next = mergeDocState(prev, {
        viewMode,
        page: readPage,
        scale: readScale,
        zoomFit,
        panelAdjusted,
        attachmentId: activeAttachmentId
      })
      localStorage.setItem(docStateKey(activeDocId), serializeDocState(next))
    } catch {
      /* 忽略 */
    }
  }, [
    activeDocId,
    hydratedDocId,
    viewMode,
    readPage,
    readScale,
    zoomFit,
    panelAdjusted,
    activeAttachmentId
  ])

  // 深链/检索定位：同步受控页码，避免与活动视图的 syncPage 相互拉扯
  useEffect(() => {
    if (focus) setReadPage(Math.max(1, focus.page))
    // 仅在定位变化（nonce）时同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce])

  /** 「打开译文」时预置的视图（切换附件后由下方 effect 应用，避免被重置为原文） */
  const pendingView = useRef<'bilingual' | null>(null)
  /** 已查询到的译文缓存：切换附件时先同步恢复，避免「原文/中英对照」按钮短暂消失 */
  const translationCache = useRef<Map<number, Translation>>(new Map())
  /** 当前活动附件（供异步任务完成后校验归属：翻译期间可能已切换论文） */
  const activeAttachmentRef = useRef<number | null>(activeAttachmentId)
  useEffect(() => {
    activeAttachmentRef.current = activeAttachmentId
  }, [activeAttachmentId])
  useEffect(() => {
    runningAttachmentRef.current = runningAttachment
  }, [runningAttachment])
  /** 翻译请求代次：只有最新一次请求可以更新 UI（旧请求晚到不得覆盖） */
  const translateRunRef = useRef(0)
  const translateRequestRef = useRef<{ id: string; attachmentId: number } | null>(null)

  // 应用主题
  useEffect(() => {
    void window.api.settings.get().then((s) => {
      const t = s.ui.theme === 'dark' ? 'dark' : 'light'
      document.documentElement.dataset.theme = t
      setTheme(t)
    })
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await window.api.library.list()
      setItems(list)
      setLibraryError('')
      setActiveItemId((prev) => prev != null && list.some((i) => i.id === prev) ? prev : (list[0]?.id ?? null))
      if (!performance.getEntriesByName('paperdesk-library-ready').length) performance.mark('paperdesk-library-ready')
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : String(e))
    } finally { setLibraryLoading(false) }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * 普通打开文档时清掉「全文命中」带入的查找词与一次性请求：
   * 否则新文档会继续用上一次命中的词查找并高亮（幽灵高亮）。
   * 用户自己手输的查找词保持既有行为（跨文档保留），这里只清命中带入的那一个。
   */
  const clearHitFind = useCallback((): void => {
    const q = findFromHitRef.current
    if (!q) return
    findFromHitRef.current = ''
    setFindRequest(null)
    setFindQuery((prev) => (prev === q ? '' : prev))
    setFindStatus({ count: 0, index: -1 })
  }, [])

  /**
   * 切换文库条目：先清空旧附件/译文/视图，再加载新条目。
   * 否则新旧附件的异步加载会交错，出现「左栏原文还是上一篇、右栏译文已是新一篇」。
   */
  const selectItem = useCallback(
    (itemId: number): void => {
      if (itemId !== activeItemId) {
        clearHitFind()
        pendingView.current = null
        restoreViewRef.current = null
        setActiveAttachmentId(null)
        setTranslation(null)
        setViewMode('original')
        setReadPage(1)
      }
      setActiveItemId(itemId)
      setWorkspace('reader')
      setReaderOpened(true)
      setMindmapOpen(false)
      setKnowledgeOpen(false)
    },
    [activeItemId, clearHitFind]
  )

  // 主进程导入/抽取/改名/删除后主动刷新，避免「上传后要再传一篇才出现」
  useEffect(() => window.api.onLibraryChanged(() => void refresh()), [refresh])

  /** 双击文库条目 → 左栏文档详情（返回时回到文档列表） */
  const openItemDetail = useCallback(
    (itemId: number): void => {
      setDetailItemId(itemId)
      setLeftView('detail')
    },
    [setLeftView]
  )
  const closeItemDetail = useCallback((): void => {
    setDetailItemId(null)
    setLeftView('library')
  }, [setLeftView])

  useEffect(() => {
    if (activeItemId == null) {
      setAttachments([])
      setActiveAttachmentId(null)
      return
    }
    let cancelled = false
    void (async () => {
      const atts = await window.api.attachments.listByItem(activeItemId)
      if (cancelled) return
      setAttachments(atts)
      // 若当前附件仍属于该条目（例如深链指定），则保留
      setActiveAttachmentId((prev) =>
        prev != null && atts.some((a) => a.id === prev) ? prev : (atts[0]?.id ?? null)
      )
    })()
    return () => {
      cancelled = true
    }
  }, [activeItemId])

  // 译文状态：切换附件时重新查询（先用缓存同步恢复，避免切换按钮短暂消失）
  useEffect(() => {
    let cancelled = false
    const pending = pendingView.current
    setProgress('')
    setPartial(null)
    // 切回「仍在后台翻译」的文档时恢复它的进度：任务没有中断，只是界面之前没在看它
    const running = runningAttachmentRef.current
    if (running != null && running === activeAttachmentId) {
      const bg = bgProgressRef.current.get(running)
      if (bg) {
        setProgress(bg.message)
        setTranslateRatio(bg.ratio ?? undefined)
      }
    } else {
      setTranslateRatio(undefined)
    }
    if (pending) {
      // 显式打开译文时优先，清掉待恢复的文档视图，避免互相干扰
      restoreViewRef.current = null
    } else if (restoreViewRef.current == null) {
      setViewMode('original')
    }
    if (activeAttachmentId == null) {
      setTranslation(null)
      return
    }
    // 先用缓存里的译文兜底：查询返回前按钮不会消失
    const cached = translationCache.current.get(activeAttachmentId) ?? null
    if (cached) setTranslation(cached)
    void window.api.translate.get(activeAttachmentId, 'zh').then((t) => {
      if (cancelled) return
      if (t) translationCache.current.set(activeAttachmentId, t)
      // 查询为空时回退缓存，避免瞬时空结果清掉按钮
      setTranslation(pickTranslation(cached, t))
      if (pending) {
        setViewMode(pending === 'bilingual' && t?.path ? 'bilingual' : 'original')
        pendingView.current = null
      } else if (restoreViewRef.current) {
        // 恢复该文档上次的视图（仅在确有对应译文时生效）
        const want = restoreViewRef.current
        restoreViewRef.current = null
        setViewMode(validViewMode(want, pickTranslation(cached, t)))
      }
    })
    return () => {
      cancelled = true
    }
  }, [activeAttachmentId])

  useEffect(() => {
    return window.api.onTranslateProgress((p: TranslateProgress) => {
      const req = translateRequestRef.current
      if (!req || p.requestId !== req.id) return
      const entry = { message: p.message ?? p.stage ?? '', ratio: p.progress ?? null }
      // 按「请求所属附件」记录：离开该文档时进度仍在，切回来能恢复，不会看起来中断
      bgProgressRef.current.set(req.attachmentId, entry)
      if (req.attachmentId !== activeAttachmentRef.current) return
      setProgress(entry.message)
      setTranslateRatio(entry.ratio ?? undefined)
    })
  }, [])

  // 译文 PDF 预解析：翻译完成/切到已有译文的文档后，空闲时后台读盘 + 解析，
  // 之后再打开「中英对照」不再先空白等解析（译文内嵌 CJK 字体，首开通常比原文更慢）。
  useEffect(() => {
    const id = translation?.id
    if (!id || !readerOpened) return
    const timer = window.setTimeout(() => preloadTranslationDoc(id), 1200)
    return () => window.clearTimeout(timer)
  }, [translation?.id, readerOpened])

  const cancelTranslate = useCallback(async (): Promise<void> => {
    const req = translateRequestRef.current
    if (!req || req.attachmentId !== activeAttachmentRef.current) return
    await window.api.translate.cancel(req.id)
    if (translateRequestRef.current?.id === req.id && req.attachmentId === activeAttachmentRef.current) {
      setProgress('已请求取消…')
    }
  }, [])

  const handleTranslateSelection = useCallback((text: string, page?: number): void => {
    const t = (text ?? '').trim()
    if (!t) return
    // 页码随选区一起带去翻译面板（面板会显示「p.N 选区」），文本仍是完整原文
    setPartial({ text: t, kind: 'selection', page: page && page > 0 ? page : null })
    selectTab('translate')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleTranslatePage = useCallback((text: string): void => {
    // 保留段落结构：只压缩行内空白，保留空行分段（旧实现把整段压成一行，译文段落会丢）
    const t = (text ?? '')
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}/)
      .map((p) => p.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim())
      .filter(Boolean)
      .join('\n\n')
    if (!t) return
    setPartial({ text: t, kind: 'page', auto: true })
    selectTab('translate')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAskSelection = useCallback(
    (text: string, task: 'qa' | 'term', page?: number): void => {
      const t = (text ?? '').trim()
      if (!t) return
      // 选区作为独立上下文下发：完整原文 + 附件 + 页码，供「翻译上面这段」/追问引用
      const selection: AskSelection = {
        text: t,
        attachmentId: activeAttachmentRef.current,
        page: page && page > 0 ? page : null,
        origin: 'selection'
      }
      setAiRequest({ text: t, task, selection })
      selectTab('ai')
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const runTranslate = useCallback(
    async (
      lang = 'zh',
      mode: 'fine' | 'coarse' = 'fine',
      engine?: string,
      force?: boolean,
      layout: 'reflow' | 'strict' = 'reflow',
      fontDelta?: number
    ): Promise<void> => {
      if (activeAttachmentId == null) return
      // 固定本次请求的归属：完成后若用户已切走论文，结果仍落在被翻译的附件上，
      // 但绝不能更新当前界面（否则会出现「B 的原文 + A 的译文」）。
      const reqAttachmentId = activeAttachmentId
      const runId = ++translateRunRef.current
      const requestId = crypto.randomUUID()
      translateRequestRef.current = { id: requestId, attachmentId: reqAttachmentId }
      const isCurrent = (): boolean =>
        runId === translateRunRef.current && reqAttachmentId === activeAttachmentRef.current
      selectTab('translate')
      setRunningAttachment(reqAttachmentId)
      setProgress('准备中…')
      setTranslateRatio(0)
      bgProgressRef.current.set(reqAttachmentId, { message: '准备中…', ratio: 0 })
      try {
        const t = await window.api.translate.run(reqAttachmentId, {
          requestId,
          lang,
          mode,
          layout,
          ...(engine ? { engine } : {}),
          ...(force ? { force } : {}),
          ...(typeof fontDelta === 'number' ? { fontDelta } : {})
        })
        // 译文始终写入该附件的缓存（切回时立即可用）；界面只在仍属于当前附件时更新。
        if (t?.attachment_id === reqAttachmentId) {
          translationCache.current.set(reqAttachmentId, t)
        }
        if (!isCurrent()) return
        if (t.attachment_id !== reqAttachmentId) {
          setProgress('翻译结果归属异常：已忽略（请重试）')
          return
        }
        setTranslation(t)
        // 翻译完成后默认进入「中英对照」（左右并排）；走同一入口（每篇只自动收起一次）
        if (t.path) enterBilingual()
        else setViewMode('original')
        // 不要覆盖主进程发来的完成摘要/告警（旧逻辑会把「精译完成：…（告警）」改成「翻译完成」）
        setProgress((p) => (p.includes('完成') ? p : '翻译完成'))
      } catch (e) {
        if (!isCurrent()) return
        setProgress('翻译失败：' + (e instanceof Error ? e.message : String(e)))
      } finally {
        // 旧请求晚到的 finally 不得关掉新请求的进行中状态
        if (runId === translateRunRef.current) {
          translateRequestRef.current = null
          setRunningAttachment(null)
          bgProgressRef.current.delete(reqAttachmentId)
        }
      }
    },
    [activeAttachmentId]
  ) // eslint-disable-line react-hooks/exhaustive-deps

  // 处理 paperdesk:// 深链
  const handleDeepLinkUrl = useCallback(async (url: string): Promise<void> => {
    try {
      const u = new URL(url)
      if (u.protocol !== 'paperdesk:') return
      const attKey = u.searchParams.get('attachment')
      if (!attKey) return
      const att = await window.api.attachments.getByKey(attKey)
      if (!att) return
      setWorkspace('reader'); setReaderOpened(true); setMindmapOpen(false); setKnowledgeOpen(false)
      if (att.item_id != null) setActiveItemId(att.item_id)
      setActiveAttachmentId(att.id)
      setFocus({
        page: Math.max(1, Number(u.searchParams.get('page') ?? '1') || 1),
        annotationKey: u.searchParams.get('annotation'),
        nonce: Date.now()
      })
    } catch {
      /* 忽略非法深链 */
    }
  }, [])

  useEffect(() => {
    return window.api.onDeepLink((url) => {
      void handleDeepLinkUrl(url)
    })
  }, [handleDeepLinkUrl])

  const addToNote = useCallback(
    async (annotationId: number): Promise<void> => {
      if (activeItemId == null) return
      await window.api.notes.addAnnotation(activeItemId, annotationId)
      setNotesRefresh((n) => n + 1)
    },
    [activeItemId]
  )

  const openTarget = useCallback(
    (target: {
      itemId: number | null
      attachmentId: number | null
      page: number | null
      rect?: [number, number, number, number] | null
    }): void => {
      setWorkspace('reader'); setReaderOpened(true); setMindmapOpen(false); setKnowledgeOpen(false)
      // 跳到另一篇文档/附件时清掉上一次全文命中带入的查找（同文档内跳页则保留，由 findRequest 重放）
      const switching =
        (target.itemId != null && target.itemId !== activeItemId) ||
        (target.attachmentId != null && target.attachmentId !== activeAttachmentId)
      if (switching) clearHitFind()
      if (target.itemId != null) setActiveItemId(target.itemId)
      if (target.attachmentId != null) setActiveAttachmentId(target.attachmentId)
      if (target.page != null) {
        const page = Math.max(1, Math.floor(target.page))
        // 同步写入受控页码：目标文档尚未打开时 PdfViewer 会在本次渲染里挂载，
        // 它拿到的 initialPage/syncPage 就是 readPage 的当前值。只靠下方 focus effect（被动 effect）
        // 事后回写会让新视图首帧停在旧页，并把旧页回传覆盖掉命中页（文库命中行跳页 bug）。
        setReadPage(page)
        setFocus({
          page,
          annotationKey: null,
          nonce: Date.now(),
          rect: target.rect ?? null
        })
      }
    },
    [activeItemId, activeAttachmentId, clearHitFind]
  )

  const openTranslation = useCallback(
    (t: TranslationTarget, mode: ViewMode): void => {
      setWorkspace('reader'); setReaderOpened(true); setMindmapOpen(false); setKnowledgeOpen(false)
      if (t.itemId != null) setActiveItemId(t.itemId)
      setTranslation(t.translation)
      setViewMode(mode)
      // 若目标附件与当前不同，记录待应用的视图，待附件切换后由 effect 生效
      if (activeAttachmentId !== t.translation.attachment_id) {
        pendingView.current = mode === 'original' ? null : mode
        setActiveAttachmentId(t.translation.attachment_id)
      }
    },
    [activeAttachmentId]
  )

  const openHit = useCallback(
    async (h: SearchHit, query = ''): Promise<void> => {
      // 译文命中：直接切到该论文的「译文」视图（既有行为，保持不变）
      if (h.kind === 'translation' && h.attachmentId != null) {
        const t = await window.api.translate.get(h.attachmentId, h.translationLang ?? 'zh')
        if (t) {
          openTranslation(
            { translation: t, itemId: h.itemId },
            'bilingual'
          )
          // 与 openTarget 同一道理：命中页必须和视图切换在同一次更新里写进 readPage，
          // 否则对照视图挂载时 initialPage 还是旧页，首帧跳过命中页。
          if (h.page != null && h.page >= 1) setReadPage(Math.max(1, Math.floor(h.page)))
          return
        }
      }
      const q = query.trim()
      // 先跳页（openTarget 在切文档时会清掉旧命中带入的查找），再把本次命中词带入查找框
      openTarget({ itemId: h.itemId, attachmentId: h.attachmentId, page: h.page })
      if (q) {
        findFromHitRef.current = q
        findReqNonceRef.current += 1
        setFindQuery(q)
        setFindRequest({
          query: q,
          page: h.page != null && h.page >= 1 ? h.page : 1,
          nonce: findReqNonceRef.current
        })
      }
    },
    [openTarget, openTranslation]
  )

  const panelBase: Omit<PanelContext, 'active'> = {
    itemId: activeItemId,
    attachmentId: activeAttachmentId,
    items,
    notesRefresh,
    theme,
    onDeepLink: (url: string) => void handleDeepLinkUrl(url),
    onOpenTarget: openTarget,
    onOpenPanel: selectTab,
    onOpenNotes: (id: number) => {
      setActiveItemId(id)
      selectTab('notes')
    },
    onOpenTranslation: openTranslation,
    onLibraryChanged: () => void refresh(),
    onNotesChanged: () => setNotesRefresh((n) => n + 1),
    translation,
    viewMode,
    translating,
    translateProgress: progress,
    translateRatio,
    onRunTranslate: runTranslate,
    onCancelTranslate: cancelTranslate,
    onSetViewMode: setViewMode,
    partial,
    onClearPartial: () => setPartial(null),
    aiRequest,
    onAskSelection: handleAskSelection,
    onClearAiRequest: () => setAiRequest(null),
    pendingBatchTask,
    onConsumePendingBatchTask: () => setPendingBatchTask(null),
    pendingDiscoveryFilter,
    onConsumePendingDiscoveryFilter: () => setPendingDiscoveryFilter(null),
    onExpandCitations: (itemId: number, filter: GraphNodeKind) => {
      setActiveItemId(itemId)
      setPendingDiscoveryFilter(filter)
      selectTab('discovery')
    },
    onAddToBatch: (taskId: string) => {
      setPendingBatchTask(taskId)
      selectTab('batch')
    },
    onSearchWorks: (query: string) => {
      setPendingWorksQuery(query)
      selectTab('works')
    },
    pendingWorksQuery,
    onConsumePendingWorksQuery: () => setPendingWorksQuery(null),
    onOpenSettings: () => openSettings(),
    groupName: aiGroupName,
    groupLabel: aiGroupLabel
  }

  const handleImport = async (group?: string | null): Promise<void> => {
    const res = await window.api.library.importPdfs(group)
    if (res.canceled || res.items.length === 0) return
    await refresh()
    const last = res.items[res.items.length - 1]
    // 导入后打开新文档：清掉上一次全文命中带入的查找，避免幽灵高亮
    clearHitFind()
    setActiveItemId(last.item.id)
    setActiveAttachmentId(last.attachment.id)
    if (res.items.length > 1) setProgress(res.message)
  }

  const handleImportFolder = async (group?: string | null): Promise<void> => {
    const res = await window.api.library.importFolder(group)
    if (!res) return
    await refresh()
    const extra = res.errors.length ? `（部分失败：${res.errors.join('；')}）` : ''
    setProgress(`批量导入完成：成功 ${res.imported} · 跳过 ${res.skipped}${extra}`)
  }

  const handleDeleteItem = async (itemId: number): Promise<void> => {
    if (!window.confirm('确定删除该条目？')) return
    try {
      await window.api.library.delete(itemId)
    } finally {
      setActiveItemId((prev) => (prev === itemId ? null : prev))
      await refresh()
    }
  }

  const activeItem = items.find((i) => i.id === activeItemId) ?? null
  const openDocs = openDocIds
    .map((id) => items.find((i) => i.id === id))
    .filter((x): x is Item => x != null)

  // ---- 公共工具栏（固定常驻）：页码 / 缩放 / 联动 / 查找 ----
  /** 是否有「活动 PDF 视图」：原文 与 中英对照（左右两侧均为 PDF）都支持页码/缩放 */
  const hasPdfView =
    activeAttachmentId != null && (viewMode === 'original' || viewMode === 'bilingual')

  const gotoPage = (n: number): void => {
    if (!Number.isFinite(n)) return
    const max = readNumPages > 0 ? readNumPages : Math.max(1, Math.floor(n))
    setReadPage(Math.max(1, Math.min(Math.floor(n), max)))
  }

  /** 只重译当前页；完成后换缓存 key，避免继续显示旧的 PDF 字节。 */
  const retranslateCurrentPage = async (): Promise<void> => {
    if (!translation?.path || rePageBusy) return
    // 预加载脚本不能热更新；渲染层先升级而主窗口仍是旧进程时，
    // 这里会是 undefined，直接报“不是函数”让人误以为是功能没做。
    if (typeof window.api.translate?.retranslatePage !== 'function') {
      setProgress('当前运行的还是旧版本：请完全退出 PaperDesk（含托盘）后重新启动，再重译本页。')
      return
    }
    const page = Math.max(1, Math.floor(readPage))
    setRePageBusy(true)
    setProgress(`正在重译第 ${page} 页…`)
    try {
      const next = await window.api.translate.retranslatePage(translation.id, page)
      setTranslation(next)
      const epoch = translationEpoch + 1
      setTranslationEpoch(epoch)
      preloadTranslationDoc(next.id, epoch)
      setProgress(`第 ${page} 页已重译`)
    } catch (e) {
      setProgress(`重译第 ${page} 页失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRePageBusy(false)
    }
  }

  const zoomOut = (): void => {
    setZoomFit(false)
    setReadScale((s) => Math.max(0.5, +(s - 0.2).toFixed(2)))
  }
  const zoomIn = (): void => {
    setZoomFit(false)
    setReadScale((s) => Math.min(4, +(s + 0.2).toFixed(2)))
  }
  const zoomToFit = (): void => {
    setZoomFit(true)
    setFitNonce((n) => n + 1)
  }

  /** 活动视图有效缩放变化：跟随显示；用户手势缩放时退出「适应宽度」 */
  const handleScaleChange = useCallback((s: number, opts?: { fit?: boolean }): void => {
    setReadScale(s)
    if (opts && opts.fit === false) setZoomFit(false)
  }, [])

  /** 顶栏「明暗」快捷开关：切换并持久化主题（等价于设置里的界面明暗） */
  const toggleTheme = useCallback((): void => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    setTheme(next)
    void window.api.settings.save({ ui: { theme: next } }).catch(() => undefined)
  }, [theme])

  /** 聚焦活动窗格查找框（对照左侧为 PDF 时优先；缺失则忽略） */
  // 左栏折叠时必须同步减少**网格列数**：折叠后只渲染「窄条 + 主区」两个子元素，
  // 若仍保留 3 列，主区会落进 0px 的分隔条列 → 整页空白。
  useEffect(() => { if (viewMode === 'bilingual') setCompareOpened(true) }, [viewMode])
  const enterWorkspace = (next: Workspace): void => {
    setWorkspace(next)
    setMindmapOpen(false)
    setKnowledgeOpen(false)
    if (next === 'library') { setLeftView('library'); setSbCollapsed(false); setLayoutMode('library') }
    if (next === 'reader') { setReaderOpened(true); setSbCollapsed(true); setLayoutMode('library') }
    if (next === 'knowledge') { setKnowledgeOpen(true); setSbCollapsed(true) }
    if (next === 'research') selectTab('works')
    if (next === 'tasks') selectTab('batch')
  }
  useEffect(() => {
    if (mindmapOpen || knowledgeOpen) setWorkspace('knowledge')
  }, [mindmapOpen, knowledgeOpen])
  useEffect(() => {
    if (leftView !== 'panel') return
    if (PANELS.find((p) => p.id === rightTab)?.group === 'data') setWorkspace('tasks')
    else if (PANELS.find((p) => p.id === rightTab)?.group === 'research') setWorkspace('research')
    else { setWorkspace('reader'); setReaderOpened(true) }
  }, [leftView, rightTab])
  useEffect(() => {
    if (!commandOpen) return
    const previous = document.activeElement as HTMLElement | null
    const trap = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const elements = Array.from(document.querySelectorAll<HTMLElement>('.command-dialog button, .command-dialog input'))
      const first = elements[0], last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => { document.removeEventListener('keydown', trap); previous?.focus() }
  }, [commandOpen])
  useEffect(() => {
    document.documentElement.dataset.density = density
    localStorage.setItem('paperdesk.ui.density', density)
  }, [density])
  useEffect(() => window.api.onBatchProgress((p) => {
    setTaskStatus(p.status === 'running' ? `处理中 ${p.done}/${p.total}` : p.status === 'failed' ? '有任务失败' : '后台任务')
  }), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setCommandOpen((open) => !open)
      }
      if (workspace === 'reader' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        const tag = (event.target as HTMLElement)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          event.preventDefault(); setReaderMore(true)
          window.setTimeout(() => document.querySelector<HTMLInputElement>('[data-testid=find-input]')?.focus(), 0)
        }
      }
      if (event.key === 'Escape') setCommandOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workspace])
  const sidebarCollapsed = sbCollapsed || leftView === null
  return (
    <Suspense fallback={<div className="workspace-loading" role="status">正在载入工作区…</div>}>
    <div className="desk-shell" data-workspace={workspace}>
      <header className="desk-header">
        <button className="desk-brand" onClick={() => enterWorkspace('library')}><span><Icon name="book" size={21} /></span>PaperDesk</button>
        <span className="desk-breadcrumb">{({ library: '文库', reader: '阅读工作区', knowledge: '知识工作区', research: '文献研究', tasks: '任务中心' })[workspace]}</span>
        <button className="desk-command" data-testid="command-open" onClick={() => setCommandOpen(true)}><Icon name="search" size={15} /><span>搜索论文与功能</span><kbd>Ctrl K</kbd></button>
        {workspace === 'reader' && <button className="ghost" onClick={() => applyLayout(layoutMode === 'focus' ? 'library' : 'focus')}>{layoutMode === 'focus' ? '退出专注' : '专注阅读'}</button>}
        <button className="ghost" onClick={() => setDensity((d) => d === 'compact' ? 'comfortable' : 'compact')}>{density === 'compact' ? '紧凑' : '标准'}</button>
        <button className="icon ghost" aria-label="切换明暗主题" onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} /></button>
      </header>
      <nav className="desk-nav" aria-label="主工作区">
        {([{ id: 'library', title: '文库', icon: 'library' }, { id: 'reader', title: '阅读', icon: 'book' }, { id: 'knowledge', title: '知识', icon: 'graph' }, { id: 'research', title: '研究', icon: 'search' }, { id: 'tasks', title: '任务', icon: 'list' }] as const).map((nav) => <button key={nav.id} className={workspace === nav.id ? 'desk-nav__item active' : 'desk-nav__item'} aria-current={workspace === nav.id ? 'page' : undefined} data-testid={`workspace-${nav.id}`} onClick={() => enterWorkspace(nav.id)}><Icon name={nav.icon} size={20} /><span>{nav.title}</span></button>)}
        <div className="desk-nav__spacer" /><button className="desk-nav__item" onClick={() => openSettings()} aria-label="打开设置"><Icon name="settings" size={20} /><span>设置</span></button>
      </nav>
    <div
      className="app desk-content" data-workspace={workspace} data-left-view={leftView || ''} data-tool={leftView === 'panel' && !sidebarCollapsed ? rightTab : ''}
      style={{
        gridTemplateColumns: workspace === 'tasks' || workspace === 'research' || workspace === 'knowledge'
          ? 'minmax(0, 1fr)'
          : !sidebarCollapsed && ((workspace === 'reader' && leftView === 'panel') || (workspace === 'library' && leftView === 'detail'))
            ? `minmax(0, 1fr) 5px ${Math.max(320, effSbW)}px`
            : sidebarCollapsed ? '32px minmax(0, 1fr)' : `${workspace === 'library' ? Math.min(280, effSbW) : effSbW}px 5px minmax(0, 1fr)`
      }}
    >
      {sidebarCollapsed ? (
        <div className="side-strip side-strip--left" data-testid="sb-strip">
          <button
            className="icon ghost"
            title="展开文库栏"
            data-testid="sb-expand"
            onClick={() => {
              setLeftView((v) => v ?? 'library')
              setSbCollapsed(false)
            }}
          >
            <Icon name="right" size={16} />
          </button>
          <span className="side-strip__label">文库</span>
        </div>
      ) : leftView === 'detail' && detailItemId != null ? (
        <ItemDetailPanel
          itemId={detailItemId}
          onBack={closeItemDetail}
          onOpenItem={selectItem}
          onOpenNotes={(id) => {
            selectItem(id)
            selectTab('notes')
          }}
          onLibraryChanged={() => void refresh()}
        />
      ) : leftView === 'toc' ? (
        <TocPanel
          numPages={readNumPages}
          page={readPage}
          onGoPage={(n) => gotoPage(n)}
          onCollapse={() => setSbCollapsed(true)}
        />
      ) : leftView === 'panel' ? (
        <div className="leftpanels" data-testid="left-panel">
          <div className="leftpanels__bar">
            <span className="leftpanels__title">
              {PANELS.find((p) => p.id === rightTab)?.title ?? '面板'}
            </span>
            <span className="toolbar__spacer" />
            <button
              className="icon ghost"
              title="折叠左栏（腾出更多阅读空间）"
              data-testid="panel-collapse"
              onClick={() => { if (workspace === 'reader') setSbCollapsed(true); else enterWorkspace('reader') }}
            >
              <Icon name="left" size={15} />
            </button>
          </div>
          {(workspace === 'research' || workspace === 'tasks') && <div className="workspace-panel-tabs">{PANELS.filter((p) => workspace === 'tasks' ? p.group === 'data' : p.group === 'research').map((p) => <button key={p.id} className={rightTab === p.id ? 'on' : ''} onClick={() => selectTab(p.id)}>{p.title}</button>)}</div>}
          <div className="leftpanels__body">
            {PANELS.filter((p) => visited.has(p.id)).map((p) => (
              <div
                key={p.id}
                className="panelwrap"
                style={{ display: rightTab === p.id ? undefined : 'none' }}
              >
                <ErrorBoundary
                  label={`${p.title} 面板出错了`}
                  resetKey={`${p.id}-${activeItemId ?? 'none'}-${activeAttachmentId ?? 'none'}`}
                >
                  <Suspense fallback={<div className="workspace-loading" role="status">正在载入{p.title}…</div>}>{p.render({ ...panelBase, active: rightTab === p.id })}</Suspense>
                </ErrorBoundary>
              </div>
            ))}
            {visited.size === 0 && <div className="list__hint">从顶栏选择一个功能</div>}
          </div>
        </div>
      ) : (
        <LibraryList
          items={items}
          activeId={activeItemId}
          onSelect={selectItem}
          onImport={handleImport}
          onImportFolder={handleImportFolder}
          onLibraryChanged={() => void refresh()}
          onShowDetail={openItemDetail}
          onDelete={handleDeleteItem}
          onOpenHit={(h: SearchHit, q: string) => void openHit(h, q)}
          onCollapse={() => setSbCollapsed(true)}
          focusSearch={leftView === 'search'}
          groupFilter={groupFilter}
          onGroupFilterChange={setGroupFilter}
        />
      )}

      {!sidebarCollapsed && (
        <div className="splitter" title="拖动调整宽度" onMouseDown={(e) => startDrag(e)} />
      )}

      <div className="main">
        <TabsBar
          docs={openDocs}
          activeId={activeItemId}
          onSelect={selectItem}
          onClose={closeDoc}
        />
        <div className={`toolbar${readerMore ? ' toolbar--expanded' : ''}`} data-testid="common-toolbar">
          {attachments.length > 1 ? (
            <select
              value={activeAttachmentId ?? ''}
              onChange={(e) => setActiveAttachmentId(Number(e.target.value))}
            >
              {attachments.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.filename}
                </option>
              ))}
            </select>
          ) : (
            <span className="toolbar__name" title={activeItem?.title ?? ''}>
              {activeItem?.title ?? '未选择'}
            </span>
          )}

          <button className="ghost reader-more" aria-expanded={readerMore} onClick={() => setReaderMore((v) => !v)}><Icon name="settings" size={14} />{readerMore ? '收起工具' : '更多工具'}</button>
          {/* 阅读模式：原文 / 中英对照（始终渲染；不可用时置灰） */}
          <div className="seg" data-testid="view-modes">
            <button
              className={viewMode === 'original' ? 'on' : ''}
              data-testid="view-original"
              title="查看原文 PDF（公式保持原样，便于提取公式/定理）"
              onClick={() => setViewMode('original')}
            >
              原文
            </button>
            <button
              className={viewMode === 'bilingual' ? 'on' : ''}
              data-testid="view-bilingual"
              disabled={!translation?.path}
              title={translation?.path ? '中英对照（左右并排 + 连续滚动同步）' : '尚无译文，先点「翻译」'}
              onClick={enterBilingual}
            >
              中英对照
            </button>
          </div>

          <span className="toolbar__spacer" />

          {/* 页码：无活动 PDF 视图时置灰 */}
          <div className="group" title="页码导航">
            <button
              className="icon ghost"
              title="上一页"
              data-testid="toolbar-page-prev"
              disabled={!hasPdfView || readPage <= 1}
              onClick={() => gotoPage(readPage - 1)}
            >
              <Icon name="left" size={15} />
            </button>
            <span className="toolbar__zoom" data-testid="toolbar-page-label">
              {readPage} / {readNumPages}
            </span>
            <button
              className="icon ghost"
              title="下一页"
              data-testid="toolbar-page-next"
              disabled={!hasPdfView || (readNumPages > 0 && readPage >= readNumPages)}
              onClick={() => gotoPage(readPage + 1)}
            >
              <Icon name="right" size={15} />
            </button>
            <input
              className="readerbar__jump"
              type="number"
              min={1}
              max={readNumPages > 0 ? readNumPages : undefined}
              placeholder="页码"
              value={pageInput}
              data-testid="toolbar-page"
              title="输入页码后回车跳转"
              disabled={!hasPdfView}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  gotoPage(Number(pageInput))
                  setPageInput('')
                }
              }}
            />
          </div>

          <button
            className="ghost toolbar-secondary"
            title={
              translation?.path
                ? `只重译当前第 ${readPage} 页（约 10-30 秒），其余页不动`
                : '尚无译文'
            }
            data-testid="toolbar-retranslate-page"
            disabled={!translation?.path || rePageBusy || !hasPdfView}
            onClick={() => void retranslateCurrentPage()}
          >
            <Icon name="refresh" size={14} />
            {rePageBusy ? '重译中…' : '重译本页'}
          </button>

          <button
            className="ghost toolbar-secondary"
            title="页面管理：删除页面（生成新版本，可撤销，原文件保留）"
            data-testid="toolbar-page-edit"
            disabled={!hasPdfView || activeAttachmentId == null}
            onClick={() => setPagesOpen(true)}
          >
            <Icon name="trash" size={14} />
            页面
          </button>

          {/* 缩放：无活动 PDF 视图时置灰 */}

          <div className="group" title="缩放（也可用 Ctrl+滚轮 / 触控板捏合）">
            <button
              className="ghost"
              title="适应宽度"
              data-testid="toolbar-zoom-fit"
              disabled={!hasPdfView}
              onClick={zoomToFit}
            >
              适应宽度
            </button>
            <button
              className="icon ghost"
              title="缩小"
              data-testid="toolbar-zoom-out"
              disabled={!hasPdfView}
              onClick={zoomOut}
            >
              <Icon name="minus" size={15} />
            </button>
            <span className="toolbar__zoom" data-testid="toolbar-zoom">
              {Math.round(readScale * 100)}%
            </span>
            <button
              className="icon ghost"
              title="放大"
              data-testid="toolbar-zoom-in"
              disabled={!hasPdfView}
              onClick={zoomIn}
            >
              <Icon name="plus" size={15} />
            </button>
          </div>

          {/* 联动：仅「中英对照」视图有意义（左右并排 + 连续滚动同步） */}
          <label
            className="compare-toolbar__sync"
            title="联动：滚动/翻页时同步另一侧（仅「中英对照」视图有效）"
          >
            <input
              type="checkbox"
              data-testid="toolbar-sync"
              checked={sync}
              disabled={viewMode !== 'bilingual'}
              onChange={(e) => setSync(e.target.checked)}
            />
            联动
          </label>

          <div className="group toolbar-secondary" data-testid="toolbar-find" title="在当前文档中查找">
            <Icon name="search" size={15} />
            <input
              className="readerbar__jump"
              style={{ width: 120 }}
              placeholder="查找…"
              value={findQuery}
              data-testid="find-input"
              disabled={!hasPdfView}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setFindNextTick((n) => n + 1)
              }}
            />
            <span className="toolbar__zoom" data-testid="find-count">
              {findStatus.count > 0 ? `${findStatus.index + 1}/${findStatus.count}` : '0'}
            </span>
            <button
              className="icon ghost"
              title="上一处"
              data-testid="find-prev"
              disabled={!hasPdfView || findStatus.count === 0}
              onClick={() => setFindPrevTick((n) => n + 1)}
            >
              <Icon name="chevron-up" size={14} />
            </button>
            <button
              className="icon ghost"
              title="下一处"
              data-testid="find-next"
              disabled={!hasPdfView || findStatus.count === 0}
              onClick={() => setFindNextTick((n) => n + 1)}
            >
              <Icon name="chevron-down" size={14} />
            </button>
          </div>

          {/* 侧栏入口：文件库 / 目录 / 搜索 / 笔记（收起后入口仍可见） */}
          <div className="group entries toolbar-secondary" data-testid="side-entries">
            <button
              className={leftView === 'library' && !sbCollapsed ? 'on' : ''}
              data-testid="entry-library"
              title="左侧：文件库"
              onClick={() => toggleLeft('library')}
            >
              文件库
            </button>
            <button
              className={leftView === 'toc' && !sbCollapsed ? 'on' : ''}
              data-testid="entry-toc"
              title="左侧：目录"
              onClick={() => toggleLeft('toc')}
            >
              目录
            </button>
            <button
              className={leftView === 'search' && !sbCollapsed ? 'on' : ''}
              data-testid="entry-search"
              title="左侧：搜索"
              onClick={() => toggleLeft('search')}
            >
              搜索
            </button>
          </div>

          {/* 解析检查（只读）：按阅读顺序查看结构化块；默认关闭，打开时显示在阅读区右侧 */}
          <button
            className={(parseCheckOpen ? 'ghost mindmap-toggle on' : 'ghost mindmap-toggle') + ' toolbar-secondary'}
            title="解析检查：按阅读顺序查看结构化块（只读，不改变解析结果）"
            data-testid="toolbar-parse-check"
            aria-pressed={parseCheckOpen}
            disabled={activeAttachmentId == null}
            onClick={toggleParseCheck}
          >
            <Icon name="list" size={14} />
            解析检查
          </button>

          <button
            className={(mindmapOpen ? 'ghost mindmap-toggle on' : 'ghost mindmap-toggle') + ' toolbar-secondary'}
            title="思维地图（当前文献）"
            data-testid="toolbar-mindmap"
            disabled={activeItemId == null}
            onClick={() => setMindmapOpen((open) => !open)}
          >
            <Icon name="graph" size={14} />
            思维地图
          </button>

          {/* 知识库入口（PD36）：与思维地图并列，随时可打开，不依赖当前文献 */}
          <button
            className={(knowledgeOpen ? 'ghost mindmap-toggle on' : 'ghost mindmap-toggle') + ' toolbar-secondary'}
            title="知识库：查看已发布条目（提案请先到暂存区审核）"
            data-testid="knowledge-open"
            onClick={() => {
              setStagingOpen(false)
              setKnowledgeOpen((open) => !open)
            }}
          >
            <Icon name="library" size={14} />
            知识库
          </button>

          {/* 知识库暂存区入口（PD34）：随时可打开，不依赖当前文献 */}
          <button
            className={(stagingOpen ? 'ghost mindmap-toggle on' : 'ghost mindmap-toggle') + ' toolbar-secondary'}
            title="暂存区：审核 AI 提案后再发布到知识库"
            data-testid="toolbar-staging"
            onClick={() => {
              setKnowledgeOpen(false)
              setStagingOpen((open) => !open)
            }}
          >
            <Icon name="layers" size={14} />
            暂存区
          </button>

          {progress && <span className="toolbar__status">{progress}</span>}
          <button
            className="ghost"
            title="保版式翻译"
            disabled={translating || activeAttachmentId == null}
            onClick={() => void runTranslate('zh', 'fine')}
          >
            <Icon name="translate" size={15} />
            {translating ? '翻译中…' : '翻译'}
          </button>

          <span className="toolbar__spacer" />
          <button
            className="icon ghost toolbar-header-action"
            title={theme === 'dark' ? '切换到浅色界面' : '切换到深色界面'}
            data-testid="toggle-theme"
            onClick={() => toggleTheme()}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
          </button>
          <button
            className="icon ghost toolbar-header-action"
            title="设置（界面明暗 / 模型服务与 API 配置）"
            data-testid="open-settings-top"
            onClick={() => openSettings()}
          >
            <Icon name="settings" size={15} />
          </button>
        </div>

        {/* 功能区（WPS 式）：分组 + 面板按钮，位于顶栏；面板内容渲染在左侧功能区 */}
        <div
          className={layoutMode === 'focus' ? 'funcbar funcbar--hidden' : 'funcbar'}
          data-testid="ribbon"
        >

          {/* 文件库本身也是一个「功能」：任何时候都能一键返回 */}
          <button
            className={leftView === 'library' && !sbCollapsed ? 'primary' : ''}
            data-testid="panel-tab-library"
            title="文件库"
            onClick={() => {
              setPanelAdjusted(true)
              setLeftView('library')
              setSbCollapsed(false)
            }}
          >
            <Icon name="library" size={14} />
            文件库
          </button>
          <div className="ribbon__row ribbon__row--groups" data-testid="ribbon-groups">
            {PANEL_GROUPS.map((g) => (
              <button
                key={g.id}
                className={activeGroup === g.id ? 'primary' : ''}
                onClick={() => {
                  setActiveGroup(g.id)
                  const first = PANELS.find((p) => p.group === g.id)
                  if (first) selectTab(first.id)
                }}
              >
                {g.title}
              </button>
            ))}
          </div>
          <div className="ribbon__row ribbon__row--panels" data-testid="ribbon-panels">
            {PANELS.filter((p) => p.group === activeGroup).map((p) => (
              <button
                key={p.id}
                className={leftView === 'panel' && rightTab === p.id ? 'primary' : ''}
                data-testid={`panel-tab-${p.id}`}
                title={p.title}
                onClick={() => selectTab(p.id)}
              >
                <Icon name={p.icon} size={14} />
                {p.title}
              </button>
            ))}
          </div>
          <div className="ribbon__row ribbon__row--layout" data-testid="ribbon-layout">
            <button
              className={layoutMode === 'library' ? 'primary' : ''}
              data-testid="layout-library"
              title="整理文库：展开文件库与面板，便于批量整理（各自记住栏宽与入口）"
              onClick={() => applyLayout('library')}
            >
              <Icon name="library" size={14} />
              整理文库
            </button>
            <button
              className={layoutMode === 'focus' ? 'primary' : ''}
              data-testid="layout-focus"
              title="专注阅读：收起左栏与功能区，把空间留给论文（再点返回）"
              onClick={() => applyLayout('focus')}
            >
              <Icon name="book" size={14} />
              专注阅读
            </button>
          </div>
        </div>

        {/* 专注阅读：功能区收起后仍需一个明显的退出入口 */}
        {layoutMode === 'focus' && (
          <button
            className="focus-exit"
            data-testid="layout-exit"
            title="退出专注阅读，回到整理文库布局"
            onClick={() => applyLayout('library')}
          >
            <Icon name="chevron-left" size={13} />
            退出专注阅读
          </button>
        )}

        <div className="viewer">
          {workspace === 'library' && <LibraryWorkspace items={items} group={groupFilter} activeId={activeItemId} loading={libraryLoading} error={libraryError} onRetry={() => void refresh()} onRead={(id) => { selectItem(id); setSbCollapsed(true) }} onDetail={(id) => { openItemDetail(id); setSbCollapsed(false) }} onDelete={(id) => void handleDeleteItem(id)} onImport={() => void handleImport(aiGroupName)} onImportFolder={() => void handleImportFolder(aiGroupName)} onSearch={() => { setLeftView('search'); setSbCollapsed(false) }} />}
          {readerOpened && <div className="reader-retained" style={{ display: workspace === 'reader' ? undefined : 'none' }}>
          <Suspense fallback={<div className="workspace-loading" role="status">正在打开论文…</div>}>
          <ErrorBoundary
            label="阅读器出错了"
            resetKey={`${activeAttachmentId ?? 'none'}-${translation?.id ?? 'none'}`}
          >
            {activeAttachmentId != null ? (
              // 译文存在时同时挂载「原文」和「对照」两套阅读器，用 CSS 切换可见性：
              // 切视图不再卸载/重建 PDF 版面，避免每次切换都重新解码、重排、重绘（用户看到白屏卡 10 秒）。
              <div className="viewer__stack">
                {translation?.path && (compareOpened || viewMode === 'bilingual') && (
                  <div
                    className="viewer__pane"
                    data-hidden={viewMode === 'bilingual' ? '0' : '1'}
                    aria-hidden={viewMode !== 'bilingual'}
                  >
                    <CompareView
                      attachmentId={activeAttachmentId}
                      translationId={translation.id}
                      reloadKey={translationEpoch}
                      itemId={activeItemId}
                      focus={focus}
                      onAddToNote={addToNote}
                      onTranslateSelection={handleTranslateSelection}
                      onTranslatePage={handleTranslatePage}
                      onAskSelection={handleAskSelection}
                      onSearchWorks={panelBase.onSearchWorks}
                      onOpenSettings={() => openSettings()}
                      page={readPage}
                      onPageChange={setReadPage}
                      onNumPages={setReadNumPages}
                      scale={readScale}
                      onScaleChange={handleScaleChange}
                      zoomFit={zoomFit}
                      onFitRequest={fitNonce}
                      sync={sync}
                      onSyncChange={setSync}
                      externalFindQuery={viewMode === 'bilingual' ? findQuery : undefined}
                      findNextTick={viewMode === 'bilingual' ? findNextTick : 0}
                      findPrevTick={viewMode === 'bilingual' ? findPrevTick : 0}
                      findRequest={viewMode === 'bilingual' ? findRequest : null}
                      findOwner={viewMode === 'bilingual'}
                      onFindStatus={
                        viewMode === 'bilingual'
                          ? (count, index) => setFindStatus({ count, index })
                          : undefined
                      }
                      onFindQueryChange={viewMode === 'bilingual' ? setFindQuery : undefined}
                    />
                  </div>
                )}
                <div
                  className="viewer__pane"
                  data-hidden={viewMode === 'bilingual' && translation?.path ? '1' : '0'}
                  aria-hidden={viewMode === 'bilingual' && !!translation?.path}
                >
                  <PdfViewer
                    attachmentId={activeAttachmentId}
                    translationId={null}
                    itemId={activeItemId}
                    focus={focus}
                    onAddToNote={addToNote}
                    onTranslateSelection={handleTranslateSelection}
                    onTranslatePage={handleTranslatePage}
                    onAskSelection={handleAskSelection}
                    onSearchWorks={panelBase.onSearchWorks}
                    onOpenSettings={() => setSettingsOpen(true)}
                    initialPage={readPage}
                    initialScale={zoomFit ? null : readScale}
                    syncPage={readPage}
                    onPageChangeExternal={setReadPage}
                    onNumPages={setReadNumPages}
                    scale={readScale}
                    onScaleChange={handleScaleChange}
                    zoomMode={zoomFit ? 'fit' : 'custom'}
                    onFitRequest={fitNonce}
                    hideToolbar
                    selectedBlock={selectedBlock}
                    blocks={parseBlocks}
                    onBlockPicked={handleSelectBlock}
                    externalFindQuery={viewMode === 'bilingual' ? undefined : findQuery}
                    findNextTick={viewMode === 'bilingual' ? 0 : findNextTick}
                    findPrevTick={viewMode === 'bilingual' ? 0 : findPrevTick}
                    findRequest={viewMode === 'bilingual' ? null : findRequest}
                    findOwner={viewMode !== 'bilingual'}
                    onFindStatus={
                      viewMode === 'bilingual'
                        ? undefined
                        : (count, index) => setFindStatus({ count, index })
                    }
                    onFindQueryChange={viewMode === 'bilingual' ? undefined : setFindQuery}
                  />

                {pagesOpen && activeAttachmentId != null && (
                  <PageEditDialog
                    attachmentId={activeAttachmentId}
                    pageCount={readNumPages}
                    onClose={() => setPagesOpen(false)}
                    onApplied={() => {
                      // 页数已变：译文与原文不再 1:1，清掉旧译文并强制重新加载 PDF
                      setTranslation(null)
                      setTranslationEpoch((n) => n + 1)
                    }}
                  />
                )}                </div>
              </div>
            ) : activeItemId != null ? (
              <ItemPreview
                itemId={activeItemId}
                onLibraryChanged={() => void refresh()}
                onOpenItem={selectItem}
              />
            ) : (
              <div className="empty">
                <Icon name="book" size={30} />
                <span>{items.length === 0 ? '点击左上角「导入」添加第一篇论文' : '该条目没有附件'}</span>
              </div>
            )}
          </ErrorBoundary>
          </Suspense></div>}
          {workspace === 'reader' && !readerOpened && <div className="workspace-loading">请选择论文开始阅读</div>}
          {/* 阶段二：思维地图 / 知识库在主工作区展开（不挡阅读器，可一键返回论文） */}
          {(mindmapOpen || knowledgeOpen) && (
            <div className="workspace-layer" data-testid="workspace-layer">
              <div className="workspace-layer__bar">
                <button
                  className="ghost"
                  data-testid="workspace-back"
                  title="返回论文"
                  onClick={() => {
                    setMindmapOpen(false)
                    setKnowledgeOpen(false)
                    setWorkspace('reader')
                    setReaderOpened(true)
                  }}
                >
                  <Icon name="chevron-left" size={14} />
                  返回论文
                </button>
                <div className="workspace-panel-tabs knowledge-tabs"><button className={knowledgeOpen ? 'on' : ''} onClick={() => { setKnowledgeOpen(true); setMindmapOpen(false) }}>知识库</button><button className={mindmapOpen ? 'on' : ''} disabled={activeItemId == null} onClick={() => { setKnowledgeOpen(false); setMindmapOpen(true) }}>思维地图</button><button onClick={() => setStagingOpen(true)}>暂存区审核</button></div>
                {mindmapOpen && activeItem?.title && (
                  <span className="workspace-layer__sub">{activeItem.title}</span>
                )}
              </div>
              <div className="workspace-layer__body"><Suspense fallback={<div className="workspace-loading">正在载入知识工作区…</div>}>
                {/* 主工作区展开仍用 overlay 变体：三级切换（论文/分组/全部）只在主窗口提供，
                    独立地图窗口（?mwindow=）才用 standalone；定位由 .workspace-layer .mindmap 接管 */}
                {mindmapOpen && activeItemId != null && (
                  <MindMapPanel
                    key={activeItemId}
                    itemId={activeItemId}
                    title={activeItem?.title ?? null}
                    onClose={() => enterWorkspace('reader')}
                  />
                )}
                {knowledgeOpen && (
                  <KnowledgePanel
                    variant="standalone"
                    onClose={() => enterWorkspace('reader')}
                    onOpenStaging={() => {
                      setStagingOpen(true)
                    }}
                    onOpenEmbedSettings={() => {
                      setStagingOpen(false)
                      openSettings('embed')
                    }}
                  />
                )}
              </Suspense></div>
            </div>
          )}
          {/* 右侧抽屉：只读解析检查。默认不渲染，打开时固定宽度，不挤压阅读器的横向滚动 */}
          {parseCheckOpen && (<Suspense fallback={<div className="overlay-loading">正在载入解析检查…</div>}>
            <ParseCheckPanel
              blocks={parseBlocks}
              onSelect={handleSelectBlock}
              selectedId={selectedBlockId}
              loading={parseLoading}
              error={parseError}
              emptyReason={parseEmptyReason}
            /></Suspense>
          )}
        </div>
      </div>

      {stagingOpen && (<Suspense fallback={<div className="overlay-loading" role="status">正在打开暂存区…</div>}>
        <StagingPanel
          onClose={() => setStagingOpen(false)}
          onOpenEvidence={(target) => openTarget(target)}
        /></Suspense>
      )}

      {settingsOpen && (<Suspense fallback={<div className="overlay-loading" role="status">正在打开设置…</div>}>
        <SettingsDialog
          initialSection={settingsSection}
          onClose={() => {
            setSettingsOpen(false)
            setSettingsSection(null)
          }}
          onThemeChange={(t) => setTheme(t === 'dark' ? 'dark' : 'light')}
          onOpenKnowledge={() => {
            setSettingsOpen(false)
            setStagingOpen(false)
            setKnowledgeOpen(true)
          }}
          onOpenStaging={() => {
            setSettingsOpen(false)
            setKnowledgeOpen(false)
            setStagingOpen(true)
          }}
        /></Suspense>
      )}
    </div>
      <footer className="desk-status"><span>{libraryLoading ? '正在读取文库…' : libraryError ? '文库读取失败' : `${items.length} 篇论文 · 本地文库已就绪`}</span><button onClick={() => enterWorkspace('tasks')}><Icon name="list" size={13} />{taskStatus}</button></footer>
      {commandOpen && <div className="command-overlay" onClick={() => setCommandOpen(false)}><section className="command-dialog" role="dialog" aria-modal="true" aria-label="搜索论文与功能" onClick={(e) => e.stopPropagation()}><div className="command-input"><Icon name="search" size={19} /><input autoFocus aria-label="搜索论文与功能" placeholder="搜索论文标题，或选择一个操作…" value={commandQuery} onChange={(e) => setCommandQuery(e.target.value)} /><button onClick={() => setCommandOpen(false)}>Esc</button></div><div className="command-results">{([{ title: '打开文库', run: () => enterWorkspace('library') }, { title: '继续阅读', run: () => enterWorkspace('reader') }, { title: '打开知识库', run: () => enterWorkspace('knowledge') }, { title: '文献检索', run: () => enterWorkspace('research') }, { title: '任务中心', run: () => enterWorkspace('tasks') }, { title: '翻译当前论文', run: () => { enterWorkspace('reader'); selectTab('translate') } }, { title: '打开笔记', run: () => { enterWorkspace('reader'); selectTab('notes') } }]).filter((c) => !commandQuery || c.title.includes(commandQuery)).map((c) => <button key={c.title} onClick={() => { c.run(); setCommandOpen(false) }}><Icon name="right" size={15} />{c.title}</button>)}{items.filter((i) => !commandQuery || i.title?.toLowerCase().includes(commandQuery.toLowerCase())).slice(0, 12).map((i) => <button key={i.id} onClick={() => { selectItem(i.id); setSbCollapsed(true); setCommandOpen(false) }}><Icon name="book" size={15} /><span>{i.title || '未命名论文'}</span></button>)}</div></section></div>}
    </div>
    </Suspense>
  )
}
