import type {
  KnowledgeEvidenceInput,
  KnowledgeEvidenceLink,
  KnowledgeEvidencePrecision
} from '@shared/types'

/**
 * 证据精度文案（PD40）。
 *
 * 精度只在「模块 id + 模块正文字符区间」同时成立时才是 module，否则按实际定位
 * 降级为 page / message / document。UI 必须如实写出「页级证据」，不能让用户
 * 误以为定位到了段落。这里与主进程 knowledge.ts::derivePrecision 保持同一判定。
 */

type PrecisionEvidence = Pick<
  KnowledgeEvidenceInput | KnowledgeEvidenceLink,
  'precision'
> & {
  pageIndex?: number | null
  moduleId?: string | null
  charStart?: number | null
  charEnd?: number | null
}

export type EvidencePrecisionTone = 'ok' | 'warn' | 'muted'

function hasModuleSpan(evidence: PrecisionEvidence): boolean {
  // 已发布链接（KnowledgeEvidenceLink）历史上不向渲染层暴露字符区间：
  // 两方面都 undefined 时以主进程已固化的 precision 为准（写入时已校验过区间）；
  // 明确给 null 则表示「确实没有区间」，必须降级。
  if (evidence.charStart === undefined && evidence.charEnd === undefined) return true
  return (
    Boolean(evidence.moduleId) &&
    evidence.charStart !== null &&
    evidence.charStart !== undefined &&
    evidence.charEnd !== null &&
    evidence.charEnd !== undefined &&
    evidence.charEnd > evidence.charStart
  )
}

/** 返回可直接渲染的中文精度标签；document 不显示（避免噪音）。 */
export function evidencePrecisionLabel(evidence: PrecisionEvidence): string | null {
  const precision: KnowledgeEvidencePrecision | null | undefined = evidence.precision
  if (precision === 'module') {
    if (hasModuleSpan(evidence)) return '模块级证据'
    return evidence.pageIndex !== null && evidence.pageIndex !== undefined ? '页级证据' : null
  }
  if (precision === 'page') return '页级证据'
  if (precision === 'message') return '对话级证据'
  return null
}

export function evidencePrecisionTone(evidence: PrecisionEvidence): EvidencePrecisionTone {
  const label = evidencePrecisionLabel(evidence)
  if (label === '模块级证据') return 'ok'
  if (label === '页级证据') return 'warn'
  return 'muted'
}
