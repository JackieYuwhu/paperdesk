import { getDb } from '../db'
import { resolveStoragePath } from './storage'
import { ensureSidecar } from '../sidecar/manager'
import type { Attachment } from '../../shared/types'

/** 一页里的矢量图形区域与图表题注（坐标：底边原点，y 向上，与 pdf.js 一致） */
export interface FigureCaption {
  n: number
  letter: string
  kind: 'figure' | 'table'
  rect: [number, number, number, number]
}
export interface FigurePage {
  page: number
  w: number
  h: number
  rects: Array<[number, number, number, number]>
  captions: FigureCaption[]
}

function attPath(attachmentId: number): string | null {
  const att = getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId) as
    | Attachment
    | undefined
  return att ? resolveStoragePath(att.path) : null
}

/**
 * 取附件的「矢量图形区域 + 图表题注」（侧车脚本计算，不调模型）。
 * 失败时返回空数组（渲染层回退到启发式）。
 */
export async function getFigureRegions(attachmentId: number): Promise<FigurePage[]> {
  const absPath = attPath(attachmentId)
  if (!absPath) return []
  try {
    const base = await ensureSidecar()
    const res = await fetch(`${base}/figures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: absPath })
    })
    if (!res.ok) return []
    const data = (await res.json()) as { pages?: FigurePage[] }
    return Array.isArray(data.pages) ? data.pages : []
  } catch {
    return []
  }
}

/** 把某页的某个区域渲染成 PNG（base64）——供网页译文里的图表预览使用 */
export async function getFigureImage(
  attachmentId: number,
  page: number,
  rect: [number, number, number, number],
  scale: number
): Promise<{ png: string; w: number; h: number } | null> {
  const absPath = attPath(attachmentId)
  if (!absPath) return null
  try {
    const base = await ensureSidecar()
    const res = await fetch(`${base}/figure-image`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: absPath, page, rect, scale })
    })
    if (!res.ok) return null
    const data = (await res.json()) as { png?: string; w?: number; h?: number }
    if (!data.png) return null
    return { png: data.png, w: data.w ?? 0, h: data.h ?? 0 }
  } catch {
    return null
  }
}
