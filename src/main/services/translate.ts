import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { getDataDir, getDb } from '../db'
import { generateKey } from '../db/keys'
import { resolveStoragePath } from './storage'
import { ensureSidecar, isSidecarRunning, sidecarLogTail } from '../sidecar/manager'
import {
  canReuseTranslation,
  type ReusableTranslationRow,
  type ReuseSignature
} from '../../shared/translation-reuse'
import { mergeTranslatedBlocks, splitTranslatableBlocks } from '../../shared/md-table'
import {
  TranslationJobs,
  TranslationServiceExited,
  TranslationTerminationUnconfirmed,
  pollTranslationStatus
} from './translation-jobs'
import { getModules } from './modules'
import { listArticleTerms, prepareArticleTerms } from './article-glossary'
import { glossaryInstructions } from '../../shared/glossary'
import { exportDocument } from './export'
import { skillsDir } from './skills'
import { upsertSectionInItemNote } from './notes'
import {
  effective,
  isOpenCode,
  modelHeaders,
  mtConfig,
  openCodeEndpointHint,
  sessionFor
} from './settings'
import type {
  Attachment,
  TranslateDiagnosis,
  TranslateOptions,
  TranslateProgress,
  Translation,
  TranslationMap,
  TranslationTarget
} from '../../shared/types'

export function translatedDir(): string {
  const dir = join(getDataDir(), 'translated')
  mkdirSync(dir, { recursive: true })
  return dir
}

const DEFAULT_LANG = 'zh'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 按调用隔离后台任务；批处理和前台翻译互不覆盖。 */
const translationJobs = new TranslationJobs()

const KIND_LABEL: Record<string, string> = {
  body: '正文',
  heading: '标题',
  abstract: '摘要',
  caption: '题注',
  formula: '公式',
  reference: '文献',
  margin: '页眉页脚'
}

function stageMessage(st: { stage?: string; done: number; total: number }): string {
  const stage = st.stage ?? ''
  if (stage.startsWith('translating:')) {
    const label = KIND_LABEL[stage.slice('translating:'.length)] ?? stage.slice('translating:'.length)
    return st.total > 0 ? `翻译中·${label} ${st.done}/${st.total} 段` : `翻译中·${label}…`
  }
  switch (stage) {
    case 'analyzing':
      return st.total > 0
        ? `分析版面 ${Math.min(st.done, st.total)}/${st.total} 页…`
        : '分析版面…'
    case 'translating':
      return st.total > 0 ? `翻译中 ${st.done}/${st.total} 段` : '翻译中…'
    case 'writing':
      return '重排版面…'
    default:
      return '翻译中…'
  }
}

/** 取消指定翻译请求（包含尚未取得侧车 jobId 的请求）。 */
export async function cancelTranslation(requestId: string): Promise<void> {
  await translationJobs.cancel(requestId)
}

