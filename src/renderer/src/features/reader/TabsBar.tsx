import type { Item } from '@shared/types'
import { Icon } from '../../components/Icon'

interface Props {
  docs: Item[]
  activeId: number | null
  onSelect: (id: number) => void
  onClose: (id: number) => void
}

const MAX_TITLE = 18

function truncate(s: string): string {
  return s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE)}…` : s
}

/** 多文档「文件标签栏」：每篇论文一个标签，可横向滚动；溢出时用下拉切换 */
export function TabsBar({ docs, activeId, onSelect, onClose }: Props): React.JSX.Element {
  return (
    <div className="doc-tabs" data-testid="doc-tabs">
      {docs.map((d) => {
        const title = d.title ?? '未命名'
        return (
          <div
            key={d.id}
            className={`doc-tab${d.id === activeId ? ' on' : ''}`}
            data-testid={`doc-tab-${d.id}`}
            title={title}
            onClick={() => onSelect(d.id)}
          >
            <span className="doc-tab__title">{truncate(title)}</span>
            <button
              className="doc-tab__close"
              data-testid={`doc-tab-close-${d.id}`}
              title="关闭该标签"
              onClick={(e) => {
                e.stopPropagation()
                onClose(d.id)
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )
      })}
      {docs.length > 1 && (
        <select
          className="doc-tabs__menu"
          data-testid="doc-tabs-menu"
          title="全部已打开文档"
          value={activeId ?? ''}
          onChange={(e) => onSelect(Number(e.target.value))}
        >
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title ?? '未命名'}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
