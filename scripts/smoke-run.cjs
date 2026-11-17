// 冒烟测试启动器：在 Electron 的 Node 运行时下运行 smoke.cjs（跨平台，无需手设环境变量）
// 用法: npm run smoke
//       node scripts/smoke-run.cjs --fault-status   （只打印当前故障注入状态，不启动 Electron）
const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')

const projectRoot = path.join(__dirname, '..')
const TEST_FAULTS = ['copy-fail', 'search-fail']

/**
 * 与 src/main/test-profile.ts 的 activeTestFault 同口径：
 * 只有隔离测试副本（.nightshift/ISOLATED_TEST_COPY）会读开关；
 * 控制文件 .testprofile/test-fault.txt 优先于环境变量 PAPERDESK_TEST_FAULT。
 */
function activeTestFault() {
  if (!existsSync(path.join(projectRoot, '.nightshift', 'ISOLATED_TEST_COPY'))) return null
  const control = path.join(projectRoot, '.testprofile', 'test-fault.txt')
  const raw = existsSync(control) ? readFileSync(control, 'utf8') : process.env.PAPERDESK_TEST_FAULT
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return TEST_FAULTS.includes(value) ? value : null
}

function testFaultLine() {
  return `[smoke] test fault: ${activeTestFault() ?? 'disabled'}`
}

// --fault-status 必须在 require('electron') 之前处理：没有 Electron dist 时也能自检
if (process.argv.includes('--fault-status')) {
  console.log(testFaultLine())
  process.exit(0)
}

// 正常冒烟也先打印同一行，便于人工核对当前注入状态
console.log(testFaultLine())

const electron = require('electron')

const r = spawnSync(electron, [path.join(__dirname, 'smoke.cjs')], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
process.exit(r.status ?? 1)
