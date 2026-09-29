// Checker + two-way gate for the coverage suite.
//
// The gate's job is the same as everywhere else in this project: prove each case can
// PASS with a correct answer and FAIL with a plausible wrong one. Six of my own errors
// have been caught this way; one more was caught before this file even existed (T7's
// fixture had no bug at all, so every attempt would have "passed").
//
// Scoring is per-case and independent — there is no cross-model comparison, because the
// question here is "can the preset finish this category of work", not "is it better
// than X".
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { COVERAGE_CASES } from './coverage-cases.mjs'

// ── fixture setup ──────────────────────────────────────────────────────────
export function writeSetup(dir, files) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body, 'utf8')
  }
}

// ── per-kind checks ────────────────────────────────────────────────────────
async function checkModule(dir, spec) {
  const f = join(dir, spec.file)
  if (!existsSync(f)) return { pass: 0, total: spec.cases.length + (spec.throws?.length ?? 0) + (spec.custom ? 1 : 0), failures: ['file not written'] }
  let mod
  try { mod = await import(pathToFileURL(f).href + '?t=' + Date.now()) }
  catch (e) { return { pass: 0, total: 1, failures: ['import failed: ' + String(e.message).slice(0, 100)] } }

  const fn = mod[spec.exportName]
  if (typeof fn !== 'function') return { pass: 0, total: 1, failures: ['export ' + spec.exportName + ' missing'] }

  let pass = 0
  const total = spec.cases.length + (spec.throws?.length ?? 0) + (spec.custom ? 1 : 0)
  const failures = []

  for (const [args, want] of spec.cases) {
    try {
      const got = fn(...args)
      if (deepEqual(got, want)) pass++
      else failures.push(args.join(',') + ' -> ' + JSON.stringify(got))
    } catch (e) { failures.push(args.join(',') + ' threw') }
  }
  for (const args of spec.throws ?? []) {
    try { fn(...args); failures.push('expected throw for ' + JSON.stringify(args)) }
    catch { pass++ }
  }
  if (spec.custom === 'queue') {
    try {
      const q = new mod.Queue(3)
      for (let i = 1; i <= 5; i++) q.push(i)
      if (q.size() === 3 && q.first() === 3) pass++
      else failures.push('queue gave size=' + q.size() + ' first=' + q.first() + ', want 3 and 3')
    } catch (e) { failures.push('queue threw: ' + e.message) }
  }
  return { pass, total, failures }
}

function checkGrepAbsent(dir, spec) {
  const files = ['a.mjs', 'b.mjs', 'c.mjs']
  let pass = 0
  const total = 1 + 1 + (spec.behaviour ? 1 : 0)
  const failures = []
  let allGone = true
  let anyThere = false
  let missingFile = false
  for (const f of files) {
    const p = join(dir, f)
    if (!existsSync(p)) { missingFile = true; failures.push(f + ' missing'); continue }
    const t = readFileSync(p, 'utf8')
    for (const s of spec.absent) if (new RegExp('\\b' + s + '\\b').test(t)) allGone = false
    for (const s of spec.present) if (new RegExp('\\b' + s + '\\b').test(t)) anyThere = true
  }
  // The old name must be gone from EVERY file.
  if (allGone && !missingFile) pass++; else if (!missingFile) failures.push('old name still referenced')
  // The new name must appear in AT LEAST ONE file. An earlier version required it in
  // every file, which is wrong: c.mjs only imports functions and legitimately mentions
  // neither name, so the reference solution was reported as broken.
  if (anyThere) pass++; else failures.push('new name missing everywhere')
  if (spec.behaviour) pass++
  return { pass, total, failures }
}

async function checkBehaviour(dir, spec) {
  const f = join(dir, spec.file)
  if (!existsSync(f)) return false
  try {
    const mod = await import(pathToFileURL(f).href + '?t=' + Date.now())
    return deepEqual(mod[spec.exportName](...spec.args), spec.want)
  } catch { return false }
}

function checkFileEquals(dir, spec) {
  const p = join(dir, spec.file)
  if (!existsSync(p)) return { pass: 0, total: 1, failures: [spec.file + ' not written'] }
  const got = readFileSync(p, 'utf8').trim().replace(/\\/g, '/')
  const ok = spec.want.some((w) => got === w || got.endsWith(w))
  return { pass: ok ? 1 : 0, total: 1, failures: ok ? [] : ['got "' + got.slice(0, 80) + '"'] }
}

// Order-insensitive deep equality for JSON values.
//
// `JSON.stringify(a) === JSON.stringify(b)` is wrong for objects: key order is not
// meaningful in JSON, but stringify preserves insertion order. A run that produced
// {"cherry":1,"banana":2,"apple":3} was scored as a failure against
// {"apple":3,"banana":2,"cherry":1} even though the two documents are identical.
// Arrays DO have meaningful order, so they are still compared element by element.
export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => deepEqual(x, b[i]))
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
    return ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

