// UI-3 regression: convergence status, round count, cost, and outstanding
// findings are captured in App.tsx's PlanResult type but never passed as
// props to PlanReview — only `.plan` is forwarded
// (`<PlanReview plan={planResult.plan} .../>`), and PlanReview.tsx has no
// props for any of this. A human reviewing a plan that hit the round cap
// with the reviewer still unhappy has no way to see that from the QC screen.
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { capReachedPlanResult, fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("UI-3: plan metadata (status/rounds/cost/outstanding) must reach the QC screen", () => {
  let mock: MockFetch;

  beforeEach(async () => {
    seedAuth();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.post(`/api/projects/${projectAlpha.id}/plan`, { body: capReachedPlanResult });
    mock.install();

    const { user } = await renderAppAndOpenProject(projectAlpha.name);
    await screen.findByTestId("graph-version");
    await user.type(screen.getByTestId("plan-objective"), capReachedPlanResult.plan.objective);
    await user.click(screen.getByRole("button", { name: /run live planning/i }));
    await screen.findByTestId("plan-review");
  });

  test("shows the plan did not converge (cap_reached) after 5 rounds", () => {
    expect(screen.getByText(/cap_reached/i)).toBeInTheDocument();
    expect(screen.getByText(/5/)).toBeInTheDocument();
  });

  test("shows the total planning cost", () => {
    // capReachedPlanResult.total_cost_usd is 118.2 — assert the figure is
    // rendered somewhere, however it ends up formatted.
    expect(screen.getByText(/118\.2/)).toBeInTheDocument();
  });

  test("shows the reviewer's outstanding finding", () => {
    const [finding] = capReachedPlanResult.outstanding;
    expect(finding).toBeDefined();
    const snippet = finding?.statement.slice(0, 30) ?? "";
    expect(screen.getByText(new RegExp(snippet))).toBeInTheDocument();
  });
});
