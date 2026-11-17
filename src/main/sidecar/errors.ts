/**
 * sidecar 生命周期相关的**纯**错误文案构造（不依赖 electron），便于单元测试。
 */

/** 子进程 spawn 抛错（如 ENOENT = 找不到解释器）时的可操作提示 */
export function spawnErrorMessage(err: { code?: string; message?: string }): string {
  if (err?.code === 'ENOENT') {
    return '未找到 Python，无法启动 sidecar（请安装 Python 3.10+，或通过 PAPERDESK_PYTHON 指定解释器）'
  }
  return `无法启动 sidecar：${err?.message ?? '未知错误'}`
}

/** 子进程在健康检查通过前提前退出时的提示 */
export function earlyExitMessage(code: number | null, signal: string | null): string {
  return `sidecar 进程提前退出（code=${code}${signal ? `, signal=${signal}` : ''}），请检查 Python 环境`
}
