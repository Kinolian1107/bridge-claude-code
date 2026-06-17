# claude-code-bridge start script (Windows)
# Usage: .\start.ps1          (foreground)
#        .\start.ps1 daemon   (background, hidden window)
#
# .env is loaded by claude-code-bridge.mjs itself, so no env plumbing is needed here.
param([string]$Mode = "")

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Read BRIDGE_PORT from .env for the health check (default 18793)
$BridgePort = 18793
$EnvFile = Join-Path $ScriptDir ".env"
if (Test-Path $EnvFile) {
    $portLine = Select-String -Path $EnvFile -Pattern '^\s*BRIDGE_PORT\s*=\s*"?(\d+)"?' | Select-Object -First 1
    if ($portLine) { $BridgePort = [int]$portLine.Matches[0].Groups[1].Value }
}
if ($env:BRIDGE_PORT) { $BridgePort = [int]$env:BRIDGE_PORT }

# Read BRIDGE_HOST too, for display in the summary box (default 127.0.0.1)
$BridgeHost = "127.0.0.1"
if (Test-Path $EnvFile) {
    $hostLine = Select-String -Path $EnvFile -Pattern '^\s*BRIDGE_HOST\s*=\s*"?([^"\r\n]+)"?' | Select-Object -First 1
    if ($hostLine) { $BridgeHost = $hostLine.Matches[0].Groups[1].Value.Trim() }
}
if ($env:BRIDGE_HOST) { $BridgeHost = $env:BRIDGE_HOST }
# A 0.0.0.0 bind isn't a clickable URL — show loopback for the displayed endpoint.
$DisplayHost = if ($BridgeHost -in @("0.0.0.0", "")) { "127.0.0.1" } else { $BridgeHost }

# Detect already-running instances (by command line, not pid file)
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match "claude-code-bridge\.mjs" }
if ($existing) {
    $ids = ($existing | ForEach-Object { $_.ProcessId }) -join ", "
    Write-Host "claude-code-bridge is already running (PID(s): $ids)"
    exit 0
}

if ($Mode -eq "daemon") {
    Write-Host "Starting claude-code-bridge in background..."
    $proc = Start-Process node -ArgumentList "`"$(Join-Path $ScriptDir 'claude-code-bridge.mjs')`"" `
        -WorkingDirectory $ScriptDir -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2

    # First test after startup: the /health probe. Its JSON also carries the app
    # name + version + model + permission we display below, so the box reflects
    # the live server, not just what we think we launched.
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/health" -TimeoutSec 5
    } catch {
        Write-Host "[FAIL] Health check failed after startup. Check logs\ directory."
        exit 1
    }

    # ── Summary box (pure-ASCII so it renders on any Windows console) ──
    $W = 58
    function BLine($t)   { if ($t.Length -gt $W) { $t = $t.Substring(0, $W) }; "|" + $t.PadRight($W) + "|" }
    function BCenter($t) { if ($t.Length -gt $W) { $t = $t.Substring(0, $W) }; $p = $W - $t.Length; $l = [int]($p / 2); "|" + (" " * $l) + $t + (" " * ($p - $l)) + "|" }
    $border = "+" + ("-" * $W) + "+"
    $apiKeyLabel = if ($health.supports.bearer_auth) { "required (BRIDGE_API_KEY)" } else { "none (keep on localhost)" }
    $base = "http://${DisplayHost}:$BridgePort"

    Write-Host ""
    Write-Host $border
    Write-Host (BCenter "$($health.service) v$($health.version)")
    Write-Host (BCenter "OpenAI + Anthropic API  ->  Claude Code CLI")
    Write-Host $border
    Write-Host (BLine "  Test:       GET /health -> [OK] $($health.status)")
    Write-Host (BLine "  PID:        $($proc.Id)")
    Write-Host (BLine "  Endpoint:   $base/v1/chat/completions")
    Write-Host (BLine "  Health:     $base/health")
    # The URL above uses loopback (0.0.0.0 isn't a usable URL host); make the
    # actual wildcard bind scope explicit so users know it's reachable LAN-wide.
    if ($BridgeHost -eq "0.0.0.0") {
        Write-Host (BLine "  Listening:  0.0.0.0:$BridgePort (wildcard - all interfaces)")
    }
    Write-Host (BLine "  Model:      $($health.model)")
    Write-Host (BLine "  Permission: $($health.permissionMode)")
    Write-Host (BLine "  API key:    $apiKeyLabel")
    Write-Host (BLine "  Logs:       .\logs\")
    Write-Host $border
    Write-Host (BLine "  Stop:       .\stop.ps1")
    Write-Host $border
    Write-Host ""
} else {
    node (Join-Path $ScriptDir "claude-code-bridge.mjs")
}
