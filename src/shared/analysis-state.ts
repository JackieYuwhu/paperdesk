/**
 * 论文拆解面板的「上次查看小节」持久化（纯函数，便于单测）。
 *
 * localStorage 里按附件 key 记录当前高亮的小节索引，下次打开该论文时恢复：
 *  - 读取值可能是脏数据（null / 负数 / 小数 / 非数字），一律回退到 0；
 *  - 恢复时按当前小节数做钳制，避免索引越界。
 */

/** 每篇论文（按附件 key）记录上次查看小节的存储键。 */
export function analysisSectionKey(attKey: string): string {
  return `paperdesk.analysis.lastSection.${attKey}`
}

/** 解析持久化的小节索引；非法（null/负数/非整数）一律回退到 0。 */
export function parseSectionIndex(raw: string | null): number {
  if (raw == null) return 0
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) return 0
  return n
}

/** 把小节索引钳制到 [0, max(0, count - 1)]。 */
export function clampSectionIndex(idx: number, count: number): number {
  const max = Math.max(0, count - 1)
  const n = Number.isInteger(idx) ? idx : 0
  return Math.min(Math.max(n, 0), max)
}
