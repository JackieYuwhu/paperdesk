import type { DiffRow } from '@shared/diff'

export interface ProposalDiffProps {
  /** 行级差异：left=发布前，right=提案后（由主进程 IPC 用 shared/diff.ts 生成） */
  rows: DiffRow[]
  stats?: { added: number; removed: number; same: number }
  /** 没有差异时的提示（例如新增提案没有基线） */
  emptyText?: string
}

const SIGN: Record<DiffRow['type'], string> = { '=': ' ', '-': '−', '+': '+' }

const KIND: Record<DiffRow['type'], string> = { '=': 'same', '-': 'del', '+': 'add' }

/**
 * 提案差异视图：只渲染，不做 diff 计算。
 * 差异行统一来自 `@shared/diff`（主进程 proposalGet 生成），避免渲染层另写一套比较逻辑。
 */
export function ProposalDiff({ rows, stats, emptyText }: ProposalDiffProps): React.JSX.Element {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) {
    return (
      <div className="pdiff pdiff--empty" data-testid="proposal-diff">
        <span className="pdiff__empty">{emptyText ?? '没有可显示的差异'}</span>
      </div>
    )
  }
  const added = stats?.added ?? list.filter((row) => row.type === '+').length
  const removed = stats?.removed ?? list.filter((row) => row.type === '-').length
  const same = stats?.same ?? list.filter((row) => row.type === '=').length
  return (
    <div className="pdiff" data-testid="proposal-diff">
      <div className="pdiff__stats" data-testid="proposal-diff-stats">
        <span className="pdiff__stat pdiff__stat--add">+{added}</span>
        <span className="pdiff__stat pdiff__stat--del">−{removed}</span>
        <span className="pdiff__stat">未变 {same}</span>
      </div>
      <div className="pdiff__body">
        {list.map((row, index) => (
          <div
            key={`${row.type}-${index}`}
            className={`pdiff__row pdiff__row--${KIND[row.type]}`}
            data-testid={`proposal-diff-row-${KIND[row.type]}`}
          >
            <span className="pdiff__sign" aria-hidden="true">
              {SIGN[row.type]}
            </span>
            <span className="pdiff__text">
              {row.type === '-' ? (row.left ?? '') : row.type === '+' ? (row.right ?? '') : (row.right ?? row.left ?? '')}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
