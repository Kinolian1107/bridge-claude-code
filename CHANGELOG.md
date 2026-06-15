# Changelog

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
