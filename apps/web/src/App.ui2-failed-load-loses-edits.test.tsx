// UI-2 regression, updated for FRONT DOOR P1c: this used to verify that a
// failed plan/load request (commitPlan's PlanReview.onCommit path, the "01 ·
// Live planning" box) didn't discard the human's QC review edits. That path
// has no remaining UI caller — one canonical planning path now: a durable
// planning run materialized into a phase, reviewed and staffed in
// StrategyReview.tsx, approved via POST .../strategy/approve.
//
// This rewrite verifies the same property against the new flow: a staffing
// edit the human made, followed by a rejected approve request, must leave
// the StrategyReview screen (and the edit) exactly where the human left it
// — not silently discarded. approveStrategy()'s own try/catch already keeps
// `strategyReview` populated on failure (it's only cleared inside the try
// block, after a confirmed-successful approve), so this is a genuine
// regression test for that property, not a demonstration of a live bug.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test } from "vitest";
import { App } from "./App";
import { setToken } from "./auth";
import { projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("UI-2 (rewritten for P1c): a rejected approve must not discard staffing edits", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  function strategyReviewBody(overrides: { staffing?: Record<string, unknown>[] } = {}) {
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
        staffing: overrides.staffing ?? [
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
    };
  }

  test("QC review (and the human's staffing edit) stays on screen after the server rejects the approve", async () => {
    setToken("present");
    mock = new MockFetch();
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
        status: "converged",
        round: 2,
        max_rounds: 3,
        transcript: [],
        result: { plan: {}, content_hash: "a".repeat(64), total_cost_usd: 12 },
        error: null,
      },
    });
    mock.post(`/api/v2/projects/${projectAlpha.id}/phases`, {
      status: 201,
      body: strategyReviewBody(),
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
    // The staffing PATCH echoes back the edited model — this is the human's
    // edit that must survive a subsequently-rejected approve.
    mock.patch(`/api/v2/projects/${projectAlpha.id}/phases/phase-new/strategy/staffing`, {
      body: strategyReviewBody({
        staffing: [
          {
            assignment_id: "assign-1",
            task_local_id: "task-1",
            task_title: "Reranking pass",
            required_roles: ["engineer"],
            provider: "openai",
            model: "gpt-5.6-terra",
            reviewer_provider: "openai",
            reviewer_model: "gpt-5.6-terra",
            budget_limit_usd: 60,
            rationale: "balanced",
            rationale_factors: [],
          },
        ],
      }),
    });
    // The server rejects the approve (e.g. a stale content hash) — no
    // `message` field, matching a real safeParse-failure/conflict shape.
    mock.post(`/api/v2/projects/${projectAlpha.id}/phases/phase-new/strategy/approve`, {
      status: 409,
      body: { error: "strategy_approval_conflict" },
    });
    mock.install();

    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: new RegExp(projectAlpha.name, "i") }),
    );
    // FRONT DOOR P1d: the planning-run status / StrategyReview live under
    // the "Plan" tab now.
    await user.click(await screen.findByRole("button", { name: "Plan" }));
    await screen.findByTestId("planning-run-status");
    await user.click(screen.getByRole("button", { name: /create phase from this run/i }));
    await screen.findByTestId("strategy-review-section");

    const agentModelSelect = screen.getByRole("combobox", {
      name: /agent model for reranking pass/i,
    });
    await user.selectOptions(agentModelSelect, "openai:gpt-5.6-terra");
    await waitFor(() => expect(agentModelSelect).toHaveValue("openai:gpt-5.6-terra"));

    await user.click(screen.getByTestId("approve-strategy"));

    await waitFor(() => {
      expect(mock.calls.some((c) => c.url.endsWith("/strategy/approve"))).toBe(true);
    });

    // The QC review — including the human's staffing edit — is still here.
    // A rejected approve is not a reason to throw it away.
    const strategySection = screen.getByTestId("strategy-review-section");
    expect(strategySection).toBeInTheDocument();
    expect(within(strategySection).getByTestId("strategy-review-error")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /agent model for reranking pass/i })).toHaveValue(
      "openai:gpt-5.6-terra",
    );
  });
});
