import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { getDataDir } from '../db'
import { ensureSidecar } from '../sidecar/manager'
import type { TranslateSkill } from '../../shared/types'

/** 翻译技能目录：data/skills/translate/<id>.json */
export function skillsDir(): string {
  return join(getDataDir(), 'skills', 'translate')
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const base = await ensureSidecar()
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!r.ok) throw new Error(`翻译技能服务失败: ${r.status}`)
  return (await r.json()) as T
}

export async function listSkills(): Promise<TranslateSkill[]> {
  const j = await post<{ skills: TranslateSkill[] }>('/skills/list', { dir: skillsDir() })
  return j.skills
}

export async function saveSkill(
  id: string,
  system: string,
  skip: boolean,
  scope: string
): Promise<TranslateSkill[]> {
  await post('/skills/save', { dir: skillsDir(), id, system, skip, scope })
  return listSkills()
}

export async function resetSkills(): Promise<TranslateSkill[]> {
  const j = await post<{ skills: TranslateSkill[] }>('/skills/reset', { dir: skillsDir() })
  return j.skills
}

/** 导出整套技能到一个 JSON 文件（便于分享/备份） */
export async function exportSkillsFile(): Promise<string | null> {
  const list = await listSkills()
  const { dialog } = await import('electron')
  const res = await dialog.showSaveDialog({
    title: '导出翻译技能',
    defaultPath: 'paperdesk-skills.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePath) return null
  const payload = list.map((s) => ({
    match: s.match,
    label: s.label,
    skip: s.skip,
    system: s.system,
    scope: s.scope,
    version: s.version ?? 1
  }))
  writeFileSync(res.filePath, JSON.stringify(payload, null, 2), 'utf8')
  return res.filePath
}

/** 最近一次导入的技能载荷（供冲突时「强制覆盖」复用） */
let lastImport: unknown[] | null = null

async function postImport(
  parsed: unknown[],
  force: boolean,
  only?: string[]
): Promise<{ skills: TranslateSkill[]; imported: number; conflicts: string[]; updates: string[] }> {
  const j = await post<{
    skills: TranslateSkill[]
    imported: number
    conflicts: string[]
    updates: string[]
  }>('/skills/import', { dir: skillsDir(), skills: parsed, force, only: only ?? [] })
  return {
    skills: j.skills,
    imported: j.imported ?? 0,
    conflicts: j.conflicts ?? [],
    updates: j.updates ?? []
  }
}

/** 从 JSON 文件导入技能（合并进当前技能目录） */
/** 选择技能 JSON 文件并解析（仅缓存，不写入）；取消返回 null */
export async function pickSkillsFile(): Promise<TranslateSkill[] | null> {
  const { dialog } = await import('electron')
  const res = await dialog.showOpenDialog({
    title: '导入翻译技能',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (res.canceled || res.filePaths.length === 0) return null
  const raw = readFileSync(res.filePaths[0], 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('文件不是合法 JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('技能文件应为 JSON 数组')
  lastImport = parsed as unknown[]
  return (parsed as Record<string, unknown>[]).map((p) => {
    const match = String(p.match ?? p.id ?? '')
    return {
      id: match,
      match,
      label: String(p.label ?? match),
      skip: !!p.skip,
      system: String(p.system ?? ''),
      scope: String(p.scope ?? 'all'),
      version: Number(p.version ?? 0),
      updated_at: String(p.updated_at ?? ''),
      path: ''
    }
  })
}

/** 用最近一次导入的载荷重试（force=true 覆盖版本冲突项；only 指定仅这些 match） */
export async function applyLastSkillsImport(
  force: boolean,
  only?: string[]
): Promise<{ skills: TranslateSkill[]; imported: number; conflicts: string[]; updates: string[] }> {
  if (!lastImport) throw new Error('没有可重试的导入记录')
  return postImport(lastImport, force, only)
}
