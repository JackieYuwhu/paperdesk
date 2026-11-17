import type { CreateBatchInput } from '../../../shared/types'

const VALID_SCOPES: ReadonlyArray<CreateBatchInput['scope']> = [
  'all',
  'item',
  'attachment',
  'select',
  'group',
  'tag'
]

export function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0
}

/**
 * 校验创建批处理作业的入参；非法输入抛出明确错误，返回规范化后的输入。
 *
 * 关键约束：`scope=attachment`/`item`/`select` 必须带合法目标，避免上层
 * `resolveTargets` 在目标缺失时**静默回退为「处理全部」**。
 *
 * 纯函数（`taskExists` 由调用方注入，避免依赖 electron），便于单元测试。
 */
export function validateCreateInput(
  input: unknown,
  taskExists: (id: string) => boolean
): CreateBatchInput {
  if (!input || typeof input !== 'object') throw new Error('批处理请求无效')
  const it = input as Record<string, unknown>

  if (typeof it.task !== 'string' || it.task.length === 0) throw new Error('task 无效')
  if (!taskExists(it.task)) throw new Error(`未知批处理任务: ${it.task}`)

  const scope = it.scope
  if (
    typeof scope !== 'string' ||
    !VALID_SCOPES.includes(scope as CreateBatchInput['scope'])
  ) {
    throw new Error(`scope 无效: ${String(scope)}`)
  }

  if (scope === 'attachment' && !isPositiveInt(it.attachmentId)) {
    throw new Error('scope=attachment 时 attachmentId 必须为正整数')
  }
  if (scope === 'item' && !isPositiveInt(it.itemId)) {
    throw new Error('scope=item 时 itemId 必须为正整数')
  }
  if (scope === 'select') {
    const ids = it.itemIds
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isPositiveInt)) {
      throw new Error('scope=select 时 itemIds 必须为非空的正整数数组')
    }
  }
  if (scope === 'group') {
    if (typeof it.group !== 'string' || !it.group.trim()) {
      throw new Error('scope=group 时 group 必须为非空分组路径')
    }
  }
  if (scope === 'tag') {
    if (typeof it.tag !== 'string' || !it.tag.trim()) {
      throw new Error('scope=tag 时 tag 必须为非空标签名')
    }
  }
  if (it.params != null && (typeof it.params !== 'object' || Array.isArray(it.params))) {
    throw new Error('params 必须为对象')
  }

  return it as unknown as CreateBatchInput
}
