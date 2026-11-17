/**
 * 检索范围（scope）：把「只在某篇论文 / 某个附件 / 某个分组 / 某条笔记里找」的约束
 * 下推进 SQL 的 WHERE，避免「先全库取 N 条、再在结果集上过滤」把冷门论文的命中挤掉。
 *
 * 纯模块：不 import electron / db / services，只 import type，方便 node:sqlite 单测直接执行。
 *
 * 约定：
 *  - buildScopeSql 产出的片段以 " AND (...)" 开头（无需范围时为空串），调用方把它插在
 *    MATCH / 常规 WHERE 之后、ORDER BY 之前；参数顺序与片段中 ? 的出现顺序一致。
 *  - 非法范围统一抛可读错误（中文），不做静默忽略，避免「传错了却像是没找到」。
 *  - applicable=false 表示该数据源天然承载不了这组范围（例如按笔记限定却去查 items），
 *    调用方应整段跳过该来源，而不是退化成全库检索。
 */

/** 一次分组范围最多解析出多少条目（超过说明范围过大，宁可报错也不悄悄截断） */
export const SCOPE_ITEM_LIMIT = 500

/** LIKE 词法检索最多拆出多少个词项（限制 SQL 规模） */
const LIKE_MAX_TERMS = 8

/** LIKE 单个词项的最大长度，避免超长串把 SQL 撑爆 */
const LIKE_TERM_MAX_CHARS = 120

/** SQLite LIKE 的转义字符（单引号内就是一个反斜杠） */
const LIKE_ESCAPE = " ESCAPE '\\'"

/** 调用方传入的原始范围（字段都可缺省；null 视为未限定） */
export interface SearchScopeInput {
  /** 单篇论文（items.id） */
  itemId?: number | null
  /** 一批论文（items.id），分组范围解析后的结果走这里 */
  itemIds?: readonly number[] | null
  /** 单个附件（attachments.id） */
  attachmentId?: number | null
  /** 单条笔记（notes.id） */
  noteId?: number | null
  /** 分组名路径；纯模块无法查库解析，必须配合 itemIds 一起使用（见 groupScopeFromPaperIds） */
  groupId?: string | null
}

/** 归一化后的范围：字段要么是正整数，要么是 null */
export interface SearchScope {
  itemId: number | null
  itemIds: number[] | null
  attachmentId: number | null
  noteId: number | null
  groupId: string | null
  /** 范围已明确为「没有任何匹配」（例如空分组），SQL 层直接 AND 0 */
  empty: boolean
}

/** 支持范围下推的五个数据源（与 search.ts / knowledge-search.ts 的 FROM 别名对应） */
export type ScopeSource = 'items' | 'chunks' | 'notes' | 'translations' | 'knowledge'

export interface ScopeSql {
  /** 以 " AND (...)" 开头；无需范围时为空串 */
  sql: string
  params: unknown[]
  /** false = 该来源承载不了这组范围，调用方应跳过该来源 */
  applicable: boolean
}

const SCOPE_PREFIX = '检索范围非法：'

function fail(message: string): never {
  throw new Error(`${SCOPE_PREFIX}${message}`)
}

/** 正整数归一化；缺省返回 null，非法抛可读错误 */
function posInt(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`${label} 必须是正整数（收到 ${describe(value)}）`)
  }
  return value
}

function describe(value: unknown): string {
  if (typeof value === 'string') return `"${value.slice(0, 40)}"`
  if (typeof value === 'number') return String(value)
  if (value === null) return 'null'
  return typeof value
}

/** 范围字段是否「有限定」 */
function isSet(value: unknown): boolean {
  return value !== null && value !== undefined
}

/**
 * 归一化范围。整组范围为空（全部字段未限定）时返回 null，调用方据此不加任何条件。
 * 非法输入（0、负数、小数、字符串 id、超长 itemIds、只有 groupId 没有 itemIds）抛可读错误。
 */
