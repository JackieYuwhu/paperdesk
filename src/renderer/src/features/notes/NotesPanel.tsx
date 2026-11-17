import { useCallback, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon } from '../../components/Icon'
import { slugifyHeading } from '@shared/slug'
import type { NoteWithContent } from '@shared/types'

/** 从 React 子节点里提取纯文本（用于给标题生成锚点 id） */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) {
    return textOf((node as { props?: { children?: ReactNode } }).props?.children)
  }
  return ''
}

interface Props {
  itemId: number | null
  /** 变化时强制重新载入（例如刚把批注加入笔记） */
  refreshSignal: number
  onDeepLink: (url: string) => void
}

export function NotesPanel({ itemId, refreshSignal, onDeepLink }: Props): React.JSX.Element {
  const [note, setNote] = useState<NoteWithContent | null>(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [status, setStatus] = useState('')

  const load = useCallback(async (): Promise<void> => {
    if (itemId == null) {
      setNote(null)
      setDraft('')
      setDirty(false)
      return
    }
    const n = await window.api.notes.getForItem(itemId)
    setNote(n)
    setDraft(n?.content ?? '')
    setDirty(false)
  }, [itemId])

  useEffect(() => {
    void load()
  }, [load, refreshSignal])

  const create = async (): Promise<void> => {
    if (itemId == null) return
    const n = await window.api.notes.create(itemId)
    setNote(n)
    setDraft(n.content)
    setDirty(false)
    setMode('edit')
  }

  const save = async (): Promise<void> => {
    if (!note) return
    const updated = await window.api.notes.save(note.note.id, draft)
    setNote({ note: updated, content: draft })
    setDirty(false)
    setStatus(`已保存 ${new Date().toLocaleTimeString()}`)
  }

  if (itemId == null) {
    return (
      <aside className="notes">
        <div className="notes__header">
          <span className="sidebar__title">笔记</span>
        </div>
        <div className="notes__empty">
          <Icon name="book" size={26} />
          <p>先选择一篇论文</p>
        </div>
      </aside>
    )
  }

  return (
    <aside className="notes">
      <div className="notes__header">
        <span className="sidebar__title">笔记</span>
        {note && (
          <div className="seg">
            <button className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>
              编辑
            </button>
            <button className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>
              预览
            </button>
          </div>
        )}
      </div>

      {note?.note.md_path && (
        <div className="notes__file" data-testid="note-file">
          <span className="meta__muted" title={note.note.md_path}>
            {note.note.md_path}
          </span>
          <span className="toolbar__spacer" />
          <button
            className="icon ghost"
            title="在 VS Code 打开 .md"
            onClick={() => void window.api.files.vscode(note.note.md_path as string)}
          >
            <Icon name="file" size={13} />
          </button>
          <button
            className="icon ghost"
            title="在文件管理器中显示"
            onClick={() => void window.api.files.reveal(note.note.md_path as string)}
          >
            <Icon name="folder" size={13} />
          </button>
          <button
            className="icon ghost"
            title="用默认程序打开"
            onClick={() => void window.api.files.open(note.note.md_path as string)}
          >
            <Icon name="external" size={13} />
          </button>
        </div>
      )}

      {!note ? (
        <div className="notes__empty">
          <Icon name="notes" size={26} />
          <p>这篇论文还没有笔记。阅读时选中文字可「加入笔记」，也可以直接新建。</p>
          <button className="primary" onClick={() => void create()}>
            <Icon name="plus" size={14} />
            新建笔记
          </button>
        </div>
      ) : (
        <>
          <div className="notes__title" title={note.note.title ?? ''}>
            {note.note.title}
          </div>
          {mode === 'edit' ? (
            <textarea
              className="notes__editor"
              value={draft}
              placeholder="在这里写 Markdown 笔记…"
              data-testid="note-editor"
              onChange={(e) => {
                setDraft(e.target.value)
                setDirty(true)
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                  e.preventDefault()
                  void save()
                }
              }}
              onBlur={() => {
                // 失焦自动保存：避免「有保存键却像被禁用」导致内容丢失
                if (dirty) void save()
              }}
            />
          ) : (
            <div className="notes__preview">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                // 允许 paperdesk:// 自定义协议（默认白名单会剥掉它）
                urlTransform={(url) => url}
                components={{
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      onClick={(e) => {
                        e.preventDefault()
                        if (!href) return
                        // 站内锚点（如笔记目录）在预览面板内滚动
                        if (href.startsWith('#')) {
                          const el = document.getElementById(
                            decodeURIComponent(href.slice(1))
                          )
                          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                          return
                        }
                        if (href.startsWith('paperdesk://')) onDeepLink(href)
                        else void window.api.app.openExternal(href)
                      }}
                    >
                      {children}
                    </a>
                  ),
                  h1: ({ children }) => (
                    <h1 id={slugifyHeading(textOf(children))}>{children}</h1>
                  ),
                  h2: ({ children }) => (
                    <h2 id={slugifyHeading(textOf(children))}>{children}</h2>
                  ),
                  h3: ({ children }) => (
                    <h3 id={slugifyHeading(textOf(children))}>{children}</h3>
                  )
                }}
              >
                {draft || '_（空）_'}
              </ReactMarkdown>
            </div>
          )}
          <div className="notes__footer">
            <span className="notes__status">{dirty ? '未保存' : status}</span>
            <span className="toolbar__spacer" />
            <button
              className="primary"
              data-testid="note-save"
              title="保存笔记（Ctrl/Cmd+S）"
              onClick={() => void save()}
            >
              <Icon name="check" size={14} />
              保存
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
