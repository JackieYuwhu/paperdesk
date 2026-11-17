/**
 * 文库「分组」纯逻辑：名称归一化 / 按组过滤 / 分组树。
 *
 * items.group_name 保存完整路径（如 大模型/推理），library_groups 保存树结构；
 * 这里全部是零依赖纯函数，便于单元测试，也便于渲染层复用。
 */
import type { LibraryGroup } from './types'

/** 分组完整路径长度上限；单级名称另有 40 字限制（见 createGroup） */
export const GROUP_NAME_MAX = 120

/** 下拉框里「全部」与「未分组」两个虚拟选项的取值（真实组名不会以 __ 开头） */
export const GROUP_ALL = '__all__'
export const GROUP_UNGROUPED = '__none__'

export interface GroupableItem {
  group_name?: string | null
}

/**
 * 归一化用户输入的分组名：去首尾空格、折叠内部空白、截断到上限。
 * 空串 / 纯空白 / 非字符串一律视为「未分组」，返回 null。
 */
export function normalizeGroupName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX).trim()
  return s || null
}

/** 「全部」虚拟选项：不做任何过滤 */
export function isAllGroup(filter: string | null | undefined): boolean {
  return !filter || filter === GROUP_ALL
}

/**
 * 按分组过滤条目：
 *  - GROUP_ALL / 空          → 全部
 *  - GROUP_UNGROUPED         → 仅未分组
 *  - 其它                    → 仅该组
 * 保持输入顺序（调用方已按添加时间倒序）。
 */
export function filterItemsByGroup<T extends GroupableItem>(
  items: T[],
  filter: string | null | undefined
): T[] {
  if (isAllGroup(filter)) return items
  if (filter === GROUP_UNGROUPED) return items.filter((i) => normalizeGroupName(i.group_name) == null)
  const name = normalizeGroupName(filter)
  if (!name) return items
  return items.filter((i) => normalizeGroupName(i.group_name) === name)
}