export function normalizeSearchScope(raw: SearchScopeInput | null | undefined): SearchScope | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('scope 必须是对象')

  const itemId = posInt(raw.itemId, 'itemId')
  const attachmentId = posInt(raw.attachmentId, 'attachmentId')
  const noteId = posInt(raw.noteId, 'noteId')

  let itemIds: number[] | null = null
  if (raw.itemIds !== null && raw.itemIds !== undefined) {
    if (!Array.isArray(raw.itemIds)) fail('itemIds 必须是数组')
    const seen = new Set<number>()
    const list: number[] = []
    for (const value of raw.itemIds) {
      const id = posInt(value, 'itemIds 的元素')
      if (id === null) continue
      if (seen.has(id)) continue
      seen.add(id)
      list.push(id)
    }
    if (list.length > SCOPE_ITEM_LIMIT) {
      fail(`itemIds 最多 ${SCOPE_ITEM_LIMIT} 项（收到 ${list.length} 项）`)
    }
    itemIds = list
  }

  if (itemId !== null && itemIds !== null) fail('itemId 与 itemIds 不能同时使用')

  let groupId: string | null = null
  if (isSet(raw.groupId)) {
    if (typeof raw.groupId !== 'string') fail('groupId 必须是字符串')
    const trimmed = raw.groupId.trim()
    groupId = trimmed === '' ? null : trimmed
  }
  if (groupId !== null && itemIds === null) {
    fail('groupId 必须先解析成 itemIds（使用 groupScopeFromPaperIds）')
  }

  if (
    itemId === null &&
    itemIds === null &&
    attachmentId === null &&
    noteId === null &&
    groupId === null
  ) {
    return null
  }

  return {
    itemId,
    itemIds,
    attachmentId,
    noteId,
    groupId,
    empty: itemIds !== null && itemIds.length === 0
  }
}

/** 把分组解析出的条目 id 列表包成范围；空分组得到 empty 范围（SQL 层 AND 0） */
export function groupScopeFromPaperIds(
  paperIds: readonly number[] | null | undefined,
  groupId: string | null = null
): SearchScope {
  const scope = normalizeSearchScope({
    itemIds: Array.isArray(paperIds) ? paperIds : [],
    groupId
  })
  // itemIds 一定非 null，normalize 不会返回 null
  return scope as SearchScope
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',')
}

/** 某数据源能承载哪些范围字段；出现不支持的字段就整段跳过该来源 */
const SOURCE_KEYS: Record<ScopeSource, ReadonlyArray<keyof SearchScopeInput>> = {
  items: ['itemId', 'itemIds', 'attachmentId'],
  chunks: ['itemId', 'itemIds', 'attachmentId'],
  notes: ['itemId', 'itemIds', 'noteId'],
  translations: ['itemId', 'itemIds', 'attachmentId'],
  knowledge: ['itemId', 'itemIds', 'attachmentId']
}

/**
 * 按数据源生成参数化范围片段。
 * 片段里的别名固定为：items→i、chunks→c、notes→n、translations→t、knowledge→e，
 * 与各查询的 FROM 别名一致；附件归属统一走 attachments 子查询（不走 items 反查）。
 */
export function buildScopeSql(
  scope: SearchScope | null | undefined,
  source: ScopeSource
): ScopeSql {
  const none: ScopeSql = { sql: '', params: [], applicable: true }
  if (!scope) return none

  const supported = SOURCE_KEYS[source]
  if (!supported) fail(`未知的数据源 ${String(source)}`)
  const keys: Array<keyof SearchScopeInput> = [
    'itemId',
    'itemIds',
    'attachmentId',
    'noteId'
  ]
  const unsupported = keys.some((key) => isSet(scope[key]) && !supported.includes(key))
  if (unsupported) return { sql: '', params: [], applicable: false }

  if (scope.empty) return { sql: ' AND 0', params: [], applicable: true }

  const conditions: string[] = []
  const params: unknown[] = []
  const ids = scope.itemIds

  switch (source) {
    case 'items': {
      if (scope.itemId !== null) {
        conditions.push('i.id = ?')
        params.push(scope.itemId)
      }
      if (ids !== null) {
        conditions.push(`i.id IN (${placeholders(ids.length)})`)
        params.push(...ids)
      }
      if (scope.attachmentId !== null) {
        conditions.push(
          'EXISTS (SELECT 1 FROM attachments sc WHERE sc.item_id = i.id AND sc.id = ?)'
        )
        params.push(scope.attachmentId)
      }
      break
    }
    case 'chunks': {
      if (scope.itemId !== null) {
        conditions.push(
          'EXISTS (SELECT 1 FROM attachments sc WHERE sc.id = c.attachment_id AND sc.item_id = ?)'
        )
        params.push(scope.itemId)
      }
      if (ids !== null) {
        conditions.push(
          `EXISTS (SELECT 1 FROM attachments sc WHERE sc.id = c.attachment_id AND sc.item_id IN (${placeholders(ids.length)}))`
        )
        params.push(...ids)
      }
      if (scope.attachmentId !== null) {
        conditions.push('c.attachment_id = ?')
        params.push(scope.attachmentId)
      }
      break
    }
    case 'notes': {
      if (scope.itemId !== null) {
        conditions.push('n.item_id = ?')
        params.push(scope.itemId)
      }
      if (ids !== null) {
        conditions.push(`n.item_id IN (${placeholders(ids.length)})`)
        params.push(...ids)
      }
      if (scope.noteId !== null) {
        conditions.push('n.id = ?')
        params.push(scope.noteId)
      }
      break
    }
    case 'translations': {
      if (scope.itemId !== null) {
        conditions.push(
          'EXISTS (SELECT 1 FROM attachments sc WHERE sc.id = t.attachment_id AND sc.item_id = ?)'
        )
        params.push(scope.itemId)
      }
      if (ids !== null) {
        conditions.push(
          `EXISTS (SELECT 1 FROM attachments sc WHERE sc.id = t.attachment_id AND sc.item_id IN (${placeholders(ids.length)}))`
        )
        params.push(...ids)
      }
      if (scope.attachmentId !== null) {
        conditions.push('t.attachment_id = ?')
        params.push(scope.attachmentId)
      }
      break
    }
    case 'knowledge': {
      if (scope.itemId !== null) {
        conditions.push('e.item_id = ?')
        params.push(scope.itemId)
      }
      if (ids !== null) {
        conditions.push(`e.item_id IN (${placeholders(ids.length)})`)
        params.push(...ids)
      }
      if (scope.attachmentId !== null) {
        // 条目本身记了附件，或证据链接指到该附件，都算命中
        conditions.push(
          '(e.attachment_id = ? OR EXISTS (SELECT 1 FROM evidence_links ev WHERE ev.entry_id = e.id AND ev.attachment_id = ?))'
        )
        params.push(scope.attachmentId, scope.attachmentId)
      }
      break
    }
  }

  if (conditions.length === 0) return none
  return { sql: ` AND (${conditions.join(' AND ')})`, params, applicable: true }
}

