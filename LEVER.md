# Adding a browser half to 昆仑 — the four silent failures

昆仑's composer lever (the snow-peak burst and the startup tone) is a **client plugin**,
which is a different mechanism from the agent preset. This file records what it takes to
mount one, because **every failure in this area is silent**: nothing appears in the GUI,
nothing appears in the console, and the profile boots happily. Four separate bugs each
produced a working-looking startup and a missing lever.

## The four failures, in the order they bit

### 1. The bundle overlay was missing

```
dsh: skipping profile bundle "dsh-kunlun": failed to read overlay
  node_modules\dsh-kunlun\cordis.patch.yml: ENOENT
```

A profile bundle is composed from its own `cordis.patch.yml`. If that file is absent the
launcher skips **the entire bundle** — the plugin's host half and client half both vanish —
and the only trace is one line of stderr that scrolls past.

The very first version of `cordis.patch.yml` in this directory was the stale 白泽 file,
which inserts a `baize-preset` row. It parsed fine and did nothing.

**Fix:** `install-client.mjs` copies `cordis.patch.yml` and fails loudly if it is absent.

### 2. The row used a shell subpath that does not exist

```yaml
- insert:
    - id: web-ui-kunlun
      name: "dsh-kunlun/shell"     # no such export
```

The `@linxin666/dsh-web-all` aggregate mounts family plugins through its own `shells/*`
indirection with the real package name in `config.plugin`. That indirection belongs to
that aggregate. For a standalone package the row names **the package itself**:

```yaml
- insert:
    - id: web-ui-kunlun
      name: dsh-kunlun
```

A row whose spec does not resolve is dropped with no error.

### 3. `slots.register` without `slots.inject` mounts nothing

This was the subtlest one. Registering the entry is not enough:

```js
// WRONG — the entry exists, the slot host never mounts it
ctx.slots.register({ name: 'conversation.input.right', ... }, Component)
```

The registration must be wrapped so the fiber *claims* the slot:

```js
// RIGHT
ctx.slots.inject('conversation.input.right', () => {
  const off = ctx.slots.register({ name: 'conversation.input.right', ... }, Component)
  return () => off()
})
```

The proof was in the live DOM: the composer published `data-slot="conversation.input.right"`
and 梁神's lever was rendering inside it, while ours was absent from the same element. The
slot existed and worked; we simply never joined it.

### 4. `sessions.current()` does not exist

The controller resolved the session with a method that is not on the service. Because the
call was inside `try { } catch { }`, every click returned `undefined` and the gesture did
nothing — no error, no state change, no console output.

The real API:

```js
const state = ctx.sessions.list.getSnapshot()      // { byId, ... }
const row = Object.values(state.byId)
  .find((r) => (r.retainedBy?.mainView ?? 0) > 0)  // the session owning the main view
row.id                                             // session id
row.projectionValues.agentPreset                   // its current preset
```

**Fix:** read the snapshot store; do not invent a method.

## Rules that follow

1. **Never `catch {}` around a gesture handler.** All four bugs above were invisible
   because failures were swallowed. Log to the console instead.
2. **Verify in a real browser.** Static checks cannot distinguish "installed" from
   "mounted". `verify-lever-browser.mjs` does exactly this and caught every one of these.
3. **The lever listens for `pointerdown`.** Puppeteer's `click()` dispatches mouse events
   only; dispatch a real `PointerEvent` sequence in tests.
4. **A screenshot is evidence.** The first passing run still had a glow flooding the page
   and the banner on top of the composer — both invisible to assertions.
5. **Make tests order-independent.** The preset persists across runs, so a second run
   started already-ON and the activation burst never fired. Normalise state first.

## Files

| File | Role |
| --- | --- |
| `src/lever.js` | the component, the burst CSS, the Web Audio tone |
| `src/lever-controller.js` | roster, session resolution, the preset switch |
| `src/client.js` | the browser entry (`apply` + `inject`) |
| `build-client.mjs` | wraps the sources in `window.__ModuleLoader__.load` |
| `install-client.mjs` | copies the package into the profile and registers the bundle |
| `cordis.patch.yml` | the bundle overlay that mounts `web-ui-kunlun` |

## Install

```sh
node build-client.mjs      # regenerate lib/client.js from src/
node install-client.mjs    # copy into the profile + register the bundle
```

Then **restart the desktop app**. The client half is loaded at boot; there is no hot
reload for a newly mounted client module.
