// Find d1api's REAL context window by bisection.
//
// The provider's /v1/models omits context_length, so the harness falls back to 262144.
// We probe the endpoint directly: send a growing input and read the server's own answer.
// The server is the only authority here — never infer this from documentation.
//
// Run:  node measure-context.mjs           (probe deepseek-v4.1-flash)
//       node measure-context.mjs glm-5.3   (probe a named model)
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'

const REPORT = 'C:/Users/Lenovo/.dsh/profiles/desktop/measure-report.txt'
writeFileSync(REPORT, '', 'utf8')
const say = (s) => { try { console.log(s) } catch {}; try { appendFileSync(REPORT, String(s) + '\n', 'utf8') } catch {} }

const model = process.argv[2] ?? 'deepseek-v4.1-flash'

// The key lives in the credential store; read it there rather than duplicating it.
const cred = readFileSync('C:/Users/Lenovo/.dsh/.credentials.yaml', 'utf8')
const key = cred.match(/D1API_API_KEY:\s*(\S+)/)?.[1]
if (!key) { say('no D1API_API_KEY'); process.exit(1) }

// A filler token repeated N times gives a predictable input size. We measure the
// server's ACTUAL accounting from its usage field, not from our own estimate.
const FILLER = 'token '

async function probe(tokens) {
  const body = {
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content: FILLER.repeat(tokens) + '\n\nReply with the single word: ok' }],
  }
  const t0 = Date.now()
  let res
  try {
    res = await fetch('https://d1api.xin/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    })
  } catch (e) {
    return { tokens, ms: Date.now() - t0, status: 'network', note: String(e.message).slice(0, 120) }
  }
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  const promptTokens = json?.usage?.prompt_tokens
  const errMsg = json?.error?.message ?? (res.ok ? null : text.slice(0, 160))
  return { tokens, ms: Date.now() - t0, status: res.status, promptTokens, note: errMsg }
}

say('=== measuring real context window for "' + model + '" ===')
say('')

// Calibrate: how many filler repeats make how many real tokens?
const cal = await probe(100)
say('calibration: ' + JSON.stringify(cal))
const ratio = cal.promptTokens ? cal.promptTokens / 100 : 1.3
say('  ~' + ratio.toFixed(2) + ' real tokens per filler repeat')
say('')

// Bisect on the filler count, watching for the server's own rejection.
let lo = 256000         // already proven acceptable
let hi = 4000000        // push far enough to find a real ceiling
let firstFail = null

// Establish a failing upper bound first, doubling upward.
let t = lo
while (t <= hi) {
  const r = await probe(t)
  const ok = r.status === 200 && r.promptTokens !== undefined
  say((ok ? '  OK   ' : '  FAIL ') + String(t).padStart(7) + ' filler  -> HTTP ' + r.status +
      (r.promptTokens ? '  prompt_tokens=' + r.promptTokens : '') +
      (r.note ? '  ' + r.note.slice(0, 110) : '') +
      '  (' + (r.ms / 1000).toFixed(1) + 's)')
  if (!ok) { firstFail = t; hi = t; break }
  lo = t
  t = t * 2
}

if (firstFail === null) {
  say('')
  say('no failure up to ' + hi + ' filler tokens — the endpoint accepts at least that much')
  process.exit(0)
}

// Narrow the boundary between lo (ok) and hi (fail).
say('')
say('boundary between ' + lo + ' and ' + hi + ' — bisecting')
while (hi - lo > Math.max(2000, lo * 0.05)) {
  const mid = Math.floor((lo + hi) / 2)
  const r = await probe(mid)
  const ok = r.status === 200 && r.promptTokens !== undefined
  say((ok ? '  OK   ' : '  FAIL ') + String(mid).padStart(7) + ' filler  -> HTTP ' + r.status +
      (r.promptTokens ? '  prompt_tokens=' + r.promptTokens : '') +
      (r.note ? '  ' + r.note.slice(0, 110) : ''))
  if (ok) lo = mid; else hi = mid
}

say('')
say('=== RESULT ===')
say('  largest accepted input : ' + lo + ' filler tokens')
say('  smallest rejected input: ' + hi + ' filler tokens')
say('  => real context window is approximately ' + lo + ' filler tokens (~' + Math.round(lo * ratio) + ' real tokens)')
process.exit(0)
