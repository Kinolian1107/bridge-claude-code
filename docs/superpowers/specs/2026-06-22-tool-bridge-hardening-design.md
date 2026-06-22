# Tool Bridge Mode 硬化設計

- 日期:2026-06-22
- 狀態:設計待驗證(尚未實作;通過驗證才 push,效果不佳則整包 rollback 回 v1.4.1)
- 基準:v1.4.1（master `fd2d524`）
- 語言:本 spec 為內部工作文件,以繁體中文撰寫;技術識別字維持原文。非 `docs/` 對外 topic 文件,故不做雙語鏡像。

---

## 1. 背景與目標

### 真實目的
讓 host 上的 Claude **訂閱額度在閒置時有效共享**——放假或沒在用時開放給朋友,但**不交出原 Claude 帳號**。朋友用自己的 agent IDE（Claude Code / opencode / roo / cline / continue）連 bridge,工具實際**跑在朋友自己的機器**。

bridge 已在 v1.4.1 具備 llm mode（`--tools "" --strict-mcp-config --disallowedTools LSP`,無 host 工具、隔離 working dir）。本次硬化針對 **Tool Bridge Mode**(請求帶 `tools[]` 時的 prompt 模擬協定),**在 emulation 框架內最大逼近 passthrough**,並加上**解析異常的可觀測性**,以便長期迭代收斂。

### 範圍（in scope）
1. **穩健解析**:大括號平衡,修掉巢狀參數被截斷而丟 call 的 bug。
2. **Parallel tool calls**:協定允許多區塊,輸出端正確 `index`、保序。
3. **Block 級串流增量**:區塊外文字即時串流;每個 `<tool_call>` 區塊一閉合就吐一個帶 `index` 的 tool_call。
4. **解析異常 log + metrics**:純模組回傳 anomaly,server 落地(計數器永遠開、結構化 log 預設開且有界)。
5. 把上述解析/掃描邏輯抽成有測試的純模組 `lib/tool-bridge.mjs`（符合 CLAUDE.md「edge/policy 邏輯落在 `lib/` 並有測試」）。

### 非目標（out of scope）
- 真 native passthrough（需 OAuth token 重用,另案、帶 ToS 風險)。
- Token 級 partial-json 串流(已決議採 block 級)。
- thinking 模式下非串流回傳 event 陣列導致 `JSON.parse` fallback 的 bug(另案)。
- host user-level `~/.claude/CLAUDE.md` 滲漏(emulation 的固有限制,非本次處理)。

---

## 2. 現況流程（v1.4.1）與弱點

`runClaudeCode(prompt, requestModel, stream, res, tools)`,`toolBridgeMode = tools?.length > 0`。是否串流由請求 `stream` 旗標決定,與 tools/模式正交。

**串流 + 有 tools(本次主要修正對象)**:
1. `messagesToPrompt` 注入協定(`toolsToPromptSection`,寫死「Output ONE block」)。
2. SSE 開,送 role chunk。
3. stdout 文字全進 `toolBridgeBuffer`,**全程不串流**。
4. `proc.close` 才 `parseToolCalls(toolBridgeBuffer)` 一次。
5. 有 call → 一次吐整個 array（**無 `index`**)+ finish `tool_calls`;否則整段文字當 content + finish `stop`。

弱點:
- `TOOL_CALL_REGEX = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g` 非貪婪 → **巢狀物件參數在第一個 `}` 截斷** → `JSON.parse` 失敗 → **整個 call 被靜默丟棄**。
- 串流被 buffer,client 全程看不到東西。
- 協定勸退 parallel。
- 解析失敗靜默(`catch {}`),無可觀測性,無從迭代。

**非串流 + 有 tools**:同樣用 `parseToolCalls`(同截斷 bug),其餘流程正確。
**無 tools**:`stream:true` 已即時串流(`collectText`),不動。

---

## 3. 新設計

### 3.1 新模組 `lib/tool-bridge.mjs`（pure,no I/O）

#### 匯出 `buildToolProtocol(tools): string`
取代 `toolsToPromptSection`。空 tools → `""`。協定文字調整:
- 允許多區塊:「Output one `<tool_call>` block per tool. You MAY emit several blocks to call multiple tools in one turn.」
- 明確要求:「Do NOT wrap blocks in markdown code fences. Emit the raw `<tool_call>` block.」
- 保留格式範例與「JSON 必須合法且符合 schema」規則。

