import { getDb } from '../db'
import { embedBacking, embeddingsAvailable, semanticSearchQuery, type SemanticHit } from './embed'
import { groupItemIds } from './library-groups'
import { retrievalRerankEnabled } from './settings'
import {
  buildScopeSql,
  normalizeSearchScope,
  type ScopeSource,
  type ScopeSql,
  type SearchScope,
  type SearchScopeInput
} from '../../shared/knowledge-query'
import { fuseHybrid, resolveRetrievalMode, type RetrievalModeInfo } from '../../shared/api'
import type { RetrievalMode, SearchHit } from '../../shared/types'

/** 把用户输入转成安全的 FTS5 查询（每个词加引号 + 前缀匹配，AND 连接） */
function ftsQuery(raw: string): string {
  const tokens = (raw || '')
    .split(/\s+/)
    .map((t) => t.replace(/["'()*:^-]/g, '').trim())
    .filter(Boolean)
  if (tokens.length === 0) return ''
  return tokens.map((t) => `"${t}"*`).join(' AND ')
}

interface Row {
  id: number
  itemId: number | null
  attachmentId: number | null
  pageIndex: number | null
  title: string | null
  snippet: string | null
  score: number
}

/**
 * 归一化调用方范围；分组名在这里解析成条目 id（SQL 中的 IN 仍由 buildScopeSql 参数化）。
 * 解析不出条目（空分组）得到 empty 范围，SQL 层 AND 0，不会退化成全库检索。
 */
function resolveScope(raw?: SearchScopeInput | null): SearchScope | null {
  if (!raw) return null
  const needResolve = raw.groupId != null && raw.itemIds == null
  const input: SearchScopeInput = needResolve
    ? { ...raw, itemIds: groupItemIds(raw.groupId as string) }
    : raw
  return normalizeSearchScope(input)
}

/** 各来源的范围片段；不适用（例如按笔记限定去查论文）时返回 null，整段跳过该来源 */
function sourceScope(scope: SearchScope | null, source: ScopeSource): ScopeSql | null {
  const built = buildScopeSql(scope, source)
  return built.applicable ? built : null
}

function searchInSources(raw: string, limit: number, scope: SearchScope | null): SearchHit[] {
  const q = ftsQuery(raw)
  if (!q) return []
  const db = getDb()
  const hits: SearchHit[] = []

  // 论文条目
  const itemsScope = sourceScope(scope, 'items')
  if (itemsScope) {
    try {
      const rows = db
        .prepare(
          `SELECT i.id AS id, i.id AS itemId, NULL AS attachmentId, NULL AS pageIndex,
                  i.title AS title,
                  snippet(items_fts, -1, '«', '»', '…', 12) AS snippet,
                  bm25(items_fts) AS score
           FROM items_fts JOIN items i ON i.id = items_fts.rowid
           WHERE items_fts MATCH ?${itemsScope.sql} ORDER BY score LIMIT ?`
        )
        .all(q, ...itemsScope.params, limit) as Row[]
      for (const r of rows) {
        hits.push({
          kind: 'item',
          id: r.id,
          itemId: r.itemId,
          attachmentId: null,
          page: null,
          title: r.title,
          snippet: r.snippet ?? '',
          score: -r.score
        })
      }
    } catch {
      /* 查询语法问题则跳过该来源 */
    }
  }

  // 全文分块
  const chunksScope = sourceScope(scope, 'chunks')
  if (chunksScope) {
    try {
      const rows = db
        .prepare(
          `SELECT c.id AS id, a.item_id AS itemId, c.attachment_id AS attachmentId,
                  c.page_index AS pageIndex, i.title AS title,
                  snippet(chunks_fts, -1, '«', '»', '…', 14) AS snippet,
                  bm25(chunks_fts) AS score
           FROM chunks_fts
           JOIN chunks c ON c.id = chunks_fts.rowid
           JOIN attachments a ON a.id = c.attachment_id
           LEFT JOIN items i ON i.id = a.item_id
           WHERE chunks_fts MATCH ?${chunksScope.sql} ORDER BY score LIMIT ?`
        )
        .all(q, ...chunksScope.params, limit) as Row[]
      for (const r of rows) {
        hits.push({
          kind: 'chunk',
          id: r.id,
          itemId: r.itemId,
          attachmentId: r.attachmentId,
          page: (r.pageIndex ?? 0) + 1,
          title: r.title,
          snippet: r.snippet ?? '',
          score: -r.score
        })
      }
    } catch {
      /* ignore */
    }
  }

  // 笔记
  const notesScope = sourceScope(scope, 'notes')
  if (notesScope) {
    try {
      const rows = db
        .prepare(
          `SELECT n.id AS id, n.item_id AS itemId, NULL AS attachmentId, NULL AS pageIndex,
                  n.title AS title,
                  snippet(notes_fts, -1, '«', '»', '…', 12) AS snippet,
                  bm25(notes_fts) AS score
           FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
           WHERE notes_fts MATCH ?${notesScope.sql} ORDER BY score LIMIT ?`
        )
        .all(q, ...notesScope.params, limit) as Row[]
      for (const r of rows) {
        hits.push({
          kind: 'note',
          id: r.id,
          itemId: r.itemId,
          attachmentId: null,
          page: null,
          title: r.title,
          snippet: r.snippet ?? '',
          score: -r.score
        })
      }
    } catch {
      /* ignore */
    }
  }

  // 译文（skills 产出的 Markdown 全文）
  const translationsScope = sourceScope(scope, 'translations')
  if (translationsScope) {
    try {
      const rows = db
        .prepare(
          `SELECT t.id AS id, a.item_id AS itemId, t.attachment_id AS attachmentId, t.lang AS lang,
                  snippet(translations_fts, -1, '«', '»', '…', 14) AS snippet,
                  bm25(translations_fts) AS score
           FROM translations_fts JOIN translations t ON t.id = translations_fts.rowid
           LEFT JOIN attachments a ON a.id = t.attachment_id
           WHERE translations_fts MATCH ?${translationsScope.sql} ORDER BY score LIMIT ?`
        )
        .all(q, ...translationsScope.params, limit) as Array<Row & { lang: string }>
      for (const r of rows) {
        hits.push({
          kind: 'translation',
          id: r.id,
          itemId: r.itemId,
          attachmentId: r.attachmentId,
          page: null,
          title: `译文（${r.lang}）`,
          snippet: r.snippet ?? '',
          score: -r.score,
          translationLang: r.lang
        })
      }
    } catch {
      /* ignore */
    }
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

/**
 * 词法检索（FTS5/bm25）。
 * scope 可选：限定论文/附件/分组/笔记时，条件以参数化 SQL 进入各来源 WHERE，
 * 即「先范围、后排序、再 LIMIT」，不会先取 limit 条再过滤。
 */
export function search(raw: string, limit = 20, scopeInput?: SearchScopeInput | null): SearchHit[] {
  return searchInSources(raw, limit, resolveScope(scopeInput))
}

/** 由 chunk id 组装一条 SearchHit；给了范围时在 SQL 层复核（语义命中同样受范围约束） */
function chunkHit(
  chunkId: number,
  score: number,
  snippetText?: string,
  scope?: SearchScope | null
): SearchHit | null {
  const chunkScope = sourceScope(scope ?? null, 'chunks')
  if (!chunkScope) return null
  const row = getDb()
    .prepare(
      `SELECT c.id AS id, c.page_index AS pageIndex, c.text AS text,
              c.attachment_id AS attachmentId, a.item_id AS itemId, i.title AS title
       FROM chunks c
       JOIN attachments a ON a.id = c.attachment_id
       LEFT JOIN items i ON i.id = a.item_id
       WHERE c.id = ?${chunkScope.sql}`
    )
    .get(chunkId, ...chunkScope.params) as
    | {
        id: number
        pageIndex: number | null
        text: string
        attachmentId: number
        itemId: number | null
        title: string | null
      }
    | undefined
  if (!row) return null
  return {
    kind: 'chunk',
    id: row.id,
    itemId: row.itemId,
    attachmentId: row.attachmentId,
    page: (row.pageIndex ?? 0) + 1,
    title: row.title,
    snippet: snippetText ?? `${row.text.replace(/\s+/g, ' ').slice(0, 160)}…`,
    score
  }
}

export interface HybridOptions {
  mode?: RetrievalMode
  limit?: number
  /** 兼容旧调用：等价于 scope.attachmentId */
  attachmentId?: number | null
  /** 检索范围；attachmentId 与 scope 同时给时按「且」合并 */
  scope?: SearchScopeInput | null
  /**
   * 语义重排开关（PD42）：不传时读设置 retrieval.rerank（默认关闭）。
   * 只有后端是真语义向量时才可能生效；哈希后端始终降级为词法。
   */
  rerank?: boolean
}

/** 检索结果（PD42）：mode 是实际生效模式，retrieval 说明后端/降级原因 */
export interface HybridResult {
  hits: SearchHit[]
  mode: RetrievalMode
  retrieval: RetrievalModeInfo
}

/** 合并 attachmentId 与 scope：两者都要满足，故合成一个范围对象 */
function scopeFromOptions(opts: HybridOptions): SearchScopeInput | null {
  const scope = opts.scope ?? null
  if (scope) {
    if (opts.attachmentId != null && scope.attachmentId == null) {
      return { ...scope, attachmentId: opts.attachmentId }
    }
    return scope
  }
  return opts.attachmentId != null ? { attachmentId: opts.attachmentId } : null
}

/**
 * 混合检索：词法（FTS5/bm25）+ 语义（向量余弦）用 RRF 融合。
 *
 * PD42 硬规则：只有真语义向量后端（openai）才可能参与排序；none / mock(local-hash-64)
 * 一律标 lexical，哈希相似度不进 RRF——否则哈希分会被当成语义分，排序与纯词法不一致。
 * 语义重排是可选开关且默认关闭；打开但后端为哈希时降级为词法并在 retrieval 里写原因。
 * 范围在词法与语义两侧都进 SQL。
 */
export async function searchHybrid(
  query: string,
  opts: HybridOptions = {}
): Promise<HybridResult> {
  const limit = opts.limit ?? 20
  const requested = opts.mode ?? 'hybrid'
  const scopeInput = scopeFromOptions(opts)
  const scope = resolveScope(scopeInput)

  const backing = embedBacking()
  const rerank = opts.rerank ?? retrievalRerankEnabled()
  const hasIndex = embeddingsAvailable()
  const info = resolveRetrievalMode(requested, backing, { rerank, hasIndex })
  const lexical = searchInSources(query, limit * 2, scope)

  // 词法模式：完全不碰向量（哈希后端下这是唯一路径）
  if (info.mode === 'lexical') {
    return { hits: lexical.slice(0, limit), mode: 'lexical', retrieval: info }
  }

  const chunksScope = sourceScope(scope, 'chunks')
  // 窄范围（单篇/单附件/分组）下候选被范围过滤，候选池要放大，否则语义命中不够 limit 条
  const narrow = scope !== null && !scope.empty
  const semLimit = narrow ? Math.min(Math.max(limit * 8, 40), 400) : limit * 2
  let sem: SemanticHit[] = []
  if (chunksScope) {
    try {
      sem = await semanticSearchQuery(query, semLimit, scope?.attachmentId ?? null)
    } catch {
      sem = []
    }
  }
  // 索引为空（或查询向量化失败）：回退词法，且不谎称成功做过语义
  if (sem.length === 0) {
    return {
      hits: lexical.slice(0, limit),
      mode: 'lexical',
      retrieval: {
        ...info,
        mode: 'lexical',
        degraded: true,
        reason: info.degraded
          ? info.reason
          : '没有可用的向量命中，已回退为词法检索'
      }
    }
  }

  if (info.mode === 'semantic') {
    const hits = sem
      .map((s) => chunkHit(s.chunkId, s.score, undefined, scope))
      .filter((h): h is SearchHit => !!h)
      .slice(0, limit)
    if (hits.length === 0) {
      return {
        hits: lexical.slice(0, limit),
        mode: 'lexical',
        retrieval: {
          ...info,
          mode: 'lexical',
          degraded: true,
          reason: '语义命中都在检索范围之外，已回退为词法检索'
        }
      }
    }
    return { hits, mode: 'semantic', retrieval: info }
  }

  // RRF 融合：eligible 由后端起决定，哈希后端永远不会走到这里
  const hits = fuseHybrid<SearchHit>(lexical, sem, {
    eligible: info.semantic,
    limit,
    materialize: (chunkId, score) => chunkHit(chunkId, score, undefined, scope)
  })
  return { hits, mode: 'hybrid', retrieval: info }
}
