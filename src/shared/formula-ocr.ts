/**
 * 公式识别（OCR）**候选引擎注册表与选择**（纯逻辑，可单测）。
 *
 * 关键原则（按评审意见）：
 *  · 不同识别器的置信度**不可直接比较** → 各自记录，按引擎分别设阈值校准；
 *  · "调用成功" ≠ "识别成功" → 候选必须通过验证（`formula-validate`）才可能被选用；
 *  · 选不出可信候选时**保留原文**并标记待复核。
 */
import type { FormulaValidation } from './formula-validate'

export interface OcrCandidate {
  /** 引擎 id（vision / pix2tex / mock …） */
  engine: string
  /** 引擎版本（用于缓存失效与回溯） */
  engineVersion: string
  latex: string
  /** **该引擎自己的**置信度（无则 null；不与其他引擎比较） */
  confidence: number | null
  validation: FormulaValidation | null
}

/** 每个引擎的接受阈值（先用保守默认值，后续用真实评测集校准） */
export const DEFAULT_THRESHOLDS: Record<string, number> = {
  vision: 0.6,
  pix2tex: 0.75,
  mock: 0.5
}

/** 引擎优先级（先试更可靠的） */
export const ENGINE_ORDER = ['pix2tex', 'vision', 'mock']

/** 由验证结果推导一个**结构性**置信度（0–1），用于没有自报置信度的引擎 */
export function deriveStructuralConfidence(v: FormulaValidation | null): number {
  if (!v) return 0
  let s = 1
  if (!v.balanced) s -= 0.4
  s -= Math.min(0.4, v.garbleRatio * 0.8)
  s -= Math.min(0.3, v.missingSymbols.length * 0.15)
  return Math.max(0, Number(s.toFixed(3)))
}

export interface PickResult {
  chosen: OcrCandidate | null
  /** 被拒绝的候选及原因（供 UI 展示/回溯） */
  rejected: Array<{ engine: string; reason: string }>
}

/**
 * 从多个引擎的候选中**选一个可信的**：
 * 按优先级排序；要求 验证通过 且 该引擎置信度 ≥ 阈值（自报置信度缺失时用结构置信度兜底）。
 */
export function pickCandidate(
  candidates: OcrCandidate[],
  thresholds: Record<string, number> = DEFAULT_THRESHOLDS
): PickResult {
  const rejected: Array<{ engine: string; reason: string }> = []
  const rank = (e: string): number => {
    const i = ENGINE_ORDER.indexOf(e)
    return i < 0 ? ENGINE_ORDER.length : i
  }
  const sorted = [...candidates].sort((a, b) => rank(a.engine) - rank(b.engine))
  for (const c of sorted) {
    if (!c.latex || !c.latex.trim()) {
      rejected.push({ engine: c.engine, reason: 'empty' })
      continue
    }
    if (c.validation && !c.validation.ok) {
      rejected.push({ engine: c.engine, reason: `validation: ${c.validation.issues.join('; ')}` })
      continue
    }
    const conf = c.confidence ?? deriveStructuralConfidence(c.validation)
    const th = thresholds[c.engine] ?? 0.6
    if (conf < th) {
      rejected.push({ engine: c.engine, reason: `below_threshold(${conf.toFixed(2)}<${th})` })
      continue
    }
    return { chosen: c, rejected }
  }
  return { chosen: null, rejected }
}
