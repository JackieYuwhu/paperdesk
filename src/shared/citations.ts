/**
 * 引用解析（独立模块，三步式）：**类型识别 → 编号解析 → 目标匹配**。
 *
 * 不把所有规则堆成一个长正则：
 *  1. `recognizeCiteTypes`：别名/类型（图/Figure/Fig./表/Table/公式/Equation/Eq./文献/References/节）
 *  2. `parseCiteNumber`：编号（保留字符串，支持 `S3`、`2.1a`、`(2.1a)`、`3–5`、`2a,b`、罗马数字）
 *  3. `resolveCitationTargets`：与文档里的图表题注 / 公式编号 / 参考文献条目匹配
 *
 * 方括号引用单独处理：`[3–5]` 可能是文献引用，`[0,1]` 可能是区间；
 * 由调用方结合上下文（是否有参考文献目标）判断，这里只给出候选。
 */
import type { ModuleCaption, ModuleRef, FormulaModule, Rect4 } from './modules'

export type CiteKind = 'figure' | 'table' | 'equation' | 'reference' | 'section'

const ALIASES: Array<{ kind: CiteKind; re: RegExp }> = [
  { kind: 'figure', re: /(?:figures?|figs?\.?|图|圖)/gi },
  { kind: 'table', re: /(?:tables?|tabs?\.?|表|表格)/gi },
  { kind: 'equation', re: /(?:equations?|eqns?\.?|eqs?\.?|公式|式)/gi },
  { kind: 'reference', re: /(?:references?|refs?\.?|参考文献|文献)/gi },
  { kind: 'section', re: /(?:sections?|secs?\.?|章节|节)/gi }
]

export interface CiteTypeHit {
  kind: CiteKind
  alias: string
  index: number
  length: number
}

/** 步骤 1：识别类型与别名（返回全部命中，含位置，便于按距离取最近的编号） */
export function recognizeCiteTypes(text: string): CiteTypeHit[] {
  const s = String(text ?? '')
  const hits: CiteTypeHit[] = []
  for (const { kind, re } of ALIASES) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
      hits.push({ kind, alias: m[0], index: m.index, length: m[0].length })
    }
  }
  return hits.sort((a, b) => a.index - b.index)
}

export interface CiteNumber {
  /** 原样编号字符串（保留字母后缀与补充材料前缀，避免丢信息） */
  raw: string
  /** 主编号（数字部分，如 "2.1"；纯罗马数字则原样） */
  main: string
  /** 字母后缀（如 2a,b → ["a","b"]） */
  letters: string[]
  /** 子编号后缀（letters 拼接；无则 null） */
  suffix: string | null
  /** 补充材料（S3 / A.1） */
  supplementary: boolean
  /** 数字区间（3–5 → 3..5） */
  start?: number
  end?: number
}

/** 步骤 2：编号解析（输入可带括号/空格/区间/字母后缀） */
export function parseCiteNumber(input: string): CiteNumber | null {
  let s = String(input ?? '').trim()
  if (!s) return null
  s = s.replace(/^[（(\[]\s*/, '').replace(/\s*[)）\]]$/, '').trim()
  // 区间：3–5 / 3-5 / 3 — 5
  const range = /^([A-Za-z]?\d+(?:\.\d+)*)\s*[-–—]\s*([A-Za-z]?\d+(?:\.\d+)*)$/.exec(s)
  if (range) {
    const a = parseCiteNumber(range[1])
    const b = parseCiteNumber(range[2])
    if (a && b && /^\d+$/.test(a.main) && /^\d+$/.test(b.main)) {
      return {
        raw: s,
        main: `${a.main}`,
        letters: [],
        suffix: null,
        supplementary: a.supplementary || b.supplementary,
        start: Number(a.main),
        end: Number(b.main)
      }
    }
    return null
  }
  // 主编号 + 字母后缀：2.1a / 2a,b / S3 / A.1 / IV
  const m = /^([A-Za-z]?\d+(?:\.\d+)*|[IVXLC]+)([a-z](?:\s*,\s*[a-z])*)?$/i.exec(s)
  if (!m) return null
  const main = m[1]
  const letters = (m[2] ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  const supplementary = /^[A-Za-z]/.test(main) && !/^[IVXLC]+$/i.test(main)
  return {
    raw: s,
    main,
    letters,
    suffix: letters.length ? letters.join('') : null,
    supplementary
  }
}

/** 区间展开成具体编号（3–5 → 3,4,5） */
export function expandCiteNumbers(n: CiteNumber): CiteNumber[] {
  if (n.start == null || n.end == null || n.end < n.start || n.end - n.start > 40) return [n]
  const out: CiteNumber[] = []
  for (let k = n.start; k <= n.end; k++) {
    out.push({
      raw: String(k),
      main: String(k),
      letters: [],
      suffix: null,
      supplementary: n.supplementary
    })
  }
  return out
}

export interface CiteRef {
  kind: CiteKind | 'interval'
  number: CiteNumber
  /** 原文片段（展示/回溯用） */
  text: string
  /** 是否来自方括号（需结合上下文判断是文献还是区间） */
  bracket: boolean
  /** 方括号且形如「小数字区间」→ 更可能是数学区间而非文献 */
  likelyInterval?: boolean
}

const BRACKET_RE = /\[([^\]\n]{1,40})\]/g

