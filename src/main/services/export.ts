import { ensureSidecar } from '../sidecar/manager'

export interface ExportResult {
  format: string
  engine?: string
  outPath: string
  pages: number
  blocks: number
  images: number
  formulas: number
  warnings?: string[]
}

/** 调 sidecar /export 把 PDF 导出为 md / html / pdf（保公式排版；可选 MinerU 引擎） */
export async function exportDocument(
  absPath: string,
  outPath: string,
  format: 'md' | 'html' | 'pdf',
  engine = 'simple'
): Promise<ExportResult> {
  const base = await ensureSidecar()
  const res = await fetch(`${base}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: absPath, outPath, format, engine })
  })
  if (!res.ok) throw new Error(`导出失败: ${res.status}`)
  return (await res.json()) as ExportResult
}
