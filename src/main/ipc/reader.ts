import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import { getDb } from '../db'
import { generateKey } from '../db/keys'
import { getFigureRegions, getFigureImage } from '../services/figures'
import { getFormulas, getModules, selectFormulaResult } from '../services/modules'
import type { FormulaValidation } from '../../shared/formula-validate'
import type { Annotation, AnnotationType, NewAnnotation } from '../../shared/types'

const nowIso = (): string => new Date().toISOString()

const VALID_TYPES: AnnotationType[] = ['highlight', 'underline', 'note']

function validate(p: NewAnnotation): void {
  if (!p || typeof p.attachmentId !== 'number') throw new Error('attachmentId 无效')
  if (!VALID_TYPES.includes(p.type)) throw new Error(`批注类型无效: ${p.type}`)
  if (typeof p.pageIndex !== 'number' || p.pageIndex < 0) throw new Error('pageIndex 无效')
  if (!Array.isArray(p.rects) || p.rects.length === 0) throw new Error('rects 不能为空')
  for (const r of p.rects) {
    if (!Array.isArray(r) || r.length !== 4 || r.some((n) => typeof n !== 'number' || !isFinite(n))) {
      throw new Error('rect 必须是 [x1,y1,x2,y2] 数值')
    }
  }
}

export function registerReaderHandlers(): void {
  ipcMain.handle(CH.reader.listAnnotations, (_e, attachmentId: number, translationId?: number | null): Annotation[] => {
    return getDb()
      .prepare(
        'SELECT * FROM annotations WHERE attachment_id = ? AND json_extract(position, \'$.translationId\') IS ? ORDER BY page_index, sort_index'
      )
      .all(attachmentId, translationId ?? null) as Annotation[]
  })

  ipcMain.handle(CH.reader.createAnnotation, (_e, p: NewAnnotation): Annotation => {
    validate(p)
    const db = getDb()
    if (p.translationId != null && !db.prepare('SELECT id FROM translations WHERE id = ? AND attachment_id = ?').get(p.translationId, p.attachmentId)) {
      throw new Error('译文不属于当前附件')
    }
    const key = generateKey()
    const ts = nowIso()
    // 归一化每个矩形的角点顺序
    const rects = p.rects.map((r) => [
      Math.min(r[0], r[2]),
      Math.min(r[1], r[3]),
      Math.max(r[0], r[2]),
      Math.max(r[1], r[3])
    ])
    const position = JSON.stringify({ pageIndex: p.pageIndex, rects, ...(p.translationId != null ? { translationId: p.translationId } : {}) })
    const sortIndex = String(Math.round(rects[0][1]))

    const res = db
      .prepare(
        `INSERT INTO annotations
           (key, attachment_id, type, text, prefix, suffix, comment, color,
            page_index, position, sort_index, date_added, date_modified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        key,
        p.attachmentId,
        p.type,
        p.text ?? null,
        p.prefix ?? null,
        p.suffix ?? null,
        p.comment ?? null,
        p.color ?? null,
        p.pageIndex,
        position,
        sortIndex,
        ts,
        ts
      )

    return db
      .prepare('SELECT * FROM annotations WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as Annotation
  })

  ipcMain.handle(CH.reader.deleteAnnotation, (_e, id: number): void => {
    getDb().prepare('DELETE FROM annotations WHERE id = ?').run(id)
  })

  ipcMain.handle(CH.reader.figures, (_e, attachmentId: number) => getFigureRegions(attachmentId))
  ipcMain.handle(CH.reader.modules, (_e, attachmentId: number) => getModules(attachmentId))
  ipcMain.handle(CH.reader.formulas, (_e, attachmentId: number) => getFormulas(attachmentId))
  ipcMain.handle(
    CH.reader.saveModuleLatex,
    (
      _e,
      attachmentId: number,
      moduleId: string,
      latex: string,
      source: 'extracted' | 'recognized',
      validation?: FormulaValidation
    ): boolean =>
      selectFormulaResult(attachmentId, moduleId, {
        latex,
        source: source === 'recognized' ? 'formula_ocr' : 'structural',
        validation
      })
  )
  ipcMain.handle(
    CH.reader.figureImage,
    (
      _e,
      attachmentId: number,
      page: number,
      rect: [number, number, number, number],
      scale: number
    ) => getFigureImage(attachmentId, page, rect, scale)
  )
}
