import { useCallback, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { PANELS } from '../modules/registry'

/** 左侧功能区当前展示的内容（null=收起） */
export type LeftView = 'library' | 'detail' | 'toc' | 'search' | 'panel' | null

/**
 * 多文档标签（纯界面状态 + 持久化）：
 * - 打开列表 `paperdesk.docs.open`、当前文档 `paperdesk.docs.active`；
 * - 关闭标签时激活相邻标签。
 * 注意：`activeItemId` 是「当前文档」的唯一来源，由 App 持有。
 */
export function useDocTabs(
  activeItemId: number | null,
  setActiveItemId: Dispatch<SetStateAction<number | null>>
): { openDocIds: number[]; closeDoc: (id: number) => void } {
  const [openDocIds, setOpenDocIds] = useState<number[]>(() => {
    try {
      const arr = JSON.parse(localStorage.getItem('paperdesk.docs.open') ?? '[]')
      return Array.isArray(arr)
        ? arr.filter((n) => typeof n === 'number' && Number.isInteger(n))
        : []
    } catch {
      return []
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('paperdesk.docs.open', JSON.stringify(openDocIds))
    } catch {
      /* 忽略 */
    }
  }, [openDocIds])

  useEffect(() => {
    try {
      if (activeItemId == null) localStorage.removeItem('paperdesk.docs.active')
      else localStorage.setItem('paperdesk.docs.active', String(activeItemId))
    } catch {
      /* 忽略 */
    }
  }, [activeItemId])

  // 选中的文档自动出现在标签栏（含恢复上次 / 深链 / 导入 / 从图谱加入）
  useEffect(() => {
    if (activeItemId == null) return
    setOpenDocIds((prev) => (prev.includes(activeItemId) ? prev : [...prev, activeItemId].slice(-12)))
  }, [activeItemId])

  const closeDoc = useCallback(
    (id: number): void => {
      setOpenDocIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev))
      setActiveItemId((prev) => {
        if (prev !== id) return prev
        const rest = openDocIds.filter((x) => x !== id)
        return rest[Math.min(openDocIds.indexOf(id), rest.length - 1)] ?? null
      })
    },
    [openDocIds, setActiveItemId]
  )

  return { openDocIds, closeDoc }
}

/**
 * 功能面板与左侧功能区（纯界面状态，不持久化）：
 * - 顶栏功能区（分组 + 面板按钮）决定「哪个面板」；
 * - 左侧功能区在「文件库 / 目录 / 搜索 / 某面板」间切换，同一时间只展示一种。
 */
export function usePanels(onUserAdjust?: () => void): {
  rightTab: string
  activeGroup: string
  visited: Set<string>
  leftView: LeftView
  setLeftView: Dispatch<SetStateAction<LeftView>>
  sbCollapsed: boolean
  setSbCollapsed: Dispatch<SetStateAction<boolean>>
  setActiveGroup: Dispatch<SetStateAction<string>>
  selectTab: (id: string) => void
  toggleLeft: (v: 'library' | 'toc' | 'search') => void
} {
  const [rightTab, setRightTab] = useState<string>(PANELS[0]?.id ?? 'notes')
  const [activeGroup, setActiveGroup] = useState<string>(PANELS[0]?.group ?? 'read')
  const [visited, setVisited] = useState<Set<string>>(() => new Set([PANELS[0]?.id ?? 'notes']))
  const [leftView, setLeftView] = useState<LeftView>('library')
  const [sbCollapsed, setSbCollapsed] = useState(false)

  const selectTab = useCallback((id: string): void => {
    setRightTab(id)
    const p = PANELS.find((x) => x.id === id)
    if (p) setActiveGroup(p.group)
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
    // 面板渲染在左侧功能区：切到该面板并展开左栏
    setLeftView('panel')
    setSbCollapsed(false)
  }, [])

  /** 左侧入口切换：再点当前入口则收起（收起后入口仍然可见） */
  const toggleLeft = useCallback(
    (v: 'library' | 'toc' | 'search'): void => {
      onUserAdjust?.()
      if (leftView === v && !sbCollapsed) setSbCollapsed(true)
      else {
        setLeftView(v)
        setSbCollapsed(false)
      }
    },
    [leftView, sbCollapsed, onUserAdjust]
  )

  return {
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
  }
}
