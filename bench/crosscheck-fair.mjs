// Verify every expectation in the F5/F6/F7 tasks against an independent implementation.
//
// This exists because I hand-wrote wrong expected values THREE times while building
// this suite (applyDiscount(999,10), [4,8,9] vs [3,8,9], and two reversed LRU cases).
// Every one was caught only by cross-checking against a real algorithm. So the rule is
// now mechanical: no expectation is trusted until an independent implementation
// reproduces it.
//
// The implementations here are written from the SPEC text, deliberately not copied from
// the gate's references, so agreement is evidence rather than a tautology.
import { FAIR_TASKS } from './fair-tasks.mjs'

const impl = {}

// ── F5 skyline ──────────────────────────────────────────────────────────────
impl['F5-skyline'] = function skyline(buildings) {
  if (buildings.length === 0) return []
  const events = []
  for (const [l, r, h] of buildings) {
    events.push([l, h, 'add'])
    events.push([r, h, 'del'])
  }
  // process adds before dels at the same x is WRONG for half-open; process del first
  events.sort((a, b) => a[0] - b[0] || (a[2] === 'del' ? -1 : 1) - (b[2] === 'del' ? -1 : 1) || b[1] - a[1])
  const heights = new Map()
  const out = []
  let i = 0
  let prevMax = 0
  while (i < events.length) {
    const x = events[i][0]
    while (i < events.length && events[i][0] === x) {
      const [, h, kind] = events[i]
      if (kind === 'add') heights.set(h, (heights.get(h) ?? 0) + 1)
      else {
        const c = heights.get(h) - 1
        if (c <= 0) heights.delete(h); else heights.set(h, c)
      }
      i++
    }
    let max = 0
    for (const h of heights.keys()) if (h > max) max = h
    if (max !== prevMax) {
      out.push([x, max])
      prevMax = max
    }
  }
  return out
}

// ── F6 toposort ─────────────────────────────────────────────────────────────
impl['F6-toposort'] = function topoSort(nodes, edges) {
  const set = new Set(nodes)
  const adj = new Map()
  const indeg = new Map()
  for (const n of nodes) { adj.set(n, new Set()); indeg.set(n, 0) }
  for (const [f, t] of edges) {
    if (!set.has(f) || !set.has(t)) continue
    if (!adj.get(f).has(t)) { adj.get(f).add(t); indeg.set(t, indeg.get(t) + 1) }
  }
  // sorted frontier, smallest first
  const ready = [...nodes].filter((n) => indeg.get(n) === 0).sort()
  const out = []
  while (ready.length) {
    const n = ready.shift()
    out.push(n)
    for (const m of adj.get(n)) {
      indeg.set(m, indeg.get(m) - 1)
      if (indeg.get(m) === 0) {
        // insert keeping sorted order
        let lo = 0, hi = ready.length
        while (lo < hi) { const mid = (lo + hi) >> 1; if (ready[mid] < m) lo = mid + 1; else hi = mid }
        ready.splice(lo, 0, m)
      }
    }
  }
  if (out.length !== nodes.length) throw new Error('cycle detected')
  return out
}

// ── F7 weighted interval scheduling ─────────────────────────────────────────
impl['F7-intervals2'] = function maxWeightSchedule(intervals) {
  const n = intervals.length
  if (n === 0) return { total: 0, chosen: [] }
  // Sort by end, then by start (so on ties the earlier-starting comes first).
  const items = intervals.map((v, i) => ({ ...v, i })).sort((a, b) => a.end - b.end || a.start - b.start)
  const ends = items.map((v) => v.end)
  // p[j] = last index < j whose end <= items[j].start
  const p = new Array(n).fill(-1)
  for (let j = 0; j < n; j++) {
    let lo = 0, hi = j
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ends[mid] <= items[j].start) lo = mid + 1; else hi = mid }
    p[j] = lo - 1
  }
  // dp with reconstruction
  const dp = new Array(n + 1).fill(0)
  for (let j = 0; j < n; j++) dp[j + 1] = Math.max(dp[j], dp[p[j] + 1] + items[j].weight)
  const chosen = []
  let j = n
  while (j > 0) {
    const take = dp[p[j - 1] + 1] + items[j - 1].weight
    if (take > dp[j - 1]) { chosen.push(items[j - 1]); j = p[j - 1] + 1 }
    else j--
  }
  chosen.sort((a, b) => a.start - b.start || a.end - b.end)
  return { total: dp[n], chosen: chosen.map(({ start, end, weight }) => ({ start, end, weight })) }
}

// ── Cross-check ─────────────────────────────────────────────────────────────
const ONLY = process.argv.slice(2)
let bad = 0
let checked = 0

for (const task of FAIR_TASKS) {
  if (!impl[task.id]) continue
  if (ONLY.length && !ONLY.includes(task.id)) continue
  console.log('--- ' + task.id + ' ---')
  for (const t of task.tests) {
    checked++
    const wantThrow = t.want === 'THROW'
    let got
    let threw = false
    try {
      const args = t.call.map((c) => new Function('return (' + c + ')')())
      got = impl[task.id](...args)
    } catch (e) { threw = true; got = 'THREW: ' + e.message }

    let ok
    if (wantThrow) ok = threw
    else if (threw) ok = false
    else ok = JSON.stringify(got) === t.want

    if (!ok) bad++
    console.log('  ' + (ok ? 'OK   ' : 'WRONG') + ' ' + t.call.join(', ').slice(0, 72))
    if (!ok) {
      console.log('        declared: ' + t.want.slice(0, 150))
      console.log('        computed: ' + (threw ? got : JSON.stringify(got)).slice(0, 150))
    }
  }
}

console.log('')
if (!checked) { console.log('NOTHING CHECKED — the filter matched no task.'); process.exit(1) }
if (bad) { console.log(bad + ' of ' + checked + ' expectations disagree with an independent implementation.'); process.exit(1) }
console.log('ALL ' + checked + ' expectations reproduce independently.')