export function getTranslation(attachmentId: number, lang: string): Translation | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM translations WHERE attachment_id = ? AND lang = ?
         ORDER BY (status = 'done') DESC, id DESC LIMIT 1`
      )
      .get(attachmentId, lang) as Translation) ?? null
  )
}

/** 某附件 + 语言的译文历史（最新在前，含已被取代的版本） */
export function listTranslations(attachmentId: number, lang: string): Translation[] {
  return getDb()
    .prepare('SELECT * FROM translations WHERE attachment_id = ? AND lang = ? ORDER BY id DESC')
    .all(attachmentId, lang) as Translation[]
}

/** 按 id 取某份译文 */
export function getTranslationById(id: number): Translation | null {
  return (
    (getDb().prepare('SELECT * FROM translations WHERE id = ?').get(id) as Translation) ?? null
  )
}

/** 删除某份译文（默认连同磁盘产物），并清理其 FTS 索引 */
export function deleteTranslation(id: number, removeFiles = true): void {
  const db = getDb()
  const row = db.prepare('SELECT * FROM translations WHERE id = ?').get(id) as
    | Translation
    | undefined
  if (!row) return
  if (removeFiles) {
    const dir = translatedDir()
    const rels = [
      row.path,
      row.html_path,
      row.bilingual_path,
      row.md_path,
      row.bilingual_md_path
    ]
    for (const rel of rels) {
      if (!rel) continue
      try {
        rmSync(join(dir, rel), { force: true })
      } catch {
        /* 忽略 */
      }
    }
  }
  db.prepare('DELETE FROM translations_fts WHERE rowid = ?').run(id)
  db.prepare('DELETE FROM translations WHERE id = ?').run(id)
}

/** 标记/取消「基线」（收藏）：清理时永不删除 */
export function setPinned(id: number, pinned: boolean): void {
  getDb().prepare('UPDATE translations SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
}

/** 预览「只保留最近 keep 份」将删除哪些版本（不实际删除） */
export interface PruneItem {
  id: number
  engine: string
  date_added: string
  pinned: number
  bytes: number
}

export function previewPrune(attachmentId: number, lang: string, keep: number): PruneItem[] {
  if (!keep || keep <= 0) return []
  const rows = listTranslations(attachmentId, lang)
  const groups = new Map<string, Translation[]>()
  for (const r of rows) {
    if (r.pinned) continue
    const g = r.engine ?? 'simple'
    const arr = groups.get(g)
    if (arr) arr.push(r)
    else groups.set(g, [r])
  }
  const out: PruneItem[] = []
  for (const list of groups.values()) {
    for (const r of list.slice(keep)) {
      let bytes = 0
      for (const rel of [r.path, r.html_path, r.bilingual_path, r.md_path, r.bilingual_md_path]) {
        if (!rel) continue
        try {
          bytes += statSync(join(translatedDir(), rel)).size
        } catch {
          /* 忽略 */
        }
      }
      out.push({
        id: r.id,
        engine: r.engine ?? 'simple',
        date_added: r.date_added,
        pinned: r.pinned ?? 0,
        bytes
      })
    }
  }
  return out
}

/** 回滚：把某个历史版本设为「最新」（其余同语言版本标记为已取代） */
export function rollbackTranslation(id: number): void {
  const db = getDb()
  const row = db.prepare('SELECT * FROM translations WHERE id = ?').get(id) as
    | Translation
    | undefined
  if (!row) throw new Error('译文不存在')
  db.transaction(() => {
    db.prepare(
      "UPDATE translations SET status = 'superseded' WHERE attachment_id = ? AND lang = ? AND id != ?"
    ).run(row.attachment_id, row.lang, id)
    db.prepare("UPDATE translations SET status = 'done' WHERE id = ?").run(id)
  })()
}

/**
 * 只保留最近 keep 份（**按引擎各自计数**；标记为基线的永不被删，连文件一起删）。
 * keep <= 0 表示保留全部。返回删除数量。
 */
export function pruneTranslations(attachmentId: number, lang: string, keep: number): number {
  if (!keep || keep <= 0) return 0
  const rows = listTranslations(attachmentId, lang)
  const groups = new Map<string, Translation[]>()
  for (const r of rows) {
    if (r.pinned) continue
    const g = r.engine ?? 'simple'
    const arr = groups.get(g)
    if (arr) arr.push(r)
    else groups.set(g, [r])
  }
  let deleted = 0
  for (const list of groups.values()) {
    for (const r of list.slice(keep)) {
      deleteTranslation(r.id, true)
      deleted++
    }
  }
  return deleted
}

/** 读取译文的 Markdown（translation=译文；bilingual=中英对照） */
export function readTranslationMarkdown(id: number, which: 'translation' | 'bilingual'): string {
  const p = markdownAbsPath(id, which)
  if (!p) throw new Error('该译文还没有 Markdown 版本')
  return readFileSync(p, 'utf8')
}

export interface OrphanFile {
  name: string
  bytes: number
}

export interface OrphanReport {
  /** translated/ 目录绝对路径（便于「打开所在目录」） */
  dir: string
  /** 未被任何译文引用的产物（按体积从大到小） */
  orphans: OrphanFile[]
  /** 占用字节数合计 */
  bytes: number
}

/** 派生产物（ZIP / README / 自检 / manifest / 快照）不属于「译文产物」，不参与孤儿判定 */
function isDerivedExport(name: string): boolean {
  return (
    /\.zip$/i.test(name) ||
    /\.snapshot\.html$/i.test(name) ||
    /(?:README|qa|manifest)\.md$/i.test(name)
  )
}

/** 扫描 translated/ 下未被任何译文引用、也不是派生产物的文件（按体积排序） */
export function scanOrphanFiles(): OrphanReport {
  const dir = translatedDir()
  if (!existsSync(dir)) return { dir, orphans: [], bytes: 0 }
  const referenced = new Set<string>()
  const rows = getDb()
    .prepare(
      'SELECT path, html_path, bilingual_path, md_path, bilingual_md_path FROM translations'
    )
    .all() as Array<{
    path: string | null
    html_path: string | null
    bilingual_path: string | null
    md_path: string | null
    bilingual_md_path: string | null
  }>
  for (const r of rows) {
    for (const v of [r.path, r.html_path, r.bilingual_path, r.md_path, r.bilingual_md_path]) {
      if (v) referenced.add(v)
    }
  }
  const orphans: OrphanFile[] = []
  let bytes = 0
  for (const f of readdirSync(dir)) {
    if (referenced.has(f) || isDerivedExport(f)) continue
    if (!/\.(pdf|html|md)$/i.test(f)) continue
    let size = 0
    try {
      size = statSync(join(dir, f)).size
    } catch {
      /* 忽略 */
    }
    orphans.push({ name: f, bytes: size })
    bytes += size
  }
  orphans.sort((a, b) => b.bytes - a.bytes)
  return { dir, orphans, bytes }
}

/** 删除孤儿文件（names 为空则先扫描）。返回删除数量 */
export function cleanOrphanFiles(names?: string[]): number {
  const dir = translatedDir()
  const list = names && names.length > 0 ? names : scanOrphanFiles().orphans.map((o) => o.name)
  let n = 0
  for (const f of list) {
    try {
      rmSync(join(dir, f), { force: true })
      n++
    } catch {
      /* 忽略 */
    }
  }
  return n
}

interface SidecarTranslateResult {
  engine?: string
  backend?: string
  pages?: number
  blocks?: number
  htmlPath?: string | null
  bilingualPath?: string | null
  mdPath?: string | null
  bilingualMdPath?: string | null
  /** 放不下的译文按源页归档的 sidecar（与 PDF 同目录） */
  overflowPath?: string | null
  /** 块级映射 sidecar（源矩形 → 译文落版矩形） */
  mapPath?: string | null
  counts?: Record<string, number>
  qa?: Record<string, number | string>
  mode?: string
  timing?: {
    mode?: string
    totalSeconds?: number
    stages?: Record<string, number>
    requests?: number
    requestSeconds?: number
    failedBatches?: number
    batchSize?: number
    workers?: number
  }
  coverage?: {
    expected?: number
    written?: number
    failedBlocks?: number
    formulaPreserved?: number
    formulaApproximated?: number
    formulaDropped?: number
    formulaMissing?: number
    /** 译文放不下、已回填原文的块数 */
    fellBackToOriginal?: number
  }
  warnings?: string[]
}

/** 调用 sidecar 做保版式翻译，产物登记到 translations 表 */
export async function runTranslation(
  attachmentId: number,
  opts: TranslateOptions = {},
  onProgress?: (p: TranslateProgress) => void,
  /** 批处理等调用方的取消信号：轮询期间检查，确认后向侧车发取消 */
  isCancelled?: () => boolean
): Promise<Translation> {
  const requestId = opts.requestId ?? generateKey()
  translationJobs.begin(requestId)
  try {
    return await runTranslationJob(attachmentId, { ...opts, requestId }, onProgress, isCancelled)
  } finally {
    translationJobs.finish(requestId)
  }
}

/** 正在单页重译的译文 id，防止同一份译文并发改写同一 PDF。 */
const pageRetranslating = new Set<number>()
const pageAttachments = new Set<number>()

/** Stage a new version; an unsuccessful retranslation never replaces the current version. */
export async function retranslatePage(id: number, page: number): Promise<Translation> {
  const old = getTranslationById(id)
  if (!old || old.status !== 'done') throw new Error('只能重译已完成的译文')
  if (pageAttachments.has(old.attachment_id)) throw new Error('本文已有页面正在重译')
  pageAttachments.add(old.attachment_id)
  const db = getDb(), dir = translatedDir(), key = generateKey()
  const created: string[] = []
  let stagedId: number | null = null
  const copy = (rel: string | null, suffix: string): string | null => {
    if (!rel || !existsSync(join(dir, rel))) return null
    const next = `${key}${suffix}`
    copyFileSync(join(dir, rel), join(dir, next)); created.push(next); return next
  }
  try {
    const pdf = copy(old.path, '.pdf')
    if (!pdf) throw new Error('译文 PDF 不存在')
    copy(old.path.replace(/\.pdf$/i, '.map.json'), '.map.json')
    const md = copy(old.md_path, '.md'), bi = copy(old.bilingual_md_path, '.bilingual.md')
    const result = db.prepare(`INSERT INTO translations(key,attachment_id,lang,path,engine,backend,status,date_added,md_path,bilingual_md_path,qa)
      VALUES(?,?,?,?,?,?,'retranslating',?,?,?,?)`).run(key, old.attachment_id, old.lang, pdf, old.engine, old.backend, new Date().toISOString(), md, bi, old.qa)
    stagedId = Number(result.lastInsertRowid)
    const next = await retranslateWorkingPage(stagedId, page)
    db.transaction(() => {
      db.prepare("UPDATE translations SET status='superseded' WHERE id=?").run(id)
      db.prepare("UPDATE translations SET status='done' WHERE id=?").run(stagedId)
      // Unchanged pages retain their annotations in both versions. The old page's annotations
      // remain attached to its historical version, never guessed onto newly laid out text.
      const anns = db.prepare("SELECT * FROM annotations WHERE attachment_id=? AND json_extract(position,'$.translationId')=? AND page_index<>?").all(old.attachment_id, id, Math.floor(page) - 1) as Array<Record<string, unknown>>
      for (const a of anns) db.prepare(`INSERT INTO annotations(key,attachment_id,type,text,prefix,suffix,comment,color,page_index,position,sort_index,date_added,date_modified)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(generateKey(), old.attachment_id, a.type, a.text, a.prefix, a.suffix, a.comment, a.color, a.page_index,
          JSON.stringify({ ...JSON.parse(String(a.position)), translationId: stagedId }), a.sort_index, a.date_added, a.date_modified)
      if (next.md_path) db.prepare('INSERT INTO translations_fts(rowid,title,body) VALUES(?,?,?)').run(stagedId, `译文(${old.lang})`, readFileSync(join(dir, next.md_path), 'utf8'))
    })()
    return getTranslationById(stagedId) as Translation
  } catch (e) {
    if (stagedId != null) db.prepare('DELETE FROM translations WHERE id=?').run(stagedId)
    for (const rel of created) rmSync(join(dir, rel), { force: true })
    throw e
  } finally { pageAttachments.delete(old.attachment_id) }
}

/**
 * 只重译某一页：侧车把该页单独翻译后替换回原译文 PDF，其余页保持不动。
 * 用于「整篇已翻译，但某页漏译/内容缺失」的定点修复。
 */
