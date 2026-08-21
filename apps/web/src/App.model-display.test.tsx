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
    mock.get("/api/auth/me", {
      body: { id: "u1", email: "admin@example.com", name: null, role: "admin", status: "active" },
    });
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.install();

    await renderAppAndOpenProject(projectAlpha.name);

    // FRONT DOOR P1d: the PM model now renders as a "Coordinator" chip in
    // the workspace header (was "Claude Sonnet 5 PM" text before the tab
    // reorg — same information, mockup-aligned presentation).
    expect(await screen.findByText(/Claude Sonnet 5.*Coordinator/i)).toBeInTheDocument();
  });

  it("opens a newly created project with an independent repository-map empty state", async () => {
    seedAuth();
    mock = new MockFetch();
    mock.get("/api/auth/me", {
      body: { id: "u1", email: "admin@example.com", name: null, role: "admin", status: "active" },
    });
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get("/api/integrations/github/status", {
      body: {
        configured: true,
        setup_available: false,
        configuration_source: "manifest",
        user_authorization: { connected: true, login: "octocat" },
        connections: [],
      },
    });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, {
      status: 409,
      body: { error: "not_planned", message: "project has no plan yet" },
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/repository-graph`, {
      body: {
        state: "missing",
        message: "Build a local Graphify map to explore this repository.",
        observed_head: "abcdef123456",
        node_count: 0,
        edge_count: 0,
        community_count: 0,
        nodes: [],
        edges: [],
        truncated: false,
      },
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, {
      body: {
        schema_version: 2,
        project: {
          id: projectAlpha.id,
          name: projectAlpha.name,
          description: projectAlpha.description,
          status: "initializing",
          aggregate_version: 1,
        },
        architecture: null,
        repositories: [],
        phases: [],
        attention: { open_decisions: 0, active_runs: 0, blocked_tasks: 0 },
        active_memory_entries: 0,
        recent_completions: [],
        next_recommended_action: "Connect a project repository",
      },
    });
    mock.install();

    const { user } = await renderAppAndOpenProject(projectAlpha.name);
    await user.click(screen.getByRole("button", { name: "Graph" }));

    expect(await screen.findByRole("heading", { name: "Repository map" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Build the repository map" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Build map" })).toHaveLength(1);
    expect(screen.queryByText(/unknown project/i)).not.toBeInTheDocument();
  });
});
