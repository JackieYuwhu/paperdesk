import { useEffect, useMemo, useRef, useState } from 'react'
import { lineDiff, type DiffRow } from '@shared/diff'
import { splitTranslatableBlocks } from '@shared/md-table'
import { Icon } from '../../components/Icon'
import type { PartialText, TranslateDiagnosis, Translation } from '@shared/types'

export type ViewMode = 'original' | 'bilingual'

interface Props {
  itemId: number | null
  attachmentId: number | null
  translation: Translation | null
  viewMode: ViewMode
  translating: boolean
  progress: string
  progressRatio?: number
  onRunTranslate: (
    lang: string,
    mode: 'fine' | 'coarse',
    engine?: string,
    force?: boolean,
    layout?: 'reflow' | 'strict',
    fontDelta?: number
  ) => void | Promise<void>
  onCancelTranslate: () => void | Promise<void>
  onSetViewMode: (mode: ViewMode) => void
  /** 部分翻译（划词/本页）：确认后才翻译 */
  partial: PartialText | null
  onClearPartial: () => void
  /** 归档到笔记后刷新笔记面板 */
  onNotesChanged: () => void
  /** 跳转（质量自检里点「疑似未译」定位到原文页） */
  onOpenTarget?: (t: { itemId: number | null; attachmentId: number | null; page: number | null }) => void
  /** 打开某个历史译文 */
  onOpenTranslation?: (
    t: { translation: Translation; itemId: number | null },
    mode: ViewMode
  ) => void
  /** 把「翻译论文」加入批处理（打开批处理面板并预选该任务） */
  onAddToBatch?: (taskId: string) => void
}

const LANGS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
  { value: 'ja', label: '日文' },
  { value: 'ko', label: '韩文' },
  { value: 'fr', label: '法文' },
  { value: 'de', label: '德文' }
]

/** 加载动画至少显示这么久，避免一闪而过 */
const MIN_LOADING_MS = 800

interface Seg {
  t: '=' | '-' | '+'
  s: string
}

/** 对比行：'~' 表示同一行被修改（左右都有，且已按词切分）；'hunk' 表示折叠的未变块 */
interface DR {
  type: '=' | '~' | '-' | '+' | 'hunk'
  left?: string
  right?: string
  leftSegs?: Seg[]
  rightSegs?: Seg[]
  text?: string
}

/** 计算配对后的差异行（含词级切分），支持忽略大小写/空白 */
function computeDiffRows(
  aText: string,
  bText: string,
  igCase: boolean,
  igSpace: boolean
): DR[] {
  const key = (s: string): string => {
    let x = s
    if (igSpace) x = x.replace(/\s+/g, ' ').trim()
    if (igCase) x = x.toLowerCase()
    return x
  }
  return pairRows(lineDiff(aText.split(/\r?\n/), bText.split(/\r?\n/), key))
}

/** 折叠大段未变内容，只保留改动附近 context 行 */
function collapseEqual(rows: DR[], context: number): DR[] {
  const out: DR[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i].type !== '=') {
      out.push(rows[i])
      i++
      continue
    }
    let j = i
    while (j < rows.length && rows[j].type === '=') j++
    const runLen = j - i
    if (runLen > context * 2 + 1) {
      for (let k = 0; k < context; k++) out.push(rows[i + k])
      out.push({ type: 'hunk', text: `…… 折叠 ${runLen - context * 2} 行未变 ……` })
      for (let k = j - context; k < j; k++) out.push(rows[k])
    } else {
      for (let k = i; k < j; k++) out.push(rows[k])
    }
    i = j
  }
  return out
}

/** 按「中文字 / 英文数字词 / 空白 / 单符号」切词 */
function tokenize(s: string): string[] {
  return s.match(/[\u4e00-\u9fff]|[A-Za-z0-9]+|\s+|[^\s]/g) ?? []
}

