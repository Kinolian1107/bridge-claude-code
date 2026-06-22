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
