import { describe, expect, it } from "vitest";
import { type HelperRunnerSnapshot, helperStatus } from "../src/runners/helperOnboarding.js";

function runner(overrides: Partial<HelperRunnerSnapshot> = {}): HelperRunnerSnapshot {
  return {
    runner_id: "runner-1",
    generation: 1,
    connected: true,
    workspace_picker_ready: true,
    workspace_repository_inventory_ready: true,
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
});
