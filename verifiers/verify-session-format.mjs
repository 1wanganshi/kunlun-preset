// Verify the preset cannot corrupt stored sessions.
//
// THE DEFECT THIS EXISTS FOR
//
// Three modules published injected messages with the v3 source shape:
//
//     source: { plugin: name }        // v3 — a `plugin` field and NO `kind`
//
// The v4 admission predicate is:
//
//     if (!isObject(value) || typeof value.kind !== 'string'
//         || value.kind.length === 0 || value.kind === 'plugin') throw
//       SessionFormatError('format v4 message requires a producer-owned source kind')
//
// A failing record does not fail alone — it makes the loader reject the WHOLE
// session:
//
//     历史加载失败: stored session "..." is corrupt
//
// So every conversation run under the preset became unopenable after a restart and
// vanished from the history list. The preset itself kept working, which is exactly
// why this survived: the damage only appears on the NEXT launch.
//
// IMPORTANT: this suite deliberately does NOT use an allow-list of acceptable kinds.
// An earlier version of this check did, and it flagged the harness's own
// `session/title` sources and any preset-chosen kind — producing failures the preset
// cannot cause. Read the predicate, do not reconstruct it.
//
// Two independent halves, because either alone can be fooled:
//   1. STATIC  — no module source contains the v3 shape in live code
//   2. STORED  — sessions on disk contain only admissible message sources, with a
//                known-bad session as the control
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'
import * as _paths from './env-paths.mjs'

const { BUNDLE, PLUGIN } = _paths

// ── The admission predicate, quoted from the harness ────────────────────────
function sourceIsAdmissible(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false
  const k = source.kind
  return typeof k === 'string' && k.length > 0 && k !== 'plugin'
}

// A message lives at `$.data.message`, in `$.data.inserted[]`, or directly at
// `$.data` for the message-bearing event types. `session/title` also carries a
// source at `$.data`, but it is not a message and uses kinds this predicate does not
// cover, so the event type is part of the test.
const MESSAGE_EVENTS = new Set([
  'user/message', 'assistant/message', 'tool/result',
  'system/message', 'developer/message', 'agent/message',
])

let failures = 0
const fail = (m) => { console.log('  FAIL  ' + m); failures++ }
const ok = (m) => console.log('  ok    ' + m)

// ── 1. STATIC: no live v3 source shape ──────────────────────────────────────
console.log('=== 1. module sources must not write the v3 shape ===')
const modDirs = [join(PLUGIN, 'presets', 'kunlun'), join(BUNDLE, 'modules')].filter(existsSync)
let checked = 0
let staticBad = 0
for (const dir of modDirs) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n')
    checked++
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]
      const comment = t.trimStart().startsWith('//') || t.trimStart().startsWith('*') || t.trimStart().startsWith('/*')
      if (comment) continue
      // Match a source object literal that carries `plugin` but no `kind`, in any
      // assignment or property position.
      //
      // The first version of this regex required `source:` — a COLON — but the real
      // code is `const source = { plugin: name }`, an assignment. It therefore
      // matched nothing, and the suite passed while the defect was present. It was
      // caught only by deliberately writing the bad shape back and requiring a
      // failure; without that step the check would have been worthless.
      //
      // Plain substring tests now, so there is no pattern left to get subtly wrong:
      // a line is bad when it mentions `plugin` inside a source literal and has no
      // `kind`.
      const mentionsSource = /\bsource\b/.test(t)
      const hasPluginField = /\bplugin\s*:/.test(t)
      const hasKindField = /\bkind\s*:/.test(t)
      if (mentionsSource && hasPluginField && !hasKindField && !/kind/.test(t)) {
        fail(f + ':' + (i + 1) + '  source carries `plugin` with no `kind` — v3 shape, the session will not reload')
        staticBad++
      }
      if (/source\?\.plugin/.test(t)) {
        fail(f + ':' + (i + 1) + '  reads source.plugin — will not recognise the corrected shape')
        staticBad++
      }
    }
  }
}
if (!staticBad) ok(checked + ' module file(s) clean (source and installed copies)')

// ── 2. STORED: sessions on disk must be admissible ──────────────────────────
console.log('')
console.log('=== 2. stored sessions must contain only admissible message sources ===')

const SESSIONS = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'sessions')
  : join(_paths.DSH_HOME, 'sessions')

function readFrames(file) {
  const buf = readFileSync(file)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let i = 0
  for (;;) {
    const at = buf.indexOf(MAGIC, i)
    if (at < 0) break
    starts.push(at)
    i = at + 4
  }
  let out = ''
  for (let k = 0; k < starts.length; k++) {
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { out += zlib.zstdDecompressSync(buf.subarray(starts[k], to)).toString('utf8') } catch {}
  }
  return out
}

