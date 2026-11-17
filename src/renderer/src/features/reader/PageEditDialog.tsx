import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'

/**
 * 页面编辑：删除页 + 版本撤销/恢复。
 *
 * 交互约束（对应需求）：
 * - 删除前用缩略图 + 页码核对，不能删除全部页面；
 * - 原文件由主进程备份到版本目录，删除后可撤销，重启后仍能恢复；
 * - 删页会移除旧译文（提示需重新生成），避免原文/译文页码错配。
 */
export function PageEditDialog({
  attachmentId,
  pageCount,
  onClose,
  onApplied
}: {
  attachmentId: number
  pageCount: number
  onClose: () => void
  /** 删除/恢复成功后通知外层重新加载 PDF */
  onApplied: () => void
}): React.JSX.Element {
  const [thumbs, setThumbs] = useState<{ page: number; png: string }[]>([])
  const [total, setTotal] = useState(pageCount)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [versions, setVersions] = useState<
    Awaited<ReturnType<typeof window.api.reader.pageEdits>>
  >([])

  const load = useCallback(async () => {
    setError('')
    try {
      const [t, v] = await Promise.all([
        window.api.reader.pageThumbs(attachmentId),
        window.api.reader.pageEdits(attachmentId)
      ])
      setThumbs(t.thumbs)
      setTotal(t.pageCount)
      setVersions(v)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [attachmentId])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = (page: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(page)) next.delete(page)
      else next.add(page)
      return next
    })
  }

  const runDelete = async (): Promise<void> => {
    const pages = [...selected].sort((a, b) => a - b)
    if (pages.length === 0 || busy) return
    setBusy(true)
    setError('')
    setWarnings([])
    try {
      const r = await window.api.reader.deletePages(attachmentId, pages)
      setWarnings(r.warnings ?? [])
      setSelected(new Set())
      onApplied()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const runRestore = async (versionId: number): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const r = await window.api.reader.restorePageEdit(versionId)
      setWarnings(r.warnings ?? [])
      onApplied()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const allSelected = total > 0 && selected.size >= total

  return (
    <div className="modal" role="dialog" aria-modal="true" data-testid="page-edit">
      <div className="page-edit__panel">
        <div className="page-edit__head">
          <strong>页面管理</strong>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            共 {total} 页 · 删除会生成新版本，原文件保留
          </span>
          <button className="icon ghost" onClick={onClose} title="关闭" data-testid="page-edit-close">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="page-edit__grid" data-testid="page-edit-grid">
          {thumbs.map((t) => {
            const on = selected.has(t.page)
            return (
              <button
                key={t.page}
                className={`page-edit__item${on ? ' is-on' : ''}`}
                onClick={() => toggle(t.page)}
                title={`第 ${t.page + 1} 页${on ? '（已选中）' : ''}`}
                data-testid={`page-edit-item-${t.page + 1}`}
                style={{ border: on ? '2px solid var(--accent)' : undefined }}
              >
                <img src={`data:image/png;base64,${t.png}`} alt={`第 ${t.page + 1} 页`} />
                <span className="page-edit__no">{t.page + 1}</span>
              </button>
            )
          })}
        </div>

        <div className="page-edit__actions">
          <span className="muted" style={{ fontSize: 12 }}>
            已选 {selected.size} 页{allSelected ? '（不能删除全部页面）' : ''}
          </span>
          <span style={{ flex: 1 }} />
          <button
            className="ghost"
            onClick={() => setSelected(new Set())}
            disabled={busy || selected.size === 0}
          >
            清空选择
          </button>
          <button
            className="danger"
            onClick={() => void runDelete()}
            disabled={busy || selected.size === 0 || allSelected}
            data-testid="page-delete-run"
            title={allSelected ? '至少保留 1 页' : '删除所选的页面（可撤销）'}
          >
            <Icon name="trash" size={14} />
            {busy ? '处理中…' : `删除所选（${selected.size}）`}
          </button>
        </div>

        {error && (
          <div className="page-edit__msg error" data-testid="page-edit-error">
            {error}
          </div>
        )}
        {warnings.length > 0 && (
          <ul className="page-edit__msg" data-testid="page-edit-warnings">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        <div className="page-edit__versions">
          <div className="page-edit__versions-title">历史版本（可恢复）</div>
          {versions.length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>
              还没有编辑记录
            </div>
          ) : (
            <ul data-testid="page-edit-versions">
              {versions.map((v) => (
                <li key={v.id} className="page-edit__version">
                  <span className="muted">{new Date(v.createdAt).toLocaleString()}</span>
                  <span>
                    删除 {v.removed.length} 页（{v.removed.map((p) => p + 1).join('、')}） · 页数{' '}
                    {v.pageCountFrom} → {v.pageCountTo}
                  </span>
                  <span style={{ flex: 1 }} />
                  {v.undoneAt ? (
                    <span className="muted" style={{ fontSize: 12 }}>
                      已撤销
                    </span>
                  ) : (
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() => void runRestore(v.id)}
                      data-testid={`page-edit-restore-${v.id}`}
                      title="恢复到这个版本（恢复原文件与该版本前的批注页号）"
                    >
                      撤销/恢复
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