#### 匯出 `parseToolCalls(text): { calls, anomalies }`
整段(非串流)解析。以**字面字串**定位 `<tool_call>` / `</tool_call>`(容忍標籤內空白:`/<tool_call\s*>/i`、`/<\/tool_call\s*>/i`),逐區塊取 payload,對 payload 跑**大括號平衡 JSON 擷取**:
- 從第一個 `{` 起逐字掃描;以 `inString`(遇未跳脫 `"` 翻轉)、`escape`(前字元為 `\`)狀態避開字串內的括號;`depth` 在非字串時 `{` +1、`}` -1;`depth` 歸 0 即區塊 JSON 結尾。
- `JSON.parse` 成功且有 `name` → 產生 tool_call:`{ id: "call_<24hex>", type: "function", function: { name, arguments: JSON.stringify(parsed.arguments ?? parsed.params ?? {}) } }`。
- 保序、允許重複(移除 v1.4.1 的「exact JSON 字串去重」;單次掃描自然不會把 fenced 與 bare 重複計數)。
- best-effort:擷取前先剝除緊鄰 opener 的 code fence(```` ```xml ````/```` ```json ````/```` ``` ````),記 `fenced` anomaly。
- 額外 anomaly:遇 closer 卻無對應 opener → `orphan_close`;整段解析完 `calls.length === 0` 且全文含字面 `tool_call` → `near_miss`(模型疑似想呼叫卻沒產生合法區塊,迭代用最高價值訊號)。

#### 匯出 `createToolCallScanner()`
串流核心。stateful,單向消費:
```
const s = createToolCallScanner();
const { text, toolCalls, anomalies } = s.push(chunk); // 任一可為空陣列/空字串
const { text, toolCalls, anomalies } = s.flush();      // 串流結束時呼叫一次
```
- `text`:目前**區塊外**、可安全立即串流的文字。
- `toolCalls`:本次剛**閉合**的區塊解析出的 call,**附 `index`**(模組內遞增計數器,跨 push 連續)。
- `anomalies`:本次新發現的異常。

內部狀態:`pending`(待分類文字)、`inBlock`、`blockBuf`(opener 後累積)、`nextIndex`、`sawToolCallWord`。

演算法:
1. `push(chunk)`:`pending += chunk`,迴圈處理:
   - **非 inBlock**:在 `pending` 找 opener。
     - 找到 p:`p` 之前的文字(剝尾端 fence)併入待吐 `text`;進入 `inBlock`,`blockBuf` 從 opener 之後開始;continue。
     - 沒找到:吐出 `pending` 除最後 `K` 字元外的部分(`K = 16`,涵蓋 `</tool_call>` 與 fence,防 opener 跨 chunk 切斷),保留尾巴;break。
   - **inBlock**:在 `blockBuf` 找 closer。
     - 找到:opener↔closer 間 payload 跑平衡擷取 → 成功 push 一個帶 `index` 的 tool_call;失敗記 `invalid_json`/`unbalanced` anomaly。closer 之後(剝前導 fence)回到 `pending`,離開 `inBlock`;continue。
     - 沒找到:保留 `blockBuf` 繼續累積;break。
2. `flush()`:
   - 仍 `inBlock` → `unterminated` anomaly;**未閉合區塊的原始文字(含 opener)當純文字 fallback 吐出**(不丟資料)。
   - 吐出保留的尾巴 `pending`。
   - 若全程 `toolCalls` 數為 0 且 `sawToolCallWord`(曾出現字面 `tool_call`)→ `near_miss` anomaly。

#### anomaly 物件
`{ type, snippet }`,`type ∈ { "unterminated", "invalid_json", "unbalanced", "orphan_close", "fenced", "near_miss" }`。`snippet` 為違規區段原文(模組不截斷;由 server 落地時決定界限)。

### 3.2 metrics（`lib/metrics.mjs`）
`createMetrics()` 回傳物件新增:
- `recordToolParseAnomaly(type)`:內部 `Map<type, count>`。
- `recordToolCalls(n)`:成功吐出的 call 累計(供算「異常率」)。
- `render()` 增補:
  - `bridge_tool_calls_total`(counter)
  - `bridge_tool_parse_anomalies_total{type="..."}`(counter)
- 既有 metrics 不變;沿用 zero-dep 文字 exposition。

### 3.3 server 接線（`claude-code-bridge.mjs`)
- 移除 inline 的 `TOOL_CALL_REGEX`、`TOOL_CALL_FENCED_REGEX`、`toolsToPromptSection`、`parseToolCalls`,改 `import { buildToolProtocol, parseToolCalls, createToolCallScanner } from "./lib/tool-bridge.mjs";`。
- `messagesToPrompt` 改呼叫 `buildToolProtocol(tools)`(replay 多輪 assistant tool_calls 邏輯不變)。
- **串流 + toolBridgeMode**:不再 buffer。建 `const scanner = createToolCallScanner();`。stdout 文字事件 → `scanner.push(text)`:
  - 回傳 `text` 非空 → 發 content delta(沿用現有 chunk 格式)。
  - 回傳 `toolCalls` → 逐一發 `{ delta: { tool_calls: [{ ...call, index }] } }`。
  - 回傳 `anomalies` → `metrics.recordToolParseAnomaly(type)` + 結構化 log(見 §3.4)。
  - 記旗標 `emittedAnyCall`。
  - `proc.close`:`scanner.flush()` 同上落地;`emittedAnyCall ? finish_reason:"tool_calls" : "stop"`;`recordToolCalls(callCount)`;`[DONE]`。
