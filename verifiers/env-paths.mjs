// Where things are, resolved at RUN time instead of hardcoded.
//
// Every verifier used to open with three absolute constants naming this machine:
//
//     const EXE     = 'D:\\软件安装\\Dsh官方\\DeepSeek Harness.exe'
//     const DSH     = 'D:\\软件安装\\Dsh官方\\resources\\app.asar\\dsh'
//     const PROFILE = 'C:\\Users\\Lenovo\\.dsh\\profiles\\desktop'
//
// That made the whole suite unusable for anyone else, and it silently verified the
// wrong tree after the preset was renamed. Discovery order below is deliberate:
// an explicit environment variable wins, so a test can point the suite at an
// isolated profile and be sure it is measuring that profile.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const isWin = process.platform === 'win32'

// ── 1. The harness home ─────────────────────────────────────────────────────
export const DSH_HOME = process.env.DSH_HOME
  || (isWin
    ? path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
    : path.join(os.homedir(), '.dsh'))

// ── 2. The profile ──────────────────────────────────────────────────────────
export const PROFILE = process.env.DSH_PROFILE_DIR
  || path.join(DSH_HOME, 'profiles', 'desktop')

// ── 3. The installed preset bundle ──────────────────────────────────────────
export const BUNDLE = path.join(PROFILE, 'node_modules', 'kunlun-preset-bundle')

// ── 3b. This plugin's own source directory ──────────────────────────────────
//
// Several suites compare the installed copy against the canonical source, so they
// need both. This module sits in the source directory, so its own location IS the
// answer — no discovery needed, and it stays correct wherever the plugin is checked
// out.
export const PLUGIN = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

// ── 4. The harness executable, and the asar it loads ────────────────────────
//
// The app is installed by the user, so its location varies. These candidates cover
// the shipped layout plus a few plausible alternatives; the first that exists wins.
// DSH_EXE and DSH_ASAR override everything, for a non-standard install.
function findHarness() {
  const exeNames = isWin
    ? ['DeepSeek Harness.exe', 'DeepSeekHarness.exe']
    : ['DeepSeek Harness', 'deepseek-harness']

  const roots = [
    process.env.DSH_INSTALL_DIR,
    'D:\\软件安装\\Dsh官方',
    'C:\\Program Files\\DeepSeek Harness',
    'C:\\Program Files (x86)\\DeepSeek Harness',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness') : null,
    '/Applications/DeepSeek Harness.app/Contents/MacOS',
    '/opt/DeepSeek Harness',
  ].filter(Boolean)

  let exe = process.env.DSH_EXE || null
  if (!exe) {
    for (const r of roots) {
      for (const n of exeNames) {
        const p = path.join(r, n)
        if (fs.existsSync(p)) { exe = p; break }
      }
      if (exe) break
    }
  }

  // The JS half lives inside app.asar, which is an ARCHIVE, not a directory.
  let asar = process.env.DSH_ASAR || null
  if (!asar && exe) {
    const cand = path.join(path.dirname(exe), 'resources', 'app.asar', 'dsh')
    // existsSync returns false for a path inside an asar, so accept it when the
    // archive itself is present and let the caller fail loudly if it cannot load.
    const asarFile = path.join(path.dirname(exe), 'resources', 'app.asar')
    if (fs.existsSync(asarFile)) asar = cand
  }
  if (!asar) asar = 'D:\\软件安装\\Dsh官方\\resources\\app.asar\\dsh'
  return { exe, asar }
}

const harness = findHarness()
export const EXE = harness.exe
export const DSH = harness.asar

// The app.asar ARCHIVE itself (not the dsh/ subtree inside it). Some suites read the
// archive's JSON header directly, so they need the path to the file.
export const ASAR_ROOT = EXE && fs.existsSync(path.join(path.dirname(EXE), 'resources', 'app.asar'))
  ? path.join(path.dirname(EXE), 'resources', 'app.asar')
  : path.dirname(DSH)

// ── 5. Report what was found, so a wrong guess is visible ───────────────────
export function describe() {
  const rows = [
    ['dsh home', DSH_HOME, fs.existsSync(DSH_HOME)],
    ['profile', PROFILE, fs.existsSync(PROFILE)],
    ['bundle', BUNDLE, fs.existsSync(BUNDLE)],
    ['harness exe', EXE ?? '(not found)', !!EXE && fs.existsSync(EXE)],
    ['app.asar/dsh', DSH, true],
  ]
  for (const [label, p, ok] of rows) {
    console.log('  ' + (ok ? 'ok  ' : 'MISS') + ' ' + label.padEnd(14) + ' ' + p)
  }
}

// A verifier is worthless if it silently runs against the wrong tree, so callers
// check these before doing any work.
export function requireProfile() {
  if (!fs.existsSync(PROFILE)) {
    throw new Error('profile not found: ' + PROFILE + '\nSet DSH_PROFILE_DIR to the profile you mean to test.')
  }
  return PROFILE
}
export function requireExe() {
  if (!EXE || !fs.existsSync(EXE)) {
    throw new Error(
      'the DeepSeek Harness executable was not found.\n' +
      'Set DSH_EXE to its full path, or DSH_INSTALL_DIR to its folder.\n' +
      'Looked in: ' + (process.env.DSH_INSTALL_DIR || 'the default install locations'))
  }
  return EXE
}

export default { DSH_HOME, PROFILE, BUNDLE, EXE, DSH, describe, requireProfile, requireExe }
