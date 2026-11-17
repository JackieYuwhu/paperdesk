// 坐标转换的单元测试（Node 原生 TS 类型擦除直接运行）
// 运行: node scripts/test-coords.ts
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { resolveTestFault } from '../src/main/test-profile.ts'
import {
  rectToPdfRect,
  pdfRectToViewportRect,
  clientRectsToPdfRects
} from '../src/renderer/src/features/reader/coords.ts'
import type { PointConverter } from '../src/renderer/src/features/reader/coords.ts'
import {
  addChild,
  alignNodesToColumn,
  clampMindmapZoom,
  createMindMap,
  hiddenByCollapse,
  mindmapContentPoint,
  moveNodesBy,
  nextMindmapZoom,
  rectsIntersect,
  removeNodes,
  zoomScrollAfterZoom
} from '../src/renderer/src/features/mindmap/mindmap-model.ts'
import {
  canDropGroupOn,
  flattenGroupDragRows,
  isSameOrDescendantGroup,
  resolveGroupDrop
} from '../src/renderer/src/features/library/group-drag.ts'
import {
  GROUP_PANE_DEFAULT_HEIGHT,
  groupPaneHeightFromDrag,
  groupPaneStyle
} from '../src/renderer/src/features/library/group-split.ts'
import { buildGroupTree, visibleGroupNodes } from '../src/shared/library-groups.ts'

const W = 612
const H = 792

// 复刻 pdf.js PageViewport 在 rotation=0 时的变换: transform = [s, 0, 0, -s, 0, H*s]
function makeViewport(s: number): PointConverter {
  return {
    convertToViewportPoint(x: number, y: number): number[] {
      return [s * x, -s * y + H * s]
    },
    convertToPdfPoint(x: number, y: number): number[] {
      return [x / s, (H * s - y) / s]
    }
  }
}

let failed = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name} ${extra}`)
  }
}
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps
}

// PD03：组件里的纯函数（搜索状态机 / 高亮转义）用 #region 标记，测试直接抽取
// 生产源码执行，避免在测试里复制一份逻辑导致两边漂移。
function loadRegion(region: string, expression: string): any {
  const source = readFileSync(
    new URL('../src/renderer/src/features/library/LibraryList.tsx', import.meta.url),
    'utf8'
  )
  const start = source.indexOf(`// #region ${region}`)
  const end = source.indexOf(`// #endregion ${region}`)
  if (start < 0 || end <= start) throw new Error(`LibraryList.tsx 缺少 ${region} 标记区`)
  const js = stripTypeScriptTypes(source.slice(start, end), { mode: 'strip' })
  return new Function(`${js}\nreturn (${expression})`)()
}

console.log('坐标转换测试')

// 1) 往返一致：CSS 矩形 -> PDF -> CSS 应还原
{
  const vp = makeViewport(1.3)
  const pdf = rectToPdfRect(100, 200, 300, 215, vp)
  const back = pdfRectToViewportRect(pdf, vp)
  check(
    '往返一致 (scale=1.3)',
    approx(back.left, 100, 1e-4) &&
      approx(back.top, 200, 1e-4) &&
      approx(back.width, 200, 1e-4) &&
      approx(back.height, 15, 1e-4),
    JSON.stringify(back)
  )
}

// 2) 缩放无关：同一 PDF 位置在不同缩放下换算出的 PDF 点是同一个
{
  const vp1 = makeViewport(1.3)
  const vp2 = makeViewport(2.7)
  // 同一个 PDF 点，在两个缩放下对应的 CSS 点
  const pdfPoint: [number, number] = [150, 400]
  const [c1x, c1y] = vp1.convertToViewportPoint(pdfPoint[0], pdfPoint[1])
  const [c2x, c2y] = vp2.convertToViewportPoint(pdfPoint[0], pdfPoint[1])
  const p1 = vp1.convertToPdfPoint(c1x, c1y)
  const p2 = vp2.convertToPdfPoint(c2x, c2y)
  check(
    '缩放无关 (1.3 vs 2.7 得到同一 PDF 点)',
    approx(p1[0], pdfPoint[0], 1e-4) && approx(p1[1], pdfPoint[1], 1e-4) &&
      approx(p2[0], pdfPoint[0], 1e-4) && approx(p2[1], pdfPoint[1], 1e-4),
    JSON.stringify({ p1, p2 })
  )
}

