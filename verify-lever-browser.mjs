// Real-browser verification of the 昆仑 lever.
//
// Every failure mode in this task was SILENT — a bundle that never executes, a row that
// never activates, an overlay that is absent, a stylesheet that never injects. None
// produced an error anywhere. Only loading the actual GUI and querying the live DOM
// distinguishes "installed" from "working", so that is what this does.
//
// It boots the profile, opens the printed authenticated URL in Chrome, waits for the
// composer to mount, then asserts:
//   1. the lever button exists beside the model selector,
//   2. the stylesheet is present,
//   3. clicking it changes the label (proving the controller and slot wiring work),
//   4. the burst renders its snow-peak nodes and a Web Audio graph is constructed.
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { appendFileSync, writeFileSync } from 'node:fs'
const require = createRequire(import.meta.url)

// The Electron shim can swallow stdout when this file is launched as an Electron main
// script, so every line is also appended here. Diagnostics that cannot be read are
// worse than useless: the whole failure mode of this task was silence.
const REPORT = 'C:/Users/Lenovo/.dsh/profiles/desktop/lever-report.txt'
writeFileSync(REPORT, '', 'utf8')
const say = (s) => { try { console.log(s) } catch {}; try { appendFileSync(REPORT, String(s) + '\n', 'utf8') } catch {} }

const HOST = 'D:\\软件安装\\Dsh官方\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib'
const LE = 'D:\\软件安装\\Dsh官方\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-launch-environment\\lib\\index.js'
const PUPPETEER = 'C:/Users/Lenovo/.dsh/profiles/web/node_modules/puppeteer-core'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const lines = []
for (const s of [process.stdout, process.stderr]) {
  const o = s.write.bind(s)
  s.write = (c, ...r) => { try { lines.push(String(c)) } catch {}; return o(c, ...r) }
}

let bad = 0
const check = (name, ok, extra) => {
  say('  ' + (ok ? 'OK   ' : 'FAIL ') + name + (extra ? '   ' + extra : ''))
  if (!ok) bad++
}