- **串流 + 無 tools**:維持現狀(`collectText` 即時串流)。
- **非串流 + toolBridgeMode**:`const { calls, anomalies } = parseToolCalls(responseText);` anomaly 落地;`calls.length` 決定 `tool_calls` 或 `stop`。
- Anthropic `/v1/messages`:`createAnthropicStreamTranslator` 已逐筆吃 `delta.tool_calls`,改為多筆小 delta **相容,不改**。

### 3.4 異常 log 落地（server 端,I/O 邊界)
- **計數器永遠開**(metrics,隱私安全,只有 type 與次數)。
- **結構化 log 預設開、有界**:每筆 anomaly 輸出一行,含 timestamp、requestId 末 8 碼、type、**截斷至 200 字元**的 snippet。
- **環境變數 `BRIDGE_TOOL_PARSE_LOG_FULL=1`**:輸出完整未截斷 snippet,供回來深入分析(預設關,因 bridge 共享給朋友,避免把對方資料整段寫進 log)。
- 沿用既有 log 風格(`console.log`/`console.error` + `verboseLog`)。

---

## 4. 資料流（before / after,串流 + 有 tools）

```
v1.4.1:  stdout 文字 ─→ toolBridgeBuffer(全程不吐) ──close──→ parseToolCalls 一次 ─→ [tool_calls array 無 index] / [整段文字]
新設計:  stdout 文字 ─→ scanner.push ─┬→ 區塊外文字  ──即時──→ content delta
                                      ├→ 區塊閉合    ──即時──→ tool_calls delta(帶 index)
                                      └→ anomalies   ──────→ metrics + log
                         close ─→ scanner.flush ─→ 收尾文字 + 未閉合 fallback + finish_reason
```

---

## 5. 影響、相容性、風險

### 影響
- agent IDE:即時文字 + 帶 index 的 tool_calls,更貼近 native UX。
- 巢狀參數的 call 不再被丟;parallel 受支援。
- 無 tools 路徑、非串流路徑(除解析升級)、auth、health、install/start、agent mode 執行:**不受影響**。

### 相容性
- 帶 `index` 是**增加** OpenAI 規格符合度(舊的無 index array 反而較不標準)。
- 協定允許多區塊,**單區塊仍相容**。
- Anthropic translator 不需改。

### 風險與對策
- **最大新風險 = scanner 跨界/尾巴邏輯**(可能卡字、漏字、漏抓跨界標籤)→ **先以單元測試壓滿跨界 case 再接線**。
- fence 處理為 best-effort;殘留 ``` 文字 artifact 會以 `fenced` anomaly 記錄,後續迭代。
- 回退:變更集中在 1 新模組 + metrics 增補 + server 接線;rollback = revert 該 commit,維持 v1.4.1。

---

## 6. 測試計畫

### `tests/tool-bridge.test.mjs`（新)
- `buildToolProtocol`:空 tools → `""`;含工具名/參數;含「多區塊」與「不要 fence」字樣。
- `parseToolCalls`:單一;**巢狀參數(回歸 bug)**;多區塊保序;fenced;`params` 別名;壞 JSON → `invalid_json` anomaly;`near_miss`(含 `tool_call` 字樣但零 call)。
- `createToolCallScanner`:純文字穿透;單區塊單 push;**opener 跨界**;**closer 跨界**;單 push 多區塊(index 0/1);文字夾區塊;巢狀參數;未閉合 flush → fallback 文字 + `unterminated`;fenced。

### `tests/metrics.test.mjs`（增補)
- `recordToolParseAnomaly` / `recordToolCalls` 累計;`render()` 含 `bridge_tool_parse_anomalies_total{type=...}` 與 `bridge_tool_calls_total`。

### 整合
- `npm test` 全綠。
- 串流 e2e 對 running bridge smoke:含巢狀參數的工具、parallel 兩工具、純文字串流不受影響。

---

## 7. 版本與回退
- 版本:擬 **v1.5.0**(新串流行為 + 新模組 + 新 metrics)。header/health/banner/CHANGELOG 同步(中英雙語 CHANGELOG)。
- 文件:`docs/configuration*.md` 增補 `BRIDGE_TOOL_PARSE_LOG_FULL`;Tool Bridge Mode 行為說明更新(雙語)。
- 回退策略:單一 feature commit,效果不佳 `git revert` 即回 v1.4.1。**先 local commit,驗證通過才 push。**
