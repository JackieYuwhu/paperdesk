import { BrowserWindow } from 'electron'
import { getDb } from '../db'
import { EVT } from '../../shared/channels'
import { resolveStoragePath } from './storage'
import { effective, llmConfig, modelHeaders, sessionFor } from './settings'
import { indexAttachment } from './embed'
import { refreshSpaceIndex } from './spaces'
import { ensureSidecar } from '../sidecar/manager'
import { classifyItemDomain } from './domain'
import { enrichItem } from './enrich'
import { chunkContentHash } from './knowledge-index'
import type { Attachment, ExtractSummary, StructureResult } from '../../shared/types'

interface SidecarReference {
  index?: number
  raw?: string
  doi?: string | null
  title?: string | null
  via?: string | null
}

interface SidecarResult {
  source: string
  pageCount: number
  metadata: { title: string | null; authors: string[] }
  abstract?: string | null
  year?: number | null
  venue?: string | null
  references: SidecarReference[]
  pages?: { page: number; text: string }[]
  warnings?: string[]
  resolvedCount?: number
}

/** 把一页文本切成若干块（按空行聚合，控制长度） */
function splitChunks(text: string, max = 800): string[] {
  const parts = text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)
  const out: string[] = []
  let cur = ''
  for (const p of parts) {
    if (cur && (cur + '\n' + p).length > max) {
      out.push(cur)
      cur = p
    } else {
      cur = cur ? `${cur}\n${p}` : p
    }
  }
  if (cur) out.push(cur)
  return out.filter((c) => c.length > 10)
}

