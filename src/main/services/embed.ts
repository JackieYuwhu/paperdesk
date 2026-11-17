import { getDb } from '../db'
import { ensureSidecar } from '../sidecar/manager'
import { embedConfig, modelHeaders, openCodeEndpointHint, sessionFor } from './settings'
import type { RetrievalBacking } from '../../shared/api'

export interface SemanticHit {
  chunkId: number
  score: number
}

interface EmbedResult {
  backend: string
  model: string
  dim: number
  vectors: number[][]
}

/** 调 sidecar 生成向量（设置 > 环境变量 > 默认 mock） */
export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) return { backend: 'none', model: 'none', dim: 0, vectors: [] }
  const cfg = embedConfig()
  if (cfg.backend === 'openai') {
    const hint = openCodeEndpointHint(cfg.baseUrl, cfg.model)
    if (hint) throw new Error(hint)
  }
  const base = await ensureSidecar()
  const res = await fetch(`${base}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      texts,
      backend: cfg.backend,
      baseUrl: cfg.baseUrl || undefined,
      apiKey: cfg.apiKey,
      model: cfg.model || undefined,
      headers: modelHeaders(cfg.baseUrl, sessionFor.embed())
    })
  })
  if (!res.ok) throw new Error(`向量化失败: ${res.status}`)
  return (await res.json()) as EmbedResult
}

const toBlob = (v: number[]): Buffer => Buffer.from(new Float32Array(v).buffer)
const fromBlob = (b: Buffer): Float32Array =>
  new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)

/** 为某附件的所有分块建立（或重建）向量索引 */
export async function indexAttachment(
  attachmentId: number
): Promise<{ indexed: number; model: string }> {
  const db = getDb()
  const chunks = db
    .prepare('SELECT id, text FROM chunks WHERE attachment_id = ? ORDER BY id')
    .all(attachmentId) as Array<{ id: number; text: string }>
  if (chunks.length === 0) return { indexed: 0, model: 'none' }

  const BATCH = 32
  let model = ''
  const rows: Array<{ id: number; vec: number[] }> = []
  for (let i = 0; i < chunks.length; i += BATCH) {
    const part = chunks.slice(i, i + BATCH)
    const out = await embedTexts(part.map((c) => c.text))
    if (out.backend === 'none') return { indexed: 0, model: 'none' }
    model = out.model
    part.forEach((c, j) => rows.push({ id: c.id, vec: out.vectors[j] ?? [] }))
  }

  const ts = new Date().toISOString()
  const tx = db.transaction(() => {
    const ins = db.prepare(
      `INSERT INTO chunk_embeddings (chunk_id, model, dim, vector, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET model=excluded.model, dim=excluded.dim,
         vector=excluded.vector, created_at=excluded.created_at`
    )
    for (const r of rows) {
      if (r.vec.length === 0) continue
      ins.run(r.id, model, r.vec.length, toBlob(r.vec), ts)
    }
  })
  tx()
  return { indexed: rows.length, model }
}

export function embeddingsAvailable(): boolean {
  const row = getDb()
    .prepare('SELECT count(*) AS c FROM chunk_embeddings')
    .get() as { c: number }
  return (row?.c ?? 0) > 0
}

/**
 * 当前检索真正用到的嵌入后端（PD42）。
 * `embeddingsAvailable()` 只看有没有行，local-hash-64 也算有索引；
 * 因此模式徽标与 RRF 资格必须看 backend/model，而不是行数。
 * model 优先取索引里实际写入的模型：配置换成真模型但索引仍是旧哈希时，不能谎称语义。
 */
export function embedBacking(): RetrievalBacking {
  const cfg = embedConfig()
  if (cfg.backend === 'none') return { backend: 'none', model: 'none', semantic: false }
  const row = getDb()
    .prepare(
      `SELECT model FROM chunk_embeddings GROUP BY model ORDER BY count(*) DESC LIMIT 1`
    )
    .get() as { model: string } | undefined
  const indexed = (row?.model ?? '').trim()
  const model = indexed || cfg.model || 'none'
  // 只有服务端真向量模型才算语义；mock/local-hash-64 是哈希相似度，永远不是语义
  const semantic = cfg.backend === 'openai' && model !== 'local-hash-64'
  return { backend: cfg.backend, model, semantic }
}

/** 语义检索：对查询向量与库中所有分块向量做余弦相似度 */
export function semanticSearch(
  queryVec: number[],
  limit: number,
  attachmentId?: number | null
): SemanticHit[] {
  const db = getDb()
  const rows = (
    attachmentId != null
      ? db
          .prepare(
            `SELECT e.chunk_id AS chunkId, e.vector AS vector FROM chunk_embeddings e
             JOIN chunks c ON c.id = e.chunk_id WHERE c.attachment_id = ?`
          )
          .all(attachmentId)
      : db.prepare('SELECT chunk_id AS chunkId, vector FROM chunk_embeddings').all()
  ) as Array<{ chunkId: number; vector: Buffer }>

  const q = new Float32Array(queryVec)
  const qn = Math.hypot(...q) || 1
  const scored: SemanticHit[] = []
  for (const r of rows) {
    const v = fromBlob(r.vector)
    if (v.length !== q.length) continue
    let dot = 0
    for (let i = 0; i < v.length; i++) dot += v[i] * q[i]
    const vn = Math.hypot(...v) || 1
    scored.push({ chunkId: r.chunkId, score: dot / (qn * vn) })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** 便捷：文本查询 -> 向量 -> 语义检索 */
export async function semanticSearchQuery(
  query: string,
  limit: number,
  attachmentId?: number | null
): Promise<SemanticHit[]> {
  if (!embeddingsAvailable()) return []
  const out = await embedTexts([query])
  const vec = out.vectors[0]
  if (!vec || vec.length === 0) return []
  return semanticSearch(vec, limit, attachmentId)
}