async function retranslateWorkingPage(id: number, page: number): Promise<Translation> {
  const row = getTranslationById(id)
  if (!row) throw new Error(`译文不存在: ${id}`)
  const pageNo = Math.floor(page)
  if (!Number.isFinite(pageNo) || pageNo < 1) throw new Error(`页码无效: ${page}`)
  if (row.status !== 'retranslating') throw new Error('缺少重译暂存版本')
  if (pageRetranslating.has(id)) throw new Error('这一页正在重译，请稍候')
  pageRetranslating.add(id)
  try {
    const db = getDb()
    const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(row.attachment_id) as
      | Attachment
      | undefined
    if (!att) throw new Error(`附件不存在: ${row.attachment_id}`)
    const srcAbs = resolveStoragePath(att.path)
    const outAbs = join(translatedDir(), row.path)
    if (!existsSync(outAbs)) throw new Error('译文 PDF 不存在，请重新翻译整篇')

    const cfg = mtConfig()
    const base = await ensureSidecar()
    const engine = (row.engine ?? 'simple').split(':')[0]
    if (engine !== 'simple') {
      throw new Error('单页重译只支持内置精译引擎；请用同一引擎重新翻译整篇')
    }
    const isCoarse = (row.engine ?? '').includes(':coarse')
    const isStrict = (row.engine ?? '').includes(':strict')
    const res = await fetch(`${base}/translate/page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: srcAbs,
        outPath: outAbs,
        page: pageNo,
        targetLang: row.lang,
        engine: 'simple',
        backend: cfg.backend,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        headers: modelHeaders(cfg.baseUrl, sessionFor.translate(att.key)),
        mode: isCoarse ? 'coarse' : 'fine',
        layout: isStrict ? 'strict' : 'reflow',
        maxWorkers: 2,
        glossary: effective('mt.glossary', 'PAPERDESK_MT_GLOSSARY', '') || undefined,
        terminology: /^zh/i.test(row.lang) ? glossaryInstructions(listArticleTerms(att.id)) : '',
        autoGlossary: false,
        fontDelta: Math.max(
          0,
          Math.min(4, Number(effective('mt.fontDelta', 'PAPERDESK_MT_FONT_DELTA', '1.5')) || 1.5)
        ),
        noThink: effective('mt.thinking', 'PAPERDESK_MT_THINKING', '0') === '0'
      })
    })
    if (!res.ok) {
      const raw = await res.text()
      let detail = raw
      try {
        const parsed = JSON.parse(raw) as { detail?: string; error?: string }
        detail = parsed.detail ?? parsed.error ?? raw
      } catch {
        /* 非 JSON 错误体 */
      }
      throw new Error(`单页重译失败: ${detail.slice(0, 300)}`)
    }
    const result = (await res.json()) as { page?: number; warnings?: string[]; pageMarkdown?: string; pageBilingualMarkdown?: string; qa?: { verification?: { pages?: Array<Record<string, unknown>> } } }
    for (const [rel, content] of [[row.md_path, result.pageMarkdown], [row.bilingual_md_path, result.pageBilingualMarkdown]] as const) {
      if (!rel || content == null) continue
      const file = join(translatedDir(), rel), text = readFileSync(file, 'utf8')
      const marker = `<!-- 第 ${pageNo} 页 -->`
      const start = text.indexOf(marker)
      const next = start < 0 ? -1 : text.indexOf('<!-- 第 ', start + marker.length)
      const pageText = content.replace(/<!-- 第 1 页 -->/g, marker).trim() + '\n\n'
      writeFileSync(file, start < 0 ? text + '\n\n' + pageText : text.slice(0, start) + pageText + (next < 0 ? '' : text.slice(next)), 'utf8')
    }

    // Use the new page's actual layout verdict; completing a request alone is not a pass.
    try {
      if (row.qa) {
        const qa = JSON.parse(row.qa) as {
          verification?: {
            pages?: Array<Record<string, unknown>>
            failedPages?: number[]
            passed?: boolean
          }
          retranslatedPages?: number[]
        }
        const v = qa.verification
        if (v) {
          const pages = Array.isArray(v.pages) ? v.pages : []
          const hit = pages.find((p) => Number(p.page) === pageNo)
          const verdict = result.qa?.verification?.pages?.[0] ?? { ok: false, status: 'needs_review', reason: '手动重译，待核对' }
          if (hit) {
            Object.assign(hit, verdict, { page: pageNo })
          } else {
            pages.push({ ...verdict, page: pageNo })
          }
          v.pages = pages
          v.failedPages = pages
            .filter((p) => !p.ok && p.status !== 'skipped')
            .map((p) => Number(p.page))
            .filter((n) => Number.isFinite(n))
          v.passed = v.failedPages.length === 0
        }
        qa.retranslatedPages = Array.from(new Set([...(qa.retranslatedPages ?? []), pageNo]))
        db.prepare('UPDATE translations SET qa = ? WHERE id = ?').run(JSON.stringify(qa), id)
      }
    } catch {
      /* 验收记录更新失败不影响 PDF 已替换 */
    }
    if (result.warnings?.length) {
      console.warn('[paperdesk] 单页重译警告:', result.warnings.join('; '))
    }
    return getTranslationById(id) as Translation
  } finally {
    pageRetranslating.delete(id)
  }
}

/** 复用决策结果：reuse=true 时 message 说明复用的是哪次产物以及如何强制重译。 */
export interface TranslationReuseDecision {
  reuse: boolean
  message: string
}

export interface TranslationReuseInput {
  /** 强制重译：始终跳过复用 */
  force?: boolean
  /** 源文件指纹（为空表示无法判断，保守地不复用） */
  fingerprint: string
  existing: ReusableTranslationRow | null
  /** 复用签名：backend/model/源文件指纹/引擎模式/版式 */
  sig: ReuseSignature
  /** 本次请求实际使用的后端（显式 backend 已由调用方解析进 sig.backend） */
  backend: string
}

/**
 * 纯函数复用决策（便于单测，不读数据库/配置）：
 * - force 始终跳过复用，并给出明确提示；
 * - 源文件指纹不可用时不复用；
 * - 其余交给 canReuseTranslation 核对 backend/model/指纹/引擎/版式。
 */
export function decideTranslationReuse(input: TranslationReuseInput): TranslationReuseDecision {
  if (input.force) {
    return { reuse: false, message: '已按「重新翻译」强制重译，不复用已有译文。' }
  }
  if (!input.fingerprint) {
    return { reuse: false, message: '源文件指纹不可用，本次不复用已有译文。' }
  }
  if (!canReuseTranslation(input.existing, input.sig, input.backend)) {
    return { reuse: false, message: '' }
  }
  const backend = input.existing?.backend ?? input.backend
  const model = input.sig.model ? ` · ${input.sig.model}` : ''
  return {
    reuse: true,
    message: `复用已有译文（${backend}${model}，如需更新请点「重新翻译」）`
  }
}

async function runTranslationJob(
  attachmentId: number,
  opts: TranslateOptions & { requestId: string },
  onProgress?: (p: TranslateProgress) => void,
  isCancelled?: () => boolean
): Promise<Translation> {
  const db = getDb()
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId) as
    | Attachment
    | undefined
  if (!att) throw new Error(`附件不存在: ${attachmentId}`)

  const lang = opts.lang ?? DEFAULT_LANG
  const engine = opts.engine ?? effective('mt.engine', 'PAPERDESK_MT_ENGINE', 'simple')
  // 精译/粗译分开记账：粗译结果不能冒充精译（复用判断按 engineKey）
  const mode: 'fine' | 'coarse' = opts.mode === 'coarse' ? 'coarse' : 'fine'
  const layout: 'reflow' | 'strict' = opts.layout === 'strict' ? 'strict' : 'reflow'
  // 译文正文字号增量：整篇/单页/批处理共用同一设置（mt.fontDelta），改动即视为新产物
  const fontDelta = Number(opts.fontDelta ?? effective('mt.fontDelta', 'PAPERDESK_MT_FONT_DELTA', '1.5'))
  const effFontDelta = Number.isFinite(fontDelta) ? Math.max(0, Math.min(4, fontDelta)) : 1.5
  // 严格版式与可读重排是不同产物，不能互相复用
  const baseEngine = layout === 'strict' ? `${engine}:strict` : engine
  const engineKey =
    (mode === 'coarse' ? `${baseEngine}:coarse` : baseEngine) + (effFontDelta > 0 ? `:f${effFontDelta}` : '')
  const docTitle = att.item_id
    ? ((db.prepare('SELECT title FROM items WHERE id = ?').get(att.item_id) as
        | { title: string | null }
        | undefined)?.title ?? undefined)
    : undefined
  const docAuthors = att.item_id
    ? (db
        .prepare(
          `SELECT a.display_name AS name FROM item_authors ia
           JOIN authors a ON a.id = ia.author_id WHERE ia.item_id = ? ORDER BY ia.position`
        )
        .all(att.item_id) as Array<{ name: string }>)
        .map((r) => r.name)
        .join(', ') || undefined
    : undefined

  const cfg = mtConfig()
  const backend = opts.backend && opts.backend !== 'auto' ? opts.backend : cfg.backend
  const baseUrl = cfg.baseUrl
  const model = cfg.model
  const apiKey = cfg.apiKey

  // 源文件指纹：同一路径内容变了就不能复用旧译文
  let fingerprint = ''
  try {
    const st = statSync(resolveStoragePath(att.path))
    fingerprint = `${st.size}:${Math.floor(st.mtimeMs)}`
  } catch {
    /* 文件不可读时不做复用 */
  }
  const termsSignature = glossaryInstructions(listArticleTerms(att.id)) + effective('mt.glossary', 'PAPERDESK_MT_GLOSSARY', '')
  const reuseSig = { backend, model: model ?? '', fingerprint, engineKey, layout,
    terminologyHash: termsSignature ? createHash('sha256').update(termsSignature).digest('hex') : '' }

  // 默认复用已有译文，但必须核对：同引擎/模式、同后端与模型、源文件未变；
  // mock/none 不得冒充真实模型结果。force 始终跳过。
  // 复用决策由纯函数给出（单测覆盖 force / backend / model 变化）
  const existing = fingerprint ? getTranslation(attachmentId, lang) : null
  const reuseDecision = decideTranslationReuse({
    force: opts.force,
    fingerprint,
    existing,
    sig: reuseSig,
    backend
  })
  if (reuseDecision.reuse && existing) {
    onProgress?.({ stage: 'done', message: reuseDecision.message })
    return existing as Translation
  }

  if (backend === 'openai') {
    const hint = openCodeEndpointHint(baseUrl, model)
    if (hint) throw new Error(hint)
  }
  const tkey = generateKey()
  const relPath = `${att.key}.${tkey}.${lang}.pdf`
  const outPath = join(translatedDir(), relPath)
  // HTML 译文已移除（AI 侧可直接产出 LaTeX/结构化内容），只保留 PDF + Markdown
  const mdRel = `${att.key}.${tkey}.${lang}.md`
  const mdAbs = join(translatedDir(), mdRel)
  const biMdRel = `${att.key}.${tkey}.${lang}.bilingual.md`
  const biMdAbs = join(translatedDir(), biMdRel)
  // 并发度：侧车是**全局线程池**（跨类型组并行），翻译本身是 I/O 密集——
  // 实测单个 key 并发 8/16/32 时单请求延迟基本不变、无 429，因此 OpenCode 网关
  // 默认 32（上限 32），其它端点默认 24（更保守，避免 429）。
  // 可用 mt.workers / PAPERDESK_MT_WORKERS 覆盖，最终仍夹到 1~32。
  const isOC = isOpenCode(baseUrl)
  const defaultWorkers = '4'
  const workers = Number(effective('mt.workers', 'PAPERDESK_MT_WORKERS', defaultWorkers)) || Number(defaultWorkers)
  const effWorkers = Math.max(1, Math.min(32, workers))
  // 该网关是**延迟主导**：单请求耗时随「段数」增长远快于线性（实测 4 段 42s、
  // 8 段 61s、16 段 127s），而并发是近乎免费的（32 路无排队）。
  // 所以最优不是「批越大越好」，而是「请求数不超过并发数（一波打完）+ 批尽量小」；
  // 侧车会按分组大小自动选批，此处不再固定小批。需要固定值时设 mt.batch（4~16）。
  const batchOverride = Number(effective('mt.batch', 'PAPERDESK_MT_BATCH', ''))
  const batchSize =
    isOC && batchOverride > 0 ? Math.max(4, Math.min(16, batchOverride)) : undefined
  // 术语表：用户自定义（每行 `英文=中文`）优先，自动抽取的补在后面。
  // 自动抽取只花一次短请求（关思考），结果按内容哈希缓存，重译不再花钱。
  const glossary = effective('mt.glossary', 'PAPERDESK_MT_GLOSSARY', '')
  const autoGlossary = effective('mt.autoGlossary', 'PAPERDESK_MT_AUTO_GLOSSARY', '1') !== '0'
  // 翻译时关闭模型思考：论文段落翻译不需要推理。开着思考时单请求要白等几十秒，
  // 这是长文档翻译慢的主因。服务端不接受该参数时侧车会自动降级（仍可翻译）。
  // 设置语义：mt.thinking='0'（默认）=关闭思考；'1'=使用服务端默认。
  const noThink = effective('mt.thinking', 'PAPERDESK_MT_THINKING', '0') === '0'

  onProgress?.({
    stage: 'starting',
    message: opts.force ? '正在重新翻译：已忽略已有译文…' : '准备中…'
  })
  const base = await ensureSidecar()

  // ---- 模块化：翻译前先拿到结构化模块，只翻译正文（图/表/公式/参考文献不译）----
  let skipRects: Record<string, number[][]> | undefined
  let articleTerms = listArticleTerms(att.id)
  try {
    const mods = await getModules(att.id)
    if (autoGlossary && backend === 'openai' && /^zh/i.test(lang)) {
      onProgress?.({ stage: 'starting', message: '提取本文术语并查找参考译名…' })
      try {
        articleTerms = await prepareArticleTerms(att.id, mods.modules.filter((m) => m.type !== 'reference').map((m) => m.text).join('\n'), () => translationJobs.isCancelled(opts.requestId))
      } catch (e) { console.warn('[glossary] extraction unavailable:', e instanceof Error ? e.message : String(e)) }
    }
    if (mods.pageCount > 0 && mods.modules.length) {
      const SKIP = new Set(['figure', 'table', 'equation', 'reference'])
      const acc: Record<string, number[][]> = {}
      for (const m of mods.modules) {
        if (!SKIP.has(m.type)) continue
        // 一个模块可能有多个片段（参考文献续行可能跨块/跨页）：
        // 逐段生成保护矩形，不能只用首段的 rect/page。
        const pieces = [
          { page: m.page, rect: m.rect },
          ...(m.rects ?? []).map((x) => ({ page: x.page, rect: x.rect }))
        ]
        for (const piece of pieces) {
          const key = String(piece.page - 1) // 侧车用 0 基页码
          ;(acc[key] ??= []).push([
            piece.rect[0],
            piece.rect[1],
            piece.rect[2],
            piece.rect[3]
          ])
        }
      }
      if (Object.keys(acc).length) skipRects = acc
    }
  } catch {
    /* 模块不可用：退回启发式（不影响翻译） */
  }
  const finalTerms = glossaryInstructions(articleTerms) + glossary
  reuseSig.terminologyHash = finalTerms ? createHash('sha256').update(finalTerms).digest('hex') : ''

  /** 任务失败/被杀时清掉可能写了一半的 PDF（避免 0 字节文件被当成译文） */
  const cleanupPartial = (): void => {
    try {
      if (existsSync(outPath)) rmSync(outPath, { force: true })
    } catch {
      /* 忽略 */
    }
  }

  if (translationJobs.isCancelled(opts.requestId)) throw new Error('翻译已取消')

  // 启动后台翻译任务（避免单个超长请求触发 Node fetch 超时）
  const startRes = await fetch(`${base}/translate/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: resolveStoragePath(att.path),
      outPath,
      targetLang: lang,
      engine,
      backend,
      baseUrl,
      apiKey,
      model,
      headers: modelHeaders(baseUrl, sessionFor.translate(att.key)),
      mode,
      mdPath: mdAbs,
      bilingualMdPath: biMdAbs,
      layout,
      skillsDir: skillsDir(),
      docTitle,
      docAuthors,
      maxWorkers: effWorkers,
      batchSize,
      glossary: glossary || undefined,
      terminology: /^zh/i.test(lang) ? glossaryInstructions(articleTerms) : '',
      autoGlossary: autoGlossary && articleTerms.length === 0,
      noThink,
      fontDelta: effFontDelta,
      skipRects
    })
  }).catch((e: unknown) => {
    // 启动响应丢失不代表服务未接收任务，存活时不能删仍在写入的产物。
    if (!isSidecarRunning(base)) cleanupPartial()
    throw new Error(
      `无法连接本地翻译服务（可能刚重启）：${e instanceof Error ? e.message : String(e)}`
    )
  })
  if (!startRes.ok) throw new Error(`启动翻译失败: ${startRes.status}`)
  const { jobId } = (await startRes.json()) as { jobId: string }
  await translationJobs.attach(opts.requestId, base, jobId)

  const finalize = async (result: SidecarTranslateResult): Promise<Translation> => {
    const data = result
    onProgress?.({
      stage: 'saving',
      message: `写入译文（${data.pages ?? '?'} 页 / ${data.blocks ?? '?'} 块）`
    })

    const ts = new Date().toISOString()
    // 记录**实际执行**的引擎：pdf2zh 失败回退到内置引擎后，
    // 不能仍把它标成 pdf2zh（否则下次请求 pdf2zh 会误复用这份回退结果）。
    const actualEngine = data.engine && data.engine !== 'pdf2zh' ? data.engine : engine
    const actualBase = layout === 'strict' ? `${actualEngine}:strict` : actualEngine
    const actualKey = (mode === 'coarse' ? `${actualBase}:coarse` : actualBase) + (effFontDelta > 0 ? `:f${effFontDelta}` : '')
    if (actualEngine !== engine) {
      data.warnings = [
        ...(data.warnings ?? []),
        `请求的引擎「${engine}」未生效，实际使用「${actualEngine}」`
      ]
    }
    const tx = db.transaction((): Translation => {
      // 保留历史：把同附件同语言的旧译文标记为 superseded（文件保留，可回看）
      db.prepare(
        "UPDATE translations SET status = 'superseded' WHERE attachment_id = ? AND lang = ? AND status = 'done'"
      ).run(attachmentId, lang)
      const r = db
        .prepare(
          `INSERT INTO translations (key, attachment_id, lang, path, engine, backend, status, date_added)
           VALUES (?, ?, ?, ?, ?, ?, 'done', ?)`
        )
        .run(tkey, attachmentId, lang, relPath, actualKey, data.backend ?? backend, ts)
      return db.prepare('SELECT * FROM translations WHERE id = ?').get(Number(r.lastInsertRowid)) as Translation
    })
    const row = tx()

    // 质量自检结果 + 覆盖率/告警一起落库（原来只存 qa，溢出与告警在历史里看不到）
    if (data.qa || data.warnings?.length || data.coverage) {
      try {
        const q = JSON.stringify({
          ...(data.qa ?? {}),
          coverage: data.coverage ?? null,
          warnings: data.warnings ?? [],
          overflowPath: data.overflowPath ?? null,
          actualEngine,
          reuse: reuseSig
        })
        getDb().prepare('UPDATE translations SET qa = ? WHERE id = ?').run(q, row.id)
        row.qa = q
      } catch {
        /* 忽略 */
      }
    }

    // Markdown（译文 / 对照）：保留轻量文本导出。HTML 译文已从产品中移除。
    try {
      if (data.mdPath && existsSync(mdAbs)) {
        getDb().prepare('UPDATE translations SET md_path = ? WHERE id = ?').run(mdRel, row.id)
        row.md_path = mdRel
        try {
          const title = `${docTitle ?? '论文'} 译文(${lang})`
          getDb().prepare('DELETE FROM translations_fts WHERE rowid = ?').run(row.id)
          getDb()
            .prepare('INSERT INTO translations_fts (rowid, title, body) VALUES (?, ?, ?)')
            .run(row.id, title, readFileSync(mdAbs, 'utf8'))
        } catch {
          /* 索引失败不影响翻译 */
        }
      }
      if (data.bilingualMdPath && existsSync(biMdAbs)) {
        getDb()
          .prepare('UPDATE translations SET bilingual_md_path = ? WHERE id = ?')
          .run(biMdRel, row.id)
        row.bilingual_md_path = biMdRel
      }
    } catch (e) {
      data.warnings = [...(data.warnings ?? []), `Markdown 生成失败: ${e instanceof Error ? e.message : String(e)}`]
    }

    const summary = data.counts
      ? Object.entries(data.counts)
          .map(([k, v]) => `${KIND_LABEL[k] ?? k} ${v}`)
          .join(' · ')
      : ''
    const secs = data.timing?.totalSeconds
    const timeText = secs ? `，用时 ${secs >= 60 ? `${(secs / 60).toFixed(1)} 分钟` : `${Math.round(secs)} 秒`}` : ''
    const modeText = mode === 'coarse' ? '粗译' : '精译'
    const warnings = data.warnings ?? []
    if (warnings.length) {
      console.warn('[translate]', warnings.join('; '))
      // 优先显示「内容/版面」类告警，而不是耗时信息（否则真正的风险会被挤掉）
      const important =
        warnings.find((w) => /放不下|失败|截断|未覆盖|缺失|丢弃|不一致/.test(w)) ?? warnings[0]
      onProgress?.({
        stage: 'done',
        message: `${modeText}完成${summary ? '：' + summary : ''}${timeText}（告警 ${warnings.length} 条：${important}）`
      })
    } else {
      onProgress?.({
        stage: 'done',
        message: `${modeText}完成${summary ? '：' + summary : ''}${timeText}`
      })
    }
    // 历史自动保留策略：设置「每篇最多保留 N 份」时，翻译后自动清理旧版本（0=不限制）
    try {
      const keep = Number(effective('mt.keepVersions', 'PAPERDESK_MT_KEEP_VERSIONS', '0')) || 0
      if (keep > 0) pruneTranslations(attachmentId, lang, keep)
    } catch {
      /* 忽略 */
    }
    return row
  }

  // 轮询进度
  let data: SidecarTranslateResult | null = null
  try {
  for (;;) {
    // 调用方取消（如批处理）：立刻请求侧车终止并退出，不等后台跑完
    if (isCancelled?.()) {
      await translationJobs.cancel(opts.requestId)
      throw new Error('已取消')
    }
    await sleep(700)
    if (translationJobs.isCancelled(opts.requestId)) await translationJobs.cancel(opts.requestId)
    let st: {
      status: string
      stage?: string
      done: number
      total: number
      message?: string
      error?: string
      result?: SidecarTranslateResult
    }
    let stRes: Response
    try {
      stRes = await pollTranslationStatus(`${base}/translate/status/${jobId}`, {
        isRunning: () => isSidecarRunning(base),
        isCancelled: () => translationJobs.isCancelled(opts.requestId),
        cancel: () => translationJobs.cancel(opts.requestId),
        reconnecting: () => onProgress?.({
          stage: 'reconnecting', message: '本地服务暂不可达，正在恢复连接（可取消）…'
        })
      })
    } catch (error) {
      if (error instanceof TranslationServiceExited) {
        cleanupPartial()
        throw new Error(error.message + sidecarLogTail())
      }
      throw error
    }
    if (!stRes.ok) {
      // 404 明确表示任务不存在；其它 HTTP 错误不证明写入已停止。
      if (stRes.status === 404) cleanupPartial()
      throw new Error(stRes.status === 404
        ? '翻译任务在本地服务中已丢失，请重新点击「翻译」。'
        : `任务状态查询失败: ${stRes.status}（产物已保留）`)
    }
    st = (await stRes.json()) as typeof st
    if (st.status === 'error') {
      cleanupPartial()
      throw new Error(st.error || '翻译失败')
    }
    if (st.status === 'done') {
      data = st.result ?? null
      break
    }
    onProgress?.({
      stage: st.stage ?? 'translating',
      message: stageMessage(st),
      progress: st.total > 0 ? Math.min(1, st.done / st.total) : undefined
    })
  }
  } catch (error) {
    // 断连/取消后仍无法确认终态：保留身份与 finalize，恢复连接后由 reconciliation 收敛
    if (error instanceof TranslationTerminationUnconfirmed) {
      translationJobs.markUnconfirmed(opts.requestId, { finalize })
    }
    throw error
  }
  if (!data) {
    cleanupPartial()
    throw new Error('翻译任务未返回结果')
  }

  return await finalize(data)


}

