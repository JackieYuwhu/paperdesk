import { useEffect, useMemo, useRef, useState } from 'react'
import cytoscape from 'cytoscape'
import { Icon } from '../../components/Icon'
import type {
  DiscoveryDiagnosis,
  DiscoveryGraph,
  DiscoverySource,
  GraphNode,
  GraphNodeKind
} from '@shared/types'

interface Props {
  itemId: number | null
  active: boolean
  theme: string
  onLibraryChanged: () => void
  /** related=相关论文（以当前论文为中心）；topic=研究方向（独立检索） */
  mode?: 'related' | 'topic'
  /** 外部要求按类别过滤（如「按引用展开」→ 仅看施引文献） */
  pendingFilter?: GraphNodeKind | null
  onConsumePendingFilter?: () => void
}

const KIND_LABEL: Record<string, string> = {
  seed: '种子',
  reference: '参考文献',
  citation: '施引文献',
  related: '相关论文',
  ai: 'AI 建议',
  library: '本地库'
}

const KIND_COLOR: Record<string, string> = {
  seed: '#2563eb',
  reference: '#f59e0b',
  citation: '#10b981',
  related: '#8b5cf6',
  ai: '#ec4899',
  library: '#0ea5e9'
}

/** 「相关论文」的数据源：只保留两个 —— OpenAlex（纯网络）与 AI 辅助（= 网络+本地+AI 全部合并） */
const SOURCES: Array<{ id: DiscoverySource; label: string; title: string }> = [
  {
    id: 'ai',
    label: 'AI 辅助',
    title: '网络（OpenAlex/Crossref）+ 本地库 + AI 建议，全部合并并按类别标注来源'
  },
  {
    id: 'openalex',
    label: 'OpenAlex',
    title: '仅 OpenAlex / Crossref（含参考文献与施引文献），失败回退 Crossref'
  }
]