// 3) y 轴翻转正确：页面顶部(y 小) 对应 PDF 里 y 大
{
  const vp = makeViewport(1)
  const top = rectToPdfRect(0, 0, 10, 10, vp)
  const bottom = rectToPdfRect(0, H - 10, 10, H, vp)
  check(
    'y 轴翻转 (顶部 PDF y≈H，底部 PDF y≈0)',
    approx(top[3], H, 1e-4) && approx(bottom[1], 0, 1e-4),
    JSON.stringify({ top, bottom })
  )
}

// 4) 归一化：传入逆序角点也能得到 (min,min,max,max)
{
  const vp = makeViewport(1.5)
  const a = rectToPdfRect(300, 400, 100, 200, vp)
  const b = rectToPdfRect(100, 200, 300, 400, vp)
  check('角点归一化与输入顺序无关', JSON.stringify(a) === JSON.stringify(b), JSON.stringify({ a, b }))
}

// 5) 容器偏移换算
{
  const vp = makeViewport(1)
  const rects = clientRectsToPdfRects(
    [{ left: 150, top: 300, right: 250, bottom: 315 }],
    50, // 容器 left
    80, // 容器 top
    vp
  )
  const back = pdfRectToViewportRect(rects[0], vp)
  check(
    '容器偏移换算',
    approx(back.left, 100, 1e-4) && approx(back.top, 220, 1e-4),
    JSON.stringify(back)
  )
}

// 6) PD56：缩放比例夹取与步进（0.4–2.0，步长 0.1）
{
  check(
    '缩放夹取与步进',
    clampMindmapZoom(0.05) === 0.4 &&
      clampMindmapZoom(9) === 2 &&
      clampMindmapZoom(1.24) === 1.2 &&
      clampMindmapZoom(Number.NaN) === 1 &&
      clampMindmapZoom('x') === 1 &&
      nextMindmapZoom(1, 1) === 1.1 &&
      nextMindmapZoom(2, 1) === 2 &&
      nextMindmapZoom(0.4, -1) === 0.4,
    JSON.stringify({
      lo: clampMindmapZoom(0.05),
      hi: clampMindmapZoom(9),
      step: nextMindmapZoom(1, 1)
    })
  )
}

// 7) PD56：缩放锚点——光标下的内容点在缩放前后保持不动（误差 ≤ 2px）
{
  const anchor = {
    scrollLeft: 40,
    scrollTop: 30,
    viewportLeft: 100,
    viewportTop: 50,
    pointerX: 300,
    pointerY: 250,
    zoom: 0.5,
    nextZoom: 1
  }
  const r = zoomScrollAfterZoom(anchor)
  // 缩放后再把同一个屏幕点换算回内容坐标，应回到 contentX/contentY
  const after = mindmapContentPoint(
    300,
    250,
    100,
    50,
    r.scrollLeft,
    r.scrollTop,
    1
  )
  check(
    '缩放锚点保持光标下内容不动',
    Math.abs(after.x - r.contentX) <= 2 && Math.abs(after.y - r.contentY) <= 2,
    JSON.stringify({ ...r, after })
  )
  check(
    '缩放锚点的滚动量按内容坐标反推',
    approx(r.contentX, 480) && approx(r.contentY, 460) && approx(r.scrollLeft, 280) &&
      approx(r.scrollTop, 260),
    JSON.stringify(r)
  )
  const noScroll = zoomScrollAfterZoom({ ...anchor, scrollLeft: 0, scrollTop: 0, zoom: 1, nextZoom: 2 })
  check(
    '无滚动时放大后滚到锚点内容位置',
    approx(noScroll.scrollLeft, 200) && approx(noScroll.scrollTop, 200),
    JSON.stringify(noScroll)
  )
}