/** 调用 sidecar 抽取元数据/参考文献，并写库（幂等：重复抽取会覆盖旧结果） */
export async function runExtraction(
  attachmentId: number,
  opts: { forceVision?: boolean; forceTitle?: boolean } = {}
): Promise<ExtractSummary> {
  const db = getDb()
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId) as
    | Attachment
    | undefined
  if (!att) throw new Error(`附件不存在: ${attachmentId}`)

  const base = await ensureSidecar()
  const absPath = resolveStoragePath(att.path)
  const grobidUrl = effective('grobid.url', 'GROBID_URL', '') || null
  // Crossref 消解默认开启（对无 DOI 的参考文献，限量 + 超时）；设 metadata.crossref=0 可关闭
  const resolveCrossref = effective('metadata.crossref', 'PAPERDESK_CROSSREF', '1') !== '0'
  const mailto = effective('openalex.mailto', 'PAPERDESK_OPENALEX_MAILTO', '') || null
  const crossrefLimit = Number(effective('metadata.crossrefLimit', 'PAPERDESK_CROSSREF_LIMIT', '12')) || 12

  const res = await fetch(`${base}/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: absPath, grobidUrl, resolveCrossref, mailto, crossrefLimit })
  })
  if (!res.ok) throw new Error(`sidecar /extract 失败: ${res.status}`)
  const data = (await res.json()) as SidecarResult

  const warnings = [...(data.warnings ?? [])]

  // 无文本层（扫描件）或缺失标题/作者：用视觉模型从首页图片补齐元数据
  const needVision =
    opts.forceVision || !data.metadata?.title || (data.metadata?.authors ?? []).length === 0
  if (needVision) {
    const cfg = llmConfig()
    if (cfg.baseUrl && cfg.apiKey) {
      try {
        const vr = await fetch(`${base}/vision/metadata`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: absPath,
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            model: cfg.model,
            headers: modelHeaders(cfg.baseUrl, sessionFor.chat())
          })
        })
        if (vr.ok) {
          const vm = (await vr.json()) as {
            title?: string | null
            authors?: string[]
            abstract?: string | null
            year?: number | null
            venue?: string | null
            doi?: string | null
          }
          if (!data.metadata) data.metadata = { title: null, authors: [] }
          if (!data.metadata.title && vm.title) data.metadata.title = vm.title
          if ((data.metadata.authors ?? []).length === 0 && vm.authors?.length) {
            data.metadata.authors = vm.authors
          }
          if (!data.abstract && vm.abstract) data.abstract = vm.abstract
          if (data.year == null && vm.year != null) data.year = vm.year
          if (!data.venue && vm.venue) data.venue = vm.venue
          warnings.push('已用视觉模型识别元数据（该 PDF 可能无文本层）')
        } else {
          warnings.push(`视觉元数据识别失败：${vr.status}`)
        }
      } catch (e) {
        warnings.push(`视觉元数据识别失败：${e instanceof Error ? e.message : String(e)}`)
      }
    } else if (opts.forceVision) {
      warnings.push('未配置模型服务，无法进行视觉元数据识别')
    }
  }

  const itemId = persist(att, data, warnings, !!opts.forceTitle)
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send(EVT.libraryChanged)
    } catch {
      /* 窗口可能已关闭 */
    }
  }
  let domainTask: Promise<string | null> = Promise.resolve(null)
  if (itemId != null) {
    // 元数据补全（best-effort，最多一次）：PDF 抽取通常只能拿到标题/作者，
    // 期刊来源、年份、DOI 常缺失（界面显示「暂无发表信息」），这里按 DOI/标题查
    // Crossref + OpenAlex 补齐后写入；失败只记 warning，绝不影响抽取与索引。
    // 注意：判断只看 venue/year/doi，已存在 abstract 的论文也会补全。
    try {
      const row = db
        .prepare('SELECT venue, year, doi FROM items WHERE id = ?')
        .get(itemId) as { venue: string | null; year: number | null; doi: string | null } | undefined
      if (row && (!row.venue || row.year == null || !row.doi)) {
        await enrichItem(itemId)
      }
    } catch (e) {
      warnings.push(`期刊/元数据补全失败：${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      refreshSpaceIndex(itemId)
    } catch {
      /* 空间索引失败不影响抽取 */
    }
    // 领域识别（best-effort；未配置模型时自动跳过）。与索引并行，且必须在最后的
    // libraryChanged 通知前完成，否则单篇导入时界面会先刷新、标签永远不补显示。
    domainTask = classifyItemDomain(itemId).catch(() => null)
  }

  // 建立向量索引（best-effort，失败不影响抽取）
  try {
    const r = await indexAttachment(att.id)
    if (r.indexed > 0) console.log(`[paperdesk] embedded ${r.indexed} chunks (${r.model})`)
  } catch (e) {
    warnings.push(`向量索引失败: ${e instanceof Error ? e.message : String(e)}`)
  }

  await domainTask

  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send(EVT.libraryChanged)
    } catch {
      /* 窗口可能已关闭 */
    }
  }
  return {
    itemId,
    pageCount: data.pageCount ?? 0,
    source: data.source ?? 'unknown',
    authorCount: data.metadata?.authors?.length ?? 0,
    referenceCount: data.references?.length ?? 0,
    resolvedCount: data.resolvedCount ?? data.references?.filter((r) => r.doi).length ?? 0,
    warnings
  }
}

/** 快速提取公式与定理类环境（本地 sidecar） */
export async function runStructure(attachmentId: number): Promise<StructureResult> {
  const db = getDb()
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId) as
    | Attachment
    | undefined
  if (!att) throw new Error(`附件不存在: ${attachmentId}`)
  const base = await ensureSidecar()
  const absPath = resolveStoragePath(att.path)
  const res = await fetch(`${base}/structure`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: absPath })
  })
  if (!res.ok) throw new Error(`sidecar /structure 失败: ${res.status}`)
  return (await res.json()) as StructureResult
}

