/**
 * working-context — the Baize preset's minimal recency projection: one durable
 * user message carrying a single `[Working Context: ...]` line of the
 * session's objective, machine-readable state, refreshed only when it changes.
 *
 * Every field is folded from the durable session event stream, so the line
 * survives resume, reload and compaction without any process-memory state, and
 * every field is omitted when the log has nothing objective to say:
 *
 * - `plan mode: on|off` — from the session's `plan/mode` events (last one
 *   wins). Omitted entirely when the log holds no such event, because the
 *   ambient default is off.
 * - `active namespaces: ...` — paged namespaces currently on the wire, replayed
 *   from `tool_activate` calls. With paging off (this preset's default) the
 *   field never appears.
 * - `in progress: ...` — in-progress todo titles from the latest `todo/write`,
 *   cleared by the next `turn/start`.
 * - `key facts: ...` — the pinned register (see fact-ledger.mjs).
 *
 * Injection discipline: the message is persistent, and a replacement is
 * published only when the rendered line actually changed — so an unchanged
 * context costs the prefix cache nothing.
 */

import {
  DEFAULT_MAX_ACTIVE_NAMESPACES,
  DEFAULT_PAGED_TOOL_PATTERNS,
  integerAtLeast,
  replayActivations,
  sessionEvents,
  validatePagedToolPatterns,
} from './paging.mjs'

import { foldFactLedger, renderLedgerField } from './fact-ledger.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'baize-working-context'

/** Cap one rendered todo title so the line stays a single glance. */
const MAX_TITLE_CHARS = 80

/** At most this many in-progress titles render; the rest collapse to a count. */
const MAX_TITLES = 3

/** The latest plan/mode state in the log: seen flag plus active value. */
export function planModeState(events) {
  let seen = false
  let active = false
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'plan/mode' || typeof event.data?.active !== 'boolean') continue
    seen = true
    active = event.data.active
  }
  return { seen, active }
}

/**
 * The in-progress todo titles as the host's todos projection folds them: the
 * latest todo/write list, cleared by the next turn/start.
 */
export function inProgressTodos(events) {
  let todos
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'turn/start') { todos = undefined; continue }
    if (event?.type === 'todo/write' && Array.isArray(event.data?.todos)) todos = event.data.todos
  }
  return (todos ?? [])
    .filter(item => item?.status === 'in_progress' && typeof item?.content === 'string' && item.content.trim() !== '')
    .map(item => item.content.trim())
}

/** Clip one title to the per-title budget. */
function clipTitle(title) {
  if (title.length <= MAX_TITLE_CHARS) return title
  return `${title.slice(0, MAX_TITLE_CHARS - 3)}...`
}

/**
 * Render the working-context line, or undefined when nothing objective is
 * known. Field order is stable so an unchanged session renders an identical
 * string (which is what keeps the message republish-free).
 */
export function renderWorkingContext(events, options = {}) {
  const fields = []
  const plan = planModeState(events)
  if (plan.seen) fields.push(`plan mode: ${plan.active ? 'on' : 'off'}`)

  const patterns = options.pagedToolPatterns ?? DEFAULT_PAGED_TOOL_PATTERNS
  if (patterns.length > 0) {
    const maxActive = options.maxActiveNamespaces ?? DEFAULT_MAX_ACTIVE_NAMESPACES
    const { active } = replayActivations(events, maxActive, patterns)
    if (active.length > 0) fields.push(`active namespaces: ${active.join(', ')}`)
  }

  const titles = inProgressTodos(events)
  if (titles.length > 0) {
    const shown = titles.slice(0, MAX_TITLES).map(clipTitle)
    const extra = titles.length - shown.length
    fields.push(`in progress: ${shown.join(' | ')}${extra > 0 ? ` (+${extra} more)` : ''}`)
  }

  const ledger = renderLedgerField(foldFactLedger(events))
  if (ledger !== undefined) fields.push(ledger)

  if (fields.length === 0) return undefined
  return `[Working Context: ${fields.join(' | ')}]`
}

/** Build the durable message carrying one rendered line. */
function createContextMessage(line, source) {
  return {
    role: 'user',
    content: [{ type: 'text', text: line }],
    source,
  }
}

/** The text of a candidate message, or undefined. */
function textOf(message) {
  const part = Array.isArray(message?.content) ? message.content[0] : undefined
  return typeof part?.text === 'string' ? part.text : undefined
}

/**
 * Mount the plugin: fold the line on every pre-step and publish it as one
 * durable user message, replacing (never duplicating) the previous copy.
 */
export function apply(ctx, config = {}) {
  const patterns = validatePagedToolPatterns(name, config.pagedToolPatterns)
  const maxActive = integerAtLeast(name, config.maxActiveNamespaces, 'maxActiveNamespaces', 1, DEFAULT_MAX_ACTIVE_NAMESPACES)
  const source = { plugin: name }
  const messageId = `${name}:context`

  ctx.on('agent/pre-step', (decision, session) => {
    const events = sessionEvents(session)
    const line = renderWorkingContext(events, { pagedToolPatterns: patterns, maxActiveNamespaces: maxActive })
    const messages = Array.isArray(decision?.messages) ? decision.messages : []
    const existing = messages.find(message => message?.source?.plugin === name || message?.id === messageId)

    // Nothing to say and nothing published: leave the step untouched.
    if (line === undefined) {
      if (existing === undefined) return decision
      return { ...decision, messages: messages.filter(message => message !== existing) }
    }
    // Already published verbatim: no republish, so the prefix cache is intact.
    if (existing !== undefined && textOf(existing) === line) return decision

    const message = { ...createContextMessage(line, source), id: messageId }
    if (existing === undefined) return { ...decision, messages: [...messages, message] }
    return { ...decision, messages: messages.map(item => (item === existing ? message : item)) }
  }, { prepend: true })
}