// 8) PD56：屏幕坐标 → 内容坐标（含滚动量与缩放）
{
  const p = mindmapContentPoint(300, 250, 100, 50, 40, 30, 2)
  check('内容坐标换算', approx(p.x, 120) && approx(p.y, 115), JSON.stringify(p))
}

// 9) PD56：选框命中（相交，含边相触）
{
  const a = { left: 0, top: 0, right: 100, bottom: 60 }
  check(
    '选框相交判定',
    rectsIntersect(a, { left: 50, top: 20, right: 150, bottom: 90 }) &&
      rectsIntersect(a, { left: 100, top: 60, right: 120, bottom: 80 }) &&
      !rectsIntersect(a, { left: 101, top: 0, right: 200, bottom: 60 }) &&
      !rectsIntersect(a, { left: 200, top: 200, right: 200, bottom: 200 }) &&
      !rectsIntersect(a, { left: Number.NaN, top: 0, right: 10, bottom: 10 })
  )
}

// 10) PD56：多选整体平移保持相对位置，越界整组停下
{
  const base = createMindMap(1, '测试论文')
  const withA = addChild(base, base.rootId, 'A')
  const aId = withA.nodes[withA.nodes.length - 1].id
  const withB = addChild(withA, aId, 'B')
  const bId = withB.nodes[withB.nodes.length - 1].id
  const doc = {
    ...withB,
    nodes: withB.nodes.map((node) =>
      node.id === aId
        ? { ...node, x: 296, y: 120 }
        : node.id === bId
          ? { ...node, x: 520, y: 200 }
          : node
    )
  }
  const moved = moveNodesBy(doc, [aId, bId], 10.6, -5)
  const movedA = moved.nodes.find((node) => node.id === aId)!
  const movedB = moved.nodes.find((node) => node.id === bId)!
  check(
    '多选平移：同一位移、相对位置不变',
    movedA.x === 307 && movedA.y === 115 && movedB.x === 531 && movedB.y === 195 &&
      movedB.x - movedA.x === 224,
    JSON.stringify({ movedA, movedB })
  )
  const clamped = moveNodesBy(doc, [aId, bId], -1000, 0)
  const clampedA = clamped.nodes.find((node) => node.id === aId)!
  const clampedB = clamped.nodes.find((node) => node.id === bId)!
  check(
    '多选平移：负坐标处整组停下',
    clampedA.x === 0 && clampedB.x === 224 && clampedB.x - clampedA.x === 224,
    JSON.stringify({ clampedA, clampedB })
  )
  check('多选平移：无位移返回同一引用', moveNodesBy(doc, [aId], 0, 0) === doc)
}

// 11) PD56：批量删除跳过根、子树去重、可撤销
{
  const base = createMindMap(1, '测试论文')
  const withA = addChild(base, base.rootId, 'A')
  const aId = withA.nodes[withA.nodes.length - 1].id
  const withB = addChild(withA, aId, 'B')
  const bId = withB.nodes[withB.nodes.length - 1].id
  const pruned = removeNodes(withB, [aId, bId, base.rootId, 'missing'])
  check(
    '批量删除：整棵子树一次删净且跳过根',
    pruned.nodes.length === 1 && pruned.nodes[0].id === base.rootId,
    JSON.stringify(pruned.nodes.map((node) => node.id))
  )
  check('批量删除：无可删节点返回同一引用', removeNodes(withB, [base.rootId]) === withB)
}

