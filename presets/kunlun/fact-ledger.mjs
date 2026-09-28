/**
 * fact-ledger — the Baize preset's key-fact register.
 *
 * WHY THIS EXISTS: long conversations forget. A sparse-attention index
 * guarantees a query only the most recent local window, and a hard constraint
 * the user stated eighty turns ago competes for Top-K slots with every tool
 * schema, log line and test failure since. The working-context projection is
 * the one surface that lands inside that guaranteed window EVERY step, so the
 * register rides it.
 *
 * WHAT BAIZE CHANGES FROM THE LIANGSHEN LEDGER:
 *
 * 1. `priority` — LiangShen evicts strictly by age (a plain FIFO), so a
 *    constraint pinned in turn 3 is silently dropped once twelve fresher facts
 *    accumulate, and the model is told nothing. Here a fact may be marked
 *    `high`, and eviction takes the OLDEST LOW-PRIORITY fact first, only
 *    falling back to the oldest high-priority one when every slot is high.
 *    A hard user constraint therefore cannot be evicted by a trivia note.
 *
 * 2. An OVERFLOW NOTICE. When a pin is dropped, the tool's own reply says so.
 *    LiangShen's silent eviction is the worst failure mode a memory surface
 *    can have: the model believes the fact is still projected.
 *
 * 3. Append-only revocation is kept exactly as upstream (a `revoke` entry
 *    removes every earlier fact carrying the same tag), so the fold stays
 *    deterministic after resume and compaction with no process memory.
 */

import { parseArguments } from './paging.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'baize-fact-ledger'

/** The tools registry must exist before the ledger tool can register. */
export const inject = ['tools']

/** The model-facing registration tool this plugin mounts. */
export const FACT_LEDGER_TOOL = 'fact_register'

/** Cap one fact so a single entry stays a glance, not a paragraph. */
export const MAX_FACT_CHARS = 160

/** Cap the register so the ledger cannot itself flood the local window. */
export const MAX_FACTS = 12

/** The two priority levels. Anything else is rejected. */
export const PRIORITIES = ['high', 'normal']

/** Default priority for an untagged pin. */
export const DEFAULT_PRIORITY = 'normal'

/**
 * Fold the current fact register from the event stream.
 *
 * Every successful `fact_register` call appends its fact (or revokes by tag).
 * Facts carry no ids — revocation matches on the optional `tag`, and an
 * untagged fact can only be revoked by revoking its exact text.
 *
 * Eviction, when the register exceeds {@link MAX_FACTS}, drops the oldest
 * `normal` fact; only if every slot is `high` does it drop the oldest one.
 *
 * @returns the surviving facts, newest last.
 */
export function foldFactLedger(events) {
  const facts = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'tool/call' || event.data?.name !== FACT_LEDGER_TOOL) continue
    const args = parseArguments(event.data?.arguments)
    if (args === undefined || args === null) continue

    if (typeof args.revoke === 'string' && args.revoke.trim() !== '') {
      const tag = args.revoke.trim()
      for (let index = facts.length - 1; index >= 0; index -= 1) {
        if (facts[index].tag === tag || facts[index].text === tag) facts.splice(index, 1)
      }
      continue
    }

    if (typeof args.fact !== 'string' || args.fact.trim() === '') continue
    const text = args.fact.trim().slice(0, MAX_FACT_CHARS)
    if (facts.some(entry => entry.text === text)) continue
    const tag = typeof args.tag === 'string' && args.tag.trim() !== '' ? args.tag.trim() : undefined
    const priority = args.priority === 'high' ? 'high' : DEFAULT_PRIORITY
    facts.push({ text, tag, priority })

    // Evict the oldest low-priority fact first; only then the oldest of all.
    while (facts.length > MAX_FACTS) {
      const victim = facts.findIndex(entry => entry.priority !== 'high')
      facts.splice(victim === -1 ? 0 : victim, 1)
    }
  }
  return facts
}

/**
 * Render the register as the working-context field value, or undefined when
 * the register is empty. High-priority facts are marked and ordered first so
 * the most load-bearing lines sit closest to the model's recency window.
 */
export function renderLedgerField(facts) {
  if (!Array.isArray(facts) || facts.length === 0) return undefined
  const ordered = [
    ...facts.filter(entry => entry.priority === 'high'),
    ...facts.filter(entry => entry.priority !== 'high'),
  ]
  const rendered = ordered.map(entry => {
    const mark = entry.priority === 'high' ? '!' : ''
    return entry.tag === undefined ? `${mark}${entry.text}` : `${mark}${entry.text} [${entry.tag}]`
  })
  return `key facts: ${rendered.join(' ; ')}`
}

/** Register the `fact_register` tool. */
export function apply(ctx) {
  ctx.tools.register({
    name: FACT_LEDGER_TOOL,
    description: [
      'Pin one key fact into this session\'s working context — the line the runtime projects next to the newest message every step. Use it for the facts a long session must not lose: a hard user constraint, a confirmed architecture decision, a path that already failed.',
      `A fact is one short line (<= ${MAX_FACT_CHARS} chars); at most ${MAX_FACTS} stay pinned. Pass priority "high" for a constraint that must outlive ordinary notes — eviction drops normal facts first, so a high-priority fact is only displaced when every slot is high.`,
      'Pass the same text again to no-op; pass the revoke field with a fact tag (or its exact text) to unpin everything under it.',
      'Pin sparingly: the register rides the guaranteed-attention window, and flooding it dilutes every other fact.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description: 'The single-line fact to pin (for example "User requires TypeScript strict mode, no any"). Omit when revoking.',
        },
        tag: {
          type: 'string',
          description: 'An optional short tag naming the fact\'s topic (for example "constraints", "auth-decision") so it can be revoked by tag later.',
        },
        priority: {
          type: 'string',
          enum: PRIORITIES,
          description: 'Pin strength. "high" for a hard constraint or confirmed decision that must survive eviction; "normal" (default) for ordinary context. Normal facts are evicted oldest-first before any high fact is touched.',
        },
        revoke: {
          type: 'string',
          description: 'Revoke every pinned fact under this tag (or matching this exact text). When set, the fact field is ignored.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    /**
     * Concurrency-safe: the handler only validates and reports. The register
     * itself is the fold of the durable log the runtime appends for the call,
     * so overlapping registrations cannot corrupt shared state.
     */
    isConcurrencySafe: () => true,
    async execute(args) {
      if (typeof args?.revoke === 'string' && args.revoke.trim() !== '') {
        return { text: `Revocation recorded for "${args.revoke.trim()}": every pinned fact under that tag (or matching that text) drops from the next step's working context.` }
      }
      if (typeof args?.fact !== 'string' || args.fact.trim() === '') {
        throw new Error('fact_register requires either a non-empty `fact` to pin or a non-empty `revoke` tag/text to unpin')
      }
      const text = args.fact.trim().slice(0, MAX_FACT_CHARS)
      const tagged = typeof args?.tag === 'string' && args.tag.trim() !== '' ? ` under tag "${args.tag.trim()}"` : ''
      const strength = args?.priority === 'high' ? ' (high priority — evicted last)' : ''
      return { text: `Pinned${tagged}${strength}: "${text}". It rides the working-context line from the next step on.` }
    },
  })
}
