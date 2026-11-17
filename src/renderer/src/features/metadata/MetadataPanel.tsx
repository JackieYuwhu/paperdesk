import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import type { MetadataView, StructureResult } from '@shared/types'

interface Props {
  itemId: number | null
  attachmentId: number | null
}

const LATEX_SYMBOLS: Record<string, string> = {
  '\\sum': '∑',
  '\\prod': '∏',
  '\\int': '∫',
  '\\oint': '∮',
  '\\sqrt': '√',
  '\\pm': '±',
  '\\mp': '∓',
  '\\times': '×',
  '\\cdot': '·',
  '\\leq': '≤',
  '\\le': '≤',
  '\\geq': '≥',
  '\\ge': '≥',
  '\\neq': '≠',
  '\\ne': '≠',
  '\\approx': '≈',
  '\\infty': '∞',
  '\\partial': '∂',
  '\\nabla': '∇',
  '\\rightarrow': '→',
  '\\to': '→',
  '\\leftarrow': '←',
  '\\in': '∈',
  '\\forall': '∀',
  '\\exists': '∃',
  '\\alpha': 'α',
  '\\beta': 'β',
  '\\gamma': 'γ',
  '\\delta': 'δ',
  '\\epsilon': 'ε',
  '\\theta': 'θ',
  '\\lambda': 'λ',
  '\\mu': 'μ',
  '\\nu': 'ν',
  '\\pi': 'π',
  '\\rho': 'ρ',
  '\\sigma': 'σ',
  '\\tau': 'τ',
  '\\phi': 'φ',
  '\\psi': 'ψ',
  '\\omega': 'ω',
  '\\Delta': 'Δ',
  '\\Theta': 'Θ',
  '\\Lambda': 'Λ',
  '\\Sigma': 'Σ',
  '\\Omega': 'Ω'
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 轻量「公式渲染」：把 LaTeX 记号与上下标转成 HTML（无需外部 KaTeX）。 */
function renderFormula(raw: string): string {
  let s = escapeHtml(raw)
  s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
  for (const [k, v] of Object.entries(LATEX_SYMBOLS)) s = s.split(k).join(v)
  s = s.replace(/\\[a-zA-Z]+/g, '') // 去掉剩余未知命令
  s = s.replace(/[{}]/g, '')
  s = s.replace(/_(\w+|\d)/g, '<sub>$1</sub>')
  s = s.replace(/\^(\w+|\d)/g, '<sup>$1</sup>')
  return s
}

export function MetadataPanel({ itemId, attachmentId }: Props): React.JSX.Element {
  const [meta, setMeta] = useState<MetadataView | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [structure, setStructure] = useState<StructureResult | null>(null)
  const [structBusy, setStructBusy] = useState(false)
  const [structStatus, setStructStatus] = useState('')
  const [structOpen, setStructOpen] = useState(true)
  const [formulaSize, setFormulaSize] = useState(14)
  const [translatedTh, setTranslatedTh] = useState<Record<number, string>>({})
  const [thBusy, setThBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (itemId == null) {
      setMeta(null)
      return
    }
    setMeta(await window.api.metadata.get(itemId))
  }, [itemId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setStructure(null)
    setStructStatus('')
    setTranslatedTh({})
  }, [itemId, attachmentId])

  const extract = async (forceVision = false): Promise<void> => {
    if (attachmentId == null) return
    setBusy(true)
    setStatus(
      forceVision ? '视觉识别中…（用模型读首页图片）' : '识别中…（首次会启动本地解析服务）'
    )
    try {
      const s = await window.api.metadata.extract(attachmentId, { forceVision })
      await load()
      const warn = s.warnings.length ? ` ⚠ ${s.warnings.join('；')}` : ''
      setStatus(`作者 ${s.authorCount} · 参考文献 ${s.referenceCount} · 已解析 DOI ${s.resolvedCount}${warn}`)
    } catch (e) {
      setStatus('失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const extractStructure = async (): Promise<void> => {
    if (attachmentId == null) return
    setStructBusy(true)
    setStructStatus('提取中…（本地解析）')
    try {
      const r = await window.api.metadata.structure(attachmentId)
      setStructure(r)
      const warn = r.warnings.length ? ` ⚠ ${r.warnings.join('；')}` : ''
      setStructStatus(`公式 ${r.counts.equations} · 定理/定义 ${r.counts.theorems}${warn}`)
    } catch (e) {
      setStructStatus('失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setStructBusy(false)
    }
  }

  const translateTh = useCallback(async (i: number, text: string): Promise<void> => {
    const r = await window.api.translate.text(text, 'zh')
    setTranslatedTh((prev) => ({ ...prev, [i]: r.text }))
  }, [])

  const translateAllTh = async (): Promise<void> => {
    if (!structure) return
    setThBusy(true)
    const items = structure.theorems
    const CONC = 3
    for (let k = 0; k < items.length; k += CONC) {
      await Promise.all(
        items
          .slice(k, k + CONC)
          .map((t, off) => translateTh(k + off, t.statement).catch(() => undefined))
      )
    }
    setThBusy(false)
  }

  if (itemId == null) {
    return (
      <div className="panel">
        <div className="empty">
          <Icon name="info" size={26} />
          <span>先选择一篇论文</span>
        </div>
      </div>
    )
  }

  const item = meta?.item ?? null
  const authors = meta?.authors ?? []
  const refs = meta?.references ?? []

  return (
    <div className="panel">
      <div className="panel__bar">
        <button
          className="primary"
          disabled={busy || attachmentId == null}
          onClick={() => void extract()}
        >
          <Icon name="refresh" size={14} />
          {busy ? '识别中…' : '识别元数据'}
        </button>
        <button
          disabled={busy || attachmentId == null}
          onClick={() => void extract(true)}
          data-testid="meta-extract-vision"
          title="用多模态模型读首页图片识别（适合扫描件/无文本层）"
        >
          <Icon name="sparkles" size={14} />
          视觉识别
        </button>
        <button
          disabled={structBusy || attachmentId == null}
          onClick={() => void extractStructure()}
          data-testid="meta-structure"
          title="快速提取文中的公式与定理/定义"
        >
          <Icon name="sparkles" size={14} />
          {structBusy ? '提取中…' : '公式/定理'}
        </button>
      </div>
      {status && <div className="panel__status">{status}</div>}
      {structStatus && (
        <div className="panel__status" data-testid="meta-structure-status">
          {structStatus}
        </div>
      )}

      <div className="meta__section">
        <div className="meta__label">标题</div>
        <div className="meta__title">{item?.title ?? '（未知）'}</div>
        <div className="meta__meta">
          {item?.year ?? '—'} · {item?.venue ?? '—'} · {item?.doi ?? '无 DOI'}
        </div>
      </div>

      <div className="meta__section">
        <div className="meta__label">作者（{authors.length}）</div>
        <div className="meta__authors" data-testid="meta-authors">
          {authors.length === 0 ? (
            <span className="meta__muted">未识别</span>
          ) : (
            authors.map((a) => (
              <span className="chip" key={a.id}>
                {a.name}
              </span>
            ))
          )}
        </div>
      </div>

      <div className="meta__section meta__section--grow">
        <div className="meta__label">参考文献（{refs.length}）</div>
        <ol className="meta__refs" data-testid="meta-refs">
          {refs.length === 0 ? (
            <li className="meta__muted">未识别</li>
          ) : (
            refs.map((r) => (
              <li key={r.id} className="meta__ref">
                <span className="meta__ref-text">{r.raw ?? r.title ?? '(空)'}</span>
                {r.doi ? (
                  <a
                    className="meta__doi"
                    href={`https://doi.org/${r.doi}`}
                    onClick={(e) => {
                      e.preventDefault()
                      void window.api.app.openExternal(`https://doi.org/${r.doi}`)
                    }}
                  >
                    {r.doi}
                  </a>
                ) : (
                  <span className="meta__muted">未解析</span>
                )}
              </li>
            ))
          )}
        </ol>
      </div>

      {(structure || structBusy) && (
        <div className="meta__section" data-testid="meta-structure-result">
          <div className="meta__label meta__label--row">
            <button
              className="icon ghost struct__caret"
              title={structOpen ? '收起' : '展开'}
              onClick={() => setStructOpen((v) => !v)}
            >
              <Icon
                name="right"
                size={13}
                style={{ transform: structOpen ? 'rotate(90deg)' : 'none' }}
              />
            </button>
            公式与定理
            {structure && (
              <span className="struct__counts">
                公式 {structure.counts.equations} · 定理 {structure.counts.theorems}
              </span>
            )}
            <span className="toolbar__spacer" />
            <button
              className="ghost"
              disabled={thBusy || !structure || structure.theorems.length === 0}
              onClick={() => void translateAllTh()}
              data-testid="meta-translate-theorems"
              title="把所有定理/定义翻译成中文"
            >
              <Icon name="translate" size={13} />
              {thBusy ? '翻译中…' : '翻译定理'}
            </button>
          </div>

          {structOpen && (
            <>
              <div className="struct__sizebar">
                <span className="meta__muted">公式字号</span>
                <input
                  type="range"
                  min={11}
                  max={26}
                  value={formulaSize}
                  data-testid="formula-size"
                  onChange={(e) => setFormulaSize(Number(e.target.value))}
                />
                <span className="meta__muted">{formulaSize}px</span>
              </div>

              <div className="meta__label">公式（{structure?.counts.equations ?? 0}）</div>
              {structure && structure.equations.length > 0 ? (
                <ol className="struct__list" data-testid="meta-equations">
                  {structure.equations.map((eq, i) => (
                    <li key={`eq-${i}`} className="struct__eq">
                      <span className="struct__page">p.{eq.page}</span>
                      <span
                        className="struct__math"
                        style={{ fontSize: formulaSize }}
                        dangerouslySetInnerHTML={{ __html: renderFormula(eq.text) }}
                      />
                      {eq.number && <span className="struct__num">({eq.number})</span>}
                      <button
                        className="icon ghost"
                        title="复制原文"
                        onClick={() => void navigator.clipboard.writeText(eq.text)}
                      >
                        <Icon name="check" size={13} />
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="meta__muted">未识别到公式</div>
              )}

              <div className="meta__label" style={{ marginTop: 10 }}>
                定理 / 定义（{structure?.counts.theorems ?? 0}）
              </div>
              {structure && structure.theorems.length > 0 ? (
                <ol className="struct__list" data-testid="meta-theorems">
                  {structure.theorems.map((t, i) => (
                    <li key={`th-${i}`} className="struct__item struct__item--block">
                      <div className="struct__head">
                        <span className="struct__badge">
                          {t.kind}
                          {t.number ? ` ${t.number}` : ''}
                        </span>
                        <span className="struct__page">p.{t.page}</span>
                        <span className="toolbar__spacer" />
                        <button
                          className="icon ghost"
                          title="翻译成中文"
                          onClick={() => void translateTh(i, t.statement)}
                        >
                          <Icon name="translate" size={13} />
                        </button>
                        <button
                          className="icon ghost"
                          title="复制"
                          onClick={() =>
                            void navigator.clipboard.writeText(
                              `${t.kind}${t.number ? ' ' + t.number : ''}. ${t.statement}`
                            )
                          }
                        >
                          <Icon name="check" size={13} />
                        </button>
                      </div>
                      <div className="struct__stmt">{t.statement}</div>
                      {translatedTh[i] && (
                        <div className="struct__trans">
                          <span className="struct__trans-badge">中</span>
                          {translatedTh[i]}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="meta__muted">未识别到定理/定义</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
