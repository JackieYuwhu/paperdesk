import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import { getDb } from '../db'
import { runExtraction, runStructure } from '../services/extract'
import type {
  AuthorRef,
  ExtractSummary,
  Item,
  MetadataView,
  ReferenceView,
  StructureResult
} from '../../shared/types'

export function registerMetadataHandlers(): void {
  ipcMain.handle(
    CH.metadata.extract,
    (
      _e,
      attachmentId: number,
      opts?: { forceVision?: boolean; forceTitle?: boolean }
    ): Promise<ExtractSummary> => {
      return runExtraction(attachmentId, opts ?? {})
    }
  )

  ipcMain.handle(CH.metadata.structure, (_e, attachmentId: number): Promise<StructureResult> => {
    return runStructure(attachmentId)
  })

  ipcMain.handle(CH.metadata.get, (_e, itemId: number): MetadataView => {
    const db = getDb()
    const item = (db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Item) ?? null
    const authors = db
      .prepare(
        `SELECT a.id AS id, a.display_name AS name, a.orcid AS orcid
         FROM item_authors ia JOIN authors a ON a.id = ia.author_id
         WHERE ia.item_id = ? ORDER BY ia.position`
      )
      .all(itemId) as AuthorRef[]
    const references = db
      .prepare(
        `SELECT c.id AS id, c.ref_index AS refIndex, c.target_raw AS raw, c.resolved AS resolved,
                w.doi AS doi, w.title AS title
         FROM citations c LEFT JOIN works w ON w.id = c.target_work_id
         WHERE c.source_item_id = ? ORDER BY c.ref_index`
      )
      .all(itemId) as Array<Omit<ReferenceView, 'resolved'> & { resolved: number }>

    return {
      item,
      authors,
      references: references.map((r) => ({ ...r, resolved: !!r.resolved }))
    }
  })
}
