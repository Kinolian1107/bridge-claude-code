# claude-code-bridge installer (Windows)
# Usage: .\install.ps1
#
# Mirrors install.sh for Windows:
#   1. Checks Node.js >= 22
#   2. Detects the claude CLI binary
#   3. Creates .env pointing CLAUDE_BIN at the detected binary
#
# Start/stop scripts (start.ps1 / stop.ps1) ship with the repo.
# OpenClaw / Hermes integration scripts are Linux/macOS-only (set-*.sh).

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Defaults (override via environment before running)
$BridgePort = if ($env:BRIDGE_PORT) { $env:BRIDGE_PORT } else { "18793" }
$ClaudeModel = if ($env:CLAUDE_MODEL) { $env:CLAUDE_MODEL } else { "sonnet" }
$PermissionMode = if ($env:CLAUDE_PERMISSION_MODE) { $env:CLAUDE_PERMISSION_MODE } else { "bypassPermissions" }
# Tool mode default: 'llm' (pure model, no host tools) is the safe default for
# shared / LAN use. Set $env:BRIDGE_TOOL_MODE='agent' before install for a
# single-machine setup that wants the full Claude Code toolset on this host.
$ToolMode = if ($env:BRIDGE_TOOL_MODE) { $env:BRIDGE_TOOL_MODE } else { "llm" }

Write-Host ""
Write-Host "+----------------------------------------------------+"
Write-Host "|  claude-code-bridge installer (Windows)            |"
Write-Host "|  OpenAI/Anthropic-compatible proxy for Claude Code |"
Write-Host "+----------------------------------------------------+"
Write-Host ""

# -- 1. Check prerequisites ------------------------------------
Write-Host "Checking prerequisites..."

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "[FAIL] Node.js not found. Install Node >= 22 first: https://nodejs.org"
    exit 1
}
$nodeMajor = [int]((node -v) -replace '^v', '' -split '\.')[0]
if ($nodeMajor -lt 22) {
    Write-Host "[FAIL] Node.js >= 22 required (found $(node -v))"
    exit 1
}
Write-Host "[OK] Node.js $(node -v)"

# Claude Code CLI — resolve a REAL claude.exe (not a shim) so the bridge can
# spawn it directly. npm global installs DON'T put claude.exe on PATH; they only
# create shims (claude / claude.cmd / claude.ps1) that call the real binary at
#   <npm-prefix>\node_modules\@anthropic-ai\claude-code\bin\claude.exe
# winget / the native installer DO put a real claude.exe on PATH (and in
# ~/.local/bin or the WinGet Links dir).
$ClaudeBin = $null

# 1. A real claude.exe on PATH (native installer / winget) — but SKIP the
#    Claude Desktop App Execution Alias in %LOCALAPPDATA%\Microsoft\WindowsApps.
#    That alias launches the desktop GUI (spawning 10+ processes) instead of
#    running `claude -p` headlessly, and it sits high on PATH so it shadows the
#    real CLI. Enumerate all matches (-All) and take the first non-WindowsApps one.
foreach ($cmd in @(Get-Command claude.exe -All -ErrorAction SilentlyContinue)) {
    if ($cmd.Source -and $cmd.Source -notmatch '\\WindowsApps\\') {
        $ClaudeBin = $cmd.Source; break
    }
}

# 2. npm global install: ask npm where its global node_modules live, then look
#    up the package's bin/claude.exe (works even if npm's bin dir isn't on PATH).
if (-not $ClaudeBin -and (Get-Command npm -ErrorAction SilentlyContinue)) {
    try {
        $npmRoot = (& npm root -g 2>$null | Select-Object -First 1)
        if ($npmRoot) {
            $exe = Join-Path $npmRoot "@anthropic-ai\claude-code\bin\claude.exe"
            if (Test-Path $exe) { $ClaudeBin = $exe }
        }
    } catch { }
}

# 3. Derive from a shim on PATH: every npm shim sits right next to
#    node_modules\@anthropic-ai\claude-code\bin\claude.exe.
if (-not $ClaudeBin) {
    foreach ($name in @("claude.cmd", "claude.ps1", "claude")) {
        $shim = Get-Command $name -ErrorAction SilentlyContinue
        if ($shim -and $shim.Source) {
            $exe = Join-Path (Split-Path -Parent $shim.Source) "node_modules\@anthropic-ai\claude-code\bin\claude.exe"
            if (Test-Path $exe) { $ClaudeBin = $exe; break }
        }
    }
}

