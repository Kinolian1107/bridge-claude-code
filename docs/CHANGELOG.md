# Changelog

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
