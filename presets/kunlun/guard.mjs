/**
 * guard — the Baize preset's runtime degeneration circuit breaker.
 *
 * WHY AN OUTSIDE FORCE IS NEEDED: a model-side generation degeneration exists
 * under very long context and max reasoning effort where the agent emits turn
 * after turn of zero-output self-urging reasoning with no tool call and no
 * automatic fuse, and the run has to be killed by hand. The persona's own
 * reflection-fuse discipline cannot stop it, because in that state the
 * discipline text itself has fallen out of the effective context. The only
 * force that works is an outside one.
 *
 * TWO SIGNALS, both folded from the durable session event stream (never from
 * process memory, so resume and compaction rebuild the same verdict):
 *
 * - STALL: consecutive assistant steps carrying reasoning but neither a tool
 *   call nor visible reply text. The reasoning TEXT is never read (impossible
 *   on routes that redact it); its character count is the objective measure.
 * - ECHO: the same tool called with the same arguments failing repeatedly with
 *   no success in between — the closed loop of repeating one broken call.
 *
 * ON FIRING, once per episode:
 *  1. a circuit-breaker user message is injected at the next pre-step — the
 *     one channel guaranteed to reach the model;
 *  2. a temporary reasoning-effort step-down rides the `agent/request`
 *     waterfall for the next few requests (max -> high -> low; anything else
 *     is left alone). This is the ONLY moment this plugin rewrites a request:
 *     with no signal it never touches one, so prefix-cache stability and the
 *     user's explicit model-selector effort stay untouched.
 *
 * ── WHAT BAIZE CHANGES FROM THE LIANGSHEN GUARD ─────────────────────────────
 *
 * The upstream guard fires its per-step ladder on ONE output-free step with a
 * per-step floor as low as 8000 chars at max effort, and its own comments
 * defend that as "hair-trigger". The cost is asymmetric in the direction that
 * hurts: a false interruption of genuine long reasoning destroys work in
 * progress and can derail a correct solution, while a missed episode costs one
 * more step before the slow-burn ladder (which is genuinely conservative)
 * catches it anyway. Baize therefore:
 *
 * 1. requires TWO consecutive qualifying steps on the per-step ladder
 *    (STALL_STEPS = 2) instead of one, keeping the slow-burn ladder as the
 *    real detector;
 * 2. raises the per-step floors (max 16000, high 20000, low 28000) so only a
 *    step that is individually enormous AND output-free counts;
 * 3. re-arms on any real progress (a tool call or visible text), so a genuine
 *    long think followed by a normal action resets the ladder rather than
 *    accumulating toward a trip;
 * 4. keeps the fire-once-per-episode discipline and the refire cooldown, so
 *    the breaker can never become its own pathology by spamming notices.
 *
 * Recovery: once the step-down window has run its requests, the route's own
 * effort resumes unchanged.
 */

import { parseArguments, sessionEvents } from './paging.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'kunlun-guard'

/**
 * Consecutive qualifying steps the per-step ladder requires. TWO, not one:
 * see the header note on asymmetric cost. A single huge output-free step is
 * suspicious but not yet a loop; the slow-burn ladder covers the sequence.
 */
export const DEFAULT_STALL_STEPS = 2

/**
 * The per-step reasoning-character floor for a step to count as "long", keyed
 * by the request's CURRENT reasoning effort. Max effort produces the longest
 * trajectories and is where every documented runaway happened, so its floor is
 * the lowest — but still far beyond any healthy single step (16000 chars is
 * roughly 4-8K thinking tokens), so the ladder cannot trip on ordinary depth.
 */
export const STALL_REASONING_CHARS_BY_EFFORT = {
  max: 16000,
  high: 20000,
  low: 28000,
}

/** Floor for unknown effort levels (numeric efforts, off). */
export const DEFAULT_STALL_REASONING_CHARS = 20000

/** How many identical-argument failures in a row constitute an echo loop. */
export const DEFAULT_ECHO_FAILURES = 3

