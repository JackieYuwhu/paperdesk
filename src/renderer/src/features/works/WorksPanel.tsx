import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import type { WorkHit } from '@shared/types'

interface Props {
  /** 当前论文（用于「加入文库」时归入其空间；可为空） */
  itemId: number | null
  onLibraryChanged: () => void
  /** 设为相关论文图谱的种子：切到该条目并打开「相关论文」面板 */
  onOpenTarget: (t: { itemId: number | null; attachmentId: number | null; page: number | null }) => void
  onOpenPanel: (id: string) => void
  /** 按引用展开：切到该条目、打开相关论文并仅看施引文献 */
  onExpandCitations: (itemId: number, filter: 'citation') => void
  /** 划词「文件检索」传入的检索词：非空时自动填入并检索 */
  pendingQuery?: string | null
  onConsumePendingQuery?: () => void
}

const PER_PAGE = 25

/** 生成一条 BibTeX（@article） */
function bibEntry(h: WorkHit): string {
  const surname = (h.authors[0] ?? 'anon').split(/\s+/).slice(-1)[0]
  const key = `${surname}${h.year ?? ''}${(h.id || '').slice(-4)}`.replace(/[^A-Za-z0-9]/g, '') || 'ref'
  const fields = [
    h.title ? `  title = {${h.title}}` : '',
    h.authors.length ? `  author = {${h.authors.join(' and ')}}` : '',
    h.year ? `  year = {${h.year}}` : '',
    h.venue ? `  journal = {${h.venue}}` : '',
    h.doi ? `  doi = {${h.doi}}` : '',
    h.oaUrl ? `  url = {${h.oaUrl}}` : ''
  ]
    .filter(Boolean)
    .join(',\n')
  return `@article{${key},\n${fields}\n}`
}

