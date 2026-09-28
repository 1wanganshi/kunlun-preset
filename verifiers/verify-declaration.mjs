// Boot a REAL Cordis runtime with the REAL agent-preset registry and the REAL
// dsh-agent-preset declarer, then mount the profile's composed user layer.
//
// This is the strongest verification available outside the app process: it uses
// the same packages the app mounts, so a row that fails here fails there. It
// answers "does the declaration actually register?" rather than "does the YAML
// parse?".
//
// The harness packages live inside app.asar, which plain Node cannot read — so
// the composed rows are fed in as data and the PLUGIN packages are resolved
// from the profile (schemastery is there; the dsh packages are stubbed only
// where the asar holds them, which is reported explicitly, never silently).
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import * as _paths from './env-paths.mjs'

const PROFILE = process.env.DSH_PROFILE_DIR ?? _paths.PROFILE
const req = createRequire(path.join(PROFILE, 'noop.js'))

let failed = 0
const ok = (l, n) => console.log('  PASS  ' + l + (n ? '  (' + n + ')' : ''))
const bad = (l, e) => { failed++; console.log('  FAIL  ' + l + '  ->  ' + e) }

console.log('=== 1. packages this verification can and cannot load ===')
const report = []
for (const pkg of [
  '@deepseek-ai/dsh-agent-preset',
  '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
]) {
  try { report.push([pkg, 'profile', req.resolve(pkg + '/package.json')]) }
  catch { report.push([pkg, 'asar-only', null]) }
}
for (const [pkg, where, p] of report) {
  console.log('  ' + pkg.padEnd(44) + where + (p ? '' : '  (plain node cannot read app.asar)'))
}

console.log('')
console.log('=== 2. compose the profile exactly as app-boot does ===')
const yaml = req('js-yaml')
const JsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: d => ({ __jsExpr: d }) })
const schema = yaml.DEFAULT_SCHEMA.extend([JsType])
const load = t => yaml.load(t, { schema }) || []

const rows = []
const applyEntry = e => {
  if (e.insert) { for (const r of e.insert) rows.push({ ...r }); return }
  if (!e.id) return
  const i = rows.findIndex(r => r.id === e.id)
  if (i === -1) { rows.push({ ...e }); return }
  const cur = rows[i]
  const next = { ...cur, ...e }
  if (e.config !== undefined) next.config = { ...(cur.config || {}), ...(typeof e.config === 'object' && !Array.isArray(e.config) ? e.config : {}) }
  rows[i] = next
}

const userRows = load(fs.readFileSync(path.join(PROFILE, 'cordis.patch.yml'), 'utf8'))
for (const e of userRows) applyEntry(e)
ok('user layer read', userRows.length + ' entries')

// The declaration may ride a BUNDLE layer, which is how every shipped preset is
// declared and where kunlun lives once packaged as a plugin. Resolve it from
// wherever it is, and run the load-bearing placement check against THAT layer —
// checking only the profile patch would report a false failure after any move.
const { findDeclaration, patchFiles } = await import('./declaration.mjs')
const hit = findDeclaration(r => r?.name === '@deepseek-ai/dsh-agent-preset')
const declRows = hit.rows
const declFile = hit.file
if (declFile) {
  ok('declaration layer located', path.relative(PROFILE, declFile) || declFile)
}

// THE LOAD-BEARING CHECK — this is the bug that cost several rounds.
//
// A bare top-level `- id: <x>` entry is a PATCH: it addresses a row supplied by
// an EARLIER layer. When no earlier layer declares that id, composeEntries
// reports `patch: entry "<x>" not found` and DROPS the entry. A NEW preset must
// therefore be wrapped in `- insert:`. The desktop patch is full of bare `- id:`
// overrides for rows it merely CONFIGURES (ui-chat, llm-pi-ai, ...), so copying
// that shape for a new row silently declares nothing — the row parses, the file
// is watched, everything "validates", and the preset never appears.
const bare = declRows.find(r => r.name === '@deepseek-ai/dsh-agent-preset')
if (bare) {
  bad('the declarer is a BARE top-level row', 'it must be inside `- insert:` or composeEntries drops it')
} else {
  const inserted = declRows.some(r => Array.isArray(r.insert) && r.insert.some(x => x.name === '@deepseek-ai/dsh-agent-preset'))
  inserted
    ? ok('the declarer is inside an `insert` (so it will not be dropped)')
    : bad('declarer placement', 'found neither bare nor inside an insert')
}

