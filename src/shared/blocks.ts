/**
 * 统一结构化块标注（阶段 B 最小 PoC）。与侧车适配层 ``python/app/blocks_adapter.py`` 对齐，
 * 设计依据：``docs/audit-pdf-pipeline.md`` §6（6.1 接口路径 / 6.2 三必填字段 / 6.3 开关方案）。
 *
 * 适配层开关（环境变量 ``PAPERDESK_BLOCKS_ADAPTER``）默认关闭：关闭时解析产物**不带** blocks
 * 字段（老缓存也不带），因此所有消费方一律按**可选字段**处理。适配层只做标注
 * （stableId / blockType / sourceRegion），不做公式 LaTeX 重建，也绝不改写文本。
 *
 * 坐标约定与 ``src/shared/modules.ts`` 的 ``StructuredModule.rect`` 一致：底边原点
 * （y 向上）， ``rect`` 为 ``[x0, y0, x1, y1]``。
 */

/** 侧车适配层版本（与 blocks_adapter.py 的 ``ADAPTER_VERSION`` 一致） */
export const BLOCKS_ADAPTER_VERSION = 'blocks-adapter/1'

/**
 * 块级类型（与 blocks_adapter.py ``_classify`` 的输出对齐，沿用 modules.ts 的字面量联合风格）。
 */
export type StructuredBlockType =
  /** 正文段落 */
  | 'paragraph'
  /** 标题（字号 ≥ 正文字号 + 1 的短块） */
  | 'heading'
  /** 图/表题注 */
  | 'caption'
  /** 独立公式行 */
  | 'equation'
  /** 公式编号行（如 (1)） */
  | 'equation-number'
  /** 参考文献条目 */
  | 'reference'

/** 单个块矩形：``[x0, y0, x1, y1]``（底边原点，y 向上） */
export type BlockRect = [number, number, number, number]

/**
 * 块的原文出处区域（验收三必填之一）。
 */
export interface SourceRegion {
  /** 1 基页码 */
  page: number
  /** 块外接矩形（底边原点） */
  rect: BlockRect
  /** 更细的片段矩形（同坐标系，如逐 span/行），可选 */
  rects?: BlockRect[]
}

/**
 * 统一结构化块：原文映射层的最小标注单元。
 * 每块保证有 stableId / blockType / sourceRegion；对齐侧信息二选一——
 * ``moduleId``（对齐到既有 StructuredModule）或 ``orphan: true``（未对齐）。
 */
export interface StructuredBlock {
  /** 稳定 ID：``p<页>-b<序>``（同一解析结果内唯一，供跨进程引用） */
  stableId: string
  /** 块级类型 */
  blockType: StructuredBlockType
  /** 原文出处（页码 + 矩形） */
  sourceRegion: SourceRegion
  /**
   * 未对齐到任何既有模块（块矩形与 modules[i].rect 重合度 ≤ 0.6）。
   * 对齐成功时该字段不存在（此时 ``moduleId`` 有值）。
   */
  orphan?: boolean
  /** 原文逐字保留（适配层绝不改写文本） */
  text?: string
  /** 主字号字体（按块内最大字号 span 标注，可选） */
  font?: string
  /** 主字号（可选） */
  fontSize?: number
  /** 行内数学嫌疑区间（字符 offset + 同坐标系矩形，可选） */
  inlineMath?: Array<{ start: number; end: number; text: string; rect: BlockRect }>
  /** 对齐到的既有 StructuredModule.id（与 orphan 互斥出现） */
  moduleId?: string
  /** 公式编号块回挂的最近公式块 stableId（6.4 最小证明） */
  relatedEquationId?: string
}

/**
 * 挂在文档级解析产物上的 blocks 载荷（这也是产物 `blocks` 字段的形态；可选字段，
 * 老缓存/关闭开关时为 undefined）。
 */
export interface BlocksPayload {
  /** 生成这份标注的适配层版本 */
  adapterVersion: string
  /** 结构化块列表（按页序 + 阅读顺序） */
  blocks: StructuredBlock[]
}
