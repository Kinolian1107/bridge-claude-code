# Tool Bridge Mode 硬化設計

- 日期:2026-06-22
- 狀態:設計待驗證(尚未實作;通過驗證才 push,效果不佳則整包 rollback 回 v1.4.1)
- 基準:v1.4.1（master `fd2d524`）
- 修訂:2026-06-22 r2 — 經對 host 上真實 `claude -p` 跑診斷後,修正對 Claude Code 回應流程的理解,新增兩個既有 bug 修正進範圍,並定案「不加 `--include-partial-messages`」。
- 修訂:2026-06-22 r3(Senior Review)— 用 tool-calling 協定 prompt 實跑 `claude -p`(並行 + 巢狀參數,串流/非串流各一)驗證解析邏輯。更正「assistant 事件可能多個」;新增「協定 STOP 規則 + scanner 抑制 call 後文字」以消除幻覺式結果敘述(R2)。大括號平衡、cli-output、usage、thinking guard 皆獲實測佐證。
- 修訂:2026-06-22 r4 — 用 **harness 忠實複製端點 prompt**(messagesToPrompt + 新協定)實跑 `claude -p`:**STOP 規則證實消除追加敘述**(scanner 抑制降為保險)。新增 **Host 用量日誌(token-usage.csv)**:result 事件實測帶 `total_cost_usd`/`usage.*`,逐筆 append 記錄。
- 語言:內部工作文件,繁體中文;技術識別字維持原文。非 `docs/` 對外 topic 文件,不做雙語鏡像。

---

## 1. 背景與目標

### 真實目的
讓 host 上的 Claude **訂閱額度在閒置時有效共享**——放假/沒在用時開放給朋友,但**不交出原 Claude 帳號**。朋友用自己的 agent IDE（Claude Code / opencode / roo / cline / continue）連 bridge,工具實際**跑在朋友自己的機器**。**延遲不是考量點**;重點是功能正確、解析穩定、可長期迭代逼近 passthrough。

bridge 已在 v1.4.1 具備 llm mode（`--tools "" --strict-mcp-config --disallowedTools LSP`,無 host 工具、隔離 working dir）。本次硬化針對 **Tool Bridge Mode**(請求帶 `tools[]` 時的 prompt 模擬協定)。

### 範圍（in scope）
1. **穩健解析**:大括號平衡,修掉巢狀參數被截斷而丟 call 的 bug。
2. **Parallel tool calls + 區塊後停止**:協定允許多區塊(輸出端正確 `index`、保序),並要求**區塊後停止**;scanner 在已吐 call 後**抑制後續文字**,消除幻覺式結果敘述(實測 R2)。
3. **異常可觀測性**:純模組回傳 anomaly,server 落地(metrics 永遠開、結構化 log 預設開且有界)。
4. **🔴 非串流陣列解析修正**(既有 bug,預設觸發):`--output-format json` 回傳的是**事件陣列**,現行 `JSON.parse(stdout.slice(indexOf("{")))` 解析失敗 → 把整包原始 JSON 當 content 吐回。改為解析陣列、取 `result` 事件。
5. **usage 欄位修正**:讀 `…usage.input_tokens/output_tokens`(現行讀錯路徑,usage 永遠是估算值)。
6. **thinking guard**:extended thinking 預設開啟;只有 `text` 型內容能餵進解析器,thinking 內容(模型推理,可能字面含 `tool_call`)必須排除。
7. 解析/掃描邏輯抽成有測試的純模組(符合 CLAUDE.md「edge/policy 邏輯落 `lib/` 並有測試」)。
8. **Host 用量日誌(`token-usage.csv`)**:每次呼叫從 result 事件擷取 tokens/cost,逐筆 append 一列(時間/來源 IP/model/tokens/cost/duration…),供 host 管理者看用量與費用;另在 `/metrics` 加聚合 token/cost 計數。

### 設計決策(經實測定案)
- **不加 `--include-partial-messages`**。實測:現參數 `stream-json --verbose` 下,文字以**單一 `assistant` 事件整段送達**(無 token 級 delta)。加上 partial-messages 才有逐 token 串流,但會引入 `stream_event` 封套解析、`thinking_delta` 過濾、與 consolidated `assistant` 事件去重等額外脆弱面。**因延遲非考量點,維持現參數**:範圍最小、風險最低。scanner 仍保留增量介面(防禦性),實務上一次 push 收完整文字。

