import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProjectSummary, Projects } from "./Projects";
import { projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("Phase 5 attention-first portfolio", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();
  let acknowledged = false;

  beforeEach(() => {
    acknowledged = false;
    onOpenProject.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get("/api/v2/attention", () => ({
      body: {
        generated_at: "2026-07-16T21:00:00.000Z",
        counts: {
          critical: acknowledged ? 0 : 1,
          high: 0,
          decisions: acknowledged ? 0 : 1,
          approvals: 0,
          blockers: 0,
          active_projects: 1,
          active_runs: 1,
        },
        items: acknowledged
          ? []
          : [
              {
                key: "attention:proj_alpha:decision_point:decision-1:stuck_run",
                project_id: projectAlpha.id,
                project_name: projectAlpha.name,
                condition_fingerprint: "a".repeat(64),
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
              },
            ],
        projects: [
          {
            id: projectAlpha.id,
            name: projectAlpha.name,
            health: acknowledged ? "healthy" : "blocked",
            current_phase: "Release",
            completed_tasks: 3,
            total_tasks: 5,
            active_runs: 1,
            attention_count: acknowledged ? 0 : 1,
            next_action: "Review the stalled run",
          },
        ],
      },
    }));
    mock.post("/api/v2/attention/disposition", () => {
      acknowledged = true;
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
    expect(onOpenProject).toHaveBeenCalledWith(projectAlpha);
  });

  it("acknowledges the exact fingerprint and removes the unchanged item", async () => {
    await screen.findByText("Retry the stalled release run?");
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(screen.queryByText("Retry the stalled release run?")).toBeNull());
    expect(mock.calls.find((call) => call.url === "/api/v2/attention/disposition")).toMatchObject({
      body: {
        condition_fingerprint: "a".repeat(64),
        disposition: "acknowledged",
      },
    });
  });
});
