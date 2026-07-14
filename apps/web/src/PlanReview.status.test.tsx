// UI-3 regression lock-in + estimated_complexity field-name fix.
//
// ADR-2: no "approve anyway" exception path. When a plan hits the round cap,
// the normal "Load into graph" commit action must be structurally absent —
// not merely disabled — and the outstanding (must-fix) findings must be the
// primary content of the view instead.
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { PlanReview } from "./PlanReview";
import { capReachedPlanResult, convergedPlanResult, makeCoreApiModule } from "./test/fixtures";

describe("UI-3: convergence status drives structurally distinct views", () => {
  test("a converged plan shows the editing workflow and a working commit button", () => {
    render(
      <PlanReview
        result={convergedPlanResult}
        committing={false}
        onCancel={() => {}}
        onCommit={() => {}}
      />,
    );

    expect(screen.getByTestId("plan-status")).toHaveTextContent(/converged/i);
    expect(screen.getByTestId("load-into-graph")).toBeInTheDocument();
    expect(screen.queryByTestId("outstanding-findings")).not.toBeInTheDocument();
  });

  test("a capped plan has no 'Load into graph' button at all, and shows the full outstanding statement", () => {
    render(
      <PlanReview
        result={capReachedPlanResult}
        committing={false}
        onCancel={() => {}}
        onCommit={() => {}}
      />,
    );

    expect(screen.getByTestId("plan-status")).toHaveTextContent(/round cap reached/i);
    // Structurally absent, not just disabled — ADR-2.
    expect(screen.queryByTestId("load-into-graph")).not.toBeInTheDocument();

    const findings = screen.getByTestId("outstanding-findings");
    for (const f of capReachedPlanResult.outstanding) {
      expect(findings).toHaveTextContent(f.statement);
    }

    // The only way forward from here is Cancel.
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });
});

describe("estimated_complexity field-name fix", () => {
  test("a module's real estimated_complexity value renders instead of 'complexity n/a'", () => {
    const result = {
      ...convergedPlanResult,
      plan: {
        ...convergedPlanResult.plan,
        modules: [makeCoreApiModule({ estimated_complexity: "XL" })],
      },
    };

    render(
      <PlanReview result={result} committing={false} onCancel={() => {}} onCommit={() => {}} />,
    );

    expect(screen.getByText("XL")).toBeInTheDocument();
    expect(screen.queryByText(/complexity n\/a/i)).not.toBeInTheDocument();
  });
});
