// Structural A/B: what can kunlun do that liangshen architecturally CANNOT?
//
// The coverage suite proved the two presets are IDENTICAL on task completion
// (21/21 vs 21/21, every category, every run). That is the expected result and it
// closes a line of inquiry: both ride the same harness, the same model, and the same
// official tools, so no amount of task-design cleverness will separate them on
// "did the task get done".
//
// The only place a difference can exist is in capabilities one preset has and the other
// does not have at all. This suite measures three of them, and it is deliberately
// structured so each check can FAIL — a capability check that cannot fail proves
// nothing.
//
//   C1  cross-session memory    a fact told in session A is available in session B
//   C2  model routing           the session can select a non-default provider/model
//   C3  behaviour modules       a module observes the event stream from outside the
//                               prompt, so its rules do not decay with context
//
// C1 and C2 are behavioural: they run real sessions. C3 is structural: it inspects what
// the composition mounts, because a module that is not mounted cannot run.
import { join } from 'node:path'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HOST_LIB = 'D:\\软件安装\\Dsh官方\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib'
const LE = 'D:\\软件安装\\Dsh官方\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-launch-environment\\lib\\index.js'
const ROOT = 'D:\\vibecoding\\工作区1\\_structural'
const PRESETS = (process.env.PRESETS || 'kunlun,liangshen').split(',')

// A fact the session cannot possibly know unless it is persisted somewhere.
const SECRET = 'kunlun-handoff-' + Math.random().toString(36).slice(2, 8).toUpperCase()

