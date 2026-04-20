#!/bin/bash
# claude-code-bridge startup script
# Usage: ./start.sh        (foreground)
#        ./start.sh daemon  (background)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$SCRIPT_DIR/claude-code-bridge.pid"
mkdir -p "$SCRIPT_DIR/logs"
LOGFILE="$SCRIPT_DIR/logs/claude-code-bridge.$(date +%Y%m%d).log"

# ─── Configuration (override via .env or environment) ───
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

export CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"
export CLAUDE_PERMISSION_MODE="${CLAUDE_PERMISSION_MODE:-bypassPermissions}"
export BRIDGE_PORT="${BRIDGE_PORT:-18793}"

# Use pgrep to detect all running instances (not just PID file)
EXISTING_PIDS=$(pgrep -f "claude-code-bridge.mjs" 2>/dev/null)
if [ -n "$EXISTING_PIDS" ]; then
    echo "claude-code-bridge is already running (PID(s): $EXISTING_PIDS)"
    exit 0
fi

# Extra check: verify the port is not already in use
if ss -tlnp 2>/dev/null | grep -q ":${BRIDGE_PORT} "; then
    PORT_PID=$(ss -tlnp 2>/dev/null | grep ":${BRIDGE_PORT} " | grep -oP 'pid=\K[0-9]+' | head -1)
    echo "Port $BRIDGE_PORT is already in use (PID: ${PORT_PID:-unknown})"
    exit 1
fi

# Clear stale PID file
rm -f "$PIDFILE"

# Verify claude CLI is available
if ! command -v "${CLAUDE_BIN:-claude}" &>/dev/null; then
    echo "✗ Error: 'claude' CLI not found in PATH"
    echo "  Install: npm install -g @anthropic-ai/claude-code"
    echo "  Or set CLAUDE_BIN to the path of the claude binary"
    exit 1
fi

if [ "$1" = "daemon" ]; then
    echo "Starting claude-code-bridge in background..."
    nohup node "$SCRIPT_DIR/claude-code-bridge.mjs" > /dev/null 2>&1 &
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