/**
 * 方括号候选的**识别**（与关联解耦）：
 * `[3–5]`/`[1,3]` → reference 候选；`[0,1]`/`[-1,1]`（全为 0/1 的两个数）→ interval；
 * 其余 → unknown（仍以 reference 候选返回，交给关联阶段决定，**不直接否定身份**）。
 */
export function identifyBracketCitations(text: string): CiteRef[] {
  const s = String(text ?? '')
  const out: CiteRef[] = []
  for (const m of s.matchAll(BRACKET_RE)) {
    const body = m[1]
    if (!/^[\s\d,;–—-]+$/.test(body)) continue
    const parts = body
      .split(/[,;]/)
      .map((x) => x.trim())
      .filter(Boolean)
    const nums = parts.map((p) => parseCiteNumber(p)).filter((x): x is CiteNumber => !!x)
    if (!nums.length) continue
    const allSmall = nums.length === 2 && nums.every((n) => /^\d+$/.test(n.main) && Number(n.main) <= 1)
    const isInterval = allSmall || /[-–—]/.test(body)
    for (let i = 0; i < nums.length; i++) {
      out.push({
        kind: isInterval && allSmall ? 'interval' : 'reference',
        number: nums[i],
        text: `[${parts[i] ?? nums[i].raw}]`,
        bracket: true,
        likelyInterval: isInterval
      })
    }
  }
  return out
}

/** 步骤 1+2：解析查询里的全部引用（类型 + 编号 + 方括号候选） */
export function parseCitations(query: string): CiteRef[] {
  const s = String(query ?? '')
  const out: CiteRef[] = []
  const types = recognizeCiteTypes(s)
  for (const t of types) {
    // 取类型词之后最近的编号（允许 "Fig. 3"、"图3"、"Equation (2.1a)"）
    const tail = s.slice(t.index + t.length, t.index + t.length + 24)
    const m = /^\s*[.．:：]?\s*[（(\[]?\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?(?:\s*,\s*[a-z])?|[IVXLC]+)\s*[)）\]]?/.exec(
      tail
    )
    if (!m) continue
    const num = parseCiteNumber(m[1])
    if (!num) continue
    out.push({ kind: t.kind, number: num, text: `${t.alias} ${m[1]}`, bracket: false })
  }
  out.push(...identifyBracketCitations(s))
  return out
}

export interface StructuralRefs {
  figures: Array<{ n: number; letter: string; kind: 'figure' | 'table' }>
  refs: number[]
  formulas: string[]
}

/**
 * 兼容入口：从提问里识别「结构性引用」：图 3 / Table 2 / [1,3] / 公式 (5)。
 * 委托给三步式引用解析（`recognizeCiteTypes` → `parseCiteNumber` → 聚合）。
 */
