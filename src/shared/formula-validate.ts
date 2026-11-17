/**
 * 公式候选结果的**验证**（纯函数，可单测）。
 *
 * 原则（按评审意见）：**能渲染只能证明语法基本成立，不能证明识别正确**。
 * 因此这里检查的是「候选是否可信」的可验证信号：
 *   · 花括号 / 括号 / `\begin-\end` 是否配对
 *   · 乱码与非法控制字符比例
 *   · **关键符号是否遗漏**（原文里的数学符号/希腊字母在候选里应能找到对应）
 *   · 是否为空 / 是否含明显的非 LaTeX 片段
 * 验证不通过 → 保留原文并标记待复核，**不覆盖**。
 */

/** Unicode 数学符号 → LaTeX 命令（与侧车 formula.py 保持一致） */
export const MATH_CMD: Record<string, string> = {
  '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∮': '\\oint', '√': '\\sqrt',
  '≈': '\\approx', '≠': '\\neq', '≤': '\\leq', '≥': '\\geq', '≡': '\\equiv',
  '×': '\\times', '÷': '\\div', '·': '\\cdot', '⋅': '\\cdot', '±': '\\pm',
  '∈': '\\in', '∉': '\\notin', '⊂': '\\subset', '⊆': '\\subseteq',
  '∪': '\\cup', '∩': '\\cap', '∀': '\\forall', '∃': '\\exists',
  '∞': '\\infty', '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow', '⇔': '\\Leftrightarrow', '∂': '\\partial',
  '∇': '\\nabla', '∝': '\\propto', '∼': '\\sim',
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\epsilon',
  ζ: '\\zeta', η: '\\eta', θ: '\\theta', κ: '\\kappa', λ: '\\lambda',
  μ: '\\mu', ν: '\\nu', ξ: '\\xi', π: '\\pi', ρ: '\\rho', σ: '\\sigma',
  τ: '\\tau', φ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi',
  Π: '\\Pi', Σ: '\\Sigma', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega'
}

/** 关键符号（遗漏这些基本可判定识别失败） */
const KEY_SYMBOLS = Object.keys(MATH_CMD)

export interface FormulaValidation {
  ok: boolean
  issues: string[]
  /** 原文里有、候选里找不到对应的关键符号 */
  missingSymbols: string[]
  balanced: boolean
  garbleRatio: number
}

const BAD_RE = /[\ufffd\ue000-\uf8ff\u0000-\u0008\u000b-\u001f]/g

function countChar(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n++
  return n
}

/** 花括号 / 圆括号 / 方括号 / \begin-\end 是否配对 */
export function isBalanced(latex: string): boolean {
  const pairs: Array<[string, string]> = [
    ['{', '}'],
    ['(', ')'],
    ['[', ']']
  ]
  for (const [a, b] of pairs) {
    if (countChar(latex, a) !== countChar(latex, b)) return false
  }
  const begins = latex.match(/\\begin\{[^}]+\}/g) ?? []
  const ends = latex.match(/\\end\{[^}]+\}/g) ?? []
  if (begins.length !== ends.length) return false
  for (let i = 0; i < begins.length; i++) {
    const env = /\\begin\{([^}]+)\}/.exec(begins[i])?.[1]
    if (!ends.some((e) => e.includes(`{${env}}`))) return false
  }
  if (countChar(latex, '$') % 2 !== 0) return false
  return true
}

/** 校验候选 LaTeX 是否可信 */
export function validateFormulaLatex(raw: string, latex: string): FormulaValidation {
  const issues: string[] = []
  const src = String(raw ?? '')
  const cand = String(latex ?? '').trim()
  const garbleRatio = src ? (src.match(BAD_RE)?.length ?? 0) / Math.max(1, src.length) : 1

  if (!cand) issues.push('候选为空')
  const balanced = cand ? isBalanced(cand) : false
  if (cand && !balanced) issues.push('括号/环境不配对')
  if (garbleRatio > 0.2) issues.push('原文乱码比例过高')
  if (/[\u0000-\u0008\u000b-\u001f]/.test(cand)) issues.push('候选含非法控制字符')

  // 关键符号遗漏：原文里的数学符号应在候选里有对应命令/字符
  const missing: string[] = []
  for (const sym of KEY_SYMBOLS) {
    if (!src.includes(sym)) continue
    const cmd = MATH_CMD[sym]
    if (!cand.includes(cmd) && !cand.includes(sym)) missing.push(sym)
  }
  if (missing.length) issues.push(`关键符号遗漏：${missing.join(' ')}`)

  return {
    ok: issues.length === 0 && !!cand,
    issues,
    missingSymbols: missing,
    balanced,
    garbleRatio: Number(garbleRatio.toFixed(3))
  }
}