/**
 * Steps with at least this much reasoning count toward the global (slow-burn)
 * stall ladder. Deliberately low: the ladder exists to catch the loop of many
 * individually-plausible-but-output-free steps, so any step that really
 * thought must count, while a tool ack or empty turn must not.
 */
export const GLOBAL_MIN_REASONING_CHARS = 200

/** How many consecutive output-free reasoning steps trip the slow-burn ladder. */
export const DEFAULT_GLOBAL_STALL_CAP = 4

/**
 * Sensitivity presets: a whole-scale multiplier over the adaptive thresholds,
 * for operators who fear false interruptions more than missed episodes (or the
 * reverse) without hand-tuning four numbers.
 * - conservative: every floor and cap x 1.5, rounded — fewest interruptions.
 * - balanced: x 1.0, the Baize defaults.
 * - aggressive: every floor x 0.5 and every cap - 1 (floored at the minimums).
 */
export const SENSITIVITY_OPTIONS = ['conservative', 'balanced', 'aggressive']
export const DEFAULT_SENSITIVITY = 'balanced'
const SENSITIVITY_SCALE = { conservative: 1.5, balanced: 1.0, aggressive: 0.5 }

/** Requests the temporary effort step-down stays on after firing. */
export const DEFAULT_STEP_DOWN_REQUESTS = 3

/** Steps the breaker stays quiet after firing once (no message spam). */
export const DEFAULT_REFIRE_COOLDOWN_STEPS = 5

/** The effort ladder a step-down walks along. Anything else is left alone. */
const EFFORT_LADDER = ['max', 'high', 'low']

