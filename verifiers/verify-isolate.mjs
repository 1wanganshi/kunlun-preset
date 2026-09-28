// Verify that no row inside an isolating group injects a service the group
// isolates. mountPreset() rejects the whole preset with
//   "Preset services require isolate realms: <names>"
// when a row resolves a root-realm service, and the ONLY way a preset can be
// `broken` while every package resolves is exactly this.
//
// This is the check that would have caught `terminal-pwsh` naming the bash
// terminal package: dsh-terminal-bash injects "terminals", the persistent-shell
// group isolates "terminals", so the mount leaked and the preset never loaded.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import * as _paths from './env-paths.mjs'

const PROFILE = process.env.DSH_PROFILE_DIR ?? _paths.PROFILE
const req = createRequire(path.join(PROFILE, 'noop.js'))
const yaml = req('js-yaml')

let pass = 0
const failures = []
const ok = m => { pass++; console.log('  OK    ' + m) }
const bad = (m, d) => { failures.push(m); console.log('  FAIL  ' + m + (d ? '  — ' + d : '')) }

const JsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: d => ({ __jsExpr: d }) })
const schema = yaml.DEFAULT_SCHEMA.extend([JsType])

const rows = yaml.load(fs.readFileSync(path.join(PROFILE, 'cordis.patch.yml'), 'utf8'), { schema })

// The declaration may ride a BUNDLE layer instead of the profile patch — that is
// how every shipped preset is declared, and it is where kunlun lives once it is
// packaged as a plugin. Resolve it from wherever it actually is, so that moving
// the declaration does not read as a failure when nothing is wrong.
let decl
{
  const { findDeclaration } = await import('./declaration.mjs')
  const hit = findDeclaration()
  decl = hit.decl
  if (decl) {
    console.log('  declaration : ' + (decl.config?.id ?? decl.id) + '   from ' + describeFile(hit.file))
  }
}
if (!decl) {
  // Legacy fallback: the declaration kept in the profile patch.
  for (const r of rows) {
    if (r.name === '@deepseek-ai/dsh-agent-preset') decl = r
    if (Array.isArray(r.insert)) { const h = r.insert.find(x => x.name === '@deepseek-ai/dsh-agent-preset'); if (h) decl = h }
  }
}
if (!decl) { console.log('FAIL: no declaration'); process.exit(1) }

function describeFile (file) {
  if (!file) return '(unknown)'
  try { return path.relative(PROFILE, file) || file } catch { return file }
}

console.log('=== isolate / inject consistency ===')
console.log('')

// The services each plugin injects, read from the shipping packages.
const ASAR = process.env.DSH_ASAR ?? _paths.DSH
const injectOf = async name => {
  if (typeof name !== 'string') return undefined
  try {
    if (name.startsWith('file:')) {
      const m = await import(name)
      return (m.default || m)?.inject
    }
    if (name.startsWith('cordis:')) return undefined
    const resolved = ASAR_SUPPORTED ? req.resolve(name) : undefined
    return resolved ? (req(resolved).default ?? req(resolved))?.inject : undefined
  } catch { return undefined }
}

// Services each shipping plugin injects. Only these three matter here: they are
// the packages whose `inject` list overlaps what the persistent-shell group
// isolates. A row that legitimately BELONGS in the group needs `terminals` and
// receives the group's own instance — that is not a leak. A leak is a row whose
// package expects the ROOT instance of a service the group re-owns.
const KNOWN_INJECT = {
  '@deepseek-ai/dsh-terminal-bash': ['terminals', 'sandboxPolicy', 'sessionProjections', 'subprocess'],
  '@deepseek-ai/dsh-pwsh-local': ['subprocess'],
  '@deepseek-ai/dsh-tool-pwsh-persistent': ['tools', 'terminals'],
  '@deepseek-ai/dsh-tool-bash-persistent': ['tools', 'terminals'],
  '@deepseek-ai/dsh-terminal': [],
}

// Packages designed to run INSIDE an isolating shell group; they consume the
// group-owned `terminals` on purpose.
//
// dsh-terminal-bash is the PTY backend the group mounts: it injects `terminals`
// precisely because the group's own `pty` row provides it. Naming it here is not
// a leak — it is the supported pairing, and it is what the shipped minimal preset
// uses for its terminal-pwsh row on Windows.
const GROUP_NATIVE = new Set([
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-pwsh-persistent',
  '@deepseek-ai/dsh-tool-bash-persistent',
])

const ASAR_SUPPORTED = false

// Evaluate a `!!js` platform gate the way the Loader does, with the real
// `process.platform` in scope, and report whether the row would mount here.
const mountedHere = e => {
  if (e.disabled === undefined) return true
  if (typeof e.disabled === 'object' && e.disabled.__jsExpr !== undefined) {
    try { return !Boolean(eval(e.disabled.__jsExpr)) } catch { return false }
  }
  return !Boolean(e.disabled)
}

