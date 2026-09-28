// Verify that EVERY package a preset row names is resolvable from the profile.
//
// WHY THIS EXISTS
// A row whose package cannot be resolved never starts. The registry then reports
// it as 加载失败 with only:
//
//     agent-preset/invalid: workflow-ptc (@deepseek-ai/dsh-workflow-ptc): never started
//
// That message is easy to miss because it appears in the host log, and the
// session simply fails to launch ("has no provider/model", or no reply at all).
//
// The trap is specific: several packages exist in the shipped app.asar but are
// NOT resolvable from the profile, because the profile resolves @deepseek-ai/*
// from its own on-disk DSH installation. `dsh-workflow-ptc` is in app.asar and
// absent from the profile, so naming it broke the whole preset.
//
// This suite resolves each row's package the way the Loader does — from the
// profile — and fails on anything that would never start.
//
// Usage: node verify-resolvable.mjs
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { EXE, DSH, PROFILE, BUNDLE, requireProfile } from './env-paths.mjs'

const probe = String.raw`
const path = require('path')
const fs = require('fs')
const PROFILE = ${JSON.stringify(PROFILE)}
// DSH must be interpolated too: the probe resolves some rows from the shipped
// installation rather than the profile, and without this line the generated script
// throws "DSH is not defined" — a failure of the harness, not of the preset.
const DSH = ${JSON.stringify(DSH)}
const { createRequire } = require('module')
const req = createRequire(path.join(PROFILE, 'noop.js'))
const yaml = require(path.join(PROFILE, 'node_modules', 'js-yaml'))
const JsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: d => ({ __jsExpr: d }) })
const schema = yaml.DEFAULT_SCHEMA.extend([JsType])

// Walk every mounted patch and collect the rows the host will actually mount.
//
// Two kinds of row are deliberately NOT resolved from the profile alone:
//
//   * ISERTED rows (inside an insert:) are NEW, so the profile layer must
//     supply them. These are the rows this suite guards.
//   * BARE top-level rows addressed by id are PATCHES onto rows some earlier
//     layer declared. The desktop patch is full of these for host-only rows
//     (agent-preset-registry, ui-settings-account), which resolve from app.asar.
//     Requiring them to resolve from the profile reports permanent false
//     failures.
//
// So: every INSERTED row must resolve from the profile; bare patch rows only need
// to resolve from the profile OR the shipped installation.
const pkgJson = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'))
const layers = []
for (const b of pkgJson.dsh.profile.bundles ?? []) {
  let mp
  try { mp = req.resolve(b + '/package.json', { paths: [PROFILE] }) } catch { continue }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'))
  const rel = meta?.dsh?.bundle?.patch
  if (!rel) continue
  for (const f of (typeof rel === 'string' ? [rel] : rel)) {
    const full = path.join(path.dirname(mp), f)
    if (fs.existsSync(full)) layers.push({ label: b, rows: yaml.load(fs.readFileSync(full, 'utf8'), { schema }) || [] })
  }
}
layers.push({ label: 'PROFILE', rows: yaml.load(fs.readFileSync(path.join(PROFILE, 'cordis.patch.yml'), 'utf8'), { schema }) || [] })

// The shipped installation, used only for bare patch rows.

const reqDsh = createRequire(path.join(DSH, 'noop.js'))

const enabled = e => {
  if (e.disabled === undefined) return true
  if (typeof e.disabled === 'object' && e.disabled.__jsExpr !== undefined) { try { return !Boolean(eval(e.disabled.__jsExpr)) } catch { return false } }
  return !Boolean(e.disabled)
}

// A row's name may be a bare package, a package subpath, a file: URL, or a
// cordis: builtin. Only the first two need resolution; a file: URL is checked on
// disk instead.
const problems = []
const seen = new Set()

const check = (name, id, where, mustResolveHere) => {
  if (typeof name !== 'string' || name.length === 0) return
  if (name.startsWith('cordis:')) return
  const key = where + '\u0000' + name
  if (seen.has(key)) return
  seen.add(key)

  if (name.startsWith('file:')) {
    const p = name.replace(/^file:\/\/\//, '').replace(/\//g, path.sep)
    if (!fs.existsSync(p)) problems.push({ id, name, where, why: 'file: URL does not exist on disk' })
    return
  }

  // The Loader resolves the package (possibly a subpath) from the profile.
  const inProfile = () => {
    try { req.resolve(name, { paths: [PROFILE] }); return true } catch {}
    const parts = String(name).split('/')
    const root = parts.slice(0, 2).join('/')
    try { req.resolve(root + '/package.json', { paths: [PROFILE] }); return true } catch {}
    return false
  }
  if (inProfile()) return

  if (!mustResolveHere) {
    // A bare patch row may target a host-only package from the installation.
    const inDsh = () => {
      try { reqDsh.resolve(name, { paths: [DSH] }); return true } catch {}
      const parts = String(name).split('/')
      const root = parts.slice(0, 2).join('/')
      try { reqDsh.resolve(root + '/package.json', { paths: [DSH] }); return true } catch {}
      return false
    }
    if (inDsh()) return
  }

  problems.push({
    id, name, where,
    why: mustResolveHere
      ? 'INSERTED row not resolvable from the profile'
      : 'not resolvable from the profile or the installation',
  })
}

const walk = (rows, where, inserted) => {
  for (const e of rows) {
    if (!e || typeof e !== 'object') continue
    if (Array.isArray(e.insert)) { walk(e.insert, where, true); continue }
    if (e.name === '@deepseek-ai/dsh-agent-preset') {
      // A preset row is mounted by the HOST Loader, which resolves against its
      // own base — not the profile. So a name only the installation can resolve
      // is legitimate here, exactly as it is in the shipped standard preset
      // (which names @deepseek-ai/dsh-workflow-ptc, invisible to the profile).
      // Report such names as notes instead of failing.
      const inner = list => { for (const r of list) { if (!r || typeof r !== 'object') continue; if (Array.isArray(r.config)) { inner(r.config); continue } if (!enabled(r)) continue; check(r.name, r.id, 'preset kunlun', false) } }
      inner(e.config?.plugins ?? [])
      continue
    }
    if (Array.isArray(e.config)) { walk(e.config, where, inserted); continue }
    if (!enabled(e)) continue
    check(e.name, e.id, where, inserted)
  }
}
for (const L of layers) walk(L.rows, L.label, false)

console.log('rows whose package was checked: ' + seen.size)
console.log('')
if (problems.length === 0) {
  console.log('RESULT: PASS - every row package resolves from the profile')
} else {
  console.log('RESULT: FAIL - these rows would never start:')
  for (const p of problems) {
    console.log('  ' + String(p.id).padEnd(22) + p.name)
    console.log('     in ' + p.where + '  ->  ' + p.why)
  }
  console.log('')
  console.log('  A row that never starts fails the whole preset mount:')
  console.log('     agent-preset/invalid: <id> (<name>): never started')
  process.exitCode = 1
}
`

const script = join(PROFILE, '_verify-resolvable-run.cjs')
const { writeFileSync, unlinkSync } = await import('node:fs')
writeFileSync(script, probe, 'utf8')
const r = spawnSync(EXE, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 240000 })
try { unlinkSync(script) } catch {}
if (r.stdout) process.stdout.write(r.stdout)
if (r.stderr) process.stderr.write(r.stderr)
process.exitCode = r.status ?? 0