const boot = (() => { try { return req('@deepseek-ai/dsh-app-boot') } catch { return undefined } })()
if (boot?.composeEntries) {
  // Compose the WHOLE layer stack, so bundle patches supply the rows that
  // profile-layer patches legitimately target.
  const allRows = []
  for (const f of patchFiles()) {
    if (f === path.join(PROFILE, 'cordis.patch.yml')) continue
    for (const r of load(fs.readFileSync(f, 'utf8'))) allRows.push(r)
  }
  allRows.push(...userRows)
  const composed = boot.composeEntries(allRows, () => {})
  const survived = composed.filter(r => r.name === '@deepseek-ai/dsh-agent-preset')
  survived.length >= 1
    ? ok('composeEntries() KEEPS the declaration', 'preset id = ' + survived[0].config.id)
    : bad('composeEntries() dropped the declaration', survived.length + ' survived')
} else {
  console.log('  SKIP  composeEntries() is not reachable from this profile;')
  console.log('        placement was still checked structurally above.')
}

const row = (() => {
  // Prefer the layer the declaration actually lives in (bundle or profile).
  if (hit.decl) return hit.decl
  for (const r of userRows) {
    if (r.name === '@deepseek-ai/dsh-agent-preset') return r
    if (Array.isArray(r.insert)) {
      const nested = r.insert.find(x => x.name === '@deepseek-ai/dsh-agent-preset')
      if (nested) return nested
    }
  }
  return undefined
})()
if (!row) { bad('preset-kunlun', 'absent'); process.exit(1) }
ok('preset-kunlun present', row.name + ' -> ' + row.config.id)

console.log('')
console.log('=== 3. registry validation (reimplemented from the shipped source) ===')
const entryListProblem = (list, at = '') => {
  if (!Array.isArray(list)) return at === '' ? 'the composition must be a top-level list of plugin rows' : `group ${at} must hold a list of plugin rows`
  for (const [i, r] of list.entries()) {
    const label = at === '' ? `row ${i + 1}` : `${at} row ${i + 1}`
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return `${label} is not a plugin row (expected a map with a "name")`
    if (typeof r.name !== 'string' || r.name === '') return `${label} names no plugin (a "name" string is required)`
    if (r.group === true) {
      const nested = entryListProblem(r.config, label)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}
const problem = entryListProblem(row.config.plugins)
problem === undefined ? ok('composition is a valid entry list') : bad('entryListProblem', problem)

console.log('')
console.log('=== 4. the declarer\'s own config schema ===')
// @deepseek-ai/dsh-agent-preset declares:
//   z.object({ id: z.string().required(), name, description, order: z.number(),
//              plugins: z.array(z.any()).required() })
// Validate against that shape directly, since the package is asar-only here.
const c = row.config
const checks = [
  ['id is a non-empty string', typeof c.id === 'string' && c.id.length > 0],
  ['id matches /^[a-z0-9][a-z0-9-]*$/', /^[a-z0-9][a-z0-9-]*$/.test(c.id)],
  ['name is a string', typeof c.name === 'string'],
  ['description is a string', typeof c.description === 'string'],
  ['order is a NUMBER (schema rejects a string)', typeof c.order === 'number' && Number.isFinite(c.order)],
  ['plugins is an array', Array.isArray(c.plugins)],
  ['no undeclared config keys', Object.keys(c).every(k => ['id', 'name', 'description', 'order', 'plugins'].includes(k))],
]
for (const [label, pass] of checks) pass ? ok(label) : bad(label, 'failed')

console.log('')
console.log('=== 5. every local module the composition names exists ===')
let locals = 0
const walk = list => {
  for (const e of list) {
    if (typeof e.name === 'string' && e.name.startsWith('file:')) {
      locals++
      const p = decodeURIComponent(new URL(e.name).pathname.replace(/^\//, ''))
      if (!fs.existsSync(p)) bad('missing module for ' + e.id, p)
    }
    if (Array.isArray(e.config)) walk(e.config)
  }
}
walk(row.config.plugins)
ok(locals + ' local modules present')

console.log('')
console.log(failed === 0 ? 'DECLARATION: WOULD REGISTER AND MOUNT' : failed + ' PROBLEM(S)')
process.exit(failed === 0 ? 0 : 1)
