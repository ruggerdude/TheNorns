import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("project model display", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("shows the persisted PM model in the project workspace header", async () => {
    seedAuth();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.install();

    await renderAppAndOpenProject(projectAlpha.name);

    expect(await screen.findByText(/Claude Sonnet 5 PM/i)).toBeInTheDocument();
  });
});
