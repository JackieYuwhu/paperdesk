// 解析检查视图模型的单元测试（Node 原生 TS 类型擦除直接运行）
// 运行: node scripts/test-blocks-view.ts
import {
  BLOCK_TYPES,
  PREVIEW_MAX,
  blockStatus,
  previewText,
  summarize,
  toRows
} from '../src/shared/blocks-view.ts'
import type {
  BlockRect,
  SourceRegion,
  StructuredBlock,
  StructuredBlockType
} from '../src/shared/blocks.ts'

let failed = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name} ${extra}`)
  }
}

const RECT: BlockRect = [72, 96, 540, 120]

function makeBlock(
  stableId: string,
  blockType: StructuredBlockType,
  page: number,
  text: string,
  extra: Partial<StructuredBlock> = {}
): StructuredBlock {
  return {
    stableId,
    blockType,
    sourceRegion: { page, rect: [...RECT] as BlockRect },
    text,
    ...extra
  }
}

// ---- 6 条样例：ok / warn×3 / error×2 ----
const LONG_TEXT = '第一段  正文\n用于检查摘要折叠与截断：' + 'x'.repeat(80)
const blocks: StructuredBlock[] = [
  // 1) ok：正文，页码坐标齐全
  makeBlock('p1-b1', 'paragraph', 1, LONG_TEXT),
  // 2) warn：未对齐（orphan）
  makeBlock('p1-b2', 'paragraph', 1, '未对齐的段落', { orphan: true }),
  // 3) warn：标题文本为空（只有空白）
  makeBlock('p2-b1', 'heading', 2, '   \n  '),
  // 4) warn：类型不在白名单（原始类型保留）
  makeBlock('p3-b1', 'footer' as StructuredBlockType, 3, '页脚块'),
  // 5) error：页码缺失（page=0）
  makeBlock('p3-b2', 'caption', 0, '缺页码的题注'),
  // 6) error：坐标缺失（rect 不存在）
  {
    stableId: 'p4-b1',
    blockType: 'equation',
    sourceRegion: { page: 4 } as unknown as SourceRegion,
    text: 'E=mc^2'
  }
]

const rows = toRows(blocks)

check('块类型白名单为 6 类且无重复', BLOCK_TYPES.length === 6 && new Set(BLOCK_TYPES).size === 6)

const st = blocks.map((b) => blockStatus(b))
check('样例 1 状态 ok 且无原因', st[0].status === 'ok' && st[0].reasons.length === 0, JSON.stringify(st[0]))
check(
  '样例 2 orphan → warn',
  st[1].status === 'warn' && st[1].reasons.join(',') === 'orphan',
  JSON.stringify(st[1])
)
check(
  '样例 3 正文空文本 → warn',
  st[2].status === 'warn' && st[2].reasons.join(',') === 'empty-text',
  JSON.stringify(st[2])
)
check(
  '样例 4 未知类型 → warn',
  st[3].status === 'warn' && st[3].reasons.join(',') === 'unknown-type',
  JSON.stringify(st[3])
)
check(
  '样例 5 缺页码 → error',
  st[4].status === 'error' && st[4].reasons.join(',') === 'missing-page',
  JSON.stringify(st[4])
)
check(
  '样例 6 缺坐标 → error',
  st[5].status === 'error' && st[5].reasons.join(',') === 'missing-bbox',
  JSON.stringify(st[5])
)
check('公式/编号不受空文本影响：equation 空文本仍 ok', blockStatus(makeBlock('p5-b1', 'equation', 5, '')).status === 'ok')

// ---- 顺序与展平 ----
check('rows 数量与输入一致', rows.length === blocks.length)
check('阅读顺序：rows[0].stableId === blocks[0].stableId', rows[0].stableId === blocks[0].stableId)
check(
  '阅读顺序与输入完全一致',
  rows.map((r) => r.stableId).join(',') === blocks.map((b) => b.stableId).join(',')
)
check('序号 1 基递增', rows.every((r, i) => r.index === i + 1))
check('bbox 展平自 sourceRegion.rect', JSON.stringify(rows[0].bbox) === JSON.stringify(RECT))
check('缺页码时 page 为 null', rows[4].page === null)
check('缺坐标时 bbox 为 null', rows[5].bbox === null)
check('未知类型原样保留在行里', rows[3].type === 'footer')

// ---- 摘要 ----
check(
  'preview 折叠空白并截断到 60 字符',
  rows[0].preview.length === PREVIEW_MAX && !/[\r\n\t]/.test(rows[0].preview),
  `len=${rows[0].preview.length}`
)
check('previewText 折叠连续空白', previewText('a  b\n\t c') === 'a b c')
check('previewText 空值安全', previewText(undefined) === '' && previewText(null) === '')

const sum = summarize(rows)
check('总数 6', sum.total === 6)
check('ok=1', sum.ok === 1)
check('warn=3', sum.warn === 3)
check('error=2', sum.error === 2)
check(
  'byType 按原始类型计数',
  sum.byType.paragraph === 2 &&
    sum.byType.heading === 1 &&
    sum.byType.footer === 1 &&
    sum.byType.caption === 1 &&
    sum.byType.equation === 1,
  JSON.stringify(sum.byType)
)
check('空输入安全', toRows(null).length === 0 && summarize([]).total === 0)

console.log(failed === 0 ? 'BLOCKSVIEW_OK' : `BLOCKSVIEW_FAIL (${failed})`)
process.exitCode = failed === 0 ? 0 : 1
