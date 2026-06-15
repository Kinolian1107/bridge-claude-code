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

## OpenAI SDK / plain curl

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:18793/v1", api_key="sk-anything")
client.chat.completions.create(model="sonnet", messages=[{"role": "user", "content": "hi"}])
```
