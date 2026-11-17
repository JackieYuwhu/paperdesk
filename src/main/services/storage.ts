import { join } from 'node:path'
import { copyFileSync, mkdirSync } from 'node:fs'
import { getDataDir } from '../db'

/** data/storage/<itemKey>/<filename> */
export function storageDirForItem(itemKey: string): string {
  const dir = join(getDataDir(), 'storage', itemKey)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 把源 PDF 复制进库，返回相对 data/ 的路径 */
export function storePdf(itemKey: string, srcPath: string): { relPath: string; filename: string } {
  const filename = srcPath.split(/[\\/]/).pop() || 'document.pdf'
  const dir = storageDirForItem(itemKey)
  copyFileSync(srcPath, join(dir, filename))
  const relPath = ['storage', itemKey, filename].join('/')
  return { relPath, filename }
}

/** 相对路径 -> 绝对路径 */
export function resolveStoragePath(relPath: string): string {
  return join(getDataDir(), ...relPath.split('/'))
}
