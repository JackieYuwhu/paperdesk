import { getDb } from '../db'
import {
  buildCoAuthorGraph,
  buildCoCitationGraph,
  buildCouplingGraph,
  buildKeywordGraph,
  topSubgraph,
  type BiblioGraph,
  type BiblioKind
} from '../../shared/biblio'

/** 读取本地文库，构建作者合著 / 关键词共现 / 文献耦合 / 共被引网络（默认仅保留权重最高的 limit 个节点） */
export function getBiblioGraph(kind: BiblioKind, limit = 60): BiblioGraph {
  const db = getDb()
  const lim = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 60

  if (kind === 'keywords') {
    const rows = db
      .prepare(
        `SELECT it.item_id AS item_id, t.id AS tag_id, t.name AS name
         FROM item_tags it JOIN tags t ON t.id = it.tag_id`
      )
      .all() as Array<{ item_id: number; tag_id: number; name: string }>
    const graph = buildKeywordGraph(
      rows.map((r) => ({ itemId: r.item_id, tagId: r.tag_id, name: r.name }))
    )
    return topSubgraph(graph, lim)
  }

  if (kind === 'coupling') {
    const rows = db
      .prepare(
        `SELECT c.source_item_id AS itemId, i.title AS itemTitle,
                COALESCE('w'||c.target_work_id, lower(trim(c.target_raw))) AS refKey
         FROM citations c JOIN items i ON i.id = c.source_item_id
         WHERE COALESCE(c.target_work_id IS NOT NULL, trim(c.target_raw) <> '')`
      )
      .all() as Array<{ itemId: number; itemTitle: string; refKey: string }>
    const graph = buildCouplingGraph(
      rows.map((r) => ({ itemId: r.itemId, itemTitle: r.itemTitle, refKey: r.refKey }))
    )
    return topSubgraph(graph, lim)
  }

  if (kind === 'cocitation') {
    const rows = db
      .prepare(
        `SELECT c.source_item_id AS itemId,
                COALESCE('w'||c.target_work_id, lower(trim(c.target_raw))) AS refKey,
                COALESCE(w.title, c.target_raw) AS refLabel
         FROM citations c LEFT JOIN works w ON w.id = c.target_work_id`
      )
      .all() as Array<{ itemId: number; refKey: string; refLabel: string }>
    const graph = buildCoCitationGraph(
      rows.map((r) => ({ itemId: r.itemId, refKey: r.refKey, refLabel: r.refLabel }))
    )
    return topSubgraph(graph, lim)
  }

  const rows = db
    .prepare(
      `SELECT ia.item_id AS item_id, a.id AS author_id, a.display_name AS name
       FROM item_authors ia JOIN authors a ON a.id = ia.author_id`
    )
    .all() as Array<{ item_id: number; author_id: number; name: string }>
  const graph = buildCoAuthorGraph(
    rows.map((r) => ({ itemId: r.item_id, authorId: r.author_id, name: r.name }))
  )
  return topSubgraph(graph, lim)
}