function persist(
  att: Attachment,
  data: SidecarResult,
  warnings: string[],
  forceTitle = false
): number | null {
  const db = getDb()
  const itemId = att.item_id
  const ts = new Date().toISOString()

  const tx = db.transaction((): number | null => {
    if (typeof data.pageCount === 'number') {
      db.prepare('UPDATE attachments SET page_count = ? WHERE id = ?').run(data.pageCount, att.id)
    }
    if (itemId == null) return null

    // 标题：仅在当前标题为空/等于文件名时覆盖
    const cur = db.prepare('SELECT title FROM items WHERE id = ?').get(itemId) as
      | { title: string | null }
      | undefined
    const fallback = (att.filename ?? '').replace(/\.pdf$/i, '')
    if (data.metadata?.title && (forceTitle || !cur?.title || cur.title === fallback)) {
      db.prepare('UPDATE items SET title = ?, date_modified = ? WHERE id = ?').run(
        data.metadata.title,
        ts,
        itemId
      )
    }
    // 摘要 / 年份 / 来源（视觉识别或其它来源提供时，仅在缺失时补齐）
    if (data.abstract) {
      db.prepare(
        'UPDATE items SET abstract = COALESCE(abstract, ?), date_modified = ? WHERE id = ?'
      ).run(data.abstract, ts, itemId)
    }
    if (data.year != null) {
      db.prepare('UPDATE items SET year = COALESCE(year, ?), date_modified = ? WHERE id = ?').run(
        data.year,
        ts,
        itemId
      )
    }
    if (data.venue) {
      db.prepare('UPDATE items SET venue = COALESCE(venue, ?), date_modified = ? WHERE id = ?').run(
        data.venue,
        ts,
        itemId
      )
    }

    // 作者：整体替换
    const authors = data.metadata?.authors ?? []
    if (authors.length) {
      db.prepare('DELETE FROM item_authors WHERE item_id = ?').run(itemId)
      authors.forEach((name, i) => {
        db.prepare('INSERT OR IGNORE INTO authors (display_name) VALUES (?)').run(name)
        const row = db.prepare('SELECT id FROM authors WHERE display_name = ?').get(name) as {
          id: number
        }
        db.prepare(
          'INSERT OR IGNORE INTO item_authors (item_id, author_id, position) VALUES (?, ?, ?)'
        ).run(itemId, row.id, i)
      })
    }

    // 参考文献 -> citations + works
    db.prepare('DELETE FROM citations WHERE source_item_id = ?').run(itemId)
    const refs = data.references ?? []
    refs.forEach((r, i) => {
      let workId: number | null = null
      if (r.doi) {
        db.prepare('INSERT OR IGNORE INTO works (doi, title) VALUES (?, ?)').run(
          r.doi,
          r.title ?? null
        )
        const w = db.prepare('SELECT id FROM works WHERE doi = ?').get(r.doi) as
          | { id: number }
          | undefined
        workId = w?.id ?? null
      }
      db.prepare(
        'INSERT INTO citations (source_item_id, target_work_id, target_raw, ref_index, resolved) VALUES (?, ?, ?, ?, ?)'
      ).run(itemId, workId, r.raw ?? null, r.index ?? i + 1, r.doi ? 1 : 0)
    })

    if (refs.length === 0) warnings.push('未识别到参考文献（可能格式特殊或缺少 References 段）')
    if (!data.metadata?.title) warnings.push('未提取到标题（可配置 GROBID 提升抽取质量）')
    if ((data.metadata?.authors ?? []).length === 0) warnings.push('未提取到作者')

    // 全文分块 -> chunks（供检索 / RAG）
    // PD40：写入内容指纹；module_id / 字符区间由 knowledge-index 的幂等回填补齐
    // （抽取阶段还没有结构化模块，不能凭空写模块级证据）。
    db.prepare('DELETE FROM chunks WHERE attachment_id = ?').run(att.id)
    const pages = data.pages ?? []
    let chunkCount = 0
    for (const pg of pages) {
      for (const text of splitChunks(pg.text ?? '')) {
        db.prepare(
          'INSERT INTO chunks (attachment_id, page_index, section, bbox, text, content_hash) VALUES (?, ?, NULL, NULL, ?, ?)'
        ).run(att.id, Math.max(0, (pg.page ?? 1) - 1), text, chunkContentHash(text))
        chunkCount++
      }
    }
    if (chunkCount === 0) warnings.push('未索引到全文分块（PDF 可能无文本层）')

    return itemId
  })

  return tx()
}