/** 研究 → 文献检索：关键词检索（OpenAlex 为主，Crossref 兜底）+ 一键下载/入库 */
export function WorksPanel({
  itemId,
  onLibraryChanged,
  onOpenTarget,
  onOpenPanel,
  onExpandCitations,
  pendingQuery,
  onConsumePendingQuery
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'keyword' | 'author' | 'doi'>('keyword')
  // 检索来源：auto=OpenAlex+Crossref；google=Google Scholar（需 SerpAPI Key）
  const [provider, setProvider] = useState<'auto' | 'google' | 'semantic' | 'openalex'>(
    'auto'
  )
  const [yearFrom, setYearFrom] = useState('')
  const [yearTo, setYearTo] = useState('')
  const [minCited, setMinCited] = useState('')
  const [oaOnly, setOaOnly] = useState(false)
  // 默认「最新优先」：新领域里高被引旧文会把近两年的工作挤下去
  const [sort, setSort] = useState<'recent' | 'cited' | 'relevance'>('recent')
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [results, setResults] = useState<WorkHit[]>([])
  const [total, setTotal] = useState(0)
  const [added, setAdded] = useState<Record<string, boolean>>({})
  const [openAbs, setOpenAbs] = useState<Record<string, boolean>>({})

  // 划词「文件检索」：填入检索词并立即执行
  useEffect(() => {
    if (!pendingQuery) return
    setQuery(pendingQuery)
    setMode('keyword')
    onConsumePendingQuery?.()
    void search(1, pendingQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuery])

  const search = async (p = 1, qOverride?: string): Promise<void> => {
    const q = (qOverride ?? query).trim()
    if (!q) {
      setStatus('请输入关键词（标题 / 主题 / 作者均可）')
      return
    }
    setBusy(true)
    setStatus('检索中…')
    try {
      const r = await window.api.works.search(q, {
        yearFrom: yearFrom ? Number(yearFrom) : null,
        yearTo: yearTo ? Number(yearTo) : null,
        minCited: minCited ? Number(minCited) : null,
        oaOnly,
        page: p,
        mode,
        provider,
        sort
      })
      setResults(r.results)
      setTotal(r.total)
      setPage(p)
      const warn = r.warnings.length ? ` ⚠ ${r.warnings.join('；')}` : ''
      setStatus(`来源 ${r.source} · 命中 ${r.total} 条（第 ${p} 页，每页 ${PER_PAGE}）${warn}`)
    } catch (e) {
      setStatus('检索失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const download = async (h: WorkHit): Promise<void> => {
    const input = h.doi ? `https://doi.org/${h.doi}` : h.oaUrl ?? ''
    if (!input) {
      setStatus('该条没有 DOI / 开放获取链接，无法自动下载')
      return
    }
    setStatus('下载中…')
    try {
      const r = await window.api.library.importFromUrl(input)
      setStatus(r.ok ? `已导入：${h.title ?? input}` : `导入失败：${r.message}`)
      if (r.ok) onLibraryChanged()
    } catch (e) {
      setStatus('导入失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const addToLibrary = async (h: WorkHit): Promise<void> => {
    try {
      await window.api.library.addMetadata({
        title: h.title,
        doi: h.doi,
        year: h.year,
        venue: h.venue,
        parentId: itemId ?? null
      })
      setAdded((prev) => ({ ...prev, [h.id]: true }))
      setStatus(`已加入文库：${h.title ?? h.id}`)
      onLibraryChanged()
    } catch (e) {
      setStatus('加入失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /** 设为种子：加入文库（若需要）→ 切到该条目 → 打开「相关论文」面板（图谱会围绕它构建） */
  const setAsSeed = async (h: WorkHit): Promise<void> => {
    try {
      const it = await window.api.library.addMetadata({
        title: h.title,
        doi: h.doi,
        year: h.year,
        venue: h.venue,
        parentId: itemId ?? null
      })
      setAdded((prev) => ({ ...prev, [h.id]: true }))
      onLibraryChanged()
      onOpenTarget({ itemId: it.id, attachmentId: null, page: null })
      onOpenPanel('discovery')
      setStatus(`已把「${h.title ?? h.id}」设为相关论文图谱的种子`)
    } catch (e) {
      setStatus('设为种子失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /** 按引用展开：加入文库 → 切到该条目 → 打开相关论文并仅看施引文献 */
  const expandCitations = async (h: WorkHit): Promise<void> => {
    try {
      const it = await window.api.library.addMetadata({
        title: h.title,
        doi: h.doi,
        year: h.year,
        venue: h.venue,
        parentId: itemId ?? null
      })
      setAdded((prev) => ({ ...prev, [h.id]: true }))
      onLibraryChanged()
      onExpandCitations(it.id, 'citation')
      setStatus(`正在展开「${h.title ?? h.id}」的施引文献…`)
    } catch (e) {
      setStatus('展开失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /** 全部加入文库（逐个 addMetadata；已加入的跳过） */
  const addAll = async (): Promise<void> => {
    let n = 0
    for (const h of results) {
      if (added[h.id]) continue
      try {
        await window.api.library.addMetadata({
          title: h.title,
          doi: h.doi,
          year: h.year,
          venue: h.venue,
          parentId: itemId ?? null
        })
        setAdded((prev) => ({ ...prev, [h.id]: true }))
        n++
      } catch {
        /* 跳过失败项 */
      }
    }
    onLibraryChanged()
    setStatus(`已加入文库 ${n} 条`)
  }

  /** 导出当前结果为 BibTeX */
  const exportBibtex = async (): Promise<void> => {
    if (results.length === 0) return
    try {
      const bib = results.map(bibEntry).join('\n\n')
      const p = await window.api.translate.saveReport('works.bib', bib)
      setStatus(p ? `已导出 BibTeX：${p}` : '已取消')
    } catch (e) {
      setStatus('导出 BibTeX 失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const maxPage = Math.max(1, Math.ceil(total / PER_PAGE))

  const exportPdf = async (h: WorkHit): Promise<void> => {
    if (!h.oaUrl) {
      setStatus('该条没有开放获取 PDF 链接，无法导出')
      return
    }
    try {
      const p = await window.api.works.savePdf(h.oaUrl, h.title ?? h.id)
      setStatus(p ? `已导出 PDF：${p}` : '已取消')
    } catch (e) {
      setStatus('导出失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  return (
    <div className="panel" data-testid="works-panel">
      <div className="panel__bar">
        <div className="seg" title="检索方式">
          <button
            className={mode === 'keyword' ? 'on' : ''}
            data-testid="works-mode-keyword"
            onClick={() => setMode('keyword')}
          >
            关键词
          </button>
          <button
            className={mode === 'author' ? 'on' : ''}
            data-testid="works-mode-author"
            onClick={() => setMode('author')}
          >
            作者
          </button>
          <button
            className={mode === 'doi' ? 'on' : ''}
            data-testid="works-mode-doi"
            onClick={() => setMode('doi')}
          >
            DOI
          </button>
        </div>
        <Icon name="search" size={14} />
        <input
          placeholder={
            mode === 'author'
              ? '作者名，如：Yoshua Bengio'
              : mode === 'doi'
                ? 'DOI，如：10.1038/s42256-026-01307-8'
                : '关键词 / 标题，如：graph neural network'
          }
          value={query}
          data-testid="works-query"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search(1)
          }}
        />
        <button className="primary" disabled={busy} data-testid="works-run" onClick={() => void search(1)}>
          <Icon name="search" size={14} />
          {busy ? '检索中…' : '检索'}
        </button>
      </div>
      <div className="panel__bar">
        <span className="meta__muted">来源</span>
        <select
          className="works__num"
          style={{ width: 150 }}
          value={provider}
          data-testid="works-provider"
          title="检索来源；Google Scholar 需要 SerpAPI Key（设置 → 其他）"
          onChange={(e) =>
            setProvider(e.target.value as 'auto' | 'google' | 'semantic' | 'openalex')
          }
        >
          <option value="auto">自动（OpenAlex）</option>
          <option value="google">Google Scholar</option>
          <option value="semantic">Semantic Scholar</option>
          <option value="openalex">仅 OpenAlex</option>
        </select>
        <span className="meta__muted">排序</span>
        <select
          className="works__num"
          style={{ width: 110 }}
          value={sort}
          data-testid="works-sort"
          title="找最新论文选「最新优先」；经典工作选「被引最多」"
          onChange={(e) => setSort(e.target.value as 'recent' | 'cited' | 'relevance')}
        >
          <option value="recent">最新优先</option>
          <option value="cited">被引最多</option>
          <option value="relevance">相关度</option>
        </select>
        <span className="meta__muted">年份</span>
        <input
          className="works__num"
          placeholder="起"
          value={yearFrom}
          data-testid="works-year-from"
          onChange={(e) => setYearFrom(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
        <span className="meta__muted">–</span>
        <input
          className="works__num"
          placeholder="止"
          value={yearTo}
          data-testid="works-year-to"
          onChange={(e) => setYearTo(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
        <button
          className="ghost"
          title="只看最近 3 年（新领域快速找前沿）"
          onClick={() => setYearFrom(String(new Date().getFullYear() - 2))}
        >
          近3年
        </button>
        <span className="meta__muted">最少被引</span>
        <input
          className="works__num"
          placeholder="0"
          value={minCited}
          data-testid="works-min-cited"
          onChange={(e) => setMinCited(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        <label className="meta__muted" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={oaOnly}
            data-testid="works-oa-only"
            onChange={(e) => setOaOnly(e.target.checked)}
          />
          仅开放获取
        </label>
        <span className="toolbar__spacer" />
        <button
          className="ghost"
          disabled={!query.trim()}
          data-testid="works-open-scholar"
          title="在系统浏览器打开 Google Scholar 检索（不需要 Key）"
          onClick={() => void window.api.works.openScholar(query)}
        >
          <Icon name="search" size={13} />
          Scholar ↗
        </button>
        <button
          className="ghost"
          disabled={results.length === 0}
          data-testid="works-add-all"
          title="把当前结果全部加入文库"
          onClick={() => void addAll()}
        >
          全部加入文库
        </button>
        <button
          className="ghost"
          disabled={results.length === 0}
          data-testid="works-bibtex"
          title="导出当前结果为 BibTeX"
          onClick={() => void exportBibtex()}
        >
          <Icon name="file" size={13} />
          BibTeX
        </button>
      </div>
      {status && <div className="panel__status">{status}</div>}

      {results.length > 0 ? (
        <>
          <ol className="works__list" data-testid="works-list">
            {results.map((h) => (
              <li key={h.id} className="works__item">
                <div className="works__main">
                  <span className="works__title">{h.title ?? h.id}</span>
                  <span className="works__meta">
                    {h.authors.length ? `${h.authors.slice(0, 3).join(', ')}${h.authors.length > 3 ? ' 等' : ''} · ` : ''}
                    {h.year ?? '—'} · {h.venue ?? '—'} · 被引 {h.citedBy}
                    {h.isOa ? ' · 开放获取' : ''}
                  </span>
                  {h.abstract && (
                    <>
                      <button
                        className="link works__abs-toggle"
                        data-testid={`works-abs-toggle-${h.id}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setOpenAbs((prev) => ({ ...prev, [h.id]: !prev[h.id] }))
                        }}
                      >
                        {openAbs[h.id] ? '收起摘要' : '摘要'}
                      </button>
                      {openAbs[h.id] && <span className="works__abs">{h.abstract}</span>}
                    </>
                  )}
                </div>
                <div className="works__actions">
                  <button
                    className="ghost"
                    data-testid={`works-download-${h.id}`}
                    disabled={!h.doi && !h.oaUrl}
                    title={h.doi ? `下载：${h.doi}` : h.oaUrl ? '从开放获取链接下载' : '无 DOI/链接'}
                    onClick={() => void download(h)}
                  >
                    <Icon name="upload" size={13} />
                    下载
                  </button>
                  <button
                    data-testid={`works-add-${h.id}`}
                    disabled={!!added[h.id]}
                    onClick={() => void addToLibrary(h)}
                  >
                    {added[h.id] ? '已加入' : '加入文库'}
                  </button>
                  <button
                    className="ghost"
                    data-testid={`works-export-${h.id}`}
                    disabled={!h.oaUrl}
                    title={h.oaUrl ? '导出开放获取 PDF 到指定位置（不加入文库）' : '该条没有开放获取 PDF'}
                    onClick={() => void exportPdf(h)}
                  >
                    <Icon name="upload" size={13} />
                    导出 PDF
                  </button>
                  <button
                    className="ghost"
                    data-testid={`works-seed-${h.id}`}
                    title="加入文库并把它设为相关论文图谱的种子"
                    onClick={() => void setAsSeed(h)}
                  >
                    <Icon name="graph" size={13} />
                    设为种子
                  </button>
                  <button
                    className="ghost"
                    data-testid={`works-cite-${h.id}`}
                    title="加入文库并只展开它的施引文献"
                    onClick={() => void expandCitations(h)}
                  >
                    <Icon name="graph" size={13} />
                    按引用展开
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <div className="works__pager">
            <button
              className="ghost"
              data-testid="works-prev"
              disabled={busy || page <= 1}
              onClick={() => void search(page - 1)}
            >
              上一页
            </button>
            <span className="meta__muted">
              {page} / {maxPage}
            </span>
            <button
              className="ghost"
              data-testid="works-next"
              disabled={busy || page >= maxPage}
              onClick={() => void search(page + 1)}
            >
              下一页
            </button>
          </div>
        </>
      ) : (
        <div className="empty" style={{ padding: 16 }}>
          <Icon name="search" size={22} />
          <span>输入关键词检索论文；可下载开放获取 PDF 或加入文库</span>
        </div>
      )}
    </div>
  )
}
