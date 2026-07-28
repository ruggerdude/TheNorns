import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProjectSummary, Projects } from "./Projects";
import { makeProject } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

function renderProjects(): void {
  render(
    <Projects
      onOpenProject={vi.fn()}
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

describe("portfolio truthfulness", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("does not render Ready while a high-severity failed run is visible", async () => {
    const project = makeProject({
      id: "project-failed",
      name: "Failed delivery",
      status: "planned",
    });
    mock = new MockFetch();
    mock.get("/api/projects", { body: [project] });
    mock.get(`/api/v2/projects/${project.id}/resume`, {
      body: {
        phases: [
          {
            id: "phase-failed",
            objective_summary: "Visual polish",
            status: "active",
            tasks: 1,
            completed_tasks: 0,
            blocked_tasks: 0,
          },
        ],
        progress: {
          overall_percent_complete: 0,
          blended_eta_at: null,
          agents_active: 0,
          decisions_waiting: 0,
        },
        attention: { open_decisions: 0, active_runs: 0, blocked_tasks: 0 },
      },
    });
    mock.get("/api/runners", { body: [] });
    mock.get("/api/v2/attention", {
      body: {
        generated_at: "2026-07-25T17:00:00.000Z",
        counts: {
          critical: 0,
          high: 1,
          decisions: 0,
          approvals: 0,
          blockers: 0,
          active_projects: 1,
          active_runs: 0,
        },
        items: [
          {
            key: "failed-run",
            project_id: project.id,
            project_name: project.name,
            condition_fingerprint: "a".repeat(64),
            kind: "failed_run",
            severity: "high",
            title: "Run failed",
            summary: "The visual change did not complete.",
            explanation: "The runner reported a failure.",
            recommendation: "Inspect diagnostics and retry.",
            tradeoffs: [],
            impact: "The phase cannot complete.",
            resumes: "A successful retry resumes the phase.",
            occurred_at: "2026-07-25T16:59:00.000Z",
            phase_id: "phase-failed",
            task_id: "task-failed",
          },
        ],
        projects: [
          {
            id: project.id,
            name: project.name,
            health: "attention",
            current_phase: "Visual polish",
            completed_tasks: 0,
            total_tasks: 1,
            active_runs: 0,
            attention_count: 1,
            next_action: "Inspect failed run",
          },
        ],
      },
    });
    mock.install();

    renderProjects();

    expect(await screen.findByText("1 item need attention")).toBeVisible();
    expect(screen.getAllByText("Needs attention").length).toBeGreaterThan(0);
    expect(screen.queryByText("No urgent interventions")).not.toBeInTheDocument();
    expect(await screen.findByTestId("proj-row")).toHaveClass("s-red");
    expect(screen.getByText("Run failed", { selector: ".badge" })).toBeVisible();
    expect(await screen.findByText("failed — review")).toBeVisible();
    // DESIGN R2: the runner fact is a tile — bare state value + label. With
    // no runner registered it truthfully reads "None", never a healthy state.
    expect(screen.getByTestId("runner-freshness")).toHaveTextContent("None");
    expect(screen.getByTestId("runner-freshness")).toHaveTextContent("Runner heartbeat");
    expect(screen.getByTestId("runner-freshness")).not.toHaveTextContent("Online");
  });

  it("shows a failed quick kickoff as restart-needed instead of Ready or Draft", async () => {
    const project = makeProject({
      id: "project-quick-kickoff",
      name: "Grammar fix",
      status: "draft",
    });
    mock = new MockFetch();
    mock.get("/api/projects", { body: [project] });
    mock.get(`/api/v2/projects/${project.id}/resume`, {
      body: {
        phases: [
          {
            id: "phase-quick-kickoff",
            objective_summary: "Correct the empty-state grammar",
            status: "approved",
            tasks: 1,
            completed_tasks: 0,
            blocked_tasks: 0,
          },
        ],
        progress: {
          overall_percent_complete: 0,
          blended_eta_at: null,
          agents_active: 0,
          decisions_waiting: 0,
        },
        attention: { open_decisions: 0, active_runs: 0, blocked_tasks: 0 },
      },
    });
    mock.get("/api/runners", { body: [] });
    mock.get("/api/v2/attention", {
      body: {
        generated_at: "2026-07-25T18:01:00.000Z",
        counts: {
          critical: 0,
          high: 1,
          decisions: 0,
          approvals: 0,
          blockers: 1,
          active_projects: 1,
          active_runs: 0,
        },
        items: [
          {
            key: "quick-kickoff-failure",
            project_id: project.id,
            project_name: project.name,
            condition_fingerprint: "b".repeat(64),
            source_type: "planning_run",
            source_id: "planning-run-quick-kickoff",
            condition_class: "quick_kickoff_failed",
            kind: "blocker",
            severity: "high",
            title: "Coding needs a restart",
            summary: "No runner is available for the approved workspace.",
            explanation: "The approved quick change did not start execution.",
            recommendation: "Open the Phase tab and retry coding.",
            tradeoffs: [],
            impact: "The approved phase remains pending.",
            resumes: "A successful retry dispatches the pending task.",
            occurred_at: "2026-07-25T18:00:00.000Z",
            phase_id: "phase-quick-kickoff",
            task_id: null,
          },
        ],
        projects: [
          {
            id: project.id,
            name: project.name,
            status: "active",
            health: "attention",
            current_phase: "Correct the empty-state grammar",
            completed_tasks: 0,
            total_tasks: 1,
            active_runs: 0,
            attention_count: 1,
            next_action: "Open the Phase tab and retry coding.",
          },
        ],
      },
    });
    mock.install();

    renderProjects();

    expect(await screen.findByText("1 item need attention")).toBeVisible();
    expect(screen.getByText("Coding needs a restart")).toBeVisible();
    expect(screen.getByText("Needs you")).toBeVisible();
    expect(screen.getAllByText("Needs attention").length).toBeGreaterThan(0);
    expect(
      within(screen.getByLabelText("Portfolio attention summary")).getByText("Blockers")
        .parentElement,
    ).toHaveTextContent("1");
    expect(screen.getByText("1 attention")).toBeVisible();
    expect(await screen.findByTestId("proj-row")).toHaveClass("s-red");
    expect(screen.queryByText("No urgent interventions")).not.toBeInTheDocument();
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
  });

  it("labels a local project from its binding even when the resume has a summary line", async () => {
    const project: ProjectSummary = {
      ...makeProject({ id: "project-local", name: "Local fixture", status: "planned" }),
      source_type: "local",
      source_location: "local-fixture",
    };
    mock = new MockFetch();
    mock.get("/api/projects", { body: [project] });
    mock.get("/api/runners", { body: [] });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get(`/api/v2/projects/${project.id}/resume`, {
      body: {
        phases: [],
        attention: { open_decisions: 0, active_runs: 0, blocked_tasks: 0 },
        onboarding: { summary_line: "Runs in the approved local workspace" },
      },
    });
    mock.install();

    renderProjects();

    const row = await screen.findByTestId("proj-row");
    const source = await within(row).findByTitle("Runs in the approved local workspace");
    expect(source).toHaveTextContent("Local folder");
    expect(source).not.toHaveTextContent("GitHub");
  });

  it("reports unavailable status instead of inferring healthy state when initial reads fail", async () => {
    const project = makeProject({
      id: "project-unavailable",
      name: "Unavailable project",
      status: "planned",
    });
    mock = new MockFetch();
    mock.get("/api/projects", { body: [project] });
    mock.get(`/api/v2/projects/${project.id}/resume`, {
      status: 503,
      body: { message: "resume unavailable" },
    });
    mock.get("/api/v2/attention", {
      status: 503,
      body: { message: "attention unavailable" },
    });
    mock.get("/api/runners", {
      status: 503,
      body: { message: "runner status unavailable" },
    });
    mock.install();

    renderProjects();

    expect(await screen.findByText("Status unavailable")).toBeVisible();
    expect(screen.getByText("Portfolio status is unavailable")).toBeVisible();
    expect(screen.getByTestId("portfolio-refresh-status")).toHaveTextContent(
      "Refresh issue · showing last known data",
    );
    expect(screen.queryByText("No urgent interventions")).not.toBeInTheDocument();
  });
});
