// Configuration helpers for the bridge. Pure — no I/O (path/temp-dir lookups
// only; directory creation is the caller's job).

import { tmpdir } from "node:os";
import { join } from "node:path";

/** Name of the dedicated empty working dir used to harden `llm` mode. */
export const LLM_WORKDIR_NAME = "claude-code-bridge-llm-cwd";

/**
 * Resolve the working directory the bridge launches `claude` in.
 *
 * Precedence: explicit CLAUDE_WORKING_DIR → HOME (POSIX) → USERPROFILE
 * (Windows has no HOME) → process cwd. The final cwd fallback guarantees a
 * non-empty string, so the server never starts with an undefined workingDir
 * (which previously crashed the startup banner on Windows daemon launches).
 *
 * @param {Record<string, string|undefined>} [env] env vars (defaults to process.env)
 * @param {string} [cwd] last-resort fallback (defaults to process.cwd())
 * @returns {string} a non-empty working directory path
 */
export function resolveWorkingDir(env = process.env, cwd = process.cwd()) {
  const candidates = [
    env.CLAUDE_WORKING_DIR,
    env.HOME,
    env.USERPROFILE,
    cwd,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  // cwd should always be a non-empty string, but guard anyway.
  return ".";
}

/**
 * Resolve the tool mode for the bridge.
 *
 * - "agent" (default) — Claude Code runs as a full agent with all built-in
 *   tools (Read, Write, Bash, …) and --dangerously-skip-permissions. File
 *   operations execute on the bridge host. Use for single-machine setups.
 * - "llm" — passes --tools "" to claude, disabling every built-in tool.
 *   Claude behaves as a pure language model. Required when the bridge is
 *   shared across machines: callers must include file content in the prompt
 *   themselves (same model as every cloud LLM API).
 *
 * @param {Record<string, string|undefined>} [env] env vars (defaults to process.env)
 * @returns {"agent"|"llm"}
 */
export function resolveToolMode(env = process.env) {
  const raw = (env.BRIDGE_TOOL_MODE ?? "").toLowerCase().trim();
  return raw === "llm" ? "llm" : "agent";
}

/**
 * Resolve the working directory, hardened for the given tool mode.
 *
 * - An explicit CLAUDE_WORKING_DIR always wins (escape hatch) — same precedence
 *   as resolveWorkingDir().
 * - In "llm" mode with no explicit CLAUDE_WORKING_DIR, return a dedicated EMPTY
 *   directory under the OS temp dir instead of $HOME. This stops a
 *   *project-level* CLAUDE.md on the bridge host from leaking into responses, so
 *   the endpoint behaves like a clean model provider. The caller (the server)
 *   is responsible for creating the directory.
 * - In "agent" mode, behaves exactly like resolveWorkingDir() ($HOME default).
 *
 * Note: it cannot point at the *caller's* machine — the bridge runs on the host
 * and has no access to the client filesystem (that is the whole premise of llm
 * mode). It also does NOT neutralise the user-level ~/.claude/CLAUDE.md or
 * settings.json, which Claude Code loads regardless of cwd.
 *
 * @param {"agent"|"llm"} toolMode
 * @param {Record<string, string|undefined>} [env] env vars (defaults to process.env)
 * @param {string} [tmpBase] OS temp dir (defaults to os.tmpdir(); injectable for tests)
 * @param {string} [cwd] last-resort fallback (defaults to process.cwd())
 * @returns {string} a non-empty working directory path
 */
export function resolveWorkingDirForMode(toolMode, env = process.env, tmpBase = tmpdir(), cwd = process.cwd()) {
  const explicit = env.CLAUDE_WORKING_DIR;
  if (typeof explicit === "string" && explicit.trim()) return resolveWorkingDir(env, cwd);
  if (toolMode === "llm") return join(tmpBase, LLM_WORKDIR_NAME);
  return resolveWorkingDir(env, cwd);
}

/**
 * Plugin tools that survive `--tools ""` and must be denied by name so nothing
 * runs on the bridge host in llm mode. `LSP` is the tool shipped by the official
 * pyright-lsp / csharp-lsp plugins. Hosts with other plugins that register tools
 * may need to add names here.
 */
export const LLM_DISALLOWED_TOOLS = ["LSP"];

/**
 * CLI args that make `llm` mode a *true* pure LLM — nothing executes on the host
 * AND no host-side config (hooks/plugins/CLAUDE.md/settings) bleeds into responses.
 *
 * `--tools ""` alone only disables the built-in set (Read/Write/Edit/Bash/…);
 * plugin tools (LSP) and MCP connectors survive, and the host's user-level
 * settings (plugins, SessionStart hooks, ~/.claude/CLAUDE.md) inject into every
 * spawned session. Verified against Claude Code 2.1.x:
 *   --tools ""                                            → LSP + mcp__* survive
 *   --tools "" --strict-mcp-config --disallowedTools LSP  → tool list empty, BUT
 *       the host superpowers SessionStart hook still fired 6× and injected its
 *       instructions into responses (observed leaking to a connected client)
 *   + --setting-sources ""                                → 0 hook events; host
 *       plugins/hooks/CLAUDE.md all gone; OAuth subscription auth still works
 *
 * - `--strict-mcp-config` ignores every host MCP config.
 * - `--disallowedTools LSP` denies the surviving LSP plugin tool by name.
 * - `--setting-sources ""` loads none of the user/project/local setting sources,
 *   so host plugins, hooks, CLAUDE.md and custom settings never load. Auth is NOT
 *   a setting source, so the claude.ai subscription / OAuth login is preserved.
 *
 * (`--bare` would also drop plugins/hooks/LSP, but it forces ANTHROPIC_API_KEY
 * auth and never reads OAuth/keychain, breaking subscription logins — NOT used.)
 *
 * @returns {string[]} args to append to the `claude` invocation in llm mode
 */
export function llmHardeningArgs() {
  return ["--tools", "", "--strict-mcp-config", "--disallowedTools", ...LLM_DISALLOWED_TOOLS, "--setting-sources", ""];
}
