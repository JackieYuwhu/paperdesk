/**
 * AI 工具库：把散落在各面板里的 AI 能力集中成一份「分类清单 + 权限清单」。
 *
 * 纯函数、零依赖（不碰 fs / IPC / React），主进程、渲染进程与单元测试共用。
 *
 * 设计要点：
 *  - 清单（AI_TOOLS）是唯一事实来源：分类、需要哪些能力、入口在哪，都写在这里；
 *  - 用户状态（AiToolState）只记 enabled 与权限开关，缺省全开；
 *  - 非法输入一律回退默认值（不抛错），持久化层损坏时也能把界面恢复正常；
 *  - AI 没有发布通道：这里的权限只管「能不能用某个入口」，不授予任何写库/发布权力。
 */

/** 工具分类：按用户找功能的方式划分（阅读 / 翻译 / 知识库 / 思维地图 / 检索） */
export type AiToolCategory = 'reading' | 'translation' | 'knowledge' | 'mindmap' | 'search'

/** 工具需要的能力：调用模型 / 联网 / 写入知识库 */
export type AiToolPermission = 'model' | 'network' | 'write-knowledge'

/** 一条 AI 工具定义（静态清单，不随用户开关变化） */
export interface AiToolDefinition {
  /** 稳定 id，持久化与 data-testid 都用它 */
  id: string
  /** 界面显示名 */
  name: string
  category: AiToolCategory
  /** 一句话说明它能做什么 */
  description: string
  /** 需要的能力（空数组表示纯本地、不需要额外能力） */
  requires: AiToolPermission[]
  /** 入口提示：告诉用户在哪里能找到它 */
  entryHint: string
}

/** 一条工具的用户状态（恰好包含 enabled 与全部权限开关） */
export interface AiToolState {
  id: string
  enabled: boolean
  permissions: Record<AiToolPermission, boolean>
}

/** 一次状态覆盖的原始输入（来自 ai-tools.json 或 IPC，可能是脏数据） */
export type AiToolOverrides = Record<string, unknown>

/** 更新请求：id 必填，enabled / permissions 可选（permissions 按 key 合并） */
export interface AiToolUpdateInput {
  id: string
  enabled?: boolean
  permissions?: Partial<Record<AiToolPermission, boolean>>
}

/** 一个「入口依赖某工具能力」的闸门声明 */
export interface AiToolGate {
  id: string
  /** 还需要这个工具的具体权限；省略表示只看 enabled */
  permission?: AiToolPermission
}

/** 工具库操作结果：状态 + 给用户看的提示（损坏回退等） */
export interface AiToolsResult {
  tools: AiToolState[]
  warnings: string[]
}

/** 分类顺序（界面 tab 顺序与此一致） */
export const AI_TOOL_CATEGORIES: readonly AiToolCategory[] = [
  'reading',
  'translation',
  'knowledge',
  'mindmap',
  'search'
]

/** 分类显示名 */
export const AI_TOOL_CATEGORY_LABELS: Record<AiToolCategory, string> = {
  reading: '阅读',
  translation: '翻译',
  knowledge: '知识库',
  mindmap: '思维地图',
  search: '检索'
}

/** 权限顺序 */
export const AI_TOOL_PERMISSIONS: readonly AiToolPermission[] = [
  'model',
  'network',
  'write-knowledge'
]

/** 权限显示名 */
export const AI_TOOL_PERMISSION_LABELS: Record<AiToolPermission, string> = {
  model: '调用模型',
  network: '联网',
  'write-knowledge': '写入知识库'
}

