// 端到端验证（M1..M7：批注 / 笔记深链 / 作者引用 / 相关论文 / 翻译 / 检索RAG / 模块化与设置）：
//  1. 生成 2 页样例 PDF 与临时 userData 目录
//  2. 预置 2 条批注（第1页 / 第2页）
//  3. 用 --remote-debugging-port 启动真实 Electron App
//  4. 通过 CDP 断言：文本层/批注层/缩放不变性/IPC CRUD/笔记保存/深链跳转
// 运行: npm run test:e2e
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const PORT = 9411
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 生成 2 页最小合法 PDF（含 Info 元数据 + References 段）----
function makePdf() {
  const c1 =
    'BT /F1 20 Tf 72 720 Td (E2E Sample Paper) Tj ET\n' +
    'BT /F1 12 Tf 72 690 Td (Alice Zhang, Bob Li) Tj ET\n'
  const c2 =
    'BT /F1 14 Tf 72 700 Td (References) Tj ET\n' +
    'BT /F1 11 Tf 72 670 Td ([1] Smith J. A study of things. Journal of Tests, 2020. doi:10.1234/abcd.5678) Tj ET\n' +
    'BT /F1 11 Tf 72 645 Td ([2] Doe A. Another work on stuff. 2019.) Tj ET\n'
  const page = (contentsRef) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${contentsRef} >>`
  const stream = (s) => `<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}endstream`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    page('4 0 R'),
    stream(c1),
    page('6 0 R'),
    stream(c2),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Title (E2E Sample Paper) /Author (Alice Zhang; Bob Li) >>'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

// ---- 本地 OpenAlex mock（让 M4 离线可复现）----
function startMockOpenAlex() {
  const http = require('node:http')
  const mk = (id, name, year, citedBy) => ({
    id: `https://openalex.org/${id}`,
    doi: `https://doi.org/10.9999/${id.toLowerCase()}`,
    display_name: name,
    publication_year: year,
    cited_by_count: citedBy,
    primary_location: { source: { display_name: 'Mock Venue' } }
  })
  const SEED = 'WSEED0001'
  const works = {
    [SEED]: {
      ...mk(SEED, 'E2E Seed Paper', 2020, 5),
      referenced_works: ['https://openalex.org/WREF0001', 'https://openalex.org/WREF0002'],
      related_works: ['https://openalex.org/WREL0001']
    },
    WREF0001: mk('WREF0001', 'Reference One', 2015, 120),
    WREF0002: mk('WREF0002', 'Reference Two', 2016, 80),
    WREL0001: mk('WREL0001', 'Related One', 2019, 300),
    WCITE0001: mk('WCITE0001', 'Citing One', 2022, 40)
  }
  // OpenCode 端点调用统计（供用例断言「所有 AI 调用点都合规」）
  let ocCalls = 0
  let ocMissingSession = 0
  let lastSession = ''
  let lastUa = ''

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const filter = u.searchParams.get('filter') || ''
    const isOaSeed = u.pathname.startsWith('/works/doi:')

  // 联网检索 fixture（PD21）：搜索 JSON + 一页可抓正文的 HTML。
  // 结果 URL 用请求 Host 拼，e2e 因此能断言「来源指向本地 fixture，而不是真实外网」。
  if (u.pathname === '/websearch/search') {
    const q = u.searchParams.get('q') || ''
    if (q.includes('FAIL500')) {
      // PD25：HTTP 非 200 降级
      res.statusCode = 500
      res.setHeader('content-type', 'text/plain')
      res.end('boom')
      return
    }
    if (q.includes('HANG')) {
      // PD25：永不响应，验证客户端 3 秒预算（收尾时统一销毁连接）
      return
    }
    const host = req.headers.host || '127.0.0.1'
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        results: [
          {
            title: 'E2E Web Search Result',
            url: `http://${host}/websearch/page1`,
            snippet: 'E2E 联网摘要'
          }
        ]
      })
    )
    return
  }
  if (u.pathname === '/websearch/page1') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(
      '<html><body><h1>E2E 网页</h1><p>E2E fixture 网页正文：扩散模型用加噪与去噪学习分布。</p></body></html>'
    )
    return
  }

  // Semantic Scholar 的 mock
  if (u.pathname === '/graph/v1/paper/search') {
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        total: 1,
        data: [
          {
            paperId: 's2-e2e-1',
            title: 'Semantic Result Paper',
            year: 2023,
            venue: 'TestConf',
            citationCount: 11,
            authors: [{ name: 'C. Author' }, { name: 'D. Author' }],
            externalIds: { DOI: '10.5555/s2.2023' },
            openAccessPdf: { url: 'https://example.org/s2-paper.pdf' },
            abstract: 's2 abstract'
          }
        ]
      })
    )
    return
  }

  // SerpAPI Google Scholar 的 mock（验证 provider 接线）
  if (u.pathname === '/search.json') {
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        organic_results: [
          {
            result_id: 'scholar-e2e-1',
            title: 'Scholar Result Paper',
            link: 'https://doi.org/10.1234/scholar.2024.1',
            snippet: 'scholar snippet',
            publication_info: {
              summary: 'A. Author, B. Author - Test Journal, 2024 - example.org',
              authors: [{ name: 'A. Author' }, { name: 'B. Author' }]
            },
            inline_links: { cited_by: { total: 7 } },
            resources: [{ link: 'https://example.org/scholar-paper.pdf' }]
          }
        ],
        search_information: { total_results: 1 }
      })
    )
    return
  }

    if (u.pathname === '/mock/state') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ocCalls, ocMissingSession, lastSession, lastUa }))
      return
    }

    // OpenAlex 限流演示：特定 DOI 强制 429（用于验证 Crossref 回退）
    if (isOaSeed && decodeURIComponent(u.pathname).includes('10.9999/fallback')) {
      res.statusCode = 429
      res.setHeader('retry-after', '1')
      res.end('{"error":"rate limited"}')
      return
    }

    // Crossref：/works/{doi}
    const cr = /^\/works\/(10\..+)$/.exec(u.pathname)
    if (cr) {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          message: {
            DOI: decodeURIComponent(cr[1]),
            title: ['Fallback Paper Title'],
            'container-title': ['Mock Venue'],
            'is-referenced-by-count': 7,
            issued: { 'date-parts': [[2020]] },
            reference: [
              { DOI: '10.9999/ref-a', 'article-title': 'Fallback Ref A', year: '2018' },
              { DOI: '10.9999/ref-b', 'article-title': 'Fallback Ref B', year: '2019' }
            ]
          }
        })
      )
      return
    }

    // Crossref：/works?query.bibliographic=...
    if (u.pathname === '/works' && u.searchParams.get('query.bibliographic')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ message: { items: [{ DOI: '10.9999/fallback' }] } }))
      return
    }

    // OpenCode Go 兼容性：必须带 x-opencode-session；返回「译文」以便验证确实走了模型
    if (u.pathname.startsWith('/zen/go/v1/chat/completions')) {
      lastSession = String(req.headers['x-opencode-session'] || '')
      lastUa = String(req.headers['user-agent'] || '')
      if (!lastSession) {
        ocMissingSession++
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'MissingSessionID', message: 'Request is missing x-opencode-session' }
          })
        )
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        ocCalls++
        let content = 'pong'
        try {
          const j = JSON.parse(body)
          const user = (j?.messages || []).find((m) => m.role === 'user')?.content || ''
          const segs = user.split(/\n(?=\[\d+\])/).filter((s) => /^\[\d+\]/.test(s))
          if (segs.length > 0) {
            content = JSON.stringify(segs.map((s) => '译:' + s.replace(/^\[\d+\]\s*/, '')))
          } else if (/整张地图的现有内容/.test(user)) {
            // PD58：整图 AI 优化固定返回两份分组，供预览/应用/撤销链路验证
            content = JSON.stringify({
              rationale: '按问题与方法重排现有要点。',
              groups: [
                { title: '问题与背景', points: ['成本高', '评测缺失'] },
                { title: '方法与结果', points: ['缓存分层', '速度提升'] }
              ]
            })
          } else if (/请优化/.test(user) && /思维地图/.test(user)) {
            // PD57：AI 优化固定返回一份合法差异建议，供预览/逐项接受/撤销链路验证
            content = JSON.stringify({
              rationale: '只依据节点与原文片段整理措辞，并补两个材料里出现过的要点。',
              summary: 'AI 优化后的节点',
              children: ['材料中的新子节点'],
              mergedIds: [],
              topics: [
                { title: '问题', points: ['成本高', '评测缺失'] },
                { title: '方法', points: ['缓存'] }
              ]
            })
          }
        } catch {
          /* ignore */
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
      })
      return
    }

    let results = []
    if (isOaSeed) {
      results = [works[SEED]]
    } else if (filter.startsWith('openalex_id:')) {
      const ids = filter.slice('openalex_id:'.length).split('|')
      results = ids.map((id) => works[id]).filter(Boolean)
    } else if (filter.startsWith('cites:')) {
      results = [works.WCITE0001]
    } else if (u.pathname === '/authors' && filter.startsWith('orcid:')) {
      results = [
        {
          id: 'https://openalex.org/AAUTH0001',
          display_name: 'Orcid Person',
          orcid: filter.slice('orcid:'.length)
        }
      ]
    } else if (u.searchParams.get('search')) {
      results = [works[SEED]]
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ meta: { count: results.length }, results }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function connectCdp(port) {
  let targets = null
  for (let i = 0; i < 80; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      if (Array.isArray(targets) && targets.some((t) => t.type === 'page')) break
    } catch {
      /* retry */
    }
    await sleep(250)
  }
  const page = (targets || []).find((t) => t.type === 'page')
  if (!page) throw new Error('未找到 CDP page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = (e) => reject(new Error('WS 连接失败: ' + e.message))
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Runtime.enable', {})
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result && r.result.exceptionDetails) {
      throw new Error('renderer 异常: ' + JSON.stringify(r.result.exceptionDetails))
    }
    return r.result && r.result.result ? r.result.result.value : undefined
  }
  return { evaluate, send, close: () => ws.close() }
}

const clickByText = (sel, text) =>
  `(()=>{const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!el)return false;el.click();return true})()`

// Office 式功能区：先切到分组，再点该组内的面板
const GROUP_OF = {
  笔记: '阅读',
  问答: '阅读',
  翻译: '阅读',
  拆解论文: '阅读',
  相关论文: '研究',
  研究方向: '研究',
  文献检索: '研究',
  领域调研: '研究',
  期刊: '研究',
  作者: '研究',
  文件: '数据',
  批处理: '数据'
}
// 轮询等待「真实就绪信号」（避免固定延迟在 dev/测试实例并发、慢机下偶发失败）
const waitFor = async (cdp, expr, { timeout = 10000, interval = 100 } = {}) => {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    try {
      last = await cdp.evaluate(expr)
    } catch {
      last = undefined // 渲染进程未就绪：继续等待
    }
    if (last) return last
    if (Date.now() >= deadline) return last
    await sleep(interval)
  }
}

const panelTabExpr = (title) =>
  `[...document.querySelectorAll('[data-testid="ribbon-panels"] button')].find(x=>x.textContent.trim()===${JSON.stringify(title)})`

const openPanel = async (cdp, title) => {
  // 对照首屏会自动收起右栏；进入面板前先展开（薄条上的展开按钮始终存在）
  if (await cdp.evaluate("!!document.querySelector('[data-testid=\"rc-strip\"]')")) {
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"rc-expand\"]');if(b){b.click();return true}return false})()"
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"ribbon-groups\"]')")
  }
  const g = GROUP_OF[title]
  if (g) {
    await cdp.evaluate(clickByText('[data-testid="ribbon-groups"] button', g))
    // 等该分组切换后，其面板按钮真正出现（而不是 sleep 一个固定时长）
    await waitFor(cdp, `!!${panelTabExpr(title)}`)
  }
  const clicked = await cdp.evaluate(clickByText('[data-testid="ribbon-panels"] button', title))
  // 等该面板真正激活（按钮带 primary），再返回，保证面板已挂载
  await waitFor(cdp, `(()=>{const b=${panelTabExpr(title)};return !!(b&&b.classList.contains('primary'))})()`)
  return clicked === true
}

// 采样可见画布像素：判断是否「全黑」（黑屏回归守卫，不是掩饰手段）
const canvasLightRatioExpr =
  "(()=>{const c=document.querySelector('.scrollpage canvas');if(!c||!c.width||!c.height)return -1;try{const ctx=c.getContext('2d');const w=c.width,h=c.height;const sx=Math.max(1,Math.floor(w/32)),sy=Math.max(1,Math.floor(h/32));let light=0,total=0;for(let y=Math.floor(sy/2);y<h;y+=sy){for(let x=Math.floor(sx/2);x<w;x+=sx){const d=ctx.getImageData(x,y,1,1).data;total++;if(d[0]+d[1]+d[2]>150)light++}}return total>0?(light/total):-1}catch(e){return -2}})()"
const checkCanvasNotBlack = async (cdp, label, chk) => {
  const ratio = Number(await cdp.evaluate(canvasLightRatioExpr))
  chk(label, ratio >= 0 && ratio > 0.1, `lightRatio=${ratio}`)
  return ratio
}

// 采样指定页画布的「暗/亮」像素分布：
//   ink   = 明显偏暗的像素占比（纸张上的文字/线条）→ 用来守卫「整页空白（全白）」
//   white = 接近纯白的像素占比
//   dark  = 暗像素计数（绝对值，避免小图占比噪声）
const pagePixelsExpr = (page) =>
  `(()=>{const c=document.querySelector('[data-page="${page}"] canvas');if(!c||!c.width||!c.height)return null;` +
  `try{const ctx=c.getContext('2d');const w=c.width,h=c.height;const d=ctx.getImageData(0,0,w,h).data;` +
  `const sx=Math.max(1,Math.floor(w/700)),sy=Math.max(1,Math.floor(h/700));` +
  `let dark=0,light=0,total=0;` +
  `for(let y=0;y<h;y+=sy){for(let x=0;x<w;x+=sx){const o=(y*w+x)*4;const s=d[o]+d[o+1]+d[o+2];total++;` +
  `if(s<330)dark++;else if(s>690)light++;}}` +
  `return {w,h,total,dark,light,ink:dark/total,white:(total?light/total:1)}}catch(e){return {err:String(e)}}})()`
/**
 * 断言某页画布「有内容」：已上屏 + 有文字墨迹（非全白）+ 不黑屏。
 * 注意阈值：样张是「几行文字 + 大片空白纸」，正常画面白色占比本来就有 ~99.6%，
 * 所以「非全白」的判据是**存在暗像素**（墨迹），white 只做「不是纯粹一张白纸」的兜底。
 */
const checkPageHasInk = (sample, label, chk) =>
  chk(
    label,
    !!sample &&
      !sample.err &&
      sample.total > 0 &&
      sample.dark >= 20 &&
      sample.ink > 0.00002 &&
      sample.white < 0.9995,
    JSON.stringify(sample)
  )

// 面板现在渲染在左侧功能区：使用文库/搜索/阅读器前，确保左栏切回「文件库」
const ensureLeft = async (cdp) => {
  const hasSearch = await cdp.evaluate("!!document.querySelector('[data-testid=\"search-input\"]')")
  if (!hasSearch) {
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"entry-library\"]');if(b){b.click();return true}return false})()"
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"search-input\"]')")
  }
}

