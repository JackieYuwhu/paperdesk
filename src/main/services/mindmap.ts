import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { getDataDir, getDb } from '../db'
import { generateStrict } from './llm'
import { searchHybrid } from './search'
import {
  MINDMAP_MAX_PASSAGES,
  MINDMAP_PASSAGE_MAX_CHARS,
  MindmapAiError,
  contextFromDoc,
  describeMindmapAiError,
  mapOutlineFromDoc
} from '../../shared/mindmap-ai'
import type {
  MindmapExpansionResult,
  MindmapMapOptimizeResult,
  MindmapOptimizeResult,
  MindmapPassage,
  MindmapPromptContext,
  MindmapSummaryResult,
  MindmapSupportResult
} from '../../shared/mindmap-ai'
import type { MindMapDoc, MindmapSyncResult, SearchHit } from '../../shared/types'
import {
  createMindMapDoc,
  digestPointsFromMarkdown
} from '../../shared/api'
import { applySkeletonToMindMap } from '../../shared/mindmap-skeleton'
import { generateItemSkeleton } from './mindmap-skeleton'
import { runExpandTool, runMapOptimizeTool, runOptimizeTool, runSupportTool, runSummarizeTool } from './mindmap-ai-tools'

/**
 * 思维地图存储：data/mindmap/<items.key>.json
 *
 * 刻意不进数据库：地图是纯展示数据，按文献 key 存 JSON 即可，
 * 既避免 schema 迁移，也让删除文献后的孤儿文件不影响其他条目。
 */
