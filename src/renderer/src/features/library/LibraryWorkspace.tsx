import { useMemo, useState } from 'react'
import type { Item } from '@shared/types'
import { filterItemsByGroup, GROUP_ALL, GROUP_UNGROUPED, groupDisplayName } from '@shared/library-groups'
import { Icon } from '../../components/Icon'

interface Props {
  items: Item[]
  group: string
  activeId: number | null
  loading: boolean
  error: string
  onRetry: () => void
  onRead: (id: number) => void
  onDelete: (id: number) => void
  onDetail: (id: number) => void
  onImport: () => void
  onImportFolder: () => void
  onSearch: () => void
}

/** 文库主工作区；分组管理保留在现有侧栏，论文在宽列表中浏览。 */
export function LibraryWorkspace({ items, group, activeId, loading, error, onRetry, onRead, onDetail, onDelete, onImport, onImportFolder, onSearch }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('recent')
  const [limit, setLimit] = useState(80)
  const [importOpen, setImportOpen] = useState(false)
  const rows = useMemo(() => {
    const q = query.toLocaleLowerCase().trim()
    const scoped = group === GROUP_ALL || group === GROUP_UNGROUPED
      ? filterItemsByGroup(items, group)
      : items.filter((i) => i.group_name === group || i.group_name?.startsWith(`${group}/`))
    return scoped
      .filter((i) => !q || [i.title, i.venue, i.doi, i.domain, ...(i.tags ?? [])].some((v) => v?.toLocaleLowerCase().includes(q)))
      .sort((a, b) => sort === 'year'
        ? (b.year ?? 0) - (a.year ?? 0) || b.date_added.localeCompare(a.date_added)
        : b.date_added.localeCompare(a.date_added))
  }, [items, group, query, sort])
  const active = items.find((i) => i.id === activeId)
  const title = group === GROUP_ALL ? '全部论文' : group === GROUP_UNGROUPED ? '未分组' : groupDisplayName(group)
  return (
    <section className="library-workspace" data-testid="library-workspace">
      <div className="workspace-heading">
        <div><span className="workspace-eyebrow">YOUR RESEARCH, TOGETHER</span><h1>{title}</h1><p>{loading ? '正在读取本地文库…' : `${rows.length} 篇论文 · 在这里开始下一次发现`}</p></div>
        <div className="library-import">
          <button className="primary" aria-expanded={importOpen} onClick={() => setImportOpen((v) => !v)}><Icon name="upload" size={16} />导入论文<Icon name="chevron-down" size={13} /></button>
          {importOpen && <div className="library-import__menu"><button onClick={() => { setImportOpen(false); onImport() }}>本地 PDF</button><button onClick={() => { setImportOpen(false); onImportFolder() }}>整个文件夹</button><button onClick={() => { setImportOpen(false); onSearch() }}>DOI / arXiv / 网页链接</button></div>}
        </div>
      </div>
      {error && <div className="workspace-error" role="alert">{error}<button onClick={onRetry}>重新加载</button></div>}
      {active && !query && <div className="resume-paper"><div className="resume-paper__icon"><Icon name="book" size={23} /></div><div><span className="workspace-eyebrow">继续阅读</span><h2>{active.title || '未命名论文'}</h2><span>{active.venue || active.domain || '本地文库'}{active.year ? ` · ${active.year}` : ''}</span></div><button onClick={() => onRead(active.id)}>继续阅读<Icon name="right" size={15} /></button></div>}
      <div className="library-controls"><label className="library-filter"><Icon name="search" size={16} /><input aria-label="筛选论文" placeholder="筛选标题、出处、标签…" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(80) }} /></label><button className="ghost" onClick={onSearch}>全文检索</button><select aria-label="论文排序" value={sort} onChange={(e) => setSort(e.target.value)}><option value="recent">最近添加</option><option value="year">发表年份</option></select></div>
      <div className="library-table" role="table" aria-label="论文列表">
        <div className="library-table__head" role="row"><span role="columnheader">论文 / 发表出处</span><span role="columnheader">年份</span><span role="columnheader">分组</span><span role="columnheader">操作</span></div>
        {rows.slice(0, limit).map((item) => <div className={`library-table__row${item.id === activeId ? ' is-current' : ''}`} role="row" key={item.id}>
          <div role="cell"><button className="paper-title" onClick={() => onRead(item.id)} title={item.title || ''}>{item.title || '未命名论文'}</button><div className="paper-meta">{item.venue || '暂无发表信息'}{item.domain ? ` · ${item.domain}` : ''}</div>{!!item.tags?.length && <div className="paper-tags">{item.tags.slice(0, 3).map((t) => <span key={t}>{t}</span>)}</div>}</div>
          <span role="cell" className="paper-year">{item.year || '—'}</span><span role="cell" className="paper-group" title={item.group_name || ''}>{item.group_name ? groupDisplayName(item.group_name) : '未分组'}</span><div role="cell" className="paper-actions"><button className="ghost" aria-label={`查看 ${item.title || '论文'} 详情`} onClick={() => onDetail(item.id)}>详情</button><button className="icon ghost" aria-label={`删除 ${item.title || '论文'}`} title="删除论文（将确认）" onClick={() => onDelete(item.id)}><Icon name="trash" size={14} /></button></div>
        </div>)}
      </div>
      {!loading && rows.length === 0 && !error && <div className="workspace-empty"><Icon name="library" size={32} /><h2>{query ? '没有匹配的论文' : '给你的研究留一个位置'}</h2><p>{query ? '试试其他关键词，或使用全文检索。' : '导入论文后，就可以阅读、批注、翻译和整理知识。'}</p>{!query && <button onClick={onImport}>导入第一篇论文</button>}</div>}
      {rows.length > limit && <button className="library-more" onClick={() => setLimit((n) => n + 80)}>显示更多（还有 {rows.length - limit} 篇）</button>}
    </section>
  )
}
