import { getDb } from '../db'
import {
  buildDocOrder,
  groupAncestors,
  groupDisplayName,
  groupJoin,
  groupWithDescendants,
  normalizeGroupName
} from '../../shared/library-groups'
import type { LibraryGroup } from '../../shared/types'
import type { DeleteGroupResult } from '../../shared/api'

const nowIso = (): string => new Date().toISOString()

/** 完整分组路径：去空段、保留 `/`，空串视为未分组 */
export function normalizeGroupPath(raw: unknown): string | null {
  const n = normalizeGroupName(raw)
  if (!n) return null
  const path = n
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/')
  return path || null
}

/** 排序维护使用的最小数据库接口（better-sqlite3 与测试替身都满足） */
interface DbRef {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
}

/** 同层下一个 sort_order（还没排过序时为 1） */
function nextSiblingOrder(db: DbRef, parent: string | null): number {
  const stmt = db.prepare(
    parent
      ? 'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM library_groups WHERE parent_name = ?'
      : 'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM library_groups WHERE parent_name IS NULL'
  )
  const row = stmt.get(...(parent ? [parent] : [])) as
    | { next_order?: number | string | null }
    | undefined
  const n = Number(row?.next_order ?? 1)
  return Number.isFinite(n) ? n : 1
}

function ensureAncestors(path: string): void {
  const db = getDb()
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO library_groups (name, parent_name, date_created, date_modified, sort_order) VALUES (?, ?, ?, ?, ?)'
  )
  for (const ancestor of groupAncestors(path)) {
    const parent = groupAncestors(ancestor).slice(-1)[0] ?? null
    const ts = nowIso()
    stmt.run(ancestor, parent, ts, ts, nextSiblingOrder(db, parent))
  }
}

