import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { getDb } from '../../db'
import { resolveStoragePath } from '../storage'
import { archiveAll, exportQa, translatedDir, runTranslation } from '../translate'
import {
  exportZip,
  pruneTranslations,
  renderTranslationManifest,
  translationInfo
} from '../translate'
import { exportDocument } from '../export'
import { buildGraph } from '../discovery'
import { analyzePaper, compareFromCards } from '../analysis'
import { upsertSectionInItemNote, upsertSectionInStandaloneNote, readSectionFromStandaloneNote } from '../notes'
import { appendOverviewRow, checkAnalysis, formatQuality } from '../../../shared/analysis-check'
import { search } from '../search'
import { indexAttachment } from '../embed'
import { generate } from '../llm'
import { sessionFor } from '../settings'
import { uniqueBatchOutput } from './filenames'
import type {
  BatchTaskHandler,
  BatchTaskHandler as H,
  BatchContext,
  BatchInput,
  BatchItemResult
} from './types'
import type { Attachment } from '../../../shared/types'

/* ============================ 共用：范式与逐节抽取 ============================ */

interface Section {
  key: string
  label: string
  query: string
}

const DEFAULT_LABELS = ['研究问题 / 背景', '方法', '数据集与实验设置', '主要结果', '贡献', '局限与未来工作']

const TEMPLATE_PRESETS = [
  { name: '默认（六段式）', value: DEFAULT_LABELS.join('\n') },
  {
    name: '方法学对比',
    value: ['研究问题', '方法', '数据集', '基线', '评价指标', '主要结果', '局限'].join('\n')
  },
  { name: '综述速览', value: ['领域背景', '主要进展', '争议点', '研究空白', '对我的启示'].join('\n') }
]

const QUERY_HINTS: Array<{ match: RegExp; query: string }> = [
  { match: /问题|背景|动机|problem|background|motiv/i, query: 'problem challenge difficult limitation of prior' },
  { match: /方法|method|approach|architect/i, query: 'we propose method approach architecture model' },
  { match: /数据|实验|设置|dataset|experiment|setup/i, query: 'dataset training experiments setup benchmark' },
  { match: /基线|指标|baseline|metric/i, query: 'baseline metric evaluation comparison' },
  { match: /结果|result/i, query: 'results achieve outperform state-of-the-art improvement' },
  { match: /贡献|contribution/i, query: 'contribution we introduce novel first' },
  { match: /局限|未来|limitation|future/i, query: 'limitation future work remain open' },
  { match: /空白|gap|争议|controvers/i, query: 'open problem debate inconsistent' },
  { match: /启示|takeaway|implication/i, query: 'implication insight practical' }
]

function queryFor(label: string): string {
  const hit = QUERY_HINTS.find((h) => h.match.test(label))
  return hit ? hit.query : label
}

/** 解析范式（每行一节）；留空用默认 */
export function parseSections(template: string): Section[] {
  const lines = (template || '')
    .split('\n')
    .map((s) => s.trim().replace(/^[-*\d.]+\s*/, ''))
    .filter(Boolean)
  const labels = lines.length > 0 ? lines : DEFAULT_LABELS
  return labels.map((label, i) => ({ key: `s${i}`, label, query: queryFor(label) }))
}

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * 逐节抽取：每节一次生成调用（离线时用词法检索取最相关原文）。
 * 逐节调用便于「多篇对比表」直接拿到结构化字段，无需解析模型输出的格式。
 */
