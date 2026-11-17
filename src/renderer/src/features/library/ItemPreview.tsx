import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import type { Item, MetadataView } from '@shared/types'

interface Props {
  itemId: number
  onLibraryChanged: () => void
  onOpenItem: (itemId: number) => void
}

/** 无 PDF 的元数据条目预览（相关论文 / AI 建议加入文库后）：标题/作者/摘要/DOI/参考文献。 */
export function ItemPreview({ itemId, onLibraryChanged, onOpenItem }: Props): React.JSX.Element {
  const [item, setItem] = useState<Item | null>(null)
  const [meta, setMeta] = useState<MetadataView | null>(null)
  const [children, setChildren] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  const load = useCallback(async (): Promise<void> => {
    const [it, m, all] = await Promise.all([
      window.api.library.get(itemId),
      window.api.metadata.get(itemId),
      window.api.library.list()
    ])
    setItem(it)
    setMeta(m)
    setChildren(all.filter((x) => x.parent_id === itemId))
  }, [itemId])

  useEffect(() => {
    void load()
    setStatus('')
  }, [load])

  const enrich = async (): Promise<void> => {
    setBusy(true)
    setStatus('获取摘要…')
    try {
      await window.api.library.enrich(itemId)
      await load()
      onLibraryChanged()
      setStatus('已更新')
    } catch (e) {
      setStatus('失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm('确定删除该条目？（含其空间目录；子条目会上移到上一级）')) return
    await window.api.library.delete(itemId)
    onLibraryChanged()
  }

  const openUrl = (url: string): void => void window.api.app.openExternal(url)

  const authors = meta?.authors ?? []
  const refs = meta?.references ?? []

  return (
    <div className="preview">
      <div className="preview__card">
        <div className="preview__head">
          <span className="preview__badge">元数据条目（无 PDF）</span>
          <span className="toolbar__spacer" />
          <button className="ghost" disabled={busy} onClick={() => void enrich()} data-testid="preview-enrich">
            <Icon name="refresh" size={14} />
            {busy ? '获取中…' : '获取摘要'}
          </button>
          <button className="ghost" onClick={() => void remove()} data-testid="preview-delete">
            <Icon name="trash" size={14} />
            删除
          </button>
        </div>

        <h2 className="preview__title">{item?.title ?? '（未知标题）'}</h2>
        <div className="preview__meta">
          <span>{item?.year ?? '—'}</span>
          <span>·</span>
          <span>{item?.venue ?? '—'}</span>
          {item?.doi && (
            <>
              <span>·</span>
              <a
                href={`https://doi.org/${item.doi}`}
                onClick={(e) => {
                  e.preventDefault()
                  openUrl(`https://doi.org/${item.doi}`)
                }}
              >
                {item.doi}
              </a>
            </>
          )}
        </div>

        {authors.length > 0 && (
          <div className="preview__authors">
            {authors.map((a) => (
              <span className="chip" key={a.id}>
                {a.name}
              </span>
            ))}
          </div>
        )}

        {status && <div className="panel__status">{status}</div>}

        <div className="preview__section">
          <div className="meta__label">摘要</div>
          {item?.abstract ? (
            <p className="preview__abstract">{item.abstract}</p>
          ) : (
            <div className="meta__muted">暂无摘要，点右上「获取摘要」从 Crossref / OpenAlex 拉取。</div>
          )}
        </div>

        <div className="preview__links">
          {item?.doi && (
            <button onClick={() => openUrl(`https://doi.org/${item.doi}`)}>
              <Icon name="external" size={14} />
              DOI 原文
            </button>
          )}
          <button
            onClick={() =>
              openUrl(
                `https://scholar.google.com/scholar?q=${encodeURIComponent(item?.title ?? '')}`
              )
            }
          >
            <Icon name="search" size={14} />
            Google Scholar
          </button>
          <button
            onClick={() =>
              openUrl(`https://www.semanticscholar.org/search?q=${encodeURIComponent(item?.title ?? '')}`)
            }
          >
            <Icon name="search" size={14} />
            Semantic Scholar
          </button>
        </div>

        {children.length > 0 && (
          <div className="preview__section">
            <div className="meta__label">衍生论文（{children.length}）</div>
            <ol className="disc__list">
              {children.map((c) => (
                <li key={c.id} className="disc__item">
                  <div className="disc__item-main">
                    <span className="disc__title">{c.title ?? c.key}</span>
                    <span className="disc__meta">{c.year ?? '—'}</span>
                  </div>
                  <button onClick={() => onOpenItem(c.id)}>查看</button>
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="preview__section">
          <div className="meta__label">参考文献（{refs.length}）</div>
          {refs.length === 0 ? (
            <div className="meta__muted">暂无发表信息（可点「识别元数据」从 PDF 提取，或该条目本就没有）</div>
          ) : (
            <ol className="meta__refs">
              {refs.slice(0, 40).map((r) => (
                <li key={r.id} className="meta__ref">
                  <span className="meta__ref-text">{r.raw ?? r.title ?? '(空)'}</span>
                  {r.doi && (
                    <a
                      className="meta__doi"
                      href={`https://doi.org/${r.doi}`}
                      onClick={(e) => {
                        e.preventDefault()
                        openUrl(`https://doi.org/${r.doi}`)
                      }}
                    >
                      {r.doi}
                    </a>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  )
}
