// TWO-WAY GATE for the fair task set.
//
// Proves, before any model runs:
//   REFERENCE  a correct implementation scores 100%
//   WEAK       genuinely weaker implementations score clearly less
//
// The WEAK implementations here are not "deliberately silly". Each is the natural
// output of a model that understood the SPEC but not the DEPTH — which is exactly the
// failure this task set is meant to detect. If a weak-but-reasonable implementation
// passes, the task cannot discriminate and must be redesigned.
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FAIR_TASKS } from './fair-tasks.mjs'

const TMP = 'D:\\vibecoding\\工作区1\\_gate-fair'

const REFERENCE = {
  'F1-calculator': `
let pos = 0
let src = ''
function peek() { return src[pos] }
function skip() { while (pos < src.length && /\\s/.test(src[pos])) pos++ }
function parseExpr() {
  let left = parseTerm()
  for (;;) {
    skip()
    const c = peek()
    if (c === '+' || c === '-') { pos++; const r = parseTerm(); left = c === '+' ? left + r : left - r }
    else return left
  }
}
function parseTerm() {
  let left = parseUnary()
  for (;;) {
    skip()
    const c = peek()
    if (c === '*' || c === '/') {
      pos++
      const r = parseUnary()
      if (c === '*') left = left * r
      else { if (r === 0) throw new Error('division by zero'); left = left / r }
    } else return left
  }
}
function parseUnary() {
  skip()
  // ONLY unary minus. The spec's error rule says "two operators in a row where the
  // second is not a unary minus" is malformed, so accepting a unary "+" here would
  // make "1++2" evaluate to 3 — contradicting rule 8. The earlier draft of this
  // reference did accept "+" and failed its own spec; caught by the gate.
  if (peek() === '-') { pos++; return -parseUnary() }
  return parseAtom()
}
function parseAtom() {
  skip()
  if (peek() === '(') {
    pos++
    const v = parseExpr()
    skip()
    if (peek() !== ')') throw new Error('unbalanced parentheses')
    pos++
    return v
  }
  const start = pos
  let seenDot = false
  while (pos < src.length) {
    const c = src[pos]
    if (/[0-9]/.test(c)) { pos++; continue }
    if (c === '.' && !seenDot) { seenDot = true; pos++; continue }
    break
  }
  const text = src.slice(start, pos)
  if (text === '' || text === '.') throw new Error('malformed number at ' + start)
  if (!/[0-9]/.test(text)) throw new Error('malformed number: ' + text)
  return Number(text)
}
export function evaluate(expr) {
  src = String(expr); pos = 0
  skip()
  if (pos >= src.length) throw new Error('empty expression')
  const v = parseExpr()
  skip()
  if (pos !== src.length) throw new Error('unexpected character at ' + pos)
  return v
}`,

  'F2-lru': `
export function createLRU(capacity) {
  if (!(capacity >= 1)) throw new Error('capacity must be >= 1')
  const map = new Map()
  return {
    get(key) {
      if (!map.has(key)) return undefined
      const v = map.get(key)
      map.delete(key)
      map.set(key, v)
      return v
    },
    put(key, value) {
      if (map.has(key)) { map.delete(key); map.set(key, value); return }
      if (map.size >= capacity) {
        const oldest = map.keys().next().value
        map.delete(oldest)
      }
      map.set(key, value)
    },
    size() { return map.size },
  }
}`,

  'F3-lis': `
export function longestIncreasingSubsequence(nums) {
  const n = nums.length
  if (n === 0) return []
  const tails = []
  const tailsIdx = []
  const prev = new Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    const x = nums[i]
    let lo = 0, hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < x) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tailsIdx[lo - 1]
    tails[lo] = x
    tailsIdx[lo] = i
  }
  const out = []
  let k = tailsIdx[tails.length - 1]
  while (k !== -1) { out.push(nums[k]); k = prev[k] }
  out.reverse()
  return out
}`,

  'F4-diff': `
export function diffLines(a, b) {
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  const push = (op, line) => {
    const last = ops[ops.length - 1]
    if (last && last.op === op) last.lines.push(line)
    else ops.push({ op, lines: [line] })
  }
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('equal', a[i]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('delete', a[i]); i++ }
    else { push('insert', b[j]); j++ }
  }
  while (i < n) { push('delete', a[i]); i++ }
  while (j < m) { push('insert', b[j]); j++ }
  return ops
}`,
}

