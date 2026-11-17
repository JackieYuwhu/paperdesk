// 复现「切到原文后页码在 1..N 疯狂切换」：原文 12 页、译文 4 页。
// 运行: node scripts/flicker.cjs
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const PORT = 9416
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makePdf(pages, heading) {
  const objs = []
  const pageObjs = []
  const streams = []
  for (let i = 0; i < pages; i++) {
    streams.push(
      `BT /F1 20 Tf 72 720 Td (${heading} - page ${i + 1}) Tj ET\n` +
        `BT /F1 11 Tf 72 680 Td (Body line one on page ${i + 1} of the document.) Tj ET\n` +
        `BT /F1 11 Tf 72 660 Td (Body line two on page ${i + 1} of the document.) Tj ET\n`
    )
  }
  // 布局: 1 catalog, 2 pages, then per page: page obj + content obj, then font
  const kids = []
  for (let i = 0; i < pages; i++) kids.push(`${3 + i * 2} 0 R`)
  objs.push('<< /Type /Catalog /Pages 2 0 R >>')
  objs.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`)
  for (let i = 0; i < pages; i++) {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`
    )
    const s = streams[i]
    objs.push(`<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}endstream`)
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
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

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px/1.7 system-ui;margin:24px}</style></head><body><h1>译文</h1><p>测试段落。</p></body></html>`

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
      return
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => a.value ?? '').join(' ')
      if (String(text).includes('[pd]')) console.log('   LOG', text)
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
      fs.mkdirSync(path.join(ROOT, '.shots-flicker'), { recursive: true })
      fs.writeFileSync(path.join(ROOT, '.shots-flicker', name), Buffer.from(r.result.data, 'base64'))
    }
  }
  return { send, evaluate, shot, close: () => ws.close() }
}

const SAMPLE = `(()=>{
  const lbl = (document.querySelector('[data-testid="toolbar-page-label"]')||{}).textContent||''
  const tops = [...document.querySelectorAll('.scrollpages')].map(p=>Math.round(p.scrollTop))
  const canv = document.querySelectorAll('.viewer canvas').length
  return {lbl: lbl.trim(), tops, canv}
})()`

async function sampleFor(cdp, label, ms) {
  const seen = []
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const s = await cdp.evaluate(SAMPLE)
    const key = JSON.stringify(s)
    if (seen.length === 0 || JSON.stringify(seen[seen.length - 1]) !== key) {
      seen.push(s)
    }
    await sleep(120)
  }
  console.log(`--- ${label}: ${seen.length} distinct states ---`)
  for (const s of seen.slice(0, 25)) console.log('   ', JSON.stringify(s))
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paperdesk-flicker-'))
  const dataDir = path.join(tmp, 'data')
  const itemKey = 'FLKITEM'
  const attKey = 'FLKATT1'
  fs.mkdirSync(path.join(dataDir, 'storage', itemKey), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'storage', itemKey, 'orig.pdf'), makePdf(12, 'Original Paper'))
  fs.mkdirSync(path.join(dataDir, 'translated'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'translated', 'tr1.pdf'), makePdf(4, '译文'))
  fs.writeFileSync(path.join(dataDir, 'translated', 'tr1.html'), HTML)
  fs.writeFileSync(path.join(dataDir, 'translated', 'tr1.bi.html'), HTML)
  const schema = fs.readFileSync(path.join(ROOT, 'src', 'main', 'db', 'schema.sql'), 'utf8')
  const db = new DatabaseSync(path.join(dataDir, 'library.sqlite'))
  db.exec(schema)
  const ts = new Date().toISOString()
  db.prepare('INSERT INTO items (key,doi,title,year,venue,type,date_added,date_modified) VALUES (?,?,?,?,?,?,?,?)').run(
    itemKey, '10.9999/flk', 'Original Paper', 2024, 'NeurIPS', 'conference', ts, ts
  )
  const itemId = db.prepare('SELECT id FROM items WHERE key=?').get(itemKey).id
  db.prepare('INSERT INTO attachments (key,item_id,path,filename,content_type,date_added) VALUES (?,?,?,?,?,?)').run(
    attKey, itemId, ['storage', itemKey, 'orig.pdf'].join('/'), 'orig.pdf', 'application/pdf', ts
  )
  const attId = db.prepare('SELECT id FROM attachments WHERE key=?').get(attKey).id
  db.prepare(
    'INSERT INTO translations (key,attachment_id,lang,path,html_path,bilingual_path,engine,backend,status,date_added) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run('TR1', attId, 'zh', 'tr1.pdf', 'tr1.html', 'tr1.bi.html', 'mock', 'mock', 'done', ts)
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
    await cdp.evaluate('window.__pdLog = true')
    console.log('enter 中英对照:', await cdp.evaluate(click('view-bilingual')))
    await sleep(1500)
    // 用工具栏「下一页」翻到第 4 页（让 App 的 readPage 真正变成 4），再切到原文
    for (let i = 0; i < 3; i++) {
      await cdp.evaluate("document.querySelector('[data-testid=\"toolbar-page-next\"]')?.click()")
      await sleep(350)
    }
    await sleep(800)
    await sampleFor(cdp, '中英对照(第4页)', 800)
    await cdp.shot('01-bilingual.png')
    // 快速翻页：连点「下一页」，并在过程中高频采样（捕捉瞬态闪烁）
    const rapid = []
    for (let i = 0; i < 10; i++) {
      await cdp.evaluate("document.querySelector('[data-testid=\"toolbar-page-next\"]')?.click()")
      for (let k = 0; k < 3; k++) {
        rapid.push(await cdp.evaluate(SAMPLE))
        await sleep(45)
      }
    }
    for (let k = 0; k < 20; k++) {
      rapid.push(await cdp.evaluate(SAMPLE))
      await sleep(60)
    }
    const uniq = []
    for (const s of rapid) {
      const key = JSON.stringify(s)
      if (uniq.length === 0 || JSON.stringify(uniq[uniq.length - 1]) !== key) uniq.push(s)
    }
    console.log(`--- 快速翻页（${uniq.length} distinct states）---`)
    for (const s of uniq.slice(0, 40)) console.log('   ', JSON.stringify(s))
    await cdp.shot('01b-after-rapid.png')

    // 连续滚动（模拟滚轮）跨页：左侧 scrollTop 应单调递增，不应被"跳页"拉回（抖动/闪烁）
    await cdp.evaluate(
      "(()=>{const p=document.querySelectorAll('.compare__pane')[0];const L=p&&p.querySelector('.scrollpages');if(L){L.scrollTop=0;L.dispatchEvent(new Event('scroll'))}})()"
    )
    await sleep(800)
    const scrollStates = []
    for (let step = 0; step < 26; step++) {
      await cdp.evaluate(
        "(()=>{const p=document.querySelectorAll('.compare__pane')[0];const L=p&&p.querySelector('.scrollpages');if(L){L.scrollTop += 240;L.dispatchEvent(new Event('scroll'))}})()"
      )
      scrollStates.push(await cdp.evaluate(SAMPLE))
      await sleep(70)
    }
    const uniqS = []
    for (const s of scrollStates) {
      const k = JSON.stringify(s)
      if (!uniqS.length || JSON.stringify(uniqS[uniqS.length - 1]) !== k) uniqS.push(s)
    }
    const leftTops = uniqS.map((s) => (s.tops && s.tops[0]) || 0)
    let drops = 0
    for (let i = 1; i < leftTops.length; i++) if (leftTops[i] < leftTops[i - 1] - 4) drops++
    console.log(`--- 连续滚动（${uniqS.length} states，左栏回退次数=${drops}）---`)
    for (const s of uniqS.slice(0, 40)) console.log('   ', JSON.stringify(s))
    await cdp.shot('01c-after-scroll.png')
    console.log('switch 原文:', await cdp.evaluate(click('view-original')))
    await sampleFor(cdp, '原文(切换后 6s)', 6000)
    await cdp.shot('02-original.png')
    console.log('switch 回 中英对照:', await cdp.evaluate(click('view-bilingual')))
    await sampleFor(cdp, '中英对照(再切回 4s)', 4000)
    cdp.close()
  } catch (e) {
    console.log('FLICKER_ERROR', e && e.message)
  } finally {
    child.kill()
    await sleep(400)
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  }
  console.log('FLICKER_DONE')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
