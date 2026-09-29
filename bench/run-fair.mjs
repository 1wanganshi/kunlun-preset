// The decisive experiment: does a strong model actually win on the fair task set?
//
// Arms:
//   kunlun+flash     the preset on the default model
//   kunlun+v4pro     the preset with the session pinned to deepseek-v4-pro
//   liangshen+flash  CONTROL: the preset we must beat, on the same model as arm 1
//
// Model selection uses controller.selectModel, which was verified separately: a session
// pinned that way self-reported "deepseek-v4-pro" when asked.
//
// Scoring is all-or-nothing per task (a task counts only if EVERY case passes and the
// perf requirement is met), because partial credit would hide the difference between
// "wrote something plausible" and "got it right".
import { join } from 'node:path'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { FAIR_TASKS } from './fair-tasks.mjs'

const require = createRequire(import.meta.url)
const HOST_LIB = 'D:\\软件安装\\Dsh官方\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib'
const LE = 'D:\\软件安装\\Dsh官方\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-launch-environment\\lib\\index.js'
const ROOT = 'D:\\vibecoding\\工作区1\\_fair-run'

const ARMS = [
  { name: 'kunlun+flash', preset: 'kunlun', model: null },
  // `deepseek-official/deepseek-v4-pro` was the intended strong route, but both
  // deepseek-official and deepseek-account are currently returning HTTP 402
  // "Insufficient Balance" (verified per-model on this host). The d1api routes are
  // funded and reachable, so the strong arm uses the largest model that actually
  // responds there. The arm name records which route was really used.
  { name: 'kunlun+glm-5.3', preset: 'kunlun', model: { provider: 'd1api', model: 'glm-5.3' } },
  { name: 'liangshen+flash', preset: 'liangshen', model: null },
]

const RUNS = Number(process.env.RUNS || 2)
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null

// ── grader (same semantics as the gated one) ────────────────────────────────
function same(got, want) {
  if (want === 'undefined') return got === undefined
  return JSON.stringify(got) === want
}

