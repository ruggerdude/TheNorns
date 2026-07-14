// UI-1 regression: the approval banner stays visible/unchanged after the
// graph or allocation is mutated. approveAllocation() on the server computes
// a content hash and returns it once — nothing persists it, and nothing on
// the client invalidates the "✓ Approved" indicator when the graph moves on
// (ProjectGraph's approvalHash state is set once by the approve handler and
// never cleared or re-checked against the current graph version).
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import {
  approvalHash,
  approvedAllocation,
  fullyAllocatedGraph,
  mutatedAfterApprovalGraph,
  projectAlpha,
} from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("UI-1: approval indicator must reflect staleness after mutation", () => {
  let mock: MockFetch;

  beforeEach(() => {
    seedAuth();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.post(`/api/projects/${projectAlpha.id}/graph/approve-allocation`, {
      body: approvedAllocation,
    });
    // Simulates a post-approval mutation, e.g. a re-allocation or override —
    // same project, graph.version bumped and an assignment changed.
    mock.post(`/api/projects/${projectAlpha.id}/graph/allocate`, {
      body: mutatedAfterApprovalGraph,
    });
    mock.install();
  });

  test("approving, then mutating the graph, clears or updates the approval indicator", async () => {
    const { user } = await renderAppAndOpenProject(projectAlpha.name);

    // Wait for the initial (fully-allocated, pre-approval) graph to load.
    await screen.findByTestId("graph-version");
    expect(screen.getByTestId("graph-version")).toHaveTextContent("v3");

    // Approve.
    const approveButton = screen.getByRole("button", { name: /approve graph & budget/i });
    expect(approveButton).not.toBeDisabled();
    await user.click(approveButton);

    await waitFor(() => {
      expect(screen.getByTestId("approval-hash")).toHaveTextContent(approvalHash.slice(0, 8));
    });

    // Mutate: re-run auto allocate, which the server returns as a new graph
    // version with a changed assignment (as if approval had never happened).
    const autoAllocateButton = screen.getByRole("button", { name: /auto allocate/i });
    await user.click(autoAllocateButton);

    await waitFor(() => {
      expect(screen.getByTestId("graph-version")).toHaveTextContent("v4");
    });

    // The approval indicator was for v3's exact assignments — it must not
    // keep claiming "✓ Approved" once the graph has moved past what was
    // actually approved. Today nothing clears approvalHash on mutation, so
    // this fails: the stale hash from the v3 approval is still shown.
    expect(screen.queryByTestId("approval-hash")).not.toBeInTheDocument();
  });
});