export function detectStructuralRefs(query: string): StructuralRefs {
  const parsed = parseCitations(query)
  const figures: StructuralRefs['figures'] = []
  const refs: number[] = []
  const formulas: string[] = []
  for (const r of parsed) {
    if (r.kind === 'figure' || r.kind === 'table') {
      if (!/^\d+$/.test(r.number.main)) continue
      figures.push({ n: Number(r.number.main), letter: r.number.letters[0] ?? '', kind: r.kind })
    } else if (r.kind === 'reference') {
      for (const x of expandCiteNumbers(r.number)) {
        if (/^\d+$/.test(x.main)) refs.push(Number(x.main))
      }
    } else if (r.kind === 'equation') {
      formulas.push(r.number.main)
    }
  }
  const dedupF = figures.filter(
    (f, i) => figures.findIndex((x) => x.n === f.n && x.letter === f.letter && x.kind === f.kind) === i
  )
  return { figures: dedupF, refs: Array.from(new Set(refs)), formulas: Array.from(new Set(formulas)) }
}

export interface CiteTarget {
  kind: CiteKind
  moduleId: string
  page: number
  rect: Rect4 | null
  label: string
  text: string
}

export interface CiteDoc {
  captions: ModuleCaption[]
  refs: ModuleRef[]
  formulas: FormulaModule[]
  modules: Array<{ id: string; text: string }>
}

/** 步骤 3：与文档目标匹配（图/表题注、公式编号、参考文献条目） */
export function resolveCitationTargets(doc: CiteDoc, refs: CiteRef[]): CiteTarget[] {
  return associateCitations(doc, refs).targets
}

/**
 * 步骤 3（关联）：匹配目标；**找不到时保留为 unresolved**（不否定其引用身份）。
 * `interval` 类候选不参与关联（数学区间）。
 */
export function associateCitations(
  doc: CiteDoc,
  refs: CiteRef[]
): { targets: CiteTarget[]; unresolved: CiteRef[] } {
  const out: CiteTarget[] = []
  const unresolved: CiteRef[] = []
  const seen = new Set<string>()
  const push = (t: CiteTarget): void => {
    const key = `${t.kind}:${t.moduleId}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(t)
  }
  for (const r of refs) {
    if (r.kind === 'interval') continue
    const nums = expandCiteNumbers(r.number)
    let hitAny = false
    if (r.kind === 'figure' || r.kind === 'table') {
      for (const n of nums) {
        if (!/^\d+$/.test(n.main)) continue
        const want = Number(n.main)
        const cap = doc.captions.find(
          (c) =>
            c.n === want &&
            c.kind === r.kind &&
            (n.letters.length === 0 || n.letters.some((L) => !c.letter || c.letter === L))
        )
        if (!cap) continue
        const capMod = doc.modules.find((m) => m.id === cap.captionId)
        const label = `${r.kind === 'table' ? '表' : '图'} ${cap.n}${cap.letter}`
        push({
          kind: r.kind,
          moduleId: cap.figureId ?? cap.captionId,
          page: cap.page,
          rect: cap.figureRect ?? cap.rect,
          label,
          text: `${label}${capMod?.text ? `：${capMod.text}` : ''}`
        })
        hitAny = true
      }
    } else if (r.kind === 'reference') {
      for (const n of nums) {
        if (!/^\d+$/.test(n.main)) continue
        const hit = doc.refs.find((x) => x.n === Number(n.main))
        if (!hit) continue
        push({
          kind: 'reference',
          moduleId: hit.id,
          page: hit.page,
          rect: hit.rect,
          label: `[${hit.n}]`,
          text: hit.text
        })
        hitAny = true
      }
    } else if (r.kind === 'equation') {
      const hit = doc.formulas.find((f) => f.n != null && f.n === r.number.main)
      if (hit) {
        push({
          kind: 'equation',
          moduleId: hit.id,
          page: hit.page,
          rect: hit.rect,
          label: `公式 ${hit.n}`,
          text: `公式 ${hit.n}${hit.text ? `：${hit.text}` : ''}${hit.latex ? `\nLaTeX: ${hit.latex}` : ''}`
        })
        hitAny = true
      }
    }
    if (!hitAny) unresolved.push(r)
  }
  return { targets: out, unresolved }
}
