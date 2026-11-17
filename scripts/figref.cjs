// 验证「点击 Fig. 1 引用 → 弹出图表小窗」：原文含图表题注与正文引用。
// 运行: node scripts/figref.cjs
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const PORT = 9417
const OUT = path.join(ROOT, '.shots-figref')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makePdf() {
  const c =
    'BT /F1 20 Tf 72 740 Td (A Paper With Figures) Tj ET\n' +
    'BT /F1 12 Tf 72 700 Td (Alice Zhang, Bob Li) Tj ET\n' +
    'BT /F1 11 Tf 72 660 Td (The results are shown in Fig. 1 and Table 2 below.) Tj ET\n' +
    'BT /F1 7 Tf 300 668 Td (1) Tj ET\n' + // 上标角标
    'BT /F1 8 Tf 72 60 Td (1 This is the footnote text at the bottom.) Tj ET\n' +
    '1 0 0 RG 4 w 72 330 m 500 330 l 500 560 l 72 560 l s\n' + // 图形框
    'BT /F1 11 Tf 72 500 Td (PLOT AREA) Tj ET\n' +
    'BT /F1 10 Tf 72 300 Td (Fig. 1 | Example figure caption describing the plot.) Tj ET\n' +
    'BT /F1 10 Tf 72 200 Td (Fig. 2 | Second figure caption.) Tj ET\n' +
    'BT /F1 11 Tf 72 240 Td (Body text after the figure.) Tj ET\n'
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
    if (r.result && r.result.data) {
      fs.mkdirSync(OUT, { recursive: true })
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'))
    }
  }
  return { send, evaluate, shot, close: () => ws.close() }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paperdesk-figref-'))
  const dataDir = path.join(tmp, 'data')
  const itemKey = 'FIGITEM'
  const attKey = 'FIGATT1'
  fs.mkdirSync(path.join(dataDir, 'storage', itemKey), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'storage', itemKey, 'fig.pdf'), makePdf())
  fs.mkdirSync(path.join(dataDir, 'translated'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'translated', 'fig.pdf'), makePdf())
  fs.writeFileSync(
    path.join(dataDir, 'translated', 'tr1.html'),
    '<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px/1.8 system-ui;padding:20px}</style></head><body><h1>译文</h1><p>结果显示见 Fig. 1 与 Table 2 的内容。</p></body></html>'
  )
  const schema = fs.readFileSync(path.join(ROOT, 'src', 'main', 'db', 'schema.sql'), 'utf8')
  const db = new DatabaseSync(path.join(dataDir, 'library.sqlite'))
  db.exec(schema)
  const ts = new Date().toISOString()
  db.prepare('INSERT INTO items (key,doi,title,year,venue,type,date_added,date_modified) VALUES (?,?,?,?,?,?,?,?)').run(
    itemKey, '10.9999/fig', 'A Paper With Figures', 2024, 'NeurIPS', 'conference', ts, ts
  )
  const itemId = db.prepare('SELECT id FROM items WHERE key=?').get(itemKey).id
  db.prepare('INSERT INTO attachments (key,item_id,path,filename,content_type,date_added) VALUES (?,?,?,?,?,?)').run(
    attKey, itemId, ['storage', itemKey, 'fig.pdf'].join('/'), 'fig.pdf', 'application/pdf', ts
  )
  const attId = db.prepare('SELECT id FROM attachments WHERE key=?').get(attKey).id
  db.prepare(
    'INSERT INTO translations (key,attachment_id,lang,path,html_path,engine,backend,status,date_added) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run('TR1', attId, 'zh', 'fig.pdf', 'tr1.html', 'mock', 'mock', 'done', ts)
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
    const clicked = await cdp.evaluate(`(()=>{
      const spans=[...document.querySelectorAll('.textLayer span')]
      const s=spans.find(x=>/Fig\\.?\\s*1/.test(x.textContent||''))
      if(!s) return 'no-span'
      const t=s.textContent||''
      const idx=t.search(/Fig/i)
      const frac=t.length>0?Math.max(0.05,Math.min(0.95,(idx+2)/t.length)):0.5
      const r=s.getBoundingClientRect()
      s.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+r.width*frac,clientY:r.top+r.height/2}))
      return 'clicked@'+Math.round(frac*100)+'%'
    })()`)
    await sleep(1200)
    const pop = await cdp.evaluate(`(()=>{
      const el=document.querySelector('[data-testid="fig-pop"]')
      if(!el) return null
      const c=el.querySelector('canvas')
      let light=0,total=0
      if(c&&c.width&&c.height){const ctx=c.getContext('2d');const d=ctx.getImageData(0,0,Math.min(c.width,300),Math.min(c.height,300)).data
        for(let i=0;i<d.length;i+=4){total++;if(d[i]+d[i+1]+d[i+2]>150)light++}}
      return {label:(el.querySelector('.figpop__label')||{}).textContent||'', w:c?c.width:0, h:c?c.height:0, lightRatio: total?light/total:0}
    })()`)
    await cdp.shot('figpop.png')
    console.log('clicked=', clicked)
    console.log('popup=', JSON.stringify(pop))
    const hl = await cdp.evaluate(
      "(()=>{try{return !!(CSS&&CSS.highlights&&CSS.highlights.has('paperdesk-figref'))}catch(e){return false}})()"
    )
    console.log('figref highlight=', hl)
    // 「下一个」切换到图 2
    await cdp.evaluate(
      "(()=>{const b=document.querySelector('[data-testid=\"fig-pop-next\"]');if(b)b.click();return !!b})()"
    )
    await sleep(1000)
    const next = await cdp.evaluate(
      "(()=>{const el=document.querySelector('[data-testid=\"fig-pop\"]');return el?(el.querySelector('.figpop__label')||{}).textContent:null})()"
    )
    console.log('after next label=', next)
    // 切深色再点一次，验证主题
    await cdp.evaluate("document.documentElement.dataset.theme='dark'")
    await sleep(200)
    const darkBg = await cdp.evaluate(
      "(()=>{const el=document.querySelector('.figpop');return el?getComputedStyle(el).backgroundColor:''})()"
    )
    console.log('dark bg=', darkBg)

    // 注脚角标：点击上标数字「1」→ 底部脚注应被高亮（.fn-flash）
    const fnClicked = await cdp.evaluate(`(()=>{
      const spans=[...document.querySelectorAll('.textLayer span')]
      const s=spans.find(x=>(x.textContent||'').trim()==='1')
      if(!s) return 'no-marker'
      const r=s.getBoundingClientRect()
      s.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}))
      return 'clicked'
    })()`)
    await sleep(900)
    const fnFlash = await cdp.evaluate("!!document.querySelector('.fn-flash')")
    console.log('fn clicked=', fnClicked, 'fn-flash=', fnFlash)

    // 网页译文：点「Fig. 1」→ 图表预览弹窗
    await cdp.evaluate("document.querySelector('[data-testid=\"view-html\"]')?.click()")
    await sleep(1600)
    const webRefs = await cdp.evaluate(
      "(()=>{const f=document.querySelector('[data-testid=\"html-view\"]');try{return f&&f.contentDocument?f.contentDocument.querySelectorAll('.figref').length:-1}catch(e){return -2}})()"
    )
    console.log('web .figref count=', webRefs)
    await cdp.evaluate(
      "(()=>{const f=document.querySelector('[data-testid=\"html-view\"]');const el=f&&f.contentDocument&&f.contentDocument.querySelector('.figref');if(el){el.click();return true}return false})()"
    )
    await sleep(1600)
    const webPop = await cdp.evaluate(`(()=>{
      const el=document.querySelector('[data-testid="fig-pop-web"]')
      if(!el) return null
      const img=el.querySelector('img')
      return {label:(el.querySelector('.figpop__label')||{}).textContent||'', src:(img&&img.getAttribute('src')||'').slice(0,30), len:(img&&img.getAttribute('src')||'').length}
    })()`)
    console.log('web popup=', JSON.stringify(webPop))
    await cdp.shot('figpop-web.png')
    cdp.close()
  } catch (e) {
    console.log('FIGREF_ERROR', e && e.message)
  } finally {
    child.kill()
    await sleep(400)
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  }
  console.log('FIGREF_DONE ->', OUT)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