/**
 * 收敛「终止未确认」任务：断连/取消窗口过后，恢复连接时查询侧车。
 * - done 且未被用户取消 → 用保留的 finalize 登记（只登记一次）
 * - error / cancelled / 404 → 释放身份
 * - 仍不可达 → 保留，下次再试；超过 30 分钟清理并记日志
 */
export async function reconcileTranslationJobs(): Promise<{
  recovered: number
  expired: number
}> {
  let recovered = 0
  for (const job of translationJobs.pending()) {
    try {
      const res = await fetch(`${job.base}/translate/status/${job.jobId}`, {
        signal: AbortSignal.timeout(8000)
      })
      if (res.status === 404) {
        translationJobs.confirm(job.id)
        continue
      }
      if (!res.ok) continue
      const st = (await res.json()) as { status?: string; result?: SidecarTranslateResult }
      if (st.status === 'done' && st.result && job.finalize && !job.cancelled) {
        await job.finalize(st.result)
        translationJobs.confirm(job.id)
        recovered++
        console.log('[translate] 已恢复并登记后台完成的任务:', job.jobId)
      } else if (st.status === 'error' || st.status === 'cancelled' || st.status === 'done') {
        translationJobs.confirm(job.id)
      }
    } catch {
      /* 服务仍不可达：保留，下次再试 */
    }
  }
  const expired = translationJobs.releaseExpired()
  if (expired.length) {
    console.warn('[translate] 终止未确认任务已过期（30 分钟），释放跟踪:', expired.join(','))
  }
  return { recovered, expired: expired.length }
}

