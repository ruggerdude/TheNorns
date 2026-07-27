import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type HelperRunnerSnapshot, helperStatus } from "../src/runners/helperOnboarding.js";

const installerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/install-runner.sh",
);

function runner(overrides: Partial<HelperRunnerSnapshot> = {}): HelperRunnerSnapshot {
  return {
    runner_id: "runner-1",
    generation: 1,
    connected: true,
    workspace_picker_ready: true,
    workspace_repository_inventory_ready: true,
    workspace_clone_ready: true,
    last_seen_at: "2026-07-27T18:00:00.000Z",
    ...overrides,
  };
}

describe("local helper capability status", () => {
  it("accepts a helper that supports the current repository inventory", () => {
    expect(helperStatus([runner()])).toMatchObject({
      state: "connected",
      runner_id: "runner-1",
    });
  });

  it("requires an update when a legacy picker cannot catalog or inspect repositories", () => {
    expect(helperStatus([runner({ workspace_repository_inventory_ready: false })])).toMatchObject({
      state: "degraded",
      runner_id: "runner-1",
      message: expect.stringMatching(/out of date/i),
    });
  });

  it("prefers a clone-capable helper when more than one helper is connected", () => {
    expect(
      helperStatus([
        runner({ runner_id: "legacy-helper", workspace_clone_ready: false }),
        runner({ runner_id: "current-helper" }),
      ]),
    ).toMatchObject({
      state: "connected",
      runner_id: "current-helper",
      workspace_clone_ready: true,
    });
  });
});

describe("local helper installer", () => {
  it("runs the shipped Node version check as valid JavaScript", () => {
    const versionCheck = `[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 24 ]`;
    expect(readFileSync(installerPath, "utf8")).toContain(versionCheck);
    expect(() => execFileSync("sh", ["-c", versionCheck])).not.toThrow();
  });
});
