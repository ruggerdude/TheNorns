import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("project-manager staffing", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("asks the selected PM for the worker/model mix and displays its advice", async () => {
    seedAuth();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, { status: 404, body: {} });
    mock.get("/api/integrations/github/status", { status: 404, body: {} });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.post(`/api/projects/${projectAlpha.id}/graph/recommend-allocation`, {
      body: {
        ...fullyAllocatedGraph,
        nodes: fullyAllocatedGraph.nodes.map((node, index) => ({
          ...node,
          assignment: node.assignment
            ? {
                ...node.assignment,
                provider: index % 2 === 0 ? "anthropic" : "openai",
                source: "pm",
                rationale: "Selected by the project manager for this module.",
              }
            : null,
        })),
        allocation_advice: {
          summary: "A mixed-provider team gives this graph the best capability-to-cost balance.",
          pm_provider: "anthropic",
          pm_model: "claude-sonnet-5",
        },
      },
    });
    mock.install();

    const { user } = await renderAppAndOpenProject(projectAlpha.name);
    // FRONT DOOR P1d: Allocate/Approve/node inspector live under the "Graph"
    // tab now.
    await user.click(screen.getByRole("button", { name: "Graph" }));
    await user.selectOptions(await screen.findByLabelText(/allocation strategy/i), "pm");
    await user.click(screen.getByRole("button", { name: /ask pm to recommend team/i }));

    expect(await screen.findByTestId("allocation-advice")).toHaveTextContent(
      /mixed-provider team/i,
    );
    expect(
      mock.calls.find(
        (call) =>
          call.method === "POST" &&
          call.url === `/api/projects/${projectAlpha.id}/graph/recommend-allocation`,
      ),
    ).toBeDefined();
  });
});
