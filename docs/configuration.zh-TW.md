**[English](configuration.md)** | **[繁體中文](configuration.zh-TW.md)** · [← README](../README.zh-TW.md)

# 設定

所有設定都透過環境變數（或 `.env` 檔——bridge 會自己載入，所以單獨 `node claude-code-bridge.mjs` 也會吃到你的設定，任何平台都一樣）。

| 變數 | 預設 | 說明 |
|------|------|------|
| `BRIDGE_PORT` | `18793` | proxy server 的 port |
| `BRIDGE_HOST` | `127.0.0.1` | 綁定位址 |
| `BRIDGE_API_KEY` | *(空)* | **v1.3** — 可選的 bearer auth；設定後除 `/health` 外每個 endpoint 都需要 key（見 [api.zh-TW.md](api.zh-TW.md#bearer-auth--metricsv13)） |
| `CLAUDE_MODEL` | `sonnet` | 預設 model（alias 或完整 ID） |
| `CLAUDE_BIN` | `claude` | `claude` binary 路徑 |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | `bypassPermissions` / `plan` / `default` |
| `CLAUDE_WORKING_DIR` | `$HOME` | `claude` subprocess 的工作目錄 |
| `BRIDGE_TIMEOUT_MS` | `300000` | request timeout（5 分鐘） |
| `BRIDGE_MAX_ARG_LEN` | `32768` | 超過此長度的 prompt 改走 stdin（避免 `E2BIG`） |
| `BRIDGE_VERBOSE` | `true` | log 完整 request/response body 與 claude-cli I/O；設 `false` 關閉 |
| `ANTHROPIC_API_KEY` | *(空)* | 若設定，`GET /v1/models` 會回傳 Anthropic API 的即時清單 |

> Windows 上請在 `.env` 設定 `CLAUDE_BIN` 指向你的 Claude Code binary（例如 `C:\Users\you\.local\bin\claude.cmd`）。

## Claude Code 認證

claude-code-bridge 自己不處理 auth——spawn 出來的 `claude` process 用 Claude Code 自己的憑證。設定一次即可：

```bash
claude auth login        # 互動式（claude.ai 訂閱或 API key）
claude auth status       # 確認
```

bridge 會把整個 environment 傳給 subprocess，所以 `.env`/shell 裡的 `ANTHROPIC_API_KEY` 也會被 Claude Code 採用。只要透過 `claude auth login` 登入，就不需要 Anthropic API key。

## 在 LAN 上曝露 bridge

預設 bridge 綁定 `127.0.0.1`——只有本機能連。要讓同網段其他電腦把它當 endpoint 用，在跑 bridge 的這台機器做三件事：

### 1. 綁定到所有介面

```bash
# .env
BRIDGE_HOST=0.0.0.0
```

`0.0.0.0` 會監聽每個網路介面，LAN clients 才連得進來。改完重啟（`./stop.sh && ./start.sh daemon`）。

### 2. 一定要設 `BRIDGE_API_KEY`

一旦綁到 `0.0.0.0`，**任何連得到這台機器的人都能驅動一個跑在 `bypassPermissions` 模式的 `claude` process**——等於能用你的身分執行工具、改檔案。設一個 bearer key：

```bash
# .env
BRIDGE_API_KEY=$(openssl rand -hex 32)   # 或任何夠長的隨機字串
```

之後除 `/health` 外每個 endpoint 都需要其中一種 header：

```bash
-H "Authorization: Bearer <key>"
# 或
-H "x-api-key: <key>"
```

> ⚠️ 只有在完全信任的家用網段才可省略 key。LAN / Tailscale 上務必設定——預設 permission mode 是 `bypassPermissions`。

### 3. 找出 LAN IP 並開防火牆

```bash
# 找 IP（看 192.168.x.x / 10.x.x.x）
ip addr | grep "inet "          # Linux
ipconfig                         # Windows (PowerShell)

# 開 port 18793
sudo ufw allow 18793/tcp                              # Linux (ufw)
```

```powershell
# Windows（系統管理員 PowerShell）
New-NetFirewallRule -DisplayName "claude-code-bridge" -Direction Inbound -LocalPort 18793 -Protocol TCP -Action Allow
```

### 從其他電腦連線

把 `127.0.0.1` 換成 host 的 LAN IP，並帶上 key：

```bash
curl http://192.168.1.50:18793/v1/chat/completions \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello!"}]}'
```

OpenClaw / Hermes / SDK clients：把 `base_url` 設成 `http://192.168.1.50:18793/v1`，用同一把 key。

### ⚠️ 在 WSL2 裡跑

WSL2 在 NAT 後面，所以即使設了 `BRIDGE_HOST=0.0.0.0`，其他 LAN 電腦**也連不到** WSL 的 IP——它們只看得到 Windows host。要在 **Windows host** 上加 port forward（系統管理員 PowerShell）：

```powershell
# 取得 WSL IP
wsl hostname -I

# 把 Windows host 的 18793 轉進 WSL（<WSL_IP> 換成上面的值）
netsh interface portproxy add v4tov4 `
  listenaddress=0.0.0.0 listenport=18793 `
  connectaddress=<WSL_IP> connectport=18793

# 開 Windows 防火牆
New-NetFirewallRule -DisplayName "claude-code-bridge" -Direction Inbound -LocalPort 18793 -Protocol TCP -Action Allow
```

其他電腦改連 **Windows host 的** LAN IP（從 `ipconfig` 看），不是 WSL IP。WSL IP 重開機會變，重啟後要重跑 forward（`netsh interface portproxy reset` 清掉舊規則）。原生 Linux/macOS host 不需要這段——步驟 1–3 就夠了。

## Logs

Log 寫在 `logs/` 目錄，每日輪替：

```
logs/
└── claude-code-bridge.20260616.log   ← 一天一份
```

```bash
# 追今天的 log
tail -f logs/claude-code-bridge.$(date +%Y%m%d).log
```

Log stream 會在午夜自動輪替，不需重啟。設 `BRIDGE_VERBOSE=false` 只記摘要（不含完整 body）。

## 疑難排解

### bridge 起不來
- 確認 port 是否被佔用：`ss -tlnp | grep 18793`
- 看 log：`tail -f logs/claude-code-bridge.$(date +%Y%m%d).log`

### 認證錯誤
- 跑 `claude auth login` 登入
- 確認狀態：`claude auth status`

### 找不到 Claude Code CLI
- **Windows：** `irm https://claude.ai/install.ps1 | iex` 或 `winget install Anthropic.ClaudeCode`
- **Linux / macOS：** `npm install -g @anthropic-ai/claude-code`
- 需要時在 `.env` 把 `CLAUDE_BIN` 設成完整路徑

### 第一次回應很慢
- 第一個 request 較慢（Claude Code 啟動），後續會快。

## 移除

```bash
./uninstall.sh                 # Linux / macOS / WSL
.\uninstall.ps1                # Windows（PowerShell）
.\uninstall.ps1 -DeleteLogs    # Windows，並一併移除 logs/（不詢問）
```

兩者都會停掉 bridge、清理產生的檔案（`.env`、`*.pid`），並在刪除 `logs/` 前詢問。
Linux/macOS 版還會移除 `~/.bashrc` 的 auto-start；OpenClaw / Hermes 整合用
`./clearset-openclaw.sh` / `./clearset-hermesagent.sh` 還原。Windows 安裝程式不會
加入任何 shell auto-start，整合腳本也僅限 Linux/macOS，因此 `uninstall.ps1` 沒有對應
需要還原的項目。

Windows：跑 `.\stop.ps1` 後刪掉專案資料夾即可——`install.ps1` 只建立本地 `.env`（不寫 registry 或開機項目）。
