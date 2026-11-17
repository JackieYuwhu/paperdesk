import type { Attachment, Item } from '../../../shared/types'

export interface BatchInput {
  itemId: number | null
  attachmentId: number | null
  item: Item | null
  attachment: Attachment | null
}

export interface BatchContext {
  jobId: number
  jobKey: string
  params: Record<string, string>
  outDir: string
  log: (msg: string) => void
  isCancelled: () => boolean
}

export interface BatchOutput {
  outputs: string[]
  message?: string
}

/** 逐项执行结果（供 finalize 做汇总） */
export interface BatchItemResult {
  itemId: number | null
  attachmentId: number | null
  label: string
  ok: boolean
  outputs: string[]
  message?: string
}

export interface BatchParamField {
  key: string
  label: string
  type: 'select' | 'text' | 'textarea'
  options?: Array<{ value: string; label: string }>
  /** textarea 的预置模板 */
  presets?: Array<{ name: string; value: string }>
  placeholder?: string
  default?: string
  /** textarea 行数 */
  rows?: number
  hint?: string
}

/**
 * 批处理任务处理器 —— 「批处理」模块的扩展点。
 * 新增一类任务 = 写一个实现 + 在 registry.ts 的 TASKS 里加一行。
 */
export interface BatchTaskHandler {
  id: string
  title: string
  description: string
  /** 输入粒度：按附件 / 按条目 */
  input: 'attachment' | 'item'
  /** 是否调用大模型（用于低峰调度提示） */
  usesLlm?: boolean
  paramFields: BatchParamField[]
  run(input: BatchInput, ctx: BatchContext): Promise<BatchOutput>
  /** 可选：全部条目跑完后执行一次，用于跨条目汇总（如生成对比表） */
  finalize?(ctx: BatchContext, results: BatchItemResult[]): Promise<BatchOutput | void>
  /**
   * 资源需求（用于并发限制；缺省视为轻量）。
   * —— 声明式：任务自己说明占用，调度据此决定能否与其它任务并行，避免拖慢前台阅读/缩放。
   */
  resources?: {
    /** 相对 CPU 占用（1=轻，2=中，3=重） */
    cpu?: number
    /** 是否占用模型服务（低峰/限流考虑） */
    model?: boolean
  }
  /** 是否可安全暂停（缺省 false）。仅声明为 true 的任务才允许「暂停」。 */
  supportsPause?: boolean
  /**
   * 是否支持批处理队列（缺省 true）。
   * 单文件耗时任务同样可以入队；设为 false 表示只能「立即执行」。
   */
  batchable?: boolean
}
