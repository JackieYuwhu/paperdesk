/**
 * 安装预检（Installation preflight）。
 * 用法：npm run preflight
 *
 * 校验：Node 版本、Python 版本（≥3.10）、Python 依赖可导入、sidecar 能真正起来并响应 /health。
 * 这是「无开发环境的机器能否跑起来」的第一道自动检查。
 */
const { spawn, spawnSync } = require('node:child_process')
const { createServer } = require('node:net')
const path = require('node:path')

const PY = process.env.PAPERDESK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const ROOT = path.join(__dirname, '..')
const PY_DIR = path.join(ROOT, 'python')

let failed = 0
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failed++
    console.log(`  FAIL  ${name} ${extra}`)
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function checkSidecar() {
  const port = await freePort()
  const child = spawn(
    PY,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)],
    { cwd: PY_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let started = false
  const deadline = Date.now() + 15000
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`)
        if (r.ok) {
          started = true
          break
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(400)
    }
  } finally {
    try {
      child.kill()
    } catch {
      /* noop */
    }
  }
  check('sidecar 能启动并响应 /health', started)
}

async function main() {
  console.log('PaperDesk 安装预检')

  const major = Number(process.versions.node.split('.')[0])
  check(`Node ≥ 20（当前 ${process.versions.node}）`, major >= 20)

  const v = spawnSync(PY, ['--version'], { encoding: 'utf8' })
  const vOut = `${v.stdout || ''}${v.stderr || ''}`.trim()
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(vOut)
  const pyOk = v.status === 0 && !!m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10))
  check(`Python ≥ 3.10（${vOut || '未找到'}）`, pyOk, `PY=${PY}`)

  if (pyOk) {
    const dep = spawnSync(
      PY,
      ['-c', 'import fastapi, uvicorn, fitz, httpx, pydantic; print("ok")'],
      { encoding: 'utf8' }
    )
    check('Python 依赖可导入（fastapi/uvicorn/pymupdf/httpx/pydantic）', dep.status === 0, (dep.stderr || '').slice(0, 160))
    if (dep.status === 0) await checkSidecar()
    else console.log('  SKIP  sidecar 启动检查（依赖缺失）')
  } else {
    console.log('  SKIP  依赖与 sidecar 检查（Python 不可用）')
  }

  console.log(failed === 0 ? 'PREFLIGHT_OK' : `PREFLIGHT_FAIL (${failed})`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('预检异常：', e)
  process.exit(1)
})
