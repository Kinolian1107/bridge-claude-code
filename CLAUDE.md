# bridge-claude-code

This is a pure Node.js / JavaScript project: an OpenAI- and Anthropic-compatible
HTTP proxy that wraps the Claude Code CLI (`claude -p`). Zero runtime dependencies
— only Node.js built-in modules.

## Active rule scopes

Only the following global rule sets apply to this project:
- `common/*` — general development workflow, coding style, testing, security
- `typescript/*` — TypeScript/JavaScript patterns

## Ignored rule scopes

The following global rule sets are **NOT applicable** to this project and should be disregarded:
- `web/*` — frontend/browser rules (CSP, Core Web Vitals, bento layouts, Playwright E2E)
- `csharp/*` — C# / .NET rules
- `python/*` — Python rules

## Architecture

- `claude-code-bridge.mjs` — the HTTP server + request pipeline (entry point)
- `lib/auth.mjs` — optional bearer-token auth (`BRIDGE_API_KEY`), pure
- `lib/metrics.mjs` — Prometheus `/metrics` registry, pure
- `lib/anthropic-compat.mjs` — Anthropic `/v1/messages` ⇄ OpenAI translation, pure
- `tests/*.test.mjs` — `node --test` unit tests for the pure modules
- `set-*.sh` / `clearset-*.sh` — OpenClaw / Hermes Agent integration helpers

`lib/*` modules are pure (no I/O) so they can be unit-tested in isolation. New
edge-translation or policy logic should land in a `lib/` module with tests, not
inline in the server file.

## Documentation conventions

1. **README is a landing page, not a manual.** Keep `README.md` / `README.zh-TW.md`
   short and in this order: what the project can do → quick start → a simple
   example → a hierarchical "Documentation" index linking to `docs/*.md`.
   Advanced/deep content (API reference, configuration, models, integrations,
   internals) lives in `docs/`, never inline in the README.
2. **All non-README markdown lives in `docs/`.** This includes `docs/CHANGELOG.md`,
   `docs/CHANGELOG.zh-TW.md`, and topic docs (`api.md`, `configuration.md`,
   `models.md`, `integrations.md`, `how-it-works.md`). Do not create new top-level
   `.md` files (CLAUDE.md and the two READMEs are the only exceptions).
3. Every doc is bilingual: `<name>.md` (English) + `<name>.zh-TW.md` mirror,
   cross-linked via the standard header line
   (`[English](<name>.md) | [繁體中文](<name>.zh-TW.md)`). When updating one
   language, update the other.

## Testing

- `npm test` runs the suite (`node --test tests/*.test.mjs`).
- Pure modules in `lib/` must have unit tests. End-to-end changes that touch the
  `claude` subprocess path should be smoke-tested against a running bridge.
