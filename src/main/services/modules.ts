import { createHash } from 'node:crypto'
import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { getDb } from '../db'
import { resolveStoragePath } from './storage'
import { ensureSidecar } from '../sidecar/manager'
import { llmConfig } from './settings'
import type { Attachment } from '../../shared/types'
import type { FigurePage } from './figures'
import type { FormulaModule, Rect4, StructuredDoc } from '../../shared/modules'
import type { StructuredBlock } from '../../shared/blocks'
import { BLOCKS_ADAPTER_VERSION } from '../../shared/blocks'
import type { FormulaValidation } from '../../shared/formula-validate'

export type { Rect4, StructuredDoc }
export type {
  StructuredModule,
  ModuleCaption,
  ModuleRef,
  FormulaModule,
  ModuleType
} from '../../shared/modules'

/**
 * 侧车 ``/modules`` 响应的类型：阶段 B PoC 里 ``blocks`` / ``adapterVersion``
 * 由适配层以**顶层平铺字段**写入（``python/app/blocks_adapter.py: attach_blocks``），
 * 组装成 ``BlocksPayload`` 前先按平铺形态读取。
 */
type SidecarDocResponse = Omit<Partial<StructuredDoc>, 'blocks'> & {
  blocks?: unknown
  adapterVersion?: string
}

/** 公式提取器版本（与侧车 formula.py 的 EXTRACTOR_VERSION 对应；解析逻辑变化时 +1） */
export const EXTRACTOR_VERSION_FALLBACK = 'formula-tree-2'
/** 识别引擎版本（模型/OCR 变化时 +1） */
const OCR_ENGINE_VERSION = 'vision-1'

/**
 * 文档指纹：内容哈希（size + 头尾各 64KB + mtime）。
 * 比 `mtime:size` 更能代表内容（复制/回滚会改变 mtime，编辑但长度不变会改变内容）。
 */
function fingerprint(path: string): string {
  try {
    const st = statSync(path)
    const h = createHash('sha1')
    h.update(`${st.size}:`)
    const fd = openSync(path, 'r')
    try {
      const head = Buffer.alloc(Math.min(65536, st.size))
      readSync(fd, head, 0, head.length, 0)
      h.update(head)
      if (st.size > 65536) {
        const tailLen = Math.min(65536, st.size)
        const tail = Buffer.alloc(tailLen)
        readSync(fd, tail, 0, tailLen, Math.max(0, st.size - tailLen))
        h.update(tail)
      }
    } finally {
      closeSync(fd)
    }
    return h.digest('hex').slice(0, 16)
  } catch {
    return 'unknown'
  }
}

/** 配置哈希：模型/端点变化会让「模型识别」的结果失效 */
function configHash(): string {
  try {
    const cfg = llmConfig()
    return createHash('sha1')
      .update(`${cfg.baseUrl ?? ''}|${cfg.model ?? ''}|${cfg.backend ?? ''}`)
      .digest('hex')
      .slice(0, 12)
  } catch {
    return 'none'
  }
}

interface FormulaRow {
  page_number: number
  bbox: string | null
  formula_order: number
  raw_text: string | null
  latex: string | null
  latex_source: string | null
  structure_json: string | null
  detection_confidence: number | null
  reconstruction_confidence: number | null
  status: string | null
  extractor_version: string | null
  selected_text: string | null
  selected_source: string | null
  fallback_reason: string | null
  validation_results: string | null
  engine_version: string | null
}

