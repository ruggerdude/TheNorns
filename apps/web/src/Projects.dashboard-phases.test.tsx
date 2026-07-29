import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProjectSummary, Projects } from "./Projects";
import { makeProject } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

const project = makeProject({
  id: "proj_atlas",
  name: "Atlas billing rewrite",
  description: "Migrate metered billing onto the usage ledger.",
  status: "planned",
});

function resumeBody() {
  return {
    schema_version: 2,
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      status: "active",
      aggregate_version: 4,
    },
    architecture: null,
    repositories: [],
    phases: [
      {
        id: "phase-schema",
        objective_summary: "Schema & ingest",
        priority: 2,
        status: "active",
        percent_complete: 78,
        tasks_completed: 7,
        tasks_total: 9,
        eta_at: "2099-07-20T18:00:00.000Z",
        burn_rate_usd_per_hour: 3.1,
      },
      {
        id: "phase-reconciliation",
        objective_summary: "Reconciliation",
        priority: 1,
        status: "blocked",
        percent_complete: 0,
        tasks_completed: 0,
        tasks_total: 4,
        eta_at: null,
        burn_rate_usd_per_hour: null,
      },
    ],
    attention: { open_decisions: 1, active_runs: 2, blocked_tasks: 1 },
    active_memory_entries: 0,
    recent_completions: [],
    next_recommended_action: "Review open decision points",
    progress: {
      overall_percent_complete: 47,
      blended_eta_at: "2026-07-27T16:00:00.000Z",
      agents_active: 2,
      decisions_waiting: 1,
    },
    delivery: {
      total_commits: 14,
      last_commit_sha: "abc123def456",
      last_commit_at: "2026-07-27T15:45:00.000Z",
    },
    update_interval_seconds: 300,
  };
}

describe("project cards on the Portfolio", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();

  afterEach(() => mock.restore());

  function setup() {
    onOpenProject.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [project] });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get(`/api/v2/projects/${project.id}/resume`, { body: resumeBody() });
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
  }

  it("shows the compact project dashboard horizontally and omits the phase plan", async () => {
    setup();
    const row = await screen.findByTestId("proj-row");
    const dashboard = within(row).getByLabelText(`${project.name} dashboard`);
    await waitFor(() => expect(within(dashboard).getByText("47%")).toBeVisible());
    expect(within(dashboard).getByText("Overall complete")).toBeVisible();
    expect(within(dashboard).getByText("Active agents")).toBeVisible();
    expect(within(dashboard).getByText("Decisions")).toBeVisible();
    expect(within(dashboard).getByText("Blended ETA")).toBeVisible();
    expect(within(dashboard).getByText("Total commits")).toBeVisible();
    expect(within(dashboard).getByText("14")).toBeVisible();
    expect(within(dashboard).getByText("Last commit")).toBeVisible();
    expect(within(dashboard).getByText("abc123de")).toBeVisible();
    expect(screen.queryByTestId("pr-phase")).not.toBeInTheDocument();
    expect(screen.queryByText("Schema & ingest")).not.toBeInTheDocument();
    expect(row).toHaveClass("s-red");
  });

  it("opens the Overview workspace from anywhere on the project card", async () => {
    setup();
    await userEvent.click(await screen.findByRole("link", { name: `Enter ${project.name}` }));
    expect(onOpenProject).toHaveBeenCalledWith(project);
    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });
});
