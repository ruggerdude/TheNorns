import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
            implementation_agent: {
              profile_id: "agent-codex-sol",
              provider: "openai",
              model: "gpt-5-codex",
              roles: ["implementation"],
            },
            reviewer_agent: {
              profile_id: "agent-claude-fable",
              provider: "anthropic",
              model: "claude-fable-5",
              roles: ["independent_review", "quality_control"],
            },
            run: {
              id: "run-2",
              state: "verifying",
              attempt: 1,
              verification_status: "pending",
              commit_sha: "abcdef1234567890",
              failure_detail: null,
            },
            evidence_count: 2,
            reviews: [
              {
                id: "review-1",
                run_id: "run-2",
                review_round: 1,
                decision: "rework",
                summary: "The rollback verification is incomplete. Add a production-safe drill.",
                evidence: [
                  {
                    artifact_id: "artifact-1",
                    content_hash: "b".repeat(64),
                    media_type: "text/plain",
                    label: "Verification log",
                  },
                ],
                reviewer: {
                  profile_id: "agent-claude-fable",
                  provider: "anthropic",
                  model: "claude-fable-5",
                  roles: ["independent_review"],
                },
                created_at: "2026-07-17T12:00:00.000Z",
              },
            ],
          },
        ],
      },
    });
    mock.post(`/api/v2/projects/${projectAlpha.id}/directions`, { body: {} });
    mock.install();

    await renderAppAndOpenProject(projectAlpha.name, { workspaceTab: "Work" });
    expect(await screen.findByRole("heading", { name: "Release safely" })).toBeVisible();
    expect(screen.getByText("Verify production release")).toBeVisible();
    expect(screen.getByRole("region", { name: "Implementation Agent" })).toHaveTextContent(
      /gpt-5-codex.*agent-codex-sol.*active/i,
    );
    expect(screen.getByRole("region", { name: "Independent QC Reviewer" })).toHaveTextContent(
      /claude-fable-5.*agent-claude-fable/i,
    );
    expect(screen.getByText(/Verification: pending/i)).toBeVisible();
    expect(screen.getByText("2 evidence")).toBeVisible();
    expect(screen.getByText(/rollback verification is incomplete/i)).toBeVisible();
    expect(screen.getByText(/Verification log · text\/plain · b{12}/i)).toBeVisible();

    await userEvent.selectOptions(screen.getByLabelText("Send to"), "reviewer");
    await userEvent.type(
      screen.getByLabelText("Direction"),
      "Verify the recovery drill before the next review round.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Record direction" }));
    await waitFor(() =>
      expect(
        mock.calls.find((call) => call.url === `/api/v2/projects/${projectAlpha.id}/directions`),
      ).toMatchObject({
        body: {
          phase_id: "phase-1",
          task_id: "task-2",
          direction_target: "reviewer",
          direction_text: "Verify the recovery drill before the next review round.",
        },
      }),
    );
    expect(
      screen.getByText(/^Direction recorded in project memory\. Agent delivery is pending\.$/i),
    ).toBeVisible();
  });

  it("replaces a stale failed task card with the newly designated recovery attempt", async () => {
    seedAuth();
    let recovered = false;
    const decisionPointId = "decision:failed_run:run-2";
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get("/api/v2/attention", () => ({
      body: {
        generated_at: "2026-07-25T20:00:00.000Z",
        counts: {
          critical: 0,
          high: recovered ? 0 : 1,
          decisions: recovered ? 0 : 1,
          approvals: 0,
          blockers: 0,
          active_projects: 1,
          active_runs: recovered ? 1 : 0,
        },
        items: recovered
          ? []
          : [
              {
                key: "attention:project-1:decision:run-2",
                project_id: projectAlpha.id,
                project_name: projectAlpha.name,
                condition_fingerprint: "a".repeat(64),
                phase_id: "phase-1",
                task_id: "task-1",
                source_type: "decision_point",
                source_id: decisionPointId,
                kind: "decision",
                severity: "high",
                title: "Recover the failed run",
                summary: "Run 2 failed and needs a fresh fenced attempt.",
                explanation: "The designated execution attempt stopped.",
                recommendation: "Retry safely",
                tradeoffs: ["Retry uses additional budget."],
                impact: "The task cannot advance.",
                resumes: "A new designated run resumes execution.",
                occurred_at: "2026-07-25T19:59:00.000Z",
                decision: {
                  decision_point_id: decisionPointId,
                  condition_fingerprint: "b".repeat(64),
                  recommendation_option_id: "retry",
                  options: [
                    {
                      id: "retry",
                      label: "Retry safely",
                      impact: "Creates a new designated run.",
                      risk: "May repeat work.",
                    },
                    {
                      id: "cancel",
                      label: "Cancel phase",
                      impact: "Stops unfinished work.",
                      risk: "Leaves the task incomplete.",
                    },
                  ],
                },
              },
            ],
        projects: [],
      },
    }));
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
            objective_summary: "Correct the README heading",
            status: "active",
            tasks: 1,
            completed_tasks: 0,
            blocked_tasks: recovered ? 0 : 1,
          },
        ],
        attention: {
          open_decisions: recovered ? 0 : 1,
          active_runs: recovered ? 1 : 0,
          blocked_tasks: recovered ? 0 : 1,
        },
        next_recommended_action: recovered ? "Monitor the recovery attempt" : "Recover run 2",
      },
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-1/execution`, () => ({
      body: {
        phase: {
          id: "phase-1",
          objective_summary: "Correct the README heading",
          status: "active",
          planning_mode: "quick",
          completed_tasks: 0,
          total_tasks: 1,
        },
        tasks: [
          {
            id: "task-1",
            title: "Correct the README heading",
            state: recovered ? "in_progress" : "failed",
            complexity: "S",
            risk: "low",
            dependencies: [],
            assignment: { provider: "anthropic", model: "claude-sonnet-5", status: "active" },
            implementation_agent: {
              profile_id: "agent-claude",
              provider: "anthropic",
              model: "claude-sonnet-5",
              roles: ["implementation"],
            },
            reviewer_agent: null,
            run: {
              id: recovered ? "run-3" : "run-2",
              state: recovered ? "running" : "failed",
              attempt: recovered ? 3 : 2,
              verification_status: "pending",
              commit_sha: null,
              failure_detail: recovered ? null : "The previous attempt failed.",
            },
            evidence_count: 0,
            reviews: [],
          },
        ],
      },
    }));
    mock.get(
      new RegExp(
        `^/api/v2/projects/${projectAlpha.id}/phases/phase-1/tasks/task-1/run-log(?:\\?.*)?$`,
      ),
      { body: { run_id: recovered ? "run-3" : "run-2", entries: [], truncated: false } },
    );
    mock.post(
      `/api/v2/projects/${projectAlpha.id}/decision-points/${encodeURIComponent(decisionPointId)}/resolve`,
      () => {
        recovered = true;
        return { body: {} };
      },
    );
    mock.install();

    const { user } = await renderAppAndOpenProject(projectAlpha.name, { workspaceTab: "Work" });
    expect(await screen.findByText("Run 2: failed")).toBeVisible();
    expect(await screen.findByTestId("phase-needs-you")).toBeVisible();
    await user.type(
      screen.getByLabelText("Decision rationale"),
      "The previous attempt is safely fenced.",
    );
    await user.click(screen.getByRole("button", { name: "Retry safely" }));

    expect(await screen.findByText("Run 3: running")).toBeVisible();
    expect(screen.queryByText("Run 2: failed")).not.toBeInTheDocument();
  });
});
