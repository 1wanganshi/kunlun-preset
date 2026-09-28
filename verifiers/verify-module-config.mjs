// Verify the COMPOSITION SOURCE for the exact defect that cost several restarts.
//
// History, so this is not "fixed" the wrong way twice:
//
//   1. The composition wrote `pagedToolPatterns:` with no value.
//   2. YAML yields null for that; the validator rejected null and accepted
//      only undefined, so the preset failed to mount.
//   3. The first fix changed both sites to `[]` AND loosened the validator to
//      accept null. That is belt-and-braces, but it made a later "run the
//      validator" suite PASS even against the broken input — a false green.
//
// So this suite checks the SOURCE TEXT for the ambiguous form, which is the
// defect itself, plus the validator for the null tolerance. Both facts are
// asserted independently; neither can mask the other.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as _paths from './env-paths.mjs'

// PROFILE is destructured explicitly: this suite builds paths from it below, and a
// namespace import does not bring its members into scope.
const { PROFILE } = _paths
const CANON = join(_paths.PLUGIN, 'presets', 'kunlun', 'agent.cordis.yml')
const MODULES = join(_paths.PLUGIN, 'presets', 'kunlun')

// Keys whose MODULE requires an array, and which must therefore never be
// written in YAML's valueless form. A valueless key yields null, not [].
const ARRAY_KEYS = ['pagedToolPatterns']

const problems = []
let assertions = 0

// --- 1. source text: no valueless form of an array-valued key --------------
const src = readFileSync(CANON, 'utf8').split(/\r?\n/)
for (const key of ARRAY_KEYS) {
  for (let i = 0; i < src.length; i++) {
    const line = src[i]
    if (/^\s*#/.test(line)) continue
    const m = new RegExp('^(\\s*)' + key + ':\\s*$').exec(line)
    if (!m) continue
    assertions++
    problems.push({
      what: 'valueless YAML key in the composition',
      where: CANON,
      line: i + 1,
      detail: '`' + key + ':` with no value parses to null; the module requires an array.'
        + ' Write `' + key + ': []` to mean none.',
    })
  }
}

// --- 2. the built bundle carries an ARRAY, not null ------------------------
{
  const { createRequire } = await import('node:module')
  const req = createRequire(join(PROFILE, 'noop.js'))
  const yaml = req(join(PROFILE, 'node_modules', 'js-yaml'))
  const JsType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', resolve: () => true, construct: (d) => ({ __jsExpr: d }),
  })
  const schema = yaml.DEFAULT_SCHEMA.extend([JsType])
  const built = join(PROFILE, 'node_modules', 'kunlun-preset-bundle', 'cordis.patch.yml')
  const doc = yaml.load(readFileSync(built, 'utf8'), { schema }) || []
  const rows = doc[0].insert[0].config.plugins
  const flat = []
  const walk = (list) => { for (const r of list) { if (!r || typeof r !== 'object') continue; if (Array.isArray(r.config)) { walk(r.config); continue } flat.push(r) } }
  walk(rows)
  for (const r of flat) {
    for (const key of ARRAY_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(r.config ?? {}, key)) continue
      assertions++
      const v = r.config[key]
      if (!Array.isArray(v)) {
        problems.push({
          what: 'built bundle carries a non-array for an array-valued key',
          where: 'bundle row ' + r.id,
          detail: key + ' = ' + JSON.stringify(v),
        })
      }
    }
  }
}

// --- 3. the validator tolerates null (defence in depth) -------------------
try {
  const mod = await import(pathToFileURL(join(MODULES, 'paging.mjs')).href)
  assertions++
  try {
    mod.validatePagedToolPatterns('probe', null)
  } catch (e) {
    problems.push({ what: 'validator still rejects null', where: 'paging.mjs', detail: e.message })
  }
} catch (e) {
  problems.push({ what: 'could not import paging.mjs', where: MODULES, detail: e.message })
}

console.log('assertions evaluated: ' + assertions)
console.log('')
if (problems.length === 0) {
  console.log('RESULT: PASS - array-valued config keys are written explicitly, and the')
  console.log('        built bundle carries arrays')
} else {
  console.log('RESULT: FAIL')
  for (const p of problems) {
    console.log('  ' + p.what)
    console.log('     at ' + p.where + (p.line ? ':' + p.line : ''))
    console.log('     ' + p.detail)
  }
  process.exitCode = 1
}
