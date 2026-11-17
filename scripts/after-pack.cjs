// Chromium refuses writable-by-low-integrity runtime resources on Windows.
// Restrict only the generated application files to the normal medium integrity level.
const path = require('node:path')
const { execFileSync } = require('node:child_process')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const release = path.resolve(context.packager.projectDir, 'release')
  const output = path.resolve(context.appOutDir)
  const relative = path.relative(release, output)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to change integrity labels outside the release application directory')
  }
  execFileSync('icacls.exe', [output, '/setintegritylevel', '(OI)(CI)M', '/T', '/C'], {
    windowsHide: true, stdio: 'pipe'
  })
}
