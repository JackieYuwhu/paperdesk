import { join } from 'node:path'

/**
 * 解析数据根目录。
 * 允许用环境变量 `PAPERDESK_DATA` 覆盖真实 userData —— 测试 / CI 用它保证
 * **绝不写入用户的真实数据目录**。
 *
 * 纯函数（不依赖 electron），便于单元测试。
 */
export function resolveDataDir(
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = (env?.PAPERDESK_DATA ?? '').trim()
  return override ? override : join(userDataPath, 'data')
}