// 12) PD56：批量对齐取最上方选中节点的 x，y 不变
{
  const base = createMindMap(1, '测试论文')
  const withA = addChild(base, base.rootId, 'A')
  const aId = withA.nodes[withA.nodes.length - 1].id
  const withB = addChild(withA, aId, 'B')
  const bId = withB.nodes[withB.nodes.length - 1].id
  const doc = {
    ...withB,
    nodes: withB.nodes.map((node) =>
      node.id === aId
        ? { ...node, x: 520, y: 200 }
        : node.id === bId
          ? { ...node, x: 296, y: 120 }
          : node
    )
  }
  const aligned = alignNodesToColumn(doc, [aId, bId])
  const alignedA = aligned.nodes.find((node) => node.id === aId)!
  const alignedB = aligned.nodes.find((node) => node.id === bId)!
  check(
    '批量对齐：最上方节点的列为准、y 不变',
    alignedA.x === 296 && alignedB.x === 296 && alignedA.y === 200 && alignedB.y === 120,
    JSON.stringify({ alignedA, alignedB })
  )
  check('批量对齐：单个节点不处理', alignNodesToColumn(doc, [aId]) === doc)
}

// 13) PD56：折叠只隐藏后代、不隐藏自身
{
  const base = createMindMap(1, '测试论文')
  const withA = addChild(base, base.rootId, 'A')
  const aId = withA.nodes[withA.nodes.length - 1].id
  const withB = addChild(withA, aId, 'B')
  const bId = withB.nodes[withB.nodes.length - 1].id
  const hidden = hiddenByCollapse(withB, [aId])
  check(
    '折叠：隐藏全部后代、保留折叠节点自身',
    hidden.has(bId) && !hidden.has(aId) && !hidden.has(base.rootId) &&
      hiddenByCollapse(withB, []).size === 0 &&
      hiddenByCollapse(withB, null).size === 0,
    JSON.stringify(Array.from(hidden))
  )
}

// 14) PD03：搜索请求状态机——过期结果/错误不得回写当前状态
{
  const { initialSearchRequestState, reduceSearchRequest } = loadRegion(
    'search-request-state',
    '{ initialSearchRequestState, reduceSearchRequest }'
  )
  const hit = (id: number): any => ({ id })

  // 可控延迟：A 慢、B 快，B 先返回，A 后返回
  let s = reduceSearchRequest(initialSearchRequestState(), { type: 'begin', seq: 1, query: 'a' })
  check('搜索开始进入 loading 并清空上一轮命中', s.phase === 'loading' && s.hits.length === 0)
  s = reduceSearchRequest(s, { type: 'begin', seq: 2, query: 'b' })
  s = reduceSearchRequest(s, { type: 'resolve', seq: 2, hits: [hit(2)] })
  s = reduceSearchRequest(s, { type: 'resolve', seq: 1, hits: [hit(1)] })
  check(
    '慢请求 A 的结果晚到被丢弃，只保留当前 B',
    s.phase === 'success' && s.query === 'b' && s.hits.length === 1 && s.hits[0].id === 2,
    JSON.stringify(s)
  )

  // 清空输入后旧请求的结果与错误都不得恢复
  s = reduceSearchRequest(s, { type: 'clear', seq: 3 })
  s = reduceSearchRequest(s, { type: 'resolve', seq: 2, hits: [hit(2)] })
  s = reduceSearchRequest(s, { type: 'reject', seq: 2, error: '旧错误' })
  check(
    '清空输入后旧请求不能恢复结果或错误',
    s.phase === 'idle' && s.query === '' && s.hits.length === 0 && s.error === '',
    JSON.stringify(s)
  )

  // 失败后可读提示 + 重试；旧失败晚到不得覆盖新请求
  s = reduceSearchRequest(s, { type: 'begin', seq: 4, query: 'c' })
  s = reduceSearchRequest(s, { type: 'reject', seq: 4, error: '搜索失败：数据库忙' })
  check(
    '搜索失败进入 error 并保留可读提示',
    s.phase === 'error' && s.error === '搜索失败：数据库忙' && s.hits.length === 0,
    JSON.stringify(s)
  )
  s = reduceSearchRequest(s, { type: 'begin', seq: 5, query: 'c' })
  check('重试立即回到 loading 并清除错误', s.phase === 'loading' && s.error === '', JSON.stringify(s))
  s = reduceSearchRequest(s, { type: 'reject', seq: 4, error: '旧失败' })
  check(
    '旧请求的迟到错误不覆盖新请求 loading',
    s.phase === 'loading' && s.error === '',
    JSON.stringify(s)
  )
  s = reduceSearchRequest(s, { type: 'resolve', seq: 5, hits: [] })
  check('重试成功且无命中进入 success 空态', s.phase === 'success' && s.hits.length === 0)

  // 反向：旧请求的迟到成功不得覆盖当前错误
  let t = reduceSearchRequest(initialSearchRequestState(), { type: 'begin', seq: 1, query: 'a' })
  t = reduceSearchRequest(t, { type: 'begin', seq: 2, query: 'b' })
  t = reduceSearchRequest(t, { type: 'reject', seq: 2, error: '当前失败' })
  t = reduceSearchRequest(t, { type: 'resolve', seq: 1, hits: [hit(1)] })
  check(
    '旧请求的迟到成功不覆盖当前错误',
    t.phase === 'error' && t.error === '当前失败' && t.hits.length === 0,
    JSON.stringify(t)
  )

  // 命中高亮：« » 转 mark，其余内容转义（跳页用的页码/标题渲染不回归）
  const { escapeHtml } = loadRegion('search-highlight', '{ escapeHtml }')
  check(
    '命中高亮标记与 HTML 转义',
    escapeHtml('a<b>«标题»&') === 'a&lt;b&gt;<mark>标题</mark>&amp;',
    escapeHtml('a<b>«标题»&')
  )
}