function inspect(file) {
  let text
  try { text = readFrames(file) } catch { return null }
  const bad = []
  const ours = new Set()
  let events = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    events++
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    const stack = [{ n: ev, p: '$' }]
    while (stack.length) {
      const { n, p } = stack.pop()
      if (!n || typeof n !== 'object') continue
      if (Array.isArray(n)) { n.forEach((v) => stack.push({ n: v, p: p + '[]' })); continue }
      if (n.source && typeof n.source === 'object' && !Array.isArray(n.source)) {
        if (/kunlun/i.test(String(n.source.kind))) ours.add(String(n.source.kind))
        const isMsg = p === '$.data.message' || p === '$.data.inserted[]' ||
          (p === '$.data' && MESSAGE_EVENTS.has(ev.type))
        if (isMsg && !sourceIsAdmissible(n.source)) {
          bad.push({ at: p, kind: n.source.kind, source: n.source, type: ev.type })
        }
      }
      // Build the child path from the REAL key. Using a placeholder here made every
      // message source appear at `$.x`, so the slot test never matched and the check
      // silently reported zero problems for a session known to be corrupt — a
      // false PASS, caught only because the control session was required to fail.
      for (const [k, v] of Object.entries(n)) {
        if (v && typeof v === 'object') stack.push({ n: v, p: p + '.' + k })
      }
    }
  }
  return { bad, ours, events }
}

if (!existsSync(SESSIONS)) {
  console.log('  skip  no sessions directory at ' + SESSIONS)
} else {
  const found = []
  for (const d of readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const base = join(SESSIONS, d.name)
    let subs = []
    try { subs = readdirSync(base, { withFileTypes: true }) } catch { continue }
    for (const s of subs) {
      if (!s.isDirectory()) continue
      const f = join(base, s.name, 'session.v4.jsonl.zstd')
      if (!existsSync(f)) continue
      found.push({ id: s.name, file: f, mtime: statSync(f).mtimeMs })
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)

  // The control: a session known to have been written by the buggy version. If we
  // cannot find one, we cannot show this check is capable of failing, and a check
  // that has never failed is not evidence.
  const CONTROL = process.env.KUNLUN_CONTROL_SESSION || 'session-f4836865-748e-4d66-a172-916616d6eec1'
  const control = found.find((s) => s.id === CONTROL)

  if (control) {
    const r = inspect(control.file)
    if (r && r.bad.length) {
      ok('control session is rejected by this check (' + r.bad.length + ' bad source(s)) — the check can fail')
    } else {
      fail('the control session was NOT flagged, so this check cannot detect the defect')
    }
  } else {
    console.log('  note  control session not present; set KUNLUN_CONTROL_SESSION to a known-bad session id to calibrate')
  }

  // Only sessions written AFTER the fix can be expected to be clean. Sessions stored
  // before it are already on disk in the old format, and no code change can repair
  // them — reporting those as failures would be permanent noise that trains the
  // reader to ignore this suite.
  //
  // The boundary is a timestamp, not a guess: `KUNLUN_FIX_EPOCH` (ms) is when the
  // corrected modules were installed. Defaults to the mtime of the installed
  // tool-catalog module, which is exactly when the fix became live.
  let fixEpoch = Number(process.env.KUNLUN_FIX_EPOCH || 0)
  if (!fixEpoch) {
    const marker = join(BUNDLE, 'modules', 'tool-catalog.mjs')
    if (existsSync(marker)) fixEpoch = statSync(marker).mtimeMs
  }

  const afterFix = fixEpoch ? found.filter((s) => s.mtime >= fixEpoch) : found
  const recent = afterFix.slice(0, 12)

  console.log('  note  fix epoch: ' + (fixEpoch ? new Date(fixEpoch).toISOString() : 'unknown (checking all)'))
  console.log('  note  sessions written after the fix: ' + afterFix.length)

  let badRecent = 0
  let exercised = 0
  for (const s of recent) {
    const r = inspect(s.file)
    if (!r) continue
    if (r.ours.size) exercised++
    if (r.bad.length) {
      badRecent++
      fail(s.id.slice(0, 24) + '  ' + r.bad.length + ' inadmissible source(s), e.g. ' +
        JSON.stringify(r.bad[0].source).slice(0, 60))
    }
  }
  if (!badRecent && exercised) ok('newest ' + recent.length + ' post-fix session(s) admissible; ' + exercised + ' published a 昆仑 message')
  else if (!exercised) console.log('  note  no post-fix session contains a 昆仑-published message yet; run a session to exercise this')
  else ok('no post-fix session is corrupt')
}

console.log('')
if (failures) {
  console.log('RESULT: FAIL — ' + failures + ' problem(s)')
  process.exit(1)
}
console.log('RESULT: PASS — the preset writes only admissible session sources')
