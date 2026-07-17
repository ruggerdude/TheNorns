import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProjectSummary, Projects } from "./Projects";
import { projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("Phase 5 attention-first portfolio", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();
  let resolved = false;
  let failFirstResolution = false;
  let resolutionAttempts = 0;

  beforeEach(() => {
    resolved = false;
    failFirstResolution = false;
    resolutionAttempts = 0;
    onOpenProject.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get("/api/v2/attention", () => ({
      body: {
        generated_at: "2026-07-16T21:00:00.000Z",
        counts: {
          critical: resolved ? 0 : 1,
          high: 0,
          decisions: resolved ? 0 : 1,
          approvals: 0,
          blockers: 0,
          active_projects: 1,
          active_runs: 1,
        },
        items: resolved
          ? []
          : [
              {
                key: "attention:proj_alpha:decision_point:decision-1:stuck_run",
                project_id: projectAlpha.id,
                project_name: projectAlpha.name,
                condition_fingerprint: "a".repeat(64),
                phase_id: "phase-release",
                task_id: "task-release",
                source_type: "decision_point",
                source_id: "decision-1",
                kind: "decision",
                severity: "critical",
                title: "Retry the stalled release run?",
                summary: "The run stopped producing events.",
                explanation:
                  "Human judgment is required before retrying potentially ambiguous work.",
                recommendation: "Inspect the last commit and retry safely",
                tradeoffs: ["Retry may repeat external work"],
                impact: "The release task remains blocked.",
                resumes: "Resolution resumes the release task.",
                occurred_at: "2026-07-16T20:55:00.000Z",
                decision: {
                  decision_point_id: "decision-1",
                  condition_fingerprint: "b".repeat(64),
                  recommendation_option_id: "retry",
                  options: [
                    {
                      id: "retry",
                      label: "Retry safely",
                      impact: "Creates a new designated run.",
                      risk: "May repeat ambiguous work.",
                    },
                    {
                      id: "cancel",
                      label: "Cancel task",
                      impact: "Leaves the release incomplete.",
                      risk: "Blocks dependent work.",
                    },
                  ],
                },
              },
            ],
        projects: [
          {
            id: projectAlpha.id,
            name: projectAlpha.name,
            health: resolved ? "healthy" : "blocked",
            current_phase: "Release",
            completed_tasks: 3,
            total_tasks: 5,
            active_runs: 1,
            attention_count: resolved ? 0 : 1,
            next_action: "Review the stalled run",
          },
        ],
      },
    }));
    mock.post(`/api/v2/projects/${projectAlpha.id}/decision-points/decision-1/resolve`, () => {
      resolutionAttempts += 1;
      if (failFirstResolution && resolutionAttempts === 1) {
        return { status: 503, body: { message: "Response was lost" } };
      }
      resolved = true;
      return { body: {} };
    });
    mock.install();
    render(
      <Projects
        onOpenProject={onOpenProject}
        openProjects={[]}
        onCloseProject={vi.fn()}
        onUnauthorized={vi.fn()}
        onSignOut={vi.fn()}
        user={null}
        onOpenAccount={vi.fn()}
        onOpenAdmin={vi.fn()}
      />,
    );
  });

  afterEach(() => mock.restore());

  it("leads with strategic attention and opens the affected project", async () => {
    expect(
      await screen.findByRole("heading", { name: "What needs your attention?" }),
    ).toBeVisible();
    expect(screen.getByText("Retry the stalled release run?")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open project" }));
    expect(onOpenProject).toHaveBeenCalledWith({
      ...projectAlpha,
      focus_phase_id: "phase-release",
      focus_task_id: "task-release",
    });
  });

  it("resolves a decision with its exact fingerprint, rationale, and subsequent direction", async () => {
    await screen.findByText("Retry the stalled release run?");
    expect(screen.queryByRole("button", { name: "Acknowledge" })).not.toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeVisible();
    await userEvent.type(
      screen.getByLabelText("Decision rationale"),
      "The last commit is safe and the external action is idempotent.",
    );
    await userEvent.selectOptions(screen.getByLabelText("Direct subsequent work to"), "all_agents");
    await userEvent.type(
      screen.getByLabelText("Optional direction for subsequent work"),
      "Re-run verification before integration.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Resolve decision" }));
    await waitFor(() => expect(screen.queryByText("Retry the stalled release run?")).toBeNull());
    expect(
      mock.calls.find(
        (call) =>
          call.url === `/api/v2/projects/${projectAlpha.id}/decision-points/decision-1/resolve`,
      ),
    ).toMatchObject({
      body: {
        expected_condition_fingerprint: "b".repeat(64),
        selected_option_id: "retry",
        rationale: "The last commit is safe and the external action is idempotent.",
        direction_target: "all_agents",
        direction_text: "Re-run verification before integration.",
        idempotency_key: expect.stringMatching(/^decision-decision-1-/),
      },
    });
  });

  it("reuses the decision idempotency key when a failed response is retried", async () => {
    failFirstResolution = true;
    await screen.findByText("Retry the stalled release run?");
    await userEvent.type(
      screen.getByLabelText("Decision rationale"),
      "The retry is safe after inspecting the existing commit.",
    );

    await userEvent.click(screen.getByRole("button", { name: "Resolve decision" }));
    expect(await screen.findByText("Response was lost")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Resolve decision" }));
    await waitFor(() => expect(screen.queryByText("Retry the stalled release run?")).toBeNull());

    const resolutionCalls = mock.calls.filter(
      (call) =>
        call.url === `/api/v2/projects/${projectAlpha.id}/decision-points/decision-1/resolve`,
    );
    expect(resolutionCalls).toHaveLength(2);
    expect(resolutionCalls[0]?.body).toMatchObject({
      idempotency_key: expect.stringMatching(/^decision-decision-1-/),
    });
    expect(resolutionCalls[1]?.body).toMatchObject({
      idempotency_key: (resolutionCalls[0]?.body as { idempotency_key: string }).idempotency_key,
    });
  });
});