/** Validate a positive-integer config value, or fall back when absent. */
function integerAtLeast(value, field, minimum, fallback) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name}: ${field} must be an integer >= ${minimum}`)
  }
  return value
}

/** Scale one numeric threshold by the sensitivity preset. */
function scaleFloor(base, sensitivity) {
  const factor = SENSITIVITY_SCALE[sensitivity] ?? 1
  return Math.max(1, Math.round(base * factor))
}

/** Scale one cap by the sensitivity preset (aggressive tightens by 1). */
function scaleCap(base, sensitivity) {
  if (sensitivity === 'conservative') return Math.ceil(base * 1.5)
  if (sensitivity === 'aggressive') return Math.max(1, base - 1)
  return base
}

/** The reasoning-effort value the route reports for one request/step. */
function effortOf(step) {
  const effort = step?.request?.reasoningEffort ?? step?.reasoningEffort ?? step?.request?.effort
  return typeof effort === 'string' ? effort : undefined
}

/** Whether one step produced any visible progress. */
function producedOutput(step) {
  if (Array.isArray(step?.toolCalls) && step.toolCalls.length > 0) return true
  if (Array.isArray(step?.messages)) {
    for (const message of step.messages) {
      if (message?.role !== 'assistant') continue
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') return true
        if (part?.type === 'tool-call' || part?.type === 'tool_use') return true
      }
    }
  }
  return false
}

/** The assistant steps of a session, oldest first. */
function assistantSteps(session) {
  const steps = []
  for (const event of sessionEvents(session)) {
    if (event?.type === 'turn/start') continue
    if (event?.type !== 'step/end' && event?.type !== 'assistant/step') continue
    if (event.data !== undefined) steps.push(event.data)
  }
  return steps
}

/** Reasoning character count of one step, without reading its text. */
function reasoningChars(step) {
  const blocks = step?.reasoning ?? step?.reasoningBlocks
  if (typeof blocks === 'string') return blocks.length
  if (!Array.isArray(blocks)) return 0
  let total = 0
  for (const block of blocks) {
    if (typeof block === 'string') { total += block.length; continue }
    if (typeof block?.text === 'string') total += block.text.length
  }
  return total
}

/** Fold the stall verdict from the step list. */
export function foldStall(steps, thresholds) {
  let consecutive = 0
  let globalConsecutive = 0
  for (const step of steps) {
    const chars = reasoningChars(step)
    if (producedOutput(step)) { consecutive = 0; globalConsecutive = 0; continue }
    const effort = effortOf(step)
    const floor = thresholds.floorByEffort[effort] ?? thresholds.defaultFloor
    if (chars >= floor) consecutive += 1
    if (chars >= GLOBAL_MIN_REASONING_CHARS) globalConsecutive += 1
  }
  return {
    stalled: consecutive >= thresholds.stallSteps || globalConsecutive >= thresholds.globalStallCap,
    consecutive,
    globalConsecutive,
  }
}

/** Fold the echo verdict: identical failing calls with no success between. */
export function foldEcho(events, echoFailures) {
  let signature
  let count = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'tool/result') {
      const failed = event.data?.isError === true || event.data?.ok === false
      const name = event.data?.name
      const args = JSON.stringify(parseArguments(event.data?.arguments) ?? null)
      const next = `${name}\u0000${args}`
      if (failed && next === signature) { count += 1; continue }
      if (failed) { signature = next; count = 1; continue }
      signature = undefined
      count = 0
      continue
    }
    if (event?.type === 'tool/call') {
      const name = event.data?.name
      const args = JSON.stringify(parseArguments(event.data?.arguments) ?? null)
      if (`${name}\u0000${args}` !== signature) { signature = undefined; count = 0 }
    }
  }
  return { echoed: count >= echoFailures, count }
}

/** Mount the plugin. */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const sensitivity = SENSITIVITY_OPTIONS.includes(config.sensitivity) ? config.sensitivity : DEFAULT_SENSITIVITY
  const thresholds = {
    stallSteps: scaleCap(integerAtLeast(config.stallSteps, 'stallSteps', 1, DEFAULT_STALL_STEPS), sensitivity),
    floorByEffort: {
      max: scaleFloor(config.stallReasoningChars ?? STALL_REASONING_CHARS_BY_EFFORT.max, sensitivity),
      high: scaleFloor(Math.round((config.stallReasoningChars ?? STALL_REASONING_CHARS_BY_EFFORT.max) * 1.25), sensitivity),
      low: scaleFloor(Math.round((config.stallReasoningChars ?? STALL_REASONING_CHARS_BY_EFFORT.max) * 1.75), sensitivity),
    },
    defaultFloor: scaleFloor(integerAtLeast(config.stallReasoningChars, 'stallReasoningChars', 1, DEFAULT_STALL_REASONING_CHARS), sensitivity),
    globalStallCap: scaleCap(integerAtLeast(config.globalStallCap, 'globalStallCap', 1, DEFAULT_GLOBAL_STALL_CAP), sensitivity),
  }
  const echoFailures = integerAtLeast(config.echoFailures, 'echoFailures', 2, DEFAULT_ECHO_FAILURES)
  const stepDownRequests = integerAtLeast(config.stepDownRequests, 'stepDownRequests', 0, DEFAULT_STEP_DOWN_REQUESTS)
  const cooldown = integerAtLeast(config.refireCooldownSteps, 'refireCooldownSteps', 0, DEFAULT_REFIRE_COOLDOWN_STEPS)

  const state = new Map() // session id -> { fired, quietUntil, stepDownLeft, lastEffort }

  // The `agent/request` payload is `{ turn, step, signal }` and carries no
  // session, so remember the session the pre-step waterfall handed us. Pre-step
  // runs for every turn before its request, so this is always current by the
  // time a request arrives.
  let lastSession

  const stateOf = session => {
    const id = session?.id ?? session?.sessionId ?? 'default'
    let entry = state.get(id)
    if (entry === undefined) {
      entry = { fired: false, quietSteps: 0, stepDownLeft: 0 }
      state.set(id, entry)
    }
    return entry
  }

  // The request waterfall: the ONLY place this plugin rewrites a request, and
  // only while a step-down window is open.
  //
  // TWO facts about this waterfall, both of which a wrong listener breaks:
  //
  //  1. The PAYLOAD is `{ turn, step, signal }` — the round's coordinates, NOT
  //     the request config. `agent-loop` calls
  //         dispatch.waterfall("agent/request", { turn, step, signal },
  //                            () => seedConfig)
  //     and the config with provider/model lives in the SEED, reachable only by
  //     awaiting next().
  //  2. A listener's return value REPLACES the seed. So returning the payload
  //     (or `request`, as an earlier revision did) hands back `{turn,step,...}`
  //     with no provider/model, and agent-loop then throws
  //         agent "<id>" has no provider/model: set AgentOptions.provider and
  //         AgentOptions.model or supply both via the agent/request waterfall
  //     which surfaces as a silent turn failure: step/start then step/end with
  //     no system/message and no error record.
  //
  // The contract is therefore: always `await next()` to obtain the config, and
  // return the config either untouched or modified.
  ctx.on('agent/request', async (request, next) => {
    const config = await next()
    // The payload carries no session — `{ turn, step, signal }` — so the
    // step-down window is keyed by the last session this plugin observed on the
    // pre-step waterfall, which runs for every turn before any request.
    const entry = stateOf(lastSession)
    if (entry.stepDownLeft <= 0) return config
    entry.stepDownLeft -= 1
    const current = config?.reasoningEffort
    const index = EFFORT_LADDER.indexOf(current)
    if (index === -1 || index === EFFORT_LADDER.length - 1) return config
    const stepDownTo = EFFORT_LADDER[index + 1]
    ctx.logger?.info?.(`${name}: step-down ${current} -> ${stepDownTo} (${entry.stepDownLeft} requests left)`)
    return { ...config, reasoningEffort: stepDownTo }
  })

  // The pre-step: observe, and inject the breaker message exactly once.
  ctx.on('agent/pre-step', (decision, session) => {
    // Remember the session for the request waterfall, whose payload omits it.
    lastSession = session
    const entry = stateOf(session)
    if (entry.quietSteps > 0) { entry.quietSteps -= 1; return decision }
    if (entry.fired) return decision

    const events = sessionEvents(session)
    const steps = assistantSteps(session)
    const stall = foldStall(steps, thresholds)
    const echo = foldEcho(events, echoFailures)
    if (!stall.stalled && !echo.echoed) return decision

    entry.fired = true
    entry.quietSteps = cooldown
    entry.stepDownLeft = stepDownRequests
    const kind = stall.stalled
      ? `detected ${stall.consecutive >= thresholds.stallSteps ? 'consecutive' : 'sustained'} output-free long reasoning`
      : `detected ${echo.count} identical failing tool calls in a row`
    ctx.logger?.warn?.(`${name}: ${kind}; breaker fired`)

    const text = [
      `[Circuit breaker: ${kind}. The loop was interrupted from outside the conversation.]`,
      'Stop and reassess before continuing:',
      '- If you already have enough evidence, close out now with your best answer.',
      '- If you do not, take ONE materially different action — a different tool, a different query, or a narrower read. Repeating the current approach is not a new step.',
      '- Do not restate the problem or re-derive what you already know.',
    ].join('\n')

    // `kind: name` is the v4 producer-owned shape. It used to be
    // `source: { plugin: name }` (v3), which made the loader reject the ENTIRE
    // session as corrupt once the app restarted, so the conversation could never be
    // reopened. See the long note in tool-catalog.mjs — same defect, same cause.
    const message = { role: 'user', content: [{ type: 'text', text }], source: { kind: name }, id: `${name}:breaker` }
    const messages = Array.isArray(decision?.messages) ? decision.messages : []
    // Match on `kind` now. Checking the old `plugin` field would stop recognising
    // our own previous message and duplicate the breaker on every pass.
    const others = messages.filter(item => item?.source?.kind !== name)
    return { ...decision, messages: [...others, message] }
  }, { prepend: true })
}
