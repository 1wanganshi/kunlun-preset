// Build the kunlun preset BUNDLE.
//
// The declaration must ride a bundle layer (that is how all four shipped presets
// are declared). This script assembles the bundle directory, copying the real
// composition in as the declaration and syncing the local plugin modules, so the
// bundle is self-contained and reproducible.
//
//   1. read the managed row block from  <source>/cordis.kunlun.yml
//   2. rewrite its `insert:` id to preset-kunlun and its config.id to kunlun
//   3. copy the local .mjs preset modules next to the bundle so the file: URLs
//      resolve relative to the bundle rather than the source directory
//   4. write  <bundle>/package.json  and  <bundle>/cordis.patch.yml
//
// Run:  node build-bundle.mjs            (dry run, prints the plan)
//       node build-bundle.mjs --write    (writes the bundle)
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PROFILE = process.env.DSH_PROFILE_DIR
  ? process.env.DSH_PROFILE_DIR.replace(/\\/g, '/')
  : path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'profiles', 'desktop').replace(/\\/g, '/')
const BUNDLE = join(PROFILE, 'node_modules', 'kunlun-preset-bundle')
const WRITE = process.argv.includes('--write')

// The generated row block: already a valid `- insert:` document.
const rowPath = join(PROFILE, 'cordis.kunlun.yml')
if (!existsSync(rowPath)) {
  console.error('missing ' + rowPath)
  process.exit(1)
}

let text = readFileSync(rowPath, 'utf8')

// Refuse to build a bundle whose shell row would collide with the host.
//
// The host's own base bundle already mounts a shell executor (pwsh-sandbox on
// Windows, bash-sandbox elsewhere). A preset row naming ANY package whose class
// extends ShellExecutor re-registers the "shell" service in the same realm, and
// Cordis refuses it with
//     service "shell" has been registered at <SandboxPwshExecutor>
// which renders the whole preset as 加载失败. The shipped minimal preset avoids
// this by naming dsh-terminal-bash, which binds no service at all.
if (/dsh-pwsh-local|dsh-pwsh-sandbox|dsh-bash-local|dsh-bash-sandbox/.test(text)) {
  console.error('REFUSING TO BUILD: the row block names a shell executor')
  console.error('  the host already binds the "shell" service; a preset row that')
  console.error('  binds it again fails the mount as 加载失败.')
  console.error('  Use @deepseek-ai/dsh-terminal-bash for terminal-pwsh / terminal-bash.')
  const offenders = [...new Set(text.match(/@deepseek-ai\/dsh-(?:pwsh|bash)-(?:local|sandbox)/g) ?? [])]
  for (const o of offenders) console.error('    found: ' + o)
  process.exit(1)
}

// Report (do not refuse) packages the PROFILE cannot resolve.
//
// The profile resolves @deepseek-ai/* from its own on-disk DSH installation,
// which is not the same tree as app.asar, so some host-shipped packages are
// invisible to a plain require(). That is NOT by itself a defect: the preset is
// mounted by the host Loader, which resolves against its own base.
//
// The shipped standard preset names @deepseek-ai/dsh-workflow-ptc — absent from
// the profile — and works. So an unresolvable name is a WARNING to check against
// the shipped presets, not a build failure. An earlier revision refused the
// build here, which pushed 昆仑 away from the official shape for no reason.
{
  const { createRequire } = await import('node:module')
  const req = createRequire(join(PROFILE, 'noop.js'))
  const unresolvable = []
  const HOST_ONLY = new Set(['@deepseek-ai/dsh-agent-preset'])
  for (const quoted of new Set(text.match(/"@?[\w./@-]+"/g) ?? [])) {
    const bare = quoted.slice(1, -1)
    if (!bare.startsWith('@') && !bare.startsWith('dsh')) continue
    if (/\.(mjs|js|yml|yaml|json)$/.test(bare)) continue
    if (HOST_ONLY.has(bare)) continue
    try { req.resolve(bare, { paths: [PROFILE] }); continue } catch {}
    const root = bare.split('/').slice(0, 2).join('/')
    try { req.resolve(root + '/package.json', { paths: [PROFILE] }); continue } catch {}
    unresolvable.push(bare)
  }
  if (unresolvable.length > 0) {
    console.warn('NOTE: these packages do not resolve from the profile:')
    for (const u of unresolvable) console.warn('    ' + u)
    console.warn('  The host Loader resolves against its own base, so this is fine when')
    console.warn('  the shipped standard preset names the same package. Verify against')
    console.warn('  @deepseek-ai/dsh-web-app/presets/standard.patch.yml before changing it.')
  }
}

