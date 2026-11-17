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
  const shots = path.join(ROOT, '.tmp-shots', 'settings')
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
  const requests = []
  const http = require('node:http')
  const fixture = http.createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk
    const body = JSON.parse(data || '{}')
    requests.push({ path: req.url, headers: req.headers, body })
    const anthropic = req.url.endsWith('/messages')
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const event = anthropic ? { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Protocol stream works.' } } : { choices: [{ delta: { content: 'Protocol stream works.' } }] }
      const wire = `data: ${JSON.stringify(event)}\n\n`
      res.write(wire.slice(0, 17)); setTimeout(() => res.end(wire.slice(17) + 'data: [DONE]\n\n'), 20)
    } else {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(anthropic ? { content: [{ type: 'text', text: 'Protocol reply works.' }] } : { choices: [{ message: { content: 'Protocol reply works.' } }] }))
    }
  })
  await new Promise(r => fixture.listen(0, '127.0.0.1', r))
  const fixtureBase = `http://127.0.0.1:${fixture.address().port}/v1`
  const launchedAt = Date.now()
  const child = spawn(process.env.PAPERDESK_TEST_EXE || require('electron'), [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, ...(process.env.PAPERDESK_TEST_NOSANDBOX ? ['--no-sandbox'] : []), ...(process.env.PAPERDESK_TEST_EXE ? [] : ['.'])], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
    const shot = async (name) => { await sleep(250); const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.data, 'base64')) }
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1320, height: 840, deviceScaleFactor: 1, mobile: false })
    await wait("!!document.querySelector('[data-testid=library-workspace]')", 'library shell')
    const firstReadyMs = Date.now() - launchedAt
    assert.equal(await evaluate('document.querySelectorAll(".desk-nav [data-testid]").length'), 5)
    // Before reading, PDF.js/reader chunks should not have been requested.
    assert.equal(await evaluate("performance.getEntriesByType('resource').some(r=>/PdfViewer-|pdf-[A-Za-z0-9_-]+\\.js/.test(r.name))"), false, 'reader deferred on library startup')
    await evaluate(`document.querySelector('[aria-label="打开设置"]').click()`)
    await wait("!!document.querySelector('[data-testid=set-provider-baseurl]')", 'settings loaded')
    const setInput = (id, value) => evaluate(`(()=>{const el=document.querySelector('[data-testid="${id}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    assert.equal(await evaluate('document.querySelectorAll(".settings-nav button").length'), 7)
    assert.equal(await evaluate('document.querySelectorAll(".settings-card:not([hidden])").length'), 1)
    await setInput('set-provider-baseurl', fixtureBase)
    await setInput('set-provider-key', 'synthetic-test-key')
    await setInput('set-provider-chatmodel', 'openai-test')
    await evaluate(`(()=>{const el=document.querySelector('[data-testid=set-provider-mode]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,'auto');el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
    await click('set-test-provider')
    await wait("document.querySelector('[data-testid=set-test-result]')?.textContent.includes('连接成功')", 'OpenAI connection')
    assert.equal(requests.at(-1).path, '/v1/chat/completions')
    assert.equal(requests.at(-1).headers.authorization, 'Bearer synthetic-test-key')
    await shot('01-model-openai')
    // Empty optional Key fields must preserve existing secrets.
    await evaluate("window.api.settings.save({openalex:{apiKey:'synthetic-openalex'},scholar:{apiKey:'synthetic-scholar'},semantic:{apiKey:'synthetic-semantic'}})")
    await click('protocol-anthropic')
    await setInput('set-provider-chatmodel', 'claude-test')
    await click('set-test-provider')
    await wait("document.querySelector('[data-testid=set-test-result]')?.textContent.includes('连接成功')", 'Anthropic connection')
    assert.equal(requests.at(-1).path, '/v1/messages')
    assert.equal(requests.at(-1).headers['x-api-key'], 'synthetic-test-key')
    assert.equal(requests.at(-1).headers['anthropic-version'], '2023-06-01')
    assert(!requests.at(-1).headers.authorization)
    assert(requests.at(-1).body.max_tokens > 0)
    const saved = await evaluate('window.api.settings.get()')
    assert.equal(saved.provider.protocol, 'anthropic')
    assert(saved.openalex.apiKeySet && saved.scholar.apiKeySet && saved.semantic.apiKeySet)
    assert(!JSON.stringify(saved).includes('synthetic-'))
    await shot('02-model-anthropic')
    // Exercise the actual main-process SSE path against split network frames.
    const streamed = await evaluate(`(async()=>{let deltas='';const out=await window.api.ai.askStream('Say hello',{streamId:'protocol-check',tools:false,web:'off',strict:false},d=>deltas+=d);return {out,deltas}})()`)
    assert(streamed.deltas.includes('Protocol stream works.'), JSON.stringify(streamed))
    assert(requests.some(r => r.path.endsWith('/messages') && r.body.system && r.body.stream))
    // All categories have visible content and fit the panel at desktop and small sizes.
    for (const section of ['reading','ai','search','skills','data','system']) {
      await click(`settings-tab-${section}`)
      await wait(`document.querySelector('[data-testid=settings-tab-${section}]').getAttribute('aria-current')==='page'`, 'category selected')
      assert(await evaluate('document.querySelectorAll(".settings-card:not([hidden])").length > 0'))
      assert.equal(await evaluate('document.querySelector(".settings-content").scrollWidth > document.querySelector(".settings-content").clientWidth'), false, `${section} overflow`)
    }
    await shot('03-system')
    await click('settings-tab-model')
    await evaluate("document.documentElement.dataset.theme='dark'")
    await shot('04-model-dark')
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false })
    await shot('05-model-narrow')
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false)
    assert.deepEqual(errors, [])
    console.log('SETTINGS_UI_OK', JSON.stringify({firstReadyMs, requests:requests.map(r=>({path:r.path,stream:!!r.body.stream})),shots}))
  } finally {
    fixture.close()
    if (ws) ws.close()
    child.kill()
    fs.writeFileSync(path.join(shots, 'app.log'), logs)
  }
}
run().catch((e) => { console.error(e); process.exitCode = 1 })
