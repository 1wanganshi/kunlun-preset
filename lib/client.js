window.__ModuleLoader__.load({
	id: "dsh-kunlun",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
// ── lever-controller.js ───────────────────────────────────────
/**
 * Lever controller: the facts and verbs behind 昆仑's composer lever.
 *
 * The view stays pure — everything it renders comes from here. The roster arrives over
 * the agent-preset Remote namespace, the current session comes from the client session
 * store, and the switch goes through `agentPresets.select`, which the host accepts only
 * while the session is still blank.
 *
 * Copied in shape from the LiangShen lever controller, because that design is sound:
 * a refused switch must leave the lever exactly as it was, and the sequence number
 * (`burst`) is what the view watches to know a switch LANDED, so the theatrical part
 * never plays for a refusal.
 */

const SELECT_TIMEOUT_MS = 10000

/** Preset id this lever switches to. Matches the declaration in cordis.patch.yml. */
const KUNLUN_PRESET_ID = 'kunlun'
class LeverController {
  constructor(ctx) {
    this.ctx = ctx
    this.rows = []
    this.previous = null
    this.loading = false
    this.listeners = new Set()
    this.disposers = []
    this.snap = {
      state: 'off',
      restoreLabel: '',
      busy: false,
      error: undefined,
      burst: 0,
    }
  }

  snapshot() {
    return {
      subscribe: (fn) => {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
      getSnapshot: () => this.snap,
    }
  }

  emit() {
    for (const fn of this.listeners) {
      try { fn() } catch {}
    }
  }

  set(patch) {
    this.snap = { ...this.snap, ...patch }
    this.emit()
  }

  start() {
    try {
      // The session list is a snapshot store, and it is the only thing that knows which
      // session owns the main view. There is no `sessions.current()` — calling one is
      // how an earlier version of this controller silently did nothing on every click.
      const off = this.ctx.sessions?.list?.subscribe?.(() => this.refresh())
      if (typeof off === 'function') this.disposers.push(off)
    } catch {}
    this.refresh()
    this.load()
  }

  dispose() {
    for (const d of this.disposers) { try { d() } catch {} }
    this.disposers = []
    this.listeners.clear()
  }

  async load() {
    this.loading = true
    try {
      const res = await this.ctx.remote.agentPresets.list()
      const roster = res?.ok ? res.value : null
      const list = roster?.presets ?? roster?.rows ?? roster ?? []
      this.rows = Array.isArray(list) ? list : []
    } catch {
      // A refused read leaves the lever as it was; it must not fabricate a roster.
    } finally {
      this.loading = false
      this.refresh()
    }
  }

  /**
   * The session that currently owns the main view, or undefined when the user is on the
   * session list. Mirrors the harness's own rule: a row is the main view when something
   * retained it (`retainedBy.mainView > 0`).
   */
  currentSession() {
    try {
      const state = this.ctx.sessions?.list?.getSnapshot?.()
      const byId = state?.byId
      if (!byId) return undefined
      for (const row of Object.values(byId)) {
        if (row && (row.retainedBy?.mainView ?? 0) > 0) return row
      }
    } catch {}
    return undefined
  }

  /** Current session id, or undefined when there is no main view. */
  currentSessionId() {
    const s = this.currentSession()
    return s?.id
  }

  currentPreset() {
    const v = this.currentSession()?.projectionValues?.agentPreset
    return typeof v === 'string' && v ? v : null
  }

  refresh() {
    const cur = this.currentPreset()
    const on = cur === KUNLUN_PRESET_ID
    // `previous` only exists for the length of a page visit; otherwise there is
    // nothing to restore and the label stays empty rather than lying.
    const restoreLabel = this.previous ? this.labelOf(this.previous) : ''
    this.set({ state: on ? 'on' : 'off', restoreLabel })
  }

  labelOf(id) {
    const row = this.rows.find((r) => (r?.id ?? r?.preset ?? r?.name) === id)
    return row?.name ?? row?.label ?? id
  }

  face() {
    return {
      store: this.snapshot(),
      pull: () => this.toggle('on'),
      push: () => this.toggle('off'),
      t: (key) => {
        const dict = {
          on: '昆仑模式',
          off: '普通模式',
          pullDown: '拨下开启昆仑模式',
          pushUp: '上拨恢复原模式',
          locked: '会话已经开始，模式不可再更改',
          missing: '没有找到昆仑模式',
          timeout: '切换超时，请重试',
          busy: '正在切换',
        }
        return dict[key] ?? key
      },
    }
  }

  toggle(direction) {
    if (this.snap.busy) return
    const sid = this.currentSessionId()
    // No main view means the user is on the session list, where there is no composer
    // and therefore no lever. Reaching here means the gesture beat the refresh.
    if (!sid) {
      this.set({ error: { kind: 'failed', reason: '没有正在编辑的会话' } })
      return
    }

    // Remember what to restore BEFORE switching away from it.
    if (direction === 'on') this.previous = this.currentPreset() || null

    const target = direction === 'on' ? KUNLUN_PRESET_ID : (this.previous || 'standard')
    this.set({ busy: true, error: undefined })

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      this.set({ busy: false, error: { kind: 'timeout' } })
    }, SELECT_TIMEOUT_MS)

    Promise.resolve()
      .then(() => this.ctx.remote.agentPresets.select(sid, target))
      .then((res) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // `select` resolves with the new preset id on success; a failure carries an
        // error object. Reading only `.ok` missed both shapes, so check what is there.
        const failed = res?.ok === false || res?.error !== undefined
        if (!failed) {
          this.set({
            busy: false,
            error: undefined,
            state: direction === 'on' ? 'on' : 'off',
            // Only a LANDED switch increments the burst, so a refusal never celebrates.
            burst: this.snap.burst + 1,
          })
        } else {
          const code = String(res?.error?.code ?? res?.error?.kind ?? '')
          const upper = code.toUpperCase()
          const kind = upper.includes('LOCK') ? 'locked'
            : upper.includes('MISS') || upper.includes('NOT_FOUND') ? 'missing'
            : 'failed'
          this.set({
            busy: false,
            error: kind === 'failed'
              ? { kind, reason: String(res?.error?.message ?? res?.error?.reason ?? '切换失败') }
              : { kind },
          })
        }
      })
      .catch((e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.set({ busy: false, error: { kind: 'failed', reason: String(e?.message ?? e) } })
      })
  }
}

