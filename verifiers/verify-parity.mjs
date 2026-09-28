// 昆仑 must equal the shipped `standard` preset plus exactly the five local
// modules. This check exists because a self-invented `persistent-shell` group
// silently replaced the shell: the group mounted, but no `pwsh` tool reached the
// model, so 昆仑 could not run a single command while its own persona claimed it
// could. Nothing failed loudly — the tool was simply absent. A row-by-row diff
// against the shipped preset is the only thing that catches that class of bug.
//
// ALLOWED_EXTRA is deliberately explicit: adding a row here is a decision, not
// an accident.
import { spawnSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EXE, DSH, PROFILE, BUNDLE, requireProfile } from './env-paths.mjs'

// Intentional additions, each with a stated reason. Adding a row here is a
// decision; the parity check exists so it can never be an accident.
const ALLOWED_EXTRA = new Set([
  // The five behaviour modules — 昆仑's own mechanisms.
  'working-context',    // durable [Working Context] line folded from the event stream
  'fact-ledger',        // fact_register: pin hard constraints so long sessions cannot forget
  'guard',              // circuit breaker for output-free long reasoning / repeated failures
  'tool-catalog',       // declare the wire presentation; keep catalog and wire in agreement
  'tool-activate',      // paged tool namespaces, loaded on demand
  // Persistent cross-session memory. The ONLY row here that adds a capability the
  // harness does not already ship — the five above reshape how existing tools are
  // used, this one puts nine new tools on the wire. Proven end to end: a fact
  // recorded in one session was recalled by a fresh session that was never told
  // it. See KUNLUN-PROGRESS.md §2.3.
  'mcp-memory',
])

// Rows the shipped `standard` preset carries under a name that CANNOT resolve.
// Declaring a substitution here is a decision, and each one must be justified by
// a resolution check — not by preference.
//
// `workflow-ptc` is the only case. The shipped preset names
// @deepseek-ai/dsh-workflow-ptc, which resolves from NEITHER the profile NOR
// app.asar (verified with createRequire from both roots); the row can never
// start. @deepseek-ai/dsh-workflow provides the same `workflowEngine` service and
// DOES resolve. Keeping the unresolvable name would mean the delegation group
// never activates tool-workflow or tool-ralph, because both inject that service.
const SUBSTITUTIONS = new Map([
  ['delegation/workflow-ptc', { id: 'delegation/workflow', name: '@deepseek-ai/dsh-workflow' }],
])

const probe = String.raw`
const fs = require('fs')
const path = require('path')
const DSH = ${JSON.stringify(DSH)}
const PROFILE = ${JSON.stringify(PROFILE)}
const { createRequire } = require('node:module')
const req = createRequire(path.join(PROFILE, 'noop.js'))
const yaml = require(path.join(PROFILE, 'node_modules', 'js-yaml'))
const JsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: d => ({ __jsExpr: d }) })
const schema = yaml.DEFAULT_SCHEMA.extend([JsType])

function rowsOf(file) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'), { schema }) || []
  let decl = null
  const find = (l) => { for (const r of l) { if (!r || typeof r !== 'object') continue
    if (r.name === '@deepseek-ai/dsh-agent-preset') { decl = r; return }
    if (Array.isArray(r.insert)) find(r.insert) } }
  find(doc)
  if (!decl) return []
  const out = []
  const walk = (list, group) => {
    for (const r of list) {
      if (!r || typeof r !== 'object') continue
      if (Array.isArray(r.config) && (r.group === true || r.name === 'cordis:group')) { walk(r.config, r.id); continue }
      out.push({ id: r.id, name: r.name, group: group ?? null })
    }
  }
  walk(decl.config.plugins ?? [], null)
  return out
}

const webApp = path.dirname(req.resolve('@deepseek-ai/dsh-web-app/package.json', { paths: [DSH] }))
const std = rowsOf(path.join(webApp, 'presets', 'standard.patch.yml'))
const bz = rowsOf(path.join(PROFILE, 'node_modules', 'kunlun-preset-bundle', 'cordis.patch.yml'))
const key = (r) => (r.group ? r.group + '/' : '') + r.id
const stdMap = new Map(std.map((r) => [key(r), r]))
const bzMap = new Map(bz.map((r) => [key(r), r]))

const out = { extra: [], missing: [], mismatch: [] }
for (const [k, r] of bzMap) if (!stdMap.has(k)) out.extra.push({ key: k, name: r.name })
for (const [k, r] of stdMap) if (!bzMap.has(k)) out.missing.push({ key: k, name: r.name })
for (const [k, r] of bzMap) { const s = stdMap.get(k); if (s && s.name !== r.name) out.mismatch.push({ key: k, kunlun: r.name, standard: s.name }) }
console.log('JSON:' + JSON.stringify(out))
`

const script = join(tmpdir(), 'diff2-' + Date.now() + '.cjs')
writeFileSync(script, probe, 'utf8')
const r = spawnSync(EXE, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 120000 })
try { unlinkSync(script) } catch {}

const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('JSON:'))
if (!line) {
  console.log('RESULT: FAIL - could not read the comparison (probe produced no data)')
  if (r.stderr) console.log(r.stderr.slice(0, 500))
  process.exit(1)
}
const d = JSON.parse(line.slice(5))

const problems = []
// A substitution consumes BOTH halves of the deviation: the extra row 昆仑 carries
// and the unresolvable row standard carries. Anything unmatched is still a fault.
const consumedExtra = new Set()
const consumedMissing = new Set()
for (const [stdKey, sub] of SUBSTITUTIONS) {
  const got = d.extra.find((e) => e.key === sub.id && e.name === sub.name)
  if (got) consumedExtra.add(sub.id)
  const lost = d.missing.find((m) => m.key === stdKey)
  if (lost) consumedMissing.add(stdKey)
  if (!got || !lost) problems.push('declared substitution not in effect: ' + stdKey + ' -> ' + sub.id)
}
for (const e of d.extra) if (!ALLOWED_EXTRA.has(e.key) && !consumedExtra.has(e.key)) problems.push('unexpected extra row: ' + e.key + '  (' + e.name + ')')
for (const m of d.missing) if (!consumedMissing.has(m.key)) problems.push('missing row present in standard: ' + m.key + '  (' + m.name + ')')
for (const m of d.mismatch) problems.push('same id, different package: ' + m.key + '  kunlun=' + m.kunlun + '  standard=' + m.standard)

// The shell must actually be advertised.
if (!d.extra.length && !d.missing.length) { /* structure ok */ }

console.log('compared against the shipped standard preset')
console.log('  intentional additions : ' + d.extra.map((e) => e.key).join(', '))
console.log('  missing from kunlun    : ' + (d.missing.map((m) => m.key).join(', ') || '(none)'))
console.log('  package mismatches    : ' + (d.mismatch.map((m) => m.key).join(', ') || '(none)'))
console.log('')
if (problems.length === 0) {
  console.log('RESULT: PASS - 昆仑 is exactly the shipped standard preset plus the')
  console.log('        ' + d.extra.length + ' intentional additions listed in ALLOWED_EXTRA,')
  console.log('        with no other deviation')
} else {
  console.log('RESULT: FAIL')
  for (const p of problems) console.log('  ' + p)
  process.exitCode = 1
}
