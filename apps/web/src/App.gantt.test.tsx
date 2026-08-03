// The project overview intentionally omits detailed schedule visualization;
// phase work and its gates belong in the dedicated work surfaces.
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("FRONT DOOR P1b: workspace Gantt wiring", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("keeps the detailed Gantt off the compact project overview", async () => {
    seedAuth();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, {
      body: {
        project: {
          id: projectAlpha.id,
          name: projectAlpha.name,
          status: "active",
          aggregate_version: 3,
        },
        architecture: null,
        repositories: [],
        phases: [
          {
            id: "phase-schema",
            objective_summary: "Schema & ingest",
            status: "active",
            tasks: 9,
            completed_tasks: 7,
            blocked_tasks: 0,
            percent_complete: 78,
            eta_at: "2099-07-20T18:00:00.000Z",
          },
          {
            id: "phase-reconciliation",
            objective_summary: "Reconciliation",
            status: "active",
            tasks: 4,
            completed_tasks: 0,
            blocked_tasks: 1,
            percent_complete: 0,
            eta_at: null,
          },
        ],
        attention: { open_decisions: 1, active_runs: 2, blocked_tasks: 1 },
        next_recommended_action: "Review open decision points",
        update_interval_seconds: 300,
      },
    });
    mock.get("/api/v2/attention", {
      body: {
        generated_at: "2026-07-20T21:00:00.000Z",
        counts: {
          critical: 1,
          high: 0,
          decisions: 1,
          approvals: 0,
          blockers: 0,
          active_projects: 1,
          active_runs: 2,
        },
        items: [
          {
            key: "attention:proj_alpha:decision_point:decision-1",
            project_id: projectAlpha.id,
            project_name: projectAlpha.name,
            condition_fingerprint: "a".repeat(64),
            phase_id: "phase-reconciliation",
            kind: "decision",
            severity: "critical",
            title: "Confirm the reconciliation window: 24h or 72h?",
            summary: "Phase 4 can't start until this is set.",
            explanation: "Human judgment required.",
            recommendation: "Pick 24h.",
            tradeoffs: [],
            impact: "Blocks the phase.",
            resumes: "Resolution unblocks it.",
            occurred_at: "2026-07-20T20:55:00.000Z",
          },
        ],
        projects: [],
      },
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-schema/execution`, {
      body: {
        phase: {
          id: "phase-schema",
          objective_summary: "Schema & ingest",
          status: "active",
          completed_tasks: 7,
          total_tasks: 9,
        },
        tasks: [
          {
            id: "task-1",
            title: "Ingest schema",
            state: "in_progress",
            complexity: "M",
            risk: "medium",
            dependencies: [],
            assignment: null,
            implementation_agent: {
              profile_id: "agent-1",
              provider: "anthropic",
              model: "claude-sonnet-5",
              roles: ["implementation"],
            },
            reviewer_agent: {
              profile_id: "agent-2",
              provider: "openai",
              model: "gpt-5.6-terra",
              roles: ["independent_review"],
            },
            run: null,
            evidence_count: 0,
            reviews: [],
          },
        ],
      },
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-reconciliation/execution`, {
      body: {
        phase: {
          id: "phase-reconciliation",
          objective_summary: "Reconciliation",
          status: "active",
          completed_tasks: 0,
          total_tasks: 4,
        },
        tasks: [],
      },
    });
    mock.install();

    await renderAppAndOpenProject(projectAlpha.name);
    expect(await screen.findByTestId("overview-dashboard")).toBeVisible();
    expect(screen.queryByTestId("workspace-mini-gantt")).not.toBeInTheDocument();
    expect(screen.queryByTestId("project-timeline")).not.toBeInTheDocument();
  });
});
