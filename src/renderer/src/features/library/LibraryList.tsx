import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react'
import type { Item, LibraryGroup, LibraryTag, SearchHit } from '@shared/types'
import {
  GROUP_ALL,
  GROUP_UNGROUPED,
  buildGroupTree,
  filterItemsByGroup,
  flattenGroupTree,
  groupDisplayName,
  groupWithDescendants,
  isGroupCollapsed,
  normalizeGroupName,
  toggleGroupCollapsed,
  type GroupCollapseState,
  type GroupTreeNode
} from '@shared/library-groups'
import { flattenGroupDragRows, resolveGroupDrop, type GroupDropPlan } from './group-drag'
import {
  GROUP_PANE_DEFAULT_HEIGHT,
  GROUP_PANE_MIN_HEIGHT,
  GROUP_PANE_STORE_KEY,
  clampGroupPaneHeight,
  groupPaneHeightFromContent,
  groupPaneHeightFromDrag,
  groupPaneStyle,
  groupTreeContentHeight,
  maxGroupPaneHeight,
  readStoredGroupPaneHeight,
  resetGroupPaneHeight
} from './group-split'
import { Icon } from '../../components/Icon'

interface Props {
  items: Item[]
  activeId: number | null
  onSelect: (id: number) => void
  onImport: (group?: string | null) => void | Promise<void>
  onImportFolder: (group?: string | null) => void | Promise<void>
  onOpenHit: (hit: SearchHit, query: string) => void
  /** 双击条目：在左栏显示该文详情（作者/期刊/主要思想/被引） */
  onShowDetail?: (itemId: number) => void
  onDelete: (itemId: number) => void | Promise<void>
  /** 链路导入成功后刷新文库 */
  onLibraryChanged?: () => void | Promise<void>
  /** 收起左侧文库栏（折叠为薄条，始终可见） */
  onCollapse?: () => void
  /** 以「搜索」入口打开时自动聚焦搜索框 */
  focusSearch?: boolean
  /**
   * 受控的分组筛选（可选）。由 App 持有：切到右侧面板时左栏会卸载，
   * 分组选择仍要保留，AI 面板也要据此提供「分组级问答」。
   */
  groupFilter?: string
  onGroupFilterChange?: (value: string) => void
}

const KIND_LABEL: Record<string, string> = { item: '条目', note: '笔记', chunk: '全文', translation: '译文' }

// #region search-request-state
// PD03：搜索状态机（纯函数）。每次输入变化 / 清空 / 重试都会拿到更大的 seq，
// 异步回调只有在自己仍是最新请求时才能改状态——旧请求的结果、loading、错误一律丢弃。
type SearchPhase = 'idle' | 'loading' | 'success' | 'error'

interface SearchRequestState {
  /** 最新请求序号；过期的 resolve/reject 不允许写回 */
  seq: number
  /** 该状态对应的输入（已 trim）；与当前输入不一致时不得展示 */
  query: string
  phase: SearchPhase
  hits: SearchHit[]
  error: string
}

type SearchRequestEvent =
  | { type: 'begin'; seq: number; query: string }
  | { type: 'clear'; seq: number }
  | { type: 'resolve'; seq: number; hits: SearchHit[] }
  | { type: 'reject'; seq: number; error: string }

function initialSearchRequestState(): SearchRequestState {
  return { seq: 0, query: '', phase: 'idle', hits: [], error: '' }
}

function reduceSearchRequest(
  state: SearchRequestState,
  event: SearchRequestEvent
): SearchRequestState {
  switch (event.type) {
    case 'begin':
      if (event.seq <= state.seq) return state
      return { seq: event.seq, query: event.query, phase: 'loading', hits: [], error: '' }
    case 'clear':
      if (event.seq <= state.seq) return state
      return { seq: event.seq, query: '', phase: 'idle', hits: [], error: '' }
    case 'resolve':
      if (event.seq !== state.seq) return state
      return { seq: state.seq, query: state.query, phase: 'success', hits: event.hits, error: '' }
    case 'reject':
      if (event.seq !== state.seq) return state
      return { seq: state.seq, query: state.query, phase: 'error', hits: [], error: event.error }
    default:
      return state
  }
}
// #endregion search-request-state

/** 层级缩进交给 CSS 变量：TSX 只传深度，像素留在 styles.css（UI-SPEC §6.2） */
const depthStyle = (depth: number): CSSProperties =>
  ({ '--depth': depth }) as unknown as CSSProperties

