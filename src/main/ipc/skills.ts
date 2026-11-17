import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import {
  applyLastSkillsImport,
  exportSkillsFile,
  listSkills,
  pickSkillsFile,
  resetSkills,
  saveSkill
} from '../services/skills'
import type { TranslateSkill } from '../../shared/types'

export function registerSkillsHandlers(): void {
  ipcMain.handle(CH.skills.list, (): Promise<TranslateSkill[]> => listSkills())

  ipcMain.handle(
    CH.skills.save,
    (_e, id: string, system: string, skip: boolean, scope: string): Promise<TranslateSkill[]> =>
      saveSkill(id, system ?? '', !!skip, scope ?? 'all')
  )

  ipcMain.handle(CH.skills.reset, (): Promise<TranslateSkill[]> => resetSkills())

  ipcMain.handle(CH.skills.export, (): Promise<string | null> => exportSkillsFile())

  ipcMain.handle(CH.skills.import, () => pickSkillsFile())

  ipcMain.handle(CH.skills.applyImport, (_e, force: boolean, only?: string[]) =>
    applyLastSkillsImport(!!force, only)
  )
}
