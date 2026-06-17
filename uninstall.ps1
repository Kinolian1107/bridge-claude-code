# claude-code-bridge uninstaller (Windows)
# Usage: .\uninstall.ps1            (prompts before deleting request data + logs/)
#        .\uninstall.ps1 -DeleteLogs  (also removes request data + logs/ without prompting)
#
# Mirrors uninstall.sh for Windows:
#   1. Stops the bridge (via stop.ps1)
#   2. Removes generated files (.env, *.pid)
#   3. Optionally removes leftover request data (%TEMP%\claude-code-bridge-*)
#   4. Optionally removes logs/
#
# Windows install.ps1 adds no shell auto-start entry, and the OpenClaw / Hermes
# integrations are Linux/macOS-only (clearset-*.sh), so there is nothing
# equivalent to revert here.
param([switch]$DeleteLogs)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "claude-code-bridge uninstaller (Windows)"
Write-Host "----------------------------------------"
Write-Host ""

# -- 1. Stop the bridge ----------------------------------------
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match "claude-code-bridge\.mjs" }
if ($running) {
    & (Join-Path $ScriptDir "stop.ps1")
} else {
    Write-Host "claude-code-bridge is not running"
}

# -- 2. Remove generated files ---------------------------------
foreach ($f in @(".env", "claude-code-bridge.pid")) {
    $path = Join-Path $ScriptDir $f
    if (Test-Path $path) {
        Remove-Item $path -Force
        Write-Host "[OK] Removed $f"
    }
}

# -- 3. Optionally remove leftover request data ----------------
# The bridge writes each request's prompt to %TEMP%\claude-code-bridge-*\prompt.txt
# and normally cleans it up per request; orphans can remain after a crash. These
# hold past request content, so confirm before deleting (-DeleteLogs auto-confirms).
$tempLeftovers = @(Get-ChildItem -Path $env:TEMP -Directory -Filter "claude-code-bridge-*" -ErrorAction SilentlyContinue)
if ($tempLeftovers.Count -gt 0) {
    Write-Host "Found $($tempLeftovers.Count) leftover request-data folder(s) to delete:"
    $tempLeftovers | ForEach-Object { Write-Host "    $($_.FullName)" }
    $remove = $DeleteLogs
    if (-not $remove) {
        $ans = Read-Host "Delete the folder(s) listed above? [y/N]"
        $remove = $ans -match '^[Yy]'
    }
    if ($remove) {
        $tempLeftovers | ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
        Write-Host "[OK] Removed $($tempLeftovers.Count) leftover temp dir(s) from `$env:TEMP"
    } else {
        Write-Host "[--] Kept request data in `$env:TEMP"
    }
}

# -- 4. Optionally remove logs/ --------------------------------
$LogDir = Join-Path $ScriptDir "logs"
if (Test-Path $LogDir) {
    Write-Host "The following log folder will be deleted:"
    Write-Host "    $LogDir"
    $remove = $DeleteLogs
    if (-not $remove) {
        $ans = Read-Host "Delete the folder listed above? [y/N]"
        $remove = $ans -match '^[Yy]'
    }
    if ($remove) {
        Remove-Item $LogDir -Recurse -Force
        Write-Host "[OK] Deleted logs/"
    } else {
        Write-Host "[--] Kept logs/"
    }
}

Write-Host ""
Write-Host "Done."
Write-Host ""
