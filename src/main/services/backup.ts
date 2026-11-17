import { basename, dirname, join, resolve } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import type { TestFault } from '../test-profile'

/**
 * 与 test-profile.ts 的 TEST_FAULT_READER 是同一个 Symbol（单测断言两者一致）。
 * 这里用登记表而不是静态 import，原因见 test-profile.ts 中的说明：
 * Node 原生 TS 直跑要求相对导入带扩展名，而 tsconfig.node.json 不允许 .ts 扩展名。
 */
const TEST_FAULT_READER = Symbol.for('paperdesk.testFaultReader')

/** 测试副本登记的故障读取器；未登记（正式构建 / 普通单测）时视为没有故障 */
function activeTestFault(): TestFault | null {
  const reader = (globalThis as unknown as Record<symbol, unknown>)[TEST_FAULT_READER]
  return typeof reader === 'function' ? (reader as () => TestFault | null)() : null
}

/**
 * 只读 SQLite 探针：生产用 better-sqlite3（db/index.ts 提供），单测用 node:sqlite。
 * 只依赖 `prepare(sql).all()`，避免把原生模块/electron 泄漏进纯逻辑。
 */
export interface SqliteProbe {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
  close(): void
}

/**
 * 备份/恢复依赖的数据库后端。由 db/index.ts 在启动时注册；
 * 单测可以直接传入基于 node:sqlite 的实现，不需要 import electron。
 */
export interface BackupBackend {
  /** 用户数据根目录（`<userData>/data` 或 PAPERDESK_DATA） */
  dataDir(): string
  /** 生成当前库的一致性快照（VACUUM INTO） */
  snapshotLive(dest: string): void
  /** 在线备份（better-sqlite3 的 backup，正确处理 WAL；返回实现自定义的元信息） */
  backupLive(dest: string): Promise<unknown>
  /** 只读打开一个 SQLite 文件，用于恢复前校验 */
  openProbe(file: string): SqliteProbe
  /** 关闭当前连接 */
  close(): void
  /** 重新打开连接并跑迁移 */
  init(): void
}

let backend: BackupBackend | null = null

/** 由 db/index.ts 在模块加载时调用，注入真实数据库实现 */
export function configureBackupBackend(next: BackupBackend): void {
  backend = next
}

function requireBackend(): BackupBackend {
  if (!backend) throw new Error('备份服务未初始化（DB 后端未注册）')
  return backend
}

