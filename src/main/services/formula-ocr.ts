import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { formulaFromImage } from './ai'
import { validateFormulaLatex } from '../../shared/formula-validate'
import { deriveStructuralConfidence, type OcrCandidate } from '../../shared/formula-ocr'

const run = promisify(execFile)

/** 识别引擎：可用性探测 + 单次识别（返回候选，不负责选择） */
export interface OcrEngine {
  id: string
  version: string
  available(): Promise<boolean>
  recognize(pngB64: string): Promise<OcrCandidate | null>
}

/** 已有能力：视觉对话模型（不返回置信度 → 用结构置信度兜底） */
const visionEngine: OcrEngine = {
  id: 'vision',
  version: 'vision-1',
  async available(): Promise<boolean> {
    return true
  },
  async recognize(pngB64: string): Promise<OcrCandidate | null> {
    const r = await formulaFromImage(pngB64, 'image/png')
    const latex = (r.latex || '').trim()
    if (!latex || r.kind === 'none') return null
    return {
      engine: 'vision',
      engineVersion: 'vision-1',
      latex,
      confidence: null,
      validation: null
    }
  }
}

/**
 * LaTeX-OCR / pix2tex（可选，未安装则不可用）。
 * 通过环境变量 `PAPERDESK_LATEXOCR` 指定可执行文件；缺省探测 `latexocr`。
 * 输出协议：stdout 最后一行是 LaTeX。
 */
const pix2texEngine: OcrEngine = {
  id: 'pix2tex',
  version: 'latexocr-cli',
  async available(): Promise<boolean> {
    const bin = process.env.PAPERDESK_LATEXOCR || 'latexocr'
    try {
      await run(bin, ['--version'], { timeout: 8000, windowsHide: true })
      return true
    } catch {
      return false
    }
  },
  async recognize(pngB64: string): Promise<OcrCandidate | null> {
    const bin = process.env.PAPERDESK_LATEXOCR || 'latexocr'
    const tmp = `${process.env.TEMP || '/tmp'}/paperdesk-formula-${Date.now()}.png`
    const { writeFileSync, unlinkSync } = await import('node:fs')
    writeFileSync(tmp, Buffer.from(pngB64, 'base64'))
    try {
      const { stdout } = await run(bin, [tmp], {
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
        // Windows：可选 OCR CLI 是控制台程序，隐藏窗口，避免识别时闪黑窗
        windowsHide: true
      })
      const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean)
      const latex = (lines[lines.length - 1] ?? '').trim()
      if (!latex) return null
      return {
        engine: 'pix2tex',
        engineVersion: 'latexocr-cli',
        latex,
        // 该引擎自报置信度不可得 → 留空，由结构置信度兜底
        confidence: null,
        validation: null
      }
    } finally {
      try {
        unlinkSync(tmp)
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 测试用：`PAPERDESK_OCR_MOCK=<latex>` 时启用（永远返回同一候选） */
const mockEngine: OcrEngine = {
  id: 'mock',
  version: 'mock-1',
  async available(): Promise<boolean> {
    return !!process.env.PAPERDESK_OCR_MOCK
  },
  async recognize(): Promise<OcrCandidate | null> {
    const latex = process.env.PAPERDESK_OCR_MOCK ?? ''
    if (!latex) return null
    return { engine: 'mock', engineVersion: 'mock-1', latex, confidence: 0.99, validation: null }
  }
}

const ENGINES: OcrEngine[] = [pix2texEngine, visionEngine, mockEngine]

export interface FormulaCandidateResult {
  candidates: OcrCandidate[]
  /** 探测到但不可用的引擎（用于明确"未尝试"而不是"失败"） */
  unavailable: string[]
  errors: Array<{ engine: string; error: string }>
}

/**
 * 跑所有**可用**引擎，返回候选（附验证结果）。**不在这里选择**——选择由 `pickCandidate` 决定。
 * 每个引擎独立 try/catch：单个失败不影响其它引擎。
 */
export async function recognizeFormulaCandidates(
  pngB64: string,
  rawText: string
): Promise<FormulaCandidateResult> {
  const candidates: OcrCandidate[] = []
  const unavailable: string[] = []
  const errors: Array<{ engine: string; error: string }> = []
  for (const e of ENGINES) {
    let ok = false
    try {
      ok = await e.available()
    } catch {
      ok = false
    }
    if (!ok) {
      unavailable.push(e.id)
      continue
    }
    try {
      const c = await e.recognize(pngB64)
      if (!c) continue
      c.validation = validateFormulaLatex(rawText, c.latex)
      c.confidence = c.confidence ?? deriveStructuralConfidence(c.validation)
      candidates.push(c)
    } catch (err) {
      errors.push({ engine: e.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { candidates, unavailable, errors }
}
