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

export class LeverController {
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

export { KUNLUN_PRESET_ID, SELECT_TIMEOUT_MS }
