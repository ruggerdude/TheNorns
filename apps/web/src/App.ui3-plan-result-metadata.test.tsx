// UI-3 regression, updated for FRONT DOOR P1c: this used to verify that
// convergence status, round count, cost, and outstanding findings reached
// the legacy PlanReview QC screen (the "01 · Live planning" box's
// runPlanning -> planResult path). That path has no remaining UI caller —
// one canonical planning path now: a durable planning run, materialized
// into a phase, reviewed in StrategyReview.tsx. This rewrite verifies the
// same property (a plan that hit the round cap with the reviewer still
// unhappy must not hide that from the human) against the new flow: status
// and round count surface on the planning-run-status card before
// materializing, cost surfaces there too (previously computed but never
// rendered — added alongside this rewrite), and outstanding findings
// surface on the materialized StrategyReview screen.
import { screen, within } from "@testing-library/react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { setToken } from "./auth";
import { projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("UI-3 (rewritten for P1c): plan metadata reaches the human, via the durable planning-run flow", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  async function setupAndMaterialize() {
    mock = new MockFetch();
    setToken("present");
    mock.get("/api/projects", { body: [{ ...projectAlpha, focus_planning_run_id: "run-1" }] });
    mock.get("/api/integrations/github/status", { status: 404, body: {} });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, {
      status: 409,
      body: { error: "not_planned" },
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, {
      body: {
        project: {
          id: projectAlpha.id,
          name: projectAlpha.name,
          status: "active",
          aggregate_version: 1,
        },
        architecture: null,
        repositories: [],
        phases: [],
        attention: { open_decisions: 0, active_runs: 0, blocked_tasks: 0 },
        next_recommended_action: "Review open decision points",
      },
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/planning-runs/run-1`, {
      body: {
        id: "run-1",
        status: "cap_reached",
        round: 5,
        max_rounds: 5,
        transcript: [],
        result: { plan: {}, content_hash: "a".repeat(64), total_cost_usd: 118.2 },
        error: null,
      },
    });
    mock.post(`/api/v2/projects/${projectAlpha.id}/phases`, {
      status: 201,
      body: {
        phase: {
          id: "phase-new",
          status: "awaiting_approval",
          objective_summary: "Web UI",
          approved_strategy_version_id: null,
          approved_budget_usd: 0,
          aggregate_version: 1,
        },
        rounds: {
          planning_run_id: "run-1",
          status: "cap_reached",
          round: 5,
          max_rounds: 5,
          transcript: [],
        },
        strategy: {
          id: "strategy-1",
          version: 1,
          status: "proposed",
          aggregate_version: 1,
          content_hash: "a".repeat(64),
          objective: "Ship the v1 notifications service",
          assumptions: [],
          risks: [],
          scope_in: [],
          scope_out: [],
          architecture_impact: "none",
          convergence: "cap_reached",
          review_rounds: 5,
          proposed_concurrency: 1,
          proposed_budget_usd: 40,
          objectives: [],
          tasks: [],
          staffing: [],
          findings: [],
        },
        outstanding_findings: [
          {
            severity: "must_fix",
            finding:
              "Reviewer flagged: web-ui module has no rollback plan for a failed notification-preferences migration.",
            recommendation: "Add a rollback drill and name the evidence required before release.",
          },
        ],
      },
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-new/execution`, {
      body: {
        phase: {
          id: "phase-new",
          objective_summary: "Web UI",
          status: "awaiting_approval",
          completed_tasks: 0,
          total_tasks: 0,
        },
        tasks: [],
      },
    });
    mock.install();

    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: new RegExp(projectAlpha.name, "i") }),
    );
    return { user };
  }

  it("shows the cap_reached status and round count on the planning-run card before materializing", async () => {
    await setupAndMaterialize();
    const card = await screen.findByTestId("planning-run-status");
    expect(within(card).getByText(/cap_reached/i)).toBeInTheDocument();
    expect(within(card).getByText(/round 5 of 5/i)).toBeInTheDocument();
  });

  it("shows the total planning cost before materializing", async () => {
    await setupAndMaterialize();
    const card = await screen.findByTestId("planning-run-status");
    expect(within(card).getByTestId("planning-run-cost")).toHaveTextContent(/118\.20/);
  });

  it("shows the reviewer's outstanding finding on the materialized StrategyReview screen — cap_reached never hides it", async () => {
    const { user } = await setupAndMaterialize();
    await screen.findByTestId("planning-run-status");
    await user.click(screen.getByRole("button", { name: /create phase from this run/i }));

    const strategySection = await screen.findByTestId("strategy-review-section");
    expect(within(strategySection).getByTestId("strategy-outstanding-findings")).toHaveTextContent(
      /rollback plan for a failed notification-preferences migration/i,
    );
    // The rounds banner also carries the cap_reached status through — the
    // human isn't left thinking this converged cleanly.
    expect(within(strategySection).getByTestId("strategy-rounds-banner")).toHaveTextContent(
      /round cap reached/i,
    );
  });
});