async function extractSections(
  itemId: number,
  sections: Section[],
  ctx: BatchContext
): Promise<{ backend: string; sections: Array<{ label: string; text: string }> }> {
  const db = getDb()
  const chunks = db
    .prepare(
      `SELECT c.text AS text FROM chunks c
       JOIN attachments a ON a.id = c.attachment_id
       WHERE a.item_id = ? ORDER BY c.page_index, c.id LIMIT 40`
    )
    .all(itemId) as Array<{ text: string }>
  if (chunks.length === 0) throw new Error('没有可用的全文分块，请先「识别元数据」')

  const context = chunks
    .map((c) => c.text.replace(/\s+/g, ' '))
    .join('\n')
    .slice(0, 8000)

  const out: Array<{ label: string; text: string }> = []
  let backend = 'mock'

  for (const s of sections) {
    if (ctx.isCancelled()) break
    const r = await generate({
      session: sessionFor.batch(ctx.jobId),
      system:
        'You are a research-paper analyst. Answer in Chinese, at most 120 words, using ONLY the given paper text. ' +
        'If the section is not covered, write 未提及.',
      user: `Section: ${s.label}\n\nPaper text:\n${context}`,
      mock: () => {
        const hit = search(s.query, 1).find((h) => h.kind === 'chunk')
        if (hit?.snippet) return hit.snippet
        const c = chunks[hashStr(s.label) % chunks.length].text.replace(/\s+/g, ' ')
        return `${c.slice(0, 180)}…`
      }
    })
    backend = r.backend
    out.push({ label: s.label, text: r.text.replace(/\s+/g, ' ').trim() || '未提及' })
  }
  return { backend, sections: out }
}

function templateField(rows = 5): NonNullable<BatchTaskHandler['paramFields']>[number] {
  return {
    key: 'template',
    label: '范式（每行一节）',
    type: 'textarea',
    rows,
    placeholder: DEFAULT_LABELS.join('\n'),
    hint: '每行一个章节名；留空用默认六段式',
    presets: TEMPLATE_PRESETS
  }
}

/* ============================ 1) 翻译（保版式） ============================ */

const translateTask: H = {
  id: 'translate',
  title: '翻译论文（保版式）',
  description: '',
  input: 'attachment',
  usesLlm: true,
  paramFields: [
    {
      key: 'mode',
      label: '翻译模式',
      type: 'select',
      default: 'fine',
      options: [
        { value: 'fine', label: '精译（逐段重排、还原样式）' },
        { value: 'coarse', label: '粗译（快速通读，允许少量排版瑕疵）' }
      ]
    },
    {
      key: 'format',
      label: '产物格式',
      type: 'select',
      default: 'pdf',
      options: [
        { value: 'pdf', label: 'PDF（保版式）' },
        { value: 'md', label: 'Markdown（文本）' },
        { value: 'zip', label: '打包 ZIP（全部产物）' }
      ]
    },
    {
      key: 'layout',
      label: '版式',
      type: 'select',
      default: 'reflow',
      options: [
        { value: 'reflow', label: '可读重排（默认，允许推挤/回收空白）' },
        { value: 'strict', label: '严格保版式（段顶固定、不跨栏）' }
      ]
    },
    {
      key: 'backend',
      label: '翻译后端',
      type: 'select',
      default: '',
      options: [
        { value: '', label: '跟随设置' },
        { value: 'mock', label: 'mock（离线）' },
        { value: 'openai', label: 'OpenAI 兼容' }
      ]
    }
  ],
  async run(input: BatchInput, ctx: BatchContext) {
    if (!input.attachment) throw new Error('该条目没有附件')
    // 取消已请求：不再发起翻译模型请求
    if (ctx.isCancelled()) throw new Error('已取消')
    const lang = ctx.params.lang || 'zh'
    const format = ctx.params.format || 'pdf'
    const mode = ctx.params.mode === 'coarse' ? 'coarse' : 'fine'
    const layout = ctx.params.layout === 'strict' ? 'strict' : 'reflow'
    const backend = ctx.params.backend || undefined
    const force = ctx.params.force === '1'

    const tr = await runTranslation(
      input.attachment.id,
      { lang, mode, layout, ...(backend ? { backend } : {}), ...(force ? { force } : {}) },
      (p) => ctx.log(p.message ?? p.stage),
      ctx.isCancelled
    )
    const dir = translatedDir()
    const key = input.attachment.key

    const copyAs = (rel: string | null | undefined, ext: string): string | null => {
      if (!rel) return null
      const src = join(dir, rel)
      if (!existsSync(src)) return null
      const outName = `${key}.${lang}.${ext}`
      copyFileSync(src, join(ctx.outDir, outName))
      return outName
    }

    if (format === 'pdf') {
      const name = copyAs(tr.path, 'pdf')
      if (!name) throw new Error('未生成译文 PDF')
      return { outputs: [name], message: `译文 PDF：${name}` }
    }
    if (format === 'zip') {
      const z = await exportZip(tr.id)
      const outName = `${key}.${lang}.zip`
      copyFileSync(z, join(ctx.outDir, outName))
      return { outputs: [outName], message: `打包：${outName}` }
    }
    if (format === 'md') {
      const name = copyAs(tr.md_path, 'md')
      if (name) return { outputs: [name], message: `译文导出 Markdown：${name}` }
      throw new Error('未生成 Markdown（译文为空或导出失败）')
    }
    throw new Error(`不支持的产物格式：${format}`)
  }
}

