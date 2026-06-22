# Tool Bridge Mode Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the prompt-emulation Tool Bridge Mode reliable (balanced-JSON parsing, parallel calls, STOP rule), fix two pre-existing bugs (non-stream array parse + usage path), add parse-anomaly observability and a per-call host usage CSV.

**Architecture:** Three new pure modules under `lib/` (`tool-bridge.mjs`, `cli-output.mjs`, `usage-log.mjs`) each unit-tested; `lib/metrics.mjs` gains aggregate counters; `claude-code-bridge.mjs` is rewired to use them. No new runtime dependencies (Node built-ins only). Empirically validated against real `claude -p` (spec r4).

**Tech Stack:** Node.js ≥22 ESM, `node --test`, zero deps.

**Spec:** `docs/superpowers/specs/2026-06-22-tool-bridge-hardening-design.md`

---

## Deviation note (read first)

- The spec includes `createToolCallScanner` for "block-level streaming". Ground truth (spec r4) showed `claude -p` does **not** token-stream text (one whole `assistant` text block), so the scanner provides ~no real-time benefit. This plan implements the scanner per the approved spec (Task 2). **Simpler alternative (optional):** drop Task 2 and have the streaming path buffer the turn's text and call `parseToolCalls` at close (same as non-stream), reusing one parser. If you prefer that, skip Task 2 and use `parseToolCalls(fullBuffer)` in Task 6's streaming branch. Default = follow the spec (keep scanner).
- Anomaly types implemented: `invalid_json`, `unbalanced`, `unterminated`, `near_miss`, `fenced`. `orphan_close` from the spec is dropped (YAGNI — model never emits stray closers in validation).

---

## File Structure

**Create:**
- `lib/tool-bridge.mjs` — `buildToolProtocol`, `parseToolCalls`, `createToolCallScanner` (+ internal balanced-JSON helper)
- `lib/cli-output.mjs` — `parseClaudeJsonOutput`
- `lib/usage-log.mjs` — `USAGE_CSV_HEADER`, `formatUsageRow`
- `tests/tool-bridge.test.mjs`, `tests/cli-output.test.mjs`, `tests/usage-log.test.mjs`

**Modify:**
- `lib/metrics.mjs` (+ `tests/metrics.test.mjs`) — anomaly/tool-call/usage counters
- `claude-code-bridge.mjs` — imports, `messagesToPrompt`, streaming + non-stream paths, usage extraction, anomaly logging, usage CSV, `runClaudeCode` meta param, version bump
- `.gitignore` (+ `logs/`), `.env.example` (+ two env vars)
- `docs/configuration.md` + `docs/configuration.zh-TW.md`, `docs/CHANGELOG.md` + `docs/CHANGELOG.zh-TW.md`

---

## Task 1: `lib/tool-bridge.mjs` — protocol + `parseToolCalls`

**Files:**
- Create: `lib/tool-bridge.mjs`
- Test: `tests/tool-bridge.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/tool-bridge.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildToolProtocol, parseToolCalls } from "../lib/tool-bridge.mjs";

const TOOLS = [
  { type: "function", function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } } },
];

test("buildToolProtocol: empty tools → empty string", () => {
  assert.equal(buildToolProtocol([]), "");
  assert.equal(buildToolProtocol(undefined), "");
});

test("buildToolProtocol: includes name, multi-block allowance, no-fence and STOP rules", () => {
  const p = buildToolProtocol(TOOLS);
  assert.match(p, /get_weather/);
  assert.match(p, /MAY emit several blocks/);
  assert.match(p, /Do NOT wrap blocks in markdown code fences/);
  assert.match(p, /After emitting your tool_call block\(s\), STOP/);
});

test("parseToolCalls: single call", () => {
  const { calls } = parseToolCalls('<tool_call>\n{"name":"get_weather","arguments":{"city":"Tokyo"}}\n</tool_call>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "function");
  assert.equal(calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: "Tokyo" });
  assert.match(calls[0].id, /^call_[0-9a-f]{24}$/);
});

test("parseToolCalls: nested object + array args survive (regression on truncation)", () => {
  const text = '<tool_call>{"name":"create_event","arguments":{"title":"Team Sync","when":{"date":"2026-07-01","time":"14:00"},"attendees":["a@x.com","b@x.com"]}}</tool_call>';
  const { calls } = parseToolCalls(text);
  assert.equal(calls.length, 1);
  const args = JSON.parse(calls[0].function.arguments);
  assert.equal(args.when.time, "14:00");
  assert.deepEqual(args.attendees, ["a@x.com", "b@x.com"]);
});

test("parseToolCalls: multiple parallel blocks, in order", () => {
  const text = '<tool_call>{"name":"a","arguments":{}}</tool_call>\n<tool_call>{"name":"b","arguments":{"x":1}}</tool_call>';
  const { calls } = parseToolCalls(text);
  assert.deepEqual(calls.map((c) => c.function.name), ["a", "b"]);
});

test("parseToolCalls: returns leading text before first block", () => {
  const { leadingText } = parseToolCalls('Sure, doing it.\n<tool_call>{"name":"a","arguments":{}}</tool_call>');
  assert.equal(leadingText, "Sure, doing it.\n");
});

test("parseToolCalls: 'params' alias accepted", () => {
  const { calls } = parseToolCalls('<tool_call>{"name":"a","params":{"x":1}}</tool_call>');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { x: 1 });
});

test("parseToolCalls: malformed JSON → invalid_json anomaly, no call", () => {
  const { calls, anomalies } = parseToolCalls('<tool_call>{not json}</tool_call>');
  assert.equal(calls.length, 0);
  assert.equal(anomalies[0].type, "invalid_json");
});

test("parseToolCalls: text mentioning tag but no valid block → near_miss", () => {
  const { calls, anomalies } = parseToolCalls("I would emit a <tool_call> but I won't finish it properly");
  assert.equal(calls.length, 0);
  assert.ok(anomalies.some((a) => a.type === "unterminated" || a.type === "near_miss"));
});

test("parseToolCalls: plain text → no calls, no anomalies", () => {
  const { calls, anomalies } = parseToolCalls("just a normal answer");
  assert.equal(calls.length, 0);
  assert.equal(anomalies.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tool-bridge.test.mjs`
