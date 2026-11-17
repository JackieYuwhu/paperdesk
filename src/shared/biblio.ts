// 文献网络（VOSviewer 精简版）纯逻辑：合著 / 关键词共现 + 标签传播聚类。
// 不依赖 electron / node，可被主进程、渲染进程与单元测试共用。
export type BiblioKind = 'authors' | 'keywords' | 'coupling' | 'cocitation'

export interface BiblioNode {
  id: string
  label: string
  weight: number
  cluster: number
  /** 该节点对应的文库条目 id（用于下钻；仅「文献耦合」节点具备） */
  itemId?: number | null
}

export interface BiblioEdge {
  source: string
  target: string
  weight: number
}

export interface BiblioGraph {
  kind: BiblioKind
  nodes: BiblioNode[]
  edges: BiblioEdge[]
  clusters: number
}

/** 稳定的字符串比较（用于确定性排序） */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 由「节点信息 + 每个 item 的节点集合」组装成图并聚类 */
function assemble(
  kind: BiblioKind,
  nodeInfo: Map<string, { label: string; items: Set<string | number> }>,
  itemNodes: Map<number | string, Set<string>>
): BiblioGraph {
  const edgeMap = new Map<string, number>()
  for (const ids of itemNodes.values()) {
    const uniq = [...ids].sort(byId)
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const key = `${uniq[i]}\u0000${uniq[j]}`
        edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1)
      }
    }
  }

  const nodes: BiblioNode[] = [...nodeInfo.entries()].map(([id, info]) => ({
    id,
    label: info.label,
    weight: info.items.size,
    cluster: 0
  }))
  nodes.sort((a, b) => byId(a.id, b.id))

  const edges: BiblioEdge[] = [...edgeMap.entries()]
    .map(([key, weight]) => {
      const [source, target] = key.split('\u0000')
      return { source, target, weight }
    })
    .sort((a, b) => byId(a.source, b.source) || byId(a.target, b.target))

  const clusterMap = clusterByLabelPropagation(
    nodes.map((n) => n.id),
    edges
  )
  for (const n of nodes) n.cluster = clusterMap[n.id] ?? 0

  return { kind, nodes, edges, clusters: new Set(nodes.map((n) => n.cluster)).size }
}

/** 作者合著网络：节点 = 作者，边 = 同篇论文共现 */
export function buildCoAuthorGraph(
  rows: Array<{ itemId: number; authorId: number; name: string }>
): BiblioGraph {
  const nodeInfo = new Map<string, { label: string; items: Set<string | number> }>()
  const itemNodes = new Map<number | string, Set<string>>()
  for (const r of rows) {
    const id = `a${r.authorId}`
    const info = nodeInfo.get(id) ?? { label: r.name, items: new Set<number>() }
    if (r.name) info.label = r.name
    info.items.add(r.itemId)
    nodeInfo.set(id, info)
    const set = itemNodes.get(r.itemId) ?? new Set<string>()
    set.add(id)
    itemNodes.set(r.itemId, set)
  }
  return assemble('authors', nodeInfo, itemNodes)
}

/** 关键词共现网络：节点 = 标签，边 = 同篇论文共现 */
export function buildKeywordGraph(
  rows: Array<{ itemId: number; tagId: number; name: string }>
): BiblioGraph {
  const nodeInfo = new Map<string, { label: string; items: Set<string | number> }>()
  const itemNodes = new Map<number | string, Set<string>>()
  for (const r of rows) {
    const id = `t${r.tagId}`
    const info = nodeInfo.get(id) ?? { label: r.name, items: new Set<number>() }
    if (r.name) info.label = r.name
    info.items.add(r.itemId)
    nodeInfo.set(id, info)
    const set = itemNodes.get(r.itemId) ?? new Set<string>()
    set.add(id)
    itemNodes.set(r.itemId, set)
  }
  return assemble('keywords', nodeInfo, itemNodes)
}

