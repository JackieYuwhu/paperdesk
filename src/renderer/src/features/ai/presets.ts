/** 问答面板空态的功能按键（预设提示）：点击后只把提示写入输入框，不自动发送。 */
export interface AiPreset {
  /** 稳定键：按钮 data-testid = `ai-preset-<key>`，同时用于映射查表 */
  key: string
  /** 按键文案 */
  label: string
  /** 点击后写入输入框的提示文本（用户仍可编辑） */
  prompt: string
}

/**
 * 至少 6 个按键，覆盖：论文概要 / 方法拆解 / 实验结果 / 研究局限 / 相关文献 / 术语解释。
 * 提示措辞按「当前作用域」描述，单篇 / 分组 / 全库三种作用域下都成立。
 */
export const AI_PRESETS: AiPreset[] = [
  {
    key: 'overview',
    label: '论文概要',
    prompt: '请概括当前范围内论文的研究问题、核心方法与主要贡献。'
  },
  {
    key: 'method',
    label: '方法拆解',
    prompt: '请拆解当前范围内论文的方法：整体流程、关键模块与每一步的作用。'
  },
  {
    key: 'results',
    label: '实验结果',
    prompt: '请总结当前范围内论文的实验结果：数据集、评价指标、关键数值与结论。'
  },
  {
    key: 'limitations',
    label: '研究局限',
    prompt: '请分析当前范围内论文的研究局限与可改进方向。'
  },
  {
    key: 'related',
    label: '相关文献',
    prompt: '请列出与当前范围内论文密切相关的代表性工作，并说明关联点。'
  },
  {
    key: 'term',
    label: '术语解释',
    prompt: '请解释当前范围内论文的关键术语，并给出通俗说明。'
  }
]

/** 按 key 取预设；未知 key 返回 null（拼错 testid 或旧数据时安全降级） */
export function presetFor(key: string): AiPreset | null {
  return AI_PRESETS.find((preset) => preset.key === key) ?? null
}
