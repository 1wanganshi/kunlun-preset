/**
 * config — the Baize preset's settings surface.
 *
 * WHY THIS EXISTS: without it, every knob the preset exposes (wire
 * presentation, breaker sensitivity, paging) is frozen into the profile patch,
 * so changing one means hand-editing `cordis.patch.yml` and restarting the
 * desktop app. A schemastery `Config` with `.volatile()` fields instead makes
 * the host render them in the plugin's settings panel and hand the values over
 * as LIVE references, so an edit takes effect on the next re-arm without a
 * restart.
 *
 * The field names and semantics mirror LiangShen's where the preset composes
 * the same mechanism, so an operator moving between the two recognizes them.
 * Where Baize differs (the presentation default, the breaker floors), the
 * DEFAULT differs rather than the name.
 *
 * @module dsh-baize/config
 */

import z from '@deepseek-ai/schemastery'

/** The settings namespace this declarer's fields live under. */
export const BAIZE_SETTINGS_NAMESPACE = 'baize'

/** The wire presentations the tool catalog accepts. */
export const PRESENTATION_OPTIONS = ['native', 'ptc', 'both']

/** Sensitivity presets for the circuit breaker's adaptive thresholds. */
export const SENSITIVITY_OPTIONS = ['conservative', 'balanced', 'aggressive']

/**
 * The declarer's configuration.
 *
 * Every field is `.volatile()` so the host treats it as a live reference rather
 * than a load-time constant: the Loader commits a settings write into this
 * row's references and fires `loader/volatile-update`, which re-declares the
 * preset with the new values. Nothing needs a restart.
 */
export const Config = z.object({
  /** Whether 白泽模式 is offered at all. */
  enabled: z.boolean().default(true).volatile(),

  /**
   * How this preset's tools sit on the wire.
   *
   * DEFAULT `native` — deliberately NOT LiangShen's `ptc`. The official
   * scaffold comparison ranks the collapsed `ptc` surface BELOW the native one
   * on both code-agent benchmarks, and LiangShen's own comments concede the
   * choice is a static-context decision rather than a measured win.
   */
  presentation: z.union([...PRESENTATION_OPTIONS]).default('native').volatile(),

  /**
   * Tool families withheld from the wire until `tool_activate` loads them.
   *
   * DEFAULT EMPTY (paging off) — deliberately NOT LiangShen's `['mcp__*']`.
   * Paging a namespace a session actually needs is a capability loss dressed as
   * a token saving, so it is opt-in per deployment.
   */
  pagedToolPatterns: z.array(z.string()).default([]).volatile(),

  /** How many activated namespaces stay resident before LRU eviction. */
  maxActiveNamespaces: z.number().default(3).volatile(),

  /** Whether the degeneration circuit breaker is armed. */
  guardEnabled: z.boolean().default(true).volatile(),

  /** How eagerly the breaker fires: more conservative interrupts less. */
  guardSensitivity: z.union([...SENSITIVITY_OPTIONS]).default('balanced').volatile(),

  /**
   * The per-step reasoning-character floor at `max` effort.
   *
   * DEFAULT 12000 — deliberately higher than LiangShen's 8000, and paired with
   * a two-step ladder (see guard.mjs): a false interruption destroys work in
   * progress, while a missed episode costs one more step before the slow-burn
   * ladder catches it.
   */
  guardStallReasoningChars: z.number().default(12000).volatile(),

  /** Consecutive output-free reasoning steps that trip the slow-burn ladder. */
  guardGlobalStallCap: z.number().default(4).volatile(),

  /** Identical-argument tool failures in a row that constitute an echo loop. */
  guardEchoFailures: z.number().default(3).volatile(),

  /** Cap on one tool's one-line summary in the injected catalog. */
  catalogDescriptionMaxLength: z.number().default(200).volatile(),
})

/** The schema defaults, for a context built by hand rather than by the Loader. */
export const DEFAULT_CONFIG = {
  enabled: true,
  presentation: 'native',
  pagedToolPatterns: [],
  maxActiveNamespaces: 3,
  guardEnabled: true,
  guardSensitivity: 'balanced',
  guardStallReasoningChars: 12000,
  guardGlobalStallCap: 4,
  guardEchoFailures: 3,
  catalogDescriptionMaxLength: 200,
}

