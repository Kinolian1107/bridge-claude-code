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
| `BRIDGE_TOOL_MODE` | `agent` | **v1.4** — `agent`（所有內建工具，`--dangerously-skip-permissions`）/ `llm`（停用所有內建工具——純 LLM 行為；見 [LLM 模式](#llm-模式--遠端呼叫)）。沒設 env 時的執行期預設是 `agent`;`install.ps1` / `install.sh`（v1.4.1）會把 `llm` 寫進新的 `.env`。 |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | `bypassPermissions` / `plan` / `default`——僅在 `agent` 模式下生效 |
| `CLAUDE_WORKING_DIR` | `$HOME` | `claude` subprocess 的工作目錄。**v1.4.1:** 在 `llm` 模式下（未設定時）預設為一個隔離的空暫存目錄,而非 `$HOME`,讓 host 的 `CLAUDE.md` 不會滲入。 |
| `BRIDGE_TIMEOUT_MS` | `300000` | request timeout（5 分鐘） |
| `BRIDGE_MAX_ARG_LEN` | `32768` | 超過此長度的 prompt 改走 stdin（避免 `E2BIG`） |
| `BRIDGE_VERBOSE` | `true` | log 完整 request/response body 與 claude-cli I/O；設 `false` 關閉 |
| `ANTHROPIC_API_KEY` | *(空)* | 若設定，`GET /v1/models` 會回傳 Anthropic API 的即時清單 |

> Windows 上 `install.ps1` 會自動偵測真正的 `claude.exe`（npm / 原生 / winget）並寫進 `CLAUDE_BIN`。若要手動設定，請指向 **`.exe`**——例如 `C:\Users\you\.local\bin\claude.exe`,或 npm 安裝的 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`——而非 `claude.cmd`/`.ps1` shim,新版 Node 無法直接 spawn 它們。

## Claude Code 認證

claude-code-bridge 自己不處理 auth——spawn 出來的 `claude` process 用 Claude Code 自己的憑證。設定一次即可：

```bash
claude auth login        # 互動式（claude.ai 訂閱或 API key）
claude auth status       # 確認
```

bridge 會把整個 environment 傳給 subprocess，所以 `.env`/shell 裡的 `ANTHROPIC_API_KEY` 也會被 Claude Code 採用。只要透過 `claude auth login` 登入，就不需要 Anthropic API key。

## 在 LAN 上曝露 bridge

預設 bridge 綁定 `127.0.0.1`——只有本機能連。要讓同網段其他電腦把它當 endpoint 用，在跑 bridge 的這台機器做三件事：

> **Windows 上 `start.ps1` 會自動幫你做掉大部分(v1.3.2)。** 只要設好 `BRIDGE_HOST=0.0.0.0`(步驟 1)再跑 `.\start.ps1 daemon`,它就會:沒設 key 時自動產生 `BRIDGE_API_KEY` 寫進 `.env`(步驟 2)、產生會自動提權的 `firewall-rule-add-port-<port>.ps1` / `firewall-rule-delete-port-<port>.ps1` 輔助腳本給步驟 3(跑 *add* 那個 —— 它會透過 UAC 以管理員重啟並在結束前暫停讓你看結果)、把主機 LAN IPv4 以 `Remote:` endpoint 顯示,並印出可複製的 `curl` 測試(PowerShell + cmd.exe 兩種寫法)且自動帶上 bearer 標頭。

### 1. 綁定到所有介面

```bash
# .env
BRIDGE_HOST=0.0.0.0
```

`0.0.0.0` 會監聽每個網路介面，LAN clients 才連得進來。改完重啟（`./stop.sh && ./start.sh daemon`）。Windows 上 `start.ps1 daemon` 會在摘要框確認 wildcard 綁定（`Listening: 0.0.0.0:<port>`）。

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

## LLM 模式 — 遠端呼叫

> **TL;DR：** 要跨主機分享 bridge？在 server 端設定 `BRIDGE_TOOL_MODE=llm`。呼叫端自己把需要的檔案內容包進 prompt，和使用一般雲端 LLM 完全一樣。

### 為什麼這很重要

claude-code-bridge 包裝的是 `claude -p`，它是一個完整的 AI **agent**，內建讀寫檔案、執行 shell 指令、搜尋網頁等工具。這些工具永遠在**跑 bridge 的那台機器（server）**上執行。當 B 電腦的使用者叫 Claude「讀 `main.py`」，Claude 會去找 A 電腦（bridge host）上的 `main.py`，而不是 B 電腦上的。

單機使用時這是正確行為。但當 bridge 跨網路分享時，你通常希望 Claude 像一般雲端 LLM 一樣——只看到 prompt 裡的內容，需要檔案時請呼叫端自己貼過來。

### 啟用 LLM 模式

```bash
# .env（bridge server，也就是 A 電腦上）
BRIDGE_TOOL_MODE=llm
```

> 新安裝預設就是這個:`install.ps1` / `install.sh`（v1.4.1）會把 `BRIDGE_TOOL_MODE=llm` 寫進產生的 `.env`。若要單機、完整工具集的設定,安裝前先設 `BRIDGE_TOOL_MODE=agent`。

bridge 就會帶 `--tools "" --strict-mcp-config --disallowedTools LSP` 呼叫 `claude`。Claude 變成純語言模型：

- 無法存取 bridge host 上的任何檔案。`--tools ""` 停用內建工具集（Read、Write、Edit、Bash、WebSearch……）;`--strict-mcp-config` 與 `--disallowedTools LSP`(v1.4.1)再把 MCP connector 與 LSP plugin 工具一併移除——這兩者單靠 `--tools ""` 會殘留、且會在 host 上執行。已驗證:session 啟動時工具清單為空。
- 若呼叫端叫它「讀 `config.json`」但沒附上內容，Claude 會回覆要求對方把檔案直接貼過來。
- `CLAUDE_PERMISSION_MODE` / `--dangerously-skip-permissions` 不再適用（沒有工具就沒有需要審核的動作）。
- **v1.4.1:** bridge 還會把 `claude` 啟動在一個隔離的空工作目錄（OS 暫存目錄底下),而非 `$HOME`,讓 host 上 *project 層級* 的 `CLAUDE.md` 不會滲進回應。明確設定 `CLAUDE_WORKING_DIR` 仍會優先。

### 呼叫端如何傳遞檔案內容

B 電腦的使用者在自己的機器上讀檔，再把內容放進 prompt——這和所有雲端 LLM IDE 插件的做法完全一樣：

```bash
# B 電腦——本地讀檔，注入 request
FILE_CONTENT=$(cat main.py)

curl http://192.168.1.50:18793/v1/chat/completions \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"sonnet\",
    \"messages\": [{
      \"role\": \"user\",
      \"content\": \"Review this file:\n\n\`\`\`python\n${FILE_CONTENT}\n\`\`\`\"
    }]
  }"
