import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import type { TestFaultStatus } from '../../shared/types'
import {
  backupDialog,
  backupTo,
  backupsDir,
  restoreDialog,
  restoreFrom
} from '../services/backup'
import { IS_TEST_COPY, activeTestFault } from '../test-profile'

/** 数据安全：数据库备份 / 恢复（阶段 2） */
export function registerDataHandlers(): void {
  ipcMain.handle(CH.data.backupDir, (): string => backupsDir())
  ipcMain.handle(CH.data.backup, (): Promise<string | null> => backupDialog())
  ipcMain.handle(
    CH.data.restore,
    (): Promise<{ restored: string; safety: string | null } | null> => restoreDialog()
  )
  // 程序化接口（无对话框；供测试/自动化使用）
  ipcMain.handle(CH.data.backupTo, (_e, dest: string): Promise<string> => backupTo(dest))
  ipcMain.handle(
    CH.data.restoreFrom,
    (_e, src: string): { restored: string; safety: string | null } => restoreFrom(src)
  )
  // 测试副本故障注入状态（FA02）：正式版 IS_TEST_COPY=false，恒为未启用
  ipcMain.handle(
    CH.data.testFault,
    (): TestFaultStatus => ({ isTestCopy: IS_TEST_COPY, fault: activeTestFault() })
  )
}
