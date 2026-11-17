/**
 * 知识库阶段 2（PD40）：chunks 的**证据字段**——内容指纹 + 模块级定位。
 *
 * 设计边界（见 docs/KNOWLEDGE-DESIGN.md §7 / §10）：
 *   - `chunks.content_hash` 是「归一化正文」的 sha256：**内容指纹，不是语义哈希**，
 *     也不是 embedding。它与 `evidence_links.content_hash = sha256([quote])` 的
 *     计算口径不同（一个对块正文、一个对证据引文数组），不要互相校验。
 *   - `chunks.char_start / char_end` 是**模块正文 `module.text` 的 UTF-16 下标**
 *     （左闭右开）。不是 PDF 字符偏移，前端不要按此去切 PDF 文本层。
 *   - `module_id` 与字符区间**同时成立**才算模块级证据；否则只保留页级
 *     （`page_index`），精度由 knowledge.ts::derivePrecision 统一判定。
 *
 * 本文件刻意只依赖 `node:crypto` 与 `src/shared/modules.ts`（都不 import
 * electron），因此可被 `scripts/test-unit.ts` 用 node:sqlite 内存库直接验证。
 */

import { createHash } from 'node:crypto'
// @ts-expect-error TS5097：测试用 `node scripts/test-unit.ts` 直接加载本文件，
// 相对导入必须带 .ts 扩展名；electron-vite 打包同样能解析（与 knowledge-search.ts 同）。
import { matchChunkToModule, type StructuredModule } from '../../shared/modules.ts'

/* ============================================================================
 * 1. 内容指纹
 * ==========================================================================*/

/** 归一化：NFKC + 每码点小写 + 空白折叠为单个空格 + 去首尾空白。 */
export function normalizeChunkText(text: string): string {
  const normalized = buildNormalized(String(text ?? ''))
  return normalized.text
}

/**
 * 块内容指纹：归一化正文的 sha256（hex）。
 *
 * 用途：判断「同一块正文是否已变」，供增量索引/去重参考；
 * **不表示语义相似**，也不参与模块定位判定。
 */
export function chunkContentHash(text: string): string {
  return createHash('sha256').update(normalizeChunkText(text), 'utf8').digest('hex')
}

/* ============================================================================
 * 2. 模块内字符区间
 * ==========================================================================*/

interface NormalizedText {
  /** 归一化后的文本（小写、空白折叠、已 trim） */
  text: string
  /** 每个归一化码元在原文中的起点（UTF-16） */
  starts: number[]
  /** 每个归一化码元在原文中的终点（UTF-16，开区间） */
  ends: number[]
}

const isSpace = (s: string): boolean => /^\s+$/u.test(s)

/**
 * 归一化并保留「归一化下标 → 原文 UTF-16 区间」的映射。
 *
 * NFKC / 小写都可能把一个码点展开成多个码元（如 ﬁ → fi），展开后的每个码元
 * 都映射回同一个原文码点区间，因此回填出的 char_start/char_end 始终落在原文上。
 */
function buildNormalized(input: string): NormalizedText {
  let text = ''
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const ch of input) {
    const originStart = offset
    offset += ch.length
    let normalized: string
    try {
      normalized = ch.normalize('NFKC').toLowerCase()
    } catch {
      normalized = ch.toLowerCase()
    }
    if (!normalized) continue
    if (isSpace(normalized)) {
      if (text.endsWith(' ')) {
        // 连续空白折叠：只延长上一个空格的原文区间
        ends[ends.length - 1] = offset
      } else {
        text += ' '
        starts.push(originStart)
        ends.push(offset)
      }
      continue
    }
    for (let i = 0; i < normalized.length; i++) {
      text += normalized[i]
      starts.push(originStart)
      ends.push(offset)
    }
  }
  // trim（只可能出现在两端，且都是折叠后的空格）
  let begin = 0
  let end = text.length
  while (begin < end && text[begin] === ' ') begin++
  while (end > begin && text[end - 1] === ' ') end--
  return {
    text: text.slice(begin, end),
    starts: starts.slice(begin, end),
    ends: ends.slice(begin, end)
  }
}

/**
 * 40 字窗口探针：与 `matchChunkToModules` 使用同一策略（最多 4 个），
 * 保证「能匹配到模块」的块通常也能定位到字符区间。
 */
function chunkProbes(chunk: string): string[] {
  const probes: string[] = []
  const win = 40
  const step = Math.max(1, Math.floor((chunk.length - win) / 3) || 1)
  for (let i = 0; i + win <= chunk.length && probes.length < 4; i += step) {
    probes.push(chunk.slice(i, i + win))
  }
  if (!probes.length) probes.push(chunk.slice(0, win))
  return probes
}

/**
 * 把块正文定位到模块正文内，返回模块正文的 UTF-16 字符区间（左闭右开）。
 * 依次尝试：整块包含 → 40 字窗口 → 模块正文（≥24 字）被块包含。
 * 定位不可靠时返回 null（不猜）。
 */
