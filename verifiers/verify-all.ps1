# Run every 昆仑 verification suite and report a single verdict.
#
# Usage:
#   & ./verify-all.ps1
#   & ./verify-all.ps1 -Profile "D:\some\other\profile"
#
# Every path is discovered, so this works on any machine. Override with:
#   $env:DSH_NODE_BIN    the node executable to use
#   $env:DSH_PROFILE_DIR the profile to test
#   $env:DSH_EXE         the DeepSeek Harness executable
#
# The suite is run from the PLUGIN SOURCE directory, and each suite resolves the
# harness packages through the shared env-paths.mjs module. Suites that need the
# installed copy (verify-plugin.mjs) are skipped with a clear reason rather than
# reported as failures, because a suite that cannot import its dependencies is not
# evidence about the preset.

param(
  [string]$Profile = $env:DSH_PROFILE_DIR
)

$ErrorActionPreference = 'Stop'

# ── Locate node ─────────────────────────────────────────────────────────────
function Find-Node {
  if ($env:DSH_NODE_BIN -and (Test-Path $env:DSH_NODE_BIN)) { return $env:DSH_NODE_BIN }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  throw 'node was not found. Set DSH_NODE_BIN to its full path.'
}

# ── Locate the plugin and profile ───────────────────────────────────────────
$plugin = $PSScriptRoot
if (-not $Profile) {
  $Profile = if ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'profiles\desktop' }
             elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
             else { Join-Path $HOME '.dsh/profiles/desktop' }
}

$node = Find-Node
Write-Host "node    : $node"
Write-Host "source  : $plugin"
Write-Host "profile : $Profile"
Write-Host ''

if (-not (Test-Path $Profile)) {
  Write-Host "FAIL  the profile does not exist: $Profile"
  Write-Host '      Set DSH_PROFILE_DIR (or -Profile) to the profile you mean to test.'
  Write-Host '      Refusing to continue, because every check below would measure nothing.'
  exit 1
}

# ── The suites that run from the source tree ────────────────────────────────
# All of these import env-paths.mjs, so they resolve the harness themselves.
$suites = @(
  'verify-parity.mjs',          # equals the shipped standard preset + declared extras
  'verify-waterfall.mjs',       # every module honours the waterfall contract
  'verify-configs.mjs',         # every row satisfies its plugin's config schema
  'verify-services.mjs',        # no row re-binds a service the host owns
  'verify-isolate.mjs',         # preset services run in isolate realms
  'verify-resolvable.mjs',      # every package a row names actually resolves
  'verify-declaration.mjs',     # the preset is declared exactly once
  'verify-module-config.mjs',   # no valueless YAML key where an array is required
  'verify-session-format.mjs'   # stored sessions stay loadable (v4 source kinds)
)

$failed = 0
$passed = 0
$skipped = 0

foreach ($suite in $suites) {
  $p = Join-Path $plugin $suite
  if (-not (Test-Path $p)) {
    Write-Host ("  {0,-26} SKIP  (not present)" -f $suite)
    $skipped++
    continue
  }
  $out = & $node $p 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) {
    Write-Host ("  {0,-26} PASS" -f $suite)
    $passed++
  } else {
    Write-Host ("  {0,-26} FAIL" -f $suite)
    ($out -split "`n" | Where-Object { $_ -match 'Error|FAIL|missing|unexpected' } | Select-Object -First 6) |
      ForEach-Object { Write-Host "        $_" }
    $failed++
  }
}

# ── Suites needing the installed copy ───────────────────────────────────────
# verify-plugin.mjs imports @deepseek-ai/schemastery, which only resolves from the
# profile's node_modules. Running it here would fail for a reason that says nothing
# about the preset, so it is reported as skipped with the reason.
$installedDirs = @('dsh-kunlun', 'kunlun-preset-bundle') |
  ForEach-Object { Join-Path $Profile "node_modules\$_" } |
  Where-Object { Test-Path $_ }

if ($installedDirs.Count -and (Test-Path (Join-Path $plugin 'verify-plugin.mjs'))) {
  foreach ($dir in $installedDirs) {
    $vp = Join-Path $dir 'verify-plugin.mjs'
    if (-not (Test-Path $vp)) { continue }
    $out = & $node $vp 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
      Write-Host ("  {0,-26} PASS" -f 'verify-plugin.mjs')
      $passed++
    } else {
      Write-Host ("  {0,-26} FAIL" -f 'verify-plugin.mjs')
      $failed++
    }
  }
} else {
  Write-Host ("  {0,-26} SKIP  (needs the installed copy; run the installer first)" -f 'verify-plugin.mjs')
  $skipped++
}

Write-Host ''
if ($failed -eq 0) {
  Write-Host "ALL SUITES PASSED  ($passed passed, $skipped skipped)"
  exit 0
}
Write-Host "$failed CHECK(S) FAILED  ($passed passed, $skipped skipped)"
exit 1
