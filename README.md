# bridge-claude-code

An OpenAI-compatible API proxy that bridges any OpenAI-compatible client to [Claude Code CLI](https://github.com/anthropics/claude-code).

> 繁體中文版請見 [README.zh-TW.md](./README.zh-TW.md)

---

## Overview

```
Any OpenAI client  ──(OpenAI API)──►  bridge-claude-code :18793  ──►  claude -p --output-format stream-json
```

`bridge-claude-code` exposes an OpenAI-compatible HTTP API (`/v1/chat/completions`, `/v1/models`) and translates every request into a `claude -p` subprocess call. Auth is handled entirely by Claude Code's own credential system — no Anthropic API key required.

---

## Features

- **OpenAI-compatible API** — drop-in replacement for any client that supports the OpenAI chat completions format
- **Streaming** — real-time SSE streaming via `--output-format stream-json`
- **Tool Bridge Mode** — translates OpenAI `tools[]` / `tool_calls` to `<tool_call>` prompt injection and back; supports multi-turn tool conversations
- **Dynamic model list** — `GET /v1/models` returns live results from the Anthropic API (if `ANTHROPIC_API_KEY` is set) or a built-in list of known model aliases
- **Daily log rotation** — logs written to `logs/claude-code-bridge.YYYYMMDD.log`
- **Verbose logging** — full request/response bodies and CLI I/O logged to file (toggle with `BRIDGE_VERBOSE`)
- **Claude.ai OAuth auth** — uses Claude Code's own login; no extra credentials needed

---

## Requirements

- Node.js 22+
- [Claude Code CLI](https://github.com/anthropics/claude-code) installed and authenticated

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

---

## Quick Start

```bash
git clone https://github.com/Kinolian1107/bridge-claude-code.git
cd bridge-claude-code

# Foreground
node claude-code-bridge.mjs

# Background daemon
./start.sh daemon
```

The server starts on `http://127.0.0.1:18793`.

---

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `BRIDGE_PORT` | `18793` | HTTP port |
| `BRIDGE_HOST` | `127.0.0.1` | Bind address |
| `CLAUDE_MODEL` | `sonnet` | Default Claude model |
| `CLAUDE_BIN` | `claude` | Path to claude binary |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | `bypassPermissions` / `plan` / `default` |
| `CLAUDE_WORKING_DIR` | `$HOME` | Working directory for claude subprocess |
| `BRIDGE_TIMEOUT_MS` | `300000` | Request timeout (ms) |
| `BRIDGE_VERBOSE` | `true` | Log full request/response bodies to file |
| `ANTHROPIC_API_KEY` | _(unset)_ | If set, enables live model list from Anthropic API |

---

## API Endpoints

### `GET /health`

Returns server status.

```json
{ "status": "ok", "service": "claude-code-bridge", "version": "1.2.0", "model": "sonnet" }
```

### `GET /v1/models`

Returns available models. Live list if `ANTHROPIC_API_KEY` is set; otherwise returns built-in aliases.

```
sonnet, opus, haiku, claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001
```

### `POST /v1/chat/completions`

Standard OpenAI chat completions endpoint. Supports:
- `messages[]` — system / user / assistant / tool roles
- `model` — overrides `CLAUDE_MODEL` for this request
- `stream` — `true` for SSE streaming
- `tools[]` — triggers Tool Bridge Mode (see below)

---

## Tool Bridge Mode

When `tools[]` is included in the request, the bridge enters **Tool Bridge Mode**:

1. Tool definitions are injected into the prompt as a `<tool_calling_protocol>` block
2. Claude outputs `<tool_call>` XML blocks when it wants to invoke a tool
3. The bridge parses those blocks and returns a proper OpenAI `tool_calls` response

```
Request (tools[])  →  prompt + <tool_calling_protocol>  →  claude  →  <tool_call> block  →  tool_calls response
```

**Non-streaming response with tool call:**

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\": \"Taipei\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

**Multi-turn tool conversations** are fully supported — `tool` role messages and `assistant` messages with `tool_calls` are correctly serialized back into the prompt for subsequent turns.

### Tool Calling vs. Cursor Bridge

Unlike `bridge-cursor-cli`, **no model switching is required** — Claude models natively follow the tool protocol without treating it as prompt injection.

---

## Model Selection

Pass `model` in the request body to override the default:

```json
{ "model": "opus", "messages": [...] }
```

Supported aliases (always available):

| Alias | Model |
|---|---|
| `sonnet` | Claude Sonnet (latest) |
| `opus` | Claude Opus (latest) |
| `haiku` | Claude Haiku (latest) |

Full model IDs (e.g. `claude-sonnet-4-6`) are also accepted. Prefix `bridge-claude-code/` or `claude/` is automatically stripped.

---

## Logs

Logs are written to `logs/claude-code-bridge.YYYYMMDD.log` with daily rotation.

To disable verbose request/response logging:

```bash
BRIDGE_VERBOSE=false node claude-code-bridge.mjs
```

---

## Start / Stop

```bash
# Start foreground
node claude-code-bridge.mjs

# Start background daemon
./start.sh daemon

# Stop
./stop.sh
```

---

## OpenClaw Integration

```
baseUrl:  http://127.0.0.1:18793/v1
apiKey:   claude-code-bridge-local
api:      openai-completions
```

---

## Version History

See [CHANGELOG.md](./CHANGELOG.md).

---

## License

MIT
