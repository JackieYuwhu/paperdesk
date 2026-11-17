/**
 * 思维地图 AI 工具注册表（PD55）：
 * 所有节点级 AI 动作的 prompt、解析、前置校验都集中在这里，调用点不允许自己拼 prompt。
 *
 * 本文件刻意不 import `./llm`：调用方（主进程服务 / 单测）把 `complete` 注入进来，
 * 这样 registry 可以在没有 API Key、没有 Electron 的环境里被单测完整覆盖。
 */
// @ts-expect-error TS5097：单测用 `node scripts/test-unit.ts` 直接加载本文件，Node ESM 需要显式扩展名
import { MindmapAiError, MINDMAP_MAP_OPTIMIZE_MIN_GROUPS, buildExpandPrompt, buildMapOptimizePrompt, buildOptimizePrompt, buildSummaryPrompt, buildSupportPrompt, parseExpansionResult, parseMapOptimizeResult, parseOptimizeResult, parseSupportResult, parseSummaryResult, type MindmapAiComplete, type MindmapMapOptimizeResult, type MindmapMapPromptContext, type MindmapOptimizeResult, type MindmapPassage, type MindmapPrompt, type MindmapPromptContext, type MindmapSupportResult } from '../../shared/mindmap-ai.ts'
// @ts-expect-error TS5097：单测用 `node scripts/test-unit.ts` 直接加载本文件，Node ESM 需要显式扩展名
import { buildSkeletonPrompt, parseSkeletonAiResult, type MindmapSkeletonInput, type MindmapSkeletonNode } from '../../shared/mindmap-skeleton.ts'

/** 思维地图允许的 AI 动作（与 shared/ai-tools.ts 的细粒度条目一一对应） */
export type MindmapAiToolId =
  | 'map-skeleton'
  | 'map-optimize'
  | 'node-summarize'
  | 'node-optimize'
  | 'node-expand'
  | 'node-support'

/** 注册表输入：按动作取用其中一部分字段 */
export interface MindmapAiToolInput {
  ctx?: MindmapPromptContext
  map?: MindmapMapPromptContext
  skeleton?: MindmapSkeletonInput
  passages?: MindmapPassage[]
}

export interface MindmapAiToolDefinition<TResult = unknown> {
  id: MindmapAiToolId
  title: string
  /** 该动作依赖的 AI 能力（与 AI_TOOLS.requires 对齐） */
  requires: 'model'
  promptBuilder: (input: MindmapAiToolInput) => MindmapPrompt
  parse: (raw: string, input: MindmapAiToolInput) => TResult
  /** 返回可读中文原因表示不满足前置条件；null 表示可以调用 */
  guard: (input: MindmapAiToolInput) => string | null
}

function needCtx(input: MindmapAiToolInput): MindmapPromptContext {
  if (!input?.ctx) throw new MindmapAiError('bad-response', '缺少思维地图上下文，无法调用 AI')
  return input.ctx
}

function needSkeleton(input: MindmapAiToolInput): MindmapSkeletonInput {
  if (!input?.skeleton) throw new MindmapAiError('bad-response', '缺少拆解材料，无法生成骨架')
  return input.skeleton
}

function needMap(input: MindmapAiToolInput): MindmapMapPromptContext {
  if (!input?.map) throw new MindmapAiError('bad-response', '缺少地图大纲，无法优化整图')
  return input.map
}

const SKELETON_TOOL: MindmapAiToolDefinition<MindmapSkeletonNode[] | null> = {
  id: 'map-skeleton',
  title: 'AI 结构化骨架',
  requires: 'model',
  promptBuilder: (input) => buildSkeletonPrompt(needSkeleton(input)),
  parse: (raw, input) => parseSkeletonAiResult(raw, needSkeleton(input)),
  guard: (input) => {
    const skeleton = input?.skeleton
    if (!skeleton) return '缺少拆解材料，无法生成骨架'
    if (!String(skeleton.markdown ?? '').trim()) return '拆解材料为空，已改用规则骨架'
    return null
  }
}

