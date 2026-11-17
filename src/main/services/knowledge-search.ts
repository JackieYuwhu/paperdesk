/**
 * 知识库检索（知识库阶段 2）：范围条件先进 SQL，再打分排序，最后 LIMIT。
 *
 * 本阶段是纯词法检索：标题/正文 LIKE（ESCAPE 转义通配符），标题命中权重高于正文。
 * 条目/关系的 FTS（cjk 分词 + bm25 rank）属 PD42，届时只替换这里的 match/score 片段。
 *
 * 只读：不写提案、不写条目、不改状态；正式条目由提案审核发布流程产生。
 */
import type { KnowledgeDb } from './knowledge'
import type { KnowledgeSearchHit, SearchScopeInput } from '../../shared/knowledge-query'
// Node 原生执行 .ts 需要显式扩展名（scripts/test-unit.ts 直接 import 本模块做 node:sqlite 单测）；
// 打包侧（vite/esbuild）同样能解析 .ts，故保留扩展名并压掉这里的 TS5097。
// @ts-expect-error TS5097 需要 allowImportingTsExtensions，但改 tsconfig 不在本任务范围
import { buildLikeMatch, buildScopeSql, normalizeSearchScope } from '../../shared/knowledge-query.ts'

export type { KnowledgeSearchHit }

export interface KnowledgeSearchOptions {
  /** 限定论文/附件/分组（分组需先解析成 itemIds，见 groupScopeFromPaperIds） */
  scope?: SearchScopeInput | null
  /** 返回条数，默认 20，上限 100 */
  limit?: number
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

interface KnowledgeRow {
  id: number
  key: string
  kind: string
  title: string
  body: string
  contentNature: string
  sourceType: string
  itemId: number | null
  attachmentId: number | null
  updatedAt: string
  score: number
}

function clampLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(raw), MAX_LIMIT)
}

/** 命中位置附近取一段摘要；找不到关键词就退化成开头截断 */
function makeSnippet(body: string, terms: string[], max = 160): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const lower = flat.toLowerCase()
  let at = -1
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase())
    if (idx >= 0 && (at < 0 || idx < at)) at = idx
  }
  if (at < 0) return flat.length > max ? `${flat.slice(0, max)}…` : flat
  const start = Math.max(0, at - 40)
  const piece = flat.slice(start, start + max)
  return `${start > 0 ? '…' : ''}${piece}${start + max < flat.length ? '…' : ''}`
}

/**
 * 知识库词法检索：state='active' + 标题/正文 LIKE + 范围片段，全部进 WHERE 后排序再 LIMIT。
 * 空查询返回 []（不访问数据库）；非法范围抛可读错误（normalizeSearchScope）。
 */
export function searchKnowledge(
  db: KnowledgeDb,
  raw: unknown,
  opts: KnowledgeSearchOptions = {}
): KnowledgeSearchHit[] {
  const like = buildLikeMatch(raw)
  if (!like.ok) return []

  const scope = normalizeSearchScope(opts.scope ?? null)
  const scoped = buildScopeSql(scope, 'knowledge')
  if (!scoped.applicable) return []

  const limit = clampLimit(opts.limit)
  const sql =
    `SELECT e.id AS id, e.key AS key, e.kind AS kind, e.title AS title, e.body AS body,
            e.content_nature AS contentNature, e.source_type AS sourceType,
            e.item_id AS itemId, e.attachment_id AS attachmentId,
            e.updated_at AS updatedAt,
            (${like.score}) AS score
       FROM knowledge_entries e
      WHERE e.state = 'active'${like.where}${scoped.sql}
      ORDER BY score DESC, updatedAt DESC, e.id DESC
      LIMIT ?`
  // 参数顺序严格按 SQL 文本出现顺序：SELECT 打分 → WHERE LIKE → 范围 → LIMIT
  const params: unknown[] = [
    ...like.scoreParams,
    ...like.whereParams,
    ...scoped.params,
    limit
  ]

  const rows = db.prepare(sql).all(...params) as KnowledgeRow[]
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    kind: row.kind,
    title: row.title,
    snippet: makeSnippet(row.body, like.terms),
    score: row.score,
    contentNature: row.contentNature,
    sourceType: row.sourceType,
    itemId: row.itemId,
    attachmentId: row.attachmentId,
    updatedAt: row.updatedAt
  }))
}
