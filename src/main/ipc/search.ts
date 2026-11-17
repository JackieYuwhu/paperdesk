import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { CH, EVT } from '../../shared/channels'
import { search } from '../services/search'
import {
  ask,
  cancelAsk,
  formulaFromImage,
  latexFromText,
  tableFromImage,
  type FormulaResult,
  type TableResult
} from '../services/ai'
import { recognizeFormulaCandidates } from '../services/formula-ocr'
import { findPapers } from '../services/paper-finder'
import {
  appendMessage,
  createConversation,
  deleteConversation,
  generateTitle,
  getConversation,
  listConversations,
  renameConversation
} from '../services/ai-chat'
import { indexAttachment } from '../services/embed'
import type {
  AskProgress,
  AskRequest,
  AskResult,
  PaperFindResult,
  SearchHit
} from '../../shared/types'

/**
 * 问答请求：参数形状统一来自 shared/types 的 AskRequest（渲染层 → preload → IPC → ai.ask）。
 * 进度事件带 requestId，界面按请求过滤；取消走 CH.ai.cancel。
 */
function withProgress(
  event: IpcMainInvokeEvent,
  opts: AskRequest
): { opts: AskRequest; onProgress: (p: AskProgress) => void } {
  const requestId = opts.requestId ?? opts.streamId ?? ''
  return {
    opts,
    onProgress: (p: AskProgress) => {
      if (!requestId) return
      try {
        event.sender.send(EVT.aiProgress, { ...p, requestId })
      } catch {
        /* 窗口已关闭：进度无处可推，不影响主流程 */
      }
    }
  }
}

export function registerSearchHandlers(): void {
  ipcMain.handle(CH.search.query, (_e, text: string, limit?: number): SearchHit[] => {
    return search(text ?? '', limit ?? 20)
  })

  ipcMain.handle(
    CH.search.index,
    (_e, attachmentId: number): Promise<{ indexed: number; model: string }> => {
      return indexAttachment(attachmentId)
    }
  )

  ipcMain.handle(
    CH.ai.ask,
    (event, question: string, raw?: AskRequest): Promise<AskResult> => {
      const { opts, onProgress } = withProgress(event, raw ?? {})
      return ask(question ?? '', { ...opts, onProgress })
    }
  )

  // 流式问答：逐段把 delta 推给渲染层（同一套检索/引用）
  ipcMain.handle(
    CH.ai.askStream,
    (event, question: string, raw?: AskRequest): Promise<AskResult> => {
      const { opts, onProgress } = withProgress(event, raw ?? {})
      const streamId = opts.streamId ?? ''
      return ask(question ?? '', { ...opts, onProgress }, (delta: string) => {
        if (streamId) event.sender.send(EVT.aiStream, { streamId, delta })
      })
    }
  )

  // 取消进行中的问答/翻译（模型请求已发出时尽快断开，分段翻译保留已完成段）
  ipcMain.handle(CH.ai.cancel, (_e, requestId?: string): boolean => cancelAsk(requestId))

  ipcMain.handle(
    CH.ai.formula,
    (_e, imageB64: string, mime?: string): Promise<FormulaResult> =>
      formulaFromImage(imageB64 ?? '', mime ?? 'image/png')
  )

  ipcMain.handle(
    CH.ai.table,
    (_e, imageB64: string, mime?: string): Promise<TableResult> =>
      tableFromImage(imageB64 ?? '', mime ?? 'image/png')
  )

  ipcMain.handle(
    CH.ai.formulaCandidates,
    (_e, imageB64: string, rawText: string) =>
      recognizeFormulaCandidates(imageB64 ?? '', rawText ?? '')
  )

  ipcMain.handle(
    CH.ai.latex,
    (_e, text: string): Promise<{ latex: string }> => latexFromText(text ?? '')
  )

  // ---- 对话历史 ----
  ipcMain.handle(CH.ai.listConversations, (_e, limit?: number) => listConversations(limit ?? 100))
  ipcMain.handle(CH.ai.getConversation, (_e, id: number) => getConversation(id))
  ipcMain.handle(
    CH.ai.createConversation,
    (_e, input: { itemId?: number | null; attachmentId?: number | null; title?: string }) =>
      createConversation(input ?? {})
  )
  ipcMain.handle(
    CH.ai.appendMessage,
    (
      _e,
      conversationId: number,
      msg: { role: 'user' | 'assistant'; content: string; citations?: unknown }
    ) => appendMessage(conversationId, msg)
  )
  ipcMain.handle(CH.ai.renameConversation, (_e, id: number, title: string) =>
    renameConversation(id, title)
  )
  ipcMain.handle(CH.ai.deleteConversation, (_e, id: number) => deleteConversation(id))
  ipcMain.handle(CH.ai.generateTitle, (_e, id: number, force?: boolean) =>
    generateTitle(id, force === true)
  )

  // 「用 AI 找论文」：一句话需求 → 去重后的结构化论文列表
  ipcMain.handle(
    CH.ai.findPapers,
    (
      _e,
      question: string,
      opts?: {
        limit?: number
        sort?: 'relevance' | 'cited' | 'recent'
        yearFrom?: number | null
        yearTo?: number | null
        minCited?: number | null
        oaOnly?: boolean
        useAi?: boolean
      }
    ): Promise<PaperFindResult> => findPapers(question ?? '', opts ?? {})
  )
}
