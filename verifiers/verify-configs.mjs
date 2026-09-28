// verify-configs.mjs — prove every preset row satisfies its plugin's Config.
//
// WHY THIS EXISTS
// A row whose plugin declares a REQUIRED config field fails to mount when the row
// omits `config:` entirely. The host reports it as:
//
//     persona (@deepseek-ai/dsh-persona): invalid config:
//     - $.prefix missing required value (at prefix)
//
// and the panel renders it as 加载失败. That class of bug is invisible to every
// other check we run (the YAML is valid, the package resolves, composeEntries
// keeps the row) because it only surfaces when the host INSTANTIATES the plugin.
//
// This script instantiates each row's Config schema with the row's config — the
// same call the mount makes — so the failure appears at build time instead.
//
// Usage:  node verify-configs.mjs [path-to-composition.yml]
//
// Exits non-zero if any schema-bearing row rejects its config.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { EXE, DSH, PROFILE, BUNDLE, requireProfile } from './env-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// Compose the set of files to check: whatever the caller named, plus the two the
// plugin actually ships (the generated row block and the bundle's declaration).
const defaultTargets = [
  join(PROFILE, 'cordis.kunlun.yml'),
  join(PROFILE, 'node_modules', 'kunlun-preset-bundle', 'cordis.patch.yml'),
  join(here, 'presets', 'kunlun', 'agent.cordis.yml'),
]

const targets = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : defaultTargets.filter(existsSync)

const check = String.raw`
const path = require('path')
const fs = require('fs')
const DSH = ${JSON.stringify(DSH)}
const PROFILE = ${JSON.stringify(PROFILE)}
const { createRequire } = require('module')

const yaml = require(path.join(PROFILE, 'node_modules', 'js-yaml'))
// Preset compositions may carry !!js platform gates; resolve them as opaque
// values (the real decision belongs to the mounting host, not to this check).
const JsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: d => ({ __jsExpr: d }) })
const schema = yaml.DEFAULT_SCHEMA.extend([JsType])

const req = createRequire(path.join(DSH, 'noop.js'))

const load = async name => {
  if (typeof name !== 'string' || name.startsWith('cordis:')) return undefined
  if (name.startsWith('file:')) { const m = await import(name); return m.default ?? m }
  try { const m = req(req.resolve(name)); return m.default ?? m } catch { return undefined }
}

// Pull the plugin rows out of whatever document shape the file uses: a bare
// insert wrapper, a plain list, or a single declarer row.
const rowsOf = doc => {
  const out = []
  const visit = list => {
    for (const r of list) {
      if (!r || typeof r !== 'object') continue
      if (r.name === '@deepseek-ai/dsh-agent-preset' && r.config && Array.isArray(r.config.plugins)) out.push(...r.config.plugins)
      else if (Array.isArray(r.insert)) visit(r.insert)
    }
  }
  visit(Array.isArray(doc) ? doc : [doc])
  return out
}

const results = { ok: 0, bad: 0, noschema: 0, unresolved: 0 }
const problems = []
const unresolvedNames = new Set()

const walk = async rows => {
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    if (Array.isArray(row.config)) { await walk(row.config); continue }
    const impl = await load(String(row.name))
    if (impl === undefined) { results.unresolved++; unresolvedNames.add(String(row.name)); continue }
    const Config = impl.Config
    if (Config === undefined) { results.noschema++; continue }
    try {
      new Config(row.config ?? {})
      results.ok++
    } catch (e) {
      results.bad++
      problems.push({ id: row.id, name: row.name, msg: String(e.message) })
    }
  }
}

;(async () => {
  const files = process.argv.slice(2)
  for (const f of files) {
    const doc = yaml.load(fs.readFileSync(f, 'utf8'), { schema })
    const rows = rowsOf(doc)
    console.log('FILE ' + f)
    console.log('  rows found: ' + rows.length)
    await walk(rows)
  }
  console.log('')
  console.log('  config OK         : ' + results.ok)
  console.log('  config INVALID    : ' + results.bad)
  console.log('  no Config schema  : ' + results.noschema)
  console.log('  unresolved module : ' + results.unresolved)
  if (unresolvedNames.size > 0) {
    for (const n of unresolvedNames) console.log('     unresolved: ' + n)
  }
  console.log('')
  if (problems.length === 0) {
    console.log('RESULT: PASS - every schema-bearing row accepts its config')
  } else {
    console.log('RESULT: FAIL - these rows would render as 加载失败:')
    for (const p of problems) {
      console.log('  ' + p.id + ' (' + p.name + ')')
      for (const line of p.msg.split('\n')) console.log('     ' + line)
    }
    process.exitCode = 1
  }
})().catch(e => { console.log('FATAL: ' + e.message); process.exitCode = 2 })
`

const tmp = join(PROFILE, '_verify-configs-run.cjs')
const { writeFileSync, unlinkSync } = await import('node:fs')
writeFileSync(tmp, check, 'utf8')

const r = spawnSync(EXE, [tmp, ...targets], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  timeout: 240000,
})

try { unlinkSync(tmp) } catch {}
if (r.stdout) process.stdout.write(r.stdout)
if (r.stderr) process.stderr.write(r.stderr)
process.exitCode = r.status ?? 0