async function runCase(mod, task, steps) {
  if (/^mk\(/.test(steps[0])) {
    const cap = Number(/^mk\((\d+)\)$/.exec(steps[0])[1])
    const inst = mod[task.exportName](cap)
    let last
    for (let i = 1; i < steps.length; i++) {
      const s = steps[i]
      if (s.startsWith('p(')) { const [k, v] = JSON.parse('[' + s.slice(2, -1) + ']'); last = inst.put(k, v) }
      else if (s.startsWith('g(')) { last = inst.get(JSON.parse('[' + s.slice(2, -1) + ']')[0]) }
      else if (s === 'sz()') { last = inst.size() }
    }
    return last
  }
  const args = steps.map((s) => new Function('return (' + s + ')')())
  return mod[task.exportName](...args)
}

async function grade(dir, task) {
  const f = join(dir, task.file)
  if (!existsSync(f)) return { pass: 0, total: 1, note: 'file not written', failures: ['missing'] }
  let mod
  try { mod = await import(pathToFileURL(f).href + '?t=' + Date.now()) }
  catch (e) { return { pass: 0, total: 1, note: 'import failed', failures: [String(e.message).slice(0, 120)] } }

  let passed = 0
  let total = 0
  const failures = []
  for (const t of task.tests) {
    total++
    const wantThrow = t.want === 'THROW'
    try {
      const got = await runCase(mod, task, t.call)
      if (wantThrow) failures.push('no throw: ' + t.call[0])
      else if (same(got, t.want)) passed++
      else failures.push(t.call.join(',') + ' -> ' + JSON.stringify(got))
    } catch (e) {
      if (wantThrow) passed++
      else failures.push(t.call.join(',') + ' threw')
    }
  }
  if (task.perf) {
    total++
    try {
      const big = Array.from({ length: task.perf.size }, (_, i) => (i * 7919) % 5000)
      const t0 = Date.now()
      mod[task.exportName](big)
      const ms = Date.now() - t0
      if (ms > task.perf.maxMs) failures.push('perf ' + ms + 'ms')
      else passed++
    } catch (e) { failures.push('perf threw') }
  }
  return { pass: passed, total, failures }
}

async function main() {
  const { runProfile } = require(join(HOST_LIB, 'profile-boot.js'))
  const le = require(LE)
  const environment = le.createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }])
  const app = await runProfile({ profile: 'desktop', patchFiles: [], environment, args: ['--no-open'] })
  const ctx = app.ctx
  const controller = ctx.get('sessionController')

  const tasks = ONLY ? FAIR_TASKS.filter((t) => ONLY.includes(t.id)) : FAIR_TASKS
  const results = []
  let dead = 0

  for (let run = 1; run <= RUNS; run++) {
    for (const arm of ARMS) {
      for (const task of tasks) {
        const dir = join(ROOT, arm.name + '-r' + run, task.id)
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(dir, { recursive: true })

        const c = await controller.create({ cwd: dir, agentPreset: arm.preset })
        const sid = c.sessionId
        if (arm.model) {
          await controller.selectModel({
            sessionId: sid, provider: arm.model.provider,
            model: arm.model.model, reasoningEffort: arm.model.reasoningEffort,
          })
        }

        const instruction = [
          'Write a single JavaScript module in the current directory.',
          '',
          task.prompt,
          '',
          `Write it as ./${task.file}. Do not create any other files. Do not write tests.`,
          'When done, reply with exactly: DONE',
        ].join('\n')

        const t0 = Date.now()
        try {
          await controller.prompt(
            { sessionId: sid, requestId: randomUUID(), content: [{ type: 'text', text: instruction }] },
            new AbortController().signal,
          )
        } catch (e) { /* recorded via missing file */ }

        const w0 = Date.now()
        while (Date.now() - w0 < 300000) {
          const log = ctx.sessions.get(sid)?.log ?? []
          if (log.filter((e) => e.type === 'turn/end').length > 0) break
          await new Promise((r) => setTimeout(r, 300))
        }
        const elapsedMs = Date.now() - t0
        const log = ctx.sessions.get(sid)?.log ?? []
        const tools = log.filter((e) => e.type === 'tool/result').length

        // ── API-FAILURE DETECTION ────────────────────────────────────────────
        //
        // A provider error is NOT a task result. Without this check, an exhausted
        // account (HTTP 402 "Insufficient Balance") produced sessions that ended in one
        // second with no tool call, and the runner graded the empty directory — which
        // reads as "the model could not solve the task". Thirty-three sessions were
        // nearly reported that way. The error is surfaced as its own outcome and
        // aborts the run, because a dead provider invalidates every later number.
        let apiError = null
        for (const e of log) {
          if (e.type !== 'assistant/attempt') continue
          for (const s of (e.data?.stream ?? [])) {
            if (s.type === 'chunk' && s.chunk?.type === 'finish' && s.chunk.reason?.kind === 'error') {
              const f = s.chunk.reason.failure ?? {}
              apiError = { message: String(f.message ?? 'unknown').slice(0, 160), code: String(f.code ?? ''), status: f.status }
            }
          }
        }

        const g = await grade(dir, task)
        const perfect = g.pass === g.total && g.total > 1

        results.push({
          run, arm: arm.name, task: task.id,
          pass: g.pass, total: g.total, perfect,
          elapsedMs, tools, note: g.note ?? null,
          apiError,
          failures: g.failures.slice(0, 2),
        })

        console.log('  r' + run + ' ' + arm.name.padEnd(17) + task.id.padEnd(16) +
          (apiError ? 'API-ERROR' : (g.note ? g.note : g.pass + '/' + g.total)).padEnd(10) +
          (perfect ? 'OK ' : '   ') + Math.round(elapsedMs / 1000) + 's tools=' + tools)
        if (apiError) console.log('        provider refused the call: ' + apiError.message)
        else if (!perfect && g.failures.length) console.log('        ' + g.failures[0])

        // A provider refusal is an environment failure, never a model result. Stop
        // immediately rather than spending the rest of the matrix on a dead route.
        if (apiError) {
          console.log('')
          console.log('ABORT: the provider returned an error, so this arm cannot be measured.')
          console.log('Reporting these as task failures would be a fabricated result.')
          mkdirSync(ROOT, { recursive: true })
          writeFileSync(join(ROOT, '_results.json'), JSON.stringify(
            { aborted: true, reason: 'provider error: ' + apiError.message, results }, null, 2), 'utf8')
          try { await app.shutdown?.shutdown?.(0) } catch {}
          process.exit(3)
        }

        // ── PREREQUISITE GATE ────────────────────────────────────────────────
        //
        // A session that made no tool call and wrote no file did not "fail the task" —
        // it never ran. Grading it anyway records a capability result for a machine
        // that was not working, which is worse than having no data.
        //
        // This actually happened: the harness stalled after session 10, and the runner
        // went on to grade 33 empty directories in about a second each, presenting them
        // as ordinary task failures. The summary would have been pure fiction.
        // Three consecutive dead sessions now abort the whole run.
        if (tools === 0 && !existsSync(join(dir, task.file))) {
          dead++
          console.log('        (no tool call, no file — session did not run; dead=' + dead + ')')
          if (dead >= 3) {
            console.log('')
            console.log('ABORT: three consecutive sessions produced nothing. The harness has')
            console.log('stalled; this is an environment failure, not a task result. Refusing')
            console.log('to continue grading empty directories.')
            mkdirSync(ROOT, { recursive: true })
            writeFileSync(join(ROOT, '_results.json'), JSON.stringify(
              { aborted: true, reason: 'harness stalled after ' + results.length + ' sessions', results },
              null, 2), 'utf8')
            try { await app.shutdown?.shutdown?.(0) } catch {}
            process.exit(2)
          }
        } else {
          dead = 0
        }

        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }

  console.log('')
  console.log('=== SUMMARY (per-task perfect counts) ===')
  const header = ['task'.padEnd(16), ...ARMS.map((a) => a.name.padEnd(17))].join('')
  console.log('  ' + header)
  for (const task of tasks) {
    const row = [task.id.padEnd(16)]
    for (const arm of ARMS) {
      const rs = results.filter((r) => r.arm === arm.name && r.task === task.id)
      const p = rs.filter((r) => r.perfect).length
      row.push((p + '/' + rs.length).padEnd(17))
    }
    console.log('  ' + row.join(''))
  }
  console.log('')
  for (const arm of ARMS) {
    const rs = results.filter((r) => r.arm === arm.name)
    const perfect = rs.filter((r) => r.perfect).length
    const avgS = Math.round(rs.reduce((a, r) => a + r.elapsedMs, 0) / Math.max(1, rs.length) / 1000)
    const avgT = (rs.reduce((a, r) => a + r.tools, 0) / Math.max(1, rs.length)).toFixed(1)
    console.log('  ' + arm.name.padEnd(17) + 'perfect ' + perfect + '/' + rs.length +
      '   avg ' + avgS + 's   ' + avgT + ' tools')
  }

  mkdirSync(ROOT, { recursive: true })
  writeFileSync(join(ROOT, '_results.json'), JSON.stringify(results, null, 2), 'utf8')
  console.log('')
  console.log('raw: ' + join(ROOT, '_results.json'))

  try { await app.shutdown?.shutdown?.(0) } catch {}
  process.exit(0)
}

main().catch((e) => { console.log('THREW: ' + ((e && e.stack) || e)); process.exit(1) })
