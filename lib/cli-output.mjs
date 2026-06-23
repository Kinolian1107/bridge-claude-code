// Parse the output of `claude -p --output-format json`. Pure — no I/O.
// Claude Code 2.1.x emits an ARRAY of events; older builds a single object.
// Tested in tests/cli-output.test.mjs.

function textFromAssistant(ev) {
  const content = ev?.message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

/** Coerce to the documented string return type (drops non-string CLI values). */
function asText(v) {
  return typeof v === "string" ? v : "";
}

const EMPTY = { text: "", usage: null, isError: false, stopReason: null, costUsd: null, durationMs: null, numTurns: null };

/** Build the result shape from a `result` event (array) or a legacy single object. */
function fromResult(ev) {
  return {
    text: asText(ev.result),
    usage: ev.usage ?? null,
    isError: !!ev.is_error,
    stopReason: ev.stop_reason ?? null,
    costUsd: ev.total_cost_usd ?? null,
    durationMs: ev.duration_ms ?? null,
    numTurns: ev.num_turns ?? null,
  };
}

/**
 * @returns {{ text: string, usage: object|null, isError: boolean, stopReason: string|null,
 *             costUsd: number|null, durationMs: number|null, numTurns: number|null }}
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
        if (result) return fromResult(result);
        const lastAssistant = [...parsed].reverse().find((e) => e?.type === "assistant");
        if (lastAssistant) return { ...EMPTY, text: textFromAssistant(lastAssistant) };
        return { ...EMPTY };
      } else if (parsed && typeof parsed === "object") {
        return fromResult(parsed);
      }
    } catch {
      // fall through to safe fallback
    }
  }
  return { ...EMPTY, text: trimmed.trim() };
}
