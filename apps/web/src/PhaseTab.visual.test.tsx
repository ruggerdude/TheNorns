import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhaseTab } from "./PhaseTab";
import type { PhasePlanningRunDto } from "./phaseTabApi";
import { MockFetch } from "./test/mockFetch";

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
      /1\s*implementation phase/,
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
