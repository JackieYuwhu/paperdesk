/**
 * 批注高亮配色（第四轮：以 WPS 荧光笔的可读性为参照）。
 *
 * 设计约束：
 * - 颜色与不透明度**逐色**定义，不再用一个全局 opacity 混所有颜色。
 * - 旧批注里存的是 `#ffd400` 这类纯色；这里保留这些色值为「历史色」，
 *   渲染时映射到同一色相的高亮色，保证老批注开箱即可见、内容与位置不变。
 * - 白底 PDF 上高亮要明显，同时黑字不能被盖住：黄/绿/蓝/粉的透明度控制在 0.45–0.58；
 *   叠加时用 multiply（见 styles.css），重叠区域变深而不是糊成一片。
 */

export interface HighlightSpec {
  /** 色板 id，供界面展示与测试引用 */
  id: 'yellow' | 'green' | 'blue' | 'pink'
  label: string
  /** 渲染用的高亮色（纯色，实际不透明度由 alpha 控制） */
  hex: string
  /** 浅色主题下的不透明度 */
  alpha: number
  /** 深色主题下略低一点，避免 screen 叠加过亮 */
  darkAlpha: number
}

export const HIGHLIGHT_PALETTE: readonly HighlightSpec[] = [
  { id: 'yellow', label: '黄色', hex: '#ffd400', alpha: 0.58, darkAlpha: 0.5 },
  { id: 'green', label: '绿色', hex: '#7ac93c', alpha: 0.55, darkAlpha: 0.48 },
  { id: 'blue', label: '蓝色', hex: '#2f8cff', alpha: 0.52, darkAlpha: 0.46 },
  { id: 'pink', label: '粉色', hex: '#ff5fb0', alpha: 0.5, darkAlpha: 0.44 }
]

/** 旧色值 → 色板 id（历史数据里出现过纯色与略偏的变体） */
const LEGACY: Record<string, HighlightSpec['id']> = {
  '#ffd400': 'yellow',
  '#ffe066': 'yellow',
  '#ffeb3b': 'yellow',
  '#fdd835': 'yellow',
  '#fde68a': 'yellow',
  '#a8e05f': 'green',
  '#8bc34a': 'green',
  '#7cc4ff': 'blue',
  '#4a90e2': 'blue',
  '#3b82f6': 'blue',
  '#ff9bd2': 'pink',
  '#ff69b4': 'pink',
  '#f472b6': 'pink'
}

function normalizeHex(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(s)) return s
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
  }
  return ''
}

/** 任意历史色值 → 色板条目；无法识别时按「黄色高亮」处理但沿用原色相 */
export function resolveHighlight(raw: string | null | undefined): HighlightSpec {
  const hex = normalizeHex(raw ?? '')
  // 先认当前色板：新批注存的就是色板色值，必须拿到该色自己的 alpha，
  // 否则会落到「未知色」分支统一成 0.5，四种颜色的透明度差异就丢了。
  const exact = hex ? HIGHLIGHT_PALETTE.find((c) => c.hex === hex) : undefined
  if (exact) return exact
  const id = hex ? LEGACY[hex] : undefined
  if (id) return HIGHLIGHT_PALETTE.find((c) => c.id === id) ?? HIGHLIGHT_PALETTE[0]
  if (!hex) return HIGHLIGHT_PALETTE[0]
  // 未知色：保留用户原色，透明度取中间值，避免看不见
  return { id: 'yellow', label: '自定义', hex, alpha: 0.5, darkAlpha: 0.46 }
}

/** 新批注可选的色板（顺序与旧 COLORS 一致，便于用户形成肌肉记忆） */
export function highlightColorValues(): string[] {
  return HIGHLIGHT_PALETTE.map((c) => c.hex)
}

/** 悬停/选中/搜索命中的相对增量：集中定义，避免各处 CSS 各调一套 */
export const HIGHLIGHT_STATES = {
  hoverDelta: 0.12,
  activeDelta: 0.16,
  ringAlpha: 0.85
} as const
