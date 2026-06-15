**[English](models.md)** | **[繁體中文](models.zh-TW.md)** · [← README](../README.md)

# Models

## Selecting a model

Set the default in `.env` (`CLAUDE_MODEL=sonnet`) or override per request via the
`model` field. Aliases always resolve to the latest snapshot of each family, so
they survive model renames:

| Alias | Family |
|-------|--------|
| `fable` | Claude Fable (latest flagship) |
| `opus` | Claude Opus (most capable) |
| `sonnet` | Claude Sonnet (balanced, default) |
| `haiku` | Claude Haiku (fastest, cheapest) |

Full model IDs are also accepted, e.g. `claude-opus-4-8`, `claude-sonnet-4-6`,
`claude-fable-5`, `claude-haiku-4-5-20251001`. A `claude/` or
`bridge-claude-code/` prefix on the requested model is stripped automatically.

## `GET /v1/models`

- **Without `ANTHROPIC_API_KEY`** — returns the built-in list (aliases + known full IDs):
  ```
  fable, sonnet, opus, haiku,
  claude-fable-5, claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5-20251001
  ```
- **With `ANTHROPIC_API_KEY`** — fetches the live list from `https://api.anthropic.com/v1/models` (cached after the first call).

The built-in list is kept in sync with the Claude Code model lineup; aliases
always work regardless of the list because `claude --model <alias>` resolves them.

## Tool Bridge Mode

When a request includes `tools[]`, the bridge enters **Tool Bridge Mode**:

1. Tool definitions are injected into the prompt as a `<tool_calling_protocol>` block.
2. Claude outputs `<tool_call>` blocks when it wants to invoke a tool.
3. The bridge parses those blocks and returns a proper OpenAI `tool_calls`
   response (`finish_reason: "tool_calls"`), or Anthropic `tool_use` blocks on
   `/v1/messages`.

```
Request (tools[]) → prompt + <tool_calling_protocol> → claude → <tool_call> block → tool_calls response
```

Multi-turn tool conversations are fully supported — `tool` role messages and
`assistant` messages with `tool_calls` are serialized back into the prompt for
subsequent turns.

### No model switching required

Unlike `bridge-cursor-cli` (where Claude models reject the tool protocol as
prompt injection and a codex model must be substituted), **Claude Code models
natively follow the tool protocol** — the bridge never swaps the model for tool
calls.
