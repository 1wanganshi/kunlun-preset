// Verify every local module's waterfall listeners honour the waterfall contract.
//
// THE DEFECT THIS EXISTS FOR
//
// guard.mjs registered:
//
//     ctx.on('agent/request', (request, session) => {
//       ...
//       return request              // <-- returns the PAYLOAD
//     })
//
// But `agent/request` is a waterfall whose payload is `{ turn, step, signal }`;
// the request config (with provider/model) is the SEED, reachable only through
// next(). A listener's return value REPLACES the seed, so returning the payload
// produced a config with no provider/model and agent-loop threw
//
//     agent "<id>" has no provider/model
//
// which surfaced as a silent turn failure — step/start then step/end, no
// error record. That cost many restarts to find, because nothing pointed at the
// listener.
//
// The contract is mechanically checkable: for each `agent/*` waterfall a module
// listens on, the handler must `await next()` and must not return its first
// parameter. Assert both by reading the source text of the handler.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as _paths from './env-paths.mjs'

const MODULES = join(_paths.BUNDLE, 'modules')
const SOURCE = join(_paths.PLUGIN, 'presets', 'kunlun')

// Waterfalls whose payload is NOT the request config: a listener must call
// next() to see the real value, and must never return its first argument.
const WATERFALLS = new Set(['agent/request', 'agent/request-error'])

const problems = []
let checked = 0

for (const dir of [MODULES, SOURCE]) {
  let files
  try { files = readdirSync(dir).filter((f) => f.endsWith('.mjs')) } catch { continue }
  for (const f of files) {
    let src
    try { src = readFileSync(join(dir, f), 'utf8') } catch { continue }
    const lines = src.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const m = /ctx\.on\(\s*['"]([\w/:.-]+)['"]\s*,\s*(?:async\s*)?\(?\s*([\w$]+)/.exec(lines[i])
      if (!m) continue
      const event = m[1]
      if (!WATERFALLS.has(event)) continue

      // Grab the handler body: from this line to the matching `})` at the same
      // indent, bounded so a malformed file cannot hang the scan.
      let depth = 0
      let body = ''
      let started = false
      for (let j = i; j < Math.min(i + 120, lines.length); j++) {
        const l = lines[j]
        for (const ch of l) {
          if (ch === '(' || ch === '{') { depth++; started = true }
          else if (ch === ')' || ch === '}') depth--
        }
        body += l + '\n'
        if (started && depth <= 0) break
      }

      checked++

      // 1. must await next()
      if (!/\bawait\s+next\s*\(/.test(body) && !/\bnext\s*\(\s*\)/.test(body)) {
        problems.push({
          what: 'waterfall listener never calls next()',
          where: f + ':' + (i + 1),
          event,
          detail: 'On ' + event + ' the payload is not the config; without next() the seed is unreachable.',
        })
      }

      // 2. must not return the first parameter (which would replace the seed)
      const first = m[2]
      const badReturn = new RegExp('return\\s+' + first.replace(/\$/g, '\\$') + '\\s*;?\\s*$', 'm')
      if (badReturn.test(body)) {
        problems.push({
          what: 'waterfall listener returns its first parameter',
          where: f + ':' + (i + 1),
          event,
          detail: '`return ' + first + '` replaces the seed with the payload, dropping provider/model.',
        })
      }

      // 3. must not spread the first parameter as the result
      if (new RegExp('return\\s*\\{\\s*\\.\\.\\.' + first.replace(/\$/g, '\\$')).test(body)) {
        problems.push({
          what: 'waterfall listener spreads its first parameter',
          where: f + ':' + (i + 1),
          event,
          detail: 'Spreading the payload yields a config with no provider/model.',
        })
      }
    }
  }
}

console.log('waterfall listeners examined: ' + checked)
console.log('')
if (problems.length === 0) {
  console.log('RESULT: PASS - every agent/* waterfall listener awaits next() and')
  console.log('        returns a config derived from it')
} else {
  console.log('RESULT: FAIL - these listeners would break the request waterfall:')
  for (const p of problems) {
    console.log('  ' + p.what)
    console.log('     at ' + p.where + '   event=' + p.event)
    console.log('     ' + p.detail)
  }
  process.exitCode = 1
}
