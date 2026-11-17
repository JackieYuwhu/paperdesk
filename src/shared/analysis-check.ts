/**
 * 拆解结果的「证据自检」（纯函数，无依赖，便于单元测试）。
 *
 * 目的：把「关键结论是否带原文定位」变成可量化、可展示的东西——
 * 技能里要求 `[p.N]/[§x]/[Fig.N]/[Tab.N]/[Eq.N]`，这里做一次确定性体检。
 */

export interface AnalysisQuality {
  /** 出现的定位标记总数 */
  locators: number
  /** 非空行数 */
  lines: number
  /** 疑似「结论/事实」的行数（含数字或结论性措辞） */
  claims: number
  /** 其中带定位的行数 */
  claimsWithLocator: number
  /** 平均每千字的定位数 */
  density: number
  /** 缺少定位的结论行（最多 8 条，已截断） */
  missing: string[]
  /** 识别到的小节编号 */
  sections: number[]
}

const LOCATOR_RE = /\[(?:p\.\d+|§\s*[\d.]+|Fig\.?\s*\d+|Tab(?:le)?\.?\s*\d+|Eq\.?\(?\d+\)?)\]/i
const CLAIM_WORDS =
  /(表明|说明|证明|提出|发现|提升|降低|优于|相比|超过|达到|显著|相关|因果|outperform|achiev|improv|reduc|increase|suggest|show|demonstrat|propos|indicate)/i

/** 判定某行是否是「结论/事实」行：带数字，或含结论性措辞 */
function looksLikeClaim(line: string): boolean {
  const t = line.replace(/^[-*+]\s*/, '').trim()
  if (t.length < 8) return false
  if (/\d/.test(t)) return true
  return CLAIM_WORDS.test(t)
}

export function checkAnalysis(markdown: string): AnalysisQuality {
  const md = String(markdown ?? '')
  const locators = (md.match(/\[(?:p\.\d+|§\s*[\d.]+|Fig\.?\s*\d+|Tab(?:le)?\.?\s*\d+|Eq\.?\(?\d+\)?)\]/gi) ?? [])
    .length
  const rawLines = md.split(/\r?\n/)
  const lines = rawLines.filter((l) => l.trim().length > 0).length

  const sections: number[] = []
  let claims = 0
  let claimsWithLocator = 0
  const missing: string[] = []
  let inCode = false
  for (const raw of rawLines) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    const m = /^###\s+(\d+)\b/.exec(line)
    if (m) {
      const n = Number(m[1])
      if (n >= 1 && n <= 8 && !sections.includes(n)) sections.push(n)
      continue
    }
    if (/^#{1,6}\s/.test(line)) continue // 标题不算结论行
    if (!looksLikeClaim(line)) continue
    claims++
    if (LOCATOR_RE.test(line)) {
      claimsWithLocator++
    } else if (missing.length < 8) {
      missing.push(line.replace(/^[-*+]\s*/, '').slice(0, 90))
    }
  }
  const density = md.length > 0 ? Math.round((locators / (md.length / 1000)) * 10) / 10 : 0
  return { locators, lines, claims, claimsWithLocator, density, missing, sections: sections.sort((a, b) => a - b) }
}

/** 供面板/报告展示的一行摘要 */
export function formatQuality(q: AnalysisQuality): string {
  const pct = q.claims > 0 ? Math.round((q.claimsWithLocator / q.claims) * 100) : 0
  return `定位 ${q.locators} 处 · 结论行 ${q.claims} 条（${q.claimsWithLocator} 条带定位，${pct}%）· 密度 ${q.density}/千字`
}

/** 「总览」表格的表头（跨批累积用） */
export const OVERVIEW_HEADER = '| 批次 | 时间 | 篇数 | 篇幅 | 维度 | 定位/结论 |'
export const OVERVIEW_SEP = '|---|---|---|---|---|---|'

/**
 * 在「总览」表格片段末尾追加一行（空则生成表头）。纯函数，便于单测。
 */
export function appendOverviewRow(existing: string, row: string[]): string {
  const kept = String(existing ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .filter((l) => !/^\|\s*-{2,}/.test(l) && !/批次\s*\|/.test(l))
  return [OVERVIEW_HEADER, OVERVIEW_SEP, ...kept, `| ${row.join(' | ')} |`].join('\n')
}
