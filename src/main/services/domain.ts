import { getDb } from '../db'
import { fallbackDomain } from '../../shared/domain'
import { generate } from './llm'
import { sessionFor } from './settings'

const SYSTEM_PROMPT =
  '你是学术论文领域标注助手。请根据论文的标题与摘要，给出该论文所属的**研究领域**。' +
  '要求：中文不超过 8 个字（如「自然语言处理」「计算机视觉」「凝聚态物理」），' +
  '英文不超过 3 个单词；只输出领域名称本身，不要标点、序号或任何解释。'

/** 归一化模型输出：取首行、去掉引号/序号/收尾标点、限长 */
export function cleanDomain(raw: string): string {
  let t = (raw ?? '').trim()
  if (!t) return ''
  t = t.split(/\r?\n/)[0] ?? ''
  // 去掉常见前缀「领域：」与包裹的引号
  t = t.replace(/^[\s"'“”‘’（(【\[]*(?:领域|学科|研究方向|field|domain)\s*[:：]\s*/i, '')
  t = t.replace(/^[\s"'“”‘’（(【\[]+/, '').replace(/[\s"'“”‘’）)】\]。．.,，;；:：]+$/, '')
  t = t.trim()
  if (!t) return ''
  return t.length > 24 ? t.slice(0, 24) : t
}

/**
 * 用 AI 识别条目领域并写库（best-effort）：
 * - 模型不可用/返回空时用本地关键词兜底，保证导入后必有标签；
 * - 已有领域时不重复识别；
 * - 失败不影响导入 / 抽取主流程。
 */
export async function classifyItemDomain(itemId: number): Promise<string | null> {
  const db = getDb()
  const item = db
    .prepare('SELECT id, title, abstract, domain FROM items WHERE id = ?')
    .get(itemId) as
    | { id: number; title: string | null; abstract: string | null; domain: string | null }
    | undefined
  if (!item) return null
  const existing = (item.domain ?? '').trim()
  if (existing) return existing

  const title = (item.title ?? '').trim()
  const abstract = (item.abstract ?? '').trim()
  if (!title && !abstract) return null

  let text = ''
  try {
    const r = await generate({
      system: SYSTEM_PROMPT,
      user: `标题：${title}\n摘要：${abstract.slice(0, 1500)}`,
      mock: () => '',
      temperature: 0,
      session: sessionFor.chat()
    })
    text = r.text
  } catch (e) {
    console.warn('[paperdesk] 领域识别失败，使用本地兜底:', e instanceof Error ? e.message : e)
  }

  const domain = cleanDomain(text) || fallbackDomain(title, abstract)
  if (!domain) return null
  db.prepare('UPDATE items SET domain = ?, date_modified = ? WHERE id = ?').run(
    domain,
    new Date().toISOString(),
    itemId
  )
  return domain
}