// ── lever.js ──────────────────────────────────────────────────
/**
 * 昆仑模式 (Kunlun) — the composer lever for the dsh web GUI.
 *
 * A lever beside the model selector on the new-session screen. Pulling it down (or
 * clicking it) switches the session about to start into 昆仑模式; pushing it up restores
 * the preset the user was on.
 *
 * Two deliberate differences from the LiangShen lever this is modelled on:
 *
 *   1. **It speaks and it sounds.** LiangShen's lever is purely visual — its client
 *      bundle contains no audio code at all. This one synthesizes a startup tone with
 *      the Web Audio API, so there is no audio file to ship and the sound can be tuned
 *      without touching assets.
 *   2. **The geometry is the name.** LiangShen bursts sparks like a jackpot. 昆仑 is a
 *      mountain, so the burst is a range of snow peaks rising from below, a light
 *      sweeping along the ridge, and gold light opening above it.
 *
 * The component is pure: every fact and verb arrives through the injected face. The
 * theatrical part plays only after the switch actually LANDED, so a refused switch
 * never celebrates.
 */

/** Vertical travel that separates a pull or push from a plain click. */
const DRAG_THRESHOLD_PX = 14
/** How long the burst overlay stays mounted, matching its CSS duration. */
const BURST_MS = 2400
/** Audio context is created lazily, on the first user gesture, as browsers require. */
let audioCtx = null

/**
 * The startup tone: a low pedal note that swells, a rising perfect fifth above it, and
 * a bright bell partial on top. Chosen to read as "waking up" rather than "winning".
 *
 * Every gain is scheduled with an envelope rather than switched on, because a raw
 * start/stop on an oscillator produces an audible click.
 */
