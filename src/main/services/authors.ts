import { getDb } from '../db'
import { resolveStoragePath } from './storage'
import { llmConfig, modelHeaders, sessionFor } from './settings'
import { ensureSidecar } from '../sidecar/manager'
import { oaGet, shortId, stripDoi } from './discovery'
import type {
  AuthorCleanupResult,
  AuthorProfile,
  AuthorSummary,
  AuthorWork,
  ImportAuthorsResult,
  Item,
  LinkAuthorInput,
  LinkAuthorResult
} from '../../shared/types'

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 仅查**本地库**的作者名（不联网、不调模型）——用于文库列表展示「主要作者」。
 */
export function authorsForItemLocal(itemId: number): string[] {
  const db = getDb()
  const rows = db
    .prepare(
      'SELECT a.display_name AS n FROM item_authors ia JOIN authors a ON a.id = ia.author_id WHERE ia.item_id = ? ORDER BY ia.position, a.id'
    )
    .all(itemId) as Array<{ n: string | null }>
  return rows.map((r) => r.n ?? '').filter(Boolean)
}

/**
 * 批量版：一次 SQL 取回多个条目的本地作者名（itemId → 作者名数组）。
 *
 * 文库列表原先对可见条目逐条 `authors.forItemLocal(id)`，80 个条目就是 80 次 IPC，
 * 打开文库时明显卡顿；这里合并成一次查询。仍**只读本地库**，不联网、不调模型。
 */
