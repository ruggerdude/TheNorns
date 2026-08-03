import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PhaseTab } from "./PhaseTab";
import type { PhasePlanningRunDto } from "./phaseTabApi";
import { MockFetch } from "./test/mockFetch";
import { preloadConversationWorkspaceForTest } from "./test/preloadConversationWorkspace";

const projectId = "project-visual";
const runUrl = `/api/v2/projects/${projectId}/planning-runs/run-visual`;

function makeRun(overrides: Partial<PhasePlanningRunDto> = {}): PhasePlanningRunDto {
  return {
    id: "run-visual",
    status: "reviewing",
    round: 2,
    max_rounds: 3,
    review_rounds_total: 3,
    rounds_completed: 1,
    worker_providers: "both",
    decision: null,
    transcript: [],
    result: null,
    error: null,
    execution: null,
    ...overrides,
  };
}

const readyRun = makeRun({
  status: "converged",
  rounds_completed: 3,
  result: {
    plan: {
      modules: [
        {
          id: "foundation",
          title: "Repository foundation",
          description: "Prepare the existing architecture for the requested work.",
        },
      ],
    },
    content_hash: "f".repeat(64),
    total_cost_usd: 0.84,
    staffing_proposal: {
      summary: "One focused implementation phase.",
      recommendations: [
        {
          node_id: "foundation",
          provider: "anthropic",
          model: "claude-sonnet-5",
          worker_count: 1,
        },
      ],
    },
  },
});

