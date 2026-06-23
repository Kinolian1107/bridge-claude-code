// Unit tests for config helpers (lib/config.mjs).
// Run: npm test (node --test)

import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { resolveWorkingDir, resolveToolMode, resolveWorkingDirForMode, LLM_WORKDIR_NAME, llmHardeningArgs, LLM_DISALLOWED_TOOLS } from "../lib/config.mjs";

test("prefers explicit CLAUDE_WORKING_DIR over everything", () => {
  const env = { CLAUDE_WORKING_DIR: "/work", HOME: "/home", USERPROFILE: "C:\\Users\\u" };
  assert.equal(resolveWorkingDir(env, "/cwd"), "/work");
});

test("falls back to HOME on POSIX", () => {
  assert.equal(resolveWorkingDir({ HOME: "/home/u" }, "/cwd"), "/home/u");
});

test("falls back to USERPROFILE when HOME is absent (Windows)", () => {
  assert.equal(resolveWorkingDir({ USERPROFILE: "C:\\Users\\u" }, "C:\\cwd"), "C:\\Users\\u");
});

test("falls back to cwd when no env vars set (the daemon crash case)", () => {
  assert.equal(resolveWorkingDir({}, "C:\\cwd"), "C:\\cwd");
});

test("ignores empty/whitespace env values", () => {
  assert.equal(resolveWorkingDir({ CLAUDE_WORKING_DIR: "", HOME: "   " }, "/cwd"), "/cwd");
});

test("always returns a non-empty string", () => {
  const result = resolveWorkingDir({}, "");
  assert.equal(typeof result, "string");
  assert.ok(result.length > 0);
});

// ── resolveToolMode ────────────────────────────────────────────────

test("resolveToolMode: defaults to agent when BRIDGE_TOOL_MODE is unset", () => {
  assert.equal(resolveToolMode({}), "agent");
});

test("resolveToolMode: returns llm for BRIDGE_TOOL_MODE=llm", () => {
  assert.equal(resolveToolMode({ BRIDGE_TOOL_MODE: "llm" }), "llm");
});

test("resolveToolMode: llm match is case-insensitive", () => {
  assert.equal(resolveToolMode({ BRIDGE_TOOL_MODE: "LLM" }), "llm");
  assert.equal(resolveToolMode({ BRIDGE_TOOL_MODE: "Llm" }), "llm");
});

test("resolveToolMode: unknown values fall back to agent", () => {
  assert.equal(resolveToolMode({ BRIDGE_TOOL_MODE: "auto" }), "agent");
  assert.equal(resolveToolMode({ BRIDGE_TOOL_MODE: "" }), "agent");
});

test("resolveToolMode: agent is explicit alias", () => {
  assert.equal(resolveToolMode({ BRIDGE_TOOL_MODE: "agent" }), "agent");
});

// ── resolveWorkingDirForMode ───────────────────────────────────────

test("resolveWorkingDirForMode: llm mode with no explicit dir uses isolated temp dir", () => {
  const dir = resolveWorkingDirForMode("llm", { HOME: "/home/u" }, "/tmp", "/cwd");
  assert.equal(dir, join("/tmp", LLM_WORKDIR_NAME));
});

test("resolveWorkingDirForMode: explicit CLAUDE_WORKING_DIR always wins, even in llm mode", () => {
  const env = { CLAUDE_WORKING_DIR: "/work", HOME: "/home/u" };
  assert.equal(resolveWorkingDirForMode("llm", env, "/tmp", "/cwd"), "/work");
});

test("resolveWorkingDirForMode: agent mode behaves like resolveWorkingDir (HOME default)", () => {
  assert.equal(resolveWorkingDirForMode("agent", { HOME: "/home/u" }, "/tmp", "/cwd"), "/home/u");
});

test("resolveWorkingDirForMode: agent mode honours explicit CLAUDE_WORKING_DIR", () => {
  const env = { CLAUDE_WORKING_DIR: "/work", HOME: "/home/u" };
  assert.equal(resolveWorkingDirForMode("agent", env, "/tmp", "/cwd"), "/work");
});

test("resolveWorkingDirForMode: llm mode ignores empty CLAUDE_WORKING_DIR, falls to temp dir", () => {
  const dir = resolveWorkingDirForMode("llm", { CLAUDE_WORKING_DIR: "   ", HOME: "/home/u" }, "/tmp", "/cwd");
  assert.equal(dir, join("/tmp", LLM_WORKDIR_NAME));
});

// ── llmHardeningArgs ───────────────────────────────────────────────

test("llmHardeningArgs: tools off, strict mcp, denies LSP, excludes setting sources", () => {
  assert.deepEqual(llmHardeningArgs(), ["--tools", "", "--strict-mcp-config", "--disallowedTools", "LSP", "--setting-sources", ""]);
});

test("llmHardeningArgs: disabling the built-in set is the first thing it does", () => {
  const args = llmHardeningArgs();
  assert.equal(args[0], "--tools");
  assert.equal(args[1], ""); // "" = disable all built-in tools
});

test("llmHardeningArgs: denies every name in LLM_DISALLOWED_TOOLS", () => {
  const args = llmHardeningArgs();
  const i = args.indexOf("--disallowedTools");
  assert.ok(i >= 0);
  assert.deepEqual(args.slice(i + 1, i + 1 + LLM_DISALLOWED_TOOLS.length), LLM_DISALLOWED_TOOLS);
});

test("llmHardeningArgs: excludes all setting sources (no host plugins/hooks/CLAUDE.md)", () => {
  const args = llmHardeningArgs();
  const i = args.indexOf("--setting-sources");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], ""); // "" = load no user/project/local settings; OAuth auth still works
});
