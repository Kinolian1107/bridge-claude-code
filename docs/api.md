**[English](api.md)** | **[繁體中文](api.zh-TW.md)** · [← README](../README.md)

# API Reference

Base URL: `http://127.0.0.1:18793` (default). All endpoints set permissive CORS headers.

## `GET /health`

Public (never requires auth). Returns server status and capability flags.

```json
{
  "status": "ok",
  "service": "claude-code-bridge",
  "version": "1.3.0",
  "model": "sonnet",
  "permissionMode": "bypassPermissions",
  "supports": {
    "anthropic_messages": true,
    "bearer_auth": false,
    "metrics": true,
    "tool_bridge": true,
    "streaming": true
  }
}
```

## `GET /v1/models`

Returns available models. Live list from the Anthropic API if `ANTHROPIC_API_KEY` is set; otherwise a built-in list of aliases + full IDs. See [models.md](models.md).

## `POST /v1/chat/completions`

OpenAI Chat Completions endpoint. Supported fields:

- `messages[]` — `system` / `user` / `assistant` / `tool` roles
- `model` — overrides `CLAUDE_MODEL` for this request (alias or full ID; a `claude/` or `bridge-claude-code/` prefix is stripped)
- `stream` — `true` for SSE streaming
- `tools[]` — triggers [Tool Bridge Mode](models.md#tool-bridge-mode)

```bash
curl http://127.0.0.1:18793/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello!"}]}'
```

## `POST /v1/messages` (Anthropic Messages API)

Anthropic-compatible endpoint. Lets the Anthropic SDK and Claude Code itself
(`ANTHROPIC_BASE_URL` → bridge) talk to the bridge. The request is translated to
the OpenAI shape, run through the same pipeline, and the response is rewritten
back to Anthropic shape (both JSON and SSE).

```bash
curl http://127.0.0.1:18793/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'
```

Streaming emits the standard Anthropic event sequence: `message_start` →
`content_block_start` / `content_block_delta` / `content_block_stop` →
`message_delta` → `message_stop`. `tool_use` blocks are emitted for tool calls.

### `POST /v1/messages/count_tokens`

Returns an input-token estimate (same ratio as the `usage` fields):

```json
{ "input_tokens": 33 }
```

## `GET /metrics`

Prometheus text exposition format (`version=0.0.4`). Exposed series:

| Metric | Type | Labels |
|--------|------|--------|
| `bridge_requests_total` | counter | `endpoint`, `method`, `status` |
| `bridge_request_duration_seconds` | summary | `endpoint` |
| `bridge_auth_failures_total` | counter | — |
| `bridge_inflight_requests` | gauge | — |
| `bridge_uptime_seconds` | gauge | — |

Unknown paths collapse into the `endpoint="other"` label to keep cardinality bounded.

## Bearer auth & metrics (v1.3)

Auth is **off by default**. Set `BRIDGE_API_KEY` to require a key on every
endpoint except `/health`. Clients may send either header form:

```bash
-H "Authorization: Bearer <key>"   # OpenAI SDK style
-H "x-api-key: <key>"              # Anthropic SDK style
```

Rejected requests return `401` — OpenAI error shape on `/v1/chat/*` and
`/metrics`, Anthropic error shape on `/v1/messages*` — and increment
`bridge_auth_failures_total`. The comparison is timing-safe. See
[configuration.md](configuration.md#exposing-the-bridge-on-a-lan) for LAN setup.

## Error format

OpenAI-style endpoints return:

```json
{ "error": { "message": "...", "type": "auth_error", "code": 401 } }
```

Anthropic-style endpoints (`/v1/messages*`) return:

```json
{ "type": "error", "error": { "type": "authentication_error", "message": "..." } }
```

Error types are classified from the `claude` exit/stderr: `rate_limit`,
`auth_error`, `context_overflow`, `binary_not_found`, `timeout`, `server_error`.