/** 词级差异（用于行内高亮增删） */
function wordDiff(a: string, b: string): { left: Seg[]; right: Seg[] } {
  const ta = tokenize(a)
  const tb = tokenize(b)
  const n = ta.length
  const m = tb.length
  if (n === 0 || m === 0 || n * m > 20000) {
    return {
      left: a ? [{ t: '-', s: a }] : [],
      right: b ? [{ t: '+', s: b }] : []
    }
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const left: Seg[] = []
  const right: Seg[] = []
  const push = (arr: Seg[], t: Seg['t'], s: string): void => {
    if (!s) return
    const last = arr[arr.length - 1]
    if (last && last.t === t) last.s += s
    else arr.push({ t, s })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      push(left, '=', ta[i])
      push(right, '=', tb[j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(left, '-', ta[i])
      i++
    } else {
      push(right, '+', tb[j])
      j++
    }
  }
  while (i < n) push(left, '-', ta[i++])
  while (j < m) push(right, '+', tb[j++])
  return { left, right }
}

/** 把「-/+ 连续块」配对成「同一行修改」（'~'），并做词级切分 */
function pairRows(rows: DiffRow[]): DR[] {
  const out: DR[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i].type === '=') {
      out.push({ type: '=', left: rows[i].left, right: rows[i].right })
      i++
      continue
    }
    const dels: string[] = []
    const adds: string[] = []
    while (i < rows.length && rows[i].type !== '=') {
      if (rows[i].type === '-') dels.push(rows[i].left ?? '')
      else adds.push(rows[i].right ?? '')
      i++
    }
    const max = Math.max(dels.length, adds.length)
    for (let k = 0; k < max; k++) {
      const l = dels[k]
      const r = adds[k]
      if (l != null && r != null) {
        const w = wordDiff(l, r)
        out.push({ type: '~', left: l, right: r, leftSegs: w.left, rightSegs: w.right })
      } else if (l != null) {
        out.push({ type: '-', left: l })
      } else {
        out.push({ type: '+', right: r })
      }
    }
  }
  return out
}

const skillLabel = (h: { engine: string | null; date_added: string }): string =>
  `${h.engine ?? 'simple'} · ${(h.date_added ?? '').slice(0, 16).replace('T', ' ')}`

/** PDF 文本层常把数学变体字符重复抽取（𝒪𝒪）；同类别折叠，避免把重复符号送进模型 */
const cleanDup = (t: string): string =>
  (t ?? '').replace(/([\u{1D400}-\u{1D7FF}\u2100-\u214F])\1+/gu, '$1')

/** 差异行 className（'~' 用 mod，避免特殊字符转义） */
const diffCls = (t: DR['type']): string => (t === '~' ? 'mod' : t)

/** 按页验收结果（翻译侧写进 translation.qa 的 JSON；面板直接解析，不需要新 IPC/类型） */
interface PageVerdict {
  page: number
  expected?: number
  written?: number
  ratio?: number
  ok?: boolean
  status?: string
  reason?: string
  /** 页面角色：body / references / appendix / front_matter（新版翻译才有） */
  role?: string
}

interface QaVerification {
  threshold?: number
  retryLimit?: number
  retryWorkers?: number
  pages?: PageVerdict[]
  preRetryFailedPages?: number[]
  failedPages?: number[]
  retriedPages?: number[]
  passed?: boolean
  /** 页码（1 基）→ 页面角色；用于告诉用户哪些页是正文/参考文献/附录 */
  pageRoles?: Record<string, string>
}

/** 解析 translation.qa 里的 verification；老译文没有该字段时返回 null（不展示） */
function parseVerification(qa: string | null | undefined): QaVerification | null {
  if (!qa) return null
  try {
    const v = (JSON.parse(qa) as { verification?: QaVerification } | null)?.verification
    if (!v || !Array.isArray(v.pages)) return null
    return v
  } catch {
    return null
  }
}

/** 渲染一行内的词级增删高亮 */
function Segs({ segs, side }: { segs: Seg[]; side: 'L' | 'R' }): React.JSX.Element {
  return (
    <>
      {segs.map((s, i) => {
        if (s.t === '=') return <span key={i}>{s.s}</span>
        if (s.t === '-') return side === 'L' ? <del key={i}>{s.s}</del> : null
        return side === 'R' ? <ins key={i}>{s.s}</ins> : null
      })}
    </>
  )
}

