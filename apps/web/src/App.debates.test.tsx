import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("project debate navigation", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("opens debates as a project subpage and switches directly back to the graph", async () => {
    seedAuth();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, { status: 404, body: {} });
    mock.get(`/api/v2/projects/${projectAlpha.id}/debates`, { body: [] });
    mock.get("/api/v2/capabilities/ai-models", { body: { models: [] } });
    mock.install();

    const { user } = await renderAppAndOpenProject(projectAlpha.name);
    // FRONT DOOR P1d: the graph canvas/stats live under the "Graph" tab now.
    await user.click(screen.getByRole("button", { name: "Graph" }));
    await screen.findByTestId("graph-version");
    await user.click(screen.getByRole("button", { name: "Debates" }));
    expect(await screen.findByRole("heading", { name: "Debates" })).toBeVisible();
    expect(screen.getByText("No debates yet")).toBeVisible();

    expect(screen.queryByRole("button", { name: "Back to project" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Graph" }));
    expect(await screen.findByTestId("graph-version")).toBeVisible();
  });
});
