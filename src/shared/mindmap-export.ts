/**
 * 思维地图导出（Markdown 缩进大纲 / Mermaid graph TD）纯模块。
 *
 * 设计约束：
 * - 不 import electron / db / React，只依赖类型，供主进程 IPC 与 `scripts/test-unit.ts`
 *   的 strip-types 直接导入共用（`services/mindmap.ts` 依赖 better-sqlite3，不能放进单测）；
 * - 层级与顺序只认 `rootId` 起的 DFS 前序、子节点按 `doc.nodes` 数组先后，与画布渲染一致；
 * - 只做序列化，不读写磁盘、不改地图、不写 data 目录：落到哪个文件由用户在选择框里决定。
 */
import type { MindMapDoc, MindMapNode } from './types'
// @ts-expect-error TS5097：测试用 `node scripts/test-unit.ts` 直接加载本文件，Node ESM 需要显式扩展名
import { stripMarkdownForMap } from './mindmap-ai.ts'

export type MindmapExportFormat = 'markdown' | 'mermaid'

/** 空地图 / 只有根节点时的统一提示（IPC 与渲染层共用，避免两处漂移） */
export const MINDMAP_EXPORT_EMPTY =
  '地图里只有根节点，没有可导出的内容：请先新增至少一个子节点再导出'

export interface MindmapOrderedNode {
  node: MindMapNode
  depth: number
}

/** 导出格式对应的文件扩展名（不含点） */
export function mindmapExportExtension(format: MindmapExportFormat): string {
  return format === 'mermaid' ? 'mmd' : 'md'
}

/**
 * 节点文本收敛成单行：先按地图渲染同一规则去掉 Markdown，再把换行/连续空白折成一个空格。
 * 保证导出的 Markdown / Mermaid 与画布上看到的文字一致（PD57）。
 */
function oneLine(text: string): string {
  return stripMarkdownForMap(text).replace(/\s+/gu, ' ').trim()
}

/**
 * 地图是否值得导出：至少根节点 + 一个子节点。
 * 正常地图里除根之外的节点都挂在根下（IPC 校验会拒绝孤立节点），所以长度 > 1 即可。
 */
export function hasExportableContent(doc: MindMapDoc | null | undefined): boolean {
  if (!doc || !Array.isArray(doc.nodes) || doc.nodes.length === 0) return false
  if (typeof doc.rootId !== 'string' || !doc.rootId.trim()) return false
  return doc.nodes.length > 1
}

/** 从根节点做 DFS 前序；子节点保持 `doc.nodes` 里的先后顺序，靠 visited 防环 */
export function orderMindmapNodes(doc: MindMapDoc): MindmapOrderedNode[] {
  const root = doc.nodes.find((node) => node.id === doc.rootId)
  if (!root) return []
  const byParent = new Map<string, MindMapNode[]>()
  for (const node of doc.nodes) {
    if (node.parentId == null) continue
    const list = byParent.get(node.parentId)
    if (list) list.push(node)
    else byParent.set(node.parentId, [node])
  }

  const out: MindmapOrderedNode[] = []
  const visited = new Set<string>()
  const stack: MindmapOrderedNode[] = [{ node: root, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    if (visited.has(current.node.id)) continue
    visited.add(current.node.id)
    out.push(current)
    const kids = byParent.get(current.node.id) ?? []
    // 逆序压栈，保证第一个子节点先出栈（前序 = 与画布/大纲阅读顺序一致）
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      stack.push({ node: kids[i], depth: current.depth + 1 })
    }
  }
  return out
}

/**
 * Markdown 缩进大纲：每层 2 空格，行首 `- `，行尾换行；不加标题行。
 * 只有根节点时返回空串（调用方据此提示，不产生空文件）。
 */
export function toMarkdownOutline(doc: MindMapDoc): string {
  const ordered = orderMindmapNodes(doc)
  if (ordered.length <= 1) return ''
  const lines = ordered.map(({ node, depth }) => `${'  '.repeat(depth)}- ${oneLine(node.text)}`)
  return `${lines.join('\n')}\n`
}

/**
 * Mermaid 标签转义：顺序敏感（先 `#` 再实体，避免自己生成的 `#` 被二次转义）。
 * 括号在部分 Mermaid 版本里会截断标签，因此一并转成实体；斜杠、连字符、冒号保留。
 */
export function escapeMermaidLabel(text: string): string {
  return oneLine(text)
    .replace(/#/gu, '#35;')
    .replace(/"/gu, '#quot;')
    .replace(/\[/gu, '#91;')
    .replace(/\]/gu, '#93;')
    .replace(/\(/gu, '#40;')
    .replace(/\)/gu, '#41;')
    .replace(/\{/gu, '#123;')
    .replace(/\}/gu, '#125;')
}

/**
 * Mermaid 图：首行 `graph TD`，节点用 DFS 序 id（mm0/mm1/...）而不是用户 id，避免注入；
 * 边按「父 --> 子」。只有根节点时返回空串。
 */
export function toMermaid(doc: MindMapDoc): string {
  const ordered = orderMindmapNodes(doc)
  if (ordered.length <= 1) return ''
  const ids = new Map<string, string>()
  ordered.forEach(({ node }, index) => ids.set(node.id, `mm${index}`))

  const lines = ['graph TD']
  for (const { node } of ordered) {
    lines.push(`  ${ids.get(node.id)}["${escapeMermaidLabel(node.text)}"]`)
  }
  for (const { node } of ordered) {
    if (node.parentId == null) continue
    const parent = ids.get(node.parentId)
    const self = ids.get(node.id)
    if (parent && self) lines.push(`  ${parent} --> ${self}`)
  }
  return `${lines.join('\n')}\n`
}

/** 按指定格式序列化；空图返回空串（调用方负责提示，不写空文件） */
export function serializeMindmapExport(doc: MindMapDoc, format: MindmapExportFormat): string {
  return format === 'mermaid' ? toMermaid(doc) : toMarkdownOutline(doc)
}

/**
 * 保存框默认文件名：根节点文本清洗成 Windows 合法文件名，扩展名按格式给 md/mmd。
 * 根文本为空时退回 `mindmap`。
 */
export function exportFileBaseName(
  rootText: string | null | undefined,
  format: MindmapExportFormat
): string {
  const ext = mindmapExportExtension(format)
  const safe = oneLine(typeof rootText === 'string' ? rootText : '')
    .replace(/[\\/:*?"<>|]/gu, '_')
    .slice(0, 80)
    // 截断后可能又落在空格/点上：Windows 文件名不允许尾随空格与点
    .replace(/[. ]+$/gu, '')
    .trim()
  return `${safe || 'mindmap'}.${ext}`
}
