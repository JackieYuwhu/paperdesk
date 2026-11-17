import { useCallback, useEffect, useMemo, useState } from 'react'
import { vosLayout, type BiblioGraph, type BiblioKind, type BiblioNode } from '@shared/biblio'

interface Props {
  active?: boolean
  theme?: string
  onOpenTarget?: (t: {
    itemId: number | null
    attachmentId: number | null
    page: number | null
  }) => void
}

const W = 320
const H = 320
/** 聚类配色（固定小调色板，按 cluster 取模） */
const PALETTE = [
  '#3b82f6',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#ec4899',
  '#0ea5e9',
  '#ef4444',
  '#14b8a6',
  '#a855f7',
  '#84cc16'
]

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const KINDS: readonly BiblioKind[] = ['authors', 'keywords', 'coupling', 'cocitation']

function truncate(s: string, n = 14): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** 研究 → 文献网络：作者合著 / 关键词共现 / 文献耦合 / 共被引（VOS 式布局 + 节点下钻） */
export function BiblioPanel({ active, onOpenTarget }: Props): React.JSX.Element {
  const [kind, setKind] = useState<BiblioKind>('authors')
  const [graph, setGraph] = useState<BiblioGraph | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [exportMsg, setExportMsg] = useState('')

  const load = useCallback(async (k: BiblioKind): Promise<void> => {
    setBusy(true)
    setMsg('')
    try {
      const g = await window.api.biblio.get(k, 60)
      setGraph(g)
    } catch (e) {
      setMsg('加载失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }, [])

  const doExport = useCallback(
    async (format: 'pajek' | 'gexf'): Promise<void> => {
      setExportMsg('')
      try {
        const path = await window.api.biblio.export(kind, format)
        setExportMsg(path ? `已导出：${path}` : '已取消')
      } catch (e) {
        setExportMsg('导出失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [kind]
  )

  // 挂载 / 切换类型 / 面板被激活时加载
  useEffect(() => {
    if (active === false) return
    void load(kind)
  }, [kind, active, load])

  // 图变化时清空选中
  useEffect(() => {
    setPicked(null)
  }, [graph])

  // VOS 式确定性布局（从 SVG 尺寸计算，随图 / 激活状态重算）
  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>()
    if (!graph || graph.nodes.length === 0) return map
    const laid = vosLayout(graph.nodes, graph.edges, { width: W, height: H })
    for (const [id, p] of Object.entries(laid)) map.set(id, p)
    return map
  }, [graph, active])

  const maxEdgeWeight = useMemo(() => {
    if (!graph || graph.edges.length === 0) return 1
    return Math.max(1, ...graph.edges.map((e) => e.weight))
  }, [graph])

  const labelIds = useMemo(() => {
    if (!graph) return new Set<string>()
    return new Set(
      [...graph.nodes]
        .sort((a, b) => b.weight - a.weight || byId(a.id, b.id))
        .slice(0, 20)
        .map((n) => n.id)
    )
  }, [graph])

  const nodes = graph?.nodes ?? []
  const edges = graph?.edges ?? []
  const enough = nodes.length >= 2
  const pickedNode = picked ? nodes.find((n) => n.id === picked) ?? null : null

  const onNodeClick = (node: BiblioNode): void => {
    if (node.itemId != null) {
      onOpenTarget?.({ itemId: node.itemId, attachmentId: null, page: null })
    } else {
      setPicked((cur) => (cur === node.id ? null : node.id))
    }
  }

  const radiusOf = (weight: number): number => 3 + Math.sqrt(weight) * 1.6

  return (
    <div className="panel" data-testid="biblio-panel">
      <div className="biblio__head">
        <span className="biblio__title">文献网络</span>
        <select
          className="biblio__kind"
          data-testid="biblio-kind"
          value={kind}
          onChange={(e) => {
            const v = e.target.value as BiblioKind
            setKind(KINDS.includes(v) ? v : 'authors')
          }}
        >
          <option value="authors">作者</option>
          <option value="keywords">关键词</option>
          <option value="coupling">文献耦合</option>
          <option value="cocitation">共被引</option>
        </select>
        <button
          className="biblio__reload"
          data-testid="biblio-reload"
          disabled={busy}
          onClick={() => void load(kind)}
          title="重新读取本地文库"
        >
          刷新
        </button>
      </div>

      {!enough ? (
        <p className="biblio__empty" data-testid="biblio-empty">
          {busy ? '加载中…' : msg || '文库数据不足（需要作者/关键词/引文）'}
        </p>
      ) : (
        <svg
          className="biblio__svg"
          data-testid="biblio-svg"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="文献网络图"
        >
          {/* 边：透明度 ∝ 权重 */}
          {edges.map((e, i) => {
            const a = positions.get(e.source)
            const b = positions.get(e.target)
            if (!a || !b) return null
            const ratio = Math.min(1, e.weight / maxEdgeWeight)
            return (
              <line
                key={`e${i}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="var(--text-faint)"
                strokeWidth={1}
                strokeOpacity={0.1 + ratio * 0.55}
              />
            )
          })}
          {/* 节点 */}
          {nodes.map((node) => {
            const p = positions.get(node.id)
            if (!p) return null
            const selected = picked === node.id
            const drillable = node.itemId != null
            return (
              <circle
                key={node.id}
                data-testid={`biblio-node-${node.id}`}
                cx={p.x}
                cy={p.y}
                r={radiusOf(node.weight)}
                fill={PALETTE[node.cluster % PALETTE.length]}
                fillOpacity={selected ? 1 : 0.9}
                stroke={selected ? 'var(--text)' : 'var(--bg-panel)'}
                strokeWidth={selected ? 2.4 : 0.8}
                style={{ cursor: drillable ? 'pointer' : 'default' }}
                onClick={() => onNodeClick(node)}
              >
                <title>
                  {`${node.label}（${node.weight}）${drillable ? ' — 点击打开' : ''}`}
                </title>
              </circle>
            )
          })}
          {/* 标签：仅展示权重前 20 的节点 */}
          {nodes
            .filter((n) => labelIds.has(n.id))
            .map((node) => {
              const p = positions.get(node.id)
              if (!p) return null
              return (
                <text
                  key={`t-${node.id}`}
                  x={p.x}
                  y={p.y - radiusOf(node.weight) - 2}
                  textAnchor="middle"
                  className="biblio__label"
                >
                  {truncate(node.label)}
                </text>
              )
            })}
        </svg>
      )}

      {pickedNode ? (
        <div className="biblio__picked" data-testid="biblio-picked">
          已选：{pickedNode.label}（权重 {pickedNode.weight}）
        </div>
      ) : (
        <div className="biblio__picked" data-testid="biblio-picked" />
      )}

      <div className="biblio__count" data-testid="biblio-count">
        节点 {nodes.length} · 边 {edges.length} · 聚类 {graph?.clusters ?? 0}
      </div>

      <div className="biblio__export">
        <button
          className="biblio__export-btn"
          data-testid="biblio-export-pajek"
          onClick={() => void doExport('pajek')}
          title="导出为 Pajek .net（Gephi / Pajek 可读）"
        >
          导出 Pajek
        </button>
        <button
          className="biblio__export-btn"
          data-testid="biblio-export-gexf"
          onClick={() => void doExport('gexf')}
          title="导出为 GEXF 1.2（Gephi 可读）"
        >
          导出 GEXF
        </button>
      </div>
      <div className="biblio__export-status" data-testid="biblio-export-status">
        {exportMsg}
      </div>
      {msg && enough && <div className="biblio__msg">{msg}</div>}
    </div>
  )
}
