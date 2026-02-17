#!/bin/bash
# claude-code-bridge startup script
# Usage: ./start.sh        (foreground)
#        ./start.sh daemon  (background)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$SCRIPT_DIR/claude-code-bridge.pid"
LOGFILE="$SCRIPT_DIR/claude-code-bridge.log"

# ─── Configuration (override via .env or environment) ───
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

export CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"
export CLAUDE_PERMISSION_MODE="${CLAUDE_PERMISSION_MODE:-bypassPermissions}"
export BRIDGE_PORT="${BRIDGE_PORT:-18793}"

# Check if already running
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "claude-code-bridge is already running (PID $OLD_PID)"
        exit 0
    else
        rm -f "$PIDFILE"
    fi
fi

# Verify claude CLI is available
if ! command -v claude &>/dev/null; then
    echo "✗ Error: 'claude' CLI not found in PATH"
    echo "  Install: npm install -g @anthropic-ai/claude-code"
    echo "  Or set CLAUDE_BIN to the path of the claude binary"
    exit 1
fi

echo "╔═══════════════════════════════════════════════════════╗"
echo "║         claude-code-bridge v1.0.0                    ║"
echo "╠═══════════════════════════════════════════════════════╣"
echo "║  Model:      ${CLAUDE_MODEL}"
echo "║  Port:       ${BRIDGE_PORT}"
echo "║  Permission: ${CLAUDE_PERMISSION_MODE}"
echo "║  Claude:     $(which claude) (v$(claude --version 2>/dev/null || echo 'unknown'))"
echo "╚═══════════════════════════════════════════════════════╝"

if [ "$1" = "daemon" ]; then
    echo "Starting claude-code-bridge in background..."
    nohup node "$SCRIPT_DIR/claude-code-bridge.mjs" >> "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    echo "claude-code-bridge started (PID $(cat "$PIDFILE"))"
    echo "Log: $LOGFILE"
    sleep 2
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "✓ Health check: $(curl -s http://127.0.0.1:${BRIDGE_PORT}/health)"
    else
        echo "✗ Failed to start. Check $LOGFILE"
        exit 1
    fi
else
    exec node "$SCRIPT_DIR/claude-code-bridge.mjs"
fi
