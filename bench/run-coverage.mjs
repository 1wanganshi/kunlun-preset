// Does kunlun actually finish each category of real work?
//
// No comparison arm. No "strong model". The question is simply: given a task from
// category X, does the preset produce a deliverable that meets the stated requirement?
//
// That is the question the user asked. An earlier round spent its whole budget chasing
// deepseek-v4-pro as a comparison baseline, which was never the goal and which the
// account could not fund anyway.
//
// Each case runs in its own clean directory with its own fixture. Scoring is
// all-or-nothing per case, using the gated checker, so a number here means "the
// deliverable was correct", not "something was written".
import { join } from 'node:path'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { COVERAGE_CASES } from './coverage-cases.mjs'
import { writeSetup, checkCase } from './gate-coverage.mjs'

const require = createRequire(import.meta.url)
const HOST_LIB = 'D:\\软件安装\\Dsh官方\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib'
const LE = 'D:\\软件安装\\Dsh官方\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-launch-environment\\lib\\index.js'
const ROOT = 'D:\\vibecoding\\工作区1\\_coverage-run'

const PRESET = process.env.PRESET || 'kunlun'
const RUNS = Number(process.env.RUNS || 1)
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null

// The single artifact a case is expected to create, used only to know when it is safe
// to grade. T3 has none (it edits existing files in place), so it returns null and the
// runner falls back to a short fixed settle.
function expectedArtifact(c) {
  const k = c.check.kind
  if (k === 'module') return c.check.file
  if (k === 'fileEquals') return c.check.file
  if (k === 'jsonEquals') return c.check.file
  if (k === 'csvEquals') return c.check.file
  return null
}

