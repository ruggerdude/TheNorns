// Workspace update preferences: global defaults can be changed from project
// Settings and the active workspace immediately honors the resolved cadence.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("FRONT DOOR P5: tracking update interval", () => {
  let mock: MockFetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.clear();
    } catch {
      // Storage can be unavailable in the Node test process.
    }
  });
  afterEach(() => {
    mock.restore();
    vi.useRealTimers();
  });

  function resumeBody(updateIntervalSeconds: number) {
    return {
      project: {
        id: projectAlpha.id,
        name: projectAlpha.name,
        status: "active",
        aggregate_version: 1,
      },
      architecture: null,
      repositories: [],
      phases: [],
      attention: { open_decisions: 0, active_runs: 0, blocked_tasks: 0 },
      next_recommended_action: "Review open decision points",
      update_interval_seconds: updateIntervalSeconds,
    };
  }

  it("saves the global interval and polls resume at that cadence", async () => {
    seedAuth();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    let resumeCalls = 0;
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, () => {
      resumeCalls += 1;
      return { body: resumeBody(300) };
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/rules`, {
      body: { filename: "NORN.md", content: "", version: 0, updated_at: null },
    });
    mock.install();

    const { user } = await renderAppAndOpenProject(projectAlpha.name);
    const workspaceNav = screen.getByRole("navigation", { name: "Workspace sections" });
    await user.click(within(workspaceNav).getByRole("button", { name: "Settings" }));
    await screen.findByTestId("workspace-settings");
    await user.selectOptions(screen.getByLabelText("Default timing"), "60");
    await user.click(screen.getByRole("button", { name: "Save update preferences" }));
    expect(screen.getByText("Update preferences saved")).toBeVisible();

    await user.click(within(workspaceNav).getByRole("button", { name: "Overview" }));
    await screen.findByTestId("overview-dashboard");

    const callsAfterSave = resumeCalls;
    // The poll cadence now honors the just-saved 60s interval, not the
    // previous 300s one.
    await vi.advanceTimersByTimeAsync(61_000);
    await waitFor(() => expect(resumeCalls).toBeGreaterThan(callsAfterSave));
  });
});
