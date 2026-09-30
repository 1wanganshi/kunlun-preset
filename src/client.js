/**
 * 昆仑模式 (Kunlun) — browser half.
 *
 * Registers the composer lever beside the model selector. The lever toggles the
 * session's agent preset to `kunlun` and back, and plays the 昆仑 burst (snow range,
 * gold light, drifting snow) together with a synthesized startup tone.
 *
 * LiangShen's lever, which this is modelled on, is silent — its bundle contains no
 * audio code. The tone here is generated with the Web Audio API rather than shipped as
 * a file, so there is nothing to load and the sound can be retuned in place.
 */
import { LeverController, KUNLUN_PRESET_ID } from './lever-controller.js'
import { createKunlunLever } from './lever.js'

/** Services the browser half reads. Every one is declared, because the context proxy
 *  refuses an uninjected service and `remote.agentPresets` needs `remote` too. */
export const inject = ['slots', 'sessions', 'remote', 'remote.agentPresets']

/**
 * Mount the lever.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx) {
  const controller = new LeverController(ctx)
  ctx.effect(() => () => controller.dispose(), 'kunlun: lever controller')
  controller.start()

  const lever = createKunlunLever(ctx)
  lever.attach(controller)
}

export { KUNLUN_PRESET_ID, LeverController }
