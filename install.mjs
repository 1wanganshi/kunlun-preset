#!/usr/bin/env node
// 昆仑 (Kunlun) installer.
//
// WHAT THIS DOES
//   1. Resolves the placeholder tokens in the shipped composition against THIS
//      machine, so one repo works for every user.
//   2. Installs the preset bundle into the profile.
//   3. Generates the preset registry row.
//   4. Registers the bundle with the profile.
//   5. Selects 昆仑 as the default preset.
//   6. Enables multi-model routing (see the long note at step 6 — the preset's own
//      config row is NOT enough on its own).
//   7. Installs the bundled skills into <dshHome>/skills.
//
// USAGE
//   node install.mjs                 # install into the default profile
//   node install.mjs --dry-run       # show what would change, write nothing
//   node install.mjs --profile <dir> # install into a specific profile directory
//
// RESTART the desktop app afterwards. The harness composes a preset when a session
// starts, so nothing already running picks up the change.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const DRY = args.includes('--dry-run') || args.includes('--dryRun')

function argValue(flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

// ── Locate the harness home and profile ─────────────────────────────────────
//
// The environment is authoritative: DSH_HOME and DSH_PROFILE_DIR are set by the
// running app, and honouring them is what lets a test install into an isolated
// directory. Falling back to the platform default keeps a manual `node install.mjs`
// working.
const DSH_HOME = process.env.DSH_HOME
  || (process.platform === 'win32'
    ? path.join(process.env.USERPROFILE || '', '.dsh')
    : path.join(process.env.HOME || '', '.dsh'))

const PROFILE = argValue('--profile')
  || process.env.DSH_PROFILE_DIR
  || path.join(DSH_HOME, 'profiles', 'desktop')

const BUNDLE_NAME = 'kunlun-preset-bundle'
const BUNDLE_DIR = path.join(PROFILE, 'node_modules', BUNDLE_NAME)
const PRESET_ID = 'kunlun'

// ── Tokens resolved at install time ─────────────────────────────────────────
const MODULE_DIR = path.join(BUNDLE_DIR, 'presets', 'kunlun')
const NODE_EXE = process.execPath
const MCP_ENTRY = path.join(BUNDLE_DIR, 'mcp', 'server-memory', 'dist', 'index.js')
const MEMORY_FILE = path.join(DSH_HOME, 'kunlun-memory.json')

const TOKENS = {
  '@@KUNLUN_MODULE_DIR@@': MODULE_DIR,
  '@@NODE_EXE@@': NODE_EXE,
  '@@KUNLUN_MCP_ENTRY@@': MCP_ENTRY,
  '@@KUNLUN_MEMORY_FILE@@': MEMORY_FILE,
}

// Routes the installer allows for subagents. These are a PERMISSION LIST, not a
// hard binding — they say which provider/model pairs an agent may pick from.
//
// The list deliberately spans providers rather than taking six models from one,
// because routing is only useful when the models actually differ: `d1api` serves
// glm-5.3, kimi-k3 and minimax-m3, while `deepseek-official` serves deepseek-v4-pro
// with reasoning-effort levels. A route whose provider has no credentials is simply
// unusable, so listing a model you have not bought is harmless. Edit freely.
const ROUTES = [
  { provider: 'd1api', model: 'deepseek-v4.1-flash' },
  { provider: 'd1api', model: 'glm-5.3' },
  { provider: 'd1api', model: 'kimi-k3' },
  { provider: 'd1api', model: 'minimax-m3' },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  { provider: 'deepseek-official', model: 'deepseek-flash' },
]

function say(s) { console.log(s) }
function step(s) { console.log(''); console.log('== ' + s) }
function read(p) { return fs.readFileSync(p, 'utf8') }
function write(p, t) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, t, 'utf8')
}
function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0
  fs.mkdirSync(to, { recursive: true })
  let n = 0
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name)
    const d = path.join(to, e.name)
    if (e.isDirectory()) n += copyDir(s, d)
    else { fs.copyFileSync(s, d); n++ }
  }
  return n
}

say('昆仑 (Kunlun) installer')
say('  dsh home : ' + DSH_HOME)
say('  profile  : ' + PROFILE)
say('  mode     : ' + (DRY ? 'DRY RUN (nothing written)' : 'installing'))

if (!fs.existsSync(PROFILE)) {
  say('')
  say('ERROR: the profile directory does not exist:')
  say('  ' + PROFILE)
  say('Start DeepSeek Harness Desktop at least once, then run this again.')
  process.exit(1)
}