function checkJsonEquals(dir, spec) {
  // A case may declare extra acceptable locations for the same artifact, because more
  // than one placement can be a defensible reading of the request. Without this, a
  // correct result written next to its input scored as a JSON-handling failure.
  const candidates = [spec.file, ...(spec.acceptAlso ?? [])]
  const hit = candidates.map((f) => join(dir, f)).find((p) => existsSync(p))
  const p = hit ?? join(dir, spec.file)
  if (!hit) return { pass: 0, total: 1, failures: [spec.file + ' not written'] }
  const buf = readFileSync(p)
  // A UTF-8 BOM makes `JSON.parse` throw even when the JSON itself is valid. That IS a
  // real defect worth reporting — but it is a different defect from "the values are
  // wrong", and conflating the two hides both. So judge the content with the BOM
  // stripped, and report the BOM as its own finding.
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const text = hasBom ? buf.subarray(3).toString('utf8') : buf.toString('utf8')
  let got
  try { got = JSON.parse(text) }
  catch (e) { return { pass: 0, total: 1, failures: ['not valid JSON: ' + String(e.message).slice(0, 70)], hasBom } }
  const ok = deepEqual(got, spec.want)
  const failures = ok ? [] : ['got ' + JSON.stringify(got).slice(0, 90)]
  if (hasBom && ok) failures.push('content correct but written with a UTF-8 BOM — JSON.parse rejects it')
  return { pass: ok ? 1 : 0, total: 1, failures, hasBom }
}

function checkCsvEquals(dir, spec) {
  const p = join(dir, spec.file)
  if (!existsSync(p)) return { pass: 0, total: 1, failures: [spec.file + ' not written'] }
  const raw = readFileSync(p, 'utf8')
  const lines = raw.trim().split(/\r?\n/).map((l) => l.split(',').map((c) => c.trim()))
  const want = [spec.header, ...spec.rows]
  const ok = lines.length === want.length && want.every((r, i) => JSON.stringify(lines[i]) === JSON.stringify(r))
  return { pass: ok ? 1 : 0, total: 1, failures: ok ? [] : ['got ' + JSON.stringify(lines).slice(0, 110)] }
}

export async function checkCase(dir, c) {
  const k = c.check.kind
  if (k === 'module') return checkModule(dir, c.check)
  if (k === 'fileEquals') return checkFileEquals(dir, c.check)
  if (k === 'jsonEquals') return checkJsonEquals(dir, c.check)
  if (k === 'csvEquals') return checkCsvEquals(dir, c.check)
  if (k === 'grepAbsent') {
    const r = checkGrepAbsent(dir, c.check)
    // behaviour is verified separately so the whole case is all-or-nothing
    if (c.check.behaviour) {
      const ok = await checkBehaviour(dir, c.check.behaviour)
      if (!ok) return { ...r, failures: [...r.failures, 'behaviour changed'] }
    }
    return r
  }
  return { pass: 0, total: 1, failures: ['unknown check kind ' + k] }
}

// ── reference answers (a correct solution for each case) ───────────────────
const REFERENCE = {
  'T1-write-module': {
    'src/version.mjs': `export function compare(a, b) {
  const p = (v) => {
    const m = /^(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(v)
    if (!m) throw new Error('invalid version: ' + v)
    return [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  const x = p(a), y = p(b)
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1 }
  return 0
}
`,
  },
  'T2-fix-existing': {
    'src/parse.mjs': `export function parseConfig(text) {
  const out = {}
  for (const line of text.split('\\n')) {
    if (line.trim() === '') continue
    if (line.trim().startsWith('#')) continue
    const i = line.indexOf('=')
    if (i === -1) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
`,
  },
  'T3-multi-file-refactor': {
    'a.mjs': `export const LABEL = 'alpha'\nexport function greet() { return 'hello ' + LABEL }\n`,
    'b.mjs': `import { LABEL } from './a.mjs'\nexport function shout() { return LABEL.toUpperCase() }\n`,
    'c.mjs': `import { greet } from './a.mjs'\nimport { shout } from './b.mjs'\nexport function both() { return greet() + ' ' + shout() }\n`,
  },
  'T4-find-in-tree': {
    'answer.txt': 'lib/util/totals.ts\n',
  },
  'T5-run-command': {
    'counts.json': JSON.stringify({ apple: 3, banana: 2, cherry: 1 }, null, 2) + '\n',
  },
  'T6-generate-data': {
    'report.csv': 'id,name,score\n1,user1,10\n2,user2,20\n3,user3,30\n4,user4,40\n5,user5,50\n',
  },
  'T7-debug-symptom': {
    'src/queue.mjs': `export class Queue {
  constructor(limit) {
    this.limit = limit
    this.items = []
  }
  push(item) {
    this.items.push(item)
    while (this.items.length > this.limit) this.items.shift()
  }
  size() { return this.items.length }
  first() { return this.items[0] }
}
`,
  },
}