/** 知识库检索的一行结果（纯类型，供渲染层/服务层共用） */
export interface KnowledgeSearchHit {
  id: number
  key: string
  kind: string
  title: string
  snippet: string
  /** 命中分：标题命中 2 分/词，正文命中 1 分/词（纯词法，非语义） */
  score: number
  contentNature: string
  sourceType: string
  itemId: number | null
  attachmentId: number | null
  updatedAt: string
}

export interface LikeMatch {
  ok: boolean
  terms: string[]
  /** 每个词项的 %关键词% 模式（已做 ESCAPE 转义） */
  patterns: string[]
  /** 以 " AND (...)" 开头；无关键词时为空串 */
  where: string
  whereParams: unknown[]
  /** 打分表达式（不含 "AS"），按词项累加；无关键词时为 "0" */
  score: string
  scoreParams: unknown[]
}

/** 转义 LIKE 通配符，配合 LIKE_ESCAPE 使用 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

const TERM_SPLIT = /[\s,，。;；、:：!！?？()（）\[\]【】"'“”‘’<>《》|/\\]+/

/**
 * 把用户输入拆成 LIKE 词项：按空白与常见中英标点切分，逐词 %…% 匹配标题/正文。
 * 输入全为空/全标点时 ok=false（调用方直接返回 []，不访问数据库）。
 */
export function buildLikeMatch(raw: unknown): LikeMatch {
  const text = String(raw ?? '')
    .normalize('NFKC')
    .trim()
  const terms = text
    .split(TERM_SPLIT)
    .map((term) => term.trim().slice(0, LIKE_TERM_MAX_CHARS))
    .filter(Boolean)
    .slice(0, LIKE_MAX_TERMS)

  if (terms.length === 0) {
    return { ok: false, terms: [], patterns: [], where: '', whereParams: [], score: '0', scoreParams: [] }
  }

  const patterns = terms.map((term) => `%${escapeLike(term)}%`)
  const where = ` AND (${terms
    .map(() => `(e.title LIKE ?${LIKE_ESCAPE} OR e.body LIKE ?${LIKE_ESCAPE})`)
    .join(' AND ')})`
  const whereParams: unknown[] = []
  for (const pattern of patterns) whereParams.push(pattern, pattern)

  const score = terms
    .map(
      () =>
        `(CASE WHEN e.title LIKE ?${LIKE_ESCAPE} THEN 2 ELSE 0 END + CASE WHEN e.body LIKE ?${LIKE_ESCAPE} THEN 1 ELSE 0 END)`
    )
    .join(' + ')
  const scoreParams: unknown[] = []
  for (const pattern of patterns) scoreParams.push(pattern, pattern)

  return { ok: true, terms, patterns, where, whereParams, score, scoreParams }
}
