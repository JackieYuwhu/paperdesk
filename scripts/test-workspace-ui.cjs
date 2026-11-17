// 隔离 Electron 工作区验收：只创建临时文库，不读取用户配置或调用真实模型。
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const ROOT = path.resolve(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperdesk-workspace-'))
  const data = path.join(dir, 'data')
  const shots = path.join(ROOT, '.tmp-shots', 'workspace')
  fs.mkdirSync(shots, { recursive: true })
  const net = require('node:net')
  const server = net.createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  await new Promise((r) => server.close(r))
  const env = { ...process.env, PAPERDESK_DATA: data, PAPERDESK_PROVIDER_MODE: 'mock', PAPERDESK_DISABLE_GPU: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  // Isolate every provider override; the test never needs a model or a network endpoint.
  for (const key of Object.keys(env)) if (/^PAPERDESK_(MT|LLM|CHAT|EMBED|WEBSEARCH)_/.test(key)) delete env[key]
  const launchedAt = Date.now()
  const child = spawn(require('electron'), [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '.'], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', (b) => { logs += b.toString() })
  child.stderr.on('data', (b) => { logs += b.toString() })
  let ws
  try {
    let page
    for (let i = 0; i < 100; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((p) => p.type === 'page') } catch {}
      if (page) break
      await sleep(150)
    }
    assert(page, 'CDP page available')
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    let seq = 0
    const pending = new Map()
    const errors = []
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m) } }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)
    }
    const send = (method, params = {}) => new Promise((r, j) => {
      const id = ++seq
      const timer = setTimeout(() => { pending.delete(id); j(new Error(`CDP timeout: ${method}`)) }, 20000)
      pending.set(id, (m) => { clearTimeout(timer); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result) })
      ws.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result?.value
    }
    const wait = async (expression, label) => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(120) }
      throw new Error(`Timed out: ${label}`)
    }
    const click = (testid) => evaluate(`document.querySelector('[data-testid="${testid}"]')?.click()`)
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.data, 'base64')) }
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1320, height: 840, deviceScaleFactor: 1, mobile: false })
    await wait("!!document.querySelector('[data-testid=library-workspace]')", 'library shell')
    const firstReadyMs = Date.now() - launchedAt
    assert.equal(await evaluate('document.querySelectorAll(".desk-nav [data-testid]").length'), 5)
    // Before reading, PDF.js/reader chunks should not have been requested.
    assert.equal(await evaluate("performance.getEntriesByType('resource').some(r=>/PdfViewer-|pdf-[A-Za-z0-9_-]+\\.js/.test(r.name))"), false, 'reader deferred on library startup')
    const id = await evaluate("window.api.library.addMetadata({title:'Temporal transportation network dismantling',year:2026,venue:'Reliability Engineering & System Safety'}).then(x=>x.id)")
    const pdf = path.join(data, 'sample.pdf')
    const stream = (text) => `BT /F1 18 Tf 60 720 Td (${text}) Tj ET\nBT /F1 12 Tf 60 680 Td (Research methods and evidence for temporal networks.) Tj ET\n`
    const streams = [stream('Workspace reader - page one'), stream('Workspace reader - page two')]
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>', ...streams.flatMap((t, i) => [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${4 + i * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(t)} >>\nstream\n${t}endstream`]), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    let source = '%PDF-1.4\n'
    const offsets = objects.map((o, i) => { const n = Buffer.byteLength(source); source += `${i + 1} 0 obj\n${o}\nendobj\n`; return n })
    const start = Buffer.byteLength(source)
    source += `xref\n0 8\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
    fs.writeFileSync(pdf, source)
    const db = new DatabaseSync(path.join(data, 'library.sqlite'))
    db.prepare('INSERT INTO attachments(key,item_id,path,filename,content_type,size,page_count,date_added) VALUES(?,?,?,?,?,?,?,?)').run('UIATT001', id, 'sample.pdf', 'sample.pdf', 'application/pdf', fs.statSync(pdf).size, 2, new Date().toISOString())
    db.close()
    await evaluate(`window.api.library.setGroup(${id},'组合优化/网络拆解')`)
    await wait("document.querySelectorAll('.library-table__row').length===1", 'library refresh')
    await shot('01-library')
    await evaluate("document.querySelector('.paper-actions button').click()")
    await wait("!!document.querySelector('[data-testid=item-detail]')", 'detail drawer')
    assert.equal(await evaluate("(()=>{const d=document.querySelector('[data-testid=item-detail]').getBoundingClientRect(),m=document.querySelector('.main').getBoundingClientRect();return d.x>m.x})()"), true, 'detail on right')
    await click('workspace-library')
    await evaluate("[...document.querySelectorAll('.library-controls button')].find(b=>b.textContent==='全文检索').click()")
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.sidebar__split-pane--list')).display!=='none'"), true, 'full-text search results visible')
    await click('workspace-library')
    await evaluate("document.querySelector('.paper-title').click()")
    await wait("!!document.querySelector('canvas[data-rendered=\"1\"]')", 'PDF first page')
    await sleep(150)
    await shot('02-reader')
    await click('toolbar-page-next')
    await wait("document.querySelector('[data-testid=toolbar-page-label]')?.textContent.trim().startsWith('2')", 'page navigation')
    await click('workspace-library')
    await click('workspace-reader')
    await wait("!!document.querySelector('canvas[data-rendered=\"1\"]')", 'retained PDF')
    assert.equal(await evaluate("document.querySelector('[data-testid=toolbar-page-label]').textContent.trim().startsWith('2')"), true, 'page position preserved')
    await click('panel-tab-ai')
    await wait("!!document.querySelector('.ai')", 'AI side panel')
    const geometry = await evaluate("(()=>{const p=document.querySelector('.leftpanels').getBoundingClientRect(),m=document.querySelector('.main').getBoundingClientRect();return {panel:p.x,main:m.x,width:m.width}})()")
    assert(geometry.panel > geometry.main && geometry.width > 350, 'AI is on right of readable PDF')
    await shot('03-reader-ai')
    await evaluate("document.querySelector('.reader-more').click()")
    assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-testid=toolbar-page-edit]')).display!=='none'"), true, 'page editor remains accessible')
    await evaluate("document.querySelector('.reader-more').click()")
    await click('workspace-tasks')
    await wait("document.querySelector('.desk-shell')?.dataset.workspace==='tasks' && !!document.querySelector('[data-testid=batch-task]')", 'task workspace')
    await shot('04-tasks')
    await click('workspace-research')
    await wait("!!document.querySelector('.workspace-panel-tabs') && document.querySelector('.desk-shell')?.dataset.workspace==='research'", 'research workspace')
    await shot('05-research')
    await click('workspace-knowledge')
    await wait("!!document.querySelector('[data-testid=workspace-layer] .stage')", 'knowledge workspace')
    await shot('06-knowledge')
    await click('command-open')
    await wait("!!document.querySelector('.command-dialog')", 'command palette')
    await evaluate("[...document.querySelectorAll('.command-results button')].find(b=>b.textContent.includes('打开文库')).click()")
    await wait("!!document.querySelector('[data-testid=library-workspace]')", 'command navigation')
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false })
    await shot('07-narrow-library')
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, 'no window overflow')
    await evaluate("document.querySelector('.desk-header>button[aria-label=\"切换明暗主题\"]').click()")
    await wait("document.documentElement.dataset.theme==='dark'", 'dark theme')
    await shot('08-dark-library')
    assert.deepEqual(errors, [], 'no unhandled renderer errors')
    const marks = await evaluate("performance.getEntriesByType('mark').map(m=>({name:m.name,ms:Math.round(m.startTime)}))")
    fs.writeFileSync(path.join(shots, 'verification.json'), JSON.stringify({ firstReadyMs, marks, geometry, checks: 'WORKSPACE_UI_OK', profile: dir }, null, 2))
    console.log('WORKSPACE_UI_OK', JSON.stringify({ firstReadyMs, marks, geometry, shots }))
  } finally {
    if (ws) ws.close()
    child.kill()
    fs.writeFileSync(path.join(shots, 'app.log'), logs)
  }
}
run().catch((e) => { console.error(e); process.exitCode = 1 })
