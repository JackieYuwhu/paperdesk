/**
 * 把论文标题变成可读、跨平台安全的文件名主干。
 * 保留中文/英文字母与常见符号，去掉 Windows 禁用字符；过长时优先在空格处截断。
 */
export function safeBatchStem(text: string, max = 96): string {
  const cleaned = String(text || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  const sliced = cleaned.slice(0, max)
  const wordBreak = sliced.lastIndexOf(' ')
  const clipped = (wordBreak >= max * 0.6 ? sliced.slice(0, wordBreak) : sliced)
    .trim()
    .replace(/[. ]+$/g, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clipped)) return `${clipped}_`
  return clipped || '未命名论文'
}
