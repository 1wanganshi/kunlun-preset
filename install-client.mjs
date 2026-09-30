/**
 * Install the 昆仑 plugin into the desktop profile as a real package directory.
 *
 * The plugin must live INSIDE the profile's `node_modules` — a junction to
 * `~/.dsh/plugins/kunlun` does not work, because Node's resolver walks up from the real
 * (link-resolved) path and escapes the profile, so `@deepseek-ai/schemastery` and
 * friends stop resolving.
 *
 * The bundle's own `cordis.patch.yml` must be copied too. The harness reads it as the
 * bundle "overlay" while composing the profile; without it the launcher skips the whole
 * bundle with an ENOENT and the client half never registers, silently.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROFILE = 'C:/Users/Lenovo/.dsh/profiles/desktop'
const DEST = join(PROFILE, 'node_modules', 'dsh-kunlun')
const PROFILE_PKG = join(PROFILE, 'package.json')

/** Files and directories the installed package needs. */
const INCLUDE = ['lib', 'presets', 'mcp', 'skills', 'cordis.patch.yml', 'package.json']

function copyTree(src, dest) {
  const st = statSync(src)
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true })
    for (const name of readdirSync(src)) copyTree(join(src, name), join(dest, name))
  } else {
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
  }
}

// 1. Copy the payload.
rmSync(DEST, { recursive: true, force: true })
mkdirSync(DEST, { recursive: true })
let copied = 0
for (const name of INCLUDE) {
  const src = join(HERE, name)
  if (!existsSync(src)) { console.log('  skip (absent): ' + name); continue }
  copyTree(src, join(DEST, name))
  copied++
  console.log('  copied: ' + name)
}

// 2. The bundle patch MUST be present, or the launcher skips the bundle with ENOENT.
const patch = join(DEST, 'cordis.patch.yml')
if (!existsSync(patch)) {
  console.error('FAIL: cordis.patch.yml was not copied; the bundle will be skipped')
  process.exit(1)
}

// 3. Register the package in the profile manifest: dependency + bundle list. Both are
//    required. A package that is not listed as a bundle is never composed, and a
//    package not in dependencies is not considered installed.
const pkg = JSON.parse(readFileSync(PROFILE_PKG, 'utf8'))
pkg.dependencies ??= {}
pkg.dependencies['dsh-kunlun'] = 'file:./node_modules/dsh-kunlun'
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []
if (!pkg.dsh.profile.bundles.includes('dsh-kunlun')) pkg.dsh.profile.bundles.push('dsh-kunlun')
writeFileSync(PROFILE_PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log('  registered in profile package.json (dependency + bundle)')

// 4. Verify what matters: the client half is reachable and the manifest declares it.
const checks = [
  ['lib/index.js present', existsSync(join(DEST, 'lib', 'index.js'))],
  ['lib/client.js present', existsSync(join(DEST, 'lib', 'client.js'))],
  ['cordis.patch.yml present', existsSync(patch)],
  ['bundle lists dsh-kunlun', pkg.dsh.profile.bundles.includes('dsh-kunlun')],
]
const installed = JSON.parse(readFileSync(join(DEST, 'package.json'), 'utf8'))
checks.push(['manifest declares dsh.client', !!installed.dsh?.client])
checks.push(['manifest exports ./client', !!installed.exports?.['./client']])

let bad = 0
console.log('')
for (const [name, ok] of checks) {
  console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + name)
  if (!ok) bad++
}
console.log('')
console.log('installed to ' + DEST)
if (bad) { console.error('install check FAILED'); process.exit(1) }