async function main() {
  const { runProfile } = require(join(HOST_LIB, 'profile-boot.js'))
  const le = require(LE)
  const environment = le.createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }])
  const app = await runProfile({ profile: 'desktop', patchFiles: [], environment, args: ['--no-open'] })
  const ctx = app.ctx
  const controller = ctx.get('sessionController')

  const cases = ONLY ? COVERAGE_CASES.filter((c) => ONLY.includes(c.id)) : COVERAGE_CASES
  const results = []
  let dead = 0

  for (let run = 1; run <= RUNS; run++) {
    for (const c of cases) {
      const dir = join(ROOT, PRESET + '-r' + run, c.id)
      writeSetup(dir, c.setup)

      const sess = await controller.create({ cwd: dir, agentPreset: PRESET })
      const sid = sess.sessionId

      const t0 = Date.now()
      try {
        await controller.prompt(
          { sessionId: sid, requestId: randomUUID(), content: [{ type: 'text', text: c.prompt }] },
          new AbortController().signal,
        )
      } catch (e) { /* detected below */ }

      const w0 = Date.now()
      while (Date.now() - w0 < 300000) {
        const log = ctx.sessions.get(sid)?.log ?? []
        if (log.filter((e) => e.type === 'turn/end').length > 0) break
        await new Promise((r) => setTimeout(r, 300))
      }
      const elapsedMs = Date.now() - t0
      const log = ctx.sessions.get(sid)?.log ?? []
      const tools = log.filter((e) => e.type === 'tool/result').length

      // ── settle before grading ────────────────────────────────────────────
      //
      // `turn/end` does not guarantee the last tool's writes have reached the
      // filesystem: a write issued in the final step can still be in flight when the
      // turn closes. Grading immediately produced a false failure — T5 reported
      // "counts.json not written" while the file was demonstrably on disk with the
      // correct contents, timestamped a few seconds AFTER the checker ran.
      //
      // So: wait for the expected artifact to appear, up to a bounded time. This is
      // both faster than a fixed sleep and strictly more correct. It does NOT weaken
      // the check — a file that never appears still fails after the deadline, and the
      // gate's wrong-answer cases prove the checker still rejects bad content.
      const expected = expectedArtifact(c)
      if (expected) {
        const paths = [expected, ...(c.check.acceptAlso ?? [])].map((f) => join(dir, f))
        const deadline = Date.now() + 45000
        while (Date.now() < deadline && !paths.some((p) => existsSync(p))) {
          await new Promise((r) => setTimeout(r, 400))
        }
      }
      // Always give the filesystem a moment even when no single artifact is expected
      // (T3 edits files in place and has no new path to wait for).
      await new Promise((r) => setTimeout(r, 1200))

      // Provider errors are not task results.
      let apiError = null
      for (const e of log) {
        if (e.type !== 'assistant/attempt') continue
        for (const s of (e.data?.stream ?? [])) {
          if (s.type === 'chunk' && s.chunk?.type === 'finish' && s.chunk.reason?.kind === 'error') {
            apiError = String(s.chunk.reason.failure?.message ?? 'unknown').slice(0, 140)
          }
        }
      }

      const g = await checkCase(dir, c)
      const perfect = g.total > 0 && g.pass === g.total

      results.push({
        run, case: c.id, category: c.category,
        pass: g.pass, total: g.total, perfect, elapsedMs, tools, apiError,
        failures: g.failures.slice(0, 2),
      })

      const tag = apiError ? 'API-ERROR' : (perfect ? 'PASS' : 'FAIL')
      console.log('  r' + run + ' ' + c.id.padEnd(24) + tag.padEnd(10) +
        (perfect ? '' : (g.pass + '/' + g.total + ' ').padEnd(8)) +
        Math.round(elapsedMs / 1000) + 's tools=' + tools)
      if (apiError) console.log('        provider: ' + apiError)
      else if (!perfect && g.failures.length) console.log('        ' + g.failures[0])

      if (apiError) {
        console.log('')
        console.log('ABORT: provider error — cannot measure the preset against a dead route.')
        mkdirSync(ROOT, { recursive: true })
        writeFileSync(join(ROOT, '_results.json'), JSON.stringify({ aborted: true, reason: apiError, results }, null, 2), 'utf8')
        try { await app.shutdown?.shutdown?.(0) } catch {}
        process.exit(3)
      }

      if (tools === 0) {
        dead++
        if (dead >= 3) {
          console.log('')
          console.log('ABORT: three consecutive sessions made no tool call. Environment failure,')
          console.log('not a preset result. Refusing to grade empty directories.')
          mkdirSync(ROOT, { recursive: true })
          writeFileSync(join(ROOT, '_results.json'), JSON.stringify({ aborted: true, reason: 'no-tool sessions', results }, null, 2), 'utf8')
          try { await app.shutdown?.shutdown?.(0) } catch {}
          process.exit(2)
        }
      } else dead = 0

      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  console.log('')
  console.log('=== KUNLUN TASK COVERAGE (' + PRESET + ') ===')
  for (const c of cases) {
    const rs = results.filter((r) => r.case === c.id)
    const p = rs.filter((r) => r.perfect).length
    const avgS = Math.round(rs.reduce((a, r) => a + r.elapsedMs, 0) / Math.max(1, rs.length) / 1000)
    const bar = p === rs.length ? '✅' : '❌'
    console.log('  ' + bar + ' ' + c.id.padEnd(24) + c.category.padEnd(30) + p + '/' + rs.length + '   ' + avgS + 's')
  }
  const totalPass = results.filter((r) => r.perfect).length
  console.log('')
  console.log('  TOTAL: ' + totalPass + '/' + results.length + ' cases completed correctly')

  mkdirSync(ROOT, { recursive: true })
  writeFileSync(join(ROOT, '_results.json'), JSON.stringify(results, null, 2), 'utf8')
  console.log('  raw: ' + join(ROOT, '_results.json'))

  try { await app.shutdown?.shutdown?.(0) } catch {}
  process.exit(0)
}

main().catch((e) => { console.log('THREW: ' + ((e && e.stack) || e)); process.exit(1) })