Expected: FAIL — `Cannot find module '../lib/tool-bridge.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/tool-bridge.mjs`:

```js
// Tool Bridge Mode helpers: prompt protocol + tool_call extraction. Pure — no I/O.
// Tested in tests/tool-bridge.test.mjs.
import { randomUUID } from "node:crypto";

const OPEN_RE = /<tool_call\s*>/i;
const CLOSE_RE = /<\/tool_call\s*>/i;

/** Build the <tool_calling_protocol> prompt section. Empty tools → "". */
export function buildToolProtocol(tools) {
  if (!tools || !tools.length) return "";
  const toolDefs = tools
    .map((t) => {
      const fn = t.function || t;
      const params = fn.parameters ? JSON.stringify(fn.parameters, null, 2) : "{}";
      return `### ${fn.name}\nDescription: ${fn.description || "(no description)"}\nParameters:\n${params}`;
    })
    .join("\n\n");
  return `<tool_calling_protocol>
You have access to the following tools. When you want to call a tool, output a <tool_call> block in this EXACT format:

<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1"}}
</tool_call>

Rules:
- Output one <tool_call> block per tool. You MAY emit several blocks to call multiple tools in one turn.
- JSON inside must be valid and match the tool's parameter schema.
- Do NOT wrap blocks in markdown code fences. Emit the raw <tool_call> block.
- After emitting your tool_call block(s), STOP. Do NOT add any text after the blocks; do NOT describe, summarise, or predict results you have not received yet.
- If no tool is needed, respond normally without any <tool_call> block.

Available tools:
${toolDefs}
</tool_calling_protocol>`;
}

