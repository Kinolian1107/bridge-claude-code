**[English](README.md)** | **[繁體中文](README.zh-TW.md)**

# bridge-claude-code

把你的 **Claude Code** 登入變成本機 AI API server。bridge-claude-code 把 [Claude Code CLI](https://github.com/anthropics/claude-code)（`claude -p`）包成一個同時講 **OpenAI** 與 **Anthropic** wire format 的 HTTP proxy——讓任何 AI client 都能驅動 Claude（Fable 5、Opus 4.8、Sonnet 4.6、Haiku 4.5），**不需要 Anthropic API key**。支援 **Linux、macOS、Windows**。

## 能做什麼

- **OpenAI 相容 API** — `POST /v1/chat/completions`（streaming 與 non-streaming），可搭配 OpenClaw、Hermes Agent、Continue.dev、OpenAI SDK 或純 `curl`
- **Anthropic 相容 API**（v1.3）— `POST /v1/messages` 讓 Anthropic SDK 甚至 **Claude Code** 本身（`ANTHROPIC_BASE_URL`）都能走 bridge
- **Tool calling** — 完整多輪 `tools` 迴圈；不需要切換 model（Claude 原生就遵守 tool protocol）
- **Ops-ready**（v1.3）— 可選的 bearer auth（`BRIDGE_API_KEY`）供 LAN/Tailscale 使用、Prometheus `/metrics`、每日輪替的 log
- **跨平台** — `install.sh`/`start.sh`/`stop.sh` 都有原生 PowerShell 雙生版（`install.ps1`/`start.ps1`/`stop.ps1`）；長 prompt 走 stdin 避開 OS command-line 長度限制
- **零依賴** — 純 Node.js 內建模組；auth 完全交給 Claude Code 自己的登入處理

```
OpenAI / Anthropic clients ──► bridge-claude-code (:18793) ──► claude -p ──► 你的 Claude Code 登入
```

## 快速開始

需求：**Node.js ≥ 22** 以及已登入的 [Claude Code CLI](https://github.com/anthropics/claude-code)。

### 先安裝 Node.js（如果還沒有）

這個 bridge 是純 Node.js——沒有它什麼都跑不起來。先確認版本：

```bash
node --version   # 必須是 v22.0.0 以上
```

如果指令不存在或版本低於 22，就安裝：

```bash
# Linux / macOS / WSL — nvm（推薦，免 sudo）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# 重開終端機後：
nvm install 22

# macOS — Homebrew
brew install node@22

# Ubuntu / Debian — NodeSource apt repo
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
```

```powershell
# Windows — winget（或從 https://nodejs.org 下載 LTS 安裝檔）
winget install OpenJS.NodeJS.LTS
```

### 安裝 Claude Code CLI

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### 安裝並執行 bridge

**Linux / macOS / WSL：**

```bash
git clone https://github.com/Kinolian1107/bridge-claude-code.git
cd bridge-claude-code

./install.sh        # 檢查 Node + claude，建立 .env
./start.sh daemon   # 背景啟動（停止：./stop.sh）
```

**Windows（PowerShell）：**

```powershell
git clone https://github.com/Kinolian1107/bridge-claude-code.git
cd bridge-claude-code

.\install.ps1        # 偵測 claude，建立 .env
.\start.ps1 daemon   # 背景啟動（停止：.\stop.ps1）
```

或任何平台手動：`cp .env.example .env` 後 `node claude-code-bridge.mjs`——bridge 會自己載入 `.env`。

## 試打看看

```bash
# Health check + model list
curl http://127.0.0.1:18793/health
curl http://127.0.0.1:18793/v1/models

# OpenAI 格式
curl http://127.0.0.1:18793/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello!"}]}'

# Anthropic 格式——或把 ANTHROPIC_BASE_URL 指到這裡，用 SDK / Claude Code
curl http://127.0.0.1:18793/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'
```

## 文件

| 主題 | 連結 |
|------|------|
| **API reference** — endpoints、Anthropic Messages API、bearer auth 與 Prometheus metrics | [docs/api.zh-TW.md](docs/api.zh-TW.md) |
| **設定** — 所有 env vars、Claude Code 認證、logs、疑難排解、移除 | [docs/configuration.zh-TW.md](docs/configuration.zh-TW.md) |
| └ LAN / 對外曝露 — 分享給其他電腦使用（含 WSL2 port forwarding） | [docs/configuration.zh-TW.md](docs/configuration.zh-TW.md#在-lan-上曝露-bridge) |
| **模型** — aliases、推薦模型、即時 model list、Tool Bridge Mode | [docs/models.zh-TW.md](docs/models.zh-TW.md) |
| **整合** — Hermes Agent、OpenClaw、Anthropic SDK / Claude Code、OpenAI SDK | [docs/integrations.zh-TW.md](docs/integrations.zh-TW.md) |
| **運作原理** — request flow、CLI flags、auth model | [docs/how-it-works.zh-TW.md](docs/how-it-works.zh-TW.md) |
| **Changelog** — 完整版本歷史 | [docs/CHANGELOG.zh-TW.md](docs/CHANGELOG.zh-TW.md) |

每份文件都有繁體中文鏡像（`*.zh-TW.md`）。

## 測試

```bash
npm test
```

## 移除

```bash
./uninstall.sh
```

## License

MIT — 見 [LICENSE](LICENSE)。