function playKunlunTone(kind) {
  try {
    if (typeof window === 'undefined') return
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) return
    if (!audioCtx) audioCtx = new Ctor()
    const ctx = audioCtx
    // A context created before a gesture is 'suspended'; resume is safe to call either way.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})

    const now = ctx.currentTime
    const master = ctx.createGain()
    master.gain.value = 0
    master.connect(ctx.destination)

    // Pulse the master so the stack of partials reads as one event, not three.
    const on = kind === 'off'
    master.gain.setValueAtTime(0, now)
    master.gain.linearRampToValueAtTime(on ? 0.10 : 0.13, now + 0.06)
    master.gain.exponentialRampToValueAtTime(0.0001, now + (on ? 1.05 : 1.45))

    // A gentle low-pass keeps the bell partials from sounding harsh.
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(900, now)
    filter.frequency.exponentialRampToValueAtTime(4200, now + 0.5)
    filter.Q.value = 0.6
    filter.connect(master)

    // Root and fifth: a deep pedal that rises into place. Descending when turning off,
    // so the two directions are audibly different rather than just shorter/longer.
    const partials = on
      ? [
          { f0: 110, f1: 82, type: 'sine', gain: 0.55, delay: 0.0 },
          { f0: 165, f1: 123, type: 'sine', gain: 0.30, delay: 0.05 },
        ]
      : [
          { f0: 110, f1: 220, type: 'sine', gain: 0.50, delay: 0.0 },
          { f0: 165, f1: 330, type: 'triangle', gain: 0.28, delay: 0.05 },
        ]

    for (const p of partials) {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = p.type
      const t = now + p.delay
      osc.frequency.setValueAtTime(p.f0, t)
      osc.frequency.exponentialRampToValueAtTime(p.f1, t + 0.55)
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(p.gain, t + 0.05)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9)
      osc.connect(g)
      g.connect(filter)
      osc.start(t)
      osc.stop(t + 1.0)
    }

    // A bell strike on activation only — the "mountain wakes" accent.
    if (!on) {
      for (const [freq, gain, delay] of [[1318.5, 0.16, 0.10], [1975.5, 0.09, 0.16]]) {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, now + delay)
        g.gain.setValueAtTime(0, now + delay)
        g.gain.linearRampToValueAtTime(gain, now + delay + 0.01)
        g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.75)
        osc.connect(g)
        g.connect(master)
        osc.start(now + delay)
        osc.stop(now + delay + 0.8)
      }
    }
  } catch {
    // Audio is decoration. A browser that blocks it must not break the lever.
  }
}

/**
 * Injected into the page once. Prefixed to avoid colliding with the host's own classes,
 * and scoped under `.kunlun-lever-root` so nothing leaks into the rest of the GUI.
 */