/** 确保一个分组路径存在；用于导入时直接写入目标分组 */
export function ensureGroupPath(raw: unknown): string | null {
  const path = normalizeGroupPath(raw)
  if (!path) return null
  ensureAncestors(path)
  const parent = groupAncestors(path).slice(-1)[0] ?? null
  const ts = nowIso()
  const db = getDb()
  db.prepare(
    'INSERT OR IGNORE INTO library_groups (name, parent_name, date_created, date_modified, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(path, parent, ts, ts, nextSiblingOrder(db, parent))
  return path
}

/**
 * 新建分组（可指定父分组）。
 * 单级名称不允许 `/`；父路径不存在时会自动补出中间层。
 */
export function createLibraryGroup(leafRaw: string, parentRaw?: string | null): LibraryGroup {
  const leaf = normalizeGroupName(leafRaw)
  if (!leaf) throw new Error('分组名不能为空')
  if (leaf.includes('/')) throw new Error('分组名不能包含 /，请在上层分组下新建子分组')
  if (leaf.length > 40) throw new Error('分组名最多 40 个字')

  const parent = normalizeGroupPath(parentRaw)
  if (parent) ensureGroupPath(parent)
  const full = groupJoin(parent, leaf)
  const db = getDb()
  const ts = nowIso()
  db.prepare(
    'INSERT OR IGNORE INTO library_groups (name, parent_name, date_created, date_modified, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(full, parent, ts, ts, nextSiblingOrder(db, parent))
  const row = db
    .prepare(
      `SELECT g.name AS name, g.parent_name AS parent_name, g.description,
              g.date_modified, g.sort_order AS sort_order,
              (SELECT COUNT(*) FROM items i WHERE i.group_name = g.name) AS count
         FROM library_groups g WHERE g.name = ?`
    )
    .get(full) as LibraryGroup | undefined
  return row ?? { name: full, parent_name: parent, count: 0 }
}

/**
 * 全部分组（含空分组）。旧数据只有 items.group_name 时也并入结果，
 * parent_name 为 NULL，由 buildGroupTree 按路径推断父子关系。
 */
export function listLibraryGroups(): LibraryGroup[] {
  const rows = getDb()
    .prepare(
      `SELECT g.name AS name, g.parent_name AS parent_name, g.description,
              g.date_modified, g.sort_order AS sort_order,
              (SELECT COUNT(*) FROM items i WHERE i.group_name = g.name) AS count
         FROM library_groups g
        UNION ALL
       SELECT i.group_name AS name, NULL AS parent_name, NULL AS description,
              NULL AS date_modified, NULL AS sort_order, COUNT(*) AS count
         FROM items i
        WHERE i.group_name IS NOT NULL AND trim(i.group_name) <> ''
          AND NOT EXISTS (SELECT 1 FROM library_groups g WHERE g.name = i.group_name)
        GROUP BY i.group_name
        ORDER BY name COLLATE NOCASE`
    )
    .all() as LibraryGroup[]

  // 旧版只有 items.group_name='A/B' 时没有 A 这一行；补出祖先，
  // 否则按父组过滤/批量时看不到子组里的论文。
  const byName = new Set(rows.map((r) => r.name))
  for (const row of [...rows]) {
    for (const ancestor of groupAncestors(row.name)) {
      if (byName.has(ancestor)) continue
      byName.add(ancestor)
      rows.push({
        name: ancestor,
        parent_name: groupAncestors(ancestor).slice(-1)[0] ?? null,
        count: 0
      })
    }
  }
  // 旧库只有 items.group_name、没有 library_groups 行时，列表能显示但
  // getGroup/updateGroup 会报「分组不存在」。读列表时顺手补齐为真实分组，
  // 让存量分组也能改介绍/改名/移动。
  const persisted = new Set(
    (getDb().prepare('SELECT name FROM library_groups').all() as Array<{ name: string }>).map(
      (r) => r.name
    )
  )
  for (const row of rows) {
    if (!persisted.has(row.name)) ensureGroupPath(row.name)
  }
  // 最终显示顺序交给 buildDocOrder：declared parent 优先、同层 sort_order 优先、
  // 名称兜底、层级展开；顺序稳定可重复（旧库由 BACKFILLS 给出初始序号）
  return buildDocOrder(rows) as LibraryGroup[]
}

/** 某个分组（含全部子分组）下的条目 id；按添加时间倒序 */
export function groupItemIds(root: string): number[] {
  const path = normalizeGroupPath(root)
  if (!path) return []
  const names = groupWithDescendants(listLibraryGroups(), path)
  if (names.length === 0) return []
  const marks = names.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT id FROM items
        WHERE group_name IN (${marks})
        ORDER BY date_added DESC, id DESC`
    )
    .all(...names) as Array<{ id: number }>
  return rows.map((r) => r.id)
}

/** 分组问答用的论文条目：标题 + 摘要 + 首个附件 */
export interface GroupPaperRow {
  itemId: number
  title: string
  abstract: string | null
  attachmentId: number | null
}

/**
 * 某个分组（含全部子分组）下用于 AI 问答的论文清单；按添加时间倒序。
 * 摘要/附件可能为空——上下文构建会退化成只用标题。
 */
export function groupPapers(root: string): GroupPaperRow[] {
  const path = normalizeGroupPath(root)
  if (!path) return []
  const names = groupWithDescendants(listLibraryGroups(), path)
  if (names.length === 0) return []
  const marks = names.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT i.id AS itemId, i.title AS title, i.abstract AS abstract,
              (SELECT a.id FROM attachments a WHERE a.item_id = i.id ORDER BY a.id LIMIT 1) AS attachmentId
         FROM items i
        WHERE i.group_name IN (${marks})
        ORDER BY i.date_added DESC, i.id DESC`
    )
    .all(...names) as Array<{
    itemId: number
    title: string | null
    abstract: string | null
    attachmentId: number | null
  }>
  return rows.map((r) => ({
    itemId: Number(r.itemId),
    title: r.title ?? '',
    abstract: r.abstract ?? null,
    attachmentId: r.attachmentId == null ? null : Number(r.attachmentId)
  }))
}

/** 单个分组（含介绍/计数）；不存在返回 null */
export function getLibraryGroup(raw: unknown): LibraryGroup | null {
  const path = normalizeGroupPath(raw)
  if (!path) return null
  const row = getDb()
    .prepare(
      `SELECT g.name AS name, g.parent_name AS parent_name, g.description,
              g.date_modified, g.sort_order AS sort_order,
              (SELECT COUNT(*) FROM items i WHERE i.group_name = g.name) AS count
         FROM library_groups g WHERE g.name = ?`
    )
    .get(path) as LibraryGroup | undefined
  return row ?? null
}

const NO_ORDER_LAST = 999999999

/**
 * 重排某一层并写出连续的 1..n。
 * headName 从原位抽出：有 position（>=1）插到第 N 位（越界夹取），否则放到末尾；
 * 未给 headName 时只压实现有顺序（移动后清理原层用）。
 */
function reorderLayer(
  db: DbRef,
  parent: string | null,
  opts: { headName?: string; position?: number | null } = {}
): void {
  const sql = parent
    ? `SELECT name FROM library_groups WHERE parent_name = ?
        ORDER BY COALESCE(sort_order, ${NO_ORDER_LAST}) ASC, name COLLATE NOCASE ASC`
    : `SELECT name FROM library_groups WHERE parent_name IS NULL
        ORDER BY COALESCE(sort_order, ${NO_ORDER_LAST}) ASC, name COLLATE NOCASE ASC`
  const rows = db.prepare(sql).all(...(parent ? [parent] : [])) as Array<{ name: string }>
  let names = rows.map((r) => String(r.name))
  const head = opts.headName
  if (head !== undefined) {
    names = names.filter((n) => n !== head)
    const requested = Number(opts.position)
    const idx =
      opts.position != null && Number.isFinite(requested)
        ? Math.max(0, Math.min(names.length, Math.floor(requested) - 1))
        : names.length
    names.splice(idx, 0, head)
  }
  const update = db.prepare('UPDATE library_groups SET sort_order = ? WHERE name = ?')
  names.forEach((name, i) => update.run(i + 1, name))
}

export interface GroupPatch {
  /** 新叶名（不含父路径）；undefined = 不改名 */
  leaf?: string
  /** 新父路径；null = 移到顶层；undefined = 保持原父级 */
  parent?: string | null
  description?: string | null
  /** 目标同层第 N 位（1 起，越界夹取）；只在移动/重排时生效，未指定位次时移动到层末尾 */
  position?: number | null
}

/**
 * 编辑分组：改名/移动父级时会同步所有后代路径和 items.group_name。
 * 不允许把分组移动到自己的后代下（会成环）。
 */
export function updateLibraryGroup(raw: unknown, patch: GroupPatch): LibraryGroup {
  const oldPath = normalizeGroupPath(raw)
  if (!oldPath) throw new Error('分组不存在')
  const db = getDb()
  const row = db.prepare('SELECT * FROM library_groups WHERE name = ?').get(oldPath) as
    | { name: string; parent_name: string | null; description: string | null }
    | undefined
  if (!row) throw new Error('分组不存在')

  const oldLeaf = groupDisplayName(oldPath)
  const leaf = patch.leaf === undefined ? oldLeaf : normalizeGroupName(patch.leaf)
  if (!leaf) throw new Error('分组名不能为空')
  if (leaf.includes('/')) throw new Error('分组名不能包含 /')
  if (leaf.length > 40) throw new Error('分组名最多 40 个字')
  const parent =
    patch.parent === undefined ? normalizeGroupPath(row.parent_name) : normalizeGroupPath(patch.parent)
  const next = groupJoin(parent, leaf)
  if (!next) throw new Error('分组名不能为空')
  // 显式把 parent 设为自身：哪怕叶名不变也视为非法移动（会指向自己的路径）
  if (patch.parent !== undefined && parent === oldPath) {
    throw new Error('不能把分组移动到它自己或它的后代下')
  }
  if (next !== oldPath && (next === oldPath || next.startsWith(`${oldPath}/`))) {
    throw new Error('不能把分组移动到自己的子分组下')
  }

  const oldParent = normalizeGroupPath(row.parent_name)
  const ts = nowIso()
  const tx = db.transaction((): void => {
    const moving = next !== oldPath
    if (moving) {
      const clash = db.prepare('SELECT 1 AS ok FROM library_groups WHERE name = ?').get(next)
      if (clash) throw new Error('目标分组已存在')
      // 先改后代（长路径优先），再改自己；items 同步路径前缀
      db.prepare(
        `UPDATE library_groups
            SET name = ? || substr(name, ?),
                parent_name = CASE WHEN parent_name = ? THEN ? ELSE ? || substr(parent_name, ?) END
          WHERE name LIKE ? AND name <> ?`
      ).run(
        next,
        oldPath.length + 1,
        oldPath,
        next,
        next,
        oldPath.length + 1,
        `${oldPath}/%`,
        oldPath
      )
      db.prepare('UPDATE library_groups SET name = ?, parent_name = ? WHERE name = ?').run(
        next,
        parent,
        oldPath
      )
      db.prepare(
        'UPDATE items SET group_name = ? || substr(group_name, ?) WHERE group_name LIKE ?'
      ).run(next, oldPath.length + 1, `${oldPath}/%`)
      db.prepare('UPDATE items SET group_name = ? WHERE group_name = ?').run(next, oldPath)
      ensureGroupPath(parent)
    }
    if (patch.description !== undefined) {
      db.prepare(
        'UPDATE library_groups SET description = ?, date_modified = ? WHERE name = ?'
      ).run(patch.description?.trim() || null, ts, next)
    } else {
      db.prepare('UPDATE library_groups SET date_modified = ? WHERE name = ?').run(ts, next)
    }
    // 排序维护：跨层移动 → 新层按位次/末尾插入 + 原层压实；同层改名或重排 → 按位次插入
    if (moving && parent !== oldParent) {
      reorderLayer(db, parent, { headName: next, position: patch.position ?? null })
      reorderLayer(db, oldParent, {})
    } else if (moving && patch.position != null && Number.isFinite(Number(patch.position))) {
      reorderLayer(db, parent, { headName: next, position: patch.position })
    } else if (!moving && patch.position != null && Number.isFinite(Number(patch.position))) {
      reorderLayer(db, parent, { headName: oldPath, position: patch.position })
    }
  })
  tx()
  return getLibraryGroup(next) ?? { name: next, parent_name: parent, count: 0 }
}

/** 分组是否还有后代分组（删除/移动时提示用） */
export function groupHasChildren(name: string): boolean {
  const path = normalizeGroupPath(name)
  if (!path) return false
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM library_groups WHERE parent_name = ? LIMIT 1')
    .get(path) as { ok?: number } | undefined
  return !!row?.ok
}

export interface DeleteGroupOptions {
  /** 默认拒绝删除带子分组的分组；true 时连同整棵子树一起删除 */
  withDescendants?: boolean
}

/**
 * 删除分组。
 *
 * - 叶子分组：组内文献并入父分组（无父 = 未分组），删除分组行后把同层
 *   sort_order 压实为连续 1..n。
 * - 带子分组：默认抛错拒绝，只有显式 `{ withDescendants: true }` 才整棵删除；
 *   子树内文献统一并入被删根分组的父级（无父 = 未分组），绝不连带删文献。
 */
export function deleteLibraryGroup(
  raw: unknown,
  options: DeleteGroupOptions = {}
): DeleteGroupResult {
  const path = normalizeGroupPath(raw)
  if (!path) throw new Error('分组不存在')
  const db = getDb()
  const row = db
    .prepare('SELECT name, parent_name FROM library_groups WHERE name = ?')
    .get(path) as { name: string; parent_name: string | null } | undefined
  if (!row) throw new Error('分组不存在')

  const declaredParent = normalizeGroupPath(row.parent_name)
  // 防御坏数据：父级指向自己或后代时按顶层处理，避免把文献移到刚删掉的路径下
  const parent =
    declaredParent && declaredParent !== path && !declaredParent.startsWith(`${path}/`)
      ? declaredParent
      : null

  const childRows = db
    .prepare('SELECT name FROM library_groups WHERE parent_name = ?')
    .all(path) as Array<{ name: string }>
  if (childRows.length > 0 && options?.withDescendants !== true) {
    throw new Error(
      `分组「${path}」下还有 ${childRows.length} 个子分组，请确认是否一并删除`
    )
  }

  const allNames = (db.prepare('SELECT name FROM library_groups').all() as Array<{ name: string }>)
    .map((r) => String(r.name))
  const removed = allNames.filter((name) => name === path || name.startsWith(`${path}/`))
  if (!removed.includes(path)) removed.unshift(path)

  // 子树内所有文献（含旧库只有 items.group_name、没有分组行的路径）
  const prefix = `${path}/`
  const itemWhere = 'group_name = ? OR substr(group_name, 1, ?) = ?'
  const countRow = db
    .prepare(`SELECT COUNT(*) AS c FROM items WHERE ${itemWhere}`)
    .get(path, prefix.length, prefix) as { c?: number | string } | undefined
  const movedItems = Number(countRow?.c ?? 0)
  const ts = nowIso()

  const tx = db.transaction((): void => {
    db.prepare(`UPDATE items SET group_name = ?, date_modified = ? WHERE ${itemWhere}`).run(
      parent,
      ts,
      path,
      prefix.length,
      prefix
    )
    const del = db.prepare('DELETE FROM library_groups WHERE name = ?')
    for (const name of removed) del.run(name)
    // 同层顺序压实：删掉一行后不留空号
    reorderLayer(db, parent, {})
  })
  tx()

  // 旧数据里父级可能还没有 library_groups 行；补出来，避免文献落到幽灵分组
  if (parent && !getLibraryGroup(parent)) ensureGroupPath(parent)

  return {
    name: path,
    parent_name: parent,
    removed,
    movedTo: parent,
    movedItems: Number.isFinite(movedItems) ? movedItems : 0
  }
}

export { groupDisplayName }