export function mindmapDir(): string {
  const dir = join(getDataDir(), 'mindmap')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 文献 key（items.key）；条目不存在时返回 null，避免写出无主地图 */
export function mindmapKeyForItem(itemId: number): string | null {
  const row = getDb().prepare('SELECT key FROM items WHERE id = ?').get(itemId) as
    | { key: string | null }
    | undefined
  const key = typeof row?.key === 'string' ? row.key.trim() : ''
  return key || null
}

export function mindmapPathForKey(key: string): string {
  return join(mindmapDir(), `${key}.json`)
}

function looksLikeDoc(raw: unknown): raw is MindMapDoc {
  if (!raw || typeof raw !== 'object') return false
  const d = raw as Partial<MindMapDoc>
  return d.version === 1 && typeof d.rootId === 'string' && Array.isArray(d.nodes)
}

/** 读取地图；没有文件、JSON 损坏或结构明显不对时返回 null，由渲染层新建空白地图 */
export function loadMindMap(itemId: number): MindMapDoc | null {
  const key = mindmapKeyForItem(itemId)
  if (!key) return null
  try {
    const raw: unknown = JSON.parse(readFileSync(mindmapPathForKey(key), 'utf8'))
    return looksLikeDoc(raw) ? raw : null
  } catch {
    return null
  }
}

/** 覆盖保存整份地图；updatedAt 由主进程统一写入 */
export function saveMindMap(itemId: number, doc: MindMapDoc): MindMapDoc {
  const key = mindmapKeyForItem(itemId)
  if (!key) throw new Error('文献不存在，无法保存思维地图')
  const next: MindMapDoc = { ...doc, itemId, updatedAt: new Date().toISOString() }
  writeFileSync(mindmapPathForKey(key), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/** 拆解同步的内容指纹：忽略行尾空白与 BOM，同一份内容重复同步命中同一 syncId */
export function digestSyncId(markdown: string): string {
  const normalized = String(markdown ?? '')
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .trim()
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32)
}

/**
 * 把一篇论文的拆解 markdown 覆盖式同步进它自己的思维地图（PD55）：
 * - 先按拆解材料生成三层骨架（AI 严格 JSON，失败回退规则骨架）；
 * - 覆盖上一次同步写入且未被用户改过的节点，用户节点/改过名的节点永不删除；
 * - 同一份内容重复同步直接返回 added=0/removed=0（不重复调用 AI）；
 * - 只有地图真的变化才写盘，避免无意义的 updatedAt 变化。
 */
export async function syncDigestToItemMindMap(
  itemId: number,
  title: string | null | undefined,
  markdown: string,
  batchId?: string | null
): Promise<MindmapSyncResult> {
  const source = String(markdown ?? '')
  const points = digestPointsFromMarkdown(source)
  const syncId = digestSyncId(source)
  const existing = loadMindMap(itemId)

  // 幂等：同一份内容、且上次写入的节点都还在 → 不调 AI、不写盘
  if (
    existing?.sync &&
    existing.sync.syncId === syncId &&
    existing.sync.nodeIds.length > 0 &&
    existing.sync.nodeIds.every((id) => existing.nodes.some((node) => node.id === id))
  ) {
    return {
      itemId,
      points: points.length,
      added: 0,
      removed: 0,
      kept: 0,
      mode: existing.sync.mode ?? 'rule',
      syncId,
      warnings: []
    }
  }

  if (points.length === 0 && !source.trim()) {
    return {
      itemId,
      points: 0,
      added: 0,
      removed: 0,
      kept: 0,
      mode: 'rule',
      syncId,
      warnings: ['拆解内容为空，思维地图未改动']
    }
  }

  const base = existing ?? createMindMapDoc(itemId, title)
  let skeleton
  try {
    skeleton = await generateItemSkeleton(itemId, {
      markdown: source,
      title: title ?? undefined,
      points: points.map((point) => ({ title: point.title, body: point.body }))
    })
  } catch (error) {
    // generateItemSkeleton 已内部兜底；这里只防御性兜底一次，保证不把异常抛给批处理
    return {
      itemId,
      points: points.length,
      added: 0,
      removed: 0,
      kept: 0,
      mode: 'rule',
      syncId,
      warnings: [`生成骨架失败（${describeMindmapAiError(error)}），思维地图未改动`]
    }
  }

  const applied = applySkeletonToMindMap(base, skeleton.nodes, {
    syncId,
    batchId: batchId ?? null,
    mode: skeleton.mode
  })
  const changed = applied.added > 0 || applied.removed > 0
  if (changed) saveMindMap(itemId, applied.doc)
  return {
    itemId,
    points: points.length,
    added: applied.added,
    removed: applied.removed,
    kept: applied.kept,
    mode: skeleton.mode,
    syncId,
    warnings: skeleton.warnings
  }
}

/* ------------------------------------------------------------------ */
/* 节点级 AI：摘要 / 展开子节点 / 找支撑段落                            */
/* 复用 settings 里已有的 provider 配置（llmConfig），不新增密钥、不硬编码模型 */
/* ------------------------------------------------------------------ */

interface ChunkRow {
  id: number
  text: string | null
  pageIndex: number | null
  bbox?: string | null
  moduleId?: string | null
}

function itemTitle(itemId: number): string {
  const row = getDb().prepare('SELECT title FROM items WHERE id = ?').get(itemId) as
    | { title: string | null }
    | undefined
  const title = typeof row?.title === 'string' ? row.title.trim() : ''
  return title || '未命名文献'
}

function toPassage(row: ChunkRow): MindmapPassage | null {
  const raw = typeof row.text === 'string' ? row.text : ''
  if (!raw.trim()) return null
  return {
    page: (row.pageIndex ?? 0) + 1,
    text: raw.replace(/\s+/gu, ' ').trim().slice(0, MINDMAP_PASSAGE_MAX_CHARS),
    // 锚点偏移必须落在原文上：chunkText 保留未折叠/未截断的正文
    chunkText: raw,
    chunkId: row.id,
    bbox: row.bbox ?? null,
    moduleId: row.moduleId ?? null
  }
}

/** 从检索命中里挑出「本文」的正文块，并回库取完整文本（命中只带片段） */
function passagesFromHits(itemId: number, hits: SearchHit[]): MindmapPassage[] {
  const ids: number[] = []
  for (const hit of hits) {
    if (hit.kind !== 'chunk' || hit.itemId !== itemId) continue
    if (!ids.includes(hit.id)) ids.push(hit.id)
    if (ids.length >= MINDMAP_MAX_PASSAGES) break
  }
  if (ids.length === 0) return []
  const marks = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT c.id AS id, c.text AS text, c.page_index AS pageIndex,
              c.bbox AS bbox, c.module_id AS moduleId
         FROM chunks c WHERE c.id IN (${marks})`
    )
    .all(...ids) as ChunkRow[]
  const byId = new Map(rows.map((row) => [row.id, row]))
  const out: MindmapPassage[] = []
  for (const id of ids) {
    const row = byId.get(id)
    const passage = row ? toPassage(row) : null
    if (passage) out.push(passage)
  }
  return out
}

/** 关键词（含中文长句）转 LIKE 词表：过长的 CJK 串取首尾片段，避免整句匹配不上 */
function likeKeywords(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? []
  const words: string[] = []
  for (const token of tokens) {
    if (token.length < 2) continue
    const value = token.length > 8 ? token.slice(0, 4) : token
    if (!words.includes(value)) words.push(value)
    if (token.length > 8) {
      const tail = token.slice(-4)
      if (!words.includes(tail)) words.push(tail)
    }
    if (words.length >= 4) break
  }
  return words
}

/** FTS 没命中时的兜底：按关键词扫本文正文块（没有 FTS 索引也能找到支撑段落） */
function likePassages(itemId: number, query: string): MindmapPassage[] {
  const words = likeKeywords(query)
  if (words.length === 0) return []
  const where = words.map(() => 'c.text LIKE ?').join(' OR ')
  const rows = getDb()
    .prepare(
      `SELECT c.id AS id, c.text AS text, c.page_index AS pageIndex,
              c.bbox AS bbox, c.module_id AS moduleId
         FROM chunks c JOIN attachments a ON a.id = c.attachment_id
        WHERE a.item_id = ? AND (${where})
        ORDER BY c.page_index, c.id LIMIT ?`
    )
    .all(itemId, ...words.map((word) => `%${word}%`), MINDMAP_MAX_PASSAGES) as ChunkRow[]
  return rows.map(toPassage).filter((passage): passage is MindmapPassage => !!passage)
}

/** 最后的兜底：本文最靠前的正文块（让「找支撑」至少有可核对的材料，绝不编造） */
function headPassages(itemId: number): MindmapPassage[] {
  const rows = getDb()
    .prepare(
      `SELECT c.id AS id, c.text AS text, c.page_index AS pageIndex,
              c.bbox AS bbox, c.module_id AS moduleId
         FROM chunks c JOIN attachments a ON a.id = c.attachment_id
        WHERE a.item_id = ?
        ORDER BY c.page_index, c.id LIMIT ?`
    )
    .all(itemId, MINDMAP_MAX_PASSAGES) as ChunkRow[]
  return rows.map(toPassage).filter((passage): passage is MindmapPassage => !!passage)
}

/** 取该文献可用于提示词的原文片段：混合检索 → LIKE 兜底 → 正文首块 */
async function passagesForItem(itemId: number, query: string): Promise<MindmapPassage[]> {
  let hits: SearchHit[] = []
  try {
    const result = await searchHybrid(query, { limit: MINDMAP_MAX_PASSAGES * 3 })
    hits = result.hits
  } catch {
    hits = []
  }
  const fromHits = passagesFromHits(itemId, hits)
  if (fromHits.length > 0) return fromHits
  const fromLike = likePassages(itemId, query)
  if (fromLike.length > 0) return fromLike
  return headPassages(itemId)
}

/** 组装提示词上下文：论文标题 + 祖先路径 + 已有子节点 + 本文原文片段 */
export async function buildMindMapContext(
  itemId: number,
  doc: MindMapDoc,
  nodeId: string
): Promise<MindmapPromptContext> {
  const target = doc.nodes.find((node) => node.id === nodeId)
  if (!target) throw new MindmapAiError('bad-response', '节点不存在，请先在思维地图里选中一个节点')
  const children = doc.nodes.filter((node) => node.parentId === nodeId).map((node) => node.text)
  const query = [target.text, ...children].filter(Boolean).join(' ').slice(0, 200)
  const passages = await passagesForItem(itemId, query || itemTitle(itemId))
  return contextFromDoc(doc, nodeId, itemTitle(itemId), passages)
}

/** 注入给 shared/mindmap-ai 的严格补全：未配置 / 失败都抛可读错误，没有 mock 兜底 */
async function completeForMindmap(system: string, user: string): Promise<string> {
  const { text } = await generateStrict({ system, user, session: 'mindmap', temperature: 0.2 })
  return text
}

async function contextForNode(itemId: number, nodeId: string): Promise<MindmapPromptContext> {
  const doc = loadMindMap(itemId)
  if (!doc) {
    throw new MindmapAiError(
      'bad-response',
      '这篇文献的思维地图还没保存过：请先新建/重命名一个节点，再使用 AI'
    )
  }
  return buildMindMapContext(itemId, doc, nodeId)
}

/** AI 摘要：结果由渲染层写进节点，不在此处落盘 */
export async function summarizeNode(
  itemId: number,
  nodeId: string
): Promise<MindmapSummaryResult> {
  const ctx = await contextForNode(itemId, nodeId)
  return runSummarizeTool({ ctx }, completeForMindmap)
}

/** AI 展开 2–4 个子节点：只返回文本，写图与撤销都在渲染层（整份 JSON 保存） */
export async function expandNode(
  itemId: number,
  nodeId: string
): Promise<MindmapExpansionResult> {
  const ctx = await contextForNode(itemId, nodeId)
  return runExpandTool({ ctx }, completeForMindmap)
}

/** AI 优化：把选中节点的现有子节点整理成 2–6 个分组；结果由渲染层写入并整份撤销 */
export async function optimizeNode(itemId: number, nodeId: string): Promise<MindmapOptimizeResult> {
  const ctx = await contextForNode(itemId, nodeId)
  return runOptimizeTool({ ctx }, completeForMindmap)
}

/**
 * 整图优化（PD58）：把整张地图的大纲交给模型重新分组，不需要先选中节点。
 * 只返回分组结果，写图/预览/撤销都在渲染层（保证不产生假结果）。
 */
export async function optimizeMap(itemId: number): Promise<MindmapMapOptimizeResult> {
  const doc = loadMindMap(itemId)
  if (!doc) {
    throw new MindmapAiError(
      'bad-response',
      '这张地图还没有内容：先「从论文结构生成骨架」或手动建几个节点，再用 AI 优化'
    )
  }
  const outline = mapOutlineFromDoc(doc)
  if (!outline.trim()) {
    throw new MindmapAiError(
      'bad-response',
      '这张地图还没有内容：先「从论文结构生成骨架」或手动建几个节点，再用 AI 优化'
    )
  }
  const query = outline.replace(/^[\s-]+/gmu, ' ').slice(0, 200) || itemTitle(itemId)
  const passages = await passagesForItem(itemId, query)
  return runMapOptimizeTool(
    { map: { paperTitle: itemTitle(itemId), outline, passages } },
    completeForMindmap
  )
}

/**
 * AI 从本文找支撑段落：引文核对不上时 found:false。
 * 命中时返回点锚点（chunk 正文字符区间 + bbox/module 透传），供节点保存后再次定位。
 */
export async function findSupport(
  itemId: number,
  nodeId: string
): Promise<MindmapSupportResult> {
  const ctx = await contextForNode(itemId, nodeId)
  if (ctx.passages.filter((passage) => (passage.text ?? '').trim()).length === 0) {
    return {
      found: false,
      page: null,
      quote: '',
      reason: '未找到：这篇文献还没有可用的原文片段（可能尚未解析正文）',
      anchor: null
    }
  }
  return runSupportTool({ ctx }, completeForMindmap)
}
