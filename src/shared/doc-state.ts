// 每篇文档的阅读状态（纯函数，便于单测）
// 持久化到 localStorage：paperdesk.doc.<itemId>
export interface DocState {
  /** 上次查看的附件（同一篇可能有多个附件） */
  attachmentId?: number | null
  /** 视图：original / pdf / html / bilingual / split */
  viewMode?: string
  /** 阅读页码 */
  page?: number
  /** 缩放比例（1.0 = 100%）；null 表示沿用「适应宽度」 */
  scale?: number | null
  /** 是否处于「适应宽度」 */
  zoomFit?: boolean
  /** 右侧面板列是否收起（薄条） */
  rcCollapsed?: boolean
  /** 用户是否已手动调整过面板（首次进入对照只自动收起一次） */
  panelAdjusted?: boolean
}

const PREFIX = 'paperdesk.doc.'

/** 文档状态的 localStorage 键 */
export function docStateKey(itemId: number): string {
  return `${PREFIX}${itemId}`
}

/** 解析持久化字符串；损坏 / 非对象 → {} （并在字段层面做类型校验） */
export function parseDocState(raw: string | null): DocState {
  if (!raw) return {}
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const o = obj as Record<string, unknown>
  const out: DocState = {}
  if (o.attachmentId === null || typeof o.attachmentId === 'number') {
    out.attachmentId = o.attachmentId as number | null
  }
  if (typeof o.viewMode === 'string') out.viewMode = o.viewMode
  if (typeof o.page === 'number' && Number.isFinite(o.page)) out.page = o.page
  if (o.scale === null || typeof o.scale === 'number') out.scale = o.scale as number | null
  if (typeof o.zoomFit === 'boolean') out.zoomFit = o.zoomFit
  if (typeof o.rcCollapsed === 'boolean') out.rcCollapsed = o.rcCollapsed
  if (typeof o.panelAdjusted === 'boolean') out.panelAdjusted = o.panelAdjusted
  return out
}

/** 序列化文档状态 */
export function serializeDocState(s: DocState): string {
  return JSON.stringify(s)
}

/** 合并补丁：未提供的字段保留原值（显式传入 undefined 也视为「不修改」） */
export function mergeDocState(prev: DocState, patch: Partial<DocState>): DocState {
  const next: DocState = { ...prev }
  if (patch.attachmentId !== undefined) next.attachmentId = patch.attachmentId
  if (patch.viewMode !== undefined) next.viewMode = patch.viewMode
  if (patch.page !== undefined) next.page = patch.page
  if (patch.scale !== undefined) next.scale = patch.scale
  if (patch.zoomFit !== undefined) next.zoomFit = patch.zoomFit
  if (patch.rcCollapsed !== undefined) next.rcCollapsed = patch.rcCollapsed
  return next
}
