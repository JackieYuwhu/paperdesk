/**
 * 期刊/会议速查（内置数据集）。
 *
 * ⚠️ 用途：快速了解「这本刊/这个会在意什么」，**不是**官方投稿规范。
 * 具体字数/格式/伦理声明等**一律以官网 Author Guidelines 为准**——界面里已给出直达链接。
 * 这里只放**稳定、通用**的信息；`limits` 仅为**常见参考值**，且多数为缺省（未填=以官网为准）。
 */

export interface JournalRequirements {
  /** 语言/写作 */
  language: string
  /** 篇幅惯例 */
  length: string
  /** 摘要要求 */
  abstract: string
  /** 参考文献风格 */
  references: string
  /** 图表/补充材料 */
  figures: string
  /** 数据与代码可用性 */
  dataCode: string
  /** 开放获取 / 版面费 */
  apc: string
  /** 审稿与周期（定性） */
  review: string
}

/** 常见参考上限（**非官方**；未填表示「以官网为准」） */
export interface JournalLimits {
  abstractWords?: number
  mainTextPages?: number
  note?: string
}

export interface Journal {
  id: string
  name: string
  nameZh?: string
  publisher: string
  kind: 'journal' | 'conference'
  /** 学科范围 */
  scope: string
  /** 影响力/定位（定性，不写具体数字以免过期） */
  standing: string
  /** 作者指南直达 */
  guideUrl: string
  /** 期刊主页 */
  homeUrl: string
  /** 用于「按当前论文推荐」的关键词匹配（小写） */
  keywords: string[]
  limits?: JournalLimits
  requirements: JournalRequirements
  /** 常见要求 / 易踩坑 */
  tips: string[]
}

const R = (
  language: string,
  length: string,
  abstract: string,
  references: string,
  figures: string,
  dataCode: string,
  apc: string,
  review: string
): JournalRequirements => ({ language, length, abstract, references, figures, dataCode, apc, review })

