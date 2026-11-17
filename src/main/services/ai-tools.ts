/**
 * AI 工具库持久化：数据目录下的 ai-tools.json。
 *
 * 文件格式（schemaVersion 1，只记录与默认值不同的项，便于人工阅读）：
 *   {
 *     "schemaVersion": 1,
 *     "tools": {
 *       "web-search": { "enabled": false },
 *       "digest-sync": { "permissions": { "write-knowledge": false } }
 *     }
 *   }
 *
 * 约定：
 *  - 文件缺失 = 全新安装，直接用默认（全开），不算异常；
 *  - 文件损坏 / 版本不认识 → 回退默认并在 warnings 里给出中文原因，不抛错、不阻塞设置面板；
 *  - 写入一律「临时文件 + rename」，避免中途崩溃留下半个 JSON；
 *  - 非法 id / 非法权限名在更新时抛中文错误（界面据此提示），不静默吞掉。
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getDataDir } from '../db'
import {
  AI_TOOLS,
  AI_TOOL_PERMISSIONS,
  isAiToolId,
  isAiToolPermission,
  resolveToolState,
  stateToOverrides
} from '../../shared/ai-tools'
import type {
  AiToolOverrides,
  AiToolPermission,
  AiToolState,
  AiToolUpdateInput,
  AiToolsResult
} from '../../shared/ai-tools'

/** 配置文件名（放在数据目录根下，与 library.sqlite / settings.json 同级） */
const FILE_NAME = 'ai-tools.json'
/** 当前文件版本；将来结构变化时递增并在读取处写迁移 */
const SCHEMA_VERSION = 1

/** ai-tools.json 的绝对路径 */
export function aiToolsFile(): string {
  return join(getDataDir(), FILE_NAME)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function defaultResult(): AiToolsResult {
  return { tools: resolveToolState(AI_TOOLS), warnings: [] }
}

/** 读取并解析配置文件；任何异常都回退默认并带 warning */
export function readAiTools(): AiToolsResult {
  const file = aiToolsFile()
  if (!existsSync(file)) return defaultResult()
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return {
      tools: resolveToolState(AI_TOOLS),
      warnings: [`AI 工具库配置读取失败，已回退默认设置（${describeError(error)}）`]
    }
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    return {
      tools: resolveToolState(AI_TOOLS),
      warnings: [`AI 工具库配置文件损坏，已回退默认设置（${describeError(error)}）`]
    }
  }
  if (!isPlainObject(data)) {
    return {
      tools: resolveToolState(AI_TOOLS),
      warnings: ['AI 工具库配置文件损坏，已回退默认设置（顶层不是对象）']
    }
  }
  if (data.schemaVersion !== SCHEMA_VERSION) {
    const version = typeof data.schemaVersion === 'number' ? data.schemaVersion : '缺失'
    return {
      tools: resolveToolState(AI_TOOLS),
      warnings: [`AI 工具库配置版本不受支持（${version}），已回退默认设置`]
    }
  }
  const overrides = isPlainObject(data.tools) ? data.tools : {}
  return { tools: resolveToolState(AI_TOOLS, overrides), warnings: [] }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 原子写：先写同目录临时文件再 rename，失败时清掉临时文件 */
export function writeAiTools(states: readonly AiToolState[]): void {
  const file = aiToolsFile()
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    tools: stateToOverrides(states)
  } satisfies { schemaVersion: number; tools: AiToolOverrides }
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* 清理失败不影响把真实错误抛给调用方 */
    }
    throw new Error(`AI 工具库配置写入失败：${describeError(error)}`)
  }
}

/** 列出全部工具状态（含损坏回退的 warning） */
export function listAiTools(): AiToolsResult {
  return readAiTools()
}

/**
 * 更新一个工具：enabled 覆盖启用状态，permissions 按 key 合并（只改传入的权限）。
 * 非法 id / 非法权限名 / 非布尔值都抛中文错误，界面直接展示。
 */
export function updateAiTool(input: unknown): AiToolsResult {
  if (!isPlainObject(input)) throw new Error('AI 工具更新参数无效：需要一个对象')
  const raw = input as AiToolUpdateInput & Record<string, unknown>
  const id = raw.id
  if (!isAiToolId(id)) {
    const text = typeof id === 'string' ? id : String(id)
    throw new Error(`未知的 AI 工具：${text}`)
  }
  if ('enabled' in raw && raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error(`AI 工具 ${id} 的 enabled 必须是 true 或 false`)
  }
  const permissionPatch: Partial<Record<AiToolPermission, boolean>> = {}
  if ('permissions' in raw && raw.permissions !== undefined) {
    if (!isPlainObject(raw.permissions)) {
      throw new Error(`AI 工具 ${id} 的 permissions 必须是一个对象`)
    }
    for (const [key, value] of Object.entries(raw.permissions)) {
      if (!isAiToolPermission(key)) throw new Error(`未知的 AI 工具权限：${key}`)
      if (typeof value !== 'boolean') {
        throw new Error(`AI 工具 ${id} 的权限 ${key} 必须是 true 或 false`)
      }
      permissionPatch[key] = value
    }
  }
  const current = readAiTools()
  const next = current.tools.map((state) => {
    if (state.id !== id) return state
    const permissions = { ...state.permissions }
    for (const permission of AI_TOOL_PERMISSIONS) {
      const value = permissionPatch[permission]
      if (typeof value === 'boolean') permissions[permission] = value
    }
    return {
      id: state.id,
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : state.enabled,
      permissions
    }
  })
  writeAiTools(next)
  return { tools: next, warnings: current.warnings }
}

/** 恢复默认（全开）并写回文件 */
export function resetAiTools(): AiToolsResult {
  const tools = resolveToolState(AI_TOOLS)
  writeAiTools(tools)
  return { tools, warnings: [] }
}
