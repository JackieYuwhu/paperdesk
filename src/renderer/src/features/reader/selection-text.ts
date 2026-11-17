/**
 * 划词文本清理：PDF 文本层会把同一个字形画成多个重叠 span（MathML/公式区尤其明显），
 * 浏览器原生 selection.toString() 因此会输出成对重复的符号（𝒯𝒯、𝒫𝒫、𝒪𝒪𝒪），
 * 复制出来的文本与用户实际看到的选区不一致。
 *
 * 这里只处理**数学字母数字符号**（U+1D400–U+1D7FF，即 𝒯/𝒫/𝒪 这类）的相邻重复：
 * 普通文本里连续两个相同字符是合法的（"11"、"coo"、"a a"），不能一概去重。
 */

const MATH_ALNUM_START = 0x1d400
const MATH_ALNUM_END = 0x1d7ff

function isMathAlnum(ch: string): boolean {
  const cp = ch.codePointAt(0)
  return cp !== undefined && cp >= MATH_ALNUM_START && cp <= MATH_ALNUM_END
}

/**
 * 去掉数学符号被文本层重复绘制造成的连续重复（𝒯𝒯 → 𝒯，𝒪𝒪𝒪 → 𝒪）。
 * 连续三个以上同类符号也会收敛成一个：选区里这些字符本来就是同一个字。
 */
export function dedupeMathGlyphs(text: string): string {
  if (!text) return text
  const chars = Array.from(text)
  const out: string[] = []
  for (const ch of chars) {
    const prev = out[out.length - 1]
    if (prev !== undefined && prev === ch && isMathAlnum(ch)) continue
    out.push(ch)
  }
  return out.join('')
}

/** 复制/高亮/浮层预览共用的选区文本清理入口。 */
export function normalizeSelectionText(text: string): string {
  return dedupeMathGlyphs(text).replace(/\s+$/g, '')
}