export function LibraryList({
  items,
  activeId,
  onSelect,
  onImport,
  onImportFolder,
  onOpenHit,
  onShowDetail,
  onDelete,
  onLibraryChanged,
  onCollapse,
  focusSearch,
  groupFilter: groupFilterProp,
  onGroupFilterChange
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  // 搜索状态（结果 / loading / 错误）由同一个带序号的 reducer 持有，避免三条独立
  // setState 在乱序回调下互相覆盖（PD03）。
  const [searchState, dispatchSearch] = useReducer(reduceSearchRequest, undefined, initialSearchRequestState)
  const { hits, phase: searchPhase, error: searchError } = searchState
  const searchSeq = useRef(0)
  // 失败后重试：自增触发 effect 重新搜索（与输入变化共用同一套序号逻辑）
  const [searchRetry, setSearchRetry] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [urlInput, setUrlInput] = useState('')
  const [urlMsg, setUrlMsg] = useState('')
  const [urlBusy, setUrlBusy] = useState(false)
  // 分组：filter 为 GROUP_ALL / GROUP_UNGROUPED / 真实组名
  // 受控模式（App 传入 groupFilter/onGroupFilterChange）下由上层持有，便于 AI 面板复用
  const [groupFilterLocal, setGroupFilterLocal] = useState<string>(GROUP_ALL)
  const groupFilter = groupFilterProp ?? groupFilterLocal
  const setGroupFilter = (next: string): void => {
    if (groupFilterProp === undefined) setGroupFilterLocal(next)
    onGroupFilterChange?.(next)
  }
  const [groups, setGroups] = useState<LibraryGroup[]>([])
  const [newGroup, setNewGroup] = useState('')
  const groupInputRef = useRef<HTMLInputElement | null>(null)
  // 常驻分组树：折叠状态（VSCode 式，有子分组默认收起；只影响显示，不影响数据）。
  // 仅记录用户显式点过的组，其余走 shared 的默认规则。
  const [groupCollapse, setGroupCollapse] = useState<GroupCollapseState>({})
  const [groupMsg, setGroupMsg] = useState('')
  const [tags, setTags] = useState<LibraryTag[]>([])
  const [tagFilter, setTagFilter] = useState('')
  const [groupInfo, setGroupInfo] = useState<LibraryGroup | null>(null)
  const [groupMetaEdit, setGroupMetaEdit] = useState<{
    name: string
    leaf: string
    parent: string
    description: string
  } | null>(null)
  // 删除分组确认框：带分组名、整棵子树文献数与子分组数，确认后才真正落库
  const [deleteTarget, setDeleteTarget] = useState<{
    name: string
    items: number
    children: number
  } | null>(null)
  // 行内删除按钮只在悬停或键盘聚焦该行时出现（分组树没有 :hover 删除样式）
  const [hoverGroup, setHoverGroup] = useState<string | null>(null)
  // 分组拖拽（类资源管理器）：drag 源放 ref（dragOver 高频回调里读最新值），
  // 预览放 state 只用于高亮/插入线；非法落点单独记一行，用来显示禁止光标。
  const groupDragRef = useRef<{ name: string } | null>(null)
  const groupDropKeyRef = useRef('')
  const [groupDragName, setGroupDragName] = useState<string | null>(null)
  const [groupDropPreview, setGroupDropPreview] = useState<GroupDropPlan | null>(null)
  const [groupDropBlocked, setGroupDropBlocked] = useState<string | null>(null)
  /** 分组落库后自增，触发 listGroups 重新拉一次（含父子关系与同层顺序） */
  const [groupsReload, setGroupsReload] = useState(0)
  const [visibleLimit, setVisibleLimit] = useState(200)
  const timer = useRef<number | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  // 分组区 / 文献列表之间的横向分隔条：分组面板高度（px），拖动实时改，双击复位。
  // 阶段二：默认按分组内容自适应（分组多时封顶到上限并内部滚动）；用户拖动后写 localStorage，
  // 刷新 / 重启按记住的高度恢复；双击恢复为「自适应」。
  const [groupPaneHeight, setGroupPaneHeight] = useState<number>(() => {
    const stored = readStoredGroupPaneHeight(
      typeof localStorage === 'undefined' ? null : localStorage.getItem(GROUP_PANE_STORE_KEY)
    )
    return stored ?? GROUP_PANE_DEFAULT_HEIGHT
  })
  /** true = 高度由内容决定（用户还没手动调过） */
  const [groupPaneAuto, setGroupPaneAuto] = useState<boolean>(() => {
    return (
      readStoredGroupPaneHeight(
        typeof localStorage === 'undefined' ? null : localStorage.getItem(GROUP_PANE_STORE_KEY)
      ) == null
    )
  })
  const [introOpen, setIntroOpen] = useState(false)
  // 「＋」默认收起：新建输入框不常驻，避免空占一行高度
  const [groupNewOpen, setGroupNewOpen] = useState(false)
  const groupHeadRef = useRef<HTMLDivElement | null>(null)
  const groupRowsRef = useRef<HTMLDivElement | null>(null)
  const groupNewRef = useRef<HTMLDivElement | null>(null)
  const groupInfoRef = useRef<HTMLDivElement | null>(null)
  const splitRef = useRef<HTMLDivElement | null>(null)
  const splitDragRef = useRef<{
    pointerId: number
    startY: number
    startHeight: number
    available: number
  } | null>(null)

  // 窗口变矮时把分组面板夹回上限，避免把文献列表挤成 0 高
  useEffect(() => {
    const onResize = (): void => {
      setGroupPaneHeight((h) => clampGroupPaneHeight(h, splitRef.current?.clientHeight ?? 0))
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 阶段二：内容自适应高度的测量放在 currentGroupName 定义之后（见下方 effect）

  // 以「搜索」入口打开左侧面板时，自动聚焦搜索框
  useEffect(() => {
    if (focusSearch) searchRef.current?.focus()
  }, [focusSearch])

  // 列表显示「期刊 · 年份 · 主要作者」：**仅查本地库**的作者（不联网、不调模型）。
  // 一次批量 IPC + 一次 SQL 取回全部可见条目（原先逐条 IPC 是 N+1，文库大时列表明显卡顿）。
  const [authorOf, setAuthorOf] = useState<Record<number, string>>({})
  useEffect(() => {
    let cancelled = false
    const ids = items.slice(0, 80).map((it) => it.id)
    if (ids.length === 0) {
      setAuthorOf({})
      return
    }
    void window.api.authors
      .forItemsLocal(ids)
      .then((byItem) => {
        if (cancelled) return
        const map: Record<number, string> = {}
        for (const [id, names] of Object.entries(byItem ?? {})) {
          if (names && names.length) map[Number(id)] = names[0]
        }
        setAuthorOf(map)
      })
      .catch(() => {
        /* 作者只影响副标题，失败不影响列表 */
      })
    return () => {
      cancelled = true
    }
  }, [items])

  // 分组计数（主进程一次 GROUP BY 查询；失败时退化为只显示组名）
  useEffect(() => {
    let cancelled = false
    void window.api.library
      .listGroups()
      .then((gs) => {
        if (!cancelled) setGroups(gs ?? [])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [items, groupsReload])

  // 手动标签：列表筛选、行内 chip 与批处理范围共用
  useEffect(() => {
    let cancelled = false
    void window.api.library
      .listTags()
      .then((ts) => {
        if (!cancelled) setTags(ts ?? [])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [items])

  useEffect(() => {
    setVisibleLimit(200)
  }, [groupFilter, tagFilter, query])

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    const q = query.trim()
    // 先占号：清空也占一个号，让仍在路上的旧请求彻底失效
    const seq = ++searchSeq.current
    if (!q) {
      dispatchSearch({ type: 'clear', seq })
      return
    }
    dispatchSearch({ type: 'begin', seq, query: q })
    timer.current = window.setTimeout(() => {
      void window.api.search
        .query(q, 30)
        .then((r) => dispatchSearch({ type: 'resolve', seq, hits: r }))
        .catch((e) => {
          dispatchSearch({ type: 'reject', seq, error: readableSearchError(e) })
        })
    }, 220)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [query, searchRetry])

  const active = query.trim()
  // 只有「状态对应的输入」与当前输入一致时才展示结果/错误；输入刚变化、effect 还没跑
  // 的那一帧也不会闪出上一轮的命中（PD03）。
  const searchIsCurrent = searchState.query === active
  const searchLoading = active.length > 0 && (!searchIsCurrent || searchPhase === 'loading')
  const currentHits = searchIsCurrent ? hits : []

  // 分组树：空分组也要显示；旧数据的 `a/b` 路径会自动补出父级。
  const groupTree = useMemo(() => buildGroupTree(groups), [groups])
  // 拖拽落点解析用的先序行（带同层 index 与父级）
  const groupDragRows = useMemo(() => flattenGroupDragRows(groupTree), [groupTree])
  const flatGroupOptions = useMemo(() => flattenGroupTree(groupTree), [groupTree])
  const subtreeCount = (node: GroupTreeNode): number =>
    node.count + node.children.reduce((n, child) => n + subtreeCount(child), 0)
  const groupedCount = groups.reduce((n, g) => n + g.count, 0)
  const ungroupedCount = Math.max(0, items.length - groupedCount)
  const currentGroupName =
    groupFilter === GROUP_ALL || groupFilter === GROUP_UNGROUPED
      ? null
      : normalizeGroupName(groupFilter)

  // 切换分组时收起介绍（默认紧凑显示，可点「展开」查看全文）
  useEffect(() => {
    setIntroOpen(false)
  }, [currentGroupName])

  // 阶段二：内容自适应高度 —— 标题行 + 分组树实际内容 + 「新建分组」行 + 分组介绍卡。
  // 分组很多时由 clampGroupPaneHeight 封顶（文献列表至少留 LIST_MIN），超出的行在分组树内部滚动。
  // 介绍卡高度必须计入：否则有介绍的分组里，分组树会被挤到只剩一行可见。
  const groupInfoDesc = groupInfo?.description ?? ''
  useEffect(() => {
    if (!groupPaneAuto) return
    const rows = groupRowsRef.current
    if (!rows) return
    const head = groupHeadRef.current?.offsetHeight ?? 0
    // 不能读 rows.scrollHeight / clientHeight：分组树在分隔面板里是 flex:1，
    // 面板比内容高时 clientHeight 会被撑大，scrollHeight 也随之返回撑大后的值，
    // 于是删掉分组后面板不会跟着缩（用户看到的就是「分组很少却留一大块空白」）。
    // 改为累加每个可见行自身高度（行间距 1px）。
    const rowNodes = Array.from(rows.children) as HTMLElement[]
    const body = groupTreeContentHeight(rowNodes.map((el) => el.offsetHeight))
    const footer = groupNewRef.current?.offsetHeight ?? 0
    const info = groupInfoRef.current?.offsetHeight ?? 0
    if (body <= 0) return
    setGroupPaneHeight(
      clampGroupPaneHeight(head + body + footer + info + 6, splitRef.current?.clientHeight ?? 0)
    )
  }, [groupPaneAuto, groups, groupsReload, groupCollapse, currentGroupName, introOpen, groupInfoDesc, groupNewOpen])
  // 点父分组时显示「本组 + 全部后代组」的论文；点叶子组则只显示本组。
  const visibleItems = useMemo(() => {
    if (!currentGroupName) return filterItemsByGroup(items, groupFilter)
    const names = new Set(groupWithDescendants(groups, currentGroupName))
    return items.filter((i) => {
      const name = normalizeGroupName(i.group_name)
      return name != null && names.has(name)
    })
  }, [items, groupFilter, groups, currentGroupName])
  const currentGroupLabel =
    groupFilter === GROUP_ALL
      ? '全部'
      : groupFilter === GROUP_UNGROUPED
        ? '未分组'
        : (groupDisplayName(groupFilter) || '全部')
  const currentGroupCount =
    groupFilter === GROUP_ALL
      ? items.length
      : groupFilter === GROUP_UNGROUPED
        ? ungroupedCount
        : (subtreeCount(flatGroupOptions.find((g) => g.name === groupFilter) ?? {
            name: '',
            count: 0,
            depth: 0,
            parent_name: null,
            children: []
          }))

  // 选中分组时懒加载这一组的介绍/修改时间；分组详情不在列表里重复展开。
  useEffect(() => {
    let cancelled = false
    if (!currentGroupName) {
      setGroupInfo(null)
      return
    }
    void window.api.library
      .getGroup(currentGroupName)
      .then((g) => {
        if (!cancelled) setGroupInfo(g)
      })
      .catch(() => {
        if (!cancelled) setGroupInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [currentGroupName, items])

  const tagFiltered = useMemo(
    () => (tagFilter ? visibleItems.filter((i) => i.tags?.includes(tagFilter)) : visibleItems),
    [visibleItems, tagFilter]
  )
  // 头部计数跟随列表实际内容：搜索时是命中数，否则是当前分组/标签筛选后的总数。
  const displayCount = active ? currentHits.length : tagFiltered.length
  // 大库首屏只渲染一部分；继续向下滚动时再追加，避免一次挂上千行。
  const pageItems = tagFiltered.slice(0, visibleLimit)
  const hasMore = tagFiltered.length > visibleLimit

  // 按 parent_id 组织层级（Obsidian 式）：顶层为 parent 为空或父不在列表中的条目
  const idSet = new Set(pageItems.map((i) => i.id))
  const byParent = new Map<number, Item[]>()
  for (const it of pageItems) {
    if (it.parent_id != null && idSet.has(it.parent_id)) {
      const arr = byParent.get(it.parent_id) ?? []
      arr.push(it)
      byParent.set(it.parent_id, arr)
    }
  }
  const roots = pageItems.filter((i) => i.parent_id == null || !idSet.has(i.parent_id))

  /** 新建子分组：父级 = 当前筛选的分组；之后导入的文献自动归入。 */
  const createGroup = async (): Promise<void> => {
    const name = normalizeGroupName(newGroup)
    if (!name) {
      groupInputRef.current?.focus()
      return
    }
    const parent = currentGroupName
    if (typeof window.api.library.createGroup !== 'function') {
      setGroupMsg('当前窗口仍是旧版接口，请完全退出 PaperDesk 后重新启动再试')
      return
    }
    try {
      const created = await window.api.library.createGroup(name, parent)
      setNewGroup('')
      setGroupNewOpen(false)
      groupInputRef.current?.blur()
      setGroups((prev) => (prev.some((g) => g.name === created.name) ? prev : [...prev, created]))
      setGroupFilter(created.name)
      setGroupMsg(
        parent
          ? `已新建子分组「${groupDisplayName(created.name)}」（位于「${groupDisplayName(parent)}」下）`
          : `已新建分组「${created.name}」`
      )
    } catch (e) {
      setGroupMsg(`新建分组失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 导入 PDF：分组由主进程在入库事务里写入，避免「导入后逐条补标签」的竞态。 */
  const importFiles = async (): Promise<void> => {
    await onImport(currentGroupName)
  }

  const toggle = (id: number): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 从链接 / DOI / arXiv 导入 PDF（单条 → 单链接通道；多条 → 批量通道）
  const importFromUrl = async (): Promise<void> => {
    const value = urlInput.trim()
    if (!value || urlBusy) return
    setUrlBusy(true)
    setUrlMsg('正在解析并下载…')
    const target = currentGroupName
    try {
      const lines = value
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      if (lines.length <= 1) {
        const res = await window.api.library.importFromUrl(value, target)
        const importedTitle = res.result && 'item' in res.result ? res.result.item.title : null
        setUrlMsg(res.ok && importedTitle ? `已导入：${importedTitle}` : res.message)
        // 只有本次真正新增的条目才刷新；跳过/失败不改动任何已有条目（PD02）
        if (res.itemIds.length > 0) {
          setUrlInput('')
          await onLibraryChanged?.()
        }
      } else {
        const res = await window.api.library.importManyFromUrls(value, target)
        setUrlMsg(res.message)
        if (res.itemIds.length > 0) {
          setUrlInput('')
          await onLibraryChanged?.()
        }
      }
    } catch (e) {
      setUrlMsg(`导入失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setUrlBusy(false)
    }
  }

  const openGroupMeta = (): void => {
    if (!currentGroupName) return
    const parts = currentGroupName.split('/')
    setGroupMetaEdit({
      name: currentGroupName,
      leaf: parts[parts.length - 1] ?? currentGroupName,
      parent: parts.slice(0, -1).join('/'),
      description: groupInfo?.description ?? ''
    })
  }

  const saveGroupMeta = async (): Promise<void> => {
    if (!groupMetaEdit) return
    try {
      const updated = await window.api.library.updateGroup(groupMetaEdit.name, {
        leaf: groupMetaEdit.leaf.trim(),
        parent: groupMetaEdit.parent.trim(),
        description: groupMetaEdit.description
      })
      setGroupMetaEdit(null)
      setGroupFilter(updated.name)
      await onLibraryChanged?.()
    } catch (e) {
      window.alert(`保存分组信息失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const openDeleteGroup = (node: GroupTreeNode): void => {
    const countDescendants = (n: GroupTreeNode): number =>
      n.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0)
    setDeleteTarget({
      name: node.name,
      items: subtreeCount(node),
      children: countDescendants(node)
    })
    setGroupMsg('')
  }

  const confirmDeleteGroup = async (): Promise<void> => {
    const target = deleteTarget
    if (!target) return
    if (typeof window.api.library.deleteGroup !== 'function') {
      setDeleteTarget(null)
      setGroupMsg('当前窗口仍是旧版接口，请完全退出 PaperDesk 后重新启动再试')
      return
    }
    try {
      // 有子分组时必须显式 withDescendants：后端默认拒绝，避免误删整棵树
      const res = await window.api.library.deleteGroup(
        target.name,
        target.children > 0 ? { withDescendants: true } : {}
      )
      const removed = new Set(res.removed)
      setDeleteTarget(null)
      setGroups((list) => list.filter((g) => !removed.has(g.name)))
      // 折叠状态里被删掉的分组一并清理；其余保持不变
      setGroupCollapse((st) => {
        const next: GroupCollapseState = {}
        for (const [name, flag] of Object.entries(st)) {
          if (!removed.has(name)) next[name] = flag
        }
        return next
      })
      // 正在筛选被删分组（或其后代）就回落到「全部」，不留幽灵分组筛选
      const stillThere = (name: string): boolean =>
        [...removed].some((gone) => name === gone || name.startsWith(`${gone}/`))
      if (groupFilter !== GROUP_ALL && groupFilter !== GROUP_UNGROUPED && stillThere(groupFilter)) {
        setGroupFilter(GROUP_ALL)
      }
      setGroupsReload((n) => n + 1)
      await onLibraryChanged?.()
      const movedTo = res.parent_name
        ? `已移到「${groupDisplayName(res.parent_name)}」`
        : '已移到「未分组」'
      setGroupMsg(
        `已删除分组「${groupDisplayName(target.name)}」${
          res.movedItems > 0 ? `，${res.movedItems} 篇文献${movedTo}` : ''
        }`
      )
    } catch (e) {
      setDeleteTarget(null)
      setGroupMsg(`删除分组失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // —— 分组拖拽（类资源管理器）：悬停算落点 → 高亮/插入线 → 松开落库 ——
  // 落点解析在 ./group-drag（纯函数、可单测）；这里只做 DOM 事件与 IPC。
  const clearGroupDrag = (): void => {
    groupDragRef.current = null
    groupDropKeyRef.current = ''
    setGroupDragName(null)
    setGroupDropPreview(null)
    setGroupDropBlocked(null)
  }

  /** 只在预览真的变化时 setState：dragOver 每帧都会触发，避免无谓重渲染 */
  const previewGroupDrop = (plan: GroupDropPlan | null, target: string | null): void => {
    const key = plan
      ? `${plan.mode}|${plan.parent ?? ''}|${plan.position ?? ''}|${plan.targetName ?? ''}`
      : `blocked|${target ?? ''}`
    if (key === groupDropKeyRef.current) return
    groupDropKeyRef.current = key
    setGroupDropPreview(plan)
    setGroupDropBlocked(plan ? null : target)
  }

  const applyGroupDrop = async (dragName: string, plan: GroupDropPlan): Promise<void> => {
    if (typeof window.api.library.updateGroup !== 'function') {
      setGroupMsg('当前窗口仍是旧版接口，请完全退出 PaperDesk 后重新启动再试')
      return
    }
    try {
      const updated = await window.api.library.updateGroup(dragName, {
        parent: plan.parent,
        position: plan.position
      })
      setGroupsReload((n) => n + 1)
      setGroupFilter(updated.name)
      const leaf = groupDisplayName(updated.name)
      if (plan.mode === 'child') {
        setGroupMsg(
          `已把「${groupDisplayName(dragName)}」移入「${groupDisplayName(plan.parent ?? '')}」下`
        )
      } else if (plan.mode === 'root') {
        setGroupMsg(`已把「${leaf}」移到顶层`)
      } else {
        setGroupMsg(
          `已把「${leaf}」插到「${groupDisplayName(plan.targetName ?? '')}」` +
            (plan.mode === 'before' ? '之前' : '之后')
        )
      }
    } catch (e) {
      setGroupMsg(`移动分组失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const beginGroupDrag = (name: string, e: React.DragEvent): void => {
    groupDragRef.current = { name }
    groupDropKeyRef.current = ''
    setGroupDragName(name)
    setGroupDropPreview(null)
    setGroupDropBlocked(null)
    setGroupMsg('')
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      try {
        e.dataTransfer.setData('text/plain', name)
      } catch {
        /* 个别平台限制自定义类型，忽略：拖拽不依赖 clipboard 数据 */
      }
    }
  }

  const dropRatio = (e: React.DragEvent): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    return rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5
  }

  const overGroupRow = (nodeName: string, e: React.DragEvent): void => {
    const drag = groupDragRef.current
    if (!drag) return
    e.preventDefault()
    e.stopPropagation()
    const plan = resolveGroupDrop(drag.name, groupDragRows, {
      targetName: nodeName,
      edgeRatio: dropRatio(e)
    })
    if (e.dataTransfer) e.dataTransfer.dropEffect = plan ? 'move' : 'none'
    previewGroupDrop(plan, nodeName)
  }

  const dropOnGroupRow = (nodeName: string, e: React.DragEvent): void => {
    const drag = groupDragRef.current
    if (!drag) return
    e.preventDefault()
    e.stopPropagation()
    const plan = resolveGroupDrop(drag.name, groupDragRows, {
      targetName: nodeName,
      edgeRatio: dropRatio(e)
    })
    clearGroupDrag()
    if (!plan) {
      setGroupMsg('不能把分组移动到它自己或它的子分组下')
      return
    }
    void applyGroupDrop(drag.name, plan)
  }

  /** 分组菜单的空白处：落到这里 = 回到顶层 */
  const overBlankArea = (e: React.DragEvent): void => {
    if (!groupDragRef.current) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    previewGroupDrop({ mode: 'root', parent: null, position: null, targetName: null }, null)
  }

  const dropOnBlankArea = (e: React.DragEvent): void => {
    const drag = groupDragRef.current
    if (!drag) return
    e.preventDefault()
    e.stopPropagation()
    clearGroupDrag()
    void applyGroupDrop(drag.name, { mode: 'root', parent: null, position: null, targetName: null })
  }

  const renderRow = (it: Item, depth: number): React.JSX.Element => {
    const kids = byParent.get(it.id) ?? []
    const hasKids = kids.length > 0
    const isOpen = !collapsed.has(it.id)
    return (
      <div key={it.id} className="tree__node">
        <div
          className={`list__item tree__row${it.id === activeId ? ' list__item--active' : ''}`}
          style={depthStyle(depth)}
          data-testid="item-row"
          title="双击查看文档详情"
          onClick={() => onSelect(it.id)}
          onDoubleClick={() => onShowDetail?.(it.id)}
        >
          {hasKids ? (
            <button
              className="icon ghost tree__caret"
              title={isOpen ? '收起' : '展开'}
              onClick={(e) => {
                e.stopPropagation()
                toggle(it.id)
              }}
            >
              <Icon
                name="right"
                size={13}
                className={`tree__caret-icon${isOpen ? ' is-open' : ''}`}
              />
            </button>
          ) : (
            <span className="tree__caret tree__caret--leaf" />
          )}
          <div className="list__item-main">
            <div className="list__item-title">{it.title ?? '未命名'}</div>
            <div className="list__item-meta">
              {it.domain && <span className="list__item-domain">{it.domain}</span>}
              {(it.tags ?? []).slice(0, 3).map((t) => (
                <button
                  key={t}
                  className={`tag-chip${tagFilter === t ? ' tag-chip--active' : ''}`}
                  title={`按标签「${t}」筛选`}
                  data-testid="item-tag-chip"
                  onClick={(e) => {
                    e.stopPropagation()
                    setTagFilter((cur) => (cur === t ? '' : t))
                  }}
                >
                  {t}
                </button>
              ))}
              {authorOf[it.id] && <span>{authorOf[it.id]} 等</span>}
              {authorOf[it.id] && <span>·</span>}
              <span>{it.venue || '暂无发表信息'}</span>
              <span>·</span>
              <span>{it.year ?? '—'}</span>
            </div>
          </div>
          <button
            className="icon ghost tree__del"
            title="删除该条目"
            data-testid="item-delete"
            onClick={(e) => {
              e.stopPropagation()
              void onDelete(it.id)
            }}
          >
            <Icon name="trash" size={13} />
          </button>
        </div>
        {hasKids && isOpen && kids.map((k) => renderRow(k, depth + 1))}
      </div>
    )
  }

  const renderGroupNode = (node: GroupTreeNode, depth: number): React.JSX.Element => {
    const preview = groupDropPreview?.targetName === node.name ? groupDropPreview : null
    const blocked = groupDropBlocked === node.name
    const dragging = groupDragName === node.name
    const collapsed = isGroupCollapsed(groupCollapse, node)
    const expandGroup = (): void => {
      if (node.children.length > 0) setGroupCollapse({ ...groupCollapse, [node.name]: false })
    }
    // 落点指示：成为子分组 = 整行高亮；前后插入 = 上/下插入线；非法 = 禁止光标 + 红框
    const dropStyle: CSSProperties | undefined = preview
      ? preview.mode === 'child'
        ? {
            background: 'color-mix(in srgb, var(--accent) 22%, transparent)',
            boxShadow: 'inset 0 0 0 2px var(--accent)'
          }
        : preview.mode === 'before'
          ? { boxShadow: 'inset 0 2px 0 0 var(--accent)' }
          : preview.mode === 'after'
            ? { boxShadow: 'inset 0 -2px 0 0 var(--accent)' }
            : undefined
      : blocked
        ? { boxShadow: 'inset 0 0 0 2px #e5484d', cursor: 'not-allowed' }
        : undefined
    return (
      <div
        key={node.name}
        className={`group-picker__node${depth > 0 ? ' group-picker__node--sub' : ''}`}
      >
        <div
          className="group-tree__row"
          onMouseEnter={() => setHoverGroup(node.name)}
          onMouseLeave={() => setHoverGroup((cur) => (cur === node.name ? null : cur))}
        >
          {node.children.length > 0 ? (
            <button
              className="group-tree__caret"
              title={collapsed ? '展开子分组' : '收起子分组'}
              aria-label={collapsed ? `展开分组 ${groupDisplayName(node.name)}` : `收起分组 ${groupDisplayName(node.name)}`}
              aria-expanded={!collapsed}
              data-testid="group-caret"
              data-group-name={node.name}
              onClick={(e) => {
                e.stopPropagation()
                setGroupCollapse(toggleGroupCollapsed(groupCollapse, node))
              }}
            >
              {collapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="group-tree__caret group-tree__caret--empty" aria-hidden="true" />
          )}
        <button
          className={`group-picker__item${groupFilter === node.name ? ' active' : ''}`}
          style={{ ...depthStyle(depth), ...dropStyle, opacity: dragging ? 0.5 : undefined }}
          title={
            preview?.mode === 'child'
              ? `松开：把分组移入「${groupDisplayName(node.name)}」`
              : preview?.mode === 'before'
                ? `松开：插到「${groupDisplayName(node.name)}」之前`
                : preview?.mode === 'after'
                  ? `松开：插到「${groupDisplayName(node.name)}」之后`
                  : blocked
                    ? '不能移动到它自己或它的子分组下'
                    : node.name
          }
          data-testid="group-option"
          data-group-name={node.name}
          data-drop-mode={preview?.mode ?? (blocked ? 'blocked' : undefined)}
          draggable
          onDragStart={(e) => beginGroupDrag(node.name, e)}
          onDragOver={(e) => overGroupRow(node.name, e)}
          onDrop={(e) => dropOnGroupRow(node.name, e)}
          onDragEnd={() => clearGroupDrag()}
          onClick={() => {
            setGroupFilter(node.name)
            setGroupMsg('')
            // VSCode 式：点行也展开（保持选中语义，收起仍通过箭头操作）
            if (collapsed) expandGroup()
          }}
        >
          <Icon name="folder" size={13} />
          <span className="group-picker__name">{groupDisplayName(node.name)}</span>
          <span className="group-picker__count">{subtreeCount(node)}</span>
          {node.children.length > 0 && (
            <span className="group-picker__more" aria-hidden="true">
              ›
            </span>
          )}
        </button>
        <button
          className="ghost"
          type="button"
          title={`删除分组「${groupDisplayName(node.name)}」`}
          aria-label={`删除分组 ${groupDisplayName(node.name)}`}
          data-testid="group-delete"
          data-group-name={node.name}
          style={{
            opacity: hoverGroup === node.name ? 1 : 0,
            pointerEvents: hoverGroup === node.name ? 'auto' : 'none',
            transition: 'opacity 120ms',
            flex: '0 0 auto',
            padding: '0 4px',
            lineHeight: 1
          }}
          onFocus={() => setHoverGroup(node.name)}
          onBlur={() => setHoverGroup((cur) => (cur === node.name ? null : cur))}
          onClick={(e) => {
            e.stopPropagation()
            openDeleteGroup(node)
          }}
        >
          <Icon name="trash" size={13} />
        </button>
        </div>
        {node.children.length > 0 && !collapsed && (
          <div className="group-picker__children">
            {node.children.map((child) => renderGroupNode(child, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  // —— 分组区 / 文献列表分栏：Pointer Events 捕获，拖动时不会选中文字 ——
  const beginGroupSplitDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setGroupPaneAuto(false)
    splitDragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startHeight: groupPaneHeight,
      available: splitRef.current?.clientHeight ?? 0
    }
  }

  const moveGroupSplit = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = splitDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    e.preventDefault()
    setGroupPaneHeight(
      groupPaneHeightFromDrag(drag.startHeight, e.clientY - drag.startY, drag.available)
    )
  }

  const endGroupSplit = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = splitDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    splitDragRef.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    // 记住用户调整（阶段二：重启后恢复）；拖动过程不写，避免高频落盘
    try {
      localStorage.setItem(
        GROUP_PANE_STORE_KEY,
        String(clampGroupPaneHeight(groupPaneHeight, splitRef.current?.clientHeight ?? 0))
      )
    } catch {
      /* localStorage 不可用时忽略：下次启动继续按内容自适应 */
    }
  }

  const resetGroupSplit = (): void => {
    splitDragRef.current = null
    // 双击 = 回到「按内容自适应」，同时清掉手动记忆
    try {
      localStorage.removeItem(GROUP_PANE_STORE_KEY)
    } catch {
      /* ignore */
    }
    setGroupPaneAuto(true)
    setGroupPaneHeight(resetGroupPaneHeight(splitRef.current?.clientHeight ?? 0))
  }

  const nudgeGroupSplit = (deltaY: number): void => {
    setGroupPaneAuto(false)
    setGroupPaneHeight((h) => {
      const next = groupPaneHeightFromDrag(h, deltaY, splitRef.current?.clientHeight ?? 0)
      try {
        localStorage.setItem(GROUP_PANE_STORE_KEY, String(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  const onGroupSplitKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      nudgeGroupSplit(e.key === 'ArrowUp' ? -16 : 16)
    } else if (e.key === 'Home') {
      e.preventDefault()
      resetGroupSplit()
    }
  }

  const splitAvailable = splitRef.current?.clientHeight ?? 0
  const groupPaneHeightNow = clampGroupPaneHeight(groupPaneHeight, splitAvailable)

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <Icon name="book" size={18} className="icon" />
        PaperDesk
      </div>

      <div className="sidebar__header">
        <span className="sidebar__title sidebar__title--count" title={`文库 · ${displayCount}`}>
          <span className="sidebar__title-label">文库 ·</span>
          <span className="sidebar__count" data-testid="library-count">
            {displayCount}
          </span>
        </span>
        <span className="sidebar__actions">
          {onCollapse && (
            <button
              className="icon ghost"
              title="收起文库栏"
              data-testid="sb-collapse"
              onClick={onCollapse}
            >
              <Icon name="left" size={16} />
            </button>
          )}
          <button
            className="icon ghost"
            title="批量导入文件夹"
            data-testid="import-folder"
            onClick={() => void onImportFolder(currentGroupName)}
          >
            <Icon name="folder" size={16} />
          </button>
          <button
            className="btn btn--primary"
            title="导入 PDF"
            data-testid="import-pdf"
            onClick={() => void importFiles()}
          >
            <Icon name="upload" size={15} />
            导入
          </button>
        </span>
      </div>

      <div className="sidebar__search">
        <Icon name="search" size={14} />
        <input
          type="search"
          placeholder="搜索全文 / 笔记"
          value={query}
          ref={searchRef}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="search-input"
        />
      </div>

      <div className="sidebar__import-url">
        <input
          type="text"
          placeholder="DOI/arxiv/网页链接"
          title="输入 DOI、arXiv 编号或论文网页链接，自动嗅探并下载 PDF（OpenAlex / Semantic Scholar / doi.org 落地页等多级回退）"
          value={urlInput}
          disabled={urlBusy}
          data-testid="import-url-input"
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void importFromUrl()
            }
          }}
        />
        <button
          className="btn btn--primary"
          title="从链接导入 PDF（支持多行批量）"
          disabled={urlBusy}
          data-testid="import-url-go"
          onClick={() => void importFromUrl()}
        >
          <Icon name="upload" size={14} />
          导入
        </button>
      </div>
      {urlMsg && (
        <div className="list__hint" data-testid="import-url-status">
          {urlMsg}
        </div>
      )}

      {/* 分组区 / 文献列表分栏：上块高度可拖拽，下块吃掉剩余空间 */}
      <div className="sidebar__split" data-testid="sidebar-split" ref={splitRef}>
        <div
          className="sidebar__split-pane sidebar__split-pane--groups"
          data-testid="group-pane"
          data-height={groupPaneHeightNow}
          style={groupPaneStyle(groupPaneHeightNow, splitAvailable)}
        >
      {/* 分组栏：常驻分组树（可展开/收起、可拖拽调整层级与顺序） */}
      <div className="sidebar__groups group-tree" data-testid="group-bar">
        <div className="group-tree__head" ref={groupHeadRef}>
          <Icon name="folder" size={13} />
          <span className="group-tree__title">分组</span>
          <span className="group-tree__current" title={currentGroupLabel}>
            {currentGroupLabel}
          </span>
          <button
            className="icon ghost group-tree__newtoggle"
            title={groupNewOpen ? '收起新建分组' : '新建分组'}
            aria-label={groupNewOpen ? '收起新建分组' : '新建分组'}
            aria-expanded={groupNewOpen}
            data-testid="group-new-toggle"
            onClick={() => setGroupNewOpen((v) => !v)}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
        <div className="group-tree__rows" data-testid="group-tree" ref={groupRowsRef}>
          <button
            className={`group-picker__item${groupFilter === GROUP_ALL ? ' active' : ''}`}
            data-testid="group-option-all"
            onClick={() => {
              setGroupFilter(GROUP_ALL)
              setGroupMsg('')
            }}
          >
            <Icon name="library" size={13} />
            <span className="group-picker__name">全部</span>
            <span className="group-picker__count">{items.length}</span>
          </button>
          <button
            className={`group-picker__item${groupFilter === GROUP_UNGROUPED ? ' active' : ''}`}
            data-testid="group-option-ungrouped"
            onClick={() => {
              setGroupFilter(GROUP_UNGROUPED)
              setGroupMsg('')
            }}
          >
            <Icon name="file" size={13} />
            <span className="group-picker__name">未分组</span>
            <span className="group-picker__count">{ungroupedCount}</span>
          </button>
          {groupTree.map((node) => renderGroupNode(node, 0))}
        </div>
        {groupDragName && (
          <div
            className="group-picker__drop-root"
            data-testid="group-drop-root"
            title="拖到这里松手：分组回到顶层，不再是任何分组的子分组"
            onDragOver={overBlankArea}
            onDrop={dropOnBlankArea}
          >
            拖到这里松手 → 回到顶层
          </div>
        )}
        {groupNewOpen && (
          <div className="group-tree__new" ref={groupNewRef}>
            <input
              ref={groupInputRef}
              autoFocus
              className="group-new"
              placeholder={currentGroupName ? '新建子分组' : '新建分组'}
              title={
                currentGroupName
                  ? `在当前分组「${groupDisplayName(currentGroupName)}」下新建子分组`
                  : '新建顶层分组；之后导入的文献自动归入'
              }
              value={newGroup}
              data-testid="group-new-input"
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void createGroup()
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setGroupNewOpen(false)
                }
              }}
            />
            <button
              className="icon group-create"
              title="新建并切换到该分组（之后导入的文献自动归入）"
              data-testid="group-create"
              onClick={() => void createGroup()}
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
        )}
      </div>
      {groupMsg && (
        <div className="list__hint" data-testid="group-status">
          {groupMsg}
        </div>
      )}

      {currentGroupName && (
        <div className="group-info" data-testid="group-info" ref={groupInfoRef}>
          <div className="group-info__head">
            <span className="group-info__title" title={currentGroupName}>
              分组介绍
            </span>
            <button
              className="icon ghost"
              title="编辑分组介绍 / 上级分组"
              data-testid="group-edit"
              onClick={openGroupMeta}
            >
              <Icon name="edit" size={13} />
            </button>
          </div>
          {/* 阶段二：默认单行紧凑显示，点「展开」看全文（切换分组时自动收起） */}
          <div
            className={`group-info__desc${groupInfo?.description ? '' : ' muted'}${introOpen ? ' open' : ''}`}
          >
            {groupInfo?.description || '暂无分组介绍'}
          </div>
          {groupInfo?.description && groupInfo.description.length > 24 && (
            <button
              className="group-info__toggle"
              data-testid="group-intro-toggle"
              onClick={() => setIntroOpen((v) => !v)}
              title={introOpen ? '收起分组介绍' : '展开分组介绍全文'}
            >
              {introOpen ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}
        </div>

        {/* 分隔条：上下拖动改比例；双击（或聚焦后 Home）恢复默认 */}
        <div
          className="sidebar__splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整分组区与文献列表的高度"
          aria-valuemin={GROUP_PANE_MIN_HEIGHT}
          aria-valuemax={maxGroupPaneHeight(splitAvailable)}
          aria-valuenow={groupPaneHeightNow}
          title="上下拖动调整分组区与文献列表的高度；双击恢复默认"
          tabIndex={0}
          data-testid="group-splitter"
          onPointerDown={beginGroupSplitDrag}
          onPointerMove={moveGroupSplit}
          onPointerUp={endGroupSplit}
          onPointerCancel={endGroupSplit}
          onDoubleClick={resetGroupSplit}
          onKeyDown={onGroupSplitKeyDown}
        />

        <div
          className="sidebar__split-pane sidebar__split-pane--list"
          data-testid="library-pane"
        >
      <div className="sidebar__tagfilter">
        <Icon name="layers" size={13} />
        <select
          value={tagFilter}
          data-testid="tag-filter"
          title="按手动标签筛选（与当前分组叠加）"
          onChange={(e) => setTagFilter(e.target.value)}
        >
          <option value="">全部标签</option>
          {tags.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}（{t.count}）
            </option>
          ))}
        </select>
        {tagFilter && (
          <button className="icon ghost" title="清除标签筛选" onClick={() => setTagFilter('')}>
            <Icon name="close" size={12} />
          </button>
        )}
      </div>

      <div className="list">
        {active ? (
          <>
            {searchLoading && (
              <div className="state state--inline state--loading" role="status">
                <span className="spinner" aria-hidden="true" />
                <span className="state__detail">搜索中…</span>
              </div>
            )}
            {searchPhase === 'error' && searchIsCurrent && !searchLoading && (
              <div
                className="state state--inline state--error"
                role="alert"
                data-testid="search-error"
              >
                <span className="state__detail">{searchError || '搜索失败'}</span>
                <span className="state__actions">
                  <button
                    className="btn btn--ghost"
                    data-testid="search-retry"
                    title="重新搜索当前输入"
                    onClick={() => setSearchRetry((n) => n + 1)}
                  >
                    重试
                  </button>
                </span>
              </div>
            )}
            {!searchLoading &&
              searchPhase === 'success' &&
              searchIsCurrent &&
              currentHits.length === 0 && (
                <div className="state state--inline state--filtered">
                  <span className="state__detail">没有匹配结果</span>
                </div>
              )}
            {currentHits.map((h) => (
              <div
                key={`${h.kind}-${h.id}`}
                className="list__item"
                data-testid="search-hit"
                data-kind={h.kind}
                onClick={() => onOpenHit(h, query.trim())}
              >
                <div className="list__item-meta">
                  <span className="hit__badge">{KIND_LABEL[h.kind] ?? h.kind}</span>
                  <span className="hit__line">
                    <span className="hit__title" title={h.title ?? undefined}>
                      {h.title ?? ''}
                    </span>
                    {h.page != null && <span className="hit__page">{` · p.${h.page}`}</span>}
                  </span>
                </div>
                <div
                  className="list__item-title"
                  dangerouslySetInnerHTML={{ __html: escapeHtml(h.snippet) }}
                />
              </div>
            ))}
          </>
        ) : roots.length === 0 ? (
          <div
            className={`state state--empty${tagFilter || groupFilter !== GROUP_ALL ? ' state--filtered' : ''}`}
          >
            <div className="state__title">
              {tagFilter ? '当前分组下没有这个标签的文献' : '还没有文献'}
            </div>
            <div className="state__detail">
              {tagFilter
                ? '换个标签，或清除标签筛选后查看当前分组的全部文献'
                : groupFilter === GROUP_ALL
                  ? '从右上角「导入」选 PDF，或粘贴 DOI / arXiv 链接自动抓取'
                  : '该分组下暂无条目，可从其它分组移动进来'}
            </div>
          </div>
        ) : (
          roots.map((it) => renderRow(it, 0))
        )}
        {!active && hasMore && (
          <button
            className="btn btn--ghost list__more"
            data-testid="library-more"
            onClick={() => setVisibleLimit((n) => n + 200)}
          >
            加载更多（还有 {tagFiltered.length - visibleLimit} 篇）
          </button>
        )}
      </div>
        </div>
      </div>

      {groupMetaEdit && (
        <div
          className="group-move-overlay"
          data-testid="group-meta-modal"
          onMouseDown={() => setGroupMetaEdit(null)}
        >
          <div className="group-move-card" onMouseDown={(e) => e.stopPropagation()}>
            <div className="group-move-title">分组信息</div>
            <label className="group-meta-label">
              名称
              <input
                className="group-move-input"
                data-testid="group-meta-name"
                value={groupMetaEdit.leaf}
                onChange={(e) => setGroupMetaEdit({ ...groupMetaEdit, leaf: e.target.value })}
              />
            </label>
            <label className="group-meta-label">
              上级分组（留空 = 顶层）
              <input
                className="group-move-input"
                data-testid="group-meta-parent"
                list="group-move-options"
                value={groupMetaEdit.parent}
                onChange={(e) => setGroupMetaEdit({ ...groupMetaEdit, parent: e.target.value })}
              />
            </label>
            <label className="group-meta-label">
              分组介绍
              <textarea
                className="group-meta-desc"
                data-testid="group-meta-desc"
                rows={4}
                placeholder="这个分组关注什么方向、收录标准…"
                value={groupMetaEdit.description}
                onChange={(e) =>
                  setGroupMetaEdit({ ...groupMetaEdit, description: e.target.value })
                }
              />
            </label>
            <div className="group-move-hint">改名或换上级分组会同步移动该组下所有论文。</div>
            <div className="group-move-actions">
              <span className="toolbar__spacer" />
              <button className="ghost" onClick={() => setGroupMetaEdit(null)}>
                取消
              </button>
              <button
                className="primary"
                data-testid="group-meta-save"
                onClick={() => void saveGroupMeta()}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div
          className="group-move-overlay"
          data-testid="group-delete-modal"
          onMouseDown={() => setDeleteTarget(null)}
        >
          <div className="group-move-card" onMouseDown={(e) => e.stopPropagation()}>
            <div className="group-move-title">删除分组</div>
            <div className="group-move-hint" data-testid="group-delete-message">
              {`确定删除分组「${groupDisplayName(deleteTarget.name)}」？该分组下有 ${deleteTarget.items} 篇文献`}
              {deleteTarget.children > 0
                ? `，还有 ${deleteTarget.children} 个子分组，确认后连同子分组一起删除。`
                : '。'}
            </div>
            <div className="group-move-hint">
              文献本身不会被删除：会移到
              {deleteTarget.name.includes('/')
                ? `上一级分组「${groupDisplayName(
                    deleteTarget.name.split('/').slice(0, -1).join('/')
                  )}」`
                : '「未分组」'}
              ，分组行与同层顺序会一起压实。
            </div>
            <div className="group-move-actions">
              <span className="toolbar__spacer" />
              <button
                className="ghost"
                data-testid="group-delete-cancel"
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                className="primary"
                data-testid="group-delete-confirm"
                onClick={() => void confirmDeleteGroup()}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}

/** 高亮标记 « » 由 FTS snippet 生成，其余内容转义 */
// #region search-highlight
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/«/g, '<mark>')
    .replace(/»/g, '</mark>')
}
// #endregion search-highlight

/**
 * 搜索失败时要显示给用户的文字。
 * 主进程抛出的错误经过 IPC 会被包成
 * `Error invoking remote method 'search:query': Error: <真正原因>`；
 * 直接把它贴到界面上，用户看到的是传输层前缀而不是失败原因。
 */
// #region search-error-message
function readableSearchError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const detail = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
  return detail ? `搜索失败：${detail}` : '搜索失败'
}
// #endregion search-error-message