### 非目標（out of scope）
- 真 native passthrough（需 OAuth token 重用,另案、帶 ToS 風險)。
- Token 級 partial-json 串流 / `--include-partial-messages`(見上決策)。
- host user-level `~/.claude/CLAUDE.md` 滲漏(emulation 固有限制)。

---

## 2. Claude Code 回應流程(host 實測 ground truth)

對 host 上 `claude -p` 實跑觀察(Claude Code 2.1.x、sonnet):

| 參數 | 事件序列 | 文字到達 |
|---|---|---|
| `stream-json --verbose`(**= 目前 bridge**) | `system… → assistant ×(1+) → rate_limit_event → result` | **文字在 `assistant` 事件**(可能 1+ 個),無 `content_block_delta`(非 token 級) |
| `+ --include-partial-messages` | 多 `stream_event` 封套(`{type:"stream_event","event":{<原生 SSE 事件>}}`) | 逐 token |
| `--output-format json`(非串流) | **`[{...},{...}]` 事件陣列** | 取 `result` 事件 |

- **assistant 事件可能 1 個或多個**:thinking 與 text 可能在同一事件的 `content[]`(多 block),也可能拆成多個 `assistant` 事件(實測並行工具情境出現兩個)。text 也可能分散多 block → server 須對**每個** assistant 事件的**每個** `text` block 餵 scanner,scanner **跨 push 累積**(故跨 push 累積為實際需求,非純防禦)。
- **extended thinking 預設開**:assistant 的 `content[]` = `[{type:"thinking",...},{type:"text",...}]`。
- `result` 事件(串流與非串流皆有):`{type:"result", subtype, is_error, api_error_status, result:"<完整文字>", stop_reason, usage:{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,...}}`。
- `rate_limit_event` 會出現在串流中(目前 bridge 忽略,可記 log)。

### tool-call 實測驗證(llm 硬化 + 並行 + 巢狀參數,串流與非串流各一次)
- ✓ 模型如實輸出**未圍欄 `<tool_call>` 區塊**;新協定「MAY emit several blocks」→ **確實並行兩區塊**。
- ✓ 參數含**巢狀物件 + 陣列**(`{"when":{"date":...,"time":...},"attendees":[...]}`)→ 舊非貪婪 regex 於第一個 `}` 截斷會**丟掉該 call** → **大括號平衡為必要**(JSON 單行,但平衡法同時相容多行)。
- ✓ 非串流 `result.result` 含兩個 `<tool_call>`;`result.usage.input_tokens` 實測=2(prompt 長度估算會高估數百倍)→ cli-output + usage 修正必要。
- ✓ thinking 未出現字面 `<tool_call>`(但會敘述「即將呼叫」)→ 只餵 `text` 的 guard 必要。
- 🔴 **模型在區塊後追加幻覺式結果敘述**(「結果回來後我會整理報告」)→ 需協定加回「區塊後停止」規則 + scanner 在已吐 call 後**抑制後續區塊外文字**(見 §3.1)。**✅ r4 用忠實端點 prompt 實測:加入 STOP 規則後追加敘述消失,協定層已從源頭解決;scanner 抑制降為保險。**

### 現況弱點(對照上表)
- 串流 `parseToolCalls` 用 `/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/`(非貪婪)→ **巢狀參數在第一個 `}` 截斷** → 整個 call 被靜默丟棄。
- 串流 usage 讀 `event.input_tokens`(實為 `event.usage.input_tokens`)→ 永遠落回估算。
- **非串流讀陣列失敗 → dump 原始 JSON 當 content**(thinking 預設開,**預設觸發**,tool-bridge 非串流等於失效)。
- 協定勸退 parallel;解析失敗靜默無可觀測性。
- 串流文字在現參數下本就單事件整段到(非死碼問題,只是非即時)。bridge 內 `content_block_delta` 分支在現參數下為死碼,harmless,**本次不動**。

---

## 3. 新設計

### 3.1 新模組 `lib/tool-bridge.mjs`（pure,no I/O）

