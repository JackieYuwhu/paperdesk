export interface ReuseSignature {
  /** 实际执行后端：mock/none/openai */
  backend: string
  /** 实际模型名（mock 时可为空） */
  model: string
  /** 源文件指纹（size:mtime），内容变化即失效 */
  fingerprint: string
  /** 引擎 + 模式（如 simple:coarse / simple:strict） */
  engineKey: string
  /** 版式：reflow / strict；不同版式不能互相复用 */
  layout?: 'reflow' | 'strict'
}

export interface ReusableTranslationRow {
  status?: string | null
  engine?: string | null
  backend?: string | null
  qa?: string | null
}

function storedSignature(qa: string | null | undefined): Partial<ReuseSignature> | null {
  try {
    const parsed = JSON.parse(qa ?? '') as { reuse?: Partial<ReuseSignature> } | null
    return parsed?.reuse ?? null
  } catch {
    return null
  }
}

/**
 * 是否允许复用已有译文。
 *
 * - 状态 done、引擎+模式一致；
 * - **mock/none 结果不能冒充真实模型任务**；真实结果也不用于 mock 请求；
 * - 真实后端必须核对 backend/model/源文件指纹（旧译文没有签名时不复用）；
 * - `force` 由调用方处理（不进入本函数）。
 */
export function canReuseTranslation(
  existing: ReusableTranslationRow | null | undefined,
  sig: ReuseSignature,
  requestedBackend: string
): boolean {
  if (!existing || existing.status !== 'done') return false
  if ((existing.engine ?? 'simple') !== sig.engineKey) return false
  const requestedMock = requestedBackend === 'mock' || requestedBackend === 'none'
  const existingMock = existing.backend === 'mock' || existing.backend === 'none'
  if (requestedMock) return existingMock
  if (existingMock) return false
  const stored = storedSignature(existing.qa)
  if (!stored) return false
  return (
    stored.backend === sig.backend &&
    (stored.model ?? '') === sig.model &&
    stored.fingerprint === sig.fingerprint &&
    (stored.layout ?? 'reflow') === (sig.layout ?? 'reflow')
  )
}
