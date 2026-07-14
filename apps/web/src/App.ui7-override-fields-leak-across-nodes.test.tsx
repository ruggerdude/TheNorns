// UI-7 regression: node-override draft fields (overrideModel/overrideBudget
// in ProjectGraph) are flat useState, not keyed per node, and not
// repopulated on selection change. Selecting node A, typing a draft
// override, then selecting node B without saving leaves node B's override
// fields showing node A's typed value.
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("UI-7: override draft fields must be scoped to the selected node", () => {
  beforeEach(() => {
    seedAuth();
    const mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.install();
  });

  test("typing an override for node A, then selecting node B, does not carry A's draft over", async () => {
    const { user } = await renderAppAndOpenProject(projectAlpha.name);
    await screen.findByTestId("graph-version");

    // Select "Core API" (fullyAllocatedGraph's first node). Use fireEvent
    // instead of userEvent here: userEvent's full pointerdown/mousedown
    // sequence trips @xyflow/react's d3-drag "nodrag" mousedown handler,
    // which throws in jsdom (no real window/defaultView on the synthetic
    // event) — a jsdom/d3-drag interaction issue unrelated to the bug this
    // test targets. A plain click event still fires React Flow's
    // onNodeClick.
    fireEvent.click(screen.getByText("Core API"));
    await screen.findByTestId("node-panel");

    const modelInput = screen.getByLabelText(/override model/i);
    await user.type(modelInput, "gpt-5-custom-A-only");
    expect(modelInput).toHaveValue("gpt-5-custom-A-only");

    // Switch to "Web UI" WITHOUT applying the override.
    fireEvent.click(screen.getByText("Web UI"));

    // Node inspector should now be showing Web UI's own (empty, since no
    // draft has been typed for it) override field — not Core API's leftover
    // draft text. Today the override inputs are flat useState shared across
    // every node, so this still reads "gpt-5-custom-A-only".
    const modelInputAfterSwitch = screen.getByLabelText(/override model/i);
    expect(modelInputAfterSwitch).toHaveValue("");
  });
});
