# Changelog

## v1.5.0 — 2026-06-23

### Fixed
- **Non-stream (`--output-format json`) responses now parse correctly.** Claude Code 2.1.x returns
  a JSON **array** of events; the old parser assumed a single object, so it dumped the raw JSON as
  the message content. Parsing now lives in the pure `lib/cli-output.mjs` module, which finds the
  `result` event and extracts the assistant text. Token usage is read from that event's `usage.*` /
  `total_cost_usd` instead of a character-count estimate.

### Added
- **Tool Bridge Mode hardening** (`lib/tool-bridge.mjs`):
  - **Brace-balanced `<tool_call>` parsing** — nested-object / array arguments are no longer
    truncated and silently dropped.
  - **Parallel tool calls** — multiple `<tool_call>` blocks in one turn are returned together with
    the correct `index` per call.
  - **Protocol STOP rule** — the model is instructed to stop after emitting the `<tool_call>`
    blocks, so it no longer hallucinates "results" for calls the caller hasn't run yet.
  - **Incremental streaming** of text + `tool_calls` via a scanner (no longer buffer-and-flush only).
- **Observability** — tool-call parse anomalies are counted in `/metrics`
  (`bridge_tool_parse_anomalies_total{type}`) and logged (truncated by default; set
  `BRIDGE_TOOL_PARSE_LOG_FULL=1` for full snippets). New metrics `bridge_tool_calls_total`,
  `bridge_tokens_total{type}`, and `bridge_cost_usd_total`.
