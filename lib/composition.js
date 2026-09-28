/**
 * composition — the Baize preset's composition reader.
 *
 * Under 0.1.7-rc a preset is an ordinary registry declaration rather than a
 * directory the harness scans, so this plugin hands `ctx.agentPresets` the rows
 * of its OWN bundled composition. No YAML package is resolvable from this
 * package, so the subset is owned here rather than imported.
 *
 * Supported: block maps and sequences, quoted and plain scalars, single-line
 * flow sequences, literal and folded block scalars, comments, and `!!js`
 * expressions preserved as data (`{ __jsExpr }` — the shape the Loader itself
 * hands a plugin).
 *
 * Fail-closed: a construct outside the subset — anchors, aliases, tags other
 * than `!!js`, NESTED flow collections, multiple documents, tabs — raises
 * {@link CompositionError} rather than being guessed at, so an unreadable
 * composition is refused instead of half-declared.
 *
 * NOTE the deliberate difference from the LiangShen reader: that one rejects
 * ALL flow collections. Baize accepts a single-line flow SEQUENCE (`[a, b]`)
 * because the official preset-center accepts flow collections too and an
 * operator switching between surfaces should not have to rewrite the file.
 * This is strictly more permissive, so it can never reject a file the other
 * reader would accept.
 *
 * Relative module names (`name: ./guard.mjs`) are resolved against the preset
 * directory and emitted as file URLs: the registry mounts a declaration under
 * the DECLARING LOADER's base, so a relative name would otherwise resolve
 * outside this package.
 *
 * @module dsh-baize/composition
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** A construct outside the supported subset, or malformed YAML. */
export class CompositionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CompositionError'
  }
}

const BLANK_OR_COMMENT_RE = /^[ \t]*(?:#.*)?$/
const INTEGER_RE = /^[+-]?\d+$/
const FLOAT_RE = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/

/** The composition file every preset directory carries. */
export const COMPOSITION_FILE = 'agent.cordis.yml'

/** The display-metadata file beside it. */
export const METADATA_FILE = 'preset.yml'

/** The indentation width of one line (its leading spaces). */
function indentOf(line) {
  return /^ */.exec(line)?.[0].length ?? 0
}

/** The indentation of a structurally significant line; tabs are forbidden. */
function significantIndent(line, lineNumber) {
  const leading = /^[ \t]*/.exec(line)?.[0] ?? ''
  if (leading.includes('\t')) {
    throw new CompositionError(`line ${String(lineNumber)}: tabs must not be used for indentation`)
  }
  return leading.length
}

/** Advance past blank and comment-only lines. */
function skipInsignificant(cursor) {
  while (cursor.index < cursor.lines.length && BLANK_OR_COMMENT_RE.test(cursor.lines[cursor.index] ?? '')) {
    cursor.index += 1
  }
}

/** Whether a line at `indent` opens a block sequence entry. */
function isSequenceEntry(line, indent) {
  if (line[indent] !== '-') return false
  return line.length === indent + 1 || line[indent + 1] === ' '
}

/** Strip a trailing comment that is not inside a quoted scalar. */
function stripComment(text) {
  let quote
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== undefined) {
      if (quote === '"' && char === '\\') { index += 1; continue }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '#' && (index === 0 || text[index - 1] === ' ' || text[index - 1] === '\t')) {
      return text.slice(0, index)
    }
  }
  return text
}

/** The index of the quote that closes a quoted scalar starting at index 0. */
function closingQuote(text) {
  const quote = text[0]
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index]
    if (quote === '"' && char === '\\') { index += 1; continue }
    if (quote === "'" && char === "'" && text[index + 1] === "'") { index += 1; continue }
    if (char === quote) return index
  }
  return -1
}

/** Unquote a scalar, honoring YAML's doubled-single-quote escape. */
function unquote(text) {
  const quote = text[0]
  const body = text.slice(1, -1)
  if (quote === "'") return body.replaceAll("''", "'")
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, esc) => {
    if (esc[0] === 'u' || esc[0] === 'x') return String.fromCharCode(Number.parseInt(esc.slice(1), 16))
    const simple = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0' }
    return simple[esc] ?? esc
  })
}

