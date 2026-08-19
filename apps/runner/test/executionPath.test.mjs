import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";
import { executionPath } from "../dist/executionPath.js";

test("prepends the running node's directory and appends toolchain locations", () => {
  const path = executionPath("/usr/bin:/bin");
  const entries = path.split(":");
  assert.equal(entries[0], dirname(process.execPath));
  assert.ok(entries.includes("/usr/bin"));
  assert.ok(entries.includes("/opt/homebrew/bin"));
  assert.ok(entries.includes("/usr/local/bin"));
});

test("deduplicates and tolerates a missing base PATH", () => {
  const path = executionPath(undefined);
  const entries = path.split(":");
  assert.equal(new Set(entries).size, entries.length);
  assert.ok(!entries.includes(""));
});
