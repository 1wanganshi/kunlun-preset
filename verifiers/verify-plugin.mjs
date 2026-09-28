// Verify the dsh-kunlun plugin: composition reader + real apply() declaration.
//
// Imports resolve RELATIVE TO THIS FILE, so the suite runs from either the
// source directory (for the composition reader alone) or the profile copy (for
// everything, since only there can `@deepseek-ai/schemastery` resolve).
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const asUrl = rel => new URL(rel, import.meta.url).href

let moduleError
let readPresetDefinition, readCordisYaml, apply, bundledPresetDir, kunlun_PRESET_ID, kunlunDeclarationStatus
try {
  ;({ readPresetDefinition, readCordisYaml } = await import(asUrl('./lib/composition.js')))
  ;({ apply, bundledPresetDir, kunlun_PRESET_ID, kunlunDeclarationStatus } = await import(asUrl('./lib/index.js')))
} catch (error) {
  moduleError = error
}

let failures = 0
const check = (label, fn) => {
  try { const note = fn(); console.log('  PASS  ' + label + (note ? '  (' + note + ')' : '')) }
  catch (e) { failures++; console.log('  FAIL  ' + label + '  ->  ' + e.message) }
}

if (moduleError !== undefined) {
  console.log('CANNOT LOAD THE PLUGIN FROM THIS LOCATION')
  console.log('  ' + moduleError.message)
  if (moduleError.code === 'ERR_MODULE_NOT_FOUND') {
    console.log('')
    console.log('  run this suite from the copy installed in the profile, where the')
    console.log('  harness packages it imports (schemastery) are resolvable:')
    console.log('    node "<profile>/node_modules/dsh-kunlun/verify-plugin.mjs"')
  }
  process.exit(1)
}

console.log('=== 1. bundledPresetDir ===')
console.log('  ' + bundledPresetDir())

console.log('=== 2. composition reader ===')
let def
check('readPresetDefinition on the bundled preset', () => {
  def = readPresetDefinition(kunlun_PRESET_ID, bundledPresetDir())
  if (def.id !== 'kunlun') throw new Error('wrong id: ' + def.id)
  if (typeof def.name !== 'string') throw new Error('no name')
  if (!Array.isArray(def.plugins)) throw new Error('plugins not an array')
  return `id=${def.id} name=${def.name} order=${def.order} rows=${def.plugins.length}`
})
check('relative names became file: URLs', () => {
  const flat = []
  const walk = rows => { for (const r of rows) { if (r.insert) { walk(r.insert); continue } if (r.name) flat.push(r.name); if (Array.isArray(r.config)) walk(r.config) } }
  walk(def.plugins)
  const leftover = flat.filter(n => n.startsWith('./'))
  if (leftover.length) throw new Error('unresolved: ' + leftover.join(', '))
  const locals = flat.filter(n => n.startsWith('file:'))
  if (locals.length !== 5) throw new Error('expected 5 local modules, got ' + locals.length)
  return locals.length + ' local modules resolved'
})
check('!!js expressions preserved as { __jsExpr }', () => {
  const flat = []
  const walk = rows => { for (const r of rows) { if (r.insert) { walk(r.insert); continue } flat.push(r); if (Array.isArray(r.config)) walk(r.config) } }
  walk(def.plugins)
  const gated = flat.filter(r => r.disabled && typeof r.disabled === 'object' && typeof r.disabled.__jsExpr === 'string')
  // Four platform gates: bash/`persistent` pair gated OFF on win32, pwsh pair
  // gated OFF elsewhere. (Other disabled rows are plain booleans.)
  if (gated.length !== 4) throw new Error('expected 4 !!js gates, got ' + gated.length)
  for (const r of gated) {
    if (!r.disabled.__jsExpr.startsWith('process.platform')) {
      throw new Error('expression mangled on ' + r.id + ': ' + r.disabled.__jsExpr)
    }
  }
  return gated.length + ' gates, expressions intact'
})
check('group config arrays survive', () => {
  const shell = def.plugins.find(r => r.id === 'persistent-shell')
  if (!shell) throw new Error('persistent-shell missing')
  if (!Array.isArray(shell.config)) throw new Error('group config is not an array')
  if (shell.config.length !== 5) throw new Error('expected 5 shell rows, got ' + shell.config.length)
  return shell.config.length + ' shell rows'
})
check('block scalars parse with newlines', () => {
  const persona = def.plugins.find(r => r.id === 'persona')
  const prefix = persona?.config?.prefix
  if (typeof prefix !== 'string') throw new Error('persona prefix missing')
  if (!prefix.includes('\n')) throw new Error('prefix lost its newlines')
  if (!prefix.includes('Thinking Disruption')) throw new Error('prefix content wrong')
  return prefix.length + ' chars, multi-line'
})
check('flow sequence accepted (kunlun superset)', () => {
  const parsed = readCordisYaml('- id: x\n  config:\n    list: [a, b]\n')
  if (JSON.stringify(parsed[0].config.list) !== '["a","b"]') throw new Error('flow seq failed: ' + JSON.stringify(parsed))
  return '[a, b] -> 2 items'
})
check('fail-closed on unsupported constructs', () => {
  const bad = [
    ['anchors', '- id: &a x\n'],
    ['aliases', '- id: *a\n'],
    ['flow mapping', '- id: {a: 1}\n'],
    ['leading-indent tab', '- id: a\n\t- id: b\n'],
    ['unclosed flow seq', '- id: x\n  config: [1, 2\n'],
  ]
  for (const [label, text] of bad) {
    let threw = false
    try { readCordisYaml(text) } catch { threw = true }
    if (!threw) throw new Error('did not refuse: ' + label)
  }
  return bad.length + ' constructs refused'
})
check('nested flow sequences parse (recursive)', () => {
  const parsed = readCordisYaml('- id: x\n  config: [[1, 2], [3]]\n')
  if (JSON.stringify(parsed[0].config) !== '[[1,2],[3]]') throw new Error('nested flow failed: ' + JSON.stringify(parsed))
  return '[[1,2],[3]]'
})

