/**
 * tool-catalog — the Baize preset's tool-surface declaration.
 *
 * The Baize preset's whole system prompt is one persona block, so the
 * capability facts the Standard prompt would carry as tool-guidance prose have
 * nowhere to live. They arrive instead as one durable tool-catalog message,
 * appended after the user's own message the way the skill catalog is injected:
 * exactly the tools the current request's wire carries (argument signature plus
 * a one-line summary), so the declared surface and the request's own wire can
 * never disagree.
 *
 * PRESENTATION: `presentation` picks how this session's tools sit on the wire.
 *   - `native` (BAIZE DEFAULT): the assembled roster stays on the wire, so the
 *     model reads each tool's name, parameters and description directly. This is
 *     the surface the shipped `standard` preset uses.
 *   - `both`: the native roster AND the `run_code` transport co-resident —
 *     native calls carry ordinary work, `run_code` covers programmatic batch
 *     computation and wide fan-out.
 *   - `ptc`: the wire collapses to the single `run_code` transport. This is what
 *     LiangShen ships by default.
 *
 * WHY `native` IS THE DEFAULT, STATED HONESTLY: an earlier revision of this
 * comment claimed "the official scaffold comparison ranks this surface ABOVE the
 * collapsed one on both code-agent benchmarks", and cited DeepSWE and
 * Terminal-Bench numbers. That claim was NOT verifiable — a full scan of the
 * shipped harness finds no PTC-versus-native comparison anywhere, and the
 * benchmarks themselves are third-party. The numbers are therefore withdrawn.
 *
 * The real, checkable grounds for defaulting to `native` are narrower:
 *   1. Presentation is a STATIC-context tradeoff, not a measured capability
 *      difference, and LiangShen's own comments already concede that.
 *   2. `ptc` requires a `run_code` transport, which drags the generated tool SDK
 *      signatures into the system prompt — in LiangShen that is ~36,000 of its
 *      ~39,500 prompt characters, paid on every request.
 *   3. `native` keeps the ordinary working set visible without that dependency.
 *   4. Operators who want the collapsed surface can set `presentation: ptc`;
 *      the option stays available.
 *
 * Do not restate a benchmark number here without naming a source that can be
 * checked.
 *
 * The declaration lands once per agent scope through the public
 * `agent.ctx.tools.presentAs(mode)`, and degrades to the native surface with a
 * one-time warning when the deployment has no code runtime or the host
 * declines — never leaving the session with a transport it cannot carry.
 *
 * PAGING: `pagedToolPatterns` (BAIZE DEFAULT `[]` — off) withholds matching
 * families from the wire until the preset's own `tool_activate` tool loads
 * their namespace; at most `maxActiveNamespaces` stay resident, LRU evicting
 * the oldest. Paging is enforced twice — the assembled list loses the family
 * AND the agent scope is restricted — because under `ptc` the wire has already
 * collapsed and a wire-only filter would withhold nothing the model can reach.
 */

import {
  DEFAULT_MAX_ACTIVE_NAMESPACES,
  DEFAULT_PAGED_TOOL_PATTERNS,
  integerAtLeast,
  isPaged,
  namespaceOf,
  replayActivations,
  sessionEvents,
  validatePagedToolPatterns,
} from './paging.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'kunlun-tool-catalog'

/** The systemPrompt service must exist before the catalog can re-assemble. */
export const inject = ['systemPrompt']

/** Default cap for one tool's one-line summary in the injected compact list. */
export const DEFAULT_DESCRIPTION_MAX_LENGTH = 200

/** The presentation modes the SDK's ToolPresentationMode supports. */
export const PRESENTATION_MODES = ['native', 'ptc', 'both']

/**
 * The Baize default: keep the assembled roster on the wire. Deliberately NOT
 * LiangShen's `ptc`, because the official comparison ranks the collapsed
 * presentation below the native one on both code-agent benchmarks.
 */
export const DEFAULT_PRESENTATION = 'native'

/** The durable message id so replacements never duplicate. */
const CATALOG_MESSAGE_ID = `${name}:catalog`

/** Build a one-shot warner so a degraded path speaks exactly once. */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (key, detail) => {
    if (seen.has(key)) return
    seen.add(key)
    ctx.logger?.warn?.(`${name}: ${detail}`)
  }
}