interface TranslationInfo {
  key: string
  title: string | null
  authors: string | null
  lang: string
  engine: string
  backend: string
  model: string
  qa: { translated: number; skipped: number; unchanged: number; suspicious: number }
  files: { rel: string; label: string }[]
  generatedAt: string
}

const FILE_LABEL: Record<string, string> = {
  pdf: '译文 PDF（保留版式）',
  html: '译文网页（自包含 HTML）',
  bilingual: '中英对照 HTML',
  md: '译文 Markdown',
  bilingual_md: '中英对照 Markdown'
}

/** 汇总一份译文的元信息（供 README / manifest / 快照统一使用） */
export function translationInfo(id: number): TranslationInfo {
  const db = getDb()
  const row = db.prepare('SELECT * FROM translations WHERE id = ?').get(id) as
    | Translation
    | undefined
  if (!row) throw new Error('译文不存在')
  const att = db
    .prepare('SELECT key, item_id FROM attachments WHERE id = ?')
    .get(row.attachment_id) as { key: string; item_id: number | null } | undefined
  const title = att?.item_id
    ? (((db.prepare('SELECT title FROM items WHERE id = ?').get(att.item_id) as
        | { title: string | null }
        | undefined)?.title ?? null) as string | null)
    : null
  const authors = att?.item_id
    ? ((db
        .prepare(
          "SELECT group_concat(a.display_name, ', ') AS names FROM item_authors ia JOIN authors a ON a.id = ia.author_id WHERE ia.item_id = ?"
        )
        .get(att.item_id) as { names: string | null } | undefined)?.names ?? null)
    : null
  let qa: {
    translated?: number
    skipped?: number
    unchanged?: number
    suspicious?: number
  } = {}
  try {
    qa = row.qa ? (JSON.parse(row.qa) as typeof qa) : {}
  } catch {
    qa = {}
  }
  const files: { rel: string; label: string }[] = []
  const add = (rel: string | null, label: string): void => {
    if (rel) files.push({ rel, label })
  }
  add(row.path, FILE_LABEL.pdf)
  add(row.html_path, FILE_LABEL.html)
  add(row.bilingual_path, FILE_LABEL.bilingual)
  add(row.md_path, FILE_LABEL.md)
  add(row.bilingual_md_path, FILE_LABEL.bilingual_md)
  let model = ''
  try {
    model = mtConfig().model
  } catch {
    /* 忽略 */
  }
  return {
    key: att?.key ?? 'translation',
    title,
    authors,
    lang: row.lang,
    engine: row.engine ?? 'simple',
    backend: row.backend ?? '—',
    model,
    qa: {
      translated: qa.translated ?? 0,
      skipped: qa.skipped ?? 0,
      unchanged: qa.unchanged ?? 0,
      suspicious: qa.suspicious ?? 0
    },
    files,
    generatedAt: new Date().toISOString()
  }
}

