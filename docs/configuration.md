**[English](configuration.md)** | **[繁體中文](configuration.zh-TW.md)** · [← README](../README.md)

# Configuration

All configuration is via environment variables (or the `.env` file — the bridge loads it by itself, so `node claude-code-bridge.mjs` alone picks up your configuration on any platform).

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_PORT` | `18793` | Port for the proxy server |
| `BRIDGE_HOST` | `127.0.0.1` | Bind address |
| `BRIDGE_API_KEY` | *(empty)* | **v1.3** — optional bearer auth; when set, every endpoint except `/health` requires the key (see [api.md](api.md#bearer-auth--metrics-v13)) |
| `CLAUDE_MODEL` | `sonnet` | **Default / fallback** model (alias or full ID). A client's requested model overrides it when valid — see [Model selection](#model-selection--forcing-v15) |
| `BRIDGE_FORCE_MODEL` | *(empty)* | **v1.5** — when set, ALWAYS use this model and ignore the client's requested model (host-side cost control / pin). Empty = off. See [Model selection](#model-selection--forcing-v15) |
| `CLAUDE_BIN` | `claude` | Path to the `claude` binary |
| `BRIDGE_TOOL_MODE` | `agent` | **v1.4** — `agent` (all built-in tools, `--dangerously-skip-permissions`) / `llm` (no built-in tools — pure LLM behaviour; see [LLM mode](#llm-mode--remote-callers)). Runtime default with no env is `agent`; `install.ps1` / `install.sh` (v1.4.1) write `llm` into new `.env` files. |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | `bypassPermissions` / `plan` / `default` — only applies in `agent` mode |
| `CLAUDE_WORKING_DIR` | `$HOME` | Working directory for the `claude` subprocess. **v1.4.1:** in `llm` mode (when unset) this defaults to an isolated empty temp dir instead of `$HOME`, so a host `CLAUDE.md` can't leak in. |
| `BRIDGE_TIMEOUT_MS` | `300000` | Request timeout (5 min) |
| `BRIDGE_MAX_ARG_LEN` | `32768` | Prompts longer than this are piped via stdin (avoids `E2BIG`) |
| `BRIDGE_VERBOSE` | `true` | Log full request/response bodies and claude-cli I/O; set `false` to disable |
| `BRIDGE_USAGE_LOG` | `./logs/token-usage.csv` | **v1.5** — per-call usage CSV; one metadata-only row per request (tokens, cost, duration, …). Set `off` to disable. One writer process per file. See [Per-call usage log](#per-call-usage-log--tool-bridge-parsing-v150) |
| `BRIDGE_TOOL_PARSE_LOG_FULL` | `0` | **v1.5** — when a `<tool_call>` block fails to parse, the logged snippet is truncated to 200 chars by default; set `1` to log the full untruncated snippet when debugging |
| `ANTHROPIC_API_KEY` | *(empty)* | If set, `GET /v1/models` returns the live list from the Anthropic API |

> On Windows, `install.ps1` auto-detects the real `claude.exe` (npm / native / winget) and writes it to `CLAUDE_BIN`. If you set it by hand, point at the **`.exe`** — e.g. `C:\Users\you\.local\bin\claude.exe`, or for an npm install `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` — not the `claude.cmd`/`.ps1` shim, which modern Node can't spawn directly.

## Model selection & forcing (v1.5)

The model that actually reaches `claude --model` is resolved per request, in this order:

1. **`BRIDGE_FORCE_MODEL`** (host `.env`) — if set, it is **always** used and the client's requested model is ignored. Use it on a shared host to **pin the model for cost control** (e.g. `BRIDGE_FORCE_MODEL=sonnet`, so a client asking for `opus` still runs on `sonnet`). The toggle is its presence: set it to force, remove/blank it to allow per-request models.
2. **The client's `model`** — honoured only if it looks like a Claude model: a bare alias (`sonnet` / `opus` / `haiku` / `fable`) or a full `claude-…` id, after stripping a routing prefix (`bridge-claude-code/`, `claude/`, `anthropic/`). This is the "dynamic model switching" that lets a client override the host default per request.
3. **`CLAUDE_MODEL`** (host default) — used when the client sends **no model**, a blank model, or a **non-Claude** model. Other agent IDEs (Roo Code / Cline / OpenCode) often send a non-Claude name such as `gpt-4o`; rather than handing `claude --model gpt-4o` an invalid name (which errors), the bridge **falls back to `CLAUDE_MODEL`**.

The usage log and the response `model` field record the **resolved** model — what was actually sent to `claude`, not the raw request.

> Only the **model** is forwarded. A client's reasoning-effort / thinking setting (e.g. Claude Code's `xhigh`) is **not** passed through — the host `claude` generates at its own default effort.

## Claude Code Authentication

claude-code-bridge does not handle auth itself — the spawned `claude` process uses Claude Code's own credentials. Set it up once:

```bash
claude auth login        # interactive (claude.ai subscription or API key)
claude auth status       # verify
```

The bridge passes the full environment to the subprocess, so an `ANTHROPIC_API_KEY` in your `.env`/shell is also honoured by Claude Code. No Anthropic API key is required when you are logged in via `claude auth login`.

## Exposing the bridge on a LAN

By default the bridge binds to `127.0.0.1` — only the host machine can reach it. To let other computers on the same network use it as an endpoint, do three things on the machine running the bridge:

> **On Windows, `start.ps1` automates most of this (v1.3.2).** Once you set `BRIDGE_HOST=0.0.0.0` (step 1) and run `.\start.ps1 daemon`, it will: generate a `BRIDGE_API_KEY` into `.env` if you haven't set one (step 2), write self-elevating `firewall-rule-add-port-<port>.ps1` / `firewall-rule-delete-port-<port>.ps1` helpers for step 3 (run the *add* one — it relaunches as Administrator via UAC and pauses so you can read the result), show the host LAN IPv4 as a `Remote:` endpoint, and print copy-paste `curl` tests (PowerShell + cmd.exe forms) with the bearer header already filled in.

### 1. Bind to all interfaces

```bash
# .env
BRIDGE_HOST=0.0.0.0
```

`0.0.0.0` listens on every network interface so LAN clients can connect. Restart afterwards (`./stop.sh && ./start.sh daemon`). On Windows, `start.ps1 daemon` confirms the wildcard bind in its summary box (`Listening: 0.0.0.0:<port>`).

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

## LLM mode — remote callers

> **TL;DR:** Sharing the bridge across machines? Set `BRIDGE_TOOL_MODE=llm` on the server. Callers then include file content in the prompt themselves, exactly like any cloud LLM.

### Why it matters

claude-code-bridge wraps `claude -p`, which is a full AI **agent**. It has built-in tools for reading and writing files, running shell commands, searching the web, and more. Those tools always execute on the **machine running the bridge** (the server). When a remote caller on Computer B asks Claude to "read `main.py`", Claude looks for `main.py` on Computer A — the bridge host — not on Computer B.

This is correct behaviour for single-machine use. But when the bridge is shared across a network, you usually want Claude to behave like a plain cloud LLM: it only sees what you send it, and if it needs a file it asks you to paste the contents.

### Enable LLM mode

```bash
# .env  (on the bridge server, Computer A)
BRIDGE_TOOL_MODE=llm
```

> New installs default to this: `install.ps1` / `install.sh` (v1.4.1) write `BRIDGE_TOOL_MODE=llm` into the generated `.env`. Set `BRIDGE_TOOL_MODE=agent` before install for a single-machine, full-toolset setup.

The bridge then passes `--tools "" --strict-mcp-config --disallowedTools LSP --setting-sources ""` to `claude`. Claude becomes a pure language model:

- It cannot access any file on the bridge host. `--tools ""` disables the built-in set (Read, Write, Edit, Bash, WebSearch, …); `--strict-mcp-config` and `--disallowedTools LSP` (v1.4.1) also drop the MCP connectors and the LSP plugin tool, which survive `--tools ""` alone and would otherwise run on the host. Verified: the session starts with an empty tool list.
- If a caller asks it to "read `config.json`" without providing the content, Claude will reply asking the caller to paste the file directly into the message.
- `CLAUDE_PERMISSION_MODE` / `--dangerously-skip-permissions` no longer applies (there are no tools to approve).
- **v1.4.1:** the bridge also launches `claude` in an isolated empty working directory (under the OS temp dir) instead of `$HOME`, so a *project-level* `CLAUDE.md` on the host can't leak into responses. An explicit `CLAUDE_WORKING_DIR` still wins.
- **v1.5:** `--setting-sources ""` loads **none** of the host's user/project/local settings, so its plugins, **SessionStart hooks**, and *user-level* `~/.claude/CLAUDE.md` / custom settings never load and can't inject into responses. (A connected client previously observed the host's superpowers SessionStart hook bleeding into replies.) Auth is not a setting source, so the claude.ai subscription / OAuth login still works.

### How callers send file content

Callers on Computer B read their own files and include the content in the prompt — the same pattern every cloud LLM IDE plugin uses:

```bash
# Computer B — read the file locally, inject into the request
FILE_CONTENT=$(cat main.py)

