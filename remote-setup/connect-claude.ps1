# connect-claude.ps1 — point THIS machine's Claude Code at a remote
# bridge-claude-code host, then launch it in the current project directory.
#
# Copy this file onto a client machine (e.g. into your project folder) and run it
# from PowerShell while sitting in the project you want to work on:
#
#     .\connect-claude.ps1                 # connect + launch claude in this folder
#     .\connect-claude.ps1 -NoLaunch       # only set the redirect in this shell
#     .\connect-claude.ps1 -Persist        # also save the redirect for future shells
#     .\connect-claude.ps1 -p "hello"      # forward extra args straight to claude
#
# How it works: it sets ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN so Claude Code talks
# to the bridge's Anthropic-compatible endpoint instead of api.anthropic.com, and marks
# hasCompletedOnboarding=true in ~/.claude.json so interactive `claude` skips its startup
# call to api.anthropic.com (which otherwise fails with ECONNRESET where Anthropic is
# blocked — claude-code issues #26935 / #36998). The claude.ai subscription / auth lives
# on the BRIDGE HOST, so this machine only needs the Claude Code CLI installed — no login.
#
# ── Configure these once, then distribute ───────────────────────────────────
#   $BridgeHost : the machine running bridge-claude-code (its LAN IPv4)
#   $Port       : its BRIDGE_PORT
#   $ApiKey     : its BRIDGE_API_KEY (from the host's .env / start.ps1 output);
#                 leave "" if the bridge has no key set.

[CmdletBinding()]
param(
    [string]$BridgeHost = "10.101.0.1",
    [int]   $Port       = 12345,
    [string]$ApiKey     = "apikey-XXXXXX",
    [switch]$NoLaunch,
    [switch]$Persist,
    [Parameter(ValueFromRemainingArguments = $true)]
    $ClaudeArgs
)

$ErrorActionPreference = "Stop"
$BaseUrl = "http://${BridgeHost}:$Port"

Write-Host ""
Write-Host "Connecting Claude Code  ->  $BaseUrl"

# 1) Health check first, so we fail fast with an actionable message.
try {
    $h = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 5
    $authState = if ($h.supports.bearer_auth) { "required" } else { "none" }
    Write-Host "[OK] Bridge reachable: $($h.service) v$($h.version)  (model=$($h.model), auth=$authState)"
    if ($h.supports.bearer_auth -and -not $ApiKey) {
        Write-Host "[WARN] The bridge requires a key but -ApiKey is empty. Set it to the host's BRIDGE_API_KEY or requests will 401."
    }
} catch {
    Write-Host "[FAIL] Cannot reach $BaseUrl/health : $($_.Exception.Message)"
    Write-Host "       - Is bridge-claude-code running on ${BridgeHost}?"
    Write-Host "       - Firewall open for TCP $Port on the host? (run its firewall-rule-add-port-$Port.ps1 as Administrator)"
    Write-Host "       - Host bound to 0.0.0.0? On the host: netstat -ano | findstr :$Port  (expect 0.0.0.0:$Port LISTENING)"
    exit 1
}

# 2) Redirect Claude Code. $env: is process-scoped, so it persists in THIS shell
#    (when run as .\connect-claude.ps1) and is inherited by the claude we launch.
$key = if ($ApiKey) { $ApiKey } else { "bridge-no-key" }
$env:ANTHROPIC_BASE_URL   = $BaseUrl
$env:ANTHROPIC_AUTH_TOKEN = $key   # gateway-standard: sent as Authorization: Bearer
$env:ANTHROPIC_API_KEY    = $key   # also sent as x-api-key (the bridge accepts either)
# Cut Claude Code's non-essential calls to anthropic.com (telemetry / auto-update /
# error reporting); they hang or fail where api.anthropic.com is blocked.
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
Write-Host "[OK] Set ANTHROPIC_BASE_URL + auth (AUTH_TOKEN/API_KEY) for this session."

# 2b) IMPORTANT: interactive `claude` contacts api.anthropic.com on startup and ignores
#     ANTHROPIC_BASE_URL until onboarding is marked complete (claude-code #26935 / #36998).
#     In a region where api.anthropic.com is blocked that fails with ECONNRESET, even
#     though the bridge is reachable. Mark onboarding done in ~/.claude.json so the
#     startup check is skipped and traffic routes through the bridge.
$claudeJson = Join-Path $env:USERPROFILE ".claude.json"
try {
    if (Test-Path $claudeJson) {
        $cfg = Get-Content $claudeJson -Raw | ConvertFrom-Json
        if (-not $cfg.hasCompletedOnboarding) {
            Copy-Item $claudeJson "$claudeJson.bak" -Force
            $cfg | Add-Member -NotePropertyName hasCompletedOnboarding -NotePropertyValue $true -Force
            [System.IO.File]::WriteAllText($claudeJson, ($cfg | ConvertTo-Json -Depth 100))
            Write-Host "[OK] Marked hasCompletedOnboarding=true in ~/.claude.json (backup: .claude.json.bak)"
        }
    } else {
        [System.IO.File]::WriteAllText($claudeJson, '{"hasCompletedOnboarding":true}')
        Write-Host "[OK] Created ~/.claude.json with hasCompletedOnboarding=true"
    }
} catch {
    Write-Host "[WARN] Could not update ~/.claude.json: $($_.Exception.Message)"
    Write-Host "       If claude still hits api.anthropic.com, set hasCompletedOnboarding=true in $claudeJson manually."
}

if ($Persist) {
    [Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL",   $BaseUrl, "User")
    [Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", $key,     "User")
    [Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY",    $key,     "User")
    [Environment]::SetEnvironmentVariable("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1", "User")
    Write-Host "[OK] Persisted env vars to the User environment (new shells too)."
}

# 3) Launch Claude Code in the current directory (unless -NoLaunch).
if ($NoLaunch) {
    Write-Host ""
    Write-Host "Done. Run 'claude' here, or point any OpenAI/Anthropic client at $BaseUrl"
    return
}

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    Write-Host "[FAIL] Claude Code CLI not found on this machine. Install it first:"
    Write-Host "       irm https://claude.ai/install.ps1 | iex      # or: winget install Anthropic.ClaudeCode"
    exit 1
}

Write-Host "Launching claude in $((Get-Location).Path) ..."
Write-Host ""
& claude @ClaudeArgs
