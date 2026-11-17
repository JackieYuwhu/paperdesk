import { Icon } from '../../components/Icon'

interface Props {
  /** 当前文档页数（0 表示未知） */
  numPages: number
  /** 当前页码 */
  page: number
  /** 跳转到某页 */
  onGoPage: (page: number) => void
  /** 收起左侧面板 */
  onCollapse?: () => void
}

/** 左侧「目录」面板：列出当前文档页码，点击跳转。 */
export function TocPanel({ numPages, page, onGoPage, onCollapse }: Props): React.JSX.Element {
  const pages = Array.from({ length: Math.max(0, numPages) }, (_, i) => i + 1)
  return (
    <div className="sidebar tocpanel" data-testid="toc-panel">
      <div className="sidebar__head">
        <span className="sidebar__title">目录</span>
        {onCollapse && (
          <button
            className="icon ghost"
            title="收起目录"
            data-testid="toc-collapse"
            onClick={onCollapse}
          >
            <Icon name="left" size={15} />
          </button>
        )}
      </div>
      <div className="sidebar__body">
        {pages.length === 0 ? (
          <div className="list__hint">还没有打开 PDF，无法列出目录</div>
        ) : (
          <ul className="tocpanel__list" data-testid="toc-list">
            {pages.map((p) => (
              <li key={p}>
                <button
                  className={p === page ? 'on' : ''}
                  data-testid={`toc-page-${p}`}
                  onClick={() => onGoPage(p)}
                >
                  第 {p} 页
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
