import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunnerStateFile } from "../dist/state.js";

/** Seed a runner-state.json with a given executed map, then load it. */
function stateWithExecuted(executed) {
  const dir = mkdtempSync(join(tmpdir(), "norns-reap-"));
  writeFileSync(
    join(dir, "runner-state.json"),
    JSON.stringify({
      runner_id: "runner-1",
      private_key_pem: "",
      generation: 1,
      seq: 10,
      buffer: [],
      executed,
      terminal_acks: {},
    }),
  );
  return new RunnerStateFile(dir, { runner_id: "runner-1", private_key_pem: "", generation: 1 });
}

test("orphanedExecutingIds reaps only stuck 'executing' entries with no live owner", () => {
  const state = stateWithExecuted({
    "cmd:orphan": "executing", // process died mid-run -> orphaned
    "cmd:live": "executing", // still running in this process
    "cmd:done": "succeeded", // terminal, never reaped
    "cmd:refused": "rejected", // terminal, never reaped
  });
  const live = new Set(["cmd:live"]);
  assert.deepEqual(state.orphanedExecutingIds(live), ["cmd:orphan"]);
});

test("a fresh process (no live runs) reaps every stuck 'executing' entry", () => {
  const state = stateWithExecuted({
    "cmd:a": "executing",
    "cmd:b": "executing",
    "cmd:ok": "succeeded",
  });
  assert.deepEqual(state.orphanedExecutingIds(new Set()).sort(), ["cmd:a", "cmd:b"]);
});

test("nothing to reap when the durable map holds only terminal entries", () => {
  const state = stateWithExecuted({ "cmd:ok": "succeeded", "cmd:no": "failed" });
  assert.deepEqual(state.orphanedExecutingIds(new Set()), []);
});