```

Continue.dev、Cursor 等 AI 程式設計用戶端會自動做這件事——它們讀取編輯器裡開著的檔案，在送出 request 前把內容注入進去。

### 模式比較

| | `agent`（預設） | `llm` |
|---|---|---|
| 內建工具 | ✅ 全部啟用 | ❌ 停用（`--tools ""`） |
| 檔案存取 | Bridge host 的檔案系統 | 無——由呼叫端提供內容 |
| `--dangerously-skip-permissions` | 是 | 否 |
| 適合場景 | 單機使用 | 跨主機/多人共用 |

### 兩套各自獨立的「tool」機制

`BRIDGE_TOOL_MODE` 和 request 裡的 OpenAI `tools[]` 欄位**不是同一件事**。兩者正交,而理解它們的差異,正是把 bridge 當成乾淨「模型供應商」的關鍵:

| | `BRIDGE_TOOL_MODE`(server env) | Tool Bridge Mode(逐 request) |
|---|---|---|
| 觸發來源 | server 上的 `.env` | request body 帶了 `tools[]` |
| 控制什麼 | Claude 的**內建**工具(`--tools ""`) | **呼叫端的** function 定義 |
| 工具在哪執行 | bridge host(`agent`)/ 不執行(`llm`) | **回傳給呼叫端執行**(`finish_reason: "tool_calls"`) |

Tool Bridge Mode 會把呼叫端的工具 schema 注入 prompt、要求 Claude 輸出 `<tool_call>` 區塊、解析出來,再回傳標準的 OpenAI `tool_calls`。呼叫端**在自己機器上**執行,再把結果送回來——這正是 Continue.dev / Cursor / agent IDE 驅動模型的方式。

正因兩者獨立,`BRIDGE_TOOL_MODE=llm` 同時支援兩種呼叫風格:

| Request | 在 `llm` 下的結果 |
|---|---|
| 無 `tools[]` | 純文字 completion——呼叫端自己把檔案內容貼進 prompt |
| 有 `tools[]` | Claude 回傳 `tool_calls`,由**呼叫端**在本地執行。host 端不執行任何工具,也沒有內建工具來搶 |

> 要避免的組合是 `agent` **加上**呼叫端的 `tools[]`:Claude 被要求為呼叫端輸出 `<tool_call>` 區塊,但它自己的內建工具仍然活著,可能改在 host 上觸發。要做 client-side function calling,一律用 `llm`。

### 同時跑兩種模式

`BRIDGE_TOOL_MODE` 是整個 process 層級的設定。若你想**自己保有完整 agent 能力**、同時**對 LAN 提供安全的 LLM 端點**,與其加 per-request 覆寫,不如跑兩個實例——安全邊界更乾淨,因為能碰到 host 檔案系統的那個實例永遠不離開 loopback:

```bash
# Agent 實例——僅限本機、完整工具、永不對外
BRIDGE_HOST=127.0.0.1 BRIDGE_PORT=18793 BRIDGE_TOOL_MODE=agent  node claude-code-bridge.mjs

