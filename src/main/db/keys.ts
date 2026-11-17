import { randomBytes } from 'node:crypto'

const ALPHABET = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ' // 去混淆字符（去掉 0/1/O）

/** 生成本地稳定 key（8 位，仿 Zotero item key） */
export function generateKey(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}
