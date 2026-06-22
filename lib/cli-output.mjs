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
          return { text: asText(result.result), usage: result.usage ?? null, isError: !!result.is_error, stopReason: result.stop_reason ?? null };
        }
        const lastAssistant = [...parsed].reverse().find((e) => e?.type === "assistant");
        if (lastAssistant) {
          return { text: textFromAssistant(lastAssistant), usage: null, isError: false, stopReason: null };
        }
        // Parsed a valid array but no usable event — don't echo the raw JSON.
        return { text: "", usage: null, isError: false, stopReason: null };
      } else if (parsed && typeof parsed === "object") {
        return { text: asText(parsed.result), usage: parsed.usage ?? null, isError: !!parsed.is_error, stopReason: parsed.stop_reason ?? null };
      }
    } catch {
      // fall through to safe fallback
    }
  }
  return { text: trimmed.trim(), usage: null, isError: false, stopReason: null };
}