// ── 1. Composition with resolved paths ──────────────────────────────────────
step('1. resolving the composition against this machine')
const compSrc = path.join(HERE, 'presets', PRESET_ID, 'agent.cordis.yml')
if (!fs.existsSync(compSrc)) {
  say('ERROR: presets/' + PRESET_ID + '/agent.cordis.yml is missing from the release.')
  process.exit(1)
}
let comp = read(compSrc)
for (const [token, value] of Object.entries(TOKENS)) {
  const n = comp.split(token).length - 1
  if (n) {
    comp = comp.split(token).join(value.replace(/\\/g, '/'))
    say('   ' + token + '  x' + n + '  ->  ' + value)
  }
}
// A leftover token would install a preset that references the literal string
// "@@NODE_EXE@@" and fails at boot with a confusing error. Catch it here instead.
const unresolved = (comp.match(/@@[A-Z_]+@@/g) ?? []).length
if (unresolved) {
  say('   ERROR: ' + unresolved + ' placeholder(s) were not resolved — aborting.')
  process.exit(1)
}
say('   all placeholders resolved')

// Rewrite the relative module references to absolute file:// URLs BEFORE writing.
//
// This is what makes the bundle movable. Left relative, they resolve against the
// HOST's directory rather than the installed bundle and mount nothing.
const MODULE_REFS = [...comp.matchAll(/\.\/[A-Za-z0-9._-]+\.mjs/g)].map((m) => m[0])
comp = comp.replace(/(\.\/[A-Za-z0-9._-]+\.mjs)/g, (m) => {
  return 'file:///' + path.join(MODULE_DIR, m.slice(2)).replace(/\\/g, '/')
})
say('   rewrote ' + MODULE_REFS.length + ' module reference(s) to absolute URLs')

