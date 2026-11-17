import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  KnowledgeEntryDetail,
  KnowledgeEntrySummary,
  KnowledgeKind,
  KnowledgeNature,
  PublicSettings
} from '@shared/types'
import {
  KNOWLEDGE_UNLINKED_PAPER,
  embedBackingFrom,
  groupKnowledgeEntries,
  knowledgeEmbedHint,
  knowledgeEmptyState,
  resolveRetrievalMode,
  retrievalModeLabel,
  STAGING_SCOPE_NOTE,
  type RetrievalModeInfo
} from '@shared/api'
import { Icon } from '../../components/Icon'
import { CiteText, KnowledgeMarkdown } from './KnowledgeMarkdown'
import { evidencePrecisionLabel, evidencePrecisionTone } from './evidence-precision'

export interface KnowledgePanelProps {
  onClose: () => void
  /** 跳去暂存区审核提案；未提供时不显示入口（独立渲染 / 测试场景） */
  onOpenStaging?: () => void
  /** 打开设置并定位到「语义检索」段（PD50）；未提供时不显示入口 */
  onOpenEmbedSettings?: () => void
  /**
   * 阶段二：'overlay' 弹窗（工具栏 / 设置页入口）；'standalone' 嵌在主工作区，
   * 不画遮罩、不抢焦点，由 App 提供「返回论文」。
   */
  variant?: 'overlay' | 'standalone'
}

const KIND_LABEL: Record<KnowledgeKind, string> = {
  paper: '论文',
  concept: '概念',
  method: '方法',
  result: '结果',
  dataset: '数据集',
  metric: '指标',
  claim: '论断',
  note: '笔记',
  decision: '决定',
  question: '问题'
}

const NATURE_LABEL: Record<KnowledgeNature, string> = {
  user_decision: '用户决定',
  user_hypothesis: '用户假设',
  author_claim: '作者主张',
  observation: '观察',
  ai_inference: 'AI 推断',
  ai_suggestion: 'AI 建议'
}

/** IPC 错误带 "Error invoking remote method 'x': Error:" 前缀，去掉后才是给用户看的文案 */
function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/u, '')
    .replace(/^Error:\s*/u, '')
    .trim()
}

