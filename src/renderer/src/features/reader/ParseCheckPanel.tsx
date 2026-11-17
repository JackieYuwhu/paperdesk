import { useEffect, useMemo, useRef } from 'react'
import type { StructuredBlock } from '@shared/blocks'
import {
  collapseWhitespace,
  summarize,
  toRows,
  type BlockReason,
  type BlockStatus
} from '@shared/blocks-view'
import './parse-check.css'

interface Props {
  /** 结构化块（`blocks` 适配层产物；缺失时显示空态） */
  blocks: readonly StructuredBlock[] | null | undefined
  /** 点击/回车选中一行时回调上层（后续接 PDF 高亮） */
  onSelect: (stableId: string) => void
  /** 当前选中块（可选，用于高亮） */
  selectedId?: string | null
  /** 正在读取块标注（可选） */
  loading?: boolean
  /** 读取块标注失败信息（可选） */
  error?: string
  /** 没有块时的**原因**（可选）：如「结构化块未启用」/「块标注为空」 */
  emptyReason?: string
  /** 没有块时的**开启方法**（可选，默认给出 PAPERDESK_BLOCKS_ADAPTER 的开启步骤） */
  emptyHint?: string
}

/**
 * 空态默认开启说明：面板拿不到 blocks 时不留空白，明确告诉用户怎么让数据出现。
 * 首选路径是应用内开关（设置 → 结构化解析（实验））；环境变量只作备选。
 */
const DEFAULT_EMPTY_HINT =
  '开启方法：打开「设置 → 结构化解析（实验）」里的开关（切换即保存），然后重新解析该文档，解析产物才会带上 blocks 块标注。' +
  '备选：也可设置环境变量 PAPERDESK_BLOCKS_ADAPTER=1 后重启应用再重新解析。'

const STATUS_LABELS: Record<BlockStatus, string> = {
  ok: '正常',
  warn: '可疑',
  error: '错误'
}

const REASON_LABELS: Record<BlockReason, string> = {
  'missing-page': '缺少页码',
  'missing-bbox': '缺少坐标',
  'unknown-type': '未知类型',
  orphan: '未对齐模块',
  'empty-text': '正文为空'
}

const TYPE_LABELS: Record<string, string> = {
  paragraph: '正文',
  heading: '标题',
  caption: '题注',
  equation: '公式',
  'equation-number': '公式号',
  reference: '参考文献'
}

function formatBbox(bbox: readonly [number, number, number, number] | null): string {
  return bbox ? bbox.map((n) => Math.round(n)).join(',') : '—'
}

/**
 * 解析检查面板（只读）：按阅读顺序逐块展示 序号 / 类型 / 状态 / 页码与坐标 / 文本摘要。
 * 行可键盘聚焦，Enter 或空格触发 `onSelect(stableId)`。
 */
export function ParseCheckPanel({
  blocks,
  onSelect,
  selectedId = null,
  loading = false,
  error = '',
  emptyReason = '',
  emptyHint = DEFAULT_EMPTY_HINT
}: Props): React.JSX.Element {
  const rows = useMemo(() => toRows(blocks), [blocks])
  const summary = useMemo(() => summarize(rows), [rows])
  const fullTexts = useMemo(
    () => (Array.isArray(blocks) ? blocks.map((b) => collapseWhitespace(b?.text)) : []),
    [blocks]
  )
  const types = useMemo(
    () =>
      Object.entries(summary.byType).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      ),
    [summary]
  )

  // 反向联动：外部传入的 selectedId（面板点击或 PDF 页面点选）变化时，
  // 把对应行滚动到可视区（block:'nearest' 不打断当前滚动位置，仅最小滚动）。
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!selectedId) return
    const list = listRef.current
    if (!list) return
    const row = list.querySelector(`[data-stable-id="${CSS.escape(selectedId)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  return (
    <aside className="parse-check" data-testid="parse-check-panel" aria-label="解析检查（只读）">
      <header className="parse-check__head">
        <div className="parse-check__titlebar">
          <span className="parse-check__title">解析检查</span>
          <span className="parse-check__total" data-testid="parse-check-total">
            共 {summary.total} 块
          </span>
        </div>
        <div className="parse-check__counts">
          <span className="parse-check__count parse-check__count--ok">正常 {summary.ok}</span>
          <span className="parse-check__count parse-check__count--warn">可疑 {summary.warn}</span>
          <span className="parse-check__count parse-check__count--error">错误 {summary.error}</span>
        </div>
        {types.length > 0 && (
          <div className="parse-check__types">
            {types.map(([type, count]) => (
              <span key={type} className="parse-check__chip" title={type}>
                {TYPE_LABELS[type] ?? type} {count}
              </span>
            ))}
          </div>
        )}
      </header>
      <div ref={listRef} className="parse-check__list" role="list" aria-label="结构化块列表">
        {loading ? (
          <div className="parse-check__empty">正在读取块标注…</div>
        ) : error ? (
          <div className="parse-check__empty parse-check__empty--error">{error}</div>
        ) : rows.length === 0 ? (
          <div className="parse-check__empty" data-testid="parse-check-empty">
            <div className="parse-check__empty-reason" data-testid="parse-check-empty-reason">
              {emptyReason || '没有块数据'}
            </div>
            <div className="parse-check__empty-hint" data-testid="parse-check-empty-hint">
              {emptyHint}
            </div>
          </div>
        ) : (
          rows.map((row) => {
            const reasonText = row.reasons.map((r) => REASON_LABELS[r]).join('、')
            const statusText = reasonText
              ? `${STATUS_LABELS[row.status]}：${reasonText}`
              : STATUS_LABELS[row.status]
            const fullText = fullTexts[row.index - 1] || '（空文本）'
            return (
              <div
                key={`${row.index}-${row.stableId}`}
                className={`parse-check__row parse-check__row--${row.status}${
                  row.stableId === selectedId ? ' is-selected' : ''
                }`}
                role="listitem"
                tabIndex={0}
                data-testid="parse-check-row"
                data-stable-id={row.stableId}
                data-status={row.status}
                title={statusText}
                onClick={() => onSelect(row.stableId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(row.stableId)
                  }
                }}
              >
                <span className="parse-check__index">{row.index}</span>
                <span className="parse-check__type" title={row.type || '未知类型'}>
                  {TYPE_LABELS[row.type] ?? (row.type || '—')}
                </span>
                <span
                  className={`parse-check__dot parse-check__dot--${row.status}`}
                  role="img"
                  aria-label={`状态：${statusText}`}
                  title={statusText}
                />
                <span
                  className="parse-check__loc"
                  title={
                    row.page == null
                      ? '缺少页码'
                      : `第 ${row.page} 页 · ${formatBbox(row.bbox)}`
                  }
                >
                  {row.page == null ? 'p.—' : `p.${row.page}`}
                  <span className="parse-check__bbox"> {formatBbox(row.bbox)}</span>
                </span>
                <span className="parse-check__text" title={fullText}>
                  {row.preview || '（空文本）'}
                </span>
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}