curl http://192.168.1.50:18793/v1/chat/completions \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"sonnet\",
    \"messages\": [{
      \"role\": \"user\",
      \"content\": \"Review this file:\n\n\`\`\`python\n${FILE_CONTENT}\n\`\`\`\"
    }]
  }"
```

AI coding clients (Continue.dev, Cursor, etc.) do this automatically — they read the files open in your editor and inject the content before sending the request to the configured endpoint.

### Mode comparison

| | `agent` (default) | `llm` |
|---|---|---|
| Built-in tools | ✅ all enabled | ❌ disabled (`--tools ""`) |
| File access | Bridge-host filesystem | None — caller provides content |
| `--dangerously-skip-permissions` | Yes | No |
| Best for | Single machine | Shared / multi-machine |

### Two independent "tool" mechanisms

`BRIDGE_TOOL_MODE` is **not** the same thing as the OpenAI `tools[]` field in a request. They are orthogonal, and the difference is the key to using the bridge as a clean model provider:

| | `BRIDGE_TOOL_MODE` (server env) | Tool Bridge Mode (per request) |
|---|---|---|
| Triggered by | `.env` on the server | request body contains `tools[]` |
| What it controls | Claude's **built-in** tools (`--tools ""`) | the **caller's** function definitions |
| Where tools run | bridge host (`agent`) / nowhere (`llm`) | **returned to the caller to run** (`finish_reason: "tool_calls"`) |

Tool Bridge Mode injects the caller's tool schemas into the prompt, asks Claude to emit `<tool_call>` blocks, parses them out, and returns standard OpenAI `tool_calls`. The caller executes them **on its own machine** and sends the results back — exactly how Continue.dev / Cursor / an agent IDE drives a model.

Because the two are independent, `BRIDGE_TOOL_MODE=llm` supports both calling styles:

| Request | Result under `llm` |
|---|---|
| no `tools[]` | pure text completion — caller pastes any file content into the prompt |
| with `tools[]` | Claude returns `tool_calls`; the **caller** executes them locally. No host-side execution, no competing built-in tools |

> The combination to avoid is `agent` **with** a caller's `tools[]`: Claude is asked to emit `<tool_call>` blocks for the caller, but its own built-in tools are still live and may fire on the host instead. For client-side function calling, always use `llm`.

### Running both modes at once

`BRIDGE_TOOL_MODE` is process-wide. To keep full agent power for yourself **and** serve a safe LLM endpoint to the LAN, run two instances rather than adding a per-request override — the security boundary stays clean because the instance that can touch the host filesystem never leaves loopback:

```bash
# Agent instance — localhost only, full tools, never exposed
BRIDGE_HOST=127.0.0.1 BRIDGE_PORT=18793 BRIDGE_TOOL_MODE=agent  node claude-code-bridge.mjs