/** Split a single-line flow sequence body on its top-level commas. */
function splitFlow(body) {
  const parts = []
  let depth = 0
  let quote
  let current = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (quote !== undefined) {
      current += char
      if (quote === '"' && char === '\\') { current += body[index + 1] ?? ''; index += 1; continue }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue }
    if (char === '[' || char === '{') depth += 1
    if (char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += char
  }
  if (current.trim() !== '' || parts.length > 0) parts.push(current)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

/** Parse one scalar value into its JavaScript form. */
function scalarValue(raw, lineNumber) {
  const value = stripComment(raw).trim()
  if (value === '') return null
  if (value.startsWith('!!js')) {
    const expression = value.slice(4).trim()
    if (expression === '') throw new CompositionError(`line ${String(lineNumber)}: !!js requires an expression`)
    // The expression is a plain scalar, NOT a quoted one: unquote() would eat
    // its first character. Only strip quotes when it is actually quoted.
    const body = expression.startsWith('"') || expression.startsWith("'")
      ? unquote(expression)
      : expression
    return { __jsExpr: body }
  }
  if (value.startsWith('"') || value.startsWith("'")) {
    const end = closingQuote(value)
    if (end === -1) throw new CompositionError(`line ${String(lineNumber)}: unterminated quoted scalar`)
    const tail = value.slice(end + 1).trim()
    if (tail !== '') throw new CompositionError(`line ${String(lineNumber)}: unexpected content after a quoted scalar: ${tail}`)
    return unquote(value.slice(0, end + 1))
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new CompositionError(`line ${String(lineNumber)}: a flow sequence must be closed on its own line`)
    const body = value.slice(1, -1)
    if (body.includes('{')) throw new CompositionError(`line ${String(lineNumber)}: nested flow collections are not supported`)
    return splitFlow(body).map(part => scalarValue(part, lineNumber))
  }
  if (value.startsWith('{')) {
    throw new CompositionError(`line ${String(lineNumber)}: flow mappings are not supported`)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (INTEGER_RE.test(value)) return Number.parseInt(value, 10)
  if (FLOAT_RE.test(value)) return Number.parseFloat(value)
  if (value.startsWith('&') || value.startsWith('*')) {
    throw new CompositionError(`line ${String(lineNumber)}: anchors and aliases are not supported`)
  }
  if (value.startsWith('!')) throw new CompositionError(`line ${String(lineNumber)}: unsupported YAML tag: ${value}`)
  return value
}

/** Read one literal (`|`) or folded (`>`) block scalar, consuming its lines. */
function blockScalar(cursor, parentIndent, header, lineNumber) {
  const style = header[0]
  const indicators = header.slice(1).replace(/#.*$/, '').trim()
  let explicitIndent
  let chomp = 'clip'
  for (const char of indicators) {
    if (char === '-') chomp = 'strip'
    else if (char === '+') chomp = 'keep'
    else if (/[1-9]/.test(char)) explicitIndent = parentIndent + Number(char)
  }
  const collected = []
  let contentIndent = explicitIndent
  while (cursor.index < cursor.lines.length) {
    const line = cursor.lines[cursor.index] ?? ''
    if (line.trim() === '') { collected.push(''); cursor.index += 1; continue }
    const indent = indentOf(line)
    if (indent <= parentIndent) break
    if (contentIndent === undefined) contentIndent = indent
    if (indent < contentIndent) break
    collected.push(line.slice(contentIndent))
    cursor.index += 1
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
  if (collected.length === 0) return chomp === 'keep' ? '\n' : ''
  const text = style === '|' ? collected.join('\n') : collected.join(' ').replace(/\s+/g, ' ').trim()
  return chomp === 'strip' ? text : `${text}\n`
}

/**
 * Parse a mapping or sequence body at `indent`, appending to the cursor.
 * @param cursor - line cursor.
 * @param indent - the indentation this body starts at.
 * @returns the parsed node.
 */
function parseBlock(cursor, indent) {
  skipInsignificant(cursor)
  const first = cursor.lines[cursor.index]
  if (first === undefined) return null
  return isSequenceEntry(first, indent) ? parseSequence(cursor, indent) : parseMapping(cursor, indent)
}

/** Parse a block sequence at `indent`. */
function parseSequence(cursor, indent) {
  const items = []
  while (cursor.index < cursor.lines.length) {
    skipInsignificant(cursor)
    const line = cursor.lines[cursor.index]
    if (line === undefined) break
    if (significantIndent(line, cursor.index + 1) !== indent || !isSequenceEntry(line, indent)) break
    const lineNumber = cursor.index + 1
    const rest = line.slice(indent + 1)
    cursor.index += 1

    if (rest.trim() === '') {
      // A bare dash: the item is the block that follows, at any deeper indent.
      skipInsignificant(cursor)
      const next = cursor.lines[cursor.index]
      if (next === undefined) { items.push(null); continue }
      const nextIndent = significantIndent(next, cursor.index + 1)
      items.push(nextIndent > indent ? parseBlock(cursor, nextIndent) : null)
      continue
    }

    // `- key: value` opens a mapping whose first key sits on the dash line.
    const trimmed = stripComment(rest).trim()
    if (isMappingLine(trimmed)) {
      const entryIndent = indent + 1 + (/^ */.exec(rest)?.[0].length ?? 0)
      items.push(parseMappingEntry(cursor, entryIndent, trimmed, lineNumber, rest, indent))
      continue
    }

    items.push(scalarValue(rest, lineNumber))
  }
  return items
}

/** Whether a line reads as `key:` or `key: value` (not a quoted scalar). */
function isMappingLine(trimmed) {
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return false
  return /^[^:#]+:(\s|$)/.test(trimmed)
}

/**
 * Parse a mapping that opens on a sequence-entry line (`- key: value`) and
 * continues on the following lines at `entryIndent`.
 *
 * The first pair is taken from `firstLine` text; the rest are read from the
 * cursor exactly like a normal block mapping. Keeping this separate from
 * {@link parseMapping} avoids the rewind-and-restore dance that made the
 * cursor non-monotonic.
 */
function parseMappingEntry(cursor, entryIndent, firstTrimmed, lineNumber, rawRest, seqIndent) {
  const map = {}
  const consume = (content, atLine) => {
    const match = /^([^:]+):(?:\s+(.*))?$/.exec(content)
    if (match === null) throw new CompositionError(`line ${String(atLine)}: expected "key: value"`)
    const key = match[1].trim().replace(/^["']|["']$/g, '')
    const inline = match[2]
    if (inline === undefined || inline.trim() === '') {
      skipInsignificant(cursor)
      const next = cursor.lines[cursor.index]
      const nextIndent = next === undefined ? -1 : significantIndent(next, cursor.index + 1)
      // A nested block must indent past the key line, and must not be a
      // sibling sequence entry of the OUTER sequence.
      const opensBlock = nextIndent > entryIndent || (nextIndent === seqIndent && isSequenceEntry(next ?? '', seqIndent))
      map[key] = opensBlock ? parseBlock(cursor, nextIndent) : null
      return
    }
    const header = inline.trim()
    if (header === '|' || header === '>' || /^[|>][-+]?\d*/.test(header)) {
      map[key] = blockScalar(cursor, entryIndent, header, atLine)
      return
    }
    map[key] = scalarValue(inline, atLine)
  }

  consume(firstTrimmed, lineNumber)

  while (cursor.index < cursor.lines.length) {
    skipInsignificant(cursor)
    const line = cursor.lines[cursor.index]
    if (line === undefined) break
    const lineIndent = significantIndent(line, cursor.index + 1)
    if (lineIndent !== entryIndent) break
    if (isSequenceEntry(line, lineIndent)) break
    const content = stripComment(line.slice(entryIndent)).trimEnd()
    cursor.index += 1
    consume(content, cursor.index)
  }
  return map
}

/** Parse a block mapping at `indent`. */
function parseMapping(cursor, indent) {
  const map = {}
  while (cursor.index < cursor.lines.length) {
    skipInsignificant(cursor)
    const line = cursor.lines[cursor.index]
    if (line === undefined) break
    if (significantIndent(line, cursor.index + 1) !== indent) break
    if (isSequenceEntry(line, indent)) break
    const lineNumber = cursor.index + 1
    const content = stripComment(line.slice(indent)).trimEnd()
    const match = /^([^:]+):(?:\s+(.*))?$/.exec(content)
    if (match === null) throw new CompositionError(`line ${String(lineNumber)}: expected "key: value"`)
    const key = match[1].trim().replace(/^["']|["']$/g, '')
    const inline = match[2]
    cursor.index += 1
    if (inline === undefined || inline.trim() === '') {
      // A block value: sequence, mapping, or nothing.
      skipInsignificant(cursor)
      const next = cursor.lines[cursor.index]
      const nextIndent = next === undefined ? -1 : significantIndent(next, cursor.index + 1)
      map[key] = nextIndent > indent ? parseBlock(cursor, nextIndent) : null
      continue
    }
    const header = inline.trim()
    if (header === '|' || header === '>' || /^[|>][-+]?\d*/.test(header)) {
      map[key] = blockScalar(cursor, indent, header, lineNumber)
      continue
    }
    map[key] = scalarValue(inline, lineNumber)
  }
  return map
}

/** Parse one cordis composition document. */
export function readCordisYaml(text) {
  if (text.includes('\t')) {
    const idx = text.split(/\r?\n/).findIndex(line => /^[ \t]*\t/.test(line))
    if (idx !== -1) throw new CompositionError(`line ${String(idx + 1)}: tabs must not be used for indentation`)
  }
  if (/^---/m.test(text) && text.split(/^---\s*$/m).length > 2) {
    throw new CompositionError('multiple YAML documents are not supported')
  }
  const lines = text.split(/\r?\n/)
  const cursor = { lines, index: 0 }
  // Skip a leading document marker.
  if ((lines[0] ?? '').trim() === '---') cursor.index = 1
  return parseBlock(cursor, 0)
}

/** Convert a parsed `!!js` marker into the Loader's expression shape. */
function toLoaderValue(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.__jsExpr === 'string') {
    return value
  }
  return value
}

/** Recursively absolutize relative row names and normalize `!!js` markers. */
function absolutize(value, baseDir, label) {
  if (Array.isArray(value)) return value.map((item, index) => absolutize(item, baseDir, `${label}[${String(index)}]`))
  if (value === null || typeof value !== 'object') return toLoaderValue(value)
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    out[key] = absolutize(raw, baseDir, `${label}.${key}`)
  }
  if (typeof out.name === 'string' && out.name.startsWith('./')) {
    out.name = pathToFileURL(join(baseDir, out.name.slice(2))).href
  }
  return out
}

/**
 * Read the child plugin rows of one `agent.cordis.yml`.
 * @param text - the raw composition document.
 * @param baseDir - directory a relative row `name` resolves against.
 * @returns the row list to hand the registry.
 */
export function readCompositionRows(text, baseDir) {
  const value = readCordisYaml(text)
  if (!Array.isArray(value)) {
    throw new CompositionError(`${COMPOSITION_FILE} must be a top-level list of plugin rows`)
  }
  return absolutize(value, baseDir, 'composition')
}

/** Read and validate the display metadata. */
export function readPresetMetadata(text) {
  const value = readCordisYaml(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompositionError(`${METADATA_FILE} must be a mapping`)
  }
  if (typeof value.name !== 'string' || value.name === '') {
    throw new CompositionError(`${METADATA_FILE} requires a non-empty name`)
  }
  if (value.order !== undefined && !Number.isInteger(value.order)) {
    throw new CompositionError(`${METADATA_FILE} order must be an integer`)
  }
  return value
}

/** Build the registry definition of one preset directory. */
export function readPresetDefinition(id, dir) {
  const read = name => {
    try {
      return readFileSync(join(dir, name), 'utf8')
    } catch (error) {
      throw new CompositionError(`${name} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    id,
    ...readPresetMetadata(read(METADATA_FILE)),
    plugins: readCompositionRows(read(COMPOSITION_FILE), dir),
  }
}
