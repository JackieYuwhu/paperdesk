// Chromium refuses writable-by-low-integrity runtime resources on Windows.
// Restrict only the generated application files to the normal medium integrity level.
const path = require('node:path')
const { rmSync } = require('node:fs')
const { execFileSync } = require('node:child_process')

function ensureMedium(directory, recursive) {
  const options = { windowsHide: true, stdio: 'pipe' }
  try {
    execFileSync('icacls.exe', [directory, '/setintegritylevel', '(OI)(CI)M', ...(recursive ? ['/T', '/C'] : [])], options)
  } catch (error) {
    // A normal non-admin account may lack WRITE_OWNER while the files already
    // have the default medium label. Do not require elevation merely to restamp it.
    const output = execFileSync('icacls.exe', [directory, ...(recursive ? ['/T', '/C'] : [])], options)
    const acl = output.toString('utf8') + '\n' + new TextDecoder('gb18030').decode(output)
    if (/Low Mandatory|Untrusted Mandatory|低强制|低完整|不受信任.*强制|S-1-16-(?:0|4096)\b/i.test(acl)) throw error
    console.log('[after-pack] Keeping existing default integrity labels (no low-integrity label found).')
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const release = path.resolve(context.packager.projectDir, 'release')
  const output = path.resolve(context.appOutDir)
  const relative = path.relative(release, output)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to change integrity labels outside the release application directory')
  }
  // A locally reused Electron distribution may carry Chromium's debug log.
  // It is runtime output and must never be included in a public installer.
  rmSync(path.join(output, 'debug.log'), { force: true })
  // Installer stubs are generated beside appOutDir and executed during NSIS
  // packaging. New files there must inherit the same normal integrity level.
  ensureMedium(path.dirname(output), false)
  ensureMedium(output, true)
}