// ── plausible WRONG answers, one per case ──────────────────────────────────
const WRONG = {
  // does not validate the input shape
  'T1-write-module': {
    why: 'no validation — returns a comparison instead of throwing',
    files: { 'src/version.mjs': `export function compare(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1 }
  return 0
}
` },
  },
  // handles comments but forgets that a missing "=" must be skipped, and does not trim
  'T2-fix-existing': {
    why: 'does not skip lines without "=" and does not trim',
    files: { 'src/parse.mjs': `export function parseConfig(text) {
  const out = {}
  for (const line of text.split('\\n')) {
    if (line === '' || line.startsWith('#')) continue
    const i = line.indexOf('=')
    out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}
` },
  },
  // renames only the definition site, leaving the importers broken
  'T3-multi-file-refactor': {
    why: 'renamed the export but not the importers',
    files: { 'a.mjs': `export const LABEL = 'alpha'\nexport function greet() { return 'hello ' + LABEL }\n` },
  },
  // picks the first textual match instead of the right one
  'T4-find-in-tree': {
    why: 'picked the deprecated legacy file, the first filename match',
    files: { 'answer.txt': 'lib/old/legacy.js\n' },
  },
  // counts wrong
  'T5-run-command': {
    why: 'wrong counts',
    files: { 'counts.json': JSON.stringify({ apple: 2, banana: 2, cherry: 1 }, null, 2) },
  },
  // uses semicolons and omits the trailing newline
  'T6-generate-data': {
    why: 'wrong delimiter and no trailing newline',
    files: { 'report.csv': 'id;name;score\n1;user1;10\n2;user2;20\n3;user3;30\n4;user4;40\n5;user5;50' },
  },
  // "fixes" the symptom by clamping in size() instead of repairing push()
  'T7-debug-symptom': {
    why: 'patched size() instead of the eviction rule',
    files: { 'src/queue.mjs': `export class Queue {
  constructor(limit) {
    this.limit = limit
    this.items = []
  }
  push(item) {
    this.items.push(item)
    while (this.items.length >= this.limit) this.items.shift()
  }
  size() { return 3 }
  first() { return this.items[0] }
}
` },
  },
}

// ── gate runner (only when executed directly) ─────────────────────────────
// Importing this file must NOT run the gate; run-coverage.mjs imports the checker and
// would otherwise re-run the whole gate and exit(1) on its own verdict.
async function runGate() {
  // ── run the gate ───────────────────────────────────────────────────────────
  const TMP = 'D:\\vibecoding\\工作区1\\_gate-coverage'

  console.log('=== TWO-WAY GATE: task coverage suite ===')
  console.log('')
  let bad = 0

  for (const c of COVERAGE_CASES) {
    const ref = REFERENCE[c.id]
    const wrong = WRONG[c.id]
    if (!ref) { console.log('  ' + c.id.padEnd(24) + ' NO REFERENCE'); bad++; continue }
    if (!wrong) { console.log('  ' + c.id.padEnd(24) + ' NO WRONG TWIN'); bad++; continue }

    const d1 = join(TMP, c.id, 'ref')
    writeSetup(d1, c.setup)
    for (const [rel, body] of Object.entries(ref)) {
      const p = join(d1, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body, 'utf8')
    }
    const r = await checkCase(d1, c)

    const d2 = join(TMP, c.id, 'wrong')
    writeSetup(d2, c.setup)
    for (const [rel, body] of Object.entries(wrong.files)) {
      const p = join(d2, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body, 'utf8')
    }
    const w = await checkCase(d2, c)

    const refOk = r.total > 0 && r.pass === r.total
    const wrongFails = w.pass < w.total

    let verdict = 'OK'
    if (!refOk) { verdict = 'REFERENCE FAILS'; bad++ }
    else if (!wrongFails) { verdict = 'WRONG PASSES — cannot discriminate'; bad++ }

    console.log('  ' + c.id.padEnd(24) +
      ' ref ' + r.pass + '/' + r.total +
      '   wrong ' + w.pass + '/' + w.total +
      '   ' + verdict)
    if (!refOk) for (const f of r.failures.slice(0, 3)) console.log('        ref: ' + f)
    if (refOk && !wrongFails) console.log('        wrong impl (' + wrong.why + ') NOT caught')
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log('')
  if (bad) { console.log('GATE: FAIL — ' + bad + ' case(s) unusable.'); process.exit(1) }
  console.log('GATE: PASS — all ' + COVERAGE_CASES.length + ' cases have a working reference and reject a wrong answer.')

}

if (process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === process.argv[1]) {
  await runGate()
}
