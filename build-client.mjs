// Bundles the 昆仑 browser half into the format the GUI's module loader expects.
//
// The client bundle is NOT plain ESM: the web shell loads it through
// `window.__ModuleLoader__.load({ id, factory })`, where `factory(require)` receives a
// require that resolves the host's shared modules — `react` and `react/jsx-runtime`
// among them. LiangShen's shipped client.js has exactly this shape, and a plain ESM
// file will silently never execute, which is why this is generated rather than
// hand-written.
//
// The sources in src/ are concatenated in dependency order with their `import`/`export`
// statements stripped, then wrapped in the loader call. This keeps the bundle readable
// and avoids adding a bundler to a plugin that otherwise needs none.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, 'src')
const OUT = join(HERE, 'lib', 'client.js')

const FILES = [
  ['lever-controller.js', 'leverController'],
  ['lever.js', 'lever'],
]

function stripModuleSyntax(code) {
  return code
    // Drop import statements; the bundle takes react from the factory argument.
    .replace(/^\s*import\s+[^;]*?from\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^\s*import\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    // Drop export keywords but keep the declarations.
    .replace(/^\s*export\s+(async\s+)?(function|class|const|let|var)\b/gm, (m, a, k) => `${a ?? ''}${k}`)
    // Convert `export { a, b }` into nothing (the wrapper exports what it needs).
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '')
}

// The two functions the entry point needs, exported from the wrapper's scope.
let body = ''
for (const [file] of FILES) {
  const p = join(SRC, file)
  if (!existsSync(p)) {
    console.error('missing source: ' + p)
    process.exit(1)
  }
  body += `// ── ${file} ${'─'.repeat(Math.max(0, 58 - file.length))}\n`
  body += stripModuleSyntax(readFileSync(p, 'utf8'))
  body += '\n'
}

// The entry: mount the lever using the shared react the loader hands us.
body += `
// ── entry ${'─'.repeat(56)}
function apply(ctx) {
  var controller = new LeverController(ctx)
  ctx.effect(function () { return function () { controller.dispose() } }, 'kunlun: lever controller')
  controller.start()
  var lever = createKunlunLever(ctx, react)
  lever.attach(controller)
}
`

const out = `window.__ModuleLoader__.load({
	id: "dsh-kunlun",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
${body}
		exports.apply = apply;
		exports.inject = ["slots", "sessions", "remote", "remote.agentPresets"];
		exports.LeverController = LeverController;
		exports.KUNLUN_PRESET_ID = KUNLUN_PRESET_ID;
		return module.exports;
	}
});
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, out, 'utf8')

// Sanity: the bundle must reference the loader, react, and both symbols.
const checks = [
  ['__ModuleLoader__', out.includes('window.__ModuleLoader__.load')],
  ['id dsh-kunlun', out.includes('id: "dsh-kunlun"')],
  ['require("react")', out.includes('require("react")')],
  ['exports.apply', out.includes('exports.apply = apply')],
  ['LeverController defined', /class\s+LeverController|const\s+LeverController|function\s+LeverController/.test(out)],
  ['createKunlunLever defined', /function\s+createKunlunLever/.test(out)],
  ['inject lists slots', out.includes('"slots"')],
]
let bad = 0
for (const [name, ok] of checks) {
  console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + name)
  if (!ok) bad++
}
console.log('')
console.log('wrote ' + OUT + '  (' + out.length + ' B)')
if (bad) { console.error('bundle check FAILED'); process.exit(1) }
