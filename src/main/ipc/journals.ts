import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import { generate } from '../services/llm'
import { JOURNALS, type Journal } from '../../shared/journals'

const SYSTEM = [
  '你是学术期刊/会议的投稿顾问。',
  '只依据用户提供的「期刊速查要点」作答；**不要编造任何硬性数字**（页数上限、摘要字数、参考文献数量等）。',
  '要点中没有的信息，明确写「需查官方作者指南」，并提醒最终以官网为准。',
  '输出中文 Markdown，包含两部分：',
  '一、要求摘要（分点，最多 8 条，聚焦「会踩坑的硬要求」）；',
  '二、投稿前 checklist（用 `- [ ]` 形式，8–12 条，可直接照着核对）。',
  '不要输出与投稿无关的客套话。'
].join('\n')

function journalPrompt(j: Journal): string {
  const r = j.requirements
  return [
    `期刊：${j.name}${j.nameZh ? `（${j.nameZh}）` : ''}`,
    `类型：${j.kind === 'conference' ? '会议' : '期刊'}`,
    `出版社/主办：${j.publisher}`,
    `范围：${j.scope}`,
    `定位：${j.standing}`,
    j.limits
      ? `已知参考上限：${[
          j.limits.abstractWords ? `摘要约 ${j.limits.abstractWords} 词` : '',
          j.limits.mainTextPages ? `正文约 ${j.limits.mainTextPages} 页` : '',
          j.limits.note ?? ''
        ]
          .filter(Boolean)
          .join('；')}`
      : '已知参考上限：无（以官网为准）',
    '',
    '速查要点：',
    `- 语言/写作：${r.language}`,
    `- 篇幅惯例：${r.length}`,
    `- 摘要：${r.abstract}`,
    `- 参考文献：${r.references}`,
    `- 图表/补充材料：${r.figures}`,
    `- 数据与代码：${r.dataCode}`,
    `- 开放获取/费用：${r.apc}`,
    `- 审稿与周期：${r.review}`,
    '',
    '常见要求 / 易踩坑：',
    ...j.tips.map((t) => `- ${t}`),
    '',
    `作者指南：${j.guideUrl}`
  ].join('\n')
}

/** 离线（mock）时的确定性结果：直接把要点整理成摘要 + checklist */
function mockSummary(j: Journal): string {
  const r = j.requirements
  const lines = [
    '> ⚠️ 当前为**离线占位**（未调用模型）。在「设置 → 模型服务」配置后可让 AI 生成更贴合的版本。',
    '',
    `## 一、要求摘要（${j.name}）`,
    '',
    `- 写作语言：${r.language}`,
    `- 篇幅惯例：${r.length}`,
    `- 摘要：${r.abstract}`,
    `- 参考文献：${r.references}`,
    `- 图表/补充材料：${r.figures}`,
    `- 数据与代码：${r.dataCode}`,
    `- 开放获取/费用：${r.apc}`,
    `- 审稿与周期：${r.review}`,
    '',
    '## 二、投稿前 checklist',
    ''
  ]
  const checks = [
    '按官方模板排版，核对页数/字数上限',
    '摘要符合该刊格式与字数要求',
    '参考文献风格与引文格式一致',
    '图注自解释（含统计方法与重复数）',
    '补充材料与正文分工明确',
    '数据与代码可用性声明（含仓库/许可证）',
    '伦理/利益冲突/作者贡献声明齐备',
    ...j.tips
  ]
  for (const c of checks) lines.push(`- [ ] ${c}`)
  lines.push('', `> 详细要求请查官方作者指南：${j.guideUrl}`)
  return lines.join('\n')
}

export function registerJournalsHandlers(): void {
  ipcMain.handle(
    CH.journals.summarize,
    async (_e, journalId: string): Promise<{ text: string; backend: string }> => {
      const j = JOURNALS.find((x) => x.id === journalId)
      if (!j) throw new Error(`未知期刊: ${journalId}`)
      return generate({
        system: SYSTEM,
        user: journalPrompt(j),
        mock: () => mockSummary(j),
        session: 'journals'
      })
    }
  )
}
