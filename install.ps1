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

# Claude Code CLI — PATH first, then the default native-install location.
$ClaudeBin = $null
foreach ($name in @("claude", "claude.cmd", "claude.exe")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $ClaudeBin = $cmd.Source; break }
}
if (-not $ClaudeBin) {
    foreach ($candidate in @(
        (Join-Path $env:USERPROFILE ".local\bin\claude.exe"),
        (Join-Path $env:USERPROFILE ".local\bin\claude.cmd")
    )) {
        if (Test-Path $candidate) { $ClaudeBin = $candidate; break }
    }
}
if (-not $ClaudeBin) {
    Write-Host "[FAIL] Claude Code CLI not found. Install it first:"
    Write-Host "       npm install -g @anthropic-ai/claude-code"
    exit 1
}
Write-Host "[OK] Claude Code CLI: $ClaudeBin"

Write-Host ""
Write-Host "Selected model: $ClaudeModel"
Write-Host "  (Override with: `$env:CLAUDE_MODEL='<model-id>'; .\install.ps1)"
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
