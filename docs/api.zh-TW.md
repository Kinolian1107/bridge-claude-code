**[English](api.md)** | **[繁體中文](api.zh-TW.md)** · [← README](../README.zh-TW.md)

# API Reference

Base URL：`http://127.0.0.1:18793`（預設）。所有 endpoint 都帶寬鬆的 CORS header。

## `GET /health`

公開（永遠不需 auth）。回傳 server 狀態與 capability flags。

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

回傳可用 model。設了 `ANTHROPIC_API_KEY` 就回 Anthropic API 即時清單，否則回內建的 alias + 完整 ID 清單。見 [models.zh-TW.md](models.zh-TW.md)。

## `POST /v1/chat/completions`

OpenAI Chat Completions endpoint。支援欄位：

- `messages[]` — `system` / `user` / `assistant` / `tool` roles
- `model` — 覆寫該次 request 的 `CLAUDE_MODEL`（alias 或完整 ID；`claude/` 或 `bridge-claude-code/` 前綴會被去除）
- `stream` — `true` 啟用 SSE streaming
- `tools[]` — 觸發 [Tool Bridge Mode](models.zh-TW.md#tool-bridge-mode)

```bash
curl http://127.0.0.1:18793/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello!"}]}'
```

## `POST /v1/messages`（Anthropic Messages API）

Anthropic 相容 endpoint。讓 Anthropic SDK 與 Claude Code 本身（`ANTHROPIC_BASE_URL` → bridge）都能走 bridge。Request 會被轉成 OpenAI 形狀、走同一條 pipeline，回應再被改寫回 Anthropic 形狀（JSON 與 SSE 都支援）。

```bash
curl http://127.0.0.1:18793/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'
```

Streaming 會送出標準 Anthropic event 序列：`message_start` → `content_block_start` / `content_block_delta` / `content_block_stop` → `message_delta` → `message_stop`。tool call 會以 `tool_use` block 輸出。

### `POST /v1/messages/count_tokens`

回傳 input token 估算（與 `usage` 欄位同比例）：

```json
{ "input_tokens": 33 }
```

## `GET /metrics`

Prometheus text exposition 格式（`version=0.0.4`）。輸出的 series：

| Metric | 型別 | Labels |
|--------|------|--------|
| `bridge_requests_total` | counter | `endpoint`、`method`、`status` |
| `bridge_request_duration_seconds` | summary | `endpoint` |
| `bridge_auth_failures_total` | counter | — |
| `bridge_inflight_requests` | gauge | — |
| `bridge_uptime_seconds` | gauge | — |

未知路徑會收斂成 `endpoint="other"` label，避免 cardinality 爆量。

## Bearer auth & metrics（v1.3）

Auth **預設關閉**。設定 `BRIDGE_API_KEY` 後，除 `/health` 外每個 endpoint 都需要 key。Client 可送任一種 header：

```bash
-H "Authorization: Bearer <key>"   # OpenAI SDK 風格
-H "x-api-key: <key>"              # Anthropic SDK 風格
```

被拒的 request 回 `401`——`/v1/chat/*` 與 `/metrics` 用 OpenAI error 形狀，`/v1/messages*` 用 Anthropic error 形狀——並累加 `bridge_auth_failures_total`。比對是 timing-safe。LAN 設定見 [configuration.zh-TW.md](configuration.zh-TW.md#在-lan-上曝露-bridge)。

## 錯誤格式

OpenAI 風格 endpoint 回：

```json
{ "error": { "message": "...", "type": "auth_error", "code": 401 } }
```

Anthropic 風格 endpoint（`/v1/messages*`）回：

```json
{ "type": "error", "error": { "type": "authentication_error", "message": "..." } }
```

Error type 由 `claude` 的 exit/stderr 判定：`rate_limit`、`auth_error`、`context_overflow`、`binary_not_found`、`timeout`、`server_error`。