export function DiscoveryPanel({
  itemId,
  active,
  theme,
  onLibraryChanged,
  mode = 'related',
  pendingFilter = null,
  onConsumePendingFilter
}: Props): React.JSX.Element {
  const [graph, setGraph] = useState<DiscoveryGraph | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [source, setSource] = useState<DiscoverySource>('ai')
  const [added, setAdded] = useState<Record<string, boolean>>({})
  const [diagnosis, setDiagnosis] = useState<DiscoveryDiagnosis | null>(null)
  /** 图例筛选：只显示某类（null = 全部） */
  const [filter, setFilter] = useState<GraphNodeKind | null>(null)
  /** 当前在图中点选/高亮的节点 id（用于滚动定位到下方列表） */
  const [selected, setSelected] = useState<string | null>(null)
  /** 「研究方向」检索词（默认用当前论文的领域填充） */
  const [topicQuery, setTopicQuery] = useState('')
  /** 列表/方向检索排序：新领域默认「最新优先」，避免只看到高被引旧文 */
  const [sort, setSort] = useState<'recent' | 'cited'>('recent')
  const cyRef = useRef<HTMLDivElement>(null)
  const cyInstance = useRef<cytoscape.Core | null>(null)
  /** 已检查过缓存的条目（用于「无图谱时自动查询一次」） */
  const cacheCheckedRef = useRef<Set<number>>(new Set())
  const autoRanRef = useRef<Set<number>>(new Set())

  // 重新激活时重算画布尺寸（面板用 display:none 保活）
  useEffect(() => {
    if (active && cyInstance.current) {
      cyInstance.current.resize()
      cyInstance.current.fit(undefined, 24)
    }
  }, [active])

  useEffect(() => {
    setGraph(null)
    setStatus('')
    setAdded({})
    setDiagnosis(null)
    if (itemId == null) return
    let cancelled = false
    // 先读缓存（一篇论文的相关论文基本固定，查一次即可）
    void window.api.discovery
      .cached(itemId)
      .then((c) => {
        if (cancelled) return
        if (c) {
          setGraph(c.graph)
          setStatus(`已加载缓存（${new Date(c.cachedAt).toLocaleString()}）· 需更新请点「开始查询」`)
        }
        cacheCheckedRef.current.add(itemId)
      })
      .catch(() => {
        cacheCheckedRef.current.add(itemId)
      })
    return () => {
      cancelled = true
    }
  }, [itemId])

  /** 外部要求按类别过滤（如「按引用展开」→ 仅看施引文献） */
  useEffect(() => {
    if (!pendingFilter) return
    setFilter(pendingFilter)
    onConsumePendingFilter?.()
  }, [pendingFilter, onConsumePendingFilter])

  /**
   * 面板被激活、当前条目还没有图谱时，自动查询一次——
   * 这样「文献检索 → 设为种子」之后能直接看到图谱，而不用再点一次「开始查询」。
   */
  useEffect(() => {
    if (!active || itemId == null || graph) return
    if (!cacheCheckedRef.current.has(itemId)) return
    if (autoRanRef.current.has(itemId)) return
    autoRanRef.current.add(itemId)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, itemId, graph])

  // 预填「研究方向」：默认用当前论文的领域（导入/识别元数据时由 AI 标注）
  useEffect(() => {
    if (itemId == null) return
    let cancelled = false
    void window.api.library
      .get(itemId)
      .then((it) => {
        if (cancelled) return
        setTopicQuery((prev) => prev || (it?.domain ?? '') || '')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [itemId])

  const load = async (src: DiscoverySource = source): Promise<void> => {
    setBusy(true)
    setStatus(src === 'topic' ? '按研究方向检索 OpenAlex…' : src === 'ai' ? 'AI 辅助搜寻…' : '查询 OpenAlex…')
    try {
      // 「研究方向」不依赖具体条目；其余来源需要 itemId
      if (src !== 'topic' && itemId == null) {
        setStatus('请先选择一篇论文')
        return
      }
      // 「AI 辅助」= 网络 + 本地 + AI 全部合并（后端 auto-ai）
      const apiSrc: DiscoverySource = src === 'ai' ? 'auto-ai' : src
      const g = await window.api.discovery.graph(itemId ?? 0, apiSrc, topicQuery.trim(), sort)
      setGraph(g)
      if (g.seed) {
        const warn = g.warnings.length ? ` ⚠ ${g.warnings.join('；')}` : ''
        if (src === 'topic') {
          setStatus(
            `${g.seed.title} · 命中 ${g.stats.related} 篇（${sort === 'recent' ? '按发表时间倒序' : '按被引排序'}）` +
              (g.stats.local ? ` · 本地库 ${g.stats.local}` : '') +
              warn
          )
        } else {
          setStatus(
            `参考文献 ${g.stats.references} · 施引文献 ${g.stats.citations} · 相关论文 ${g.stats.related}` +
              (g.stats.local ? ` · 本地库 ${g.stats.local}` : '') +
              (g.stats.ai ? ` · AI ${g.stats.ai}` : '') +
              warn
          )
        }
      } else {
        setStatus(g.warnings.join('；') || '未找到')
      }
    } catch (e) {
      setStatus('失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  // 渲染力导向图
  useEffect(() => {
    const container = cyRef.current
    if (!graph || !container) return

    const nodeIds = new Set(graph.nodes.map((n) => n.id))
    const elements = [
      ...graph.nodes.map((n) => ({
        data: {
          id: n.id,
          label: (n.title ?? n.id).slice(0, 60),
          kind: n.kind,
          color: KIND_COLOR[n.kind] ?? '#94a3b8',
          size: 22 + Math.min(38, Math.log10((n.citedBy || 0) + 1) * 16)
        }
      })),
      // 防御：丢掉端点不存在的边，避免 cytoscape 因脏数据抛错（整块面板白屏）
      ...graph.edges
        .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
        .map((e, i) => ({
          data: { id: `e${i}`, source: e.source, target: e.target, type: e.type }
        }))
    ]

    const cs = getComputedStyle(document.documentElement)
    const labelColor = cs.getPropertyValue('--text').trim() || '#333'
    const outlineColor = cs.getPropertyValue('--bg-canvas').trim() || '#e8eaee'

    const cy = cytoscape({
      container,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            width: 'data(size)',
            height: 'data(size)',
            label: 'data(label)',
            'font-size': 9,
            color: labelColor,
            'text-outline-width': 2.5,
            'text-outline-color': outlineColor,
            'text-max-width': '92px',
            'text-wrap': 'ellipsis',
            'text-valign': 'bottom',
            'text-margin-y': 4,
            'border-width': 1,
            'border-color': '#ffffff'
          }
        },
        {
          selector: 'edge',
          style: {
            width: 1,
            'line-color': '#94a3b8',
            'target-arrow-color': '#94a3b8',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'arrow-scale': 0.6
          }
        },
        {
          selector: 'edge[type="related"]',
          style: { 'line-style': 'dashed', 'target-arrow-shape': 'none' }
        }
      ],
      layout: {
        name: 'cose',
        animate: false,
        padding: 16,
        nodeRepulsion: 9000,
        idealEdgeLength: 70
      }
    } as cytoscape.CytoscapeOptions)

    cyInstance.current = cy

    // 点击图中圆圈 → 选中并滚动到下方列表对应论文
    cy.on('tap', 'node', (evt) => {
      const id = String(evt.target.id())
      setSelected(id)
      const items = document.querySelectorAll<HTMLElement>('[data-node-id]')
      for (const el of Array.from(items)) {
        if (el.dataset.nodeId === id) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          break
        }
      }
    })
    // 点空白处清除选中
    cy.on('tap', (evt) => {
      if (evt.target === cy) setSelected(null)
    })

    return () => {
      cyInstance.current = null
      cy.destroy()
    }
  }, [graph, theme])

  // 图例筛选：隐藏不匹配的节点/边并重新适配（保留种子节点）
  useEffect(() => {
    const cy = cyInstance.current
    if (!cy) return
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const kind = String(n.data('kind') ?? '')
        const show = !filter || kind === filter || kind === 'seed'
        n.style('display', show ? 'element' : 'none')
      })
      cy.edges().forEach((e) => {
        const s = e.source().style('display') !== 'none'
        const t = e.target().style('display') !== 'none'
        e.style('display', s && t ? 'element' : 'none')
      })
    })
    cy.fit(undefined, 24)
  }, [filter, graph])

  const related = useMemo(() => {
    const all = (graph?.nodes ?? [])
      .filter((n) => n.kind !== 'seed')
      .sort((a, b) =>
        sort === 'recent'
          ? (b.year ?? 0) - (a.year ?? 0) || b.citedBy - a.citedBy
          : b.citedBy - a.citedBy
      )
    return filter ? all.filter((n) => n.kind === filter) : all
  }, [graph, filter, sort])

  const diagnose = async (): Promise<void> => {
    if (itemId == null) return
    setBusy(true)
    setStatus('自检中…（OpenAlex / Crossref）')
    try {
      const d = await window.api.discovery.diagnose(itemId)
      setDiagnosis(d)
      setStatus('')
    } catch (e) {
      setStatus('自检失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const add = async (n: GraphNode): Promise<void> => {
    await window.api.library.addMetadata({
      title: n.title,
      doi: n.doi,
      year: n.year,
      venue: n.venue,
      parentId: itemId
    })
    setAdded((prev) => ({ ...prev, [n.id]: true }))
    onLibraryChanged()
  }

  if (itemId == null && mode !== 'topic') {
    return (
      <div className="panel">
        <div className="panel__bar">
          <div className="seg" title="数据源">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                className={source === s.id ? 'on' : ''}
                title={s.title}
                data-testid={`disc-source-${s.id}`}
                onClick={() => setSource(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="empty">
          <Icon name="graph" size={26} />
          <span>先选择一篇论文（或到「研究方向」按方向检索）</span>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      {mode === 'topic' ? (
        <div className="panel__bar" data-testid="disc-topic-bar">
          <Icon name="search" size={14} />
          <input
            placeholder="研究方向，如：蛋白质结构预测 / graph neural network"
            value={topicQuery}
            data-testid="disc-topic-input"
            onChange={(e) => setTopicQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load('topic')
            }}
          />
          <button
            className="primary"
            disabled={busy || !topicQuery.trim()}
            onClick={() => void load('topic')}
            data-testid="disc-run"
          >
            <Icon name="search" size={14} />
            {busy ? '检索中…' : '按方向检索'}
          </button>
          <select
            className="works__num"
            style={{ width: 96 }}
            value={sort}
            data-testid="disc-sort"
            title="新领域选「最新优先」；经典工作选「高被引」"
            onChange={(e) => setSort(e.target.value as 'recent' | 'cited')}
          >
            <option value="recent">最新优先</option>
            <option value="cited">高被引</option>
          </select>
        </div>
      ) : (
        <div className="panel__bar">
          <div className="seg" title="数据源">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                className={source === s.id ? 'on' : ''}
                title={s.title}
                data-testid={`disc-source-${s.id}`}
                onClick={() => setSource(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <span className="toolbar__spacer" />
          <select
            className="works__num"
            style={{ width: 96 }}
            value={sort}
            data-testid="disc-sort"
            title="列表排序：新领域选「最新优先」"
            onChange={(e) => setSort(e.target.value as 'recent' | 'cited')}
          >
            <option value="recent">最新优先</option>
            <option value="cited">高被引</option>
          </select>
          <button
            className="ghost"
            disabled={busy || itemId == null}
            onClick={() => void diagnose()}
            data-testid="disc-diagnose"
            title="自检：OpenAlex / Crossref 是否可用"
          >
            <Icon name="info" size={14} />
            自检
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void load()}
            data-testid="disc-run"
          >
            <Icon name="graph" size={14} />
            {busy ? '查询中…' : '开始查询'}
          </button>
        </div>
      )}
      {mode === 'topic' && (
        <div className="list__hint" data-testid="disc-topic-hint">
          输入研究方向即可检索（与当前论文无关）· {sort === 'recent' ? '按发表时间倒序' : '按被引排序'} · 来自 OpenAlex
        </div>
      )}
      {status && <div className="panel__status">{status}</div>}
      {diagnosis && (
        <div className="lookup" data-testid="disc-diagnosis">
          <div className="lookup__head">
            <span className="sidebar__title">相关论文自检</span>
            <button className="icon ghost" onClick={() => setDiagnosis(null)}>
              <Icon name="close" size={13} />
            </button>
          </div>
          <ul className="diag__list">
            {diagnosis.notes.map((n, i) => (
              <li key={i} className={/429|不可用|限流|未找到|没有/.test(n) ? 'diag__bad' : 'diag__ok'}>
                {n}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="cy" data-testid="disc-graph" ref={cyRef} />

      {graph && (
        <>
          <div className="disc__legend" data-testid="disc-legend">
            <button
              className={`disc__legend-item${filter == null ? ' on' : ''}`}
              data-testid="disc-legend-all"
              aria-pressed={filter == null}
              title="显示全部类别"
              onClick={() => setFilter(null)}
            >
              <i style={{ background: 'transparent', border: '1px solid var(--border)' }} />
              全部
            </button>
            {(['seed', 'reference', 'citation', 'related', 'ai', 'library'] as const).map((k) => (
              <button
                key={k}
                className={`disc__legend-item${filter === k ? ' on' : ''}`}
                data-testid={`disc-legend-${k}`}
                aria-pressed={filter === k}
                title={`只看「${KIND_LABEL[k]}」（再次点击取消）`}
                onClick={() => setFilter((f) => (f === k ? null : k))}
              >
                <i style={{ background: KIND_COLOR[k] }} />
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="disc__counts meta__muted" data-testid="disc-counts">
            参考文献 {graph.stats.references}
            {graph.stats.refsTotal ? ` / 共 ${graph.stats.refsTotal}` : ''} · 施引 {graph.stats.citations}
            {graph.stats.citesTotal ? ` / 共 ${graph.stats.citesTotal}` : ''} · 相关 {graph.stats.related}
            {graph.stats.relatedTotal ? ` / 共 ${graph.stats.relatedTotal}` : ''}
            {filter ? ` · 已筛选：${KIND_LABEL[filter]}` : ''}
          </div>
        </>
      )}

      {related.length > 0 ? (
        <ol className="disc__list" data-testid="disc-list">
          {related.map((n) => (
            <li
              key={n.id}
              className={`disc__item${selected === n.id ? ' disc__item--active' : ''}`}
              data-node-id={n.id}
            >
              <div className="disc__item-main">
                <span className="disc__badge" style={{ background: KIND_COLOR[n.kind] }}>
                  {KIND_LABEL[n.kind]}
                </span>
                <span className="disc__title">{n.title ?? n.id}</span>
                <span className="disc__meta">
                  {n.year ?? '—'} · {n.venue ?? '—'} · 被引 {n.citedBy}
                  {n.doi ? ` · ${n.doi}` : ''}
                </span>
              </div>
              <button disabled={!!added[n.id]} onClick={() => void add(n)}>
                {added[n.id] ? '已加入' : '加入文库'}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="empty" style={{ padding: 16 }}>
          <Icon name="graph" size={22} />
          <span>
            {filter
              ? `当前筛选（${KIND_LABEL[filter]}）下没有条目，点「全部」查看所有结果`
              : '暂无结果，可切换数据源或用「AI 辅助」（需配置模型服务）'}
          </span>
        </div>
      )}
    </div>
  )
}
