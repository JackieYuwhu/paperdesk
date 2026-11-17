import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 测试副本基础设施；正式应用的运行行为完全不受影响。
 *
 * 这个模块有两条加载路径：electron-vite 打出的主进程 CJS（有 `__dirname`，指向 out/main）
 * 和 `node scripts/test-unit.ts` / `test-coords.ts` 的纯 Node ESM 直跑（没有 `__dirname`）。
 * 所以 electron 只允许在函数内部延迟 require，模块顶层只碰 node 内置模块；
 * 否则单测脚本会因为无法解析 electron 而整个起不来。
 */
const root = typeof __dirname === 'string' ? join(__dirname, '../..') : process.cwd()
export const IS_TEST_COPY = existsSync(join(root, '.nightshift', 'ISOLATED_TEST_COPY'))

function electronModule(): typeof import('electron') {
  // 延迟 require：见文件头注释。主进程产物是 CJS，这里的 require 是可用且必需的。
  return require('electron') as typeof import('electron')
}

/* ------------------------------ 可控故障注入 ------------------------------ */

/** 故障开关的环境变量名（只有测试副本读它） */
export const TEST_FAULT_ENV = 'PAPERDESK_TEST_FAULT'
export const TEST_FAULTS = ['copy-fail', 'search-fail'] as const
export type TestFault = (typeof TEST_FAULTS)[number]
/** 测试 profile 根目录下的控制文件：存在时覆盖环境变量，空文件表示清除故障 */
export const TEST_FAULT_FILE_NAME = 'test-fault.txt'

/** 测试 profile 根目录，供控制文件定位；未配置时为 null */
let testProfileDir: string | null = null

/** 把原始字符串解析成受支持的故障；大小写与空白都不敏感，未知值视为未开启 */
export function parseTestFault(raw: string | null | undefined): TestFault | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  return (TEST_FAULTS as readonly string[]).includes(value) ? (value as TestFault) : null
}

/**
 * 生产不可达的保证就只有这一处判断：非测试副本一律返回 null，
 * 环境变量和控制文件都不会被读到。
 */
export function resolveTestFault(
  isTestCopy: boolean,
  raw: string | null | undefined
): TestFault | null {
  if (!isTestCopy) return null
  return parseTestFault(raw)
}

export function testFaultControlPath(): string | null {
  return testProfileDir ? join(testProfileDir, TEST_FAULT_FILE_NAME) : null
}

/** 每次调用都重新解析：清掉控制文件/环境变量后下一次请求立刻恢复正常 */
export function activeTestFault(isTestCopy: boolean = IS_TEST_COPY): TestFault | null {
  if (!isTestCopy) return null
  const control = testFaultControlPath()
  if (control && existsSync(control)) return parseTestFault(readFileSync(control, 'utf8'))
  return resolveTestFault(isTestCopy, process.env[TEST_FAULT_ENV])
}

export function testFaultActive(fault: TestFault, isTestCopy: boolean = IS_TEST_COPY): boolean {
  return activeTestFault(isTestCopy) === fault
}

/* ------------------------------ 与恢复流程的接线 ------------------------------ */

/**
 * 恢复流程（src/main/services/backup.ts）的 copy-fail 必须用同一套测试副本判定，
 * 但它不能静态 import 本模块：Node 原生 TS 直跑（scripts/test-unit.ts）只认带扩展名的
 * 相对导入，而 tsconfig.node.json 没开 allowImportingTsExtensions，两种写法无法同时满足。
 * 所以在本模块加载时单向登记读取器；正式构建（非测试副本）根本不登记，
 * 生产路径上连读取器都不存在，自然读不到这个开关。
 */
export const TEST_FAULT_READER = Symbol.for('paperdesk.testFaultReader')

if (IS_TEST_COPY) {
  Object.defineProperty(globalThis, TEST_FAULT_READER, {
    value: activeTestFault,
    configurable: true,
    writable: true,
    enumerable: false
  })
}

/** search-fail 命中时抛给渲染进程的文案：说明是测试注入，并给出去掉故障的办法 */
export const SEARCH_FAULT_MESSAGE =
  '测试故障注入（search-fail）：搜索暂不可用，清除 test-fault.txt 或 PAPERDESK_TEST_FAULT 后重试'

