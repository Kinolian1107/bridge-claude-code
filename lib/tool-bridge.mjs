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
    // A fenced block violates the protocol; record it for observability but
    // still parse the call (lenient) so a fence doesn't drop a valid tool call.
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
  if (calls.length === 0 && anomalies.length === 0 && /tool_call/i.test(text)) {
    anomalies.push({ type: "near_miss", snippet: text.slice(0, 500) });
  }
  return { calls, anomalies, leadingText };
}

// Index in `s` where a partial open tag begins at the very end — text we must
// hold back because the rest of the tag may arrive on the next push. Handles a
// prefix of "<tool_call" and the full word with trailing whitespace (OPEN_RE
// allows internal \s). Returns -1 if the tail cannot start an open tag.
function partialOpenStart(s) {
  const lt = s.lastIndexOf("<");
  if (lt === -1) return -1;
  const tail = s.slice(lt).toLowerCase();
  if (tail.includes(">")) return -1; // a '>' means any tag is already complete
  if ("<tool_call".startsWith(tail)) return lt; // e.g. "<", "<too", "<tool_call"
  if (/^<tool_call\s+$/.test(tail)) return lt;   // full word + trailing whitespace
  return -1;
}

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
  let sawWord = false;   // saw the literal "tool_call" in raw input
  let hadAnomaly = false;
  let rawTail = "";      // rolling window of recent raw input for sawWord detection

  function emitText(out, s) {
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
        const hp = partialOpenStart(buf);
        if (hp === -1) { emitText(out, buf); buf = ""; }
        else { emitText(out, buf.slice(0, hp)); buf = buf.slice(hp); }
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
      // sawWord is computed on raw input (with a rolling window) so a "tool_call"
      // split across pushes is not missed by the outside-text hold-back.
      const combined = rawTail + chunk;
      if (/tool_call/i.test(combined)) sawWord = true;
      rawTail = combined.slice(-16);
      buf += chunk;
      process(out, false);
      if (out.anomalies.length) hadAnomaly = true;
      return out;
    },
    flush() {
      const out = { text: "", toolCalls: [], anomalies: [] };
      if (inBlock) {
        out.anomalies.push({ type: "unterminated", snippet: openTag + blockBuf });
        if (!suppress) out.text += openTag + blockBuf;
        inBlock = false; blockBuf = "";
      }
      process(out, true);
      if (out.anomalies.length) hadAnomaly = true;
      // near_miss only when no calls AND no other anomalies (parseToolCalls parity).
      if (nextIndex === 0 && sawWord && !hadAnomaly) out.anomalies.push({ type: "near_miss", snippet: "" });
      return out;
    },
  };
}