/** 渲染导出的 README 清单 */
export function renderTranslationReadme(info: TranslationInfo): string {
  const lines: string[] = []
  lines.push(`# ${info.title ?? info.key}｜译文导出`)
  lines.push('')
  if (info.title) lines.push(`- 标题：${info.title}`)
  if (info.authors) lines.push(`- 作者：${info.authors}`)
  lines.push(`- 目标语言：${info.lang}`)
  lines.push(`- 引擎：${info.engine}`)
  lines.push(
    `- 翻译统计：已译 ${info.qa.translated} · 跳过 ${info.qa.skipped} · 未改动 ${info.qa.unchanged} · 疑似未译 ${info.qa.suspicious}`
  )
  lines.push(`- 生成时间：${info.generatedAt}`)
  lines.push('')
  lines.push('## 包含文件')
  lines.push('')
  for (const f of info.files) lines.push(`- \`${f.rel}\`：${f.label}`)
  return lines.join('\n')
}

/** 渲染批处理归档的 manifest */
export function renderTranslationManifest(
  info: TranslationInfo,
  extra: { id?: number; zip?: string; qa?: string } = {}
): string {
  const lines: string[] = []
  lines.push('# 翻译归档清单')
  lines.push('')
  lines.push(`- 附件：${info.key}`)
  lines.push(`- 目标语言：${info.lang}`)
  if (extra.id != null) lines.push(`- 译文 ID：${extra.id}`)
  lines.push(`- 引擎：${info.engine}`)
  lines.push(`- 后端：${info.backend}`)
  lines.push(`- 模型：${info.model || '—'}`)
  lines.push(
    `- 翻译统计：已译 ${info.qa.translated} · 跳过 ${info.qa.skipped} · 未改动 ${info.qa.unchanged} · 疑似未译 ${info.qa.suspicious}`
  )
  for (const f of info.files) lines.push(`- ${f.label}：${f.rel}`)
  if (extra.qa) lines.push(`- 质量自检：${extra.qa}`)
  if (extra.zip) lines.push(`- ZIP：${extra.zip}`)
  lines.push('')
  lines.push(`生成时间：${info.generatedAt}`)
  return lines.join('\n')
}

