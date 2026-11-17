import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Attachment, Item, ItemInsight, MetadataView, NoteWithContent } from '@shared/types'
import {
  CITATION_SOURCE_LABEL,
  PUBLICATION_SOURCE_LABEL,
  PUBLICATION_TYPE_LABEL,
  describeCitation,
  formatPublicationLine,
  type CitationRecord,
  type PublicationInfo,
  type PublicationType
} from '@shared/publication'
import { groupDisplayName } from '@shared/library-groups'
import { extractAnalysisSection } from '@shared/note-sections'
import { Icon } from '../../components/Icon'

interface Props {
  itemId: number
  /** 返回文档列表 */
  onBack: () => void
  /** 在阅读器中打开该条目 */
  onOpenItem: (itemId: number) => void
  /** 打开该条目的笔记（完整拆解在笔记里） */
  onOpenNotes?: (itemId: number) => void
  /** 元数据变更后刷新文库列表 */
  onLibraryChanged?: () => void
}

const TYPE_OPTIONS: PublicationType[] = ['journal', 'conference', 'preprint', 'unknown']

/** 发表信息里的可编辑字段（手动修正表单） */
interface PubDraft {
  type: PublicationType
  venue: string
  venueShort: string
  event: string
  volume: string
  issue: string
  pages: string
  year: string
  preprintPlatform: string
  preprintId: string
}

function draftFrom(info: PublicationInfo | null): PubDraft {
  return {
    type: info?.type ?? 'unknown',
    venue: info?.venue ?? '',
    venueShort: info?.venueShort ?? '',
    event: info?.event ?? '',
    volume: info?.volume ?? '',
    issue: info?.issue ?? '',
    pages: info?.pages ?? '',
    year: info?.year == null ? '' : String(info.year),
    preprintPlatform: info?.preprintPlatform ?? '',
    preprintId: info?.preprintId ?? ''
  }
}

