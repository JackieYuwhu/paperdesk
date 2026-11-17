import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import type { AuthorProfile, AuthorSummary } from '@shared/types'

interface Props {
  itemId: number | null
}

/** 作者信息搜索：OpenAlex /authors?search= + 代表作；离线用本地库兜底 */
export function AuthorsPanel({ itemId }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [authors, setAuthors] = useState<AuthorSummary[]>([])
  const [profile, setProfile] = useState<AuthorProfile | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState<Record<string, boolean>>({})
  const [orcidText, setOrcidText] = useState('')
  const [itemAuthors, setItemAuthors] = useState<string[]>([])

  // 切换论文时：用 OpenAlex / 视觉识别（AI）获取作者，而非本地库
  useEffect(() => {
    setProfile(null)
    setAuthors([])
    setWarnings([])
    setStatus('')
    setItemAuthors([])
    if (itemId == null) return
    let cancelled = false
    setBusy(true)
    setStatus('获取作者中（OpenAlex / AI）…')
    void window.api.authors
      .forItem(itemId)
      .then((r) => {
        if (cancelled) return
        setItemAuthors(r.names)
        if (r.warnings.length) setWarnings(r.warnings)
        const first = r.names[0]
        if (first) {
          setQuery(first)
          void run(first)
        } else {
          setStatus('未找到作者，可手动输入姓名搜索')
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatus('失败：' + (e instanceof Error ? e.message : String(e)))
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId])

  const run = async (q: string): Promise<void> => {
    const name = q.trim()
    if (!name) return
    setBusy(true)
    setStatus('检索作者…')
    setProfile(null)
    try {
      const r = await window.api.authors.search(name, 10)
      setAuthors(r.authors)
      setWarnings(r.warnings)
      setStatus(r.authors.length ? `找到 ${r.authors.length} 位作者` : '未找到作者')
    } catch (e) {
      setStatus('失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const cleanup = async (): Promise<void> => {
    setBusy(true)
    setStatus('整理本地作者…')
    try {
      const r = await window.api.authors.cleanup()
      setStatus(`整理完成：合并重复 ${r.merged} · 补齐 OpenAlex ID ${r.enriched}/${r.scanned}`)
    } catch (e) {
      setStatus('整理失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const importOrcid = async (): Promise<void> => {
    const t = orcidText.trim()
    if (!t) return
    setBusy(true)
    setStatus('按 ORCID 导入…')
    try {
      const r = await window.api.authors.importByOrcid(t)
      const extra = r.errors.length ? `（${r.errors[0]}）` : ''
      setStatus(`导入：新增 ${r.added} · 更新 ${r.updated} · 跳过 ${r.skipped}${extra}`)
    } catch (e) {
      setStatus('导入失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const open = async (a: AuthorSummary): Promise<void> => {
    setBusy(true)
    setStatus(`读取 ${a.name} 的资料…`)
    try {
      const p = await window.api.authors.profile(a.id)
      setProfile(p)
      setWarnings(p.warnings)
      setStatus('')
    } catch (e) {
      setStatus('失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const add = async (w: AuthorProfile['works'][number]): Promise<void> => {
    await window.api.library.addMetadata({
      title: w.title,
      doi: w.doi,
      year: w.year,
      venue: w.venue
    })
    setAdded((prev) => ({ ...prev, [w.id]: true }))
  }

  const link = async (): Promise<void> => {
    if (!profile) return
    try {
      const r = await window.api.authors.link({
        openalexId: profile.author.id,
        name: profile.author.name,
        orcid: profile.author.orcid
      })
      setProfile({
        ...profile,
        author: { ...profile.author, localAuthorId: r.authorId }
      })
      setStatus(
        r.created
          ? `已在本地新建作者 #${r.authorId}`
          : `已关联本地作者 #${r.authorId}${r.merged ? `（合并重复 ${r.merged} 条）` : ''}`
      )
    } catch (e) {
      setStatus('关联失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  return (
    <div className="panel">
      <div className="panel__bar">
        <input
          className="ai__input"
          placeholder="搜索作者（姓名）…"
          value={query}
          data-testid="author-input"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run(query)
          }}
        />
        <button className="primary" disabled={busy} onClick={() => void run(query)} data-testid="author-search">
          <Icon name="search" size={14} />
          {busy ? '检索中…' : '搜索'}
        </button>
        <button
          className="ghost"
          disabled={busy}
          title="合并同名作者，并按 ORCID 从 OpenAlex 补齐 ID"
          onClick={() => void cleanup()}
          data-testid="author-cleanup"
        >
          <Icon name="refresh" size={14} />
          整理
        </button>
      </div>
      <div className="panel__bar">
        <input
          className="ai__input"
          placeholder="粘贴 ORCID 批量导入（逗号/换行分隔）…"
          value={orcidText}
          data-testid="author-orcid-input"
          onChange={(e) => setOrcidText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void importOrcid()
          }}
        />
        <button
          className="ghost"
          disabled={busy}
          title="按 ORCID 从 OpenAlex 批量导入本地作者"
          onClick={() => void importOrcid()}
          data-testid="author-import-orcid"
        >
          <Icon name="upload" size={14} />
          导入 ORCID
        </button>
      </div>

      {itemAuthors.length > 0 && (
        <div className="author__chips" data-testid="author-item-authors">
          <span className="meta__muted">本文作者（点击搜索）：</span>
          {itemAuthors.map((n) => (
            <button
              key={n}
              className="chip"
              onClick={() => {
                setQuery(n)
                void run(n)
              }}
            >
              {n}
            </button>
          ))}
        </div>
      )}
      {status && <div className="panel__status">{status}</div>}
      {warnings.length > 0 && <div className="panel__status">⚠ {warnings.join('；')}</div>}

      {authors.length > 0 && (
        <ol className="disc__list" data-testid="author-list">
          {authors.map((a) => (
            <li key={a.id} className="disc__item">
              <div className="disc__item-main">
                <span className="disc__badge" style={{ background: a.source === 'openalex' ? '#2563eb' : '#0ea5e9' }}>
                  {a.source === 'openalex' ? 'OpenAlex' : '本地'}
                </span>
                <span className="disc__title">{a.name}</span>
                <span className="disc__meta">
                  {a.affiliation ?? '—'} · 论文 {a.worksCount} · 被引 {a.citedBy}
                  {a.hIndex != null ? ` · h指数 ${a.hIndex}` : ''}
                  {a.localAuthorId != null ? ' · 本地已有' : ''}
                </span>
              </div>
              <button onClick={() => void open(a)}>查看</button>
            </li>
          ))}
        </ol>
      )}

      {profile && (
        <div className="author__profile">
          <div className="author__head">
            <strong>{profile.author.name}</strong>
            <span className="disc__meta">
              论文 {profile.author.worksCount} · 被引 {profile.author.citedBy}
              {profile.author.hIndex != null ? ` · h指数 ${profile.author.hIndex}` : ''}
            </span>
            {profile.author.orcid && (
              <span className="disc__meta">ORCID {profile.author.orcid}</span>
            )}
            {profile.author.source === 'openalex' ? (
              <span className="author__actions">
                <button
                  data-testid="author-link"
                  disabled={profile.author.localAuthorId != null}
                  title="把该 OpenAlex 作者写入/合并到本地作者表"
                  onClick={() => void link()}
                >
                  <Icon name="check" size={14} />
                  {profile.author.localAuthorId != null
                    ? `已关联本地 #${profile.author.localAuthorId}`
                    : '关联本地作者'}
                </button>
              </span>
            ) : (
              <span className="disc__meta">本地作者 #{profile.author.localAuthorId ?? '—'}</span>
            )}
          </div>
          {profile.works.length > 0 ? (
            <ol className="disc__list" data-testid="author-works">
              {profile.works.map((w) => (
                <li key={w.id} className="disc__item">
                  <div className="disc__item-main">
                    <span className="disc__title">{w.title ?? w.id}</span>
                    <span className="disc__meta">
                      {w.year ?? '—'} · {w.venue ?? '—'} · 被引 {w.citedBy}
                    </span>
                  </div>
                  <button disabled={!!added[w.id]} onClick={() => void add(w)}>
                    {added[w.id] ? '已加入' : '加入文库'}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <div className="list__hint">没有可展示的代表作</div>
          )}
        </div>
      )}
    </div>
  )
}