/** 备份目录（自动安全备份放这里）：<data>/backups */
export function backupsDir(): string {
  const dir = join(requireBackend().dataDir(), 'backups')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 当前数据库文件路径 */
export function dbPath(): string {
  return join(requireBackend().dataDir(), 'library.sqlite')
}

/**
 * 备份当前数据库到目标文件。
 * 用 SQLite 在线备份（正确处理 WAL），而不是直接拷贝文件。
 */
export async function backupTo(dest: string): Promise<string> {
  mkdirSync(dirname(dest), { recursive: true })
  await requireBackend().backupLive(dest)
  return dest
}

/* --------------------------- 恢复前的完整性校验 --------------------------- */

/** 一份可用备份至少要有这些表（条目 / 附件 / 批注 / 笔记 / 设置） */
export const REQUIRED_BACKUP_TABLES = [
  'items',
  'attachments',
  'annotations',
  'notes',
  'settings'
] as const

/** 必要列：缺列时恢复后会读不出条目、批注或笔记 */
export const REQUIRED_BACKUP_COLUMNS: Record<string, readonly string[]> = {
  items: ['id', 'key', 'title', 'date_added', 'date_modified'],
  attachments: ['id', 'key', 'item_id', 'path', 'date_added'],
  annotations: ['id', 'key', 'attachment_id', 'page_index', 'position', 'date_added'],
  notes: ['id', 'key', 'item_id', 'title', 'date_added', 'date_modified'],
  settings: ['key', 'value']
}

export interface BackupInspection {
  ok: boolean
  reason: string
  tables: string[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function firstValue(row: unknown): unknown {
  return row && typeof row === 'object' ? Object.values(row as Record<string, unknown>)[0] : undefined
}

function columnValue(row: unknown, column: string): unknown {
  if (!row || typeof row !== 'object') return undefined
  const record = row as Record<string, unknown>
  return column in record ? record[column] : firstValue(row)
}

/**
 * 检查一个文件是否是可恢复的 SQLite 备份：
 * 1. 文件存在且非空；2. `PRAGMA integrity_check` 全部为 ok；
 * 3. 必要表齐全；4. 必要列齐全。任何一步失败都返回 ok=false，绝不抛给调用方。
 */
export function inspectBackupDatabase(
  file: string,
  openProbe: (file: string) => SqliteProbe
): BackupInspection {
  if (!existsSync(file)) return { ok: false, reason: '备份文件不存在: ' + file, tables: [] }
  let probe: SqliteProbe | null = null
  try {
    if (statSync(file).size === 0) return { ok: false, reason: '备份文件为空', tables: [] }
    probe = openProbe(file)
    const integrityRows = probe.prepare('PRAGMA integrity_check').all()
    const integrity = integrityRows.map((row) => String(firstValue(row) ?? ''))
    if (integrity.length === 0 || integrity.some((value) => value.toLowerCase() !== 'ok')) {
      const detail = integrity.slice(0, 3).join('; ') || '无结果'
      return { ok: false, reason: 'SQLite 完整性检查未通过: ' + detail, tables: [] }
    }
    const tableRows = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    const tables = tableRows.map((row) => String(columnValue(row, 'name') ?? ''))
    const missingTables = REQUIRED_BACKUP_TABLES.filter((table) => !tables.includes(table))
    if (missingTables.length > 0) {
      return {
        ok: false,
        reason: '备份缺少必要数据表: ' + missingTables.join(', '),
        tables
      }
    }
    for (const [table, columns] of Object.entries(REQUIRED_BACKUP_COLUMNS)) {
      const infoRows = probe.prepare('PRAGMA table_info(' + table + ')').all()
      const present = infoRows.map((row) => String(columnValue(row, 'name') ?? ''))
      const missing = columns.filter((column) => !present.includes(column))
      if (missing.length > 0) {
        return {
          ok: false,
          reason: '备份数据表 ' + table + ' 缺少必要列: ' + missing.join(', '),
          tables
        }
      }
    }
    return { ok: true, reason: '', tables }
  } catch (error) {
    return { ok: false, reason: '不是有效的 SQLite 备份: ' + errorMessage(error), tables: [] }
  } finally {
    try {
      probe?.close()
    } catch {
      /* 探针关闭失败不影响判定 */
    }
  }
}

/* ------------------------------- 恢复流程 ------------------------------- */

export interface RestoreResult {
  restored: string
  safety: string | null
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function sidecarFiles(file: string): string[] {
  return [file + '-wal', file + '-shm']
}

/** 只读探针打开 WAL 库会留下 -wal/-shm，校验完必须清掉，避免临时文件残留在数据目录 */
function removeSidecars(file: string): void {
  for (const sidecar of sidecarFiles(file)) removeFile(sidecar)
}

function removeFile(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    /* 删除临时文件失败不阻断后续步骤 */
  }
}

function uniquePath(dir: string, base: string): string {
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  let candidate = join(dir, base)
  let suffix = 1
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${suffix}${ext}`)
    suffix += 1
  }
  return candidate
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 从备份恢复数据库（失败时保证现有库可用）。
 *
 * 顺序经过刻意安排，任何一步失败都不会丢现有数据：
 * 1. 先校验备份（完整性 + 必要 schema），不通过直接拒绝；
 * 2. 对当前库做 VACUUM INTO 安全备份并校验，失败则拒绝恢复；
 * 3. 把备份复制到数据目录内的临时文件并再次校验；
 * 4. 关闭连接 → 原子改名保留原库 → 安装临时文件 → 重新打开（跑迁移）；
 * 5. 以上任一步失败都回滚到原库并重新打开。
 */
export interface RestoreOptions {
  /**
   * 测试故障注入：显式指定本次恢复要模拟的故障，不读环境变量。
   * 生产调用方不传，走 `activeTestFault()`（非测试副本恒为 null）。
   */
  testFault?: TestFault | null
}

export function restoreDatabase(
  src: string,
  hooks: BackupBackend,
  options: RestoreOptions = {}
): RestoreResult {
  const source = resolve(src)
  if (!existsSync(source)) throw new Error('备份文件不存在: ' + src)
  const testFault = options.testFault === undefined ? activeTestFault() : options.testFault

  const dataDir = hooks.dataDir()
  const live = resolve(join(dataDir, 'library.sqlite'))
  if (samePath(source, live)) {
    throw new Error('备份文件与当前数据库是同一个文件，已取消恢复')
  }

  // 1) 恢复前校验：不通过即拒绝，当前库完全不动
  const inspection = inspectBackupDatabase(source, hooks.openProbe)
  if (!inspection.ok) {
    throw new Error('恢复被拒绝（备份不可用）: ' + inspection.reason)
  }

  // 2) 安全备份失败时必须放弃恢复（fail closed）
  const backupDir = join(dataDir, 'backups')
  mkdirSync(backupDir, { recursive: true })
  const stamp = timestamp()
  const safetyAbs = uniquePath(backupDir, 'pre-restore-' + stamp + '.sqlite')
  let safety: string | null = null
  try {
    hooks.snapshotLive(safetyAbs)
  } catch (error) {
    removeFile(safetyAbs)
    throw new Error('安全备份失败，已取消恢复（现有数据库保持不变）: ' + errorMessage(error))
  }
  const safetyCheck = inspectBackupDatabase(safetyAbs, hooks.openProbe)
  if (!safetyCheck.ok) {
    removeFile(safetyAbs)
    removeSidecars(safetyAbs)
    throw new Error(
      '安全备份校验失败，已取消恢复（现有数据库保持不变）: ' + safetyCheck.reason
    )
  }
  removeSidecars(safetyAbs)
  safety = safetyAbs

  // 3) 先复制到数据目录内的临时文件并校验，避免直接覆盖 live
  const staged = join(dataDir, 'library.restore-' + stamp + '.tmp')
  try {
    // 测试故障注入（copy-fail）：位置刻意选在这里——live 还没 close、也还没 rename，
    // 所以失败后现存 library.sqlite 必然一个字节都没动，正好用来验收「恢复失败不毁库」。
    if (testFault === 'copy-fail') throw new Error('测试故障注入 copy-fail：备份副本复制失败')
    copyFileSync(source, staged)
    const stagedCheck = inspectBackupDatabase(staged, hooks.openProbe)
    if (!stagedCheck.ok) throw new Error('备份副本校验失败: ' + stagedCheck.reason)
    removeSidecars(staged)
  } catch (error) {
    removeFile(staged)
    removeSidecars(staged)
    throw new Error('恢复失败（现有数据库保持不变）: ' + errorMessage(error))
  }

  // 4) 关闭连接后原子替换；失败则回滚
  const rollback = join(dataDir, 'library.pre-restore-' + stamp + '.bak')
  let closed = false
  let movedAway = false
  let installed = false
  try {
    hooks.close()
    closed = true
    for (const file of sidecarFiles(live)) removeFile(file)
    removeFile(rollback)
    for (const file of sidecarFiles(rollback)) removeFile(file)
    renameSync(live, rollback)
    movedAway = true
    renameSync(staged, live)
    installed = true
    for (const file of sidecarFiles(live)) removeFile(file)
    hooks.init()
  } catch (error) {
    const primary = errorMessage(error)
    try {
      if (installed) {
        removeFile(live)
        for (const file of sidecarFiles(live)) removeFile(file)
      }
      if (movedAway && existsSync(rollback)) renameSync(rollback, live)
      removeFile(staged)
      removeSidecars(staged)
      if (closed) hooks.init()
    } catch (rollbackError) {
      throw new Error(
        '恢复失败且回滚原数据库失败: ' +
          primary +
          ' / ' +
          errorMessage(rollbackError) +
          '（原库文件保留在 ' +
          rollback +
          '）'
      )
    }
    throw new Error('恢复失败，已回滚到原数据库: ' + primary)
  }

  // 成功后才清理回滚副本；清理失败只保留副本，不影响恢复结果
  removeFile(rollback)
  for (const file of sidecarFiles(rollback)) removeFile(file)
  return { restored: basename(live), safety }
}

/** 从备份恢复（使用已注册的真实数据库后端） */
export function restoreFrom(src: string): RestoreResult {
  return restoreDatabase(src, requireBackend())
}

/* ------------------------------ 带对话框的封装 ------------------------------ */

export async function backupDialog(): Promise<string | null> {
  const { dialog } = await import('electron')
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const res = await dialog.showSaveDialog({
    title: '备份数据库',
    defaultPath: `paperdesk-backup-${ts}.sqlite`,
    filters: [{ name: 'SQLite', extensions: ['sqlite', 'db'] }]
  })
  if (res.canceled || !res.filePath) return null
  return backupTo(res.filePath)
}

export async function restoreDialog(): Promise<RestoreResult | null> {
  const { dialog } = await import('electron')
  const res = await dialog.showOpenDialog({
    title: '从备份恢复',
    properties: ['openFile'],
    filters: [{ name: 'SQLite', extensions: ['sqlite', 'db'] }]
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return restoreFrom(res.filePaths[0])
}