const SUMMARIZE_TOOL: MindmapAiToolDefinition<{ summary: string }> = {
  id: 'node-summarize',
  title: 'AI 摘要',
  requires: 'model',
  promptBuilder: (input) => buildSummaryPrompt(needCtx(input)),
  parse: (raw) => {
    const summary = parseSummaryResult(raw)
    if (!summary) throw new MindmapAiError('bad-response', 'AI 没有返回可用的摘要，请重试')
    return { summary }
  },
  guard: (input) => (input?.ctx ? null : '请先在思维地图里选中一个节点')
}

const OPTIMIZE_TOOL: MindmapAiToolDefinition<MindmapOptimizeResult> = {
  id: 'node-optimize',
  title: 'AI 优化结构',
  requires: 'model',
  promptBuilder: (input) => buildOptimizePrompt(needCtx(input)),
  parse: (raw) => {
    const result = parseOptimizeResult(raw)
    // 与 optimizeMindMapNode 保持同一口径：精简措辞 / 子节点 / 分组，任一可用即可。
    const hasChange =
      result.topics.length >= 2 ||
      (result.summary != null && result.summary.length > 0) ||
      (result.children?.length ?? 0) > 0
    if (!hasChange) {
      throw new MindmapAiError('bad-response', 'AI 没有给出可用的优化建议，请重试或先补充子节点')
    }
    return result
  },
  guard: (input) => {
    if (!input?.ctx) return '请先在思维地图里选中一个节点'
    return null
  }
}

/** 整图优化（PD58）：看整张地图的大纲重新分组，不需要先选中节点 */
const MAP_OPTIMIZE_TOOL: MindmapAiToolDefinition<MindmapMapOptimizeResult> = {
  id: 'map-optimize',
  title: 'AI 优化整图',
  requires: 'model',
  promptBuilder: (input) => buildMapOptimizePrompt(needMap(input)),
  parse: (raw) => {
    const result = parseMapOptimizeResult(raw)
    if (result.groups.length < MINDMAP_MAP_OPTIMIZE_MIN_GROUPS) {
      throw new MindmapAiError(
        'bad-response',
        `AI 只给出了 ${result.groups.length} 个可用分组（至少需要 ${MINDMAP_MAP_OPTIMIZE_MIN_GROUPS} 个），请重试`
      )
    }
    return result
  },
  guard: (input) => {
    if (!input?.map) return '这张地图还没有内容，先「从论文结构生成骨架」再优化'
    if (!String(input.map.outline ?? '').trim()) return '这张地图还没有内容，先「从论文结构生成骨架」再优化'
    return null
  }
}

const EXPAND_TOOL: MindmapAiToolDefinition<{ texts: string[] }> = {
  id: 'node-expand',
  title: 'AI 展开子节点',
  requires: 'model',
  promptBuilder: (input) => buildExpandPrompt(needCtx(input)),
  parse: (raw) => {
    const texts = parseExpansionResult(raw)
    if (texts.length < 2) {
      throw new MindmapAiError('bad-response', 'AI 没有给出 2–4 个可用的子节点，请重试或换个节点')
    }
    return { texts }
  },
  guard: (input) => (input?.ctx ? null : '请先在思维地图里选中一个节点')
}

const SUPPORT_TOOL: MindmapAiToolDefinition<MindmapSupportResult> = {
  id: 'node-support',
  title: 'AI 找支撑段落',
  requires: 'model',
  promptBuilder: (input) => buildSupportPrompt(needCtx(input)),
  parse: (raw, input) => {
    const ctx = needCtx(input)
    return parseSupportResult(raw, input?.passages ?? ctx.passages)
  },
  guard: (input) => {
    if (!input?.ctx) return '请先在思维地图里选中一个节点'
    const passages = input.passages ?? input.ctx.passages
    if (!passages.some((passage) => (passage.text ?? '').trim())) {
      return '未找到：这篇文献还没有可用的原文片段（可能尚未解析正文）'
    }
    return null
  }
}

