import type {
  CreateKnowledgeProposalInput,
  KnowledgeProposalSummary
} from '../../shared/types'
import type { KnowledgeDb } from './knowledge'

/**
 * 知识库 AI 工具适配层（PD33）。
 *
 * 硬边界（docs/KNOWLEDGE-DESIGN.md §8.4）：
 *   - 这里**只有**「提议新增知识」「提议修改知识」两个工具，AI 永远只能写提案；
 *   - 不 import 任何 IPC / 发布代码，不导出 publish / delete / sql / file / secret 入口；
 *   - 入参是**严格白名单**：出现 contentNature（AI 不得自称 user_decision）、status、
 *     publish、apiKey 等任何未列出字段一律抛错，而不是静默忽略；
 *   - 来源证据缺失时提案会被 knowledge.ts 标成「待核验」，发布时被拒绝——AI 无法伪造定位。
 *
 * 发布只能由用户在渲染层点「发布」，经 ipc/knowledge.ts::publishBatch 调 services/knowledge.ts。
 */

export const KNOWLEDGE_AI_TOOL_NAMES = ['propose_create', 'propose_update'] as const

export type KnowledgeAiToolName = (typeof KNOWLEDGE_AI_TOOL_NAMES)[number]

export interface KnowledgeAiTool {
  name: KnowledgeAiToolName
  /** 给模型看的说明：只描述「提议」，明确不含发布/删除 */
  description: string
  /** 严格校验入参后写一条提案，返回提案摘要（状态恒为待审核） */
  run(input: unknown): KnowledgeProposalSummary
}

const CREATE_KEYS = [
  'batchId',
  'itemId',
  'targetKey',
  'kind',
  'title',
  'body',
  'sourceType',
  'sourceRef',
  'evidence',
  'reason'
] as const

const UPDATE_KEYS = [
  'batchId',
  'itemId',
  'targetEntryId',
  'targetKey',
  'baseVersion',
  'kind',
  'title',
  'body',
  'sourceType',
  'sourceRef',
  'evidence',
  'reason'
] as const

/** 出现即拒绝的字段名（防御式：即使调用方想越权也拿不到通道） */
const FORBIDDEN_KEY = /(nature|status|publish|release|delete|remove|sql|query|exec|file|path|secret|api[_-]?key|authorization|token|password)/i

function asObject(raw: unknown, tool: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`AI 工具 ${tool} 的入参必须是对象`)
  }
  return raw as Record<string, unknown>
}

function assertStrictKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  tool: string
): void {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`AI 工具 ${tool} 不接受参数：${key}（AI 只能提议，不能设定性质/状态或发布）`)
    }
    if (!allowed.includes(key)) {
      throw new Error(`AI 工具 ${tool} 不接受参数：${key}`)
    }
  }
}

function toBatchId(obj: Record<string, unknown>, tool: string): number {
  const raw = obj.batchId
  const n = typeof raw === 'string' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new Error(`AI 工具 ${tool} 缺少有效的 batchId`)
  }
  return n
}

/** 组装成 createProposal 的入参：内容性质由本层强制为 ai_suggestion */
function proposalInput(
  obj: Record<string, unknown>,
  op: 'create' | 'update'
): CreateKnowledgeProposalInput {
  const content = {
    kind: obj.kind,
    title: obj.title,
    body: obj.body
  }
  const evidence = Array.isArray(obj.evidence) ? (obj.evidence as CreateKnowledgeProposalInput['evidence']) : []
  return {
    op,
    itemId: (obj.itemId ?? null) as number | null,
    targetEntryId: (obj.targetEntryId ?? null) as number | null,
    targetKey: (obj.targetKey ?? null) as string | null,
    baseVersion: (obj.baseVersion ?? null) as number | null,
    content: content as CreateKnowledgeProposalInput['content'],
    // 强制 AI 性质：不接受调用方指定（白名单里也没有这个字段）
    contentNature: 'ai_suggestion',
    sourceType: obj.sourceType as CreateKnowledgeProposalInput['sourceType'],
    sourceRef: (obj.sourceRef ?? null) as CreateKnowledgeProposalInput['sourceRef'],
    evidence,
    reason: typeof obj.reason === 'string' ? obj.reason : ''
  }
}

/**
 * 数据层依赖：显式注入，而不是 import('./knowledge')。
 * 原因：`node scripts/test-unit.ts` 直接以 ESM 导入本文件，Node 要求相对导入带
 * 扩展名，而 tsc 又不允许 `.ts` 后缀导入 —— 显式注入让两侧都能解析。
 */
export interface KnowledgeAiDeps {
  createProposal(
    db: KnowledgeDb,
    batchId: number,
    input: CreateKnowledgeProposalInput
  ): KnowledgeProposalSummary
}

/**
 * 创建 AI 工具集。只接受 KnowledgeDb + 数据层依赖注入，不读 settings、不读 API Key、不联网。
 */
export function createKnowledgeAiTools(db: KnowledgeDb, deps: KnowledgeAiDeps): KnowledgeAiTool[] {
  return [
    {
      name: 'propose_create',
      description:
        '提议在知识库中新增一条知识（只生成待审核提案，不会写入正式条目）。需要标题、正文、知识类型、来源类型；有原文时就填 evidence（页码/模块/引文），没有来源也允许提交，但该提案会被标记为待核验。',
      run(input: unknown): KnowledgeProposalSummary {
        const tool = 'propose_create'
        const obj = asObject(input, tool)
        assertStrictKeys(obj, CREATE_KEYS, tool)
        return deps.createProposal(db, toBatchId(obj, tool), proposalInput(obj, 'create'))
      }
    },
    {
      name: 'propose_update',
      description:
        '提议修改知识库中的一条既有知识（只生成待审核提案，不会写入正式条目）。必须提供目标条目（targetEntryId 或 targetKey）与 baseVersion；发布时若正式条目版本已变则报版本冲突。',
      run(input: unknown): KnowledgeProposalSummary {
        const tool = 'propose_update'
        const obj = asObject(input, tool)
        assertStrictKeys(obj, UPDATE_KEYS, tool)
        if (obj.targetEntryId === undefined && obj.targetKey === undefined) {
          throw new Error(`AI 工具 ${tool} 需要 targetEntryId 或 targetKey`)
        }
        if (obj.baseVersion === undefined || obj.baseVersion === null) {
          throw new Error(`AI 工具 ${tool} 需要 baseVersion（提案基于的条目版本）`)
        }
        return deps.createProposal(db, toBatchId(obj, tool), proposalInput(obj, 'update'))
      }
    }
  ]
}