const STYLE_ID = 'kunlun-lever-style'
function ensureStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = `
.kunlun-lever-root { position: relative; display: inline-flex; align-items: center; }
.kunlun-lever-btn {
  position: relative; display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px 0 6px; border-radius: 14px; cursor: pointer;
  border: 1px solid rgba(120,140,180,.30);
  background: linear-gradient(180deg, rgba(30,38,54,.72), rgba(20,26,38,.72));
  color: #b9c6dc; font-size: 12px; line-height: 1; user-select: none;
  transition: border-color .18s, color .18s, background .18s;
}
.kunlun-lever-btn:hover { border-color: rgba(150,180,230,.55); color: #dce6f5; }
.kunlun-lever-btn[data-on="1"] {
  border-color: rgba(198,164,92,.65);
  background: linear-gradient(180deg, rgba(46,42,28,.80), rgba(28,26,18,.80));
  color: #e8d9a8;
}
.kunlun-lever-btn[data-busy="1"] { opacity: .6; pointer-events: none; }
/* The arm: a small track with a knob that slides down when the mode is on. */
.kunlun-arm {
  position: relative; width: 14px; height: 22px; border-radius: 7px;
  background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.10);
}
.kunlun-knob {
  position: absolute; left: 1px; top: 1px; width: 10px; height: 10px; border-radius: 50%;
  background: linear-gradient(180deg, #8ea3c4, #5d7192);
  transition: transform .22s cubic-bezier(.34,1.56,.64,1), background .22s;
}
.kunlun-lever-btn[data-on="1"] .kunlun-knob {
  transform: translateY(8px);
  background: linear-gradient(180deg, #f0d99a, #c9a45c);
  box-shadow: 0 0 8px rgba(230,196,120,.75);
}
.kunlun-label { font-weight: 500; letter-spacing: .02em; white-space: nowrap; }

/* ── the burst ─────────────────────────────────────────────────────────── */
.kunlun-burst {
  position: fixed; inset: 0; z-index: 9999; pointer-events: none;
  display: flex; align-items: flex-end; justify-content: center; overflow: hidden;
}
.kunlun-burst-inner { position: relative; width: 100%; height: 100%; }
/* Gold light opening above the ridge. Kept to the lower half of the viewport: at
   90vmin it washed out the whole page and read as a glitch rather than a sunrise. */
.kunlun-glow {
  position: absolute; left: 50%; bottom: 6%; width: 58vmin; height: 58vmin;
  transform: translate(-50%, 50%); border-radius: 50%;
  background: radial-gradient(circle, rgba(255,214,130,.34) 0%, rgba(255,190,90,.15) 34%, rgba(255,170,60,0) 68%);
  animation: kunlun-glow-open ${BURST_MS}ms ease-out forwards;
}
@keyframes kunlun-glow-open {
  0%   { opacity: 0; transform: translate(-50%, 50%) scale(.35); }
  22%  { opacity: 1; transform: translate(-50%, 50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, 50%) scale(1.22); }
}
/* A ring expanding from the ridge, tying the burst to the gesture. Travel is capped so
   it frames the peaks instead of sweeping the entire window. */
.kunlun-ring {
  position: absolute; left: 50%; bottom: 6%; width: 10vmin; height: 10vmin;
  transform: translate(-50%, 50%); border-radius: 50%;
  border: 2px solid rgba(255,222,150,.85);
  animation: kunlun-ring-out ${BURST_MS}ms cubic-bezier(.2,.7,.3,1) forwards;
}
@keyframes kunlun-ring-out {
  0%   { opacity: .95; transform: translate(-50%, 50%) scale(.2); }
  70%  { opacity: .30; }
  100% { opacity: 0; transform: translate(-50%, 50%) scale(5.5); }
}
/* The snow range, rising from below the fold. */
.kunlun-peaks {
  position: absolute; left: 50%; bottom: 0; width: 100%;
  transform: translateX(-50%);
  animation: kunlun-peaks-rise ${BURST_MS}ms cubic-bezier(.16,.84,.3,1) forwards;
}
@keyframes kunlun-peaks-rise {
  0%   { opacity: 0; transform: translate(-50%, 34%) scaleY(.86); }
  26%  { opacity: 1; }
  100% { opacity: 0; transform: translate(-50%, 2%) scaleY(1); }
}
/* Light running along the ridge line. */
.kunlun-ridge {
  position: absolute; left: 50%; bottom: 0; width: 100%; transform: translateX(-50%);
  animation: kunlun-ridge-sweep ${BURST_MS}ms ease-out forwards;
}
@keyframes kunlun-ridge-sweep {
  0%   { opacity: 0; }
  20%  { opacity: 1; }
  75%  { opacity: .8; }
  100% { opacity: 0; }
}
/* The banner sits BELOW the fold of the composer, over the rising range. At bottom:34%
   it landed on the input box and read as a rendering bug. */
.kunlun-banner {
  position: absolute; left: 50%; bottom: 12%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  animation: kunlun-banner-in ${BURST_MS}ms cubic-bezier(.2,1.2,.3,1) forwards;
}
@keyframes kunlun-banner-in {
  0%   { opacity: 0; transform: translate(-50%, 22px) scale(.92); }
  18%  { opacity: 1; transform: translate(-50%, 0) scale(1); }
  82%  { opacity: 1; transform: translate(-50%, 0) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -12px) scale(1.03); }
}
.kunlun-title {
  font-size: 34px; font-weight: 700; letter-spacing: .34em; text-indent: .34em;
  color: #fff4d6;
  text-shadow: 0 0 14px rgba(255,205,115,1), 0 0 40px rgba(255,170,60,.75), 0 2px 6px rgba(90,60,10,.55);
}
.kunlun-sub {
  font-size: 11px; letter-spacing: .3em; text-indent: .3em;
  color: rgba(255,238,205,.95); text-shadow: 0 0 12px rgba(255,190,90,.9), 0 1px 3px rgba(90,60,10,.6);
}
/* Snow, falling after the range has risen. */
.kunlun-flake {
  position: absolute; top: -4%; width: 3px; height: 3px; border-radius: 50%;
  background: rgba(255,255,255,.9); box-shadow: 0 0 4px rgba(255,255,255,.8);
  animation: kunlun-fall linear forwards;
}
@keyframes kunlun-fall {
  0%   { opacity: 0; transform: translateY(0) translateX(0); }
  12%  { opacity: .95; }
  100% { opacity: 0; transform: translateY(104vh) translateX(var(--drift, 0px)); }
}
.kunlun-lever-btn[data-burst="1"] .kunlun-knob { box-shadow: 0 0 14px rgba(255,220,140,.95); }
`
  document.head.appendChild(el)
}