export function locateChunkInModule(
  moduleText: string,
  chunkText: string
): { charStart: number; charEnd: number } | null {
  const moduleNorm = buildNormalized(String(moduleText ?? ''))
  if (!moduleNorm.text) return null
  const chunk = normalizeChunkText(chunkText)
  if (!chunk) return null

  const at = moduleNorm.text.indexOf(chunk)
  if (at >= 0) return spanAt(moduleNorm, at, chunk.length)

  for (const probe of chunkProbes(chunk)) {
    if (!probe) continue
    const hit = moduleNorm.text.indexOf(probe)
    if (hit >= 0) return spanAt(moduleNorm, hit, probe.length)
  }

  // 模块正文本身很短（≤ 块）：整段模块就是证据区间
  if (
    moduleNorm.text.length >= 24 &&
    chunk.includes(moduleNorm.text.slice(0, 24))
  ) {
    return {
      charStart: moduleNorm.starts[0],
      charEnd: moduleNorm.ends[moduleNorm.ends.length - 1]
    }
  }
  return null
}

function spanAt(
  normalized: NormalizedText,
  at: number,
  length: number
): { charStart: number; charEnd: number } {
  return {
    charStart: normalized.starts[at],
    charEnd: normalized.ends[at + length - 1]
  }
}

/** 模块级证据：模块 id + 模块正文内的字符区间。 */
export interface ChunkModuleEvidence {
  moduleId: string
  charStart: number
  charEnd: number
}

/**
 * 用结构化模块表解析一个块的模块级证据；模块或区间任一缺失都返回 null。
 * 只返回 **module_id 与区间同时成立** 的结果，避免写出「半截」证据。
 */
export function resolveChunkModuleEvidence(
  modules: StructuredModule[],
  page: number,
  chunkText: string
): ChunkModuleEvidence | null {
  const module = matchChunkToModule(modules, page, chunkText)
  if (!module) return null
  const span = locateChunkInModule(module.text, chunkText)
  if (!span) return null
  return { moduleId: module.id, charStart: span.charStart, charEnd: span.charEnd }
}

/* ============================================================================
 * 3. 读回（统一证据读取入口）
 * ==========================================================================*/

export interface ChunkEvidenceDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
}

export interface ChunkEvidence {
  chunkId: number
  attachmentId: number
  pageIndex: number | null
  text: string
  moduleId: string | null
  charStart: number | null
  charEnd: number | null
  contentHash: string | null
  /** module 仅在 module_id + 区间都成立时给出，否则为 page */
  precision: 'module' | 'page'
}

interface ChunkRow {
  id: number
  attachment_id: number
  page_index: number | null
  text: string
  module_id: string | null
  char_start: number | null
  char_end: number | null
  content_hash: string | null
}

const CHUNK_COLUMNS =
  'id, attachment_id, page_index, text, module_id, char_start, char_end, content_hash'

/** 精度判定：module 必须 module_id 与合法区间同时成立，否则 page。 */
export function chunkEvidencePrecision(row: {
  moduleId: string | null
  charStart: number | null
  charEnd: number | null
}): 'module' | 'page' {
  return row.moduleId !== null &&
    row.charStart !== null &&
    row.charEnd !== null &&
    row.charEnd > row.charStart
    ? 'module'
    : 'page'
}

/** 统一读取一个块的证据三字段，供检索/UI/测试复用。 */
export function readChunkEvidence(db: ChunkEvidenceDb, chunkId: number): ChunkEvidence | null {
  const row = db.prepare(`SELECT ${CHUNK_COLUMNS} FROM chunks WHERE id = ?`).get(chunkId) as
    | ChunkRow
    | undefined
  if (!row) return null
  return {
    chunkId: row.id,
    attachmentId: row.attachment_id,
    pageIndex: row.page_index,
    text: row.text,
    moduleId: row.module_id,
    charStart: row.char_start,
    charEnd: row.char_end,
    contentHash: row.content_hash,
    precision: chunkEvidencePrecision({
      moduleId: row.module_id,
      charStart: row.char_start,
      charEnd: row.char_end
    })
  }
}

/* ============================================================================
 * 4. 历史块回填（幂等，失败降级不阻止启动）
 * ==========================================================================*/

export interface KnowledgeBackfillResult {
  /** ok = 全部处理；degraded = 有块/附件失败但已尽量写入；skipped = 无 chunks 表 */
  status: 'ok' | 'degraded' | 'skipped'
  /** 本次扫描到的待回填块数（第二次执行应为 0） */
  scanned: number
  /** 成功写入 module_id + 区间的块数 */
  filled: number
  /** 只写入 content_hash 的块数 */
  hashed: number
  /** 解析 doc_json / 写入失败的次数（降级计数） */
  degraded: number
  /** 前若干条错误摘要（供启动日志与单测诊断） */
  errors: string[]
}

