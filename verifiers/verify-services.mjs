// Verify that no preset row BINDS a service the host already provides.
//
// WHY THIS EXISTS
// Cordis refuses a second registration of the same service name in one realm:
//
//     terminal-pwsh (@deepseek-ai/dsh-pwsh-local): service "shell" has been
//     registered at <SandboxPwshExecutor>
//
// The host's own base bundle already mounts a shell executor (`pwsh-sandbox`,
// `bash-sandbox`), so a preset row naming another shell executor collides. The
// shipped presets avoid this: they name dsh-terminal-bash (binds nothing) or
// dsh-tool-pwsh (a tool that INJECTS shell rather than providing it).
//
// The distinction that matters is provide-vs-inject:
//   BINDS   — the class extends ShellExecutor/TerminalSession/... (calls
//             super(ctx, "<name>")), so mounting it owns the service name.
//   INJECTS — the package lists the name in `inject` and only consumes it.
//
// This suite maps every row to its role and fails when a row binds a name that
// the host layer already binds elsewhere.
//
// Usage: node verify-services.mjs
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EXE, DSH, PROFILE, BUNDLE, requireProfile } from './env-paths.mjs'

const probe = String.raw`
const path = require('path')
const fs = require('fs')
const { existsSync } = fs
const PROFILE = ${JSON.stringify(PROFILE)}
// Resolve through the PROFILE, not app.asar.
//
// This distinction is load-bearing: the desktop profile resolves its
// @deepseek-ai/* packages from a separate on-disk DSH installation, and that
// install is not necessarily the version inside the running app. Reading
// app.asar would inspect classes the preset never loads, and the class
// hierarchy is exactly what decides which service a row binds.
const { createRequire } = require('module')
const req = createRequire(path.join(PROFILE, 'noop.js'))
const yaml = require(path.join(PROFILE, 'node_modules', 'js-yaml'))
const JsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: d => ({ __jsExpr: d }) })
const schema = yaml.DEFAULT_SCHEMA.extend([JsType])

// The service names a package BINDS (provides).
//
// A package binds a service in one of two ways, and only checking the first
// silently misses the bug this suite exists to catch:
//
//   1. DIRECT   — a class in the file calls super(ctx, "<name>").
//   2. INHERITED — the exported class extends a class that itself binds, e.g.
//                  SandboxPwshExecutor extends PwshLocalExecutor, and
//                  PwshLocalExecutor extends ShellExecutor (which calls
//                  super(ctx, "shell")). The subclass re-runs that constructor,
//                  so mounting it registers the SAME name a second time.
//
// Rule 2 is what made terminal-pwsh: dsh-pwsh-local collide with the host's own
// sandbox row. Follow the extends chain across packages until a class calls
// super(ctx, name) or the chain leaves @deepseek-ai.
//
// The PLUGIN's own class must be the one followed. A package may import other
// plugin classes it merely mounts; following those would report services the
// package never provides. Anchor on the class the default export resolves to.
const bindOf = (pkg, depth = 0) => {
  if (depth > 4) return undefined
  let lib, impl
  try {
    const dir = path.dirname(req.resolve(String(pkg) + '/package.json'))
    lib = path.join(dir, 'lib', 'index.js')
    const mod = req(lib)
    impl = mod.default ?? mod
  } catch { return undefined }
  if (!fs.existsSync(lib)) return undefined
  const src = fs.readFileSync(lib, 'utf8')

  // The plugin class name, used to walk only its own extends chain.
  const pluginName = typeof impl === 'function' ? impl.name : undefined
  // A plugin that only CONSUMES services lists them in inject; those must never
  // be reported as bindings.
  const injected = new Set(Array.isArray(impl?.inject) ? impl.inject : [])

  // (1) direct registrations in this file, for the plugin class itself
  const direct = [...new Set([...src.matchAll(/super\(\s*ctx\s*,\s*["']([\w-]+)["']/g)].map(m => m[1]))]
    .filter(n => !injected.has(n))
  if (direct.length > 0) return direct

  // (2) inheritance. Only a package whose DEFAULT EXPORT is a class can inherit
  //     a registration; one exporting a plain plugin object ({ name, apply })
  //     provides nothing through inheritance, and following an unrelated class
  //     in its file would invent a binding that never happens.
  if (typeof impl !== 'function') return undefined

  // Bundled output spells these "var X = class X extends Base {", so match both
  // the plain and the assigned form. Only matching the plain form silently finds
  // nothing and reports a false PASS.
  const patterns = []
  if (pluginName) patterns.push(new RegExp('class\\s+' + pluginName + '\\s+extends\\s+(\\w+)'))
  patterns.push(/(?:var\s+\w+\s*=\s*)?class\s+\w*\s*extends\s+(\w+)/)

  let baseName
  for (const p of patterns) {
    const m = src.match(p)
    if (m) { baseName = m[1]; break }
  }
  if (!baseName) return undefined
  if (baseName === 'Service' || baseName === '_classSuper') return undefined

  // Escape regex metacharacters without a literal escape regex (it would clash
  // with the surrounding template literal).
  let esc = ''
  for (const ch of baseName) esc += '.^$*+?()[]{}|\\'.includes(ch) ? '\\' + ch : ch
  const imp = src.match(new RegExp('import\\s*\\{[^}]*\\b' + esc + '\\b[^}]*\\}\\s*from\\s*["\']([^"\']+)["\']'))
  if (!imp) return undefined
  return bindOf(imp[1], depth + 1)
}

const injectOf = pkg => {
  try {
    const dir = path.dirname(req.resolve(String(pkg) + '/package.json'))
    const mod = req(path.join(dir, 'lib', 'index.js'))
    const impl = mod.default ?? mod
    return impl.inject
  } catch { return undefined }
}

// Every row of every mounted patch that BINDS a service, split by layer.
const pkgJson = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'))
const layers = []
for (const b of pkgJson.dsh.profile.bundles ?? []) {
  let mp
  // Resolve each bundle through the profile too — the same tree that mounts it.
  for (const root of [PROFILE]) { try { mp = req.resolve(b + '/package.json', { paths: [root] }); break } catch {} }
  if (!mp) continue
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'))
  const rel = meta?.dsh?.bundle?.patch
  if (!rel) continue
  for (const f of (typeof rel === 'string' ? [rel] : rel)) {
    const full = path.join(path.dirname(mp), f)
    if (existsSync(full)) layers.push({ label: b, rows: yaml.load(fs.readFileSync(full, 'utf8'), { schema }) || [] })
  }
}
layers.push({ label: 'PROFILE', rows: yaml.load(fs.readFileSync(path.join(PROFILE, 'cordis.patch.yml'), 'utf8'), { schema }) || [] })

const enabled = e => {
  if (e.disabled === undefined) return true
  if (typeof e.disabled === 'object' && e.disabled.__jsExpr !== undefined) { try { return !Boolean(eval(e.disabled.__jsExpr)) } catch { return false } }
  return !Boolean(e.disabled)
}

// (1) what the HOST binds outside any preset declaration
const hostBinds = new Map()
// (2) what each preset declaration's rows bind, WITH the isolate realm each row
//     sits in. A group that declares an isolate entry for a service moves that
//     service into a realm-private symbol, so a row inside it legitimately
//     re-provides the name without colliding with the host. Only a row that
//     re-binds a host service in the ROOT realm is an error.
const presetRows = []

const collect = rows => {
  for (const e of rows) {
    if (!e || typeof e !== 'object') continue
    if (Array.isArray(e.insert)) { collect(e.insert); continue }
    if (e.name === '@deepseek-ai/dsh-agent-preset') {
      const walk = (list, isolated) => {
        for (const r of list) {
          if (!r || typeof r !== 'object') continue
          if (Array.isArray(r.config)) {
            const own = new Set(isolated)
            for (const s of Object.keys(r.isolate ?? {})) own.add(s)
            walk(r.config, own)
            continue
          }
          presetRows.push({ row: r, isolated })
        }
      }
      walk(e.config?.plugins ?? [], new Set())
      continue
    }
    if (Array.isArray(e.config)) { collect(e.config); continue }
    if (typeof e.name !== 'string' || e.name.startsWith('cordis:')) continue
    if (!enabled(e)) continue
    const b = bindOf(e.name)
    if (b) for (const n of b) if (!hostBinds.has(n)) hostBinds.set(n, { id: e.id, name: e.name })
  }
}
for (const L of layers) collect(L.rows)

console.log('=== services the HOST already binds ===')
console.log('  ' + hostBinds.size + ' service(s)')
for (const [svc, who] of hostBinds) console.log('    ' + svc.padEnd(24) + '<- ' + who.id)
console.log('')

console.log('=== preset rows that BIND a service ===')
const clashes = []
const seen = new Map()
for (const { row: r, isolated } of presetRows) {
  if (!r.name || typeof r.name !== 'string' || r.name.startsWith('cordis:')) continue
  if (!enabled(r)) continue
  const b = bindOf(r.name)
  if (!b) continue
  for (const svc of b) {
    const host = hostBinds.get(svc)
    const dup = seen.has(svc)
    // A host clash is fine when the group isolates that very service: the row
    // then owns a realm-private instance instead of re-registering the root one.
    const shielded = host !== undefined && isolated.has(svc)
    const verdict = shielded ? 'ok (isolated realm)' : (host || dup) ? 'CLASH' : 'ok'
    console.log('  ' + svc.padEnd(18) + '<- ' + String(r.id).padEnd(20) + r.name + '   ' + verdict)
    if (!shielded && (host || dup)) clashes.push({ svc, id: r.id, name: r.name, host })
    if (!seen.has(svc)) seen.set(svc, r.id)
  }
}
if (seen.size === 0) console.log('  (none)')
console.log('')

if (clashes.length === 0) {
  console.log('RESULT: PASS - no preset row re-binds a service the host already owns')
} else {
  console.log('RESULT: FAIL - Cordis would refuse these registrations:')
  for (const c of clashes) {
    console.log('  ' + c.id + ' (' + c.name + ') binds "' + c.svc + '"')
    if (c.host) console.log('     already bound by ' + c.host.id + ' (' + c.host.name + ') in a host layer')
  }
  process.exitCode = 1
}
`

const tmp = join(PROFILE, '_verify-services-run.cjs')
const { writeFileSync, unlinkSync } = await import('node:fs')
writeFileSync(tmp, probe, 'utf8')

const r = spawnSync(EXE, [tmp], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 240000 })
try { unlinkSync(tmp) } catch {}
if (r.stdout) process.stdout.write(r.stdout)
if (r.stderr) process.stderr.write(r.stderr)
process.exitCode = r.status ?? 0
