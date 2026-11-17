// 针对「设置保存不了」的定位脚本：连 CDP，直接调 IPC 与走 UI 两条路径，打印结果与错误。
// 用法: node scripts/devsettings.cjs [port]
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
    console.log('FAIL 未找到页面目标')
    process.exit(1)
  }
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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result && r.result.exceptionDetails) {
      return 'EXCEPTION: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails)
    }
    return r.result && r.result.result ? r.result.result.value : undefined
  }
  await send('Runtime.enable', {})
  await sleep(2500)

  console.log('== 1) 直接调 IPC 保存 provider ==')
  console.log(
    await ev(
      "window.api.settings.save({provider:{baseUrl:'https://api.example.com/v1', apiKey:'sk-abc-123', chatModel:'m1', mode:'auto'}}).then(r=>'OK '+JSON.stringify(r.provider)).catch(e=>'ERR '+e.message)"
    )
  )
  console.log('== 2) 读回 ==')
  console.log(await ev("window.api.settings.get().then(s=>JSON.stringify(s.provider))"))

  console.log('== 3) 走 UI：打开设置 → 填 Base URL/Key → 点保存 ==')
  console.log('open-settings:', await ev("(()=>{const b=document.querySelector('[data-testid=\"open-settings\"]');if(!b)return 'no-btn';b.click();return 'clicked'})()"))
  await sleep(600)
  console.log('dialog:', await ev("!!document.querySelector('[data-testid=\"settings-dialog\"]')"))
  const setInput = (sel, val) =>
    `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'no-el';const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(proto,'value').set;set.call(el,${JSON.stringify(val)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()`
  console.log('fill baseUrl:', await ev(setInput('[data-testid="set-provider-baseurl"]', 'https://ui.example.com/v1')))
  console.log('fill key:', await ev(setInput('[data-testid="set-provider-key"]', 'sk-ui-999')))
  await sleep(300)
  console.log('click save:', await ev("(()=>{const b=document.querySelector('[data-testid=\"set-save\"]');if(!b)return 'no-save';b.click();return 'clicked'})()"))
  await sleep(900)
  console.log('status text:', await ev("document.querySelector('.modal__foot .notes__status')?.textContent || ''"))
  console.log('读回 provider:', await ev("window.api.settings.get().then(s=>JSON.stringify(s.provider))"))

  console.log('== 4) 服务自检 ==')
  console.log(await ev("window.api.system.health().then(h=>JSON.stringify(h)).catch(e=>'ERR '+e.message)"))

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.log('ERROR', e.message)
  process.exit(1)
})
