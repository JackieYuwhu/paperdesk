// block-overlay 纯函数测试（Node 原生 TS 类型擦除直接运行）
// 运行: node scripts/test-block-overlay.ts
// 末行输出 OVERLAY_OK 表示全部用例通过（具体数值断言，而非「不为空」）。
import { toCssRect, clampRect, pageMatches, fromCssPoint, hitBlockAt } from '../src/renderer/src/features/reader/block-overlay.ts'

// 常规信纸页：未旋转 612 × 792；块矩形（底边原点 y 向上）：
// x0=100, y0=200（离页底 200pt），x1=300, y1=320（离页底 320pt）
const PAGE = { width: 612, height: 792 }
const RECT = [100, 200, 300, 320] as const
const region = { page: 2, rect: RECT }

let failed = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name} ${extra}`)
  }
}
function rectEq(r: { left: number; top: number; width: number; height: number },
                left: number, top: number, width: number, height: number): boolean {
  return (
    r.left === left && r.top === top && r.width === width && r.height === height
  )
}

console.log('block-overlay 测试')

// 1) rotation=0, scale=1：top = H - y1 = 792-320 = 472
{
  const out = toCssRect(region, PAGE, { scale: 1, rotation: 0 })
  check(
    'rotation=0/scale=1 → {100,472,200,120}',
    rectEq(out, 100, 472, 200, 120),
    JSON.stringify(out)
  )
}

// 2) rotation=0, scale=1.5：全部乘 1.5
{
  const out = toCssRect(region, PAGE, { scale: 1.5, rotation: 0 })
  check(
    'rotation=0/scale=1.5 → {150,708,300,180}',
    rectEq(out, 150, 708, 300, 180),
    JSON.stringify(out)
  )
}

// 3) rotation=90（顺时针，展示尺寸变为 H×W）：left=y0=200, top=x0=100, w=y1-y0=120, h=x1-x0=200
{
  const out = toCssRect(region, PAGE, { scale: 1, rotation: 90 })
  check(
    'rotation=90/scale=1 → {200,100,120,200}',
    rectEq(out, 200, 100, 120, 200),
    JSON.stringify(out)
  )
}

// 4) rotation=90 + scale=2：两组宽高互换 × 2
{
  const out = toCssRect(region, PAGE, { scale: 2, rotation: 90 })
  check(
    'rotation=90/scale=2 → {400,200,240,400}',
    rectEq(out, 400, 200, 240, 400),
    JSON.stringify(out)
  )
}

// 5) rotation=180：left = W - x1 = 612-300 = 312, top = y0 = 200, 宽高不变
{
  const out = toCssRect(region, PAGE, { scale: 1, rotation: 180 })
  check(
    'rotation=180/scale=1 → {312,200,200,120}',
    rectEq(out, 312, 200, 200, 120),
    JSON.stringify(out)
  )
}

// 6) rotation=270：left = H - y1 = 792-320 = 472, top = W - x1 = 612-300 = 312, 宽高互换
{
  const out = toCssRect(region, PAGE, { scale: 1, rotation: 270 })
  check(
    'rotation=270/scale=1 → {472,312,120,200}',
    rectEq(out, 472, 312, 120, 200),
    JSON.stringify(out)
  )
}

// 7) rotation=180 + scale=1.5
{
  const out = toCssRect(region, PAGE, { scale: 1.5, rotation: 180 })
  check(
    'rotation=180/scale=1.5 → {468,300,300,180}',
    rectEq(out, 468, 300, 300, 180),
    JSON.stringify(out)
  )
}

// 8) 越界裁剪：矩形部分超出页面（左、下越界），裁到页面内且宽高非负
{
  const out = clampRect(
    toCssRect({ page: 1, rect: [-50, 642, 150, 900] as const }, PAGE, { scale: 1, rotation: 0 }),
    { width: 612, height: 792 }
  )
  check(
    'clampRect 越界部分裁剪 → {0,0,150,150}',
    rectEq(out, 0, 0, 150, 150),
    JSON.stringify(out)
  )
}

// 9) 完全在页面外：宽（或高）被裁成 0，不产生负数
{
  const out = clampRect(toCssRect({ page: 1, rect: [700, 100, 800, 300] as const }, PAGE, { scale: 1, rotation: 0 }), {
    width: 612,
    height: 792
  })
  check('clampRect 完全越界 → 宽=0 且无负值', out.width === 0 && out.height === 200 && out.left === 612 && out.top === 492, JSON.stringify(out))
}

// 10) 越界但先归一化负宽高
{
  const out = clampRect({ left: 300, top: 100, width: -80, height: -40 }, { width: 612, height: 792 })
  check(
    'clampRect 负宽高归一化 → {220,60,80,40}',
    rectEq(out, 220, 60, 80, 40),
    JSON.stringify(out)
  )
}

// 11) pageMatches 正例 / 反例
{
  const ok = pageMatches(region, 2)
  const wrongPage = pageMatches(region, 3)
  const missing = pageMatches(null, 2)
  const zero = pageMatches(region, 0)
  check(
    'pageMatches：p2==p2 true；p2!=p3/p2!=p0/null 均 false',
    ok === true && wrongPage === false && missing === false && zero === false,
    `ok=${ok} wrong=${wrongPage} missing=${missing} zero=${zero}`
  )
}

// 12) rotation 数值健壮性：rotation=360 视作 0（环绕），非 90 倍数报错
{
  const wrapped = toCssRect(region, PAGE, { scale: 1, rotation: 360 })
  let threw = false
  try {
    ;(toCssRect as (r: typeof region, p: typeof PAGE, o: { scale: number; rotation: number }) => unknown)(
      region,
      PAGE,
      { scale: 1, rotation: 45 }
    )
  } catch {
    threw = true
  }
  check(
    'rotation=360 环绕为 0；rotation=45 抛错',
    rectEq(wrapped, 100, 472, 200, 120) && threw === true,
    `wrapped=${JSON.stringify(wrapped)} threw=${threw}`
  )
}

// ---- 反向联动（E-4）：fromCssPoint 点级逆映射 + hitBlockAt 页面点选命中 ----

// 13) 逆映射①：四种 rotation 下，toCssRect 得到的矩形中心经 fromCssPoint 反算后落回原 region 内部
{
  const [x0, y0, x1, y1] = RECT
  const parts: string[] = []
  let allInside = true
  for (const rot of [0, 90, 180, 270]) {
    const css = toCssRect(region, PAGE, { scale: 1.5, rotation: rot })
    const back = fromCssPoint(
      { x: css.left + css.width / 2, y: css.top + css.height / 2 },
      PAGE,
      { scale: 1.5, rotation: rot }
    )
    const inside = back.x > x0 && back.x < x1 && back.y > y0 && back.y < y1
    parts.push(`r${rot}=(${back.x.toFixed(1)},${back.y.toFixed(1)})`)
    if (!inside) allInside = false
  }
  check(
    'fromCssPoint(toCssRect 中心) 四种 rotation 均落回原 region 内部',
    allInside,
    parts.join(' ')
  )
}

// 14) 逆映射②（互逆精确性）：四种 rotation 下中心反算精确回到 region 中心 (200, 260)
{
  const parts: string[] = []
  let exact = true
  for (const rot of [0, 90, 180, 270]) {
    const css = toCssRect(region, PAGE, { scale: 2, rotation: rot })
    const back = fromCssPoint(
      { x: css.left + css.width / 2, y: css.top + css.height / 2 },
      PAGE,
      { scale: 2, rotation: rot }
    )
    parts.push(`r${rot}=(${back.x},${back.y})`)
    if (Math.abs(back.x - 200) > 1e-6 || Math.abs(back.y - 260) > 1e-6) exact = false
  }
  check(
    'fromCssPoint 与 toCssRect 互为逆运算（中心精确回到 200,260，scale=2）',
    exact,
    parts.join(' ')
  )
}

// 15) hitBlockAt②：两框重叠时选面积最小的（大块 [100,200,300,320] ⊃ 小块 [150,240,250,300]）
{
  const big = { stableId: 'p2-b1', sourceRegion: { page: 2, rect: [100, 200, 300, 320] as const } }
  const small = { stableId: 'p2-b2', sourceRegion: { page: 2, rect: [150, 240, 250, 300] as const } }
  // PDF 点 (200, 260) → CSS（r=0, scale=1）: X=200, Y=792-260=532
  const hit = hitBlockAt({ x: 200, y: 532, page: 2 }, [big, small], [PAGE, PAGE], {
    scale: 1,
    rotation: 0,
  })
  check(
    'hitBlockAt 重叠命中取面积最小的块',
    hit?.stableId === 'p2-b2',
    `hit=${JSON.stringify(hit)}`
  )
}

// 16) hitBlockAt 带 rotation=90：用 toCssRect 算出的展示中心命中原块
{
  const b = { stableId: 'p2-b7', sourceRegion: { page: 2, rect: RECT } }
  const css = toCssRect({ page: 2, rect: RECT }, PAGE, { scale: 1, rotation: 90 })
  const hit = hitBlockAt(
    { x: css.left + css.width / 2, y: css.top + css.height / 2, page: 2 },
    [b],
    [PAGE, PAGE],
    { scale: 1, rotation: 90 }
  )
  check(
    'hitBlockAt rotation=90 页面内 CSS 中心命中原块',
    hit?.stableId === 'p2-b7',
    `css=${JSON.stringify(css)} hit=${JSON.stringify(hit)}`
  )
}

// 17) hitBlockAt③：点落在所有框之外 / 页面之外 → null
{
  const b = { stableId: 'p2-b1', sourceRegion: { page: 2, rect: RECT } }
  // PDF 点 (50, 50) → CSS (50, 742)：在所有框外
  const outside = hitBlockAt({ x: 50, y: 742, page: 2 }, [b], [PAGE, PAGE], {
    scale: 1,
    rotation: 0,
  })
  // PDF x=700 → CSS x=700 超出页宽 612，也命中不了
  const beyond = hitBlockAt({ x: 700, y: 532, page: 2 }, [b], [PAGE, PAGE], {
    scale: 1,
    rotation: 0,
  })
  check(
    'hitBlockAt 点在所有框外 / 页面外 → null',
    outside === null && beyond === null,
    `out=${JSON.stringify(outside)} beyond=${JSON.stringify(beyond)}`
  )
}

// 18) hitBlockAt④：块在第 2 页，点给第 1 / 第 3 页 → 不命中（pageMatches 不同页）
{
  const b = { stableId: 'p2-b1', sourceRegion: { page: 2, rect: RECT } }
  const p1 = hitBlockAt({ x: 200, y: 532, page: 1 }, [b], [PAGE, PAGE], {
    scale: 1,
    rotation: 0,
  })
  const p3 = hitBlockAt({ x: 200, y: 532, page: 3 }, [b], [PAGE, PAGE, PAGE], {
    scale: 1,
    rotation: 0,
  })
  check(
    'hitBlockAt 页码不匹配（p2 块 vs p1/p3 点）→ null',
    p1 === null && p3 === null,
    `p1=${JSON.stringify(p1)} p3=${JSON.stringify(p3)}`
  )
}

// 19) hitBlockAt 输入健壮性：页尺寸缺失 / 无块 → null
{
  const b = { stableId: 'p2-b1', sourceRegion: { page: 2, rect: RECT } }
  const noPage = hitBlockAt({ x: 200, y: 532, page: 5 }, [b], [PAGE, PAGE], {
    scale: 1,
    rotation: 0,
  })
  const noBlocks = hitBlockAt({ x: 200, y: 532, page: 2 }, [], [PAGE, PAGE], {
    scale: 1,
    rotation: 0,
  })
  check(
    'hitBlockAt 页尺寸缺失 / blocks 为空 → null',
    noPage === null && noBlocks === null,
    `noPage=${JSON.stringify(noPage)} noBlocks=${JSON.stringify(noBlocks)}`
  )
}

console.log(failed === 0 ? 'OVERLAY_OK' : `OVERLAY_FAIL (${failed})`)
process.exitCode = failed === 0 ? 0 : 1
