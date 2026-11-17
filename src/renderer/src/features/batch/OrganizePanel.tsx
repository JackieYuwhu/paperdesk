import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../../components/Icon'
import {
  summarizeDraft,
  organizePurposeLabel,
  organizeTargetLabel,
  organizeEntryKindLabel,
  organizeNodeKindLabel,
  type OrganizeDraft,
  type OrganizeDraftEntry,
  type OrganizeDraftNode,
  type OrganizePreviewResult,
  type OrganizePurpose,
  type OrganizeTarget,
  type OrganizeVersionRow
} from '@shared/organize'
import type { OrganizeApplyResult } from '@shared/organize'

interface Props {
  /** 来自批处理的作业批次；为空表示从文库直接选择论文 */
  runId?: string | null
  itemIds?: number[] | null
  groupName?: string | null
  onClose: () => void
  /** 保存后跳到思维地图 / 知识库查看（可选） */
  onOpenResult?: (target: OrganizeTarget, itemId: number | null) => void
}

interface CandidateRow {
  itemId: number
  title: string
  hasText: boolean
}

export function OrganizePanel({
  runId = null,
  itemIds = null,
  groupName = null,
  onClose,
  onOpenResult
}: Props): React.JSX.Element {
  const [target, setTarget] = useState<OrganizeTarget>(runId ? 'mindmap' : 'knowledge')
  const [purpose, setPurpose] = useState<OrganizePurpose>(runId ? 'structure' : 'evidence')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<OrganizePreviewResult | null>(null)
  const [drafts, setDrafts] = useState<OrganizeDraft[]>([])
  const [activeDraft, setActiveDraft] = useState(0)
  const [candidates, setCandidates] = useState<CandidateRow[]>([])
  const [picked, setPicked] = useState<Set<number>>(new Set(itemIds ?? []))
  const [editing, setEditing] = useState<{ draft: number; nodeId: string } | null>(null)
  const [editText, setEditText] = useState('')
  const [editingEntry, setEditingEntry] = useState<{ draft: number; key: string } | null>(null)
  const [entryDraft, setEntryDraft] = useState({ title: '', body: '' })
  const [applied, setApplied] = useState<OrganizeApplyResult | null>(null)
  const [versions, setVersions] = useState<OrganizeVersionRow[]>([])

  useEffect(() => {
    if (runId) return
    void (async () => {
      try {
        const rows = await window.api.organize.candidates()
        setCandidates(rows)
      } catch (error) {
        setMessage(`读取论文列表失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }, [runId])

  // 历史版本：打开面板就列出本批次的整理记录，不要求先生成草稿（阶段三：随时可撤销/恢复）
  useEffect(() => {
    if (!runId) return
    void (async () => {
      try {
        setVersions(await window.api.organize.versions(`run:${runId}`))
      } catch {
        setVersions([])
      }
    })()
  }, [runId])

  const draft = drafts[activeDraft] ?? null
  const summary = useMemo(() => (draft ? summarizeDraft(draft) : null), [draft])

  const togglePick = (itemId: number): void => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const chooseTarget = (next: OrganizeTarget): void => {
    setTarget(next)
    // 跨论文主题归纳与证据整理落知识库；单篇结构落思维地图（需求里就是这样分工的）
    if (next === 'mindmap' && purpose !== 'structure') setPurpose('structure')
  }

  const generate = useCallback(async (): Promise<void> => {
    setBusy(true)
    setMessage('正在整理…（读取论文内容并生成草稿）')
    setApplied(null)
    try {
      const pickedIds = runId ? null : [...picked]
      if (!runId && (pickedIds ?? []).length === 0) {
        setMessage('请先勾选要整理的论文')
        return
      }
      const preview = await window.api.organize.preview({
        runId,
        itemIds: pickedIds,
        target,
        purpose,
        title: title.trim() || null,
        groupName
      })
      setResult(preview)
      setDrafts(preview.drafts.map((item) => ({ ...item })))
      setActiveDraft(0)
      setVersions(await window.api.organize.versions(preview.scopeKey).catch(() => []))
      setMessage(
        preview.drafts.length === 0
          ? preview.warnings[0] ?? '没有可整理的内容'
          : `草稿已生成：${preview.drafts.length} 份（${preview.engine === 'model' ? '模型整理' : '规则整理'}）——请检查来源与推断标记后再保存`
      )
    } catch (error) {
      setMessage(`整理失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [runId, picked, target, purpose, title, groupName])

  const apply = useCallback(async (): Promise<void> => {
    if (!result || drafts.length === 0) return
    setBusy(true)
    setMessage('正在保存…')
    try {
      const out = await window.api.organize.apply(drafts, {
        scopeKey: result.scopeKey,
        label: result.drafts[0]?.title ?? '智能整理'
      })
      setApplied(out)
      setVersions(await window.api.organize.versions(result.scopeKey).catch(() => []))
      setMessage(out.summary)
    } catch (error) {
      setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [result, drafts])

  const undo = useCallback(async (): Promise<void> => {
    if (!applied) return
    setBusy(true)
    try {
      const out = await window.api.organize.restore(applied.versionId)
      setMessage(out.message)
      setApplied(null)
    } catch (error) {
      setMessage(`撤销失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [applied])

  const restoreVersion = useCallback(
    async (versionId: number): Promise<void> => {
      setBusy(true)
      try {
        const out = await window.api.organize.restore(versionId)
        setMessage(out.message)
      } catch (error) {
        setMessage(`恢复失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const updateNode = (draftIndex: number, nodeId: string, text: string): void => {
    setDrafts((prev) =>
      prev.map((item, index) => {
        if (index !== draftIndex) return item
        return {
          ...item,
          nodes: item.nodes.map((node) =>
            node.id === nodeId ? { ...node, text, userEdited: true } : node
          )
        }
      })
    )
  }

  const updateEntry = (
    draftIndex: number,
    key: string,
    patch: { title: string; body: string }
  ): void => {
    setDrafts((prev) =>
      prev.map((item, index) => {
        if (index !== draftIndex) return item
        return {
          ...item,
          entries: item.entries.map((entry) =>
            entry.key === key ? { ...entry, ...patch } : entry
          )
        }
      })
    )
  }

  const renderNodes = (nodes: OrganizeDraftNode[]): React.JSX.Element[] => {
    const root = nodes.find((node) => node.parentId === null)
    if (!root) return []
    const rows: React.JSX.Element[] = []
    const walk = (node: OrganizeDraftNode, depth: number): void => {
      rows.push(
        <div
          key={node.id}
          className="org-node"
          style={{ paddingLeft: 8 + depth * 16 }}
          data-testid={`org-node-${node.id}`}
        >
          <span className="org-node__kind">{organizeNodeKindLabel(node.kind)}</span>
          <span className="org-node__text">{node.text}</span>
          {node.inferred ? (
            <span className="org-badge org-badge--infer" title="没有直接原文支撑，属于推断">
              推断
            </span>
          ) : null}
          {node.page != null ? (
            <span className="org-badge">{`p.${node.page}`}</span>
          ) : null}
          <button
            className="ghost org-node__edit"
            title="修改这段文字（保存时以你的版本为准）"
            data-testid={`org-edit-${node.id}`}
            onClick={() => {
              setEditing({ draft: activeDraft, nodeId: node.id })
              setEditText(node.text)
            }}
          >
            <Icon name="edit" size={12} />
          </button>
        </div>
      )
      for (const child of nodes.filter((item) => item.parentId === node.id)) {
        walk(child, depth + 1)
      }
    }
    walk(root, 0)
    return rows
  }

  const renderEntry = (entry: OrganizeDraftEntry): React.JSX.Element => (
    <div className="org-entry" key={entry.key} data-testid={`org-entry-${entry.key}`}>
      <div className="org-entry__head">
        <span className="org-node__kind">{organizeEntryKindLabel(entry.kind)}</span>
        <span className="org-entry__title">{entry.title}</span>
        {entry.inferred ? (
          <span className="org-badge org-badge--infer" title="没有可核对的原文证据">
            推断
          </span>
        ) : null}
        <button
          className="ghost org-node__edit"
          data-testid={`org-entry-edit-${entry.key}`}
          title="修改标题与正文"
          onClick={() => {
            setEditingEntry({ draft: activeDraft, key: entry.key })
            setEntryDraft({ title: entry.title, body: entry.body })
          }}
        >
          <Icon name="edit" size={12} />
        </button>
      </div>
      <div className="org-entry__body">{entry.body}</div>
      {entry.evidence.length > 0 ? (
        <div className="org-entry__evidence">
          {entry.evidence.map((item, index) => (
            <span className="org-badge" key={`${entry.key}-ev-${index}`}>
              {item.page != null ? `p.${item.page}` : '来源论文'} · {item.quote.slice(0, 24)}
              {item.quote.length > 24 ? '…' : ''}
            </span>
          ))}
        </div>
      ) : null}
      {entry.mergeInto ? (
        <div className="org-entry__merge" data-testid={`org-merge-${entry.key}`}>
          合并建议：与「{entry.mergeInto}」内容相近（{entry.mergeReason || '标题相似'}）——仅建议，未自动合并
        </div>
      ) : null}
    </div>
  )

  return (
    <div className="stage org-stage" role="dialog" aria-label="智能整理">
      <div className="stage__backdrop" onClick={onClose} />
      <div className="stage__dialog">
        <header className="stage__header">
          <div className="stage__heading">
            <Icon name="sparkles" size={15} />
            <span className="stage__title">智能整理</span>
            <span className="stage__subtitle">先生成草稿，核对来源后再生效</span>
          </div>
          <button
            className="icon ghost"
            title="关闭"
            data-testid="organize-close"
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </header>

        <div className="stage__body org-body">
          <section className="org-form" data-testid="organize-form">
            <div className="org-row">
              <span className="org-label">整理目标</span>
              <div className="org-seg">
                <button
                  className={`org-seg__btn${target === 'mindmap' ? ' is-active' : ''}`}
                  data-testid="organize-target-mindmap"
                  disabled={purpose !== 'structure'}
                  title={
                    purpose !== 'structure'
                      ? '跨论文主题归纳与证据整理写入知识库（思维地图按单篇维护）'
                      : '写入这篇文章的思维地图'
                  }
                  onClick={() => chooseTarget('mindmap')}
                >
                  思维地图
                </button>
                <button
                  className={`org-seg__btn${target === 'knowledge' ? ' is-active' : ''}`}
                  data-testid="organize-target-knowledge"
                  onClick={() => chooseTarget('knowledge')}
                >
                  知识库
                </button>
              </div>
            </div>

            <div className="org-row">
              <span className="org-label">整理目的</span>
              <div className="org-seg">
                {(['structure', 'theme', 'evidence'] as OrganizePurpose[]).map((item) => (
                  <button
                    key={item}
                    className={`org-seg__btn${purpose === item ? ' is-active' : ''}`}
                    data-testid={`organize-purpose-${item}`}
                    title={organizePurposeLabel(item)}
                    onClick={() => {
                      setPurpose(item)
                      if (item !== 'structure') setTarget('knowledge')
                    }}
                  >
                    {organizePurposeLabel(item)}
                  </button>
                ))}
              </div>
            </div>

            <div className="org-row">
              <span className="org-label">标题</span>
              <input
                className="org-input"
                data-testid="organize-title"
                placeholder="留空则自动命名"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            {runId ? (
              <div className="org-hint" data-testid="organize-scope">
                将使用该批处理中已完成的论文（未完成或内容缺失的会在结果里列出原因）
              </div>
            ) : (
              <div className="org-pick" data-testid="organize-picks">
                {candidates.length === 0 ? (
                  <div className="org-hint">正在读取论文…</div>
                ) : (
                  candidates.map((row) => (
                    <label className="org-pick__row" key={row.itemId}>
                      <input
                        type="checkbox"
                        checked={picked.has(row.itemId)}
                        onChange={() => togglePick(row.itemId)}
                      />
                      <span className="org-pick__title">{row.title}</span>
                      {!row.hasText ? <span className="org-badge">无正文</span> : null}
                    </label>
                  ))
                )}
              </div>
            )}

            <div className="org-actions">
              <button
                className="primary"
                data-testid="organize-generate"
                disabled={busy}
                onClick={() => void generate()}
              >
                {busy ? '处理中…' : result ? '重新生成草稿' : '生成草稿'}
              </button>
              {result ? (
                <button
                  data-testid="organize-apply"
                  disabled={busy || drafts.length === 0}
                  onClick={() => void apply()}
                >
                  保存整理结果
                </button>
              ) : null}
              {applied ? (
                <button data-testid="organize-undo" disabled={busy} onClick={() => void undo()}>
                  撤销本次保存
                </button>
              ) : null}
              {applied && onOpenResult ? (
                <button
                  className="ghost"
                  data-testid="organize-open"
                  onClick={() =>
                    onOpenResult(target, drafts[0]?.included[0]?.itemId ?? null)
                  }
                >
                  去查看
                </button>
              ) : null}
            </div>

            {message ? (
              <div className="org-message" data-testid="organize-message">
                {message}
              </div>
            ) : null}
          </section>

          {result && !draft ? (
            <section className="org-preview" data-testid="organize-preview">
              <div className="org-preview__head">
                <span className="org-badge org-badge--engine">
                  {result.engine === 'model' ? '模型整理' : '规则整理'}
                </span>
              </div>
              {result.warnings.length > 0 ? (
                <div className="org-note" data-testid="organize-warnings">
                  {result.warnings.map((warn, index) => (
                    <div key={`warn-${index}`}>· {warn}</div>
                  ))}
                </div>
              ) : null}
              {result.skipped.length > 0 ? (
                <div className="org-note" data-testid="organize-skipped">
                  <div className="org-note__title">未纳入的论文</div>
                  {result.skipped.map((item, index) => (
                    <div key={`skip-${index}`}>
                      · {item.title}：{item.reason}
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {result && draft ? (
            <section className="org-preview" data-testid="organize-preview">
              <div className="org-preview__head">
                <span className="org-badge org-badge--engine">
                  {result.engine === 'model' ? '模型整理' : '规则整理'}
                </span>
                {summary ? (
                  <span className="org-summary" data-testid="organize-summary">
                    {summary.text}
                  </span>
                ) : null}
              </div>

              {drafts.length > 1 ? (
                <div className="org-tabs">
                  {drafts.map((item, index) => (
                    <button
                      key={`${item.title}-${index}`}
                      className={`org-tab${index === activeDraft ? ' is-active' : ''}`}
                      data-testid={`organize-tab-${index}`}
                      onClick={() => setActiveDraft(index)}
                    >
                      {item.included[0]?.title ?? item.title}
                    </button>
                  ))}
                </div>
              ) : null}

              {draft.summary ? <div className="org-draft__summary">{draft.summary}</div> : null}

              {result.engine === 'rules' ? (
                <div className="org-warn" data-testid="organize-degraded">
                  模型不可用或输出不合法，本次是规则整理：结构来自章节标题，条目只截取原文片段，全部标为推断，请谨慎采用。
                </div>
              ) : null}

              {draft.issues.length > 0 ? (
                <div className="org-warn" data-testid="organize-issues">
                  {draft.issues.map((issue, index) => (
                    <div key={`issue-${index}`}>· {issue}</div>
                  ))}
                </div>
              ) : null}

              {result.warnings.length > 0 ? (
                <div className="org-note" data-testid="organize-warnings">
                  {result.warnings.map((warn, index) => (
                    <div key={`warn-${index}`}>· {warn}</div>
                  ))}
                </div>
              ) : null}

              {result.skipped.length > 0 ? (
                <div className="org-note" data-testid="organize-skipped">
                  <div className="org-note__title">未纳入的论文</div>
                  {result.skipped.map((item, index) => (
                    <div key={`skip-${index}`}>
                      · {item.title}：{item.reason}
                    </div>
                  ))}
                </div>
              ) : null}

              {target === 'mindmap' && result.diffs ? (
                <div className="org-diff" data-testid="organize-diff">
                  {Object.entries(result.diffs).map(([itemId, diff]) => (
                    <span className="org-badge" key={`diff-${itemId}`}>
                      #{itemId}：新增 {diff.added} · 更新 {diff.changed} · 未变 {diff.unchanged}
                      {diff.protected > 0 ? ` · 保留手改 ${diff.protected}` : ''}
                    </span>
                  ))}
                </div>
              ) : null}

              {target === 'mindmap' ? (
                <div className="org-tree" data-testid="organize-tree">
                  {renderNodes(draft.nodes)}
                </div>
              ) : (
                <div className="org-entries" data-testid="organize-entries">
                  {draft.entries.map(renderEntry)}
                </div>
              )}

              {editing && editing.draft === activeDraft ? (
                <div className="org-edit" data-testid="organize-edit-box">
                  <textarea
                    className="org-textarea"
                    data-testid="organize-edit-text"
                    value={editText}
                    onChange={(event) => setEditText(event.target.value)}
                  />
                  <div className="org-actions">
                    <button
                      className="primary"
                      data-testid="organize-edit-save"
                      onClick={() => {
                        updateNode(editing.draft, editing.nodeId, editText.trim() || editText)
                        setEditing(null)
                      }}
                    >
                      保存修改
                    </button>
                    <button className="ghost" onClick={() => setEditing(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : null}

              {editingEntry && editingEntry.draft === activeDraft ? (
                <div className="org-edit" data-testid="organize-entry-edit-box">
                  <input
                    className="org-input"
                    data-testid="organize-entry-title"
                    value={entryDraft.title}
                    onChange={(event) =>
                      setEntryDraft((prev) => ({ ...prev, title: event.target.value }))
                    }
                  />
                  <textarea
                    className="org-textarea"
                    data-testid="organize-entry-body"
                    value={entryDraft.body}
                    onChange={(event) =>
                      setEntryDraft((prev) => ({ ...prev, body: event.target.value }))
                    }
                  />
                  <div className="org-actions">
                    <button
                      className="primary"
                      data-testid="organize-entry-save"
                      onClick={() => {
                        updateEntry(editingEntry.draft, editingEntry.key, {
                          title: entryDraft.title.trim(),
                          body: entryDraft.body
                        })
                        setEditingEntry(null)
                      }}
                    >
                      保存修改
                    </button>
                    <button className="ghost" onClick={() => setEditingEntry(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {versions.length > 0 ? (
            <section className="org-versions" data-testid="organize-versions">
              <div className="org-note__title">历史版本（可恢复）</div>
              {versions.slice(0, 6).map((row) => (
                <div className="org-version" key={row.id}>
                  <span>
                    #{row.id} · {row.label} · {new Date(row.createdAt).toLocaleString()}
                  </span>
                  <button
                    className="ghost"
                    data-testid={`organize-restore-${row.id}`}
                    disabled={busy}
                    onClick={() => void restoreVersion(row.id)}
                  >
                    恢复
                  </button>
                </div>
              ))}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
