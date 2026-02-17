#!/bin/bash
# claude-code-bridge stop script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$SCRIPT_DIR/claude-code-bridge.pid"

if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Stopping claude-code-bridge (PID $PID)..."
        kill "$PID"
        sleep 2
        if kill -0 "$PID" 2>/dev/null; then
            echo "Force killing..."
            kill -9 "$PID"
        fi
        echo "✓ Stopped"
    else
        echo "Process $PID not running"
    fi
    rm -f "$PIDFILE"
else
    # Fallback: find by process name
    PIDS=$(pgrep -f "claude-code-bridge.mjs" 2>/dev/null)
    if [ -n "$PIDS" ]; then
        echo "Stopping claude-code-bridge (PIDs: $PIDS)..."
        kill $PIDS
        sleep 2
        kill -9 $PIDS 2>/dev/null
        echo "✓ Stopped"
    else
        echo "claude-code-bridge is not running"
    fi
fi
