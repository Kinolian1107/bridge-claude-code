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
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Format one usage record as a CSV line (no trailing newline). */
export function formatUsageRow(record) {
  return USAGE_COLUMNS.map((c) => cell(record[c])).join(",");
}
