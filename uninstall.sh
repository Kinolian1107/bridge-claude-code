#!/bin/bash
# ─────────────────────────────────────────────────────────────
# claude-code-bridge uninstaller
#
# Stops the bridge, removes the ~/.bashrc auto-start entry, and
# cleans up generated files (.env, *.pid, optionally logs/).
#
# OpenClaw / Hermes integrations are removed by their own
# clearset-openclaw.sh / clearset-hermesagent.sh scripts.
# ─────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
info() { echo -e "${CYAN}ℹ${NC}  $*"; }

echo ""
echo "claude-code-bridge uninstaller"
echo "──────────────────────────────"
echo ""

# Stop bridge
if pgrep -f "claude-code-bridge.mjs" >/dev/null 2>&1; then
  "$SCRIPT_DIR/stop.sh" 2>/dev/null || pkill -f "claude-code-bridge.mjs" 2>/dev/null
  ok "Stopped claude-code-bridge"
fi

# Remove auto-start from .bashrc
BASHRC="$HOME/.bashrc"
if grep -qF "claude-code-bridge auto-start" "$BASHRC" 2>/dev/null; then
  sed -i '/# claude-code-bridge auto-start/,+3d' "$BASHRC"
  ok "Removed auto-start from ~/.bashrc"
fi

# Reminder about integrations
if [ -f "$HOME/.openclaw/openclaw.json.bak.pre-claude-bridge" ]; then
  info "OpenClaw integration detected — run ./clearset-openclaw.sh to revert it"
fi
if [ -f "$HOME/.hermes/config.yaml.bak.pre-claude-bridge" ]; then
  info "Hermes integration detected — run ./clearset-hermesagent.sh to revert it"
fi

# Cleanup generated files
rm -f "$SCRIPT_DIR/.env" "$SCRIPT_DIR/claude-code-bridge.pid"
if [ -d "$SCRIPT_DIR/logs" ]; then
  read -rp "Delete logs/ directory? [y/N] " ans_logs
  if [[ "$ans_logs" =~ ^[Yy] ]]; then
    rm -rf "$SCRIPT_DIR/logs"
    ok "Deleted logs/"
  fi
fi
ok "Cleaned up generated files"

echo ""
echo "Done."
echo ""
