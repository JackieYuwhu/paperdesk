/**
 * 领域标签兜底：模型不可用/返回空时，按标题+摘要关键词给一个稳定标签。
 * 纯函数，主进程与单元测试共用；识别不出时归到「综合研究」。
 */
export function fallbackDomain(title: string, abstract: string): string {
  const text = `${title}\n${abstract}`.toLowerCase()
  if (/heuristic|启发式|combinatorial optimization|组合优化|vehicle routing|bin packing/.test(text)) {
    if (/large language|llm|language model|大语言模型/.test(text)) return '自动启发式设计'
    return /evolution|进化|genetic/.test(text) ? '进化计算' : '组合优化'
  }
  if (/evolution|进化|genetic algorithm/.test(text)) return '进化计算'
  if (
    /large language|llm|language model|natural language|attention is all|transformer|prompt|大语言模型|自然语言/.test(
      text
    )
  ) {
    return '自然语言处理'
  }
  if (/image|vision|visual|object detection|segmentation|residual learning|计算机视觉/.test(text)) {
    return '计算机视觉'
  }
  if (/reinforcement learning|强化学习|policy gradient|markov decision/.test(text)) return '强化学习'
  if (/knowledge graph|graph neural|复杂网络|graph representation/.test(text)) return '图学习'
  if (/machine learning|deep learning|neural network|generalization|机器学习|神经网络/.test(text)) {
    return '机器学习'
  }
  if (/physics|quantum|materials|chemistry|biology|medical|clinical|物理|化学|生物|医学/.test(text)) {
    return '交叉学科'
  }
  return '综合研究'
}