// ── 2. Install the preset bundle ────────────────────────────────────────────
step('2. installing the preset bundle')
let copied = 0
if (!DRY) {
  fs.mkdirSync(BUNDLE_DIR, { recursive: true })
  copied += copyDir(path.join(HERE, 'presets'), path.join(BUNDLE_DIR, 'presets'))
  copied += copyDir(path.join(HERE, 'mcp'), path.join(BUNDLE_DIR, 'mcp'))
  copied += copyDir(path.join(HERE, 'lib'), path.join(BUNDLE_DIR, 'lib'))
  write(path.join(BUNDLE_DIR, 'cordis.patch.yml'), comp)
  const manifest = {
    name: BUNDLE_NAME,
    version: '1.0.0',
    private: true,
    description: '昆仑模式 (Kunlun) agent preset, declared through the official @deepseek-ai/dsh-agent-preset mechanism.',
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  write(path.join(BUNDLE_DIR, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  say('   ' + copied + ' file(s) -> ' + BUNDLE_DIR)
} else {
  say('   would copy the bundle into ' + BUNDLE_DIR)
}

// ── 3. Generate the preset registry row ─────────────────────────────────────
step('3. generating the preset registry row')
//
// The registry row tells the harness the preset exists. It is generated from the
// composition rather than hand-maintained, so the two cannot drift apart.
//
// NOTE: the composition is a BARE row list with no `plugins:` key of its own, so it
// is wrapped here. Searching it for its own `plugins:` key finds nothing and would
// silently discard the whole file.
{
  const rowOut = path.join(PROFILE, 'cordis.kunlun.yml')
  const indented = comp.split('\n').map((l) => (l.trim() ? '          ' + l : l)).join('\n')
  const row =
    '# GENERATED by install.mjs — the 昆仑 preset registry row.\n' +
    '#\n' +
    '# Do not edit by hand: re-running the installer regenerates it from the\n' +
    '# shipped composition.\n' +
    'plugins:\n' +
    '  - id: preset-' + PRESET_ID + '\n' +
    '    name: "@deepseek-ai/dsh-agent-preset"\n' +
    '    config:\n' +
    '      id: ' + PRESET_ID + '\n' +
    '      name: 昆仑模式\n' +
    '      order: 5\n' +
    '      composition:\n' +
    indented + '\n'
  if (!DRY) write(rowOut, row)
  say('   ' + (DRY ? 'would write ' : 'wrote ') + rowOut)
}

// ── 4. Register the bundle ──────────────────────────────────────────────────
step('4. registering the bundle with the profile')
{
  const pkgPath = path.join(PROFILE, 'package.json')
  let pkg = {}
  if (fs.existsSync(pkgPath)) {
    try { pkg = JSON.parse(read(pkgPath)) } catch { pkg = {} }
  }
  pkg.dependencies = pkg.dependencies || {}
  if (!pkg.dependencies[BUNDLE_NAME]) {
    pkg.dependencies[BUNDLE_NAME] = 'file:./node_modules/' + BUNDLE_NAME
    if (!DRY) write(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    say('   added "' + BUNDLE_NAME + '" to the profile dependencies')
  } else {
    say('   already registered')
  }
}

// ── 5. Select 昆仑 as the default preset ────────────────────────────────────
step('5. selecting 昆仑 as the default preset')
//
// The settings document may not exist yet on a machine where the app has been
// started but never had a setting changed. Creating it is required, because steps 5
// and 6 both write here — and before this was handled, both steps silently did
// nothing on a fresh profile while the installer still reported success.
{
  const profPatch = path.join(PROFILE, 'cordis.patch.yml')
  if (!fs.existsSync(profPatch)) {
    say('   settings document does not exist yet — creating it')
    if (!DRY) write(profPatch, '# Profile settings and generated rows.\nplugins: []\n')
  }
  let t = read(profPatch)
  if (!/selectedDefault:/.test(t)) {
    // No registry row to patch yet, so add one that carries the selection.
    say('   no preset registry row found — appending one')
    t = t.replace(/\s*$/, '\n') +
      '\n# Selects the active agent preset.\n' +
      '- id: agent-preset-registry\n' +
      '  config:\n' +
      '    selectedDefault: ' + PRESET_ID + '\n'
    if (!DRY) write(profPatch, t)
    say('   set selectedDefault: ' + PRESET_ID)
  } else {
    const before = t
    t = t.replace(/(selectedDefault:\s*)(\S+)/, '$1' + PRESET_ID)
    if (t !== before) {
      if (!DRY) write(profPatch, t)
      say('   set selectedDefault: ' + PRESET_ID)
    } else {
      say('   already selected')
    }
  }
}

// ── 6. Enable multi-model routing ───────────────────────────────────────────
//
// THIS STEP EXISTS BECAUSE OF A REAL DEFECT, and omitting it would reproduce that
// defect for every user of this repo.
//
// The preset's `tool-subagent` row sets `modelSelectionSettings: true`. That does
// NOT enable routing. It only allows the tool to READ a Host-side preference. With
// the preference left at its default, the `subagent` tool exposes just
// description/prompt/run_in_background, `list_subagent_models` never registers, and
// the preset looks configured while routing silently does nothing.
//
// Writing the preference is the difference between a feature and a no-op.
step('6. enabling multi-model routing')
{
  const profPatch = path.join(PROFILE, 'cordis.patch.yml')
  // Step 5 guarantees this exists, but re-check so the step is safe on its own.
  if (!fs.existsSync(profPatch)) {
    say('   settings document missing — creating it')
    if (!DRY) write(profPatch, '# Profile settings and generated rows.\nplugins: []\n')
  }
  {
    const t = read(profPatch)
    if (t.includes('subagent-model-selection-settings')) {
      // Never clobber routes the user chose for themselves.
      say('   already configured — left untouched (your chosen routes are preserved)')
    } else {
      const routes = ROUTES
        .map((r) => '      - provider: ' + r.provider + '\n        model: ' + r.model)
        .join('\n')
      const block =
        '\n' +
        '# Multi-model routing for the 昆仑 preset.\n' +
        '#\n' +
        '# `dsh-tool-subagent` samples this preference when each fresh session is\n' +
        '# composed, so it takes effect on the NEXT session, not the current one.\n' +
        '#\n' +
        '# Without it the `subagent` tool accepts no provider/model and every child\n' +
        '# runs on the parent\'s model.\n' +
        '#\n' +
        '# These routes are a permission list, not a binding. Edit freely.\n' +
        '- id: subagent-model-selection-settings\n' +
        '  config:\n' +
        '    enabled: true\n' +
        '    allowedModels:\n' +
        routes + '\n'
      if (!DRY) write(profPatch, t.replace(/\s*$/, '\n') + block)
      say('   ' + (DRY ? 'would enable ' : 'enabled ') + ROUTES.length + ' route(s):')
      for (const r of ROUTES) say('     ' + r.provider + ' / ' + r.model)
    }
  }
}

// ── 7. Install the skills ───────────────────────────────────────────────────
//
// Skills live in <dshHome>/skills — the rank-400 `user-dsh` root — NOT in the
// profile. The harness does not create this directory, so a fresh install would
// otherwise have a preset with no skills at all.
step('7. installing skills')
{
  const src = path.join(HERE, 'skills')
  const dst = path.join(DSH_HOME, 'skills')
  if (!fs.existsSync(src)) {
    say('   (no skills bundled with this release)')
  } else {
    // Only directories with a SKILL.md, because that is the discovery contract.
    const names = fs.readdirSync(src, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(src, e.name, 'SKILL.md')))
      .map((e) => e.name)
    if (!names.length) {
      say('   (no skills with a SKILL.md found)')
    } else if (DRY) {
      say('   would install ' + names.length + ' skill(s) into ' + dst)
      for (const n of names) say('     ' + n)
    } else {
      fs.mkdirSync(dst, { recursive: true })
      for (const n of names) copyDir(path.join(src, n), path.join(dst, n))
      say('   installed ' + names.length + ' skill(s) into ' + dst)
      for (const n of names) say('     ' + n)
      say('   (the harness watches this directory — skills need no restart)')
    }
  }
}

// ── Done ────────────────────────────────────────────────────────────────────
step('done')
if (DRY) {
  say('Dry run complete. Re-run without --dry-run to install.')
} else {
  say('Installed.')
  say('')
  say('NEXT: restart DeepSeek Harness Desktop, then pick 昆仑模式 in')
  say('Settings > Agent 预设.')
  say('')
  say('Restarting matters for three things:')
  say('  - the preset itself is composed when a session starts')
  say('  - the routing preference is sampled when a session starts')
  say('  - the MCP memory server is launched with the profile')
}
