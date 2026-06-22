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

test("non-string result coerced to empty string (text contract)", () => {
  const out = JSON.stringify([{ type: "result", result: 42, usage: {} }]);
  assert.equal(parseClaudeJsonOutput(out).text, "");
});

test("valid array with no usable event → empty text, not raw echo", () => {
  assert.equal(parseClaudeJsonOutput("[]").text, "");
});

test("legacy single object surfaces is_error and stop_reason", () => {
  const out = JSON.stringify({ type: "result", result: "x", is_error: true, stop_reason: "max_tokens", usage: {} });
  const r = parseClaudeJsonOutput(out);
  assert.equal(r.isError, true);
  assert.equal(r.stopReason, "max_tokens");
});

test("unparseable → safe fallback (raw text, no usage)", () => {
  const r = parseClaudeJsonOutput("not json at all");
  assert.equal(r.text, "not json at all");
  assert.equal(r.usage, null);
  assert.equal(r.isError, false);
});
