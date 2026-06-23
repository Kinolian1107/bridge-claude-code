**[English](integrations.md)** | **[繁體中文](integrations.zh-TW.md)** · [← README](../README.md)

# Integrations

Any OpenAI- or Anthropic-compatible client works. Point its base URL at the
bridge (`http://127.0.0.1:18793/v1`); if `BRIDGE_API_KEY` is set, pass it as the
API key.

## OpenClaw

### Automated

```bash
./set-openclaw.sh        # patch openclaw.json + sync model list
./clearset-openclaw.sh   # revert from backup
```

`set-openclaw.sh` will:
1. Detect a running bridge and probe `/v1/models` for the live model list
2. Back up `~/.openclaw/openclaw.json` to `openclaw.json.bak.pre-claude-bridge`
3. Inject the `claude-cli` provider and set it as the default model
4. Optionally restart the OpenClaw gateway

### Manual

```
baseUrl:  http://127.0.0.1:18793/v1
apiKey:   claude-code-bridge-local   (or your BRIDGE_API_KEY)
api:      openai-completions
```

## Hermes Agent

### Automated

```bash
./set-hermesagent.sh        # configure provider + sync models
./clearset-hermesagent.sh   # revert from backup
```

`set-hermesagent.sh` will:
1. Detect the `hermes` binary and verify the bridge is running
2. Back up `~/.hermes/config.yaml` to `config.yaml.bak.pre-claude-bridge`
3. Set `model.provider = custom` with the bridge base URL and default model
4. Sync all live models from `/v1/models` into `custom_providers`
5. Optionally restart the Hermes gateway

## Anthropic SDK / Claude Code

Because the bridge exposes `/v1/messages`, any Anthropic client can point at it:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18793
export ANTHROPIC_API_KEY=<your BRIDGE_API_KEY, or any value if auth is off>
```

The Anthropic Python/TypeScript SDK and Claude Code itself then route through the
bridge — useful for local auto-approve workflows.

### Windows one-command launcher (`connect-claude.ps1`)

For Windows clients, [`remote-setup/connect-claude.ps1`](../remote-setup/connect-claude.ps1) automates the whole client side: it health-checks the bridge, sets `ANTHROPIC_BASE_URL` + auth for the shell, works around Claude Code's startup call to `api.anthropic.com` (it marks `hasCompletedOnboarding=true` in `~/.claude.json`, keeping a `.bak` — see claude-code #26935 / #36998), then launches `claude` in the current directory.

**Setup (host admin, once)** — edit the three defaults at the top of the script, then distribute it:

| Param | Set it to |
|-------|-----------|
| `$BridgeHost` | the bridge host's LAN IPv4 |
| `$Port` | its `BRIDGE_PORT` |
| `$ApiKey` | its `BRIDGE_API_KEY` (leave `""` if auth is off) |

**Use (on the client)** — copy the file into the project you want to work on, then from PowerShell **in that folder**:

```powershell
.\connect-claude.ps1               # connect + launch claude in this folder
.\connect-claude.ps1 -NoLaunch     # only set the redirect in this shell (don't launch claude)
.\connect-claude.ps1 -Persist      # also save the redirect to the User environment (future shells)
.\connect-claude.ps1 -p "hello"    # forward extra args straight to claude
```

The client only needs the **Claude Code CLI installed** — no `claude` login, because the claude.ai subscription / auth lives on the **bridge host**. The script sends the bridge key as both `Authorization: Bearer` and `x-api-key` (the bridge accepts either) and disables Claude Code's non-essential traffic to anthropic.com. If the health check fails it prints the exact things to check (host running, firewall open for the port, host bound to `0.0.0.0`).

## OpenAI SDK / plain curl

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:18793/v1", api_key="sk-anything")
client.chat.completions.create(model="sonnet", messages=[{"role": "user", "content": "hi"}])
```