/**
 * 搜索查询通道名，与 src/shared/channels.ts 的 `CH.search.query` 必须一致。
 * 这里不 import channels.ts 是刻意的：本模块要被 `node scripts/test-unit.ts` 直接加载，
 * 而那条路径只认带扩展名的 ESM 说明符；单测里会断言两者相等，改通道名时不会漏。
 */
export const SEARCH_QUERY_CHANNEL = 'search:query'

type IpcListener = (event: unknown, ...args: unknown[]) => unknown

export interface IpcHandleHost {
  handle: (channel: string, listener: IpcListener) => void
}

/** 只在命中 search-fail 时拦下搜索查询通道，其余通道原样注册 */
export function guardSearchQueryListener(
  listener: IpcListener,
  fault: () => TestFault | null = activeTestFault
): IpcListener {
  return (event, ...args) => {
    if (fault() === 'search-fail') throw new Error(SEARCH_FAULT_MESSAGE)
    return listener(event, ...args)
  }
}

export interface SearchFaultInjectionOptions {
  /** IPC 注册宿主；主进程传 electron 的 ipcMain，单测传假对象 */
  host?: IpcHandleHost
  /** 故障解析函数；默认每次请求重新解析，便于清除后立即重试成功 */
  fault?: () => TestFault | null
  isTestCopy?: boolean
}

export function installSearchFaultInjection(options: SearchFaultInjectionOptions = {}): void {
  const isTestCopy = options.isTestCopy ?? IS_TEST_COPY
  // 非测试副本直接不接管 ipcMain：生产代码路径上没有这个开关
  if (!isTestCopy) return
  const host: IpcHandleHost = options.host ?? (electronModule().ipcMain as unknown as IpcHandleHost)
  const fault = options.fault ?? activeTestFault
  const register = host.handle.bind(host)
  host.handle = (channel, listener) => {
    register(
      channel,
      channel === SEARCH_QUERY_CHANNEL ? guardSearchQueryListener(listener, fault) : listener
    )
  }
}

/* ------------------------------ 测试副本配置 ------------------------------ */

export function configureTestCopy(): void {
  if (!IS_TEST_COPY) return
  const { app } = electronModule()
  const explicit = app.commandLine.getSwitchValue('user-data-dir')
  const profile = explicit ? resolve(explicit) : join(root, '.testprofile')
  // `--user-data-dir` 会在脚本执行前改写 app.getPath('userData')，所以正式 profile 要从 appData 目录推导；
  // 否则显式一次性 profile（隔离 E2E / GUI 验收）会被误判成正式 profile 而拒绝启动。
  const formalProfile = resolve(app.getPath('appData'), app.getName())
  const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
  if (samePath(profile, formalProfile)) throw new Error('测试副本拒绝使用正式 profile')
  const data = join(profile, 'data')
  if (!explicit && !existsSync(join(data, 'library.sqlite'))) {
    throw new Error('测试副本数据快照缺失；拒绝回退到正式用户目录')
  }
  mkdirSync(join(profile, 'session'), { recursive: true })
  app.setName('paperdesk-test')
  app.setPath('userData', profile)
  app.setPath('sessionData', join(profile, 'session'))
  process.env.PAPERDESK_DATA = data
  process.env.PAPERDESK_CONNECTOR_ENABLED = '0'
  testProfileDir = profile
  // 必须在 registerAllModules() 之前接管：configureTestCopy 在 main/index.ts 顶层调用，
  // IPC 注册发生在 app.whenReady 之后，所以这里换掉的 handle 会作用到全部模块注册。
  installSearchFaultInjection()
  app.on('browser-window-created', (_event, window) => {
    // 测试副本要在标题上留标记，但不能把窗口自己的标题（例如「思维地图 · 论文名」）整个盖掉，
    // 否则按标题验收的新窗口就永远只能看到「[TEST] PaperDesk」。
    const setTitle = (): void => {
      const base = window.getTitle()
      if (base.startsWith('[TEST]')) return
      window.setTitle(`[TEST] ${base || 'PaperDesk'} — 独立测试副本`)
    }
    window.on('page-title-updated', (event) => { event.preventDefault() })
    window.webContents.on('did-finish-load', setTitle)
    setTitle()
  })
  const fault = activeTestFault()
  if (fault) console.log('[PAPERDESK_TEST_FAULT] active: ' + fault)
  console.log('[PAPERDESK_ISOLATED_TEST_COPY] enabled')
}