// FA01：故障注入开关在正式构建里不可达（只有测试副本才认 PAPERDESK_TEST_FAULT）
check('FA01：生产（非测试副本）不认 copy-fail', resolveTestFault(false, 'copy-fail') === null)
check('FA01：生产（非测试副本）不认 search-fail', resolveTestFault(false, 'search-fail') === null)
check('FA01：测试副本识别 copy-fail', resolveTestFault(true, 'copy-fail') === 'copy-fail')
check('FA01：测试副本识别大小写/空白变体', resolveTestFault(true, ' SEARCH-FAIL\n') === 'search-fail')
check('FA01：未知故障值不生效', resolveTestFault(true, 'unknown') === null)

// 搜索失败提示：剥掉 IPC 传输层包装，界面只显示真正原因
{
  const { readableSearchError } = loadRegion('search-error-message', '{ readableSearchError }')
  const wrapped = new Error(
    "Error invoking remote method 'search:query': Error: 测试故障注入（search-fail）：搜索暂不可用"
  )
  check(
    'FA01：搜索失败提示剥掉 IPC 包装前缀',
    readableSearchError(wrapped) === '搜索失败：测试故障注入（search-fail）：搜索暂不可用',
    readableSearchError(wrapped)
  )
  check(
    'FA01：普通错误保留原文',
    readableSearchError('数据库忙') === '搜索失败：数据库忙',
    readableSearchError('数据库忙')
  )
  check('FA01：空错误有可读兜底', readableSearchError('') === '搜索失败', readableSearchError(''))
  check(
    'FA01：只有传输层前缀时也有可读兜底',
    readableSearchError("Error invoking remote method 'search:query': Error: ") === '搜索失败'
  )
}