/** Resolve and validate the presentation config. */
export function resolvePresentation(config, warn) {
  const explicit = config?.presentation
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !PRESENTATION_MODES.includes(explicit)) {
      throw new TypeError(`${name}: presentation must be one of ${JSON.stringify(PRESENTATION_MODES)}`)
    }
    return explicit
  }
  if (config?.ptcPresentation !== undefined) {
    warn('ptcPresentation', 'the ptcPresentation key is deprecated — presentation takes precedence')
    return config.ptcPresentation ? 'ptc' : 'native'
  }
  return DEFAULT_PRESENTATION
}

/** A compact argument signature for one tool schema. */
function signatureOf(schema) {
  const params = schema?.parameters
  if (params === null || typeof params !== 'object') return '()'
  const required = new Set(Array.isArray(params.required) ? params.required : [])
  const keys = Object.keys(params.properties ?? {})
  if (keys.length === 0) return '()'
  const shown = keys.slice(0, 12).map(key => (required.has(key) ? key : `${key}?`))
  return `(${shown.join(', ')}${keys.length > shown.length ? ', ...' : ''})`
}

/** One-line summary of a tool's description, clipped. */
function summaryOf(schema, maxLength) {
  const raw = typeof schema?.description === 'string' ? schema.description : ''
  const line = raw.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  if (line.length <= maxLength) return line
  return `${line.slice(0, Math.max(0, maxLength - 3))}...`
}

/**
 * Render the catalog text: the on-wire tool list plus any paged-out namespace
 * summaries, plus the presentation contract when a `run_code` transport is in
 * play.
 */
export function renderCatalogText(entries, presentation = DEFAULT_PRESENTATION, inactive = [], maxLength = DEFAULT_DESCRIPTION_MAX_LENGTH) {
  const lines = [
    'Tool catalog for this request. These are the tools currently on your wire — call them directly by name:',
  ]
  if (entries.length === 0) {
    lines.push('- (none)')
  } else {
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const summary = summaryOf(entry, maxLength)
      lines.push(`- \`${entry.name}\`${signatureOf(entry)}${summary === '' ? '' : ` — ${summary}`}`)
    }
  }

  if (inactive.length > 0) {
    lines.push('')
    lines.push('Paged out (activate with `tool_activate({ namespace })` before use):')
    for (const entry of inactive) {
      lines.push(`- \`${entry.namespace}\` — ${entry.count} tool${entry.count === 1 ? '' : 's'} withheld until activated`)
    }
  }

  if (presentation === 'ptc') {
    lines.push('')
    lines.push('This session presents tools through the `run_code` transport: reach any tool above as `await tools.<name>({ ... })` inside an async TypeScript body (`code`, with a short `description`).')
  } else if (presentation === 'both') {
    lines.push('')
    lines.push('Both surfaces are live. Prefer calling tools directly by name: ordinary single-step work goes through the native call. Reserve `run_code` for what a direct call cannot do — programmatic batch computation, wide fan-out, or multi-step data shaping. Inside `run_code`, reach tools as `await tools.<name>({ ... })` and overlap independent read-only calls under `Promise.all`.')
  }

  return lines.join('\n')
}

/** Build the durable catalog message. */
export function createCatalogMessage(entries, presentation, inactive, maxLength) {
  return {
    role: 'user',
    content: [{ type: 'text', text: renderCatalogText(entries, presentation, inactive, maxLength) }],
    // The v4 session format requires a PRODUCER-OWNED `kind` here.
    //
    // THIS LINE WAS A DATA-LOSS BUG. It used to read `source: { plugin: name }`,
    // which is the v3 shape: a `plugin` field and no `kind`. v4 validation rejects
    // any message whose source kind is not producer-owned, and it rejects the WHOLE
    // session, not just the message:
    //
    //     SessionFormatError: format v4 message requires a producer-owned source kind
    //     -> 历史加载失败: stored session "..." is corrupt
    //
    // Because this module injects a message on every turn, every session that ran
    // under the preset became unloadable after a restart — the conversation could
    // not be reopened and its history disappeared from the list. The preset still
    // WORKED, which is why it went unnoticed: only the stored history was destroyed,
    // and only after the app restarted.
    //
    // `kind: name` is the shape the harness's own injected messages use — the
    // system prompt writes {"kind":"system-prompt"}, runtime context writes
    // {"kind":"runtime-context"}, the skill catalog writes {"kind":"skill-catalog"}.
    // A reference preset's equivalent module writes {"kind":"<name>-tool-catalog"}.
    // The bare name is correct; `{"kind":"plugin", plugin: name}` is the migration
    // form for legacy records and appears in zero healthy sessions.
    source: { kind: name },
    id: CATALOG_MESSAGE_ID,
  }
}

