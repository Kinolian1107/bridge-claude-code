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

test("parseToolCalls: code-fenced block → fenced anomaly, call still parsed", () => {
  const { calls, anomalies } = parseToolCalls('```json\n<tool_call>{"name":"a","arguments":{"x":1}}</tool_call>\n```');
  assert.equal(calls.length, 1);
  assert.ok(anomalies.some((a) => a.type === "fenced"));
});

test("parseToolCalls: unterminated JSON braces inside block → unbalanced anomaly", () => {
  const { calls, anomalies } = parseToolCalls('<tool_call>{"name":"a","arguments":{</tool_call>');
  assert.equal(calls.length, 0);
  assert.deepEqual(anomalies.map((a) => a.type), ["unbalanced"]);
});

test("parseToolCalls: bare-word 'tool_call' mention (no brackets) → near_miss", () => {
  const { calls, anomalies } = parseToolCalls("Sure, I will invoke the tool_call to do that.");
  assert.equal(calls.length, 0);
  assert.deepEqual(anomalies.map((a) => a.type), ["near_miss"]);
});

test("parseToolCalls: plain text → no calls, no anomalies", () => {
  const { calls, anomalies } = parseToolCalls("just a normal answer");
  assert.equal(calls.length, 0);
  assert.equal(anomalies.length, 0);
});

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
  assert.equal(text, "");
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

test("scanner: bare-word 'tool_call' with no call → near_miss on flush", () => {
  const { calls, anomalies } = drain(createToolCallScanner(), ["I will use the tool_call later"]);
  assert.equal(calls.length, 0);
  assert.ok(anomalies.some((a) => a.type === "near_miss"));
});

test("scanner: unterminated block on flush → text fallback + anomaly", () => {
  const { text, calls, anomalies } = drain(createToolCallScanner(), ['oops <tool_call>{"name":"a"']);
  assert.equal(calls.length, 0);
  assert.match(text, /<tool_call>\{"name":"a"/);
  assert.ok(anomalies.some((a) => a.type === "unterminated"));
});
