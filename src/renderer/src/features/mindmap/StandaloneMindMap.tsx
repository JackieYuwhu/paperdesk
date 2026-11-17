import { useEffect, useState } from 'react'
import { MindMapPanel } from './MindMapPanel'

export interface StandaloneMindMapProps {
  itemId: number
}

/**
 * `?mwindow=<itemId>` 独立窗口：只渲染这一篇论文的思维地图。
 *
 * 标题由主进程按条目设置；这里再取一次条目，既用于新建空白地图时确定根节点标题，
 * 也避免标题还没读到就先建出一棵「未命名文献」的树。
 */
export function StandaloneMindMap({ itemId }: StandaloneMindMapProps): React.JSX.Element {
  const [title, setTitle] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    setReady(false)
    void window.api.library
      .get(itemId)
      .then((item) => {
        if (cancelled) return
        setTitle(item?.title ?? null)
        setReady(true)
      })
      .catch(() => {
        if (cancelled) return
        setTitle(null)
        setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [itemId])

  if (!ready) {
    return (
      <div className="mindmap mindmap--standalone">
        <div className="mindmap__loading">载入中…</div>
      </div>
    )
  }

  return (
    <MindMapPanel
      itemId={itemId}
      title={title}
      variant="standalone"
      onClose={() => window.close()}
    />
  )
}