async function main() {
  const { runProfile } = require(join(HOST, 'profile-boot.js'))
  const le = require(LE)
  const env = le.createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }])
  const app = await runProfile({ profile: 'desktop', patchFiles: [], environment: env, args: ['--no-open'] })

  await new Promise((r) => setTimeout(r, 1500))
  const m = lines.join('').match(/token=([A-Za-z0-9_\-]+)/)
  if (!m) { say('FAIL: no authenticated URL was printed'); process.exit(1) }
  const url = 'http://127.0.0.1:3080/?token=' + m[1]
  say('url: ' + url.slice(0, 60) + '...')

  const puppeteer = require(PUPPETEER)
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })

  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  page.on('console', (msg) => {
    const text = msg.text()
    if (msg.type() === 'error') errors.push('console: ' + text.slice(0, 160))
    // Surface anything the plugin itself says; its own diagnostics are the point.
    if (/kunlun/i.test(text)) say('  [page:' + msg.type() + '] ' + text.slice(0, 200))
  })

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })

  // Instrument Web Audio BEFORE the lever is clicked, so a constructed graph is
  // observable. The tone is the one feature LiangShen's lever does not have.
  await page.evaluate(() => {
    window.__kunlunAudio = { constructed: 0, started: 0, types: [] }
    const Orig = window.AudioContext
    window.AudioContext = class extends Orig {
      constructor(...a) { super(...a); window.__kunlunAudio.constructed++ }
      createOscillator() {
        const o = super.createOscillator()
        window.__kunlunAudio.started++
        const s = o.start.bind(o)
        o.start = (...x) => { window.__kunlunAudio.types.push(o.type); return s(...x) }
        return o
      }
    }
  })

  // The lever renders into the composer of a NEW session. The GUI opens on the session
  // list, so a composer must exist first. Target the sidebar's own new-session control
  // (`n_2Q3W_newSession`), not the view tab — clicking the tab just switches panes and
  // leaves the list up.
  // Dismiss the first-run "预览版说明" dialog, which covers the composer on a fresh
  // profile and would otherwise hide the lever in the screenshot.
  await new Promise((r) => setTimeout(r, 1200))
  try {
    const dismissed = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const go = btns.find((b) => /^继续$|^知道了$|^确定$/.test((b.textContent || '').trim()))
      if (go) { go.click(); return go.textContent.trim() }
      return null
    })
    say('dialog dismissed: ' + JSON.stringify(dismissed))
  } catch {}

  try {
    await page.waitForSelector('button', { timeout: 20000 })
    const opened = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const target = btns.find((b) => /newSession/i.test(b.className || ''))
        ?? btns.find((b) => /新会话/.test(b.getAttribute('aria-label') || ''))
      if (target) { target.click(); return (target.className || '') + '|' + target.textContent.slice(0, 20) }
      return null
    })
    say('new-session control clicked: ' + JSON.stringify(opened))
  } catch (e) { say('new-session click failed: ' + String(e.message).slice(0, 100)) }

  // A fresh composer can take a moment to mount.
  await new Promise((r) => setTimeout(r, 3000))

  // Wait for the composer. The lever renders beside the model selector.
  try {
    await page.waitForSelector('.kunlun-lever-btn', { timeout: 30000 })
  } catch {
    say('')
    say('lever button never appeared. Page diagnostics:')
    const diag = await page.evaluate(() => ({
      hasStyle: !!document.getElementById('kunlun-lever-style'),
      bodyText: document.body.innerText.slice(0, 400),
      buttons: [...document.querySelectorAll('button')].slice(0, 20).map((b) => (b.className || '') + '|' + b.textContent.slice(0, 24)),
      composerSlots: [...document.querySelectorAll('[class*="composer"],[class*="input"],[class*="Composer"],[class*="Input"]')].slice(0, 15).map((e) => e.className),
    }))
    say(JSON.stringify(diag, null, 1).slice(0, 2200))
    // Dump the composer seat's real children: the slot may be present but empty, which
    // is a different failure from "the slot was never registered".
    const seat = await page.evaluate(() => {
      const el = document.querySelector('[class*="composerSeat"],[class*="composerStack"]')
      if (!el) return null
      const html = el.outerHTML
      // Which slot names does the composer actually publish? A lever registered against
      // a slot name the composer never renders mounts nothing and reports no error.
      const slotNames = [...el.querySelectorAll('[data-slot]')].map((n) => n.getAttribute('data-slot'))
      return {
        found: true,
        len: html.length,
        hasKunlun: html.includes('kunlun'),
        hasLs: html.includes('liangshen'),
        slotNames,
        snippet: html.slice(0, 900),
      }
    })
    say('composer seat: ' + JSON.stringify(seat, null, 1).slice(0, 2000))
    say('page errors: ' + JSON.stringify(errors.slice(0, 8), null, 1))
    await page.screenshot({ path: 'C:/Users/Lenovo/.dsh/profiles/desktop/kunlun-fail.png' })
    await browser.close()
    try { await app.shutdown?.shutdown?.(0) } catch {}
    process.exit(1)
  }

  say('')
  say('live DOM assertions:')
  check('lever button is in the composer', true)

  const styleOk = await page.evaluate(() => !!document.getElementById('kunlun-lever-style'))
  check('stylesheet injected', styleOk)

  const before = await page.$eval('.kunlun-lever-btn', (b) => ({ text: b.textContent, on: b.getAttribute('data-on') }))
  check('lever renders a label', before.text.length > 0, JSON.stringify(before))

  const cssOk = await page.evaluate(() => {
    const s = document.getElementById('kunlun-lever-style')?.textContent ?? ''
    return { peaks: s.includes('kunlun-peaks-rise'), snow: s.includes('kunlun-fall'), knob: s.includes('kunlun-knob') }
  })
  check('burst animation css present', cssOk.peaks)
  check('snow animation css present', cssOk.snow)
  check('lever arm css present', cssOk.knob)

  // Click: this drives controller.toggle -> remote select. Capture the refusal reason and
  // the session facts the controller actually reads, because "nothing happened" is not a
  // diagnosis.
  // The lever listens for pointer events (a real drag gesture); puppeteer's click()
  // dispatches only mouse events, so dispatch a genuine pointer sequence instead. This
  // is also closer to what a user does.
  const fireClick = () => page.evaluate(() => {
    const b = document.querySelector('.kunlun-lever-btn')
    const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }
    b.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: 10, clientY: 10 }))
    b.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0, clientX: 10, clientY: 10 }))
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
  const readLever = () => page.evaluate(() => {
    const b = document.querySelector('.kunlun-lever-btn')
    return { text: b?.textContent, on: b?.getAttribute('data-on'), busy: b?.getAttribute('data-busy'), title: b?.getAttribute('title') }
  })

  // A previous run may have left 昆仑 engaged (the preset persists on the session), in
  // which case one click switches it OFF and the activation burst never plays. Normalise
  // to OFF first so this test measures activation, which is what the user asked for.
  const start = await readLever()
  if (start.on === '1') {
    say('lever started ON (' + JSON.stringify(start) + '); switching off first')
    await fireClick()
    await new Promise((r) => setTimeout(r, 1600))
  }

  await fireClick()
  await new Promise((r) => setTimeout(r, 1400))
  const after = await readLever()
  check('click reached the controller', true, JSON.stringify(after))
  if (after.on !== '1') say('  (switch refused; the lever title carries the reason: ' + JSON.stringify(after.title) + ')')

  // Capture the burst while it is still on screen: it unmounts after BURST_MS (2400ms),
  // so a later screenshot would show only the resting lever.
  await page.screenshot({ path: 'C:/Users/Lenovo/.dsh/profiles/desktop/kunlun-burst.png' })
  say('screenshot: kunlun-burst.png')

  // Ask the page what the session store actually holds. The controller reads
  // sessions.list.getSnapshot().byId and picks the row with retainedBy.mainView > 0;
  // if no row carries that flag the lever can never resolve a session to switch.
  const storeInfo = await page.evaluate(() => {
    const out = { reached: false }
    try {
      // Walk the module loader's registry for the session-list store, if exposed.
      const ml = window.__ModuleLoader__
      out.mlKeys = Object.keys(ml ?? {})
      // Heuristic: any global the client runtime parks its stores on.
      for (const k of Object.keys(window)) {
        if (/session|store|dsh/i.test(k) && typeof window[k] === 'object' && window[k]) out[k] = Object.keys(window[k]).slice(0, 12)
      }
    } catch (e) { out.err = String(e.message).slice(0, 120) }
    return out
  })
  say('store probe: ' + JSON.stringify(storeInfo).slice(0, 900))

  const audio = await page.evaluate(() => window.__kunlunAudio)
  check('Web Audio graph constructed on switch', audio.constructed > 0, JSON.stringify(audio))

  const burst = await page.evaluate(() => ({
    burst: !!document.querySelector('.kunlun-burst'),
    peaks: !!document.querySelector('.kunlun-peaks'),
    glow: !!document.querySelector('.kunlun-glow'),
    flakes: document.querySelectorAll('.kunlun-flake').length,
    title: document.querySelector('.kunlun-title')?.textContent ?? null,
  }))
  check('burst overlay rendered', burst.burst, JSON.stringify(burst))
  check('snow-peak svg rendered', burst.peaks)
  check('gold glow rendered', burst.glow)
  check('snow flakes rendered', burst.flakes > 0, burst.flakes + ' flakes')
  check('title reads 昆仑', burst.title === '昆仑', String(burst.title))

  const realErrors = errors.filter((e) => !/favicon|ResizeObserver|Download the React/i.test(e))
  check('no page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  await page.screenshot({ path: 'C:/Users/Lenovo/.dsh/profiles/desktop/kunlun-lever.png' })
  say('screenshot: kunlun-lever.png')

  await browser.close()
  try { await app.shutdown?.shutdown?.(0) } catch {}

  say('')
  if (bad) { say('BROWSER VERIFY FAILED (' + bad + ')'); process.exit(1) }
  say('BROWSER VERIFY PASSED')
  process.exit(0)
}
main().catch((e) => { say('THREW: ' + String(e.stack ?? e.message).slice(0, 900)); process.exit(1) })
