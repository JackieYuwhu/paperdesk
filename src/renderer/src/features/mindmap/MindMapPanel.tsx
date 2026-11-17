import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { Attachment, MindMapDoc, MindMapNode } from '@shared/types'
import { MINDMAP_SCOPE_MISSING_SUFFIX } from '@shared/mindmap-scope'
import { aiToolBlockReason, type AiToolState } from '@shared/ai-tools'
import type { MindmapScope, MindmapScopeDoc } from '@shared/mindmap-scope'
import { describeMindmapAiError, measureMindmapNode, stripMarkdownForMap } from '@shared/mindmap-ai'
import type { MindmapSupportResult } from '@shared/mindmap-ai'
import { MINDMAP_EXPORT_EMPTY, hasExportableContent } from '@shared/mindmap-export'
import type { MindmapExportFormat } from '@shared/mindmap-export'
import { Icon } from '../../components/Icon'
import { pdfjsLib } from '../../lib/pdf'
import {
  addChild,
  alignNodesToColumn,
  applyAiExpansion,
  clampMindmapZoom,
  createMindMap,
  findNode,
  flattenOutline,
  hasChildNodes,
  hiddenByCollapse,
  MINDMAP_DIGEST_SOURCE,
  MINDMAP_ZOOM_DEFAULT,
  MINDMAP_ZOOM_MAX,
  MINDMAP_ZOOM_MIN,
  mergeSkeleton,
  mindmapContentPoint,
  moveNodesBy,
  nextMindmapZoom,
  normalizeMindMap,
  rectsIntersect,
  removeDigestNodes,
  removeNode,
  removeNodes,
  renameNode,
  undoAiExpansion,
  zoomScrollAfterZoom
} from './mindmap-model'
import type { MindMapOutlineNode, MindMapSkeletonEntry } from './mindmap-model'
import { applyMapOptimize, buildMapOptimizePreview } from './mindmap-map-optimize'
import type { MindmapMapOptimizePreview } from './mindmap-map-optimize'

/** 兜底几何（节点文本读不到时仍能画边）；真实尺寸由 @shared/mindmap-ai 的测量函数给出 */
const NODE_W = 184
const NODE_H = 46
const MIN_CANVAS_W = 1280
const MIN_CANVAS_H = 820

/**
 * PD57：节点全文显示。尺寸测量统一放在 `@shared/mindmap-ai` 的 measureMindmapNode，
 * 渲染、连边、框选与聚合图布局共用同一份结果，避免「看起来换行了、算的还是一行」。
 */

/** 聚合节点标题去掉「（暂无内容）」后缀，作为编辑目标与提示里的论文名 */
function cleanPaperTitle(text: string): string {
  return text.replace(new RegExp(`${MINDMAP_SCOPE_MISSING_SUFFIX}$`, 'u'), '').trim() || '未命名文献'
}

/** 大纲与正文标题都拿不到时的统一提示（不造伪结构） */
const NO_STRUCTURE_TEXT = '该文献没有可用的章节结构'
const SKELETON_READING_TEXT = '正在分析论文结构…'
const AI_BUSY_TEXT = {
  summary: 'AI 正在生成摘要…',
  'map-optimize': 'AI 正在整理整张地图…',
  expand: 'AI 正在展开子节点…',
  support: 'AI 正在正文里找支撑段落…'
} as const

type MindmapAiKind = keyof typeof AI_BUSY_TEXT

/** 一次 AI 结果（绑定节点，切换选中节点后自动丢弃，避免写错地方） */
type MindmapAiResult =
  | { kind: 'summary'; nodeId: string; summary: string }
  | { kind: 'map-optimize'; preview: MindmapMapOptimizePreview }
  | { kind: 'support'; nodeId: string; support: MindmapSupportResult }

/** IPC 错误会带 "Error invoking remote method 'x': Error:" 前缀，去掉后才是给用户看的文案 */
function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/u, '')
    .replace(/^Error:\s*/u, '')
    .trim()
}

/** 从附件里挑第一个 PDF：骨架只认 PDF 大纲 / 正文标题结构 */
function pickPdfAttachment(list: ReadonlyArray<Attachment> | null | undefined): Attachment | null {
  for (const att of Array.isArray(list) ? list : []) {
    const type = (att.content_type || '').toLowerCase()
    const name = `${att.filename || ''} ${att.path || ''}`.toLowerCase()
    if (type.includes('pdf') || name.includes('.pdf')) return att
  }
  return null
}

/** 优先用 PDF 自带 outline；读失败/没有 outline 返回 []，由调用方退化到正文标题 */
async function readOutlineEntries(attachmentId: number): Promise<MindMapSkeletonEntry[]> {
  const bytes = await window.api.attachments.readBytes(attachmentId)
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) })
  try {
    const pdf = await task.promise
    const outline = await pdf.getOutline()
    return flattenOutline(outline as MindMapOutlineNode[] | null)
  } finally {
    void task.destroy()
  }
}

/** 没有 outline 时退化：用侧车结构化模块里的 section 标题（level 1/2）当章节 */
async function readSectionEntries(attachmentId: number): Promise<MindMapSkeletonEntry[]> {
  const structured = await window.api.reader.modules(attachmentId)
  const entries: MindMapSkeletonEntry[] = []
  for (const mod of structured?.modules ?? []) {
    if (mod.type !== 'section') continue
    const level = typeof mod.level === 'number' && Number.isFinite(mod.level) ? mod.level : 1
    entries.push({ title: mod.text, level })
  }
  return entries
}

export interface MindMapPanelProps {
  itemId: number
  title: string | null
  onClose: () => void
  /** overlay=阅读器内浮层；standalone=独立窗口（无遮罩、铺满，只显示单篇地图） */
  variant?: 'overlay' | 'standalone'
}

type MindmapLevel = 'paper' | 'group' | 'all'

interface DragOrigin {
  id: string
  x: number
  y: number
}

interface DragState {
  id: string
  startX: number
  startY: number
  /** 按下时被拖动节点的位置；多选整体拖动时对整组统一生效 */
  origins: DragOrigin[]
  /** 按下时的整份地图：每帧都从它重算绝对位置，避免累积误差 */
  base: MindMapDoc
  moved: boolean
}

/** 框选进行中：content 为画布内容坐标（已除以 zoom 并加上滚动量） */
interface MarqueeState {
  startX: number
  startY: number
  currentX: number
  currentY: number
  additive: boolean
  base: string[]
}

/** PD56：最近一次可撤销操作（AI 展开或批量删除共用同一个撤销按钮） */
interface UndoEntry {
  doc: MindMapDoc
  label: string
  selection: string[]
}

/** 缩放比例按文献记忆；键里带 itemId，重开面板能恢复上次比例 */
const ZOOM_STORAGE_PREFIX = 'paperdesk.mindmap.zoom.'

/**
 * 阅读器「思维地图」面板。
 *
 * 地图数据由主进程按文献 key 存 JSON；这里只负责交互：
 * 新增/改名/删除子树、拖动位置、必要时防抖保存。
 */