// Weaker-but-reasonable implementations: each is what a model produces when it
// understands the stated rules but misses the depth behind them.
const WEAK = {
  // Precedence right, but no unary minus — the most common omission.
  'F1-calculator': {
    why: 'no unary minus support (the classic grader-style parser)',
    src: `
let pos = 0, src = ''
const ws = () => { while (pos < src.length && /\\s/.test(src[pos])) pos++ }
function expr() { let l = term(); for (;;) { ws(); const c = src[pos]; if (c === '+' || c === '-') { pos++; const r = term(); l = c === '+' ? l + r : l - r } else return l } }
function term() { let l = atom(); for (;;) { ws(); const c = src[pos]; if (c === '*' || c === '/') { pos++; const r = atom(); if (c === '*') l = l * r; else { if (r === 0) throw new Error('division by zero'); l = l / r } } else return l } }
function atom() {
  ws()
  if (src[pos] === '(') { pos++; const v = expr(); ws(); if (src[pos] !== ')') throw new Error('unbalanced'); pos++; return v }
  const st = pos
  while (pos < src.length && /[0-9.]/.test(src[pos])) pos++
  const t = src.slice(st, pos)
  if (t === '' || t === '.') throw new Error('bad number')
  return Number(t)
}
export function evaluate(e) { src = String(e); pos = 0; ws(); if (pos >= src.length) throw new Error('empty'); const v = expr(); ws(); if (pos !== src.length) throw new Error('trailing'); return v }`,
  },

  // Treats a missing get as a hit for ordering purposes, and refreshes on update only.
  'F2-lru': {
    why: 'missing get still refreshes order',
    src: `export function createLRU(capacity) {
  const map = new Map()
  return {
    get(key) {
      const v = map.get(key)
      // BUG: touches the key even on a miss
      if (v !== undefined) { map.delete(key); map.set(key, v) }
      else { map.delete(key); map.set(key, undefined) }
      return v
    },
    put(key, value) {
      if (map.has(key)) map.delete(key)
      else if (map.size >= capacity) map.delete(map.keys().next().value)
      map.set(key, value)
    },
    size() { return map.size },
  }
}`,
  },

  // O(n^2) DP: correct answers, but blows the performance requirement.
  'F3-lis': {
    why: 'O(n^2) reconstruction — correct but too slow at 20k',
    src: `export function longestIncreasingSubsequence(nums) {
  const n = nums.length
  if (n === 0) return []
  const len = new Array(n).fill(1)
  const prev = new Array(n).fill(-1)
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (nums[j] < nums[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j }
    }
  }
  let best = 0
  for (let i = 1; i < n; i++) if (len[i] > len[best]) best = i
  const out = []
  for (let k = best; k !== -1; k = prev[k]) out.push(nums[k])
  return out.reverse()
}`,
  },

  // Correct script but does NOT coalesce adjacent operations.
  'F4-diff': {
    why: 'no coalescing — emits one op per line',
    src: `export function diffLines(a, b) {
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const ops = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ op: 'equal', lines: [a[i]] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: 'delete', lines: [a[i]] }); i++ }
    else { ops.push({ op: 'insert', lines: [b[j]] }); j++ }
  }
  while (i < n) { ops.push({ op: 'delete', lines: [a[i]] }); i++ }
  while (j < m) { ops.push({ op: 'insert', lines: [b[j]] }); j++ }
  return ops
}`,
  },
}