# LLM instance — LAN-facing, no host filesystem access
BRIDGE_HOST=0.0.0.0   BRIDGE_PORT=18794 BRIDGE_TOOL_MODE=llm \
  BRIDGE_API_KEY=<key> node claude-code-bridge.mjs
```

### Recommended for agent IDEs

Pointing Claude Code, OpenCode, RooCode, Continue.dev, etc. at the bridge? Those clients **are** the agent — they own the tools and the workspace on *their* machine. Set `BRIDGE_TOOL_MODE=llm` so the bridge is only the model; all tool execution then stays on the client, where it belongs.

### What LLM mode does *not* isolate

`--tools ""` removes the built-in tools, but `claude -p` is still a configured Claude Code process. LLM mode does **not** neutralize:

- **The agent persona** — responses still come from Claude Code's built-in coding-agent system prompt. This is inherent to `claude -p` (not a setting source), so it remains and can make answers terse or coding-flavoured. Claude may occasionally *claim* to have tools (e.g. "I can use Read/Bash"), but the real tool registry is empty (verified `tools:[]`), so any such call simply does not exist — cosmetic confusion, not host access.

> **Resolved in v1.5:** earlier versions could not isolate the *user-level* `~/.claude/CLAUDE.md`, `settings.json`, plugins, or SessionStart hooks (only the *project-level* `CLAUDE.md` via the working dir). `--setting-sources ""` now stops all of them from loading, while OAuth subscription auth still works — so the endpoint is much closer to a clean model provider.
- **Streaming of `tools[]` calls** — when a request includes `tools[]` (v1.5), any leading text streams as content, then each `<tool_call>` is emitted as its own `tool_calls` delta the moment its block closes, with parallel calls each carrying the correct per-call `index`. Text after the first tool call is suppressed (the model is told to stop after the blocks). Plain (no-`tools[]`) requests stream normally and are unaffected.

## Per-call usage log & Tool Bridge parsing (v1.5.0)

### Per-call usage CSV (`BRIDGE_USAGE_LOG`)

When `BRIDGE_USAGE_LOG` is set (it defaults to `./logs/token-usage.csv`; set it to `off` to disable), the bridge appends **one row per request** so a shared-host admin can track usage and cost over time. The file is plain CSV with this header:

```
timestamp_iso,request_id,endpoint,client_ip,model,tool_mode,stream,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,total_cost_usd,duration_ms,num_turns,tool_calls,finish_reason,status
```

- **Metadata only** — token counts, cost, timing, and request shape. The prompt, the response text, tool arguments, and tool results are **never** written to this file.
- Token counts and `total_cost_usd` come from the `claude` result event's `usage.*` / `total_cost_usd` (the same numbers the Prometheus `/metrics` endpoint reports), not an estimate.
- **One writer process per file.** The bridge appends with no inter-process locking, so if you run two bridge instances pointed at the same path their rows can interleave. Give each instance its own `BRIDGE_USAGE_LOG` path (or leave one on the default and point the other elsewhere).

```bash
# Tail the running cost
column -s, -t logs/token-usage.csv | less -S
```

### Tool Bridge Mode parsing & anomalies

In Tool Bridge Mode (a request that includes `tools[]`), the bridge parses the `<tool_call>` blocks Claude emits back into OpenAI `tool_calls`. The parser is brace-balanced, so nested-object / array arguments are kept intact, and multiple blocks in one turn are returned as parallel calls each with the correct `index`.

When a `<tool_call>` block can't be parsed (malformed JSON, a near-miss that almost matched the protocol, …), the bridge:

- **counts it in `/metrics`** as `bridge_tool_parse_anomalies_total{type="…"}` (e.g. `type="invalid_json"`, `type="near_miss"`), alongside the new `bridge_tool_calls_total`, `bridge_tokens_total{type}`, and `bridge_cost_usd_total` counters;
- **logs a snippet** of the offending text. The snippet is **truncated to 200 chars by default** to avoid leaking prompt/response data in shared deployments; set `BRIDGE_TOOL_PARSE_LOG_FULL=1` to log the full untruncated snippet while debugging a parsing issue.

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
- **Windows:** `irm https://claude.ai/install.ps1 | iex`, `winget install Anthropic.ClaudeCode`, or `npm install -g @anthropic-ai/claude-code` — `install.ps1` detects all three
- **Linux / macOS:** `npm install -g @anthropic-ai/claude-code`
- The **Claude Desktop** app is a GUI, not the headless CLI — its `WindowsApps\Claude.exe` alias launches the app instead of running `claude -p`, so install one of the above even if Claude Desktop is present
- Set `CLAUDE_BIN` in `.env` to the full path of `claude.exe` if needed

### Slow first response
- The first request is slower (Claude Code startup). Subsequent requests are faster.

## Uninstall

```bash
./uninstall.sh                 # Linux / macOS / WSL
.\uninstall.ps1                # Windows (PowerShell)
.\uninstall.ps1 -DeleteLogs    # Windows, also remove request data + logs/ without prompting
```

Both stop the bridge and clean up generated files (`.env`, `*.pid`). On Windows,
`uninstall.ps1` then lists and prompts before deleting leftover request data
(`%TEMP%\claude-code-bridge-*` prompt folders) and the `logs/` directory; `-DeleteLogs`
auto-confirms both. On Linux/macOS the script also removes the auto-start
entry from `~/.bashrc`; OpenClaw / Hermes integrations are reverted by
`./clearset-openclaw.sh` / `./clearset-hermesagent.sh`. The Windows installer adds
no shell auto-start entry and the integrations are Linux/macOS-only, so
`uninstall.ps1` has nothing equivalent to revert.

On Windows: run `.\stop.ps1`, then delete the project folder — `install.ps1` only creates the local `.env` (no registry or startup entries).
