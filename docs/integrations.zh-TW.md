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

### Windows 一鍵啟動器（`connect-claude.ps1`）

給 Windows client 用的 [`remote-setup/connect-claude.ps1`](../remote-setup/connect-claude.ps1) 把 client 端整套自動化:它會先對 bridge 做 health check、為當前 shell 設好 `ANTHROPIC_BASE_URL` + 認證、繞過 Claude Code 啟動時對 `api.anthropic.com` 的呼叫(在 `~/.claude.json` 標記 `hasCompletedOnboarding=true`,並保留 `.bak`——見 claude-code #26935 / #36998),然後在當前目錄啟動 `claude`。

**設定(host 管理者,一次)** — 編輯腳本最上面三個預設值,再發給大家:

| 參數 | 設成 |
|------|------|
| `$BridgeHost` | bridge host 的區網 IPv4 |
| `$Port` | 它的 `BRIDGE_PORT` |
| `$ApiKey` | 它的 `BRIDGE_API_KEY`(沒開 auth 就留 `""`) |

**使用(在 client)** — 把檔案複製到你要工作的專案目錄,然後在那個目錄的 PowerShell 裡:

```powershell
.\connect-claude.ps1               # 連線並在此目錄啟動 claude
.\connect-claude.ps1 -NoLaunch     # 只在這個 shell 設好導向(不啟動 claude)
.\connect-claude.ps1 -Persist      # 另外把導向存進 User 環境變數(之後新開的 shell 也生效)
.\connect-claude.ps1 -p "hello"    # 把額外參數直接轉給 claude
```

client 只需要**裝好 Claude Code CLI**——不用 `claude` 登入,因為 claude.ai 訂閱 / 認證都在 **bridge host** 上。腳本會把 bridge key 同時用 `Authorization: Bearer` 與 `x-api-key` 送出(bridge 兩種都吃),並關閉 Claude Code 對 anthropic.com 的非必要流量。若 health check 失敗,它會印出要檢查的項目(host 有沒有跑、防火牆有沒有開該 port、host 有沒有綁 `0.0.0.0`)。

## OpenAI SDK / 純 curl

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:18793/v1", api_key="sk-anything")
client.chat.completions.create(model="sonnet", messages=[{"role": "user", "content": "hi"}])
```