/** 把任意 refKey 归一成可安全放进节点 id 的字符串（确定性） */
function sanitizeRefKey(key: string): string {
  const s = key.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return s || 'x'
}

/**
 * 文献耦合网络：节点 = 论文条目，边 = 两篇论文共用同一篇参考文献。
 * 边权 = 共同引用的参考文献数；节点权 = 该论文引用的不同参考文献数。
 */
export function buildCouplingGraph(
  rows: Array<{ itemId: number; itemTitle: string; refKey: string }>
): BiblioGraph {
  const itemIdByNode = new Map<string, number>()
  const nodeInfo = new Map<string, { label: string; items: Set<string | number> }>()
  // itemNodes 以 refKey 为“桶”，复用 assemble 的共现逻辑：同桶两节点连边
  const refItems = new Map<number | string, Set<string>>()
  for (const r of rows) {
    const id = `i${r.itemId}`
    const info = nodeInfo.get(id) ?? { label: r.itemTitle, items: new Set<string | number>() }
    if (r.itemTitle) info.label = r.itemTitle
    info.items.add(r.refKey)
    nodeInfo.set(id, info)
    itemIdByNode.set(id, r.itemId)
    const set = refItems.get(r.refKey) ?? new Set<string>()
    set.add(id)
    refItems.set(r.refKey, set)
  }
  const graph = assemble('coupling', nodeInfo, refItems)
  for (const n of graph.nodes) n.itemId = itemIdByNode.get(n.id) ?? null
  return graph
}

/**
 * 共被引网络：节点 = 被引参考文献，边 = 同一篇论文同时引用了它们。
 * 边权 = 共同引用它们的论文数；节点权 = 引用它的不同论文数；不携带 itemId。
 */
export function buildCoCitationGraph(
  rows: Array<{ itemId: number; refKey: string; refLabel: string }>
): BiblioGraph {
  const nodeInfo = new Map<string, { label: string; items: Set<string | number> }>()
  const itemRefs = new Map<number | string, Set<string>>()
  for (const r of rows) {
    const id = `r${sanitizeRefKey(r.refKey)}`
    const info = nodeInfo.get(id) ?? { label: r.refLabel, items: new Set<string | number>() }
    if (r.refLabel) info.label = r.refLabel
    info.items.add(r.itemId)
    nodeInfo.set(id, info)
    const set = itemRefs.get(r.itemId) ?? new Set<string>()
    set.add(id)
    itemRefs.set(r.itemId, set)
  }
  return assemble('cocitation', nodeInfo, itemRefs)
}

/**
 * 确定性标签传播聚类：
 *  - 按 id 升序迭代；
 *  - 采用邻居中出现最频繁的标签，平票取较小的标签；
 *  - 收敛后按「排序 id 中首次出现的顺序」把标签稠密化为 0,1,2…；
 *  - 孤立节点各自成一个聚类。
 */
export function clusterByLabelPropagation(
  ids: string[],
  edges: BiblioEdge[],
  maxIter = 10
): Record<string, number> {
  const sorted = [...new Set(ids)].sort(byId)
  const adj = new Map<string, string[]>()
  for (const id of sorted) adj.set(id, [])
  for (const e of edges) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    adj.get(e.target)!.push(e.source)
  }

  const label = new Map<string, string>()
  for (const id of sorted) label.set(id, id)

  const iters = Math.max(1, Math.floor(maxIter) || 10)
  for (let it = 0; it < iters; it++) {
    let changed = false
    for (const id of sorted) {
      const counts = new Map<string, number>()
      for (const nb of adj.get(id)!) {
        const l = label.get(nb)!
        counts.set(l, (counts.get(l) ?? 0) + 1)
      }
      if (counts.size === 0) continue
      let best = ''
      let bestCount = -1
      for (const [l, c] of counts) {
        if (c > bestCount || (c === bestCount && l < best)) {
          best = l
          bestCount = c
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best)
        changed = true
      }
    }
    if (!changed) break
  }

  const result: Record<string, number> = {}
  const remap = new Map<string, number>()
  for (const id of sorted) {
    const l = label.get(id)!
    if (!remap.has(l)) remap.set(l, remap.size)
    result[id] = remap.get(l)!
  }
  return result
}

