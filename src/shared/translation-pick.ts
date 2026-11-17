import type { Translation } from './types'

/**
 * 选择要展示的译文：优先用刚查询到的结果，查询为空时回退到缓存。
 * 用于附件切换/重新查询期间，避免瞬时空结果把「原文 / 译文 / 对照」按钮清掉。
 */
export function pickTranslation(
  cached: Translation | null,
  fetched: Translation | null
): Translation | null {
  return fetched ?? cached
}