/** 出现过的真实组名（去重 + 忽略空值 + 不区分大小写排序，便于下拉框稳定） */
export function distinctGroupNames(items: GroupableItem[]): string[] {
  const seen = new Map<string, string>()
  for (const it of items) {
    const name = normalizeGroupName(it.group_name)
    if (!name) continue
    const k = name.toLowerCase()
    if (!seen.has(k)) seen.set(k, name)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/** 分组下拉框选项（含「全部」「未分组」两个虚拟项；计数由调用方决定是否展示） */
export function groupSelectOptions(
  items: GroupableItem[]
): Array<{ value: string; label: string }> {
  return [
    { value: GROUP_ALL, label: '全部' },
    { value: GROUP_UNGROUPED, label: '未分组' },
    ...distinctGroupNames(items).map((name) => ({ value: name, label: name }))
  ]
}

/** 分组树节点（parent_name 来自 library_groups；旧数据按路径推断父级） */
export interface GroupTreeNode extends LibraryGroup {
  parent_name: string | null
  depth: number
  children: GroupTreeNode[]
}

/** 分组完整路径的最后一级，用于紧凑显示 */
export function groupDisplayName(name: string): string {
  const parts = String(name ?? '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** 把父路径和子分组名拼成完整路径 */
export function groupJoin(parent: string | null | undefined, leaf: string): string {
  const p = String(parent ?? '')
    .trim()
    .replace(/\/+$/, '')
  const l = String(leaf ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
  return p ? `${p}/${l}` : l
}

/** 同层排序的显示名兜底：空/纯空白名称统一别名，避免比较函数拿到空串 */
export function groupSortFallback(name: string): string {
  const leaf = groupDisplayName(name)
  return leaf || '未命名'
}

/** 同层分组排序：sort_order 优先（小者在前），都没序号时按中文名稳定排序兜底 */
export function compareGroupSiblings(
  a: { name: string; sort_order?: number | null },
  b: { name: string; sort_order?: number | null }
): number {
  const ord = (v: number | null | undefined): number | null =>
    v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null
  const sa = ord(a.sort_order)
  const sb = ord(b.sort_order)
  if (sa !== null && sb !== null && sa !== sb) return sa - sb
  if (sa !== null && sb === null) return -1
  if (sa === null && sb !== null) return 1
  const fa = groupSortFallback(a.name)
  const fb = groupSortFallback(b.name)
  if (fa !== fb) return fa.localeCompare(fb, 'zh-Hans')
  return a.name.localeCompare(b.name, 'zh-Hans')
}

/** 列表行（含同层顺序），services 与测试共用的最小形状 */
export interface GroupRow {
  name: string
  parent_name?: string | null
  description?: string | null
  date_modified?: string | null
  sort_order?: number | null
  count?: number
  path?: string | null
}

/**
 * 把一组 GroupRow 排成确定的显示顺序（列表用，树视图另见 buildGroupTree）。
 * declared parent 优先、未声明时按路径推断父级；父级缺失或成环时返回顶层兜底，
 * 末尾按名称追加未挂上的行，保证输出完整且顺序稳定。
 */
export function buildDocOrder(rows: GroupRow[]): GroupRow[] {
  type OrderNode = GroupRow & { children: OrderNode[] }
  const nodes = new Map<string, OrderNode>()
  for (const row of rows ?? []) {
    const name = String(row?.name ?? '').trim()
    if (!name || nodes.has(name)) continue
    const declared = (row.parent_name ?? '').trim()
    const segs = name.split('/')
    const derived = segs.length > 1 ? segs.slice(0, -1).join('/') : ''
    const parent = declared || derived
    nodes.set(name, { ...row, name, parent_name: parent || null, children: [] })
  }
  const isDescendantOf = (kid: string, ancestor: string): boolean => {
    let cur: string | null = kid
    while (cur && cur !== ancestor) cur = nodes.get(cur)?.parent_name ?? null
    return cur === ancestor
  }
  const attached: string[] = []
  for (const node of nodes.values()) {
    const parentName = node.parent_name
    if (!parentName || !nodes.has(parentName)) continue
    if (parentName === node.name || isDescendantOf(parentName, node.name)) continue
    nodes.get(parentName)!.children.push(node)
    attached.push(node.name)
  }
  const sortSiblings = (list: OrderNode[]): void => {
    list.sort((a, b) =>
      compareGroupSiblings(
        { name: a.name, sort_order: a.sort_order },
        { name: b.name, sort_order: b.sort_order }
      )
    )
  }
  const out: GroupRow[] = []
  const emit = (n: OrderNode): void => {
    out.push({
      name: n.name,
      parent_name: n.parent_name,
      description: n.description ?? null,
      date_modified: n.date_modified ?? null,
      sort_order: n.sort_order ?? null,
      count: n.count ?? 0,
      path: n.path ?? null
    })
    for (const c of n.children) emit(c)
  }
  const attachedSet = new Set(attached)
  const roots: OrderNode[] = []
  for (const node of nodes.values()) {
    if (!attachedSet.has(node.name)) roots.push(node)
  }
  sortSiblings(roots)
  for (const node of nodes.values()) sortSiblings(node.children)
  for (const r of roots) emit(r)
  // 环上的行没挂进树：按名称追加在末尾，保证不丢行
  const emitted = new Set(out.map((r) => r.name))
  const rest: GroupRow[] = []
  for (const node of nodes.values()) {
    if (emitted.has(node.name)) continue
    rest.push({
      name: node.name,
      parent_name: node.parent_name ?? null,
      description: node.description ?? null,
      date_modified: node.date_modified ?? null,
      sort_order: node.sort_order ?? null,
      count: node.count ?? 0,
      path: node.path ?? null
    })
  }
  if (rest.length > 0) {
    rest.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'))
    out.push(...rest)
  }
  return out
}

/** 某分组的所有祖先路径（不含自身），从顶层到直接父级 */
export function groupAncestors(name: string): string[] {
  const parts = String(name ?? '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

/**
 * 构建分组树。
 *
 * 旧版本的 group_name 允许包含 `/` 但没有 parent_name，因此这里会：
 * - 按路径补出缺失的父节点；
 * - 有显式 parent_name 的节点挂到父级（父级缺失时补一个空节点）；
 * - 环 / 自引用回退为顶层，避免 UI 递归死循环。
 */
export function buildGroupTree(groups: LibraryGroup[]): GroupTreeNode[] {
  const byName = new Map<string, GroupTreeNode>()
  const ensure = (name: string, parent: string | null, count = 0): GroupTreeNode => {
    const key = name.trim()
    let node = byName.get(key)
    if (!node) {
      node = {
        name: key,
        parent_name: parent,
        count,
        depth: 0,
        children: [],
        description: null,
        date_modified: null,
        sort_order: null
      }
      byName.set(key, node)
    } else if (count > node.count) {
      node.count = count
    }
    return node
  }

  for (const g of groups) {
    const name = String(g.name ?? '').trim()
    if (!name) continue
    const declaredParent = g.parent_name?.trim() || null
    const parent =
      declaredParent ?? (name.includes('/') ? (groupAncestors(name).slice(-1)[0] ?? null) : null)
    const node0 = ensure(name, parent, Number(g.count) || 0)
    if (g.description != null) node0.description = g.description
    if (g.date_modified != null) node0.date_modified = g.date_modified
    if (g.sort_order != null) node0.sort_order = g.sort_order
    // 补出旧库路径里缺失的父节点
    for (const ancestor of groupAncestors(name)) {
      ensure(ancestor, groupAncestors(ancestor).slice(-1)[0] ?? null)
    }
  }

  for (const node of byName.values()) {
    const parentName = node.parent_name
    if (!parentName || parentName === node.name) continue
    if (!byName.has(parentName)) ensure(parentName, null)
    // 防环：如果父节点出现在自己的祖先链里，回退为顶层
    let p = byName.get(parentName)
    let cycle = false
    const seen = new Set<string>([node.name])
    while (p) {
      if (seen.has(p.name)) {
        cycle = true
        break
      }
      seen.add(p.name)
      p = p.parent_name ? byName.get(p.parent_name) : undefined
    }
    if (cycle) {
      node.parent_name = null
      continue
    }
    byName.get(parentName)?.children.push(node)
  }

  const roots: GroupTreeNode[] = []
  const sortRec = (nodes: GroupTreeNode[], depth: number): void => {
    nodes.sort((a, b) =>
      compareGroupSiblings(
        { name: a.name, sort_order: a.sort_order },
        { name: b.name, sort_order: b.sort_order }
      )
    )
    for (const n of nodes) {
      n.depth = depth
      sortRec(n.children, depth + 1)
    }
  }
  for (const node of byName.values()) {
    if (!node.parent_name || !byName.has(node.parent_name)) roots.push(node)
  }
  sortRec(roots, 0)
  return roots
}

/** 先序展开，供下拉框使用 */
export function flattenGroupTree(nodes: GroupTreeNode[]): GroupTreeNode[] {
  const out: GroupTreeNode[] = []
  const walk = (list: GroupTreeNode[]): void => {
    for (const n of list) {
      out.push(n)
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/** 某个分组 + 全部后代分组的完整路径（批量处理按分组时使用） */
export function groupWithDescendants(groups: LibraryGroup[], root: string): string[] {
  const target = String(root ?? '').trim()
  if (!target) return []
  const tree = buildGroupTree(groups)
  const node = flattenGroupTree(tree).find((n) => n.name === target)
  if (!node) return [target]
  const out: string[] = []
  const walk = (n: GroupTreeNode): void => {
    out.push(n.name)
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

/** 分组折叠状态：仅记录用户显式点过的组；缺失的取默认规则（有子分组 = 收起，VSCode 式） */
export type GroupCollapseState = Record<string, boolean>

/** 折叠判定：false = 强制展开，true = 强制收起；未记录时默认「有子分组收起、叶子展开」 */
export function isGroupCollapsed(
  collapse: GroupCollapseState | null | undefined,
  node: Pick<GroupTreeNode, 'name' | 'children'>
): boolean {
  const flag = collapse?.[node.name]
  return flag === undefined ? node.children.length > 0 : flag
}

/**
 * 切换某分组的折叠状态：先算当前生效值，再取反记录。
 * 返回新对象，不改入参（React state 需要不可变更新）。
 */
export function toggleGroupCollapsed(
  collapse: GroupCollapseState,
  node: Pick<GroupTreeNode, 'name' | 'children'>
): GroupCollapseState {
  return { ...collapse, [node.name]: !isGroupCollapsed(collapse, node) }
}

/** 实际会渲染出来的节点（先序）：收起分组的子级不出现在结果里；纯函数供渲染与测试共用 */
export function visibleGroupNodes(
  roots: GroupTreeNode[],
  collapse: GroupCollapseState | null | undefined
): GroupTreeNode[] {
  const out: GroupTreeNode[] = []
  const walk = (list: GroupTreeNode[]): void => {
    for (const n of list) {
      out.push(n)
      if (!isGroupCollapsed(collapse, n)) walk(n.children)
    }
  }
  walk(roots)
  return out
}
