# bridge-claude-code

將任何相容 OpenAI API 的客戶端橋接到 [Claude Code CLI](https://github.com/anthropics/claude-code) 的代理伺服器。

> English version: [README.md](./README.md)

---

## 架構概覽

```
任何 OpenAI 客戶端  ──(OpenAI API)──►  bridge-claude-code :18793  ──►  claude -p --output-format stream-json
```

`bridge-claude-code` 提供標準的 OpenAI 相容 HTTP API（`/v1/chat/completions`、`/v1/models`），將每個請求轉換為 `claude -p` 子行程呼叫。認證完全由 Claude Code 自己的憑證系統處理，**不需要 Anthropic API Key**。

---

## 功能特點

- **OpenAI 相容 API** — 任何支援 OpenAI chat completions 格式的客戶端皆可直接使用
- **串流輸出** — 透過 `--output-format stream-json` 實現即時 SSE 串流
- **工具橋接模式（Tool Bridge Mode）** — 將 OpenAI `tools[]` / `tool_calls` 轉換為 `<tool_call>` prompt 注入，並解析回傳；支援多輪工具對話
- **動態模型列表** — `GET /v1/models` 若設定 `ANTHROPIC_API_KEY` 則從 Anthropic API 即時取得，否則返回內建的已知模型清單
- **每日 Log 輪換** — 日誌寫入 `logs/claude-code-bridge.YYYYMMDD.log`，每天一份
- **詳細日誌** — 完整的請求/回應內容與 CLI I/O 記錄（可透過 `BRIDGE_VERBOSE` 控制）
- **Claude.ai OAuth 認證** — 使用 Claude Code 自己的登入機制，無需額外憑證

---

## 需求

- Node.js 22+
- 已安裝並登入的 [Claude Code CLI](https://github.com/anthropics/claude-code)

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

---

## 快速開始

```bash
git clone https://github.com/Kinolian1107/bridge-claude-code.git
cd bridge-claude-code

# 前景執行
node claude-code-bridge.mjs

# 背景 daemon 模式
./start.sh daemon
```

伺服器啟動於 `http://127.0.0.1:18793`。

---

## 設定

複製 `.env.example` 為 `.env` 並依需求調整：

```bash
cp .env.example .env
```

| 環境變數 | 預設值 | 說明 |
|---|---|---|
| `BRIDGE_PORT` | `18793` | HTTP 埠號 |
| `BRIDGE_HOST` | `127.0.0.1` | 綁定位址 |
| `CLAUDE_MODEL` | `sonnet` | 預設 Claude 模型 |
| `CLAUDE_BIN` | `claude` | claude 執行檔路徑 |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | `bypassPermissions` / `plan` / `default` |
| `CLAUDE_WORKING_DIR` | `$HOME` | claude 子行程的工作目錄 |
| `BRIDGE_TIMEOUT_MS` | `300000` | 請求逾時（毫秒） |
| `BRIDGE_VERBOSE` | `true` | 是否將完整請求/回應內容寫入日誌 |
| `ANTHROPIC_API_KEY` | _(未設定)_ | 若設定，則啟用從 Anthropic API 即時取得模型清單 |

---

## API 端點

### `GET /health`

返回伺服器狀態。

```json
{ "status": "ok", "service": "claude-code-bridge", "version": "1.2.0", "model": "sonnet" }
```

### `GET /v1/models`

返回可用的模型列表。若設定 `ANTHROPIC_API_KEY` 則為即時清單，否則返回內建清單：

```
sonnet, opus, haiku, claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001
```

### `POST /v1/chat/completions`

標準 OpenAI chat completions 端點，支援：
- `messages[]` — system / user / assistant / tool 角色
- `model` — 覆蓋本次請求的 `CLAUDE_MODEL`
- `stream` — `true` 啟用 SSE 串流
- `tools[]` — 觸發工具橋接模式（詳見下方）

---

## 工具橋接模式（Tool Bridge Mode）

當請求包含 `tools[]` 時，bridge 進入**工具橋接模式**：

1. 工具定義以 `<tool_calling_protocol>` block 的形式注入到 prompt 最前方
2. Claude 在需要呼叫工具時輸出 `<tool_call>` XML block
3. Bridge 解析這些 block，轉換成標準 OpenAI `tool_calls` 格式回傳

```
請求 (tools[])  →  prompt + <tool_calling_protocol>  →  claude  →  <tool_call> block  →  tool_calls 回應
```

**非串流模式的工具呼叫回應範例：**

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

**多輪工具對話**完整支援 — `tool` 角色訊息和帶有 `tool_calls` 的 `assistant` 訊息，在後續輪次中會被正確序列化回 prompt。

### 與 Cursor Bridge 的差異

與 `bridge-cursor-cli` 不同，**無需切換模型** — Claude 模型原生遵守工具協定，不會把 tool protocol 當成 prompt injection 而拒絕。

---

## 模型選擇

在請求 body 中傳入 `model` 覆蓋預設值：

```json
{ "model": "opus", "messages": [...] }
```

內建支援的別名：

| 別名 | 對應模型 |
|---|---|
| `sonnet` | Claude Sonnet（最新版） |
| `opus` | Claude Opus（最新版） |
| `haiku` | Claude Haiku（最新版） |

也接受完整模型 ID（如 `claude-sonnet-4-6`）。前綴 `bridge-claude-code/` 或 `claude/` 會被自動去除。

---

## 日誌

日誌寫入 `logs/claude-code-bridge.YYYYMMDD.log`，每天自動輪換。

停用詳細日誌（減少磁碟寫入）：

```bash
BRIDGE_VERBOSE=false node claude-code-bridge.mjs
```

---

## 啟動 / 停止

```bash
# 前景執行
node claude-code-bridge.mjs

# 背景 daemon
./start.sh daemon

# 停止
./stop.sh
```

---

## OpenClaw 整合

### 手動設定

```
baseUrl:  http://127.0.0.1:18793/v1
apiKey:   claude-code-bridge-local
api:      openai-completions
```

### 自動設定腳本

```bash
# 設定 OpenClaw 使用 bridge-claude-code（修改 openclaw.json，可選重啟 gateway）
./set-openclaw.sh

# 移除整合並還原原始設定
./clearset-openclaw.sh
```

`set-openclaw.sh` 執行流程：
1. 偵測 bridge 是否執行中，並透過 `/v1/models` 取得即時模型清單
2. 備份 `~/.openclaw/openclaw.json` 為 `openclaw.json.bak.pre-claude-bridge`
3. 注入 `claude-cli` provider 並設為預設模型
4. 可選重啟 OpenClaw gateway

---

## Hermes Agent 整合

```bash
# 設定 Hermes Agent 使用 bridge-claude-code
./set-hermesagent.sh

# 移除整合並還原原始設定
./clearset-hermesagent.sh
```

`set-hermesagent.sh` 執行流程：
1. 偵測 `hermes` 執行檔並確認 bridge 是否執行中
2. 備份 `~/.hermes/config.yaml` 為 `config.yaml.bak.pre-claude-bridge`
3. 設定 `model.provider = custom`，指向 bridge base URL 與預設模型
4. 從 `/v1/models` 同步所有即時模型至 `custom_providers`
5. 可選重啟 Hermes gateway

---

## 版本歷史

詳見 [CHANGELOG.md](./CHANGELOG.md)。

---

## 授權

MIT
