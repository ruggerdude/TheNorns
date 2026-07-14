// UI-2 regression: a failed plan-load request discards all QC review edits.
//
// This is filed as a "test PlanReview in isolation" case in the phase brief,
// but the bug is not reachable from PlanReview at all: PlanReview's onCommit
// prop is a synchronous `(p: PlanLike) => void` with no way to observe
// success/failure. The actual bug is in App.tsx's ProjectGraph: the call()
// helper swallows every fetch error internally and never rethrows, so
// commitPlan()'s `await call(...)` always resolves, and it unconditionally
// runs `setPlanResult(null); setPlanObjective("")` after every attempt,
// success or not. Testing this therefore requires the same full-<App/>
// approach used for UI-1/UI-3/UI-7 — see the program manager report for this
// judgment call.
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import {
  convergedPlanResult,
  fullyAllocatedGraph,
  planLoadInvalid400Response,
  projectAlpha,
} from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("UI-2: a failed plan-load must not discard QC review edits", () => {
  let mock: MockFetch;

  beforeEach(() => {
    seedAuth();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.post(`/api/projects/${projectAlpha.id}/plan`, { body: convergedPlanResult });
    // The server 400s a plan/load request whose body fails the shared
    // PlanContract schema (e.g. a module a human emptied of every acceptance
    // criterion — UI-4). No `message` field, matching the real LoadPlanBody
    // safeParse-failure shape.
    mock.post(`/api/projects/${projectAlpha.id}/plan/load`, planLoadInvalid400Response);
    mock.install();
  });

  test("QC review stays on screen after the server rejects the load", async () => {
    const { user } = await renderAppAndOpenProject(projectAlpha.name);
    await screen.findByTestId("graph-version");

    await user.type(screen.getByTestId("plan-objective"), "Ship the v1 notifications service");
    await user.click(screen.getByRole("button", { name: /run live planning/i }));

    await screen.findByTestId("plan-review");

    await user.click(screen.getByTestId("load-into-graph"));

    // Give the (mocked, failing) request a tick to resolve.
    await waitFor(() => {
      expect(mock.calls.some((c) => c.url.endsWith("/plan/load"))).toBe(true);
    });

    // The QC review the human already did should still be here — a rejected
    // load is not a reason to throw away their edits. Today it is: call()
    // swallows the 400 and commitPlan() clears planResult unconditionally,
    // so plan-review disappears (replaced by the blank objective form).
    expect(screen.getByTestId("plan-review")).toBeInTheDocument();
  });
});