/** 唯一注册表：新增动作只允许在这里加，再补 shared/ai-tools.ts 条目与文档 */
export const MINDMAP_AI_TOOLS: Record<MindmapAiToolId, MindmapAiToolDefinition> = {
  'map-skeleton': SKELETON_TOOL as MindmapAiToolDefinition,
  'map-optimize': MAP_OPTIMIZE_TOOL as MindmapAiToolDefinition,
  'node-summarize': SUMMARIZE_TOOL as MindmapAiToolDefinition,
  'node-optimize': OPTIMIZE_TOOL as MindmapAiToolDefinition,
  'node-expand': EXPAND_TOOL as MindmapAiToolDefinition,
  'node-support': SUPPORT_TOOL as MindmapAiToolDefinition
}

export const MINDMAP_AI_TOOL_IDS = Object.keys(MINDMAP_AI_TOOLS) as MindmapAiToolId[]

export function getMindmapAiTool(id: string): MindmapAiToolDefinition | null {
  return Object.prototype.hasOwnProperty.call(MINDMAP_AI_TOOLS, id)
    ? MINDMAP_AI_TOOLS[id as MindmapAiToolId]
    : null
}

/**
 * 统一执行入口：guard → promptBuilder → complete → parse。
 * 失败抛 MindmapAiError（带可读中文 message），由各调用点决定回退或提示。
 */
export async function runMindmapAiTool<T = unknown>(
  id: MindmapAiToolId,
  input: MindmapAiToolInput,
  complete: MindmapAiComplete
): Promise<T> {
  const tool = getMindmapAiTool(id) as MindmapAiToolDefinition<T> | null
  if (!tool) throw new MindmapAiError('bad-response', `未知的思维地图 AI 动作：${id}`)
  const blocked = tool.guard(input)
  if (blocked) throw new MindmapAiError('bad-response', blocked)
  let raw: string
  const prompt = tool.promptBuilder(input)
  try {
    raw = await complete(prompt.system, prompt.user)
  } catch (error) {
    if (error instanceof MindmapAiError) throw error
    throw new MindmapAiError(
      'request-failed',
      error instanceof Error ? error.message : 'AI 调用失败：请稍后重试'
    )
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new MindmapAiError('bad-response', 'AI 返回了空内容，请重试')
  }
  return tool.parse(raw, input)
}

/** 类型化包装：调用点只关心动作名，不再自己拼 prompt */
export function runSkeletonTool(
  input: MindmapAiToolInput,
  complete: MindmapAiComplete
): Promise<MindmapSkeletonNode[] | null> {
  return runMindmapAiTool<MindmapSkeletonNode[] | null>('map-skeleton', input, complete)
}

export function runSummarizeTool(
  input: MindmapAiToolInput,
  complete: MindmapAiComplete
): Promise<{ summary: string }> {
  return runMindmapAiTool<{ summary: string }>('node-summarize', input, complete)
}

export function runOptimizeTool(
  input: MindmapAiToolInput,
  complete: MindmapAiComplete
): Promise<MindmapOptimizeResult> {
  return runMindmapAiTool<MindmapOptimizeResult>('node-optimize', input, complete)
}

export function runMapOptimizeTool(
  input: MindmapAiToolInput,
  complete: MindmapAiComplete
): Promise<MindmapMapOptimizeResult> {
  return runMindmapAiTool<MindmapMapOptimizeResult>('map-optimize', input, complete)
}

export function runExpandTool(
  input: MindmapAiToolInput,
  complete: MindmapAiComplete
): Promise<{ texts: string[] }> {
  return runMindmapAiTool<{ texts: string[] }>('node-expand', input, complete)
}

export function runSupportTool(
  input: MindmapAiToolInput,
  complete: MindmapAiComplete
): Promise<MindmapSupportResult> {
  return runMindmapAiTool<MindmapSupportResult>('node-support', input, complete)
}