function formatTime(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 知识库面板（PD36）。
 * 只列 `knowledge.listEntries()` 返回的已发布条目；提案审核仍在暂存区完成。
 * 入口可由主界面工具栏或设置页打开（同一个组件、同一份状态）。
 */
export function KnowledgePanel({
  onClose,
  onOpenStaging,
  onOpenEmbedSettings,
  variant = 'overlay'
}: KnowledgePanelProps): React.JSX.Element {
  const [entries, setEntries] = useState<KnowledgeEntrySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [details, setDetails] = useState<Record<number, KnowledgeEntryDetail>>({})
  const [detailLoadingId, setDetailLoadingId] = useState<number | null>(null)
  /** 折叠的论文分组 key（PD50）：默认全展开，只有用户点过的组才收起来 */
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  /** 当前检索模式（PD42）：词法 / 语义，以及哈希后端降级原因 */
  const [retrieval, setRetrieval] = useState<RetrievalModeInfo | null>(null)
  const [retrievalSaving, setRetrievalSaving] = useState(false)

  const panelRef = useRef<HTMLDivElement | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    panelRef.current?.focus()
    return () => {
      aliveRef.current = false
    }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [list, settings] = await Promise.all([
        window.api.knowledge.listEntries(),
        // 检索模式读设置即可（PD42）；读不到不影响条目列表
        window.api.settings.get().catch(() => null)
      ])
      if (!aliveRef.current) return
      setEntries(list)
      setExpandedId(null)
      setDetails({})
      setCollapsedGroups({})
      if (settings) {
        setRetrieval(
          resolveRetrievalMode('hybrid', embedBackingFrom(settings), {
            rerank: settings.retrieval?.rerank === '1'
          })
        )
      }
    } catch (err) {
      if (aliveRef.current) setError(ipcErrorMessage(err) || '读取知识库条目失败')
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 语义重排开关（PD42）：默认关闭；哈希后端下打开也会降级为词法，并在下方写清原因 */
  const toggleRerank = useCallback(async (): Promise<void> => {
    if (!retrieval || retrievalSaving) return
    setRetrievalSaving(true)
    try {
      const saved = await window.api.settings.save({
        retrieval: { rerank: retrieval.rerank ? '0' : '1' }
      })
      if (!aliveRef.current) return
      setRetrieval(
        resolveRetrievalMode('hybrid', embedBackingFrom(saved), {
          rerank: saved.retrieval?.rerank === '1'
        })
      )
    } catch (err) {
      if (aliveRef.current) setError(ipcErrorMessage(err) || '保存检索设置失败')
    } finally {
      if (aliveRef.current) setRetrievalSaving(false)
    }
  }, [retrieval, retrievalSaving])

  const toggleEntry = useCallback(
    async (entry: KnowledgeEntrySummary): Promise<void> => {
      if (expandedId === entry.id) {
        setExpandedId(null)
        return
      }
      setExpandedId(entry.id)
      if (details[entry.id]) return
      setDetailLoadingId(entry.id)
      try {
        const detail = await window.api.knowledge.getEntry(entry.id)
        if (!aliveRef.current) return
        if (detail) setDetails((prev) => ({ ...prev, [entry.id]: detail }))
        else setError('读取条目正文失败：条目可能已被删除')
      } catch (err) {
        if (aliveRef.current) setError(ipcErrorMessage(err) || '读取条目正文失败')
      } finally {
        if (aliveRef.current) setDetailLoadingId(null)
      }
    },
    [details, expandedId]
  )

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

  /** 按论文分组（PD50）：四篇论文的条目不能再混成一锅 */
  const groups = groupKnowledgeEntries(entries)
  const toggleGroup = useCallback((key: string): void => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  /** 条目的论文 chip 文案：完整标题，无归属时明确写「未关联论文」 */
  const paperLabel = (entry: KnowledgeEntrySummary): string =>
    entry.paperItemId !== null && entry.paperTitle?.trim()
      ? entry.paperTitle.trim()
      : KNOWLEDGE_UNLINKED_PAPER

  const emptyState = knowledgeEmptyState(entries.length)

  return (
    <div
      className={variant === 'standalone' ? 'stage stage--standalone' : 'stage'}
      data-testid="knowledge-panel"
      role="dialog"
      aria-label="知识库"
      tabIndex={-1}
      ref={panelRef}
      onKeyDown={onKeyDown}
    >
      {variant === 'overlay' && <div className="stage__backdrop" onClick={onClose} />}
      <div className="stage__dialog">
        <header className="stage__header">
          <div className="stage__heading">
            <Icon name="library" size={16} />
            <span className="stage__title">知识库</span>
            <span className="stage__subtitle">只展示已发布条目；提案请先到暂存区审核</span>
          </div>
          <button
            className="ghost"
            data-testid="knowledge-refresh"
            title="刷新已发布条目"
            onClick={() => void load()}
          >
            <Icon name="refresh" size={14} />
            刷新
          </button>
          {onOpenStaging && (
            <button
              className="ghost"
              data-testid="knowledge-open-staging"
              title="打开暂存区，审核论文拆解 / 批处理整理 / AI 助手产生的提案"
              onClick={onOpenStaging}
            >
              <Icon name="layers" size={14} />
              去暂存区审核
            </button>
          )}
          <button className="icon ghost" data-testid="knowledge-close" title="关闭" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>

        <div className="panel__section" data-testid="knowledge-sources">
          <div className="panel__section-head">
            <span className="panel__section-title">知识库里的内容从哪来</span>
            <span className="panel__section-badge">只收已发布条目</span>
          </div>
          <p className="panel__section-text">{STAGING_SCOPE_NOTE}</p>
        </div>

        {/* PD42：检索模式必须显式标注；哈希向量不得冒充语义 */}
        <div className="panel__section panel__section--muted" data-testid="knowledge-retrieval">
          <div className="panel__section-head">
            <span className="panel__section-title">检索模式</span>
            <span
              className="panel__section-badge"
              data-testid="knowledge-retrieval-mode"
              title="当前实际生效的检索模式：词法 = 只用 FTS5/BM25；语义 = 真向量参与排序"
            >
              {retrieval ? retrievalModeLabel(retrieval) : '读取中…'}
            </span>
            <span className="stage-chip stage-chip--muted" data-testid="knowledge-embed-model">
              嵌入模型：{retrieval?.backend === 'none' ? '未启用' : (retrieval?.model ?? '读取中…')}
            </span>
          </div>
          <p className="panel__section-text" data-testid="knowledge-retrieval-detail">
            {retrieval
              ? retrieval.reason ||
                (retrieval.semantic
                  ? '当前后端是真语义向量：开启语义重排后会用 RRF 参与排序，默认关闭。'
                  : '当前只有词法检索（FTS5/BM25），向量分数不参与排序。')
              : '正在读取检索配置…'}
          </p>
          {/* PD50：语义没生效时必须给出「怎么配」的入口，而不是只标一句「已降级」 */}
          {retrieval && !retrieval.semantic && (
            <p className="panel__section-text knowledge__embed-hint" data-testid="knowledge-embed-setup-hint">
              {knowledgeEmbedHint(retrieval)}
            </p>
          )}
          <div className="panel__section-actions">
            <button
              className="btn btn--ghost btn--sm"
              data-testid="knowledge-rerank-toggle"
              aria-pressed={retrieval?.rerank === true}
              disabled={!retrieval || retrievalSaving}
              title="语义重排为可选开关（默认关闭）；后端是哈希向量时会自动降级为词法，不会静默冒充语义"
              onClick={() => void toggleRerank()}
            >
              语义重排：{retrieval?.rerank ? '已开启' : '已关闭'}
              {retrieval?.rerank && !retrieval.semantic ? '（后端不支持，已降级词法）' : ''}
            </button>
            {onOpenEmbedSettings && (
              <button
                className="btn btn--ghost btn--sm"
                data-testid="knowledge-open-embed-settings"
                title="打开设置并定位到「语义检索」段，配置模型服务的 /embeddings"
                onClick={onOpenEmbedSettings}
              >
                <Icon name="settings" size={13} />
                配置语义检索
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="state state--inline state--error" role="alert" data-testid="knowledge-error">
            <span className="state__title">读取失败</span>
            <span className="state__detail">{error}</span>
          </div>
        )}

        <div className="knowledge__body">
          {loading ? (
            <div className="state state--loading" role="status" data-testid="knowledge-loading">
              <span className="spinner" aria-hidden="true" />
              <div className="state__detail">正在读取已发布条目…</div>
            </div>
          ) : entries.length === 0 && emptyState ? (
            <div className="state state--empty" data-testid="knowledge-empty">
              <div className="state__title">{emptyState.title}</div>
              <p className="state__detail">{emptyState.detail}</p>
              <ol className="state__steps" data-testid="knowledge-empty-steps">
                {emptyState.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {onOpenStaging && (
                <div className="state__actions">
                  <button
                    className="btn btn--primary"
                    data-testid="knowledge-empty-open-staging"
                    onClick={onOpenStaging}
                  >
                    打开暂存区…
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* PD50：按论文分组——四篇论文拆解出的条目不再混成一锅 */
            <div className="knowledge-groups" data-testid="knowledge-list">
              {groups.map((group) => {
                const collapsed = collapsedGroups[group.key] === true
                return (
                  <section
                    className="knowledge-group"
                    key={group.key}
                    data-testid={`knowledge-group-${group.key}`}
                    data-paper-item-id={group.paperItemId ?? ''}
                  >
                    <button
                      className="knowledge-group__head"
                      data-testid={`knowledge-group-toggle-${group.key}`}
                      aria-expanded={!collapsed}
                      onClick={() => toggleGroup(group.key)}
                    >
                      <Icon
                        name={collapsed ? 'chevron-down' : 'chevron-up'}
                        size={13}
                        className="knowledge-group__chevron"
                      />
                      <span className="knowledge-group__title" title={group.paperTitle}>
                        {group.paperTitle}
                      </span>
                      <span className="knowledge-group__count">{group.entries.length} 条</span>
                    </button>
                    {!collapsed && (
                      <ul className="knowledge-list">
                        {group.entries.map((entry) => {
                          const expanded = expandedId === entry.id
                          const detail = details[entry.id]
                          return (
                            <li
                              className="knowledge-entry"
                              key={entry.id}
                              data-testid={`knowledge-entry-${entry.id}`}
                            >
                              <button
                                className="knowledge-entry__main"
                                data-testid={`knowledge-expand-${entry.id}`}
                                aria-expanded={expanded}
                                onClick={() => void toggleEntry(entry)}
                              >
                                <span className="knowledge-entry__title">{entry.title}</span>
                                <span className="knowledge-entry__chips">
                                  <span
                                    className="stage-chip stage-chip--paper"
                                    data-testid={`knowledge-entry-paper-${entry.id}`}
                                    title={paperLabel(entry)}
                                  >
                                    {paperLabel(entry)}
                                  </span>
                                  <span className="stage-chip stage-chip--muted">
                                    {KIND_LABEL[entry.kind] ?? entry.kind}
                                  </span>
                                  <span className="stage-chip stage-chip--muted">
                                    {NATURE_LABEL[entry.contentNature] ?? entry.contentNature}
                                  </span>
                                  <span className="knowledge-entry__version">v{entry.version}</span>
                                </span>
                                <span className="knowledge-entry__time">
                                  {formatTime(entry.updatedAt)}
                                </span>
                              </button>
                              {expanded && (
                                <>
                                  <div
                                    className="knowledge-entry__body"
                                    data-testid={`knowledge-entry-body-${entry.id}`}
                                  >
                                    {detailLoadingId === entry.id && !detail ? (
                                      '正在读取正文…'
                                    ) : (
                                      <KnowledgeMarkdown source={detail?.body ?? ''} />
                                    )}
                                  </div>
                                  {detail && detail.evidence.length > 0 && (
                                    <section
                                      className="stage-detail__section"
                                      data-testid={`knowledge-evidence-${entry.id}`}
                                    >
                                      <h5>来源证据（{detail.evidence.length}）</h5>
                                      <ul className="stage-evidence">
                                        {detail.evidence.map((evidence, index) => {
                                          const label = evidencePrecisionLabel(evidence)
                                          return (
                                            <li
                                              className="stage-evidence__item"
                                              key={`${entry.id}-ev-${index}`}
                                              data-testid={`knowledge-evidence-item-${entry.id}-${index}`}
                                            >
                                              <div className="stage-evidence__head">
                                                {label && (
                                                  <span
                                                    className={`stage-chip stage-chip--${evidencePrecisionTone(evidence)}`}
                                                    data-testid={`knowledge-evidence-precision-${entry.id}-${index}`}
                                                    title="证据定位精度：模块级需同时有模块 id 与字符区间，否则只能定位到页"
                                                  >
                                                    {label}
                                                  </span>
                                                )}
                                                {evidence.moduleId && (
                                                  <span className="stage-evidence__loc">
                                                    模块 {evidence.moduleId}
                                                  </span>
                                                )}
                                                {evidence.pageIndex !== null && (
                                                  <span className="stage-evidence__loc">
                                                    第 {evidence.pageIndex + 1} 页
                                                  </span>
                                                )}
                                                {evidence.sectionPath && (
                                                  <span className="stage-evidence__loc">
                                                    {evidence.sectionPath}
                                                  </span>
                                                )}
                                              </div>
                                              <blockquote className="stage-evidence__quote">
                                                <CiteText text={evidence.quote || '（引文为空）'} />
                                              </blockquote>
                                            </li>
                                          )
                                        })}
                                      </ul>
                                    </section>
                                  )}
                                </>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </section>
                )
              })}
            </div>
          )}
        </div>

        <footer className="stage__footer">
          <span className="stage__footer-hint">
            共 {entries.length} 条已发布条目；修改或新增都要在暂存区审核提案后再发布。
          </span>
        </footer>
      </div>
    </div>
  )
}