// 15) 分组树拖拽落点解析（group-drag.ts 纯函数，LibraryList 用的就是同一份）
{
  const rows = flattenGroupDragRows([
    {
      name: '分类A',
      parent_name: null,
      children: [
        { name: '分类A/子1', parent_name: '分类A' },
        { name: '分类A/子2', parent_name: '分类A' }
      ]
    },
    { name: '分类B', parent_name: null },
    { name: '分类C', parent_name: null }
  ])
  check(
    '拖拽行：先序展开且同层 index / depth 正确',
    rows.map((r) => `${r.name}@${r.index}/${r.depth}`).join(',') ===
      '分类A@0/0,分类A/子1@0/1,分类A/子2@1/1,分类B@1/0,分类C@2/0',
    JSON.stringify(rows)
  )

  // 拖到分组行中间 = 成为它的子分组
  const asChild = resolveGroupDrop('分类C', rows, { targetName: '分类A', edgeRatio: 0.5 })
  check(
    '落点为分组节点 → mode=child',
    asChild?.mode === 'child' &&
      asChild.parent === '分类A' &&
      asChild.position === null &&
      asChild.targetName === '分类A',
    JSON.stringify(asChild)
  )

  // 同一层：拖到上半部 = 插到该条目之前（源已在同层时不重复计位）
  const before = resolveGroupDrop('分类C', rows, { targetName: '分类B', edgeRatio: 0.1 })
  check(
    '同层上半部 → before 且 index=2',
    before?.mode === 'before' && before.parent === null && before.position === 2,
    JSON.stringify(before)
  )

  // 同一层：拖到下半部 = 插到该条目之后
  const after = resolveGroupDrop('分类C', rows, { targetName: '分类A', edgeRatio: 0.9 })
  check(
    '同层下半部 → after 且 index=2',
    after?.mode === 'after' && after.parent === null && after.position === 2,
    JSON.stringify(after)
  )

  // 跨层：拖到子分组的下半部 = 插到该子分组之后，父级是它的父级
  // 位次口径与 services/library-groups.ts::reorderLayer 一致：源不在该层时不占位，
  // 子层当前是 [子1, 子2]，插到子2 之后 = 第 3 位。
  const intoChildLayer = resolveGroupDrop('分类B', rows, {
    targetName: '分类A/子2',
    edgeRatio: 0.95
  })
  check(
    '跨层下半部 → after 且父级/位次正确',
    intoChildLayer?.mode === 'after' &&
      intoChildLayer.parent === '分类A' &&
      intoChildLayer.position === 3,
    JSON.stringify(intoChildLayer)
  )
  const intoChildLayerTop = resolveGroupDrop('分类B', rows, {
    targetName: '分类A/子2',
    edgeRatio: 0.05
  })
  check(
    '跨层上半部 → before 且位次=2',
    intoChildLayerTop?.mode === 'before' &&
      intoChildLayerTop.parent === '分类A' &&
      intoChildLayerTop.position === 2,
    JSON.stringify(intoChildLayerTop)
  )

  // 空白区 = 回到顶层
  const blank = resolveGroupDrop('分类A/子1', rows, { targetName: null })
  check(
    '落在空白区 → 回到顶层',
    blank?.mode === 'root' && blank.parent === null && blank.position === null,
    JSON.stringify(blank)
  )
  check(
    '未命中任何分组行（等价空白区）→ 回到顶层',
    resolveGroupDrop('分类A/子1', rows, { targetName: '不存在的分组' })?.mode === 'root' &&
      resolveGroupDrop('分类A/子1', rows, {})?.mode === 'root'
  )

  // 非法落点：自己或自己的后代 → 返回空（任何模式）
  check(
    '源是自己 → 空',
    resolveGroupDrop('分类A', rows, { targetName: '分类A', edgeRatio: 0.5 }) === null &&
      resolveGroupDrop('分类A', rows, { targetName: '分类A', edgeRatio: 0.05 }) === null
  )
  check(
    '源的后代 → 空（child 与 before/after 都不许成环）',
    resolveGroupDrop('分类A', rows, { targetName: '分类A/子1', edgeRatio: 0.5 }) === null &&
      resolveGroupDrop('分类A', rows, { targetName: '分类A/子1', edgeRatio: 0.05 }) === null &&
      resolveGroupDrop('分类A', rows, { targetName: '分类A/子2', edgeRatio: 0.95 }) === null
  )
  check(
    '空源名 / 无法成环判断',
    resolveGroupDrop('', rows, { targetName: '分类A' }) === null &&
      isSameOrDescendantGroup('分类A/子1', '分类A') &&
      !isSameOrDescendantGroup('分类AB', '分类A') &&
      canDropGroupOn('分类B', '分类A') &&
      !canDropGroupOn('分类A', '分类A/子1')
  )
}