// Point the declaration at the real preset id (the generated block may still
// carry the probe's id while the probe is being tested).
const beforeId = (text.match(/^\s+id:\s*(\S+)\s*$/m) ?? [])[1]
text = text.replace(/^(\s+)- id: preset-kunlun(-min)?\s*$/m, '$1- id: preset-kunlun')
text = text.replace(/^(\s+)id: kunlun(-min)?\s*$/m, '$1id: kunlun')
text = text.replace(/^(\s+)name: 昆仑探针\s*$/m, '$1name: 昆仑模式')

// Rewrite every local file: URL so it points into the bundle's own module dir.
const files = [...text.matchAll(/file:\/\/\/([^'"\s]+\.mjs)/g)].map(m => decodeURIComponent(m[1]))
const localModules = [...new Set(files.map(f => basename(f)))]

console.log('source row block : ' + rowPath)
console.log('declaration id   : ' + beforeId + '  ->  kunlun')
console.log('local modules    : ' + (localModules.length ? localModules.join(', ') : '(none)'))
console.log('bundle dir       : ' + BUNDLE)
console.log('')

const header = [
  '# 昆仑模式 — the kunlun agent preset declaration.',
  '#',
  '# Declared through the official @deepseek-ai/dsh-agent-preset mechanism, riding a',
  '# bundle layer exactly as the shipped standard/ptc/minimal/cordis presets do.',
  '# Every row that needs configuration carries a config block, because a row whose',
  '# plugin declares required config fails to mount without one.',
  '',
].join('\n')

// Drop only the leading comment banner from the generated block, keeping the
// document structure intact. Stripping comments line-by-line also eats the
// `- insert:` list marker, which silently produces invalid YAML — so remove the
// banner as a contiguous prefix instead.
const bannerEnd = text.search(/^(?!\s*#)/m)
text = bannerEnd > 0 ? text.slice(bannerEnd) : text

text = header + text

if (!WRITE) {
  console.log('DRY RUN - pass --write to create the bundle')
  console.log('')
  console.log(text.split('\n').slice(0, 30).join('\n'))
  process.exit(0)
}

mkdirSync(join(BUNDLE, 'modules'), { recursive: true })

// 1. package.json declaring the bundle patch.
writeFileSync(join(BUNDLE, 'package.json'), JSON.stringify({
  name: 'kunlun-preset-bundle',
  version: '1.0.0',
  private: true,
  description: 'Declares the 昆仑模式 (kunlun) agent preset through the official @deepseek-ai/dsh-agent-preset mechanism.',
  type: 'module',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2) + '\n', 'utf8')

// 2. copy the local modules beside the bundle and repoint the URLs.
//
// The modules import each other (working-context.mjs imports ./paging.mjs), so
// copy EVERY .mjs in the preset directory rather than only the five the
// composition references by file: URL. A missing sibling import would fail the
// whole preset at mount time.
const moduleDir = join(BUNDLE, 'modules')
const presetDir = join(here, 'presets', 'kunlun')
const sources = existsSync(presetDir)
  ? readdirSync(presetDir).filter(f => f.endsWith('.mjs'))
  : localModules

let copied = 0
for (const m of sources) {
  const from = join(presetDir, m)
  if (!existsSync(from)) { console.log('  SKIP (missing): ' + m); continue }
  copyFileSync(from, join(moduleDir, m))
  copied++
}
if (copied > 0) {
  // file:///C:/.../kunlun-preset-bundle/modules/<name>.mjs
  const base = 'file:///' + join(BUNDLE, 'modules').replace(/\\/g, '/')
  text = text.replace(/file:\/\/\/[^'"\s]*\/([^/'"\s]+\.mjs)/g, (_, name) => base + '/' + name)
}

writeFileSync(join(BUNDLE, 'cordis.patch.yml'), text, 'utf8')

console.log('wrote ' + join(BUNDLE, 'package.json'))
console.log('wrote ' + join(BUNDLE, 'cordis.patch.yml') + '  (' + Buffer.byteLength(text, 'utf8') + ' B)')
console.log('copied ' + copied + ' module(s) into modules/')
console.log('')
console.log('bundles in the profile must list "kunlun-preset-bundle".')