/**
 * Read one activation field.
 *
 * The host validates the raw profile config and hands volatile fields over as
 * REFERENCES, so a read goes through `get()`. A plain value passes through, and
 * an absent field falls back to the schema default.
 */
function readField(field, fallback) {
  if (field === undefined || field === null) return fallback
  const ref = field
  if (typeof ref?.get === 'function') {
    try {
      const value = ref.get()
      return value === undefined ? fallback : value
    } catch {
      return fallback
    }
  }
  return ref
}

/**
 * Resolve the committed configuration into plain values.
 * @param config - the row config, possibly holding volatile references.
 * @returns every field as a plain value, defaults applied.
 */
export function resolveConfig(config) {
  const raw = config ?? {}
  const presentation = readField(raw.presentation, DEFAULT_CONFIG.presentation)
  const sensitivity = readField(raw.guardSensitivity, DEFAULT_CONFIG.guardSensitivity)
  const patterns = readField(raw.pagedToolPatterns, DEFAULT_CONFIG.pagedToolPatterns)
  return {
    enabled: readField(raw.enabled, DEFAULT_CONFIG.enabled) !== false,
    presentation: PRESENTATION_OPTIONS.includes(presentation) ? presentation : DEFAULT_CONFIG.presentation,
    pagedToolPatterns: Array.isArray(patterns) ? patterns : DEFAULT_CONFIG.pagedToolPatterns,
    maxActiveNamespaces: readField(raw.maxActiveNamespaces, DEFAULT_CONFIG.maxActiveNamespaces),
    guardEnabled: readField(raw.guardEnabled, DEFAULT_CONFIG.guardEnabled) !== false,
    guardSensitivity: SENSITIVITY_OPTIONS.includes(sensitivity) ? sensitivity : DEFAULT_CONFIG.guardSensitivity,
    guardStallReasoningChars: readField(raw.guardStallReasoningChars, DEFAULT_CONFIG.guardStallReasoningChars),
    guardGlobalStallCap: readField(raw.guardGlobalStallCap, DEFAULT_CONFIG.guardGlobalStallCap),
    guardEchoFailures: readField(raw.guardEchoFailures, DEFAULT_CONFIG.guardEchoFailures),
    catalogDescriptionMaxLength: readField(raw.catalogDescriptionMaxLength, DEFAULT_CONFIG.catalogDescriptionMaxLength),
  }
}

/**
 * Patch the composed rows with the committed settings.
 *
 * Only the rows the settings actually shape are rewritten, matched by id, so
 * every other row passes through untouched. A row whose id is absent from the
 * composition is ignored rather than appended — settings can tune the preset,
 * never extend it.
 *
 * @param rows - the composition rows read from the bundled preset.
 * @param values - resolved settings from {@link resolveConfig}.
 * @returns a new row list with the shaped rows updated.
 */
export function applyPresetOverrides(rows, values) {
  const shaped = {
    'tool-catalog': row => ({
      ...row,
      config: {
        ...row.config,
        presentation: values.presentation,
        pagedToolPatterns: values.pagedToolPatterns,
        descriptionMaxLength: values.catalogDescriptionMaxLength,
      },
    }),
    'working-context': row => ({
      ...row,
      config: {
        ...row.config,
        pagedToolPatterns: values.pagedToolPatterns,
        maxActiveNamespaces: values.maxActiveNamespaces,
      },
    }),
    'tool-activate': row => ({
      ...row,
      config: { ...row.config, pagedToolPatterns: values.pagedToolPatterns, maxActiveNamespaces: values.maxActiveNamespaces },
    }),
    guard: row => ({
      ...row,
      config: {
        ...row.config,
        enabled: values.guardEnabled,
        sensitivity: values.guardSensitivity,
        stallReasoningChars: values.guardStallReasoningChars,
        globalStallCap: values.guardGlobalStallCap,
        echoFailures: values.guardEchoFailures,
      },
    }),
  }

  const walk = list =>
    list.map(row => {
      const shape = shaped[row?.id]
      const next = shape !== undefined ? shape(row) : row
      if (Array.isArray(next?.config)) return { ...next, config: walk(next.config) }
      return next
    })

  return walk(rows)
}