/** 附件体积：窄栏里只保留一位小数，避免长数字挤掉文件名 */
function formatSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** 笔记里的 Markdown 拆解 → 适合窄栏阅读的纯文本（保留段落/小标题，去掉标记） */
function plainMarkdown(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 文库「文档详情」：双击列表条目后在左栏展示。
 * 本地信息（作者/期刊/摘要/已保存的论文拆解）立即显示；被引次数单独异步查询，
 * 不阻塞面板打开。
 */
export function ItemDetailPanel({
  itemId,
  onBack,
  onOpenNotes,
  onLibraryChanged
}: Props): React.JSX.Element {
  const [item, setItem] = useState<Item | null>(null)
  const [meta, setMeta] = useState<MetadataView | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [note, setNote] = useState<NoteWithContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [citation, setCitation] = useState<CitationRecord | null>(null)
  const [citeBusy, setCiteBusy] = useState(false)
  const [citeError, setCiteError] = useState('')
  const [publication, setPublication] = useState<{
    info: PublicationInfo
    line: string
    catalog: string
  } | null>(null)
  const [pubEdit, setPubEdit] = useState(false)
  const [pubDraft, setPubDraft] = useState<PubDraft>(() => draftFrom(null))
  const [pubBusy, setPubBusy] = useState(false)
  const [pubNote, setPubNote] = useState('')
  const [enrichBusy, setEnrichBusy] = useState(false)
  const [enrichNote, setEnrichNote] = useState('')
  const [extractBusy, setExtractBusy] = useState(false)
  const [extractNote, setExtractNote] = useState('')
  const [expanded, setExpanded] = useState(false)
  // 标题 / 文件名：保存时同时改库内标题与磁盘 PDF 文件名
  const [titleDraft, setTitleDraft] = useState('')
  const [titleBusy, setTitleBusy] = useState(false)
  const [titleNote, setTitleNote] = useState('')
  const [groups, setGroups] = useState<Array<{ name: string; count: number }>>([])
  const [groupDraft, setGroupDraft] = useState('')
  const [groupBusy, setGroupBusy] = useState(false)
  const [groupNote, setGroupNote] = useState('')
  const [itemTags, setItemTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const [tagOptions, setTagOptions] = useState<string[]>([])
  const [tagBusy, setTagBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api.library
      .listGroups()
      .then((rows) => {
        if (!cancelled) setGroups(rows)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [itemId])

  useEffect(() => {
    let cancelled = false
    void window.api.library
      .listTags()
      .then((rows) => {
        if (!cancelled) setTagOptions(rows.map((t) => t.name))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [itemId])

  // 本地数据：一次并行取回，切换条目时作废旧结果
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setItem(null)
    setMeta(null)
    setAttachments([])
    setNote(null)
    setExpanded(false)
    setExtractNote('')
    void Promise.all([
      window.api.library.get(itemId),
      window.api.metadata.get(itemId).catch(() => null),
      window.api.attachments.listByItem(itemId).catch(() => []),
      window.api.notes.getForItem(itemId).catch(() => null)
    ])
      .then(([it, m, atts, n]) => {
        if (cancelled) return
        setItem(it)
        setMeta(m)
        setAttachments(atts ?? [])
        setNote(n)
        setGroupDraft(it?.group_name ?? '')
        setItemTags(it?.tags ?? [])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [itemId])

  // 被引：**只读本地记录**（打开详情/切换论文/重启都不联网）；
  // 只有用户点「查询被引次数 / 刷新」才走 queryCitations()。
  useEffect(() => {
    let cancelled = false
    setCitation(null)
    setCiteError('')
    void window.api.works
      .citation(itemId)
      .then((rec) => {
        if (!cancelled) setCitation(rec)
      })
      .catch((e: unknown) => {
        if (!cancelled) setCiteError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [itemId])

  // 发表信息：先读库（老数据退回 venue），再决定是否提示补全
  useEffect(() => {
    let cancelled = false
    setPublication(null)
    setPubEdit(false)
    setPubNote('')
    void window.api.publication
      .get(itemId)
      .then((p) => {
        if (cancelled) return
        setPublication(p)
        setPubDraft(draftFrom(p.info))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [itemId])

  /** 用户主动查询/刷新被引次数（并发保护在服务端：同一篇复用同一请求） */
  const queryCitations = useCallback(
    async (candidateId?: string): Promise<void> => {
      if (citeBusy) return
      setCiteBusy(true)
      setCiteError('')
      try {
        const rec = await window.api.works.citationQuery(itemId, { candidateId })
        setCitation(rec)
        if (rec.status === 'unconfigured') {
          setCiteError(rec.lastError ?? '未配置 SerpAPI Key')
        } else if (rec.status === 'failed') {
          setCiteError(rec.lastError ?? '查询失败')
        }
      } catch (e) {
        setCiteError(`查询失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setCiteBusy(false)
      }
    },
    [citeBusy, itemId]
  )

  /** 联网补全发表信息（Crossref/OpenAlex；用户手改字段不会被覆盖） */
  const enrichPublication = useCallback(async (): Promise<void> => {
    setPubBusy(true)
    setPubNote('')
    try {
      const p = await window.api.publication.enrich(itemId)
      setPublication({ info: p.info, line: p.line, catalog: p.catalog })
      setPubDraft(draftFrom(p.info))
      if (p.info.type === 'unknown' && !p.info.venue) {
        setPubNote('没有查到可靠的发表信息：可手动选择类型并填写期刊/会议名')
      } else if (p.warnings.length) {
        setPubNote(p.warnings.join('；'))
      }
    } catch (e) {
      setPubNote(`补全失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPubBusy(false)
    }
  }, [itemId])

  /** 保存手动修正：写入 userFixed，后续自动补全不再覆盖这些字段 */
  const savePublication = useCallback(async (): Promise<void> => {
    setPubBusy(true)
    setPubNote('')
    try {
      const yearNum = Number(pubDraft.year)
      const p = await window.api.publication.save(itemId, {
        type: pubDraft.type,
        venue: pubDraft.venue.trim() || null,
        venueShort: pubDraft.venueShort.trim() || null,
        event: pubDraft.event.trim() || null,
        volume: pubDraft.volume.trim() || null,
        issue: pubDraft.issue.trim() || null,
        pages: pubDraft.pages.trim() || null,
        year: Number.isFinite(yearNum) && yearNum > 0 ? Math.trunc(yearNum) : null,
        preprintPlatform: pubDraft.preprintPlatform.trim() || null,
        preprintId: pubDraft.preprintId.trim() || null
      })
      setPublication({ info: p.info, line: p.line, catalog: p.catalog })
      setPubDraft(draftFrom(p.info))
      setPubEdit(false)
      setPubNote('已保存手动修正；之后的自动补全不会覆盖这些字段')
    } catch (e) {
      setPubNote(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPubBusy(false)
    }
  }, [itemId, pubDraft])

  useEffect(() => {
    setTitleDraft(item?.title ?? '')
  }, [item?.id, item?.title])

  /** 手动保存标题：library.rename 会同时更新库内标题和 PDF 文件名 */
  const saveTitle = useCallback(async (): Promise<void> => {
    const title = titleDraft.trim()
    if (!title) {
      setTitleNote('标题不能为空')
      return
    }
    if (title === (item?.title ?? '')) {
      setTitleNote('标题没有变化')
      return
    }
    setTitleBusy(true)
    setTitleNote('')
    try {
      const updated = await window.api.library.rename(itemId, title)
      setItem(updated)
      setTitleDraft(updated.title ?? title)
      setTitleNote('已重命名标题与 PDF 文件')
      onLibraryChanged?.()
    } catch (e) {
      setTitleNote(`重命名失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setTitleBusy(false)
    }
  }, [item?.title, itemId, onLibraryChanged, titleDraft])

  /** 存量条目移动到已有/新分组；空值表示移出分组 */
  const saveGroup = useCallback(async (): Promise<void> => {
    const next = groupDraft.trim()
    if (next === (item?.group_name ?? '')) {
      setGroupNote('分组没有变化')
      return
    }
    setGroupBusy(true)
    setGroupNote('')
    try {
      await window.api.library.setGroup(itemId, next || null)
      const latest = await window.api.library.get(itemId)
      setItem(latest)
      setGroupDraft(latest?.group_name ?? '')
      const rows = await window.api.library.listGroups()
      setGroups(rows)
      setGroupNote(next ? `已移动到「${groupDisplayName(next)}」` : '已移出分组')
      onLibraryChanged?.()
    } catch (e) {
      setGroupNote(`移动失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setGroupBusy(false)
    }
  }, [groupDraft, item?.group_name, itemId, onLibraryChanged])

  const saveTags = useCallback(
    async (next: string[]): Promise<void> => {
      setTagBusy(true)
      try {
        const saved = await window.api.library.setTags(itemId, next)
        setItemTags(saved)
        setTagDraft('')
        setItem((cur) => (cur ? { ...cur, tags: saved } : cur))
        const rows = await window.api.library.listTags()
        setTagOptions(rows.map((t) => t.name))
        onLibraryChanged?.()
      } catch (e) {
        window.alert(`保存标签失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setTagBusy(false)
      }
    },
    [itemId, onLibraryChanged]
  )

  const addTag = (): void => {
    const name = tagDraft.trim()
    if (!name || tagBusy) return
    if (itemTags.includes(name)) {
      setTagDraft('')
      return
    }
    void saveTags([...itemTags, name])
  }

  const analysis = useMemo(() => extractAnalysisSection(note?.content), [note?.content])
  const insight: ItemInsight | null = useMemo(() => {
    if (analysis) return analysis
    const abstract = (item?.abstract ?? '').trim()
    if (!abstract) return null
    return { title: '摘要', markdown: abstract, source: 'abstract' }
  }, [analysis, item?.abstract])

  const insightText = insight ? plainMarkdown(insight.markdown) : ''
  const insightPreview = expanded ? insightText : insightText.slice(0, 1200)
  const canExpand = insightText.length > 1200

  const authors = meta?.authors ?? []
  const pages = attachments.reduce((n, a) => n + (a.page_count ?? 0), 0)
  const scholarQuery = item?.doi || item?.title || ''
  const openScholar = useCallback((): void => {
    if (!scholarQuery) return
    void window.api.works.openScholar(scholarQuery)
  }, [scholarQuery])
  const openDoi = useCallback((): void => {
    if (!item?.doi) return
    void window.api.app.openExternal(`https://doi.org/${item.doi}`)
  }, [item?.doi])

  const enrichVenue = useCallback(async (): Promise<void> => {
    setEnrichBusy(true)
    setEnrichNote('')
    try {
      const it = await window.api.library.enrich(itemId)
      setItem(it)
      const m = await window.api.metadata.get(itemId).catch(() => null)
      setMeta(m)
      const p = await window.api.publication.get(itemId).catch(() => null)
      if (p) {
        setPublication(p)
        setPubDraft(draftFrom(p.info))
      }
      const known = p?.info.type !== 'unknown' && !!p?.info.venue
      setEnrichNote(
        known
          ? '已补全发表信息'
          : '仍未确认发表类型/出处（可手动修正，或点「识别元数据」从 PDF 再抽取）'
      )
    } catch (e) {
      setEnrichNote(`补全失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setEnrichBusy(false)
    }
  }, [itemId])

  /**
   * 重新跑本地抽取：修正旧条目识别错的标题/作者（例如把 arXiv 左侧收录戳当标题）。
   * 只读 PDF 本地信息，不发起 AI 视觉请求；成功后刷新详情与列表。
   */
  const reidentify = useCallback(async (): Promise<void> => {
    const att = attachments[0]
    if (!att) {
      setExtractNote('当前条目没有可读取的附件')
      return
    }
    setExtractBusy(true)
    setExtractNote('')
    const beforeTitle = item?.title ?? ''
    try {
      await window.api.metadata.extract(att.id, { forceTitle: true })
      let latest = await window.api.library.get(itemId)
      if (!latest) throw new Error('条目不存在或已删除')
      // 自动重命名：从 PDF 首页识别出新标题时，复用 rename 同步磁盘文件名。
      if (latest.title && latest.title !== beforeTitle) {
        latest = await window.api.library.rename(itemId, latest.title)
      }
      const [m, atts] = await Promise.all([
        window.api.metadata.get(itemId).catch(() => null),
        window.api.attachments.listByItem(itemId).catch(() => [])
      ])
      setItem(latest)
      setTitleDraft(latest.title ?? '')
      setMeta(m)
      setAttachments(atts ?? [])
      setExtractNote(
        latest.title && latest.title !== beforeTitle
          ? `已自动重命名为「${latest.title}」`
          : '已重新识别标题与作者'
      )
      onLibraryChanged?.()
    } catch (e) {
      setExtractNote(`重新识别失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExtractBusy(false)
    }
  }, [attachments, item?.title, itemId, onLibraryChanged])

  return (
    <aside className="sidebar detail-panel" data-testid="item-detail">
      <div className="detail__head">
        <button
          className="icon ghost"
          title="返回文档列表"
          data-testid="detail-back"
          onClick={onBack}
        >
          <Icon name="left" size={16} />
        </button>
        <span className="detail__head-title">文档详情</span>
        <span className="toolbar__spacer" />
        <button
          className="icon ghost"
          title="刷新被引次数（联网查询）"
          data-testid="detail-cite-refresh"
          disabled={citeBusy}
          onClick={() => void queryCitations()}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>

      <div className="detail__body">
        {loading ? (
          <div className="list__hint">载入中…</div>
        ) : !item ? (
          <div className="list__hint">条目不存在或已删除。</div>
        ) : (
          <>
            <div className="detail__title">{item.title ?? '（未命名）'}</div>
            <div className="detail__meta">
              <span>{item.year ?? '—'}</span>
              <span>·</span>
              <span data-testid="detail-type-chip">
                {publication?.info.type && publication.info.type !== 'unknown'
                  ? PUBLICATION_TYPE_LABEL[publication.info.type]
                  : '发表类型待确认'}
              </span>
              {publication?.info.venue && (
                <>
                  <span>·</span>
                  <span>{publication.info.venue}</span>
                </>
              )}
              {item.domain && (
                <>
                  <span>·</span>
                  <span>{item.domain}</span>
                </>
              )}
              {item.group_name && (
                <>
                  <span>·</span>
                  <span data-testid="detail-group-name" title={item.group_name}>
                    分组：{groupDisplayName(item.group_name)}
                  </span>
                </>
              )}
            </div>

            <div className="detail__section">
              <div className="detail__section-title">标题 / 文件</div>
              <div className="detail__actions">
                <input
                  className="detail__rename-input"
                  data-testid="detail-rename-input"
                  title="保存时同时更新库内标题与 PDF 文件名"
                  value={titleDraft}
                  disabled={titleBusy}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void saveTitle()
                    }
                  }}
                />
                <button
                  className="ghost"
                  data-testid="detail-rename-save"
                  disabled={titleBusy || !titleDraft.trim()}
                  onClick={() => void saveTitle()}
                >
                  <Icon name="check" size={13} />
                  保存名称
                </button>
                <button
                  className="ghost"
                  data-testid="detail-auto-rename"
                  disabled={extractBusy || !attachments.length}
                  title="从 PDF 首页重新识别标题，并同步重命名 PDF 文件"
                  onClick={() => void reidentify()}
                >
                  <Icon name="refresh" size={13} />
                  {extractBusy ? '识别中…' : '自动重命名'}
                </button>
              </div>
              {titleNote && <div className="detail__hint">{titleNote}</div>}
              {extractNote && <div className="detail__hint">{extractNote}</div>}
            </div>

            <div className="detail__section">
              <div className="detail__section-title">分组</div>
              <div className="detail__actions">
                <input
                  className="detail__rename-input"
                  data-testid="detail-group-input"
                  list="detail-group-options"
                  placeholder="未分组；可输入 A/B 新建层级"
                  value={groupDraft}
                  disabled={groupBusy}
                  onChange={(e) => setGroupDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void saveGroup()
                    }
                  }}
                />
                <datalist id="detail-group-options">
                  {groups.map((g) => (
                    <option key={g.name} value={g.name}>
                      {g.name}
                    </option>
                  ))}
                </datalist>
                <button
                  className="ghost"
                  data-testid="detail-group-save"
                  disabled={groupBusy}
                  onClick={() => void saveGroup()}
                >
                  <Icon name="folder" size={13} />
                  保存分组
                </button>
              </div>
              {groupNote && <div className="detail__hint">{groupNote}</div>}
            </div>

            <div className="detail__section">
              <div className="detail__section-title">
                标签
                <span className="detail__source">手动标签；领域/关键词标签保持不动</span>
              </div>
              <div className="tag-editor" data-testid="detail-tags">
                {itemTags.map((t) => (
                  <span className="tag-chip tag-chip--editable" key={t}>
                    {t}
                    <button
                      className="tag-chip__x"
                      title={`移除标签「${t}」`}
                      disabled={tagBusy}
                      onClick={() => void saveTags(itemTags.filter((x) => x !== t))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  className="tag-editor__input"
                  data-testid="detail-tag-input"
                  list="detail-tag-options"
                  placeholder="添加标签，回车保存"
                  value={tagDraft}
                  disabled={tagBusy}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addTag()
                    }
                  }}
                />
                <datalist id="detail-tag-options">
                  {tagOptions.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </div>
            </div>

            <div className="detail__section">
              <div className="detail__section-title">作者</div>
              {authors.length ? (
                <div className="detail__authors">
                  {authors.map((a) => (
                    <span className="chip" key={a.id}>
                      {a.name}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="meta__muted">未识别作者</div>
              )}
            </div>

            <div className="detail__section" data-testid="detail-publication">
              <div className="detail__section-title">
                发表信息
                <span className="detail__source">
                  {PUBLICATION_TYPE_LABEL[publication?.info.type ?? 'unknown']}
                </span>
              </div>
              <div className="detail__line" data-testid="detail-publication-line">
                {publication?.line ?? formatPublicationLine(publication?.info ?? null)}
              </div>
              <div className="detail__hint" data-testid="detail-publication-meta">
                {publication?.info.venue && publication.info.type !== 'unknown'
                  ? `来源：${PUBLICATION_SOURCE_LABEL[publication.info.source]}`
                  : '来源：暂无'}
                {publication?.info.updatedAt
                  ? ` · 更新于 ${new Date(publication.info.updatedAt).toLocaleString('zh-CN')}`
                  : ''}
                {' · '}
                {publication?.catalog ?? '暂无目录匹配'}
              </div>
              {publication?.info.type === 'preprint' && !publication.info.formalDoi && (
                <div className="detail__hint">尚未发现正式发表版本（仅有预印本）</div>
              )}
              {publication?.info.userFixed.length ? (
                <div className="detail__hint">
                  已手动修正：{publication.info.userFixed.join('、')}（自动补全不会覆盖）
                </div>
              ) : null}
              {!pubEdit ? (
                <div className="detail__actions">
                  <button
                    className="ghost"
                    data-testid="detail-enrich-publication"
                    disabled={pubBusy}
                    onClick={() => void enrichPublication()}
                  >
                    <Icon name="refresh" size={13} />
                    {pubBusy ? '查询中…' : '补全发表信息'}
                  </button>
                  <button
                    className="ghost"
                    data-testid="detail-edit-publication"
                    onClick={() => {
                      setPubDraft(draftFrom(publication?.info ?? null))
                      setPubEdit(true)
                    }}
                  >
                    <Icon name="edit" size={13} />
                    手动修正
                  </button>
                </div>
              ) : (
                <div className="pub-edit" data-testid="detail-publication-form">
                  <label className="pub-edit__row">
                    <span>类型</span>
                    <select
                      data-testid="detail-publication-type"
                      value={pubDraft.type}
                      onChange={(e) =>
                        setPubDraft({ ...pubDraft, type: e.target.value as PublicationType })
                      }
                    >
                      {TYPE_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                          {PUBLICATION_TYPE_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="pub-edit__row">
                    <span>{pubDraft.type === 'conference' ? '会议名' : '期刊/平台'}</span>
                    <input
                      data-testid="detail-publication-venue"
                      value={pubDraft.venue}
                      placeholder={pubDraft.type === 'conference' ? '如 NeurIPS' : '如 Nature / arXiv'}
                      onChange={(e) => setPubDraft({ ...pubDraft, venue: e.target.value })}
                    />
                  </label>
                  {pubDraft.type === 'conference' && (
                    <label className="pub-edit__row">
                      <span>会议简称</span>
                      <input
                        value={pubDraft.venueShort}
                        placeholder="如 NeurIPS"
                        onChange={(e) => setPubDraft({ ...pubDraft, venueShort: e.target.value })}
                      />
                    </label>
                  )}
                  {pubDraft.type === 'preprint' && (
                    <>
                      <label className="pub-edit__row">
                        <span>平台</span>
                        <input
                          value={pubDraft.preprintPlatform}
                          placeholder="如 arXiv"
                          onChange={(e) =>
                            setPubDraft({ ...pubDraft, preprintPlatform: e.target.value })
                          }
                        />
                      </label>
                      <label className="pub-edit__row">
                        <span>编号</span>
                        <input
                          value={pubDraft.preprintId}
                          placeholder="如 2401.12345"
                          onChange={(e) => setPubDraft({ ...pubDraft, preprintId: e.target.value })}
                        />
                      </label>
                    </>
                  )}
                  <div className="pub-edit__grid">
                    <label className="pub-edit__row">
                      <span>年份</span>
                      <input
                        value={pubDraft.year}
                        inputMode="numeric"
                        placeholder="2024"
                        onChange={(e) => setPubDraft({ ...pubDraft, year: e.target.value })}
                      />
                    </label>
                    <label className="pub-edit__row">
                      <span>卷</span>
                      <input
                        value={pubDraft.volume}
                        onChange={(e) => setPubDraft({ ...pubDraft, volume: e.target.value })}
                      />
                    </label>
                    <label className="pub-edit__row">
                      <span>期</span>
                      <input
                        value={pubDraft.issue}
                        onChange={(e) => setPubDraft({ ...pubDraft, issue: e.target.value })}
                      />
                    </label>
                    <label className="pub-edit__row">
                      <span>页码</span>
                      <input
                        value={pubDraft.pages}
                        placeholder="45-67"
                        onChange={(e) => setPubDraft({ ...pubDraft, pages: e.target.value })}
                      />
                    </label>
                  </div>
                  <div className="detail__actions">
                    <button
                      className="primary"
                      data-testid="detail-publication-save"
                      disabled={pubBusy}
                      onClick={() => void savePublication()}
                    >
                      保存
                    </button>
                    <button className="ghost" onClick={() => setPubEdit(false)}>
                      取消
                    </button>
                  </div>
                </div>
              )}
              {pubNote && (
                <div className="detail__hint" data-testid="detail-publication-note">
                  {pubNote}
                </div>
              )}
              {enrichNote && <div className="detail__hint">{enrichNote}</div>}
            </div>

            <div className="detail__section" data-testid="detail-citations">
              <div className="detail__section-title">被引次数</div>
              {citation?.status === 'ok' && citation.count != null ? (
                <div className="detail__cited-row">
                  <span className="detail__cited" data-testid="detail-cited-count">
                    {citation.count}
                  </span>
                  <span className="detail__cited-unit">次</span>
                </div>
              ) : (
                <div className="meta__muted" data-testid="detail-cited-status">
                  {describeCitation(citation)}
                </div>
              )}
              <div className="detail__hint" data-testid="detail-cited-meta">
                来源：{citation?.source ?? CITATION_SOURCE_LABEL}
                <br />
                {citation?.count != null && citation?.queriedAt
                  ? `查询时间：${new Date(citation.queriedAt).toLocaleString('zh-CN')}`
                  : citation?.lastAttemptAt
                    ? `上次尝试：${new Date(citation.lastAttemptAt).toLocaleString('zh-CN')}（未取得次数）`
                    : '查询时间：尚未查询'}
              </div>
              {citation?.matchedTitle && (
                <div className="detail__hint">
                  匹配：{citation.matchedTitle}
                  {citation.matchedId ? `（${citation.matchedId}）` : ''}
                </div>
              )}
              {citation?.status === 'ambiguous' && citation.candidates.length > 0 && (
                <div className="pub-edit" data-testid="detail-cited-candidates">
                  <div className="detail__hint">有多个候选，请选择正确的一篇：</div>
                  {citation.candidates.map((c) => (
                    <button
                      key={c.id}
                      className="ghost pub-candidate"
                      disabled={citeBusy}
                      onClick={() => void queryCitations(c.id)}
                    >
                      {c.title}
                      {c.year ? `（${c.year}）` : ''}
                      {c.count != null ? ` · 被引 ${c.count}` : ' · 次数未知'}
                    </button>
                  ))}
                </div>
              )}
              {/* 失败只提示本次失败，保留上次成功记录（不清空 count/时间） */}
              {citeError && (
                <div className="detail__hint" data-testid="detail-cited-error">
                  本次失败：{citeError}
                </div>
              )}
              {citation?.status === 'failed' && citation.lastError && !citeError && (
                <div className="detail__hint" data-testid="detail-cited-error">
                  {citation.lastError}
                </div>
              )}
              <div className="detail__actions">
                <button
                  className="ghost"
                  data-testid="detail-cite-query"
                  disabled={citeBusy}
                  onClick={() => void queryCitations()}
                  title="通过 SerpAPI 查询 Google Scholar 被引次数（需要网络与 Key）"
                >
                  <Icon name="search" size={13} />
                  {citeBusy
                    ? '查询中…'
                    : citation?.status === 'never'
                      ? '查询被引次数'
                      : '刷新'}
                </button>
              </div>
              {/* 次级入口：不再常驻，收进「更多」 */}
              <details className="detail__more">
                <summary>更多</summary>
                <div className="detail__actions">
                  <button className="ghost" onClick={openScholar} disabled={!scholarQuery}>
                    <Icon name="search" size={13} />
                    在 Google Scholar 打开
                  </button>
                  {item.doi && (
                    <button className="ghost" onClick={openDoi}>
                      <Icon name="external" size={13} />
                      DOI
                    </button>
                  )}
                </div>
              </details>
            </div>

            <div className="detail__section">
              <div className="detail__section-title">
                主要思想
                <span className="detail__source">
                  {insight?.source === 'analysis' ? '来自已保存的论文拆解' : '来自摘要（尚未拆解）'}
                </span>
              </div>
              {insight ? (
                <>
                  <div className="detail__text" data-testid="detail-insight">
                    {insightPreview}
                    {canExpand && !expanded ? '…' : ''}
                  </div>
                  <div className="detail__actions">
                    {canExpand && (
                      <button className="ghost" onClick={() => setExpanded((v) => !v)}>
                        {expanded ? '收起' : '展开全部'}
                      </button>
                    )}
                    {analysis && onOpenNotes && (
                      <button className="ghost" onClick={() => onOpenNotes(itemId)}>
                        <Icon name="notes" size={13} />
                        在笔记中查看完整拆解
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="meta__muted">暂无摘要；可先识别元数据或在「论文拆解」面板生成。</div>
              )}
            </div>

            <div className="detail__section">
              <div className="detail__section-title">附件</div>
              <div className="detail__line">
                {attachments.length} 个附件{pages > 0 ? ` · 共 ${pages} 页` : ''}
              </div>
              {attachments.length > 0 ? (
                <ul className="detail__files" data-testid="detail-files">
                  {attachments.map((att) => (
                    <li className="detail__file" key={att.id}>
                      <Icon name="file" size={13} />
                      <span className="detail__file-name" title={att.filename ?? att.path}>
                        {att.filename ?? '未命名附件'}
                      </span>
                      <span className="detail__file-meta">
                        {att.page_count ? `${att.page_count} 页` : '页数未知'}
                        {att.size ? ` · ${formatSize(att.size)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
