import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryGraph } from "./RepositoryGraph";
import { MockFetch } from "./test/mockFetch";
import { ThemeProvider } from "./theme";

describe("Graphify repository map", () => {
  let mock: MockFetch;

  afterEach(() => {
    mock.restore();
    vi.restoreAllMocks();
  });

  it("shows code relationships and no legacy allocation controls", async () => {
    mock = new MockFetch();
    mock.get("/api/v2/projects/project-1/repository-graph", {
      body: {
        state: "ready",
        graphify_version: "0.9.48",
        observed_head: "abcdef123456",
        indexed_head: "abcdef123456",
        indexed_at: "2026-08-21T12:00:00.000Z",
        node_count: 2,
        edge_count: 1,
        community_count: 1,
        nodes: [
          {
            id: "src/service.ts::run",
            label: "run",
            file_type: "function",
            source_file: "src/service.ts",
            source_location: "L12",
            community: "runtime",
            community_label: "Runtime",
            degree: 1,
          },
          {
            id: "src/store.ts::save",
            label: "save",
            file_type: "function",
            source_file: "src/store.ts",
            community: "runtime",
            community_label: "Runtime",
            degree: 1,
          },
        ],
        edges: [
          {
            id: "edge:1",
            source: "src/service.ts::run",
            target: "src/store.ts::save",
            relation: "calls",
            confidence: "EXTRACTED",
          },
        ],
        truncated: false,
      },
    });
    mock.install();

    render(
      <ThemeProvider>
        <RepositoryGraph projectId="project-1" onUnauthorized={vi.fn()} />
      </ThemeProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Repository map" })).toBeVisible();
    expect(screen.getByText("2", { selector: "strong" })).toBeVisible();
    expect(screen.getByText("run")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve graph/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/allocation strategy/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("run"));
    expect(await screen.findByLabelText("Selected symbol details")).toHaveTextContent(
      "src/service.ts:L12",
    );
    expect(screen.getByText("calls")).toBeVisible();
  });
});