# LLM 實例——對 LAN、無 host 檔案系統存取
BRIDGE_HOST=0.0.0.0   BRIDGE_PORT=18794 BRIDGE_TOOL_MODE=llm \
  BRIDGE_API_KEY=<key> node claude-code-bridge.mjs
```

### Agent IDE 的建議

要把 Claude Code、OpenCode、RooCode、Continue.dev 等指向 bridge?那些 client **本身就是 agent**——工具和 workspace 都在**它們自己**的機器上。設 `BRIDGE_TOOL_MODE=llm`,讓 bridge 只當模型;所有工具執行就會留在 client 端,也就是它該待的地方。

### LLM 模式「不會」隔離的東西

`--tools ""` 移除的是內建工具,但 `claude -p` 仍然是一個帶設定的 Claude Code process。LLM 模式**不會**中和掉:

- **User 層級的 Claude Code 設定** — v1.4.1 已隔離工作目錄,所以 *project 層級* 的 `CLAUDE.md` 不再滲入。但 *user 層級* 的 `~/.claude/CLAUDE.md` 與 `~/.claude/settings.json`(自訂 system prompt、output style)不論 cwd 都會載入,仍會影響回應。要完全可重現的模型端點,用一份乾淨的 `HOME` / Claude Code 設定來跑 LLM 實例。
- **Agent 人格 / 幻想出來的工具** — 回應仍出自 Claude Code 的 coding-agent system prompt,所以可能偏簡短、偏寫程式口吻。又因為上面那條 user 層級設定,Claude 甚至可能*聲稱*自己有工具(例如「我可以用 Read/Bash」)——但真正的工具註冊表是空的(已驗證 `tools:[]`),所以那種呼叫根本不存在。這只是表面上的混淆,不是 host 存取。
- **`tools[]` 呼叫的串流** — 當 request 帶 `tools[]` 時,回應會被緩衝,`tool_calls` 在最後一次送出(不是逐 token),多個平行呼叫擠在同一個 delta、且沒有逐筆的 `index`。純文字(無 `tools[]`)的 request 則正常串流。

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
- **Windows：** `irm https://claude.ai/install.ps1 | iex`、`winget install Anthropic.ClaudeCode`,或 `npm install -g @anthropic-ai/claude-code`——三種 `install.ps1` 都能偵測
- **Linux / macOS：** `npm install -g @anthropic-ai/claude-code`
- **Claude Desktop** 是 GUI,不是無頭 CLI——它的 `WindowsApps\Claude.exe` alias 會啟動應用程式而非執行 `claude -p`,所以即使裝了 Claude Desktop,仍需另裝上述其中一種
- 需要時在 `.env` 把 `CLAUDE_BIN` 設成 `claude.exe` 的完整路徑

### 第一次回應很慢
- 第一個 request 較慢（Claude Code 啟動），後續會快。

## 移除

```bash
./uninstall.sh                 # Linux / macOS / WSL
.\uninstall.ps1                # Windows（PowerShell）
.\uninstall.ps1 -DeleteLogs    # Windows，並一併移除 request 資料 + logs/（不詢問）
```

兩者都會停掉 bridge、清理產生的檔案（`.env`、`*.pid`）。Windows 上 `uninstall.ps1`
接著會在刪除殘留的 request 資料（`%TEMP%\claude-code-bridge-*` prompt 資料夾）與
`logs/` 前,先列出實際路徑再詢問；`-DeleteLogs` 兩者皆自動確認。
Linux/macOS 版還會移除 `~/.bashrc` 的 auto-start；OpenClaw / Hermes 整合用
`./clearset-openclaw.sh` / `./clearset-hermesagent.sh` 還原。Windows 安裝程式不會
加入任何 shell auto-start，整合腳本也僅限 Linux/macOS，因此 `uninstall.ps1` 沒有對應
需要還原的項目。

Windows：跑 `.\stop.ps1` 後刪掉專案資料夾即可——`install.ps1` 只建立本地 `.env`（不寫 registry 或開機項目）。