# 4. Known native / winget / default-npm-prefix install locations.
if (-not $ClaudeBin) {
    foreach ($candidate in @(
        (Join-Path $env:USERPROFILE ".local\bin\claude.exe"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\claude.exe"),
        (Join-Path $env:APPDATA "npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe")
    )) {
        if (Test-Path $candidate) { $ClaudeBin = $candidate; break }
    }
}

# 5. Last resort: a .ps1 shim (the bridge wraps it via powershell.exe).
if (-not $ClaudeBin) {
    $ps1 = Get-Command claude.ps1 -ErrorAction SilentlyContinue
    if ($ps1) {
        $ClaudeBin = $ps1.Source
        Write-Host "[WARN] Could not locate claude.exe; falling back to PowerShell shim:"
        Write-Host "       $ClaudeBin"
    }
}

if (-not $ClaudeBin) {
    $desktopAlias = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\Claude.exe"
    if (Test-Path $desktopAlias) {
        Write-Host "[FAIL] Only the Claude Desktop app (GUI) was found at:"
        Write-Host "       $desktopAlias"
        Write-Host "       The bridge needs the headless 'claude -p' CLI, which the desktop"
        Write-Host "       app does not provide. Install the CLI as well:"
    } else {
        Write-Host "[FAIL] Claude Code CLI not found. Install it first:"
    }
    Write-Host "       irm https://claude.ai/install.ps1 | iex"
    Write-Host "       # or: winget install Anthropic.ClaudeCode"
    Write-Host "       # or: npm install -g @anthropic-ai/claude-code"
    exit 1
}
Write-Host "[OK] Claude Code CLI: $ClaudeBin"

Write-Host ""
Write-Host "Selected model: $ClaudeModel"
Write-Host "  (Override with: `$env:CLAUDE_MODEL='<model-id>'; .\install.ps1)"
$modeNote = if ($ToolMode -eq "llm") { "pure model, no host tools" } else { "full Claude Code toolset on this host" }
Write-Host "Tool mode:      $ToolMode  ($modeNote)"
Write-Host "  (Override with: `$env:BRIDGE_TOOL_MODE='agent'; .\install.ps1)"
Write-Host ""

# -- 2. Create .env --------------------------------------------
$EnvFile = Join-Path $ScriptDir ".env"
if (Test-Path $EnvFile) {
    Write-Host "[WARN] .env already exists - leaving it untouched"
} else {
    $EnvContent = @"
# claude-code-bridge configuration
BRIDGE_PORT=$BridgePort
CLAUDE_MODEL=$ClaudeModel
CLAUDE_BIN=$ClaudeBin
# Tool mode: llm (pure model, no host tools - safe default for shared/LAN use)
#            or agent (full Claude Code toolset running on THIS host)
BRIDGE_TOOL_MODE=$ToolMode
# Permission mode below only applies in agent mode (ignored when llm)
CLAUDE_PERMISSION_MODE=$PermissionMode
# BRIDGE_API_KEY=   # set before exposing on a LAN (openssl rand -hex 32)
"@
    # WriteAllText emits UTF-8 *without* BOM on both Windows PowerShell 5.1 and
    # pwsh 7 (Set-Content -Encoding UTF8 adds a BOM on 5.1, which could confuse
    # Node's process.loadEnvFile).
    [System.IO.File]::WriteAllText($EnvFile, $EnvContent + "`n")
    Write-Host "[OK] Created $EnvFile"
}

# -- Done -------------------------------------------------------
Write-Host ""
Write-Host "+----------------------------------------------------------+"
Write-Host "|  Installation complete!                                  |"
Write-Host "+----------------------------------------------------------+"
Write-Host ""
Write-Host "  Start bridge:  .\start.ps1 daemon"
Write-Host "  Stop bridge:   .\stop.ps1"
Write-Host "  Test:          curl http://127.0.0.1:$BridgePort/health"
Write-Host ""