export function MindMapPanel({
  itemId,
  title,
  onClose,
  variant = 'overlay'
}: MindMapPanelProps): React.JSX.Element {
  const [doc, setDoc] = useState<MindMapDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState('')
  /** PD56：多选。selectedIds 是全部选中节点，selectedId 仍是「主节点」（改名/AI 用它） */
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  /** PD56：画布缩放（0.4–2.0，步进 0.1），论文级与聚合级共用 */
  const [zoom, setZoom] = useState(1)
  /** PD56：折叠节点的子树（纯 UI 状态，不写 JSON） */
  const [collapsedIds, setCollapsedIds] = useState<string[]>([])
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const [marqueeHits, setMarqueeHits] = useState<string[]>([])
  /** 批量删除二次确认：第一次点按只进入待确认，再点一次才真删 */
  const [bulkDeleteArmed, setBulkDeleteArmed] = useState(false)
  /** 批量操作的中文反馈（如「已删除 2 个节点，可用撤销上一步恢复」） */
  const [bulkNotice, setBulkNotice] = useState('')
  const [undoEntry, setUndoEntry] = useState<UndoEntry | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [saveError, setSaveError] = useState('')
  const [savedAt, setSavedAt] = useState('')
  const [skeletonBusy, setSkeletonBusy] = useState(false)
  const [skeletonNotice, setSkeletonNotice] = useState('')
  const [pendingSkeleton, setPendingSkeleton] = useState<MindMapSkeletonEntry[] | null>(null)
  const [aiBusy, setAiBusy] = useState<MindmapAiKind | null>(null)
  const [aiError, setAiError] = useState('')
  const [aiResult, setAiResult] = useState<MindmapAiResult | null>(null)
  /** PD57：AI 优化预览里被勾选的改动 id（默认全选，可逐项取消） */
  const [optimizePicked, setOptimizePicked] = useState<string[]>([])
  /** 最近一次 AI 展开生成的节点 id：只允许撤销这一次，且只删仍带 ai-generated 标记的节点 */
  const [pendingExpansion, setPendingExpansion] = useState<string[]>([])
  /** 正在导出的格式（非空时两个导出按钮都禁用，避免重复弹保存框） */
  const [exporting, setExporting] = useState<MindmapExportFormat | null>(null)
  const [exportNotice, setExportNotice] = useState('')
  const [exportError, setExportError] = useState('')
  /**
   * PD54：AI 工具库状态。思维地图 AI 被关掉时，三个 AI 按钮禁用并给出原因
   * （独立窗口也订阅同一个广播，改完开关立即生效）。
   */
  const [toolStates, setToolStates] = useState<AiToolState[] | null>(null)
  const mindmapAiBlocked = aiToolBlockReason(toolStates, [{ id: 'mindmap-ai' }])
  /** PD57/PD59：模型服务是否已配置。未配置时 AI 入口保持可点击，点后把原因写进错误区，不调模型、不改地图 */
  const [modelReady, setModelReady] = useState(false)
  const aiDisabledReason = mindmapAiBlocked
    ? `${mindmapAiBlocked}：到 设置 → AI 工具库 重新打开（或恢复默认）`
    : !modelReady
      ? '尚未配置模型服务：到 设置 → 模型服务 填写 Base URL、API Key 与模型 ID 后重试'
      : ''

  const panelRef = useRef<HTMLDivElement | null>(null)
  const docRef = useRef<MindMapDoc | null>(null)
  const pendingRef = useRef<MindMapDoc | null>(null)
  const timerRef = useRef<number | null>(null)
  const saveSeqRef = useRef(0)
  /** PD53：正在落盘的保存任务。flush 在无待存内容时也要等它，否则「返回聚合视图」
   *  会在 save IPC 写完前就去读盘，聚合图看到旧子节点。串行化也避免同文件乱序覆盖。 */
  const inflightSaveRef = useRef<Promise<void>>(Promise.resolve())
  const aliveRef = useRef(true)
  const dragRef = useRef<DragState | null>(null)

  /** 三级视图：论文（可编辑）/分组（只读聚合）/全部（只读聚合） */
  const [level, setLevel] = useState<MindmapLevel>('paper')
  const [scopeDoc, setScopeDoc] = useState<MindmapScopeDoc | null>(null)
  const [scopeLoading, setScopeLoading] = useState(false)
  const [scopeError, setScopeError] = useState('')
  const [openStatus, setOpenStatus] = useState('')
  const [groupName, setGroupName] = useState<string | null>(null)
  /** 切回论文级时 +1，强制重新从磁盘读取（新窗口里保存的位置才能显示） */
  const [paperEpoch, setPaperEpoch] = useState(0)
  /** PD53：聚合视图「编辑这篇」——在主窗口内切换到该论文的可编辑地图（null=面板自带文献） */
  const [editingPaperId, setEditingPaperId] = useState<number | null>(null)
  const [editingPaperTitle, setEditingPaperTitle] = useState<string | null>(null)
  /** 进入编辑前的聚合级别，供「返回聚合视图」原路返回 */
  const [editReturnLevel, setEditReturnLevel] = useState<MindmapLevel>('all')
  /** 聚合视图里最近点过的论文节点；默认取第一篇有地图的论文 */
  const [pickedPaperId, setPickedPaperId] = useState<number | null>(null)
  const [editNotice, setEditNotice] = useState('')
  const scopeSeqRef = useRef(0)
  /** 进入编辑时该论文在聚合图里的子节点数：用于区分「没有地图」与「地图文件损坏」 */
  const expectedChildCountRef = useRef(0)
  /** 载入标题：编辑另一篇论文时用它建根节点，避免沿用面板自带文献的标题 */
  const loadTitleRef = useRef<string | null>(title)
  loadTitleRef.current = editingPaperId != null ? editingPaperTitle : title
  /** 实际读写磁盘的文献：聚合视图里点「编辑这篇」后换成目标论文，不改既有 IPC */
  const activeItemId = editingPaperId ?? itemId

  /* ---------------- PD56：缩放 / 多选 / 批量操作的运行时状态 ---------------- */

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const zoomRef = useRef(1)
  /** 框选的实时状态：合成事件在同一批里连续派发时，state 还没重渲染，必须用 ref 兜底 */
  const marqueeRef = useRef<MarqueeState | null>(null)
  /** 缩放后要恢复的滚动量（在 useLayoutEffect 里应用，避免先闪一帧） */
  const zoomScrollRef = useRef<{ scrollLeft: number; scrollTop: number } | null>(null)
  /** reset 后要居中的标记（缩放值不变时 layoutEffect 不会触发） */
  const centerRequestRef = useRef(false)
  /** 最近一次渲染的画布尺寸，供 reset 居中计算 */
  const canvasSizeRef = useRef({ width: MIN_CANVAS_W, height: MIN_CANVAS_H })

  const persistZoom = useCallback(
    (value: number) => {
      try {
        window.localStorage.setItem(ZOOM_STORAGE_PREFIX + activeItemId, String(value))
      } catch {
        /* 隐私模式等写不进去时忽略：不影响本次会话 */
      }
    },
    [activeItemId]
  )

  /** 只选中一个节点（保持「主节点」语义，改名/AI 仍按它工作） */
  const selectOnly = useCallback((id: string) => {
    setSelectedId(id)
    setSelectedIds(id ? [id] : [])
    setBulkDeleteArmed(false)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedId('')
    setSelectedIds([])
    marqueeRef.current = null
    setMarquee(null)
    setMarqueeHits([])
    setBulkDeleteArmed(false)
  }, [])

  /** Ctrl/Shift+点击：追加或取消单个节点，并把刚点的节点设为主节点 */
  const toggleNodeSelection = useCallback(
    (id: string) => {
      const next = selectedIds.includes(id)
        ? selectedIds.filter((item) => item !== id)
        : [...selectedIds, id]
      setSelectedIds(next)
      setSelectedId(next.includes(id) ? id : (next[next.length - 1] ?? ''))
      setBulkDeleteArmed(false)
    },
    [selectedIds]
  )

  /**
   * 以屏幕坐标 clientX/clientY 为锚点缩放到 nextZoom：
   * 先算光标下的内容坐标，再按新比例反推滚动量，保证光标下的节点不动。
   */
  const zoomTo = useCallback(
    (nextZoom: number, clientX: number, clientY: number) => {
      const el = viewportRef.current
      const currentZoom = zoomRef.current
      const target = clampMindmapZoom(nextZoom)
      if (!el) {
        zoomRef.current = target
        setZoom(target)
        return
      }
      const rect = el.getBoundingClientRect()
      const result = zoomScrollAfterZoom({
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
        viewportLeft: rect.left,
        viewportTop: rect.top,
        pointerX: clientX,
        pointerY: clientY,
        zoom: currentZoom,
        nextZoom: target
      })
      zoomScrollRef.current = { scrollLeft: result.scrollLeft, scrollTop: result.scrollTop }
      zoomRef.current = target
      setZoom(target)
      persistZoom(target)
    },
    [persistZoom]
  )

  /** 工具栏按钮：以视口中心为锚点缩放 */
  const zoomByButton = useCallback(
    (direction: 1 | -1) => {
      const el = viewportRef.current
      const next = nextMindmapZoom(zoomRef.current, direction)
      if (next === zoomRef.current) return
      if (!el) {
        zoomRef.current = next
        setZoom(next)
        persistZoom(next)
        return
      }
      const rect = el.getBoundingClientRect()
      zoomTo(next, rect.left + el.clientWidth / 2, rect.top + el.clientHeight / 2)
    },
    [persistZoom, zoomTo]
  )

  /**
   * 根据画布实际尺寸把视口滚到中心（reset 与首次恢复到记忆比例时用）。
   * 画布尺寸来自 canvasSizeRef，滚动量按当前比例换算。
   */
  const centerViewport = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const size = canvasSizeRef.current
    el.scrollLeft = Math.max(0, (size.width * zoomRef.current - el.clientWidth) / 2)
    el.scrollTop = Math.max(0, (size.height * zoomRef.current - el.clientHeight) / 2)
  }, [])

  /** 回到 100% 并把视图居中 */
  const resetZoom = useCallback(() => {
    zoomRef.current = 1
    setZoom(1)
    persistZoom(1)
    centerRequestRef.current = true
    window.requestAnimationFrame(() => {
      if (!centerRequestRef.current) return
      centerRequestRef.current = false
      centerViewport()
    })
  }, [centerViewport, persistZoom])

  // 缩放值变化后一次性应用滚动补偿（在浏览器绘制前完成，锚点不跳动）
  useLayoutEffect(() => {
    const el = viewportRef.current
    const pending = zoomScrollRef.current
    if (el && pending) {
      el.scrollLeft = pending.scrollLeft
      el.scrollTop = pending.scrollTop
      zoomScrollRef.current = null
    }
    if (centerRequestRef.current) {
      centerRequestRef.current = false
      centerViewport()
    }
  }, [zoom, centerViewport])

  /** Ctrl/Command + 滚轮缩放：必须用非 passive 的原生监听才能 preventDefault */
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const direction: 1 | -1 = event.deltaY < 0 ? 1 : -1
      const next = nextMindmapZoom(zoomRef.current, direction)
      if (next === zoomRef.current) return
      zoomTo(next, event.clientX, event.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomTo, level, loading, scopeLoading, doc, scopeDoc])

  // PD54：读 AI 工具库并按主进程广播跟随（主窗口设置里改完，独立窗口也立即生效）
  useEffect(() => {
    let alive = true
    void window.api.aiTools.list().then(
      (r) => {
        if (alive) setToolStates(r.tools)
      },
      () => {
        /* 读不到按默认（可用）处理 */
      }
    )
    const off = window.api.onAiToolsChanged((r) => {
      setToolStates(r?.tools ?? null)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  /**
   * PD57：读模型服务配置。未配置时 AI 入口保持可点击，点击后在错误区给出可读原因；
   * 用户在设置里填好后切回窗口（focus）会自动恢复，不必重开面板。
   */
  useEffect(() => {
    let alive = true
    const check = (): void => {
      void window.api.settings.get().then(
        (s) => {
          if (!alive) return
          const p = s.provider
          setModelReady(Boolean(p && p.baseUrl && p.chatModel && p.apiKeySet))
        },
        () => {
          if (alive) setModelReady(false)
        }
      )
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      alive = false
      window.removeEventListener('focus', check)
    }
  }, [])

  // 分组名从条目自身读取（App.tsx 只传 itemId/title，不改它的调用面）
  useEffect(() => {
    let cancelled = false
    setGroupName(null)
    if (variant === 'standalone') return () => {
      cancelled = true
    }
    void window.api.library
      .get(itemId)
      .then((item) => {
        if (cancelled) return
        const raw = typeof item?.group_name === 'string' ? item.group_name.trim() : ''
        setGroupName(raw || null)
      })
      .catch(() => {
        if (!cancelled) setGroupName(null)
      })
    return () => {
      cancelled = true
    }
  }, [itemId, variant])

  /** 立即把最近一次待保存内容写盘；返回 Promise 供「切级/返回聚合」等场景等落盘后再读盘 */
  const flush = useCallback((): Promise<void> => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const next = pendingRef.current
    pendingRef.current = null
    if (!next) return inflightSaveRef.current
    const seq = ++saveSeqRef.current
    const task = inflightSaveRef.current.then(() =>
      window.api.mindmap
        .save(next.itemId, next)
        .then((saved) => {
          if (!aliveRef.current || seq !== saveSeqRef.current) return
          setSaveError('')
          setSavedAt(saved.updatedAt)
        })
        .catch((error: unknown) => {
          if (!aliveRef.current || seq !== saveSeqRef.current) return
          setSaveError(error instanceof Error ? error.message : '保存失败')
        })
    )
    inflightSaveRef.current = task
    return task
  }, [])

  const saveNow = useCallback(
    (next: MindMapDoc) => {
      pendingRef.current = next
      flush()
    },
    [flush]
  )

  const scheduleSave = useCallback(
    (next: MindMapDoc, delayMs: number) => {
      pendingRef.current = next
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        flush()
      }, delayMs)
    },
    [flush]
  )

  /** 统一提交本地变更：delay>0 时防抖（拖动），否则立即保存 */
  const apply = useCallback(
    (next: MindMapDoc, delayMs = 0) => {
      docRef.current = next
      setDoc(next)
      if (delayMs > 0) scheduleSave(next, delayMs)
      else saveNow(next)
    },
    [saveNow, scheduleSave]
  )

  // 载入当前文献的地图；没有则新建（根=文献标题）
  useEffect(() => {
    aliveRef.current = true
    let cancelled = false
    setLoading(true)
    setSaveError('')
    setDoc(null)
    docRef.current = null
    setEditingId(null)
    setDraggingId(null)
    setSelectedIds([])
    marqueeRef.current = null
    setMarquee(null)
    setMarqueeHits([])
    setBulkDeleteArmed(false)
    setBulkNotice('')
    setCollapsedIds([])
    setUndoEntry(null)
    zoomScrollRef.current = null
    // 按文献恢复上次的缩放比例（键含 itemId；读不到/非法值回落到 100%）
    let storedZoom: number | null = null
    try {
      const rawZoom = window.localStorage.getItem(ZOOM_STORAGE_PREFIX + activeItemId)
      if (rawZoom != null && rawZoom !== '') storedZoom = Number(rawZoom)
    } catch {
      storedZoom = null
    }
    const restoredZoom = clampMindmapZoom(storedZoom ?? MINDMAP_ZOOM_DEFAULT)
    zoomRef.current = restoredZoom
    setZoom(restoredZoom)
    setSkeletonBusy(false)
    setSkeletonNotice('')
    setPendingSkeleton(null)
    setAiBusy(null)
    setAiError('')
    setAiResult(null)
    setOptimizePicked([])
    setPendingExpansion([])
    setExporting(null)
    setExportNotice('')
    setExportError('')

    void window.api.mindmap
      .load(activeItemId)
      .then((raw) => {
        if (cancelled) return
        const expectedChildren = expectedChildCountRef.current
        expectedChildCountRef.current = 0
        const loadTitle = loadTitleRef.current
        const next = raw
          ? normalizeMindMap(raw, activeItemId, loadTitle)
          : createMindMap(activeItemId, loadTitle)
        docRef.current = next
        setDoc(next)
        setSelectedId(next.rootId)
        setSelectedIds([next.rootId])
        setSavedAt(next.updatedAt)
        setLoading(false)
        // 聚合图里有子节点却只读到空地图：地图文件缺失或 JSON 已损坏（主进程对两者都返回 null）
        setSaveError(
          expectedChildren > 0 && next.nodes.length <= 1
            ? '地图文件无法读取（可能已损坏），已显示空白地图；可重新生成骨架或手动新建节点'
            : ''
        )
      })
      .catch(() => {
        if (cancelled) return
        expectedChildCountRef.current = 0
        const next = createMindMap(activeItemId, loadTitleRef.current)
        docRef.current = next
        setDoc(next)
        setSelectedId(next.rootId)
        setSelectedIds([next.rootId])
        setLoading(false)
        setSaveError('读取失败，已新建空白地图')
      })

    return () => {
      cancelled = true
    }
  }, [activeItemId, paperEpoch])

  // 同一面板实例换文献时回到论文级，避免带着上一篇的分组/全部视图
  useEffect(() => {
    setLevel('paper')
    setScopeDoc(null)
    setScopeError('')
    setOpenStatus('')
    setEditingPaperId(null)
    setEditingPaperTitle(null)
    setPickedPaperId(null)
    setEditNotice('')
    expectedChildCountRef.current = 0
  }, [itemId])

  // 卸载时把未落盘的内容写出去（关闭面板 / 切换文献）
  useEffect(() => {
    return () => {
      aliveRef.current = false
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const next = pendingRef.current
      pendingRef.current = null
      if (next) void window.api.mindmap.save(next.itemId, next).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    if (!loading) panelRef.current?.focus()
  }, [loading])

  // 切换选中节点后丢弃上一个节点的 AI 结果，避免把摘要/优化/引文写到别的节点上
  useEffect(() => {
    setAiError('')
    setOptimizePicked([])
    setAiResult((prev) => (prev && 'nodeId' in prev && prev.nodeId !== selectedId ? null : prev))
  }, [selectedId])

  const selectedNode = doc ? findNode(doc, selectedId) : null
  /** 拆解同步写入的节点数（0 时「清除拆解节点」不可点） */
  const digestNodeCount = doc
    ? doc.nodes.filter((node) => node.source === MINDMAP_DIGEST_SOURCE).length
    : 0
  /** 头部论文名：编辑聚合里的另一篇论文时优先显示目标论文自己的标题 */
  const paperTitle =
    (editingPaperId != null ? (editingPaperTitle || '').trim() : (title || '').trim()) ||
    (doc ? findNode(doc, doc.rootId)?.text : '') ||
    '当前文献'

  const addChildToSelected = useCallback(() => {
    const current = docRef.current
    if (!current) return
    const parentId = selectedId || current.rootId
    const next = addChild(current, parentId)
    if (next === current) return
    const created = next.nodes[next.nodes.length - 1]
    apply(next)
    setSelectedId(created.id)
    setSelectedIds([created.id])
    setBulkDeleteArmed(false)
    setEditingId(created.id)
    setDraft(created.text)
  }, [apply, selectedId])

  const beginEdit = useCallback((node: MindMapNode) => {
    setSelectedId(node.id)
    setSelectedIds([node.id])
    setBulkDeleteArmed(false)
    setEditingId(node.id)
    setDraft(node.text)
  }, [])

  const commitEdit = useCallback(() => {
    const current = docRef.current
    if (!current || !editingId) {
      setEditingId(null)
      return
    }
    const next = renameNode(current, editingId, draft)
    if (next !== current) apply(next)
    setEditingId(null)
  }, [apply, draft, editingId])

  const deleteSelected = useCallback(() => {
    const current = docRef.current
    if (!current || !selectedNode || selectedNode.id === current.rootId) return
    const parent = findNode(current, selectedNode.parentId)
    const next = removeNode(current, selectedNode.id)
    if (next === current) return
    apply(next)
    setSelectedId(parent?.id ?? current.rootId)
    setSelectedIds([parent?.id ?? current.rootId])
    setEditingId(null)
    setBulkDeleteArmed(false)
  }, [apply, selectedNode])

  /** 合并骨架并走既有保存流程（落同一份 mindmap JSON，不覆盖已有节点） */
  const commitSkeleton = useCallback(
    (entries: MindMapSkeletonEntry[]) => {
      setPendingSkeleton(null)
      const current = docRef.current
      if (!current || entries.length === 0) {
        setSkeletonNotice(NO_STRUCTURE_TEXT)
        return
      }
      const next = mergeSkeleton(current, entries)
      if (next === current) {
        setSkeletonNotice(NO_STRUCTURE_TEXT)
        return
      }
      apply(next)
      setSelectedId(next.rootId)
      setSelectedIds([next.rootId])
      setEditingId(null)
      setSkeletonNotice(`已按论文结构生成 ${next.nodes.length - current.nodes.length} 个节点`)
    },
    [apply]
  )

  /**
   * 从论文自身章节结构生成骨架（不依赖 AI）：
   * 优先 PDF 自带 outline，没有则退化到正文标题（sidecar 的 section 模块），
   * 两者都没有时明确提示、不改地图；已有手动节点时先走内联二次确认。
   */
  const generateSkeleton = useCallback(async () => {
    if (!docRef.current || skeletonBusy) return
    const targetItemId = itemId
    setSkeletonBusy(true)
    setPendingSkeleton(null)
    setSkeletonNotice(SKELETON_READING_TEXT)
    try {
      const attachments = await window.api.attachments.listByItem(targetItemId)
      if (!aliveRef.current) return
      const pdf = pickPdfAttachment(attachments)
      if (!pdf) {
        setSkeletonNotice(NO_STRUCTURE_TEXT)
        return
      }
      let entries: MindMapSkeletonEntry[] = []
      try {
        entries = await readOutlineEntries(pdf.id)
      } catch {
        entries = []
      }
      if (!aliveRef.current) return
      if (entries.length === 0) {
        try {
          entries = await readSectionEntries(pdf.id)
        } catch {
          entries = []
        }
      }
      if (!aliveRef.current) return
      if (entries.length === 0) {
        setSkeletonNotice(NO_STRUCTURE_TEXT)
        return
      }
      const latest = docRef.current
      if (!latest) return
      if (hasChildNodes(latest)) {
        setSkeletonNotice(`已读取 ${entries.length} 个章节标题，确认后合并到根节点下`)
        setPendingSkeleton(entries)
        return
      }
      commitSkeleton(entries)
    } catch (error) {
      if (!aliveRef.current) return
      setSkeletonNotice(
        `读取论文结构失败：${error instanceof Error ? error.message : '未知错误'}`
      )
    } finally {
      if (aliveRef.current) setSkeletonBusy(false)
    }
  }, [commitSkeleton, itemId, skeletonBusy])

  /**
   * AI 调用前先把当前地图（含正在编辑的文本）落盘：主进程按磁盘上的地图构造上下文，
   * 这样「新建但还没保存」的节点也能用 AI；保存失败不拦着，AI 端会给出更明确的错误。
   */
  const persistBeforeAi = useCallback(async (): Promise<void> => {
    const current = docRef.current
    if (!current) return
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingRef.current = null
    try {
      const saved = await window.api.mindmap.save(current.itemId, current)
      if (!aliveRef.current) return
      setSavedAt(saved.updatedAt)
      setSaveError('')
    } catch {
      /* 保持地图不变；AI 失败时由错误区统一提示 */
    }
  }, [])

  /** 四个 AI 操作共用入口：失败只写错误区，绝不改动地图 */
  const runAi = useCallback(
    async (kind: MindmapAiKind) => {
      const current = docRef.current
      if (!current || aiBusy) return
      // PD59：未配置模型时也允许点击，但只把可读原因写进错误区，不发起 IPC，更不动地图
      if (!modelReady) {
        setAiError(aiDisabledReason)
        setAiResult(null)
        return
      }
      const target = selectedId ? findNode(current, selectedId) : null
      // 整图优化看的是整张地图，不需要先选中节点
      if (kind !== 'map-optimize' && !target) return
      const itemIdForAi = current.itemId
      const nodeId = target ? target.id : ''
      setAiBusy(kind)
      setAiError('')
      setAiResult(null)
      try {
        await persistBeforeAi()
        if (!aliveRef.current) return
        if (kind === 'summary') {
          const result = await window.api.mindmap.summarize(itemIdForAi, nodeId)
          if (!aliveRef.current) return
          setAiResult({ kind: 'summary', nodeId, summary: result.summary })
        } else if (kind === 'map-optimize') {
          // PD58：整图优化只给建议，先做分组预览；未点「应用选中分组」前绝不改地图
          const result = await window.api.mindmap.optimizeMap(itemIdForAi)
          if (!aliveRef.current) return
          const latest = docRef.current
          if (!latest) return
          const preview = buildMapOptimizePreview(latest, result)
          if (preview.groups.length === 0) {
            setAiError('AI 没有给出可用的分组，地图保持不变；可以重试或先在图上建几个节点')
            return
          }
          setAiResult({ kind: 'map-optimize', preview })
          setOptimizePicked(preview.groups.map((group) => group.id))
        } else if (kind === 'expand') {
          const result = await window.api.mindmap.expand(itemIdForAi, nodeId)
          if (!aliveRef.current) return
          const latest = docRef.current
          if (!latest) return
          const grown = applyAiExpansion(latest, nodeId, result.texts)
          if (grown.ids.length === 0) {
            setAiError('AI 没有返回可用的子节点，地图保持不变；可以重试或换个节点')
            return
          }
          apply(grown.doc)
          setPendingExpansion(grown.ids)
          // 与批量删除共用同一个撤销按钮：记录展开前的整份地图快照
          setUndoEntry({ doc: latest, label: 'AI 展开子节点', selection: [nodeId] })
          setSelectedId(nodeId)
          setSelectedIds([nodeId])
        } else {
          const result = await window.api.mindmap.findSupport(itemIdForAi, nodeId)
          if (!aliveRef.current) return
          setAiResult({ kind: 'support', nodeId, support: result })
        }
      } catch (error) {
        if (!aliveRef.current) return
        setAiError(describeMindmapAiError(ipcErrorMessage(error)))
      } finally {
        if (aliveRef.current) setAiBusy(null)
      }
    },
    [aiBusy, aiDisabledReason, apply, modelReady, persistBeforeAi, selectedId]
  )

  /** 把 AI 摘要写成选中节点的子节点（同样标 ai-generated，随整份 JSON 持久化） */
  const insertAiSummary = useCallback(() => {
    const current = docRef.current
    if (!current || !aiResult || aiResult.kind !== 'summary') return
    const grown = applyAiExpansion(current, aiResult.nodeId, [aiResult.summary])
    if (grown.ids.length === 0) return
    apply(grown.doc)
    setSelectedId(grown.ids[0])
    setSelectedIds([grown.ids[0]])
    setAiResult(null)
  }, [aiResult, apply])

  /**
   * PD58：按分组应用整图优化。
   * 只执行勾选的分组；应用前保存整份地图快照，沿用工具栏同一个「撤销上一步」。
   */
  const applyOptimize = useCallback(() => {
    const current = docRef.current
    if (!current || !aiResult || aiResult.kind !== 'map-optimize') return
    const result = applyMapOptimize(current, aiResult.preview, optimizePicked)
    if (result.addedIds.length === 0 && result.removedIds.length === 0) {
      setAiError('没有勾选任何分组，地图保持不变；可以关闭预览后重试')
      return
    }
    apply(result.doc)
    setUndoEntry({ doc: current, label: 'AI 优化整图', selection: [current.rootId] })
    setAiResult(null)
    setOptimizePicked([])
    setAiError('')
    setBulkNotice(
      `已应用 AI 优化：${result.addedIds.length} 个新节点${result.removedIds.length > 0 ? `、合并 ${result.removedIds.length} 个重复节点` : ''}，可用「撤销上一步」恢复`
    )
  }, [aiResult, apply, optimizePicked])

  /** 丢弃整份优化建议：地图与撤销栈都不动 */
  const discardOptimize = useCallback(() => {
    setAiResult(null)
    setOptimizePicked([])
    setAiError('')
    setBulkNotice('已丢弃 AI 优化建议，地图保持不变')
  }, [])

  /**
   * PD56：统一的「撤销上一步」。
   * 优先用整份地图快照恢复最近一次操作（批量删除 / AI 展开），
   * 老路径（只有 pendingExpansion）仍走 undoAiExpansion，保证行为兼容。
   */
  const undoLast = useCallback(() => {
    const current = docRef.current
    if (!current) return
    if (undoEntry) {
      apply(undoEntry.doc)
      setSelectedId(undoEntry.selection[0] ?? undoEntry.doc.rootId)
      setSelectedIds(undoEntry.selection)
      setPendingExpansion([])
      setAiError('')
      setAiResult(null)
      setBulkNotice(`已撤销「${undoEntry.label}」`)
      setUndoEntry(null)
      return
    }
    if (pendingExpansion.length === 0) return
    const next = undoAiExpansion(current, pendingExpansion)
    setPendingExpansion([])
    if (next === current) {
      setAiError('本次展开的节点已被删除或改动，无法自动撤销；地图保持不变')
      return
    }
    setAiError('')
    setAiResult(null)
    setBulkNotice('已撤销「AI 展开子节点」')
    apply(next)
  }, [apply, pendingExpansion, undoEntry])

  /** 关闭前先提交正在编辑的文本并落盘，避免“刚改完就关”丢内容 */
  const handleClose = useCallback(() => {
    const current = docRef.current
    if (current && editingId) {
      const next = renameNode(current, editingId, draft)
      if (next !== current) {
        docRef.current = next
        setDoc(next)
        pendingRef.current = next
      }
    }
    flush()
    onClose()
  }, [draft, editingId, flush, onClose])

  /**
   * 导出当前地图：传 docRef.current（内存里的最新版本）。
   * 拖动有 300ms 防抖、新图在首次保存前磁盘还是空的，只有内存版和界面完全一致。
   * 落盘路径由主进程弹保存框、由用户自己选，不写 data 目录。
   */
  const exportMap = useCallback(async (format: MindmapExportFormat) => {
    const current = docRef.current
    if (!current) return
    setExportError('')
    if (!hasExportableContent(current)) {
      setExportNotice(MINDMAP_EXPORT_EMPTY)
      return
    }
    setExportNotice('')
    setExporting(format)
    try {
      const filePath = await window.api.mindmap.export(current.itemId, format, current)
      if (!aliveRef.current) return
      setExportNotice(filePath ? `已导出到 ${filePath}` : '已取消导出')
    } catch (error) {
      if (!aliveRef.current) return
      setExportError(ipcErrorMessage(error) || '导出失败')
    } finally {
      if (aliveRef.current) setExporting(null)
    }
  }, [])

  /** PD53：退出「编辑这篇」临时编辑态，回到面板自带文献（不改变级别） */
  const exitPaperEdit = useCallback(() => {
    setEditingPaperId(null)
    setEditingPaperTitle(null)
    setPickedPaperId(null)
    setEditNotice('')
    expectedChildCountRef.current = 0
  }, [])

  /**
   * 载入聚合级文档：先等待当前地图落盘，再让主进程按 scope 拼装，
   * 这样「编辑这篇 → 返回聚合视图」能立刻看到刚编辑的子节点（读盘顺序确定）。
   */
  const loadAggregate = useCallback(
    (next: 'group' | 'all') => {
      let scope: MindmapScope
      if (next === 'all') {
        scope = { kind: 'all' }
      } else {
        if (!groupName) {
          setScopeError('该文献未分组')
          return
        }
        scope = { kind: 'group', group: groupName }
      }
      const seq = ++scopeSeqRef.current
      setLevel(next)
      setScopeLoading(true)
      setScopeDoc(null)
      setScopeError('')
      setOpenStatus('')
      setPickedPaperId(null)
      void flush().finally(() => {
        if (seq !== scopeSeqRef.current) return
        void window.api.mindmap
          .loadScope(scope)
          .then((loaded) => {
            if (seq !== scopeSeqRef.current) return
            setScopeDoc(loaded)
            setScopeLoading(false)
          })
          .catch((error: unknown) => {
            if (seq !== scopeSeqRef.current) return
            setScopeError(ipcErrorMessage(error) || '读取聚合地图失败')
            setScopeLoading(false)
          })
      })
    },
    [flush, groupName]
  )

  /** 切级：先把当前论文地图落盘；聚合级带 scope 向主进程要只读文档 */
  const switchLevel = useCallback(
    (next: MindmapLevel) => {
      if (next === 'paper') {
        if (level === 'paper' && editingPaperId == null) return
        exitPaperEdit()
        setEditReturnLevel('all')
        setLevel('paper')
        setScopeDoc(null)
        setScopeError('')
        setOpenStatus('')
        void flush().finally(() => setPaperEpoch((value) => value + 1))
        return
      }
      if (next === level && editingPaperId == null) return
      exitPaperEdit()
      loadAggregate(next)
    },
    [editingPaperId, exitPaperEdit, flush, level, loadAggregate]
  )

  /**
   * PD53：聚合视图「编辑这篇」——先确认文献仍存在，再切到论文级在主窗口内编辑。
   * 地图文件损坏时主进程同样返回 null，只能靠「聚合里有子节点却只读到空图」提示。
   */
  const editPaper = useCallback(
    async (target: { itemId: number; title: string; childCount: number }) => {
      setEditNotice('')
      try {
        const item = await window.api.library.get(target.itemId)
        if (!item) {
          setEditNotice('这篇文献已不存在，无法编辑')
          return
        }
        const cleanTitle =
          (typeof item.title === 'string' && item.title.trim() ? item.title.trim() : '') ||
          target.title ||
          '未命名文献'
        expectedChildCountRef.current = target.childCount
        setEditReturnLevel(level === 'paper' ? 'all' : level)
        await flush()
        setEditingPaperTitle(cleanTitle)
        setEditingPaperId(target.itemId)
        setLevel('paper')
        setScopeDoc(null)
        setScopeError('')
        setOpenStatus('')
      } catch (error) {
        setEditNotice(ipcErrorMessage(error) || '无法打开这篇论文的可编辑地图')
      }
    },
    [flush, level]
  )

  /** 从「编辑这篇」原路返回进入编辑前的聚合视图（编辑内容已随 flush 落盘） */
  const returnToAggregate = useCallback(() => {
    const target: 'group' | 'all' = editReturnLevel === 'group' ? 'group' : 'all'
    exitPaperEdit()
    loadAggregate(target)
  }, [editReturnLevel, exitPaperEdit, loadAggregate])

  /** 聚合视图里点论文节点：选中为编辑目标，并交给主进程开独立窗口回显结果 */
  const openPaperWindow = useCallback(async (targetItemId: number, nodeText: string) => {
    setPickedPaperId(targetItemId)
    try {
      const result = await window.api.mindmap.openPaper(targetItemId)
      if (!result.ok) {
        setScopeError(result.error || '打开新窗口失败')
        return
      }
      const clean = cleanPaperTitle(nodeText)
      setScopeError('')
      setOpenStatus(`已在新窗口打开：${clean}`)
    } catch (error) {
      setScopeError(ipcErrorMessage(error) || '打开新窗口失败')
    }
  }, [])

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (level !== 'paper') {
        if (event.key === 'Escape') {
          event.preventDefault()
          handleClose()
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        // PD56：有选框/多选时 Esc 只清空选择，不关面板（再按一次才关闭）
        if (marquee || selectedIds.length > 0) {
          clearSelection()
          return
        }
        handleClose()
      } else if (event.key === 'Tab') {
        event.preventDefault()
        addChildToSelected()
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        if (selectedIds.length > 1) {
          setBulkNotice('多选状态请在批量条里点「删除选中」（需要二次确认，可撤销）')
          return
        }
        deleteSelected()
      } else if (event.key === 'F2' && selectedNode) {
        event.preventDefault()
        beginEdit(selectedNode)
      }
    },
    [
      addChildToSelected,
      beginEdit,
      clearSelection,
      deleteSelected,
      handleClose,
      level,
      marquee,
      selectedIds.length,
      selectedNode
    ]
  )

  const onNodePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, node: MindMapNode) => {
      if (editingId === node.id) return
      event.stopPropagation()
      const current = docRef.current
      if (!current) return
      // Ctrl/Shift+点击：只切换选中，不开始拖动，避免误移动
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        toggleNodeSelection(node.id)
        return
      }
      // 已在多选里再点其中一个：保留整组，便于「拖动任一选中节点整体平移」
      const group =
        selectedIds.length > 1 && selectedIds.includes(node.id) ? selectedIds : [node.id]
      setSelectedIds(group)
      setSelectedId(node.id)
      setBulkDeleteArmed(false)
      const origins = group
        .map((id) => findNode(current, id))
        .filter((item): item is MindMapNode => item != null)
        .map((item) => ({ id: item.id, x: item.x, y: item.y }))
      dragRef.current = {
        id: node.id,
        startX: event.clientX,
        startY: event.clientY,
        origins,
        base: current,
        moved: false
      }
      // 合成事件（如脚本派发的 pointerdown）没有活跃指针，捕获会抛错，忽略即可
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId)
      } catch {
        /* 指针捕获失败不影响拖动：事件仍从节点冒泡到画布 */
      }
    },
    [editingId, selectedIds, toggleNodeSelection]
  )

  const onNodePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, node: MindMapNode) => {
      const drag = dragRef.current
      if (!drag || drag.id !== node.id) return
      // 屏幕位移换算成内容位移：缩放后拖动速度与光标一致
      const zoomValue = zoomRef.current || 1
      const dx = (event.clientX - drag.startX) / zoomValue
      const dy = (event.clientY - drag.startY) / zoomValue
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return
      drag.moved = true
      if (draggingId !== node.id) setDraggingId(node.id)
      // 从按下时的地图重算绝对位置：整组共用取整位移，相对位置保持不变
      const moved = moveNodesBy(
        drag.base,
        drag.origins.map((origin) => origin.id),
        dx,
        dy
      )
      if (moved !== docRef.current) apply(moved, 300)
    },
    [apply, draggingId]
  )

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      setDraggingId(null)
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      const current = docRef.current
      if (current && drag.moved) saveNow(current)
    },
    [saveNow]
  )

  /**
   * PD53：聚合图里的论文节点 → 「编辑这篇」候选目标。
   * 跳过「（暂无内容）」的论文（没有地图，进去只会是空图），并统计每篇在聚合图里的子节点数，
   * 供编辑态区分「地图文件缺失」与「地图文件损坏」。
   */
  const paperEditTargets = useMemo(() => {
    if (!scopeDoc) return []
    const childCounts = new Map<string, number>()
    for (const node of scopeDoc.nodes) {
      if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1)
    }
    return scopeDoc.nodes
      .filter((node) => node.parentId === scopeDoc.rootId && typeof node.ref?.itemId === 'number')
      .filter((node) => !node.text.trim().endsWith(MINDMAP_SCOPE_MISSING_SUFFIX))
      .map((node) => ({
        itemId: node.ref?.itemId as number,
        title: cleanPaperTitle(node.text),
        childCount: childCounts.get(node.id) ?? 0
      }))
  }, [scopeDoc])

  const editTarget = useMemo(() => {
    if (!paperEditTargets.length) return null
    return paperEditTargets.find((target) => target.itemId === pickedPaperId) ?? paperEditTargets[0]
  }, [paperEditTargets, pickedPaperId])

  /** 画布只渲染当前级别：论文级用可编辑 doc，聚合级用主进程返回的只读 scopeDoc */
  const viewDoc = level === 'paper' ? doc : scopeDoc

  /** PD53：节点宽度/高度随文本自适应（上限 NODE_MAX_W，最多 3 行），连边端点与画布尺寸都按实际盒子计算 */
  const nodeSizes = useMemo(() => {
    const sizes = new Map<string, { width: number; height: number }>()
    for (const node of viewDoc?.nodes ?? []) sizes.set(node.id, measureMindmapNode(node.text))
    return sizes
  }, [viewDoc])

  const sizeOf = useCallback(
    (nodeId: string) => nodeSizes.get(nodeId) ?? { width: NODE_W, height: NODE_H },
    [nodeSizes]
  )

  const canvas = useMemo(() => {
    let width = MIN_CANVAS_W
    let height = MIN_CANVAS_H
    for (const node of viewDoc?.nodes ?? []) {
      const size = sizeOf(node.id)
      width = Math.max(width, node.x + size.width + 180)
      height = Math.max(height, node.y + size.height + 180)
    }
    return { width, height }
  }, [sizeOf, viewDoc])

  /** 折叠节点的后代不渲染（纯 UI 状态，不写进地图 JSON）；折叠节点的连线也一起隐藏 */
  const hiddenIds = useMemo(
    () => (level === 'paper' && doc ? hiddenByCollapse(doc, collapsedIds) : new Set<string>()),
    [collapsedIds, doc, level]
  )

  const edges = useMemo(() => {
    if (!viewDoc) return []
    const byId = new Map(viewDoc.nodes.map((node) => [node.id, node]))
    const list: { id: string; d: string }[] = []
    for (const child of viewDoc.nodes) {
      if (!child.parentId) continue
      if (hiddenIds.has(child.id)) continue
      if (hiddenIds.has(child.parentId)) continue
      const parent = byId.get(child.parentId)
      if (!parent) continue
      const parentSize = sizeOf(parent.id)
      const childSize = sizeOf(child.id)
      const parentCenter = parent.x + parentSize.width / 2
      const childCenter = child.x + childSize.width / 2
      const sx = childCenter >= parentCenter ? parent.x + parentSize.width : parent.x
      const tx = childCenter >= parentCenter ? child.x : child.x + childSize.width
      const sy = parent.y + parentSize.height / 2
      const ty = child.y + childSize.height / 2
      const hx = Math.max(36, Math.abs(tx - sx) / 2)
      list.push({
        id: child.id,
        d: `M ${sx} ${sy} C ${sx + hx} ${sy}, ${tx - hx} ${ty}, ${tx} ${ty}`
      })
    }
    return list
  }, [hiddenIds, sizeOf, viewDoc])

  /* ---------------- PD56：折叠 / 框选 / 批量操作 ---------------- */

  canvasSizeRef.current = canvas

  const visibleNodes = useMemo(
    () => (viewDoc?.nodes ?? []).filter((node) => !hiddenIds.has(node.id)),
    [hiddenIds, viewDoc]
  )

  const multiSelected = selectedIds.length >= 2

  const marqueeRect = useMemo(() => {
    if (!marquee) return null
    return {
      left: Math.min(marquee.startX, marquee.currentX),
      top: Math.min(marquee.startY, marquee.currentY),
      right: Math.max(marquee.startX, marquee.currentX),
      bottom: Math.max(marquee.startY, marquee.currentY)
    }
  }, [marquee])

  /** 命中测试：选框与节点盒子（内容坐标）相交即选中 */
  const hitsInRect = useCallback(
    (rect: { left: number; top: number; right: number; bottom: number }): string[] => {
      const hits: string[] = []
      for (const node of visibleNodes) {
        const size = sizeOf(node.id)
        if (
          rectsIntersect(rect, {
            left: node.x,
            top: node.y,
            right: node.x + size.width,
            bottom: node.y + size.height
          })
        ) {
          hits.push(node.id)
        }
      }
      return hits
    },
    [sizeOf, visibleNodes]
  )

  const onViewportPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (level !== 'paper' || event.button !== 0) return
      const target = event.target as HTMLElement | null
      // 节点自己处理拖动；只从空白处开始框选
      if (target && target.closest('.mindmap__node')) return
      const el = viewportRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const point = mindmapContentPoint(
        event.clientX,
        event.clientY,
        rect.left,
        rect.top,
        el.scrollLeft,
        el.scrollTop,
        zoomRef.current
      )
      const additive = event.ctrlKey || event.metaKey || event.shiftKey
      const state: MarqueeState = {
        startX: point.x,
        startY: point.y,
        currentX: point.x,
        currentY: point.y,
        additive,
        base: additive ? selectedIds : []
      }
      marqueeRef.current = state
      setMarquee(state)
      setMarqueeHits([])
      setBulkDeleteArmed(false)
      try {
        el.setPointerCapture(event.pointerId)
      } catch {
        /* 合成事件没有真实指针，忽略 */
      }
    },
    [level, selectedIds]
  )

  const onViewportPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = marqueeRef.current
      if (!state) return
      const el = viewportRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const point = mindmapContentPoint(
        event.clientX,
        event.clientY,
        rect.left,
        rect.top,
        el.scrollLeft,
        el.scrollTop,
        zoomRef.current
      )
      const next: MarqueeState = { ...state, currentX: point.x, currentY: point.y }
      marqueeRef.current = next
      setMarquee(next)
      setMarqueeHits(
        hitsInRect({
          left: Math.min(next.startX, next.currentX),
          top: Math.min(next.startY, next.currentY),
          right: Math.max(next.startX, next.currentX),
          bottom: Math.max(next.startY, next.currentY)
        })
      )
    },
    [hitsInRect]
  )

  const onViewportPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = marqueeRef.current
      if (!state) return
      marqueeRef.current = null
      setMarquee(null)
      const el = viewportRef.current
      if (el && el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId)
      const rect = {
        left: Math.min(state.startX, state.currentX),
        top: Math.min(state.startY, state.currentY),
        right: Math.max(state.startX, state.currentX),
        bottom: Math.max(state.startY, state.currentY)
      }
      const tiny = rect.right - rect.left < 4 && rect.bottom - rect.top < 4
      if (tiny) {
        // 空白处单击：清空选择（Ctrl/Shift 拖动结束但没框到东西时保持原选择）
        if (!state.additive) {
          setSelectedId('')
          setSelectedIds([])
        }
        setMarqueeHits([])
        return
      }
      const hits = hitsInRect(rect)
      const next = state.additive ? Array.from(new Set([...state.base, ...hits])) : hits
      setSelectedIds(next)
      setSelectedId(next[next.length - 1] ?? '')
      setMarqueeHits([])
      setBulkDeleteArmed(false)
    },
    [hitsInRect]
  )

  /** 批量删除：二次确认 + 整份地图快照，撤销后节点与位置完全恢复 */
  const bulkDelete = useCallback(() => {
    const current = docRef.current
    if (!current || selectedIds.length < 2) return
    if (!bulkDeleteArmed) {
      setBulkDeleteArmed(true)
      setBulkNotice('再次点击「确认删除」才会删除选中节点及其子树（可撤销）')
      return
    }
    const removable = selectedIds.filter(
      (id) => id !== current.rootId && findNode(current, id) != null
    )
    if (removable.length === 0) {
      setBulkDeleteArmed(false)
      setBulkNotice('选中的只有根节点，根节点不可删除')
      return
    }
    const next = removeNodes(current, selectedIds)
    if (next === current) {
      setBulkDeleteArmed(false)
      setBulkNotice('没有可删除的节点')
      return
    }
    setUndoEntry({
      doc: current,
      label: `批量删除 ${removable.length} 个节点`,
      selection: selectedIds
    })
    setPendingExpansion([])
    apply(next)
    setSelectedId('')
    setSelectedIds([])
    setMarqueeHits([])
    setCollapsedIds((prev) => prev.filter((id) => findNode(next, id) != null))
    setBulkDeleteArmed(false)
    setBulkNotice(`已删除 ${removable.length} 个节点，可用「撤销上一步」恢复`)
  }, [apply, bulkDeleteArmed, selectedIds])

  /** 批量折叠/展开：只折叠有子节点的选中项，落点仍是 UI 状态 */
  const bulkCollapse = useCallback(() => {
    const current = docRef.current
    if (!current || selectedIds.length < 2) return
    const parents = selectedIds.filter(
      (id) =>
        id !== current.rootId && current.nodes.some((node) => node.parentId === id)
    )
    if (parents.length === 0) {
      setBulkNotice('选中的节点都没有子节点，无法折叠')
      return
    }
    const allFolded = parents.every((id) => collapsedIds.includes(id))
    setCollapsedIds((prev) =>
      allFolded
        ? prev.filter((id) => !parents.includes(id))
        : Array.from(new Set([...prev, ...parents]))
    )
    setBulkNotice(
      allFolded
        ? `已展开 ${parents.length} 个节点的子树`
        : `已折叠 ${parents.length} 个节点的子树（再次点击可展开）`
    )
  }, [collapsedIds, selectedIds])

  /** 批量对齐：按当前 y 从上到下排成一列，y 不变 */
  const bulkAlign = useCallback(() => {
    const current = docRef.current
    if (!current || selectedIds.length < 2) return
    const next = alignNodesToColumn(current, selectedIds)
    if (next === current) {
      setBulkNotice('选中的节点已经在同一列，无需对齐')
      return
    }
    const columnX = next.nodes.find((node) => selectedIds.includes(node.id))?.x
    apply(next)
    setBulkNotice(
      typeof columnX === 'number' ? `已按当前顺序对齐到 x=${Math.round(columnX)} 一列` : '已对齐到同一列'
    )
  }, [apply, selectedIds])

  /** 单节点折叠/展开：纯 UI 状态，不写回地图文件 */
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    )
  }, [])

  return (
    <div
      className={`mindmap${variant === 'standalone' ? ' mindmap--standalone' : ''}`}
      data-testid="mindmap-panel"
      ref={panelRef}
      role="dialog"
      aria-label="思维地图"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {variant === 'overlay' ? (
        <div className="mindmap__backdrop" onClick={handleClose} />
      ) : null}
      <div className="mindmap__dialog">
        <header className="mindmap__header">
          <div className="mindmap__heading">
            <Icon name="graph" size={16} />
            <span className="mindmap__title">思维地图</span>
            <span className="mindmap__paper" title={paperTitle}>
              {paperTitle}
            </span>
          </div>
          <div className="mindmap__status" data-testid="mindmap-status">
            {level !== 'paper' ? (
              scopeError ? (
                <span className="mindmap__error">{scopeError}</span>
              ) : (
                '只读聚合视图'
              )
            ) : saveError ? (
              <span className="mindmap__error">{saveError}</span>
            ) : savedAt ? (
              '已保存'
            ) : (
              ''
            )}
          </div>
          {editingPaperId != null ? (
            <button
              className="ghost mindmap__edit-return"
              data-testid="mindmap-edit-return"
              title="返回聚合视图（编辑内容已保存）"
              onClick={returnToAggregate}
            >
              <Icon name="left" size={14} />
              返回聚合视图
            </button>
          ) : null}
          <button
            className="icon ghost"
            title="关闭思维地图"
            data-testid="mindmap-close"
            onClick={handleClose}
          >
            <Icon name="close" size={15} />
          </button>
        </header>

        {/* 三级切换：论文（可编辑）/ 分组（只读聚合）/ 全部（只读聚合） */}
        {variant !== 'standalone' ? (
          <div
            className="mindmap__levels"
            data-testid="mindmap-levels"
            role="tablist"
            aria-label="思维地图级别"
          >
            <button
              className={`mindmap__level${level === 'paper' ? ' is-active' : ''}`}
              data-testid="mindmap-level-paper"
              role="tab"
              aria-selected={level === 'paper'}
              title="只看当前文献的思维地图，可编辑"
              onClick={() => switchLevel('paper')}
            >
              论文
            </button>
            <button
              className={`mindmap__level${level === 'group' ? ' is-active' : ''}`}
              data-testid="mindmap-level-group"
              role="tab"
              aria-selected={level === 'group'}
              disabled={!groupName}
              title={groupName ? `查看分组「${groupName}」的聚合地图（只读）` : '该文献未分组'}
              onClick={() => switchLevel('group')}
            >
              分组
            </button>
            <button
              className={`mindmap__level${level === 'all' ? ' is-active' : ''}`}
              data-testid="mindmap-level-all"
              role="tab"
              aria-selected={level === 'all'}
              title="查看全部论文的聚合地图（只读）"
              onClick={() => switchLevel('all')}
            >
              全部
            </button>
          </div>
        ) : null}

        {level !== 'paper' ? (
          <div className="mindmap__aggregate-hint" data-testid="mindmap-aggregate-hint">
            这是只读聚合视图，不保存任何修改；点击论文节点在新窗口打开该论文的思维地图。
            {scopeDoc ? ` 共 ${scopeDoc.paperCount} 篇，其中 ${scopeDoc.missingCount} 篇暂无地图。` : ''}
          </div>
        ) : null}

        {/* PD53：聚合图只读，但给出「编辑这篇」入口，在主窗口内切到该论文的可编辑地图 */}
        {level !== 'paper' ? (
          <div
            className="mindmap__toolbar mindmap__toolbar--aggregate"
            data-testid="mindmap-aggregate-actions"
          >
            <span className="mindmap__readonly-hint" data-testid="mindmap-readonly-hint">
              聚合视图只读，点『编辑这篇』进入可编辑地图
            </span>
            <span className="mindmap__edit-target" data-testid="mindmap-edit-target">
              {editTarget ? `目标论文：${editTarget.title}` : '暂无可编辑的论文'}
            </span>
            <button
              className="ghost"
              data-testid="mindmap-edit-paper"
              title={editTarget ? `在主窗口编辑《${editTarget.title}》` : '聚合图里还没有可编辑的论文'}
              disabled={!editTarget}
              onClick={() => {
                if (editTarget) void editPaper(editTarget)
              }}
            >
              <Icon name="edit" size={14} />
              编辑这篇
            </button>
            {editNotice ? (
              <span className="mindmap__edit-notice" data-testid="mindmap-edit-notice">
                {editNotice}
              </span>
            ) : null}
          </div>
        ) : null}

        {openStatus ? (
          <div className="mindmap__open-status" data-testid="mindmap-open-status">
            {openStatus}
          </div>
        ) : null}

        {level === 'paper' ? (
          <>
        <div className="mindmap__toolbar" data-testid="mindmap-toolbar">
          <button
            className="ghost"
            data-testid="mindmap-add"
            title="新增子节点（Tab）"
            disabled={!doc}
            onClick={addChildToSelected}
          >
            <Icon name="plus" size={14} />
            新增子节点
          </button>
          <button
            className="ghost"
            data-testid="mindmap-rename"
            title="重命名选中节点（F2 / 双击）"
            disabled={!selectedNode}
            onClick={() => selectedNode && beginEdit(selectedNode)}
          >
            <Icon name="edit" size={14} />
            重命名
          </button>
          <button
            className="ghost"
            data-testid="mindmap-skeleton"
            title="按论文自身的章节大纲生成初始树（优先 PDF 大纲，其次正文标题；不依赖 AI）"
            disabled={!doc || skeletonBusy}
            onClick={() => void generateSkeleton()}
          >
            <Icon name="layers" size={14} />
            {skeletonBusy ? '正在分析…' : '从论文结构生成骨架'}
          </button>
          <button
            className="ghost"
            data-testid="mindmap-export-markdown"
            title="把当前地图导出为 Markdown 缩进大纲（层级与顺序和画布完全一致，可选保存位置）"
            disabled={!doc || exporting != null}
            onClick={() => void exportMap('markdown')}
          >
            <Icon name="file" size={14} />
            {exporting === 'markdown' ? '导出中…' : '导出 Markdown'}
          </button>
          <button
            className="ghost"
            data-testid="mindmap-export-mermaid"
            title="把当前地图导出为 Mermaid 图（graph TD，标签里的引号/括号/斜杠已转义，可选保存位置）"
            disabled={!doc || exporting != null}
            onClick={() => void exportMap('mermaid')}
          >
            <Icon name="graph" size={14} />
            {exporting === 'mermaid' ? '导出中…' : '导出 Mermaid'}
          </button>
          {/* PD56：画布缩放（0.4–2.0，步进 0.1；滚轮锚定光标，比例按文献记忆） */}
          <span className="mindmap__zoom">
            <button
              className="ghost"
              data-testid="mindmap-zoom-out"
              title="缩小画布（Ctrl+滚轮向下，范围 40%–200%）"
              disabled={zoom <= MINDMAP_ZOOM_MIN}
              onClick={() => zoomByButton(-1)}
            >
              −
            </button>
            <span className="mindmap__zoom-value" data-testid="mindmap-zoom-value">
              {Math.round(zoom * 100)}%
            </span>
            <button
              className="ghost"
              data-testid="mindmap-zoom-in"
              title="放大画布（Ctrl+滚轮向上，范围 40%–200%）"
              disabled={zoom >= MINDMAP_ZOOM_MAX}
              onClick={() => zoomByButton(1)}
            >
              ＋
            </button>
            <button
              className="ghost"
              data-testid="mindmap-zoom-reset"
              title="回到 100% 并让视图居中"
              onClick={resetZoom}
            >
              重置
            </button>
          </span>
          <button
            className="ghost"
            data-testid="mindmap-ai-summary"
            title={
              aiDisabledReason ||
              '用 AI 给选中节点生成摘要（复用设置里的模型服务，结果不会自动改图）'
            }
            disabled={!doc || !selectedNode || aiBusy != null || !!mindmapAiBlocked}
            onClick={() => {
              if (mindmapAiBlocked) return
              void runAi('summary')
            }}
          >
            <Icon name="sparkles" size={14} />
            {aiBusy === 'summary' ? '生成中…' : 'AI 摘要'}
          </button>
          <button
            className="ghost"
            data-testid="mindmap-ai-optimize"
            title={
              aiDisabledReason ||
              '用 AI 把整张地图重新分组、合并重复节点；先看分组预览，勾选后才改图（不需要先选中节点）'
            }
            disabled={!doc || !hasChildNodes(doc) || aiBusy != null || !!mindmapAiBlocked}
            onClick={() => {
              if (mindmapAiBlocked) return
              void runAi('map-optimize')
            }}
          >
            <Icon name="sparkles" size={14} />
            {aiBusy === 'map-optimize' ? '优化中…' : 'AI 优化'}
          </button>
          {/* PD57 兼容别名：旧 e2e/脚本仍查询 mindmap-ai-expand，状态与「AI 优化」保持一致；
              视觉上隐藏且不参与工具栏点击与布局（宽度 0，几何断言会跳过）。 */}
          <button
            className="ghost mindmap__ai-alias"
            data-testid="mindmap-ai-expand"
            aria-hidden="true"
            tabIndex={-1}
            title={aiDisabledReason || 'AI 优化（旧「AI 展开」入口的兼容别名）'}
            disabled={!doc || !hasChildNodes(doc) || aiBusy != null || !!mindmapAiBlocked}
            onClick={() => {
              if (mindmapAiBlocked) return
              void runAi('map-optimize')
            }}
          >
            AI 优化
          </button>
          <button
            className="ghost"
            data-testid="mindmap-ai-support"
            title={
              aiDisabledReason ||
              '用 AI 从这篇文献的正文里找能支撑选中节点的段落（给出页码与原文引用）'
            }
            disabled={!doc || !selectedNode || aiBusy != null || !!mindmapAiBlocked}
            onClick={() => {
              if (mindmapAiBlocked) return
              void runAi('support')
            }}
          >
            <Icon name="book" size={14} />
            {aiBusy === 'support' ? '查找中…' : '找支撑段落'}
          </button>
          <button
            className="ghost"
            data-testid="mindmap-ai-undo"
            title="撤销最近一次操作：AI 展开写入的节点，或批量删除的节点（地图与位置一起恢复）"
            disabled={!undoEntry && pendingExpansion.length === 0}
            onClick={undoLast}
          >
            <Icon name="refresh" size={14} />
            撤销上一步{undoEntry ? `（${undoEntry.label}）` : ''}
          </button>
          <button
            className="ghost"
            data-testid="mindmap-digest-clear"
            title="移除由「论文拆解同步」写入的节点（手工创建的节点与用户改过的标题不受影响）"
            disabled={!doc || digestNodeCount === 0}
            onClick={() => {
              if (!doc) return
              const next = removeDigestNodes(doc)
              if (next !== doc) apply(next)
            }}
          >
            <Icon name="trash" size={14} />
            清除拆解节点{digestNodeCount > 0 ? `（${digestNodeCount}）` : ''}
          </button>
          <button
            className="ghost"
            data-testid="mindmap-delete"
            title="删除选中节点及其子树（根节点不可删除）"
            disabled={!doc || !selectedNode || selectedNode.id === doc.rootId}
            onClick={deleteSelected}
          >
            <Icon name="trash" size={14} />
            删除节点
          </button>
          <span className="mindmap__hint">
            拖动节点调整位置 · Ctrl+滚轮缩放 · 空白处拖框多选（Ctrl/Shift+点击加减选） · 双击改名 · Tab
            新增 · Delete 删除
          </span>
          <span className="mindmap__selection-count" data-testid="mindmap-selection-count">
            已选 {selectedIds.length} 个
          </span>
          <span className="mindmap__count">{doc ? `${doc.nodes.length} 个节点` : ''}</span>
        </div>

        {/* PD56：多选批量条（仅选中 ≥ 2 个时出现；删除需二次确认，可撤销） */}
        {multiSelected ? (
          <div className="mindmap__bulk" data-testid="mindmap-bulk-bar">
            <span className="mindmap__bulk-count">已选中 {selectedIds.length} 个节点</span>
            <button
              className={`ghost${bulkDeleteArmed ? ' mindmap__bulk-confirm' : ''}`}
              data-testid="mindmap-bulk-delete"
              title="删除选中节点及其子树（根节点会跳过；需要再点一次确认，可用「撤销上一步」恢复）"
              onClick={bulkDelete}
            >
              <Icon name="trash" size={14} />
              {bulkDeleteArmed ? '确认删除' : '删除选中'}
            </button>
            <button
              className="ghost"
              data-testid="mindmap-bulk-collapse"
              title="折叠选中节点的子树；已是折叠状态时会展开"
              onClick={bulkCollapse}
            >
              <Icon name="layers" size={14} />
              折叠/展开
            </button>
            <button
              className="ghost"
              data-testid="mindmap-bulk-align"
              title="按当前 y 顺序把选中节点对齐到同一列（x 取最上方的那个节点）"
              onClick={bulkAlign}
            >
              <Icon name="graph" size={14} />
              对齐成一列
            </button>
            <button
              className="ghost"
              data-testid="mindmap-bulk-clear"
              title="清空选择（Esc 同样有效）"
              onClick={clearSelection}
            >
              清空选择
            </button>
          </div>
        ) : null}

        {bulkNotice ? (
          <div className="mindmap__toolbar" data-testid="mindmap-bulk-status">
            <span className="mindmap__hint" style={{ marginLeft: 0 }}>
              {bulkNotice}
            </span>
            <button
              className="ghost"
              data-testid="mindmap-bulk-status-close"
              onClick={() => setBulkNotice('')}
            >
              关闭
            </button>
          </div>
        ) : null}

        {aiBusy ? (
          <div className="mindmap__toolbar" data-testid="mindmap-ai-busy">
            <span className="mindmap__hint" style={{ marginLeft: 0 }}>
              {AI_BUSY_TEXT[aiBusy]}
            </span>
          </div>
        ) : null}

        {aiError ? (
          <div className="mindmap__toolbar" data-testid="mindmap-ai-error">
            <span className="mindmap__error" style={{ marginLeft: 0 }}>
              {aiError}
            </span>
            <span className="mindmap__hint" style={{ marginLeft: 0 }}>
              地图内容未改动；可在「设置 → 模型服务」检查 Base URL、API Key 与模型 ID 后重试。
            </span>
          </div>
        ) : null}

        {aiResult ? (
          <div className="mindmap__toolbar" data-testid="mindmap-ai-result">
            {aiResult.kind === 'summary' ? (
              <>
                <span className="mindmap__hint" style={{ marginLeft: 0 }}>
                  AI 摘要：{aiResult.summary}
                </span>
                <button
                  className="ghost"
                  data-testid="mindmap-ai-summary-insert"
                  title="把这段摘要写成选中节点的子节点并随地图保存"
                  disabled={aiBusy != null}
                  onClick={insertAiSummary}
                >
                  <Icon name="plus" size={14} />
                  写入子节点
                </button>
              </>
            ) : aiResult.kind === 'map-optimize' ? (
              <div className="mindmap__optimize" data-testid="mindmap-ai-optimize-preview">
                <div className="mindmap__optimize-head">
                  <strong>AI 整图优化</strong>
                  <span className="mindmap__hint" style={{ marginLeft: 0 }}>
                    {aiResult.preview.rationale ||
                      `整理成 ${aiResult.preview.groups.length} 个分组，新增 ${aiResult.preview.added} 个节点，复用 ${aiResult.preview.reused} 项${aiResult.preview.merged > 0 ? `，合并 ${aiResult.preview.merged} 个重复节点` : ''}`}
                  </span>
                </div>
                <ul className="mindmap__optimize-list">
                  {aiResult.preview.groups.map((group) => {
                    const checked = optimizePicked.includes(group.id)
                    return (
                      <li key={group.id}>
                        <label data-testid={`mindmap-ai-optimize-item-${group.id}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              setOptimizePicked((prev) =>
                                event.target.checked
                                  ? [...prev, group.id]
                                  : prev.filter((id) => id !== group.id)
                              )
                            }}
                          />
                          <span className="mindmap__optimize-kind">
                            {group.reuseId ? '并入现有分组' : '新建分组'}
                          </span>
                          <span>{group.title}</span>
                          <span className="mindmap__optimize-reason">
                            {group.newPoints.length > 0
                              ? `新增 ${group.newPoints.map((point) => `「${point}」`).join('')}`
                              : '要点已存在，不重复添加'}
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
                <button
                  className="ghost"
                  data-testid="mindmap-ai-optimize-apply"
                  title="只应用勾选的分组；应用后可点「撤销上一步」整份恢复"
                  disabled={aiBusy != null || optimizePicked.length === 0}
                  onClick={applyOptimize}
                >
                  应用选中分组（{optimizePicked.length}）
                </button>
                <button
                  className="ghost"
                  data-testid="mindmap-ai-optimize-discard"
                  title="丢弃全部建议，地图保持不变"
                  onClick={discardOptimize}
                >
                  放弃
                </button>
              </div>
            ) : aiResult.support.found ? (
              <span className="mindmap__hint" style={{ marginLeft: 0 }}>
                支撑段落（第 {aiResult.support.page} 页）：「{aiResult.support.quote}」
              </span>
            ) : (
              <span className="mindmap__hint" style={{ marginLeft: 0 }}>
                {aiResult.support.reason || '未找到：本文没有能支撑该节点的段落'}
              </span>
            )}
            <button
              className="ghost"
              data-testid="mindmap-ai-result-close"
              onClick={() => setAiResult(null)}
            >
              关闭
            </button>
          </div>
        ) : null}

        {skeletonNotice ? (
          <div className="mindmap__toolbar" data-testid="mindmap-skeleton-status">
            <span className="mindmap__hint" style={{ marginLeft: 0 }}>
              {skeletonNotice}
            </span>
          </div>
        ) : null}

        {exporting || exportNotice || exportError ? (
          <div className="mindmap__toolbar" data-testid="mindmap-export-status">
            {exportError ? (
              <span className="mindmap__error" style={{ marginLeft: 0 }}>
                {exportError}
              </span>
            ) : (
              <span className="mindmap__hint" style={{ marginLeft: 0 }}>
                {exporting ? '正在导出…' : exportNotice}
              </span>
            )}
            <button
              className="ghost"
              data-testid="mindmap-export-status-close"
              onClick={() => {
                setExportNotice('')
                setExportError('')
              }}
            >
              关闭
            </button>
          </div>
        ) : null}

        {pendingSkeleton ? (
          <div className="mindmap__toolbar" data-testid="mindmap-skeleton-confirm">
            <span className="mindmap__hint" style={{ marginLeft: 0 }}>
              地图里已有 {doc ? Math.max(0, doc.nodes.length - 1) : 0} 个节点：生成骨架会把章节合并到根节点下，
              不会删除已有节点。
            </span>
            <button
              className="ghost"
              data-testid="mindmap-skeleton-confirm-ok"
              disabled={skeletonBusy}
              onClick={() => commitSkeleton(pendingSkeleton)}
            >
              <Icon name="check" size={14} />
              合并生成
            </button>
            <button
              className="ghost"
              data-testid="mindmap-skeleton-cancel"
              onClick={() => {
                setPendingSkeleton(null)
                setSkeletonNotice('已取消，地图保持不变')
              }}
            >
              取消
            </button>
          </div>
        ) : null}
          </>
        ) : null}

        {level !== 'paper' ? (
          scopeLoading ? (
            <div className="mindmap__loading">载入聚合地图…</div>
          ) : scopeDoc &&
            level === 'group' &&
            scopeDoc.paperCount > 0 &&
            scopeDoc.missingCount >= scopeDoc.paperCount ? (
            <div className="mindmap__scope-empty" data-testid="mindmap-scope-empty">
              <div>
                该分组下还没有思维地图。
                <br />
                先切回「论文」级，为文献创建地图后再看分组聚合。
              </div>
            </div>
          ) : scopeDoc ? (
            <div className="mindmap__viewport" ref={viewportRef}>
              {/* PD56：stage 承担缩放后的真实尺寸，canvas 以左上角为原点 scale，避免 min-width:100% 二次叠加 */}
              <div
                className="mindmap__stage"
                style={{
                  width: Math.round(canvas.width * zoom),
                  height: Math.round(canvas.height * zoom)
                }}
              >
                <div
                  className="mindmap__canvas"
                  style={{
                    width: canvas.width,
                    height: canvas.height,
                    transform: `scale(${zoom})`
                  }}
                >
                  <svg
                    className="mindmap__edges"
                    width={canvas.width}
                    height={canvas.height}
                    aria-hidden="true"
                  >
                    {edges.map((edge) => (
                      <path key={edge.id} d={edge.d} />
                    ))}
                  </svg>
                  {visibleNodes.map((node) => {
                    const isPaper =
                      node.parentId === scopeDoc.rootId && typeof node.ref?.itemId === 'number'
                    const refItemId = node.ref?.itemId
                    const classes = ['mindmap__node']
                    if (node.id === scopeDoc.rootId) classes.push('mindmap__node--root')
                    if (isPaper) classes.push('mindmap__node--paper')
                    return (
                      <div
                        key={node.id}
                        className={classes.join(' ')}
                        style={{
                          left: node.x,
                          top: node.y,
                          width: sizeOf(node.id).width,
                          minHeight: sizeOf(node.id).height
                        }}
                        data-testid={
                          isPaper && typeof refItemId === 'number'
                            ? `mindmap-paper-node-${refItemId}`
                            : `mindmap-node-${node.id}`
                        }
                        title={
                          isPaper
                            ? `点击在新窗口打开这篇论文的思维地图：${cleanPaperTitle(
                                stripMarkdownForMap(node.text)
                              )}`
                            : stripMarkdownForMap(node.text)
                        }
                        onClick={
                          isPaper && typeof refItemId === 'number'
                            ? (event) => {
                                event.stopPropagation()
                                void openPaperWindow(refItemId, cleanPaperTitle(node.text))
                              }
                            : (event) => event.stopPropagation()
                        }
                      >
                        <span className="mindmap__node-text">
                          {stripMarkdownForMap(node.text)}
                        </span>
                        {isPaper ? <span className="mindmap__open-badge">打开</span> : null}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="mindmap__loading">{scopeError || '没有可显示的聚合地图'}</div>
          )
        ) : loading || !doc ? (
          <div className="mindmap__loading">载入中…</div>
        ) : (
          <div
            className="mindmap__viewport"
            ref={viewportRef}
            data-testid="mindmap-viewport"
            onPointerDown={onViewportPointerDown}
            onPointerMove={onViewportPointerMove}
            onPointerUp={onViewportPointerUp}
            onPointerCancel={onViewportPointerUp}
          >
            {/* PD56：stage 承担缩放后尺寸，canvas 以左上角为原点 scale；框选与拖动都换算回内容坐标 */}
            <div
              className="mindmap__stage"
              style={{
                width: Math.round(canvas.width * zoom),
                height: Math.round(canvas.height * zoom)
              }}
            >
              <div
                className="mindmap__canvas"
                style={{
                  width: canvas.width,
                  height: canvas.height,
                  transform: `scale(${zoom})`
                }}
              >
                <svg
                  className="mindmap__edges"
                  width={canvas.width}
                  height={canvas.height}
                  aria-hidden="true"
                >
                  {edges.map((edge) => (
                    <path key={edge.id} d={edge.d} />
                  ))}
                </svg>
                {visibleNodes.map((node) => {
                  const classes = ['mindmap__node']
                  if (node.id === doc.rootId) classes.push('mindmap__node--root')
                  if (
                    selectedIds.includes(node.id) ||
                    marqueeHits.includes(node.id)
                  ) {
                    classes.push('is-selected')
                  }
                  if (node.id === draggingId) classes.push('is-dragging')
                  const childCount = doc.nodes.filter(
                    (child) => child.parentId === node.id
                  ).length
                  const isCollapsed = collapsedIds.includes(node.id)
                  return (
                    <div
                      key={node.id}
                      className={classes.join(' ')}
                      style={{
                        left: node.x,
                        top: node.y,
                        width: sizeOf(node.id).width,
                        minHeight: sizeOf(node.id).height
                      }}
                      data-testid={`mindmap-node-${node.id}`}
                      title={stripMarkdownForMap(node.text)}
                      onPointerDown={(event) => onNodePointerDown(event, node)}
                      onPointerMove={(event) => onNodePointerMove(event, node)}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                      onDoubleClick={(event) => {
                        event.stopPropagation()
                        beginEdit(node)
                      }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {editingId === node.id ? (
                        <input
                          className="mindmap__input"
                          value={draft}
                          autoFocus
                          aria-label="节点名称"
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={commitEdit}
                          onPointerDown={(event) => event.stopPropagation()}
                          onDoubleClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              commitEdit()
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              setEditingId(null)
                            }
                          }}
                        />
                      ) : (
                        <span className="mindmap__node-text">
                          {stripMarkdownForMap(node.text)}
                        </span>
                      )}
                      {node.source === 'ai-generated' ? (
                        <span
                          title="由 AI 展开生成：可用工具栏「撤销上一步」一次性移除"
                          style={{
                            position: 'absolute',
                            top: 2,
                            right: 4,
                            fontSize: 10,
                            lineHeight: '13px',
                            padding: '0 4px',
                            borderRadius: 6,
                            background: 'rgba(109, 40, 217, 0.14)',
                            color: '#6d28d9',
                            pointerEvents: 'none'
                          }}
                        >
                          AI
                        </span>
                      ) : null}
                      {node.source === MINDMAP_DIGEST_SOURCE ? (
                        <span
                          className="mindmap__source mindmap__source--digest"
                          title="由「论文拆解同步」写入：可用工具栏「清除拆解节点」一并移除"
                        >
                          拆解
                        </span>
                      ) : null}
                      {childCount > 0 ? (
                        <span
                          className={`mindmap__collapse-badge${isCollapsed ? ' is-collapsed' : ''}`}
                          data-testid={`mindmap-collapse-${node.id}`}
                          title={
                            isCollapsed
                              ? `已折叠 ${childCount} 个子节点，点击展开`
                              : `点击折叠 ${childCount} 个子节点`
                          }
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation()
                            toggleCollapsed(node.id)
                          }}
                        >
                          {isCollapsed ? `＋${childCount}` : `−${childCount}`}
                        </span>
                      ) : null}
                    </div>
                  )
                })}
                {marqueeRect ? (
                  <div
                    className="mindmap__marquee"
                    data-testid="mindmap-marquee"
                    style={{
                      left: marqueeRect.left,
                      top: marqueeRect.top,
                      width: marqueeRect.right - marqueeRect.left,
                      height: marqueeRect.bottom - marqueeRect.top
                    }}
                  />
                ) : null}
              </div>
            </div>
          </div>
        )}

        {level === 'paper' ? (
          <footer className="mindmap__footer">
            骨架、AI 摘要/优化、点锚定位与导出说明见 README「思维地图」一节。
          </footer>
        ) : (
          <footer className="mindmap__footer">
            聚合视图只读：节点来自各文献已保存的地图，这里不写回任何内容。点击论文节点可在新窗口打开并继续编辑，
            关闭新窗口后回到本面板切到「论文」级即可看到最新位置。
          </footer>
        )}
      </div>
    </div>
  )
}
