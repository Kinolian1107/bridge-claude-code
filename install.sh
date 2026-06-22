#!/bin/bash
# ─────────────────────────────────────────────────────────────
# claude-code-bridge installer
#
# This script:
#   1. Checks Node.js >= 22 and detects the claude CLI binary
#   2. Creates .env pointing CLAUDE_BIN at the detected binary
#   3. Keeps start.sh / stop.sh executable
#   4. Optionally adds auto-start to ~/.bashrc
#
# OpenClaw / Hermes Agent integration is handled by the dedicated
# set-openclaw.sh / set-hermesagent.sh scripts (run them after install).
# ─────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Defaults (override via env) ──────────────────────────────
BRIDGE_PORT="${BRIDGE_PORT:-18793}"
CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"
CLAUDE_PERMISSION_MODE="${CLAUDE_PERMISSION_MODE:-bypassPermissions}"
# 'llm' (pure model, no host tools) is the safe default for shared / LAN use.
# Set BRIDGE_TOOL_MODE=agent ./install.sh for a single-machine full-toolset setup.
BRIDGE_TOOL_MODE="${BRIDGE_TOOL_MODE:-llm}"

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✓${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "${RED}✗${NC}  $*"; exit 1; }

echo ""
echo "┌──────────────────────────────────────────────────┐"
echo "│  claude-code-bridge installer                     │"
echo "│  OpenAI/Anthropic-compatible proxy for Claude Code│"
echo "└──────────────────────────────────────────────────┘"
echo ""

# ── 1. Check prerequisites ───────────────────────────────────
info "Checking prerequisites..."

# Node >= 22
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install Node >= 22 first (see README quick start)."
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if (( NODE_VER < 22 )); then
  fail "Node.js >= 22 required (found $(node -v))"
fi
ok "Node.js $(node -v)"

# Claude Code CLI
CLAUDE_BIN=""
if command -v claude &>/dev/null; then
  CLAUDE_BIN="$(command -v claude)"
elif [ -x "$HOME/.local/bin/claude" ]; then
  CLAUDE_BIN="$HOME/.local/bin/claude"
else
  fail "Claude Code CLI not found. Install it first: npm install -g @anthropic-ai/claude-code  (Linux/macOS) | Windows: irm https://claude.ai/install.ps1 | iex"
fi
ok "Claude Code CLI: $CLAUDE_BIN ($("$CLAUDE_BIN" --version 2>/dev/null || echo 'version unknown'))"

# Auth status (best-effort, non-fatal)
if "$CLAUDE_BIN" auth status &>/dev/null; then
  ok "Claude Code is authenticated"
else
  warn "Claude Code may not be authenticated — run: claude auth login"
fi

# ── 2. Create env file ───────────────────────────────────────
echo ""
info "Selected model: ${CYAN}${CLAUDE_MODEL}${NC}  (override with CLAUDE_MODEL=<id> ./install.sh)"
if [ "$BRIDGE_TOOL_MODE" = "llm" ]; then MODE_NOTE="pure model, no host tools"; else MODE_NOTE="full Claude Code toolset on this host"; fi
info "Tool mode:      ${CYAN}${BRIDGE_TOOL_MODE}${NC}  ($MODE_NOTE — override with BRIDGE_TOOL_MODE=agent ./install.sh)"
ENV_FILE="$SCRIPT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  warn ".env already exists — leaving it untouched"
else
  cat > "$ENV_FILE" <<EOF
# claude-code-bridge configuration
BRIDGE_PORT=${BRIDGE_PORT}
CLAUDE_MODEL=${CLAUDE_MODEL}
CLAUDE_BIN=${CLAUDE_BIN}
# Tool mode: llm (pure model, no host tools - safe default for shared/LAN use)
#            or agent (full Claude Code toolset running on THIS host)
BRIDGE_TOOL_MODE=${BRIDGE_TOOL_MODE}
# Permission mode below only applies in agent mode (ignored when llm)
CLAUDE_PERMISSION_MODE=${CLAUDE_PERMISSION_MODE}
# BRIDGE_API_KEY=   # set before exposing on a LAN (openssl rand -hex 32)
EOF
  ok "Created $ENV_FILE"
fi

# ── 3. Start/stop scripts ───────────────────────────────────
chmod +x "$SCRIPT_DIR/start.sh" "$SCRIPT_DIR/stop.sh" 2>/dev/null || true
ok "start.sh / stop.sh ready"

# ── 4. Auto-start in .bashrc ────────────────────────────────
echo ""
BASHRC="$HOME/.bashrc"
MARKER="# claude-code-bridge auto-start"
if ! grep -qF "$MARKER" "$BASHRC" 2>/dev/null; then
  read -rp "Add claude-code-bridge auto-start to ~/.bashrc? [y/N] " ans
  if [[ "$ans" =~ ^[Yy] ]]; then
    cat >> "$BASHRC" <<EOF

$MARKER
if [ -f "$SCRIPT_DIR/start.sh" ] && ! pgrep -f "claude-code-bridge.mjs" >/dev/null 2>&1; then
  "$SCRIPT_DIR/start.sh" daemon >/dev/null 2>&1
fi
EOF
    ok "Added auto-start to ~/.bashrc"
  else
    info "Skipped. Start manually: $SCRIPT_DIR/start.sh daemon"
  fi
else
  warn "Auto-start entry already in ~/.bashrc"
fi

# ── Done ─────────────────────────────────────────────────────
echo ""
echo "┌──────────────────────────────────────────────────────────┐"
echo "│  ✓ Installation complete!                                 │"
echo "├──────────────────────────────────────────────────────────┤"
echo "│  Start bridge:  ./start.sh daemon                         │"
echo "│  Stop bridge:   ./stop.sh                                 │"
echo "│  Test:          curl http://127.0.0.1:${BRIDGE_PORT}/health           │"
echo "│                                                          │"
echo "│  Integrations (optional):                                │"
echo "│    ./set-openclaw.sh       — wire up OpenClaw            │"
echo "│    ./set-hermesagent.sh    — wire up Hermes Agent        │"
echo "└──────────────────────────────────────────────────────────┘"
echo ""
