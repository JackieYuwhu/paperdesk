/**
 * 「领域调研」：种子论文 → 检索相关论文 → 并发快速拆解 → 多视角智能路由推荐。
 *
 * 这个类型文件独立于 `types.ts`，避免与其它功能同时改动共享类型。
 */

export interface SurveySeed {
  itemId: number
  title: string
  year: number | null
  venue: string | null
  doi: string | null
  /** 种子摘要（供路由理解领域；不展示在 UI） */
  abstract?: string | null
}

export interface SurveyCandidate {
  index: number
  title: string
  year: number | null
  venue: string | null
  doi: string | null
  citedBy: number
  authors: string[]
  oaUrl: string | null
  abstract: string | null
}

/** 单篇「快速拆解卡」：摘要级结构化要点，供路由与展示 */
export interface SurveyCard {
  index: number
  title: string
  problem: string
  method: string
  contribution: string
  evidence: string
  limits: string
  relevance: string
  /** 没有摘要（仅标题/来源），路由时降权 */
  abstractMissing: boolean
}

export interface SurveyRecommendation {
  candidate: SurveyCandidate
  card: SurveyCard | null
  /** 多视角路由合并后的分数（0–100） */
  score: number
  /** 推荐理由（取最高分视角的理由） */
  reason: string
  /** 参与打分的视角 */
  lenses: string[]
}

export interface SurveyTiming {
  discoverMs: number
  enrichMs: number
  analyzeMs: number
  routeMs: number
  totalMs: number
}

export interface SurveyResult {
  query: string
  source: 'google' | 'openalex' | 'semantic' | 'mixed' | string
  warnings: string[]
  seeds: SurveySeed[]
  candidates: SurveyCandidate[]
  /** 成功生成拆解卡的篇数 / 失败篇数 */
  analyzed: number
  failed: number
  recommendations: SurveyRecommendation[]
  timing: SurveyTiming
  /** 本次实际使用的并发（便于排查限流） */
  workers: { analysis: number; router: number }
}

export interface SurveyRunOptions {
  /** 种子条目（文库 items.id）；用于确定领域与检索词 */
  seedItemIds: number[]
  /** 显式检索词；留空则由种子标题自动生成 */
  query?: string
  /** 用户研究方向/关注点（影响拆解与推荐） */
  focus?: string
  /** 最多检索/分析的候选篇数（默认 24，上限 40） */
  limit?: number
  yearFrom?: number | null
  yearTo?: number | null
  /** 检索来源：google=Google Scholar（SerpAPI）；openalex；semantic；auto=先 Google+OpenAlex，空结果回退 Semantic */
  provider?: 'google' | 'openalex' | 'semantic' | 'auto'
  /** 候选排序：recent（默认，最新优先）/ cited（高被引）/ relevance */
  sort?: 'recent' | 'cited' | 'relevance'
  /** 快速拆解并发（默认 24，上限 32） */
  analysisWorkers?: number
  /** 智能路由并发/视角数（默认 4，范围 3–6） */
  routerWorkers?: number
}
