/**
 * 长文分段 + 模型智能路由（纯函数，无任何依赖）——供 `analysis.ts` 与单元测试共用。
 */

export interface ChunkRow {
  page_index: number | null
  text: string
}

export interface BudgetChunk {
  from: number
  to: number
  text: string
}

/**
 * 按预算把分块切成若干「页段」。
 * 规则：逐块累加，超过预算且当前段非空则先收束；页号（1-based）连续、不倒退。
 */
export function splitByBudget(rows: ChunkRow[], budget: number): BudgetChunk[] {
  const out: BudgetChunk[] = []
  let cur: string[] = []
  let used = 0
  let from = -1
  let to = -1
  const flush = (): void => {
    if (cur.length > 0 && from > 0) out.push({ from, to, text: cur.join('\n').trim() })
    cur = []
    used = 0
    from = -1
  }
  for (const r of rows) {
    const p = (r.page_index ?? 0) + 1
    const piece = `[p.${p}] ${r.text}`
    if (used + piece.length > budget && cur.length > 0) flush()
    if (from < 0) from = p
    to = p
    cur.push(piece)
    used += piece.length + 1
  }
  flush()
  return out
}

/* =========================================================
   模型智能路由（纯函数）
   目标：便宜/快的活交给快速模型，贵/关键的活交给强模型，且
   **质量优先**——「最终成稿」类阶段（合并 / 批次对比 / 单篇一次成稿）
   一律优先强模型，只有「短的分段事实抽取」才降级到快速模型。
   ========================================================= */

/** 拆解的不同阶段（决定路由） */
export type AnalysisPhase = 'segment' | 'merge' | 'compare' | 'single'

/** 短段阈值：分段正文 < 4000 字符视为「短段」，用快速模型 */
export const SHORT_SEGMENT_CHARS = 4000

/** 路由档位：fast（快速模型）/ strong（强模型） */
export type ModelTier = 'fast' | 'strong'

export interface ModelRouteInput {
  phase: AnalysisPhase
  /** 该段正文字符数（仅 segment 阶段有意义） */
  chars?: number
  /** 设置的快速模型（可空 = 用默认模型） */
  fastModel?: string
  /** 设置的强模型（可空 = 用默认模型） */
  strongModel?: string
  /** 默认模型（provider.chatModel；留空表示交给 llm.ts 的兜底） */
  defaultModel?: string
}

/** 该阶段该用哪一档模型（纯规则，便于测试） */
export function modelTierFor(phase: AnalysisPhase, chars = 0): ModelTier {
  // 只有分段事实抽取会因为「段很短」而降级；合并 / 对比 / 成稿都要强模型
  if (phase === 'segment') return chars < SHORT_SEGMENT_CHARS ? 'fast' : 'strong'
  return 'strong'
}

/**
 * 选择本次调用的模型：先按阶段/长度定档，再取值；
 * 该档未配置（留空）则回退默认模型；都为空则返回 ''（由 llm.ts 用默认模型）。
 */
export function chooseAnalysisModel(input: ModelRouteInput): string {
  const tier = modelTierFor(input.phase, input.chars ?? 0)
  const picked = (tier === 'fast' ? input.fastModel : input.strongModel) ?? ''
  const model = picked.trim() || (input.defaultModel ?? '').trim()
  return model
}
