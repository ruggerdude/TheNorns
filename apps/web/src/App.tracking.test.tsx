// FRONT DOOR P5 (tracking): the workspace's update-interval control PATCHes
// GET/PATCH /api/v2/projects/:id/settings, and the resume poll cadence
// honors whatever interval the resume response reports.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("FRONT DOOR P5: tracking update interval", () => {
  let mock: MockFetch;

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
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

  it("PATCHes the chosen interval and polls resume at that cadence", async () => {
    seedAuth();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    let interval = 300;
    let resumeCalls = 0;
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, () => {
      resumeCalls += 1;
      return { body: resumeBody(interval) };
    });
    mock.patch(`/api/v2/projects/${projectAlpha.id}/settings`, (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { update_interval_seconds: number };
      interval = body.update_interval_seconds;
      return { body: { update_interval_seconds: interval } };
    });
    mock.install();

    const { user } = await renderAppAndOpenProject(projectAlpha.name);
    // FRONT DOOR P1b: the Tracking section now opens by default (it also
    // hosts the Gantt).
    await screen.findByTestId("tracking-settings");
    await user.click(screen.getByRole("button", { name: "1m" }));

    await waitFor(() =>
      expect(
        mock.calls.find(
          (call) =>
            call.method === "PATCH" && call.url === `/api/v2/projects/${projectAlpha.id}/settings`,
        ),
      ).toMatchObject({ body: { update_interval_seconds: 60 } }),
    );

    const callsAfterPatch = resumeCalls;
    // The poll cadence now honors the just-saved 60s interval, not the
    // previous 300s one.
    await vi.advanceTimersByTimeAsync(61_000);
    await waitFor(() => expect(resumeCalls).toBeGreaterThan(callsAfterPatch));
  });
});
