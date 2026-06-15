**[English](how-it-works.md)** | **[繁體中文](how-it-works.zh-TW.md)** · [← README](../README.md)

# How It Works

```
OpenAI / Anthropic clients ──► claude-code-bridge (:18793) ──► claude -p --output-format stream-json ──► your Claude Code auth
```

## Request flow

1. **Receive** — an OpenAI (`/v1/chat/completions`) or Anthropic (`/v1/messages`)
   request arrives. Anthropic requests are translated to the OpenAI shape by
   `lib/anthropic-compat.mjs` so the rest of the pipeline is identical.
2. **Auth** — if `BRIDGE_API_KEY` is set, the bearer key is checked
   (`lib/auth.mjs`); `/health` is always public.
3. **Build prompt** — `messagesToPrompt()` serializes the message array into a
   single prompt, labelling `[System Instructions]` / `[User]` / `[Assistant]` /
   `[Tool Result]` sections. When `tools[]` is present, a `<tool_calling_protocol>`
   block is prepended.
4. **Spawn** — `claude -p` is spawned with `--model`, the chosen output format,
   the permission mode, and `--no-session-persistence`. Short prompts go as an
   argument; long prompts (> `BRIDGE_MAX_ARG_LEN`) are piped via stdin to avoid
   `E2BIG`.
5. **Stream / collect** — stream-json events from `claude` are parsed; text is
   forwarded as OpenAI SSE chunks (or buffered for tool parsing / non-streaming).
6. **Translate out** — for `/v1/messages`, a response adapter rewrites the OpenAI
   JSON/SSE back into Anthropic shape on the way out.

## CLI flags used

| Flag | Why |
|------|-----|
| `-p` / `--print` | Non-interactive print mode |
| `--model <model>` | Per-request model selection |
| `--output-format stream-json` / `json` | Structured streaming / single result |
| `--verbose` | Required by Claude Code when `--print` + `stream-json` |
| `--dangerously-skip-permissions` | Auto-approve (`bypassPermissions` mode) |
| `--permission-mode <mode>` | `plan` / `default` modes |
| `--no-session-persistence` | Each request is independent (no saved session) |

Verified against Claude Code CLI 2.1.x.

## Auth model

The bridge never sees your Anthropic credentials — the spawned `claude` process
uses Claude Code's own auth (claude.ai OAuth or `ANTHROPIC_API_KEY`). The
optional `BRIDGE_API_KEY` is a *separate* gate that protects the bridge's own
HTTP surface, independent of how Claude Code authenticates upstream.

## Zero dependencies

The bridge uses only Node.js built-in modules. The `lib/*` modules are pure (no
I/O) so they are unit-tested in isolation (`npm test`).
