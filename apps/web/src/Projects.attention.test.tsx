import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProjectSummary, Projects, isActionableAttention } from "./Projects";
import { projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("Phase 5 attention-first portfolio", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();

  beforeEach(() => {
    onOpenProject.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get("/api/v2/attention", () => ({
      body: {
        generated_at: "2026-07-16T21:00:00.000Z",
        counts: {
          critical: 1,
          high: 0,
          decisions: 1,
          approvals: 0,
          blockers: 0,
          active_projects: 1,
          active_runs: 1,
        },
        items: [
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
            explanation: "Human judgment is required before retrying potentially ambiguous work.",
            recommendation: "Inspect the last commit and retry safely",
            tradeoffs: ["Retry may repeat external work"],
            impact: "The release task remains blocked.",
            resumes: "Resolution resumes the release task.",
            occurred_at: "2026-07-16T20:55:00.000Z",
            decision: {
              decision_point_id: "decision-recovery",
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
                  label: "Cancel phase",
                  impact: "Cancels every unfinished task in the phase.",
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
            health: "blocked",
            current_phase: "Release",
            completed_tasks: 3,
            total_tasks: 5,
            active_runs: 1,
            attention_count: 1,
            next_action: "Review the stalled run",
          },
        ],
      },
    }));
    mock.install();
    render(
      <Projects
        onOpenProject={onOpenProject}
        openProjects={[]}
        onUnauthorized={vi.fn()}
        onSignOut={vi.fn()}
        user={null}
        onOpenAccount={vi.fn()}
        onOpenAdmin={vi.fn()}
      />,
    );
  });

  it("classifies intervention by kind rather than severity", () => {
    expect(
      isActionableAttention({
        kind: "milestone",
        severity: "high",
      }),
    ).toBe(false);
    expect(
      isActionableAttention({
        kind: "blocker",
        severity: "low",
      }),
    ).toBe(true);
  });

  afterEach(() => mock.restore());

  it("summarizes attention cleanly and opens the affected project", async () => {
    const overview = await screen.findByRole("region", { name: "Portfolio overview" });
    expect(overview).toHaveTextContent("1Need attention");
    expect(screen.queryByText("Retry the stalled release run?")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: `Enter ${projectAlpha.name}` }));
    expect(onOpenProject).toHaveBeenCalledWith({
      ...projectAlpha,
      focus_phase_id: "phase-release",
      focus_task_id: "task-release",
    });
  });

  it("keeps recovery decisions inside the project instead of crowding the landing page", async () => {
    await screen.findByRole("region", { name: "Portfolio overview" });
    expect(screen.queryByLabelText("Decision rationale")).not.toBeInTheDocument();
    expect(screen.getByText("1 decision")).toBeVisible();
  });
});
