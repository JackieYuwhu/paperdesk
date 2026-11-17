// 用 CDP 给各界面截图，便于人工评估 UI。运行: node scripts/shot.cjs
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const PORT = 9412
const OUT = path.join(ROOT, '.shots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makePdf() {
  const c1 =
    'BT /F1 22 Tf 72 720 Td (Attention Is All You Need) Tj ET\n' +
    'BT /F1 12 Tf 72 694 Td (Ashish Vaswani, Noam Shazeer, Niki Parmar) Tj ET\n' +
    'BT /F1 11 Tf 72 640 Td (The dominant sequence transduction models are based on complex recurrent) Tj ET\n' +
    'BT /F1 11 Tf 72 624 Td (or convolutional neural networks that include an encoder and a decoder.) Tj ET\n' +
    'BT /F1 14 Tf 72 560 Td (1  Introduction) Tj ET\n' +
    'BT /F1 11 Tf 72 536 Td (Recurrent neural networks, long short-term memory and gated recurrent) Tj ET\n' +
    'BT /F1 11 Tf 72 520 Td (neural networks in particular, have been firmly established as state of) Tj ET\n'
  const c2 =
    'BT /F1 14 Tf 72 700 Td (References) Tj ET\n' +
    'BT /F1 11 Tf 72 670 Td ([1] He K, Zhang X. Deep Residual Learning for Image Recognition. 2016.) Tj ET\n' +
    'BT /F1 11 Tf 72 648 Td ([2] Vaswani A. Attention Is All You Need. NeurIPS, 2017.) Tj ET\n'
  const page = (c) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${c} >>`
  const stream = (s) => `<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}endstream`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    page('4 0 R'),
    stream(c1),
    page('6 0 R'),
    stream(c2),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Title (Attention Is All You Need) /Author (Ashish Vaswani; Noam Shazeer) >>'
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

function startMockOpenAlex() {
  const mk = (id, name, year, citedBy) => ({
    id: `https://openalex.org/${id}`,
    doi: `https://doi.org/10.9999/${id.toLowerCase()}`,
    display_name: name,
    publication_year: year,
    cited_by_count: citedBy,
    primary_location: { source: { display_name: 'NeurIPS' } }
  })
  const SEED = 'WSEED0001'
  const works = {
    [SEED]: {
      ...mk(SEED, 'Attention Is All You Need', 2017, 100000),
      referenced_works: ['https://openalex.org/WREF0001', 'https://openalex.org/WREF0002'],
      related_works: ['https://openalex.org/WREL0001']
    },
    WREF0001: mk('WREF0001', 'Deep Residual Learning for Image Recognition', 2016, 180000),
    WREF0002: mk('WREF0002', 'BERT: Pre-training of Deep Bidirectional Transformers', 2019, 90000),
    WREL0001: mk('WREL0001', 'An Image is Worth 16x16 Words: Transformers for Image Recognition', 2021, 60000),
    WCITE0001: mk('WCITE0001', 'Scaling Laws for Neural Language Models', 2020, 9000)
  }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const filter = u.searchParams.get('filter') || ''
    let results = []
    if (u.pathname.startsWith('/works/doi:')) results = [works[SEED]]
    else if (filter.startsWith('openalex_id:'))
      results = filter
        .slice('openalex_id:'.length)
        .split('|')
        .map((id) => works[id])
        .filter(Boolean)
    else if (filter.startsWith('cites:')) results = [works.WCITE0001]
    else if (u.searchParams.get('search')) results = [works[SEED]]
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ meta: { count: results.length }, results }))
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  )
}