export function authorsForItemsLocal(itemIds: number[]): Record<number, string[]> {
  const ids = [...new Set((itemIds ?? []).filter((id) => Number.isInteger(id) && id > 0))].slice(
    0,
    500
  )
  const out: Record<number, string[]> = {}
  if (ids.length === 0) return out
  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT ia.item_id AS item_id, a.display_name AS n
         FROM item_authors ia
         JOIN authors a ON a.id = ia.author_id
        WHERE ia.item_id IN (${placeholders})
        ORDER BY ia.item_id, ia.position, a.id`
    )
    .all(...ids) as Array<{ item_id: number; n: string | null }>
  for (const r of rows) {
    const name = r.n ?? ''
    if (!name) continue
    const arr = out[r.item_id] ?? (out[r.item_id] = [])
    arr.push(name)
  }
  return out
}

/**
 * 取某条目的作者名（用于作者面板初始填充）：
 * 1) OpenAlex（按 DOI，其次标题）——外部/AI 搜索结果优先，不依赖本地库；
 * 2) 若仍为空且有 PDF 且已配置模型 → 视觉识别首页得到作者；
 * 3) 最后才用本地 item_authors 兜底。
 */
export async function authorsForItem(itemId: number): Promise<{ names: string[]; warnings: string[] }> {
  const db = getDb()
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Item | undefined
  if (!item) return { names: [], warnings: ['条目不存在'] }
  const warnings: string[] = []
  const names: string[] = []
  const push = (n: unknown): void => {
    const s = String(n ?? '').trim()
    if (s && !names.includes(s)) names.push(s)
  }

  // 1) OpenAlex
  try {
    let w: any = null
    if (item.doi) {
      w = await oaGet(`/works/doi:${encodeURIComponent(item.doi)}`, { select: 'authorships' })
    }
    if (!w && item.title) {
      const data = await oaGet('/works', {
        search: item.title,
        per_page: 1,
        select: 'authorships'
      })
      w = data?.results?.[0] ?? null
    }
    for (const a of w?.authorships ?? []) push(a?.author?.display_name)
  } catch (e) {
    warnings.push(`OpenAlex 作者查询失败：${msg(e)}`)
  }

  // 2) 视觉识别（AI）兜底
  if (names.length === 0) {
    const att = db
      .prepare('SELECT * FROM attachments WHERE item_id = ? ORDER BY id LIMIT 1')
      .get(itemId) as { path: string } | undefined
    const cfg = llmConfig()
    if (att && cfg.baseUrl && cfg.apiKey) {
      try {
        const base = await ensureSidecar()
        const r = await fetch(`${base}/vision/metadata`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: resolveStoragePath(att.path),
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            model: cfg.model,
            headers: modelHeaders(cfg.baseUrl, sessionFor.chat()),
            maxPages: 1
          })
        })
        if (r.ok) {
          const vm = (await r.json()) as { authors?: string[] }
          for (const a of vm.authors ?? []) push(a)
        }
      } catch (e) {
        warnings.push(`视觉识别作者失败：${msg(e)}`)
      }
    }
  }

  // 3) 本地兜底
  if (names.length === 0) {
    const rows = db
      .prepare(
        `SELECT a.display_name AS name FROM item_authors ia
         JOIN authors a ON a.id = ia.author_id WHERE ia.item_id = ? ORDER BY ia.position`
      )
      .all(itemId) as Array<{ name: string }>
    for (const r of rows) push(r.name)
    if (names.length > 0) warnings.push('（OpenAlex/视觉未返回，使用本地作者）')
  }

  return { names, warnings }
}

/** 查本地 authors 表是否已有该（OpenAlex）作者：先按 openalex_id，再按同名 */
function findLocalAuthorId(name: string, openalexId?: string | null): number | null {
  const db = getDb()
  if (openalexId) {
    const byId = db.prepare('SELECT id FROM authors WHERE openalex_id = ? LIMIT 1').get(openalexId) as
      | { id: number }
      | undefined
    if (byId) return byId.id
  }
  if (name) {
    const byName = db
      .prepare('SELECT id FROM authors WHERE display_name = ? COLLATE NOCASE ORDER BY id LIMIT 1')
      .get(name) as { id: number } | undefined
    if (byName) return byName.id
  }
  return null
}

/** 作者检索：OpenAlex /authors?search=；离线/失败时回退本地 authors 表 */
export async function searchAuthors(
  query: string,
  limit = 10
): Promise<{ authors: AuthorSummary[]; warnings: string[] }> {
  const q = (query ?? '').trim()
  const warnings: string[] = []
  if (!q) return { authors: [], warnings }

  try {
    const data = await oaGet('/authors', { search: q, per_page: limit })
    const authors: AuthorSummary[] = (data?.results ?? [])
      .map(toAuthorSummary)
      .map((a: AuthorSummary) => ({ ...a, localAuthorId: findLocalAuthorId(a.name, a.id) }))
    if (authors.length > 0) return { authors, warnings }
    warnings.push('OpenAlex 未找到匹配作者，已展示本地作者')
  } catch (e) {
    warnings.push(`OpenAlex 作者检索失败（${msg(e)}），已展示本地作者`)
  }

  // 本地兜底
  const rows = getDb()
    .prepare(
      `SELECT a.id AS id, a.display_name AS name, a.orcid AS orcid,
              COUNT(ia.item_id) AS worksCount
       FROM authors a LEFT JOIN item_authors ia ON ia.author_id = a.id
       WHERE a.display_name LIKE ? COLLATE NOCASE
       GROUP BY a.id ORDER BY worksCount DESC LIMIT ?`
    )
    .all(`%${q}%`, limit) as Array<{
    id: number
    name: string
    orcid: string | null
    worksCount: number
  }>
  const authors: AuthorSummary[] = rows.map((r) => ({
    id: `local:${r.id}`,
    name: r.name,
    orcid: r.orcid,
    worksCount: r.worksCount ?? 0,
    citedBy: 0,
    hIndex: null,
    affiliation: null,
    source: 'local',
    localAuthorId: r.id
  }))
  return { authors, warnings }
}

function toAuthorSummary(w: any): AuthorSummary {
  const inst = w.last_known_institutions?.[0] ?? w.last_known_institution ?? null
  return {
    id: shortId(w.id),
    name: w.display_name ?? '(未知作者)',
    orcid: w.orcid ? String(w.orcid).replace(/^https?:\/\/orcid\.org\//, '') : null,
    worksCount: w.works_count ?? 0,
    citedBy: w.cited_by_count ?? 0,
    hIndex: w.summary_stats?.h_index ?? null,
    affiliation: inst?.display_name ?? null,
    source: 'openalex',
    localAuthorId: null
  }
}

function toWork(w: any): AuthorWork {
  return {
    id: shortId(w.id),
    title: w.display_name ?? w.title ?? null,
    year: (w.publication_year ?? w.publication_date?.slice(0, 4)) ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    doi: stripDoi(w.doi),
    citedBy: w.cited_by_count ?? 0
  }
}

/** 计算 h 指数（有被引列表时） */
function hIndexFrom(cites: number[]): number {
  const sorted = [...cites].sort((a, b) => b - a)
  let h = 0
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] >= i + 1) h = i + 1
    else break
  }
  return h
}

/** 作者详情 + 代表作：OpenAlex /authors/{id} + /works?filter=author.id=…；本地则查库 */
export async function authorProfile(id: string): Promise<AuthorProfile> {
  const warnings: string[] = []

  if (id.startsWith('local:')) {
    return localProfile(Number(id.slice('local:'.length)), warnings)
  }

  try {
    const [detail, worksData] = await Promise.all([
      oaGet(`/authors/${encodeURIComponent(id)}`),
      oaGet('/works', {
        filter: `author.id:${id}`,
        sort: 'cited_by_count:desc',
        per_page: 12,
        select: 'id,doi,display_name,publication_year,cited_by_count,primary_location'
      })
    ])
    const author = toAuthorSummary(detail)
    author.localAuthorId = findLocalAuthorId(author.name, author.id)
    const works: AuthorWork[] = (worksData?.results ?? []).map(toWork)
    if (author.hIndex == null && works.length) {
      author.hIndex = hIndexFrom(works.map((w) => w.citedBy))
    }
    return { author, works, warnings }
  } catch (e) {
    warnings.push(`OpenAlex 作者详情获取失败：${msg(e)}`)
    return {
      author: {
        id,
        name: id,
        orcid: null,
        worksCount: 0,
        citedBy: 0,
        hIndex: null,
        affiliation: null,
        source: 'openalex',
        localAuthorId: null
      },
      works: [],
      warnings
    }
  }
}

function localProfile(authorId: number, warnings: string[]): AuthorProfile {
  const db = getDb()
  const a = db.prepare('SELECT id, display_name, orcid FROM authors WHERE id = ?').get(authorId) as
    | { id: number; display_name: string; orcid: string | null }
    | undefined
  if (!a) {
    return {
      author: {
        id: `local:${authorId}`,
        name: `本地作者 ${authorId}`,
        orcid: null,
        worksCount: 0,
        citedBy: 0,
        hIndex: null,
        affiliation: null,
        source: 'local',
        localAuthorId: null
      },
      works: [],
      warnings
    }
  }
  const works = db
    .prepare(
      `SELECT i.id AS id, i.title AS title, i.year AS year, i.venue AS venue, i.doi AS doi
       FROM item_authors ia JOIN items i ON i.id = ia.item_id
       WHERE ia.author_id = ? ORDER BY i.year DESC`
    )
    .all(authorId) as Array<{ id: number; title: string | null; year: number | null; venue: string | null; doi: string | null }>
  return {
    author: {
      id: `local:${a.id}`,
      name: a.display_name,
      orcid: a.orcid,
      worksCount: works.length,
      citedBy: 0,
      hIndex: null,
      affiliation: null,
      source: 'local',
      localAuthorId: a.id
    },
    works: works.map((w) => ({
      id: `item:${w.id}`,
      title: w.title,
      year: w.year,
      venue: w.venue,
      doi: w.doi,
      citedBy: 0
    })),
    warnings
  }
}

/**
 * 把 OpenAlex 作者关联/合并到本地 authors 表：
 *  1) 优先按 openalex_id 找；2) 再按 ORCID；3) 再按同名（大小写不敏感）。
 * 找到则补齐缺失字段并把「同名重复记录」的论文合并到主记录后删除重复项；
 * 找不到则新建一条本地作者记录。
 */
export function linkLocalAuthor(input: LinkAuthorInput): LinkAuthorResult {
  const db = getDb()
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('作者名不能为空')
  const openalexId = (input.openalexId ?? '').trim()
  const orcid = input.orcid ? input.orcid.replace(/^https?:\/\/orcid\.org\//, '') : null

  let canonical:
    | { id: number; orcid: string | null; openalex_id: string | null }
    | undefined
  if (openalexId) {
    canonical = db
      .prepare('SELECT id, orcid, openalex_id FROM authors WHERE openalex_id = ? LIMIT 1')
      .get(openalexId) as typeof canonical
  }
  if (!canonical && orcid) {
    canonical = db
      .prepare('SELECT id, orcid, openalex_id FROM authors WHERE orcid = ? LIMIT 1')
      .get(orcid) as typeof canonical
  }
  const byName = db
    .prepare('SELECT id, orcid, openalex_id FROM authors WHERE display_name = ? COLLATE NOCASE ORDER BY id')
    .all(name) as Array<{ id: number; orcid: string | null; openalex_id: string | null }>
  if (!canonical) canonical = byName[0]

  let created = false
  let merged = 0

  const tx = db.transaction((): number => {
    if (!canonical) {
      const res = db
        .prepare('INSERT INTO authors (display_name, orcid, openalex_id) VALUES (?, ?, ?)')
        .run(name, orcid, openalexId || null)
      created = true
      return Number(res.lastInsertRowid)
    }
    const id = canonical.id
    if (openalexId && !canonical.openalex_id) {
      db.prepare('UPDATE authors SET openalex_id = ? WHERE id = ?').run(openalexId, id)
    }
    if (orcid && !canonical.orcid) {
      const clash = db.prepare('SELECT id FROM authors WHERE orcid = ? AND id <> ?').get(orcid, id) as
        | { id: number }
        | undefined
      if (!clash) db.prepare('UPDATE authors SET orcid = ? WHERE id = ?').run(orcid, id)
    }
    // 合并同名重复记录
    if (byName.length > 1) {
      merged += mergeAuthorRows(id, byName.filter((r) => r.id !== id).map((r) => r.id))
    }
    return id
  })

  const authorId = tx()
  return { authorId, created, merged, openalexId }
}

/** 把若干重复作者合并进主记录（搬运 item_authors 后删除重复行），返回合并条数 */
function mergeAuthorRows(canonicalId: number, dupIds: number[]): number {
  const db = getDb()
  let merged = 0
  for (const dupId of dupIds) {
    if (dupId === canonicalId) continue
    db.prepare(
      `INSERT OR IGNORE INTO item_authors (item_id, author_id, position)
       SELECT item_id, ?, position FROM item_authors WHERE author_id = ?`
    ).run(canonicalId, dupId)
    db.prepare('DELETE FROM item_authors WHERE author_id = ?').run(dupId)
    db.prepare('DELETE FROM authors WHERE id = ?').run(dupId)
    merged++
  }
  return merged
}

/**
 * 整理本地作者：
 *  1) 合并「同名（大小写不敏感）」的重复作者记录（优先保留带 ORCID 的那条）；
 *  2) 对有 ORCID 但缺 openalex_id 的作者，按 ORCID 从 OpenAlex 补齐（联网时，限量；失败即停）。
 */
export async function cleanupAuthors(): Promise<AuthorCleanupResult> {
  const db = getDb()

  let merged = 0
  const dupNames = db
    .prepare(
      `SELECT display_name AS name, COUNT(*) AS c FROM authors
       GROUP BY display_name COLLATE NOCASE HAVING c > 1`
    )
    .all() as Array<{ name: string; c: number }>
  const mergeTx = db.transaction(() => {
    for (const dn of dupNames) {
      const rows = db
        .prepare(
          `SELECT id, orcid FROM authors WHERE display_name = ? COLLATE NOCASE
           ORDER BY (orcid IS NULL), id`
        )
        .all(dn.name) as Array<{ id: number; orcid: string | null }>
      if (rows.length < 2) continue
      merged += mergeAuthorRows(
        rows[0].id,
        rows.slice(1).map((r) => r.id)
      )
    }
  })
  mergeTx()

  let enriched = 0
  let scanned = 0
  const toEnrich = db
    .prepare(
      `SELECT id, orcid FROM authors
       WHERE orcid IS NOT NULL AND orcid <> '' AND (openalex_id IS NULL OR openalex_id = '')
       LIMIT 20`
    )
    .all() as Array<{ id: number; orcid: string }>
  for (const a of toEnrich) {
    scanned++
    try {
      const data = await oaGet('/authors', { filter: `orcid:${a.orcid}`, per_page: 1 })
      const id = shortId(data?.results?.[0]?.id)
      if (id) {
        db.prepare('UPDATE authors SET openalex_id = ? WHERE id = ?').run(id, a.id)
        enriched++
      }
    } catch {
      break // 网络不可用：停止富化，保留已完成的合并
    }
  }
  return { merged, enriched, scanned }
}

/**
 * 按 ORCID 批量导入本地作者：对每个 ORCID 用 OpenAlex `/authors?filter=orcid:` 查到作者，
 * 新建（或补齐）本地 `authors` 记录。支持逗号/分号/空白/换行分隔。
 * 网络不可用时中止并返回已处理结果。
 */
export async function importAuthorsByOrcid(raw: string): Promise<ImportAuthorsResult> {
  const db = getDb()
  const result: ImportAuthorsResult = { added: 0, updated: 0, skipped: 0, errors: [] }
  const tokens = String(raw ?? '')
    .split(/[\s,;，、]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 50)

  for (const t of tokens) {
    const orcid = t.replace(/^https?:\/\/orcid\.org\//i, '')
    if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(orcid)) {
      result.skipped++
      if (result.errors.length < 8) result.errors.push(`格式不正确：${t}`)
      continue
    }
    const existing = db
      .prepare('SELECT id, openalex_id FROM authors WHERE orcid = ?')
      .get(orcid) as { id: number; openalex_id: string | null } | undefined
    if (existing && existing.openalex_id) {
      result.skipped++
      continue
    }

    let hit: any = null
    try {
      const data = await oaGet('/authors', { filter: `orcid:${orcid}`, per_page: 1 })
      hit = data?.results?.[0] ?? null
    } catch (e) {
      result.skipped++
      if (result.errors.length < 8) result.errors.push(`查询失败（${msg(e)}）`)
      break // 网络不可用：停止导入
    }
    if (!hit) {
      result.skipped++
      if (result.errors.length < 8) result.errors.push(`OpenAlex 未收录：${orcid}`)
      continue
    }

    const name = (hit.display_name as string) ?? '(未知作者)'
    const oaId = shortId(hit.id) || null
    if (existing) {
      db.prepare('UPDATE authors SET openalex_id = ? WHERE id = ?').run(oaId, existing.id)
      result.updated++
    } else {
      db.prepare(
        'INSERT INTO authors (display_name, orcid, openalex_id) VALUES (?, ?, ?)'
      ).run(name, orcid, oaId)
      result.added++
    }
  }

  return result
}
