/**
 * 由标题生成锚点 id（best-effort，与常见 Markdown 渲染器对齐）：
 * 去首尾空白、转小写、去掉标点/符号（保留中文等字母数字）、空白转连字符。
 * 供「笔记目录」生成与「笔记预览」标题 id 共同使用，避免两边规则漂移。
 */
export function slugifyHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}