/** 取权重最高的 limit 个节点构成的子图，并重新聚类 */
export function topSubgraph(graph: BiblioGraph, limit: number): BiblioGraph {
  const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  const kept = [...graph.nodes]
    .sort((a, b) => b.weight - a.weight || byId(a.id, b.id))
    .slice(0, n)
  const keptIds = new Set(kept.map((k) => k.id))
  const edges = graph.edges
    .filter((e) => keptIds.has(e.source) && keptIds.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, weight: e.weight }))

  const clusterMap = clusterByLabelPropagation(
    kept.map((k) => k.id),
    edges
  )
  const nodes: BiblioNode[] = kept.map((k) => ({
    id: k.id,
    label: k.label,
    weight: k.weight,
    cluster: clusterMap[k.id] ?? 0,
    itemId: k.itemId
  }))
  return {
    kind: graph.kind,
    nodes,
    edges,
    clusters: new Set(nodes.map((x) => x.cluster)).size
  }
}

/**
 * VOS 式确定性布局（纯函数，无随机）：
 *  - 初始位置按索引顺序均匀分布在圆周上；
 *  - 迭代若干轮：每条边按权重吸引两端点，任意两点按 ~k/dist 互斥，
 *    叠加轻微向心引力，力按节点质量（weight）缩放，并用软夹取限制在画布内；
 *  - 结果取整返回，保证可复现。
 */
export function vosLayout(
  nodes: Array<{ id: string; weight: number }>,
  edges: BiblioEdge[],
  opts?: { iterations?: number; width?: number; height?: number }
): Record<string, { x: number; y: number }> {
  const width = Number.isFinite(opts?.width) && (opts!.width as number) > 0 ? (opts!.width as number) : 100
  const height =
    Number.isFinite(opts?.height) && (opts!.height as number) > 0 ? (opts!.height as number) : 100
  const iterations =
    Number.isFinite(opts?.iterations) && (opts!.iterations as number) > 0
      ? Math.floor(opts!.iterations as number)
      : 120

  const n = nodes.length
  const cx = width / 2
  const cy = height / 2
  const radius = 0.4 * Math.min(width, height)
  const k = Math.sqrt((width * height) / Math.max(1, n))
  const eps = 1e-4

  const pos = new Map<string, { x: number; y: number }>()
  const mass = new Map<string, number>()
  nodes.forEach((nd, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2
    pos.set(nd.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) })
    mass.set(nd.id, Math.max(1, Number.isFinite(nd.weight) ? nd.weight : 1))
  })

  for (let it = 0; it < iterations; it++) {
    const disp = new Map<string, { x: number; y: number }>()
    for (const nd of nodes) disp.set(nd.id, { x: 0, y: 0 })

    // 互斥：任意两点，力 ~ k / dist
    for (let i = 0; i < n; i++) {
      const a = nodes[i].id
      const pa = pos.get(a)!
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j].id
        const pb = pos.get(b)!
        const dx = pa.x - pb.x
        const dy = pa.y - pb.y
        let dist = Math.hypot(dx, dy)
        if (dist < eps) dist = eps
        const f = k / dist
        const ux = dx / dist
        const uy = dy / dist
        const da = disp.get(a)!
        const db = disp.get(b)!
        da.x += ux * f
        da.y += uy * f
        db.x -= ux * f
        db.y -= uy * f
      }
    }

    // 吸引：每条边按权重把两端点拉近
    for (const e of edges) {
      const pa = pos.get(e.source)
      const pb = pos.get(e.target)
      if (!pa || !pb) continue
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      let dist = Math.hypot(dx, dy)
      if (dist < eps) dist = eps
      const f = (dist / k) * Math.max(1, Number.isFinite(e.weight) ? e.weight : 1)
      const ux = dx / dist
      const uy = dy / dist
      const da = disp.get(e.source)!
      const db = disp.get(e.target)!
      da.x += ux * f
      da.y += uy * f
      db.x -= ux * f
      db.y -= uy * f
    }

    // 轻微向心引力
    for (const nd of nodes) {
      const p = pos.get(nd.id)!
      const d = disp.get(nd.id)!
      d.x += (cx - p.x) * 0.01
      d.y += (cy - p.y) * 0.01
    }

    // 降温后按质量缩放移动，并软夹取在画布内
    const t = 1 - it / (iterations + 1)
    const step = 0.1 * t
    for (const nd of nodes) {
      const p = pos.get(nd.id)!
      const d = disp.get(nd.id)!
      const m = mass.get(nd.id)!
      p.x += (d.x / m) * step
      p.y += (d.y / m) * step
      if (p.x < 0) p.x = 0
      else if (p.x > width) p.x = width
      if (p.y < 0) p.y = 0
      else if (p.y > height) p.y = height
    }
  }

  const out: Record<string, { x: number; y: number }> = {}
  for (const nd of nodes) {
    const p = pos.get(nd.id)!
    out[nd.id] = { x: Math.round(p.x), y: Math.round(p.y) }
  }
  return out
}

