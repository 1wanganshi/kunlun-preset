/**
 * tool-activate — the Baize preset's paging activation handle.
 *
 * Registers `tool_activate({ namespace })`, which loads one paged-out tool
 * namespace back onto the wire. Activation is durable because it is folded
 * from the session event stream by the sibling plugins (tool-catalog releases
 * the restriction, working-context republishes its line), so resume and
 * compaction rebuild the same active set with no process memory.
 *
 * The row is mounted unconditionally and is INERT while paging is off (the
 * Baize default): with `pagedToolPatterns: []` no namespace is ever withheld,
 * so the tool honestly reports that there is nothing to activate. Keeping the
 * row mounted means flipping paging on needs no other edit.
 */

import { integerAtLeast, validatePagedToolPatterns, DEFAULT_MAX_ACTIVE_NAMESPACES } from './paging.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'baize-tool-activate'

/** The tools registry must exist before the activation tool can register. */
export const inject = ['tools']

/** The model-facing activation tool this plugin mounts. */
export const TOOL_ACTIVATE = 'tool_activate'

/** Mount the plugin. */
export function apply(ctx, config = {}) {
  const patterns = validatePagedToolPatterns(name, config.pagedToolPatterns)
  const maxActive = integerAtLeast(name, config.maxActiveNamespaces, 'maxActiveNamespaces', 1, DEFAULT_MAX_ACTIVE_NAMESPACES)

  ctx.tools.register({
    name: TOOL_ACTIVATE,
    description: patterns.length === 0
      ? 'Bring a paged-out tool namespace onto this session\'s wire. Paging is currently OFF for this preset (no tool families are withheld), so there is normally nothing to activate — every tool is already reachable by name.'
      : [
          'Bring a paged-out tool namespace onto this session\'s wire so its tools become callable.',
          `Some tool families are withheld until needed to keep the wire small. Pass the namespace exactly as the tool catalog lists it (for example "mcp__github__"). At most ${maxActive} namespaces stay active; activating a fourth pages the least recently activated one back out.`,
          'Activation persists for the session and replays after resume or compaction.',
        ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        namespace: {
          type: 'string',
          description: 'The paged namespace to activate, exactly as the tool catalog lists it (for example "mcp__github__").',
        },
      },
      required: ['namespace'],
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
    isConcurrencySafe: () => true,
    async execute(args) {
      const namespace = typeof args?.namespace === 'string' ? args.namespace.trim() : ''
      if (namespace === '') throw new Error('tool_activate requires a non-empty `namespace`')
      if (patterns.length === 0) {
        return { text: `Paging is off for this preset, so "${namespace}" was never withheld — no activation is needed. Call its tools directly by name.` }
      }
      const known = patterns.some(pattern => pattern === namespace || (pattern.endsWith('*') && namespace.startsWith(pattern.slice(0, -1))))
      if (!known) {
        return { text: `"${namespace}" does not match any paged namespace. Paged families: ${patterns.join(', ')}.` }
      }
      return { text: `Activated "${namespace}": its tools are on the wire from the next request on. At most ${maxActive} namespaces stay active; the least recently activated is paged back out beyond that.` }
    },
  })
}
