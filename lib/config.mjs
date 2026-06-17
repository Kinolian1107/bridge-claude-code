// Configuration helpers for the bridge. Pure — no I/O.

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