/** 内置工具清单（按分类顺序排列，界面默认按此顺序展示） */
export const AI_TOOLS: readonly AiToolDefinition[] = [
  {
    id: 'ai-chat',
    name: 'AI 问答',
    category: 'reading',
    description: '基于当前论文或全库上下文回答问题，支持划词提问与名词解释。',
    requires: ['model'],
    entryHint: '右栏「问答」面板'
  },
  {
    id: 'paper-digest',
    name: '论文拆解',
    category: 'reading',
    description: '把论文正文拆成研究问题、方法、结论等结构化要点。',
    requires: ['model'],
    entryHint: '右栏「拆解论文」面板'
  },
  {
    id: 'web-search',
    name: '联网检索',
    category: 'search',
    description: '问答时检索网页并给出 [W1] 来源标注；关闭后只用本地论文上下文。',
    requires: ['network'],
    entryHint: '问答工具栏的「联网 / 离线」开关'
  },
  {
    id: 'digest-sync',
    name: '拆解同步',
    category: 'knowledge',
    description: '把单篇拆解要点写进知识库暂存区或思维地图；知识库只生成待审核提案。',
    requires: ['write-knowledge'],
    entryHint: '拆解面板「同步到知识库 / 思维地图」按钮'
  },
  {
    id: 'batch-sync',
    name: '批处理同步',
    category: 'knowledge',
    description: '一次把整批论文的拆解结果同步到知识库暂存区或思维地图。',
    requires: ['write-knowledge'],
    entryHint: '批处理作业卡上的同步按钮'
  },
  {
    id: 'mindmap-ai',
    name: '思维地图 AI',
    category: 'mindmap',
    description: '思维地图 AI 总开关：摘要、优化结构、展开子节点、找支撑与结构化骨架都受它约束。',
    requires: ['model'],
    entryHint: '思维地图工具栏「AI 摘要 / AI 优化 / 找支撑」'
  },
  {
    id: 'mindmap-skeleton',
    name: 'AI 结构化骨架',
    category: 'mindmap',
    description: '把拆解材料整理成「根 → 主题 → 要点」三层骨架；模型不可用时回退规则骨架并给出提示。',
    requires: ['model'],
    entryHint: '拆解面板「同步到思维地图」与批处理同步'
  },
  {
    id: 'mindmap-summarize',
    name: 'AI 节点摘要',
    category: 'mindmap',
    description: '为选中节点生成 1–3 句摘要，只依据本文材料，材料不足时明确说明。',
    requires: ['model'],
    entryHint: '思维地图工具栏「AI 摘要」'
  },
  {
    id: 'mindmap-map-optimize',
    name: 'AI 优化整图',
    category: 'mindmap',
    description: '按整张地图的大纲重新分组，合并重复节点，结果可整份撤销。',
    requires: ['model'],
    entryHint: '思维地图工具栏「AI 优化」（无需先选中节点）'
  },
  {
    id: 'mindmap-optimize',
    name: 'AI 优化结构',
    category: 'mindmap',
    description: '把选中节点现有的零散子节点整理成 2–6 个分组，结果可整份撤销。',
    requires: ['model'],
    entryHint: '思维地图工具栏「AI 优化」'
  },
  {
    id: 'mindmap-expand',
    name: 'AI 展开子节点',
    category: 'mindmap',
    description: '把选中节点拆成 2–4 个有依据的子节点，结果可整份撤销。',
    requires: ['model'],
    entryHint: '思维地图工具栏「AI 展开」'
  },
  {
    id: 'mindmap-support',
    name: 'AI 找支撑原文',
    category: 'mindmap',
    description: '从本文正文找能逐字核对的支撑句，并返回页码与点锚点；核对不上绝不编造。',
    requires: ['model'],
    entryHint: '思维地图工具栏「找支撑」'
  }
]

/** 按 id 取定义（找不到返回 undefined，不抛错） */
export function findAiTool(id: string): AiToolDefinition | undefined {
  return AI_TOOLS.find((tool) => tool.id === id)
}

/** 是否是已知工具 id */
export function isAiToolId(id: unknown): id is string {
  return typeof id === 'string' && AI_TOOLS.some((tool) => tool.id === id)
}

