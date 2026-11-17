// 布局遮挡诊断：在多个宽度下，找出「同一父级下互相重叠」的元素，以及横向溢出窗口的元素。
// 运行: node scripts/layout.cjs
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const PORT = 9415
const OUT = path.join(ROOT, '.shots-layout')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makePdf() {
  const c =
    'BT /F1 20 Tf 72 720 Td (Attention Is All You Need) Tj ET\n' +
    'BT /F1 12 Tf 72 694 Td (Ashish Vaswani, Noam Shazeer, Niki Parmar) Tj ET\n' +
    'BT /F1 11 Tf 72 640 Td (The dominant sequence transduction models are based on complex recurrent) Tj ET\n'
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
  return { send, evaluate, shot, close: () => ws.close() }
}

// 找「同一父级下、矩形互相重叠」的元素对（这类基本就是被遮挡）
const OVERLAP_EXPR = `(() => {
  const out = []
  const roots = [document.querySelector('.main'), document.querySelector('.leftpanels')].filter(Boolean)
  const cls = (el) => (el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\\s+/).slice(0,2).join('.') : ''))
  for (const root of roots) {
    for (const parent of [root, ...root.querySelectorAll('*')]) {
      const kids = [...parent.children].filter((k) => k.offsetParent !== null || getComputedStyle(k).position === 'fixed')
      if (kids.length < 2) continue
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect()
          if (a.width < 4 || a.height < 4 || b.width < 4 || b.height < 4) continue
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left)
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
          if (ox > 3 && oy > 3) {
            // 跳过「子元素自然落在父容器内」的情况：两者同属一个滚动容器且其中一个包含另一个
            if (kids[i].contains(kids[j]) || kids[j].contains(kids[i])) continue
            out.push({ parent: cls(parent), a: cls(kids[i]), b: cls(kids[j]), ox: Math.round(ox), oy: Math.round(oy) })
          }
        }
      }
    }
  }
  return out.slice(0, 20)
})()`

// 纵向裁切：内容比可视高、但容器不能滚动 → 底部内容被裁掉（看不到）
const CLIP_EXPR = `(() => {
  const res = []
  const label = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(/\\s+/).slice(0,2).join('.') : '')
  const check = (el) => {
    if (!el) return
    const cs = getComputedStyle(el)
    const canScrollY = /auto|scroll/.test(cs.overflowY)
    if (el.scrollHeight > el.clientHeight + 1 && !canScrollY) {
      res.push({ el: label(el), sh: el.scrollHeight, ch: el.clientHeight })
    }
  }
  check(document.querySelector('.main'))
  check(document.querySelector('.toolbar'))
  check(document.querySelector('.funcbar'))
  check(document.querySelector('.viewer'))
  for (const el of document.querySelectorAll('.leftpanels .panel, .leftpanels .notes')) check(el)
  // 横向裁切：内容比可视宽、但容器不能横向滚动 → 右侧被裁掉
  for (const el of document.querySelectorAll('.leftpanels .panel, .leftpanels .notes, .main .toolbar, .main .funcbar')) {
    const cs = getComputedStyle(el)
    const canX = /auto|scroll/.test(cs.overflowX)
    if (el.scrollWidth > el.clientWidth + 1 && !canX) {
      res.push({ el: 'clipX:' + label(el), sw: el.scrollWidth, cw: el.clientWidth })
    }
  }
  // 子元素底部超出窗口（不可达）
  const W = window.innerHeight
  for (const el of document.querySelectorAll('.leftpanels *, .main .toolbar *, .main .funcbar *')) {
    const r = el.getBoundingClientRect()
    if (r.height > 4 && r.width > 4 && r.bottom > W + 1) {
      res.push({ el: 'below-window:' + label(el), bottom: Math.round(r.bottom) })
      if (res.length > 12) break
    }
  }
  return res.slice(0, 15)
})()`

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paperdesk-layout-'))
  const dataDir = path.join(tmp, 'data')
  const itemKey = 'LAYOUTITEM'
  const attKey = 'LAYOUTATT1'
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
    await cdp.evaluate("document.querySelector('[data-testid=\"sb-expand\"]')?.click()")
    const GROUP_LABEL = { read: '阅读', data: '数据', research: '研究' }
    const panels = [
      ['read', 'notes'],
      ['read', 'analysis'],
      ['read', 'translate'],
      ['read', 'ai'],
      ['read', 'meta'],
      ['data', 'batch'],
      ['research', 'authors'],
      ['research', 'journals'],
      ['research', 'discovery']
    ]
    const widths = [1320, 1000]
    for (const w of widths) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: 840,
        deviceScaleFactor: 1,
        mobile: false
      })
      await sleep(300)
      for (const [grp, p] of panels) {
        await cdp.evaluate(
          `(()=>{const g=[...document.querySelectorAll('[data-testid="ribbon-groups"] button')].find(b=>b.textContent.trim()===${JSON.stringify(GROUP_LABEL[grp])});if(g)g.click();return !!g})()`
        )
        await sleep(150)
        const ok = await cdp.evaluate(
          `(()=>{const b=document.querySelector('[data-testid="panel-tab-${p}"]');if(b)b.click();return !!b})()`
        )
        await sleep(350)
        const ov = await cdp.evaluate(OVERLAP_EXPR)
        const cl = await cdp.evaluate(CLIP_EXPR)
        const realOv = (ov || []).filter(
          (o) => !/scrollpage|syncLayer|annotationLayer|textLayer|canvas|^svg|^path/.test(o.a + o.b + o.parent)
        )
        if (realOv.length || (cl && cl.length)) {
          console.log(`[w=${w}] panel=${p} ok=${ok} overlaps=${JSON.stringify(realOv)} clipped=${JSON.stringify(cl)}`)
        } else {
          console.log(`[w=${w}] panel=${p} ok=${ok} OK`)
        }
        await cdp.shot(`w${w}-${p}.png`)
      }
    }
    cdp.close()
  } catch (e) {
    console.log('LAYOUT_ERROR', e && e.message)
  } finally {
    child.kill()
    await sleep(400)
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  }
  console.log('LAYOUT_DONE ->', OUT)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
