**[English](CHANGELOG.md)** | **[繁體中文](CHANGELOG.zh-TW.md)** · [← README](../README.zh-TW.md)

# Changelog

## v1.3.0 — 2026-06-16

### 新增
- **Anthropic Messages API 相容** — `POST /v1/messages`（+ `POST /v1/messages/count_tokens`）
  - 讓 Anthropic SDK 與 Claude Code 本身（`ANTHROPIC_BASE_URL` → bridge）都能用 bridge
  - 轉換層在 `lib/anthropic-compat.mjs`：request 轉成 OpenAI 形狀走既有 pipeline，response adapter 再把 JSON/SSE 改寫回 Anthropic 形狀
  - Streaming 輸出完整 Anthropic event 序列（`message_start` → `content_block_*` → `message_delta` → `message_stop`），含 `tool_use` block
- **可選 bearer auth**（`BRIDGE_API_KEY`）— 設定後除 `/health` 外每個 endpoint 都需要 `Authorization: Bearer <key>` 或 `x-api-key: <key>`（timing-safe）。見 `lib/auth.mjs`
- **Prometheus `/metrics`** — requests/duration/auth-failures/inflight/uptime。見 `lib/metrics.mjs`
- **跨平台** — `install.sh` / `install.ps1` / `uninstall.sh` / `start.ps1` / `stop.ps1`
- **單元測試** — `npm test`（`node --test`）涵蓋 auth、metrics 與 Anthropic compat 層
- **`LICENSE`**、**`CLAUDE.md`**，以及重構過的 `docs/`（README 改為 landing page）

### 變更
- bridge 自行載入 `.env`（`process.loadEnvFile`）——不再依賴 `start.sh`
- 純邏輯抽出成 `lib/` 模組（`auth`、`metrics`、`anthropic-compat`）
- CORS 現在允許 `x-api-key` 與 `anthropic-version` header
- Health endpoint 回報 `supports{}` capability 區塊；版本升到 1.3.0

## v1.2.1 — 2026-06-15

### 變更
- **Model lineup 更新** — 內建 `KNOWN_MODELS` fallback 更新到目前的 Claude Code 家族：新增 `fable` / `claude-fable-5`、`claude-opus-4-7` → `claude-opus-4-8`，保留 `claude-sonnet-4-6` 與 `claude-haiku-4-5-20251001`
- 對 Claude Code 2.1.x 驗證 CLI 相容性——bridge 用到的 flag（`-p`、`--model`、`--output-format`、`--verbose`、`--dangerously-skip-permissions`、`--permission-mode`、`--no-session-persistence`）皆有效
- 文件（`README*`、`.env.example`）更新以反映新的 model aliases/IDs

## v1.2.0 — 2026-04-21

### 新增
- **Tool Bridge Mode** — 支援 OpenAI `tools[]` / `tool_calls` protocol
  - 把 `<tool_calling_protocol>` block 注入 prompt
  - 解析 Claude 回應中的 `<tool_call>` XML block
  - 回傳正確的 OpenAI `tool_calls` 格式（`finish_reason: "tool_calls"`）
  - Streaming 模式緩衝輸出，並在 close 時送出 `tool_calls` chunk
  - 多輪 tool 對話：`tool` 與 `assistant(tool_calls)` 訊息正確序列化回 prompt
  - 不需切換 model——Claude 系 model 原生遵守 tool protocol

## v1.1.0 — 2026-04-21

### 新增
- **每日 log 輪替** — log 寫到 `logs/claude-code-bridge.YYYYMMDD.log`
- **Verbose logging** — 完整 request/response body 與 CLI I/O 記到檔案；以 `BRIDGE_VERBOSE` 切換
- **動態 model list** — 設 `ANTHROPIC_API_KEY` 時 `GET /v1/models` 抓 Anthropic API 即時清單，否則 fallback 內建 alias
- **`.env.example`** — 設定範本
- **`start.sh` 改進** — `pgrep` 偵測、port 衝突檢查、每日 log 路徑

### 變更
- 套件由 `openclaw-bridge-claude-code` 改名為 `bridge-claude-code`
- `.gitignore` 排除 `logs/`

## v1.0.0 — 2026-04-15

### 新增
- 初版發佈
- OpenAI 相容 `/v1/chat/completions` endpoint
- Streaming（`stream: true`）與 non-streaming 模式
- 透過 request `model` 欄位動態切換 model
- 預設 `--dangerously-skip-permissions`（`bypassPermissions` 模式）
- 大 prompt 走 stdin pipe（避免 Linux `E2BIG`）
- 結構化 error 分類（rate limit、auth、context overflow、timeout）
- `GET /v1/models` endpoint
- `GET /health` endpoint
- `start.sh` / `stop.sh` 腳本