async function connect(port) {
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
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = (e) => rej(new Error(String(e.message)))
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
  await send('Page.enable', {})
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    return r.result && r.result.result ? r.result.result.value : undefined
  }
  const shot = async (name) => {
    await sleep(500)
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    if (!data) return console.log('  shot FAIL', name)
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'))
    console.log('  shot', name)
  }
  const clickText = (sel, text) =>
    `(()=>{const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!el)return false;el.click();return true})()`
  return { send, evaluate, shot, clickText, close: () => ws.close() }
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paperdesk-shot-'))
  const dataDir = path.join(tmp, 'data')
  const itemKey = 'SHOTITEM'
  const attKey = 'SHOTATT1'
  fs.mkdirSync(path.join(dataDir, 'storage', itemKey), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'storage', itemKey, 'attention.pdf'), makePdf())
  fs.mkdirSync(path.join(dataDir, 'notes'), { recursive: true })

  const schema = fs.readFileSync(path.join(ROOT, 'src', 'main', 'db', 'schema.sql'), 'utf8')
  const db = new DatabaseSync(path.join(dataDir, 'library.sqlite'))
  db.exec(schema)
  const ts = new Date().toISOString()
  db.prepare('INSERT INTO items (key,doi,title,year,venue,type,date_added,date_modified) VALUES (?,?,?,?,?,?,?,?)').run(
    itemKey, '10.9999/attention', 'Attention Is All You Need', 2017, 'NeurIPS', 'conference', ts, ts
  )
  const itemId = db.prepare('SELECT id FROM items WHERE key=?').get(itemKey).id
  db.prepare('INSERT INTO attachments (key,item_id,path,filename,content_type,date_added) VALUES (?,?,?,?,?,?)').run(
    attKey, itemId, ['storage', itemKey, 'attention.pdf'].join('/'), 'attention.pdf', 'application/pdf', ts
  )
  const attId = db.prepare('SELECT id FROM attachments WHERE key=?').get(attKey).id
  db.prepare('INSERT INTO authors (display_name,orcid) VALUES (?,?)').run('Ashish Vaswani', null)
  const authorId = db.prepare('SELECT id FROM authors WHERE display_name=?').get('Ashish Vaswani').id
  db.prepare('INSERT INTO item_authors (item_id,author_id,position) VALUES (?,?,0)').run(itemId, authorId)
  const addAnn = db.prepare(
    `INSERT INTO annotations (key,attachment_id,type,text,comment,color,page_index,position,sort_index,date_added,date_modified) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
  addAnn.run('ANNHI1', attId, 'highlight', 'The dominant sequence transduction models', '经典 RNN/CNN 基线', '#ffd400', 0, JSON.stringify({ pageIndex: 0, rects: [[72, 630, 520, 646]] }), '640', ts, ts)
  addAnn.run('ANNUL1', attId, 'underline', 'Recurrent neural networks', null, '#7cc4ff', 0, JSON.stringify({ pageIndex: 0, rects: [[72, 526, 340, 540]] }), '536', ts, ts)
  db.prepare('INSERT INTO citations (source_item_id,ref_index,target_raw,resolved) VALUES (?,1,?,0)').run(itemId, '[1] He K. Deep Residual Learning. 2016.')
  db.prepare('INSERT INTO citations (source_item_id,ref_index,target_raw,resolved) VALUES (?,2,?,0)').run(itemId, '[2] Vaswani A. Attention Is All You Need. 2017.')
  const noteBody =
    '# 阅读笔记\n\n' +
    '## 核心贡献\n\n' +
    '- 提出 **Transformer**，完全基于注意力，去掉循环与卷积\n' +
    '- 训练更快、可并行\n\n' +
    '> **高亮**：The dominant sequence transduction models\n> — p.1 [↗ 原文](paperdesk://open?attachment=' + attKey + '&page=1)\n'
  db.prepare('INSERT INTO notes (key,item_id,title,md_path,date_added,date_modified) VALUES (?,?,?,?,?,?)').run(
    'SHOTNOTE', itemId, 'Attention Is All You Need - 阅读笔记', 'notes/SHOTNOTE.md', ts, ts
  )
  const noteId = db.prepare('SELECT id FROM notes WHERE key=?').get('SHOTNOTE').id
  fs.writeFileSync(path.join(dataDir, 'notes', 'SHOTNOTE.md'), noteBody)
  db.prepare('INSERT INTO notes_fts (rowid,title,body) VALUES (?,?,?)').run(noteId, 'Attention - 阅读笔记', noteBody)
  db.prepare('INSERT INTO chunks (attachment_id,page_index,text) VALUES (?,0,?)').run(attId, 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder.')
  db.prepare('INSERT INTO chunks (attachment_id,page_index,text) VALUES (?,0,?)').run(attId, 'Recurrent neural networks, long short-term memory and gated recurrent neural networks in particular, have been firmly established as state of the art.')
  db.close()

  const mock = await startMockOpenAlex()
  const child = spawn(
    require('electron'),
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`, '.'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PAPERDESK_OPENALEX_BASE: `http://127.0.0.1:${mock.port}` } }
  )
  child.stdout.on('data', (d) => process.stdout.write('[app] ' + d))

  try {
    const cdp = await connect(PORT)
    for (let i = 0; i < 60; i++) {
      const n = await cdp.evaluate("document.querySelectorAll('.textLayer span').length")
      if (n > 0) break
      await sleep(250)
    }
    await cdp.shot('01-notes-light.png')

    // 划词翻译
    await cdp.evaluate(
      "(()=>{const tl=document.querySelector('.textLayer');if(!tl)return false;const spans=tl.querySelectorAll('span');if(spans.length<2)return false;const r=document.createRange();r.setStartBefore(spans[0]);r.setEndAfter(spans[2]||spans[1]);const s=getSelection();s.removeAllRanges();s.addRange(r);tl.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return true})()"
    )
    await sleep(2600)
    await cdp.shot('01b-lookup.png')
    await cdp.evaluate("window.getSelection().removeAllRanges()")

    await cdp.evaluate(cdp.clickText('.rightcol__tabs button', '元数据'))
    await cdp.evaluate(cdp.clickText('.panel button', '识别元数据'))
    await sleep(6000)
    await cdp.shot('02-metadata.png')

    await cdp.evaluate(cdp.clickText('.rightcol__tabs button', '相关论文'))
    await cdp.evaluate(cdp.clickText('.panel button', '查找相关论文'))
    await sleep(3000)
    await cdp.shot('03-discovery.png')

    await cdp.evaluate(cdp.clickText('.rightcol__tabs button', '问答'))
    await cdp.evaluate(
      "(()=>{const el=document.querySelector('[data-testid=\"ai-input\"]');if(!el)return false;const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(proto,'value').set;set.call(el,'recurrent neural networks');el.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-testid=\"ai-ask\"]').click();return true})()"
    )
    await sleep(1500)
    await cdp.shot('04-ai.png')

    // 批处理面板
    await cdp.evaluate(cdp.clickText('.rightcol__tabs button', '批处理'))
    await sleep(500)
    const setSel = (sel, val) =>
      `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(el,${JSON.stringify(val)});el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`
    await cdp.evaluate(setSel('[data-testid="batch-task"]', 'export-doc'))
    await sleep(300)
    await cdp.evaluate("document.querySelector('[data-testid=\"batch-create\"]').click()")
    await sleep(5000)
    await cdp.shot('04b-batch.png')

    await cdp.evaluate(setSel('[data-testid="batch-task"]', 'decompose'))
    await sleep(600)
    await cdp.shot('04c-batch-template.png')

    await cdp.evaluate(cdp.clickText('.rightcol__tabs button', '翻译'))
    await sleep(600)
    await cdp.shot('04d-translate.png')
    await cdp.evaluate("document.querySelector('[data-testid=\"translate-run\"]')?.click()")
    await cdp.shot('04e-translate-loading.png')
    await sleep(7000)
    await cdp.shot('04f-translate-html.png')

    await cdp.evaluate("document.querySelector('[data-testid=\"open-settings\"]').click()")
    await sleep(600)
    await cdp.shot('05-settings-light.png')

    // 切深色
    await cdp.evaluate(
      "(()=>{const el=document.querySelector('[data-testid=\"set-theme\"]');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(el,'dark');el.dispatchEvent(new Event('change',{bubbles:true}));return true})()"
    )
    await sleep(600)
    await cdp.shot('06-settings-dark.png')
    await cdp.evaluate("document.querySelector('[data-testid=\"set-save\"]').click()")
    await sleep(300)
    await cdp.evaluate(cdp.clickText('.modal button', '') || 'true')
    await cdp.evaluate("document.querySelector('.modal') && document.querySelector('.modal__head button').click()")
    await cdp.evaluate(cdp.clickText('.rightcol__tabs button', '相关论文'))
    await sleep(800)
    await cdp.shot('07-dark-discovery.png')
    await cdp.evaluate(cdp.clickText('.rightcol__tabs button', '笔记'))
    await sleep(600)
    await cdp.shot('08-dark-notes.png')
    cdp.close()
  } catch (e) {
    console.log('SHOT_ERROR', e && e.message)
  } finally {
    child.kill()
    await sleep(400)
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
  console.log('SHOTS_DONE ->', OUT)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
