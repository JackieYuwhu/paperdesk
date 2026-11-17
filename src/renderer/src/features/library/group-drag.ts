/**
 * 文库分组树拖拽（类 Windows 资源管理器）的落点解析。
 *
 * 全部是零依赖纯函数：LibraryList 用它把一次 dragOver 换算成
 * 「成为子分组 / 插到同层某条目前后 / 回到顶层 / 非法落点」，
 * scripts/test-coords.ts 直接单测同一份逻辑（不在测试里复制一份实现）。
 *
 * 分组的「父子关系」由完整路径表达（`父/子`），同时 library_groups.parent_name
 * 是权威父级；这里的判断统一按路径前缀，避免 parent_name 缺失时漏判后代成环。
 */

/** 落点类型：成为子分组 / 插到某条目前 / 插到某条目后 / 回到顶层 */
export type GroupDropMode = 'child' | 'before' | 'after' | 'root'

/** 显示顺序里的一行（先序展开；index 是它在同层里的序号，0 起） */
export interface GroupDragRow {
  name: string
  parent_name: string | null
  index: number
  depth: number
}

/** 树节点最小形状：shared/library-groups.ts 的 buildGroupTree 结果天然满足 */
export interface GroupDragNode {
  name: string
  parent_name?: string | null
  children?: GroupDragNode[]
}

/**
 * 一次拖动落点：
 *  - targetName 为空 / 未命中任何分组行 → 空白区（回到顶层）
 *  - edgeRatio 是「指针在目标行高度上的比例」（0=最上沿，1=最下沿）；
 *    只有最外侧 1/4 才算插到前后，中间算成为子分组。
 */
export interface GroupDropPoint {
  targetName?: string | null
  edgeRatio?: number | null
}

/** 解析结果：直接喂给 window.api.library.updateGroup(name, { parent, position }) */
export interface GroupDropPlan {
  mode: GroupDropMode
  /** 目标父级（child=被拖到的那一层；before/after=目标行的父级；root=null 顶层） */
  parent: string | null
  /** 同层插入位次（1 起，只对 before/after 有意义；child/root 为 null = 追加到末尾） */
  position: number | null
  /** child/before/after 的目标分组行；root 为 null */
  targetName: string | null
}

/** 行的上/下边缘判定带：落在行高的最外侧 1/4 才算「插到前后」 */
export const GROUP_DROP_EDGE = 0.25

const trimPath = (value: unknown): string => String(value ?? '').trim()

const parentKey = (value: unknown): string => trimPath(value)

/**
 * 把分组树先序展开成显示顺序的行（空名节点跳过，同层 index 只数有效行）。
 * 传入 buildGroupTree 的结果即可；parent_name 缺失时按路径推断，保证同层归组正确。
 */
export function flattenGroupDragRows(
  nodes: GroupDragNode[] | null | undefined,
  depth = 0
): GroupDragRow[] {
  const out: GroupDragRow[] = []
  const walk = (list: GroupDragNode[] | null | undefined, d: number): void => {
    let index = 0
    for (const node of list ?? []) {
      const name = trimPath(node?.name)
      if (!name) continue
      const declared = trimPath(node?.parent_name)
      const derived = name.includes('/') ? name.split('/').slice(0, -1).join('/') : ''
      out.push({
        name,
        parent_name: declared || derived || null,
        index,
        depth: d
      })
      index++
      walk(node?.children, d + 1)
    }
  }
  walk(nodes, depth)
  return out
}

/** candidate 是否就是 ancestor 本身或它的后代（按路径前缀判断） */
export function isSameOrDescendantGroup(candidate: unknown, ancestor: unknown): boolean {
  const name = trimPath(candidate)
  const root = trimPath(ancestor)
  if (!name || !root) return false
  return name === root || name.startsWith(`${root}/`)
}

/** 能否把 drag 放到 target 上（拖到自己或自己的后代上 = 非法，会成环） */
export function canDropGroupOn(dragName: unknown, targetName: unknown): boolean {
  const drag = trimPath(dragName)
  const target = trimPath(targetName)
  if (!drag || !target) return false
  return !isSameOrDescendantGroup(target, drag)
}

/**
 * 解析拖拽落点。
 *
 * 返回 null 表示非法（源是自己或自己的后代）——调用方应显示禁止光标且不落库；
 * 返回 { mode: 'root' } 表示落在空白区，移动回顶层。
 */
export function resolveGroupDrop(
  dragName: unknown,
  rows: GroupDragRow[] | null | undefined,
  point: GroupDropPoint | null | undefined
): GroupDropPlan | null {
  const drag = trimPath(dragName)
  if (!drag) return null
  const targetName = trimPath(point?.targetName)
  const list = Array.isArray(rows) ? rows : []
  const toRoot = (): GroupDropPlan => ({
    mode: 'root',
    parent: null,
    position: null,
    targetName: null
  })
  // 空白区（或目标行不在当前显示顺序里）→ 回到顶层
  if (!targetName) return toRoot()
  const target = list.find((row) => row.name === targetName)
  if (!target) return toRoot()
  // 拖到自己身上 / 自己的后代上：任何父级都会成环
  if (!canDropGroupOn(drag, targetName)) return null

  const raw = Number(point?.edgeRatio)
  const ratio = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5
  const targetParent = parentKey(target.parent_name) || null

  if (ratio < GROUP_DROP_EDGE || ratio > 1 - GROUP_DROP_EDGE) {
    // 插到同层前后：父级必须是合法落点（不能是自己或后代）
    if (targetParent && isSameOrDescendantGroup(targetParent, drag)) return null
    // 位次要按「抽走源之后」的同层顺序算：源可能原本就在这一层
    const siblings = list.filter(
      (row) => parentKey(row.parent_name) === parentKey(targetParent) && row.name !== drag
    )
    const idx = siblings.findIndex((row) => row.name === targetName)
    if (idx < 0) return toRoot()
    const mode: GroupDropMode = ratio < GROUP_DROP_EDGE ? 'before' : 'after'
    return {
      mode,
      parent: targetParent,
      position: idx + 1 + (mode === 'after' ? 1 : 0),
      targetName
    }
  }
  return { mode: 'child', parent: targetName, position: null, targetName }
}