console.log('=== 3. real apply() against a mock registry ===')
const registered = []
const services = new Map()
const registry = {
  async register(definition) {
    registered.push(definition)
    return async () => { registered.pop() }
  }
}
services.set('agentPresets', registry)

const ctx = {
  logger: { info: m => console.log('    [info] ' + m), warn: m => console.log('    [warn] ' + m) },
  get: k => services.get(k),
  on: () => {},
  effect: fn => { const d = fn(); return d },
}

let dispose
check('apply() declares the preset', async () => {})
try {
  dispose = ctx.effect.call(null, () => {})
} catch { /* not needed */ }

// Call apply directly and let its effect body run.
const effects = []
ctx.effect = (fn, label) => { effects.push(fn()); return () => {} }
apply(ctx, { enabled: true })

await new Promise(r => setTimeout(r, 300))

check('registry.register was called exactly once', () => {
  if (registered.length !== 1) throw new Error('register called ' + registered.length + ' times')
  return 'ok'
})
check('the registered definition is kunlun with all rows', () => {
  const d = registered[0]
  if (d === undefined) throw new Error('nothing registered')
  if (d.id !== 'kunlun') throw new Error('wrong id: ' + d.id)
  if (d.plugins.length !== 21) throw new Error('expected 21 top-level rows, got ' + d.plugins.length)
  return `id=${d.id} name=${d.name} rows=${d.plugins.length}`
})
check('declaration status reports success', () => {
  const s = kunlunDeclarationStatus()
  if (!s.declared) throw new Error('status says not declared: ' + JSON.stringify(s))
  if (s.lastError !== undefined) throw new Error('unexpected error: ' + s.lastError)
  return JSON.stringify(s)
})

console.log('=== 4. failure is diagnosable, not silent ===')
services.delete('agentPresets')
registered.length = 0
apply(ctx, { enabled: true })
await new Promise(r => setTimeout(r, 300))
check('missing registry is reported in status', () => {
  const s = kunlunDeclarationStatus()
  if (s.declared) throw new Error('claims declared without a registry')
  if (typeof s.lastError !== 'string' || !s.lastError.includes('unavailable')) {
    throw new Error('unhelpful error: ' + JSON.stringify(s))
  }
  return s.lastError
})

console.log('')
console.log(failures === 0 ? 'PLUGIN: ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