/** 写入公式明细表（**唯一数据源**；doc_json 不再镜像公式） */
function writeFormulas(attachmentId: number, formulas: FormulaModule[]): void {
  const db = getDb()
  db.prepare('DELETE FROM document_formulas WHERE document_id = ?').run(attachmentId)
  const ins = db.prepare(
    `INSERT INTO document_formulas
       (document_id, page_number, bbox, formula_order, raw_text, latex, latex_source,
        structure_json, detection_confidence, reconstruction_confidence, status,
        extractor_version, selected_text, selected_source, fallback_reason,
        validation_results, engine_version, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  const now = new Date().toISOString()
  const tx = db.transaction((rows: FormulaModule[]) => {
    rows.forEach((f, i) => {
      // 结果来源：结构解析成功 → structural；否则保留原文 original
      const source = f.selectedSource ?? (f.latex ? 'structural' : 'original')
      ins.run(
        attachmentId,
        f.page,
        JSON.stringify(f.rect ?? null),
        i,
        f.rawText ?? f.text ?? '',
        f.latex ?? null,
        f.latexSource ?? null,
        f.structure != null ? JSON.stringify(f.structure) : null,
        f.detectionConfidence ?? null,
        f.reconstructionConfidence ?? null,
        f.status ?? null,
        f.extractorVersion ?? null,
        f.selectedText ?? f.latex ?? f.rawText ?? f.text ?? '',
        source,
        f.fallbackReason ?? null,
        f.validationResults != null ? JSON.stringify(f.validationResults) : null,
        f.engineVersion ?? null,
        now
      )
    })
  })
  tx(formulas)
}

/** 读取公式明细表 → FormulaModule[]（按 formula_order） */
export function getFormulas(attachmentId: number): FormulaModule[] {
  const rows = getDb()
    .prepare('SELECT * FROM document_formulas WHERE document_id = ? ORDER BY formula_order')
    .all(attachmentId) as FormulaRow[]
  return rows.map((r) => ({
    id: `f${r.formula_order}`,
    page: r.page_number,
    n: null,
    text: r.raw_text ?? '',
    rawText: r.raw_text ?? '',
    rect: (r.bbox ? JSON.parse(r.bbox) : [0, 0, 0, 0]) as Rect4,
    latex: r.latex,
    latexSource: (r.latex_source as FormulaModule['latexSource']) ?? null,
    structure: r.structure_json ? JSON.parse(r.structure_json) : null,
    detectionConfidence: r.detection_confidence ?? undefined,
    reconstructionConfidence: r.reconstruction_confidence ?? undefined,
    status: (r.status as FormulaModule['status']) ?? undefined,
    extractorVersion: r.extractor_version ?? undefined,
    selectedText: r.selected_text,
    selectedSource: (r.selected_source as FormulaModule['selectedSource']) ?? null,
    fallbackReason: r.fallback_reason,
    validationResults: r.validation_results ? JSON.parse(r.validation_results) : null,
    engineVersion: r.engine_version
  }))
}

function attPath(attachmentId: number): string | null {
  const att = getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId) as
    | Attachment
    | undefined
  return att ? resolveStoragePath(att.path) : null
}

/** 文件指纹（mtime + 大小）：文件变化时缓存失效 */
function fileKey(path: string): string {
  try {
    const st = statSync(path)
    return `${Math.round(st.mtimeMs)}:${st.size}`
  } catch {
    return 'unknown'
  }
}

const EMPTY: StructuredDoc = {
  pageCount: 0,
  pages: [],
  modules: [],
  captions: [],
  refs: [],
  formulas: [],
  columns: [],
  counts: { modules: 0, captions: 0, figures: 0, tables: 0, references: 0 },
  warnings: []
}

interface CacheRow {
  doc_json: string
  file_key: string | null
  document_fingerprint: string | null
  extractor_version: string | null
  config_hash: string | null
  ocr_model_version: string | null
}

/** 缓存命中需同时满足：文件键 + 内容指纹 + 提取器版本 + 配置哈希 + OCR 引擎版本 */
function readCache(attachmentId: number, key: string, fp: string, cfg: string): StructuredDoc | null {
  const row = getDb()
    .prepare(
      `SELECT doc_json, file_key, document_fingerprint, extractor_version, config_hash, ocr_model_version
       FROM paper_modules WHERE attachment_id = ?`
    )
    .get(attachmentId) as CacheRow | undefined
  if (!row) return null
  const versionOk =
    row.file_key === key &&
    row.document_fingerprint === fp &&
    row.extractor_version === EXTRACTOR_VERSION_FALLBACK &&
    row.config_hash === cfg &&
    row.ocr_model_version === OCR_ENGINE_VERSION
  if (!versionOk) return null
  try {
    const doc = JSON.parse(row.doc_json) as StructuredDoc
    if (!doc || typeof doc.pageCount !== 'number') return null
    // 公式以**明细表**为唯一数据源（doc_json 不镜像）
    doc.formulas = getFormulas(attachmentId)
    return doc
  } catch {
    return null
  }
}

/** 原子替换：文档 JSON 与公式明细在**同一事务**内写入，失败则整体回滚（保留旧结果） */
function writeCache(attachmentId: number, key: string, fp: string, cfg: string, doc: StructuredDoc): void {
  const db = getDb()
  const { formulas, ...rest } = doc
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO paper_modules
         (attachment_id, doc_json, page_count, file_key, document_fingerprint,
          extractor_version, config_hash, ocr_model_version, stale, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(attachment_id) DO UPDATE SET
         doc_json = excluded.doc_json, page_count = excluded.page_count,
         file_key = excluded.file_key, document_fingerprint = excluded.document_fingerprint,
         extractor_version = excluded.extractor_version, config_hash = excluded.config_hash,
         ocr_model_version = excluded.ocr_model_version, stale = 0,
         created_at = excluded.created_at`
    ).run(
      attachmentId,
      JSON.stringify({ ...rest, formulas: [] }),
      doc.pageCount,
      key,
      fp,
      doc.extractorVersion ?? EXTRACTOR_VERSION_FALLBACK,
      cfg,
      OCR_ENGINE_VERSION,
      new Date().toISOString()
    )
    writeFormulas(attachmentId, formulas ?? [])
  })
  tx()
}

/** 同一文档的重算任务去重（并发调用共享同一次解析） */
const inflight = new Map<number, Promise<StructuredDoc>>()

/**
 * 结构化模块层（侧车脚本计算，不调模型）：章节/段落/图片/表格/图注/表注/公式/定理/参考文献
 * + 关联关系（图注↔图、表注↔表、引用编号↔文末条目）。
 *
 * **版本化缓存**：命中需同时校验 文件键 / 内容指纹 / 提取器版本 / 配置哈希 / OCR 引擎版本；
 * 任一变化 → 重算（并发去重），新结果**原子替换**；失败时保留旧结果（不清空）。
 */
