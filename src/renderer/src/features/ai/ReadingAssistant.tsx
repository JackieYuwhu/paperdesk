import { useState, type ReactNode } from 'react'

/** Modeless: the paper stays interactive while a question is open. */
export function ReadingAssistant({ children, onClose }: { children: ReactNode; onClose: () => void }): React.JSX.Element {
  const [minimized, setMinimized] = useState(false)
  const [pos, setPos] = useState({ x: Math.max(8, window.innerWidth - 500), y: 96 })
  return <section className={`reading-assistant${minimized ? ' reading-assistant--min' : ''}`}
    role="dialog" aria-label="阅读 AI 助手" data-testid="reading-assistant"
    style={{ left: pos.x, top: pos.y }}>
    <header onPointerDown={(event) => {
      if ((event.target as HTMLElement).closest('button')) return
      const header = event.currentTarget
      const dx = event.clientX - pos.x, dy = event.clientY - pos.y
      header.setPointerCapture(event.pointerId)
      header.onpointermove = (e) => setPos({
        x: Math.max(0, Math.min(window.innerWidth - 100, e.clientX - dx)),
        y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy))
      })
      header.onpointerup = () => { header.onpointermove = null }
      header.onpointercancel = () => { header.onpointermove = null }
    }}><strong>阅读 AI 助手</strong><span />
      <button aria-label={minimized ? '展开助手' : '最小化助手'} onClick={() => setMinimized(!minimized)}>{minimized ? '展开' : '−'}</button>
      <button aria-label="关闭助手" onClick={onClose}>×</button>
    </header>
    <div className="reading-assistant__body" hidden={minimized}>{children}</div>
  </section>
}
