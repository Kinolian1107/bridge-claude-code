# claude-code-bridge start script (Windows)
# Usage: .\start.ps1          (foreground)
#        .\start.ps1 daemon   (background, hidden window)
#
# .env is loaded by claude-code-bridge.mjs itself, so no env plumbing is needed here.
#
# When BRIDGE_HOST=0.0.0.0 (LAN exposure), start also:
#   - generates a BRIDGE_API_KEY into .env if none is set (so the open port is never
#     left unauthenticated),
#   - writes firewall-rule-add/delete-port-<port>.ps1 helpers (they self-elevate via
#     UAC and pause before closing) to open/close the port (start.ps1 stays unprivileged),
#   - resolves the host LAN IPv4 and shows it as a Remote endpoint.
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

# ── LAN exposure setup (only when binding to the 0.0.0.0 wildcard) ────────────
# start.ps1 stays unprivileged — it never touches the firewall itself. Instead it
# (1) makes sure an API key exists so an open LAN port is never unauthenticated, and
# (2) writes per-port helper scripts the user runs *as Administrator* to open/close
# the port. The host LAN IPv4 is resolved for the Remote endpoint display.
$GeneratedKey = $null
$LanIp = $null
$AddRuleScript = $null
$DelRuleScript = $null
if ($BridgeHost -eq "0.0.0.0") {
    # 1) Ensure BRIDGE_API_KEY *before* the bridge starts (it self-loads .env).
    $hasKey = $env:BRIDGE_API_KEY -or ((Test-Path $EnvFile) -and (Select-String -Path $EnvFile -Pattern '^\s*BRIDGE_API_KEY\s*=\s*\S' -Quiet))
    if (-not $hasKey) {
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $kb = New-Object byte[] 32
        $rng.GetBytes($kb)
        $GeneratedKey = ($kb | ForEach-Object { $_.ToString('x2') }) -join ''
        $lines = if (Test-Path $EnvFile) { @(Get-Content $EnvFile) } else { @() }
        $done = $false
        $lines = $lines | ForEach-Object {
            if (-not $done -and $_ -match '^\s*#?\s*BRIDGE_API_KEY\s*=') { $done = $true; "BRIDGE_API_KEY=$GeneratedKey" } else { $_ }
        }
        if (-not $done) { $lines += "BRIDGE_API_KEY=$GeneratedKey" }
        [System.IO.File]::WriteAllText($EnvFile, ($lines -join "`n") + "`n")
    }

    # 2) Generate per-port firewall helper scripts. They self-elevate (relaunch as
    #    Administrator via UAC if needed) and pause before exiting so the user can read
    #    the result. The "firewall-rule-" prefix keeps add/delete sorted together.
    $AddRuleScript = "firewall-rule-add-port-$BridgePort.ps1"
    $DelRuleScript = "firewall-rule-delete-port-$BridgePort.ps1"
    # Shared header: define port/rule, self-elevate if needed, then open a try{} block.
    $hdr = @(
        ('$port = ' + $BridgePort),
        ('$ruleName = "claude-code-bridge-' + $BridgePort + '"'),
        '$ErrorActionPreference = "Stop"',
        '# Self-elevate: relaunch this script as Administrator if not already elevated.',
        'if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {',
        '    Write-Host "Administrator required - relaunching elevated (accept the UAC prompt)..."',
        '    try { Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" }',
        '    catch { Write-Host "[FAIL] Elevation cancelled or failed: $($_.Exception.Message)"; Read-Host "Press Enter to exit" }',
        '    return',
        '}',
        'try {'
    )
    # Shared footer: close try{}, report errors, and ALWAYS pause before exiting.
    $ftr = @(
        '} catch {',
        '    Write-Host "[FAIL] $($_.Exception.Message)"',
        '}',
        'Read-Host "Press Enter to close"'
    )
    $addAct = @(
        '    if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {',
        '        Write-Host "[--] Rule ''$ruleName'' already exists - nothing to do."',
        '    } else {',
        '        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port | Out-Null',
        '        Write-Host "[OK] Opened inbound TCP $port (rule ''$ruleName'')."',
        '    }'
    )
    $delAct = @(
        '    if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {',
        '        Remove-NetFirewallRule -DisplayName $ruleName',
        '        Write-Host "[OK] Removed rule ''$ruleName''."',
        '    } else {',
        '        Write-Host "[--] Rule ''$ruleName'' not found - nothing to do."',
        '    }'
    )
    $addBody = @('# Auto-generated by start.ps1 - opens inbound TCP ' + $BridgePort + ' for claude-code-bridge (self-elevates).') + $hdr + $addAct + $ftr
    $delBody = @('# Auto-generated by start.ps1 - removes the inbound TCP ' + $BridgePort + ' rule for claude-code-bridge (self-elevates).') + $hdr + $delAct + $ftr
    [System.IO.File]::WriteAllText((Join-Path $ScriptDir $AddRuleScript), ($addBody -join "`r`n") + "`r`n")
    [System.IO.File]::WriteAllText((Join-Path $ScriptDir $DelRuleScript), ($delBody -join "`r`n") + "`r`n")

    # 3) Resolve the host LAN IPv4 (interface owning the default route) for Remote.
    try { $LanIp = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1).IPv4Address.IPAddress } catch { }
    if (-not $LanIp) { try { $LanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress } catch { } }
}

