/**
 * dsh-baize — 白泽模式 (Baize) agent preset, declarer and settings surface.
 *
 * ── How a preset becomes selectable ─────────────────────────────────────────
 *
 * Under 0.1.7-rc a preset is an ordinary registry declaration rather than a
 * directory the harness scans. `agentPresets.register()` is what makes a preset
 * appear in Settings > Agent 预设, and this plugin exists to call it with the
 * bundled composition.
 *
 * NOTE: the OFFICIAL declarer for a preset is a `@deepseek-ai/dsh-agent-preset`
 * row with `config.plugins` inline, and that is what the shipped profile patch
 * uses — see `install-row.mjs`. This plugin is the OPT-IN alternative, and it
 * is the one to mount when the operator wants the settings surface below. Both
 * declare the same preset id `baize`, so mount exactly ONE of them: two
 * declarers would race and the loser's `register()` would be refused as a
 * duplicate.
 *
 * ── Why 白泽 exists rather than just using LiangShen ─────────────────────────
 *
 * 白泽 keeps LiangShen's verified wins and repairs its costs:
 *
 *  - KEEPS the minimal persona (`complete: true` drops the harness identity,
 *    web-surface and tool-guidance sections) and the standing working
 *    discipline — the single most certain saving in the design.
 *  - KEEPS the working-context projection, the tool catalog, tool paging and
 *    the degeneration breaker.
 *  - FIXES the tool surface: LiangShen keeps only the shell, stranding files,
 *    search, skills, plan mode, delegation and web fetch. 白泽 keeps the shell
 *    AND the ordinary working set.
 *  - FIXES the presentation default: `native`, not the unmeasured `ptc` that
 *    the official comparison ranks BELOW the native surface.
 *  - FIXES the breaker: TWO consecutive output-free long-reasoning steps
 *    instead of one, with higher floors — a false interruption destroys work in
 *    progress, while the slow-burn ladder still catches a real runaway.
 *  - FIXES the fact register: facts may be marked `high` so eviction drops
 *    ordinary ones first, and the tool reply TELLS the model when a pin was
 *    dropped instead of evicting it silently.
 *
 * ── Beyond LiangShen ────────────────────────────────────────────────────────
 *
 * 1. SETTINGS ARE LIVE. Every knob this preset exposes is a `.volatile()` field
 *    on {@link Config}, so the host renders it in the plugin's settings panel
 *    and hands the value over as a reference. A write fires
 *    `loader/volatile-update`, the preset is re-declared with the new values,
 *    and the next session picks them up — no file edit, no restart.
 * 2. FAILURES ARE DIAGNOSABLE. LiangShen's declare() catches a registry refusal
 *    and only logs; because the GUI hides a preset whose declaration failed,
 *    the operator sees "it's missing" with no cause anywhere. This plugin
 *    records the failure and exposes it through {@link baizeDeclarationStatus}.
 *
 * @module dsh-baize
 */

import { fileURLToPath } from 'node:url'
import { readPresetDefinition, CompositionError } from './composition.js'
import { Config, DEFAULT_CONFIG, resolveConfig, applyPresetOverrides, BAIZE_SETTINGS_NAMESPACE } from './config.js'

export { Config, DEFAULT_CONFIG, BAIZE_SETTINGS_NAMESPACE }

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-baize'

/** The registry id this plugin declares. Mirrors `presets/baize/preset.yml`. */
export const BAIZE_PRESET_ID = 'baize'

/** The agent-preset registry must exist before a declaration can be made. */
export const inject = ['agentPresets']

/** Absolute path of the bundled Baize preset directory. */
export function bundledPresetDir() {
  return fileURLToPath(new URL('../presets/baize/', import.meta.url))
}

/**
 * Declaration status of the most recent attempt, for diagnostics.
 *
 * The GUI hides a preset whose declaration failed, so without this the only
 * observable symptom is "my preset is not in the list". `lastError` carries the
 * registry's own message.
 */
let status = { declared: false, id: BAIZE_PRESET_ID, lastError: undefined, attempts: 0 }

/** Read the current declaration status (diagnostics surface). */
export function baizeDeclarationStatus() {
  return { ...status }
}

/** Build the registry definition with the committed settings applied. */
function declaration(values) {
  const definition = readPresetDefinition(BAIZE_PRESET_ID, bundledPresetDir())
  return { ...definition, plugins: applyPresetOverrides(definition.plugins, values) }
}

/** Mount the plugin. */
export function apply(ctx, config = {}) {
  let closed = false
  let release
  let generation = 0
  let queue = Promise.resolve()

  const warn = message => ctx.logger?.warn?.(`${name}: ${message}`)

  /** Release the live declaration, waiting for the registry to unmount rows. */
  const undeclare = async () => {
    const dispose = release
    release = undefined
    if (dispose === undefined) return
    try {
      await dispose()
    } catch (error) {
      warn(`releasing the preset declaration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Declare the preset with the settings committed right now. */
  const declare = () => {
    const target = ++generation
    queue = queue.then(async () => {
      if (closed || target !== generation) return
      await undeclare()

      const values = resolveConfig(config)
      if (!values.enabled) {
        status = { declared: false, id: BAIZE_PRESET_ID, lastError: 'disabled by configuration', attempts: status.attempts + 1 }
        return
      }

      const registry = ctx.get('agentPresets')
      if (registry === undefined) {
        status = { declared: false, id: BAIZE_PRESET_ID, lastError: 'the agent-preset registry is unavailable', attempts: status.attempts + 1 }
        warn('the agent-preset registry is unavailable; the preset is not declared')
        return
      }
      if (typeof registry.register !== 'function') {
        status = { declared: false, id: BAIZE_PRESET_ID, lastError: 'the agentPresets service exposes no register()', attempts: status.attempts + 1 }
        warn('the agentPresets service exposes no register(); the preset is not declared')
        return
      }

      let definition
      try {
        definition = declaration(values)
      } catch (error) {
        const detail = error instanceof CompositionError
          ? error.message
          : error instanceof Error ? error.message : String(error)
        status = { declared: false, id: BAIZE_PRESET_ID, lastError: `the bundled composition is unreadable: ${detail}`, attempts: status.attempts + 1 }
        warn(`the bundled composition is unreadable: ${detail}`)
        return
      }

      try {
        release = await registry.register(definition)
        status = {
          declared: true,
          id: BAIZE_PRESET_ID,
          lastError: undefined,
          attempts: status.attempts + 1,
          rows: definition.plugins.length,
          presentation: values.presentation,
        }
        ctx.logger?.info?.(`${name}: preset ${BAIZE_PRESET_ID} declared (${String(definition.plugins.length)} rows, presentation=${values.presentation})`)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        status = { declared: false, id: BAIZE_PRESET_ID, lastError: detail, attempts: status.attempts + 1 }
        warn(`declaring the preset failed: ${detail}`)
      }
    }).catch(error => {
      const detail = error instanceof Error ? error.message : String(error)
      status = { declared: false, id: BAIZE_PRESET_ID, lastError: detail, attempts: status.attempts + 1 }
      warn(`preset declaration failed: ${detail}`)
    })
  }

  // A settings write commits into this row's volatile references and fires this
  // event; re-declaring is what makes the new values take effect.
  ctx.on('loader/volatile-update', () => { declare() })

  ctx.effect(() => {
    declare()
    return async () => {
      closed = true
      generation += 1
      await queue
      await undeclare()
      status = { declared: false, id: BAIZE_PRESET_ID, lastError: 'unmounted', attempts: status.attempts }
    }
  }, 'dsh-baize: preset declaration')
}
