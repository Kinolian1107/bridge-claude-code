// Unit tests for config helpers (lib/config.mjs).
// Run: npm test (node --test)

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWorkingDir } from "../lib/config.mjs";

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