# Build copy-paste test commands shown after startup. Wildcard (0.0.0.0) binds use
# the host LAN IPv4 so the commands run as-is from OTHER machines; otherwise loopback.
# The bearer header is added automatically when a key is in effect. JSON is escaped
# for cmd.exe & bash (single-quoted here so PowerShell doesn't mangle the backslashes).
$TestHost  = if ($BridgeHost -eq "0.0.0.0" -and $LanIp) { $LanIp } else { $DisplayHost }
$ActiveKey = $env:BRIDGE_API_KEY
if (-not $ActiveKey -and (Test-Path $EnvFile)) {
    $m = Select-String -Path $EnvFile -Pattern '^\s*BRIDGE_API_KEY\s*=\s*(\S+)' | Select-Object -First 1
    if ($m) { $ActiveKey = $m.Matches[0].Groups[1].Value }
}
# cmd.exe and PowerShell quote JSON differently and there is no single form that
# works in both, so emit a line per shell:
#   - PowerShell: single-quote the JSON (double quotes pass through intact)
#   - cmd.exe / bash: backslash-escape the inner double quotes
$authHdr   = if ($ActiveKey) { ' -H "Authorization: Bearer ' + $ActiveKey + '"' } else { '' }
$jsonPlain = '{"model":"sonnet","messages":[{"role":"user","content":"Hello!"}]}'
$jsonEsc   = '{\"model\":\"sonnet\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello!\"}]}'
$urlBase   = 'http://' + $TestHost + ':' + $BridgePort
$TestHealthCmd = 'curl ' + $urlBase + '/health'
$TestChatPS    = 'curl.exe ' + $urlBase + '/v1/chat/completions -H "Content-Type: application/json"' + $authHdr + " -d '" + $jsonPlain + "'"
$TestChatCmd   = 'curl ' + $urlBase + '/v1/chat/completions -H "Content-Type: application/json"' + $authHdr + ' -d "' + $jsonEsc + '"'
function Write-QuickTests {
    Write-Host "  Quick test (copy-paste):"
    Write-Host "    health (any shell):"
    Write-Host "      $TestHealthCmd"
    Write-Host "    chat - PowerShell:"
    Write-Host "      $TestChatPS"
    Write-Host "    chat - cmd.exe / bash:"
    Write-Host "      $TestChatCmd"
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
    # wildcard scope + the host LAN IPv4 explicit so LAN clients know where to go.
    if ($BridgeHost -eq "0.0.0.0") {
        Write-Host (BLine "  Listening:  0.0.0.0:$BridgePort (wildcard - all interfaces)")
        if ($LanIp) { Write-Host (BLine "  Remote:     http://${LanIp}:$BridgePort") }
    }
    Write-Host (BLine "  Model:      $($health.model)")
    Write-Host (BLine "  Permission: $($health.permissionMode)")
    Write-Host (BLine "  API key:    $apiKeyLabel")
    Write-Host (BLine "  Logs:       .\logs\")
    Write-Host $border
    Write-Host (BLine "  Stop:       .\stop.ps1")
    Write-Host $border
    if ($BridgeHost -eq "0.0.0.0") {
        Write-Host ""
        Write-Host "  LAN exposure - open the firewall port as Administrator:"
        Write-Host "      .\$AddRuleScript      (close later: .\$DelRuleScript)"
        if ($GeneratedKey) {
            Write-Host ""
            Write-Host "  [!] No BRIDGE_API_KEY was set - generated one and saved it to .env:"
            Write-Host "      BRIDGE_API_KEY=$GeneratedKey"
            Write-Host "      Clients must send:  -H `"Authorization: Bearer <key>`""
        }
    }
    Write-Host ""
    Write-QuickTests
    Write-Host ""
} else {
    if ($BridgeHost -eq "0.0.0.0") {
        if ($LanIp) { Write-Host "Remote endpoint (LAN clients): http://${LanIp}:$BridgePort" }
        Write-Host "Open the firewall as Administrator: .\$AddRuleScript   (close: .\$DelRuleScript)"
        if ($GeneratedKey) { Write-Host "[!] Generated BRIDGE_API_KEY (saved to .env): $GeneratedKey" }
        Write-Host ""
    }
    Write-QuickTests
    Write-Host ""
    node (Join-Path $ScriptDir "claude-code-bridge.mjs")
}