- **Per-call usage CSV** (`BRIDGE_USAGE_LOG`, default `./logs/token-usage.csv`, `off` to disable) —
  appends one row per request: timestamp, source IP, model, tool mode, stream, input/output/cache
  tokens, `total_cost_usd`, duration, num turns, tool calls, finish reason, status. Lets a
  shared-host admin track usage and cost. **Metadata only — never request/response content.** Use
  one writer process per file. See [configuration](configuration.md#per-call-usage-log--tool-bridge-parsing-v150).
- **LLM-mode host isolation** (`--setting-sources ""`, `lib/config.mjs`) — `llm` mode now loads
  **none** of the host's user/project/local Claude Code settings, so its plugins, **SessionStart
  hooks**, and *user-level* `~/.claude/CLAUDE.md` no longer inject into responses (a connected client
  had observed the host's superpowers SessionStart hook bleeding into replies — verified the hook
  fired 6× by default, 0× with the flag). OAuth subscription auth is unaffected. Closes the
  user-level-config leak that v1.4.1 could only partially mitigate (project-level `CLAUDE.md`).
- **Robust model resolution + `BRIDGE_FORCE_MODEL`** (`lib/config.mjs` → `resolveModel`). A client's
  requested model is honoured only if it is a Claude model (alias or `claude-…` id, after stripping
  `bridge-claude-code/` / `claude/` / `anthropic/` prefixes); a non-Claude name from another IDE
  (Roo Code / Cline / OpenCode sending e.g. `gpt-4o`), or a missing/blank model, now **falls back to
  `CLAUDE_MODEL`** instead of erroring `claude --model gpt-4o`. New `BRIDGE_FORCE_MODEL` (empty = off)
  pins the model host-side regardless of the client — for cost control on a shared host. See
  [configuration](configuration.md#model-selection--forcing-v15).
- **Windows client launcher** (`remote-setup/connect-claude.ps1`) — one command points a Windows
  client's Claude Code at a remote bridge: health check, `ANTHROPIC_BASE_URL` + auth, the
  `api.anthropic.com` onboarding workaround, then launches `claude` in the current directory. See
  [integrations](integrations.md#windows-one-command-launcher-connect-claudeps1).

### Changed
- **Internal** — extracted pure, unit-tested modules `lib/tool-bridge.mjs`, `lib/cli-output.mjs`,
  and `lib/usage-log.mjs`. Backward compatible: no behaviour change for plain chat or the existing
  `agent` / `llm` modes, and the streaming no-tools path is byte-identical.

## v1.4.1 — 2026-06-22

### Fixed
- **LLM mode now actually isolates all tools (security).** `--tools ""` alone only disables the
  built-in set — the **LSP plugin tool and MCP connector tools survive it and run on the bridge
  host**, so the previous "no host access" guarantee was false. llm mode now also passes
  `--strict-mcp-config` and `--disallowedTools LSP`; verified against Claude Code 2.1.x that the
  session starts with an empty tool list (`tools:[]`, `mcp_servers:[]`). Hosts with other
  plugin-provided tools may need extra `--disallowedTools` names (`lib/config.mjs` →
  `LLM_DISALLOWED_TOOLS`).

### Changed
- **LLM mode now isolates the working directory.** In `llm` mode (with no explicit
  `CLAUDE_WORKING_DIR`), the bridge launches `claude` in a dedicated empty temp dir
  (`<os-tmp>/claude-code-bridge-llm-cwd`) instead of `$HOME`, so a *project-level* `CLAUDE.md`
  on the bridge host can no longer leak into responses. An explicit `CLAUDE_WORKING_DIR` still
  wins. (User-level `~/.claude/CLAUDE.md` / `settings.json` are unaffected by cwd — see
  [configuration](configuration.md#what-llm-mode-does-not-isolate).)
- **`install.ps1` / `install.sh` now default new `.env` files to `BRIDGE_TOOL_MODE=llm`** — the
  safe default for shared / LAN use. Set `BRIDGE_TOOL_MODE=agent` before install for a
  single-machine full-toolset setup. The runtime default with no env stays `agent` (backward
  compatible — existing `.env` files are untouched).
- `start.ps1`'s startup summary box adds a `ToolMode` line (from `/health`).

### Added
- `lib/config.mjs` — new exported `resolveWorkingDirForMode()` helper (with unit tests) that
  returns the isolated temp dir in `llm` mode and preserves `resolveWorkingDir()` behaviour in
  `agent` mode.

## v1.4.0 — 2026-06-22

### Added
- **LLM mode (`BRIDGE_TOOL_MODE=llm`)** — passes `--tools ""` to the `claude` subprocess,
  disabling every built-in tool (Read, Write, Edit, Bash, WebSearch, …). Claude behaves as
  a pure language model with no filesystem access. Required when the bridge is shared across
  machines: callers include file content in the prompt themselves, exactly as with any cloud
  LLM API. The AI asks callers to paste file contents if it needs them.
  - `agent` (default) — existing behaviour; all Claude Code built-in tools enabled,
    `--dangerously-skip-permissions` applied
  - `llm` — `--tools ""`, no permission bypass needed
- Startup banner now shows a `ToolMode` row; `/health` response includes a `toolMode` field
- `lib/config.mjs` — new exported `resolveToolMode()` helper (with unit tests)

## v1.3.2 — 2026-06-18

### Added
- **`start.ps1` LAN-exposure helpers** — when `BRIDGE_HOST=0.0.0.0`, `start.ps1` now:
  - **generates a `BRIDGE_API_KEY`** into `.env` if none is set (before the bridge starts, so an
    open LAN port is never left unauthenticated) and shows it in the summary;
  - writes **self-elevating** `firewall-rule-add-port-<port>.ps1` /
    `firewall-rule-delete-port-<port>.ps1` helpers — they relaunch via UAC if not Administrator
    and **pause before closing** so the result stays readable;
  - resolves the **host LAN IPv4** and shows it as a `Remote:` endpoint;
  - prints **copy-paste `curl` tests** for `/health` and `/v1/chat/completions` — a PowerShell
    single-quote form and a cmd.exe/bash backslash-escaped form (no single quoting works in both),
    with the bearer header auto-filled when a key is in effect.
- `.gitignore` ignores the generated `firewall-rule-*-port-*.ps1` helpers.

## v1.3.1 — 2026-06-17

### Fixed
- **Windows daemon startup crash** — `process.env.HOME` is undefined on Windows, so
  `start.ps1 daemon` (clean `Start-Process` environment) left `CONFIG.workingDir`
  undefined and crashed the startup banner right after binding; the daemon died and
  the health check failed. `workingDir` now resolves through
  `CLAUDE_WORKING_DIR → HOME → USERPROFILE → cwd` via the new pure
  `lib/config.mjs` helper (with unit tests)
- **`install.ps1` Claude CLI detection** — now resolves the real `claude.exe` across
  every install method. An npm `-g` install puts only shims (`claude.cmd`/`.ps1`) on
  PATH while the real binary sits in `node_modules\@anthropic-ai\claude-code\bin\claude.exe`;
  the installer now finds it via `npm root -g` / shim-directory derivation, alongside the
  native (irm) `~\.local\bin` and winget `WinGet\Links` locations. It explicitly **skips
  the Claude Desktop App Execution Alias** (`%LOCALAPPDATA%\Microsoft\WindowsApps\Claude.exe`),
  which launches the GUI instead of running `claude -p` headlessly
- **Windows temp-dir leak** — `cleanupTempFile()` derived the temp dir with a
  forward-slash-only regex that never matched Windows backslash paths, so every request
  left an empty `%TEMP%\claude-code-bridge-*` folder behind. Now uses `dirname()`; POSIX
  behaviour is unchanged

### Added
- **`uninstall.ps1`** — Windows twin of `uninstall.sh`: stops the bridge and removes
  generated files (`.env`, `*.pid`), then prompts before deleting both leftover request
  data (`%TEMP%\claude-code-bridge-*`) and `logs/` — listing the exact paths first
  (`-DeleteLogs` auto-confirms both)
- **`start.ps1 daemon` summary box** — after a successful health check it prints an
  ASCII box with the app name + version (read back from `/health`), the first
  health-check result, PID, endpoint, model, permission mode, API-key requirement, and —
  when bound to `0.0.0.0` — the wildcard listen scope

### Changed
- Health endpoint + startup banner now report `1.3.1` (the version constant had lagged at `1.3.0`)

### Docs
- README "Try it" `curl` examples are now single-line so they paste into both bash
  and PowerShell (the `\` line-continuation only works in bash; PowerShell uses a backtick)

## v1.3.0 — 2026-06-16

### Added
- **Anthropic Messages API compat** — `POST /v1/messages` (+ `POST /v1/messages/count_tokens`)
  - Lets the Anthropic SDK and Claude Code itself (`ANTHROPIC_BASE_URL` → bridge) use the bridge
  - Translation layer in `lib/anthropic-compat.mjs`: requests become the OpenAI shape and run
    through the existing pipeline; a response adapter rewrites JSON/SSE back to Anthropic shape
  - Streaming emits the full Anthropic event sequence (`message_start` → `content_block_*` →
    `message_delta` → `message_stop`), including `tool_use` blocks
- **Optional bearer auth** (`BRIDGE_API_KEY`) — when set, every endpoint except `/health` requires
  `Authorization: Bearer <key>` or `x-api-key: <key>` (timing-safe). See `lib/auth.mjs`
- **Prometheus `/metrics`** — requests/duration/auth-failures/inflight/uptime. See `lib/metrics.mjs`
- **Cross-platform** — `install.sh` / `install.ps1` / `uninstall.sh` / `start.ps1` / `stop.ps1`
- **Unit tests** — `npm test` (`node --test`) covering auth, metrics, and the Anthropic compat layer
- **`LICENSE`**, **`CLAUDE.md`**, and a restructured `docs/` (README is now a landing page)

### Changed
- The bridge self-loads `.env` (`process.loadEnvFile`) — no longer depends on `start.sh`
- Pure logic extracted into `lib/` modules (`auth`, `metrics`, `anthropic-compat`)
- CORS now allows `x-api-key` and `anthropic-version` headers
- Health endpoint reports a `supports{}` capability block; version bumped to 1.3.0

## v1.2.1 — 2026-06-15

### Changed
- **Model lineup refresh** — built-in `KNOWN_MODELS` fallback updated to the current
  Claude Code families: added `fable` / `claude-fable-5`, bumped `claude-opus-4-7`
  → `claude-opus-4-8`, kept `claude-sonnet-4-6` and `claude-haiku-4-5-20251001`
- Verified CLI compatibility against Claude Code 2.1.x — all flags used by the bridge
  (`-p`, `--model`, `--output-format`, `--verbose`, `--dangerously-skip-permissions`,
  `--permission-mode`, `--no-session-persistence`) remain valid
- Docs (`README*`, `.env.example`) updated to reflect the new model aliases/IDs

## v1.2.0 — 2026-04-21

### Added
- **Tool Bridge Mode** — supports OpenAI `tools[]` / `tool_calls` protocol
  - Injects `<tool_calling_protocol>` block into prompt with tool definitions
  - Parses `<tool_call>` XML blocks from Claude's response
  - Returns proper OpenAI `tool_calls` format with `finish_reason: "tool_calls"`
  - Streaming mode buffers output and emits `tool_calls` chunks on close
  - Multi-turn tool conversations: `tool` and `assistant(tool_calls)` messages correctly serialized back to prompt
  - No model switching needed — Claude models natively follow the tool protocol

## v1.1.0 — 2026-04-21

### Added
- **Daily log rotation** — logs written to `logs/claude-code-bridge.YYYYMMDD.log`
- **Verbose logging** — full request/response bodies and CLI I/O logged to file; toggle with `BRIDGE_VERBOSE`
- **Dynamic model list** — `GET /v1/models` fetches live list from Anthropic API when `ANTHROPIC_API_KEY` is set; falls back to built-in known model aliases
- **`.env.example`** — documented configuration template
- **`start.sh` improvements** — `pgrep`-based process detection, port conflict check, daily log path

### Changed
- Package renamed from `openclaw-bridge-claude-code` to `bridge-claude-code`
- `.gitignore` updated to exclude `logs/` directory

## v1.0.0 — 2026-04-15

### Added
- Initial release
- OpenAI-compatible `/v1/chat/completions` endpoint
- Streaming (`stream: true`) and non-streaming modes
- Dynamic model switching via request `model` field
- `--dangerously-skip-permissions` by default (`bypassPermissions` mode)
- stdin pipe for large prompts (avoids `E2BIG` on Linux)
- Structured error classification (rate limit, auth, context overflow, timeout)
- `GET /v1/models` endpoint
- `GET /health` endpoint
- `start.sh` / `stop.sh` scripts