/** Deterministic-ish snow: positions and timings spread across the width. */
function flakes(count) {
  const out = []
  for (let i = 0; i < count; i++) {
    out.push({
      left: (i * 100) / count + (i % 3) * 1.7,
      delay: (i % 7) * 90,
      dur: 1400 + (i % 5) * 260,
      drift: ((i % 5) - 2) * 26,
      scale: 0.6 + ((i % 4) * 0.22),
    })
  }
  return out
}

const PEAKS_SVG = `
<svg class="kunlun-peaks" viewBox="0 0 1200 300" preserveAspectRatio="none" aria-hidden="true">
  <defs>
    <linearGradient id="kunlunPeakFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#eaf1fb" stop-opacity=".95"/>
      <stop offset="42%" stop-color="#8ea6c8" stop-opacity=".72"/>
      <stop offset="100%" stop-color="#2b3a55" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="kunlunPeakFill2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".9"/>
      <stop offset="55%" stop-color="#a9bcd8" stop-opacity=".55"/>
      <stop offset="100%" stop-color="#3a4a66" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <!-- rear range -->
  <path d="M0 300 L110 168 L196 226 L300 132 L392 214 L470 176 L560 244 L660 150 L760 228 L856 186 L950 246 L1050 190 L1200 262 L1200 300 Z"
        fill="url(#kunlunPeakFill2)" opacity=".55"/>
  <!-- front range, taller, with a snow cap -->
  <path d="M0 300 L90 214 L170 252 L282 96 L352 188 L430 150 L520 232 L628 120 L716 206 L806 158 L900 240 L1000 178 L1090 232 L1200 196 L1200 300 Z"
        fill="url(#kunlunPeakFill)"/>
</svg>`

