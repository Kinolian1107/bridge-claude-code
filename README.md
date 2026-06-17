**[English](README.md)** | **[繁體中文](README.zh-TW.md)**

# bridge-claude-code

Turn your **Claude Code** login into a local AI API server. bridge-claude-code wraps the [Claude Code CLI](https://github.com/anthropics/claude-code) (`claude -p`) in an HTTP proxy that speaks both the **OpenAI** and **Anthropic** wire formats — so any AI client can drive Claude (Fable 5, Opus 4.8, Sonnet 4.6, Haiku 4.5) **without an Anthropic API key**. Runs on **Linux, macOS and Windows**.

## What it can do

- **OpenAI-compatible API** — `POST /v1/chat/completions` (streaming & non-streaming) works with OpenClaw, Hermes Agent, Continue.dev, the OpenAI SDK, or plain `curl`
- **Anthropic-compatible API** (v1.3) — `POST /v1/messages` lets the Anthropic SDK and even **Claude Code** (`ANTHROPIC_BASE_URL`) run through the bridge
- **Tool calling** — full multi-turn `tools` loop; no model switching needed (Claude follows the tool protocol natively)
- **Ops-ready** (v1.3) — optional bearer auth (`BRIDGE_API_KEY`) for LAN/Tailscale use, Prometheus `/metrics`, daily-rotated logs
- **Cross-platform** — `install.sh`/`start.sh`/`stop.sh`/`uninstall.sh` with native PowerShell twins (`install.ps1`/`start.ps1`/`stop.ps1`/`uninstall.ps1`); long prompts go via stdin to dodge OS command-line limits
- **Zero dependencies** — pure Node.js built-in modules; auth is handled entirely by Claude Code's own login

```
OpenAI / Anthropic clients ──► bridge-claude-code (:18793) ──► claude -p ──► your Claude Code auth
```

## Quick Start

Requirements: **Node.js ≥ 22** and the [Claude Code CLI](https://github.com/anthropics/claude-code) logged in.

### Install Node.js first (if you don't have it)

The bridge is pure Node.js — without it nothing will run. Check what you have:

```bash
node --version   # must print v22.0.0 or higher
```

If the command is missing or the version is below 22, install it:

```bash
# Linux / macOS / WSL — nvm (recommended, no sudo)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# reopen your terminal, then:
nvm install 22

# macOS — Homebrew
brew install node@22

# Ubuntu / Debian — NodeSource apt repo
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
```

```powershell
# Windows — winget (or download the LTS installer from https://nodejs.org)
winget install OpenJS.NodeJS.LTS
```

### Install the Claude Code CLI

**Windows (recommended):**
```powershell
irm https://claude.ai/install.ps1 | iex
# or: winget install Anthropic.ClaudeCode
```

**Linux / macOS:**
```bash
npm install -g @anthropic-ai/claude-code
```

Then authenticate:
```bash
claude auth login
```

### Install & run the bridge

**Linux / macOS / WSL:**

```bash
git clone https://github.com/Kinolian1107/bridge-claude-code.git
cd bridge-claude-code

./install.sh        # checks Node + claude, creates .env
./start.sh daemon   # start in the background (stop: ./stop.sh)
```

**Windows (PowerShell):**

```powershell
git clone https://github.com/Kinolian1107/bridge-claude-code.git
cd bridge-claude-code

.\install.ps1        # detects claude, creates .env
.\start.ps1 daemon   # start in the background (stop: .\stop.ps1)
```

Or manually on any platform: `cp .env.example .env` and `node claude-code-bridge.mjs` — the bridge loads `.env` by itself.

## Try it

```bash
# Health check + model list
curl http://127.0.0.1:18793/health
curl http://127.0.0.1:18793/v1/models

# OpenAI format (single line — works in bash and PowerShell)
curl http://127.0.0.1:18793/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello!"}]}'

# Anthropic format — or point ANTHROPIC_BASE_URL here and use the SDK / Claude Code
curl http://127.0.0.1:18793/v1/messages -H "Content-Type: application/json" -d '{"model":"sonnet","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'
```

## Documentation

| Topic | Read this |
|-------|-----------|
| **API reference** — endpoints, Anthropic Messages API, bearer auth & Prometheus metrics | [docs/api.md](docs/api.md) |
| **Configuration** — all env vars, Claude Code auth, logs, troubleshooting, uninstall | [docs/configuration.md](docs/configuration.md) |
| └ LAN / network exposure — share the bridge with other machines (incl. WSL2 port forwarding) | [docs/configuration.md](docs/configuration.md#exposing-the-bridge-on-a-lan) |
| **Models** — aliases, recommended models, live model list, Tool Bridge Mode | [docs/models.md](docs/models.md) |
| **Integrations** — Hermes Agent, OpenClaw, Anthropic SDK / Claude Code, OpenAI SDK | [docs/integrations.md](docs/integrations.md) |
| **How it works** — request flow, CLI flags, auth model | [docs/how-it-works.md](docs/how-it-works.md) |
| **Changelog** — full version history | [docs/CHANGELOG.md](docs/CHANGELOG.md) |

Every doc has a Traditional Chinese mirror (`*.zh-TW.md`).

## Tests

```bash
npm test
```

## Uninstall

```bash
./uninstall.sh     # Linux / macOS / WSL
.\uninstall.ps1    # Windows (PowerShell)
```

## License

MIT — see [LICENSE](LICENSE).