export const JOURNALS: Journal[] = [
  /* ---------------------------------- 综合 ---------------------------------- */
  {
    id: 'nature',
    name: 'Nature',
    nameZh: '自然',
    publisher: 'Springer Nature',
    kind: 'journal',
    scope: '综合科学，强调「广泛的科学意义」与概念性突破',
    standing: '综合类顶刊；看重 novelty 与跨领域影响，篇幅短、要求高',
    guideUrl: 'https://www.nature.com/nature/for-authors',
    homeUrl: 'https://www.nature.com/nature',
    keywords: [
      'protein', 'genome', 'gene', 'cell', 'brain', 'neuron', 'cancer', 'quantum', 'material',
      'climate', 'astronomy', 'physics', 'chemistry', 'machine learning', 'interdisciplinary'
    ],
    limits: { abstractWords: 200, note: '正文无固定页数限制，但要求极短' },
    requirements: R(
      '英文；英式拼写为默认（可声明美式）',
      '正文很短，多余细节放方法 / 补充材料',
      '一段式摘要，不加小标题，面向非本领域读者',
      '数字上标引文；正文参考文献数量有限制',
      '图少而精；图注需自解释；细节进 Extended Data / SI',
      '要求数据可用性声明；代码/数据需可获取',
      '以订阅为主；可选开放获取（APC 较高）',
      '编辑初筛（desk reject 比例高）+ 外审，周期较长'
    ),
    tips: ['先投「预投稿咨询（presubmission enquiry）」很常见，可省时间', '强调「为什么重要」而非「做了多少实验」']
  },
  {
    id: 'science',
    name: 'Science',
    nameZh: '科学',
    publisher: 'AAAS',
    kind: 'journal',
    scope: '综合科学，偏重结论稳健、影响面广的研究',
    standing: '综合类顶刊；对「可复现的证据链」要求高',
    guideUrl: 'https://www.science.org/content/page/science-information-authors',
    homeUrl: 'https://www.science.org/journal/science',
    keywords: [
      'protein', 'genome', 'cell', 'brain', 'cancer', 'quantum', 'material', 'climate',
      'physics', 'chemistry', 'machine learning', 'interdisciplinary'
    ],
    limits: { abstractWords: 125 },
    requirements: R(
      '英文（美式）',
      'Research Article 篇幅受限，详细内容进补充材料',
      '一段式；需一句话点明结论',
      '数字引文；格式有明确规定',
      '图版要求严格，补充材料承载细节',
      '要求数据与代码可用性声明',
      '以订阅为主；开放获取需付费',
      '编辑初筛严格，外审周期较长'
    ),
    tips: ['重视「写得好」：编辑很在意可读性', '结论要有明确证据边界，避免过度外推']
  },
  {
    id: 'pnas',
    name: 'PNAS',
    nameZh: '美国科学院院刊',
    publisher: 'National Academy of Sciences',
    kind: 'journal',
    scope: '综合科学，覆盖面极广',
    standing: '综合类权威刊；Direct Submission 与外稿渠道不同',
    guideUrl: 'https://www.pnas.org/author-center/submitting-your-manuscript',
    homeUrl: 'https://www.pnas.org/',
    keywords: [
      'protein', 'genome', 'cell', 'brain', 'ecology', 'evolution', 'material', 'physics',
      'chemistry', 'statistics', 'machine learning'
    ],
    limits: { abstractWords: 250 },
    requirements: R(
      '英文',
      'Research Article 通常 6 页左右（含图表），细节进 SI',
      '一段式摘要',
      '数字引文（PNAS 风格）',
      '图表计入篇幅，SI 不限',
      '要求数据可用性声明',
      '订阅为主；OA 可选',
      '外审较规范；可走「contributed / direct」不同通道'
    ),
    tips: ['SI 附录（Appendix）常被要求写详细方法与补充数据']
  },
  {
    id: 'nature-communications',
    name: 'Nature Communications',
    nameZh: '自然·通讯',
    publisher: 'Springer Nature',
    kind: 'journal',
    scope: '综合科学（多学科）',
    standing: '高水平开放获取综合刊；体量较大',
    guideUrl: 'https://www.nature.com/ncomms/submit',
    homeUrl: 'https://www.nature.com/ncomms',
    keywords: [
      'protein', 'genome', 'cell', 'brain', 'cancer', 'material', 'physics', 'chemistry',
      'climate', 'machine learning', 'dataset'
    ],
    requirements: R(
      '英文',
      '篇幅较宽松；细节进补充材料',
      '一段式摘要；面向跨领域读者',
      '数字上标引文',
      '图注自解释',
      '要求数据可用性声明；组学数据需入库',
      '完全开放获取（APC）',
      '外审周期中等，编辑初筛相对友好'
    ),
    tips: ['开放获取费用较高，投稿前确认经费']
  },
  {
    id: 'plos-one',
    name: 'PLOS ONE',
    nameZh: 'PLOS 综合',
    publisher: 'PLOS',
    kind: 'journal',
    scope: '综合；评审关注「技术正确性」而非影响力',
    standing: '开放获取综合刊；强调方法严谨与数据公开',
    guideUrl: 'https://journals.plos.org/plosone/s/submission-guidelines',
    homeUrl: 'https://journals.plos.org/plosone/',
    keywords: ['protein', 'genome', 'cell', 'ecology', 'psychology', 'dataset', 'statistics', 'machine learning'],
    limits: { abstractWords: 300 },
    requirements: R(
      '英文',
      '无硬性词数上限，但要求清晰完整',
      '一段式摘要（不超过上限词数）',
      '数字引文（Vancouver 风格）',
      '图自解释；支持大量补充材料',
      '**强制**数据可用性声明',
      '开放获取（APC；有减免）',
      '外审常由学术编辑处理，周期中等'
    ),
    tips: ['不需要「重要性」论点，但方法必须站得住', '提交前用他们的 checklist 自查']
  },

  /* ---------------------------------- 生命 / 医学 ---------------------------------- */
  {
    id: 'cell',
    name: 'Cell',
    nameZh: '细胞',
    publisher: 'Cell Press',
    kind: 'journal',
    scope: '生命科学，强调机制性与完整故事',
    standing: '生命科学顶刊；偏好「机制清晰 + 数据完整」',
    guideUrl: 'https://www.cell.com/cell/authors',
    homeUrl: 'https://www.cell.com/cell/home',
    keywords: ['cell', 'protein', 'gene', 'cancer', 'immunology', 'neuroscience', 'stem cell', 'mouse'],
    requirements: R(
      '英文',
      'Article 有词数/图数上限；细节进 STAR Methods / SI',
      '含 Highlights（3–4 条要点）与 eTOC 短摘要',
      '作者-年份（Cell 风格）',
      '图注需含统计与重复数',
      '强制数据可用性声明；组学数据需入库',
      '以订阅为主；OA 可选',
      '编辑初筛 + 外审；常需修回补实验'
    ),
    tips: ['STAR Methods 结构是硬要求（含 key resources table）', 'Highlights 要写「发现」而不是「做了什么」']
  },
  {
    id: 'nature-medicine',
    name: 'Nature Medicine',
    nameZh: '自然·医学',
    publisher: 'Springer Nature',
    kind: 'journal',
    scope: '转化医学与临床研究',
    standing: '医学顶刊；对临床价值与统计严谨性要求高',
    guideUrl: 'https://www.nature.com/nm/for-authors',
    homeUrl: 'https://www.nature.com/nm',
    keywords: ['clinical trial', 'patient', 'cohort', 'biomarker', 'cancer', 'therapy', 'diagnosis', 'medicine'],
    requirements: R(
      '英文',
      '研究论文篇幅受限；细节进补充材料',
      '一段式摘要（部分栏目要求结构化）',
      '数字上标引文',
      '图表需含置信区间等统计信息',
      '要求数据可用性；临床试验需注册号与 CONSORT 等报告规范',
      '订阅为主；OA 可选',
      '编辑初筛 + 外审；对统计与伦理材料要求严'
    ),
    tips: ['临床试验必须提前注册并在稿件中给出注册号', '准备完整的统计分析与伦理审批材料']
  },
  {
    id: 'nejm',
    name: 'NEJM',
    nameZh: '新英格兰医学杂志',
    publisher: 'Massachusetts Medical Society',
    kind: 'journal',
    scope: '临床医学（尤其随机对照试验）',
    standing: '临床医学顶级刊；偏好改变实践的大型 RCT',
    guideUrl: 'https://www.nejm.org/author-center/general-information',
    homeUrl: 'https://www.nejm.org/',
    keywords: ['randomized', 'clinical trial', 'patient', 'mortality', 'treatment', 'outcome', 'cohort'],
    limits: { abstractWords: 250, note: '结构化摘要（Background/Methods/Results/Conclusions）' },
    requirements: R(
      '英文',
      '研究论文字数受限；图表数量有限制',
      '**结构化摘要**（部分栏目要求）',
      '数字引文',
      '图表需精炼；补充材料承载细节',
      '要求数据共享声明；试验需注册',
      '订阅为主',
      '评审极严，常要求补充分析与独立复核'
    ),
    tips: ['RCT 需 CONSORT 流程图与注册号', '重视「对临床实践的意义」']
  },
  {
    id: 'the-lancet',
    name: 'The Lancet',
    nameZh: '柳叶刀',
    publisher: 'Elsevier',
    kind: 'journal',
    scope: '临床医学与全球健康',
    standing: '临床医学顶级刊；偏好大型、影响实践的研究',
    guideUrl: 'https://www.thelancet.com/information-for-authors',
    homeUrl: 'https://www.thelancet.com/',
    keywords: ['randomized', 'clinical trial', 'patient', 'global health', 'epidemiology', 'mortality', 'public health'],
    limits: { abstractWords: 300 },
    requirements: R(
      '英文（英式）',
      'Articles 篇幅受限，需高度凝练',
      '**结构化摘要**（Background/Methods/Findings/Interpretation/Funding）',
      '数字引文（Vancouver）',
      '图表精炼；研究背景需清晰',
      '要求数据共享声明；试验注册必需',
      '订阅为主；OA 可选',
      '评审严格；周期较长'
    ),
    tips: ['结构化摘要的五个小标题是固定的', '必须写明 Funding 与数据共享声明']
  },
  {
    id: 'elife',
    name: 'eLife',
    nameZh: 'eLife',
    publisher: 'eLife Sciences',
    kind: 'journal',
    scope: '生命科学与生物医学',
    standing: '开放获取；评审流程有「Reviewed Preprint」等创新',
    guideUrl: 'https://elifesciences.org/author-guide',
    homeUrl: 'https://elifesciences.org/',
    keywords: ['cell', 'protein', 'gene', 'neuroscience', 'evolution', 'development', 'mouse', 'biology'],
    requirements: R(
      '英文',
      '篇幅中等；方法与补充材料较详细',
      '一段式摘要',
      '作者-年份风格',
      '鼓励原始数据图与补充图',
      '要求数据/代码可用性声明',
      '开放获取（APC）',
      '评审意见公开（eLife assessment + reviews）'
    ),
    tips: ['接受「Reviewed Preprint」路径，评审意见会公开']
  },

  /* ---------------------------------- 生信 / 计算生物 ---------------------------------- */
  {
    id: 'natmethods',
    name: 'Nature Methods',
    nameZh: '自然·方法',
    publisher: 'Springer Nature',
    kind: 'journal',
    scope: '生命科学新方法/工具（算法、成像、测序、统计）',
    standing: '方法类顶刊；看重「广泛可用性」与基准比较',
    guideUrl: 'https://www.nature.com/nmeth/for-authors',
    homeUrl: 'https://www.nature.com/nmeth',
    keywords: ['method', 'tool', 'algorithm', 'benchmark', 'imaging', 'sequencing', 'single-cell', 'statistics'],
    requirements: R(
      '英文',
      'Method/Analysis 篇幅适中；协议细节进补充材料',
      '一段式；点明方法解决什么问题',
      '数字上标；格式见指南',
      '鼓励方法示意图与基准对比图',
      '**代码必须可获取**（GitHub + 版本/许可证）；需可复现说明',
      '订阅为主；OA 可选',
      '编辑初筛 + 外审；常要求与其他方法基准对比'
    ),
    tips: ['基准对比 + 可复现脚本几乎是硬门槛', '软件需有文档、版本号与许可证']
  },
  {
    id: 'natbiotech',
    name: 'Nature Biotechnology',
    nameZh: '自然·生物技术',
    publisher: 'Springer Nature',
    kind: 'journal',
    scope: '生物技术应用（治疗、诊断、平台、生物信息应用）',
    standing: '应用导向顶刊；看重转化价值与严谨性',
    guideUrl: 'https://www.nature.com/nbt/for-authors',
    homeUrl: 'https://www.nature.com/nbt',
    keywords: ['biotechnology', 'therapeutic', 'diagnostic', 'platform', 'gene editing', 'crispr', 'bioprocess'],
    requirements: R(
      '英文',
      '研究论文篇幅受限；细节进补充材料',
      '一段式，面向跨领域',
      '数字上标',
      '图注自解释；应用/转化示意清晰',
      '要求数据可用性；临床/组学有专门报告规范',
      '订阅为主；OA 可选',
      '编辑初筛 + 外审'
    ),
    tips: ['涉及临床/伦理/专利时提前准备声明与合规材料']
  },
  {
    id: 'nucleic-acids-research',
    name: 'Nucleic Acids Research',
    nameZh: '核酸研究',
    publisher: 'Oxford University Press',
    kind: 'journal',
    scope: '核酸相关（基因组、RNA、结构与计算生物学）',
    standing: '领域权威刊；数据库/工具类有专门栏目',
    guideUrl: 'https://academic.oup.com/nar/pages/General_Instructions',
    homeUrl: 'https://academic.oup.com/nar',
    keywords: ['dna', 'rna', 'genome', 'sequence', 'alignment', 'transcription', 'crispr', 'database', 'web server'],
    requirements: R(
      '英文',
      '研究论文篇幅中等；有 Database / Web Server 专刊',
      '一段式（部分栏目要求结构化）',
      'OUP 风格（按指南）',
      '图表常规；网页服务需给出可访问 URL',
      '强烈要求数据/工具公开可访问',
      '完全开放获取（APC，视机构有减免）',
      '外审周期相对明确'
    ),
    tips: ['Database/Web Server 有固定投稿窗口与专门要求，先查专刊说明']
  },
  {
    id: 'bioinformatics',
    name: 'Bioinformatics',
    nameZh: '生物信息学',
    publisher: 'Oxford University Press',
    kind: 'journal',
    scope: '生物信息方法与软件（偏工程可用性）',
    standing: '生信领域主流刊；看重「可用性 + 基准评估」',
    guideUrl: 'https://academic.oup.com/bioinformatics/pages/General_Instructions',
    homeUrl: 'https://academic.oup.com/bioinformatics',
    keywords: ['bioinformatics', 'genome', 'sequence', 'alignment', 'rnaseq', 'pipeline', 'software', 'workflow'],
    requirements: R(
      '英文',
      '通常较短（Application Note 更短，强调工具可用）',
      '一段式（部分要求动机-结果-可用性结构）',
      '数字引文（按 OUP 指南）',
      '图要能说明方法与评估',
      '**代码/数据必须公开**（仓库链接 + 许可证）',
      '开放获取（APC；可申请减免）',
      '周期通常比顶刊短'
    ),
    tips: [
      '「Availability and implementation」段落是固定要求：给出仓库与许可证',
      'Application Note 适合工具类：短、直给可用性与基准'
    ]
  },
  {
    id: 'briefings-bioinformatics',
    name: 'Briefings in Bioinformatics',
    nameZh: '生物信息学简报',
    publisher: 'Oxford University Press',
    kind: 'journal',
    scope: '生信综述与方法评述、工具对比',
    standing: '综述/评述类影响力高，适合系统性梳理',
    guideUrl: 'https://academic.oup.com/bib/pages/General_Instructions',
    homeUrl: 'https://academic.oup.com/bib',
    keywords: ['review', 'benchmark', 'survey', 'bioinformatics', 'comparison', 'pipeline', 'deep learning'],
    requirements: R(
      '英文',
      '综述较长；要有系统性的对比表',
      '通常要求结构化（背景-方法-结果-结论）',
      '数字引文；综述引文量较大',
      '对比表/流程图是加分项',
      '若做基准实验，同样要求可复现',
      '开放获取（APC）',
      '外审偏「覆盖面与公正性」'
    ),
    tips: ['综述要明确「筛选标准」与「对比维度」，避免流水账']
  },
  {
    id: 'plos-comp-biol',
    name: 'PLOS Computational Biology',
    nameZh: 'PLOS 计算生物学',
    publisher: 'PLOS',
    kind: 'journal',
    scope: '计算生物学全领域；重视可复现与开放科学',
    standing: '主流开放获取刊；审稿强调「可复现性」',
    guideUrl: 'https://journals.plos.org/ploscompbiol/s/submission-guidelines',
    homeUrl: 'https://journals.plos.org/ploscompbiol/',
    keywords: ['computational', 'model', 'simulation', 'genome', 'phylogenetics', 'systems biology', 'deep learning'],
    limits: { abstractWords: 300 },
    requirements: R(
      '英文',
      '篇幅较宽松；强调清晰而非短',
      '作者摘要仅一段；另有面向大众的 Author Summary',
      '数字引文（Vancouver 风格）',
      '图要自解释；支持大量补充材料',
      '**强制**数据/代码可用性声明与开放获取',
      '开放获取（APC；有减免）',
      '外审技术性较强，常要求补可复现细节'
    ),
    tips: ['Author Summary 要用非专业语言写，是评审关注点', '提交前用他们的 submission checklist 自查']
  },
  {
    id: 'bmc-bioinformatics',
    name: 'BMC Bioinformatics',
    nameZh: 'BMC 生物信息学',
    publisher: 'BMC (Springer Nature)',
    kind: 'journal',
    scope: '生信方法、软件与数据分析',
    standing: '开放获取刊，投稿门槛相对友好',
    guideUrl: 'https://bmcbioinformatics.biomedcentral.com/submission-guidelines',
    homeUrl: 'https://bmcbioinformatics.biomedcentral.com/',
    keywords: ['bioinformatics', 'software', 'pipeline', 'analysis', 'genome', 'rnaseq', 'tool'],
    requirements: R(
      '英文',
      '无硬性词数上限，但要求论证充分',
      '**结构化摘要**（Background/Methods/Results/Conclusions）',
      '数字引文',
      '常规',
      '要求数据与代码可用性声明',
      '开放获取（APC；有减免）',
      '外审周期通常中等'
    ),
    tips: ['结构化摘要是硬要求（常见退修点）']
  },

  /* ---------------------------------- 化学 / 物理 / 材料 ---------------------------------- */
  {
    id: 'jacs',
    name: 'JACS',
    nameZh: '美国化学会志',
    publisher: 'American Chemical Society',
    kind: 'journal',
    scope: '化学全领域（含化学生物学、材料化学）',
    standing: '化学顶刊；看重机理与表征完整性',
    guideUrl: 'https://publish.acs.org/publish/author_guidelines?coden=jacsat',
    homeUrl: 'https://pubs.acs.org/journal/jacsat',
    keywords: ['chemistry', 'catalysis', 'synthesis', 'spectroscopy', 'molecule', 'polymer', 'electrochemistry'],
    requirements: R(
      '英文',
      'Communication 很短；Article 篇幅中等',
      '一段式摘要 + 目录图（TOC graphic）',
      'ACS 数字引文风格',
      '需完整表征数据（NMR/MS 等）进 SI',
      '要求数据可用性（如 CIF/原始谱图）',
      '订阅为主；OA 可选',
      '外审较快，重机理与表征'
    ),
    tips: ['TOC graphic 与 SI 表征数据是必交项']
  },
  {
    id: 'angewandte',
    name: 'Angewandte Chemie',
    nameZh: '德国应用化学',
    publisher: 'Wiley',
    kind: 'journal',
    scope: '化学全领域',
    standing: '化学顶刊；Communication 尤其知名',
    guideUrl: 'https://onlinelibrary.wiley.com/page/journal/15213773/homepage/2011_author_guidelines.html',
    homeUrl: 'https://onlinelibrary.wiley.com/journal/15213773',
    keywords: ['chemistry', 'catalysis', 'synthesis', 'molecule', 'material', 'photochemistry'],
    requirements: R(
      '英文（或德文）',
      'Communication 篇幅极短（图数受限）',
      '一段式摘要 + 图形摘要',
      'Wiley 数字引文',
      '表征数据进 SI',
      '要求数据可用性声明',
      '订阅为主；OA 可选',
      'Communication 审稿以「新颖性」为核心'
    ),
    tips: ['Communication 字数/图数上限很严，超限会被退回']
  },
  {
    id: 'prl',
    name: 'Physical Review Letters',
    nameZh: '物理评论快报',
    publisher: 'American Physical Society',
    kind: 'journal',
    scope: '物理学各分支（短篇、强调重要性）',
    standing: '物理顶刊；以「简洁 + 重要」为特色',
    guideUrl: 'https://journals.aps.org/prl/authors',
    homeUrl: 'https://journals.aps.org/prl/',
    keywords: ['physics', 'quantum', 'condensed matter', 'optics', 'statistical mechanics', 'particle', 'simulation'],
    limits: { mainTextPages: 4, note: 'Letter 正文约 4 页（不含参考文献）' },
    requirements: R(
      '英文',
      'Letter 极短；长文可投 PRX/PRB 等',
      '一段式摘要',
      'APS 数字引文',
      '图要精炼；细节进补充材料',
      '要求数据可用性声明',
      '订阅为主；OA 可选',
      '外审看「是否重要/是否新」'
    ),
    tips: ['Letter 与 Regular Article 的篇幅与期待不同，投前先选对类型']
  },
  {
    id: 'nature-physics',
    name: 'Nature Physics',
    nameZh: '自然·物理',
    publisher: 'Springer Nature',
    kind: 'journal',
    scope: '物理学各分支（偏重要进展）',
    standing: '物理顶刊；偏好概念性/广泛意义的成果',
    guideUrl: 'https://www.nature.com/nphys/for-authors',
    homeUrl: 'https://www.nature.com/nphys',
    keywords: ['physics', 'quantum', 'condensed matter', 'optics', 'cold atoms', 'materials'],
    requirements: R(
      '英文',
      'Article/Letter 篇幅受限；细节进补充材料',
      '一段式摘要',
      '数字上标引文',
      '图自解释',
      '要求数据可用性声明',
      '订阅为主；OA 可选',
      '编辑初筛 + 外审'
    ),
    tips: ['强调「对物理学的普遍意义」']
  },
  {
    id: 'advanced-materials',
    name: 'Advanced Materials',
    nameZh: '先进材料',
    publisher: 'Wiley',
    kind: 'journal',
    scope: '材料科学（功能材料、器件、能源、生物材料）',
    standing: '材料顶刊；关注性能突破与器件演示',
    guideUrl: 'https://onlinelibrary.wiley.com/page/journal/15214095/homepage/2011_author_guidelines.html',
    homeUrl: 'https://onlinelibrary.wiley.com/journal/15214095',
    keywords: ['material', 'battery', 'catalyst', 'polymer', 'nanomaterial', 'device', 'energy', 'biomaterial'],
    requirements: R(
      '英文',
      'Communication 很短；Research Article 中等',
      '一段式摘要 + 图形摘要',
      'Wiley 数字引文',
      '性能表征与器件数据要在 SI 完整',
      '要求数据可用性声明',
      '订阅为主；OA 可选',
      '外审重「性能对比与机理」'
    ),
    tips: ['要有横向性能对比表；机理示意是加分项']
  },

  /* ---------------------------------- 计算机 / 机器学习 ---------------------------------- */
  {
    id: 'jmlr',
    name: 'JMLR',
    nameZh: '机器学习研究杂志',
    publisher: 'JMLR',
    kind: 'journal',
    scope: '机器学习理论与方法',
    standing: '机器学习权威期刊；篇幅长、理论性强',
    guideUrl: 'https://www.jmlr.org/author-info.html',
    homeUrl: 'https://www.jmlr.org/',
    keywords: ['machine learning', 'statistical learning', 'optimization', 'theory', 'algorithm', 'probabilistic'],
    requirements: R(
      '英文',
      '篇幅宽松（很多论文很长），但要求完整',
      '一段式摘要',
      '数字或作者-年份（模板固定）',
      '实验需可复现',
      '要求代码/数据可获取（鼓励）',
      '开放获取（无 APC）',
      '审稿周期可能较长（策略：可先投会议再扩展）'
    ),
    tips: ['用官方 LaTeX 模板；理论证明要完整', '会议版扩展需说明差异']
  },
  {
    id: 'tpami',
    name: 'IEEE TPAMI',
    nameZh: 'IEEE 模式分析与机器智能汇刊',
    publisher: 'IEEE',
    kind: 'journal',
    scope: '计算机视觉、模式识别、机器学习',
    standing: 'CV/ML 顶级期刊；偏长文与系统性工作',
    guideUrl: 'https://www.computer.org/csdl/journal/tp/write-for-us',
    homeUrl: 'https://www.computer.org/csdl/journal/tp',
    keywords: ['computer vision', 'pattern recognition', 'deep learning', 'image', 'segmentation', 'detection', 'neural network'],
    requirements: R(
      '英文',
      '篇幅较长（常见期刊版扩展会议论文）',
      '一段式摘要',
      'IEEE 数字引文',
      '需完整实验（多数据集 + 消融）',
      '鼓励公开代码',
      '订阅为主',
      '审稿周期长（多轮）'
    ),
    tips: ['会议扩展需新增 ≥30% 内容并引用原会议版']
  },
  {
    id: 'cvpr',
    name: 'CVPR',
    nameZh: '计算机视觉与模式识别会议',
    publisher: 'IEEE/CVF',
    kind: 'conference',
    scope: '计算机视觉',
    standing: 'CV 顶会；双盲、时间线严格、竞争激烈',
    guideUrl: 'https://cvpr.thecvf.com/',
    homeUrl: 'https://cvpr.thecvf.com/',
    keywords: ['computer vision', 'image', 'detection', 'segmentation', 'generative', 'diffusion', 'deep learning', 'benchmark'],
    limits: { mainTextPages: 8, note: '正文约 8 页（不含参考文献）' },
    requirements: R(
      '英文',
      '正文页数有硬上限（附录/参考文献不计）',
      '需先提交摘要、再交全文',
      '官方 LaTeX 模板（CVPR 样式）',
      '图表计入正文页数',
      '鼓励代码与补充材料',
      '无版面费',
      '双盲评审 + rebuttal'
    ),
    tips: ['必须用官方模板；超页会直接拒', '双盲：正文与补充材料都要匿名']
  },
  {
    id: 'acl',
    name: 'ACL',
    nameZh: '国际计算语言学大会',
    publisher: 'ACL',
    kind: 'conference',
    scope: '自然语言处理与计算语言学',
    standing: 'NLP 顶会；双盲、时间线严格',
    guideUrl: 'https://www.aclweb.org/portal/',
    homeUrl: 'https://www.aclweb.org/',
    keywords: ['nlp', 'natural language', 'language model', 'transformer', 'translation', 'text', 'embeddings'],
    limits: { mainTextPages: 8, note: '长文正文约 8 页（参考文献/附录不计）' },
    requirements: R(
      '英文',
      'Long/Short Paper 有不同页数上限',
      '需先交摘要',
      'ACL 官方模板',
      '图表计入正文',
      '鼓励提交代码与数据（可选）',
      '无版面费',
      '双盲 + rebuttal；还含伦理审查（ethics）表'
    ),
    tips: ['需填写 Limitations 与 Ethics 部分（很多会被退修）']
  },
  {
    id: 'neurips',
    name: 'NeurIPS',
    nameZh: '神经信息处理系统大会',
    publisher: 'NeurIPS Foundation',
    kind: 'conference',
    scope: '机器学习 / 计算神经科学',
    standing: '机器学习顶会；双盲评审、时间线严格',
    guideUrl: 'https://neurips.cc/',
    homeUrl: 'https://neurips.cc/',
    keywords: ['machine learning', 'deep learning', 'neural network', 'reinforcement learning', 'optimization', 'generative', 'benchmark'],
    limits: { mainTextPages: 9, note: '正文页数上限（参考文献/附录不计，按当年指南）' },
    requirements: R(
      '英文',
      '正文页数有硬上限（不含参考文献/附录）',
      '需在截止前单独提交摘要',
      '使用官方 LaTeX 模板',
      '图表计入正文页数',
      '鼓励提供代码/补充材料（可复现性评审项）',
      '无版面费；注册费另计',
      '双盲 + 领域主席；时间线严格'
    ),
    tips: ['必须用官方模板，页数超限直接拒', '双盲：正文与补充材料都要匿名', '补充材料不计页数，可放实验细节']
  },
  {
    id: 'icml',
    name: 'ICML',
    nameZh: '国际机器学习大会',
    publisher: 'ICML',
    kind: 'conference',
    scope: '机器学习',
    standing: '机器学习顶会；评审意见较为技术化',
    guideUrl: 'https://icml.cc/',
    homeUrl: 'https://icml.cc/',
    keywords: ['machine learning', 'deep learning', 'optimization', 'representation learning', 'generative', 'theory', 'benchmark'],
    limits: { mainTextPages: 8, note: '正文页数上限（参考文献/附录不计，按当年指南）' },
    requirements: R(
      '英文',
      '正文页数有硬上限（附录不限）',
      '需与全文分别在两个截止时间提交',
      '官方 LaTeX 模板（固定样式）',
      '图表计入正文页数',
      '鼓励开放代码与补充材料',
      '无版面费',
      '双盲 + rebuttal 阶段'
    ),
    tips: ['模板与页数上限是硬约束', 'rebuttal 只回应关键质疑、用数据说话']
  }
]

/** 按 id 取 */
export function getJournal(id: string): Journal | undefined {
  return JOURNALS.find((j) => j.id === id)
}