/** Extract the first brace-balanced JSON object in `s` (string/escape aware). */
export function extractBalancedJson(s) {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/** Build an OpenAI tool_call from a JSON string; push anomaly + return null on failure. */
export function makeCall(jsonStr, anomalies) {
  let parsed;
  try { parsed = JSON.parse(jsonStr); }
  catch { anomalies.push({ type: "invalid_json", snippet: jsonStr }); return null; }
  if (!parsed || !parsed.name) { anomalies.push({ type: "invalid_json", snippet: jsonStr }); return null; }
  const args = parsed.arguments ?? parsed.params ?? {};
  return {
    id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: { name: parsed.name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
}

/**
 * Extract all tool calls from a complete text.
 * @returns {{ calls: object[], anomalies: object[], leadingText: string }}
 */
export function parseToolCalls(text) {
  const calls = [];
  const anomalies = [];
  let leadingText = null;
  let pos = 0;
  while (true) {
    const m = text.slice(pos).match(OPEN_RE);
    if (!m) break;
    const openAt = pos + m.index;
    if (leadingText === null) leadingText = text.slice(0, openAt);
    // best-effort: note a code fence immediately before the block
    if (/```[a-zA-Z]*\s*$/.test(text.slice(0, openAt))) {
      anomalies.push({ type: "fenced", snippet: text.slice(Math.max(0, openAt - 12), openAt) });
    }
    const afterOpen = openAt + m[0].length;
    const cm = text.slice(afterOpen).match(CLOSE_RE);
    if (!cm) { anomalies.push({ type: "unterminated", snippet: text.slice(openAt) }); break; }
    const closeAt = afterOpen + cm.index;
    const payload = text.slice(afterOpen, closeAt);
    const json = extractBalancedJson(payload);
    if (!json) anomalies.push({ type: "unbalanced", snippet: payload });
    else { const c = makeCall(json, anomalies); if (c) calls.push(c); }
    pos = closeAt + cm[0].length;
  }
  if (leadingText === null) leadingText = text;
  if (calls.length === 0 && anomalies.length === 0 && /<\/?tool_call/i.test(text)) {
    anomalies.push({ type: "near_miss", snippet: text.slice(0, 500) });
  }
  return { calls, anomalies, leadingText };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/tool-bridge.test.mjs`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add lib/tool-bridge.mjs tests/tool-bridge.test.mjs
git commit -m "feat(tool-bridge): balanced-JSON parseToolCalls + protocol with STOP rule"
```

---

## Task 2: `lib/tool-bridge.mjs` — `createToolCallScanner`

**Files:**
- Modify: `lib/tool-bridge.mjs` (append `createToolCallScanner`)
- Test: `tests/tool-bridge.test.mjs` (append)

- [ ] **Step 1: Write the failing test** (append to `tests/tool-bridge.test.mjs`)

```js
import { createToolCallScanner } from "../lib/tool-bridge.mjs";

function drain(scanner, chunks) {
  let text = "";
  const calls = [];
  const anomalies = [];
  for (const c of chunks) {
    const r = scanner.push(c);
    text += r.text; calls.push(...r.toolCalls); anomalies.push(...r.anomalies);
  }
  const f = scanner.flush();
  text += f.text; calls.push(...f.toolCalls); anomalies.push(...f.anomalies);
  return { text, calls, anomalies };
}

test("scanner: plain text passes through", () => {
  const { text, calls } = drain(createToolCallScanner(), ["hello ", "world"]);
  assert.equal(text, "hello world");
  assert.equal(calls.length, 0);
});

test("scanner: single block in one push, leading text streamed", () => {
  const { text, calls } = drain(createToolCallScanner(), ['Doing it.\n<tool_call>{"name":"a","arguments":{"x":1}}</tool_call>']);
  assert.equal(text, "Doing it.\n");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].index, 0);
  assert.equal(calls[0].function.name, "a");
});

test("scanner: open tag split across chunks", () => {
  const { calls } = drain(createToolCallScanner(), ["pre <tool_", 'call>{"name":"a","arguments":{}}</tool_call>']);
  assert.equal(calls.length, 1);
});

test("scanner: close tag split across chunks", () => {
  const { calls } = drain(createToolCallScanner(), ['<tool_call>{"name":"a","arguments":{}}</tool', "_call>"]);
  assert.equal(calls.length, 1);
});

test("scanner: two blocks in one push get indices 0 and 1", () => {
  const { calls } = drain(createToolCallScanner(), ['<tool_call>{"name":"a","arguments":{}}</tool_call><tool_call>{"name":"b","arguments":{}}</tool_call>']);
  assert.deepEqual(calls.map((c) => c.index), [0, 1]);
});

test("scanner: text AFTER a tool_call is suppressed (R2)", () => {
  const { text, calls } = drain(createToolCallScanner(), ['<tool_call>{"name":"a","arguments":{}}</tool_call>\nI already did it, results coming.']);
  assert.equal(calls.length, 1);
  assert.equal(text, ""); // trailing narration dropped
});

test("scanner: nested args survive incremental scan", () => {
  const { calls } = drain(createToolCallScanner(), ['<tool_call>{"name":"a","arguments":{"o":{"k":"v"},"arr":[1,2]}}', "</tool_call>"]);
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { o: { k: "v" }, arr: [1, 2] });
});

test("scanner: accumulates text across multiple pushes (multi assistant events)", () => {
  const { text, calls } = drain(createToolCallScanner(), ["part one ", "part two ", "part three"]);
  assert.equal(text, "part one part two part three");
  assert.equal(calls.length, 0);
});

test("scanner: unterminated block on flush → text fallback + anomaly", () => {
  const { text, calls, anomalies } = drain(createToolCallScanner(), ['oops <tool_call>{"name":"a"']);
  assert.equal(calls.length, 0);
  assert.match(text, /<tool_call>\{"name":"a"/);
  assert.ok(anomalies.some((a) => a.type === "unterminated"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tool-bridge.test.mjs`
Expected: FAIL — `createToolCallScanner` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `lib/tool-bridge.mjs`)

```js
const HOLD = 12; // = "</tool_call>".length; on a non-final push never emit the
                 // trailing HOLD chars of outside text (a tag may be split there).

/**
 * Stateful incremental scanner. push(chunk)/flush() each return
 * { text, toolCalls, anomalies }. Once any tool_call is emitted, outside-block
 * text is suppressed (R2). toolCalls carry a turn-continuous `index`.
 */
export function createToolCallScanner() {
  let buf = "";          // unprocessed outside-block text
  let inBlock = false;
  let openTag = "<tool_call>";
  let blockBuf = "";     // text since the open tag
  let nextIndex = 0;
  let suppress = false;  // true after first call emitted
  let sawWord = false;

  function emitText(out, s) {
    if (s && /<\/?tool_call/i.test(s)) sawWord = true;
    if (s && !suppress) out.text += s;
  }

  function process(out, isFlush) {
    while (true) {
      if (!inBlock) {
        const m = buf.match(OPEN_RE);
        if (m) {
          let before = buf.slice(0, m.index);
          const stripped = before.replace(/```[a-zA-Z]*\s*$/, "");
          if (stripped !== before) out.anomalies.push({ type: "fenced", snippet: before.slice(-12) });
          emitText(out, stripped);
          openTag = m[0];
          inBlock = true; blockBuf = "";
          buf = buf.slice(m.index + m[0].length);
          continue;
        }
        if (isFlush) { emitText(out, buf); buf = ""; break; }
        if (buf.length > HOLD) { emitText(out, buf.slice(0, -HOLD)); buf = buf.slice(-HOLD); }
        break;
      } else {
        blockBuf += buf; buf = "";
        const cm = blockBuf.match(CLOSE_RE);
        if (!cm) break;
        const payload = blockBuf.slice(0, cm.index);
        const rest = blockBuf.slice(cm.index + cm[0].length);
        const json = extractBalancedJson(payload);
        if (!json) out.anomalies.push({ type: "unbalanced", snippet: payload });
        else {
          const c = makeCall(json, out.anomalies);
          if (c) { c.index = nextIndex++; out.toolCalls.push(c); suppress = true; }
        }
        inBlock = false; blockBuf = ""; buf = rest;
      }
    }
  }

  return {
    push(chunk) {
      const out = { text: "", toolCalls: [], anomalies: [] };
      buf += chunk;
      process(out, false);
      return out;
    },
    flush() {
      const out = { text: "", toolCalls: [], anomalies: [] };
      if (inBlock) {
        out.anomalies.push({ type: "unterminated", snippet: openTag + blockBuf });
        const raw = openTag + blockBuf;
        if (!suppress) out.text += raw;
        inBlock = false; blockBuf = "";
      }
      process(out, true);
      if (nextIndex === 0 && sawWord) out.anomalies.push({ type: "near_miss", snippet: "" });
      return out;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/tool-bridge.test.mjs`
Expected: PASS (Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/tool-bridge.mjs tests/tool-bridge.test.mjs
git commit -m "feat(tool-bridge): incremental scanner with split-tag handling + R2 suppression"
```

---

## Task 3: `lib/cli-output.mjs` — non-stream array parser

**Files:**
- Create: `lib/cli-output.mjs`
- Test: `tests/cli-output.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/cli-output.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClaudeJsonOutput } from "../lib/cli-output.mjs";

test("array output: takes result event text + usage", () => {
  const out = JSON.stringify([
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    { type: "result", is_error: false, result: "hello world", stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 9 } },
  ]);
  const r = parseClaudeJsonOutput(out);
  assert.equal(r.text, "hello world");
  assert.equal(r.usage.input_tokens, 2);
  assert.equal(r.usage.output_tokens, 9);
  assert.equal(r.isError, false);
  assert.equal(r.stopReason, "end_turn");
});

test("tolerates a noise prefix before the JSON array", () => {
  const out = 'Warning: no stdin data\n' + JSON.stringify([{ type: "result", result: "ok", usage: { input_tokens: 1, output_tokens: 1 } }]);
  assert.equal(parseClaudeJsonOutput(out).text, "ok");
});

test("no result event → falls back to last assistant text", () => {
  const out = JSON.stringify([{ type: "assistant", message: { content: [{ type: "text", text: "fallback" }] } }]);
  assert.equal(parseClaudeJsonOutput(out).text, "fallback");
});

test("legacy single object → reads .result/.usage", () => {
  const out = JSON.stringify({ type: "result", result: "single", usage: { input_tokens: 3, output_tokens: 4 } });
  const r = parseClaudeJsonOutput(out);
  assert.equal(r.text, "single");
  assert.equal(r.usage.output_tokens, 4);
});

test("is_error surfaced", () => {
  const out = JSON.stringify([{ type: "result", is_error: true, result: "boom", usage: {} }]);
  assert.equal(parseClaudeJsonOutput(out).isError, true);
});

test("unparseable → safe fallback (raw text, no usage)", () => {
  const r = parseClaudeJsonOutput("not json at all");
  assert.equal(r.text, "not json at all");
  assert.equal(r.usage, null);
  assert.equal(r.isError, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cli-output.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/cli-output.mjs`:

```js
// Parse the output of `claude -p --output-format json`. Pure — no I/O.
// Claude Code 2.1.x emits an ARRAY of events; older builds a single object.
// Tested in tests/cli-output.test.mjs.

function textFromAssistant(ev) {
  const content = ev?.message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

/**
 * @returns {{ text: string, usage: object|null, isError: boolean, stopReason: string|null }}
 */
export function parseClaudeJsonOutput(stdout) {
  const trimmed = String(stdout ?? "");
  const startArr = trimmed.indexOf("[");
  const startObj = trimmed.indexOf("{");
  let from = -1;
  if (startArr === -1) from = startObj;
  else if (startObj === -1) from = startArr;
  else from = Math.min(startArr, startObj);

  if (from !== -1) {
    try {
      const parsed = JSON.parse(trimmed.slice(from));
      if (Array.isArray(parsed)) {
        const result = [...parsed].reverse().find((e) => e?.type === "result");
        if (result) {
          return { text: result.result ?? "", usage: result.usage ?? null, isError: !!result.is_error, stopReason: result.stop_reason ?? null };
        }
        const lastAssistant = [...parsed].reverse().find((e) => e?.type === "assistant");
        if (lastAssistant) {
          return { text: textFromAssistant(lastAssistant), usage: null, isError: false, stopReason: null };
        }
      } else if (parsed && typeof parsed === "object") {
        return { text: parsed.result ?? "", usage: parsed.usage ?? null, isError: !!parsed.is_error, stopReason: parsed.stop_reason ?? null };
      }
    } catch {
      // fall through to safe fallback
    }
  }
  return { text: trimmed.trim(), usage: null, isError: false, stopReason: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cli-output.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/cli-output.mjs tests/cli-output.test.mjs
git commit -m "feat(cli-output): parse claude -p json array output (fixes non-stream dump)"
```

---

## Task 4: `lib/usage-log.mjs` — CSV row formatter

**Files:**
- Create: `lib/usage-log.mjs`
- Test: `tests/usage-log.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/usage-log.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { USAGE_CSV_HEADER, USAGE_COLUMNS, formatUsageRow } from "../lib/usage-log.mjs";

test("header lists all columns in order", () => {
  assert.equal(USAGE_CSV_HEADER, USAGE_COLUMNS.join(","));
});

test("formatUsageRow: values placed in column order", () => {
  const row = formatUsageRow({ timestamp_iso: "2026-06-22T00:00:00Z", request_id: "abc", model: "sonnet", input_tokens: 2, output_tokens: 215, total_cost_usd: 0.0484 });
  const cells = row.split(",");
  assert.equal(cells[USAGE_COLUMNS.indexOf("timestamp_iso")], "2026-06-22T00:00:00Z");
  assert.equal(cells[USAGE_COLUMNS.indexOf("input_tokens")], "2");
  assert.equal(cells[USAGE_COLUMNS.indexOf("total_cost_usd")], "0.0484");
});

test("formatUsageRow: missing fields become empty cells", () => {
  const row = formatUsageRow({ request_id: "abc" });
  assert.equal(row.split(",").length, USAGE_COLUMNS.length);
});

test("formatUsageRow: quotes fields containing comma/quote/newline", () => {
  const row = formatUsageRow({ model: 'a,b"c\nd' });
  assert.ok(row.includes('"a,b""c\nd"'));
});

test("formatUsageRow: row has no trailing newline", () => {
  assert.ok(!formatUsageRow({ request_id: "x" }).endsWith("\n"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/usage-log.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/usage-log.mjs`:

```js
// CSV row formatting for the per-call host usage log. Pure — no I/O.
// The server owns the appendFileSync. Tested in tests/usage-log.test.mjs.

export const USAGE_COLUMNS = [
  "timestamp_iso", "request_id", "endpoint", "client_ip", "model", "tool_mode",
  "stream", "input_tokens", "output_tokens", "cache_creation_tokens",
  "cache_read_tokens", "total_cost_usd", "duration_ms", "num_turns",
  "tool_calls", "finish_reason", "status",
];

export const USAGE_CSV_HEADER = USAGE_COLUMNS.join(",");

function cell(v) {
  if (v === undefined || v === null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Format one usage record as a CSV line (no trailing newline). */
export function formatUsageRow(record) {
  return USAGE_COLUMNS.map((c) => cell(record[c])).join(",");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/usage-log.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/usage-log.mjs tests/usage-log.test.mjs
git commit -m "feat(usage-log): CSV row formatter for per-call host usage log"
```

---

## Task 5: `lib/metrics.mjs` — anomaly / tool-call / usage counters

**Files:**
- Modify: `lib/metrics.mjs`
- Test: `tests/metrics.test.mjs`

- [ ] **Step 1: Write the failing test** (append to `tests/metrics.test.mjs`)

```js
test("tool-call, anomaly, and usage counters render", () => {
  const m = createMetrics();
  m.recordToolCalls(2);
  m.recordToolParseAnomaly("invalid_json");
  m.recordToolParseAnomaly("invalid_json");
  m.recordToolParseAnomaly("near_miss");
  m.recordUsage({ inputTokens: 2, outputTokens: 215, costUsd: 0.0484 });
  const out = m.render();
  assert.match(out, /bridge_tool_calls_total 2/);
  assert.match(out, /bridge_tool_parse_anomalies_total\{type="invalid_json"\} 2/);
  assert.match(out, /bridge_tool_parse_anomalies_total\{type="near_miss"\} 1/);
  assert.match(out, /bridge_tokens_total\{type="input"\} 2/);
  assert.match(out, /bridge_tokens_total\{type="output"\} 215/);
  assert.match(out, /bridge_cost_usd_total 0.0484/);
});
```

> If `tests/metrics.test.mjs` does not already import `createMetrics`/`test`/`assert`, add the imports it uses (mirror the existing test file header).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/metrics.test.mjs`
Expected: FAIL — `m.recordToolCalls is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/metrics.mjs`, inside `createMetrics`, add state near the other counters:

```js
  const toolAnomalies = new Map(); // type → count
  let toolCalls = 0;
  let tokensInput = 0;
  let tokensOutput = 0;
  let costUsd = 0;
```

Add these methods to the returned object (next to `incAuthFailure`):

```js
    recordToolCalls(n = 1) { toolCalls += n; },
    recordToolParseAnomaly(type) { toolAnomalies.set(type, (toolAnomalies.get(type) || 0) + 1); },
    recordUsage({ inputTokens = 0, outputTokens = 0, costUsd: c = 0 } = {}) {
      tokensInput += inputTokens; tokensOutput += outputTokens; costUsd += c;
    },
```

In `render()`, before the final `return lines.join(...)`, add:

```js
      lines.push(
        "# HELP bridge_tool_calls_total Tool calls emitted in tool-bridge mode.",
        "# TYPE bridge_tool_calls_total counter",
        `bridge_tool_calls_total ${toolCalls}`,
        "# HELP bridge_tool_parse_anomalies_total Tool-call parse anomalies by type.",
        "# TYPE bridge_tool_parse_anomalies_total counter"
      );
      for (const [type, count] of toolAnomalies) {
        lines.push(`bridge_tool_parse_anomalies_total{type="${type}"} ${count}`);
      }
      lines.push(
        "# HELP bridge_tokens_total Tokens billed, by direction.",
        "# TYPE bridge_tokens_total counter",
        `bridge_tokens_total{type="input"} ${tokensInput}`,
        `bridge_tokens_total{type="output"} ${tokensOutput}`,
        "# HELP bridge_cost_usd_total Cumulative USD cost reported by claude.",
        "# TYPE bridge_cost_usd_total counter",
        `bridge_cost_usd_total ${costUsd}`
      );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/metrics.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/metrics.mjs tests/metrics.test.mjs
git commit -m "feat(metrics): tool-call, parse-anomaly, token and cost counters"
```

---

## Task 6: Wire prompt + parsing into the server

**Files:**
- Modify: `claude-code-bridge.mjs`

- [ ] **Step 1: Add imports**

At the top of `claude-code-bridge.mjs`, alongside the existing `lib/` imports, add:

```js
import { buildToolProtocol, parseToolCalls, createToolCallScanner } from "./lib/tool-bridge.mjs";
import { parseClaudeJsonOutput } from "./lib/cli-output.mjs";
import { USAGE_CSV_HEADER, formatUsageRow } from "./lib/usage-log.mjs";
```

- [ ] **Step 2: Remove the inline duplicates**

Delete the inline `TOOL_CALL_REGEX`, `TOOL_CALL_FENCED_REGEX`, `toolsToPromptSection`, and `parseToolCalls` definitions (the "Tool Bridge Mode" block, currently around lines 238–300). They are now provided by `lib/tool-bridge.mjs`.

- [ ] **Step 3: Point `messagesToPrompt` at `buildToolProtocol`**

In `messagesToPrompt`, replace:

```js
    const toolSection = toolsToPromptSection(tools);
```

with:

```js
    const toolSection = buildToolProtocol(tools);
```

- [ ] **Step 4: Run the existing suite + a quick smoke**

Run: `node --test tests/*.test.mjs`
Expected: PASS (no test imports the removed inline functions).

Run: `node -e "import('./claude-code-bridge.mjs').catch(e=>{console.error(e);process.exit(1)})"` is NOT valid (it starts a server). Instead verify the file parses:
Run: `node --check claude-code-bridge.mjs`
Expected: no output (syntax OK).

- [ ] **Step 5: Commit**

```bash
git add claude-code-bridge.mjs
git commit -m "refactor(server): use lib/tool-bridge for protocol + parsing"
```

---

## Task 7: Rewire the streaming tool-bridge path (scanner + usage)

**Files:**
- Modify: `claude-code-bridge.mjs` (streaming branch of `runClaudeCode`, ~lines 552–682)

- [ ] **Step 1: Add a `meta` param to `runClaudeCode`**

Change the signature:

```js
function runClaudeCode(prompt, requestModel, stream, res, tools) {
```

to:

```js
function runClaudeCode(prompt, requestModel, stream, res, tools, meta = {}) {
```

(`meta` carries `{ clientIp, endpoint }` from the handlers — wired in Task 9.)

- [ ] **Step 2: Replace the streaming text collection + close handler**

In the `if (stream) {` branch, replace the `toolBridgeBuffer` declaration and `collectText` function with a scanner-based version. Replace:

```js
        let totalContent = "";      // streamed text (non-tool-bridge)
        let toolBridgeBuffer = "";  // collected text (tool bridge mode — don't stream yet)
        let usageFromResult = null;

        function collectText(text) {
            if (toolBridgeMode) {
                toolBridgeBuffer += text;
            } else {
                totalContent += text;
                res.write(`data: ${JSON.stringify({
                    id: requestId, object: "chat.completion.chunk", created, model: modelName,
                    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                })}\n\n`);
            }
        }
```

with:

```js
        let totalContent = "";      // streamed text length tracking
        let usageFromResult = null;
        const scanner = toolBridgeMode ? createToolCallScanner() : null;
        let emittedAnyCall = false;
        let callCount = 0;

        function streamContent(text) {
            if (!text) return;
            res.write(`data: ${JSON.stringify({
                id: requestId, object: "chat.completion.chunk", created, model: modelName,
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            })}\n\n`);
        }
        function streamToolCall(call) {
            res.write(`data: ${JSON.stringify({
                id: requestId, object: "chat.completion.chunk", created, model: modelName,
                choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }],
            })}\n\n`);
        }
        function logAnomalies(list) {
            for (const a of list) {
                metrics.recordToolParseAnomaly(a.type);
                logParseAnomaly(requestId, a);
            }
        }
        function collectText(text) {
            if (toolBridgeMode) {
                const r = scanner.push(text);
                streamContent(r.text);
                totalContent += r.text;
                for (const c of r.toolCalls) { streamToolCall(c); emittedAnyCall = true; callCount++; }
                logAnomalies(r.anomalies);
            } else {
                totalContent += text;
                streamContent(text);
            }
        }
```

> `metrics` is the module-scoped metrics instance created for `/metrics`. `logParseAnomaly` is added in Task 9. If `metrics` is not in scope at this point, confirm it is the same instance used by the `/metrics` route (it is module-level).

- [ ] **Step 3: Replace the close-handler tool-bridge branch**

In `proc.on("close", ...)` of the streaming branch, replace the whole `if (toolBridgeMode) { ... } else { ... }` block that emits the final chunk with:

```js
            if (toolBridgeMode) {
                const f = scanner.flush();
                streamContent(f.text);
                for (const c of f.toolCalls) { streamToolCall(c); emittedAnyCall = true; callCount++; }
                logAnomalies(f.anomalies);
                const finish = emittedAnyCall ? "tool_calls" : "stop";
                res.write(`data: ${JSON.stringify({
                    id: requestId, object: "chat.completion.chunk", created, model: modelName,
                    choices: [{ index: 0, delta: {}, finish_reason: finish }],
                    usage,
                })}\n\n`);
                if (callCount) metrics.recordToolCalls(callCount);
                console.log(`[${new Date().toISOString()}] ✓ Request ${requestId.slice(-8)}: completed in ${elapsed}s (stream, finish=${finish}, calls=${callCount})`);
            } else {
                res.write(`data: ${JSON.stringify({
                    id: requestId, object: "chat.completion.chunk", created, model: modelName,
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    usage,
                })}\n\n`);
                console.log(`[${new Date().toISOString()}] ✓ Request ${requestId.slice(-8)}: completed in ${elapsed}s (stream, ${totalContent.length} chars)`);
            }
```

- [ ] **Step 4: Fix streaming usage extraction**

In the `else if (event.type === "result")` handler, change the usage source to read the nested `usage` object. Replace:

```js
                    usageFromResult = {
                        prompt_tokens: event.input_tokens || estimateTokens(prompt),
                        completion_tokens: event.output_tokens || estimateTokens(toolBridgeBuffer || totalContent),
                        total_tokens: (event.input_tokens || estimateTokens(prompt)) + (event.output_tokens || estimateTokens(toolBridgeBuffer || totalContent)),
                    };
```

with:

```js
                    const u = event.usage || {};
                    const inTok = u.input_tokens ?? event.input_tokens ?? estimateTokens(prompt);
                    const outTok = u.output_tokens ?? event.output_tokens ?? estimateTokens(totalContent);
                    usageFromResult = {
                        prompt_tokens: inTok,
                        completion_tokens: outTok,
                        total_tokens: inTok + outTok,
                        _claude: { ...u, total_cost_usd: event.total_cost_usd, duration_ms: event.duration_ms, num_turns: event.num_turns, stop_reason: event.stop_reason },
                    };
```

Also fix the two remaining `toolBridgeBuffer` references in the same handler (the `event.result` fallback and the `usage` fallback in `proc.on("close")`): replace `toolBridgeBuffer || totalContent` with `totalContent`, and `!toolBridgeBuffer` with `true` in the `event.result` guard (so a result-only stream still emits its text). Concretely, the `event.type === "result"` text guard becomes:

```js
                    if (event.result && !totalContent) collectText(event.result);
```

- [ ] **Step 5: Syntax check + run suite**

Run: `node --check claude-code-bridge.mjs`
Expected: no output.
Run: `node --test tests/*.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add claude-code-bridge.mjs
git commit -m "feat(server): scanner-based streaming tool-bridge + correct usage extraction"
```

---

## Task 8: Rewire the non-stream path (cli-output + usage)

**Files:**
- Modify: `claude-code-bridge.mjs` (non-stream branch of `runClaudeCode`, ~lines 683–746)

- [ ] **Step 1: Replace the JSON parse + tool-bridge block**

Replace:

```js
            // Parse Claude Code JSON output
            let claudeResponse;
            try {
                const jsonStart = stdout.indexOf("{");
                claudeResponse = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);
            } catch {
                claudeResponse = { result: stdout.trim() };
            }

            const responseText = claudeResponse.result || "";
            const usage = {
                prompt_tokens: claudeResponse.input_tokens || estimateTokens(prompt),
                completion_tokens: claudeResponse.output_tokens || estimateTokens(responseText),
                total_tokens: (claudeResponse.input_tokens || estimateTokens(prompt)) + (claudeResponse.output_tokens || estimateTokens(responseText)),
            };
```

with:

```js
            const parsedOut = parseClaudeJsonOutput(stdout);
            if (parsedOut.isError) {
                const classified = classifyError(null, parsedOut.text || stderrOutput);
                sendError(res, classified.status, classified.message, classified.type);
                return;
            }
            const responseText = parsedOut.text || "";
            const cu = parsedOut.usage || {};
            const inTok = cu.input_tokens ?? estimateTokens(prompt);
            const outTok = cu.output_tokens ?? estimateTokens(responseText);
            const usage = { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok,
                _claude: { ...cu, total_cost_usd: parsedOut.usage?.total_cost_usd } };
```

- [ ] **Step 2: Update the tool-bridge detection to the new return shape**

Replace:

```js
            if (toolBridgeMode) {
                const parsedCalls = parseToolCalls(responseText);
                if (parsedCalls.length > 0) {
```

with:

```js
            if (toolBridgeMode) {
                const { calls: parsedCalls, anomalies } = parseToolCalls(responseText);
                for (const a of anomalies) { metrics.recordToolParseAnomaly(a.type); logParseAnomaly(requestId, a); }
                if (parsedCalls.length > 0) {
                    metrics.recordToolCalls(parsedCalls.length);
```

(The body that builds the `tool_calls` response stays the same; just ensure the extra `metrics.recordToolCalls` line is inside the `if`.)

- [ ] **Step 3: Syntax check + run suite**

Run: `node --check claude-code-bridge.mjs`
Expected: no output.
Run: `node --test tests/*.test.mjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add claude-code-bridge.mjs
git commit -m "fix(server): parse claude json array for non-stream + correct usage"
```

---

## Task 9: Anomaly logging + usage CSV + meta wiring

**Files:**
- Modify: `claude-code-bridge.mjs`

- [ ] **Step 1: Add config near the other CONFIG fields**

Where `CONFIG` is built, add:

```js
    toolParseLogFull: process.env.BRIDGE_TOOL_PARSE_LOG_FULL === "1",
    usageLogPath: (process.env.BRIDGE_USAGE_LOG ?? "./logs/token-usage.csv"),
```

- [ ] **Step 2: Add the two helper functions** (near `classifyError`)

```js
function logParseAnomaly(requestId, anomaly) {
    const snip = CONFIG.toolParseLogFull ? anomaly.snippet : String(anomaly.snippet || "").slice(0, 200);
    console.warn(`[${new Date().toISOString()}] ⚠ ParseAnomaly ${requestId.slice(-8)} type=${anomaly.type} snippet=${JSON.stringify(snip)}`);
}

function appendUsageLog(record) {
    if (!CONFIG.usageLogPath || CONFIG.usageLogPath.toLowerCase() === "off") return;
    try {
        const file = CONFIG.usageLogPath;
        mkdirSync(dirname(file), { recursive: true });
        if (!existsSync(file)) writeFileSync(file, USAGE_CSV_HEADER + "\n", "utf8");
        appendFileSync(file, formatUsageRow(record) + "\n", "utf8");
    } catch (err) {
        console.error(`[usage-log] write failed: ${err.message}`);
    }
}
```

> Ensure `appendFileSync`, `existsSync`, `mkdirSync`, `writeFileSync` are imported from `node:fs` and `dirname` from `node:path` (most already are; add any missing).

- [ ] **Step 3: Build the usage record at both close handlers**

Add a shared helper inside `runClaudeCode` (after `usage` is known, in each close handler), or define once near the top of `runClaudeCode`:

```js
    function recordUsage(usage, { toolCalls = 0, finishReason = "stop", status = 200 } = {}) {
        const c = usage?._claude || {};
        metrics.recordUsage({ inputTokens: usage?.prompt_tokens || 0, outputTokens: usage?.completion_tokens || 0, costUsd: c.total_cost_usd || 0 });
        appendUsageLog({
            timestamp_iso: new Date().toISOString(),
            request_id: requestId.slice(-8),
            endpoint: meta.endpoint || "",
            client_ip: meta.clientIp || "",
            model: claudeModel,
            tool_mode: CONFIG.toolMode,
            stream: String(stream),
            input_tokens: usage?.prompt_tokens ?? "",
            output_tokens: usage?.completion_tokens ?? "",
            cache_creation_tokens: c.cache_creation_input_tokens ?? "",
            cache_read_tokens: c.cache_read_input_tokens ?? "",
            total_cost_usd: c.total_cost_usd ?? "",
            duration_ms: c.duration_ms ?? "",
            num_turns: c.num_turns ?? "",
            tool_calls: toolCalls,
            finish_reason: finishReason,
            status,
        });
    }
```

Call `recordUsage(usage, { toolCalls: callCount, finishReason: finish })` in the streaming close handler (after `finish` is computed), and `recordUsage(usage, { toolCalls: parsedCalls?.length || 0, finishReason: toolBridgeMode && parsedCalls?.length ? "tool_calls" : "stop" })` just before each `res.end(...)` in the non-stream handler.

- [ ] **Step 4: Pass `meta` from the route handlers**

In the `/v1/chat/completions` handler, change:

```js
        runClaudeCode(prompt, data.model, stream, res, tools);
```

to:

```js
        const clientIp = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "").trim();
        runClaudeCode(prompt, data.model, stream, res, tools, { clientIp, endpoint: "/v1/chat/completions" });
```

In the `/v1/messages` handler, change:

```js
        runClaudeCode(prompt, converted.model, stream, adapted, tools);
```

to:

```js
        const clientIp = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "").trim();
        runClaudeCode(prompt, converted.model, stream, adapted, tools, { clientIp, endpoint: "/v1/messages" });
```

- [ ] **Step 5: Syntax check + run suite**

Run: `node --check claude-code-bridge.mjs`
Expected: no output.
Run: `node --test tests/*.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add claude-code-bridge.mjs
git commit -m "feat(server): parse-anomaly logging + per-call usage CSV + metrics"
```

---

## Task 10: Config files — `.gitignore`, `.env.example`

**Files:**
- Modify: `.gitignore`, `.env.example`

- [ ] **Step 1: Ignore the logs dir**

Append to `.gitignore`:

```
# runtime usage log
logs/
```

- [ ] **Step 2: Document the env vars**

Append to `.env.example`:

```
# Per-call usage CSV (date/ip/tokens/cost). Default ./logs/token-usage.csv; set 'off' to disable.
# BRIDGE_USAGE_LOG=./logs/token-usage.csv
# Log full (untruncated) tool-call parse-anomaly snippets (default off; truncated to 200 chars).
# BRIDGE_TOOL_PARSE_LOG_FULL=1
```

- [ ] **Step 3: Verify `logs/` is ignored**

Run: `mkdir -p logs && touch logs/token-usage.csv && git status --short logs/`
Expected: no output (the file is ignored). Then `rm -rf logs`.

- [ ] **Step 4: Commit**

```bash
git add .gitignore .env.example
git commit -m "chore: gitignore logs/, document BRIDGE_USAGE_LOG + BRIDGE_TOOL_PARSE_LOG_FULL"
```

---

## Task 11: Version bump + docs

**Files:**
- Modify: `claude-code-bridge.mjs` (version strings), `docs/CHANGELOG.md`, `docs/CHANGELOG.zh-TW.md`, `docs/configuration.md`, `docs/configuration.zh-TW.md`

- [ ] **Step 1: Bump version 1.4.1 → 1.5.0**

Run: `git grep -n "1\.4\.1" -- claude-code-bridge.mjs`
Update each match (header title comment, header changelog note, `version:` in `/health`, startup banner) to `1.5.0`.

- [ ] **Step 2: CHANGELOG (both languages)**

Add a `## v1.5.0` entry to `docs/CHANGELOG.md` and mirror in `docs/CHANGELOG.zh-TW.md`:
- **Fixed:** non-stream `--output-format json` array parse (previously dumped raw JSON as content); usage now read from `result.usage.*` instead of estimate.
- **Added:** balanced-JSON tool-call parsing (nested args no longer dropped); parallel tool calls; protocol STOP rule; tool-bridge parse-anomaly logging + `/metrics` counters; per-call host usage CSV (`BRIDGE_USAGE_LOG`); `BRIDGE_TOOL_PARSE_LOG_FULL`.

- [ ] **Step 3: configuration docs (both languages)**

In `docs/configuration.md` and `.zh-TW.md`, add rows/sections for `BRIDGE_USAGE_LOG` and `BRIDGE_TOOL_PARSE_LOG_FULL`, and a short "Tool Bridge Mode (parsing & usage log)" subsection describing the CSV columns and that anomalies are counted in `/metrics`.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add claude-code-bridge.mjs docs/CHANGELOG.md docs/CHANGELOG.zh-TW.md docs/configuration.md docs/configuration.zh-TW.md
git commit -m "docs: v1.5.0 changelog + configuration for usage log and tool-bridge"
```

---

## Task 12: End-to-end smoke test (manual, against a running bridge)

**Files:** none (verification only)

- [ ] **Step 1: Start the bridge in llm mode on a scratch port**

Run (PowerShell): `$env:BRIDGE_TOOL_MODE='llm'; $env:BRIDGE_PORT='18799'; $env:BRIDGE_USAGE_LOG='./logs/smoke.csv'; node claude-code-bridge.mjs`
Expected: banner shows `1.5.0` and `ToolMode: llm`.

- [ ] **Step 2: Streaming parallel + nested args**

POST to `http://127.0.0.1:18799/v1/chat/completions` with `stream:true`, two `tools` (one with nested-object params), and a user message asking to call both. (Reuse the request body from spec r4.)
Expected: SSE stream yields leading content, then two `tool_calls` deltas with `index` 0 and 1 (nested args intact), `finish_reason:"tool_calls"`, no trailing narration.

- [ ] **Step 3: Non-stream tool-bridge**

Same body with `stream:false`.
Expected: one JSON response with `message.tool_calls` (2 calls, nested args intact), `finish_reason:"tool_calls"` — NOT a raw JSON dump.

- [ ] **Step 4: Plain text unaffected + usage log written**

POST a no-tools `stream:true` message; expect normal incremental content. Then check `logs/smoke.csv`: one row per call with real `total_cost_usd`, `input_tokens`, `cache_creation_tokens`. Check `http://127.0.0.1:18799/metrics` shows `bridge_tool_calls_total` and `bridge_cost_usd_total`.

- [ ] **Step 5: Stop the bridge and clean up**

Stop the process; `rm -rf logs`. No commit (verification only). If anything failed, file follow-up before declaring done.

---

## Self-Review checklist (run before execution)

- Spec §1.1 balanced parse → Task 1. §1.2 parallel + STOP → Task 1 (protocol) + Task 2 (suppression). §1.3 anomaly observability → Tasks 5, 9. §1.4 non-stream array → Task 3 + Task 8. §1.5 usage fix → Tasks 7, 8. §1.6 thinking guard → Task 7 (only `part.type==="text"` fed). §1.7 pure modules → Tasks 1–4. §1.8 usage CSV → Tasks 4, 9.
- §3.3 metrics → Task 5. §3.6 usage-log → Tasks 4, 9. §7 gitignore/env/version/docs → Tasks 10, 11.
- Deviation (no `orphan_close`, scanner-vs-buffer) documented at top.