export async function exportZip(id: number): Promise<string> {
  const db = getDb()
  const row = db.prepare('SELECT * FROM translations WHERE id = ?').get(id) as
    | Translation
    | undefined
  if (!row) throw new Error('译文不存在')
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(row.attachment_id) as
    | Attachment
    | undefined
  const dir = translatedDir()
  const files = [row.path, row.html_path, row.bilingual_path, row.md_path, row.bilingual_md_path]
    .filter((p): p is string => !!p)
    .map((p) => join(dir, p))

  // 生成 README（清单）并纳入 ZIP
  try {
    const info = translationInfo(id)
    const readmeRel = `${info.key}.${info.lang}.README.md`
    writeFileSync(join(dir, readmeRel), renderTranslationReadme(info), 'utf8')
    files.push(join(dir, readmeRel))
  } catch (e) {
    console.warn('[translate] README 生成失败:', e)
  }

  const zipRel = `${att?.key ?? 'translation'}.${row.lang}.zip`
  const zipAbs = join(dir, zipRel)
  const base = await ensureSidecar()
  const r = await fetch(`${base}/zip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outPath: zipAbs, files })
  })
  if (!r.ok) throw new Error(`打包失败: ${r.status}`)
  return zipAbs
}

/** 把「<!-- 第 N 页 -->」换成可点击的页码锚点（跳回阅读器对应页） */
function anchorize(md: string, attKey: string): string {
  return md.replace(
    /<!--\s*第\s*(\d+)\s*页\s*-->/g,
    (_m, n) =>
      `> [↓ 第 ${n} 页](paperdesk://open?attachment=${encodeURIComponent(attKey)}&page=${n})`
  )
}

/** 把译文/对照 Markdown 归档进该条目的笔记（带页码锚点） */
export function archiveToNote(
  id: number,
  which: 'translation' | 'bilingual'
): { noteKey: string } {
  const db = getDb()
  const row = db.prepare('SELECT * FROM translations WHERE id = ?').get(id) as
    | Translation
    | undefined
  if (!row) throw new Error('译文不存在')
  const att = db
    .prepare('SELECT key, item_id FROM attachments WHERE id = ?')
    .get(row.attachment_id) as { key: string; item_id: number | null } | undefined
  if (att?.item_id == null) throw new Error('该译文对应的条目不存在')
  const p = markdownAbsPath(id, which)
  if (!p) throw new Error('该译文还没有 Markdown 版本，请重新翻译')
  const title = which === 'bilingual' ? `译文（${row.lang}）中英对照` : `译文（${row.lang}）`
  const note = upsertSectionInItemNote(att.item_id, title, anchorize(readFileSync(p, 'utf8'), att.key))
  return { noteKey: note.key }
}

/** 一键归档：译文 + 对照写入笔记，并打包 ZIP；返回笔记 key 与 zip 绝对路径 */
export async function archiveAll(id: number): Promise<{ noteKey: string; zip: string }> {
  const first = archiveToNote(id, 'translation')
  try {
    archiveToNote(id, 'bilingual')
  } catch {
    /* 没有对照就跳过 */
  }
  const zip = await exportZip(id)
  return { noteKey: first.noteKey, zip }
}

/** 生成质量自检清单 Markdown（供导出/入笔记复用） */
function buildQaMarkdown(id: number): { md: string; key: string; lang: string; itemId: number | null } {
  const db = getDb()
  const row = db.prepare('SELECT * FROM translations WHERE id = ?').get(id) as
    | Translation
    | undefined
  if (!row) throw new Error('译文不存在')
  const att = db
    .prepare('SELECT key, item_id FROM attachments WHERE id = ?')
    .get(row.attachment_id) as { key: string; item_id: number | null } | undefined
  let qa: {
    translated?: number
    skipped?: number
    suspicious?: number
    unchanged?: number
    items?: { page: number; text: string }[]
  } = {}
  try {
    qa = row.qa ? (JSON.parse(row.qa) as typeof qa) : {}
  } catch {
    qa = {}
  }
  const key = att?.key ?? 'translation'
  const lines: string[] = []
  lines.push('# 翻译质量自检清单')
  lines.push('')
  lines.push(`- 目标语言：${row.lang}`)
  lines.push(`- 引擎：${row.engine ?? 'simple'}`)
  lines.push(
    `- 已译：${qa.translated ?? 0}　跳过：${qa.skipped ?? 0}　未改动：${qa.unchanged ?? 0}　疑似未译：${qa.suspicious ?? 0}`
  )
  lines.push('')
  const items = qa.items ?? []
  if (items.length === 0) {
    lines.push('未发现明显的漏译段落。')
  } else {
    lines.push('## 需人工复核的段落')
    lines.push('')
    for (const it of items) {
      const link = `[↓ 打开](paperdesk://open?attachment=${encodeURIComponent(key)}&page=${it.page})`
      lines.push(`- [ ] 第 ${it.page} 页：${link} ${it.text.replace(/\s+/g, ' ').trim()}`)
    }
  }
  return { md: lines.join('\n'), key, lang: row.lang, itemId: att?.item_id ?? null }
}

/** 导出质量自检清单为 Markdown（供人工复核漏译段落），返回绝对路径 */
export function exportQa(id: number): string {
  const { md, key, lang } = buildQaMarkdown(id)
  const abs = join(translatedDir(), `${key}.${lang}.qa.md`)
  writeFileSync(abs, md, 'utf8')
  return abs
}

/** 把质量自检清单归档进该条目的笔记，返回笔记 key */
export function archiveQaToNote(id: number): { noteKey: string } {
  const { md, lang, itemId } = buildQaMarkdown(id)
  if (itemId == null) throw new Error('该译文对应的条目不存在')
  const note = upsertSectionInItemNote(itemId, `翻译质量自检（${lang}）`, md)
  return { noteKey: note.key }
}

/** 读取译文的 HTML 版本 */
export function readTranslationHtml(id: number): string {
  const row = getDb().prepare('SELECT * FROM translations WHERE id = ?').get(id) as
    | Translation
    | undefined
  if (!row?.html_path) throw new Error('该译文还没有 HTML 版本，请重新翻译')
  return readFileSync(join(translatedDir(), row.html_path), 'utf8')
}

/** 中英对照 HTML 的绝对路径 */
export function bilingualAbsPath(id: number): string | null {
  const row = getDb().prepare('SELECT * FROM translations WHERE id = ?').get(id) as
    | Translation
    | undefined
  if (!row?.bilingual_path) return null
  return join(translatedDir(), row.bilingual_path)
}

/** 读取中英对照 HTML */
export function readTranslationBilingual(id: number): string {
  const p = bilingualAbsPath(id)
  if (!p) throw new Error('该译文还没有中英对照版本')
  return readFileSync(p, 'utf8')
}

const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 读取中英对照 HTML，并把命中词高亮（用 <mark class="hit-mark">） */
export function readTranslationBilingualMarked(id: number, query: string): string {
  const html = readTranslationBilingual(id)
  const needle = escHtml((query ?? '').trim())
  if (needle.length < 2) return html
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  return html.replace(re, (m) => `<mark class="hit-mark">${m}</mark>`)
}

/** 读取单语译文 HTML，并把命中词高亮（网页译文视图用） */
export function readTranslationHtmlMarked(id: number, query: string): string {
  const html = readTranslationHtml(id)
  const needle = escHtml((query ?? '').trim())
  if (needle.length < 2) return html
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  return html.replace(re, (m) => `<mark class="hit-mark">${m}</mark>`)
}

/** 深色主题覆盖（与渲染层一致；快照导出时注入） */
const SNAPSHOT_DARK_CSS = `body{background:#1b1d21;color:#e6e6e6}
.sw{background:#1b1d21;border-bottom-color:#333}
.sw label{color:#ccc;border-color:#454545}
.pg+.pg{border-top-color:#333}
.pair{border-left-color:#454545}
.pair .src{color:#9aa0a6}
.pair .dst{color:#ececec}
.pgno{color:#7c828a}
.caption{color:#9aa0a6}
mark.hit-mark{background:rgba(255,190,60,.30);color:inherit}`

/** 快照自带的浮动工具条样式 */
const SNAPSHOT_TOOLS_CSS = `.pd-tools{position:fixed;right:16px;bottom:16px;z-index:50;display:flex;gap:10px;align-items:center;
background:rgba(0,0,0,.72);color:#fff;padding:6px 12px;border-radius:999px;font-size:12px;
font-family:-apple-system,'Segoe UI','Noto Sans SC',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)}
.pd-tools a{color:#fff;text-decoration:none}
.pd-tools .pd-hit{color:#ffe58a}`

/** 生成「当前视图 + 命中高亮」的自包含 HTML 快照内容（含浮动工具条） */
export function renderBilingualSnapshot(id: number, query: string, theme: string): string {
  let html =
    (query ?? '').trim().length >= 2
      ? readTranslationBilingualMarked(id, query)
      : readTranslationBilingual(id)
  const hits = (html.match(/class="hit-mark"/g) || []).length
  const toolbar = `<div class="pd-tools"><span class="pd-hit">命中 ${hits} 处</span><a href="#pd-top">↑ 回到顶部</a></div>`
  const style = `<style>${SNAPSHOT_TOOLS_CSS}${theme === 'dark' ? SNAPSHOT_DARK_CSS : ''}</style>`
  if (html.includes('</head>')) html = html.replace('</head>', `${style}</head>`)
  html = html.replace(/<body([^>]*)>/, `<body$1 id="pd-top">${toolbar}`)
  return html
}

/** 生成「单语网页译文 + 命中高亮」的自包含 HTML 快照内容（含浮动工具条） */
export function renderHtmlSnapshot(id: number, query: string, theme: string): string {
  let html =
    (query ?? '').trim().length >= 2
      ? readTranslationHtmlMarked(id, query)
      : readTranslationHtml(id)
  const hits = (html.match(/class="hit-mark"/g) || []).length
  const toolbar = `<div class="pd-tools"><span class="pd-hit">命中 ${hits} 处</span><a href="#pd-top">↑ 回到顶部</a></div>`
  const style = `<style>${SNAPSHOT_TOOLS_CSS}${theme === 'dark' ? SNAPSHOT_DARK_CSS : ''}</style>`
  if (html.includes('</head>')) html = html.replace('</head>', `${style}</head>`)
  html = html.replace(/<body([^>]*)>/, `<body$1 id="pd-top">${toolbar}`)
  return html
}

/** 把文本报告另存到用户指定位置（diff 报告等） */
export async function saveReport(defaultName: string, content: string): Promise<string | null> {
  const { dialog } = await import('electron')
  const res = await dialog.showSaveDialog({
    title: '另存报告',
    defaultPath: defaultName,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'HTML', extensions: ['html'] },
      { name: 'CSV', extensions: ['csv'] }
    ]
  })
  if (res.canceled || !res.filePath) return null
  writeFileSync(res.filePath, content, 'utf8')
  return res.filePath
}

/** 把「当前视图 + 命中高亮」另存为自包含 HTML 快照 */
export async function saveBilingualSnapshot(
  id: number,
  query: string,
  theme: string,
  kind: 'bilingual' | 'html' = 'bilingual'
): Promise<string | null> {
  const db = getDb()
  const row = db.prepare('SELECT * FROM translations WHERE id = ?').get(id) as
    | Translation
    | undefined
  if (!row) throw new Error('译文不存在')
  const att = db
    .prepare('SELECT key FROM attachments WHERE id = ?')
    .get(row.attachment_id) as { key: string } | undefined
  const html =
    kind === 'html'
      ? renderHtmlSnapshot(id, query, theme)
      : renderBilingualSnapshot(id, query, theme)
  const { dialog } = await import('electron')
  const res = await dialog.showSaveDialog({
    title: kind === 'html' ? '另存网页译文快照' : '另存对照快照',
    defaultPath: `${att?.key ?? 'translation'}.${row.lang}.snapshot.html`,
    filters: [{ name: 'HTML', extensions: ['html'] }]
  })
  if (res.canceled || !res.filePath) return null
  writeFileSync(res.filePath, html, 'utf8')
  return res.filePath
}

/** 译文的 HTML 绝对路径（用于打开/另存为） */
export function translationHtmlAbsPath(id: number): string | null {
  const row = getDb().prepare('SELECT * FROM translations WHERE id = ?').get(id) as
    | Translation
    | undefined
  if (!row?.html_path) return null
  return join(translatedDir(), row.html_path)
}

