**[English](configuration.md)** | **[繁體中文](configuration.zh-TW.md)** · [← README](../README.md)

# Configuration

All configuration is via environment variables (or the `.env` file — the bridge loads it by itself, so `node claude-code-bridge.mjs` alone picks up your configuration on any platform).

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_PORT` | `18793` | Port for the proxy server |
| `BRIDGE_HOST` | `127.0.0.1` | Bind address |
| `BRIDGE_API_KEY` | *(empty)* | **v1.3** — optional bearer auth; when set, every endpoint except `/health` requires the key (see [api.md](api.md#bearer-auth--metrics-v13)) |
| `CLAUDE_MODEL` | `sonnet` | Default model (alias or full ID) |
| `CLAUDE_BIN` | `claude` | Path to the `claude` binary |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | `bypassPermissions` / `plan` / `default` |
| `CLAUDE_WORKING_DIR` | `$HOME` | Working directory for the `claude` subprocess |
| `BRIDGE_TIMEOUT_MS` | `300000` | Request timeout (5 min) |
| `BRIDGE_MAX_ARG_LEN` | `32768` | Prompts longer than this are piped via stdin (avoids `E2BIG`) |
| `BRIDGE_VERBOSE` | `true` | Log full request/response bodies and claude-cli I/O; set `false` to disable |
| `ANTHROPIC_API_KEY` | *(empty)* | If set, `GET /v1/models` returns the live list from the Anthropic API |

> On Windows, set `CLAUDE_BIN` in `.env` to your Claude Code binary (e.g. `C:\Users\you\.local\bin\claude.cmd`).

## Claude Code Authentication

claude-code-bridge does not handle auth itself — the spawned `claude` process uses Claude Code's own credentials. Set it up once:

```bash
claude auth login        # interactive (claude.ai subscription or API key)
claude auth status       # verify
```

The bridge passes the full environment to the subprocess, so an `ANTHROPIC_API_KEY` in your `.env`/shell is also honoured by Claude Code. No Anthropic API key is required when you are logged in via `claude auth login`.

## Exposing the bridge on a LAN

By default the bridge binds to `127.0.0.1` — only the host machine can reach it. To let other computers on the same network use it as an endpoint, do three things on the machine running the bridge:

### 1. Bind to all interfaces

```bash
# .env
BRIDGE_HOST=0.0.0.0
```

`0.0.0.0` listens on every network interface so LAN clients can connect. Restart afterwards (`./stop.sh && ./start.sh daemon`).

### 2. Always set `BRIDGE_API_KEY`

Once bound to `0.0.0.0`, **anyone who can reach the machine can drive a `claude` process running in `bypassPermissions` mode** — i.e. run tools and edit files as you. Set a bearer key:

```bash
# .env
BRIDGE_API_KEY=$(openssl rand -hex 32)   # or any sufficiently long random string
```

Every endpoint except `/health` then requires one of these headers:

```bash
-H "Authorization: Bearer <key>"
# or
-H "x-api-key: <key>"
```

> ⚠️ Skipping the key is only acceptable on a fully trusted home segment. For LAN / Tailscale, always set it — the default permission mode is `bypassPermissions`.

### 3. Find the LAN IP and open the firewall

```bash
# Find the IP (look for 192.168.x.x / 10.x.x.x)
ip addr | grep "inet "          # Linux
ipconfig                         # Windows (PowerShell)

# Open port 18793
sudo ufw allow 18793/tcp                              # Linux (ufw)
```

```powershell
# Windows (Administrator PowerShell)
New-NetFirewallRule -DisplayName "claude-code-bridge" -Direction Inbound -LocalPort 18793 -Protocol TCP -Action Allow
```

### Connecting from other machines

Replace `127.0.0.1` with the host's LAN IP and pass the key:

```bash
curl http://192.168.1.50:18793/v1/chat/completions \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello!"}]}'
```

OpenClaw / Hermes / SDK clients: set `base_url` to `http://192.168.1.50:18793/v1` and use the same key.

### ⚠️ Running inside WSL2

WSL2 sits behind a NAT, so even with `BRIDGE_HOST=0.0.0.0` other LAN computers **cannot** reach the WSL IP directly — they only see the Windows host. Add a port forward on the **Windows host** (Administrator PowerShell):

```powershell
# Get the WSL IP
wsl hostname -I

# Forward the Windows host's 18793 into WSL (replace <WSL_IP> with the value above)
netsh interface portproxy add v4tov4 `
  listenaddress=0.0.0.0 listenport=18793 `
  connectaddress=<WSL_IP> connectport=18793

# Open the Windows firewall
New-NetFirewallRule -DisplayName "claude-code-bridge" -Direction Inbound -LocalPort 18793 -Protocol TCP -Action Allow
```

Other machines then connect to the **Windows host's** LAN IP (from `ipconfig`), not the WSL IP. The WSL IP changes on reboot, so re-run the forward after restarting (`netsh interface portproxy reset` clears the old rules). A native Linux/macOS host needs none of this — steps 1–3 are enough.

## Logs

Logs are written to the `logs/` directory with daily rotation:

```
logs/
└── claude-code-bridge.20260616.log   ← one file per day
```

```bash
# Follow today's log
tail -f logs/claude-code-bridge.$(date +%Y%m%d).log
```

The log stream auto-rotates at midnight without requiring a restart. Set `BRIDGE_VERBOSE=false` to log only summaries (no full bodies).

## Troubleshooting

### Bridge won't start
- Check if the port is in use: `ss -tlnp | grep 18793`
- View logs: `tail -f logs/claude-code-bridge.$(date +%Y%m%d).log`

### Authentication errors
- Run `claude auth login` to authenticate
- Check status: `claude auth status`

### Claude Code CLI not found
- **Windows:** `irm https://claude.ai/install.ps1 | iex` or `winget install Anthropic.ClaudeCode`
- **Linux / macOS:** `npm install -g @anthropic-ai/claude-code`
- Set `CLAUDE_BIN` in `.env` to the full path if needed

### Slow first response
- The first request is slower (Claude Code startup). Subsequent requests are faster.

## Uninstall

```bash
./uninstall.sh                 # Linux / macOS / WSL
.\uninstall.ps1                # Windows (PowerShell)
.\uninstall.ps1 -DeleteLogs    # Windows, also remove logs/ without prompting
```

Both stop the bridge and clean up generated files (`.env`, `*.pid`), then prompt
before deleting `logs/`. On Linux/macOS the script also removes the auto-start
entry from `~/.bashrc`; OpenClaw / Hermes integrations are reverted by
`./clearset-openclaw.sh` / `./clearset-hermesagent.sh`. The Windows installer adds
no shell auto-start entry and the integrations are Linux/macOS-only, so
`uninstall.ps1` has nothing equivalent to revert.

On Windows: run `.\stop.ps1`, then delete the project folder — `install.ps1` only creates the local `.env` (no registry or startup entries).
