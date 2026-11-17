import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import type { OpenTarget } from '../../modules/registry'
import type { ViewMode } from '../translate/TranslationPanel'
import type { FsEntry, FsListing, TranslationTarget } from '@shared/types'

interface Props {
  active: boolean
  onOpenTarget: (t: OpenTarget) => void
  onOpenPanel: (id: string) => void
  onOpenTranslation: (t: TranslationTarget, mode: ViewMode) => void
}

function fmtSize(n: number): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const KIND_ICON: Record<string, string> = {
  pdf: 'book',
  md: 'notes',
  html: 'file',
  json: 'file',
  sqlite: 'layers'
}

function iconFor(e: FsEntry): string {
  if (e.isDir) return 'folder'
  const ext = e.name.split('.').pop()?.toLowerCase() ?? ''
  return KIND_ICON[ext] ?? 'file'
}

/** 文件面板：data/ 目录树（Obsidian 式可视化）+ VSCode 式打开 */
export function FsPanel({ active, onOpenTarget, onOpenPanel, onOpenTranslation }: Props): React.JSX.Element {
  const [listing, setListing] = useState<FsListing | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (path = ''): Promise<void> => {
    setBusy(true)
    setStatus('')
    try {
      setListing(await window.api.files.list(path))
    } catch (e) {
      setStatus('读取失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load('')
  }, [load])

  // 面板重新激活时刷新（产物可能刚生成）
  useEffect(() => {
    if (active) void load(listing?.path ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setStatus(label + '…')
    try {
      await fn()
      setStatus(label + '完成')
    } catch (e) {
      setStatus(label + '失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  // 双击 / 「打开」：库内 PDF → 阅读器；译文产物 → 译文视图；笔记 .md → 笔记面板；否则交给系统
  const openEntry = async (e: FsEntry): Promise<void> => {
    if (e.isDir) {
      void load(e.path)
      return
    }
    if (/\.pdf$/i.test(e.name)) {
      try {
        const att = await window.api.attachments.getByPath(e.path)
        if (att) {
          onOpenTarget({ itemId: att.item_id, attachmentId: att.id, page: 1 })
          setStatus(`已在阅读器打开 ${e.name}`)
          return
        }
      } catch {
        /* 继续尝试译文/系统 */
      }
      try {
        const t = await window.api.translate.getByPath(e.path)
        if (t) {
          onOpenTranslation(t, 'bilingual')
          onOpenPanel('translate')
          setStatus(`已在译文视图打开 ${e.name}`)
          return
        }
      } catch {
        /* 回退系统打开 */
      }
    }
    if (/\.md$/i.test(e.name)) {
      try {
        const note = await window.api.notes.getByPath(e.path)
        if (note) {
          onOpenTarget({ itemId: note.item_id, attachmentId: null, page: null })
          onOpenPanel('notes')
          setStatus(`已在笔记面板打开 ${e.name}`)
          return
        }
      } catch {
        /* 回退系统打开 */
      }
    }
    await act('打开', () => window.api.files.open(e.path))
  }

  return (
    <div className="panel">
      <div className="panel__bar">
        <button
          className="icon ghost"
          title="上级目录"
          disabled={listing?.parent == null}
          onClick={() => void load(listing?.parent ?? '')}
        >
          <Icon name="left" size={16} />
        </button>
        <span className="fs__path" title={listing?.path ?? ''}>
          data/{listing?.path ?? ''}
        </span>
        <span className="toolbar__spacer" />
        <button className="icon ghost" title="刷新" onClick={() => void load(listing?.path ?? '')}>
          <Icon name="refresh" size={15} />
        </button>
      </div>
      {status && <div className="panel__status">{status}</div>}

      {busy && !listing ? (
        <div className="list__hint">加载中…</div>
      ) : !listing || listing.entries.length === 0 ? (
        <div className="empty">
          <Icon name="folder" size={26} />
          <span>此目录为空</span>
        </div>
      ) : (
        <div className="fs__list" data-testid="fs-list">
          {listing.entries.map((e) => (
            <div
              key={e.path}
              className="fs__row"
              onDoubleClick={() => void openEntry(e)}
            >
              <button
                className="fs__name"
                title={e.isDir ? '进入目录' : '打开文件'}
                onClick={() => (e.isDir ? void load(e.path) : undefined)}
              >
                <Icon name={iconFor(e)} size={15} />
                <span className="fs__label">{e.name}</span>
              </button>
              <span className="fs__size">{e.isDir ? '目录' : fmtSize(e.size)}</span>
              <span className="fs__actions">
                {!e.isDir && (
                  <button
                    className="icon ghost"
                    title="打开（库内 PDF 在阅读器中打开）"
                    onClick={() => void openEntry(e)}
                  >
                    <Icon name="external" size={14} />
                  </button>
                )}
                <button
                  className="icon ghost"
                  title="用 VS Code 打开"
                  onClick={() => void act('用 VS Code 打开', () => window.api.files.vscode(e.absPath))}
                >
                  <Icon name="file" size={14} />
                </button>
                <button
                  className="icon ghost"
                  title="在文件管理器中显示"
                  onClick={() => void act('显示', () => window.api.files.reveal(e.absPath))}
                >
                  <Icon name="folder" size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