describe("existing-project planning journey visual contract", () => {
  let mock: MockFetch;

  beforeAll(preloadConversationWorkspaceForTest);
  afterEach(() => mock.restore());

  it("shows one three-step journey and keeps staffing secondary when the plan is ready", async () => {
    mock = new MockFetch();
    mock.get(runUrl, { body: readyRun });
    mock.install();

    render(<PhaseTab projectId={projectId} initialRunId="run-visual" onUnauthorized={vi.fn()} />);

    expect(
      await screen.findByRole("heading", { name: "Your implementation plan is ready" }),
    ).toBeInTheDocument();

    const journey = screen.getByTestId("phase-journey");
    expect(within(journey).getAllByRole("listitem")).toHaveLength(3);
    expect(within(journey).getByText("Planning").closest("li")).toHaveClass("is-complete");
    expect(within(journey).getByText("Plan ready").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );

    expect(screen.getByTestId("phase-decision-rounds")).toHaveTextContent(
      /1\s*implementation task/,
    );
    expect(screen.getByTestId("phase-decision-rounds")).toHaveTextContent(
      /3\/3\s*review rounds complete/,
    );
    expect(screen.getByTestId("phase-decision-rounds")).toHaveTextContent(
      /\$0\.84\s*planning cost/,
    );

    const staffing = screen.getByTestId("phase-staffing-options");
    expect(staffing).not.toHaveAttribute("open");
    expect(within(staffing).getByText("Optional · adjust staffing")).toBeInTheDocument();
    expect(screen.getByTestId("phase-approve")).toHaveClass("phase-primary-action");
  });

  it("labels coding as the current step and gives stacked table cells durable labels", async () => {
    const approvedRun = makeRun({
      status: "approved",
      decision: {
        decision: "approve",
        direction: null,
        staffing: null,
        decided_at: "2026-07-25T12:00:00.000Z",
      },
    });
    mock = new MockFetch();
    mock.get(runUrl, { body: approvedRun });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, {
      body: {
        project_id: projectId,
        phases: [
          {
            phase_id: "foundation",
            name: "Repository foundation",
            state: "active",
            percent_complete: 35,
            est_completion: null,
            notes: "Implementation is in progress.",
          },
        ],
      },
    });
    mock.install();

    render(<PhaseTab projectId={projectId} initialRunId="run-visual" onUnauthorized={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Coding is underway" })).toBeInTheDocument();
    expect(screen.getByText("Coding", { selector: "strong" }).closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );

    const row = await screen.findByTestId("phase-execution-row-foundation");
    expect(within(row).getByText("Repository foundation")).toHaveAttribute("data-label", "Phase");
    expect(within(row).getByText("35%")).toHaveAttribute("data-label", "Complete");
  });

  it("prioritizes recovered active execution over a stale quick-kickoff refusal", async () => {
    const recoveredQuickRun = makeRun({
      mode: "quick",
      objective: "Correct the empty-state grammar",
      status: "approved",
      decision: {
        decision: "approve",
        direction: null,
        staffing: null,
        decided_at: "2026-07-25T12:00:00.000Z",
      },
      result: {
        plan: {
          objective: "Correct the empty-state grammar",
          modules: [{ id: "copy-fix", title: "Correct copy" }],
        },
        content_hash: "r".repeat(64),
        total_cost_usd: 0.04,
        staffing_proposal: null,
      },
      execution: {
        started: false,
        detail: "No build_command was discovered before the original kickoff.",
      },
    });
    mock = new MockFetch();
    mock.get(runUrl, { body: recoveredQuickRun });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, {
      body: {
        project_id: projectId,
        phases: [
          {
            phase_id: "copy-fix",
            name: "Correct the empty-state grammar",
            state: "failed",
            percent_complete: 15,
            est_completion: null,
            notes: "The prior attempt failed.",
          },
        ],
      },
    });
    mock.install();

    render(
      <PhaseTab
        projectId={projectId}
        initialRunId="run-visual"
        designatedExecution={{
          phase: {
            id: "copy-fix",
            objective_summary: "Correct the empty-state grammar",
          },
          tasks: [
            {
              id: "task-copy-fix",
              title: "Correct copy",
              run: {
                id: "run-copy-fix-3",
                attempt: 3,
                state: "running",
                failure_detail: null,
              },
            },
          ],
        }}
        onUnauthorized={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Coding is underway" })).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeVisible();
    expect(screen.getByTestId("phase-execution-kickoff-note")).toHaveTextContent(
      "The recovered quick change is now running. Attempt 3 is running.",
    );
    expect(screen.getByTestId("phase-execution-kickoff-note")).not.toHaveTextContent(
      "No build_command",
    );
    expect(screen.queryByTestId("phase-retry-execution")).not.toBeInTheDocument();
  });

  it("prioritizes the current terminal attempt and exact reason over a stale kickoff refusal", async () => {
    const expiredQuickRun = makeRun({
      mode: "quick",
      objective: "Correct the empty-state grammar",
      status: "approved",
      decision: {
        decision: "approve",
        direction: null,
        staffing: null,
        decided_at: "2026-07-25T12:00:00.000Z",
      },
      result: {
        plan: {
          objective: "Correct the empty-state grammar",
          modules: [{ id: "copy-fix", title: "Correct copy" }],
        },
        content_hash: "r".repeat(64),
        total_cost_usd: 0.04,
        staffing_proposal: null,
      },
      execution: {
        started: false,
        detail: "No build_command was discovered before the original kickoff.",
      },
    });
    mock = new MockFetch();
    mock.get(runUrl, { body: expiredQuickRun });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, {
      body: {
        project_id: projectId,
        phases: [
          {
            phase_id: "copy-fix",
            name: "Correct the empty-state grammar",
            state: "active",
            percent_complete: 15,
            est_completion: null,
            notes: "No run is active.",
          },
        ],
      },
    });
    mock.install();

    render(
      <PhaseTab
        projectId={projectId}
        initialRunId="run-visual"
        designatedExecution={{
          phase: {
            id: "copy-fix",
            objective_summary: "Correct the empty-state grammar",
          },
          tasks: [
            {
              id: "task-copy-fix",
              title: "Correct copy",
              run: {
                id: "run-copy-fix-3",
                attempt: 3,
                state: "expired",
                failure_detail: "The runner lease expired before a terminal acknowledgement.",
              },
            },
          ],
        }}
        onUnauthorized={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Coding stopped" })).toBeInTheDocument();
    expect(screen.getByTestId("phase-execution-kickoff-note")).toHaveTextContent(
      "Attempt 3 expired: The runner lease expired before a terminal acknowledgement.",
    );
    expect(screen.getByTestId("phase-execution-kickoff-note")).not.toHaveTextContent(
      "No build_command",
    );
    expect(screen.queryByTestId("phase-retry-execution")).not.toBeInTheDocument();
  });

  it("treats blocked execution as attention instead of inferring progress from approval", async () => {
    const approvedRun = makeRun({
      status: "approved",
      decision: {
        decision: "approve",
        direction: null,
        staffing: null,
        decided_at: "2026-07-25T12:00:00.000Z",
      },
    });
    mock = new MockFetch();
    mock.get(runUrl, { body: approvedRun });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, {
      body: {
        project_id: projectId,
        phases: [
          {
            phase_id: "foundation",
            name: "Repository foundation",
            state: "blocked",
            percent_complete: 10,
            est_completion: null,
            notes: "Waiting for a required decision.",
          },
        ],
      },
    });
    mock.install();

    render(<PhaseTab projectId={projectId} initialRunId="run-visual" onUnauthorized={vi.fn()} />);

    expect(
      await screen.findByRole("heading", { name: "Coding needs attention" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("phase-execution-kickoff-note")).toHaveTextContent(
      "Coding is blocked for Repository foundation",
    );
    expect(screen.queryByTestId("phase-retry-execution")).not.toBeInTheDocument();

    expect(screen.queryByTestId("phase-open-recovery-details")).not.toBeInTheDocument();
  });

  it("offers both planned and quick follow-up work after execution closes", async () => {
    const approvedRun = makeRun({
      status: "approved",
      decision: {
        decision: "approve",
        direction: null,
        staffing: null,
        decided_at: "2026-07-25T12:00:00.000Z",
      },
    });
    mock = new MockFetch();
    mock.get(runUrl, { body: approvedRun });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, {
      body: {
        project_id: projectId,
        phases: [
          {
            phase_id: "foundation",
            name: "Repository foundation",
            state: "completed",
            percent_complete: 100,
            est_completion: null,
            notes: "Complete.",
          },
          {
            phase_id: "follow-up",
            name: "Optional follow-up",
            state: "cancelled",
            percent_complete: 0,
            est_completion: null,
            notes: "Closed without implementation.",
          },
        ],
      },
    });
    mock.install();

    render(<PhaseTab projectId={projectId} initialRunId="run-visual" onUnauthorized={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Coding is complete" })).toBeInTheDocument();
    expect(screen.getByTestId("phase-execution-row-foundation")).toHaveTextContent(
      "Repository foundation",
    );
    expect(screen.getByTestId("phase-new-work")).toHaveTextContent(
      "The previous phase remains above as read-only history",
    );
    expect(screen.getByTestId("phase-start-quick")).toBeEnabled();
    await userEvent.click(screen.getByTestId("phase-start-another"));

    expect(await screen.findByTestId("phase-goal")).toHaveValue("");
    expect(screen.getByTestId("phase-mode-planned")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps cancelled failure history visible while offering a fresh quick-change composer", async () => {
    const cancelledQuickRun = makeRun({
      mode: "quick",
      objective: "Correct the empty-state grammar",
      status: "approved",
      decision: {
        decision: "approve",
        direction: null,
        staffing: null,
        decided_at: "2026-07-25T12:00:00.000Z",
      },
      result: {
        plan: {
          objective: "Correct the empty-state grammar",
          modules: [{ id: "copy-fix", title: "Correct copy" }],
        },
        content_hash: "c".repeat(64),
        total_cost_usd: 0.04,
        staffing_proposal: null,
      },
      execution: {
        started: true,
        detail: "Attempt 1 was originally dispatched.",
      },
    });
    mock = new MockFetch();
    mock.get(runUrl, { body: cancelledQuickRun });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, {
      body: {
        project_id: projectId,
        phases: [
          {
            phase_id: "copy-fix",
            name: "Correct the empty-state grammar",
            state: "cancelled",
            percent_complete: 0,
            est_completion: null,
            notes: "Cancelled after the failed attempt.",
          },
        ],
      },
    });
    mock.install();

    render(
      <PhaseTab
        projectId={projectId}
        initialRunId="run-visual"
        designatedExecution={{
          phase: {
            id: "copy-fix",
            objective_summary: "Correct the empty-state grammar",
            status: "cancelled",
          },
          tasks: [
            {
              id: "task-copy-fix",
              title: "Correct copy",
              run: {
                id: "run-copy-fix-2",
                attempt: 2,
                state: "expired",
                failure_detail: "The replacement attempt expired.",
              },
            },
          ],
        }}
        onUnauthorized={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Coding stopped" })).toBeInTheDocument();
    expect(screen.getByTestId("phase-execution-kickoff-note")).toHaveTextContent(
      "Attempt 2 expired: The replacement attempt expired.",
    );
    expect(screen.getByTestId("phase-execution-kickoff-note")).toHaveTextContent(
      "closed phase is retained here as read-only history",
    );
    expect(await screen.findByTestId("phase-execution-row-copy-fix")).toHaveTextContent(
      "cancelled",
    );
    expect(await screen.findByTestId("phase-new-work")).toBeVisible();
    expect(screen.queryByTestId("phase-open-recovery-details")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("phase-start-quick"));
    expect(await screen.findByTestId("phase-goal")).toHaveValue("");
    expect(screen.getByTestId("phase-mode-quick")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: "Coding stopped" })).not.toBeInTheDocument();
  });

  it("retains a concrete planning failure and offers a fresh run without recreating the project", async () => {
    mock = new MockFetch();
    mock.get(runUrl, {
      body: makeRun({
        status: "failed",
        error: "The reviewer response could not be validated.",
      }),
    });
    mock.install();

    render(<PhaseTab projectId={projectId} initialRunId="run-visual" onUnauthorized={vi.fn()} />);

    expect(await screen.findByTestId("phase-run-failed")).toHaveTextContent(
      "The reviewer response could not be validated.",
    );
    expect(screen.getByRole("button", { name: "Plan again" })).toBeEnabled();
  });
});
