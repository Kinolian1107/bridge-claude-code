**[English](integrations.md)** | **[繁體中文](integrations.zh-TW.md)** · [← README](../README.zh-TW.md)

# 整合

任何 OpenAI 或 Anthropic 相容 client 都能用。把它的 base URL 指到 bridge（`http://127.0.0.1:18793/v1`）；若有設 `BRIDGE_API_KEY`，把它當 API key 帶上。

## OpenClaw

### 自動

```bash
./set-openclaw.sh        # patch openclaw.json + 同步 model list
./clearset-openclaw.sh   # 從備份還原
```

`set-openclaw.sh` 會：
1. 偵測執行中的 bridge 並探測 `/v1/models` 取得即時 model list
2. 備份 `~/.openclaw/openclaw.json` 到 `openclaw.json.bak.pre-claude-bridge`
3. 注入 `claude-cli` provider 並設為預設 model
4. 可選擇重啟 OpenClaw gateway

### 手動

```
baseUrl:  http://127.0.0.1:18793/v1
apiKey:   claude-code-bridge-local   （或你的 BRIDGE_API_KEY）
api:      openai-completions
```

## Hermes Agent

### 自動

```bash
./set-hermesagent.sh        # 設定 provider + 同步 models
./clearset-hermesagent.sh   # 從備份還原
```

`set-hermesagent.sh` 會：
1. 偵測 `hermes` binary 並確認 bridge 在跑
2. 備份 `~/.hermes/config.yaml` 到 `config.yaml.bak.pre-claude-bridge`
3. 設定 `model.provider = custom`，帶上 bridge base URL 與預設 model
4. 把 `/v1/models` 的所有即時 model 同步進 `custom_providers`
5. 可選擇重啟 Hermes gateway

## Anthropic SDK / Claude Code

因為 bridge 有開 `/v1/messages`，任何 Anthropic client 都能指過來：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18793
export ANTHROPIC_API_KEY=<你的 BRIDGE_API_KEY；若 auth 關閉則任意值>
```

Anthropic Python/TypeScript SDK 與 Claude Code 本身就會走 bridge——適合本機 auto-approve 工作流。

## OpenAI SDK / 純 curl

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:18793/v1", api_key="sk-anything")
client.chat.completions.create(model="sonnet", messages=[{"role": "user", "content": "hi"}])
```
