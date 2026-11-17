import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import { listDir, openInVSCode, openPath, revealPath } from '../services/files'
import type { FsListing, OpenInResult } from '../../shared/types'

export function registerFilesHandlers(): void {
  ipcMain.handle(CH.files.list, (_e, path?: string): FsListing => listDir(path ?? ''))

  ipcMain.handle(CH.files.open, (_e, path: string): Promise<void> => openPath(path))

  ipcMain.handle(CH.files.reveal, (_e, path: string): void => revealPath(path))

  ipcMain.handle(CH.files.vscode, (_e, path: string): Promise<OpenInResult> => openInVSCode(path))
}
