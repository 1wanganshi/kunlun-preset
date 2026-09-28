/**
 * paging — the Baize preset's shared paging vocabulary.
 *
 * Kept deliberately tiny and dependency-free: `working-context` and
 * `tool-catalog` both need to agree on what "a paged namespace" means, and the
 * activation state must replay identically from the durable event stream in
 * both, or the projected line and the actual wire would disagree.
 *
 * Paging is OFF by default in this preset (see agent.cordis.yml). It is a
 * capability loss dressed as a token saving until a deployment actually mounts
 * high-fan-out tool families, so it is opt-in per operator.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'baize-paging'

/** Matcher families withheld from the wire until activated. Empty by default. */
export const DEFAULT_PAGED_TOOL_PATTERNS = []

/** How many activated namespaces stay resident before LRU eviction. */
export const DEFAULT_MAX_ACTIVE_NAMESPACES = 3

/** The tool the model calls to bring one paged namespace back. */
export const TOOL_ACTIVATE = 'tool_activate'

/**
 * Validate a positive-integer config value, or fall back when absent.
 * Mirrors the upstream helper so both plugins reject the same bad input the
 * same way.
 */
export function integerAtLeast(pluginName, value, field, minimum, fallback) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${pluginName}: ${field} must be an integer >= ${minimum}`)
  }
  return value
}

/**
 * Validate one glob pattern list. Patterns are intentionally simple: a literal
 * prefix ending in `*` (for example `mcp__*`), which is all the upstream
 * paging contract ever promised.
 */
export function validatePagedToolPatterns(pluginName, value) {
  // `null` is what a YAML mapping yields for a key written with no value —
  // `pagedToolPatterns:` alone. The intent there is always "none", so treat it
  // as the empty list the DEFAULT describes rather than throwing. An operator
  // writing the key at all is asking for paging to be OFF, not for a crash.
  if (value === undefined || value === null) return DEFAULT_PAGED_TOOL_PATTERNS
  if (!Array.isArray(value)) {
    throw new TypeError(`${pluginName}: pagedToolPatterns must be an array of strings`)
  }
  for (const pattern of value) {
    if (typeof pattern !== 'string' || pattern === '') {
      throw new TypeError(`${pluginName}: every pagedToolPatterns entry must be a non-empty string`)
    }
  }
  return value
}

/** Whether a tool name matches any paged pattern. */
export function isPaged(toolName, patterns) {
  if (typeof toolName !== 'string') return false
  for (const pattern of patterns ?? []) {
    if (pattern.endsWith('*')) {
      if (toolName.startsWith(pattern.slice(0, -1))) return true
      continue
    }
    if (toolName === pattern) return true
  }
  return false
}

/**
 * The namespace one tool name belongs to under the paged patterns: the literal
 * prefix of the first matching pattern, without the trailing `*`. Returns
 * undefined for an unpaged tool.
 */
export function namespaceOf(toolName, patterns) {
  if (typeof toolName !== 'string') return undefined
  for (const pattern of patterns ?? []) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1)
      if (toolName.startsWith(prefix)) return prefix
      continue
    }
    if (toolName === pattern) return pattern
  }
  return undefined
}

/** Session events, tolerating both snapshotEvents() and an events array. */
export function sessionEvents(session) {
  if (Array.isArray(session?.events)) return session.events
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
  return []
}

/** Parse a tool call's arguments, tolerating a JSON string or an object. */
export function parseArguments(args) {
  if (typeof args === 'string') {
    try { return JSON.parse(args) } catch { return undefined }
  }
  if (args !== null && typeof args === 'object') return args
  return undefined
}

/**
 * Replay the active namespace set from the durable event stream: every
 * successful `tool_activate` call appends its namespace, and the set is capped
 * with least-recently-activated eviction. Replaying (rather than holding
 * process memory) is what makes activate state survive resume and compaction
 * identically.
 *
 * @returns the active namespaces in activation order (oldest first).
 */
export function replayActivations(events, maxActive, patterns) {
  const order = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'tool/call') continue
    if (event.data?.name !== TOOL_ACTIVATE) continue
    const args = parseArguments(event.data?.arguments)
    const namespace = typeof args?.namespace === 'string' ? args.namespace.trim() : ''
    if (namespace === '') continue
    // Accept the namespace when it corresponds to a paged family: the model may
    // name either the literal prefix (`mcp__`) or any namespace under it
    // (`mcp__github__`). The check must run pattern -> namespace, never the
    // reverse, or a longer namespace would be rejected by its own family.
    const known = (patterns ?? []).some(pattern => {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1)
        return namespace === prefix || namespace.startsWith(prefix)
      }
      return namespace === pattern
    })
    if (!known) continue
    const existing = order.indexOf(namespace)
    if (existing !== -1) order.splice(existing, 1)
    order.push(namespace)
    while (order.length > maxActive) order.shift()
  }
  return { active: order }
}