async function grade(id, source, task) {
  const dir = join(TMP, id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const f = join(dir, task.file)
  writeFileSync(f, source, 'utf8')
  let mod
  try { mod = await import(pathToFileURL(f).href + '?t=' + Date.now()) }
  catch (e) { return { passed: 0, total: task.tests.length + 1, failures: ['import failed: ' + e.message] } }

  let passed = 0
  let total = 0
  const failures = []

  // Multi-step cases: build the object then call methods in sequence.
  for (const t of task.tests) {
    total++
    const wantThrow = t.want === 'THROW'
    try {
      const got = await runCase(mod, task, t.call)
      if (wantThrow) failures.push('expected throw, got ' + JSON.stringify(got))
      else if (same(got, t.want)) passed++
      else failures.push('got ' + JSON.stringify(got) + ' want ' + t.want)
    } catch (e) {
      if (wantThrow) passed++
      else failures.push('threw: ' + e.message)
    }
  }

  // Performance requirement, where declared.
  //
  // The input shape depends on the task: a list of numbers, a list of buildings, a
  // (nodes, edges) pair, or a list of interval objects. An earlier version generated a
  // plain number array for every task, so skyline/toposort/schedule threw on their own
  // input types and the gate reported "REFERENCE FAILS" for a working implementation.
  if (task.perf) {
    total++
    try {
      const n = task.perf.size
      const kind = task.perf.kind
      let args
      if (kind === 'topo') {
        const nodes = []
        for (let i = 0; i < n; i++) nodes.push('n' + i)
        const edges = []
        // A DAG: forward edges only, plus enough density to be interesting.
        for (let i = 0; i < n - 1; i++) edges.push(['n' + i, 'n' + (i + 1)])
        for (let i = 0; i + 7 < n; i++) edges.push(['n' + i, 'n' + (i + 7)])
        args = [nodes, edges]
      } else if (kind === 'schedule') {
        const items = []
        for (let i = 0; i < n; i++) {
          const s = (i * 13) % 100000
          items.push({ start: s, end: s + 1 + (i % 17), weight: 1 + (i % 100) })
        }
        args = [items]
      } else if (task.id === 'F5-skyline') {
        const bs = []
        for (let i = 0; i < n; i++) {
          const l = (i * 7) % 100000
          bs.push([l, l + 1 + (i % 23), 1 + (i % 50)])
        }
        args = [bs]
      } else {
        args = [Array.from({ length: n }, (_, i) => (i * 7919) % 5000)]
      }
      const t0 = Date.now()
      const r = mod[task.exportName](...args)
      const ms = Date.now() - t0
      if (ms > task.perf.maxMs) failures.push('perf: ' + ms + 'ms exceeds ' + task.perf.maxMs + 'ms')
      // A perf case passes if it finishes in time AND returns something; the exact shape
      // is already covered by the logic cases above.
      else if (r === undefined || r === null) failures.push('perf: returned nothing')
      else passed++
    } catch (e) { failures.push('perf threw: ' + e.message) }
  }

  return { passed, total, failures }
}

// Interpret a case's step list against the module.
//
// Two harness bugs lived here and both produced fake failures:
//   * a two-argument call like ["[]","[]"] was routed into the object-style branch
//     because the first step did not look like a plain single expression, then
//     `mod.diffLines` was called with no arguments
//   * comparing JSON.stringify(got) against the string "undefined" never matches,
//     because JSON.stringify(undefined) returns undefined rather than "undefined"
//
// The object style is now detected by its own explicit marker (an "mk(" first step),
// and comparison is done with a helper that handles undefined.
async function runCase(mod, task, steps) {
  // Object-style: mk(cap) then method steps; the last step's value is the answer.
  if (/^mk\(/.test(steps[0])) {
    const cap = Number(/^mk\((\d+)\)$/.exec(steps[0])[1])
    const inst = mod[task.exportName](cap)
    let last
    for (let i = 1; i < steps.length; i++) {
      const s = steps[i]
      if (s.startsWith('p(')) {
        const [k, v] = JSON.parse('[' + s.slice(2, -1) + ']')
        last = inst.put(k, v)
      } else if (s.startsWith('g(')) {
        last = inst.get(JSON.parse('[' + s.slice(2, -1) + ']')[0])
      } else if (s === 'sz()') {
        last = inst.size()
      }
    }
    return last
  }
  // Otherwise every step is an argument expression.
  const args = steps.map((s) => new Function('return (' + s + ')')())
  return mod[task.exportName](...args)
}

// Compare results, including undefined.
function same(got, want) {
  if (want === 'undefined') return got === undefined
  return JSON.stringify(got) === want
}

// The run loop lives at the END of this file, after every REFERENCE and WEAK entry has
// been assigned. An earlier layout placed it here, above the F5/F6/F7 additions, so
// those tasks reported "NO REFERENCE" even though their implementations were present —
// the assignments simply had not executed yet. Order matters in a top-level script.

// ── References and weak twins for the F5/F6/F7 tasks ───────────────────────
REFERENCE['F5-skyline'] = `
export function skyline(buildings) {
  if (buildings.length === 0) return []
  const ev = []
  for (const [l, r, h] of buildings) { ev.push([l, h, 1]); ev.push([r, h, -1]) }
  // at an equal x, removals before additions (half-open intervals)
  ev.sort((a, b) => a[0] - b[0] || a[2] - b[2] || b[1] - a[1])
  const cnt = new Map()
  const out = []
  let prev = 0
  let i = 0
  while (i < ev.length) {
    const x = ev[i][0]
    while (i < ev.length && ev[i][0] === x) {
      const [, h, d] = ev[i]
      const c = (cnt.get(h) ?? 0) + d
      if (c <= 0) cnt.delete(h); else cnt.set(h, c)
      i++
    }
    let max = 0
    for (const h of cnt.keys()) if (h > max) max = h
    if (max !== prev) { out.push([x, max]); prev = max }
  }
  return out
}`

WEAK['F5-skyline'] = {
  why: 'does not collapse equal-height key points and mishandles half-open edges',
  src: `
export function skyline(buildings) {
  if (buildings.length === 0) return []
  const xs = new Set()
  for (const [l, r] of buildings) { xs.add(l); xs.add(r) }
  const sorted = [...xs].sort((a, b) => a - b)
  const out = []
  for (const x of sorted) {
    let max = 0
    for (const [l, r, h] of buildings) if (l <= x && x < r && h > max) max = h
    out.push([x, max])
  }
  return out
}`,
}

REFERENCE['F6-toposort'] = `
export function topoSort(nodes, edges) {
  const set = new Set(nodes)
  const adj = new Map()
  const indeg = new Map()
  for (const n of nodes) { adj.set(n, new Set()); indeg.set(n, 0) }
  for (const [f, t] of edges) {
    if (!set.has(f) || !set.has(t)) continue
    if (!adj.get(f).has(t)) { adj.get(f).add(t); indeg.set(t, indeg.get(t) + 1) }
  }
  const ready = [...nodes].filter((n) => indeg.get(n) === 0).sort()
  const out = []
  while (ready.length) {
    const n = ready.shift()
    out.push(n)
    for (const m of adj.get(n)) {
      indeg.set(m, indeg.get(m) - 1)
      if (indeg.get(m) === 0) {
        let lo = 0, hi = ready.length
        while (lo < hi) { const mid = (lo + hi) >> 1; if (ready[mid] < m) lo = mid + 1; else hi = mid }
        ready.splice(lo, 0, m)
      }
    }
  }
  if (out.length !== nodes.length) throw new Error('cycle detected')
  return out
}`

WEAK['F6-toposort'] = {
  why: 'DFS post-order — valid topological order but not lexicographically smallest, and misses some cycles',
  src: `
export function topoSort(nodes, edges) {
  const set = new Set(nodes)
  const adj = new Map()
  for (const n of nodes) adj.set(n, [])
  for (const [f, t] of edges) if (set.has(f) && set.has(t)) adj.get(f).push(t)
  const out = []
  const seen = new Set()
  const visit = (n) => {
    if (seen.has(n)) return
    seen.add(n)
    for (const m of adj.get(n)) visit(m)
    out.push(n)
  }
  for (const n of nodes) visit(n)
  return out.reverse()
}`,
}

REFERENCE['F7-intervals2'] = `
export function maxWeightSchedule(intervals) {
  const n = intervals.length
  if (n === 0) return { total: 0, chosen: [] }
  const items = intervals.map((v) => ({ start: v.start, end: v.end, weight: v.weight }))
    .sort((a, b) => a.end - b.end || a.start - b.start)
  const ends = items.map((v) => v.end)
  const p = new Array(n).fill(-1)
  for (let j = 0; j < n; j++) {
    let lo = 0, hi = j
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ends[mid] <= items[j].start) lo = mid + 1; else hi = mid }
    p[j] = lo - 1
  }
  const dp = new Array(n + 1).fill(0)
  for (let j = 0; j < n; j++) dp[j + 1] = Math.max(dp[j], dp[p[j] + 1] + items[j].weight)
  const chosen = []
  let j = n
  while (j > 0) {
    if (dp[p[j - 1] + 1] + items[j - 1].weight > dp[j - 1]) { chosen.push(items[j - 1]); j = p[j - 1] + 1 }
    else j--
  }
  chosen.sort((a, b) => a.start - b.start || a.end - b.end)
  return { total: dp[n], chosen }
}`

WEAK['F7-intervals2'] = {
  why: 'greedy by weight — takes the heaviest interval first instead of optimising',
  src: `
export function maxWeightSchedule(intervals) {
  const items = intervals.map((v) => ({ ...v })).sort((a, b) => b.weight - a.weight)
  const chosen = []
  for (const it of items) {
    if (chosen.every((c) => it.end <= c.start || it.start >= c.end)) chosen.push(it)
  }
  chosen.sort((a, b) => a.start - b.start || a.end - b.end)
  return { total: chosen.reduce((a, c) => a + c.weight, 0), chosen }
}`,
}
// ── RUN THE GATE (must be last: every REFERENCE/WEAK entry above must exist first) ──
console.log('=== TWO-WAY GATE: fair task set ===')
console.log('')
let bad = 0

for (const task of FAIR_TASKS) {
  const ref = REFERENCE[task.id]
  const weak = WEAK[task.id]
  if (!ref) { console.log('  ' + task.id.padEnd(16) + ' NO REFERENCE — cannot gate'); bad++; continue }
  if (!weak) { console.log('  ' + task.id.padEnd(16) + ' NO WEAK TWIN — cannot prove it discriminates'); bad++; continue }
  const r = await grade(task.id, ref, task)
  const w = await grade(task.id, weak.src, task)
  const refOk = r.passed === r.total
  const weakFails = w.passed < w.total

  let verdict = 'OK'
  if (!refOk) { verdict = 'REFERENCE FAILS'; bad++ }
  else if (!weakFails) { verdict = 'WEAK PASSES — cannot discriminate'; bad++ }

  console.log('  ' + task.id.padEnd(16) +
    ' ref ' + r.passed + '/' + r.total +
    '   weak ' + w.passed + '/' + w.total +
    '   ' + verdict)
  if (!refOk) for (const f of r.failures.slice(0, 4)) console.log('        ref: ' + f)
  if (refOk && !weakFails) console.log('        weak impl (' + weak.why + ') was NOT caught')
  if (refOk && weakFails) console.log('        weak impl (' + weak.why + ') caught: ' + w.failures[0])
}

rmSync(TMP, { recursive: true, force: true })
console.log('')
if (bad) { console.log('GATE: FAIL — ' + bad + ' task(s) unusable.'); process.exit(1) }
console.log('GATE: PASS — every task has a working reference and rejects a plausible weak attempt.')