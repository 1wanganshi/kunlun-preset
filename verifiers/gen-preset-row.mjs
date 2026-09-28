// Generate a `@deepseek-ai/dsh-agent-preset` row carrying the kunlun composition,
// with every relative module name resolved to an absolute file: URL.
//
// Why a generator rather than a hand-written file: the composition is 20 KB and
// its five local .mjs modules must resolve against the INSTALLED preset
// directory, so the row has to be emitted, not typed.
//
// Paths are derived from this file's own location rather than hardcoded, so the
// generator keeps working wherever the plugin is checked out. DSH_PRESET_DIR
// overrides it, which is how a build can point it at a candidate directory.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { readPresetDefinition } = await import(new URL('./lib/composition.js', import.meta.url).href)

const PRESET_DIR = process.env.DSH_PRESET_DIR
  ? process.env.DSH_PRESET_DIR.replace(/\\/g, '/')
  : path.join(HERE, 'presets', 'kunlun').replace(/\\/g, '/') + '/'

const def = readPresetDefinition('kunlun', PRESET_DIR)

// An empty block-style list (`pagedToolPatterns:` with nothing under it) parses
// as null, but the paging plugins validate their config as an ARRAY. Normalize
// it here so the emitted row carries `[]` rather than `null`.
const EMPTY_LIST_KEYS = new Set(['pagedToolPatterns'])
function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.__jsExpr === 'string') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    out[key] = EMPTY_LIST_KEYS.has(key) && (value === null || value === undefined) ? [] : normalize(value)
  }
  return out
}
def.plugins = normalize(def.plugins)

/** Render one JS value as YAML, block style, at the given indent. */
function yaml(value, indent) {
  const pad = ' '.repeat(indent)
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    // Quote when the scalar could be misread.
    if (/^[\s]|[\s]$|[:#\-?*&!|>%@`{}[\],"']/.test(value) || value === '' || /^(true|false|null|~|\d)/.test(value)) {
      return JSON.stringify(value)
    }
    return value
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const lines = []
    for (const item of value) {
      const rendered = yaml(item, indent + 2)
      if (rendered.includes('\n')) {
        lines.push(`${pad}-\n${rendered}`)
      } else {
        lines.push(`${pad}- ${rendered.trimStart()}`)
      }
    }
    return lines.join('\n')
  }  if (typeof value === 'object') {
    // A !!js marker must stay an inline tagged scalar for the Loader.
    if (typeof value.__jsExpr === 'string') return `${pad}!!js ${value.__jsExpr}`
    const keys = Object.keys(value)
    if (keys.length === 0) return '{}'
    const lines = []
    for (const key of keys) {
      const child = value[key]
      const rendered = yaml(child, indent + 2)

      // A string that MUST keep its line breaks goes through a literal block,
      // because a single-line flow scalar would swallow the newlines and merge
      // the following key into the value.
      if (typeof child === 'string' && child.includes('\n')) {
        lines.push(`${pad}${key}: |-`)
        for (const line of child.split('\n')) lines.push(line === '' ? '' : `${pad}  ${line}`)
        continue
      }
      if (Array.isArray(child)) {
        lines.push(rendered === '[]' ? `${pad}${key}: []` : `${pad}${key}:\n${rendered}`)
        continue
      }
      if (typeof child === 'object' && child !== null) {
        // A `!!js` marker renders as `<pad>!!js expr`; every other object opens
        // a nested block after its own key line.
        if (typeof child.__jsExpr === 'string') {
          lines.push(`${pad}${key}: ${rendered.trimStart()}`)
          continue
        }
        lines.push(`${pad}${key}:\n${rendered}`)
        continue
      }
      lines.push(`${pad}${key}: ${rendered}`)
    }
    return lines.join('\n')
  }
  return JSON.stringify(value)
}

const row = {
  id: 'preset-kunlun',
  name: '@deepseek-ai/dsh-agent-preset',
  config: {
    id: def.id,
    name: def.name,
    description: def.description,
    order: def.order,
    plugins: def.plugins,
  },
}

const out = [
  '# 昆仑模式 (Kunlun) �?an official @deepseek-ai/dsh-agent-preset declaration.',
  '#',
  '# �?THE `- insert:` WRAPPER IS MANDATORY, NOT DECORATION.',
  '#',
  '# A bare top-level `- id: <x>` entry is a PATCH: it addresses a row that',
  '# already exists in an earlier layer and does nothing when that id is absent.',
  '# composeEntries() reports the miss and DROPS the entry:',
  '#',
  '#     patch: entry "preset-kunlun" not found',
  '#',
  '# That is precisely why an earlier revision of this file declared nothing:',
  '# the desktop patch uses bare `- id:` overrides for EXISTING rows (ui-chat,',
  '# llm-pi-ai, ...), and copying that shape for a NEW row silently discarded it.',
  '# The four shipped presets wrap themselves the same way �?see',
  '#   @deepseek-ai/dsh-web-app/presets/standard.patch.yml',
  '# which opens with `- insert:` before `- id: preset-standard`.',
  '#',
  '# Generated from The Kunlun plugin\'s bundled composition by gen-preset-row.mjs;',
  '# every local .mjs is resolved to an absolute file: URL against',
  '#   ' + PRESET_DIR,
  '# so this file does NOT need the plugin installed to work.',
  '',
  yaml([{ insert: [row] }], 0),
  '',
].join('\n')

// The row file lands beside the profile it belongs to. DSH_OUT overrides it, and
// the profile is discovered the same way the harness discovers it, so this works on
// a machine that is not this one.
const OUT = process.env.DSH_OUT
  || path.join(
    process.env.DSH_PROFILE_DIR
      || path.join(process.env.DSH_HOME
        || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'),
        'profiles', 'desktop'),
    'cordis.kunlun.yml')
writeFileSync(OUT, out, 'utf8')
console.log('wrote ' + OUT)
console.log('  preset id   :', def.id)
console.log('  display name:', def.name)
console.log('  rows        :', def.plugins.length)
console.log('  bytes       :', Buffer.byteLength(out, 'utf8'))
