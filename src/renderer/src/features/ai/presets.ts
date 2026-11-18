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
    key: 'quick-read',
    label: '快速抓重点',
    prompt: '我时间有限。请依据本文给出研究问题、核心贡献、关键公式的含义、主要实验结论与局限，建议优先读哪些段落。每个要点附可核对的原文引用或页码；没有证据请明确说明，不要编造。'
  },
  {
    key: 'deep-read',
    label: '通篇精读',
    prompt: '请带我按本文的章节顺序精读，先给阅读路线，再从第一节开始解释关键论点、陌生术语和公式。说明符号定义、假设和推导依据，区分作者原意与你的补充解释，并提供原文定位。一次讲一节，等待我的追问。'
  },
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