#### `buildToolProtocol(tools): string`
取代 `toolsToPromptSection`。空 tools → `""`。協定文字調整:
- 允許多區塊:「Output one `<tool_call>` block per tool. You MAY emit several blocks to call multiple tools in one turn.」
- 「Do NOT wrap blocks in markdown code fences. Emit the raw `<tool_call>` block.」
- **「After emitting your tool_call block(s), STOP. Do NOT add any text after the blocks; do NOT describe, summarise, or predict results you have not received yet.」**(實測:缺此規則,模型會在區塊後幻覺式預告結果。)
- 保留格式範例與「JSON 必須合法且符合 schema」規則。

#### `parseToolCalls(text): { calls, anomalies }`
整段解析。字面定位 `<tool_call>`/`</tool_call>`(容忍標籤內空白),逐區塊取 payload,對 payload 跑**大括號平衡 JSON 擷取**:
- 從第一個 `{` 起逐字掃描;以 `inString`(未跳脫 `"` 翻轉)、`escape`(前字元 `\`)避開字串內括號;`depth` 非字串時 `{`+1/`}`-1;歸 0 即 JSON 結尾。
- `JSON.parse` 成功且有 `name` → `{ id:"call_<24hex>", type:"function", function:{ name, arguments: JSON.stringify(parsed.arguments ?? parsed.params ?? {}) } }`。
- 保序、允許重複;單次掃描不會把 fenced 與 bare 重複計數。
- best-effort 剝除緊鄰 opener 的 code fence,記 `fenced` anomaly。
- anomaly:JSON 失敗 `invalid_json`;不平衡 `unbalanced`;closer 無對應 opener `orphan_close`;`calls.length===0` 且全文含字面 `tool_call` → `near_miss`。

#### `createToolCallScanner()`
串流增量介面(現參數下實務多為單次 push,但跨界處理保留為防禦)。
```
const s = createToolCallScanner();
const { text, toolCalls, anomalies } = s.push(chunk);
const { text, toolCalls, anomalies } = s.flush();
```
- `text`:區塊外、可立即串流的文字。
- `toolCalls`:本次剛閉合區塊的 call,**附跨 push 連續的 `index`**。
- 內部:`pending`、`inBlock`、`blockBuf`、`nextIndex`、`sawToolCallWord`。
- 非 inBlock 找 opener:找到→前段文字(剝尾 fence)入 `text`、進 block;沒找到→吐除末 `K=16` 字元外(防 opener 跨界),保留尾巴。
- inBlock 找 closer:找到→payload 平衡擷取→push 一個帶 `index` 的 call(失敗記 anomaly);沒找到→續累積。
- `flush()`:仍 inBlock→`unterminated` anomaly + **未閉合區塊原文(含 opener)當純文字 fallback**;吐保留尾巴;零 call 且 `sawToolCallWord`→`near_miss`。
- **抑制 call 後文字**(實測 R2):本 turn 一旦吐出任一 tool_call,後續「區塊外文字」**不再串流**(只續發後續 tool_call 區塊);區塊**前**的引言文字照常串流。對齊 native tool_use 語意,避免幻覺式結果敘述外洩(與協定 STOP 規則互為保險)。

#### anomaly 物件
`{ type, snippet }`,`type ∈ { unterminated, invalid_json, unbalanced, orphan_close, fenced, near_miss }`;`snippet` 為違規區段原文(模組不截斷,server 落地時決定界限)。

### 3.2 新模組 `lib/cli-output.mjs`（pure,no I/O)— 修非串流陣列 bug
`parseClaudeJsonOutput(stdout): { text, usage, isError, stopReason }`
- 容忍前綴雜訊:從第一個 `[` 或 `{` 起嘗試 `JSON.parse`。
- 陣列 → 取 `type==="result"` 事件:`text = ev.result`、`usage = ev.usage`、`isError = ev.is_error`、`stopReason = ev.stop_reason`;無 result 事件則退而取最後一個 `assistant` 事件的 text 內容。
- 單一物件(舊版相容)→ 直接取 `.result`/`.usage`。
- 解析全失敗 → `{ text: stdout.trim(), usage: null, isError: false }`(保底,不丟內容)。

### 3.3 metrics（`lib/metrics.mjs`)
`createMetrics()` 新增:
- `recordToolParseAnomaly(type)`、`recordToolCalls(n)`。
- `recordUsage({inputTokens, outputTokens, costUsd})`(聚合面,與逐筆 CSV 互補)。
- `render()` 增 `bridge_tool_calls_total`、`bridge_tool_parse_anomalies_total{type="..."}`、`bridge_tokens_total{type="input|output"}`、`bridge_cost_usd_total`(皆 counter)。
- 既有 metrics 不變。

### 3.4 server 接線（`claude-code-bridge.mjs`)
- import:`buildToolProtocol, parseToolCalls, createToolCallScanner`(tool-bridge)、`parseClaudeJsonOutput`(cli-output)。移除 inline 兩條 regex、`toolsToPromptSection`、`parseToolCalls`。
- `messagesToPrompt` 改呼叫 `buildToolProtocol(tools)`。
- **串流 + toolBridgeMode**:建 `scanner`(**整個 turn 共用一個**)。對**每個** assistant 事件、**每個 `part.type==="text"`** block(thinking guard,維持現有過濾)→ `scanner.push(text)`;`text`→content delta、`toolCalls`→逐一發 `{delta:{tool_calls:[{...,index}]}}`、`anomalies`→metrics+log。call 後文字抑制由 scanner 內部處理(R2)。`proc.close`:`scanner.flush()` 落地;`emittedAnyCall ? "tool_calls" : "stop"`;`recordToolCalls`。
- **串流 usage**:讀 `result` 事件 `event.usage?.input_tokens/output_tokens`(舊 `event.input_tokens` 留為 fallback)。
- **串流 + 無 tools**:維持現狀(`collectText` 即時送出該事件文字)。
- **非串流**:改用 `parseClaudeJsonOutput(stdout)` 取 `{text, usage, isError}`;`isError`→走錯誤回報;`toolBridgeMode`→`parseToolCalls(text)`(text 已排除 thinking),anomaly 落地;`calls.length` 決定 `tool_calls`/`stop`;usage 用解析所得。
- Anthropic `/v1/messages`:translator 已逐筆吃 `delta.tool_calls`,相容,不改。

### 3.5 異常 log 落地(server I/O 邊界)
- metrics 永遠開(僅 type+次數,隱私安全)。
- 結構化 log 預設開、有界:每筆含 timestamp、requestId 末 8 碼、type、**截斷 200 字元** snippet。
- `BRIDGE_TOOL_PARSE_LOG_FULL=1`:輸出完整 snippet(預設關,保護共享情境下朋友的資料)。
- 沿用既有 `console.*` / `verboseLog` 風格。

### 3.6 Host 用量日誌 `lib/usage-log.mjs`(pure formatting)+ server append
逐筆記錄每次 `claude -p` 呼叫的用量/費用,供 host 管理者看使用量、頻率、成本。資料來源:result 事件(r4 實測可取得 `usage.{input,output,cache_creation,cache_read}_tokens`、`total_cost_usd`、`duration_ms`、`num_turns`、`stop_reason`、`is_error`)。

- **格式 = CSV**(管理者用 Excel/Sheets;零依賴)。
- 純模組 `lib/usage-log.mjs`:`USAGE_CSV_HEADER` 常數、`formatUsageRow(record): string`(欄位順序固定;對含 `,` / `"` / 換行的欄位加雙引號並 `""` 跳脫)。**純函式 → 可測**。
- server I/O:檔案不存在/空 → 先寫 header;每筆 `appendFileSync` **整列一次寫入**(避免並發交錯);路徑由 `BRIDGE_USAGE_LOG` 決定(預設 `./logs/token-usage.csv`),設 `off` 可關。
- 欄位:`timestamp_iso, request_id, endpoint, client_ip, model, tool_mode, stream, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_cost_usd, duration_ms, num_turns, tool_calls, finish_reason, status`。
- `client_ip`:`X-Forwarded-For` 首段 → `socket.remoteAddress`。
- **隱私**:只記 metadata 與 token/cost,**絕不記 prompt/回應內容**;會記朋友來源 IP(管理者用途,需知情)。
- 聚合面同步進 `/metrics`(§3.3 `recordUsage`)。
- 註:cache_creation/cache_read 必留——r4 實測單次呼叫 input=2 但 cache_creation≈7400、cost≈$0.048,host 端 system-prompt overhead 才是成本主因,管理者需看得到。

---

## 4. 資料流(before / after)

```
串流+tools  v1.4.1: assistant 事件文字 → toolBridgeBuffer(不吐) ─close─→ parseToolCalls 一次(非貪婪,巢狀截斷) → [array 無 index]
            新設計: assistant 事件 text → scanner.push ─┬→ 區塊外文字 → content delta
                                                        ├→ 區塊閉合 → tool_calls delta(index)
                                                        └→ anomalies → metrics+log     close → flush → finish_reason
非串流+tools v1.4.1: 陣列 → JSON.parse 失敗 → dump 原始 JSON 當 content(壞)
            新設計: parseClaudeJsonOutput → result.result 文字 → parseToolCalls → tool_calls / stop;usage 正確
```

---

## 5. 影響、相容性、風險

### 影響
- agent IDE:巢狀參數 call 不再被丟;parallel 支援;tool_calls 帶 index(更合規)。
- **非串流 tool-bridge 從「壞」變「可用」**;usage 從估算變實值。
- 無 tools 路徑、auth、health、install/start、agent mode 執行:不受影響。

### 相容性
- 帶 `index`、允許多區塊 → 皆為增量相容(單區塊仍可)。
- Anthropic translator 不需改。
- `cli-output` 同時容忍陣列與舊單物件,跨 CLI 版本較穩。

### 風險與對策
- scanner 跨界邏輯:現參數下文字單事件到,跨界幾乎不發生 → **防禦性而非承重**,風險低;仍以單元測試壓滿。
- `parseClaudeJsonOutput` 依賴 `result` 事件形狀 → 多版本以「陣列/單物件/保底」三段相容。
- 回退:集中於 2 新模組 + metrics 增補 + server 接線;`git revert` 回 v1.4.1。

---

## 6. 測試計畫

### `tests/tool-bridge.test.mjs`（新）
- `buildToolProtocol`:空→`""`;含工具名/參數;含「多區塊」「不要 fence」。
- `parseToolCalls`:單一;**巢狀參數(回歸 bug)**;多區塊保序;fenced;`params` 別名;壞 JSON→`invalid_json`;`near_miss`;`orphan_close`。
- `createToolCallScanner`:純文字穿透;單區塊單 push;opener 跨界;closer 跨界;單 push 多區塊(index 0/1);文字夾區塊;巢狀參數;未閉合 flush→fallback+`unterminated`;fenced;**引言文字先串流、call 後追加文字被抑制(R2)**;**多次 push 累積(模擬多 assistant 事件,區塊不跨事件)**。

### `tests/cli-output.test.mjs`（新)
- 事件陣列取 result 文字+usage;前綴雜訊容忍;無 result 退 assistant;單物件相容;`is_error` 回報;全失敗保底。

### `tests/metrics.test.mjs`（增補)
- `recordToolParseAnomaly`/`recordToolCalls`/`recordUsage` 累計;`render()` 含新 counter(tool_calls、anomalies、tokens、cost)。

### `tests/usage-log.test.mjs`（新)
- `formatUsageRow`:欄位順序與 `USAGE_CSV_HEADER` 對齊;含 `,`/`"`/換行的欄位正確加引號跳脫;缺欄位補空字串;數值原樣輸出。

### 整合
- `npm test` 全綠。
- e2e smoke(對 running bridge):串流含巢狀參數工具、parallel 兩工具、純文字不受影響;**非串流 tool-bridge** 確認回正確 tool_calls(原本壞)。

---

## 7. 版本與回退
- 版本:擬 **v1.5.0**。header/health/banner/CHANGELOG(雙語)同步。
- 文件:`docs/configuration*.md`(雙語)增補 `BRIDGE_TOOL_PARSE_LOG_FULL`、`BRIDGE_USAGE_LOG`、Tool Bridge Mode 行為與「非串流修正/usage/用量日誌」說明。
- `.gitignore` 增 `logs/`(用量 CSV 為 runtime 資料,不入庫)。
- 回退:單一 feature commit,`git revert` 即回 v1.4.1。**先 local commit,驗證通過才 push。**
