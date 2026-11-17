// 复现「快速切换 原文/译文/对照/网页 时跳出奇怪界面」：
// 预置一篇论文 + 一个译文（含 HTML/双语），然后快速点各视图并抓取 DOM/控制台状态。
// 运行: node scripts/modes.cjs
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const PORT = 9413
const OUT = path.join(ROOT, '.shots-modes')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makePdf(heading) {
  const c1 =
    `BT /F1 20 Tf 72 720 Td (${heading}) Tj ET\n` +
    'BT /F1 12 Tf 72 694 Td (Ashish Vaswani, Noam Shazeer, Niki Parmar) Tj ET\n' +
    'BT /F1 11 Tf 72 640 Td (The dominant sequence transduction models are based on complex recurrent) Tj ET\n' +
    'BT /F1 11 Tf 72 624 Td (or convolutional neural networks that include an encoder and a decoder.) Tj ET\n' +
    'BT /F1 14 Tf 72 560 Td (1  Introduction) Tj ET\n'
  const c2 =
    'BT /F1 14 Tf 72 700 Td (References) Tj ET\n' +
    'BT /F1 11 Tf 72 670 Td ([1] He K, Zhang X. Deep Residual Learning. 2016.) Tj ET\n'
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
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
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
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:15px/1.7 system-ui;max-width:760px;margin:24px auto;padding:0 16px}
h1{font-size:22px}.pg{margin:0 0 18px}.pgno{color:#888;font-size:12px}
</style></head><body>
<h1>Attention Is All You Need（译文）</h1>
<div class="pg"><div class="pgno">p.1</div>占主导地位的序列转换模型基于复杂的循环或卷积神经网络，包含编码器与解码器。</div>
<div class="pg"><div class="pgno">p.2</div>参考文献。</div>
</body></html>`

async function connect(port, logs) {
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
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const type = m.params.type
      const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
      if (type === 'error' || type === 'warning') logs.push(`${type}: ${text}`)
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('exception: ' + (m.params.exceptionDetails?.exception?.description || ''))
    }
  }
  const send = (method, params) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Page.enable', {})
  await send('Runtime.enable', {})
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    return r.result && r.result.result ? r.result.result.value : undefined
  }
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'))
    }
  }
  return { evaluate, shot, close: () => ws.close() }
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paperdesk-modes-'))
  const dataDir = path.join(tmp, 'data')
  const itemKey = 'MODEITEM'
  const attKey = 'MODEATT1'
  fs.mkdirSync(path.join(dataDir, 'storage', itemKey), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'storage', itemKey, 'attention.pdf'), makePdf('Attention Is All You Need'))
  // 译文：直接用同一份 PDF + 一份自包含 HTML，避免跑模型
  fs.mkdirSync(path.join(dataDir, 'translated'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'translated', 'tr1.pdf'), makePdf('Attention Is All You Need (ZH)'))
  fs.writeFileSync(path.join(dataDir, 'translated', 'tr1.html'), HTML)
  fs.writeFileSync(path.join(dataDir, 'translated', 'tr1.bi.html'), HTML)

  const schema = fs.readFileSync(path.join(ROOT, 'src', 'main', 'db', 'schema.sql'), 'utf8')
  const db = new DatabaseSync(path.join(dataDir, 'library.sqlite'))
  db.exec(schema)
  const ts = new Date().toISOString()
  db.prepare('INSERT INTO items (key,doi,title,abstract,year,venue,type,date_added,date_modified) VALUES (?,?,?,?,?,?,?,?,?)').run(
    itemKey, '10.9999/attention', 'Attention Is All You Need', 'The dominant sequence transduction models.', 2017, 'NeurIPS', 'conference', ts, ts
  )
  const itemId = db.prepare('SELECT id FROM items WHERE key=?').get(itemKey).id
  db.prepare('INSERT INTO attachments (key,item_id,path,filename,content_type,date_added) VALUES (?,?,?,?,?,?)').run(
    attKey, itemId, ['storage', itemKey, 'attention.pdf'].join('/'), 'attention.pdf', 'application/pdf', ts
  )
  const attId = db.prepare('SELECT id FROM attachments WHERE key=?').get(attKey).id
  db.prepare(
    'INSERT INTO translations (key,attachment_id,lang,path,html_path,bilingual_path,engine,backend,status,date_added) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run('TR1', attId, 'zh', 'tr1.pdf', 'tr1.html', 'tr1.bi.html', 'mock', 'mock', 'done', ts)
  db.close()

  const logs = []
  const child = spawn(
    require('electron'),
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`, '.'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } }
  )
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  const stateExpr = `(()=>{
    const q=(s)=>!!document.querySelector(s);
    return {
      original: q('.textLayer span'),
      compare: q('[data-testid="compare-view"]'),
      html: q('[data-testid="html-view"]'),
      error: q('[data-testid="error-boundary"]'),
      loading: !!document.querySelector('.viewer .empty .spinner'),
      emptyText: (document.querySelector('.viewer .empty span:last-child')||{}).textContent||'',
      panes: document.querySelectorAll('.viewer .compare__pane').length,
      canvases: document.querySelectorAll('.viewer canvas').length
    }})()`

  try {
    const cdp = await connect(PORT, logs)
    for (let i = 0; i < 60; i++) {
      const n = await cdp.evaluate("document.querySelectorAll('.textLayer span').length")
      if (n > 0) break
      await sleep(250)
    }
    const click = (testid) =>
      `(()=>{const b=document.querySelector('[data-testid="${testid}"]');if(!b||b.disabled)return false;b.click();return true})()`

    const seq = [
      'view-translate-pdf-unused',
      'view-split',
      'view-html',
      'view-pdf',
      'view-split',
      'view-original',
      'view-html',
      'view-original',
      'view-pdf',
      'view-split'
    ]
    // 实际按钮：view-original / view-bilingual / view-html
    const real = ['view-bilingual', 'view-html', 'view-original', 'view-bilingual', 'view-html', 'view-original', 'view-bilingual']

    let step = 0
    for (const t of real) {
      const ok = await cdp.evaluate(click(t))
      step++
      const immediate = await cdp.evaluate(stateExpr)
      await sleep(220)
      const settled = await cdp.evaluate(stateExpr)
      await cdp.shot(`step-${String(step).padStart(2, '0')}-${t.replace('view-', '')}.png`)
      console.log(`#${step} click ${t} ok=${ok}`)
      console.log('   immediate:', JSON.stringify(immediate))
      console.log('   settled  :', JSON.stringify(settled))
    }
    console.log('--- console errors/warnings ---')
    for (const l of logs.slice(0, 40)) console.log('  ' + l)
    console.log('logs total =', logs.length)
    cdp.close()
  } catch (e) {
    console.log('MODES_ERROR', e && e.message)
  } finally {
    child.kill()
    await sleep(400)
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  }
  console.log('MODES_DONE ->', OUT)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