/** Read the visible tool schemas for one agent through the public API. */
function visibleSchemas(tools, agent, presentation) {
  const readers = presentation === 'native' ? ['schemas', 'sdkSchemas'] : ['sdkSchemas', 'schemas']
  for (const reader of readers) {
    if (typeof tools?.[reader] !== 'function') continue
    try {
      const schemas = tools[reader](agent)
      if (Array.isArray(schemas)) return schemas
    } catch {
      // A reader that refuses this scope is not fatal: try the next.
    }
  }
  return []
}

/** Mount the plugin. */
export function apply(ctx, config = {}) {
  const warn = warnOnceFactory(ctx)
  const presentation = resolvePresentation(config, detail => warn('presentation', detail))
  const patterns = validatePagedToolPatterns(name, config.pagedToolPatterns)
  const maxActive = integerAtLeast(name, config.maxActiveNamespaces, 'maxActiveNamespaces', 1, DEFAULT_MAX_ACTIVE_NAMESPACES)
  const maxLength = integerAtLeast(name, config.descriptionMaxLength, 'descriptionMaxLength', 0, DEFAULT_DESCRIPTION_MAX_LENGTH)

  const registry = () => ctx.get('tools')
  const declared = new WeakSet()

  /** Declare this scope's presentation through the public API. */
  const declarePresentation = agent => {
    const tools = agent?.ctx?.tools
    if (tools === undefined || typeof tools.presentAs !== 'function') {
      warn('runtime', 'no scoped tools view to declare the presentation through — keeping the native tool surface')
      return undefined
    }
    if (declared.has(tools)) return undefined
    declared.add(tools)
    try {
      const disposer = tools.presentAs(presentation)
      return typeof disposer === 'function' ? disposer : undefined
    } catch (error) {
      warn('runtime', `the "${presentation}" presentation was declined: ${error instanceof Error ? error.message : String(error)} — keeping the native tool surface`)
      return undefined
    }
  }

  /** Page the scope: remove withheld families from the reachable surface too. */
  const pageScope = (agent, withheld) => {
    if (withheld.length === 0) return undefined
    const tools = agent?.ctx?.tools
    if (tools === undefined || typeof tools.restrict !== 'function') return undefined
    try {
      const dispose = tools.restrict({ deny: withheld })
      return typeof dispose === 'function' ? dispose : undefined
    } catch (error) {
      warn('restrict', `could not restrict the scope to the paged surface: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  ctx.on('agent/pre-step', (decision, session) => {
    const agent = session?.agent ?? session
    declarePresentation(agent)

    const tools = registry()
    if (tools === undefined) return decision

    const schemas = visibleSchemas(tools, agent, presentation)
    if (schemas.length === 0) return decision

    // Partition the visible surface into the on-wire entries and the paged-out
    // namespaces, then restrict the scope so both halves agree.
    const entries = []
    const inactiveCounts = new Map()
    const withheld = []
    for (const schema of schemas) {
      const toolName = schema?.name
      if (typeof toolName !== 'string' || toolName === '') continue
      if (patterns.length > 0 && isPaged(toolName, patterns)) {
        withheld.push(toolName)
        const ns = namespaceOf(toolName, patterns) ?? toolName
        inactiveCounts.set(ns, (inactiveCounts.get(ns) ?? 0) + 1)
        continue
      }
      entries.push(schema)
    }
    pageScope(agent, withheld)

    // Honour the activation ledger: an activated namespace moves back in.
    const { active: activeList } = replayActivations(sessionEvents(session), maxActive, patterns)
    const activeNamespaces = new Set(activeList)

    // Namespace summaries exclude the ones already activated (they are on the
    // wire via their own tools, which the restriction above already released).
    const inactive = [...inactiveCounts.entries()]
      .filter(([ns]) => !activeNamespaces.has(ns))
      .map(([namespace, count]) => ({ namespace, count }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace))

    const message = createCatalogMessage(entries, presentation, inactive, maxLength)
    const messages = Array.isArray(decision?.messages) ? decision.messages : []
    // Match our own previous message by id OR by the current `kind`. The id check
    // alone is not enough across a format change, and the old `source.plugin` check
    // would no longer recognise a message written under the corrected shape.
    const existing = messages.find(item => item?.id === CATALOG_MESSAGE_ID || item?.source?.kind === name)
    const text = message.content[0].text
    if (existing !== undefined) {
      const current = Array.isArray(existing.content) ? existing.content[0]?.text : undefined
      if (current === text) return decision
      return { ...decision, messages: messages.map(item => (item === existing ? message : item)) }
    }
    return { ...decision, messages: [...messages, message] }
  }, { prepend: true })
}