// 16) 分组树折叠可见性（LibraryList renderGroupNode 用的就是 shared 的
//     isGroupCollapsed / visibleGroupNodes 语义：收起的分组子级不渲染）
  {
    const tree = buildGroupTree([
      { name: '分类A', parent_name: null, count: 5 },
      { name: '分类A/子1', parent_name: '分类A', count: 2 },
      { name: '分类A/子1/孙', parent_name: '分类A/子1', count: 1 },
      { name: '分类A/子2', parent_name: '分类A', count: 1 },
      { name: '叶子B', parent_name: null, count: 1 }
    ])
    const names = (nodes: any[]): string[] => nodes.map((n) => n.name)
    // 默认收起：有子分组的父级子级不渲染
    const shut = names(visibleGroupNodes(tree, {}))
    check(
      '分组折叠：默认收起时子级节点不渲染（父级与叶子可见）',
      shut.join(',') === '分类A,叶子B',
      shut.join(',')
    )
    check(
      '分组折叠：默认收起时子级节点不渲染（孙级/子2都不在）',
      !shut.includes('分类A/子1') && !shut.includes('分类A/子2') && !shut.includes('分类A/子1/孙')
    )
    // 展开分类A 后：其子级渲染，但孙级仍随子1默认收起
    const expandA = names(visibleGroupNodes(tree, { 分类A: false }))
    check(
      '分组折叠：展开后子级节点渲染且孙级仍默认收起',
      expandA.includes('分类A/子1') && expandA.includes('分类A/子2') &&
        !expandA.includes('分类A/子1/孙'),
      expandA.join(',')
    )
    // 全部展开：完整先序
    const allOpen = names(visibleGroupNodes(tree, { 分类A: false, '分类A/子1': false }))
    check(
      '分组折叠：逐级展开后完整先序可见',
      allOpen.join(',') === '分类A,分类A/子1,分类A/子1/孙,分类A/子2,叶子B',
      allOpen.join(',')
    )
  }

// 17) 分组区 / 文献列表分栏：分隔条存在，拖动后分组面板高度样式变化
//     （与 test-unit 的夹取用例互补：这里断言「真的渲染了分隔条」）
{
  const listSource = readFileSync(
    new URL('../src/renderer/src/features/library/LibraryList.tsx', import.meta.url),
    'utf8'
  )
  check(
    '分栏：LibraryList 渲染分隔条（sidebar__splitter / data-testid）',
    listSource.includes('data-testid="group-splitter"') &&
      listSource.includes('className="sidebar__splitter"')
  )
  check(
    '分栏：分组面板与列表面板都挂载，分组面板高度走 inline style',
    listSource.includes('data-testid="group-pane"') &&
      listSource.includes('data-testid="library-pane"') &&
      listSource.includes('style={groupPaneStyle(groupPaneHeightNow, splitAvailable)}')
  )
  check(
    '分栏：双击复位处理器已挂到分隔条',
    /onDoubleClick=\{resetGroupSplit\}/.test(listSource)
  )
  const available = 800
  const before = groupPaneStyle(GROUP_PANE_DEFAULT_HEIGHT, available)
  const draggedHeight = groupPaneHeightFromDrag(GROUP_PANE_DEFAULT_HEIGHT, 120, available)
  const after = groupPaneStyle(draggedHeight, available)
  check(
    '分栏：拖动后容器高度样式发生变化',
    before.height === `${GROUP_PANE_DEFAULT_HEIGHT}px` &&
      after.height === `${draggedHeight}px` &&
      after.height !== before.height,
    `${before.height} -> ${after.height}`
  )
}

console.log(failed === 0 ? 'COORDS_OK' : `COORDS_FAIL (${failed})`)
process.exitCode = failed === 0 ? 0 : 1