/** 是否是合法权限名 */
export function isAiToolPermission(value: unknown): value is AiToolPermission {
  return (
    typeof value === 'string' && (AI_TOOL_PERMISSIONS as readonly string[]).includes(value)
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 默认状态：全部启用、全部权限打开 */
export function defaultAiToolState(def: AiToolDefinition): AiToolState {
  const permissions = {} as Record<AiToolPermission, boolean>
  for (const permission of AI_TOOL_PERMISSIONS) permissions[permission] = true
  return { id: def.id, enabled: true, permissions }
}

/**
 * 把「原始覆盖数据」解析成完整状态列表。
 *
 * - overrides 为 undefined / null / 非对象 → 全部默认（全开）；
 * - overrides[id] 不是对象 → 该工具用默认值；
 * - enabled 不是布尔 → 回退 true；permissions 里非布尔的项 → 回退 true；
 * - 未知 id 直接忽略（只按 definitions 逐条生成，保证顺序与数量稳定）。
 */
export function resolveToolState(
  definitions: readonly AiToolDefinition[] = AI_TOOLS,
  overrides?: unknown
): AiToolState[] {
  const source = isPlainObject(overrides) ? overrides : {}
  return definitions.map((def) => {
    const state = defaultAiToolState(def)
    const raw = source[def.id]
    if (!isPlainObject(raw)) return state
    if (typeof raw.enabled === 'boolean') state.enabled = raw.enabled
    const rawPermissions = raw.permissions
    if (isPlainObject(rawPermissions)) {
      for (const permission of AI_TOOL_PERMISSIONS) {
        const value = rawPermissions[permission]
        if (typeof value === 'boolean') state.permissions[permission] = value
      }
    }
    return state
  })
}

/** 状态列表里取某工具状态 */
export function findToolState(
  states: readonly AiToolState[] | null | undefined,
  id: string
): AiToolState | undefined {
  if (!Array.isArray(states)) return undefined
  return states.find((state) => state && state.id === id)
}

/**
 * 判断某个工具当前是否可用。
 *
 * state 缺失（还没加载到 / 未知 id）按「可用」处理：宁可让入口暂时可用，
 * 也不要因为读取状态失败把功能整体锁死；真正的关闭必须是显式 false。
 */
export function isToolUsable(
  state: AiToolState | null | undefined,
  need?: AiToolPermission
): boolean {
  if (!state) return true
  if (state.enabled !== true) return false
  if (!need) return true
  return state.permissions?.[need] === true
}

/**
 * 生成「入口为什么不可用」的可读中文提示；可用时返回空字符串。
 *
 * 文案是验收约定的一部分，改动前先看 docs/AI-TOOLS.md：
 *   「已在 AI 工具库关闭联网检索」
 *   「已在 AI 工具库关闭思维地图 AI」
 *   「已在 AI 工具库关闭拆解同步的「写入知识库」权限」
 */
export function aiToolBlockReason(
  states: readonly AiToolState[] | null | undefined,
  gates: readonly AiToolGate[]
): string {
  for (const gate of gates) {
    const state = findToolState(states, gate.id)
    if (!state) continue
    const name = findAiTool(gate.id)?.name ?? gate.id
    if (state.enabled !== true) return `已在 AI 工具库关闭${name}`
    if (gate.permission && state.permissions?.[gate.permission] !== true) {
      return `已在 AI 工具库关闭${name}的「${AI_TOOL_PERMISSION_LABELS[gate.permission]}」权限`
    }
  }
  return ''
}

/** 把状态列表压成持久化用的覆盖对象（只写非默认值，便于人工阅读配置） */
export function stateToOverrides(states: readonly AiToolState[]): AiToolOverrides {
  const overrides: AiToolOverrides = {}
  for (const state of states) {
    if (!state || typeof state.id !== 'string') continue
    const entry: Record<string, unknown> = {}
    if (state.enabled !== true) entry.enabled = false
    const permissions: Record<string, boolean> = {}
    for (const permission of AI_TOOL_PERMISSIONS) {
      if (state.permissions?.[permission] === false) permissions[permission] = false
    }
    if (Object.keys(permissions).length > 0) entry.permissions = permissions
    if (Object.keys(entry).length > 0) overrides[state.id] = entry
  }
  return overrides
}
