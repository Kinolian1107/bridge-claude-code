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

test("has the expected 17 columns", () => {
  assert.equal(USAGE_COLUMNS.length, 17);
});

test("formatUsageRow: 0 and false render literally, not as empty", () => {
  const cells = formatUsageRow({ input_tokens: 0, stream: false, total_cost_usd: 0 }).split(",");
  assert.equal(cells[USAGE_COLUMNS.indexOf("input_tokens")], "0");
  assert.equal(cells[USAGE_COLUMNS.indexOf("stream")], "false");
  assert.equal(cells[USAGE_COLUMNS.indexOf("total_cost_usd")], "0");
});
