import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import {
  batchWindowStatus,
  cancelJob,
  createJob,
  createRetryJob,
  createRetryAllJobs,
  startScheduledJobs,
  estimateJob,
  runTaskOnce,
  listItems,
  listJobs,
  listTasks,
  openOutput,
  removeJob
} from '../services/batch/queue'
import { getTask } from '../services/batch/registry'
import { validateCreateInput } from '../services/batch/validate'
import type { BatchEstimate } from '../../shared/batch-estimate'
import type {
  BatchItemRow,
  BatchJob,
  BatchTaskInfo,
  BatchWindowStatus
} from '../../shared/types'

export function registerBatchHandlers(): void {
  ipcMain.handle(CH.batch.tasks, (): BatchTaskInfo[] => listTasks())
  ipcMain.handle(
    CH.batch.create,
    (_e, input: unknown): BatchJob =>
      createJob(validateCreateInput(input, (id) => !!getTask(id)))
  )
  ipcMain.handle(CH.batch.list, (): BatchJob[] => listJobs())
  ipcMain.handle(CH.batch.items, (_e, jobId: number): BatchItemRow[] => listItems(jobId))
  ipcMain.handle(CH.batch.cancel, (_e, jobId: number): void => cancelJob(jobId))
  ipcMain.handle(CH.batch.remove, (_e, jobId: number): void => removeJob(jobId))
  ipcMain.handle(CH.batch.openOutput, (_e, jobId: number): Promise<void> => openOutput(jobId))
  ipcMain.handle(CH.batch.status, (): BatchWindowStatus => batchWindowStatus())
  ipcMain.handle(CH.batch.retryFailed, (_e, jobId: number): BatchJob => createRetryJob(jobId))
  ipcMain.handle(CH.batch.retryAllFailed, (): BatchJob[] => createRetryAllJobs())
  ipcMain.handle(CH.batch.startPending, (): BatchJob[] => startScheduledJobs())
  ipcMain.handle(CH.batch.estimate, (_e, input: unknown): BatchEstimate => {
    const v = validateCreateInput(input, (id) => !!getTask(id))
    return estimateJob(v)
  })
  ipcMain.handle(
    CH.batch.runOnce,
    (
      _e,
      taskId: string,
      target: { attachmentId?: number | null; itemId?: number | null },
      params?: Record<string, string>
    ): Promise<{ ok: boolean; message: string; outputs: string[] }> =>
      runTaskOnce(taskId, target ?? {}, params ?? {})
  )
}