export async function getModules(
  attachmentId: number,
  opts?: { refresh?: boolean }
): Promise<StructuredDoc> {
  const path = attPath(attachmentId)
  if (!path) return EMPTY
  const key = fileKey(path)
  const fp = fingerprint(path)
  const cfg = configHash()
  if (!opts?.refresh) {
    const cached = readCache(attachmentId, key, fp, cfg)
    if (cached) return cached
  }
  const running = inflight.get(attachmentId)
  if (running) return running
  const task = (async (): Promise<StructuredDoc> => {
    try {
      const base = await ensureSidecar()
      const res = await fetch(`${base}/modules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path })
      })
      if (!res.ok) return readCacheAny(attachmentId)
      const data = (await res.json()) as SidecarDocResponse
      const doc: StructuredDoc = {
        pageCount: data.pageCount ?? 0,
        extractorVersion: data.extractorVersion ?? EXTRACTOR_VERSION_FALLBACK,
        pages: (data.pages ?? []) as FigurePage[],
        modules: data.modules ?? [],
        captions: data.captions ?? [],
        refs: data.refs ?? [],
        formulas: data.formulas ?? [],
        columns: data.columns ?? [],
        // 阶段 B PoC：把侧车顶层平铺的 blocks/adapterVersion 组装成 BlocksPayload 透传；
        // 两者都没有（适配层关闭/老数据）→ undefined，缺省不报错、不影响主流程。
        blocks:
          data.adapterVersion != null || Array.isArray(data.blocks)
            ? {
                adapterVersion: data.adapterVersion ?? BLOCKS_ADAPTER_VERSION,
                blocks: (Array.isArray(data.blocks) ? data.blocks : []) as StructuredBlock[]
              }
            : undefined,
        counts: data.counts ?? EMPTY.counts,
        warnings: data.warnings ?? []
      }
      if (doc.pageCount > 0) {
        writeCache(attachmentId, key, fp, cfg, doc)
        doc.formulas = getFormulas(attachmentId)
      }
      return doc
    } catch {
      return readCacheAny(attachmentId)
    } finally {
      inflight.delete(attachmentId)
    }
  })()
  inflight.set(attachmentId, task)
  return task
}

/** 版本不匹配时仍可读旧结果（明确为 stale 兜底），失败才返回空 */
function readCacheAny(attachmentId: number): StructuredDoc {
  const row = getDb()
    .prepare('SELECT doc_json FROM paper_modules WHERE attachment_id = ?')
    .get(attachmentId) as { doc_json: string } | undefined
  if (!row) return EMPTY
  try {
    const doc = JSON.parse(row.doc_json) as StructuredDoc
    doc.formulas = getFormulas(attachmentId)
    return doc
  } catch {
    return EMPTY
  }
}

/**
 * 选择公式的**最终结果**（低置信度回退为候选，不覆盖原文）：
 * source=structural 结构解析 / formula_ocr 模型识别；验证不通过则保留原文并标记待复核。
 */
export function selectFormulaResult(
  attachmentId: number,
  moduleId: string,
  input: {
    latex: string
    source: 'structural' | 'formula_ocr'
    validation?: FormulaValidation
    engineVersion?: string
  }
): boolean {
  try {
    const order = Number(String(moduleId).replace(/^f/, ''))
    if (!Number.isFinite(order)) return false
    const db = getDb()
    const row = db
      .prepare(
        'SELECT raw_text, latex FROM document_formulas WHERE document_id = ? AND formula_order = ?'
      )
      .get(attachmentId, order) as { raw_text: string | null; latex: string | null } | undefined
    if (!row) return false
    const v = input.validation
    const ok = v ? v.ok : !!input.latex
    if (!ok) {
      // 候选未通过验证：**保留原文**，记录回退原因与验证结果，状态标记待复核
      db.prepare(
        `UPDATE document_formulas
         SET selected_text = raw_text, selected_source = 'original',
             fallback_reason = ?, validation_results = ?, status = 'needs_review',
             engine_version = ?
         WHERE document_id = ? AND formula_order = ?`
      ).run(
        v && v.issues.length ? `validation_failed: ${v.issues.join('; ')}` : 'validation_failed',
        v ? JSON.stringify(v) : null,
        input.engineVersion ?? null,
        attachmentId,
        order
      )
      return false
    }
    db.prepare(
      `UPDATE document_formulas
       SET latex = ?, latex_source = ?, selected_text = ?, selected_source = ?,
           fallback_reason = NULL, validation_results = ?, status = 'needs_review',
           engine_version = ?
       WHERE document_id = ? AND formula_order = ?`
    ).run(
      input.latex,
      input.source === 'formula_ocr' ? 'recognized' : 'extracted',
      input.latex,
      input.source,
      v ? JSON.stringify(v) : null,
      input.engineVersion ?? null,
      attachmentId,
      order
    )
    return true
  } catch {
    return false
  }
}
