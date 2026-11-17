import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import { connectorStatusAsync, setConnectorEnabledAsync } from '../services/connector'
import type { ConnectorStatus } from '../../shared/types'

/** Zotero 连接器：状态查询 + 启用/停用切换 */
export function registerConnectorHandlers(): void {
  ipcMain.handle(CH.connector.status, (): Promise<ConnectorStatus> => connectorStatusAsync())
  ipcMain.handle(
    CH.connector.setEnabled,
    (_e, enabled: boolean): Promise<ConnectorStatus> => setConnectorEnabledAsync(!!enabled)
  )
}
