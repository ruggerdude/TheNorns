// FRONT DOOR P1 (dashboard): each project row lists one line per phase, with
// a compact per-phase button at the row's right end. A blocked phase reads
// "Answer →" (it needs a human decision); every other phase reads "Open →".
// Both route into the project workspace pre-focused on that exact phase
// (focus_phase_id), which is the human-approved addition to this phase's
// brief — this suite is its required routing test.
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
    update_interval_seconds: 300,
  };
}

describe("dashboard per-phase lines", () => {
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
        onCloseProject={vi.fn()}
        onUnauthorized={vi.fn()}
        onSignOut={vi.fn()}
        user={null}
        onOpenAccount={vi.fn()}
        onOpenAdmin={vi.fn()}
      />,
    );
  }

  it("renders one line per phase with percent, ETA, and the blocked phase reading 'needs you'", async () => {
    setup();
    const rows = await screen.findAllByTestId("pr-phase");
    expect(rows).toHaveLength(2);

    const schemaRow = rows.find((row) => within(row).queryByText(/schema & ingest/i));
    expect(schemaRow).toBeDefined();
    expect(within(schemaRow as HTMLElement).getByText("78%")).toBeInTheDocument();
    expect(within(schemaRow as HTMLElement).getByText(/~/)).toBeInTheDocument();

    const blockedRow = rows.find((row) => within(row).queryByText(/reconciliation/i));
    expect(blockedRow).toBeDefined();
    expect(blockedRow).toHaveClass("blocked");
    expect(within(blockedRow as HTMLElement).getByText(/blocked — needs you/i)).toBeInTheDocument();

    // Overall row color-codes red because a decision is waiting / a phase is
    // blocked, per the P1 dashboard spec.
    const row = await screen.findByTestId("proj-row");
    expect(row).toHaveClass("s-red");
  });

  it("routes 'Open →' on a normal phase to that exact phase", async () => {
    setup();
    const rows = await screen.findAllByTestId("pr-phase");
    const schemaRow = rows.find((row) =>
      within(row).queryByText(/schema & ingest/i),
    ) as HTMLElement;
    const openButton = within(schemaRow).getByRole("button", { name: /open →/i });
    expect(openButton).toHaveTextContent(/open →/i);

    await userEvent.click(openButton);
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(onOpenProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: project.id, focus_phase_id: "phase-schema" }),
    );
  });

  it("routes 'Answer →' on the blocked phase to that exact phase, distinct from the normal phase's button", async () => {
    setup();
    const rows = await screen.findAllByTestId("pr-phase");
    const blockedRow = rows.find((row) =>
      within(row).queryByText(/reconciliation/i),
    ) as HTMLElement;
    const answerButton = within(blockedRow).getByRole("button", { name: /answer →/i });
    expect(answerButton).toHaveTextContent(/answer →/i);

    await userEvent.click(answerButton);
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(onOpenProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: project.id, focus_phase_id: "phase-reconciliation" }),
    );

    // Never routed to the other (non-blocked) phase.
    expect(onOpenProject).not.toHaveBeenCalledWith(
      expect.objectContaining({ focus_phase_id: "phase-schema" }),
    );
  });

  it("clicking a phase button does not also trigger the row's own 'open workspace' navigation", async () => {
    setup();
    const rows = await screen.findAllByTestId("pr-phase");
    const schemaRow = rows.find((row) =>
      within(row).queryByText(/schema & ingest/i),
    ) as HTMLElement;
    await userEvent.click(within(schemaRow).getByRole("button", { name: /open →/i }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    // Exactly one call — the phase button's click does not bubble into a
    // second, row-level "open workspace" handler.
    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });
});
