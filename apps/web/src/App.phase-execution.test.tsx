import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("Phase 5 project execution monitoring", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("shows canonical task, assignment, run, verification, and evidence state", async () => {
    seedAuth();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, {
      body: {
        project: {
          id: projectAlpha.id,
          name: projectAlpha.name,
          status: "active",
          aggregate_version: 2,
        },
        architecture: null,
        repositories: [],
        phases: [
          {
            id: "phase-1",
            objective_summary: "Release safely",
            status: "active",
            tasks: 2,
            completed_tasks: 1,
            blocked_tasks: 0,
          },
        ],
        attention: { open_decisions: 0, active_runs: 1, blocked_tasks: 0 },
        next_recommended_action: "Monitor active agent work",
      },
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-1/execution`, {
      body: {
        phase: {
          id: "phase-1",
          objective_summary: "Release safely",
          status: "active",
          completed_tasks: 1,
          total_tasks: 2,
        },
        tasks: [
          {
            id: "task-2",
            title: "Verify production release",
            state: "verifying",
            complexity: "M",
            risk: "high",
            dependencies: ["task-1"],
            assignment: { provider: "openai", model: "gpt-5-codex", status: "active" },
            run: {
              id: "run-2",
              state: "verifying",
              attempt: 1,
              verification_status: "pending",
              commit_sha: "abcdef1234567890",
              failure_detail: null,
            },
            evidence_count: 2,
          },
        ],
      },
    });
    mock.install();

    await renderAppAndOpenProject(projectAlpha.name);
    expect(await screen.findByRole("heading", { name: "Release safely" })).toBeVisible();
    expect(screen.getByText("Verify production release")).toBeVisible();
    expect(screen.getByText(/gpt-5-codex · active/i)).toBeVisible();
    expect(screen.getByText(/Verification: pending/i)).toBeVisible();
    expect(screen.getByText("2 evidence")).toBeVisible();
  });
});
