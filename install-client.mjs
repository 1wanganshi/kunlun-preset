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
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the desktop profile the same way the harness does, so this works on a machine
 * that is not the author's. An explicit `--profile <dir>` always wins; otherwise
 * `DSH_PROFILE_DIR`, then the conventional `<dshHome>/profiles/desktop`.
 */
function resolveProfile() {
  const i = process.argv.indexOf('--profile')
  if (i !== -1 && process.argv[i + 1]) return resolve(process.argv[i + 1])
  if (process.env.DSH_PROFILE_DIR) return resolve(process.env.DSH_PROFILE_DIR)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', 'desktop')
}

const PROFILE = resolveProfile()
const DEST = join(PROFILE, 'node_modules', 'dsh-kunlun')
const PROFILE_PKG = join(PROFILE, 'package.json')

/**
 * A Windows-style absolute path inside a module specifier must be a file:// URL, or the
 * loader treats `C:` as a protocol and refuses to import it.
 */
const asUrl = (p) => 'file:///' + p.replace(/\\/g, '/')

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