const RIDGE_SVG = `
<svg class="kunlun-ridge" viewBox="0 0 1200 300" preserveAspectRatio="none" aria-hidden="true">
  <defs>
    <linearGradient id="kunlunRidgeGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffd98a" stop-opacity="0"/>
      <stop offset="42%" stop-color="#fff3cf" stop-opacity="1"/>
      <stop offset="58%" stop-color="#fff3cf" stop-opacity="1"/>
      <stop offset="100%" stop-color="#ffd98a" stop-opacity="0"/>
    </linearGradient>
    <animate attributeName="x1" values="-0.4;1.2" dur="1.6s" repeatCount="indefinite"/>
  </defs>
  <path d="M0 300 L90 214 L170 252 L282 96 L352 188 L430 150 L520 232 L628 120 L716 206 L806 158 L900 240 L1000 178 L1090 232 L1200 196"
        fill="none" stroke="url(#kunlunRidgeGrad)" stroke-width="2.5" stroke-linecap="round"/>
</svg>`
function createKunlunLever(ctx, react) {
  const slots = ctx.slots

  let unregister = null
  let controller = null

  function mount() {
    const { useState, useEffect, useRef, useSyncExternalStore, createElement: h, Fragment } = react

    function KunlunLever(face) {
      const snap = useSyncExternalStore(face.store.subscribe, face.store.getSnapshot)
      const { state, restoreLabel, busy, error, burst } = snap
      const [burstKey, setBurstKey] = useState(0)
      const [showBurst, setShowBurst] = useState(false)
      const seen = useRef(burst)
      const drag = useRef(null)
      const rootRef = useRef(null)

      // Replay the theatrical part once per landed switch, never for a refused one.
      useEffect(() => {
        if (burst !== seen.current) {
          seen.current = burst
          setBurstKey((k) => k + 1)
          setShowBurst(true)
          playKunlunTone(state === 'on' ? 'on' : 'off')
          const t = setTimeout(() => setShowBurst(false), BURST_MS)
          return () => clearTimeout(t)
        }
      }, [burst, state])

      const on = state === 'on'

      const onPointerDown = (e) => {
        drag.current = { y: e.clientY, fired: false }
        try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch {}
      }
      const onPointerMove = (e) => {
        if (!drag.current || drag.current.fired) return
        const dy = e.clientY - drag.current.y
        if (Math.abs(dy) < DRAG_THRESHOLD_PX) return
        drag.current.fired = true
        // Down = engage, up = release. Matches a physical lever beside the input.
        if (dy > 0 && !on) face.pull()
        else if (dy < 0 && on) face.push()
      }
      const onPointerUp = () => { drag.current = null }
      const onClick = () => {
        if (drag.current?.fired) return
        if (on) face.push(); else face.pull()
      }
      const onKeyDown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (on) face.push(); else face.pull() }
      }

      const label = on ? (face.t('on') || '昆仑模式') : (face.t('off') || '普通模式')
      const tip = on
        ? (restoreLabel ? `上拨恢复「${restoreLabel}」` : (face.t('pushUp') || '上拨恢复'))
        : (face.t('pullDown') || '拨下开启昆仑模式')
      const errText = error
        ? ({ locked: face.t('locked') || '会话已开始，模式不可再更改',
             missing: face.t('missing') || '没有找到该模式',
             timeout: face.t('timeout') || '切换超时，请重试',
             failed: error.reason })[error.kind]
        : null

      const nodes = [
        h('button', {
          key: 'btn',
          ref: rootRef,
          type: 'button',
          className: 'kunlun-lever-btn',
          'data-on': on ? '1' : '0',
          'data-busy': busy ? '1' : '0',
          'data-burst': showBurst ? '1' : '0',
          title: errText || tip,
          'aria-label': tip,
          'aria-pressed': on ? 'true' : 'false',
          onPointerDown, onPointerMove, onPointerUp, onClick, onKeyDown,
        },
          h('span', { key: 'arm', className: 'kunlun-arm' }, h('span', { className: 'kunlun-knob' })),
          h('span', { key: 'lab', className: 'kunlun-label' }, busy ? '…' : label),
        ),
      ]

      if (showBurst && on) {
        const fs = flakes(28)
        nodes.push(
          h('div', { key: 'burst-' + burstKey, className: 'kunlun-burst' },
            h('div', { className: 'kunlun-burst-inner' },
              h('div', { className: 'kunlun-glow' }),
              h('div', { className: 'kunlun-ring' }),
              h('div', { dangerouslySetInnerHTML: { __html: PEAKS_SVG } }),
              h('div', { dangerouslySetInnerHTML: { __html: RIDGE_SVG } }),
              h('div', { className: 'kunlun-banner' },
                h('div', { className: 'kunlun-title' }, '昆仑'),
                h('div', { className: 'kunlun-sub' }, 'K U N L U N   M O D E'),
              ),
              ...fs.map((f, i) => h('div', {
                key: 'f' + i,
                className: 'kunlun-flake',
                style: {
                  left: f.left + '%',
                  animationDelay: f.delay + 'ms',
                  animationDuration: f.dur + 'ms',
                  transform: `scale(${f.scale})`,
                  '--drift': f.drift + 'px',
                },
              })),
            ),
          ),
        )
      }

      return h(Fragment, null, ...nodes)
    }

    // The registration MUST be wrapped in `slots.inject(name, fn)`. `register` alone
    // installs the entry but the slot host never mounts it, so the lever silently never
    // renders — with no error on the page or in the console. `inject` is what tells the
    // slot host that this fiber claims that slot.
    ctx.slots.inject('conversation.input.right', () => {
      try {
        const off = slots.register(
          { name: 'conversation.input.right', id: 'kunlun-lever', order: 21, inject: () => controller.face() },
          KunlunLever,
        )
        return () => { try { off() } catch {} }
      } catch (e) {
        // Swallowing this silently is what hid the mount failure before. A broken lever
        // must not take the composer down, but it must be visible in the console.
        console.error('[kunlun] lever slot registration failed:', e)
        return () => {}
      }
    })
  }

  return {
    /** Called from the plugin's apply(), after the controller exists. */
    attach(c) {
      controller = c
      ensureStyle()
      try { mount() } catch (e) { console.error('[kunlun] lever mount failed:', e) }
    },
  }
}


// ── entry ────────────────────────────────────────────────────────
function apply(ctx) {
  var controller = new LeverController(ctx)
  ctx.effect(function () { return function () { controller.dispose() } }, 'kunlun: lever controller')
  controller.start()
  var lever = createKunlunLever(ctx, react)
  lever.attach(controller)
}

		exports.apply = apply;
		exports.inject = ["slots", "sessions", "remote", "remote.agentPresets"];
		exports.LeverController = LeverController;
		exports.KUNLUN_PRESET_ID = KUNLUN_PRESET_ID;
		return module.exports;
	}
});
