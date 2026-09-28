---
name: preset-change-verification
description: Use when changing an agent preset, a Cordis composition, or any plugin bundle in this harness — especially before claiming it works. Covers the traps that have actually cost cycles here, and the rule that a change is not verified until a real session composes it.
whenToUse: Before editing agent.cordis.yml, a bundle patch, or preset modules; and whenever about to report that such a change works.
---

# Verifying preset and composition changes

## The one rule

**Reading the YAML proves nothing.** A preset is correct only when a real session
composes it and a real `request/header` comes back. Every breakage in this
project's history was invisible in the source and obvious at mount time:

- a waterfall listener returning the payload instead of the config produced
  `agent "…" has no provider/model` — the YAML looked fine;
- a row naming `@deepseek-ai/dsh-workflow-ptc` resolved nowhere, so the row
  silently never started;
- a renamed plugin directory left `file:///…` module paths pointing at a
  directory that no longer existed.

None of those are visible by reading. All of them are visible by mounting.

## The verification sequence

Run these in order. Each catches a class the previous one cannot.

1. **Regenerate, do not hand-edit.** The row block and the bundle are emitted by
   generators. Editing the emitted file directly means the next regeneration
   silently reverts you.
   ```powershell
   node <plugin>\gen-preset-row.mjs
   node <plugin>\build-bundle.mjs --write    # --write is REQUIRED; default is a dry run
   ```
   Forgetting `--write` produces a successful-looking run that changes nothing.

2. **Resolution check.** Every row's package must resolve from the *profile* root,
   which is where a preset bundle loads from — not from the DSH installation.
   ```js
   createRequire('<profile>/noop.js').resolve('<package>/package.json')
   ```
   A package can exist in `app.asar` and still be unresolvable here.

3. **Parity check.** Diff the composition against the shipped `standard` preset.
   Every extra row must be in an explicit allow-list; a substitution for an
   unresolvable row must be declared, not assumed.

4. **Falsify the check.** Add a bogus row, regenerate, confirm the check FAILS,
   then remove it and confirm it passes. A gate that has never failed is not
   known to work. **Add the bogus row inside the preset's `plugins:` list** — a
   bare top-level `- id:` is a *patch*, is correctly ignored, and will make a
   broken gate look like a working one.

5. **Mount for real.** Create a session under the preset and read
   `request/header`. Check the tool count, the payload size, and that the system
   prompt is not empty.

## Traps that have actually fired here

| Trap | Symptom | Cause |
|---|---|---|
| Reading `app.asar` with `fs` | "no such package" for a package that exists | it is an archive; parse the header or use the Electron runtime |
| `--no-open` omitted | a browser window opens on every test run | the web surface starts by default |
| Port 3080 orphaned | `EADDRINUSE` at boot, looks like a harness bug | an interrupted run left a detached process |
| Reading results mid-run | a plausible table describing a different run | two runners writing one results file |
| `JSON.stringify` on objects | "failures" where values are identical | key order differs and the task never specified one |
| One parser for both sides | a green gate over a broken fixture | the reference solution and the grader shared an assumption |
| PowerShell `Get-Content`/`Set-Content` | mojibake in paths and em-dashes | it round-trips UTF-8; use `[System.IO.File]::WriteAllText` |

## Assertion design

- **The reference solution must reach the answer by a different route than the
  code that produced the expected value.** If both derive from the same parse, the
  gate proves self-consistency, not solvability.
- **Read the grader's expected value when something fails.** In this project a
  preset was reported "worse at data work" because the expected value was
  `105-undefined-undefined` — malformed, and obvious on inspection.
- **Keep a control.** Run the shipped `standard` preset alongside anything under
  test. If the control fails identically, the harness is at fault, not the preset.

## Reporting

State the sample size, the control, and what was measured — not what was hoped.
If a metric did not move, say it did not move. A change that cannot be
distinguished from noise must not be described as an improvement.