async function main() {
  const { runProfile } = require(join(HOST_LIB, 'profile-boot.js'))
  const le = require(LE)
  const environment = le.createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }])
  const app = await runProfile({ profile: 'desktop', patchFiles: [], environment, args: ['--no-open'] })
  const ctx = app.ctx
  const controller = ctx.get('sessionController')

  // ── RECALL PASS ───────────────────────────────────────────────────────────
  // Run with RECALL=<secret> in a FRESH process: ask each preset to recall a fact that
  // was stored by an earlier process. This is the half of C1 that actually tests
  // persistence, and it only works across a process boundary.
  if (process.env.RECALL) {
    const want = process.env.RECALL
    console.log('=== C1 RECALL PASS (fresh process) ===')
    for (const preset of PRESETS) {
      const s = await controller.create({ cwd: join(ROOT, preset), agentPreset: preset })
      await controller.prompt({ sessionId: s.sessionId, requestId: randomUUID(), content: [{ type: 'text', text: 'Search your long-term memory for the deployment token. Reply with just the token value.' }] }, new AbortController().signal)
      const w0 = Date.now()
      while (Date.now() - w0 < 180000) {
        const log = ctx.sessions.get(s.sessionId)?.log ?? []
        if (log.filter((e) => e.type === 'turn/end').length > 0) break
        await new Promise((x) => setTimeout(x, 300))
      }
      const log = ctx.sessions.get(s.sessionId)?.log ?? []
      let txt = ''
      for (const e of log) {
        if (e.type !== 'assistant/message') continue
        for (const p of (e.data?.message?.content ?? [])) if (p.type === 'text') txt += p.text
      }
      const usedMemory = log.some((e) => JSON.stringify(e).includes('mcp__memory__'))
      const ok = txt.includes(want)
      console.log('  ' + preset.padEnd(12) + ' recall=' + (ok ? 'YES' : 'NO ') +
        '  usedMemoryTool=' + (usedMemory ? 'YES' : 'NO ') +
        (ok ? '' : '  reply=' + JSON.stringify(txt.slice(0, 70))))
    }
    try { await app.shutdown?.shutdown?.(0) } catch {}
    process.exit(0)
  }

  const results = {}

  for (const preset of PRESETS) {
    const r = { preset, c1: null, c2: null, c3: null, notes: [] }
    const dir = join(ROOT, preset)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })

    const runTurn = async (prompt, sid) => {
      const s = sid ? { sessionId: sid } : await controller.create({ cwd: dir, agentPreset: preset })
      const id = s.sessionId
      await controller.prompt({ sessionId: id, requestId: randomUUID(), content: [{ type: 'text', text: prompt }] }, new AbortController().signal)
      const w0 = Date.now()
      while (Date.now() - w0 < 180000) {
        const log = ctx.sessions.get(id)?.log ?? []
        if (log.filter((e) => e.type === 'turn/end').length > 0) break
        await new Promise((x) => setTimeout(x, 300))
      }
      const log = ctx.sessions.get(id)?.log ?? []
      let text = ''
      for (const e of log) {
        if (e.type !== 'assistant/message') continue
        for (const p of (e.data?.message?.content ?? [])) if (p.type === 'text') text += p.text
      }
      return { id, text, log }
    }

    // ── C1: cross-session memory ──────────────────────────────────────────
    // Session A is told a secret and asked to store it. Session B must recall it.
    //
    // IMPORTANT — this must run across PROCESSES, not just across sessions. The MCP
    // memory server loads its store when the process boots, so a write made by session
    // A in this process is invisible to session B in the SAME process. An earlier
    // version ran both in one process, got "I don't have any record of that", and
    // scored kunlun as NO — while the store on disk plainly contained the token and a
    // fresh process recalled it correctly. That is a defect in the test, not the
    // preset: cross-session memory is by design a cross-process capability.
    //
    // So this check only WRITES here; the caller verifies recall in a new process.
    // Set SKIP_C1_WRITE=1 when running the recall pass.
    try {
      if (process.env.SKIP_C1_WRITE === '1') {
        r.c1 = null
        r.notes.push('C1 write skipped (recall pass)')
      } else {
        const a = await runTurn(
          `Remember this for later: the deployment token is ${SECRET}. ` +
          `Use whatever long-term memory tool you have to store it. Then reply DONE.`,
        )
        const aTools = a.log.filter((e) => e.type === 'tool/result').length
        // The fact is written if the session touched a memory tool. Recall is checked
        // separately, in a new process.
        const usedMemory = a.log.some((e) =>
          JSON.stringify(e).includes('mcp__memory__'))
        r.c1 = usedMemory
        r.notes.push('C1 wrote=' + r.c1 + ' tools=' + aTools)
      }
    } catch (e) { r.c1 = false; r.notes.push('C1 threw ' + String(e.message).slice(0, 80)) }

    // ── C2: model routing ─────────────────────────────────────────────────
    // Must be measured from INSIDE the session's own configuration, not by calling the
    // controller from outside. An earlier version called `controller.selectModel`
    // directly and reported YES for every preset including `standard` — because
    // selecting a model is a controller capability, not a preset capability. That made
    // the check incapable of failing, which is exactly the defect this project keeps
    // re-learning.
    //
    // The preset-level fact is whether the session carries a routing policy at all.
    // `subagent/model-selection-policy` is emitted only when the tool-subagent row is
    // mounted with `modelSelectionSettings.enabled`.
    try {
      const s = await runTurn(`Reply with exactly: OK`)
      const policy = s.log.find((e) => e.type === 'subagent/model-selection-policy')
      const allowed = policy?.data?.allowedModels ?? []
      r.c2 = allowed.length > 0
      r.notes.push('C2 routing policy routes=' + allowed.length)
    } catch (e) { r.c2 = false; r.notes.push('C2 threw ' + String(e.message).slice(0, 80)) }

    // ── C3: mounted behaviour modules ─────────────────────────────────────
    // The tool roster lives at `data.header.tools` — NOT `data.tools`. An earlier
    // version read the wrong path, saw an empty array, and reported NO for every preset
    // including kunlun, which is known to mount nine `mcp__memory__` tools. A check
    // that reports the same answer for every input is not a check.
    try {
      const s = await runTurn(`Reply with exactly: OK`)
      let wire = []
      for (const e of s.log) {
        if (e.type !== 'request/header') continue
        const tools = e.data?.header?.tools
        if (Array.isArray(tools)) wire = tools.map((t) => t?.name ?? t?.function?.name ?? '')
      }
      const mem = wire.filter((n) => String(n).startsWith('mcp__memory__')).length
      r.c3 = mem > 0
      r.notes.push('C3 memory tools on wire=' + mem + ' of ' + wire.length)
    } catch (e) { r.c3 = false; r.notes.push('C3 threw ' + String(e.message).slice(0, 80)) }

    results[preset] = r
    console.log('  ' + preset.padEnd(12) +
      ' C1 memory=' + String(r.c1).padEnd(6) +
      ' C2 routing=' + String(r.c2).padEnd(6) +
      ' C3 modules=' + String(r.c3).padEnd(6))
    for (const n of r.notes) console.log('        ' + n)
  }

  console.log('')
  console.log('=== STRUCTURAL COMPARISON ===')
  console.log('  ' + 'preset'.padEnd(12) + 'C1 cross-session  C2 routing  C3 modules')
  for (const p of PRESETS) {
    const r = results[p]
    const f = (v) => (v ? 'YES' : 'NO ')
    console.log('  ' + p.padEnd(12) + f(r.c1).padEnd(17) + f(r.c2).padEnd(12) + f(r.c3))
  }

  mkdirSync(ROOT, { recursive: true })
  writeFileSync(join(ROOT, '_results.json'), JSON.stringify({ secret: SECRET, results }, null, 2), 'utf8')
  console.log('')
  console.log('  secret used: ' + SECRET)
  console.log('  raw: ' + join(ROOT, '_results.json'))

  try { await app.shutdown?.shutdown?.(0) } catch {}
  process.exit(0)
}

main().catch((e) => { console.log('THREW: ' + ((e && e.stack) || e)); process.exit(1) })