const translateArchiveTask: H = {
  id: 'translate-archive',
  title: '翻译并归档（笔记 + ZIP）',
  description: '翻译后把译文/对照写入该论文笔记（带页码锚点），并打包 ZIP 到输出目录。',
  input: 'attachment',
  usesLlm: true,
  paramFields: [
    {
      key: 'lang',
      label: '目标语言',
      type: 'select',
      default: 'zh',
      options: [
        { value: 'zh', label: '中文' },
        { value: 'en', label: '英文' }
      ]
    },
    {
      key: 'mode',
      label: '翻译模式',
      type: 'select',
      default: 'fine',
      options: [
        { value: 'fine', label: '精译' },
        { value: 'coarse', label: '粗译（快速）' }
      ]
    },
    {
      key: 'force',
      label: '重新翻译',
      type: 'select',
      default: '0',
      options: [
        { value: '0', label: '否（复用已有译文）' },
        { value: '1', label: '是（强制重新调用模型）' }
      ]
    },
    {
      key: 'copyTo',
      label: '另存目录',
      type: 'text',
      default: '',
      placeholder: '绝对路径 / ~/下载 / 相对输出目录'
    },
    {
      key: 'keepHistory',
      label: '历史版本',
      type: 'select',
      default: 'all',
      options: [
        { value: 'all', label: '保留全部' },
        { value: 'latest', label: '归档后只保留最新版' }
      ]
    }
  ],
  async run(input: BatchInput, ctx: BatchContext) {
    if (!input.attachment) throw new Error('该条目没有附件')
    // 取消已请求：不再发起翻译模型请求
    if (ctx.isCancelled()) throw new Error('已取消')
    const lang = ctx.params.lang || 'zh'
    const mode = ctx.params.mode === 'coarse' ? 'coarse' : 'fine'
    const force = ctx.params.force === '1'
    const tr = await runTranslation(
      input.attachment.id,
      { lang, mode, ...(force ? { force } : {}) },
      (p) => ctx.log(p.message ?? p.stage),
      ctx.isCancelled
    )
    // 翻译期间被取消：不再归档、写清单或复制文件
    if (ctx.isCancelled()) throw new Error('已取消')
    ctx.log('归档到笔记并打包…')
    const r = await archiveAll(tr.id)
    const outName = `${input.attachment.key}.${lang}.archive.zip`
    const outputs = [outName]
    try {
      copyFileSync(r.zip, join(ctx.outDir, outName))
    } catch {
      /* 复制失败不致命 */
    }

    // 质量自检清单（落盘到输出目录）
    let qaName = ''
    try {
      const qaAbs = exportQa(tr.id)
      copyFileSync(qaAbs, join(ctx.outDir, `${input.attachment.key}.${lang}.qa.md`))
      qaName = `${input.attachment.key}.${lang}.qa.md`
      outputs.push(qaName)
    } catch (e) {
      ctx.log(`自检清单生成失败：${e instanceof Error ? e.message : String(e)}`)
    }

    // 产出清单 manifest（列出各产物路径，便于追溯）
    try {
      const manifest = renderTranslationManifest(translationInfo(tr.id), {
        id: tr.id,
        zip: outName,
        qa: qaName || undefined
      })
      const mName = `${input.attachment.key}.${lang}.manifest.md`
      writeFileSync(join(ctx.outDir, mName), manifest, 'utf8')
      outputs.push(mName)
    } catch (e) {
      ctx.log(`manifest 生成失败：${e instanceof Error ? e.message : String(e)}`)
    }

    // 可选：额外复制到用户指定目录（支持 ~ 展开与「相对输出目录」）
    const copyToRaw = (ctx.params.copyTo || '').trim()
    if (copyToRaw) {
      const expanded =
        copyToRaw === '~' || copyToRaw.startsWith('~/') || copyToRaw.startsWith('~\\')
          ? join(homedir(), copyToRaw.slice(1))
          : copyToRaw
      const target = isAbsolute(expanded) ? expanded : join(ctx.outDir, expanded)
      try {
        if (existsSync(target)) {
          copyFileSync(r.zip, join(target, outName))
          outputs.push(`→ ${join(target, outName)}`)
        } else {
          ctx.log(`另存目录不存在，已跳过：${target}`)
        }
      } catch (e) {
        ctx.log(`复制到另存目录失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    // 可选：归档后清理历史版本（只保留最新一份）
    if ((ctx.params.keepHistory || 'all') === 'latest') {
      try {
        const n = pruneTranslations(input.attachment.id, lang, 1)
        if (n > 0) ctx.log(`已清理 ${n} 份历史译文`)
      } catch (e) {
        ctx.log(`清理历史失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return { outputs, message: `已归档到笔记并打包：${outName}` }
  }
}

/* ============================ 1c) 论文拆解（paper-analysis） ============================ */
const analyzeTask: H = {
  id: 'analyze-paper',
  title: '论文拆解（paper-analysis）',
  description:
    '按「研究问题 / 缺口 / 贡献 / 方法 / 证据 / 局限 / 图表与复现 / 综合」八项逐篇拆解，产出带 [p.N] 定位的报告；可选在最后生成批次对比索引 index.md。',
  input: 'attachment',
  usesLlm: true,
  paramFields: [
    {
      key: 'depth',
      label: '篇幅',
      type: 'select',
      default: 'standard',
      options: [
        { value: 'brief', label: '速览（≤350 字/篇）' },
        { value: 'standard', label: '标准（700–1200 字/篇）' },
        { value: 'deep', label: '深入（按需展开）' }
      ]
    },
    {
      key: 'focus',
      label: '研究方向（可选）',
      type: 'text',
      default: '',
      placeholder: '例如：蛋白结构预测的可复现性'
    },
    {
      key: 'compare',
      label: '生成批次对比',
      type: 'select',
      default: '0',
      options: [
        { value: '0', label: '否（只出每篇报告）' },
        { value: '1', label: '是（全部跑完后出 index.md 对比表）' }
      ]
    },
    {
      key: 'archiveNote',
      label: '归档到笔记',
      type: 'select',
      default: '1',
      options: [
        { value: '1', label: '是（写入该论文笔记的小节）' },
        { value: '0', label: '否' }
      ]
    },
    {
      key: 'sections',
      label: '分析维度',
      type: 'select',
      default: 'all',
      options: [
        { value: 'all', label: '全部八项' },
        { value: 'core', label: '核心四项（贡献/方法/证据/局限）' },
        { value: 'quick', label: '速览三项（问题/贡献/证据）' }
      ]
    },
    {
      key: 'indexNote',
      label: '汇总笔记',
      type: 'select',
      default: '0',
      options: [
        { value: '0', label: '否（只出 index.md）' },
        { value: '1', label: '是（写入「论文拆解汇总」笔记）' }
      ]
    }
  ],
  async run(input: BatchInput, ctx: BatchContext) {
    if (!input.attachment) throw new Error('该条目没有附件')
    // 取消已请求：不再发起拆解模型请求
    if (ctx.isCancelled()) throw new Error('已取消')
    const depth = (ctx.params.depth || 'standard') as 'brief' | 'standard' | 'deep'
    const focus = (ctx.params.focus || '').trim()
    const secMode = ctx.params.sections || 'all'
    const sections =
      secMode === 'core'
        ? [3, 4, 5, 6]
        : secMode === 'quick'
          ? [1, 3, 5]
          : [1, 2, 3, 4, 5, 6, 7, 8]
    const r = await analyzePaper({ attachmentId: input.attachment.id, focus, depth, sections })
    const title = input.item?.title || input.attachment.key
    const name = uniqueBatchOutput(ctx.outDir, title, '.analysis.md')
    const q = checkAnalysis(r.markdown)
    writeFileSync(
      join(ctx.outDir, name),
      `# ${title}\n\n> 证据自检：${formatQuality(q)}\n\n${r.markdown}\n`,
      'utf8'
    )
    let archived = ''
    if (ctx.params.archiveNote !== '0' && input.item?.id != null) {
      try {
        const note = upsertSectionInItemNote(input.item.id, `论文拆解（${depth}）`, r.markdown)
        archived = ` · 已写入笔记「${note.title ?? '阅读笔记'}」`
      } catch (e) {
        ctx.log(`归档到笔记失败：${e instanceof Error ? e.message : String(e)}`)
        archived = ' · 笔记归档失败（详见作业日志）'
      }
    }
    return {
      outputs: [name],
      message: r.empty
        ? `${title}：未取到正文（建议先抽取）`
        : `${title}：${r.pages} 页 / ${r.chars} 字${r.reduced ? '（分段合并）' : ''} · 维度 ${sections.join('/')} · 调用 ${r.calls ?? 1} 次 · 自检 ${q.locators}/${q.claims}${archived}`
    }
  },
  async finalize(ctx: BatchContext, results: BatchItemResult[]) {
    const files = readdirSync(ctx.outDir).filter((f) => f.endsWith('.analysis.md'))
    const cards = files.map((f) => {
      const md = readFileSync(join(ctx.outDir, f), 'utf8')
      const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? f.replace(/\.analysis\.md$/, '')).trim()
      const body = md
        .replace(/^#\s+.+$/m, '')
        .replace(/^>\s*证据自检：.*$/m, '')
        .trim()
      return { title, markdown: body }
    })
    const lines: string[] = ['# 论文拆解 · 批次索引', '']
    lines.push(`- 完成：${results.filter((r) => r.ok).length} / ${results.length} 篇`)
    lines.push(`- 篇幅：${ctx.params.depth || 'standard'}`)
    lines.push(`- 研究方向：${(ctx.params.focus || '').trim() || '（未指定）'}`)
    lines.push(`- 生成时间：${new Date().toISOString()}`)
    lines.push('')
    lines.push('## 每篇报告')
    lines.push('')
    for (const f of files) lines.push(`- \`${f}\``)
    lines.push('')
    if ((ctx.params.compare || '0') === '1' && cards.length >= 2) {
      ctx.log('生成批次对比…')
      try {
        const { compare } = await compareFromCards(cards, (ctx.params.focus || '').trim())
        lines.push('## 批次对比')
        lines.push('')
        lines.push(compare)
        lines.push('')
      } catch (e) {
        ctx.log(`批次对比失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    writeFileSync(join(ctx.outDir, 'index.md'), lines.join('\n'), 'utf8')
    const outputs = ['index.md']
    // 可选：把汇总写入「论文拆解汇总」独立笔记（跨多批长期累积）
    if (ctx.params.indexNote === '1') {
      try {
        const qa = cards.map((c) => checkAnalysis(c.markdown))
        const loc = qa.reduce((n, x) => n + x.locators, 0)
        const cl = qa.reduce((n, x) => n + x.claims, 0)
        const prev = readSectionFromStandaloneNote('REVIEWANALYSIS', '总览')
        upsertSectionInStandaloneNote(
          'REVIEWANALYSIS',
          '论文拆解汇总',
          '总览',
          appendOverviewRow(prev, [
            ctx.jobKey,
            new Date().toISOString().slice(0, 16).replace('T', ' '),
            String(cards.length),
            ctx.params.depth || 'standard',
            ctx.params.sections || 'all',
            `${loc}/${cl}`
          ])
        )
        const { mdPath } = upsertSectionInStandaloneNote(
          'REVIEWANALYSIS',
          '论文拆解汇总',
          `批次 ${ctx.jobKey}`,
          lines.join('\n')
        )
        outputs.push(mdPath)
      } catch (e) {
        ctx.log(`写入汇总笔记失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return { outputs, message: `批次索引已生成（${cards.length} 篇）` }
  }
}

/* ============================ 1d) 翻译 + 论文拆解（一体化） ============================ */
const translateAnalyzeTask: H = {
  id: 'translate-analyze',
  title: '翻译 + 论文拆解',
  description: '先保版式翻译，再按八项拆解；拆解结果自动写入该论文笔记。',
  input: 'attachment',
  usesLlm: true,
  paramFields: [],
  async run(input: BatchInput, ctx: BatchContext) {
    if (ctx.isCancelled()) throw new Error('已取消')
    const tr = await translateTask.run(input, ctx)
    // 翻译阶段被取消：不再继续拆解（避免取消后仍发起模型请求）
    if (ctx.isCancelled()) throw new Error('已取消')
    const an = await analyzeTask.run(input, {
      ...ctx,
      params: { ...ctx.params, archiveNote: '1', compare: '0', sections: 'all' }
    })
    return {
      outputs: [...tr.outputs, ...an.outputs],
      message: `${tr.message ?? '翻译完成'}；${an.message ?? '拆解完成'}`
    }
  }
}

/* ============================ 2) 导出文档（保公式排版） ============================ */
const exportTask: H = {
  id: 'export-doc',
  title: '导出为 md / html / pdf',
  description: '抽取正文并尽量保留公式排版。可选 MinerU 引擎把公式转成 LaTeX。',
  input: 'attachment',
  paramFields: [
    {
      key: 'format',
      label: '输出格式',
      type: 'select',
      default: 'html',
      options: [
        { value: 'html', label: 'HTML（自包含）' },
        { value: 'md', label: 'Markdown' },
        { value: 'pdf', label: 'PDF（重排）' }
      ]
    },
    {
      key: 'engine',
      label: '解析引擎',
      type: 'select',
      default: 'simple',
      options: [
        { value: 'simple', label: '内置（不重排，保留公式原样）' },
        { value: 'mineru', label: 'MinerU（公式转 LaTeX，需安装）' }
      ],
      hint: '未安装 MinerU 时自动回退内置引擎'
    }
  ],
  async run(input: BatchInput, ctx: BatchContext) {
    if (!input.attachment) throw new Error('该条目没有附件')
    const format = (ctx.params.format || 'html') as 'md' | 'html' | 'pdf'
    const engine = ctx.params.engine || 'simple'
    const outName = `${input.attachment.key}.${format}`
    const res = await exportDocument(
      resolveStoragePath(input.attachment.path),
      join(ctx.outDir, outName),
      format,
      engine
    )
    const warn = res.warnings?.length ? ` ⚠ ${res.warnings.join('；')}` : ''
    return {
      outputs: [outName],
      message: `${res.engine ?? engine}：${res.blocks} 段 / 公式 ${res.formulas} / 图 ${res.images}${warn}`
    }
  }
}

/* ============================ 3) 找相关论文 ============================ */

const relatedTask: H = {
  id: 'find-related',
  title: '查找相关论文',
  description: '按 OpenAlex 拉取参考文献/施引文献/相关论文，输出 JSON 与 Markdown 报告。',
  input: 'item',
  paramFields: [
    { key: 'top', label: '每类条数上限', type: 'text', default: '15', placeholder: '例如 15' }
  ],
  async run(input: BatchInput, ctx: BatchContext) {
    if (!input.item) throw new Error('缺少条目')
    const g = await buildGraph(input.item.id)
    if (!g.seed) throw new Error(g.warnings.join('；') || '未找到该论文')

    const top = Math.max(1, Math.min(50, Number(ctx.params.top) || 15))
    const base = input.item.key
    writeFileSync(join(ctx.outDir, `${base}-related.json`), JSON.stringify(g, null, 2), 'utf8')

    const lines = [`# 相关论文：${g.seed.title ?? base}`, '']
    lines.push(`- 参考文献：${g.stats.references}`, `- 施引文献：${g.stats.citations}`, `- 相关论文：${g.stats.related}`, '')
    const group = (kind: string, title: string): void => {
      const rows = g.nodes
        .filter((n) => n.kind === kind)
        .sort((a, b) => b.citedBy - a.citedBy)
        .slice(0, top)
      if (!rows.length) return
      lines.push(`## ${title}`, '')
      rows.forEach((n, i) => {
        const doi = n.doi ? ` · https://doi.org/${n.doi}` : ''
        lines.push(`${i + 1}. ${n.title ?? n.id}（${n.year ?? '—'} · 被引 ${n.citedBy}）${doi}`)
      })
      lines.push('')
    }
    group('reference', '参考文献')
    group('citation', '施引文献')
    group('related', '相关论文')
    writeFileSync(join(ctx.outDir, `${base}-related.md`), lines.join('\n'), 'utf8')

    return {
      outputs: [`${base}-related.json`, `${base}-related.md`],
      message: `refs ${g.stats.references} / cites ${g.stats.citations} / related ${g.stats.related}`
    }
  }
}

/* ============================ 4) 按范式拆解论文 ============================ */

const decomposeTask: H = {
  id: 'decompose',
  title: '按范式拆解论文',
  description: '按给定范式结构化抽取，输出 Markdown 与 JSON。范式可自定义（每行一节）。',
  input: 'item',
  usesLlm: true,
  paramFields: [templateField(6)],
  async run(input: BatchInput, ctx: BatchContext) {
    if (!input.item) throw new Error('缺少条目')
    const sections = parseSections(ctx.params.template || '')
    ctx.log(`范式：${sections.map((s) => s.label).join(' / ')}`)
    const r = await extractSections(input.item.id, sections, ctx)

    const base = input.item.key
    const md =
      `# ${input.item.title ?? base} — 论文拆解\n\n` +
      `> 范式：${r.sections.map((s) => s.label).join(' / ')}\n` +
      `> 生成后端：${r.backend}\n\n` +
      r.sections.map((s) => `## ${s.label}\n\n${s.text}\n`).join('\n')
    writeFileSync(join(ctx.outDir, `${base}-decompose.md`), md, 'utf8')
    writeFileSync(
      join(ctx.outDir, `${base}-decompose.json`),
      JSON.stringify(
        { item: base, title: input.item.title, backend: r.backend, sections: r.sections },
        null,
        2
      ),
      'utf8'
    )
    return {
      outputs: [`${base}-decompose.md`, `${base}-decompose.json`],
      message: `后端 ${r.backend}`
    }
  }
}

/* ============================ 5) 多篇论文对比表 ============================ */

function csvCell(s: string): string {
  return `"${(s ?? '').replace(/"/g, '""')}"`
}

const compareTask: H = {
  id: 'compare',
  title: '多篇论文对比表',
  description: '按同一范式抽取多篇论文，汇总成一张对比表（Markdown / CSV）。',
  input: 'item',
  usesLlm: true,
  paramFields: [templateField(6)],
  async run(input: BatchInput, ctx: BatchContext) {
    if (!input.item) throw new Error('缺少条目')
    const sections = parseSections(ctx.params.template || '')
    const r = await extractSections(input.item.id, sections, ctx)
    const base = input.item.key
    const payload = {
      key: base,
      title: input.item.title ?? base,
      year: input.item.year,
      backend: r.backend,
      sections: r.sections
    }
    writeFileSync(join(ctx.outDir, `${base}.sections.json`), JSON.stringify(payload, null, 2), 'utf8')
    return { outputs: [`${base}.sections.json`], message: `${r.sections.length} 节` }
  },
  async finalize(ctx: BatchContext, results: BatchItemResult[]) {
    const files = readdirSync(ctx.outDir).filter((f) => f.endsWith('.sections.json'))
    const rows: Array<{
      title: string
      year: number | null
      sections: Array<{ label: string; text: string }>
    }> = []
    for (const f of files) {
      try {
        const p = JSON.parse(readFileSync(join(ctx.outDir, f), 'utf8')) as {
          title: string
          year: number | null
          sections: Array<{ label: string; text: string }>
        }
        rows.push(p)
      } catch {
        /* 跳过损坏文件 */
      }
    }
    if (rows.length === 0) throw new Error('没有可汇总的结果')

    const labels = rows[0].sections.map((s) => s.label)
    const header = ['论文', ...labels]
    const md =
      `# 论文对比表（${rows.length} 篇）\n\n` +
      `| ${header.join(' | ')} |\n` +
      `| ${header.map(() => '---').join(' | ')} |\n` +
      rows
        .map((r) => `| ${r.title} | ${labels.map((l) => r.sections.find((s) => s.label === l)?.text ?? '').join(' | ')} |`)
        .join('\n') +
      '\n'
    writeFileSync(join(ctx.outDir, 'compare.md'), md, 'utf8')

    const csv = [header.map(csvCell).join(',')]
      .concat(
        rows.map((r) =>
          [r.title, ...labels.map((l) => r.sections.find((s) => s.label === l)?.text ?? '')]
            .map(csvCell)
            .join(',')
        )
      )
      .join('\n')
    // 带 BOM，Excel 打开中文不乱码
    writeFileSync(join(ctx.outDir, 'compare.csv'), '\ufeff' + csv, 'utf8')

    return {
      outputs: ['compare.md', 'compare.csv'],
      message: `汇总 ${rows.length} 篇 / ${labels.length} 节（成功 ${results.filter((r) => r.ok).length}）`
    }
  }
}

/* ============================ 6) 重建向量索引 ============================ */

const embedTask: H = {
  id: 'embed',
  title: '重建向量索引',
  description: '为附件的全文分块重新生成向量（用于语义检索）。',
  input: 'attachment',
  paramFields: [],
  async run(input: BatchInput, ctx: BatchContext) {
    if (!input.attachment) throw new Error('该条目没有附件')
    const r = await indexAttachment(input.attachment.id)
    const outName = `${input.attachment.key}-embed.json`
    writeFileSync(
      join(ctx.outDir, outName),
      JSON.stringify({ attachment: input.attachment.key, indexed: r.indexed, model: r.model }, null, 2),
      'utf8'
    )
    return { outputs: [outName], message: `已索引 ${r.indexed} 块（${r.model}）` }
  }
}

export const TASKS: BatchTaskHandler[] = [
  translateTask,
  translateArchiveTask,
  analyzeTask,
  translateAnalyzeTask,
  exportTask,
  relatedTask,
  decomposeTask,
  compareTask,
  embedTask
]

/** 面板只暴露日常需要的三项；其余任务保留 API 兼容，但不再出现在批处理下拉里 */
const PUBLIC_TASK_IDS = new Set(['translate', 'analyze-paper', 'translate-analyze'])

export function getTask(id: string): BatchTaskHandler | undefined {
  return TASKS.find((t) => t.id === id)
}

export interface BatchTaskInfoLite {
  id: string
  title: string
  description: string
  input: 'attachment' | 'item'
  usesLlm: boolean
  paramFields: BatchTaskHandler['paramFields']
}

export function taskInfos(): BatchTaskInfoLite[] {
  return TASKS.filter((t) => PUBLIC_TASK_IDS.has(t.id)).map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    input: t.input,
    usesLlm: !!t.usesLlm,
    paramFields: t.paramFields
  }))
}

export type { BatchContext, BatchInput }
export type { Attachment }