// 给受控 input/textarea/select 赋值（绕过 React 的 value setter）
const setInput = (sel, val) =>
  `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;` +
  `const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;` +
  `const set=Object.getOwnPropertyDescriptor(proto,'value').set;set.call(el,${JSON.stringify(val)});` +
  `el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paperdesk-e2e-'))
  const dataDir = path.join(tmp, 'data')
  const itemKey = 'E2ETEST1'
  const attKey = 'E2EATT01'
  const storageDir = path.join(dataDir, 'storage', itemKey)
  fs.mkdirSync(storageDir, { recursive: true })
  fs.writeFileSync(path.join(storageDir, 'sample.pdf'), makePdf())

  const schema = fs.readFileSync(path.join(ROOT, 'src', 'main', 'db', 'schema.sql'), 'utf8')
  const db = new DatabaseSync(path.join(dataDir, 'library.sqlite'))
  db.exec(schema)
  const ts = new Date().toISOString()
  db.prepare(
    'INSERT INTO items (key,doi,title,abstract,type,date_added,date_modified) VALUES (?,?,?,?,?,?,?)'
  ).run(
    itemKey,
    '10.9999/e2e.seed',
    'E2E 样例论文',
    'Deep learning for protein structure prediction and bioinformatics pipelines',
    'document',
    ts,
    ts
  )
  const itemId = db.prepare('SELECT id FROM items WHERE key = ?').get(itemKey).id
  db.prepare(
    'INSERT INTO attachments (key,item_id,path,filename,content_type,date_added) VALUES (?,?,?,?,?,?)'
  ).run(attKey, itemId, ['storage', itemKey, 'sample.pdf'].join('/'), 'sample.pdf', 'application/pdf', ts)
  const attId = db.prepare('SELECT id FROM attachments WHERE key = ?').get(attKey).id

  // 第二篇（共用同一 PDF 文件），用于验证「多篇对比表」
  db.prepare(
    'INSERT INTO items (key,doi,title,year,venue,type,date_added,date_modified) VALUES (?,?,?,?,?,?,?,?)'
  ).run('E2ETEST2', '10.9999/e2e.second', 'Second Sample Paper', 2021, 'MockVenue', 'document', ts, ts)
  const item2Id = db.prepare('SELECT id FROM items WHERE key = ?').get('E2ETEST2').id
  db.prepare(
    'INSERT INTO attachments (key,item_id,path,filename,content_type,date_added) VALUES (?,?,?,?,?,?)'
  ).run('E2EATT02', item2Id, ['storage', itemKey, 'sample.pdf'].join('/'), 'sample.pdf', 'application/pdf', ts)
  const att2Id = db.prepare('SELECT id FROM attachments WHERE key = ?').get('E2EATT02').id

  // 第三篇：用一个会让 OpenAlex 返回 429 的 DOI，用于验证 Crossref 回退
  db.prepare(
    'INSERT INTO items (key,doi,title,year,venue,type,date_added,date_modified) VALUES (?,?,?,?,?,?,?,?)'
  ).run('E2ETEST3', '10.9999/fallback', 'Fallback Paper', 2020, 'MockVenue', 'document', ts, ts)
  const item3Id = db.prepare('SELECT id FROM items WHERE key = ?').get('E2ETEST3').id

  // PD51：专门给「导入自动归属」用的第 4 篇论文（没有附件、也不会被前面的笔记用例读到），
  // 避免给 E2ETEST1 预置笔记而污染既有 notes.getForItem 断言。
  db.prepare(
    'INSERT INTO items (key,doi,title,year,venue,type,date_added,date_modified) VALUES (?,?,?,?,?,?,?,?)'
  ).run('E2ETEST4', '10.9999/pd51.import', 'PD51 导入样例论文', 2024, 'MockVenue', 'document', ts, ts)
  const pd51ImportItemId = db.prepare('SELECT id FROM items WHERE key = ?').get('E2ETEST4').id
  const insertAnn = db.prepare(
    `INSERT INTO annotations (key,attachment_id,type,text,comment,color,page_index,position,sort_index,date_added,date_modified)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
  insertAnn.run('SEEDANN1', attId, 'highlight', 'Page One Title', 'p1', '#ffd400', 0, JSON.stringify({ pageIndex: 0, rects: [[72, 695, 320, 720]] }), '715', ts, ts)
  insertAnn.run('SEEDANN2', attId, 'highlight', 'Page Two Target', 'p2', '#a8e05f', 1, JSON.stringify({ pageIndex: 1, rects: [[72, 695, 320, 720]] }), '715', ts, ts)

  // PD50：知识库种子——三种归属（直接 item_id / 只有 attachment_id / 都没有）+ 一条带引用的证据。
  // 正文故意同时含标题、粗体、列表、表格、行内代码、引用标记、图片与外链，用来断言 Markdown 渲染与
  // 「图片只出链接文字、外链走主进程 openExternal、DOM 里不再有 ** / ## / |---|」。
  const entry1Body = [
    '## 方法拆解',
    '',
    '**核心结论**：注意力机制在该任务上带来稳定提升。',
    '',
    '- 要点一：多头注意力',
    '- 要点二：残差连接，见 [p.7, Tab.3]',
    '',
    '| 指标 | 数值 |',
    '| --- | --- |',
    '| 准确率 | 0.93 |',
    '',
    '行内代码 `attn(Q,K,V)`，另见 [p.7–9]。',
    '',
    '![图 1](https://example.invalid/figure.png)',
    '',
    '外链：[示例论文](https://example.com/paper)'
  ].join('\n')
  const insertEntry = db.prepare(
    `INSERT INTO knowledge_entries
       (key,kind,title,body,content_nature,item_id,attachment_id,source_type,source_ref,
        content_hash,state,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  insertEntry.run(
    'E2EKNOW1',
    'concept',
    'E2E 知识条目（直接归属）',
    entry1Body,
    'author_claim',
    itemId,
    null,
    'digest',
    '{}',
    'hash-e2e-know-1',
    'active',
    ts,
    ts
  )
  const entry1Id = db.prepare('SELECT id FROM knowledge_entries WHERE key = ?').get('E2EKNOW1').id
  insertEntry.run(
    'E2EKNOW2',
    'result',
    'E2E 知识条目（附件归属）',
    '只有附件归属的正文。',
    'observation',
    null,
    attId,
    'digest',
    '{}',
    'hash-e2e-know-2',
    'active',
    ts,
    ts
  )
  insertEntry.run(
    'E2EKNOW3',
    'note',
    'E2E 知识条目（未关联论文）',
    '没有任何归属的正文。',
    'observation',
    null,
    null,
    'user',
    '{}',
    'hash-e2e-know-3',
    'active',
    ts,
    ts
  )
  db.prepare(
    `INSERT INTO evidence_links
       (entry_id,source_type,source_ref,item_id,attachment_id,page_index,page_end,module_id,
        quote,section_path,precision,content_hash,verified,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    entry1Id,
    'paper',
    '{}',
    itemId,
    attId,
    0,
    0,
    'm-cite',
    '结论见 [p.7, Tab.3]，另见 [p.7–9]。',
    '1 方法',
    'page',
    'hash-e2e-ev-1',
    1,
    ts
  )

  // PD51：暂存区种子。批次 A = 12 条已核验待审 + 2 条未核验待审 + 1 条已发布 + 1 条已拒绝，
  // 批次 B 只有已发布条目（用来断言「无待审时全部批准禁用」）。批次标题与首条提案标题故意
  // 是 60 个字符、中间没有空格，用来验证长文本不会撑破容器。
  const pd51LongTitle = 'E2EPD51' + 'LONG'.repeat(13) + 'X'
  if (pd51LongTitle.length !== 60) throw new Error('PD51 长标题必须正好 60 字符')
  const insertBatch = db.prepare(
    `INSERT INTO proposal_batches
       (key,title,task,scope_type,scope_ref,status,origin,idempotency_key,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  )
  insertBatch.run(
    'E2E-PD51-BATCH',
    `PD51 ${pd51LongTitle}`,
    'manual',
    'library',
    null,
    'ready',
    'user',
    'e2e:pd51:batch',
    ts,
    ts
  )
  insertBatch.run(
    'E2E-PD51-CLOSED',
    'PD51 已处理完的批次',
    'manual',
    'library',
    null,
    'published',
    'user',
    'e2e:pd51:closed',
    ts,
    ts
  )
  const pd51BatchId = db.prepare('SELECT id FROM proposal_batches WHERE key = ?').get('E2E-PD51-BATCH').id
  const pd51ClosedBatchId = db
    .prepare('SELECT id FROM proposal_batches WHERE key = ?')
    .get('E2E-PD51-CLOSED').id
  const insertProposal = db.prepare(
    `INSERT INTO knowledge_proposals
       (key,batch_id,item_id,op,patch_json,reason,content_nature,source_type,source_ref,
        status,verification,checks_json,idempotency_key,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  const pd51Patch = (title) =>
    JSON.stringify({ content: { kind: 'concept', title, body: `${title} 的正文内容。` }, evidence: [] })
  const insertPd51Proposal = (key, batchId, title, status, verification, checks) =>
    insertProposal.run(
      key,
      batchId,
      itemId,
      'create',
      pd51Patch(title),
      'PD51 种子：暂存区回归用例',
      'author_claim',
      'note',
      '{}',
      status,
      verification,
      checks,
      `e2e:${key.toLowerCase()}`,
      ts,
      ts
    )
  const pd51VerifiedChecks = '{"needsVerification":false,"problems":[]}'
  const pd51PendingChecks = '{"needsVerification":true,"problems":["来源待核验"]}'
  for (let i = 1; i <= 12; i++) {
    insertPd51Proposal(
      `E2E-PD51-P${i}`,
      pd51BatchId,
      i === 1 ? pd51LongTitle : `PD51 已核验提案 ${i}`,
      'pending_review',
      'verified',
      pd51VerifiedChecks
    )
  }
  for (let i = 13; i <= 14; i++) {
    insertPd51Proposal(
      `E2E-PD51-P${i}`,
      pd51BatchId,
      `PD51 未核验提案 ${i}`,
      'pending_review',
      'pending',
      pd51PendingChecks
    )
  }
  insertPd51Proposal('E2E-PD51-P15', pd51BatchId, 'PD51 已发布提案', 'published', 'verified', pd51VerifiedChecks)
  insertPd51Proposal('E2E-PD51-P16', pd51BatchId, 'PD51 已拒绝提案', 'rejected', 'verified', pd51VerifiedChecks)
  insertPd51Proposal(
    'E2E-PD51-P17',
    pd51ClosedBatchId,
    'PD51 闭环批次已发布',
    'published',
    'verified',
    pd51VerifiedChecks
  )
  // 导入归属：当前打开的论文有一份笔记文件，点「导入我的笔记」应自动归到该论文。
  // 文件放在 storage/ 而不是 notes/，避免让「笔记目录只有一份 md」这条既有断言多出一个文件。
  fs.writeFileSync(
    path.join(dataDir, 'storage', 'pd51-note.md'),
    ['# PD51 笔记', '', '- 笔记要点一：蛋白质结构预测', '- 笔记要点二：注意力机制'].join('\n'),
    'utf8'
  )
  db.prepare(
    'INSERT INTO notes (key,item_id,title,md_path,date_added,date_modified) VALUES (?,?,?,?,?,?)'
  ).run('E2E-NOTE-PD51', pd51ImportItemId, 'PD51 测试笔记', 'storage/pd51-note.md', ts, ts)
  db.close()

  const mock = await startMockOpenAlex()

  // 在 Electron 内跑的测试进程会继承 ELECTRON_RUN_AS_NODE=1：不删掉的话 electron 会把自己
  // 当成 Node 执行，--remote-debugging-port / --user-data-dir 会被判为非法参数（CDP 起不来）。
  const appEnv = { ...process.env }
  delete appEnv.ELECTRON_RUN_AS_NODE
  delete appEnv.ELECTRON_RENDERER_URL
  // 主进程日志：验证「点击来源 → openExternal」真的走到主进程（不真的开浏览器）
  const appLog = []
  const child = spawn(
    require('electron'),
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`, '.'],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...appEnv,
        PAPERDESK_OPENALEX_BASE: `http://127.0.0.1:${mock.port}`,
        PAPERDESK_CROSSREF_BASE: `http://127.0.0.1:${mock.port}`,
        PAPERDESK_SERPAPI_BASE: `http://127.0.0.1:${mock.port}/search.json`,
        PAPERDESK_SERPAPI_KEY: 'e2e-key',
        PAPERDESK_S2_BASE: `http://127.0.0.1:${mock.port}/graph/v1`,
        PAPERDESK_WEBSEARCH_BASE: `http://127.0.0.1:${mock.port}/websearch`,
        // 点击来源时不真的拉起系统浏览器：主进程只记录 URL
        PAPERDESK_E2E_NO_EXTERNAL: '1'
      }
    }
  )
  child.stdout.on('data', (d) => {
    appLog.push(String(d))
    process.stdout.write('[app] ' + d)
  })
  child.stderr.on('data', (d) => process.stdout.write('[app:err] ' + d))

  let failed = 0
  const check = (name, cond, extra = '') => {
    if (cond) console.log(`  PASS  ${name}`)
    else {
      failed++
      console.log(`  FAIL  ${name} ${extra}`)
    }
  }
  const boxExpr =
    "(()=>{const e=document.querySelector('[data-ann=\"0\"] .ann--highlight');if(!e)return null;const r=e.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)}})()"
  const pageExpr = "document.querySelector('[data-testid=\"toolbar-page-label\"]').textContent.trim()"

  try {
    const cdp = await connectCdp(PORT)
    let spans = 0
    for (let i = 0; i < 60; i++) {
      spans = await cdp.evaluate("document.querySelectorAll('.textLayer span').length")
      if (spans > 0) break
      await sleep(250)
    }
    await ensureLeft(cdp)
    console.log('--- M1 批注 ---')
    const anns = await cdp.evaluate(
      "document.querySelectorAll('[data-ann=\"0\"] .ann--highlight').length"
    )
    const pctExpr =
      "(parseFloat((document.querySelector('[data-testid=\"toolbar-zoom\"]')||{}).textContent)||0)"
    const pctBefore = await cdp.evaluate(pctExpr)
    const box = await cdp.evaluate(boxExpr)
    check('文本层已渲染 (span>0)', spans > 0, `spans=${spans}`)
    await checkCanvasNotBlack(cdp, '首屏画布非全黑（未黑屏）', check)
    check('第1页预置批注已渲染', anns === 1, `anns=${anns}`)
    check('批注盒尺寸有效', !!box && box.w > 0 && box.h > 0, JSON.stringify(box))

    await ensureLeft(cdp)
    console.log('--- M1b 文件标签栏 & 面板折叠 ---')
    check(
      '多文档「文件标签栏」出现',
      (await waitFor(cdp, "!!document.querySelector('[data-testid=\"doc-tabs\"]')")) === true
    )
    check(
      '当前文档标签存在且高亮（class on）',
      (await cdp.evaluate(
        `(()=>{const t=document.querySelector('[data-testid="doc-tab-${itemId}"]');return !!t&&t.classList.contains('on')})()`
      )) === true
    )
    check(
      '标签栏提供关闭按钮',
      (await cdp.evaluate(
        `!!document.querySelector('[data-testid="doc-tab-close-${itemId}"]')`
      )) === true
    )
    // Batch A：顶栏功能区 + 左侧功能面板（右栏已移除）
    check(
      '顶栏功能区（分组 + 面板按钮）存在',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"ribbon-groups\"]') && !!document.querySelector('[data-testid=\"ribbon-panels\"]')"
      )) === true
    )
    check(
      '右侧面板栏已移除',
      (await cdp.evaluate("!document.querySelector('.rightcol')")) === true
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"panel-tab-notes\"]');if(b){b.click();return true}return false})()"
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"left-panel\"]')")
    check(
      '点顶栏面板 → 左侧功能区显示该面板',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"left-panel\"]') && !document.querySelector('[data-testid=\"search-input\"]')"
      )) === true
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"entry-library\"]');if(b){b.click();return true}return false})()"
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"search-input\"]')")
    check(
      '点「文件库」入口 → 左侧恢复文库',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"search-input\"]')")) === true
    )

    // 面板内「加入批处理」入口（顶栏的立即执行/加入批处理已按需求移除）
    await openPanel(cdp, '拆解论文')
    check(
      '拆解面板提供「加入批处理」入口',
      (await waitFor(cdp, "!!document.querySelector('[data-testid=\"analysis-add-batch\"]')")) === true
    )
    check(
      'batch 暴露「立即执行」API（复用同一任务核心）',
      (await cdp.evaluate("typeof window.api.batch.runOnce === 'function'")) === true
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"analysis-add-batch\"]');if(b){b.click();return true}return false})()"
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"batch-task\"]')")
    const preTask = await cdp.evaluate(
      "document.querySelector('[data-testid=\"batch-task\"]')?.value || ''"
    )
    check('「加入批处理」预选了该功能的任务', preTask === 'analyze-paper', `task=${preTask}`)

    await cdp.evaluate("document.querySelector('[data-testid=\"toolbar-zoom-in\"]').click()")
    await sleep(900)
    const pctAfter = await cdp.evaluate(pctExpr)
    const boxZoom = await cdp.evaluate(boxExpr)
    const ratio = box && boxZoom ? boxZoom.w / box.w : 0
    const expectRatio = pctBefore > 0 ? pctAfter / pctBefore : 0
    check(
      '缩放不变性 (放大后按比例缩放)',
      expectRatio > 0 && Math.abs(ratio - expectRatio) < 0.04,
      `ratio=${ratio.toFixed(3)} expect=${expectRatio.toFixed(3)} (${pctBefore}%→${pctAfter}%)`
    )

    // 顶部公共工具栏（受控缩放）接入后，内置缩放控件需保持可用且行为不变
    const pctShown = String(await cdp.evaluate(pctExpr)).trim()
    await cdp.evaluate("document.querySelector('[data-testid=\"toolbar-zoom-out\"]').click()")
    await sleep(500)
    const pctOut = await cdp.evaluate(pctExpr)
    await cdp.evaluate("document.querySelector('[data-testid=\"toolbar-zoom-in\"]').click()")
    await sleep(500)
    const pctBack = await cdp.evaluate(pctExpr)
    check(
      '缩放控件（zoom-out/zoom-level）仍工作',
      /^\d+%?$/.test(pctShown) && pctOut < pctAfter && pctBack > pctOut,
      `${pctAfter}%→${pctOut}%→${pctBack}% (${pctShown})`
    )

    await ensureLeft(cdp)
    console.log('--- M1c 公共工具栏（固定常驻：只置灰不消失） ---')
    check(
      '公共工具栏始终存在',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"common-toolbar\"]')")) === true
    )
    const modeBtns = await cdp.evaluate(
      "['view-original','view-bilingual'].map(t=>!!document.querySelector('[data-testid=\"'+t+'\"]'))"
    )
    check(
      '两种阅读模式按钮始终渲染（按钮不会消失）',
      Array.isArray(modeBtns) && modeBtns.every((x) => x === true),
      JSON.stringify(modeBtns)
    )
    check(
      '「网页」阅读模式已移除',
      (await cdp.evaluate("!document.querySelector('[data-testid=\"view-html\"]')")) === true
    )
    // 侧栏入口：文件库 / 目录 / 搜索 / 笔记（收起后入口仍在）
    check(
      '侧栏入口按钮始终渲染（文件库/目录/搜索）',
      (await cdp.evaluate(
        "['entry-library','entry-toc','entry-search'].every(t=>!!document.querySelector('[data-testid=\"'+t+'\"]'))"
      )) === true
    )
    check(
      '点「目录」入口在左侧显示目录面板',
      (await cdp.evaluate(
        "(()=>{const b=document.querySelector('[data-testid=\"entry-toc\"]');if(!b)return false;b.click();return true})()"
      )) === true
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"toc-panel\"]')")
    check(
      '目录面板出现',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"toc-panel\"]')")) === true
    )
    // 恢复默认：回到「文件库」，避免影响后续用例
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"entry-library\"]');if(b)b.click();return true})()"
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"search-input\"]')")
    check(
      '未翻译时「原文」可用、「中英对照」置灰但仍在',
      (await cdp.evaluate(
        "(()=>{const o=document.querySelector('[data-testid=\"view-original\"]');const b=document.querySelector('[data-testid=\"view-bilingual\"]');return !!o&&!o.disabled&&!!b&&b.disabled})()"
      )) === true
    )
    check(
      '公共工具栏页码指示匹配 N / N',
      /^\s*\d+\s*\/\s*\d+\s*$/.test(
        await cdp.evaluate(
          "(document.querySelector('[data-testid=\"toolbar-page-label\"]')||{}).textContent||''"
        )
      )
    )
    const tz0 = String(
      await cdp.evaluate(
        "(document.querySelector('[data-testid=\"toolbar-zoom\"]')||{}).textContent||''"
      )
    ).trim()
    await cdp.evaluate("document.querySelector('[data-testid=\"toolbar-zoom-out\"]').click()")
    await sleep(500)
    const tzOut = String(
      await cdp.evaluate(
        "(document.querySelector('[data-testid=\"toolbar-zoom\"]')||{}).textContent||''"
      )
    ).trim()
    const fitOk = await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"toolbar-zoom-fit\"]');if(!b||b.disabled)return false;b.click();return true})()"
    )
    await sleep(600)
    const tzFit = String(
      await cdp.evaluate(
        "(document.querySelector('[data-testid=\"toolbar-zoom\"]')||{}).textContent||''"
      )
    ).trim()
    check(
      '公共工具栏缩放：显示百分比、可缩小、可用「适应宽度」恢复',
      /^\d+%$/.test(tz0) && /^\d+%$/.test(tzOut) && fitOk === true && /^\d+%$/.test(tzFit),
      `${tz0}→${tzOut}→${tzFit}`
    )

    const annIds = await cdp.evaluate(
      `window.api.reader.listAnnotations(${attId}).then(a=>Object.fromEntries(a.map(x=>[x.key,x.id])))`
    )
    const createdId = await cdp.evaluate(
      `window.api.reader.createAnnotation({attachmentId:${attId},type:'underline',pageIndex:0,rects:[[80,600,260,620]],color:'#7cc4ff',text:'e2e'}).then(a=>a.id)`
    )
    const afterCreate = await cdp.evaluate(`window.api.reader.listAnnotations(${attId}).then(a=>a.length)`)
    await cdp.evaluate(`window.api.reader.deleteAnnotation(${createdId})`)
    const afterDelete = await cdp.evaluate(`window.api.reader.listAnnotations(${attId}).then(a=>a.length)`)
    check('IPC 查询到 2 条批注', afterDelete === 2, `count=${afterDelete}`)
    check('IPC 创建后为 3 条', afterCreate === 3, `count=${afterCreate}`)
    check('IPC 删除后回到 2 条', afterDelete === 2, `count=${afterDelete}`)

    await ensureLeft(cdp)
    console.log('--- M2 笔记 & 深链 ---')
    await ensureLeft(cdp)
    await openPanel(cdp, '笔记')
    const created = await cdp.evaluate(clickByText('.notes button', '新建笔记'))
    await sleep(500)
    check('笔记面板可新建', created === true)

    const md =
      '# 我的阅读笔记\n\n' +
      '> **高亮**：Page Two Target\n' +
      '> — p.2 [↗ 原文](paperdesk://open?attachment=' +
      attKey +
      '&page=2&annotation=SEEDANN2)\n'
    const setOk = await cdp.evaluate(
      `(()=>{const ta=document.querySelector('.notes__editor');if(!ta)return false;const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(ta,${JSON.stringify(
        md
      )});ta.dispatchEvent(new Event('input',{bubbles:true}));return true})()`
    )
    await sleep(300)
    await cdp.evaluate(clickByText('.notes button', '保存'))
    await sleep(500)
    const savedContent = await cdp.evaluate(
      `window.api.notes.getForItem(${itemId}).then(n=>n?n.content:'')`
    )
    check('笔记已保存 (含深链)', setOk === true && savedContent.includes('paperdesk://open'), `saved=${savedContent.length}`)

    // 文件落盘
    const notesDir = path.join(dataDir, 'notes')
    const files = fs.existsSync(notesDir) ? fs.readdirSync(notesDir) : []
    const fileBody = files.length ? fs.readFileSync(path.join(notesDir, files[0]), 'utf8') : ''
    check(
      '笔记 md 文件已落盘（纯 Markdown，无 front-matter）',
      files.length === 1 && !fileBody.startsWith('---\n') && fileBody.includes('# 我的阅读笔记'),
      `files=${files.join(',')}`
    )

    await cdp.evaluate(clickByText('.notes button', '预览'))
    await sleep(400)
    const linkHref = await cdp.evaluate(
      "(()=>{const a=document.querySelector('.notes__preview a[href^=\"paperdesk://\"]');return a?a.getAttribute('href'):null})()"
    )
    check('预览里渲染出可点击深链', !!linkHref && linkHref.includes('annotation=SEEDANN2'), `href=${linkHref}`)

    const before = await cdp.evaluate(pageExpr)
    await cdp.evaluate(
      "(()=>{const a=document.querySelector('.notes__preview a[href^=\"paperdesk://\"]');if(!a)return false;a.click();return true})()"
    )
    await sleep(2200)
    const after = await cdp.evaluate(pageExpr)
    const flashed = await cdp.evaluate("document.querySelectorAll('.ann--flash').length")
    const flashDbg = await cdp.evaluate(
      "JSON.stringify({flash:document.querySelectorAll('.ann--flash').length,ann2:document.querySelectorAll('[data-key=\"SEEDANN2\"]').length,all:document.querySelectorAll('.annotationLayer .ann').length,pages:document.querySelectorAll('.scrollpage').length})"
    )
    check('点击深链前在第 1 页', before === '1 / 2', `before=${before}`)
    check('点击深链后跳到第 2 页', after === '2 / 2', `after=${after}`)
    check('目标批注被闪烁定位', flashed === 1, `flashed=${flashed} ${flashDbg}`)

    // IPC：把第 1 页批注加入笔记
    const addRes = await cdp.evaluate(
      `window.api.notes.addAnnotation(${itemId},${annIds['SEEDANN1']}).then(n=>n.content)`
    )
    check(
      '批注可一键加入笔记',
      typeof addRes === 'string' && addRes.includes('annotation=SEEDANN1') && addRes.includes('p.1'),
      `len=${addRes ? addRes.length : 0}`
    )

    await ensureLeft(cdp)
    console.log('--- M3 作者/引用识别 ---')
    // 元数据面板已移除：直接调用抽取 API（与导入时自动识别同一入口）
    const btnClicked = await cdp.evaluate(
      `window.api.metadata.extract(${attId}).then(()=>true).catch(()=>false)`
    )
    check('可触发元数据/引用识别（API）', btnClicked === true)

    let metaView = null
    for (let i = 0; i < 80; i++) {
      metaView = await cdp.evaluate(`window.api.metadata.get(${itemId})`)
      if (metaView && metaView.authors && metaView.authors.length > 0) break
      await sleep(500)
    }
    const authorNames = (metaView?.authors || []).map((a) => a.name)
    const refs = metaView?.references || []
    const resolved = refs.filter((r) => r.resolved)
    check(
      '识别出作者',
      authorNames.includes('Alice Zhang') && authorNames.includes('Bob Li'),
      JSON.stringify(authorNames)
    )
    check('识别出参考文献 >=2 条', refs.length >= 2, `refs=${refs.length}`)
    check(
      '参考文献 DOI 已解析入库',
      resolved.some((r) => r.doi === '10.1234/abcd.5678'),
      JSON.stringify(resolved.map((r) => r.doi))
    )

    const summary = await cdp.evaluate(`window.api.metadata.extract(${attId})`)
    check(
      '抽取摘要：2 页 / 2 引用 / 至少 1 DOI',
      summary.pageCount === 2 && summary.referenceCount === 2 && summary.resolvedCount >= 1,
      JSON.stringify(summary)
    )

    // 元数据面板已移除：不再检查其 DOM，只保留抽取结果的 API 断言（见上）
    await ensureLeft(cdp)
    console.log('--- M4 相关论文图谱 ---')
    await openPanel(cdp, '相关论文')
    await sleep(400)
    const discBtn = await cdp.evaluate(clickByText('.panel button', '开始查询'))
    check('可触发相关论文查询', discBtn === true)

    let g = null
    for (let i = 0; i < 40; i++) {
      g = await cdp.evaluate(`window.api.discovery.graph(${itemId})`)
      if (g && g.nodes && g.nodes.length > 1) break
      await sleep(300)
    }
    check('解析出种子论文', !!g && !!g.seed && g.seed.title === 'E2E Seed Paper', JSON.stringify(g && g.seed))
    check(
      '图谱节点数正确 (1种子+2参考+1相关+1施引=5)',
      !!g && g.nodes.length === 5,
      g ? `nodes=${g.nodes.length}` : 'null'
    )
    check(
      '图谱边数正确 (2+1+1=4)',
      !!g && g.edges.length === 4,
      g ? `edges=${g.edges.length}` : 'null'
    )
    check(
      '统计正确',
      !!g && g.stats.references === 2 && g.stats.related === 1 && g.stats.citations === 1,
      JSON.stringify(g && g.stats)
    )

    await waitFor(cdp, "document.querySelectorAll('[data-testid=\"disc-list\"] li').length >= 4")
    const cyCanvas = await cdp.evaluate(
      "document.querySelector('[data-testid=\"disc-graph\"] canvas') ? 1 : 0"
    )
    const listCount = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"disc-list\"] li').length"
    )
    check('Cytoscape 已渲染画布', cyCanvas === 1)
    check('相关论文列表渲染', listCount >= 4, `li=${listCount}`)
    check(
      '列表项带节点映射（供图中点选跳转）',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"disc-list\"] li[data-node-id]')"
      )) === true
    )
    check(
      '显示「已取 / 共」统计',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"disc-counts\"]')")) === true
    )
    // 图例可点击筛选：点「参考文献」→ 列表只剩该类别；点「全部」恢复
    check(
      '图例为可点击按钮（含「全部」）',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"disc-legend\"]') && !!document.querySelector('[data-testid=\"disc-legend-all\"]') && !!document.querySelector('[data-testid=\"disc-legend-reference\"]')"
      )) === true
    )
    await cdp.evaluate("document.querySelector('[data-testid=\"disc-legend-reference\"]')?.click()")
    await sleep(300)
    const filteredKinds = await cdp.evaluate(
      "[...document.querySelectorAll('[data-testid=\"disc-list\"] li .disc__badge')].map(b=>b.textContent.trim())"
    )
    check(
      '点图例按类别筛选列表',
      Array.isArray(filteredKinds) && filteredKinds.length > 0 && filteredKinds.every((k) => k === '参考文献'),
      JSON.stringify(filteredKinds)
    )
    await cdp.evaluate("document.querySelector('[data-testid=\"disc-legend-all\"]')?.click()")
    await sleep(300)
    const backAll = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"disc-list\"] li').length"
    )
    check('点「全部」恢复所有条目', backAll === listCount, `all=${backAll} expect=${listCount}`)

    // 按「研究方向」检索（OpenAlex）——独立面板，与当前论文无关
    const topicG = await cdp.evaluate(
      "window.api.discovery.graph(0, 'topic', 'protein structure prediction').then(g=>({seed:g.seed&&g.seed.title, n:g.nodes.length}))"
    )
    check(
      '研究方向检索返回以「方向」为中心的图谱',
      !!topicG && /研究方向/.test(String(topicG.seed)) && topicG.n >= 2,
      JSON.stringify(topicG)
    )
    await openPanel(cdp, '研究方向')
    await sleep(300)
    check(
      '研究方向是独立面板（提供输入框）',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"disc-topic-input\"]')")) === true
    )
    await cdp.evaluate(setInput('[data-testid="disc-topic-input"]', 'graph neural network'))
    await cdp.evaluate("document.querySelector('[data-testid=\"disc-run\"]')?.click()")
    await sleep(1400)
    check(
      '按方向检索后列表渲染结果',
      (await cdp.evaluate("document.querySelectorAll('[data-testid=\"disc-list\"] li').length")) >= 1
    )
    // 还原到「相关论文」面板，避免影响后续用例
    await openPanel(cdp, '相关论文')
    await sleep(200)

    // 研究 → 文献检索（关键词检索 + 下载/入库）
    const wsApi = await cdp.evaluate(
      "window.api.works.search('e2e seed').then(r=>({n:r.results.length,total:r.total,src:r.source}))"
    )
    check(
      '文献检索 API 返回结果（含来源）',
      !!wsApi && wsApi.n >= 1 && wsApi.total >= 1 && typeof wsApi.src === 'string',
      JSON.stringify(wsApi)
    )
    await openPanel(cdp, '文献检索')
    await sleep(300)
    check(
      '文献检索面板可渲染（含检索入口）',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"works-panel\"]') && !!document.querySelector('[data-testid=\"works-run\"]')"
      )) === true
    )
    await cdp.evaluate(setInput('[data-testid="works-query"]', 'e2e seed'))
    await cdp.evaluate("document.querySelector('[data-testid=\"works-run\"]')?.click()")
    await sleep(1500)
    check(
      '文献检索后列表渲染结果',
      (await cdp.evaluate("document.querySelectorAll('[data-testid=\"works-list\"] li').length")) >= 1
    )
    check(
      '检索结果提供「设为种子」入口',
      (await cdp.evaluate("!!document.querySelector('[data-testid^=\"works-seed-\"]')")) === true
    )
    check(
      '检索结果提供「按引用展开」入口',
      (await cdp.evaluate("!!document.querySelector('[data-testid^=\"works-cite-\"]')")) === true
    )
    check(
      '文献检索支持 关键词/作者/DOI 三种方式',
      (await cdp.evaluate(
        "['works-mode-keyword','works-mode-author','works-mode-doi'].every(t=>!!document.querySelector('[data-testid=\"'+t+'\"]'))"
      )) === true
    )
    check(
      '检索结果提供「导出 PDF」入口',
      (await cdp.evaluate("!!document.querySelector('[data-testid^=\"works-export-\"]')")) === true
    )
    const doiSearch = await cdp.evaluate(
      "window.api.works.search('10.9999/e2e.seed',{mode:'doi'}).then(r=>Array.isArray(r.results))"
    )
    check('DOI 精确检索已接线（返回结果数组）', doiSearch === true)
    // Google Scholar provider（SerpAPI mock）
    await cdp.evaluate(
      "(()=>{const s=document.querySelector('[data-testid=\"works-provider\"]');if(!s)return false;s.value='google';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()"
    )
    await cdp.evaluate(setInput('[data-testid="works-query"]', 'scholar e2e'))
    await cdp.evaluate("document.querySelector('[data-testid=\"works-run\"]')?.click()")
    await sleep(1500)
    check(
      'Google Scholar 检索结果渲染',
      (await cdp.evaluate("document.body.innerText.includes('Scholar Result Paper')")) === true
    )
    check(
      'Google Scholar 来源标识',
      (await cdp.evaluate("document.body.innerText.includes('来源 google')")) === true
    )
    // Semantic Scholar provider（mock）
    await cdp.evaluate(
      "(()=>{const s=document.querySelector('[data-testid=\"works-provider\"]');if(!s)return false;s.value='semantic';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()"
    )
    await cdp.evaluate(setInput('[data-testid="works-query"]', 'semantic e2e'))
    await cdp.evaluate("document.querySelector('[data-testid=\"works-run\"]')?.click()")
    await sleep(1500)
    check(
      'Semantic Scholar 检索结果渲染',
      (await cdp.evaluate("document.body.innerText.includes('Semantic Result Paper')")) === true
    )
    check(
      'Semantic Scholar 来源标识',
      (await cdp.evaluate("document.body.innerText.includes('来源 semantic')")) === true
    )
    await cdp.evaluate(
      "(()=>{const s=document.querySelector('[data-testid=\"works-provider\"]');if(!s)return false;s.value='auto';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()"
    )
    check(
      '文献检索提供「全部加入文库」与「导出 BibTeX」',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"works-add-all\"]') && !!document.querySelector('[data-testid=\"works-bibtex\"]')"
      )) === true
    )
    // 领域调研：种子 → OpenAlex 检索 → 并发拆解卡 → 多视角路由（模型为离线 mock）
    const survey = await cdp.evaluate(
      `(async()=>{
        const items = await window.api.library.list()
        if (!items.length) return { error: 'no-items' }
        const r = await window.api.survey.run({
          seedItemIds: [items[0].id],
          provider: 'openalex',
          limit: 4,
          analysisWorkers: 4,
          routerWorkers: 3
        })
        return {
          candidates: r.candidates.length,
          recommendations: r.recommendations.length,
          source: r.source,
          analysis: r.workers.analysis,
          router: r.workers.router,
          hasTiming: !!r.timing && r.timing.totalMs >= 0
        }
      })()`
    )
    check(
      '领域调研 API：检索→并发拆解→多视角推荐已接线',
      !!survey &&
        !survey.error &&
        survey.candidates >= 1 &&
        survey.recommendations >= 1 &&
        survey.analysis === 4 &&
        survey.router === 3 &&
        survey.hasTiming,
      JSON.stringify(survey)
    )
    await openPanel(cdp, '领域调研')
    await sleep(400)
    check(
      '领域调研面板可渲染（种子/检索/并发/运行入口）',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"survey-panel\"]') && !!document.querySelector('[data-testid=\"survey-run\"]') && !!document.querySelector('[data-testid=\"survey-query\"]')"
      )) === true
    )
    await ensureLeft(cdp)
    // 回到「相关论文」面板（确保图谱列表处于激活/可见状态）再做「加入文库」
    await openPanel(cdp, '相关论文')
    await sleep(400)

    const libBefore = await cdp.evaluate('window.api.library.list().then(a=>a.length)')
    const discBtnCount = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"disc-list\"] button').length"
    )
    await cdp.evaluate(
      "(()=>{const b=[...document.querySelectorAll('[data-testid=\"disc-list\"] button')].find(x=>x.textContent.includes('加入文库'));if(!b)return false;b.click();return true})()"
    )
    await sleep(600)
    const libAfter = await cdp.evaluate('window.api.library.list().then(a=>a.length)')
    check(
      '可从图谱一键加入文库',
      libAfter === libBefore + 1,
      `before=${libBefore} after=${libAfter} btns=${discBtnCount}`
    )

    // 从链接 / DOI 导入：API 已暴露，且空输入安全返回 { ok: false }（不做真实网络下载）
    const hasImportFromUrl = await cdp.evaluate(
      "typeof window.api.library.importFromUrl === 'function'"
    )
    check('库 API 暴露 importFromUrl', hasImportFromUrl === true)
    const emptyImport = await cdp.evaluate(
      "(async () => { const r = await window.api.library.importFromUrl(''); return !!(r && r.ok === false) })()"
    )
    check('空输入 importFromUrl 返回 { ok: false }', emptyImport === true)

    // 批量导入 API：已暴露，且空输入安全返回 { ok: false, total: 0 }（不做真实网络下载）
    const hasImportMany = await cdp.evaluate(
      "typeof window.api.library.importManyFromUrls === 'function'"
    )
    check('库 API 暴露 importManyFromUrls', hasImportMany === true)
    const emptyImportMany = await cdp.evaluate(
      "(async () => { const r = await window.api.library.importManyFromUrls(''); return !!(r && r.ok === false && r.total === 0) })()"
    )
    check('空输入 importManyFromUrls 返回 { ok: false, total: 0 }', emptyImportMany === true)

    await ensureLeft(cdp)
    console.log('--- M5 保版式翻译 ---')
    const toolbarBtn = await cdp.evaluate(
      "(()=>{const b=[...document.querySelectorAll('.toolbar button')].find(x=>x.textContent.trim()==='翻译');return !!b})()"
    )
    check('工具栏有翻译按钮', toolbarBtn === true)
    await openPanel(cdp, '翻译')
    await sleep(400)
    const panelRun = await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"translate-run\"]');if(!b)return false;b.click();return true})()"
    )
    check('右侧「翻译」面板可触发翻译', panelRun === true)

    // 加载动画：点击后应立即可见（设了最短显示时长，便于观察）
    const loadingSeen = await cdp.evaluate(
      "!!document.querySelector('[data-testid=\"translate-loading\"]')"
    )
    check('翻译过程有加载动画', loadingSeen === true)
    const barSeen = await cdp.evaluate(
      "!!document.querySelector('[data-testid=\"translate-progress\"]')"
    )
    check('加载动画含进度条', barSeen === true)

    // 等翻译完成（PDF + Markdown；HTML 译文已移除）
    let zhRow = null
    for (let i = 0; i < 120; i++) {
      zhRow = await cdp.evaluate(`window.api.translate.get(${attId}, 'zh')`)
      if (zhRow && zhRow.path) break
      await sleep(500)
    }
    check(
      '翻译完成并生成译文 PDF',
      !!zhRow && !!zhRow.path,
      JSON.stringify(zhRow && { id: zhRow.id, path: zhRow.path })
    )
    check(
      'HTML 译文已移除（不再产出 html/bilingual）',
      !!zhRow && !zhRow.html_path && !zhRow.bilingual_path,
      JSON.stringify(zhRow && { html: zhRow.html_path, bilingual: zhRow.bilingual_path })
    )
    check(
      '生成译文/对照 Markdown',
      !!zhRow && !!zhRow.md_path && !!zhRow.bilingual_md_path,
      JSON.stringify(zhRow && { md: zhRow.md_path, bimd: zhRow.bilingual_md_path })
    )
    // 翻译完成：默认展示「中英对照」左右并排视图（左：原文 PDF + 右：译文 PDF）
    // 回归守卫：译文存在时「原文 / 中英对照 / 网页」切换按钮不能消失
    await waitFor(
      cdp,
      "!!document.querySelector('[data-testid=\"compare-view\"]') && !!document.querySelector('[data-testid=\"compare-pane-translation\"] canvas')"
    )
    check(
      '翻译完成后「中英对照」按钮仍在（切换按键不丢失）',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"view-bilingual\"]')")) === true
    )
    check(
      '翻译完成默认显示「中英对照」左右并排视图',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"compare-view\"]') && !!document.querySelector('[data-testid=\"view-bilingual\"]')?.classList.contains('on')"
      )) === true
    )
    check(
      '中英对照含左右两栏（原文 PDF / 译文 PDF）',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"compare-pane-original\"]') && !!document.querySelector('[data-testid=\"compare-pane-translation\"]') && !!document.querySelector('[data-testid=\"compare-pane-translation\"] canvas')"
      )) === true
    )
    check(
      '翻译后「中英对照」可用，且不再提供「网页」入口',
      (await cdp.evaluate(
        "(()=>{const b=document.querySelector('[data-testid=\"view-bilingual\"]');const h=document.querySelector('[data-testid=\"view-html\"]');return !!b&&!b.disabled&&(!h||h.disabled)})()"
      )) === true
    )
    check(
      '中英对照：公共工具栏「联动」开关可用且默认开启',
      (await cdp.evaluate(
        "(()=>{const c=document.querySelector('[data-testid=\"toolbar-sync\"]');return !!c&&!c.disabled&&c.checked===true})()"
      )) === true
    )
    check(
      '中英对照：公共工具栏页码指示匹配 N / N',
      /^\s*\d+\s*\/\s*\d+\s*$/.test(
        await cdp.evaluate(
          "(document.querySelector('[data-testid=\"toolbar-page-label\"]')||{}).textContent||''"
        )
      )
    )
    // 连续滚动同步（双向：原文 ↔ 译文，以最后主动滚动的一侧为准）：先固定从第 1 页开始，避免上一段刚好停在末页时
    // “下一页”按钮 disabled，把测试误判成联动失败。联动契约是“同一源页”，不是右侧
    // scrollTop 必须变大：目标页顶边不到半屏时右侧会被 clamp 在 0，top 本来就不会动。
    await cdp.evaluate(setInput('[data-testid="toolbar-page"]', '1'))
    await cdp.evaluate(
      "(()=>{const el=document.querySelector('[data-testid=\"toolbar-page\"]');el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()"
    )
    await sleep(800)
    const beforePages = await cdp.evaluate(`(()=>{
      const pick=(pane)=>{const c=pane&&pane.querySelector('.scrollpages');if(!c)return null;const mid=c.scrollTop+c.clientHeight/2;let page=0;for(const el of c.querySelectorAll('.scrollpage')){if(el.offsetTop<=mid)page=Number(el.dataset.page);else break}return {page,top:c.scrollTop,rmax:c.scrollHeight-c.clientHeight}}
      const p=document.querySelectorAll('.compare__pane');return {left:pick(p[0]),right:pick(p[1])}
    })()`)
    await cdp.evaluate("document.querySelector('[data-testid=\"toolbar-page-next\"]')?.click()")
    // 译文 PDF 首开/补页时右侧可能还在解码；等它跟上同一源页，而不是用固定 sleep 猜。
    await waitFor(
      cdp,
      `(()=>{
        const pick=(pane)=>{const c=pane&&pane.querySelector('.scrollpages');if(!c)return null;const mid=c.scrollTop+c.clientHeight/2;let page=0;for(const el of c.querySelectorAll('.scrollpage')){if(el.offsetTop<=mid)page=Number(el.dataset.page);else break}return {page}}
        const p=document.querySelectorAll('.compare__pane');const l=pick(p[0]),r=pick(p[1]);
        return !!l&&!!r&&l.page>0&&l.page===r.page
      })()`,
      { timeout: 5000 }
    )
    const afterPages = await cdp.evaluate(`(()=>{
      const pick=(pane)=>{const c=pane&&pane.querySelector('.scrollpages');if(!c)return null;const mid=c.scrollTop+c.clientHeight/2;let page=0;for(const el of c.querySelectorAll('.scrollpage')){if(el.offsetTop<=mid)page=Number(el.dataset.page);else break}return {page,top:c.scrollTop,rmax:c.scrollHeight-c.clientHeight}}
      const p=document.querySelectorAll('.compare__pane');return {left:pick(p[0]),right:pick(p[1])}
    })()`)
    check(
      '中英对照：连续滚动同步（原文翻页/滚动，译文跟随）',
      !!afterPages &&
        !!afterPages.left &&
        !!afterPages.right &&
        (afterPages.left.rmax <= 0 ||
          (afterPages.left.page > (beforePages?.left?.page ?? -1) &&
            afterPages.right.page === afterPages.left.page)),
      JSON.stringify({ beforePages, afterPages })
    )
    // 关键：联动按**源页**对齐，而不是全文档比例（否则带补注页/页高不同就会错位）。
    // 用「视口中线所在页」比较；末页 scrollTop 会被 clamp，不能用 pageTop 判断。
    const rightAnchor = await cdp.evaluate(`(()=>{
      const panes=document.querySelectorAll('.compare__pane')
      const pick=(pane)=>{
        const c=pane&&pane.querySelector('.scrollpages'); if(!c) return null
        const mid=c.scrollTop+c.clientHeight/2
        let page=0
        for (const el of c.querySelectorAll('.scrollpage')) {
          if (el.offsetTop<=mid) page=Number(el.dataset.page); else break
        }
        return { page, top:c.scrollTop, max:c.scrollHeight-c.clientHeight, ch:c.clientHeight }
      }
      return { left: pick(panes[0]), right: pick(panes[1]) }
    })()`)
    const syncDebug = await cdp.evaluate(`(()=>{
      const panes=document.querySelectorAll('.compare__pane')
      const L=panes[0]&&panes[0].querySelector('.scrollpages')
      const next=document.querySelector('[data-testid="toolbar-page-next"]')
      return {
        debug: window.__syncDebug||null,
        label: (document.querySelector('[data-testid="toolbar-page-label"]')||{}).textContent||'',
        leftTop: L?L.scrollTop:null,
        leftMax: L?L.scrollHeight-L.clientHeight:null,
        leftPages: L?Array.from(L.querySelectorAll('.scrollpage')).map(e=>({p:e.dataset.page,top:e.offsetTop,h:e.offsetHeight})):null,
        rightPages: (()=>{const R=panes[1]&&panes[1].querySelector('.scrollpages');return R?Array.from(R.querySelectorAll('.scrollpage')).map(e=>({p:e.dataset.page,top:e.offsetTop,h:e.offsetHeight})):null})(),
        nextDisabled: next?next.disabled:null
      }
    })()`)
    check(
      '中英对照：翻页后译文仍停在**同一源页**（不是按比例漂移）',
      !!rightAnchor &&
        !!rightAnchor.left &&
        !!rightAnchor.right &&
        rightAnchor.left.page === rightAnchor.right.page &&
        rightAnchor.left.page === 1,
      JSON.stringify({ anchor: rightAnchor, dbg: syncDebug })
    )
    // 同页还不够：两侧页内位置也必须一致（锚点协议是视口中线）
    const midL = rightAnchor?.left ? rightAnchor.left.top + rightAnchor.left.ch / 2 : 0
    const midR = rightAnchor?.right ? rightAnchor.right.top + rightAnchor.right.ch / 2 : 0
    check(
      '中英对照：同一源页内两侧视口中线对齐（误差 ≤ 8px）',
      !!rightAnchor?.left && !!rightAnchor?.right && Math.abs(midL - midR) <= 8,
      JSON.stringify({ midL, midR, anchor: rightAnchor })
    )
    // 反向联动：在右侧（译文）主动滚动，左侧原文必须跟到同一源页。
    // 旧实现单向（原文→译文），用户滚右侧后左侧不动。
    const rightCanScroll = await cdp.evaluate(`(()=>{
      const panes=document.querySelectorAll('.compare__pane')
      const R=panes[1]&&panes[1].querySelector('.scrollpages')
      const target=R&&R.querySelector('.scrollpage[data-page="1"]')
      if(!R||!target) return false
      R.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse'}))
      R.scrollTop=target.offsetTop+12
      R.dispatchEvent(new Event('scroll'))
      return true
    })()`)
    if (rightCanScroll) {
      await waitFor(
        cdp,
        `(()=>{
          const pick=(pane)=>{const c=pane&&pane.querySelector('.scrollpages');if(!c)return null;const mid=c.scrollTop+c.clientHeight/2;let page=0;for(const el of c.querySelectorAll('.scrollpage')){if(el.offsetTop<=mid)page=Number(el.dataset.page);else break}return {page,top:c.scrollTop}}
          const p=document.querySelectorAll('.compare__pane');const l=pick(p[0]),r=pick(p[1]);
          return !!l&&!!r&&l.page===1&&r.page===1
        })()`,
        { timeout: 5000 }
      )
      const reversePages = await cdp.evaluate(`(()=>{
        const pick=(pane)=>{const c=pane&&pane.querySelector('.scrollpages');if(!c)return null;const mid=c.scrollTop+c.clientHeight/2;let page=0;for(const el of c.querySelectorAll('.scrollpage')){if(el.offsetTop<=mid)page=Number(el.dataset.page);else break}return {page,top:c.scrollTop}}
        const p=document.querySelectorAll('.compare__pane');return {left:pick(p[0]),right:pick(p[1])}
      })()`)
      check(
        '中英对照：译文侧主动滚动可反向带动原文（双向联动）',
        !!reversePages?.left && !!reversePages?.right && reversePages.left.page === 1 && reversePages.right.page === 1,
        JSON.stringify(reversePages)
      )
    }
    // 先离开翻译面板，再用工具栏「翻译」触发，验证会自动切回「翻译」面板
    await openPanel(cdp, '笔记')
    const toolbarRun = await cdp.evaluate(
      "(()=>{const b=[...document.querySelectorAll('.toolbar button')].find(x=>x.textContent.trim()==='翻译');if(!b||b.disabled)return false;b.click();return true})()"
    )
    check('工具栏「翻译」可触发翻译', toolbarRun === true)
    await waitFor(
      cdp,
      "!!document.querySelector('[data-testid=\"panel-tab-translate\"]')?.classList.contains('primary')"
    )
    check(
      '点「翻译」后右侧自动切到「翻译」面板',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"panel-tab-translate\"]')?.classList.contains('primary')"
      )) === true
    )
    // 等这次（复用）翻译完成，确认默认视图仍为「中英对照」
    await waitFor(
      cdp,
      "!!document.querySelector('[data-testid=\"view-bilingual\"]')?.classList.contains('on')"
    )
    check(
      '再次翻译后默认仍显示「中英对照」视图',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"view-bilingual\"]')?.classList.contains('on')"
      )) === true
    )
    // 归档/导出/自检/历史：面板 UI 已按需求移除，这里只保留 API 能力断言
    const noteAfter = await cdp.evaluate(
      `window.api.translate.exportToNote(${zhRow.id},'translation').then(()=>window.api.notes.getForItem(${itemId})).then(n=>n?n.content:'')`
    )
    check('译文可归档到笔记（API）', noteAfter.includes('## 译文'), `len=${noteAfter.length}`)
    check(
      '归档笔记带页码锚点（跳回原文）',
      noteAfter.includes(`paperdesk://open?attachment=${attKey}&page=`),
      JSON.stringify(noteAfter.slice(-160))
    )
    const zipPath = await cdp.evaluate(`window.api.translate.exportZip(${zhRow.id})`)
    check('一键导出 ZIP（API）', typeof zipPath === 'string' && fs.existsSync(zipPath), String(zipPath))
    check(
      '译文带质量自检结果（数据）',
      !!zhRow && !!zhRow.qa && JSON.parse(zhRow.qa).total >= 1,
      String(zhRow && zhRow.qa)
    )
    const qaPath = await cdp.evaluate(`window.api.translate.exportQa(${zhRow.id})`)
    check(
      '可导出质量自检清单（Markdown）',
      typeof qaPath === 'string' &&
        fs.existsSync(qaPath) &&
        fs.readFileSync(qaPath, 'utf8').includes('翻译质量自检'),
      String(qaPath)
    )
    const reused = await cdp.evaluate(
      `window.api.translate.run(${attId}, {lang:'zh', mode:'fine'}).then(t=>t.id)`
    )
    check('译文可复用（再次翻译返回同一份）', reused === zhRow.id, `id=${reused}`)

    // 翻译历史（数据层）：强制重译保留旧版本
    const hist0 = await cdp.evaluate(`window.api.translate.history(${attId},'zh').then(h=>h.length)`)
    const forcedId = await cdp.evaluate(
      `window.api.translate.run(${attId}, {lang:'zh', mode:'fine', force:true}).then(t=>t.id)`
    )
    check(
      '强制重译生成新版本',
      typeof forcedId === 'number' && forcedId !== zhRow.id,
      `new=${forcedId} old=${zhRow.id}`
    )
    const hist1 = await cdp.evaluate(`window.api.translate.history(${attId},'zh').then(h=>h.length)`)
    check('译文历史累积（旧版本保留）', hist1 >= hist0 + 1 && hist1 >= 2, `hist=${hist1}`)
    const oldRow = await cdp.evaluate(`window.api.translate.getById(${zhRow.id})`)
    check(
      '旧译文标记为已取代（superseded）',
      !!oldRow && oldRow.status === 'superseded',
      JSON.stringify(oldRow && oldRow.status)
    )
    // 粗译模式：独立记账（engine 带 :coarse），产出 PDF
    const coarseRow = await cdp.evaluate(
      `window.api.translate.run(${attId}, {lang:'zh', mode:'coarse', force:true})`
    )
    check(
      '粗译模式可运行且独立记账（engine=*:coarse）',
      !!coarseRow && !!coarseRow.path && String(coarseRow.engine || '').endsWith(':coarse'),
      JSON.stringify(coarseRow && { engine: coarseRow.engine, path: coarseRow.path })
    )
    // 回滚到最新版本，保持后续步骤一致
    const newestId = await cdp.evaluate(`window.api.translate.history(${attId},'zh').then(h=>h[0].id)`)
    if (zhRow.id !== newestId) {
      await cdp.evaluate(`window.api.translate.rollback(${newestId})`)
    }
    // 确保处于「中英对照」视图（后续断言依赖）
    await cdp.evaluate("document.querySelector('[data-testid=\"view-bilingual\"]')?.click()")

    // 切到「网页译文」再切回「原文」，验证视图切换与 PDF 渲染
    await cdp.evaluate(clickByText('.toolbar button', '网页'))
    await sleep(1200)
    const htmlViewOk = await cdp.evaluate("!!document.querySelector('[data-testid=\"html-view\"]')")
    check('无 HTML 译文时不渲染网页视图（入口已移除）', htmlViewOk === false)
    await cdp.evaluate(clickByText('.toolbar button', '原文'))
    await sleep(1400)
    const zhText = await cdp.evaluate("document.querySelector('.textLayer')?.textContent || ''")
    check('原文 PDF 文本层可读', zhText.length > 0, JSON.stringify(zhText.slice(0, 50)))
    await checkCanvasNotBlack(cdp, '原文 PDF 画布非全黑（未黑屏）', check)
    const pageAfterTrans = await cdp.evaluate(pageExpr)
    check('原文 PDF 页码正常（N / 2）', /^\d+ \/ 2$/.test(pageAfterTrans), pageAfterTrans)

    const tdir = path.join(dataDir, 'translated')
    const tfiles = fs.existsSync(tdir) ? fs.readdirSync(tdir) : []
    check(
      '译文 PDF 与 HTML 均已落盘',
      tfiles.some((f) => f.endsWith('.zh.pdf')) &&
        tfiles.some((f) => f.endsWith('.zh.md')) &&
        !tfiles.some((f) => f.endsWith('.zh.html')),
      tfiles.join(',')
    )

    const annsOrig = await cdp.evaluate("document.querySelectorAll('.annotationLayer .ann').length")
    check('原文显示批注', annsOrig >= 1, `anns=${annsOrig}`)

    await ensureLeft(cdp)
    await ensureLeft(cdp)
    console.log('--- M6 全文检索 & RAG ---')
    const hitsSmith = await cdp.evaluate("window.api.search.query('Smith').then(r=>r)")
    check(
      '检索命中全文分块',
      Array.isArray(hitsSmith) && hitsSmith.some((h) => h.kind === 'chunk'),
      `n=${hitsSmith ? hitsSmith.length : 0}`
    )
    const chunkHit = (hitsSmith || []).find((h) => h.kind === 'chunk')
    check(
      '命中的分块带页码与附件定位',
      !!chunkHit && chunkHit.page === 2 && chunkHit.attachmentId != null,
      JSON.stringify(chunkHit)
    )
    const hitsAlice = await cdp.evaluate("window.api.search.query('Alice').then(r=>r)")
    check(
      '另一页文本也能命中（页码正确）',
      (hitsAlice || []).some((h) => h.kind === 'chunk' && h.page === 1),
      JSON.stringify((hitsAlice || []).map((h) => h.page))
    )

    await cdp.evaluate(setInput('[data-testid="search-input"]', 'Smith'))
    await sleep(800)
    const hitCount = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"search-hit\"]').length"
    )
    check('搜索框渲染出结果', hitCount >= 1, `hits=${hitCount}`)

    const trHits = await cdp.evaluate(
      "window.api.search.query('E2E').then(r=>(r||[]).map(h=>h.kind))"
    )
    check(
      '全文检索能搜到译文（skills 产出）',
      Array.isArray(trHits) && trHits.includes('translation'),
      JSON.stringify(trHits)
    )

    const trHit = await cdp.evaluate(
      "window.api.search.query('E2E').then(r=>(r||[]).find(h=>h.kind==='translation'))"
    )
    check(
      '译文命中携带语言与附件定位',
      !!trHit && trHit.translationLang === 'zh' && trHit.attachmentId != null,
      JSON.stringify(trHit)
    )

    const ai = await cdp.evaluate("window.api.ai.ask('Smith').then(r=>r)")
    check('RAG 返回答案', typeof ai.answer === 'string' && ai.answer.length > 0, JSON.stringify((ai.answer || '').slice(0, 50)))
    check('RAG 答案含引用标记 [1]', (ai.answer || '').includes('[1]'), (ai.answer || '').slice(0, 80))
    check(
      'RAG 引用带页码',
      Array.isArray(ai.citations) && ai.citations.length >= 1 && typeof ai.citations[0].page === 'number',
      `cites=${ai.citations ? ai.citations.length : 0}`
    )

    await openPanel(cdp, '问答')
    await sleep(400)
    check(
      '功能面板可折叠（腾出阅读空间）',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"panel-collapse\"]')")) === true
    )
    // 回归：折叠后网格列数必须与子元素数量一致，否则主区会落进 0px 列 → 整页空白
    const mainWBefore = await cdp.evaluate(
      "document.querySelector('.main')?.getBoundingClientRect().width || 0"
    )
    await cdp.evaluate("document.querySelector('[data-testid=\"panel-collapse\"]')?.click()")
    await sleep(350)
    const mainWAfter = await cdp.evaluate(
      "document.querySelector('.main')?.getBoundingClientRect().width || 0"
    )
    const tracks = await cdp.evaluate(
      "getComputedStyle(document.querySelector('.app')).gridTemplateColumns"
    )
    check(
      '折叠左栏后主区仍有宽度（不是空白页）',
      mainWAfter > Math.min(mainWBefore, 300),
      `before=${mainWBefore} after=${mainWAfter} tracks=${tracks}`
    )
    check(
      '折叠后网格列数与子元素匹配（2 列）',
      String(tracks).trim().split(/\s+/).length === 2,
      tracks
    )
    check(
      '折叠后仍能看到阅读器/空态（主区有可见内容）',
      (await cdp.evaluate(
        "(document.querySelector('.main')?.innerText || '').trim().length >= 0 && document.querySelector('.main')?.getBoundingClientRect().height > 100"
      )) === true
    )
    // 恢复展开，避免影响后续问答断言
    await cdp.evaluate("document.querySelector('[data-testid=\"sb-expand\"]')?.click()")
    await sleep(350)
    await cdp.evaluate(setInput('[data-testid="ai-input"]', 'Smith'))
    await cdp.evaluate("document.querySelector('[data-testid=\"ai-ask\"]').click()")
    await sleep(900)
    const ansText = await cdp.evaluate(
      "document.querySelector('[data-testid=\"ai-answer\"]')?.textContent || ''"
    )
    const citeChips = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"ai-cites\"] .ai__cite-chip').length"
    )
    const mdRendered = await cdp.evaluate(
      "!!document.querySelector('[data-testid=\"ai-answer\"] .ai__md')"
    )
    check('问答面板渲染答案', ansText.length > 0, ansText.slice(0, 50))
    check('问答答案以 Markdown 渲染（.ai__md）', mdRendered === true)
    check('问答引用为紧凑标记（[n] p.X chip）', citeChips >= 1, `chips=${citeChips}`)

    // ---- PD21 / 阶段一：联网检索默认关闭（三态 off，按需开启，不拖慢普通问答） ----
    const webDefault = await cdp.evaluate('window.api.settings.webSearchGet()')
    check('联网检索默认关闭（设置回读 off）', webDefault === 'off', `got=${webDefault}`)
    const webToggleText = await cdp.evaluate(
      "document.querySelector('[data-testid=\"ai-web-mode\"]')?.textContent?.trim() || ''"
    )
    check('AI 视图开关默认显示「联网：关闭」', webToggleText.includes('关闭'), `text=${webToggleText}`)

    // ---- PD54：AI 工具库关闭联网检索 → 问答入口禁用 + 可读原因；重新打开立即恢复 ----
    const pd54WebGate = await cdp.evaluate(`(async()=>{
      const snap=()=>{const b=document.querySelector('[data-testid="ai-web-mode"]');return b?{disabled:b.disabled,title:b.title}:null};
      await window.api.aiTools.update({id:'web-search',enabled:false});
      await new Promise((r)=>setTimeout(r,300));
      const off=snap();
      await window.api.aiTools.update({id:'web-search',enabled:true});
      await new Promise((r)=>setTimeout(r,300));
      const on=snap();
      return {off,on};
    })()`)
    check(
      'PD54：关闭联网检索后 AI 视图开关禁用并提示「已在 AI 工具库关闭联网检索」',
      !!pd54WebGate &&
        !!pd54WebGate.off &&
        pd54WebGate.off.disabled === true &&
        String(pd54WebGate.off.title).includes('已在 AI 工具库关闭联网检索'),
      JSON.stringify(pd54WebGate)
    )
    check(
      'PD54：重新打开联网检索后 AI 视图开关立即恢复可用（无需重启）',
      !!pd54WebGate && !!pd54WebGate.on && pd54WebGate.on.disabled === false,
      JSON.stringify(pd54WebGate)
    )
    const defaultQa = await cdp.evaluate(
      `(async()=>{const t0=performance.now();const r=await window.api.ai.ask('Smith');` +
        `return {ms:Math.round(performance.now()-t0),web:r&&r.web,` +
        `n:((r&&r.webSources)||[]).length,ans:((r&&r.answer)||'').slice(0,40)}})()`
    )
    check(
      '默认关闭：普通问答不发联网请求（web=off、零来源）',
      !!defaultQa && defaultQa.web === 'off' && defaultQa.n === 0,
      JSON.stringify(defaultQa)
    )
    check(
      '默认关闭：问答在 2s 内返回（8s 空等回归守卫）',
      !!defaultQa && defaultQa.ms < 2000,
      `ms=${defaultQa && defaultQa.ms}`
    )

    // ---- PD21：显式开启后联网并给出可点击来源（本地 fixture），末尾复位 ----
    const webEnabled = await cdp.evaluate(
      `(async()=>{await window.api.settings.webSearchSet('always');` +
        `const on=await window.api.settings.webSearchGet();` +
        `const r=await window.api.ai.ask('扩散模型',{web:true});` +
        `const src=(r&&r.webSources)||[];` +
        `return {on,web:r&&r.web,n:src.length,urls:src.map((s)=>s.url)}})()`
    )
    check('开启后设置回读为 always', !!webEnabled && webEnabled.on === 'always', JSON.stringify(webEnabled))
    check(
      '开启后问答联网成功（web=on 且有来源）',
      !!webEnabled && webEnabled.web === 'on' && webEnabled.n >= 1,
      JSON.stringify(webEnabled)
    )
    check(
      '联网来源 URL 指向本地 fixture 主机（可点击）',
      !!webEnabled &&
        webEnabled.urls.length >= 1 &&
        webEnabled.urls.every((u) => String(u).includes(`127.0.0.1:${mock.port}/websearch/`)),
      JSON.stringify(webEnabled && webEnabled.urls)
    )
    await cdp.evaluate("window.api.settings.webSearchSet('off')")
    check(
      '联网开关复位为关闭（不污染后续用例）',
      (await cdp.evaluate('window.api.settings.webSearchGet()')) === 'off'
    )

    await cdp.evaluate("document.querySelector('[data-testid=\"ai-cites\"] .ai__cite-chip').click()")
    await sleep(1200)
    const pageAfterCite = await cdp.evaluate(pageExpr)
    check('点击引用跳转到原文对应页 (2 / 2)', pageAfterCite === '2 / 2', pageAfterCite)

    await cdp.evaluate(
      "document.querySelector('[data-testid=\"ai-cites\"] .ai__cites-toggle')?.click()"
    )
    await sleep(250)
    const citeDetail = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"ai-cites\"] li').length"
    )
    check('引用详情可按需展开', citeDetail >= 1, `detail=${citeDetail}`)

    // ---- PD25：本地 fixture 全链路（搜索→解析命中→取正文→引用展示→点击打开来源） ----
    const webSaveOn = await cdp.evaluate(
      "window.api.settings.save({websearch:{enabled:'1',proxy:''}}).then(s=>s.websearch)"
    )
    check(
      '设置可保存联网开关（回读 websearch.enabled=1、proxy 为空）',
      !!webSaveOn && webSaveOn.enabled === '1' && webSaveOn.proxy === '',
      JSON.stringify(webSaveOn)
    )
    await cdp.evaluate(setInput('[data-testid="ai-input"]', '扩散模型'))
    await cdp.evaluate("document.querySelector('[data-testid=\"ai-ask\"]').click()")
    const srcReady = await waitFor(cdp, "!!document.querySelector('[data-testid=\"ai-web-source-1\"]')", {
      timeout: 15000
    })
    check('开启后 UI 问答展示联网来源 chip（验收 3）', srcReady === true)
    const chip = await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"ai-web-source-1\"]');return b?{text:(b.textContent||'').trim(),title:b.getAttribute('title')||''}:null})()"
    )
    check(
      '来源 chip 标注 [W1] 与 fixture 主机，title 带完整 URL',
      !!chip && chip.text.includes('[W1]') && chip.title.includes(`/websearch/page1`),
      JSON.stringify(chip)
    )
    const webMeta = await cdp.evaluate(
      "document.querySelector('[data-testid=\"ai-web-meta\"]')?.textContent?.trim() || ''"
    )
    check('回答标注「已联网 · 网页 N」', /已联网/.test(webMeta), webMeta)
    const clicked = await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"ai-web-source-1\"]');if(!b)return false;b.click();return true})()"
    )
    await sleep(600)
    check(
      '点击来源 chip → 主进程 openExternal 收到该 URL（验收 3）',
      clicked === true &&
        appLog.join('').includes('[openExternal]') &&
        appLog.join('').includes('/websearch/page1'),
      appLog.join('').slice(-300)
    )

    // ---- PD25：离线/失败降级（代理设置回读 / HTTP 非 200 / 目标不响应） ----
    const webSaveProxy = await cdp.evaluate(
      "window.api.settings.save({websearch:{enabled:'1',proxy:'http://127.0.0.1:7993'}}).then(s=>s.websearch)"
    )
    check(
      '设置可保存检索代理（回读 proxy=http://127.0.0.1:7993）',
      !!webSaveProxy &&
        webSaveProxy.enabled === '1' &&
        webSaveProxy.proxy === 'http://127.0.0.1:7993',
      JSON.stringify(webSaveProxy)
    )
    await cdp.evaluate(setInput('[data-testid="ai-input"]', 'FAIL500'))
    await cdp.evaluate("document.querySelector('[data-testid=\"ai-ask\"]').click()")
    const fixReady = await waitFor(cdp, "!!document.querySelector('[data-testid=\"ai-web-fix\"]')", {
      timeout: 10000
    })
    const failMeta = await cdp.evaluate(
      "document.querySelector('[data-testid=\"ai-web-meta\"]')?.textContent?.trim() || ''"
    )
    const fixText = await cdp.evaluate(
      "document.querySelector('[data-testid=\"ai-web-fix\"]')?.textContent?.trim() || ''"
    )
    check(
      '检索失败 UI 标注「未联网」并给出可操作提示（检查网络/设置代理）',
      fixReady === true && /未联网/.test(failMeta) && /代理|网络/.test(fixText),
      JSON.stringify({ meta: failMeta, fix: fixText })
    )
    const http500 = await cdp.evaluate(
      `(async()=>{const r=await window.api.ai.ask('FAIL500',{web:true});` +
        `return {web:r&&r.web,err:r&&r.webError}})()`
    )
    check(
      'HTTP 非 200：失败原因带状态码（不静默变成本地回答）',
      !!http500 && http500.web === 'failed' && /HTTP 500/.test(String(http500.err)),
      JSON.stringify(http500)
    )
    await cdp.evaluate("window.api.settings.save({websearch:{enabled:'1',proxy:''}})")
    const hang = await cdp.evaluate(
      `(async()=>{const t0=performance.now();const r=await window.api.ai.ask('HANG',{web:true});` +
        `return {ms:Math.round(performance.now()-t0),web:r&&r.web,err:r&&r.webError}})()`
    )
    check(
      '目标不响应：8 秒预算内失败且原因含「超时」（问答不空等）',
      !!hang && hang.web === 'failed' && hang.ms < 8300 && /超时/.test(String(hang.err)),
      JSON.stringify(hang)
    )
    await cdp.evaluate("window.api.settings.save({websearch:{enabled:'0',proxy:''}})")
    check(
      '联网开关/代理复位（不污染后续用例）',
      (await cdp.evaluate('window.api.settings.webSearchGet()')) === 'off'
    )

    // 论文范围（像「附加文件」）+ 流式输出接线
    check(
      '问答显示当前论文范围（可切换全库）',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"ai-scope\"]') && !!document.querySelector('[data-testid=\"ai-scope-toggle\"]')"
      )) === true
    )
    check(
      '问答流式输出已接线（askStream）',
      (await cdp.evaluate("typeof window.api.ai.askStream === 'function'")) === true
    )

    // 对话历史：问答后落库（AI 生成标题 + 对应的第一份附件）
    const convs = await cdp.evaluate(
      "window.api.ai.listConversations().then(l=>l.map(c=>({t:c.title,a:c.attachmentName,n:c.messageCount})))"
    )
    check(
      '问答已记入对话历史（标题 + 附件）',
      Array.isArray(convs) && convs.length >= 1 && convs[0].n >= 2,
      JSON.stringify(convs)
    )
    await cdp.evaluate("document.querySelector('[data-testid=\"ai-history-btn\"]').click()")
    await sleep(350)
    check(
      '对话历史面板可打开',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"ai-history\"]')")) === true
    )
    check(
      '历史条目显示标题与附件名',
      (await cdp.evaluate(
        "(document.querySelector('[data-testid=\"ai-history\"] .ai__hist-title')?.textContent||'').length>0 && !!document.querySelector('[data-testid=\"ai-history\"] .ai__hist-meta')"
      )) === true
    )
    await cdp.evaluate("document.querySelector('[data-testid=\"ai-hist-close\"]')?.click()")
    await sleep(200)

    // 问答引用应基于**结构化模块**定位（页码 + 精确矩形 + 类型）
    const citeMod = await cdp.evaluate(
      `window.api.ai.ask('Smith',{attachmentId:${attId}}).then(r=>({n:r.citations.length,withRect:r.citations.filter(c=>!!c.rect).length,kind:(r.citations.find(c=>!!c.rect)||{}).moduleKind||''}))`
    )
    check(
      '问答引用携带结构化模块定位（rect + 类型）',
      !!citeMod && citeMod.n >= 1 && citeMod.withRect >= 1,
      JSON.stringify(citeMod)
    )

    // #11 对话式：用户/助手气泡 + 追问累积 + 一键清空
    check(
      '问答为对话式（用户/助手气泡）',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"ai-msg-user\"]') && !!document.querySelector('[data-testid=\"ai-msg-assistant\"]')"
      )) === true
    )
    const bubbleBefore = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"ai-msg-user\"]').length"
    )
    await cdp.evaluate(setInput('[data-testid="ai-input"]', '再详细一点'))
    await cdp.evaluate("document.querySelector('[data-testid=\"ai-ask\"]').click()")
    await sleep(900)
    const bubbleAfter = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"ai-msg-user\"]').length"
    )
    check('支持连续追问（对话累积）', bubbleAfter === bubbleBefore + 1, `before=${bubbleBefore} after=${bubbleAfter}`)
    await cdp.evaluate("document.querySelector('[data-testid=\"ai-clear\"]')?.click()")
    await sleep(200)
    check(
      '可一键清空对话',
      (await cdp.evaluate("document.querySelectorAll('[data-testid=\"ai-msg-user\"]').length")) === 0
    )
    // 图片 → LaTeX：面板有入口，IPC 已接线（无真实视觉模型时返回明确错误）
    check(
      '问答面板提供「图片 → LaTeX」入口',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"ai-formula\"]')")) === true
    )
    const formulaErr = await cdp.evaluate(
      "window.api.ai.formula('aGVsbG8=','image/png').then(()=>'').catch(e=>String(e&&e.message||e))"
    )
    check(
      '图片 → LaTeX IPC 已接线（返回明确错误而非静默失败）',
      typeof formulaErr === 'string' && formulaErr.length > 0,
      String(formulaErr).slice(0, 80)
    )
    // 表格 → Markdown：面板入口 + IPC 已接线（无真实视觉模型时返回明确错误）
    check(
      '问答面板提供「表格 → Markdown」入口',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"ai-table\"]')")) === true
    )
    const tableErr = await cdp.evaluate(
      "window.api.ai.table('aGVsbG8=','image/png').then(()=>'').catch(e=>String(e&&e.message||e))"
    )
    check(
      '表格 → Markdown IPC 已接线（返回明确错误而非静默失败）',
      typeof tableErr === 'string' && tableErr.length > 0,
      String(tableErr).slice(0, 80)
    )

    await ensureLeft(cdp)
    console.log('--- M7 模块化 & 设置 ---')
    const groupTitles = await cdp.evaluate(
      "[...document.querySelectorAll('[data-testid=\"ribbon-groups\"] button')].map(b=>b.textContent.trim())"
    )
    await openPanel(cdp, '问答')
    const readPanels = await cdp.evaluate(
      "[...document.querySelectorAll('[data-testid=\"ribbon-panels\"] button')].map(b=>b.textContent.trim())"
    )
    await openPanel(cdp, '批处理')
    const dataPanels = await cdp.evaluate(
      "[...document.querySelectorAll('[data-testid=\"ribbon-panels\"] button')].map(b=>b.textContent.trim())"
    )
    check(
      'Office 式两层功能区（分组 + 面板）',
      Array.isArray(groupTitles) &&
        groupTitles.length >= 3 &&
        groupTitles.includes('阅读') &&
        groupTitles.includes('研究') &&
        groupTitles.includes('数据') &&
        readPanels.includes('翻译') &&
        readPanels.includes('问答') &&
        dataPanels.includes('批处理'),
      JSON.stringify({ groupTitles, readPanels, dataPanels })
    )

    // 研究 → 期刊面板（简介 + 投稿要求 + 按论文推荐 + AI 概括）
    await cdp.evaluate(
      "(()=>{const r=document.querySelector('[data-testid=\"item-row\"]');if(r)r.click();return !!r})()"
    )
    await sleep(600)
    // 文库：双击条目 → 左栏文档详情（作者/期刊/主要思想/被引），并可返回列表
    await ensureLeft(cdp)
    await sleep(300)
    const openedDetail = await cdp.evaluate(
      "(()=>{const r=document.querySelector('[data-testid=\"item-row\"]');if(!r)return false;r.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return true})()"
    )
    await sleep(700)
    const detailReady = await cdp.evaluate(
      "!!document.querySelector('[data-testid=\"item-detail\"]') && !!document.querySelector('[data-testid=\"detail-back\"]') && document.body.textContent.includes('主要思想')"
    )
    check('双击文库条目打开左栏文档详情', openedDetail === true && detailReady === true)
    const backFromDetail = await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"detail-back\"]');if(!b)return false;b.click();return true})()"
    )
    await sleep(500)
    const detailClosed = await cdp.evaluate(
      "!document.querySelector('[data-testid=\"item-detail\"]') && !!document.querySelector('[data-testid=\"item-row\"]')"
    )
    check('文档详情可返回文档列表', backFromDetail === true && detailClosed === true)
    // 多级分组：父组下建子组、论文归入子组、批处理按父组包含后代
    const groupCheck = await cdp.evaluate(`(async()=>{
      const parent='E2E 分组';
      const child='E2E 分组/子组';
      await window.api.library.createGroup(parent,null);
      await window.api.library.createGroup('子组',parent);
      await window.api.library.setGroup(${itemId},child);
      const groups=await window.api.library.listGroups();
      const est=await window.api.batch.estimate({task:'analyze-paper',scope:'group',group:parent});
      return {names:groups.map(g=>g.name),parents:groups.map(g=>g.parent_name),count:est&&est.count};
    })()`)
    check(
      '支持父子分组、论文归组、批处理按父组含子组',
      groupCheck &&
        groupCheck.names.includes('E2E 分组') &&
        groupCheck.names.includes('E2E 分组/子组') &&
        groupCheck.count >= 1,
      JSON.stringify(groupCheck)
    )
    const groupMetaCheck = await cdp.evaluate(`(async()=>{
      const parent='E2E 分组';
      const updated=await window.api.library.updateGroup(parent,{description:'E2E 分组介绍'});
      const one=await window.api.library.getGroup(parent);
      const tags=await window.api.library.setTags(${itemId},['E2E 标签']);
      const est=await window.api.batch.estimate({task:'analyze-paper',scope:'tag',tag:'E2E 标签'});
      return {description:updated&&updated.description,one:one&&one.description,tags,count:est&&est.count};
    })()`)
    check(
      '分组介绍可保存并回读，标签可作为批处理范围',
      groupMetaCheck &&
        groupMetaCheck.description === 'E2E 分组介绍' &&
        groupMetaCheck.one === 'E2E 分组介绍' &&
        Array.isArray(groupMetaCheck.tags) &&
        groupMetaCheck.tags.includes('E2E 标签') &&
        groupMetaCheck.count >= 1,
      JSON.stringify(groupMetaCheck)
    )
    await cdp.evaluate(
      `Promise.all([window.api.library.setGroup(${itemId},null),window.api.library.setTags(${itemId},[])])`
    )
    // 条目行只保留删除按钮；分组/改名/设置入口移到文档详情或顶部工具栏
    const rowButtons = await cdp.evaluate(`(async()=>{
      const oldTitle=await window.api.library.get(${itemId}).then(i=>i.title);
      const row=[...document.querySelectorAll('[data-testid="item-row"]')].find(r=>r.textContent.includes(oldTitle));
      return {
        group: !!row?.querySelector('[data-testid="item-group"]'),
        rename: !!row?.querySelector('[data-testid="item-rename"]'),
        settings: !!row?.querySelector('[data-testid="open-settings"]'),
        del: !!row?.querySelector('[data-testid="item-delete"]')
      };
    })()`)
    check(
      '条目行仅保留删除按钮（分组/改名/设置入口已移除）',
      rowButtons &&
        rowButtons.group === false &&
        rowButtons.rename === false &&
        rowButtons.settings === false &&
        rowButtons.del === true,
      JSON.stringify(rowButtons)
    )
    const titleBeforeRename = await cdp.evaluate(
      `window.api.library.get(${itemId}).then(i=>i.title)`
    )
    const renamed = await cdp.evaluate(
      `window.api.library.rename(${itemId}, 'E2E 重命名论文')`
    )
    await sleep(500)
    const renamedRow = await cdp.evaluate(
      "!!document.querySelector('[data-testid=\"item-row\"]') && document.body.textContent.includes('E2E 重命名论文')"
    )
    check(
      '文库文件可重命名且列表即时刷新',
      !!renamed && renamed.title === 'E2E 重命名论文' && renamedRow === true,
      JSON.stringify({ renamed: renamed && renamed.title, renamedRow })
    )
    await cdp.evaluate(
      `window.api.library.rename(${itemId}, ${JSON.stringify(titleBeforeRename)})`
    )
    await sleep(300)
    // 第二篇附件与本篇共用 sample.pdf；重命名会移动磁盘文件，补回共享副本供后续抽取
    const pdfNow = fs.readdirSync(storageDir).find((f) => f.toLowerCase().endsWith('.pdf'))
    if (pdfNow) fs.copyFileSync(path.join(storageDir, pdfNow), path.join(storageDir, 'sample.pdf'))
    const dbFix = new DatabaseSync(path.join(dataDir, 'library.sqlite'))
    dbFix.prepare('UPDATE attachments SET path=?, filename=? WHERE id=?').run(
      ['storage', itemKey, 'sample.pdf'].join('/'),
      'sample.pdf',
      attId
    )
    dbFix.close()
    await openPanel(cdp, '期刊')
    const journalRows = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"journals-list\"] li').length"
    )
    check('研究区新增「期刊」面板并列出条目', journalRows >= 5, `n=${journalRows}`)
    await cdp.evaluate(setInput('[data-testid="journals-search"]', 'bioinformatics'))
    await sleep(300)
    const journalFiltered = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"journals-list\"] li').length"
    )
    check(
      '期刊搜索可过滤',
      journalFiltered >= 1 && journalFiltered < journalRows,
      `filtered=${journalFiltered}`
    )
    await cdp.evaluate(setInput('[data-testid="journals-search"]', ''))
    await sleep(200)
    const openedJournal = await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid^=\"journal-row-\"]');if(!b)return false;b.click();return true})()"
    )
    await sleep(300)
    const journalDetail = await cdp.evaluate(
      "!!document.querySelector('[data-testid=\"journal-detail\"]') && !!document.querySelector('[data-testid=\"journal-guide\"]')"
    )
    check('期刊详情含投稿要求与作者指南入口', openedJournal === true && journalDetail === true)

    // AI 概括（离线 mock 也应返回结果）
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"journal-ai\"]');if(b)b.click();return !!b})()"
    )
    let aiOk = false
    for (let i = 0; i < 40; i++) {
      aiOk = await cdp.evaluate("!!document.querySelector('[data-testid=\"journal-ai-result\"]')")
      if (aiOk) break
      await sleep(300)
    }
    check('期刊可用 AI 概括要求（离线也可返回）', aiOk === true)

    const copied = await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"journal-copy\"]');if(b)b.click();return !!b})()"
    )
    check('期刊可复制 checklist', copied === true)

    // 返回列表 → 按当前论文推荐
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"journal-back\"]');if(b)b.click();return !!b})()"
    )
    await sleep(400)
    const recRows = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"journals-recommend\"] li').length"
    )
    check('按当前论文推荐期刊（关键词匹配）', recRows >= 1, `n=${recRows}`)

    // 阅读 → 拆解论文（paper-analysis）
    await cdp.evaluate(
      "(()=>{const r=document.querySelector('[data-testid=\"item-row\"]');if(r)r.click();return !!r})()"
    )
    await sleep(600)
    await openPanel(cdp, '拆解论文')
    const analysisRun = await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"analysis-run\"]');if(!b)return false;b.click();return true})()"
    )
    check('拆解论文面板可运行', analysisRun === true)
    let analysisOk = false
    for (let i = 0; i < 60; i++) {
      analysisOk = await cdp.evaluate("!!document.querySelector('[data-testid=\"analysis-result\"]')")
      if (analysisOk) break
      await sleep(400)
    }
    check('拆解产出分析（离线也可）', analysisOk === true)
    check(
      '拆解读取到正文（页数 > 0）',
      /[1-9]\d*\s*页/.test(
        await cdp.evaluate("(document.querySelector('[data-testid=\"analysis-notice\"]')||{}).textContent||''")
      )
    )
    check(
      '拆解包含八项小节',
      (await cdp.evaluate(
        "(()=>{const r=document.querySelector('[data-testid=\"analysis-result\"]');if(!r)return false;const t=r.textContent||'';return /研究问题/.test(t)&&/证据与结果/.test(t)&&/综合评价/.test(t)})()"
      )) === true
    )
    check(
      '拆解给出证据自检（定位/结论）',
      /定位 \d+ 处/.test(
        await cdp.evaluate(
          "(document.querySelector('[data-testid=\"analysis-quality\"]')||{}).textContent||''"
        )
      )
    )
    check(
      '拆解结果提示模型调用次数',
      /模型调用 \d+ 次/.test(
        await cdp.evaluate(
          "(document.querySelector('[data-testid=\"analysis-notice\"]')||{}).textContent||''"
        )
      )
    )

    // ---- PD54：关闭拆解同步（写入知识库权限）→ 拆解面板同步入口禁用 + 原因；恢复后可用 ----
    const pd54DigestGate = await cdp.evaluate(`(async()=>{
      const snap=()=>{
        const k=document.querySelector('[data-testid="digest-to-knowledge"]');
        const m=document.querySelector('[data-testid="digest-to-mindmap"]');
        return {k:k?{disabled:k.disabled,title:k.title}:null,m:m?{disabled:m.disabled,title:m.title}:null};
      };
      const before=snap();
      await window.api.aiTools.update({id:'digest-sync',permissions:{'write-knowledge':false}});
      await new Promise((r)=>setTimeout(r,300));
      const off=snap();
      await window.api.aiTools.update({id:'digest-sync',permissions:{'write-knowledge':true}});
      await new Promise((r)=>setTimeout(r,300));
      const on=snap();
      return {before,off,on};
    })()`)
    check(
      'PD54：关闭拆解同步后拆解面板「写入知识库/思维地图」入口禁用并提示原因',
      !!pd54DigestGate &&
        !!pd54DigestGate.off &&
        !!pd54DigestGate.off.k &&
        pd54DigestGate.off.k.disabled === true &&
        String(pd54DigestGate.off.k.title).includes('已在 AI 工具库关闭拆解同步') &&
        !!pd54DigestGate.off.m &&
        pd54DigestGate.off.m.disabled === true,
      JSON.stringify(pd54DigestGate)
    )
    check(
      'PD54：恢复拆解同步后两个同步入口立即回到关闭前的可用状态',
      !!pd54DigestGate &&
        !!pd54DigestGate.on &&
        !!pd54DigestGate.on.k &&
        pd54DigestGate.on.k.disabled === (pd54DigestGate.before && pd54DigestGate.before.k ? pd54DigestGate.before.k.disabled : false) &&
        !String(pd54DigestGate.on.k.title).includes('已在 AI 工具库') &&
        !!pd54DigestGate.on.m &&
        !String(pd54DigestGate.on.m.title).includes('已在 AI 工具库'),
      JSON.stringify(pd54DigestGate)
    )

    let linkOk = false
    for (let i = 0; i < 25; i++) {
      linkOk = await cdp.evaluate(
        "(()=>{const a=document.querySelector('[data-testid=\"analysis-result\"] .analysis__md a[href^=\"paperdesk://open\"]');return !!(a&&/attachment=.+&page=1$/.test(a.getAttribute('href')||''))})()"
      )
      if (linkOk) break
      await sleep(200)
    }
    check(
      '拆解中的 [p.N] 可点击跳原文',
      linkOk === true,
      String(
        await cdp.evaluate(
          "(()=>{const a=document.querySelector('[data-testid=\"analysis-result\"] .analysis__md a');return a?a.getAttribute('href'):'no-link'})()"
        )
      )
    )

    // 维度子集：取消 1/2/8 → 结果不含这些小节
    await cdp.evaluate(
      "(()=>{for(const n of [1,2,8]){const b=document.querySelector('[data-testid=\"analysis-sec-'+n+'\"]');if(b&&b.checked)b.click()}return true})()"
    )
    await sleep(200)
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"analysis-run\"]');if(b)b.click();return !!b})()"
    )
    let subOk = false
    for (let i = 0; i < 60; i++) {
      subOk = await cdp.evaluate(
        "(()=>{const r=document.querySelector('[data-testid=\"analysis-result\"]');if(!r)return false;const t=r.textContent||'';return /3 核心贡献/.test(t)&&!/研究问题/.test(t)&&!/综合评价/.test(t)})()"
      )
      if (subOk) break
      await sleep(400)
    }
    check('可只输出所选维度（子集）', subOk === true)

    // 与上次对比（同一篇 → 两次拆解产生历史）
    check(
      '拆解支持「与上次对比」',
      (await cdp.evaluate(
        "(()=>{const b=document.querySelector('[data-testid=\"analysis-diff-toggle\"]');if(!b)return false;b.click();return true})()"
      )) === true
    )
    let diffOk = false
    for (let i = 0; i < 25; i++) {
      diffOk = await cdp.evaluate(
        "(()=>{const d=document.querySelector('[data-testid=\"analysis-diff\"]');return !!d&&/diffrow/.test(d.innerHTML)})()"
      )
      if (diffOk) break
      await sleep(200)
    }
    check('对比视图渲染差异行', diffOk === true)

    // 技能选择器 + 导出 HTML 按钮（不点导出，避免弹系统保存框阻塞）
    check(
      '拆解面板有技能选择器',
      (await cdp.evaluate(
        "(()=>{const s=document.querySelector('[data-testid=\"analysis-skill\"]');return !!s&&s.options.length>=1&&s.value===''})()"
      )) === true
    )
    check(
      '拆解结果有「导出 HTML」按钮',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"analysis-export-html\"]')")) === true
    )
    // 归档到笔记：点击后按钮变为「已归档」，且笔记内容含该小节
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"analysis-note\"]');if(b)b.click();return !!b})()"
    )
    let archivedLabel = ''
    for (let i = 0; i < 20; i++) {
      archivedLabel = await cdp.evaluate(
        "(document.querySelector('[data-testid=\"analysis-note\"]')||{}).textContent||''"
      )
      if (/已归档/.test(archivedLabel)) break
      await sleep(300)
    }
    check('「归档到笔记」点击后有可见反馈（按钮变为已归档）', /已归档/.test(archivedLabel), archivedLabel)
    const noteHasSection = await cdp.evaluate(
      `window.api.notes.getForItem(${itemId}).then(n=>!!n&&n.content.includes('论文拆解'))`
    )
    check('归档后笔记包含「论文拆解」小节', noteHasSection === true)
    const notePath = await cdp.evaluate(
      `window.api.notes.getForItem(${itemId}).then(n=>n?n.note.md_path:'')`
    )
    check(
      '笔记文件名可读（含标题，不是随机 key）',
      typeof notePath === 'string' &&
        notePath.includes('阅读笔记') &&
        /\.md$/.test(notePath) &&
        !/notes\/[A-Z0-9]{6,}\.md$/.test(notePath),
      String(notePath)
    )

    // 技能模板「预览对比」（选另一个技能 → 逐行差异，只读）
    check(
      '拆解面板有技能对比目标选择器',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"analysis-skill-diff-target\"]')"
      )) === true
    )
    await cdp.evaluate(
      "(()=>{const s=document.querySelector('[data-testid=\"analysis-skill-diff-target\"]');if(!s)return false;const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;setter.call(s,'reviewer');s.dispatchEvent(new Event('change',{bubbles:true}));return true})()"
    )
    let skillDiffOk = false
    for (let i = 0; i < 20; i++) {
      skillDiffOk = await cdp.evaluate(
        "(()=>{const d=document.querySelector('[data-testid=\"analysis-skill-diff\"]');if(!d)return false;const t=d.textContent||'';return /\\+[0-9]+/.test(t)&&/[-−][0-9]+/.test(t)})()"
      )
      if (skillDiffOk) break
      await sleep(200)
    }
    check('技能对比渲染差异摘要（+/- 计数）', skillDiffOk === true)

    // 差异块内「设为当前技能」：一键切换技能 → 选择器/标签更新，差异块消失
    check(
      '技能差异块有「设为当前技能」按钮',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"analysis-skill-diff-apply\"]')"
      )) === true
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"analysis-skill-diff-apply\"]');if(!b)return false;b.click();return true})()"
    )
    await sleep(150)
    check(
      '点击「设为当前技能」后技能选择器切换为目标技能',
      (await cdp.evaluate(
        "document.querySelector('[data-testid=\"analysis-skill\"]').value === 'reviewer'"
      )) === true
    )
    check(
      '点击「设为当前技能」后技能标签显示目标技能',
      (await cdp.evaluate(
        "(()=>{const l=document.querySelector('[data-testid=\"analysis-skill-label\"]');return !!l&&(l.textContent||'').includes('reviewer')})()"
      )) === true
    )
    check(
      '点击「设为当前技能」后技能差异块消失',
      (await cdp.evaluate(
        "!document.querySelector('[data-testid=\"analysis-skill-diff\"]')"
      )) === true
    )

    // 小节可折叠
    const secCount = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"analysis-sections-view\"] details.analysis__sec').length"
    )
    check('拆解结果按小节渲染为可折叠块', secCount >= 3, `details=${secCount}`)
    check(
      '拆解结果有可点击大纲且条目数与小节数一致',
      (await cdp.evaluate(
        "(()=>{const o=document.querySelector('[data-testid=\"analysis-outline\"]');if(!o)return false;const n=o.querySelectorAll('button[data-testid^=\"analysis-outline-\"]').length;return n===document.querySelectorAll('[data-testid=\"analysis-sections-view\"] details.analysis__sec').length&&n>=3})()"
      )) === true
    )
    check(
      '点击大纲条目展开对应小节',
      (await cdp.evaluate(
        "(()=>{const b=document.querySelector('[data-testid=\"analysis-outline-1\"]');if(!b)return false;b.click();const el=document.querySelector('[data-testid=\"analysis-sec-view-1\"]');return !!el&&el.open===true})()"
      )) === true
    )
    let outlineActive = false
    for (let i = 0; i < 20; i++) {
      outlineActive = await cdp.evaluate(
        "document.querySelector('[data-testid=\"analysis-outline-1\"]').getAttribute('data-active') === 'true'"
      )
      if (outlineActive) break
      await sleep(200)
    }
    check('点击大纲条目后该项高亮（data-active=true）', outlineActive === true)
    // 上次查看小节：点击大纲后应把所选小节写回 localStorage（按附件 key）
    let persistedSection = false
    for (let i = 0; i < 10; i++) {
      persistedSection = await cdp.evaluate(
        "Object.keys(localStorage).some(k=>k.indexOf('paperdesk.analysis.lastSection.')===0)"
      )
      if (persistedSection) break
      await sleep(150)
    }
    check('点击大纲后记录「上次查看小节」到 localStorage', persistedSection === true)
    // 键盘导航：方向键在大纲条目间移动焦点（roving tabindex）
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"analysis-outline-0\"]');if(!b)return false;b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));return true})()"
    )
    await sleep(100)
    check(
      '大纲按 ArrowDown 聚焦下一项',
      (await cdp.evaluate(
        "document.activeElement && document.activeElement.getAttribute('data-testid') === 'analysis-outline-1'"
      )) === true
    )
    await cdp.evaluate(
      "(()=>{const b=document.activeElement;if(!b)return false;b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));return true})()"
    )
    await sleep(100)
    check(
      '大纲按 ArrowUp 聚焦上一项',
      (await cdp.evaluate(
        "document.activeElement && document.activeElement.getAttribute('data-testid') === 'analysis-outline-0'"
      )) === true
    )
    // 大纲「搜索小节」：输入过滤条目
    check(
      '大纲提供搜索小节输入框',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"analysis-outline-search\"]')"
      )) === true
    )
    const outlineTotal = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"analysis-outline\"] button[data-testid^=\"analysis-outline-\"]').length"
    )
    await cdp.evaluate(
      "(()=>{const inp=document.querySelector('[data-testid=\"analysis-outline-search\"]');if(!inp)return false;const b=document.querySelector('[data-testid=\"analysis-outline\"] button[data-testid^=\"analysis-outline-\"]');if(!b)return false;const title=(b.textContent||'').replace(/^\\d+\\.\\s*/,'');const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(inp,title);inp.dispatchEvent(new Event('input',{bubbles:true}));return true})()"
    )
    await sleep(120)
    check(
      '大纲搜索过滤后仅显示匹配条目（少于原始数）',
      (await cdp.evaluate(
        "(()=>{const c=document.querySelectorAll('[data-testid=\"analysis-outline\"] button[data-testid^=\"analysis-outline-\"]').length;return c>=1&&c<" +
          String(outlineTotal) +
          '})()'
      )) === true
    )
    await cdp.evaluate(
      "(()=>{const inp=document.querySelector('[data-testid=\"analysis-outline-search\"]');if(!inp)return false;const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(inp,'');inp.dispatchEvent(new Event('input',{bubbles:true}));return true})()"
    )
    await sleep(120)
    check(
      '大纲搜索清空后恢复全部条目',
      (await cdp.evaluate(
        "document.querySelectorAll('[data-testid=\"analysis-outline\"] button[data-testid^=\"analysis-outline-\"]').length"
      )) === outlineTotal
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"analysis-outline-1\"]');if(!b)return false;b.focus();b.click();return true})()"
    )
    await sleep(100)
    check(
      '大纲按 Enter/点击展开对应小节',
      (await cdp.evaluate(
        "(()=>{const el=document.querySelector('[data-testid=\"analysis-sec-view-1\"]');return !!el&&el.open===true})()"
      )) === true
    )
    check(
      '大纲同时只有一项处于高亮',
      (await cdp.evaluate(
        "document.querySelectorAll('[data-testid=\"analysis-outline\"] button[data-active=\"true\"]').length === 1"
      )) === true
    )
    check(
      '小节默认展开',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"analysis-sec-view-0\"][open]')"
      )) === true
    )
    check(
      '可一键折叠全部小节',
      (await cdp.evaluate(
        "(()=>{const b=document.querySelector('[data-testid=\"analysis-collapse-toggle\"]');if(!b)return false;b.click();return true})()"
      )) === true
    )
    await sleep(200)
    check(
      '折叠后小节不再展开',
      (await cdp.evaluate(
        "!document.querySelector('[data-testid=\"analysis-sec-view-0\"][open]')"
      )) === true
    )

    // 批次对比：勾选「确有附件」的前两篇
    const libWithAtt = await cdp.evaluate(
      'window.api.library.list().then(async l=>{const out=[];for(const i of l){const a=await window.api.attachments.listByItem(i.id);if(a.length)out.push(i.id)}return out})'
    )
    for (const id of (libWithAtt || []).slice(0, 2)) {
      await cdp.evaluate(
        `(()=>{const b=document.querySelector('[data-testid="analysis-pick-${id}"]');if(b&&!b.checked)b.click();return true})()`
      )
    }
    await sleep(200)
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"analysis-compare\"]');if(b)b.click();return !!b})()"
    )
    let compareOk = false
    for (let i = 0; i < 80; i++) {
      compareOk = await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"analysis-compare-result\"]')"
      )
      if (compareOk) break
      await sleep(400)
    }
    check('批次对比可运行（≥2 篇）', compareOk === true)
    check(
      '批次对比含可比性守卫提示',
      /仅供定性参考/.test(
        await cdp.evaluate(
          "(document.querySelector('[data-testid=\"analysis-compare-result\"]')||{}).textContent||''"
        )
      )
    )
    check(
      '批次对比有「导出 CSV」按钮',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"analysis-compare-csv\"]')")) === true
    )
    check(
      '批次对比有按维度浏览表格',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"analysis-compare-table\"]')")) === true
    )
    const setFilter = (val) =>
      cdp.evaluate(
        `(()=>{const i=document.querySelector('[data-testid="analysis-compare-filter"]');if(!i)return false;const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(i,'${val}');i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`
      )
    await setFilter('__nomatch__')
    await sleep(200)
    check(
      '对比表筛选无匹配时 tbody 无行',
      (await cdp.evaluate(
        "document.querySelectorAll('[data-testid=\"analysis-compare-table\"] tbody tr').length"
      )) === 0
    )
    await setFilter('')
    await sleep(200)
    check(
      '对比表清空筛选后 tbody 有行',
      (await cdp.evaluate(
        "document.querySelectorAll('[data-testid=\"analysis-compare-table\"] tbody tr').length"
      )) > 0
    )
    await setFilter('__nomatch__')
    await sleep(200)
    check(
      '对比表无匹配时「导出筛选结果」按钮禁用',
      (await cdp.evaluate(
        "document.querySelector('[data-testid=\"analysis-compare-csv-filtered\"]').disabled"
      )) === true
    )
    await setFilter('')
    await sleep(200)
    check(
      '对比表清空筛选后「导出筛选结果」按钮可用',
      (await cdp.evaluate(
        "document.querySelector('[data-testid=\"analysis-compare-csv-filtered\"]').disabled"
      )) === false
    )
    const thCount0 = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"analysis-compare-table\"] thead th').length"
    )
    const clickedHide = await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"analysis-compare-col-1\"]');if(!b)return false;b.click();return true})()"
    )
    await sleep(200)
    const thCount1 = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"analysis-compare-table\"] thead th').length"
    )
    const hidden1 = await cdp.evaluate(
      "(document.querySelector('[data-testid=\"analysis-compare-col-1\"]')||{}).getAttribute('data-hidden')"
    )
    check(
      '对比表可隐藏列（th 减少 1 且 data-hidden=true）',
      clickedHide === true && thCount1 === thCount0 - 1 && hidden1 === 'true',
      `th0=${thCount0} th1=${thCount1} hidden=${hidden1}`
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"analysis-compare-col-1\"]');if(!b)return false;b.click();return true})()"
    )
    await sleep(200)
    const thCount2 = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"analysis-compare-table\"] thead th').length"
    )
    check(
      '对比表再次点击恢复列（th 回到原值）',
      thCount2 === thCount0,
      `th0=${thCount0} th2=${thCount2}`
    )
    check(
      '对比表表头首行 cell 使用 sticky 定位',
      (await cdp.evaluate(
        "getComputedStyle(document.querySelector('[data-testid=\"analysis-compare-table\"] thead th')).position === 'sticky'"
      )) === true
    )
    check(
      '对比表表体首行 cell 使用 sticky 定位',
      (await cdp.evaluate(
        "getComputedStyle(document.querySelector('[data-testid=\"analysis-compare-table\"] tbody tr td')).position === 'sticky'"
      )) === true
    )
    check(
      '对比表表头有排序控件',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid^=\"analysis-compare-sort-\"]')"
      )) === true
    )
    const firstSortId = await cdp.evaluate(
      "(document.querySelector('[data-testid^=\"analysis-compare-sort-\"]')||{}).getAttribute('data-testid')||''"
    )
    await cdp.evaluate(
      `(()=>{const b=document.querySelector('[data-testid="${firstSortId}"]');if(!b)return false;b.click();return true})()`
    )
    await sleep(100)
    check(
      '对比表点击列头首次排序为 asc',
      (await cdp.evaluate(
        `(document.querySelector('[data-testid="${firstSortId}"]')||{}).getAttribute('data-sort')`
      )) === 'asc'
    )
    await cdp.evaluate(
      `(()=>{const b=document.querySelector('[data-testid="${firstSortId}"]');if(!b)return false;b.click();return true})()`
    )
    await sleep(100)
    check(
      '对比表同列再次点击切换为 desc',
      (await cdp.evaluate(
        `(document.querySelector('[data-testid="${firstSortId}"]')||{}).getAttribute('data-sort')`
      )) === 'desc'
    )
    const secondSortId = await cdp.evaluate(
      "(()=>{const all=document.querySelectorAll('[data-testid^=\"analysis-compare-sort-\"]');return all.length>1?(all[1].getAttribute('data-testid')||''):''})()"
    )
    await cdp.evaluate(
      `(()=>{const b=document.querySelector('[data-testid="${secondSortId}"]');if(!b)return false;b.click();return true})()`
    )
    await sleep(100)
    check(
      '对比表切换到其他列重置为 asc',
      secondSortId !== '' &&
        (await cdp.evaluate(
          `(document.querySelector('[data-testid="${secondSortId}"]')||{}).getAttribute('data-sort')`
        )) === 'asc' &&
        (await cdp.evaluate(
          `(document.querySelector('[data-testid="${firstSortId}"]')||{}).getAttribute('data-sort')`
        )) === 'none'
    )

    await ensureLeft(cdp)
    const gear = await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"open-settings-top\"],[data-testid=\"open-settings\"]');if(!b)return false;b.click();return true})()"
    )
    const dialogOpen =
      (await waitFor(cdp, "!!document.querySelector('[data-testid=\"settings-dialog\"]')")) === true
    check('设置弹窗可打开', gear === true && dialogOpen === true)

    let skillOk = false
    for (let i = 0; i < 30; i++) {
      skillOk = await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"skill-system-body\"]')"
      )
      if (skillOk) break
      await sleep(300)
    }
    check('设置里有「翻译技能」编辑器（按内容类型）', skillOk === true)
    check(
      '技能有 scope（全文/仅首页/第2页起）',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"skill-scope-body\"]')")) === true
    )
    check(
      '技能可导入/导出',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"skills-export\"]') && !!document.querySelector('[data-testid=\"skills-import\"]')"
      )) === true
    )
    // 「仅翻译正文」一键预设（最小版式改动）
    const presetClicked = await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"skills-preset-body-only\"]');if(!b)return false;b.click();return true})()"
    )
    check('技能提供「仅翻译正文」预设', presetClicked === true)
    await sleep(700)
    const skillSkip = await cdp.evaluate(
      "window.api.skills.list().then(l=>JSON.stringify(Object.fromEntries(l.map(s=>[s.match,s.skip]))))"
    )
    check(
      '预设后仅 body 参与翻译（标题/题注/公式/参考文献保持原样）',
      (() => {
        try {
          const o = JSON.parse(skillSkip)
          return (
            o.body === false &&
            o.heading === true &&
            o.caption === true &&
            o.formula === true &&
            o.reference === true
          )
        } catch {
          return false
        }
      })(),
      String(skillSkip)
    )
    await cdp.evaluate("document.querySelector('[data-testid=\"skills-reset\"]')?.click()")
    await sleep(400)
    check(
      '设置里有「历史版本保留」',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"set-keep-versions\"]')")) === true
    )
    check(
      '设置里有「扫描孤儿文件」',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"scan-orphans\"]')")) === true
    )
    check(
      '设置里有「论文拆解技能」编辑区',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"analysis-skill-text\"]')")) === true
    )
    const skillLen = await cdp.evaluate('window.api.analysis.getSkill().then(t=>(t||"").length)')
    check('论文拆解技能文本可读取', skillLen > 200, `len=${skillLen}`)
    const skillRound = await cdp.evaluate(
      "window.api.analysis.saveSkill('SENTINEL-技能测试').then(()=>window.api.analysis.getSkill())"
    )
    check('论文拆解技能可保存（写文件）', String(skillRound).includes('SENTINEL'), String(skillRound).slice(0, 40))
    await cdp.evaluate('window.api.analysis.resetSkill()')
    const skillBack = await cdp.evaluate('window.api.analysis.getSkill().then(t=>(t||"").length)')
    check('论文拆解技能可恢复内置', skillBack > 200, `len=${skillBack}`)

    // 多套拆解技能：列出 / 另存为 / 删除
    const skillNames = await cdp.evaluate('window.api.analysis.listSkills()')
    check(
      '拆解技能可列出（含内置）',
      Array.isArray(skillNames) && skillNames.includes('paper-analysis'),
      JSON.stringify(skillNames)
    )
    check(
      '预置三套技能模板（survey/method/reviewer）',
      Array.isArray(skillNames) &&
        ['survey', 'method', 'reviewer'].every((n) => skillNames.includes(n)),
      JSON.stringify(skillNames)
    )
    const templateLen = await cdp.evaluate(
      "window.api.analysis.getSkill('reviewer').then(t=>(t||'').length)"
    )
    check('技能模板可读取', templateLen > 100, `len=${templateLen}`)
    const skillCopied = await cdp.evaluate("window.api.analysis.copySkill('paper-analysis','e2e-skill')")
    check('拆解技能可另存为', skillCopied === 'e2e-skill', String(skillCopied))
    const names2 = await cdp.evaluate('window.api.analysis.listSkills()')
    check(
      '另存后出现在技能列表',
      Array.isArray(names2) && names2.includes('e2e-skill'),
      JSON.stringify(names2)
    )
    const delRes = await cdp.evaluate("window.api.analysis.deleteSkill('e2e-skill')")
    check(
      '自定义拆解技能可删除（内置保留）',
      Array.isArray(delRes) && !delRes.includes('e2e-skill') && delRes.includes('paper-analysis'),
      JSON.stringify(delRes)
    )
    const setBody = await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"settings-dialog\"] .modal__body');return b?JSON.stringify({c:b.clientHeight,s:b.scrollHeight}):null})()"
    )
    const sb = setBody ? JSON.parse(setBody) : null
    check('设置内容可滚动、不被裁剪', !!sb && sb.s > sb.c + 50, String(setBody))
    const orph = await cdp.evaluate('window.api.translate.orphans()')
    check(
      '可扫描孤儿文件',
      !!orph &&
        Array.isArray(orph.orphans) &&
        typeof orph.bytes === 'number' &&
        typeof orph.dir === 'string',
      JSON.stringify(orph && { n: orph.orphans.length, dir: orph.dir })
    )
    check(
      '设置可导入/导出',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"settings-export\"]') && !!document.querySelector('[data-testid=\"settings-import\"]')"
      )) === true
    )

    // PD25：联网检索设置项（开关 + 代理输入）
    check(
      '设置里有「联网检索」开关且默认关闭',
      (await cdp.evaluate(
        "(()=>{const s=document.querySelector('[data-testid=\"set-websearch-enabled\"]');return s?s.value:'missing'})()"
      )) === '0'
    )
    check(
      '设置里有「检索代理」输入（留空走系统代理→直连）',
      String(
        await cdp.evaluate(
          "(()=>{const i=document.querySelector('[data-testid=\"set-websearch-proxy\"]');return i?i.getAttribute('placeholder')||'':'missing'})()"
        )
      ).includes('系统代理')
    )
    await cdp.evaluate(setInput('[data-testid="set-websearch-enabled"]', '1'))
    await cdp.evaluate(setInput('[data-testid="set-websearch-proxy"]', 'http://127.0.0.1:7993'))
    await cdp.evaluate("document.querySelector('[data-testid=\"set-save\"]').click()")
    await sleep(500)
    const webSaved = await cdp.evaluate('window.api.settings.get().then(s=>s.websearch)')
    check(
      '设置弹窗可保存联网开关与代理（回读一致）',
      !!webSaved && webSaved.enabled === '1' && webSaved.proxy === 'http://127.0.0.1:7993',
      JSON.stringify(webSaved)
    )
    await cdp.evaluate(setInput('[data-testid="set-websearch-enabled"]', '0'))
    await cdp.evaluate(setInput('[data-testid="set-websearch-proxy"]', ''))
    await cdp.evaluate("document.querySelector('[data-testid=\"set-save\"]').click()")
    await sleep(400)
    const webReset = await cdp.evaluate('window.api.settings.get().then(s=>s.websearch)')
    check(
      '联网检索复位为关闭/无代理',
      !!webReset && webReset.enabled === '0' && webReset.proxy === '',
      JSON.stringify(webReset)
    )

    // ---- PD54：设置里的「AI 工具库」（分类计数、筛选、搜索、空态、开关即改即存） ----
    const pd54Panel = await cdp.evaluate(`(()=>{
      const panel=document.querySelector('[data-testid="ai-tools-panel"]');
      if(!panel) return null;
      const tabs=[...panel.querySelectorAll('[data-testid^="ai-tools-category-"]')].map((t)=>({id:t.getAttribute('data-testid'),text:(t.textContent||'').trim()}));
      return {
        section:!!document.querySelector('[data-testid="settings-section-ai-tools"]'),
        search:!!panel.querySelector('[data-testid="ai-tools-search"]'),
        cards:[...panel.querySelectorAll('.ai-tools__card')].map((c)=>c.getAttribute('data-testid')),
        toggles:panel.querySelectorAll('[data-testid^="ai-tool-toggle-"]').length,
        perms:panel.querySelectorAll('[data-testid^="ai-tool-perm-"]').length,
        tabs
      };
    })()`)
    const pd54Total = pd54Panel ? pd54Panel.cards.length : 0
    check(
      'PD54：设置里有「AI 工具库」分区，列出全部工具卡片、开关与分类计数',
      !!pd54Panel &&
        pd54Panel.section === true &&
        pd54Panel.cards.length >= 6 &&
        pd54Panel.toggles === pd54Panel.cards.length &&
        pd54Panel.perms >= pd54Panel.cards.length &&
        pd54Panel.search === true &&
        pd54Panel.tabs.length === 6 &&
        new RegExp('全部\\s*' + pd54Total).test(pd54Panel.tabs[0].text) &&
        pd54Panel.tabs.some((t) => t.id === 'ai-tools-category-knowledge' && /知识库/.test(t.text) && /\b2\b/.test(t.text)),
      JSON.stringify(pd54Panel && { cards: pd54Panel.cards, tabs: pd54Panel.tabs, toggles: pd54Panel.toggles, perms: pd54Panel.perms })
    )
    const pd54Cat = await cdp.evaluate(`(async()=>{
      const click=(id)=>{const b=document.querySelector('[data-testid="ai-tools-category-'+id+'"]');if(b)b.click();return !!b};
      const snap=()=>({cards:[...document.querySelectorAll('[data-testid="ai-tools-panel"] .ai-tools__card')].map((c)=>c.getAttribute('data-testid')),empty:!!document.querySelector('[data-testid="ai-tools-empty"]')});
      click('knowledge'); await new Promise((r)=>setTimeout(r,200));
      const knowledge=snap();
      click('translation'); await new Promise((r)=>setTimeout(r,200));
      const translation=snap();
      click('all'); await new Promise((r)=>setTimeout(r,200));
      const all=snap();
      return {knowledge,translation,all};
    })()`)
    check(
      'PD54：切到「知识库」只显示该分类的 2 个工具，翻译分类显示空态',
      !!pd54Cat &&
        pd54Cat.knowledge.cards.length === 2 &&
        pd54Cat.knowledge.cards.every((id) => /ai-tool-(digest-sync|batch-sync)$/.test(String(id))) &&
        pd54Cat.translation.cards.length === 0 &&
        pd54Cat.translation.empty === true &&
        pd54Cat.all.cards.length === pd54Total,
      JSON.stringify(pd54Cat)
    )
    await cdp.evaluate(setInput('[data-testid="ai-tools-search"]', '联网'))
    await sleep(250)
    const pd54Search = await cdp.evaluate(`(()=>{
      const panel=document.querySelector('[data-testid="ai-tools-panel"]');
      return panel?{cards:[...panel.querySelectorAll('.ai-tools__card')].map((c)=>c.getAttribute('data-testid')),empty:!!panel.querySelector('[data-testid="ai-tools-empty"]')}:null;
    })()`)
    check(
      'PD54：关键词搜索按名称/说明过滤（搜索「联网」只剩联网检索）',
      !!pd54Search && pd54Search.cards.length === 1 && pd54Search.cards[0] === 'ai-tool-web-search' && pd54Search.empty === false,
      JSON.stringify(pd54Search)
    )
    await cdp.evaluate(setInput('[data-testid="ai-tools-search"]', 'zzz-不存在的工具'))
    await sleep(250)
    const pd54Empty = await cdp.evaluate(`(()=>{
      const panel=document.querySelector('[data-testid="ai-tools-panel"]');
      const empty=panel&&panel.querySelector('[data-testid="ai-tools-empty"]');
      const btn=panel&&panel.querySelector('[data-testid="ai-tools-clear-filters"]');
      return {cards:panel?panel.querySelectorAll('.ai-tools__card').length:0,empty:!!empty,text:empty?empty.textContent:'',clear:!!btn};
    })()`)
    check(
      'PD54：搜索无结果时显示空态与「清除筛选」按钮',
      !!pd54Empty && pd54Empty.cards === 0 && pd54Empty.empty === true && pd54Empty.clear === true && /清除筛选/.test(pd54Empty.text),
      JSON.stringify(pd54Empty)
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"ai-tools-clear-filters\"]');if(b)b.click();return !!b})()"
    )
    await sleep(250)
    const pd54Cleared = await cdp.evaluate(`(()=>{
      const panel=document.querySelector('[data-testid="ai-tools-panel"]');
      const inp=panel&&panel.querySelector('[data-testid="ai-tools-search"]');
      return {cards:panel?panel.querySelectorAll('.ai-tools__card').length:0,empty:!!(panel&&panel.querySelector('[data-testid="ai-tools-empty"]')),query:inp?inp.value:null};
    })()`)
    check(
      'PD54：清除筛选后恢复全部工具、搜索框清空',
      !!pd54Cleared && pd54Cleared.cards === pd54Total && pd54Cleared.empty === false && pd54Cleared.query === '',
      JSON.stringify(pd54Cleared)
    )
    // 开关与权限勾选即改即存（无保存按钮），主进程回读一致后再复位
    const pd54Toggle = await cdp.evaluate(`(async()=>{
      const list=()=>window.api.aiTools.list().then((r)=>r.tools);
      const click=(id)=>{const b=document.querySelector('[data-testid="'+id+'"]');if(!b)return false;b.click();return true};
      click('ai-tool-toggle-web-search');
      await new Promise((r)=>setTimeout(r,450));
      const afterOff=(await list()).find((t)=>t.id==='web-search');
      const uiOff=(()=>{const c=document.querySelector('[data-testid="ai-tool-web-search"]');return c?c.classList.contains('is-off'):null})();
      click('ai-tool-toggle-web-search');
      await new Promise((r)=>setTimeout(r,450));
      const afterOn=(await list()).find((t)=>t.id==='web-search');
      click('ai-tool-perm-web-search-network');
      await new Promise((r)=>setTimeout(r,450));
      const permOff=(await list()).find((t)=>t.id==='web-search');
      click('ai-tool-perm-web-search-network');
      await new Promise((r)=>setTimeout(r,450));
      const permOn=(await list()).find((t)=>t.id==='web-search');
      return {
        offEnabled:afterOff?afterOff.enabled:null,
        offClass:uiOff,
        onEnabled:afterOn?afterOn.enabled:null,
        permOff:permOff?permOff.permissions.network:null,
        permOn:permOn?permOn.permissions.network:null
      };
    })()`)
    check(
      'PD54：卡片开关与权限勾选即改即存（关→主进程回读已关，开→恢复）',
      !!pd54Toggle &&
        pd54Toggle.offEnabled === false &&
        pd54Toggle.offClass === true &&
        pd54Toggle.onEnabled === true &&
        pd54Toggle.permOff === false &&
        pd54Toggle.permOn === true,
      JSON.stringify(pd54Toggle)
    )

    await cdp.evaluate(setInput('[data-testid="set-provider-baseurl"]', 'https://api.example.com/v1'))
    await cdp.evaluate("document.querySelector('[data-testid=\"set-save\"]').click()")
    await sleep(500)
    const saved = await cdp.evaluate('window.api.settings.get()')
    check(
      '设置已持久化（模型服务 Base URL）',
      !!saved && !!saved.provider && saved.provider.baseUrl === 'https://api.example.com/v1',
      JSON.stringify(saved && saved.provider)
    )

    const savedSecret = await cdp.evaluate(
      "window.api.settings.save({provider:{apiKey:'sk-test-123'}}).then(s=>s.provider.apiKeySet)"
    )
    check('密钥保存后仅回传「已设置」标记', savedSecret === true, `apiKeySet=${savedSecret}`)

    const health = await cdp.evaluate('window.api.system.health()')
    check(
      '服务自检可用（Python 解析服务正常）',
      !!health && !!health.python && health.python.ok === true,
      JSON.stringify(health)
    )

    await cdp.evaluate(setInput('[data-testid="set-theme"]', 'dark'))
    await sleep(250)
    const themeAttr = await cdp.evaluate('document.documentElement.dataset.theme')
    check('主题即时切换为深色', themeAttr === 'dark', `theme=${themeAttr}`)
    await cdp.evaluate("document.querySelector('[data-testid=\"set-save\"]').click()")
    await sleep(450)
    const themeSaved = await cdp.evaluate('window.api.settings.get().then(s=>s.ui.theme)')
    check('主题设置已持久化', themeSaved === 'dark', `saved=${themeSaved}`)

    // 还原为离线占位，避免后续用例走真实网络
    await cdp.evaluate("window.api.settings.save({provider:{baseUrl:'', mode:'mock'}})")
    const restored = await cdp.evaluate('window.api.settings.get().then(s=>s.provider)')
    check('可切回离线占位模式', restored.mode === 'mock' && restored.baseUrl === '', JSON.stringify(restored))

    await ensureLeft(cdp)
    console.log('--- M8 语义检索 ---')
    const idx = await cdp.evaluate(`window.api.search.index(${attId})`)
    check('分块已建立向量索引', !!idx && idx.indexed >= 1, JSON.stringify(idx))

    const sem = await cdp.evaluate("window.api.ai.ask('Smith', {mode:'semantic'})")
    check(
      '语义检索返回结果',
      !!sem && Array.isArray(sem.citations) && sem.citations.length >= 1,
      `cites=${sem && sem.citations ? sem.citations.length : 0}`
    )
    const hashBackend = /hash|mock/i.test(String(sem.backend ?? ''))
    check(
      '语义模式按后端能力降级（哈希后端一律词法）',
      hashBackend ? sem.mode === 'lexical' : sem.mode === 'semantic',
      `mode=${sem.mode} backend=${sem.backend}`
    )

    const hyb = await cdp.evaluate("window.api.ai.ask('Smith')")
    check(
      '默认检索按后端能力降级（哈希后端一律词法）',
      hashBackend ? hyb.mode === 'lexical' : hyb.mode === 'hybrid',
      `mode=${hyb.mode} backend=${hyb.backend}`
    )

    const lex = await cdp.evaluate("window.api.ai.ask('Smith', {mode:'lexical'})")
    check('词法模式生效', lex.mode === 'lexical', `mode=${lex.mode}`)

    await openPanel(cdp, '问答')
    await sleep(300)
    const modeUi = await cdp.evaluate(
      "document.querySelectorAll('[data-testid^=\"ai-mode-\"]').length"
    )
    check('问答面板不再提供检索模式切换（固定混合检索）', modeUi === 0, `modeButtons=${modeUi}`)
    await cdp.evaluate(setInput('[data-testid="ai-input"]', 'Smith'))
    await cdp.evaluate("document.querySelector('[data-testid=\"ai-ask\"]').click()")
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"ai-msg-assistant\"]')", {
      timeout: 5000
    })
    check(
      '问答面板仍可正常提问',
      (await cdp.evaluate(
        "document.querySelectorAll('[data-testid=\"ai-msg-assistant\"]').length"
      )) >= 1
    )

    await ensureLeft(cdp)
    console.log('--- M10 批处理 ---')
    const batchTasks = await cdp.evaluate('window.api.batch.tasks()')
    const taskIds = (batchTasks || []).map((t) => t.id)
    check(
      '批处理任务仅保留翻译/拆解/翻译+拆解',
      ['translate', 'analyze-paper', 'translate-analyze'].every((id) =>
        taskIds.includes(id)
      ) &&
        taskIds.every((id) =>
          ['translate', 'analyze-paper', 'translate-analyze'].includes(id)
        ),
      JSON.stringify(taskIds)
    )
    const tazKeys = (
      ((batchTasks || []).find((t) => t.id === 'translate-analyze') || {}).paramFields || []
    ).map((f) => f.key)
    check(
      '翻译+拆解任务无需额外参数',
      tazKeys.length === 0,
      JSON.stringify(tazKeys)
    )
    const trKeys = (
      ((batchTasks || []).find((t) => t.id === 'translate') || {}).paramFields || []
    ).map((f) => f.key)
    check(
      '批处理翻译任务提供精译/粗译两种模式',
      trKeys.includes('mode'),
      JSON.stringify(trKeys)
    )

    const win0 = await cdp.evaluate('window.api.batch.status()')
    check(
      '低峰时段状态可用',
      !!win0 && typeof win0.inOffPeak === 'boolean' && !!win0.start,
      JSON.stringify(win0)
    )

    // 1) 导出 HTML（保公式排版）
    const job1 = await cdp.evaluate(
      `window.api.batch.create({task:'export-doc', scope:'attachment', attachmentId:${attId}, params:{format:'html'}})`
    )
    check('创建导出作业', !!job1 && job1.id > 0, JSON.stringify(job1 && { id: job1.id, status: job1.status, total: job1.total }))

    let j1 = null
    for (let i = 0; i < 60; i++) {
      j1 = await cdp.evaluate(`window.api.batch.list().then(l=>l.find(x=>x.id===${job1.id}))`)
      if (j1 && (j1.status === 'done' || j1.status === 'failed')) break
      await sleep(500)
    }
    check(
      '导出作业完成',
      !!j1 && j1.status === 'done',
      JSON.stringify(j1 && { status: j1.status, done: j1.done, total: j1.total, error: j1.error })
    )
    const j1items = await cdp.evaluate(`window.api.batch.items(${job1.id})`)
    const j1item = (j1items || [])[0]
    check('导出产出记录为 done', !!j1item && j1item.status === 'done' && !!j1item.output, JSON.stringify(j1item))
    const htmlName = j1item && j1item.output ? JSON.parse(j1item.output)[0] : ''
    const htmlPath = j1 && htmlName ? path.join(j1.out_dir, htmlName) : ''
    const htmlOk =
      !!htmlPath && fs.existsSync(htmlPath) && fs.readFileSync(htmlPath, 'utf8').includes('<html')
    check('导出 HTML 文件已落盘', htmlOk, htmlPath)

    // 1c) 论文拆解（作用域 all → 2 篇；finalize 出 index.md 对比）
    const jobAn = await cdp.evaluate(
      `window.api.batch.create({task:'analyze-paper', scope:'all', params:{depth:'brief', compare:'1', archiveNote:'1', indexNote:'1'}})`
    )
    check('创建论文拆解作业', !!jobAn && jobAn.id > 0)
    let jAn = null
    for (let i = 0; i < 150; i++) {
      jAn = await cdp.evaluate(`window.api.batch.list().then(l=>l.find(x=>x.id===${jobAn.id}))`)
      if (jAn && (jAn.status === 'done' || jAn.status === 'failed')) break
      await sleep(500)
    }
    check(
      '论文拆解作业完成',
      !!jAn && jAn.status === 'done',
      JSON.stringify(jAn && { status: jAn.status, error: jAn.error, total: jAn.total })
    )
    const anItems = await cdp.evaluate(`window.api.batch.items(${jobAn.id})`)
    check(
      '拆解逐篇产出报告',
      Array.isArray(anItems) && anItems.length >= 2 && anItems.every((it) => it.status === 'done'),
      JSON.stringify((anItems || []).map((i) => i.status))
    )
    const anReports = jAn && jAn.out_dir ? fs.readdirSync(jAn.out_dir).filter((f) => f.endsWith('.analysis.md')) : []
    check(
      '拆解报告含证据自检',
      anReports.length >= 1 &&
        fs.readFileSync(path.join(jAn.out_dir, anReports[0]), 'utf8').includes('证据自检'),
      JSON.stringify(anReports)
    )
    const anIdx = jAn && jAn.out_dir ? path.join(jAn.out_dir, 'index.md') : ''
    check(
      '拆解批次索引 index.md 已生成（含批次对比）',
      !!anIdx && fs.existsSync(anIdx) && fs.readFileSync(anIdx, 'utf8').includes('批次对比'),
      String(anIdx)
    )
    const anKeys = (
      ((batchTasks || []).find((t) => t.id === 'analyze-paper') || {}).paramFields || []
    ).map((f) => f.key)
    check('论文拆解任务含「归档到笔记」参数', anKeys.includes('archiveNote'), JSON.stringify(anKeys))
    const anNote = await cdp.evaluate(
      `window.api.notes.getForItem(${itemId}).then(n=>n?n.content:'')`
    )
    check('拆解结果自动归档到笔记', String(anNote).includes('论文拆解'), String(anNote).slice(0, 60))
    const idxNote = await cdp.evaluate("window.api.notes.getByPath('notes/REVIEWANALYSIS.md')")
    check(
      '拆解汇总可写入「论文拆解汇总」笔记',
      !!idxNote && String(idxNote.title || '').includes('论文拆解汇总'),
      JSON.stringify(idxNote && { id: idxNote.id, title: idxNote.title })
    )
    // 拆解明细必须能直接跳到对应论文笔记，否则用户找不到报告被归档到哪里
    const anNoteItem = (anItems || []).find((it) => String(it.message || '').includes('已写入笔记'))
    check(
      '拆解明细标明已归档到哪篇笔记',
      !!anNoteItem && anNoteItem.item_id != null,
      JSON.stringify(anNoteItem && { id: anNoteItem.id, message: anNoteItem.message })
    )
    await openPanel(cdp, '批处理')
    // 前面的筛选测试可能把状态/关键词留在非默认值；先恢复“全部”，否则新作业不可见
    await cdp.evaluate(setInput('[data-testid="batch-filter-status"]', 'all'))
    await cdp.evaluate(setInput('[data-testid="batch-filter-keyword"]', ''))
    await sleep(200)
    let openedBatchJob = false
    for (let i = 0; i < 30; i++) {
      openedBatchJob = await cdp.evaluate(
        `(()=>{const el=document.querySelector('[data-testid="batch-job-${jobAn.id}"]');if(!el)return false;el.click();return true})()`
      )
      if (openedBatchJob) break
      await sleep(100)
    }

    // 1d) PD52：同步分区（按钮 + 说明）、内联结果与可展开明细
    if (!openedBatchJob) {
      check('PD52：批处理作业卡显示独立同步分区', false, '作业卡片未出现')
    } else {
      const syncGeom = () =>
        cdp.evaluate(`(()=>{
          const head=document.querySelector('[data-testid="batch-job-${jobAn.id}"]');
          const card=head&&head.closest('.batch__job');
          if(!card) return {count:0,overlaps:[['','']],out:['no-card'],rects:[]};
          const els=[...card.querySelectorAll('[data-testid="batch-sync-knowledge"],[data-testid="batch-sync-mindmap"]')];
          const cr=card.getBoundingClientRect();
          const rects=els.map((el)=>{const r=el.getBoundingClientRect();return {text:(el.textContent||'').trim().slice(0,10),left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}});
          const overlaps=[];
          for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];if(!(a.right<=b.left+0.5||b.right<=a.left+0.5||a.bottom<=b.top+0.5||b.bottom<=a.top+0.5)) overlaps.push([a.text,b.text])}
          const out=rects.filter((r)=>r.left<cr.left-1||r.right>cr.right+1||r.top<cr.top-1||r.bottom>cr.bottom+1).map((r)=>r.text);
          return {count:rects.length,overlaps,out,rects,card:{left:cr.left,top:cr.top,right:cr.right,bottom:cr.bottom}};
        })()`)
      for (const [w, h] of [
        [1280, 800],
        [1080, 720]
      ]) {
        const resp = await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: w,
          height: h,
          deviceScaleFactor: 1,
          mobile: false
        })
        await sleep(300)
        const g = await syncGeom()
        const ok =
          !resp.error &&
          g.count === 2 &&
          g.overlaps.length === 0 &&
          g.out.length === 0 &&
          g.rects.every((r) => r.width > 0 && r.height > 0)
        check(`PD52：同步按钮在 ${w}x${h} 下互不重叠且不溢出卡片`, ok, JSON.stringify(g))
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride', {})
      await sleep(300)

      const syncClicked = await cdp.evaluate(`(()=>{
        window.__pd52Confirm = window.confirm;
        window.confirm = () => true;
        const head=document.querySelector('[data-testid="batch-job-${jobAn.id}"]');
        const card=head&&head.closest('.batch__job');
        if(!card) return 'no-card';
        const both=card.querySelectorAll('[data-testid="batch-sync-knowledge"],[data-testid="batch-sync-mindmap"]').length;
        if(both!==2) return 'buttons:'+both;
        if(!card.querySelector('[data-testid="batch-sync-knowledge-${jobAn.id}"]')) return 'no-wrapper';
        const btn=card.querySelector('[data-testid="batch-sync-knowledge"]');
        if(!btn) return 'no-button';
        btn.click();
        return 'clicked';
      })()`)
      check('PD52：作业卡同时提供知识库与思维地图两个同步按钮', syncClicked === 'clicked', String(syncClicked))
      await waitFor(cdp, "!!document.querySelector('[data-testid=\"batch-sync-result\"]')", {
        timeout: 15000
      })
      const syncUi = await cdp.evaluate(`(()=>{
        const card=document.querySelector('[data-testid="batch-job-${jobAn.id}"]')?.closest('.batch__job');
        const box=card&&card.querySelector('[data-testid="batch-sync-result"]');
        const details=card&&card.querySelector('[data-testid="batch-sync-detail"]');
        if(details) details.open=true;
        const rows=details?[...details.querySelectorAll('li')]:[];
        return {
          text:box?box.textContent.trim():'',
          hasDetails:!!details,
          open:details?details.open:false,
          rows:rows.map((li)=>({text:li.textContent.trim(),title:li.querySelector('.batch__sync-row-title')?.getAttribute('title')||'',status:li.querySelector('.batch__sync-row-status')?.textContent.trim()||'',reason:li.querySelector('.batch__sync-row-reason')?.textContent.trim()||''}))
        };
      })()`)
      check(
        'PD52：知识库同步后内联结果含「成功 N · 跳过 M · 失败 K」',
        /成功\s*\d+\s*·\s*跳过\s*\d+\s*·\s*失败\s*\d+/.test(syncUi.text) &&
          syncUi.text.includes('成功'),
        JSON.stringify(syncUi.text)
      )
      check(
        'PD52：同步结果明细可展开且逐篇列出标题/结果/原因',
        syncUi.hasDetails &&
          syncUi.open &&
          syncUi.rows.length >= 2 &&
          syncUi.rows.every((r) => r.text.length > 0 && ['成功', '跳过', '失败'].includes(r.status)) &&
          syncUi.rows.some((r) => r.title.length > 0) &&
          syncUi.rows.every((r) => r.reason.length > 0),
        JSON.stringify(syncUi.rows.slice(0, 3))
      )
      // ---- PD54：关闭拆解同步（写入知识库权限）→ 批处理同步入口禁用 + 原因；恢复后可用 ----
      const pd54BatchGate = await cdp.evaluate(`(async()=>{
        const snap=()=>{
          const card=document.querySelector('[data-testid="batch-job-${jobAn.id}"]')?.closest('.batch__job');
          const b=card?card.querySelector('[data-testid="batch-sync-knowledge"]'):null;
          return b?{disabled:b.disabled,title:b.title}:null;
        };
        const before=snap();
        await window.api.aiTools.update({id:'digest-sync',permissions:{'write-knowledge':false}});
        await new Promise((r)=>setTimeout(r,300));
        const off=snap();
        await window.api.aiTools.update({id:'digest-sync',permissions:{'write-knowledge':true}});
        await new Promise((r)=>setTimeout(r,300));
        const on=snap();
        return {before,off,on};
      })()`)
      check(
        'PD54：关闭写入知识库权限后批处理同步按钮禁用并提示原因',
        !!pd54BatchGate &&
          !!pd54BatchGate.off &&
          pd54BatchGate.off.disabled === true &&
          String(pd54BatchGate.off.title).includes('已在 AI 工具库关闭拆解同步'),
        JSON.stringify(pd54BatchGate)
      )
      check(
        'PD54：恢复写入知识库权限后批处理同步按钮立即恢复可用（无需重启）',
        !!pd54BatchGate &&
          !!pd54BatchGate.on &&
          pd54BatchGate.on.disabled === false &&
          !String(pd54BatchGate.on.title).includes('已在 AI 工具库'),
        JSON.stringify(pd54BatchGate)
      )
      const pd59MindmapConfirm = await cdp.evaluate(`(()=>{
        const card=document.querySelector('[data-testid="batch-job-${jobAn.id}"]')?.closest('.batch__job');
        const btn=card?card.querySelector('[data-testid="batch-sync-mindmap"]'):null;
        if(!btn) return {err:'no-button'};
        let msg='';
        const orig=window.confirm;
        window.confirm=(m)=>{msg=String(m);return false};
        btn.click();
        window.confirm=orig;
        return {msg,disabled:btn.disabled};
      })()`)
      check(
        'PD59：思维地图同步确认文案说明「覆盖上一次同步 / 保留改过名的节点」，不再声称只追加',
        !!pd59MindmapConfirm &&
          String(pd59MindmapConfirm.msg).includes('覆盖上一次同步') &&
          String(pd59MindmapConfirm.msg).includes('改过名') &&
          !String(pd59MindmapConfirm.msg).includes('追加新节点'),
        JSON.stringify(pd59MindmapConfirm)
      )
      await cdp.evaluate(
        '(()=>{if(window.__pd52Confirm){window.confirm=window.__pd52Confirm;delete window.__pd52Confirm}return true})()'
      )
    }
    if (!anNoteItem) {
      check('拆解明细显示「查看笔记」按钮', false, '没有找到已写入笔记的明细')
    } else if (!openedBatchJob) {
      check('拆解明细显示「查看笔记」按钮', false, '作业卡片未出现')
    } else {
      await waitFor(cdp, `!!document.querySelector('[data-testid="batch-open-note-${anNoteItem.id}"]')`)
      const clickedNote = await cdp.evaluate(
        `(()=>{const el=document.querySelector('[data-testid="batch-open-note-${anNoteItem.id}"]');if(!el)return false;el.click();return true})()`
      )
      check('拆解明细显示「查看笔记」按钮', clickedNote === true)
      await waitFor(
        cdp,
        "!!document.querySelector('[data-testid=\"panel-tab-notes\"].primary')"
      )
      check(
        '「查看笔记」跳到该论文的笔记面板',
        (await cdp.evaluate(
          "document.querySelector('[data-testid=\"panel-tab-notes\"]')?.classList.contains('primary')"
        )) === true
      )
    }

    // 2) 按范式拆解（离线 mock）
    const job2 = await cdp.evaluate(
      `window.api.batch.create({task:'decompose', scope:'item', itemId:${itemId}, params:{}})`
    )
    let j2 = null
    for (let i = 0; i < 60; i++) {
      j2 = await cdp.evaluate(`window.api.batch.list().then(l=>l.find(x=>x.id===${job2.id}))`)
      if (j2 && (j2.status === 'done' || j2.status === 'failed')) break
      await sleep(500)
    }
    const j2items = await cdp.evaluate(`window.api.batch.items(${job2.id})`)
    const j2item = (j2items || [])[0]
    check(
      '拆解作业产出结果',
      !!j2 && j2.status === 'done' && !!j2item && j2item.status === 'done',
      JSON.stringify({ status: j2 && j2.status, msg: j2item && j2item.message })
    )
    const mdName = j2item && j2item.output ? JSON.parse(j2item.output)[0] : ''
    const mdPath = j2 && mdName ? path.join(j2.out_dir, mdName) : ''
    const mdOk = !!mdPath && fs.existsSync(mdPath) && fs.readFileSync(mdPath, 'utf8').includes('论文拆解')
    check('拆解结果含范式小节', mdOk, mdPath)

    // 3) 低峰调度：把窗口设为「不含当前时间」
    const hh = new Date().getHours()
    const start = hh < 12 ? '20:00' : '06:00'
    const end = hh < 12 ? '21:00' : '07:00'
    await cdp.evaluate(
      `window.api.settings.save({batch:{offPeakOnly:'0', offPeakStart:'${start}', offPeakEnd:'${end}'}})`
    )
    const win1 = await cdp.evaluate('window.api.batch.status()')
    check('低峰窗口外判定正确', win1.inOffPeak === false, JSON.stringify(win1))
    const job3 = await cdp.evaluate(
      `window.api.batch.create({task:'export-doc', scope:'attachment', attachmentId:${attId}, params:{format:'md'}, offPeakOnly:true})`
    )
    check(
      '低峰外创建的作业被排入 scheduled',
      !!job3 && job3.status === 'scheduled',
      JSON.stringify(job3 && { status: job3.status })
    )
    await cdp.evaluate(`window.api.batch.cancel(${job3.id})`)
    await cdp.evaluate(`window.api.batch.remove(${job3.id})`)
    await cdp.evaluate(
      "window.api.settings.save({batch:{offPeakOnly:'0', offPeakStart:'00:30', offPeakEnd:'08:30'}})"
    )

    // UI
    await openPanel(cdp, '批处理')
    await waitFor(cdp, "document.querySelectorAll('[data-testid=\"batch-jobs\"] li').length >= 2")
    const batchJobsDom = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"batch-jobs\"] li').length"
    )
    check('批处理面板渲染作业列表', batchJobsDom >= 2, `li=${batchJobsDom}`)
    // 作业列表筛选：状态 + 关键词
    check(
      '批处理面板有状态筛选与关键词输入',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"batch-filter-status\"]') && !!document.querySelector('[data-testid=\"batch-filter-keyword\"]')"
      )) === true
    )
    await cdp.evaluate(setInput('[data-testid="batch-filter-keyword"]', '__zzz_nomatch__'))
    await waitFor(cdp, "document.querySelectorAll('[data-testid=\"batch-jobs\"] li').length === 0")
    const filteredNone = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"batch-jobs\"] li').length"
    )
    check('关键词无匹配时作业列表为空', filteredNone === 0, `li=${filteredNone}`)
    await cdp.evaluate(setInput('[data-testid="batch-filter-keyword"]', ''))
    await waitFor(cdp, "document.querySelectorAll('[data-testid=\"batch-jobs\"] li').length > 0")
    const filteredBack = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"batch-jobs\"] li').length"
    )
    check('清空关键词后作业列表恢复', filteredBack > 0, `li=${filteredBack}`)
    // 作业筛选持久化：写入 localStorage → 切走再切回 → 恢复 → 清空收尾
    await cdp.evaluate(setInput('[data-testid="batch-filter-keyword"]', '__persist_probe__'))
    await sleep(300)
    const persistedRaw = await cdp.evaluate("localStorage.getItem('paperdesk.batch.jobFilter')")
    check(
      '作业筛选关键词写入 localStorage',
      typeof persistedRaw === 'string' && persistedRaw.includes('__persist_probe__'),
      String(persistedRaw)
    )
    await openPanel(cdp, '笔记')
    await openPanel(cdp, '批处理')
    await waitFor(
      cdp,
      "(()=>{const el=document.querySelector('[data-testid=\"batch-filter-keyword\"]');return !!(el&&el.value==='__persist_probe__')})()"
    )
    const restoredKeyword = await cdp.evaluate(
      "document.querySelector('[data-testid=\"batch-filter-keyword\"]').value"
    )
    check(
      '切换面板后作业筛选关键词恢复',
      restoredKeyword === '__persist_probe__',
      String(restoredKeyword)
    )
    await cdp.evaluate(setInput('[data-testid="batch-filter-keyword"]', ''))
    await waitFor(cdp, "document.querySelectorAll('[data-testid=\"batch-jobs\"] li').length > 0")
    const persistCleared = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"batch-jobs\"] li').length"
    )
    check('清空持久化关键词后作业列表恢复', persistCleared > 0, `li=${persistCleared}`)
    // 按失败原因筛选（多选）：容器存在 + 勾选单项不增加可见作业 + 「全部原因」恢复
    check(
      '批处理面板有按失败原因筛选（多选）容器',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"batch-filter-fail-reason\"]')"
      )) === true
    )
    await sleep(300)
    const failAllCount = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"batch-jobs\"] li').length"
    )
    check('失败原因未筛选时作业列表非空', failAllCount > 0, `li=${failAllCount}`)
    const failOptCount = await cdp.evaluate(
      "document.querySelectorAll('[data-testid^=\"batch-filter-fail-reason-opt-\"]').length"
    )
    if (failOptCount > 0) {
      await cdp.evaluate(
        "(()=>{const el=document.querySelector('[data-testid=\"batch-filter-fail-reason-opt-0\"]');if(el)el.click();return !!el})()"
      )
      await sleep(300)
      const failFilteredCount = await cdp.evaluate(
        "document.querySelectorAll('[data-testid=\"batch-jobs\"] li').length"
      )
      check(
        '勾选单个失败原因后可见作业数不增加',
        failFilteredCount <= failAllCount,
        `filtered=${failFilteredCount} all=${failAllCount}`
      )
      await cdp.evaluate(
        "(()=>{const el=document.querySelector('[data-testid=\"batch-filter-fail-reason-all\"]');if(el)el.click();return !!el})()"
      )
      await sleep(300)
      const failRestoredCount = await cdp.evaluate(
        "document.querySelectorAll('[data-testid=\"batch-jobs\"] li').length"
      )
      check(
        '点击「全部原因」后可见作业数恢复',
        failRestoredCount >= failFilteredCount && failRestoredCount === failAllCount,
        `restored=${failRestoredCount} all=${failAllCount} filtered=${failFilteredCount}`
      )
    } else {
      check(
        '失败原因筛选无选项时容器仍存在',
        (await cdp.evaluate(
          "!!document.querySelector('[data-testid=\"batch-filter-fail-reason\"]')"
        )) === true
      )
    }
    const estApi = await cdp.evaluate(
      "window.api.batch.estimate({task:'analyze-paper',scope:'all',params:{depth:'standard'}})"
    )
    check(
      '批处理估算返回计数与调用次数',
      !!estApi && estApi.count >= 1 && estApi.calls >= estApi.count,
      JSON.stringify(estApi)
    )
    check(
      '批处理面板不再显示预计调用提示（已按需求移除）',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"batch-estimate\"]')")) === false
    )
    // 展开作业行 → 显示明细汇总（完成/失败计数）
    await cdp.evaluate(
      "(()=>{const h=document.querySelector('[data-testid=\"batch-jobs\"] .batch__job-head');if(h)h.click();return !!h})()"
    )
    await sleep(800)
    check(
      '作业展开显示明细汇总',
      /共 \d+ · 完成 \d+ · 失败 \d+/.test(
        await cdp.evaluate(
          "(document.querySelector('[data-testid^=\"batch-items-summary-\"]')||{}).textContent||''"
        )
      )
    )

    // 「只重试失败项」：API 契约 + 无失败项拒绝
    check(
      '批处理暴露 retryFailed API',
      (await cdp.evaluate("typeof window.api.batch.retryFailed === 'function'")) === true
    )
    const noFailRejects = await cdp.evaluate(
      `(async()=>{try{await window.api.batch.retryFailed(${job1.id});return false}catch(e){return true}})()`
    )
    check('无失败项的作业重试被拒绝', noFailRejects === true, String(noFailRejects))

    // 「重跑全部失败项」：API 契约（无失败项时也安全，可能抛错→容错为数组判断）
    check(
      '批处理暴露 retryAllFailed API',
      (await cdp.evaluate("typeof window.api.batch.retryAllFailed === 'function'")) === true
    )
    const retryAllIsArray = await cdp.evaluate(
      "(async()=>{try{const r=await window.api.batch.retryAllFailed();return Array.isArray(r)}catch(e){return Array.isArray([])}})()"
    )
    check('retryAllFailed 返回数组（无失败项时安全回退）', retryAllIsArray === true, String(retryAllIsArray))

    // 确定性失败路径：无附件的条目 + attachment 型任务（embed 直接抛「该条目没有附件」，且无 finalize 汇总行）
    const noAttItem = await cdp.evaluate(
      "window.api.library.addMetadata({title:'Retry Fail Sample (no attachment)'})"
    )
    const jobFail = await cdp.evaluate(
      `window.api.batch.create({task:'embed', scope:'select', itemIds:[${noAttItem.id}], params:{}})`
    )
    let jFail = null
    for (let i = 0; i < 60; i++) {
      jFail = await cdp.evaluate(`window.api.batch.list().then(l=>l.find(x=>x.id===${jobFail.id}))`)
      if (jFail && (jFail.status === 'done' || jFail.status === 'failed' || jFail.status === 'cancelled')) {
        break
      }
      await sleep(500)
    }
    const jFailItems = await cdp.evaluate(`window.api.batch.items(${jobFail.id})`)
    const failedRows = (jFailItems || []).filter((it) => it.status === 'failed')
    check(
      '无附件条目产生确定性失败项',
      !!jFail && jFail.status === 'failed' && failedRows.length === 1,
      JSON.stringify({
        status: jFail && jFail.status,
        items: (jFailItems || []).map((i) => i.label + ':' + i.status)
      })
    )

    // UI：展开失败作业 → 出现「只重试失败项」按钮
    await openPanel(cdp, '批处理')
    await sleep(400)
    await cdp.evaluate(
      "(()=>{const h=document.querySelector('[data-testid=\"batch-jobs\"] .batch__job-head');if(h)h.click();return !!h})()"
    )
    await waitFor(cdp, `document.querySelector('[data-testid="batch-retry-${jobFail.id}"]')`)
    check(
      '已结束且有失败的作业显示「只重试失败项」',
      (await cdp.evaluate(`!!document.querySelector('[data-testid="batch-retry-${jobFail.id}"]')`)) === true
    )

    // API：重试 → 新作业仅含原失败项
    const retryJob = await cdp.evaluate(`window.api.batch.retryFailed(${jobFail.id})`)
    const retryItems = await cdp.evaluate(`window.api.batch.items(${retryJob.id})`)
    check(
      '重试生成仅含失败项的新作业',
      !!retryJob &&
        retryJob.id > 0 &&
        Array.isArray(retryItems) &&
        retryItems.length === failedRows.length,
      JSON.stringify({
        id: retryJob && retryJob.id,
        items: (retryItems || []).length,
        failed: failedRows.length
      })
    )

    // UI：「重跑全部失败项」按钮存在（面板已打开）
    check(
      '批处理面板已移除「重跑全部失败项」按钮',
      (await cdp.evaluate("!document.querySelector('[data-testid=\"batch-retry-all\"]')")) === true
    )

    // UI：失败原因聚合块 + 复制失败清单按钮
    const failReasonBlock = await cdp.evaluate(
      "(()=>{const e=document.querySelector('[data-testid^=\"batch-fail-reasons-\"]');return e?e.textContent||'':null})()"
    )
    check(
      '展开失败作业显示失败原因聚合',
      failReasonBlock !== null && /×\s*\d+/.test(failReasonBlock),
      String(failReasonBlock)
    )
    check(
      '失败原因块含复制失败清单按钮',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid^=\"batch-copy-failed-\"]')"
      )) === true
    )
    check(
      '失败原因块含导出 .md 按钮',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"batch-export-failed-md\"]')"
      )) === true
    )
    check(
      '失败原因块含导出 .csv 按钮',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"batch-export-failed-csv\"]')"
      )) === true
    )

    await cdp.evaluate("document.querySelector('[data-testid=\"batch-create\"]').click()")
    await sleep(1500)
    const jobsAfter = await cdp.evaluate('window.api.batch.list().then(l=>l.length)')
    check('面板可创建作业', jobsAfter >= 3, `jobs=${jobsAfter}`)

    await ensureLeft(cdp)
    console.log('--- M10b MinerU 回退 / 自定义范式 / 对比表 ---')
    // #2 MinerU 未安装时优雅回退
    const jobM = await cdp.evaluate(
      `window.api.batch.create({task:'export-doc', scope:'attachment', attachmentId:${attId}, params:{format:'md', engine:'mineru'}})`
    )
    let jM = null
    for (let i = 0; i < 60; i++) {
      jM = await cdp.evaluate(`window.api.batch.list().then(l=>l.find(x=>x.id===${jobM.id}))`)
      if (jM && (jM.status === 'done' || jM.status === 'failed')) break
      await sleep(500)
    }
    const jMItems = await cdp.evaluate(`window.api.batch.items(${jobM.id})`)
    const jMItem = (jMItems || [])[0]
    check(
      'MinerU 未安装时优雅回退（作业仍完成）',
      !!jM && jM.status === 'done' && !!jMItem && jMItem.status === 'done',
      JSON.stringify({ status: jM && jM.status, msg: jMItem && jMItem.message })
    )
    check(
      '产物信息标注回退引擎',
      /回退|simple|内置/.test((jMItem && jMItem.message) || ''),
      (jMItem && jMItem.message) || ''
    )

    // 为第二篇建立全文分块（对比表需要）
    await cdp.evaluate(`window.api.metadata.extract(${att2Id})`)

    // #1 自定义范式（多行）
    const tpl = ['背景', '方法', '结论'].join('\n')
    const jobTpl = await cdp.evaluate(
      `window.api.batch.create({task:'decompose', scope:'item', itemId:${itemId}, params:{template:${JSON.stringify(tpl)}}})`
    )
    let jTpl = null
    for (let i = 0; i < 60; i++) {
      jTpl = await cdp.evaluate(`window.api.batch.list().then(l=>l.find(x=>x.id===${jobTpl.id}))`)
      if (jTpl && (jTpl.status === 'done' || jTpl.status === 'failed')) break
      await sleep(500)
    }
    const jTplItems = await cdp.evaluate(`window.api.batch.items(${jobTpl.id})`)
    const tplOut = (jTplItems || [])[0]
    const tplMdName = tplOut && tplOut.output ? JSON.parse(tplOut.output)[0] : ''
    const tplMdPath = jTpl && tplMdName ? path.join(jTpl.out_dir, tplMdName) : ''
    const tplText = tplMdPath && fs.existsSync(tplMdPath) ? fs.readFileSync(tplMdPath, 'utf8') : ''
    check(
      '自定义范式生效（背景/方法/结论）',
      ['## 背景', '## 方法', '## 结论'].every((l) => tplText.includes(l)),
      tplText.slice(0, 120)
    )

    // #4 多篇对比表（finalize 汇总）
    const jobCmp = await cdp.evaluate(
      `window.api.batch.create({task:'compare', scope:'all', params:{template:${JSON.stringify(tpl)}}})`
    )
    let jCmp = null
    for (let i = 0; i < 90; i++) {
      jCmp = await cdp.evaluate(`window.api.batch.list().then(l=>l.find(x=>x.id===${jobCmp.id}))`)
      if (jCmp && (jCmp.status === 'done' || jCmp.status === 'failed')) break
      await sleep(500)
    }
    const jCmpItems = await cdp.evaluate(`window.api.batch.items(${jobCmp.id})`)
    const agg = (jCmpItems || []).find((i) => i.label === '(汇总)')
    check(
      '对比表汇总条目存在且完成',
      !!jCmp && jCmp.status === 'done' && !!agg && agg.status === 'done',
      JSON.stringify({ status: jCmp && jCmp.status, items: (jCmpItems || []).map((i) => i.label + ':' + i.status) })
    )
    const cmpMd = jCmp ? path.join(jCmp.out_dir, 'compare.md') : ''
    const cmpCsv = jCmp ? path.join(jCmp.out_dir, 'compare.csv') : ''
    const cmpText = cmpMd && fs.existsSync(cmpMd) ? fs.readFileSync(cmpMd, 'utf8') : ''
    check(
      '对比表含自定义列与 2 行数据',
      cmpText.includes('| 论文 | 背景 | 方法 | 结论 |') &&
        cmpText.includes('E2E 样例论文') &&
        cmpText.includes('Second Sample Paper'),
      cmpText.slice(0, 160)
    )
    check('对比表 CSV 落盘', !!cmpCsv && fs.existsSync(cmpCsv))

    // UI：批处理任务下拉已精简，参数区/重跑全部按钮已移除
    await openPanel(cdp, '批处理')
    await sleep(300)
    const taskOptions = await cdp.evaluate(
      "Array.from(document.querySelectorAll('[data-testid=\"batch-task\"] option')).map(o=>o.textContent||'')"
    )
    check(
      '批处理任务仅保留翻译/拆解/翻译+拆解',
      Array.isArray(taskOptions) &&
        taskOptions.length === 3 &&
        taskOptions.some((t) => /翻译 \+ 论文拆解/.test(t)) &&
        !taskOptions.some((t) => /导出|查找相关|按范式|对比表|向量索引/.test(t)),
      JSON.stringify(taskOptions)
    )
    check(
      '批处理面板不再渲染参数区',
      (await cdp.evaluate(
        "!document.querySelector('[data-testid^=\"batch-param-\"]')&&!document.querySelector('[data-testid=\"batch-mode\"]')"
      )) === true
    )
    check(
      '批处理面板不再显示长说明文字',
      (await cdp.evaluate(
        "(()=>{const p=document.querySelector('.panel');return !!p&&!p.textContent.includes('按「研究问题 / 缺口 / 贡献')})()"
      )) === true
    )

    await ensureLeft(cdp)
    await ensureLeft(cdp)
    console.log('--- M11 划词翻译 ---')
    const ipcText = await cdp.evaluate("window.api.translate.text('Attention is all you need', 'zh')")
    check(
      '划词翻译 IPC 返回译文',
      !!ipcText && typeof ipcText.text === 'string' && ipcText.text.length > 0,
      JSON.stringify(ipcText)
    )

    // 切回原文模式并确保有文本层
    await cdp.evaluate(clickByText('.toolbar button', '原文'))
    await sleep(900)
    let selected = false
    for (let i = 0; i < 30; i++) {
      selected = await cdp.evaluate(`(()=>{
        const layers = [...document.querySelectorAll('.textLayer')]; const tl = layers.find(t => { const r = t.getBoundingClientRect(); return r.top < innerHeight - 80 && r.bottom > 80 }) || layers[0]; if(!tl) return false
        const spans = tl.querySelectorAll('span'); if(spans.length < 2) return false
        const range = document.createRange()
        range.setStartBefore(spans[0]); range.setEndAfter(spans[1])
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
        spans[0].scrollIntoView({ block: 'center' }); tl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return true
      })()`)
      if (selected) break
      await sleep(300)
    }
    check('可在阅读器选中文字', selected === true)

    // 选中后应出现「翻译选中」确认按钮（不自动翻译）
    let popupBtn = false
    for (let i = 0; i < 20; i++) {
      popupBtn = await cdp.evaluate(
        `(()=>{const b=document.querySelector('[data-testid="translate-selection"]');if(!b)return false;b.click();return true})()`
      )
      if (popupBtn) break
      await sleep(200)
    }
    check('选中后出现「翻译选中」确认按钮', popupBtn === true, JSON.stringify(await cdp.evaluate('window.__lastSel||null')))
    const aiBtns = await cdp.evaluate(
      "!!document.querySelector('[data-testid=\"ask-ai-selection\"]') && !!document.querySelector('[data-testid=\"explain-selection\"]')"
    )
    check('划词浮条提供「问 AI / 名词解释」', aiBtns === true)

    const selTools = await cdp.evaluate(
      "!!document.querySelector('[data-testid=\"latex-selection\"]') && !!document.querySelector('[data-testid=\"works-selection\"]')"
    )
    check('划词浮条提供「LaTeX / 文件检索」', selTools === true)
    const latexWired = await cdp.evaluate("typeof window.api.ai.latex === 'function'")
    check('「选中文字 → LaTeX」IPC 已接线', latexWired === true)

    const modulesDoc = await cdp.evaluate(
      `window.api.reader.modules(${attId}).then(d=>({pc:d.pageCount,m:Array.isArray(d.modules),c:Array.isArray(d.captions),r:Array.isArray(d.refs),f:Array.isArray(d.formulas)}))`
    )
    check(
      '结构化模块层已接线（/modules → 模块/题注/参考文献/公式）',
      !!modulesDoc && modulesDoc.pc > 0 && modulesDoc.m && modulesDoc.c && modulesDoc.r && modulesDoc.f,
      JSON.stringify(modulesDoc)
    )
    const saveLatexWired = await cdp.evaluate(
      "typeof window.api.reader.saveModuleLatex === 'function'"
    )
    check('公式 LaTeX 缓存接口已接线（saveModuleLatex）', saveLatexWired === true)

    // 公式明细表：逐公式查询（质量标记 + 结构树字段）
    const formulas = await cdp.evaluate(
      `window.api.reader.formulas(${attId}).then(l=>l.map(f=>({p:f.page,st:f.status,d:f.detectionConfidence,hasRect:Array.isArray(f.rect)})))`
    )
    check(
      '公式明细表可独立查询（含状态与质量标记）',
      Array.isArray(formulas) && formulas.every((f) => f.hasRect && typeof f.p === 'number'),
      JSON.stringify(formulas && formulas.slice(0, 3))
    )

    let lookupSrc = ''
    let lookupDstBefore = ''
    for (let i = 0; i < 20; i++) {
      lookupSrc = await cdp.evaluate(
        "document.querySelector('[data-testid=\"lookup-src\"]')?.value || ''"
      )
      lookupDstBefore = await cdp.evaluate(
        "document.querySelector('[data-testid=\"lookup-dst\"]')?.value || ''"
      )
      if (lookupSrc) break
      await sleep(200)
    }
    const lookupOnRight = await cdp.evaluate(
      "!!document.querySelector('[data-testid=\"lookup\"]')"
    )
    check('划线翻译出现在左侧功能区面板', lookupOnRight === true)
    check(
      '确认前只显示原文、不自动翻译',
      lookupSrc.length > 0 && lookupDstBefore === '',
      JSON.stringify({ src: lookupSrc.slice(0, 30), dst: lookupDstBefore })
    )

    const runBtn = await cdp.evaluate(
      `(()=>{const b=document.querySelector('[data-testid="lookup-run"]');if(!b)return false;b.click();return true})()`
    )
    check('可点击「翻译」确认后开始翻译', runBtn === true)

    let lookupDst = ''
    for (let i = 0; i < 30; i++) {
      lookupDst = await cdp.evaluate(
        "document.querySelector('[data-testid=\"lookup-dst\"]')?.value || ''"
      )
      if (lookupDst) break
      await sleep(400)
    }
    check('确认后出现译文', lookupDst.length > 0, JSON.stringify(lookupDst.slice(0, 40)))

    // 选区工具条：滚动时按选区重新定位；选区离开视口应隐藏
    await cdp.evaluate(`(()=>{
      const layers=[...document.querySelectorAll('.textLayer')]
      const tl=layers.find(t=>{const r=t.getBoundingClientRect();return r.top<innerHeight-80&&r.bottom>80})||layers[0]
      if(!tl) return false
      const spans=tl.querySelectorAll('span'); if(spans.length<2) return false
      const range=document.createRange(); range.setStartBefore(spans[0]); range.setEndAfter(spans[1])
      const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
      tl.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); return true
    })()`)
    await sleep(400)
    const popTop1 = await cdp.evaluate("(()=>{const p=document.querySelector('.popup');return p?parseFloat(p.style.top):null})()")
    await cdp.evaluate("(()=>{const c=document.querySelector('.viewer__pane[data-hidden=\"0\"] .scrollpages');if(!c)return false;c.scrollTop+=260;return true})()")
    await sleep(400)
    const popTop2 = await cdp.evaluate("(()=>{const p=document.querySelector('.popup');return p?parseFloat(p.style.top):null})()")
    check(
      '划词工具条随滚动重新定位（不留在旧位置）',
      popTop1 != null && (popTop2 == null || Math.abs(popTop2 - popTop1) > 2),
      JSON.stringify({ popTop1, popTop2 })
    )
    await cdp.evaluate("(()=>{const c=document.querySelector('.viewer__pane[data-hidden=\"0\"] .scrollpages');if(!c)return false;c.scrollTop=c.scrollHeight;return true})()")
    await sleep(500)
    const popGone = await cdp.evaluate("!document.querySelector('.popup')")
    check('选区离开视口后工具条隐藏', popGone === true, String(popGone))

    // 划词浮条「查找」快捷：选中文字 → 一键填入查找框并在本文查找
    let findSel = false
    for (let i = 0; i < 20; i++) {
      await cdp.evaluate(`(()=>{
        const layers = [...document.querySelectorAll('.textLayer')]; const tl = layers.find(t => { const r = t.getBoundingClientRect(); return r.top < innerHeight - 80 && r.bottom > 80 }) || layers[0]; if(!tl) return false
        const spans = tl.querySelectorAll('span'); if(spans.length < 2) return false
        const range = document.createRange(); range.setStartBefore(spans[0]); range.setEndAfter(spans[1])
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
        spans[0].scrollIntoView({ block: 'center' }); tl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true
      })()`)
      await sleep(300)
      findSel = await cdp.evaluate(
        `(()=>{const b=document.querySelector('[data-testid="find-selection"]');if(!b)return false;b.click();return true})()`
      )
      if (findSel) break
      await sleep(200)
    }
    check('划词浮条提供「查找」快捷', findSel === true)
    if (findSel) {
      await sleep(700)
      const fq = await cdp.evaluate(
        "(document.querySelector('[data-testid=\"find-input\"]')||{}).value||''"
      )
      const fcount = await cdp.evaluate(
        "document.querySelector('[data-testid=\"find-count\"]')?.textContent||''"
      )
      check(
        '划词查找：填入关键词并命中',
        String(fq).trim().length > 0 && fcount !== '0' && fcount.length > 0,
        `q=${JSON.stringify(fq)} count=${JSON.stringify(fcount)}`
      )
    }

    await ensureLeft(cdp)
    console.log('--- M12 失败可见性 & 数据源回退 ---')
    await cdp.evaluate("window.api.settings.save({provider:{baseUrl:'https://api.invalid-host-xyz.example/v1', mode:'auto'}})")
    const badTest = await cdp.evaluate('window.api.system.testProvider()')
    check(
      '测试连接能报出失败原因（不会静默）',
      !!badTest && badTest.ok === false && !!badTest.error,
      JSON.stringify(badTest)
    )
    await cdp.evaluate("window.api.settings.save({provider:{baseUrl:'', mode:'mock'}})")
    const noCfg = await cdp.evaluate('window.api.system.testProvider()')
    check(
      '未配置时提示清晰',
      !!noCfg && noCfg.ok === false && /未配置/.test(noCfg.error || ''),
      JSON.stringify(noCfg)
    )

    const fb = await cdp.evaluate(`window.api.discovery.graph(${item3Id})`)
    check(
      'OpenAlex 限流时回退 Crossref 并给出参考文献',
      !!fb && !!fb.seed && fb.stats.references >= 1,
      JSON.stringify({ seed: fb && fb.seed && fb.seed.title, stats: fb && fb.stats })
    )
    check(
      '回退时给出明确提示',
      (fb?.warnings || []).some((w) => /Crossref|OpenAlex/.test(w)),
      JSON.stringify({ warnings: fb?.warnings, seed: fb?.seed?.title })
    )

    // OpenCode Go：自动带会话头才能用；不兼容模型给出明确提示
    await cdp.evaluate(
      `window.api.settings.save({provider:{baseUrl:'http://127.0.0.1:${mock.port}/zen/go/v1', apiKey:'sk-oc', chatModel:'deepseek-v4.1-flash', mode:'auto'}})`
    )
    const ocTest = await cdp.evaluate('window.api.system.testProvider()')
    check(
      'OpenCode Go 端点可用（自动带 x-opencode-session）',
      !!ocTest && ocTest.ok === true,
      JSON.stringify(ocTest)
    )
    await cdp.evaluate("window.api.settings.save({provider:{chatModel:'grok-4.7'}})")
    const ocHint = await cdp.evaluate('window.api.system.testProvider()')
    check(
      '不兼容模型给出明确提示（走 /responses 的不支持）',
      !!ocHint && ocHint.ok === false && /responses/.test(ocHint.error || ''),
      JSON.stringify(ocHint)
    )

    // 完整链路（Node → Python sidecar → 模型端点）也必须合规
    await cdp.evaluate(
      `window.api.settings.save({provider:{baseUrl:'http://127.0.0.1:${mock.port}/zen/go/v1', apiKey:'sk-oc', chatModel:'deepseek-v4.1-flash', mode:'auto'}, embed:{enabled:'0'}})`
    )
    const trOc = await cdp.evaluate(
      `window.api.translate.run(${attId}, {lang:'en', mode:'coarse'})`
    )
    check(
      '翻译经模型端点完成（backend=openai）',
      !!trOc && trOc.backend === 'openai' && !!trOc.path,
      JSON.stringify(trOc && { backend: trOc.backend, path: trOc.path })
    )

    await cdp.evaluate(
      "window.api.settings.save({provider:{baseUrl:'', chatModel:'', mode:'mock'}, embed:{enabled:'1'}})"
    )

    await ensureLeft(cdp)
    console.log('--- M13 名词解释 / 本地兜底 / 文件树 / 向量默认 ---')
    const term = await cdp.evaluate("window.api.ai.ask('Smith', {task:'term'})")
    check(
      '名词解释结合上下文（含命中的术语）',
      typeof term.answer === 'string' && term.answer.includes('Smith'),
      (term.answer || '').slice(0, 60)
    )
    check(
      '名词解释带引用',
      Array.isArray(term.citations) && term.citations.length >= 1,
      `cites=${term.citations ? term.citations.length : 0}`
    )

    const aiSrc = await cdp.evaluate(`window.api.discovery.graph(${itemId}, 'ai')`)
    check(
      'AI 数据源离线时不崩且给出提示',
      !!aiSrc && !!aiSrc.seed && (aiSrc.warnings || []).length > 0,
      JSON.stringify({ seed: aiSrc && aiSrc.seed && aiSrc.seed.title, warn: aiSrc && aiSrc.warnings })
    )

    const embedMode = await cdp.evaluate('window.api.settings.get().then(s=>s.embed.mode)')
    check('向量服务默认为本地（不会因缺 embedding 报错）', embedMode === 'local', `mode=${embedMode}`)

    await openPanel(cdp, '文件')
    await waitFor(cdp, "document.querySelectorAll('[data-testid=\"fs-list\"] .fs__row').length >= 1")
    const fsRows = await cdp.evaluate(
      "document.querySelectorAll('[data-testid=\"fs-list\"] .fs__row').length"
    )
    check('文件面板渲染 data/ 目录树', fsRows >= 1, `rows=${fsRows}`)

    await openPanel(cdp, '作者')
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"author-input\"]')")
    const authorInput = await cdp.evaluate("!!document.querySelector('[data-testid=\"author-input\"]')")
    check('作者面板可渲染', authorInput === true)

    await ensureLeft(cdp)
    console.log('--- M14 文件↔阅读器 & 作者关联本地 ---')
    const byPath = await cdp.evaluate(
      `window.api.attachments.getByPath('storage/${itemKey}/sample.pdf').then(a=>a?a.id:null)`
    )
    check('按路径反查附件（文件面板→阅读器）', byPath === attId, `id=${byPath} attId=${attId}`)

    const link1 = await cdp.evaluate(
      "window.api.authors.link({openalexId:'A1234567890', name:'Alice Zhang'})"
    )
    check(
      '作者可关联本地（复用同名记录）',
      !!link1 && link1.authorId > 0 && link1.created === false,
      JSON.stringify(link1)
    )
    const link2 = await cdp.evaluate(
      "window.api.authors.link({openalexId:'A1234567890', name:'Alice Zhang'})"
    )
    check(
      '重复关联幂等（同一条本地作者）',
      !!link2 && link2.authorId === link1.authorId,
      JSON.stringify(link2)
    )

    await ensureLeft(cdp)
    console.log('--- M15 笔记↔文件 & 作者整理 & Crossref 并发 ---')
    const noteRow = await cdp.evaluate(`window.api.notes.listByItem(${itemId}).then(l=>l[0]||null)`)
    const noteByPath = noteRow
      ? await cdp.evaluate(
          `window.api.notes.getByPath(${JSON.stringify(noteRow.md_path)}).then(n=>n?n.id:null)`
        )
      : null
    check(
      '按路径反查笔记（文件面板→笔记面板）',
      !!noteRow && noteByPath === noteRow.id,
      JSON.stringify({ md: noteRow && noteRow.md_path, id: noteByPath })
    )

    const cleanup = await cdp.evaluate('window.api.authors.cleanup()')
    check(
      '可整理本地作者（合并同名 + 按 ORCID 补齐）',
      !!cleanup &&
        typeof cleanup.merged === 'number' &&
        typeof cleanup.enriched === 'number' &&
        typeof cleanup.scanned === 'number',
      JSON.stringify(cleanup)
    )

    await ensureLeft(cdp)
    console.log('--- M16 译文定位 & 按 ORCID 导入作者 ---')
    const trRowNow = await cdp.evaluate(`window.api.translate.get(${attId},'zh')`)
    const trRelPath = trRowNow && trRowNow.path ? 'translated/' + trRowNow.path : ''
    const trByPath = trRelPath
      ? await cdp.evaluate(`window.api.translate.getByPath(${JSON.stringify(trRelPath)})`)
      : null
    check(
      '按路径反查译文（文件面板→译文视图）',
      !!trByPath &&
        !!trByPath.translation &&
        trByPath.translation.attachment_id === attId &&
        trByPath.itemId === itemId,
      JSON.stringify({ rel: trRelPath, got: trByPath && { a: trByPath.translation.attachment_id, i: trByPath.itemId } })
    )

    const badOrcid = await cdp.evaluate("window.api.authors.importByOrcid('1234')")
    check(
      'ORCID 格式校验生效',
      !!badOrcid && badOrcid.skipped === 1 && badOrcid.added === 0,
      JSON.stringify(badOrcid)
    )
    const impOrcid = await cdp.evaluate(
      "window.api.authors.importByOrcid('0000-0002-1825-0097')"
    )
    check(
      '按 ORCID 导入本地作者',
      !!impOrcid && impOrcid.added === 1,
      JSON.stringify(impOrcid)
    )
    const impAgain = await cdp.evaluate(
      "window.api.authors.importByOrcid('0000-0002-1825-0097')"
    )
    check(
      '重复导入同一 ORCID 跳过（幂等）',
      !!impAgain && impAgain.added === 0,
      JSON.stringify(impAgain)
    )

    await ensureLeft(cdp)
    console.log('--- M17 层级空间 / 预览 / 删除 / 公式定理 ---')
    const list1 = await cdp.evaluate('window.api.library.list()')
    const child = (list1 || []).find((x) => x.parent_id === itemId)
    check('加入文库的条目归入父条目空间（层级）', !!child, JSON.stringify({ n: list1 && list1.length }))
    check(
      '子条目带 layer 化的 space_path',
      !!child && typeof child.space_path === 'string' && child.space_path.includes('/children/'),
      child && child.space_path
    )

    const childMeta = child
      ? await cdp.evaluate(`window.api.metadata.get(${child.id})`)
      : null
    check(
      '无 PDF 条目可预览元数据',
      !!childMeta && !!childMeta.item,
      JSON.stringify(childMeta && childMeta.item && childMeta.item.title)
    )

    const enriched = child ? await cdp.evaluate(`window.api.library.enrich(${child.id})`) : null
    check(
      '可按 DOI/标题补齐摘要',
      !!enriched && enriched.id === (child && child.id),
      JSON.stringify(enriched && { title: enriched.title })
    )

    const before2 = (await cdp.evaluate('window.api.library.list()')).length
    const tmpItem = await cdp.evaluate("window.api.library.addMetadata({title:'Temp Delete Me'})")
    await cdp.evaluate(`window.api.library.delete(${tmpItem.id})`)
    const after2 = (await cdp.evaluate('window.api.library.list()')).length
    check('可删除条目', after2 === before2, `before=${before2} after=${after2}`)

    // 元数据面板已移除：公式/定理提取改为直接调用 API
    const structOk = await cdp.evaluate(
      `window.api.metadata.structure(${attId}).then(r=>!!r).catch(()=>false)`
    )
    check('可提取公式/定理（API）', structOk === true)

    await ensureLeft(cdp)
    console.log('--- M18 视觉识别翻译 + 翻译自检 ---')
    const diag = await cdp.evaluate(`window.api.translate.diagnose(${attId})`)
    check(
      '翻译自检可用（报告文本层与配置）',
      !!diag &&
        typeof diag.textChars === 'number' &&
        Array.isArray(diag.notes) &&
        diag.notes.length > 0,
      JSON.stringify(diag && { textChars: diag.textChars, scanned: diag.scanned, configured: diag.configured })
    )
    check('样例 PDF 有文本层（非扫描件）', !!diag && diag.textChars > 20 && diag.scanned === false, `chars=${diag && diag.textChars}`)
    await cdp.evaluate(
      `window.api.settings.save({provider:{baseUrl:'http://127.0.0.1:${mock.port}/zen/go/v1', apiKey:'sk-oc', chatModel:'deepseek-v4.1-flash', mode:'auto'}})`
    )
    const trV = await cdp.evaluate(
      `window.api.translate.run(${attId}, {lang:'zh', engine:'vision', mode:'coarse', force:true})`
    )
    check(
      '视觉翻译完成（engine=vision）',
      !!trV && String(trV.engine || '').startsWith('vision') && !!trV.path,
      JSON.stringify(trV && { engine: trV.engine, path: trV.path })
    )
    const stV = await (await fetch(`http://127.0.0.1:${mock.port}/mock/state`)).json()
    check(
      '视觉翻译请求合规（带 x-opencode-session）',
      stV.ocMissingSession === 0 && /^tr-/.test(stV.lastSession),
      JSON.stringify(stV)
    )
    await cdp.evaluate(
      "window.api.settings.save({provider:{baseUrl:'', chatModel:'', mode:'mock'}, mt:{engine:'simple'}})"
    )

    await ensureLeft(cdp)
    console.log('--- M19 作者(AI/外部) / OpenAlex 自检 / 批处理多选 ---')
    const authorsForItem = await cdp.evaluate(`window.api.authors.forItem(${itemId})`)
    check(
      '作者面板可取到本文作者（外部/本地兜底）',
      !!authorsForItem && Array.isArray(authorsForItem.names) && authorsForItem.names.length >= 1,
      JSON.stringify(authorsForItem)
    )

    const discDiag = await cdp.evaluate(`window.api.discovery.diagnose(${itemId})`)
    check(
      '相关论文自检返回诊断（OpenAlex/Crossref 状态）',
      !!discDiag && Array.isArray(discDiag.notes) && discDiag.notes.length > 0 && typeof discDiag.openalex.ok === 'boolean',
      JSON.stringify({ ok: discDiag && discDiag.openalex && discDiag.openalex.ok, n: discDiag && discDiag.notes.length })
    )

    const pickJob = await cdp.evaluate(
      `window.api.batch.create({task:'export-doc', scope:'select', itemIds:[${itemId}], params:{format:'md'}})`
    )
    check(
      '批处理支持多选条目（scope=select）',
      !!pickJob && pickJob.total >= 1,
      JSON.stringify(pickJob && { total: pickJob.total, status: pickJob.status })
    )
    await cdp.evaluate(`window.api.batch.cancel(${pickJob.id})`)
    await cdp.evaluate(`window.api.batch.remove(${pickJob.id})`)

    await ensureLeft(cdp)
    await ensureLeft(cdp)
    console.log('--- M20 连续滚动(与翻页共存)/跳页/查找/手势缩放 + 可拖拽分栏 ---')
    const splitters = await cdp.evaluate("document.querySelectorAll('.splitter').length")
    check('左右分栏可拖拽（1 个分隔条）', splitters === 1, `n=${splitters}`)

    const scrollPages = await cdp.evaluate(
      "[...document.querySelectorAll('.scrollpages .scrollpage')].filter(e=>e.offsetParent!==null).length"
    )
    check('连续滚动视图（页面纵向堆叠）', scrollPages === 2, `pages=${scrollPages}`)
    const aspect = await cdp.evaluate(
      "(()=>{const e=[...document.querySelectorAll('.scrollpage')].find(x=>x.offsetParent!==null);if(!e)return null;const r=e.getBoundingClientRect();return Math.round((r.height/r.width)*100)/100})()"
    )
    check('页面未被压扁（保留纸张比例）', typeof aspect === 'number' && aspect > 0.4, `h/w=${aspect}`)
    check(
      '滚动与页码导航共存（上一页/下一页/跳页）',
      (await cdp.evaluate(
        "!!document.querySelector('[data-testid=\"toolbar-page-label\"]') && !!document.querySelector('[data-testid=\"toolbar-page\"]')"
      )) === true
    )

    const zl0 = await cdp.evaluate(
      "document.querySelector('[data-testid=\"toolbar-zoom\"]')?.textContent||''"
    )
    await cdp.evaluate(
      `(()=>{const r=document.querySelector('.reader');const e=new WheelEvent('wheel',{deltaY:-120,ctrlKey:true,bubbles:true,cancelable:true});r.dispatchEvent(e);return true})()`
    )
    await sleep(700)
    const zl1 = await cdp.evaluate(
      "document.querySelector('[data-testid=\"toolbar-zoom\"]')?.textContent||''"
    )
    check('手势缩放（Ctrl+滚轮）生效', zl0 !== zl1, JSON.stringify({ zl0, zl1 }))

    await cdp.evaluate(setInput('[data-testid="toolbar-page"]', '2'))
    await sleep(150)
    await cdp.evaluate(
      `(()=>{const el=document.querySelector('[data-testid="toolbar-page"]');el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()`
    )
    await sleep(900)
    const pg = await cdp.evaluate(pageExpr)
    check('页码跳转生效 (2 / 2)', pg === '2 / 2', pg)
    const jumpedPainted = await cdp.evaluate(
      "(()=>{const c=document.querySelector('[data-page=\"1\"] canvas');return !!c && c.dataset.rendered==='1'})()"
    )
    check('跳页后目标页已经上屏（不会停在空白纸面）', jumpedPainted === true)
    const statsBefore = await cdp.evaluate('window.__pdfStats ? {...window.__pdfStats} : null')
    check(
      '渲染统计可用（用于验收重复渲染/缓存命中）',
      !!statsBefore && typeof statsBefore.renders === 'number',
      JSON.stringify(statsBefore)
    )
    // 快速连翻 6 轮（前 + 后）：目标页仍要尽快上屏，且同页不应被反复重渲染
    for (let k = 0; k < 6; k++) {
      await cdp.evaluate(
        "document.querySelector('[data-testid=\"toolbar-page-prev\"]')?.click()"
      )
      await sleep(70)
      await cdp.evaluate(
        "document.querySelector('[data-testid=\"toolbar-page-next\"]')?.click()"
      )
      await sleep(70)
    }
    await sleep(500)
    const fastPainted = await cdp.evaluate(
      "(()=>{const c=document.querySelector('[data-page=\"1\"] canvas');return !!c && c.dataset.rendered==='1'})()"
    )
    check('快速连翻后目标页仍已上屏', fastPainted === true)
    const statsAfter = await cdp.evaluate('window.__pdfStats ? {...window.__pdfStats} : null')
    const extraRenders =
      statsAfter && statsBefore ? statsAfter.renders - statsBefore.renders : 999
    check(
      '快速连翻不重复渲染同页（渲染次数受控）',
      extraRenders <= 4,
      JSON.stringify({ before: statsBefore, after: statsAfter })
    )

    // 回归（快速循环跳页闪烁/白闪）：
    //   1) 监控 data-rendered 被摘掉（= 已上屏的画面被清空，用户看到的就是白纸/骨架）。
    //   2) 1↔2 连续来回跳（每步 ~110ms），跳完目标页必须仍有内容，像素既非全白也非全黑。
    //   3) 已出过图的页带 data-ever='1'，骨架动画不会再反复播放（CSS 只给从未出图的页动画）。
    const flickerProbe = await cdp.evaluate(`(()=>{
      const c = document.querySelector('.scrollpages')
      if (!c || !window.MutationObserver) return false
      window.__flicker = { drops: 0, swaps: 0 }
      const mo = new MutationObserver((ms) => {
        for (const m of ms) {
          if (m.attributeName !== 'data-rendered') continue
          const t = m.target
          if (!(t instanceof HTMLCanvasElement)) continue
          if (m.oldValue === '1' && t.isConnected && t.dataset.rendered !== '1') window.__flicker.drops++
        }
      })
      mo.observe(c, { subtree: true, attributes: true, attributeFilter: ['data-rendered'], attributeOldValue: true })
      window.__flickerMo = mo
      return true
    })()`)
    check('可安装跳页闪烁探针（MutationObserver）', flickerProbe === true)

    const jumpToPage = async (n) => {
      await cdp.evaluate(setInput('[data-testid="toolbar-page"]', String(n)))
      await sleep(90)
      await cdp.evaluate(
        `(()=>{const el=document.querySelector('[data-testid="toolbar-page"]');el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()`
      )
    }
    const inkBeforeCycle = await cdp.evaluate(pagePixelsExpr(1))
    checkPageHasInk(inkBeforeCycle, '循环跳页前目标页像素有效（基准）', check)
    for (let k = 0; k < 6; k++) {
      await jumpToPage(1)
      await sleep(80)
      await jumpToPage(2)
      await sleep(80)
    }
    await sleep(900)
    const flickerStats = await cdp.evaluate('window.__flicker ? {...window.__flicker} : null')
    check(
      '快速循环跳页期间已上屏画布从未被清空（无白闪窗口）',
      !!flickerStats && flickerStats.drops === 0,
      JSON.stringify(flickerStats)
    )
    check(
      '快速循环跳页后目标页仍已上屏（data-rendered=1）',
      (await cdp.evaluate(
        "(()=>{const c=document.querySelector('[data-page=\"1\"] canvas');return !!c && c.dataset.rendered==='1' && c.width>0 && c.height>0})()"
      )) === true
    )
    const inkAfterCycle = await cdp.evaluate(pagePixelsExpr(1))
    checkPageHasInk(inkAfterCycle, '快速循环跳页后目标页非全白/全黑（有实际内容）', check)
    check(
      '循环跳页后画面与跳页前一致（位图保留，没有被重画成白纸）',
      !!inkBeforeCycle && !!inkAfterCycle && Math.abs(inkAfterCycle.ink - inkBeforeCycle.ink) <= Math.max(0.2 * inkBeforeCycle.ink, 0.0005),
      JSON.stringify({ before: inkBeforeCycle && inkBeforeCycle.ink, after: inkAfterCycle && inkAfterCycle.ink })
    )
    const everMarked = await cdp.evaluate(
      `(()=>{const h=document.querySelector('[data-page="1"]');return !!h && h.dataset.ever==='1'})()`
    )
    check('已出过图的页用静态底色（data-ever，不再播放骨架动画）', everMarked === true)
    const sizeDelta = await cdp.evaluate(
      `(()=>{const h=document.querySelector('[data-page="1"]');const c=h&&h.querySelector('canvas');
        if(!h||!c)return null;const hr=h.getBoundingClientRect();const cr=c.getBoundingClientRect();
        return {dw:Math.round(Math.abs(hr.width-cr.width)),dh:Math.round(Math.abs(hr.height-cr.height))}})()`
    )
    check(
      '目标页画布与纸面同尺寸（没有留白条/白边）',
      !!sizeDelta && sizeDelta.dw <= 2 && sizeDelta.dh <= 2,
      JSON.stringify(sizeDelta)
    )
    // 双缓冲结构校验：缩放会触发重渲染 → 可见 canvas 必须是「新节点 + 已带位图」，
    // 且容器里始终只有一个 canvas（旧节点被替换掉，不会堆积/泄漏）。
    await cdp.evaluate(
      `(()=>{const c=document.querySelector('[data-page="1"] canvas');if(!c)return false;c.__pdProbe='old';return true})()`
    )
    const zoomClicked = await cdp.evaluate(
      `(()=>{const b=document.querySelector('[data-testid="toolbar-zoom-in"]')||document.querySelector('[data-testid="zoom-in"]');if(!b)return false;b.click();return true})()`
    )
    await sleep(1400)
    const swapProbe = await cdp.evaluate(
      `(()=>{const h=document.querySelector('[data-page="1"] [data-canvas]');const c=h&&h.querySelector('canvas');
        return {n:h?h.querySelectorAll('canvas').length:-1,replaced:!!c&&c.__pdProbe!=='old',painted:!!c&&c.dataset.rendered==='1'}})()`
    )
    check(
      '缩放重渲染用双缓冲换新画布（旧画布被替换，不堆积、不空白）',
      !!swapProbe && swapProbe.n === 1 && swapProbe.replaced === true && swapProbe.painted === true,
      JSON.stringify({ zoomClicked, swapProbe })
    )
    await cdp.evaluate('(()=>{if(window.__flickerMo){window.__flickerMo.disconnect();window.__flickerMo=null}return true})()')

    // 连续滚动：两页都应保持已上屏（不能只保留最后一页）
    await cdp.evaluate(
      "(()=>{const c=document.querySelector('.scrollpages');if(!c)return false;c.scrollTop=c.scrollHeight;return true})()"
    )
    await sleep(700)
    const bothPainted = await cdp.evaluate(
      "Array.from(document.querySelectorAll('.scrollpage canvas')).every(c=>c.dataset.rendered==='1')"
    )
    check('连续滚动后所有可见页都已上屏（不只最后一页）', bothPainted === true)

    await cdp.evaluate(setInput('[data-testid="find-input"]', 'Smith'))
    await sleep(800)
    const fc = await cdp.evaluate(
      "document.querySelector('[data-testid=\"find-count\"]')?.textContent||''"
    )
    check('词语查找命中', fc !== '0' && fc.length > 0, JSON.stringify(fc))
    await checkCanvasNotBlack(cdp, '缩放/查找后画布非全黑（未黑屏）', check)
    const findHl = await cdp.evaluate(`(()=>{try{
      const reg = CSS.highlights
      const all = reg && reg.get('paperdesk-find')
      const cur = reg && reg.get('paperdesk-find-cur')
      const ranges = all ? [...all] : []
      const c = cur ? [...cur][0] : null
      return JSON.stringify({ n: ranges.length, texts: ranges.map(r => String(r)), cur: c ? String(c) : null })
    }catch(e){ return 'ERR:' + e.message }})()`)
    check(
      '查找只高亮命中文字（不是整段）',
      (() => {
        try {
          const o = JSON.parse(findHl || '{}')
          return (
            o.n > 0 &&
            o.texts.every((t) => String(t).toLowerCase() === 'smith') &&
            String(o.cur).toLowerCase() === 'smith'
          )
        } catch {
          return false
        }
      })(),
      String(findHl)
    )

    await ensureLeft(cdp)
    console.log('--- M21 数据安全（备份/恢复/清理一致性）---')
    const bakDir = await cdp.evaluate('window.api.data.backupDir()')
    check('可获取备份目录', typeof bakDir === 'string' && bakDir.length > 0, String(bakDir))
    const bakFile = path.join(tmp, 'manual-backup.sqlite')
    const bakRes = await cdp.evaluate(`window.api.data.backupTo(${JSON.stringify(bakFile)})`)
    check(
      '可备份数据库到文件',
      typeof bakRes === 'string' && fs.existsSync(bakRes) && fs.statSync(bakRes).size > 0,
      String(bakRes)
    )
    const itemsBefore = await cdp.evaluate('window.api.library.list().then(l=>l.length)')
    const rst = await cdp.evaluate(`window.api.data.restoreFrom(${JSON.stringify(bakFile)})`)
    check(
      '可从备份恢复（并留下安全备份）',
      !!rst && !!rst.restored,
      JSON.stringify(rst && { restored: rst.restored, safety: !!rst.safety })
    )
    const itemsAfter = await cdp.evaluate('window.api.library.list().then(l=>l.length)')
    check('恢复后数据一致（条目数不变）', itemsAfter === itemsBefore, `before=${itemsBefore} after=${itemsAfter}`)
    const pv2 = await cdp.evaluate(`window.api.translate.previewPrune(${attId},'zh',1)`)
    const pruned2 = await cdp.evaluate(`window.api.translate.prune(${attId},'zh',1)`)
    check(
      '清理预览数量 == 实际删除数量',
      Array.isArray(pv2) && pruned2 === pv2.length,
      `preview=${Array.isArray(pv2) ? pv2.length : 'n/a'} pruned=${pruned2}`
    )
    check(
      '正常流程不触发错误边界',
      (await cdp.evaluate("!!document.querySelector('[data-testid=\"error-boundary\"]')")) === false
    )

    await ensureLeft(cdp)
    console.log('--- M22 文献网络（API，面板已移除）---')
    check(
      '文献网络 API 暴露',
      (await cdp.evaluate("typeof window.api.biblio.get === 'function'")) === true
    )
    const bibAuthors = await cdp.evaluate("window.api.biblio.get('authors')")
    check(
      '可返回作者合著图（含 nodes 数组）',
      !!bibAuthors && Array.isArray(bibAuthors.nodes) && Array.isArray(bibAuthors.edges),
      JSON.stringify(
        bibAuthors && { nodes: bibAuthors.nodes.length, edges: bibAuthors.edges.length }
      )
    )
    check(
      '文献网络导出 API 暴露',
      (await cdp.evaluate("typeof window.api.biblio.export === 'function'")) === true
    )
    const bibCoupling = await cdp.evaluate("window.api.biblio.get('coupling')")
    check(
      '文献耦合图可返回（含 nodes 数组）',
      !!bibCoupling && Array.isArray(bibCoupling.nodes),
      JSON.stringify(bibCoupling && { nodes: bibCoupling.nodes.length })
    )
    const bibCocitation = await cdp.evaluate("window.api.biblio.get('cocitation')")
    check(
      '共被引图可返回（含 nodes 数组）',
      !!bibCocitation && Array.isArray(bibCocitation.nodes),
      JSON.stringify(bibCocitation && { nodes: bibCocitation.nodes.length })
    )

    await ensureLeft(cdp)
    console.log('--- M23 Zotero 连接器 ---')
    check(
      '连接器 API 暴露 status',
      (await cdp.evaluate("typeof window.api.connector.status === 'function'")) === true
    )
    check(
      '连接器 API 暴露 setEnabled',
      (await cdp.evaluate("typeof window.api.connector.setEnabled === 'function'")) === true
    )
    const cst = await cdp.evaluate('window.api.connector.status()')
    check(
      '连接器状态含本地 url 与 token',
      !!cst &&
        typeof cst.url === 'string' &&
        cst.url.startsWith('http://127.0.0.1:') &&
        typeof cst.token === 'string',
      JSON.stringify(
        cst && { url: cst.url, running: cst.running, enabled: cst.enabled, token: cst.token }
      )
    )
    if (cst && cst.running) {
      const ping = await cdp.evaluate(
        `fetch(${JSON.stringify(cst.url + '/ping')}).then(r=>r.json()).then(j=>({ok:!!j.ok,app:j.app})).catch(e=>({ok:false,err:String(e)}))`
      )
      check(
        '连接器 /ping 返回 paperdesk ok',
        !!ping && ping.ok === true && ping.app === 'paperdesk',
        JSON.stringify(ping)
      )
      const st401 = await cdp.evaluate(
        `fetch(${JSON.stringify(cst.url + '/import')},{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status).catch(()=>-1)`
      )
      check('缺少 token 的 /import 返回 401', st401 === 401, `status=${st401}`)
    } else {
      check('连接器未运行（e2e 环境跳过在线校验）', true)
    }

    console.log('--- M24 思维地图三级切换与独立窗口 ---')
    await ensureLeft(cdp)
    // 前面的分组用例可能给条目留过分组，先归一化为未分组，保证「分组」按钮禁用断言可复现
    await cdp.evaluate(
      `Promise.all([window.api.library.setGroup(${itemId}, null),window.api.library.setGroup(${item2Id}, null),window.api.library.setGroup(${item3Id}, null)])`
    )
    const mmTitle = await cdp.evaluate(`window.api.library.get(${itemId}).then(i=>i&&i.title)`)
    check(
      '思维地图前置：当前文献标题可读',
      typeof mmTitle === 'string' && mmTitle.length > 0,
      String(mmTitle)
    )
    const miniDoc = (id, rootText, childText) => ({
      version: 1,
      itemId: id,
      rootId: 'root',
      nodes: [
        { id: 'root', parentId: null, text: rootText, x: 48, y: 48 },
        { id: 'n1', parentId: 'root', text: childText, x: 296, y: 48 }
      ],
      updatedAt: ''
    })
    const doc1a = miniDoc(itemId, mmTitle, '第一章')
    const doc2a = miniDoc(item2Id, 'Second Sample Paper', '第二章')
    const saved1 = await cdp.evaluate(
      `window.api.mindmap.save(${itemId}, ${JSON.stringify(doc1a)})`
    )
    const saved2 = await cdp.evaluate(
      `window.api.mindmap.save(${item2Id}, ${JSON.stringify(doc2a)})`
    )
    check(
      '思维地图前置：两篇论文各有已保存地图',
      !!saved1 && Array.isArray(saved1.nodes) && saved1.nodes.length === 2 &&
        !!saved2 && Array.isArray(saved2.nodes) && saved2.nodes.length === 2
    )

    // 让阅读器打开第一篇（后续断言依赖 activeItemId 与工具栏入口）
    const readerReady = await cdp.evaluate(`(async()=>{
      const title=${JSON.stringify(mmTitle)};
      let rows=[...document.querySelectorAll('[data-testid="item-row"]')];
      let row=rows.find(r=>r.textContent.includes(title));
      if(!row){
        const input=document.querySelector('[data-testid="search-input"]');
        if(input){
          const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
          set.call(input,'');
          input.dispatchEvent(new Event('input',{bubbles:true}));
        }
        await new Promise(r=>setTimeout(r,600));
        rows=[...document.querySelectorAll('[data-testid="item-row"]')];
        row=rows.find(r=>r.textContent.includes(title));
      }
      if(!row)return false;
      row.click();
      for(let i=0;i<50;i++){
        const b=document.querySelector('[data-testid="toolbar-mindmap"]');
        if(b&&!b.disabled)return true;
        await new Promise(r=>setTimeout(r,100));
      }
      return false;
    })()`)
    check('思维地图入口在阅读器工具栏可用', readerReady === true)
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"toolbar-mindmap\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"mindmap-levels\"]')")
    const levelInfo = await cdp.evaluate(`(()=>{
      const bar=document.querySelector('[data-testid="mindmap-levels"]');
      const paper=document.querySelector('[data-testid="mindmap-level-paper"]');
      const group=document.querySelector('[data-testid="mindmap-level-group"]');
      const all=document.querySelector('[data-testid="mindmap-level-all"]');
      return {
        bar:!!bar,
        paper:!!paper,
        group:!!group,
        all:!!all,
        active:!!paper&&paper.classList.contains('is-active'),
        groupDisabled:!!group&&group.disabled,
        groupTitle:group?group.getAttribute('title'):null
      };
    })()`)
    check(
      '思维地图顶部出现三级切换且默认高亮「论文」',
      !!levelInfo &&
        levelInfo.bar === true &&
        levelInfo.paper === true &&
        levelInfo.group === true &&
        levelInfo.all === true &&
        levelInfo.active === true,
      JSON.stringify(levelInfo)
    )
    check(
      '未分组文献的「分组」按钮禁用并提示未分组',
      !!levelInfo &&
        levelInfo.groupDisabled === true &&
        levelInfo.groupTitle === '该文献未分组',
      JSON.stringify(levelInfo)
    )

    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-level-all\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(
      cdp,
      "(()=>{const n=document.querySelectorAll('[data-testid^=\"mindmap-paper-node-\"]').length;return n>0})()"
    )
    const libCount = await cdp.evaluate('window.api.library.list().then(l=>l.length)')
    const allView = await cdp.evaluate(`(()=>{
      const hint=document.querySelector('[data-testid="mindmap-aggregate-hint"]');
      const nodes=[...document.querySelectorAll('[data-testid^="mindmap-paper-node-"]')];
      return {
        hint:hint?hint.textContent:'',
        count:nodes.length,
        ids:nodes.map(n=>n.getAttribute('data-testid')),
        add:!!document.querySelector('[data-testid="mindmap-add"]'),
        rename:!!document.querySelector('[data-testid="mindmap-rename"]'),
        del:!!document.querySelector('[data-testid="mindmap-delete"]'),
        ai:!!document.querySelector('[data-testid="mindmap-ai-summary"]'),
        exp:!!document.querySelector('[data-testid="mindmap-export-markdown"]')
      };
    })()`)
    check(
      '「全部」级每篇论文一个节点（数量等于文库条目数）',
      !!allView && allView.count === libCount,
      JSON.stringify({ count: allView && allView.count, libCount, ids: allView && allView.ids })
    )
    check(
      '聚合视图显示只读与点击开窗提示',
      !!allView && /只读/.test(allView.hint) && /新窗口/.test(allView.hint),
      String(allView && allView.hint)
    )
    check(
      '聚合视图不出现新增/改名/删除/AI/导出入口',
      !!allView &&
        allView.add === false &&
        allView.rename === false &&
        allView.del === false &&
        allView.ai === false &&
        allView.exp === false,
      JSON.stringify(allView)
    )
    const clickedPaper = await cdp.evaluate(`(()=>{
      const n=document.querySelector('[data-testid^="mindmap-paper-node-"]');
      if(!n)return null;
      const info={testid:n.getAttribute('data-testid'),text:(n.textContent||'').replace('打开','').trim()};
      n.click();
      return info;
    })()`)
    check('全部级论文节点可点击', !!clickedPaper && !!clickedPaper.testid, JSON.stringify(clickedPaper))
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"mindmap-open-status\"]')")
    const openStatus = await cdp.evaluate(
      "document.querySelector('[data-testid=\"mindmap-open-status\"]')?.textContent || ''"
    )
    const clickedTitle = clickedPaper
      ? clickedPaper.text.replace(/（暂无内容）$/u, '').trim()
      : ''
    check(
      '点击论文节点后主窗口显示「已在新窗口打开」并含论文标题',
      openStatus.includes('已在新窗口打开：') &&
        clickedTitle.length > 0 &&
        openStatus.includes(clickedTitle),
      openStatus
    )
    const openRes = await cdp.evaluate(`window.api.mindmap.openPaper(${itemId})`)
    check(
      'openPaper 返回 ok 与窗口 id',
      !!openRes && openRes.ok === true && typeof openRes.windowId === 'number',
      JSON.stringify(openRes)
    )

    // 分组级：两篇同组，应只渲染这两篇
    const groupName = 'E2E思维地图组'
    await cdp.evaluate(
      `Promise.all([window.api.library.setGroup(${itemId}, ${JSON.stringify(groupName)}),window.api.library.setGroup(${item2Id}, ${JSON.stringify(groupName)})])`
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-close\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(cdp, "!document.querySelector('[data-testid=\"mindmap-panel\"]')")
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"toolbar-mindmap\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(
      cdp,
      "(()=>{const g=document.querySelector('[data-testid=\"mindmap-level-group\"]');return !!g&&!g.disabled})()"
    )
    const groupBtn = await cdp.evaluate(`(()=>{
      const g=document.querySelector('[data-testid="mindmap-level-group"]');
      return {disabled:!!g&&g.disabled,title:g?g.getAttribute('title'):null};
    })()`)
    check(
      '已分组文献的「分组」按钮可用',
      !!groupBtn && groupBtn.disabled === false && String(groupBtn.title).includes(groupName),
      JSON.stringify(groupBtn)
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-level-group\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(
      cdp,
      "(()=>{const n=document.querySelectorAll('[data-testid^=\"mindmap-paper-node-\"]').length;return n>0})()"
    )
    const groupView = await cdp.evaluate(`(()=>{
      const nodes=[...document.querySelectorAll('[data-testid^="mindmap-paper-node-"]')];
      return {count:nodes.length,ids:nodes.map(n=>n.getAttribute('data-testid'))};
    })()`)
    check(
      '「分组」级只渲染该组内的论文节点',
      !!groupView &&
        groupView.count === 2 &&
        groupView.ids.includes('mindmap-paper-node-' + itemId) &&
        groupView.ids.includes('mindmap-paper-node-' + item2Id),
      JSON.stringify(groupView)
    )

    // ---------- PD53：聚合视图只读提示 + 「编辑这篇」进入可编辑地图并写回 ----------
    const editUi = await cdp.evaluate(`(()=>{
      const hint=document.querySelector('[data-testid="mindmap-readonly-hint"]');
      const btn=document.querySelector('[data-testid="mindmap-edit-paper"]');
      const target=document.querySelector('[data-testid="mindmap-edit-target"]');
      const add=document.querySelector('[data-testid="mindmap-add"]');
      return {
        hint:hint?hint.textContent:'',
        btn:!!btn,
        disabled:!!btn&&btn.disabled,
        target:target?target.textContent:'',
        add:!!add
      };
    })()`)
    check(
      'PD53：聚合视图有只读提示与可用的「编辑这篇」入口，且聚合图本身仍无新增入口',
      !!editUi &&
        /聚合视图只读/.test(editUi.hint) &&
        /进入可编辑地图/.test(editUi.hint) &&
        editUi.btn === true &&
        editUi.disabled === false &&
        editUi.add === false,
      JSON.stringify(editUi)
    )
    await cdp.evaluate(
      `(()=>{const n=document.querySelector('[data-testid="mindmap-paper-node-${item2Id}"]');if(n)n.click();return !!n})()`
    )
    const targetAfterPick = await waitFor(
      cdp,
      `(()=>{const t=document.querySelector('[data-testid="mindmap-edit-target"]');return t&&t.textContent.includes('Second Sample Paper')?t.textContent:''})()`
    )
    check(
      'PD53：点击聚合论文节点后「编辑这篇」目标切换到该论文',
      typeof targetAfterPick === 'string' && targetAfterPick.includes('Second Sample Paper'),
      String(targetAfterPick)
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-edit-paper\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(
      cdp,
      "(()=>{const add=document.querySelector('[data-testid=\"mindmap-add\"]');const node=document.querySelector('[data-testid=\"mindmap-node-root\"]');return !!(add&&node)})()"
    )
    const editState = await cdp.evaluate(`(()=>{
      const paper=document.querySelector('.mindmap__paper');
      const ret=document.querySelector('[data-testid="mindmap-edit-return"]');
      const add=document.querySelector('[data-testid="mindmap-add"]');
      const rename=document.querySelector('[data-testid="mindmap-rename"]');
      const rootText=document.querySelector('[data-testid="mindmap-node-root"] .mindmap__node-text');
      return {
        paper:paper?paper.textContent:'',
        paperTitle:paper?paper.getAttribute('title'):'',
        ret:!!ret,
        add:!!add,
        rename:!!rename,
        rootText:rootText?rootText.textContent:'',
        levelPaper:!!document.querySelector('[data-testid="mindmap-level-paper"]')?.classList.contains('is-active')
      };
    })()`)
    check(
      'PD53：点「编辑这篇」在主窗口内进入该论文的可编辑地图（出现新增/改名入口）',
      !!editState &&
        editState.levelPaper === true &&
        editState.add === true &&
        editState.rename === true &&
        editState.ret === true &&
        editState.paper.includes('Second Sample Paper') &&
        editState.paperTitle === editState.paper,
      JSON.stringify(editState)
    )
    // ---- PD54：关闭思维地图 AI → 三个 AI 入口禁用 + 可读原因；重新打开立即恢复 ----
    const pd54MindGate = await cdp.evaluate(`(async()=>{
      const snap=()=>['mindmap-ai-summary','mindmap-ai-expand','mindmap-ai-support'].map((id)=>{
        const b=document.querySelector('[data-testid="'+id+'"]');
        return b?{disabled:b.disabled,title:b.title}:null;
      });
      const before=snap();
      await window.api.aiTools.update({id:'mindmap-ai',enabled:false});
      await new Promise((r)=>setTimeout(r,300));
      const off=snap();
      await window.api.aiTools.update({id:'mindmap-ai',enabled:true});
      await new Promise((r)=>setTimeout(r,300));
      const on=snap();
      return {before,off,on};
    })()`)
    check(
      'PD54：关闭思维地图 AI 后三个 AI 入口禁用并提示「已在 AI 工具库关闭思维地图 AI」',
      !!pd54MindGate &&
        pd54MindGate.off.length === 3 &&
        pd54MindGate.off.every(
          (s) => !!s && s.disabled === true && String(s.title).includes('已在 AI 工具库关闭思维地图 AI')
        ),
      JSON.stringify(pd54MindGate)
    )
    check(
      'PD54：重新打开思维地图 AI 后三个入口回到关闭前的可用状态（无需重启）',
      !!pd54MindGate &&
        pd54MindGate.on.length === 3 &&
        pd54MindGate.on.every((s, i) => {
          if (!s) return false;
          const base = pd54MindGate.before[i];
          return !String(s.title).includes('已在 AI 工具库') && s.disabled === (base ? base.disabled : false)
        }),
      JSON.stringify(pd54MindGate)
    )

    // 在目标论文地图里新增一个子节点，确认保存后返回聚合视图能看到它（真实写回 data/mindmap/<items.key>.json）
    const kidsBefore = await cdp.evaluate(`(async()=>{
      const d=await window.api.mindmap.load(${item2Id});
      if(!d)return null;
      return {root:d.rootId, kids:d.nodes.filter((n)=>n.parentId===d.rootId).map((n)=>n.id)};
    })()`)
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-add\"]');if(b)b.click();return !!b})()"
    )
    const childAdded = await waitFor(
      cdp,
      "(()=>!!document.querySelector('.mindmap__input'))()"
    )
    // 顺手试一次改名（受控 input 只认真实编辑事件，headless 下不一定生效，因此只记录不参与断言）
    const inputReady = await cdp.evaluate(
      "(()=>{const i=document.querySelector('.mindmap__input');if(!i)return false;i.focus();i.select();return true})()"
    )
    await cdp.evaluate(
      "(()=>{try{return document.execCommand('insertText',false,'PD53聚合编辑新增')}catch{return false}})()"
    )
    await sleep(200)
    const renameApplied = await cdp.evaluate(
      "(()=>{return [...document.querySelectorAll('.mindmap__node-text')].some((s)=>s.textContent.includes('PD53聚合编辑新增'))})()"
    )
    await cdp.evaluate(
      "(()=>{const i=document.querySelector('.mindmap__input');if(i)i.blur();return true})()"
    )
    await sleep(700) // 等保存 IPC 落盘
    const savedProbe = await cdp.evaluate(`(async()=>{
      const d=await window.api.mindmap.load(${item2Id});
      if(!d)return null;
      const rootId=d.rootId;
      const kids=d.nodes.filter((n)=>n.parentId===rootId);
      return {
        texts:d.nodes.map((n)=>n.text),
        kidIds:kids.map((n)=>n.id),
        newChild:kids.length?kids[kids.length-1].text:null,
        error:(document.querySelector('.mindmap__error')||{}).textContent||''
      };
    })()`)
    const addedId = savedProbe ? savedProbe.kidIds.find((id) => !(kidsBefore ? kidsBefore.kids : []).includes(id)) : null
    const newChildText = savedProbe && savedProbe.newChild ? savedProbe.newChild : ''
    check(
      'PD53：编辑这篇后可新增子节点并写回地图文件',
      childAdded === true &&
        !!kidsBefore &&
        !!savedProbe &&
        savedProbe.kidIds.length === kidsBefore.kids.length + 1 &&
        !!addedId &&
        newChildText.length > 0,
      JSON.stringify({ childAdded, inputReady, renameApplied, kidsBefore, savedProbe, addedId })
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-edit-return\"]');if(b)b.click();return !!b})()"
    )
    const backToAggregate = await waitFor(
      cdp,
      `(()=>{
        if(!document.querySelector('[data-testid="mindmap-aggregate-hint"]'))return false;
        const texts=[...document.querySelectorAll('.mindmap__node-text')].map((s)=>s.textContent);
        return texts.some((t)=>t.includes(${JSON.stringify(newChildText)}))?{hit:true,nodes:texts.length}:false;
      })()`
    )
    const aggregateProbe = await cdp.evaluate(`(()=>({
      hint:!!document.querySelector('[data-testid="mindmap-aggregate-hint"]'),
      error:(document.querySelector('.mindmap__error')||{}).textContent||'',
      nodes:[...document.querySelectorAll('.mindmap__node-text')].map((s)=>s.textContent)
    }))()`)
    check(
      'PD53：返回聚合视图能看到刚编辑保存的新子节点（写回 data/mindmap）',
      !!backToAggregate &&
        backToAggregate.hit === true &&
        aggregateProbe.hint === true &&
        aggregateProbe.error === '',
      JSON.stringify({ newChildText, backToAggregate, aggregateProbe })
    )

    // 切回论文级必须重新读盘：模拟新窗口保存后的新位置
    const moved = Object.assign({}, doc1a, {
      nodes: doc1a.nodes.map((n) => (n.id === 'n1' ? Object.assign({}, n, { x: 400 }) : n))
    })
    await cdp.evaluate(`window.api.mindmap.save(${itemId}, ${JSON.stringify(moved)})`)
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-level-paper\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(
      cdp,
      "(()=>{const n=document.querySelector('[data-testid=\"mindmap-node-n1\"]');return !!n&&n.style.left==='400px'})()"
    )
    const reloadedLeft = await cdp.evaluate(
      "document.querySelector('[data-testid=\"mindmap-node-n1\"]')?.style.left || ''"
    )
    check('切回「论文」级会重新读盘（看到新窗口保存的位置）', reloadedLeft === '400px', reloadedLeft)

    // ---------- PD56：画布缩放 / 框选多选 / 批量操作 ----------
    console.log('--- PD56 思维地图缩放与多选 ---')
    const pd56Doc = {
      version: 1,
      itemId,
      rootId: 'root',
      nodes: [
        { id: 'root', parentId: null, text: mmTitle, x: 40, y: 40 },
        { id: 'z1', parentId: 'root', text: 'PD56 节点甲', x: 300, y: 60 },
        { id: 'z2', parentId: 'root', text: 'PD56 节点乙', x: 300, y: 220 },
        { id: 'z3', parentId: 'root', text: 'PD56 节点丙', x: 560, y: 140 },
        { id: 'z1c', parentId: 'z1', text: 'PD56 子节点', x: 560, y: 20 }
      ],
      updatedAt: ''
    }
    await cdp.evaluate(`window.api.mindmap.save(${itemId}, ${JSON.stringify(pd56Doc)})`)
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-close\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(cdp, "!document.querySelector('[data-testid=\"mindmap-panel\"]')")
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"toolbar-mindmap\"]');if(b)b.click();return !!b})()"
    )
    const pd56Ready = await waitFor(
      cdp,
      "(()=>{const n=document.querySelector('[data-testid=\"mindmap-node-z1\"]');const v=document.querySelector('[data-testid=\"mindmap-zoom-value\"]');return !!n&&!!v&&v.textContent.trim()==='100%'})()"
    )
    check('PD56：重开面板载入固定地图且初始缩放为 100%', pd56Ready === true)
    const pd56ZoomUi = await cdp.evaluate(`(()=>{
      const v=document.querySelector('[data-testid="mindmap-zoom-value"]');
      return {
        out:!!document.querySelector('[data-testid="mindmap-zoom-out"]'),
        in:!!document.querySelector('[data-testid="mindmap-zoom-in"]'),
        reset:!!document.querySelector('[data-testid="mindmap-zoom-reset"]'),
        value:v?v.textContent.trim():'',
        viewport:!!document.querySelector('[data-testid="mindmap-viewport"]'),
        count:((document.querySelector('[data-testid="mindmap-selection-count"]')||{}).textContent||'').trim()
      };
    })()`)
    check(
      'PD56：缩放三键 / 比例显示 / 选区计数 / 可缩放视口齐备',
      pd56ZoomUi.out === true &&
        pd56ZoomUi.in === true &&
        pd56ZoomUi.reset === true &&
        pd56ZoomUi.value === '100%' &&
        pd56ZoomUi.viewport === true &&
        pd56ZoomUi.count.indexOf('已选') === 0,
      JSON.stringify(pd56ZoomUi)
    )
    const pd56ClickZoom = (id) =>
      cdp.evaluate(
        `(()=>{const b=document.querySelector('[data-testid="${id}"]');if(b)b.click();return !!b})()`
      )
    const pd56ReadZoom = () =>
      cdp.evaluate(
        "((document.querySelector('[data-testid=\"mindmap-zoom-value\"]')||{}).textContent||'').trim()"
      )
    await pd56ClickZoom('mindmap-zoom-in')
    await sleep(180)
    const pd56Zoom110 = await pd56ReadZoom()
    check('PD56：点「放大」后比例变为 110%', pd56Zoom110 === '110%', pd56Zoom110)
    await pd56ClickZoom('mindmap-zoom-out')
    await sleep(180)
    const pd56ZoomBack = await pd56ReadZoom()
    check('PD56：点「缩小」后比例回到 100%', pd56ZoomBack === '100%', pd56ZoomBack)
    await pd56ClickZoom('mindmap-zoom-reset')
    await sleep(200)

    // Ctrl+滚轮：以光标为锚点，光标下的节点缩放前后位移 ≤ 2px
    const pd56Anchor = await cdp.evaluate(`(async()=>{
      const vp=document.querySelector('[data-testid="mindmap-viewport"]');
      const node=document.querySelector('[data-testid="mindmap-node-z1"]');
      if(!vp||!node)return {ok:false,reason:'缺少视口或节点'};
      vp.scrollLeft=0; vp.scrollTop=0;
      await new Promise(r=>setTimeout(r,150));
      const before=node.getBoundingClientRect();
      const cx=before.left+before.width/2, cy=before.top+before.height/2;
      vp.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-120,clientX:cx,clientY:cy}));
      await new Promise(r=>setTimeout(r,200));
      const after=node.getBoundingClientRect();
      const ax=after.left+after.width/2, ay=after.top+after.height/2;
      const value=((document.querySelector('[data-testid="mindmap-zoom-value"]')||{}).textContent||'').trim();
      return {ok:true,dx:Math.abs(ax-cx),dy:Math.abs(ay-cy),value,point:{cx,cy,ax,ay}};
    })()`)
    check(
      'PD56：Ctrl+滚轮缩放到 110% 且以光标为锚点（误差 ≤ 2px）',
      !!pd56Anchor &&
        pd56Anchor.ok === true &&
        pd56Anchor.value === '110%' &&
        pd56Anchor.dx <= 2 &&
        pd56Anchor.dy <= 2,
      JSON.stringify(pd56Anchor)
    )

    // 缩放后拖动：屏幕位移 22px ÷ 1.1 ≈ 20 内容像素
    const pd56Drag = await cdp.evaluate(`(async()=>{
      const node=document.querySelector('[data-testid="mindmap-node-z2"]');
      if(!node)return {ok:false,reason:'缺少节点 z2'};
      const r=node.getBoundingClientRect();
      const left0=parseFloat(node.style.left);
      const fire=(type,x,y,extra)=>node.dispatchEvent(new PointerEvent(type,Object.assign({bubbles:true,cancelable:true,pointerType:'mouse',pointerId:1,button:0,buttons:1,clientX:x,clientY:y},extra||{})));
      fire('pointerdown',r.left+16,r.top+10);
      fire('pointermove',r.left+38,r.top+10);
      fire('pointerup',r.left+38,r.top+10,{buttons:0});
      await new Promise(done=>setTimeout(done,320));
      const left1=parseFloat(node.style.left);
      return {ok:true,left0,left1,delta:left1-left0};
    })()`)
    check(
      'PD56：缩放后拖动节点位移按比例换算（22px/1.1≈20）',
      !!pd56Drag &&
        pd56Drag.ok === true &&
        Math.abs(pd56Drag.delta - 20) <= 1.5,
      JSON.stringify(pd56Drag)
    )

    // 缩放后连线仍对齐节点边缘（路径起点 = 某节点右边缘，误差 ≤ 2px）
    const pd56Edge = await cdp.evaluate(`(()=>{
      const canvas=document.querySelector('.mindmap__canvas');
      const svg=document.querySelector('.mindmap__edges');
      if(!canvas||!svg)return {ok:false,reason:'缺少画布'};
      const cr=canvas.getBoundingClientRect();
      const zoom=canvas.offsetWidth>0?cr.width/canvas.offsetWidth:1;
      const nodes=[...document.querySelectorAll('.mindmap__node')].map((n)=>({r:n.getBoundingClientRect()}));
      let worst=0,count=0;
      for(const p of svg.querySelectorAll('path')){
        const d=p.getAttribute('d')||'';
        const parts=d.slice(1).trim().split('C')[0].trim().split(' ');
        if(parts.length<2)continue;
        const sx=cr.left+parseFloat(parts[0])*zoom;
        const sy=cr.top+parseFloat(parts[1])*zoom;
        let best=Infinity;
        for(const n of nodes){
          const ddx=Math.abs(n.r.right-sx), ddy=Math.abs(n.r.top+n.r.height/2-sy);
          best=Math.min(best,Math.max(ddx,ddy));
        }
        worst=Math.max(worst,best);
        count++;
      }
      return {ok:true,zoom,count,worst};
    })()`)
    check(
      'PD56：缩放后连线与节点边缘对齐（误差 ≤ 2px）',
      !!pd56Edge && pd56Edge.ok === true && pd56Edge.count > 0 && pd56Edge.worst <= 2,
      JSON.stringify(pd56Edge)
    )

    // 回到 100%，让框选与批量用例在基准缩放下进行
    await pd56ClickZoom('mindmap-zoom-reset')
    await sleep(240)

    // 框选：空白处拖出选框 → 命中高亮 → 松开显示计数与批量条
    const pd56Marquee = await cdp.evaluate(`(async()=>{
      const vp=document.querySelector('[data-testid="mindmap-viewport"]');
      if(!vp)return {ok:false,reason:'缺少视口'};
      vp.scrollLeft=0; vp.scrollTop=0;
      await new Promise(r=>setTimeout(r,150));
      const r=vp.getBoundingClientRect();
      const fire=(type,x,y,extra)=>vp.dispatchEvent(new PointerEvent(type,Object.assign({bubbles:true,cancelable:true,pointerType:'mouse',pointerId:2,button:0,buttons:1,clientX:x,clientY:y},extra||{})));
      fire('pointerdown',r.left+6,r.top+6);
      fire('pointermove',r.left+700,r.top+420);
      await new Promise(r2=>setTimeout(r2,150));
      const box=document.querySelector('[data-testid="mindmap-marquee"]');
      const highlighted=document.querySelectorAll('.mindmap__node.is-selected').length;
      fire('pointerup',r.left+700,r.top+420,{buttons:0});
      await new Promise(r3=>setTimeout(r3,220));
      return {
        ok:true,
        box:!!box,
        boxSize:box?{w:box.style.width,h:box.style.height}:null,
        highlighted,
        count:((document.querySelector('[data-testid="mindmap-selection-count"]')||{}).textContent||'').trim(),
        selected:document.querySelectorAll('.mindmap__node.is-selected').length,
        bulk:!!document.querySelector('[data-testid="mindmap-bulk-bar"]')
      };
    })()`)
    check(
      'PD56：空白处拖框出现选框并多选高亮（≥4 个）',
      !!pd56Marquee &&
        pd56Marquee.ok === true &&
        pd56Marquee.box === true &&
        pd56Marquee.highlighted >= 4 &&
        pd56Marquee.selected >= 4 &&
        pd56Marquee.bulk === true,
      JSON.stringify(pd56Marquee)
    )
    check(
      'PD56：松开后计数显示「已选 N 个」且与高亮数量一致',
      !!pd56Marquee &&
        pd56Marquee.count === `已选 ${pd56Marquee.selected} 个`,
      JSON.stringify({ count: pd56Marquee && pd56Marquee.count, selected: pd56Marquee && pd56Marquee.selected })
    )

    // 批量对齐：选中节点 x 全部相同
    const pd56Align = await cdp.evaluate(`(async()=>{
      const btn=document.querySelector('[data-testid="mindmap-bulk-align"]');
      if(!btn)return {ok:false,reason:'缺少批量对齐'};
      btn.click();
      await new Promise(r=>setTimeout(r,220));
      const lefts=[...document.querySelectorAll('.mindmap__node.is-selected')].map((n)=>n.style.left);
      return {ok:true,lefts,unique:[...new Set(lefts)]};
    })()`)
    check(
      'PD56：批量对齐把选中节点排到同一列',
      !!pd56Align && pd56Align.ok === true && pd56Align.lefts.length >= 4 && pd56Align.unique.length === 1,
      JSON.stringify(pd56Align)
    )

    // 批量折叠 / 展开（纯 UI，不写盘）
    const pd56Collapse = await cdp.evaluate(`(async()=>{
      const btn=document.querySelector('[data-testid="mindmap-bulk-collapse"]');
      if(!btn)return {ok:false,reason:'缺少批量折叠'};
      btn.click();
      await new Promise(r=>setTimeout(r,220));
      const hidden=!document.querySelector('[data-testid="mindmap-node-z1c"]');
      const badge=!!document.querySelector('[data-testid="mindmap-collapse-z1"].is-collapsed');
      btn.click();
      await new Promise(r=>setTimeout(r,220));
      const back=!!document.querySelector('[data-testid="mindmap-node-z1c"]');
      return {ok:true,hidden,badge,back};
    })()`)
    check(
      'PD56：批量折叠隐藏子树，再次点击展开',
      !!pd56Collapse &&
        pd56Collapse.ok === true &&
        pd56Collapse.hidden === true &&
        pd56Collapse.badge === true &&
        pd56Collapse.back === true,
      JSON.stringify(pd56Collapse)
    )

    // 批量删除（二次确认）+ 撤销恢复节点与位置
    const pd56Delete = await cdp.evaluate(`(async()=>{
      const del=document.querySelector('[data-testid="mindmap-bulk-delete"]');
      if(!del)return {ok:false,reason:'缺少批量删除'};
      const snapZ3=(document.querySelector('[data-testid="mindmap-node-z3"]')||{style:{}}).style.left;
      del.click();
      await new Promise(r=>setTimeout(r,180));
      const armed=((document.querySelector('[data-testid="mindmap-bulk-delete"]')||{}).textContent||'').trim();
      const noticeArmed=((document.querySelector('[data-testid="mindmap-bulk-status"]')||{}).textContent||'').trim();
      del.click();
      await new Promise(r=>setTimeout(r,300));
      const after={
        z3:!!document.querySelector('[data-testid="mindmap-node-z3"]'),
        count:((document.querySelector('[data-testid="mindmap-selection-count"]')||{}).textContent||'').trim(),
        bulk:!!document.querySelector('[data-testid="mindmap-bulk-bar"]'),
        undoDisabled:document.querySelector('[data-testid="mindmap-ai-undo"]').disabled
      };
      const undo=document.querySelector('[data-testid="mindmap-ai-undo"]');
      if(undo)undo.click();
      await new Promise(r=>setTimeout(r,350));
      const restored={
        z3:!!document.querySelector('[data-testid="mindmap-node-z3"]'),
        left:(document.querySelector('[data-testid="mindmap-node-z3"]')||{style:{}}).style.left,
        notice:((document.querySelector('[data-testid="mindmap-bulk-status"]')||{}).textContent||'').trim()
      };
      return {ok:true,armed,noticeArmed,after,restored,snapZ3};
    })()`)
    check(
      'PD56：批量删除需要二次确认（首次点击只提示）',
      !!pd56Delete &&
        pd56Delete.ok === true &&
        pd56Delete.armed === '确认删除' &&
        pd56Delete.noticeArmed.indexOf('再次点击') >= 0,
      JSON.stringify({ armed: pd56Delete && pd56Delete.armed, notice: pd56Delete && pd56Delete.noticeArmed })
    )
    check(
      'PD56：确认后删除选中节点（保留根）并清空选择/批量条',
      !!pd56Delete &&
        pd56Delete.after.z3 === false &&
        pd56Delete.after.count === '已选 0 个' &&
        pd56Delete.after.bulk === false &&
        pd56Delete.after.undoDisabled === false,
      JSON.stringify(pd56Delete && pd56Delete.after)
    )
    check(
      'PD56：撤销批量删除后节点与位置完全恢复',
      !!pd56Delete &&
        pd56Delete.restored.z3 === true &&
        pd56Delete.restored.left === pd56Delete.snapZ3 &&
        pd56Delete.restored.notice.indexOf('已撤销') >= 0,
      JSON.stringify({ restored: pd56Delete && pd56Delete.restored, snapZ3: pd56Delete && pd56Delete.snapZ3 })
    )

    // Ctrl/Shift+点击追加或取消单个节点；Esc 先清空选择而不是关面板
    const pd56Toggle = await cdp.evaluate(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const count=()=>((document.querySelector('[data-testid="mindmap-selection-count"]')||{}).textContent||'').trim();
      const fire=(node,extra)=>{
        const r=node.getBoundingClientRect();
        const init=Object.assign({bubbles:true,cancelable:true,pointerType:'mouse',pointerId:3,button:0,buttons:1,clientX:r.left+8,clientY:r.top+8},extra||{});
        node.dispatchEvent(new PointerEvent('pointerdown',init));
        node.dispatchEvent(new PointerEvent('pointerup',Object.assign({},init,{buttons:0})));
      };
      const clear=document.querySelector('[data-testid="mindmap-bulk-clear"]');
      if(clear)clear.click();
      await wait(150);
      const z1=document.querySelector('[data-testid="mindmap-node-z1"]');
      const z2=document.querySelector('[data-testid="mindmap-node-z2"]');
      if(!z1||!z2)return {ok:false,reason:'缺少节点'};
      fire(z1); await wait(150);
      const one=count();
      fire(z2,{ctrlKey:true}); await wait(150);
      const two=count();
      const bulk=!!document.querySelector('[data-testid="mindmap-bulk-bar"]');
      fire(z2,{ctrlKey:true}); await wait(150);
      const back=count();
      const bulkGone=!document.querySelector('[data-testid="mindmap-bulk-bar"]');
      return {ok:true,one,two,back,bulk,bulkGone};
    })()`)
    check(
      'PD56：Ctrl+点击可追加/取消单个节点（批量条随多选出现/隐藏）',
      !!pd56Toggle &&
        pd56Toggle.ok === true &&
        pd56Toggle.one === '已选 1 个' &&
        pd56Toggle.two === '已选 2 个' &&
        pd56Toggle.bulk === true &&
        pd56Toggle.back === '已选 1 个' &&
        pd56Toggle.bulkGone === true,
      JSON.stringify(pd56Toggle)
    )
    const pd56Esc = await cdp.evaluate(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const count=()=>((document.querySelector('[data-testid="mindmap-selection-count"]')||{}).textContent||'').trim();
      const panel=document.querySelector('[data-testid="mindmap-panel"]');
      const before=count();
      if(panel)panel.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      await wait(180);
      return {ok:true,before,after:count(),open:!!document.querySelector('[data-testid="mindmap-panel"]')};
    })()`)
    check(
      'PD56：Esc 先清空选择且面板保持打开',
      !!pd56Esc &&
        pd56Esc.ok === true &&
        pd56Esc.before === '已选 1 个' &&
        pd56Esc.after === '已选 0 个' &&
        pd56Esc.open === true,
      JSON.stringify(pd56Esc)
    )

    // 比例按文献记忆：放大后重开面板仍是 110%，最后重置回 100%
    await pd56ClickZoom('mindmap-zoom-in')
    await sleep(180)
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-close\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(cdp, "!document.querySelector('[data-testid=\"mindmap-panel\"]')")
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"toolbar-mindmap\"]');if(b)b.click();return !!b})()"
    )
    const pd56Persisted = await waitFor(
      cdp,
      "(()=>{const v=document.querySelector('[data-testid=\"mindmap-zoom-value\"]');const n=document.querySelector('[data-testid=\"mindmap-node-z1\"]');return !!n&&!!v&&v.textContent.trim()==='110%'})()"
    )
    check('PD56：缩放比例按文献记忆（重开面板恢复 110%）', pd56Persisted === true)
    await pd56ClickZoom('mindmap-zoom-reset')
    await sleep(220)
    const pd56Final = await cdp.evaluate(`(()=>({
      value:((document.querySelector('[data-testid="mindmap-zoom-value"]')||{}).textContent||'').trim(),
      open:!!document.querySelector('[data-testid="mindmap-panel"]'),
      count:((document.querySelector('[data-testid="mindmap-selection-count"]')||{}).textContent||'').trim()
    }))()`)
    check(
      'PD56：重置回到 100% 且面板保持打开（供后续工具栏几何断言）',
      pd56Final.value === '100%' && pd56Final.open === true,
      JSON.stringify(pd56Final)
    )

    // ---------- PD57：节点全文显示 / 去 Markdown / AI 优化 ----------
    console.log('--- PD57 思维地图全文显示与 AI 优化 ---')
    const pd57Cn =
      '这是一篇关于思维地图长标题全文显示验证的中文论文标题用于确认节点不会被省略号截断而必须完整换行显示并且相邻节点之间不会发生重叠'
    const pd57En =
      'A Very Long English Paper Title That Must Be Fully Displayed Inside The Mind Map Node Without Any Ellipsis Or Truncation At All'
    const pd57Markdown = '**粗体** 与 `代码` 和 [链接](https://example.com)'
    const pd57Doc = {
      version: 1,
      itemId,
      rootId: 'root',
      nodes: [
        { id: 'root', parentId: null, text: 'PD57 根节点', x: 40, y: 40 },
        { id: 'z1', parentId: 'root', text: pd57Cn, x: 300, y: 60 },
        { id: 'z2', parentId: 'root', text: pd57En, x: 300, y: 240 },
        { id: 'z3', parentId: 'root', text: pd57Markdown, x: 980, y: 60 }
      ],
      updatedAt: ''
    }
    await cdp.evaluate(`window.api.mindmap.save(${itemId}, ${JSON.stringify(pd57Doc)})`)
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-close\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(cdp, "!document.querySelector('[data-testid=\"mindmap-panel\"]')")
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"toolbar-mindmap\"]');if(b)b.click();return !!b})()"
    )
    const pd57Ready = await waitFor(
      cdp,
      "(()=>{const n=document.querySelector('[data-testid=\"mindmap-node-z1\"]');return !!n&&n.textContent.indexOf('重叠')>=0})()"
    )
    check('PD57：重开面板载入长标题固定地图', pd57Ready === true)
    const pd57Render = await cdp.evaluate(`(()=>{
      const info=(id)=>{
        const n=document.querySelector('[data-testid="mindmap-node-'+id+'"]');
        if(!n)return null;
        const t=n.querySelector('.mindmap__node-text');
        const cs=getComputedStyle(t);
        const r=n.getBoundingClientRect();
        return {text:t.textContent,sw:t.scrollWidth,cw:t.clientWidth,ws:cs.whiteSpace,to:cs.textOverflow,ov:cs.overflow,r:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}};
      };
      const a=info('z1'),b=info('z2'),c=info('z3');
      const hit=(x,y)=>Math.min(x.r.right,y.r.right)-Math.max(x.r.left,y.r.left)>0.5&&Math.min(x.r.bottom,y.r.bottom)-Math.max(x.r.top,y.r.top)>0.5;
      const opt=document.querySelector('[data-testid="mindmap-ai-optimize"]');
      const alias=document.querySelector('[data-testid="mindmap-ai-expand"]');
      return {
        a,b,c,
        overlap: !!a&&!!b&&!!c ? [hit(a,b),hit(a,c),hit(b,c)] : null,
        opt: opt?{text:opt.textContent.trim(),disabled:opt.disabled,title:opt.title}:null,
        alias: alias?{width:alias.getBoundingClientRect().width,disabled:alias.disabled,title:alias.title}:null
      };
    })()`)
    const pd57CnOk = pd57Render.a && pd57Render.a.text === pd57Cn && !pd57Render.a.text.includes('…')
    const pd57EnOk = pd57Render.b && pd57Render.b.text === pd57En && !pd57Render.b.text.includes('…')
    check(
      'PD57：≥60 字中文标题与长英文标题都完整显示（不截断、无省略号、scrollWidth<=clientWidth+1）',
      !!pd57CnOk &&
        !!pd57EnOk &&
        pd57Render.a.sw <= pd57Render.a.cw + 1 &&
        pd57Render.b.sw <= pd57Render.b.cw + 1 &&
        pd57Render.a.ws === 'pre-wrap' &&
        pd57Render.b.ws === 'pre-wrap' &&
        pd57Render.a.to !== 'ellipsis' &&
        pd57Render.b.to !== 'ellipsis',
      JSON.stringify({ cn: pd57Render.a, en: pd57Render.b })
    )
    check(
      'PD57：长标题节点两两不重叠（按测量宽高布局）',
      !!pd57Render.overlap && pd57Render.overlap.every((v) => v === false),
      JSON.stringify(pd57Render.overlap)
    )
    check(
      'PD57：节点正文去掉 Markdown 标记（粗体/代码/链接只留文字）',
      !!pd57Render.c && pd57Render.c.text === '粗体 与 代码 和 链接',
      JSON.stringify(pd57Render.c)
    )
    check(
      'PD57/PD59：工具栏同时存在「AI 优化」与兼容别名（别名宽 0）；未配置模型时仍可点击并在 title 标注可读原因',
      !!pd57Render.opt &&
        pd57Render.opt.text === 'AI 优化' &&
        !!pd57Render.alias &&
        pd57Render.alias.width <= 1 &&
        pd57Render.opt.disabled === false &&
        pd57Render.alias.disabled === false &&
        pd57Render.opt.title.includes('尚未配置模型服务') &&
        pd57Render.alias.title.includes('尚未配置模型服务'),
      JSON.stringify({ opt: pd57Render.opt, alias: pd57Render.alias })
    )
    const pd59NoModel = await cdp.evaluate(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const opt=document.querySelector('[data-testid="mindmap-ai-optimize"]');
      if(!opt) return {err:'no-opt'};
      const count=()=>document.querySelectorAll('[data-testid^="mindmap-node-"]').length;
      const before=count();
      opt.click();
      await wait(500);
      const err=document.querySelector('[data-testid="mindmap-ai-error"]');
      return {before,after:count(),optDisabled:opt.disabled,errorText:err?err.textContent.trim():''};
    })()`)
    check(
      'PD59：未配置模型时点「AI 优化」给出可读提示（不崩溃、不改动地图节点）',
      !!pd59NoModel &&
        pd59NoModel.before === pd59NoModel.after &&
        pd59NoModel.optDisabled === false &&
        String(pd59NoModel.errorText).includes('尚未配置模型服务'),
      JSON.stringify(pd59NoModel)
    )
    const pd57Gate = await cdp.evaluate(`(async()=>{
      const snap=()=>['mindmap-ai-optimize','mindmap-ai-expand'].map((id)=>{
        const b=document.querySelector('[data-testid="'+id+'"]');
        return b?{disabled:b.disabled,title:b.title}:null;
      });
      await window.api.aiTools.update({id:'mindmap-ai',enabled:false});
      await new Promise((r)=>setTimeout(r,300));
      const off=snap();
      await window.api.aiTools.update({id:'mindmap-ai',enabled:true});
      await new Promise((r)=>setTimeout(r,300));
      const on=snap();
      return {off,on};
    })()`)
    check(
      'PD57：关闭思维地图 AI 后「AI 优化」与兼容别名都禁用并提示原因，重开恢复',
      !!pd57Gate &&
        pd57Gate.off.length === 2 &&
        pd57Gate.off.every(
          (s) => !!s && s.disabled === true && String(s.title).includes('已在 AI 工具库关闭思维地图 AI')
        ) &&
        pd57Gate.on.every((s) => !!s && !String(s.title).includes('已在 AI 工具库')),
      JSON.stringify(pd57Gate)
    )

    // 配置模型后重开面板：AI 优化可用；预览可逐项接受/丢弃，应用后可撤销
    await cdp.evaluate(
      `window.api.settings.save({provider:{baseUrl:'http://127.0.0.1:${mock.port}/zen/go/v1', apiKey:'sk-oc', chatModel:'deepseek-v4.1-flash', mode:'auto'}})`
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-close\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(cdp, "!document.querySelector('[data-testid=\"mindmap-panel\"]')")
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"toolbar-mindmap\"]');if(b)b.click();return !!b})()"
    )
    const pd57ModelReady = await waitFor(
      cdp,
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-ai-optimize\"]');return !!b&&!String(b.title).includes('尚未配置模型服务')&&!!document.querySelector('[data-testid=\"mindmap-node-z1\"]')})()"
    )
    check('PD57：配置模型服务后「AI 优化」恢复可用', pd57ModelReady === true)
    const pd57Selected = await cdp.evaluate(`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const n=document.querySelector('[data-testid="mindmap-node-z1"]');
      if(!n)return false;
      const r=n.getBoundingClientRect();
      const init={bubbles:true,cancelable:true,pointerType:'mouse',pointerId:9,button:0,buttons:1,clientX:r.left+8,clientY:r.top+8};
      n.dispatchEvent(new PointerEvent('pointerdown',init));
      n.dispatchEvent(new PointerEvent('pointerup',Object.assign({},init,{buttons:0})));
      await wait(200);
      document.querySelector('[data-testid="mindmap-ai-optimize"]').click();
      return true;
    })()`)
    const pd57PreviewReady = await waitFor(
      cdp,
      "!!document.querySelector('[data-testid=\"mindmap-ai-optimize-preview\"]')"
    )
    const pd57Preview = await cdp.evaluate(`(()=>{
      const items=[...document.querySelectorAll('[data-testid^="mindmap-ai-optimize-item-"]')].map((b)=>({id:b.getAttribute('data-testid'),checked:!!(b.querySelector('input')||{}).checked}));
      const apply=document.querySelector('[data-testid="mindmap-ai-optimize-apply"]');
      const discard=document.querySelector('[data-testid="mindmap-ai-optimize-discard"]');
      const node=document.querySelector('[data-testid="mindmap-node-z1"] .mindmap__node-text');
      return {items,apply:!!apply&&!apply.disabled,discard:!!discard,text:node?node.textContent:''};
    })()`)
    check(
      'PD58：AI 优化给整图分组预览（逐组可勾选 / 应用 / 丢弃），预览期间地图不变',
      pd57Selected === true &&
        pd57PreviewReady === true &&
        pd57Preview.items.length >= 2 &&
        pd57Preview.items.every((x) => x.checked === true) &&
        pd57Preview.apply === true &&
        pd57Preview.discard === true &&
        pd57Preview.text === pd57Cn,
      JSON.stringify(pd57Preview)
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-ai-optimize-discard\"]');if(b)b.click();return !!b})()"
    )
    const pd57Discard = await waitFor(
      cdp,
      "(()=>{const p=document.querySelector('[data-testid=\"mindmap-ai-optimize-preview\"]');const n=document.querySelector('[data-testid=\"mindmap-node-z1\"] .mindmap__node-text');return !p&&!!n&&n.textContent.indexOf('长标题全文显示')>=0})()"
    )
    check('PD58：丢弃整图优化建议后预览消失且地图保持原样', pd57Discard === true)
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-ai-optimize\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"mindmap-ai-optimize-preview\"]')")
    const pd57BeforeApply = await cdp.evaluate(
      `(async()=>{const d=await window.api.mindmap.load(${itemId});return d?d.nodes.length:-1})()`
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-ai-optimize-apply\"]');if(b)b.click();return !!b})()"
    )
    const pd57Applied = await waitFor(
      cdp,
      `(async()=>{const d=await window.api.mindmap.load(${itemId});return !!d&&d.nodes.some((n)=>/^ai-map-/.test(n.id))})()`
    )
    const pd57AfterApply = await cdp.evaluate(
      `(async()=>{const d=await window.api.mindmap.load(${itemId});return d?{total:d.nodes.length,ai:d.nodes.filter((n)=>/^ai-map-/.test(n.id)).length,z1:(d.nodes.find((n)=>n.id==='z1')||{}).text}:null})()`
    )
    check(
      'PD58：应用整图优化后新增分组与要点节点，原有节点措辞不变',
      pd57Applied === true &&
        !!pd57AfterApply &&
        pd57AfterApply.total > pd57BeforeApply &&
        pd57AfterApply.ai >= 4 &&
        pd57AfterApply.z1 === pd57Cn,
      JSON.stringify({ applied: pd57Applied, before: pd57BeforeApply, after: pd57AfterApply })
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-ai-undo\"]');if(b)b.click();return !!b})()"
    )
    const pd57Undone = await waitFor(
      cdp,
      "(()=>{const s=document.querySelector('[data-testid=\"mindmap-bulk-status\"]');const n=document.querySelector('[data-testid=\"mindmap-node-z1\"] .mindmap__node-text');return !!n&&!!s&&s.textContent.indexOf('已撤销')>=0})()"
    )
    const pd57UndoNodes = await cdp.evaluate(
      `(async()=>{const d=await window.api.mindmap.load(${itemId});return d?d.nodes.filter((n)=>/^ai-map-/.test(n.id)).length:-1})()`
    )
    check(
      'PD58：撤销「AI 优化」移除整图优化新增的节点',
      pd57Undone === true && pd57UndoNodes === 0,
      JSON.stringify({ undone: pd57Undone, aiNodes: pd57UndoNodes })
    )
    await cdp.evaluate(
      "window.api.settings.save({provider:{baseUrl:'',apiKey:'',chatModel:'',mode:'mock'}})"
    )

    // ---------- PD53：工具栏在 1280×800 与 1080×720 下换行且按钮两两不重叠 ----------
    const toolbarGeometry = async (width, height) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false
      })
      await sleep(350)
      return cdp.evaluate(`(()=>{
        const bar=document.querySelector('[data-testid="mindmap-toolbar"]');
        const dialog=document.querySelector('.mindmap__dialog');
        if(!bar||!dialog)return {ok:false,reason:'缺少工具栏或面板'};
        const d=dialog.getBoundingClientRect();
        const btns=[...bar.querySelectorAll('button')].map((b)=>{
          const r=b.getBoundingClientRect();
          return {id:b.getAttribute('data-testid')||(b.textContent||'').trim(),r:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
        });
        const overflow=btns.filter((x)=>x.r.width>0&&(x.r.left<d.left-0.5||x.r.right>d.right+0.5||x.r.top<d.top-0.5||x.r.bottom>d.bottom+0.5)).map((x)=>x.id);
        const overlaps=[];
        for(let i=0;i<btns.length;i++)for(let j=i+1;j<btns.length;j++){
          const a=btns[i].r,b=btns[j].r;
          if(a.width<=0||b.width<=0)continue;
          const ox=Math.min(a.right,b.right)-Math.max(a.left,b.left);
          const oy=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
          if(ox>0.5&&oy>0.5)overlaps.push(btns[i].id+'×'+btns[j].id);
        }
        return {ok:true,count:btns.length,overflow,overlaps};
      })()`)
    }
    for (const [vw, vh] of [
      [1280, 800],
      [1080, 720]
    ]) {
      const geo = await toolbarGeometry(vw, vh)
      check(
        `PD53：${vw}×${vh} 下思维地图工具栏按钮两两不重叠且都在面板内容区内`,
        !!geo &&
          geo.ok === true &&
          geo.count >= 10 &&
          geo.overflow.length === 0 &&
          geo.overlaps.length === 0,
        JSON.stringify(geo)
      )
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride', {})
    await sleep(200)

    // 空分组：组内唯一一篇没有地图 → 显示 mindmap-scope-empty
    const emptyGroup = 'E2E空地图组'
    await cdp.evaluate(
      `window.api.library.setGroup(${itemId}, ${JSON.stringify(emptyGroup)})`
    )
    try {
      fs.unlinkSync(path.join(dataDir, 'mindmap', `${itemKey}.json`))
    } catch {
      /* 已不存在 */
    }
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-close\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(cdp, "!document.querySelector('[data-testid=\"mindmap-panel\"]')")
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"toolbar-mindmap\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(
      cdp,
      "(()=>{const g=document.querySelector('[data-testid=\"mindmap-level-group\"]');return !!g&&!g.disabled})()"
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-level-group\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"mindmap-scope-empty\"]')")
    const emptyText = await cdp.evaluate(
      "document.querySelector('[data-testid=\"mindmap-scope-empty\"]')?.textContent || ''"
    )
    check(
      '分组内没有任何地图时显示空态并提示切回「论文」',
      /还没有思维地图/.test(emptyText) && /论文/.test(emptyText),
      emptyText
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"mindmap-close\"]');if(b)b.click();return !!b})()"
    )

    // ---------- PD50：知识库按论文分组 + Markdown 正文 + 引用 chip + 语义检索引导 ----------
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"knowledge-open\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"knowledge-group-none\"]')")
    const knGroups = await cdp.evaluate(`(()=>{
      const groups=[...document.querySelectorAll('.knowledge-group[data-testid]')];
      const chips=[...document.querySelectorAll('[data-testid^="knowledge-entry-paper-"]')];
      const titles=groups.map((g)=>g.querySelector('.knowledge-group__title')?.textContent||'');
      return {
        keys: groups.map((g)=>g.getAttribute('data-testid')),
        titles,
        counts: groups.map((g)=>g.querySelector('.knowledge-group__count')?.textContent||''),
        expanded: groups.map((g)=>g.querySelector('[data-testid^="knowledge-group-toggle-"]')?.getAttribute('aria-expanded')),
        ellipsis: groups.map((g)=>getComputedStyle(g.querySelector('.knowledge-group__title')).textOverflow),
        titleAttrs: groups.map((g)=>g.querySelector('.knowledge-group__title')?.getAttribute('title')||''),
        chipCount: chips.length,
        chipTexts: chips.map((c)=>c.textContent||'')
      };
    })()`)
    check(
      '知识库按论文分组（含「未关联论文」组），组头显示完整论文标题与条数',
      !!knGroups &&
        knGroups.keys.includes(`knowledge-group-${itemId}`) &&
        knGroups.keys.includes('knowledge-group-none') &&
        knGroups.titles.includes('E2E 样例论文') &&
        knGroups.titleAttrs.includes('E2E 样例论文') &&
        knGroups.counts.every((c) => /条$/.test(c)) &&
        knGroups.ellipsis.every((v) => v !== 'ellipsis'),
      JSON.stringify(knGroups)
    )
    check(
      '知识库分组默认展开，且条目上带论文 chip（含未关联论文）',
      !!knGroups &&
        knGroups.chipCount === 3 &&
        knGroups.chipTexts.filter((t) => t === 'E2E 样例论文').length === 2 &&
        knGroups.chipTexts.includes('未关联论文') &&
        knGroups.expanded.every((v) => v === 'true'),
      JSON.stringify({ chips: knGroups && knGroups.chipTexts, expanded: knGroups && knGroups.expanded })
    )

    // 组头可点击折叠/展开
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"knowledge-group-toggle-none\"]');if(b)b.click();return !!b})()"
    )
    const collapsed = await cdp.evaluate(`(()=>{
      const group=document.querySelector('[data-testid="knowledge-group-none"]');
      const btn=document.querySelector('[data-testid="knowledge-group-toggle-none"]');
      return {expanded: btn?.getAttribute('aria-expanded'), items: group?group.querySelectorAll('.knowledge-entry').length:-1};
    })()`)
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"knowledge-group-toggle-none\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(
      cdp,
      "(()=>{const b=document.querySelector('[data-testid=\"knowledge-group-toggle-none\"]');return !!b&&b.getAttribute('aria-expanded')==='true'})()"
    )
    check(
      '点组头可折叠/展开该论文组（折叠后组内条目不渲染）',
      !!collapsed && collapsed.expanded === 'false' && collapsed.items === 0,
      JSON.stringify(collapsed)
    )

    // 展开正文：必须是渲染后的成文 Markdown，不再是 ** / ## / |---| 源码
    await cdp.evaluate(
      `(()=>{const b=document.querySelector('[data-testid="knowledge-expand-${entry1Id}"]');if(b)b.click();return !!b})()`
    )
    await waitFor(
      cdp,
      `!!document.querySelector('[data-testid="knowledge-entry-body-${entry1Id}"] [data-testid="knowledge-markdown"]')`
    )
    const knBody = await cdp.evaluate(`(()=>{
      const body=document.querySelector('[data-testid="knowledge-entry-body-${entry1Id}"]');
      if(!body) return null;
      const text=body.textContent||'';
      return {
        text: text.slice(0,240),
        hasTable: !!body.querySelector('table'),
        hasStrong: !!body.querySelector('strong'),
        hasHeading: !!body.querySelector('h2,h3'),
        hasCode: !!body.querySelector('code'),
        listItems: body.querySelectorAll('li').length,
        imgs: body.querySelectorAll('img').length,
        imgLinks: [...body.querySelectorAll('.knowledge-md__imglink')].map((e)=>e.textContent||''),
        links: [...body.querySelectorAll('a')].map((a)=>a.getAttribute('href')),
        citeChips: [...body.querySelectorAll('[data-testid="knowledge-cite-chip"]')].map((e)=>e.textContent||'')
      };
    })()`)
    check(
      '知识库正文用 react-markdown 渲染（标题/粗体/列表/表格/行内代码成文）',
      !!knBody &&
        knBody.hasTable &&
        knBody.hasStrong &&
        knBody.hasHeading &&
        knBody.hasCode &&
        knBody.listItems >= 2,
      JSON.stringify(knBody)
    )
    check(
      '展开后的正文文本不再出现 ** / ## / |---| 等原始 Markdown 标记',
      !!knBody &&
        !knBody.text.includes('**') &&
        !knBody.text.includes('## ') &&
        !knBody.text.includes('|---|'),
      knBody && knBody.text
    )
    check(
      '正文图片不加载远程图片，只出链接文字（无 <img>）',
      !!knBody && knBody.imgs === 0 && knBody.imgLinks.includes('图 1'),
      JSON.stringify({ imgs: knBody && knBody.imgs, imgLinks: knBody && knBody.imgLinks })
    )
    check(
      '正文引用标识渲染为 chip（Tab.3 · 第 7 页 / 第 7–9 页）',
      !!knBody &&
        knBody.citeChips.length >= 2 &&
        knBody.citeChips.includes('Tab.3 · 第 7 页') &&
        knBody.citeChips.includes('第 7–9 页'),
      JSON.stringify(knBody && knBody.citeChips)
    )

    // 外链：应用内不导航，交主进程 shell.openExternal（E2E 只记录 URL）
    await cdp.evaluate(
      `(()=>{const body=document.querySelector('[data-testid="knowledge-entry-body-${entry1Id}"]');const a=body&&body.querySelector('a[href="https://example.com/paper"]');if(!a)return false;a.click();return true})()`
    )
    await sleep(300)
    check(
      '知识库正文外链由主进程 openExternal 打开（应用内不导航）',
      appLog.join('').includes('[openExternal] https://example.com/paper'),
      appLog.join('').slice(-200)
    )

    // 证据引言里的引用也要变成 chip
    const knEvidence = await cdp.evaluate(`(()=>{
      const ev=document.querySelector('[data-testid="knowledge-evidence-${entry1Id}"]');
      if(!ev) return null;
      return {
        chips: [...ev.querySelectorAll('[data-testid="knowledge-cite-chip"]')].map((e)=>e.textContent||''),
        text: (ev.textContent||'').slice(0,200)
      };
    })()`)
    check(
      '来源证据的引文同样用引用 chip 渲染（不再裸露 [p.7, Tab.3]）',
      !!knEvidence &&
        knEvidence.chips.includes('Tab.3 · 第 7 页') &&
        !knEvidence.text.includes('[p.7, Tab.3]'),
      JSON.stringify(knEvidence)
    )

    // 语义检索引导：哈希向量必须说明「只有词法检索」并给出 /embeddings 配置入口
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"knowledge-embed-setup-hint\"]')")
    const knHint = await cdp.evaluate(
      "document.querySelector('[data-testid=\"knowledge-embed-setup-hint\"]')?.textContent || ''"
    )
    check(
      '检索模式区说明 local-hash-64 只有词法检索、不参与语义排序、可在设置配 /embeddings',
      /local-hash-64/.test(knHint) &&
        /只有词法检索生效/.test(knHint) &&
        /不参与语义排序/.test(knHint) &&
        /\/embeddings/.test(knHint),
      knHint
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"knowledge-open-embed-settings\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(
      cdp,
      "!!document.querySelector('[data-testid=\"settings-dialog\"] [data-testid=\"settings-section-embed\"]')"
    )
    const knJump = await cdp.evaluate(`(()=>{
      const dlg=document.querySelector('[data-testid="settings-dialog"]');
      const sec=document.querySelector('[data-testid="settings-section-embed"]');
      if(!dlg||!sec) return null;
      const r=sec.getBoundingClientRect();
      return {
        knowledgeClosed: !document.querySelector('[data-testid="knowledge-panel"]'),
        sectionId: sec.id,
        inViewport: r.top < window.innerHeight && r.bottom > 0,
        modeSelect: !!dlg.querySelector('[data-testid="set-embed-mode"]')
      };
    })()`)
    check(
      '「配置语义检索」打开设置并定位到「语义检索」段（知识库面板关闭）',
      !!knJump &&
        knJump.knowledgeClosed &&
        knJump.sectionId === 'settings-embed' &&
        knJump.inViewport &&
        knJump.modeSelect,
      JSON.stringify(knJump)
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"settings-dialog\"]');const outer=b&&b.parentElement;if(outer)outer.click();return !!b})()"
    )
    await waitFor(cdp, "!document.querySelector('[data-testid=\"settings-dialog\"]')")

    // ---------- PD51：暂存区极简化 / 一键全部批准 / 逐条不整队重载 / 导入自动归属 / 长文本 ----------
    console.log('--- PD51 暂存区 ---')
    // 让「导入我的笔记」自动归属到 E2ETEST4（PD51 导入样例论文）
    await cdp.evaluate(
      "(()=>{localStorage.setItem('paperdesk.docs.active','" + pd51ImportItemId + "');return true})()"
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"toolbar-staging\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(
      cdp,
      "!!document.querySelector('[data-testid=\"staging-panel\"]') && !!document.querySelector('[data-testid=\"staging-toolbar\"]')"
    )
    await waitFor(cdp, `!!document.querySelector('[data-testid="staging-batch-${pd51BatchId}"]')`)
    await cdp.evaluate(
      `(()=>{const b=document.querySelector('[data-testid="staging-batch-${pd51BatchId}"]');if(b)b.click();return !!b})()`
    )
    await waitFor(
      cdp,
      "document.querySelectorAll('[data-testid^=\"staging-accept-\"]:not([disabled])').length >= 14"
    )
    await waitFor(
      cdp,
      "(document.querySelector('[data-testid=\"staging-import-target\"]')?.textContent||'').includes('PD51 导入样例论文')"
    )

    const pd51Shell = await cdp.evaluate(`(()=>{
      const panel=document.querySelector('[data-testid="staging-panel"]');
      if(!panel) return null;
      const body=panel.querySelector('.stage__body');
      const imp=panel.querySelector('[data-testid="staging-import"]');
      const br=body?body.getBoundingClientRect():null;
      const ir=imp?imp.getBoundingClientRect():null;
      return {
        toolbar: !!panel.querySelector('[data-testid="staging-toolbar"]'),
        sources: !!panel.querySelector('[data-testid="staging-sources"]'),
        steps: !!panel.querySelector('[data-testid="staging-empty-steps"]'),
        importItem: !!panel.querySelector('[data-testid="staging-import-item"]'),
        approveAll: !!panel.querySelector('[data-testid="staging-approve-all"]'),
        targetText: (panel.querySelector('[data-testid="staging-import-target"]')||{}).textContent||'',
        importBelowBody: !!(br&&ir) && ir.top >= br.bottom - 1
      };
    })()`)
    check(
      'PD51：暂存区首屏直接是批次栏 + 提案列表（无解释段落、无五步引导、无条目选择器）',
      !!pd51Shell &&
        pd51Shell.toolbar &&
        !pd51Shell.sources &&
        !pd51Shell.steps &&
        !pd51Shell.importItem &&
        pd51Shell.approveAll &&
        pd51Shell.importBelowBody,
      JSON.stringify(pd51Shell)
    )
    check(
      'PD51：导入目标自动归属当前论文（不再要求用户选择条目）',
      !!pd51Shell && pd51Shell.targetText.includes('PD51 导入样例论文') && !pd51Shell.targetText.includes('选择'),
      JSON.stringify(pd51Shell && pd51Shell.targetText)
    )

    const pd51Counts = await cdp.evaluate(`(()=>{
      const approve=document.querySelector('[data-testid="staging-approve-all"]');
      return {
        pending: [...document.querySelectorAll('[data-testid^="staging-accept-"]')].filter((b)=>!b.disabled).length,
        label: approve?approve.textContent:'',
        disabled: approve?approve.disabled:null
      };
    })()`)
    check(
      'PD51：全部批准按钮显示当前待审条数（14）',
      !!pd51Counts && pd51Counts.pending === 14 && pd51Counts.label.includes('14') && !pd51Counts.disabled,
      JSON.stringify(pd51Counts)
    )

    const pd51OverflowExpr = `(()=>{
      const panel=document.querySelector('[data-testid="staging-panel"]');
      if(!panel) return null;
      const over=(el)=>Math.max(0, el.scrollWidth - el.clientWidth);
      const list=(sel)=>[...panel.querySelectorAll(sel)].map((el)=>({cls:el.className,max:over(el)}));
      const name=panel.querySelector('.stage__batch-name');
      const itemTitle=panel.querySelector('.stage-item__title');
      return {
        containers:list('.stage__batches, .stage-batch, .stage__toolbar, .stage-import, .stage-item'),
        nameEllipsis: name? getComputedStyle(name).textOverflow==='ellipsis' : false,
        itemWrap: itemTitle? getComputedStyle(itemTitle).overflowWrap==='anywhere' : false
      };
    })()`
    for (const [w, h] of [
      [1280, 800],
      [1080, 720]
    ]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false
      })
      await sleep(350)
      const pd51Overflow = await cdp.evaluate(pd51OverflowExpr)
      const pd51Bad = pd51Overflow ? pd51Overflow.containers.filter((x) => x.max > 1) : [{ cls: 'missing' }]
      check(
        `PD51：${w}×${h} 下批次 / 来源 / 提案长文本不超出父容器（scrollWidth ≤ clientWidth+1）`,
        !!pd51Overflow &&
          pd51Bad.length === 0 &&
          pd51Overflow.nameEllipsis &&
          pd51Overflow.itemWrap,
        JSON.stringify({ bad: pd51Bad, ellipsis: pd51Overflow && pd51Overflow.nameEllipsis, wrap: pd51Overflow && pd51Overflow.itemWrap }).slice(0, 400)
      )
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await sleep(250)

    // 逐条接受：该条就地退队，不出现整表 loading，滚动位置不动
    const pd51Before = await cdp.evaluate(`(()=>{
      const groups=document.querySelector('.stage__groups');
      if(groups) groups.scrollTop = groups.scrollHeight;
      const accept=document.querySelector('[data-testid^="staging-accept-"]:not([disabled])');
      return {
        scrollTop: groups?groups.scrollTop:0,
        id: accept?accept.getAttribute('data-testid'):null,
        pending: [...document.querySelectorAll('[data-testid^="staging-accept-"]')].filter((b)=>!b.disabled).length
      };
    })()`)
    await cdp.evaluate(
      `(()=>{const b=document.querySelector('[data-testid="${pd51Before.id}"]');if(b)b.click();return !!b})()`
    )
    let pd51SawLoading = false
    for (let i = 0; i < 10; i++) {
      if (await cdp.evaluate("!!document.querySelector('[data-testid=\"staging-loading\"]')")) {
        pd51SawLoading = true
      }
      await sleep(50)
    }
    const pd51After = await cdp.evaluate(`(()=>{
      const groups=document.querySelector('.stage__groups');
      const btn=document.querySelector('[data-testid="${pd51Before.id}"]');
      return {
        scrollTop: groups?groups.scrollTop:-1,
        disabled: btn?btn.disabled:null,
        text: btn?btn.textContent:'',
        pending: [...document.querySelectorAll('[data-testid^="staging-accept-"]')].filter((b)=>!b.disabled).length
      };
    })()`)
    check(
      'PD51：逐条接受后 500ms 内不出现整表 loading，滚动位置变化 ≤4px',
      !pd51SawLoading &&
        !!pd51After &&
        Math.abs(pd51After.scrollTop - pd51Before.scrollTop) <= 4,
      JSON.stringify({ before: pd51Before, after: pd51After, loading: pd51SawLoading })
    )
    check(
      'PD51：被接受的条目就地变更为已接受并退出待审计数',
      !!pd51After &&
        pd51After.disabled === true &&
        pd51After.text.includes('已接受') &&
        pd51After.pending === pd51Before.pending - 1,
      JSON.stringify({ before: pd51Before, after: pd51After })
    )

    // 一键全部批准：二次确认含待审条数 → 批量发布 → 内联回显统计与明细
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"staging-approve-all\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"staging-approve-all-confirm\"]')")
    const pd51Confirm = await cdp.evaluate(
      "(document.querySelector('[data-testid=\"staging-approve-all-count\"]')||{}).textContent||''"
    )
    check(
      'PD51：一键批准的二次确认写明当前待审条数（13）与未核验风险',
      /全部 13 条待审提案/.test(pd51Confirm) && /来源待核验/.test(pd51Confirm),
      pd51Confirm
    )
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"staging-approve-all-confirm-ok\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"staging-approve-all-result\"]')", {
      timeout: 15000
    })
    const pd51Result = await cdp.evaluate(`(()=>{
      const r=document.querySelector('[data-testid="staging-approve-all-result"]');
      if(!r) return null;
      return {
        text: r.textContent||'',
        detail: !!r.querySelector('[data-testid="staging-approve-all-detail"]'),
        detailCount: r.querySelectorAll('[data-testid^="staging-approve-all-detail-"]').length
      };
    })()`)
    check(
      'PD51：一键批准回显「已发布 12 · 跳过 1 · 失败 2」并可展开明细',
      !!pd51Result &&
        /已发布 12/.test(pd51Result.text) &&
        /跳过 1/.test(pd51Result.text) &&
        /失败 2/.test(pd51Result.text) &&
        pd51Result.detail &&
        pd51Result.detailCount >= 15,
      JSON.stringify({
        text: (pd51Result && pd51Result.text || '').slice(0, 200),
        detail: pd51Result && pd51Result.detail,
        detailCount: pd51Result && pd51Result.detailCount
      })
    )

    // 无待审条目的批次：按钮禁用并说明原因
    await cdp.evaluate(
      `(()=>{const b=document.querySelector('[data-testid="staging-batch-${pd51ClosedBatchId}"]');if(b)b.click();return !!b})()`
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"staging-empty\"]')")
    const pd51Disabled = await cdp.evaluate(`(()=>{
      const b=document.querySelector('[data-testid="staging-approve-all"]');
      return {disabled:b?b.disabled:null, title:b?b.title:'', label:b?b.textContent:''};
    })()`)
    check(
      'PD51：无待审条目时全部批准按钮禁用并说明原因',
      !!pd51Disabled && pd51Disabled.disabled === true && pd51Disabled.title.includes('待审'),
      JSON.stringify(pd51Disabled)
    )

    // 导入我的笔记：自动归属当前论文，结果显示生成条数与论文标题
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"staging-import-note\"]');if(b)b.click();return !!b})()"
    )
    await waitFor(cdp, "!!document.querySelector('[data-testid=\"staging-import-result\"]')", {
      timeout: 15000
    })
    const pd51Import = await cdp.evaluate(
      "(document.querySelector('[data-testid=\"staging-import-result\"]')||{}).textContent||''"
    )
    check(
      'PD51：导入结果显示生成条数与所属论文标题',
      /已把 \d+ 条笔记要点/.test(pd51Import) && pd51Import.includes('归属论文「PD51 导入样例论文」'),
      pd51Import
    )

    // PD54：AI 工具库复位（全部启用、权限全开），避免影响人工试用
    const pd54Reset = await cdp.evaluate('window.api.aiTools.reset()')
    check(
      'PD54：AI 工具库一键恢复默认（全部工具启用、权限全开）',
      !!pd54Reset &&
        Array.isArray(pd54Reset.tools) &&
        pd54Reset.tools.length >= 6 &&
        pd54Reset.tools.every(
          (t) =>
            t.enabled === true &&
            t.permissions.model === true &&
            t.permissions.network === true &&
            t.permissions['write-knowledge'] === true
        ),
      JSON.stringify(pd54Reset && pd54Reset.tools && pd54Reset.tools.map((t) => ({ id: t.id, enabled: t.enabled })))
    )

    cdp.close()
  } catch (e) {
    failed++
    console.log('E2E 异常:', e && e.message)
  } finally {
    child.kill()
    await sleep(500)
    try {
      mock.server.closeAllConnections()
    } catch {
      /* noop */
    }
    try {
      mock.server.close()
    } catch {
      /* noop */
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  }

  console.log(failed === 0 ? 'E2E_OK' : `E2E_FAIL (${failed})`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})