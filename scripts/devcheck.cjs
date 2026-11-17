// 开发模式自检：连上 CDP，看渲染进程是否真的渲染出来、有没有 CSP / 脚本错误。
// 用法: node scripts/devcheck.cjs [port]
const PORT = process.argv[2] || '9333'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const main = async () => {
  let targets = null
  for (let i = 0; i < 80; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      if (Array.isArray(targets) && targets.some((t) => t.type === 'page')) break
    } catch {
      /* retry */
    }
    await sleep(250)
  }
  const page = (targets || []).find((t) => t.type === 'page')
  if (!page) {
    console.log('DEVTEST_FAIL 未找到页面目标')
    process.exit(1)
  }
  console.log('page url:', page.url)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = (e) => rej(new Error(String(e.message)))
  })
  let id = 0
  const pending = new Map()
  const errors = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('EXC: ' + (m.params?.exceptionDetails?.text || ''))
    }
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
      errors.push('LOG: ' + m.params.entry.text)
    }
  }
  const send = (method, params) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  await send('Runtime.enable', {})
  await send('Log.enable', {})
  await sleep(4000)

  const title = await evaluate('document.title')
  const rootChildren = await evaluate("document.getElementById('root')?.children.length ?? -1")
  const spans = await evaluate("document.querySelectorAll('.textLayer span').length")
  const tabs = await evaluate("document.querySelectorAll('.rightcol__tabs button').length")

  console.log('title      :', title)
  console.log('rootChildren:', rootChildren)
  console.log('textLayer spans:', spans)
  console.log('right tabs :', tabs)
  console.log('errors     :', errors.length ? errors.slice(0, 5) : 'none')

  const ok = rootChildren > 0 && tabs >= 5
  console.log(ok ? 'DEVTEST_OK' : 'DEVTEST_FAIL')
  ws.close()
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.log('DEVTEST_ERROR', e.message)
  process.exit(1)
})
