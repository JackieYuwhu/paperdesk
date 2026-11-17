import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import {
  applyOrganize,
  listOrganizeCandidates,
  listOrganizeVersions,
  previewOrganize,
  restoreOrganizeVersion,
  type OrganizeApplyResult,
  type OrganizePreviewRequest,
  type OrganizePreviewResult,
  type OrganizeVersionRow
} from '../services/organize'
import type { OrganizeDraft } from '../../shared/organize'

export function registerOrganizeHandlers(): void {
  ipcMain.handle(
    CH.organize.preview,
    (_e, request: OrganizePreviewRequest): Promise<OrganizePreviewResult> =>
      previewOrganize(request)
  )

  ipcMain.handle(
    CH.organize.apply,
    (_e, drafts: OrganizeDraft[], opts: { scopeKey: string; label?: string | null }): Promise<OrganizeApplyResult> =>
      applyOrganize(Array.isArray(drafts) ? drafts : [], opts ?? { scopeKey: 'organize' })
  )

  ipcMain.handle(
    CH.organize.versions,
    (_e, scopeKey?: string | null): OrganizeVersionRow[] => listOrganizeVersions(scopeKey ?? null)
  )

  ipcMain.handle(
    CH.organize.restore,
    (_e, versionId: number): { ok: boolean; message: string } => restoreOrganizeVersion(versionId)
  )

  ipcMain.handle(CH.organize.candidates, () => listOrganizeCandidates())
}