/** 把图序列化为 Pajek `.net` 文本（确定性；空图也输出合法最小结构） */
export function toPajek(graph: BiblioGraph): string {
  const nodes = graph.nodes
  const index = new Map<string, number>()
  nodes.forEach((n, i) => index.set(n.id, i + 1))

  const lines: string[] = []
  lines.push(`*Vertices ${nodes.length}`)
  for (const n of nodes) {
    const label = n.label.replace(/"/g, '\\"')
    lines.push(`${index.get(n.id)} "${label}"`)
  }

  const edges = graph.edges.filter((e) => index.has(e.source) && index.has(e.target))
  lines.push(edges.length > 0 ? `*Edges ${edges.length}` : '*Edges')
  for (const e of edges) {
    lines.push(`${index.get(e.source)} ${index.get(e.target)} ${e.weight}`)
  }
  return lines.join('\n')
}

/** XML 转义（&<>"'），用于 GEXF 的属性值 */
function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 把图序列化为 GEXF 1.2 XML 文本（确定性；空图也是良构文档） */
export function toGexf(graph: BiblioGraph): string {
  const ids = new Set(graph.nodes.map((n) => n.id))
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<gexf xmlns="http://www.gexf.net/1.2draft" version="1.2">')
  lines.push('  <graph mode="static" defaultedgetype="undirected">')
  lines.push('    <attributes class="node">')
  lines.push('      <attribute id="cluster" title="cluster" type="integer" />')
  lines.push('      <attribute id="weight" title="weight" type="integer" />')
  lines.push('    </attributes>')
  lines.push('    <nodes>')
  for (const n of graph.nodes) {
    lines.push(`      <node id="${escXml(n.id)}" label="${escXml(n.label)}">`)
    lines.push('        <attvalues>')
    lines.push(`          <attvalue for="cluster" value="${escXml(String(n.cluster))}" />`)
    lines.push(`          <attvalue for="weight" value="${escXml(String(n.weight))}" />`)
    lines.push('        </attvalues>')
    lines.push('      </node>')
  }
  lines.push('    </nodes>')
  lines.push('    <edges>')
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    lines.push(
      `      <edge source="${escXml(e.source)}" target="${escXml(e.target)}" weight="${escXml(
        String(e.weight)
      )}" />`
    )
  }
  lines.push('    </edges>')
  lines.push('  </graph>')
  lines.push('</gexf>')
  return lines.join('\n')
}
