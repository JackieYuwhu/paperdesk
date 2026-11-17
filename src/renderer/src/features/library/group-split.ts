/**
 * 文库侧栏「分组区 / 文献列表」上下分栏的高度换算。
 *
 * 全部是零依赖纯函数：LibraryList 用它把一次拖动换算成像素高度，
 * scripts/test-unit.ts 与 scripts/test-coords.ts 直接单测同一份逻辑，
 * 不在测试里复制一份实现导致两边漂移。
 *
 * 高度单位是 px（分组面板的 inline style）；列表区拿到剩余空间。
 * 上限随侧栏可用高度变化，保证文献列表至少留出 LIST_MIN 的可读区域。
 */

/** 分组面板最小高度：再小分组行与「新建分组」就不可用了 */
export const GROUP_PANE_MIN_HEIGHT = 120
/** 默认高度：双击分隔条 / 首次渲染时使用 */
export const GROUP_PANE_DEFAULT_HEIGHT = 240
/** 文献列表至少保留的高度（拖动上限 = 可用高度 - 该值） */
export const GROUP_PANE_LIST_MIN_HEIGHT = 160
/** 侧栏尚未测量出高度（首帧）时的上限，避免出现 0 高度 */
export const GROUP_PANE_FALLBACK_MAX_HEIGHT = 560
/** 用户拖动后的分组区高度持久化键（刷新 / 重启后恢复） */
export const GROUP_PANE_STORE_KEY = 'paperdesk.ui.groupPaneH'
/** 按内容自适应时，分组树之外（标题栏 / 工具行）预留的高度 */
export const GROUP_PANE_CHROME_HEIGHT = 44

/**
 * 按内容算分组区高度（阶段二「默认按实际内容占用高度」）。
 * contentHeight 是分组树内容的 scrollHeight；仍然受上限约束，
 * 分组很多时封顶到 maxGroupPaneHeight，由分组树内部滚动。
 */
export function groupPaneHeightFromContent(
  contentHeight: number,
  availableHeight?: number | null
): number {
  const content = Number(contentHeight)
  if (!Number.isFinite(content) || content <= 0) {
    return clampGroupPaneHeight(GROUP_PANE_DEFAULT_HEIGHT, availableHeight)
  }
  return clampGroupPaneHeight(content + GROUP_PANE_CHROME_HEIGHT, availableHeight)
}

/** 读取持久化的分组区高度；没有 / 非法时返回 null（表示按内容自适应） */
export function readStoredGroupPaneHeight(raw: string | null): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/**
 * 分组树「实际内容」高度：累加每个可见行自身高度 + 行间距。
 *
 * 为什么不用 rows.scrollHeight / clientHeight：分组树在分隔面板里是 flex:1，
 * 面板比内容高时 clientHeight 会被 flex 撑大，scrollHeight 也随之返回撑大后的值。
 * 用它算自适应高度会让面板只能变大不能变小 —— 删掉分组后仍留一大块空白。
 */
export function groupTreeContentHeight(rowHeights: readonly number[], gap = 1): number {
  const rows = rowHeights.filter((h) => Number.isFinite(h) && h > 0)
  if (rows.length === 0) return 0
  const total = rows.reduce((sum, h) => sum + Math.round(h), 0)
  return total + Math.max(0, rows.length - 1) * Math.max(0, Math.round(gap))
}

/**
 * 分组面板高度上限。
 * availableHeight 是分栏容器的 clientHeight；首帧 / 折叠时为 0，
 * 此时退回固定上限，避免把高度夹成负数。
 */
export function maxGroupPaneHeight(availableHeight?: number | null): number {
  const available = Number(availableHeight)
  if (!Number.isFinite(available) || available <= 0) return GROUP_PANE_FALLBACK_MAX_HEIGHT
  return Math.max(GROUP_PANE_MIN_HEIGHT, Math.round(available - GROUP_PANE_LIST_MIN_HEIGHT))
}

/**
 * 把任意高度夹到 [MIN, maxGroupPaneHeight(available)]。
 * 非数字（NaN / 外部数据）退回默认高度；上下限都保证整数 px。
 */
export function clampGroupPaneHeight(
  value: number,
  availableHeight?: number | null
): number {
  const max = maxGroupPaneHeight(availableHeight)
  const raw = Number(value)
  const base = Number.isFinite(raw) ? Math.round(raw) : GROUP_PANE_DEFAULT_HEIGHT
  return Math.min(max, Math.max(GROUP_PANE_MIN_HEIGHT, base))
}

/** 拖动中：起始高度 + 指针位移，再统一夹取 */
export function groupPaneHeightFromDrag(
  startHeight: number,
  deltaY: number,
  availableHeight?: number | null
): number {
  const start = Number(startHeight)
  const delta = Number(deltaY)
  const base = Number.isFinite(start) ? start : GROUP_PANE_DEFAULT_HEIGHT
  const dy = Number.isFinite(delta) ? delta : 0
  return clampGroupPaneHeight(base + dy, availableHeight)
}

/** 双击复位：回到默认高度（窗口很矮时仍走同一套夹取规则） */
export function resetGroupPaneHeight(availableHeight?: number | null): number {
  return clampGroupPaneHeight(GROUP_PANE_DEFAULT_HEIGHT, availableHeight)
}

/** 分组面板的 inline style（测试直接断言拖动前后 height 字符串变化） */
export function groupPaneStyle(
  height: number,
  availableHeight?: number | null
): { height: string } {
  return { height: `${clampGroupPaneHeight(height, availableHeight)}px` }
}
