// Prometheus-format metrics registry for the bridge. Pure — no I/O.
//
// Deliberately minimal: counters + gauges rendered as text exposition format
// (version 0.0.4). No client library, matching the project's zero-dep rule.

// Known endpoints, used as the `endpoint` label to keep cardinality bounded.
// Anything else (404 probes, scanners) collapses into "other".
const KNOWN_ENDPOINTS = new Set([
  "/health",
  "/metrics",
  "/v1/models",
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/messages/count_tokens",
]);

/** Normalize a pathname to a bounded endpoint label. */
export function endpointLabel(pathname) {
  if (pathname === "/") return "/health";
  return KNOWN_ENDPOINTS.has(pathname) ? pathname : "other";
}

export function createMetrics({ now = Date.now } = {}) {
  const startedAtMs = now();
  const requestCounts = new Map(); // "endpoint|method|status" → count
  const durations = new Map(); // endpoint → { sumSeconds, count }
  let authFailures = 0;
  let inflight = 0;
  const toolAnomalies = new Map(); // type → count
  let toolCalls = 0;
  let tokensInput = 0;
  let tokensOutput = 0;
  let costUsd = 0;

  return {
    recordRequest({ endpoint, method, status, durationMs }) {
      const key = `${endpoint}|${method}|${status}`;
      requestCounts.set(key, (requestCounts.get(key) || 0) + 1);
      const d = durations.get(endpoint) || { sumSeconds: 0, count: 0 };
      durations.set(endpoint, {
        sumSeconds: d.sumSeconds + durationMs / 1000,
        count: d.count + 1,
      });
    },
    incAuthFailure() {
      authFailures++;
    },
    recordToolCalls(n = 1) {
      toolCalls += n;
    },
    recordToolParseAnomaly(type) {
      toolAnomalies.set(type, (toolAnomalies.get(type) || 0) + 1);
    },
    recordUsage({ inputTokens = 0, outputTokens = 0, costUsd: c = 0 } = {}) {
      tokensInput += inputTokens;
      tokensOutput += outputTokens;
      costUsd += c;
    },
    incInflight() {
      inflight++;
    },
    decInflight() {
      inflight = Math.max(0, inflight - 1);
    },

    /** Render all metrics in Prometheus text exposition format. */
    render() {
      const lines = [
        "# HELP bridge_requests_total Total HTTP requests handled by the bridge.",
        "# TYPE bridge_requests_total counter",
      ];
      for (const [key, count] of requestCounts) {
        const [endpoint, method, status] = key.split("|");
        lines.push(
          `bridge_requests_total{endpoint="${endpoint}",method="${method}",status="${status}"} ${count}`
        );
      }

      lines.push(
        "# HELP bridge_request_duration_seconds Request duration per endpoint.",
        "# TYPE bridge_request_duration_seconds summary"
      );
      for (const [endpoint, d] of durations) {
        lines.push(
          `bridge_request_duration_seconds_sum{endpoint="${endpoint}"} ${d.sumSeconds.toFixed(3)}`,
          `bridge_request_duration_seconds_count{endpoint="${endpoint}"} ${d.count}`
        );
      }

      lines.push(
        "# HELP bridge_auth_failures_total Requests rejected by bearer auth.",
        "# TYPE bridge_auth_failures_total counter",
        `bridge_auth_failures_total ${authFailures}`,
        "# HELP bridge_inflight_requests Requests currently being handled.",
        "# TYPE bridge_inflight_requests gauge",
        `bridge_inflight_requests ${inflight}`,
        "# HELP bridge_uptime_seconds Seconds since the bridge process started.",
        "# TYPE bridge_uptime_seconds gauge",
        `bridge_uptime_seconds ${Math.floor((now() - startedAtMs) / 1000)}`
      );

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
      return lines.join("\n") + "\n";
    },
  };
}