/** 把 HTML 另存到用户指定位置 */
export function saveTranslationHtml(id: number, dest: string): void {
  const src = translationHtmlAbsPath(id)
  if (!src) throw new Error('该译文还没有 HTML 版本')
  copyFileSync(src, dest)
}

/** Markdown 绝对路径（translation=译文；bilingual=中英对照） */
export function markdownAbsPath(id: number, which: 'translation' | 'bilingual'): string | null {
  const row = getDb().prepare('SELECT * FROM translations WHERE id = ?').get(id) as
    | Translation
    | undefined
  const rel = which === 'bilingual' ? row?.bilingual_md_path : row?.md_path
  return rel ? join(translatedDir(), rel) : null
}

/** 把 Markdown 另存到用户指定位置 */
export function saveTranslationMarkdown(
  id: number,
  which: 'translation' | 'bilingual',
  dest: string
): void {
  const src = markdownAbsPath(id, which)
  if (!src) throw new Error('该译文还没有 Markdown 版本')
  copyFileSync(src, dest)
}

/** 翻译自检：定位「为什么翻译不出来」 */
export async function diagnoseTranslation(attachmentId: number): Promise<TranslateDiagnosis> {
  const db = getDb()
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId) as
    | Attachment
    | undefined
  if (!att) throw new Error(`附件不存在: ${attachmentId}`)
  const abs = resolveStoragePath(att.path)

  let pageCount = 0
  let textChars = 0
  let textBlocks = 0
  let scanned = false
  try {
    const base = await ensureSidecar()
    const r = await fetch(`${base}/inspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: abs })
    })
    if (r.ok) {
      const j = (await r.json()) as {
        pageCount: number
        textChars: number
        textBlocks: number
        scanned: boolean
      }
      pageCount = j.pageCount
      textChars = j.textChars
      textBlocks = j.textBlocks
      scanned = j.scanned
    }
  } catch {
    /* 体检失败也不影响其余判断 */
  }

  const cfg = mtConfig()
  const engine = effective('mt.engine', 'PAPERDESK_MT_ENGINE', 'simple')
  const configured = !!cfg.baseUrl && !!cfg.apiKey && cfg.backend === 'openai'
  const hint = cfg.baseUrl ? openCodeEndpointHint(cfg.baseUrl, cfg.model) : null

  const notes: string[] = []
  notes.push(`文本层：${pageCount} 页 / ${textChars} 字符 / ${textBlocks} 文本块`)
  if (scanned) {
    notes.push('基本没有文本层 → 疑似扫描件/纯图片 PDF；内置引擎会输出占位，请改用「视觉识别」引擎')
  }
  if (!configured) {
    notes.push(
      '未配置模型服务 → 翻译只会产出「语言标记 + 原文」的离线占位（看起来像没翻译）。请在 ⚙ 设置里填 Base URL / API Key / 模型'
    )
  }
  if (hint) notes.push(hint)
  if (engine === 'pdf2zh') notes.push('当前引擎为 pdf2zh（需本机已安装），未安装会自动回退内置引擎')
  if (engine === 'vision') notes.push('当前引擎为「视觉识别」：逐页读图翻译（需支持视觉的模型）')
  if (configured && !hint && !scanned && engine === 'simple') {
    notes.push(`结论：应可正常翻译（引擎 ${engine} · 模型 ${cfg.model} · 走 ${cfg.baseUrl.includes('/messages') ? 'Anthropic Messages' : 'OpenAI Chat Completions'}）`)
  }

  return {
    pageCount,
    textChars,
    textBlocks,
    scanned,
    engine,
    backend: cfg.backend,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    configured,
    endpointHint: hint,
    notes
  }
}

/** 按译文产物路径反查译文（含所属条目），供文件面板点击译文产物时定位 */
export function translationByPath(path: string): TranslationTarget | null {
  const db = getDb()
  const norm = String(path ?? '').replace(/\\/g, '/')
  const base = norm.split('/').pop() ?? norm
  const row = db
    .prepare(
      `SELECT t.*, a.item_id AS item_id FROM translations t
       LEFT JOIN attachments a ON a.id = t.attachment_id
       WHERE t.path IN (?, ?, ?) OR t.html_path IN (?, ?) OR t.bilingual_path IN (?, ?)
       ORDER BY t.id DESC LIMIT 1`
    )
    .get(norm, base, `translated/${base}`, base, `translated/${base}`, base, `translated/${base}`) as
    | (Translation & { item_id: number | null })
    | undefined
  if (!row) return null
  const { item_id, ...translation } = row
  return { translation: translation as Translation, itemId: item_id ?? null }
}

export function readTranslationBytes(id: number): Uint8Array {
  const row = getDb().prepare('SELECT * FROM translations WHERE id = ?').get(id) as
    | Translation
    | undefined
  if (!row) throw new Error(`译文不存在: ${id}`)
  return readFileSync(join(translatedDir(), row.path))
}

/** 块级映射（与译文 PDF 同目录的 `<stem>.map.json`）；旧译文没有时返回 null */
export function readTranslationMap(id: number): TranslationMap | null {
  const row = getDb().prepare('SELECT * FROM translations WHERE id = ?').get(id) as
    | Translation
    | undefined
  if (!row) return null
  const rel = row.path.replace(/\.pdf$/i, '') + '.map.json'
  try {
    const raw = readFileSync(join(translatedDir(), rel), 'utf-8')
    const parsed = JSON.parse(raw) as TranslationMap
    if (!parsed || !Array.isArray(parsed.blocks)) return null
    return parsed
  } catch {
    return null
  }
}

/** 划词翻译：翻译一段文本（复用统一的模型服务配置）；signal 用于取消（AI 翻译任务） */
export async function translateTexts(
  texts: string[],
  lang = DEFAULT_LANG,
  opts: { signal?: AbortSignal } = {}
): Promise<{ backend: string; texts: string[] }> {
  if (texts.length === 0) return { backend: 'none', texts: [] }
  // 表格块不送翻译：按块切分，只把非表格块拼成一次请求，返回时按序回填（表格原样保留）
  const blocks = texts.map((t) => splitTranslatableBlocks(String(t ?? '')))
  const translatable = blocks.flatMap((bs) => bs.filter((b) => !b.table).map((b) => b.text))
  if (translatable.length === 0) {
    // 整段都是表格（或空白）：不发请求，原样返回，数字与行列不变
    return { backend: 'none', texts: texts.map((t) => String(t ?? '')) }
  }
  const cfg = mtConfig()
  if (cfg.backend === 'openai') {
    const hint = openCodeEndpointHint(cfg.baseUrl, cfg.model)
    if (hint) throw new Error(hint)
  } else if (
    cfg.baseUrl &&
    !cfg.apiKey &&
    effective('provider.mode', 'PAPERDESK_PROVIDER_MODE', 'auto') !== 'mock'
  ) {
    // 填了 Base URL 却没填 Key：不要静默走离线占位（看起来像翻译失败），
    // 更不要把空凭据发给网关等它回 401。
    throw new Error('未配置翻译密钥：请在 设置 → 模型服务 填写 API Key（或清空 Base URL 走离线占位）')
  }
  // 与整篇翻译共用同一开关：mt.thinking='0'（默认）=关闭思考
  const noThink = effective('mt.thinking', 'PAPERDESK_MT_THINKING', '0') === '0'
  const base = await ensureSidecar()
  const res = await fetch(`${base}/translate/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      texts: translatable,
      targetLang: lang,
      backend: cfg.backend,
      baseUrl: cfg.baseUrl || undefined,
      apiKey: cfg.apiKey,
      model: cfg.model || undefined,
      headers: modelHeaders(cfg.baseUrl, sessionFor.selection()),
      noThink
    })
  })
  if (!res.ok) throw new Error(`翻译失败: ${res.status}`)
  const data = (await res.json()) as { backend: string; texts: string[]; error?: string | null }
  if (data.error) throw new Error(data.error)
  // 按块回填：文字块按序取译文，表格块原样保留（模型漏返回时回退原文，不丢内容）
  const translated = Array.isArray(data.texts) ? data.texts : []
  let cursor = 0
  const merged = blocks.map((segments) => {
    const need = segments.filter((b) => !b.table).length
    const slice = translated.slice(cursor, cursor + need)
    cursor += need
    return mergeTranslatedBlocks(segments, slice)
  })
  return { backend: data.backend, texts: merged }
}
