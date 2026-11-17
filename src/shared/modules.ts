/**
 * 结构化模块层（纯函数 + 类型）。侧车解析 → 上层（阅读器预览/跳转/问答）统一按模块定位。
 *
 * 这里只放**跨进程共享**的类型与选择逻辑，便于单元测试（不依赖 electron）。
 */

import type { BlocksPayload } from './blocks'

export type Rect4 = [number, number, number, number]
export type ModuleType =
  | 'section'
  | 'paragraph'
  | 'figure'
  | 'table'
  | 'caption'
  | 'reference'
  | 'equation'
  | 'theorem'

export interface StructuredModule {
  id: string
  type: ModuleType
  page: number
  /** 栏序号（0=左/单栏，1=右） */
  column: number
  /** 底边原点（y 向上，与 pdf.js 一致） */
  rect: Rect4
  /**
   * 跨块/跨页合并后的**全部**片段（如参考文献续行）。
   * 保护规则必须覆盖每一段，否则后半段会被当成正文翻译。
   */
  rects?: Array<{ page: number; rect: Rect4 }>
  text: string
  size?: number
  n?: number
  letter?: string
  kind?: 'figure' | 'table'
  level?: number
  figureId?: string
  captionIds?: string[]
  refId?: string
}

export interface ModuleCaption {
  page: number
  n: number
  letter: string
  kind: 'figure' | 'table'
  rect: Rect4
  captionId: string
  figureId: string | null
  figureRect: Rect4 | null
}

export interface ModuleRef {
  n: number
  page: number
  text: string
  rect: Rect4
  id: string
}

/** 公式模块：latex 为空表示「未提取/未识别」；latexSource 区分来源 */
export interface FormulaModule {
  id: string
  page: number
  n: string | null
  text: string
  rect: Rect4
  latex: string | null
  latexSource: 'extracted' | 'recognized' | null
  /** 原始文本（低置信度时保留，供人工核对） */
  rawText?: string
  /** 结构树（Fraction/Root/Script/Operator/Matrix） */
  structure?: unknown
  /** 这段内容是否为公式 */
  detectionConfidence?: number
  /** 生成的 LaTeX 是否可靠反映原布局 */
  reconstructionConfidence?: number
  /** accepted=可直接用；needs_review=待复核；failed=未能可靠还原 */
  status?: 'accepted' | 'needs_review' | 'failed'
  extractorVersion?: string
  /** 最终选用的文本（原文 / 结构解析 / 公式 OCR） */
  selectedText?: string | null
  /** 结果来源：original=保留原文，structural=结构解析，formula_ocr=模型/OCR 识别 */
  selectedSource?: 'original' | 'structural' | 'formula_ocr' | null
  /** 回退原因（如 validation_failed / ocr_unavailable） */
  fallbackReason?: string | null
  /** 验证结果（见 shared/formula-validate.ts） */
  validationResults?: unknown
  /** 识别引擎版本 */
  engineVersion?: string | null
}

export interface StructuredDoc {
  pageCount: number
  /** 侧车提取器版本（版本变化 → 缓存失效重算） */
  extractorVersion?: string
  pages: Array<{ page: number; w: number; h: number; rects: Rect4[] }>
  modules: StructuredModule[]
  captions: ModuleCaption[]
  refs: ModuleRef[]
  formulas: FormulaModule[]
  columns: Array<{ page: number; columns: number }>
  counts: {
    modules: number
    captions: number
    figures: number
    tables: number
    references: number
  }
  /**
   * 统一结构化块标注（阶段 B PoC；`blocks.ts`）。
   * **可选字段**：仅当侧车适配层开启（PAPERDESK_BLOCKS_ADAPTER=1）时存在；
   * 老缓存没有该字段视为未启用，消费方一律按可选处理、不得报错。
   */
  blocks?: BlocksPayload
  warnings: string[]
}

/**
 * 按 (编号, 字母, 类型) 选题注。
 * **类型必须一致**（引用「Table 1」不能命中「Figure 1」）；
 * 字母不匹配时退化为「同编号 + 同类型」；类型为 any 时不限类型。
 */
export function pickCaptionModule<T extends Pick<ModuleCaption, 'n' | 'letter' | 'kind'>>(
  caps: T[],
  n: number,
  letter: string,
  kind: 'figure' | 'table' | 'any' = 'any'
): T | null {
  const sameKind = (c: T): boolean => kind === 'any' || c.kind === kind
  const letterEq = (c: T): boolean =>
    !letter || !c.letter || c.letter.toLowerCase() === letter.toLowerCase()
  return (
    caps.find((c) => c.n === n && sameKind(c) && letterEq(c)) ??
    caps.find((c) => c.n === n && sameKind(c)) ??
    null
  )
}

/**
 * 按编号列表选参考文献条目：保持输入顺序、去重、缺项跳过（不猜测）。
 */
export function pickRefModules<T extends Pick<ModuleRef, 'n'>>(refs: T[], nums: number[]): T[] {
  const seen = new Set<number>()
  const out: T[] = []
  for (const n of nums) {
    if (seen.has(n)) continue
    seen.add(n)
    const hit = refs.find((r) => r.n === n)
    if (hit) out.push(hit)
  }
  return out
}

const norm = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/** 可作为引用定位目标的模块类型（有正文内容） */
const CITEABLE = new Set(['paragraph', 'caption', 'reference', 'equation', 'theorem', 'section'])

/**
 * 把「检索命中的文本块」映射到**结构化模块**（同一套定位/关联机制）。
 * 规则：同页、有正文、文本重叠最大（用若干 40 字窗口做包含判定，避免 O(n²) 长匹配）。
 * 返回**按阅读顺序**（栏 → 从上到下）排序的全部命中；不可靠时返回空数组（不猜位置）。
 */
export function matchChunkToModules(
  modules: StructuredModule[],
  page: number,
  chunkText: string
): StructuredModule[] {
  const chunk = norm(chunkText)
  if (!chunk) return []
  const probes: string[] = []
  const win = 40
  const step = Math.max(1, Math.floor((chunk.length - win) / 3) || 1)
  for (let i = 0; i + win <= chunk.length && probes.length < 4; i += step) {
    probes.push(chunk.slice(i, i + win))
  }
  if (!probes.length) probes.push(chunk.slice(0, win))
  const scored: Array<{ m: StructuredModule; score: number }> = []
  for (const m of modules) {
    if (m.page !== page || !CITEABLE.has(m.type)) continue
    const text = norm(m.text)
    if (!text) continue
    let score = 0
    for (const p of probes) {
      if (text.includes(p)) score = Math.max(score, p.length)
      else if (p.includes(text.slice(0, 24)) && text.length >= 24) score = Math.max(score, 24)
    }
    if (score >= 24) scored.push({ m, score })
  }
  // 阅读顺序：栏升序 → 页面上方优先（底边原点里 y1 是上边）
  scored.sort((a, b) => a.m.column - b.m.column || b.m.rect[3] - a.m.rect[3])
  return scored.map((s) => s.m)
}

/** 单条便捷版：取阅读顺序上的第一个命中 */
export function matchChunkToModule(
  modules: StructuredModule[],
  page: number,
  chunkText: string
): StructuredModule | null {
  return matchChunkToModules(modules, page, chunkText)[0] ?? null
}