export interface BackfillLog {
  info?: (message: string) => void
  warn?: (message: string, error: unknown) => void
}

const MAX_ERRORS = 5

/**
 * 幂等回填历史 chunks 的证据字段。
 *
 * - 只扫描「缺 content_hash / 缺 module_id / 缺字符区间」的块；
 * - 每个附件只读一次 `paper_modules.doc_json`，解析失败只记降级，不中断其它附件；
 * - 模块或区间任一解析不到时**只补 content_hash**，module_id 保持 NULL（页级证据）；
 * - 失败只返回 `degraded` 并告警，调用方（initDb）不因此阻止启动。
 *
 * 注意：写入走普通 UPDATE，`chunks_fts` 的 UPDATE 触发器会 delete+insert 同一行，
 * 因此 FTS 命中集合不变（PD40 验收④的单测直接断言这一点）。
 */
export function migrateKnowledgeBackfill(
  db: ChunkEvidenceDb,
  log: BackfillLog = {}
): KnowledgeBackfillResult {
  const info = log.info ?? ((m: string): void => console.log(m))
  const warn = log.warn ?? ((m: string, e: unknown): void => console.warn(m, e))
  const result: KnowledgeBackfillResult = {
    status: 'ok',
    scanned: 0,
    filled: 0,
    hashed: 0,
    degraded: 0,
    errors: []
  }

  let rows: ChunkRow[]
  try {
    const cols = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>
    if (!cols.length) {
      result.status = 'skipped'
      return result
    }
    rows = db
      .prepare(
        `SELECT ${CHUNK_COLUMNS} FROM chunks
         WHERE content_hash IS NULL
            OR module_id IS NULL
            OR char_start IS NULL
            OR char_end IS NULL
         ORDER BY id`
      )
      .all() as ChunkRow[]
  } catch (e) {
    warn('[paperdesk] knowledge backfill scan failed (degraded):', e)
    result.status = 'degraded'
    result.degraded++
    result.errors.push(String(e))
    return result
  }

  result.scanned = rows.length
  if (!rows.length) return result

  const moduleCache = new Map<number, StructuredModule[] | null>()
  const loadModules = (attachmentId: number): StructuredModule[] | null => {
    if (moduleCache.has(attachmentId)) return moduleCache.get(attachmentId) ?? null
    let modules: StructuredModule[] | null = null
    try {
      const row = db
        .prepare('SELECT doc_json FROM paper_modules WHERE attachment_id = ?')
        .get(attachmentId) as { doc_json: string | null } | undefined
      if (row?.doc_json) {
        const parsed = JSON.parse(row.doc_json) as { modules?: StructuredModule[] }
        if (Array.isArray(parsed?.modules)) modules = parsed.modules
      }
    } catch (e) {
      result.degraded++
      if (result.errors.length < MAX_ERRORS) {
        result.errors.push(`attachment ${attachmentId}: doc_json 解析失败: ${String(e)}`)
      }
      warn(`[paperdesk] knowledge backfill doc_json failed (attachment ${attachmentId}):`, e)
    }
    moduleCache.set(attachmentId, modules)
    return modules
  }

  for (const row of rows) {
    try {
      const contentHash = chunkContentHash(row.text)
      const needsModule =
        row.module_id === null || row.char_start === null || row.char_end === null
      let resolved: ChunkModuleEvidence | null = null
      if (needsModule && row.page_index !== null) {
        const modules = loadModules(row.attachment_id)
        if (modules) resolved = resolveChunkModuleEvidence(modules, row.page_index + 1, row.text)
      }
      if (resolved) {
        // 已有 module_id 但缺区间时，只在定位到同一模块时写回，避免覆盖成别的模块
        if (row.module_id !== null && row.module_id !== resolved.moduleId) {
          resolved = null
        }
      }
      if (resolved) {
        db.prepare(
          'UPDATE chunks SET module_id = ?, char_start = ?, char_end = ?, content_hash = ? WHERE id = ?'
        ).run(
          resolved.moduleId,
          resolved.charStart,
          resolved.charEnd,
          contentHash,
          row.id
        )
        result.filled++
      } else if (row.content_hash === null) {
        // 无模块信息：只补内容指纹，module_id/区间保持 NULL（页级）
        db.prepare('UPDATE chunks SET content_hash = ? WHERE id = ?').run(contentHash, row.id)
        result.hashed++
      }
    } catch (e) {
      result.degraded++
      if (result.errors.length < MAX_ERRORS) {
        result.errors.push(`chunk ${row.id}: ${String(e)}`)
      }
      warn(`[paperdesk] knowledge backfill chunk ${row.id} failed (degraded):`, e)
    }
  }

  if (result.degraded > 0) result.status = 'degraded'
  info(
    `[paperdesk] knowledge backfill: scanned=${result.scanned} filled=${result.filled} hashed=${result.hashed} degraded=${result.degraded}`
  )
  return result
}
