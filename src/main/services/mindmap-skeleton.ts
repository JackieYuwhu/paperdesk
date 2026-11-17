/**
 * 单篇文献 → AI 结构化骨架（PD55）。
 *
 * 这是「主进程薄封装」：取文献标题、把拆解材料交给注册表里的 map-skeleton 动作，
 * 成功得到严格 JSON 树就用 AI 骨架，任何失败（未配置模型 / 非法 JSON / 网络错误）
 * 都回退到规则骨架并把可读原因放进 warnings，绝不把异常抛给调用方。
 */
import { getDb } from '../db'
import { generateStrict } from './llm'
import { runSkeletonTool } from './mindmap-ai-tools'
import {
  buildSkeletonResult,
  type MindmapSkeleton,
  type MindmapSkeletonInput,
  type MindmapSkeletonNode
} from '../../shared/mindmap-skeleton'
import { describeMindmapAiError, type MindmapAiComplete } from '../../shared/mindmap-ai'

export interface GenerateItemSkeletonOptions {
  /** 拆解 markdown；缺省时返回空规则骨架并给出提示 */
  markdown?: string
  /** 显式标题；缺省时查 items.title */
  title?: string | null
  /** 单测/离线场景可关闭 AI，直接走规则骨架 */
  useAi?: boolean
  /** 已切分的要点（可选，规则回退用） */
  points?: ReadonlyArray<{ title: string; body?: string }>
}

function itemTitle(itemId: number): string {
  try {
    const row = getDb().prepare('SELECT title FROM items WHERE id = ?').get(itemId) as
      | { title: string | null }
      | undefined
    const title = typeof row?.title === 'string' ? row.title.trim() : ''
    return title || '未命名文献'
  } catch {
    return '未命名文献'
  }
}

/** 主进程注入的模型调用（temperature 与节点级 AI 保持一致） */
const completeForSkeleton: MindmapAiComplete = async (system, user) => {
  const { text } = await generateStrict({ system, user, temperature: 0.2, session: 'mindmap' })
  return text
}

/**
 * 生成单篇文献的思维地图骨架。
 * 返回 { mode:'ai'|'rule', nodes, warnings }；nodes 含根节点（level 1）。
 */
export async function generateItemSkeleton(
  itemId: number,
  opts: GenerateItemSkeletonOptions = {}
): Promise<MindmapSkeleton> {
  const title = String(opts.title ?? '').trim() || itemTitle(itemId)
  const markdown = String(opts.markdown ?? '')
  const input: MindmapSkeletonInput = {
    title,
    markdown,
    points: opts.points
  }

  if (!markdown.trim()) {
    return buildSkeletonResult(input, null, '拆解材料为空，已生成最小规则骨架；请先在「论文拆解」里生成要点')
  }
  if (opts.useAi === false) {
    return buildSkeletonResult(input, null, '已关闭 AI 骨架，按拆解结构生成规则骨架')
  }

  let aiNodes: MindmapSkeletonNode[] | null = null
  let warning: string | null = null
  try {
    aiNodes = await runSkeletonTool({ skeleton: input }, completeForSkeleton)
    if (!aiNodes) {
      warning = 'AI 返回的骨架结构不完整，已回退到规则骨架'
    }
  } catch (error) {
    warning = `AI 骨架不可用（${describeMindmapAiError(error)}），已回退到规则骨架`
  }
  return buildSkeletonResult(input, aiNodes, warning)
}
