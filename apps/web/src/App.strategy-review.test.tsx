// FRONT DOOR P1: new-phase creation goes through an observable planning run
// -> materializing it into a phase + proposed strategy -> the StrategyReview
// screen (editable staffing, then approve). This covers the wizard's
// focus_planning_run_id hand-off, the "Create phase from this run" bridge
// call, a staffing edit PATCH, and the approve POST.
import { screen, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { setToken } from "./auth";
import { projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("FRONT DOOR P1: planning run -> phase -> strategy review", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  function baseStrategyReview(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      phase: {
        id: "phase-new",
        status: "awaiting_approval",
        objective_summary: "Ranking & UI parity",
        approved_strategy_version_id: null,
        approved_budget_usd: 0,
        aggregate_version: 1,
      },
      rounds: {
        planning_run_id: "run-1",
        status: "converged",
        round: 2,
        max_rounds: 3,
        transcript: [],
      },
      strategy: {
        id: "strategy-1",
        version: 1,
        status: "proposed",
        aggregate_version: 1,
        content_hash: "a".repeat(64),
        objective: "Add reranking and UI parity",
        assumptions: [],
        risks: [],
        scope_in: [],
        scope_out: [],
        architecture_impact: "none",
        convergence: "converged",
        review_rounds: 2,
        proposed_concurrency: 1,
        proposed_budget_usd: 60,
        objectives: [{ local_id: "obj-1", outcome: "Ranking parity", success_measures: [] }],
        tasks: [
          {
            local_id: "task-1",
            objective_local_id: "obj-1",
            title: "Reranking pass",
            description: "",
            deliverables: [],
            acceptance_criteria: [],
            complexity: "M",
            risk: "medium",
            required_roles: ["engineer"],
            dependency_local_ids: [],
          },
        ],
        staffing: [
          {
            assignment_id: "assign-1",
            task_local_id: "task-1",
            task_title: "Reranking pass",
            required_roles: ["engineer"],
            provider: "anthropic",
            model: "claude-sonnet-5",
            reviewer_provider: "openai",
            reviewer_model: "gpt-5.6-terra",
            budget_limit_usd: 60,
            rationale: "balanced",
            rationale_factors: [],
          },
        ],
        findings: [],
      },
      outstanding_findings: [],
      ...overrides,
    };
  }

  function setup() {
    mock = new MockFetch();
    setToken("present");
    mock.get("/api/projects", {
      body: [{ ...projectAlpha, focus_planning_run_id: "run-1" }],
    });
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
        status: "converged",
        round: 2,
        max_rounds: 3,
        transcript: [
          {
            round: 1,
            role: "pm",
            provider: "anthropic",
            model: "claude-sonnet-5",
            summary: "Drafted the plan",
            finding_counts: null,
          },
        ],
        result: { plan: {}, content_hash: "a".repeat(64), total_cost_usd: 12 },
        error: null,
      },
    });
    mock.post(`/api/v2/projects/${projectAlpha.id}/phases`, {
      status: 201,
      body: baseStrategyReview(),
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-new/execution`, {
      body: {
        phase: {
          id: "phase-new",
          objective_summary: "Ranking & UI parity",
          status: "awaiting_approval",
          completed_tasks: 0,
          total_tasks: 0,
        },
        tasks: [],
      },
    });
    mock.install();
    render(<App />);
  }

  it("shows the converged run and materializes it into a phase whose strategy review is ready to approve", async () => {
    setup();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: new RegExp(projectAlpha.name, "i") }),
    );
    // FRONT DOOR P1d: the planning-run status card lives under the "Plan"
    // tab now.
    await user.click(await screen.findByRole("button", { name: "Plan" }));
    expect(await screen.findByTestId("planning-run-status")).toHaveTextContent(/converged/i);

    await user.click(screen.getByRole("button", { name: /create phase from this run/i }));

    expect(await screen.findByTestId("strategy-review-section")).toHaveTextContent(
      /Ranking & UI parity/i,
    );
    expect(
      mock.calls.find(
        (call) =>
          call.method === "POST" && call.url === `/api/v2/projects/${projectAlpha.id}/phases`,
      ),
    ).toMatchObject({ body: { planning_run_id: "run-1" } });
    expect(await screen.findByTestId("staffing-table")).toHaveTextContent(/Reranking pass/i);
  });

  it("edits staffing (agent model) via PATCH and approves the strategy", async () => {
    setup();
    mock.patch(`/api/v2/projects/${projectAlpha.id}/phases/phase-new/strategy/staffing`, {
      body: baseStrategyReview({
        strategy: {
          ...baseStrategyReview().strategy,
          staffing: [
            {
              ...(baseStrategyReview().strategy.staffing[0] as Record<string, unknown>),
              provider: "openai",
              model: "gpt-5.6-terra",
            },
          ],
        },
      }),
    });
    mock.post(`/api/v2/projects/${projectAlpha.id}/phases/phase-new/strategy/approve`, {
      status: 200,
      body: {
        strategy_version_id: "strategy-1",
        approval_id: "approval-1",
        objectives: 1,
        tasks: 1,
      },
    });
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: new RegExp(projectAlpha.name, "i") }),
    );
    await user.click(await screen.findByRole("button", { name: "Plan" }));
    await screen.findByTestId("planning-run-status");
    await user.click(screen.getByRole("button", { name: /create phase from this run/i }));
    await screen.findByTestId("strategy-review-section");

    await user.selectOptions(
      screen.getByRole("combobox", { name: /agent model for reranking pass/i }),
      "openai:gpt-5.6-terra",
    );

    await waitFor(() =>
      expect(
        mock.calls.find(
          (call) =>
            call.method === "PATCH" &&
            call.url === `/api/v2/projects/${projectAlpha.id}/phases/phase-new/strategy/staffing`,
        ),
      ).toMatchObject({
        body: {
          assignments: [{ assignment_id: "assign-1", provider: "openai", model: "gpt-5.6-terra" }],
        },
      }),
    );

    await user.click(screen.getByTestId("approve-strategy"));

    await waitFor(() =>
      expect(
        mock.calls.find(
          (call) =>
            call.method === "POST" &&
            call.url === `/api/v2/projects/${projectAlpha.id}/phases/phase-new/strategy/approve`,
        ),
      ).toMatchObject({ body: { expected_content_hash: "a".repeat(64) } }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("strategy-review-section")).not.toBeInTheDocument(),
    );
  });
});
