**[English](models.md)** | **[繁體中文](models.zh-TW.md)** · [← README](../README.zh-TW.md)

# 模型

## 選擇 model

在 `.env` 設預設（`CLAUDE_MODEL=sonnet`），或每次 request 用 `model` 欄位覆寫。Alias 永遠對應到各家族的最新 snapshot，所以模型改名也不會壞：

| Alias | 家族 |
|-------|------|
| `fable` | Claude Fable（最新 flagship） |
| `opus` | Claude Opus（最強） |
| `sonnet` | Claude Sonnet（均衡，預設） |
| `haiku` | Claude Haiku（最快最便宜） |

也接受完整 model ID，例如 `claude-opus-4-8`、`claude-sonnet-4-6`、`claude-fable-5`、`claude-haiku-4-5-20251001`。requested model 上的 `claude/` 或 `bridge-claude-code/` 前綴會被自動去除。

## `GET /v1/models`

- **沒設 `ANTHROPIC_API_KEY`** — 回內建清單（alias + 已知完整 ID）：
  ```
  fable, sonnet, opus, haiku,
  claude-fable-5, claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5-20251001
  ```
- **有設 `ANTHROPIC_API_KEY`** — 從 `https://api.anthropic.com/v1/models` 抓即時清單（第一次抓完後 cache）。

內建清單會跟著 Claude Code 的 model lineup 維護；不論清單如何，alias 永遠可用，因為 `claude --model <alias>` 會自己解析。

## Tool Bridge Mode

當 request 帶 `tools[]`，bridge 進入 **Tool Bridge Mode**：

1. Tool 定義以 `<tool_calling_protocol>` block 注入 prompt。
2. Claude 想呼叫工具時輸出 `<tool_call>` block。
3. bridge 解析這些 block，回傳正確的 OpenAI `tool_calls` 回應（`finish_reason: "tool_calls"`），或在 `/v1/messages` 回 Anthropic `tool_use` block。

```
Request (tools[]) → prompt + <tool_calling_protocol> → claude → <tool_call> block → tool_calls 回應
```

完整支援多輪 tool 對話——`tool` role 訊息與帶 `tool_calls` 的 `assistant` 訊息會被序列化回 prompt 供後續輪使用。

### 不需要切換 model

不像 `bridge-cursor-cli`（Claude 系 model 會把 tool protocol 當成 prompt injection 拒絕，必須換成 codex model），**Claude Code 系 model 原生就遵守 tool protocol**——bridge 從不為了 tool call 換 model。
