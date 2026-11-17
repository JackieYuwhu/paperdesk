import { getDb } from '../db'
import { aiTitle } from './ai'
import type {
  AiChatMessage,
  AiConversation,
  AiConversationSummary,
  AskSelection
} from '../../shared/types'

const nowIso = (): string => new Date().toISOString()

/** 论文对应的「第一份附件」（多份附件只取第一份用于展示） */
function primaryAttachment(itemId: number | null): { id: number; filename: string } | null {
  if (itemId == null) return null
  const row = getDb()
    .prepare('SELECT id, filename FROM attachments WHERE item_id = ? ORDER BY id LIMIT 1')
    .get(itemId) as { id: number; filename: string } | undefined
  return row ?? null
}

function itemTitle(itemId: number | null): string | null {
  if (itemId == null) return null
  const row = getDb().prepare('SELECT title FROM items WHERE id = ?').get(itemId) as
    | { title: string | null }
    | undefined
  return row?.title ?? null
}

function decorate(row: {
  id: number
  title: string
  item_id: number | null
  attachment_id: number | null
  created_at: string
  updated_at: string
}): AiConversation {
  const att = primaryAttachment(row.item_id)
  return {
    id: row.id,
    title: row.title,
    itemId: row.item_id,
    attachmentId: row.attachment_id,
    itemTitle: itemTitle(row.item_id),
    attachmentName: att?.filename ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** 对话列表（最近更新在前） */
export function listConversations(limit = 100): AiConversationSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.title, c.item_id, c.attachment_id, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS msg_count
       FROM ai_conversations c
       ORDER BY c.updated_at DESC LIMIT ?`
    )
    .all(limit) as Array<{
    id: number
    title: string
    item_id: number | null
    attachment_id: number | null
    created_at: string
    updated_at: string
    msg_count: number
  }>
  return rows.map((r) => ({ ...decorate(r), messageCount: r.msg_count }))
}

export function getConversation(id: number): {
  conversation: AiConversation
  messages: AiChatMessage[]
} | null {
  const row = getDb().prepare('SELECT * FROM ai_conversations WHERE id = ?').get(id) as
    | {
        id: number
        title: string
        item_id: number | null
        attachment_id: number | null
        created_at: string
        updated_at: string
      }
    | undefined
  if (!row) return null
  const msgs = getDb()
    .prepare('SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY sort_index, id')
    .all(id) as Array<{
    id: number
    role: string
    content: string
    citations_json: string | null
    context_json?: string | null
    sort_index: number
    created_at: string
  }>
  return {
    conversation: decorate(row),
    messages: msgs.map((m) => {
      // 选区上下文是可选的（老库无此列/老消息无值）；解析失败按无上下文处理，不影响历史
      let context: AskSelection | null = null
      if (m.context_json) {
        try {
          const parsed = JSON.parse(m.context_json) as Partial<AskSelection>
          if (parsed && typeof parsed.text === 'string' && parsed.text)
            context = {
              text: parsed.text,
              attachmentId: parsed.attachmentId ?? null,
              page: parsed.page ?? null,
              origin: parsed.origin === 'selection' ? 'selection' : 'paste'
            }
        } catch {
          context = null
        }
      }
      return {
        id: m.id,
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
        citations: m.citations_json ? JSON.parse(m.citations_json) : [],
        context,
        createdAt: m.created_at
      }
    })
  }
}

/** 新建对话（记录论文 + 第一份附件；标题留空，稍后由模型生成） */
export function createConversation(input: {
  itemId?: number | null
  attachmentId?: number | null
  title?: string
}): AiConversation {
  const itemId = input.itemId ?? null
  const att = primaryAttachment(itemId)
  const ts = nowIso()
  const info = getDb()
    .prepare(
      `INSERT INTO ai_conversations (title, item_id, attachment_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.title ?? '', itemId, att?.id ?? input.attachmentId ?? null, ts, ts)
  const id = Number(info.lastInsertRowid)
  return decorate({
    id,
    title: input.title ?? '',
    item_id: itemId,
    attachment_id: att?.id ?? input.attachmentId ?? null,
    created_at: ts,
    updated_at: ts
  })
}

/** 追加一条消息（返回该消息 id）；context 为该轮选区上下文（完整原文/附件/页码） */
export function appendMessage(
  conversationId: number,
  msg: {
    role: 'user' | 'assistant'
    content: string
    citations?: unknown
    context?: AskSelection | null
  }
): number {
  const db = getDb()
  const next = (
    db
      .prepare('SELECT COALESCE(MAX(sort_index), -1) + 1 AS n FROM ai_messages WHERE conversation_id = ?')
      .get(conversationId) as { n: number }
  ).n
  const info = db
    .prepare(
      `INSERT INTO ai_messages (conversation_id, role, content, citations_json, context_json, sort_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      conversationId,
      msg.role,
      msg.content ?? '',
      msg.citations ? JSON.stringify(msg.citations) : null,
      msg.context ? JSON.stringify(msg.context) : null,
      next,
      nowIso()
    )
  db.prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?').run(nowIso(), conversationId)
  return Number(info.lastInsertRowid)
}

export function renameConversation(id: number, title: string): boolean {
  const t = (title ?? '').trim()
  if (!t) return false
  const info = getDb()
    .prepare('UPDATE ai_conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(t.slice(0, 60), nowIso(), id)
  return info.changes > 0
}

export function deleteConversation(id: number): boolean {
  const db = getDb()
  db.prepare('DELETE FROM ai_messages WHERE conversation_id = ?').run(id)
  const info = db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(id)
  return info.changes > 0
}

/**
 * 生成标题：优先用模型（AI 生成）；未配置模型/失败时回退到「首个问题」截断。
 * 只对还没有标题的对话生成，避免覆盖用户手动改过的名字。
 */
export async function generateTitle(conversationId: number, force = false): Promise<string> {
  const db = getDb()
  const conv = db.prepare('SELECT title FROM ai_conversations WHERE id = ?').get(conversationId) as
    | { title: string }
    | undefined
  if (!conv) return ''
  if (conv.title && !force) return conv.title
  const firstUser = db
    .prepare(
      "SELECT content FROM ai_messages WHERE conversation_id = ? AND role = 'user' ORDER BY sort_index, id LIMIT 1"
    )
    .get(conversationId) as { content: string } | undefined
  const seed = (firstUser?.content ?? '').replace(/\s+/g, ' ').trim()
  if (!seed) return ''
  let title = await aiTitle(seed)
  if (!title) title = seed.length > 18 ? `${seed.slice(0, 18)}…` : seed
  db.prepare('UPDATE ai_conversations SET title = ? WHERE id = ?').run(title, conversationId)
  return title
}
