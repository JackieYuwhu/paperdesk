import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Item } from '@shared/types'
import type { SurveyRecommendation, SurveyResult } from '@shared/survey'
import { Icon } from '../../components/Icon'

interface Props {
  itemId: number | null
  items: Item[]
  onLibraryChanged: () => void
}

const PROVIDER_LABEL: Record<string, string> = {
  auto: '自动（Scholar + OpenAlex）',
  google: 'Google Scholar',
  openalex: 'OpenAlex'
}

const SOURCE_LABEL: Record<string, string> = {
  google: 'Google Scholar',
  openalex: 'OpenAlex',
  semantic: 'Semantic Scholar',
  mixed: 'Google Scholar + OpenAlex'
}

/**
 * 领域调研：选几篇种子论文 → Google Scholar/OpenAlex 找相关论文 →
 * 20–30 路并发快速拆解（标题+摘要级）→ 3–6 个视角并行打分 → 推荐阅读清单。
 *
 * 这里只做「快速调研」，不下载全文；需要精读时再逐篇导入并走「拆解论文」。
 */
export function SurveyPanel({ itemId, items, onLibraryChanged }: Props): React.JSX.Element {
  const [seedIds, setSeedIds] = useState<number[]>(() => (itemId ? [itemId] : []))
  const [query, setQuery] = useState('')
  const [focus, setFocus] = useState('')
  const [limit, setLimit] = useState(24)
  const [provider, setProvider] = useState<'auto' | 'google' | 'openalex' | 'semantic'>('auto')
  const [sort, setSort] = useState<'recent' | 'cited' | 'relevance'>('recent')
  const [analysisWorkers, setAnalysisWorkers] = useState(24)
  const [routerWorkers, setRouterWorkers] = useState(4)
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<SurveyResult | null>(null)
  const [error, setError] = useState('')
  const [added, setAdded] = useState<Set<string>>(() => new Set())
  const startedRef = useRef(0)

  // 当前论文变化时，如果还没有选种子，自动带上（不覆盖用户已选）
  useEffect(() => {
    if (!itemId) return
    setSeedIds((prev) => (prev.length === 0 ? [itemId] : prev))
  }, [itemId])

  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - startedRef.current) / 1000)), 500)
    return () => window.clearInterval(t)
  }, [busy])

  const seedTitle = useMemo(() => {
    const first = items.find((it) => seedIds.includes(it.id))
    return first?.title ?? ''
  }, [items, seedIds])

  const toggleSeed = (id: number): void => {
    setSeedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const run = useCallback(async (): Promise<void> => {
    if (busy) return
    if (seedIds.length === 0 && !query.trim()) {
      setError('请选择至少一篇种子论文，或填写检索词')
      return
    }
    setBusy(true)
    setError('')
    setResult(null)
    setAdded(new Set())
    startedRef.current = Date.now()
    setElapsed(0)
    try {
      const r = await window.api.survey.run({
        seedItemIds: seedIds,
        query: query.trim() || undefined,
        focus: focus.trim() || undefined,
        limit,
        provider,
        sort,
        analysisWorkers,
        routerWorkers
      })
      setResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [busy, seedIds, query, focus, limit, provider, analysisWorkers, routerWorkers])

  const addToLibrary = async (rec: SurveyRecommendation): Promise<void> => {
    const c = rec.candidate
    const key = c.doi || c.title
    try {
      await window.api.library.addMetadata({
        title: c.title,
        doi: c.doi,
        year: c.year,
        venue: c.venue
      })
      setAdded((prev) => new Set(prev).add(key))
      onLibraryChanged()
    } catch (e) {
      setError(`加入文库失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <section className="survey-panel" data-testid="survey-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, minHeight: 0, overflow: 'auto' }}>
      <div className="meta__muted" style={{ lineHeight: 1.5 }}>
        选几篇种子论文（或直接填检索词），用 Google Scholar/OpenAlex 找同领域论文；
        并发做「标题+摘要级」快速拆解，再由多个视角并行给出推荐理由。
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <button
          className="ghost"
          disabled={!itemId}
          title="把当前阅读的论文加入种子"
          onClick={() => itemId && setSeedIds((prev) => (prev.includes(itemId) ? prev : [...prev, itemId]))}
        >
          <Icon name="book" size={13} />
          用当前论文
        </button>
        <span className="meta__muted">已选 {seedIds.length} 篇种子</span>
        {seedTitle && <span className="meta__muted">· {seedTitle.slice(0, 28)}</span>}
        <span className="toolbar__spacer" />
        <button className="ghost" disabled={busy || seedIds.length === 0} onClick={() => setSeedIds([])}>
          清空种子
        </button>
      </div>

      <div style={{ maxHeight: 132, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 4 }}>
        {items.length === 0 ? (
          <div className="meta__muted">文库还没有条目。</div>
        ) : (
          items.slice(0, 200).map((it) => (
            <label
              key={it.id}
              style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 4px', cursor: 'pointer' }}
              title={it.title ?? ''}
            >
              <input
                type="checkbox"
                checked={seedIds.includes(it.id)}
                onChange={() => toggleSeed(it.id)}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.title ?? `#${it.id}`}
              </span>
            </label>
          ))
        )}
      </div>

      <input
        className="input"
        placeholder="检索词（留空=用第一篇种子标题；可加领域关键词）"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid="survey-query"
      />
      <input
        className="input"
        placeholder="你的研究方向 / 关注点（可选，影响拆解与推荐）"
        value={focus}
        onChange={(e) => setFocus(e.target.value)}
        data-testid="survey-focus"
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <label className="meta__muted">
          来源{' '}
          <select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
            <option value="auto">自动（Scholar + OpenAlex）</option>
            <option value="google">Google Scholar</option>
            <option value="openalex">OpenAlex</option>
            <option value="semantic">Semantic Scholar</option>
          </select>
        </label>
        <label className="meta__muted">
          候选{' '}
          <input
            className="works__num"
            type="number"
            min={4}
            max={40}
            value={limit}
            onChange={(e) => setLimit(Math.max(4, Math.min(40, Number(e.target.value) || 24)))}
          />
        </label>
        <label className="meta__muted">
          排序{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="recent">最新优先</option>
            <option value="cited">高被引</option>
            <option value="relevance">相关度</option>
          </select>
        </label>
        <label className="meta__muted">
          拆解并发{' '}
          <input
            className="works__num"
            type="number"
            min={1}
            max={32}
            value={analysisWorkers}
            onChange={(e) => setAnalysisWorkers(Math.max(1, Math.min(32, Number(e.target.value) || 24)))}
          />
        </label>
        <label className="meta__muted">
          路由视角{' '}
          <input
            className="works__num"
            type="number"
            min={3}
            max={6}
            value={routerWorkers}
            onChange={(e) => setRouterWorkers(Math.max(3, Math.min(6, Number(e.target.value) || 4)))}
          />
        </label>
        <button className="primary" disabled={busy} onClick={() => void run()} data-testid="survey-run">
          <Icon name="search" size={14} />
          {busy ? `调研中… ${elapsed}s` : '开始调研'}
        </button>
      </div>

      {/* 没有 SerpAPI/Google 网络时的备用学术入口：只打开浏览器，不在本地抓取 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="meta__muted">备用入口</span>
        <button
          className="ghost"
          title="Internet Archive Scholar（无需 Key，可代替 Google Scholar 检索）"
          onClick={() => {
            const q = (query || seedTitle).trim()
            if (q) void window.api.app.openExternal(`https://scholar.archive.org/search?q=${encodeURIComponent(q)}`)
          }}
        >
          Archive Scholar ↗
        </button>
        <button
          className="ghost"
          title="Semantic Scholar 网页检索"
          onClick={() => {
            const q = (query || seedTitle).trim()
            if (q) void window.api.app.openExternal(`https://www.semanticscholar.org/search?q=${encodeURIComponent(q)}`)
          }}
        >
          Semantic Scholar ↗
        </button>
        <button
          className="ghost"
          title="OpenAlex 网页检索"
          onClick={() => {
            const q = (query || seedTitle).trim()
            if (q) void window.api.app.openExternal(`https://openalex.org/works?search=${encodeURIComponent(q)}`)
          }}
        >
          OpenAlex ↗
        </button>
      </div>

      {busy && (
        <div className="meta__muted" data-testid="survey-progress">
          检索 → 补摘要 → 并发拆解 → 多视角路由；候选多时约 20–60s（取决于模型延迟）。
        </div>
      )}
      {error && <div className="meta__muted" data-testid="survey-error">失败：{error}</div>}

      {result && (
        <div data-testid="survey-result" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="meta__muted">
            来源 {SOURCE_LABEL[result.source] ?? result.source} · 候选 {result.candidates.length} 篇 ·
            成功拆解 {result.analyzed} 篇{result.failed ? ` · 失败 ${result.failed}` : ''} ·
            并发 {result.workers.analysis}/{result.workers.router} · 用时{' '}
            {(result.timing.totalMs / 1000).toFixed(1)}s
          </div>
          <div className="meta__muted">
            检索 {result.timing.discoverMs}ms · 补摘要 {result.timing.enrichMs}ms · 拆解{' '}
            {result.timing.analyzeMs}ms · 路由 {result.timing.routeMs}ms
          </div>
          {result.warnings.length > 0 && (
            <details>
              <summary className="meta__muted">告警 {result.warnings.length} 条</summary>
              <ul className="meta__muted" style={{ margin: '4px 0 0 16px' }}>
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}

          <ol className="works__list" data-testid="survey-recommendations">
            {result.recommendations.map((rec, i) => {
              const c = rec.candidate
              const key = c.doi || c.title
              return (
                <li key={`${c.index}-${i}`} className="works__item">
                  <div className="works__main">
                    <span className="works__title">
                      {i + 1}. {c.title}
                    </span>
                    <span className="works__meta">
                      {c.authors.length ? `${c.authors.slice(0, 3).join(', ')}${c.authors.length > 3 ? ' 等' : ''} · ` : ''}
                      {c.year ?? '—'} · {c.venue ?? '—'} · 被引 {c.citedBy}
                    </span>
                    <span className="meta__muted" style={{ whiteSpace: 'pre-wrap' }}>
                      推荐理由：{rec.reason}
                    </span>
                    <span className="works__meta">
                      综合分 {rec.score} · 视角 {rec.lenses.join(' / ')}
                    </span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                      <button
                        className="ghost"
                        disabled={added.has(key)}
                        onClick={() => void addToLibrary(rec)}
                      >
                        <Icon name="plus" size={12} />
                        {added.has(key) ? '已加入' : '加入文库'}
                      </button>
                      <button className="ghost" onClick={() => void window.api.works.openScholar(c.doi || c.title)}>
                        <Icon name="search" size={12} />
                        Scholar ↗
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
          {result.recommendations.length === 0 && (
            <div className="meta__muted">没有找到可推荐的候选；可换检索词或增加候选数量。</div>
          )}
        </div>
      )}
    </section>
  )
}
