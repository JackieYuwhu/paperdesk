// 诊断「左栏 UI 显示不全/被遮挡」：打开各功能面板，测量左栏与面板的宽度/滚动宽度并截图。
// 运行: node scripts/leftshot.cjs
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const PORT = 9414
const OUT = path.join(ROOT, '.shots-left')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makePdf() {
  const c =
    'BT /F1 20 Tf 72 720 Td (Attention Is All You Need) Tj ET\n' +
    'BT /F1 12 Tf 72 694 Td (Ashish Vaswani, Noam Shazeer, Niki Parmar) Tj ET\n' +
    'BT /F1 11 Tf 72 640 Td (The dominant sequence transduction models are based on complex recurrent) Tj ET\n' +
    'BT /F1 11 Tf 72 624 Td (or convolutional neural networks that include an encoder and a decoder.) Tj ET\n'
  const page = (c) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${c} >>`
  const stream = (s) => `<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}endstream`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    page('4 0 R'),
    stream(c),
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
    await sleep(400)
    const r = await send('Page.captureScreenshot', { format: 'png' })
    if (r.result && r.result.data) fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'))
  }
  return { evaluate, shot, close: () => ws.close() }
}

const METRICS = `(()=>{
  const app=document.querySelector('.app');
  const lp=document.querySelector('.leftpanels');
  const wraps=[...document.querySelectorAll('.leftpanels .panelwrap')];
  const visible=wraps.find(w=>w.style.display!=='none');
  const panel=visible?visible.querySelector('.panel, .notes'):null;
  const over=[];
  if(panel){
    for(const el of panel.querySelectorAll('*')){
      const r=el.getBoundingClientRect();
      if(r.width>0 && (r.right > panel.getBoundingClientRect().right + 1 || r.left < panel.getBoundingClientRect().left - 1)){
        over.push({tag:el.tagName, cls:(el.className||'').toString().slice(0,40), left:Math.round(r.left), right:Math.round(r.right)});
        if(over.length>=6) break;
      }
    }
  }
  return {
    win: window.innerWidth,
    col1: app ? Math.round(app.children[0].getBoundingClientRect().width) : null,
    lpClient: lp?lp.clientWidth:null, lpScroll: lp?lp.scrollWidth:null,
    panelClient: panel?panel.clientWidth:null, panelScroll: panel?panel.scrollWidth:null,
    overflow: over
  }})()`

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paperdesk-left-'))
  const dataDir = path.join(tmp, 'data')
  const itemKey = 'LEFTITEM'
  const attKey = 'LEFTATT1'
  fs.mkdirSync(path.join(dataDir, 'storage', itemKey), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'storage', itemKey, 'attention.pdf'), makePdf())
  fs.mkdirSync(path.join(dataDir, 'notes'), { recursive: true })
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
  db.close()

  const child = spawn(require('electron'), [`--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`, '.'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  try {
    const cdp = await connect(PORT)
    for (let i = 0; i < 60; i++) {
      const n = await cdp.evaluate("document.querySelectorAll('.textLayer span').length")
      if (n > 0) break
      await sleep(250)
    }
    const click = (tid) =>
      `(()=>{const b=document.querySelector('[data-testid="${tid}"]');if(!b)return false;b.click();return true})()`
    await cdp.evaluate("document.querySelector('[data-testid=\"sb-expand\"]')?.click()")
    for (const p of ['notes', 'meta', 'analysis', 'translate', 'ai', 'discovery']) {
      const ok = await cdp.evaluate(click(`panel-tab-${p}`))
      await sleep(500)
      const m = await cdp.evaluate(METRICS)
      console.log(`panel ${p} ok=${ok}`, JSON.stringify(m))
      await cdp.shot(`panel-${p}.png`)
    }
    cdp.close()
  } catch (e) {
    console.log('LEFT_ERROR', e && e.message)
  } finally {
    child.kill()
    await sleep(400)
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  }
  console.log('LEFT_DONE ->', OUT)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
