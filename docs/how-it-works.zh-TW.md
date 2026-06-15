**[English](how-it-works.md)** | **[繁體中文](how-it-works.zh-TW.md)** · [← README](../README.zh-TW.md)

# 運作原理

```
OpenAI / Anthropic clients ──► claude-code-bridge (:18793) ──► claude -p --output-format stream-json ──► 你的 Claude Code 登入
```

## Request flow

1. **接收** — 進來一個 OpenAI（`/v1/chat/completions`）或 Anthropic（`/v1/messages`）request。Anthropic request 由 `lib/anthropic-compat.mjs` 轉成 OpenAI 形狀，後續 pipeline 完全相同。
2. **Auth** — 若有設 `BRIDGE_API_KEY`，檢查 bearer key（`lib/auth.mjs`）；`/health` 永遠公開。
3. **組 prompt** — `messagesToPrompt()` 把 message 陣列序列化成單一 prompt，標上 `[System Instructions]` / `[User]` / `[Assistant]` / `[Tool Result]` 區段。帶 `tools[]` 時會在前面加 `<tool_calling_protocol>` block。
4. **Spawn** — 以 `--model`、選定的 output format、permission mode 與 `--no-session-persistence` 啟動 `claude -p`。短 prompt 走 argument；長 prompt（> `BRIDGE_MAX_ARG_LEN`）走 stdin 以避開 `E2BIG`。
5. **Stream / 收集** — 解析 `claude` 的 stream-json events；文字以 OpenAI SSE chunk 轉發（或為 tool 解析 / non-streaming 而緩衝）。
6. **轉出** — `/v1/messages` 時，response adapter 在輸出端把 OpenAI JSON/SSE 改寫回 Anthropic 形狀。

## 用到的 CLI flags

| Flag | 用途 |
|------|------|
| `-p` / `--print` | 非互動 print 模式 |
| `--model <model>` | 每次 request 選 model |
| `--output-format stream-json` / `json` | 結構化 streaming / 單一結果 |
| `--verbose` | Claude Code 在 `--print` + `stream-json` 時必須帶 |
| `--dangerously-skip-permissions` | auto-approve（`bypassPermissions` 模式） |
| `--permission-mode <mode>` | `plan` / `default` 模式 |
| `--no-session-persistence` | 每個 request 獨立（不存 session） |

已對 Claude Code CLI 2.1.x 驗證。

## Auth model

bridge 從來看不到你的 Anthropic 憑證——spawn 出來的 `claude` process 用 Claude Code 自己的 auth（claude.ai OAuth 或 `ANTHROPIC_API_KEY`）。可選的 `BRIDGE_API_KEY` 是*另一道*閘門，保護 bridge 自己的 HTTP 表面，與 Claude Code 上游怎麼認證無關。

## 零依賴

bridge 只用 Node.js 內建模組。`lib/*` 模組是 pure（無 I/O），所以可獨立做 unit test（`npm test`）。
