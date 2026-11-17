import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import { runSurvey } from '../services/survey'
import type { SurveyResult, SurveyRunOptions } from '../../shared/survey'

export function registerSurveyHandlers(): void {
  ipcMain.handle(
    CH.survey.run,
    (_e, opts: SurveyRunOptions): Promise<SurveyResult> => runSurvey(opts)
  )
}