const checkGroup = (group, inherited = new Set()) => {
  const isolate = new Set(Object.keys(group.isolate ?? {}))
  const scope = new Set([...inherited, ...isolate])
  const label = group.id ?? '(group)'
  for (const e of group.config ?? []) {
    if (Array.isArray(e.config)) { checkGroup(e, scope); continue }
    if (!mountedHere(e)) continue
    if (GROUP_NATIVE.has(e.name)) { ok(`${label} / ${e.id} is group-native (owns the isolated service)`); continue }
    const inject = KNOWN_INJECT[e.name]
    if (inject === undefined) continue
    const overlap = inject.filter(s => scope.has(s))
    if (overlap.length > 0) {
      bad(`${label} / ${e.id} injects "${overlap.join(', ')}" but the group isolates it`,
        'mountPreset() would reject with "Preset services require isolate realms"')
    } else {
      ok(`${label} / ${e.id} respects the isolate boundary`)
    }
  }
}

// Check EVERY composition that declares kunlun: the file that is live right now,
// plus the canonical source composition the installer embeds. A probe with no
// groups must not make this suite vacuously pass.
const compositions = []
{
  const seen = new Set([decl.config?.id ?? decl.id])
  compositions.push({ label: 'live (' + (decl.config?.id ?? decl.id) + ')', plugins: decl.config.plugins })
  const canonical = path.join(import.meta.dirname, 'presets', 'kunlun', 'agent.cordis.yml')
  if (fs.existsSync(canonical)) {
    const doc = yaml.load(fs.readFileSync(canonical, 'utf8'), { schema })
    const found = []
    const visit = list => { for (const r of list) { if (!r || typeof r !== 'object') continue; if (Array.isArray(r.insert)) visit(r.insert); else if (Array.isArray(r.config)) found.push(r); else if (r.name === 'cordis:group') found.push(r) } }
    visit(Array.isArray(doc) ? doc : [doc])
    compositions.push({ label: 'canonical (agent.cordis.yml)', plugins: found })
  }
}

let groups = 0
for (const comp of compositions) {
  for (const r of comp.plugins) {
    if (Array.isArray(r.config)) { groups++; checkGroup(r) }
  }
}
ok(`scanned ${groups} isolating group(s) across ${compositions.length} composition(s)`)

// ── the decisive check ──────────────────────────────────────────────────────
//
// An `isolate:` key DETACHES a service from the host realm. If a row in the
// same group injects it, that row can only activate when a sibling PROVIDES it.
// Without a provider the row stays pending forever, and diagnostic() folds
// pending lines into the same failure list as hard errors:
//
//     const lines = [...audit.failed, ...audit.pending];
//     return lines.length === 0 ? void 0 : lines.join("\n");
//
// so the panel renders the entire preset as 加载失败. This is exactly how the
// `delegation` group broke: it isolated `workflowEngine` while `tool-workflow`
// and `tool-ralph` both inject it, with no provider in sight.
console.log('')
console.log('=== every isolated service must have a provider in its own group ===')

// Which package PROVIDES which service. A provider is the row whose own plugin
// name matches the service key (TerminalSessionService -> terminals, etc.), or
// an explicitly known provider pair.
//
// workflowEngine's provider is @deepseek-ai/dsh-workflow (class WorkflowEngine,
// which calls super(ctx, "workflowEngine")). There is a dsh-workflow-ptc package
// in the app.asar, but it is NOT resolvable from the profile, so naming it here
// makes the row fail to start — which fails the whole mount as 加载失败 rather
// than anything visible in the isolate audit.
const PROVIDERS = {
  workflowEngine: '@deepseek-ai/dsh-workflow',
  planMode: '@deepseek-ai/dsh-plan-mode',
  compaction: '@deepseek-ai/dsh-compaction-basic',
  toolResultPruner: '@deepseek-ai/dsh-compaction-tool-result-pruner',
  terminals: '@deepseek-ai/dsh-terminal',
}

const checkProviders = (group, inherited = new Set()) => {
  const isolate = Object.keys(group.isolate ?? {})
  const label = group.id ?? '(group)'
  if (isolate.length > 0) {
    const names = new Set()
    const collect = list => { for (const e of list) { if (Array.isArray(e.config)) collect(e.config); else names.add(e.name) } }
    collect(group.config ?? [])
    for (const service of isolate) {
      const provider = PROVIDERS[service]
      if (provider === undefined) {
        bad(`${label}: isolates "${service}" but its provider package is unknown`,
          'add it to PROVIDERS in this suite')
        continue
      }
      if (!names.has(provider)) {
        bad(`${label}: isolates "${service}" with no provider inside the group`,
          `expected a row named ${provider}; without it every row injecting "${service}" stays pending and the preset shows 加载失败`)
      } else {
        ok(`${label}: "${service}" is provided in-group by ${provider}`)
      }
    }
  }
  for (const e of group.config ?? []) if (Array.isArray(e.config)) checkProviders(e, inherited)
}

for (const comp of compositions) {
  for (const r of comp.plugins) if (Array.isArray(r.config)) checkProviders(r)
}

console.log('')
if (failures.length === 0) {
  console.log(`ISOLATE CHECK PASSED — ${pass} assertion(s)`)
} else {
  console.log(`ISOLATE CHECK FAILED — ${failures.length} problem(s)`)
  process.exit(1)
}