export function TranslationPanel({
  itemId,
  attachmentId,
  translation,
  viewMode,
  translating,
  progress,
  progressRatio,
  onRunTranslate,
  onCancelTranslate,
  onSetViewMode,
  partial,
  onClearPartial,
  onNotesChanged,
  onOpenTarget,
  onOpenTranslation,
  onAddToBatch
}: Props): React.JSX.Element {
  const [lang, setLang] = useState('zh')
  const [engine, setEngine] = useState('simple')
  const [mode, setMode] = useState<'fine' | 'coarse'>('fine')
  const [layout, setLayout] = useState<'reflow' | 'strict'>('reflow')
  /**
   * 译文正文字号增量（pt）：默认 +1.5，可在工具栏切换。
   * 初值取设置里的 mt.fontDelta，保证整篇 / 单页重译 / 批处理用同一份排版参数。
   */
  const [fontDelta, setFontDelta] = useState<number>(1.5)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [showLoading, setShowLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const startedAt = useRef(0)
  const [notice, setNotice] = useState('')
  const [diagnosis, setDiagnosis] = useState<TranslateDiagnosis | null>(null)


  // 部分翻译（划词/本页）：用户点「翻译」后才开始
  const [partialLang, setPartialLang] = useState('zh')
  /** 划线翻译的可编辑源文（阅读器划词会自动填入） */
  const [selText, setSelText] = useState('')
  const [translationText, setTranslationText] = useState('')
  const [translatingSel, setTranslatingSel] = useState(false)
  const [mockBackend, setMockBackend] = useState(false)
  const reqId = useRef(0)

  // 表格块：服务层不送翻译、原样返回，这里单独用等宽表格渲染（超宽横向滚动）
  const tableBlocks = useMemo(
    () => splitTranslatableBlocks(translationText).filter((b) => b.table),
    [translationText]
  )

  // 新的部分文本到来时清空上次结果（不自动翻译）
  useEffect(() => {
    setTranslationText('')
    setMockBackend(false)
    setTranslatingSel(false)
    reqId.current++
    if (partial?.text) setSelText(cleanDup(partial.text))
  }, [partial])


  const runPartial = async (textArg?: string): Promise<void> => {
    const text = cleanDup(textArg ?? selText).trim()
    if (!text) return
    const id = ++reqId.current
    setTranslatingSel(true)
    setTranslationText('')
    try {
      const r = await window.api.translate.text(text, partialLang)
      if (reqId.current !== id) return
      // 兜底：去掉模型可能加的编号前缀（[0] / 1.）
      setTranslationText(r.text.replace(/^\s*\[\s*\d+\s*\]\s*/, ''))
      setMockBackend(r.backend === 'mock')
    } catch (e) {
      if (reqId.current === id) {
        setTranslationText('翻译失败：' + (e instanceof Error ? e.message : String(e)))
      }
    } finally {
      if (reqId.current === id) setTranslatingSel(false)
    }
  }

  // 划词「翻译选中」：面板打开即自动翻译一次，用户不需要再点「翻译」
  useEffect(() => {
    if (!partial?.auto || !partial.text) return
    void runPartial(partial.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partial])

  useEffect(() => {
    void window.api.system
      .health()
      .then((h) => setConfigured(h.provider.configured))
      .catch(() => setConfigured(null))
    void window.api.settings
      .get()
      .then((s) => {
        setEngine(s.mt.engine || 'simple')
        // 字号设置对整篇 / 单页重译 / 批处理生效，打开面板时读回当前值
        const fd = Number((s.mt as { fontDelta?: string }).fontDelta ?? '1.5')
        if (Number.isFinite(fd)) setFontDelta(Math.max(0, Math.min(4, fd)))
      })
      .catch(() => undefined)
  }, [])

  // 全文翻译的加载动画（含最短显示时长）
  useEffect(() => {
    if (translating) {
      startedAt.current = Date.now()
      setElapsed(0)
      setShowLoading(true)
      return
    }
    if (!showLoading) return
    const remain = Math.max(0, MIN_LOADING_MS - (Date.now() - startedAt.current))
    const t = window.setTimeout(() => setShowLoading(false), remain)
    return () => window.clearTimeout(t)
  }, [translating]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!showLoading) return
    const id = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAt.current) / 1000))
    }, 500)
    return () => window.clearInterval(id)
  }, [showLoading])

  const diagnose = async (): Promise<void> => {
    if (attachmentId == null) return
    setNotice('体检中…')
    try {
      setDiagnosis(await window.api.translate.diagnose(attachmentId))
      setNotice('')
    } catch (e) {
      setNotice('诊断失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  // 翻译失败时自动体检（定位原因）
  useEffect(() => {
    if (progress.startsWith('翻译失败') && attachmentId != null) {
      void window.api.translate
        .diagnose(attachmentId)
        .then(setDiagnosis)
        .catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress])


  const pct = progressRatio != null ? Math.round(Math.min(1, Math.max(0, progressRatio)) * 100) : null

  // 翻译完成后的按页验收结论（translation.qa 内嵌，翻译侧已自动重译未通过的页）
  const verification = useMemo(() => parseVerification(translation?.qa), [translation?.qa])
  const roleSummary = useMemo(() => {
    const roles = verification?.pageRoles
    if (!roles) return ''
    const labels: Record<string, string> = {
      body: '正文',
      references: '参考文献',
      appendix: '附录',
      front_matter: '前置页'
    }
    const counts: Record<string, number> = {}
    for (const role of Object.values(roles)) {
      if (labels[role]) counts[role] = (counts[role] ?? 0) + 1
    }
    return Object.entries(labels)
      .filter(([role]) => counts[role])
      .map(([role, label]) => `${label} ${counts[role]} 页`)
      .join(' · ')
  }, [verification])
  const failedPages = verification?.failedPages ?? []
  const retriedPages = verification?.retriedPages ?? []
  const preFailedPages = verification?.preRetryFailedPages ?? []
  const skippedPages =
    verification?.pages?.filter((p) => p.status === 'skipped').length ?? 0


  return (
    <div className="panel">
      {/* 部分翻译：划词 / 本页，确认后才翻译 */}
      {/* 划线翻译（Zotero 式）：源文 + 译文，使用全局模型配置（无需单独填 Key） */}
      <div className="meta__section tr-sel" data-testid="lookup">
        <div className="meta__label">划线翻译</div>
        <div className="meta__muted" style={{ marginBottom: 6 }}>
          粘贴/输入文本，或在正文里选中文字后点「翻译选中」；使用全局模型配置，无需单独填 Key。
        </div>
        <div className="tr-sel__bar">
          <span className="meta__muted">译为</span>
          <select
            value={partialLang}
            data-testid="lookup-lang"
            onChange={(e) => setPartialLang(e.target.value)}
          >
            {LANGS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="toolbar__spacer" />
          <button
            className="ghost"
            data-testid="sel-clear"
            onClick={() => {
              setSelText('')
              setTranslationText('')
              onClearPartial?.()
            }}
          >
            <Icon name="close" size={13} />
            清空
          </button>
        </div>
        <textarea
          className="tr-sel__src"
          data-testid="lookup-src"
          placeholder="要翻译的文本…"
          value={selText}
          onChange={(e) => setSelText(e.target.value)}
        />
        <div className="tr-sel__actions">
          <button
            className="primary"
            data-testid="lookup-run"
            disabled={translatingSel || !selText.trim()}
            onClick={() => void runPartial()}
          >
            <Icon name="translate" size={13} />
            {translatingSel ? '翻译中…' : translationText ? '重新翻译' : '翻译'}
          </button>
          {translationText && (
            <button
              className="ghost"
              data-testid="sel-copy"
              onClick={() => void navigator.clipboard.writeText(translationText)}
            >
              <Icon name="check" size={13} />
              复制
            </button>
          )}
        </div>
        {!translatingSel && mockBackend && translationText && (
          <div className="meta__muted">离线占位翻译：设置模型服务后即为真实翻译</div>
        )}
        <textarea
          className="tr-sel__dst"
          data-testid="lookup-dst"
          readOnly
          placeholder="译文"
          value={translationText}
        />
        {tableBlocks.length > 0 && (
          <div className="tr-sel__tables" data-testid="lookup-tables">
            <div className="meta__muted">表格块按原文保留，未翻译（行列与数字不变）</div>
            {tableBlocks.map((b, i) => (
              <pre className="tr-table" data-testid="lookup-table" key={`tbl-${i}`}>
                {b.text}
              </pre>
            ))}
          </div>
        )}
      </div>

      {attachmentId == null ? (
        <div className="empty">
          <Icon name="translate" size={26} />
          <span>先选择一篇论文</span>
        </div>
      ) : (
        <>
          <div className="panel__bar">
            <select
              value={engine}
              data-testid="translate-engine"
              onChange={(e) => setEngine(e.target.value)}
              style={{ flex: 'none' }}
              title="翻译引擎"
            >
              <option value="simple">内置（保版式）</option>
              <option value="vision">视觉识别（扫描件）</option>
              <option value="pdf2zh">pdf2zh</option>
            </select>
            <select
              value={lang}
              data-testid="translate-lang"
              onChange={(e) => setLang(e.target.value)}
              style={{ flex: 'none' }}
            >
              {LANGS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <select
              value={mode}
              data-testid="translate-mode"
              onChange={(e) => setMode(e.target.value as 'fine' | 'coarse')}
              style={{ flex: 'none' }}
              title="精译：逐段重排、还原底色；粗译：优先速度，适合快速通读"
            >
              <option value="fine">精译</option>
              <option value="coarse">粗译</option>
            </select>
            <select
              value={layout}
              data-testid="translate-layout"
              onChange={(e) => setLayout(e.target.value as 'reflow' | 'strict')}
              style={{ flex: 'none' }}
              title="可读重排：允许页内推挤/回收空白；严格保版式：段顶固定、不跨栏（放不下保留原文+溢出）"
            >
              <option value="reflow">可读重排</option>
              <option value="strict">严格保版式</option>
            </select>
            <select
              value={String(fontDelta)}
              data-testid="translate-font-delta"
              onChange={(e) => {
                const v = Number(e.target.value)
                setFontDelta(v)
                // 字号是译文产物的一部分：记住选择，整篇/单页/批处理都从这里取
                void window.api.settings.save({ mt: { fontDelta: String(v) } }).catch(() => {})
              }}
              style={{ flex: 'none' }}
              title="译文正文字号：比原文放大 0–2pt（已生成的旧译文需要重新翻译才会应用）"
            >
              <option value="0">字号 +0</option>
              <option value="1">字号 +1</option>
              <option value="1.5">字号 +1.5</option>
              <option value="2">字号 +2</option>
            </select>
            <button
              className="primary"
              disabled={translating}
              onClick={() => void onRunTranslate(lang, mode, engine, false, layout, fontDelta)}
              data-testid="translate-run"
              style={{ flex: 1, whiteSpace: 'nowrap' }}
            >
              <Icon name="translate" size={14} />
              {translating ? '翻译中…' : translation ? '复用' : '开始翻译'}
            </button>
            {translation && (
              <button
                className="ghost"
                disabled={translating}
                title="忽略已有译文，重新调用模型翻译"
                data-testid="translate-retranslate"
                onClick={() => void onRunTranslate(lang, mode, engine, true, layout, fontDelta)}
              >
                <Icon name="refresh" size={14} />
                重新翻译
              </button>
            )}
            {/*
              字号改了但译文还没重生成时，必须明确提示——否则用户以为新字号没生效。
              旧产物的 engine 后缀（:f1.5）与当前选择不一致即视为旧译文。
            */}
            {translation && !translating && !(translation.engine ?? '').includes(`:f${fontDelta}`) && (
              <span className="translate__stale" data-testid="translate-stale-hint">
                当前译文按旧字号生成，点「重新翻译」应用 +{fontDelta}pt
              </span>
            )}
            {onAddToBatch && (
              <button
                className="ghost"
                disabled={attachmentId == null}
                title="把「翻译论文」加入批处理（到批处理面板确认执行）"
                data-testid="translate-add-batch"
                onClick={() => onAddToBatch('translate')}
              >
                <Icon name="layers" size={14} />
                加入批处理
              </button>
            )}
          </div>

          {engine === 'vision' && (
            <div className="panel__status">
              视觉识别：用模型逐页读图翻译，适合扫描件（需配置支持视觉的模型；不支持保版式 PDF）。
            </div>
          )}

          <div className="panel__bar">
            <button
              className="ghost"
              disabled={attachmentId == null}
              data-testid="translate-diagnose"
              title="体检：为什么翻译不出来"
              onClick={() => void diagnose()}
            >
              <Icon name="info" size={14} />
              翻译自检
            </button>
          </div>
          {diagnosis && (
            <div className="lookup" data-testid="translate-diagnosis">
              <div className="lookup__head">
                <span className="sidebar__title">翻译自检</span>
                <button className="icon ghost" onClick={() => setDiagnosis(null)}>
                  <Icon name="close" size={13} />
                </button>
              </div>
              <ul className="diag__list">
                {diagnosis.notes.map((n, i) => (
                  <li
                    key={i}
                    className={
                      /未配置|扫描件|不支持|responses|messages|回退/.test(n) ? 'diag__bad' : 'diag__ok'
                    }
                  >
                    {n}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {showLoading && (
            <div className="translate-loading" data-testid="translate-loading">
              <span className="spinner" />
              <div className="translate-loading__text">{progress || '正在翻译并重排版面…'}</div>
              <div className="translate-loading__bar">
                <i
                  data-testid="translate-progress"
                  style={
                    pct != null
                      ? { left: 0, width: `${pct}%`, animation: 'none' }
                      : undefined
                  }
                />
              </div>
              <div className="translate-loading__meta">
                已用 {elapsed}s{pct != null ? ` · ${pct}%` : ''}
                {translating && (
                  <button
                    className="ghost"
                    style={{ marginLeft: 8, padding: '1px 8px', fontSize: 11 }}
                    onClick={() => void onCancelTranslate()}
                    data-testid="translate-cancel"
                  >
                    取消
                  </button>
                )}
              </div>
            </div>
          )}

          {!showLoading && progress && <div className="panel__status">{progress}</div>}

          {configured === false && (
            <div className="meta__section">
              <div className="lookup__tip" style={{ margin: 0 }}>
                当前未配置模型服务：翻译结果会是「原文 + 语言标记」的离线占位。
                到 ⚙ 设置 →「模型服务」填好 Base URL 与 API Key 后，即为真实翻译。
              </div>
            </div>
          )}

          <div className="meta__section">
            <div className="meta__label">结果</div>
            {translation ? (
              <>
                <div className="meta__muted">
                  语言 {translation.lang} · 引擎 {translation.engine ?? 'simple'} · 后端{' '}
                  {translation.backend ?? '—'}
                </div>
                {verification && (
                  <div
                    data-testid="translate-verification"
                    style={{ marginTop: 6 }}
                  >
                    {!failedPages.length ? (
                      <div className="meta__muted diag__ok">
                        {!verification.pages?.length
                          ? '验收：未检出可验收的正文块（可能是扫描件或纯图表页）'
                          : '验收：通过'}
                        {preFailedPages.length > 0
                          ? `（${preFailedPages.length} 页未通过，已重译 ${retriedPages.length} 页）`
                          : ''}
                        {skippedPages > 0 ? ` · ${skippedPages} 页图形过多按整页保留` : ''}
                      </div>
                    ) : (
                      <>
                        <div className="meta__muted diag__bad">
                          验收：{failedPages.length} 页未通过
                          {retriedPages.length > 0 ? `（已重译 ${retriedPages.length} 页）` : ''}
                        </div>
                        <div className="lookup__tip" style={{ marginTop: 2 }}>
                          第 {failedPages.join('、')} 页正文未正常翻译，已保留原文，请对照原文核对。
                        </div>
                      </>
                    )}
                    {roleSummary && (
                      <div
                        className="meta__muted"
                        data-testid="translate-page-roles"
                        title="页面角色由翻译侧按标题结构识别；参考文献不强制翻译，附录会正常翻译"
                      >
                        页面结构：{roleSummary}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="meta__muted">
                还没有译文。选好语言和格式后点「开始翻译」——译文会在原版面上回填，公式与图片位置不变。
              </div>
            )}
            {notice && <div className="meta__muted" style={{ marginTop: 8 }}>{notice}</div>}
          </div>

        </>
      )}
    </div>
  )
}
