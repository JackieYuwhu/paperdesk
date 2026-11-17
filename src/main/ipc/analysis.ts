import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import {
  analyzePaper,
  comparePapers,
  readAnalysisSkill,
  resetAnalysisSkill,
  saveAnalysisSkill,
  listAnalysisSkills,
  copyAnalysisSkill,
  deleteAnalysisSkill
} from '../services/analysis'
import type { AnalysisDepth, AnalysisResult, CompareResult } from '../services/analysis'

/** 论文拆解（paper-analysis 技能；支持多套技能） */
export function registerAnalysisHandlers(): void {
  ipcMain.handle(
    CH.analysis.run,
    (
      _e,
      opts: { attachmentId: number; focus?: string; depth?: AnalysisDepth; sections?: number[]; skill?: string }
    ): Promise<AnalysisResult> => analyzePaper(opts)
  )
  ipcMain.handle(
    CH.analysis.compare,
    (
      _e,
      opts: { attachmentIds: number[]; focus?: string; skill?: string }
    ): Promise<CompareResult> => comparePapers(opts)
  )
  ipcMain.handle(CH.analysis.getSkill, (_e, name?: string): string => readAnalysisSkill(name))
  ipcMain.handle(CH.analysis.saveSkill, (_e, text: string, name?: string): string =>
    saveAnalysisSkill(text, name)
  )
  ipcMain.handle(CH.analysis.resetSkill, (_e, name?: string): string => resetAnalysisSkill(name))
  ipcMain.handle(CH.analysis.listSkills, (): string[] => listAnalysisSkills())
  ipcMain.handle(CH.analysis.copySkill, (_e, from: string, to: string): string =>
    copyAnalysisSkill(from, to)
  )
  ipcMain.handle(CH.analysis.deleteSkill, (_e, name: string): string[] =>
    deleteAnalysisSkill(name)
  )
}
