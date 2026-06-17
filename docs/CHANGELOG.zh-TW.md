**[English](CHANGELOG.md)** | **[繁體中文](CHANGELOG.zh-TW.md)** · [← README](../README.zh-TW.md)

# Changelog

## v1.3.1 — 2026-06-17

### 修正
- **Windows daemon 啟動崩潰** — Windows 沒有 `process.env.HOME`，所以
  `start.ps1 daemon`（乾淨的 `Start-Process` 環境）會讓 `CONFIG.workingDir` 變成
  undefined，在 bind 之後印橫幅時立刻崩潰，daemon 死掉、health check 失敗。
  `workingDir` 改為依序 `CLAUDE_WORKING_DIR → HOME → USERPROFILE → cwd` 解析，
  邏輯放進新的純模組 `lib/config.mjs`（含單元測試）
- **`install.ps1` Claude CLI 偵測** — 現在能在各種安裝方式下解析出真正的 `claude.exe`。
  npm `-g` 安裝只會在 PATH 放 shim（`claude.cmd`/`.ps1`），真正的執行檔藏在
  `node_modules\@anthropic-ai\claude-code\bin\claude.exe`；安裝程式改用 `npm root -g` /
  從 shim 目錄反推來找到它，並涵蓋原生（irm）的 `~\.local\bin` 與 winget 的 `WinGet\Links`
  位置。同時會明確**跳過 Claude Desktop 的 App Execution Alias**
  （`%LOCALAPPDATA%\Microsoft\WindowsApps\Claude.exe`）——它會啟動 GUI，而非以 `claude -p`
  無頭執行
- **Windows temp 目錄洩漏** — `cleanupTempFile()` 原本用只認正斜線的 regex 取目錄，
  在 Windows 反斜線路徑上完全不 match，導致每個 request 都殘留一個空的
  `%TEMP%\claude-code-bridge-*` 資料夾。改用 `dirname()`；POSIX 行為不變

### 新增
- **`uninstall.ps1`** — `uninstall.sh` 的 Windows 雙生版：停掉 bridge、移除產生的檔案
  （`.env`、`*.pid`），接著在刪除殘留的 request 資料（`%TEMP%\claude-code-bridge-*`）
  與 `logs/` 前都會先列出實際路徑再詢問（`-DeleteLogs` 兩者皆自動確認）
- **`start.ps1 daemon` 摘要框** — health check 成功後印出 ASCII 框，顯示應用名 + 版本
  （從 `/health` 回讀）、首次 health check 結果、PID、endpoint、model、permission mode、
  API key 需求，以及——綁定 `0.0.0.0` 時——wildcard 監聽範圍

### 變更
- Health endpoint 與啟動橫幅現在回報 `1.3.1`（版本常數先前一直停在 `1.3.0`）

### 文件
- README「Try it」的 `curl` 範例改為單行，bash 與 PowerShell 都能直接貼上執行
  （`\` 換行接續只在 bash 有效；PowerShell 用的是反引號 backtick）

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
