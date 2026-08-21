import { screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { makeProject } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";
import { preloadConversationWorkspaceForTest } from "./test/preloadConversationWorkspace";

const project = makeProject({
  onboarding_scenario: "new_repo",
  entry_flow: null,
  focus_planning_run_id: null,
});

describe("relational Overview fallback", () => {
  let mock: MockFetch;

  beforeAll(preloadConversationWorkspaceForTest);
  afterEach(() => mock.restore());

  it("uses an approved quick run as the truthful Overview fallback when legacy resume is empty", async () => {
    const legacyProject = makeProject({
      status: "draft",
      onboarding_scenario: null,
      entry_flow: null,
      focus_planning_run_id: null,
      plan_objective: null,
    });
    const quickRun = {
      id: "run-quick",
      mode: "quick",
      objective: "Correct the workspace empty-state copy",
      status: "approved",
      round: 0,
      max_rounds: 0,
      review_rounds_total: 0,
      rounds_completed: 0,
      worker_providers: "openai",
      decision: {
        decision: "approve",
        direction: null,
        staffing: null,
        decided_at: "2026-07-25T12:00:00.000Z",
      },
      transcript: [],
      result: {
        plan: {
          objective: "Correct the workspace empty-state copy",
          modules: [
            {
              id: "task-copy",
              title: "Correct empty-state copy",
              description: "Make the wording truthful.",
            },
          ],
        },
        content_hash: "q".repeat(64),
        total_cost_usd: 0.08,
        staffing_proposal: null,
      },
      error: null,
      execution: {
        started: false,
        detail:
          'phase "Legacy implementation" (phase-other) is already executing; wait for it to finish',
      },
    };
    let quickRunCreated = false;

    mock = new MockFetch();
    mock.get("/api/v2/capabilities/execution-models", {
      body: {
        ready: true,
        required_environment: ["NORNS_RUNNER_ALLOWED_MODELS"],
        models: [
          {
            id: "gpt-5.6-terra",
            provider: "openai",
            label: "GPT-5.6 Terra",
            available: true,
            unavailable_reason: null,
          },
        ],
      },
    });
    mock.get("/api/projects", { body: [legacyProject] });
    mock.get(`/api/projects/${legacyProject.id}/graph`, {
      status: 409,
      body: { error: "not_planned", message: "project has no legacy graph" },
    });
    mock.get(`/api/v2/projects/${legacyProject.id}/repository-graph`, {
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
    mock.get(`/api/v2/projects/${legacyProject.id}/resume`, {
      body: {
        project: {
          id: legacyProject.id,
          name: legacyProject.name,
          status: "draft",
          aggregate_version: 1,
        },
        architecture: null,
        repositories: [],
        phases: [],
        attention: { open_decisions: 0, active_runs: 0, blocked_tasks: 0 },
        next_recommended_action: "Create the project's next phase",
      },
    });
    mock.get(`/api/v2/projects/${legacyProject.id}/planning-runs/latest`, () => ({
      body: { planning_run: quickRunCreated ? quickRun : null },
    }));
    mock.post(`/api/v2/projects/${legacyProject.id}/planning-runs`, () => {
      quickRunCreated = true;
      return { status: 202, body: { planning_run_id: quickRun.id } };
    });
    mock.get(`/api/v2/projects/${legacyProject.id}/planning-runs/${quickRun.id}`, {
      body: quickRun,
    });
    mock.get(`/api/v2/projects/${legacyProject.id}/execution-status`, {
      body: {
        project_id: legacyProject.id,
        phases: [
          {
            phase_id: "phase-other",
            name: "Legacy implementation",
            state: "active",
            percent_complete: 50,
            est_completion: null,
            notes: "Unrelated work is active.",
          },
        ],
      },
    });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.install();
    seedAuth();

    const { user } = await renderAppAndOpenProject(legacyProject.name);

    await user.click(await screen.findByTestId("overview-no-plan-pointer"));
    await user.type(
      await screen.findByTestId("phase-goal", undefined, { timeout: 3_000 }),
      "Correct the workspace empty-state copy",
    );
    await user.click(screen.getByTestId("phase-start"));
    expect(await screen.findByRole("heading", { name: "Coding needs a restart" })).toBeVisible();

    // Auto-approved quick runs do not emit the client-side approval callback.
    // Returning to Overview must therefore refresh the durable latest run.
    await user.click(screen.getByRole("button", { name: "Overview" }));
    const resumePanel = await screen.findByTestId("overview-dashboard");
    expect(screen.queryByTestId("overview-no-plan-pointer")).not.toBeInTheDocument();
    expect(within(resumePanel).getByTestId("overview-phase-count")).toHaveTextContent("1");
    expect(within(resumePanel).getByTestId("overview-attention-count")).toHaveTextContent("1");
    expect(screen.queryByTestId("next-step")).not.toBeInTheDocument();
    expect(screen.queryByTestId("relational-overview-phase")).not.toBeInTheDocument();
    expect(screen.queryByTestId("knowledge-status-relational")).not.toBeInTheDocument();
    expect(screen.queryByTestId("project-timeline")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in Work" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Graph" }));
    expect(await screen.findByRole("heading", { name: "Repository map" })).toBeVisible();
    expect(screen.queryByText("Correct empty-state copy")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Work" }));
    expect(await screen.findByRole("heading", { name: "Coding needs a restart" })).toBeVisible();
    expect(
      mock.calls.filter(
        (call) =>
          call.method === "GET" &&
          call.url === `/api/v2/projects/${legacyProject.id}/planning-runs/latest`,
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });
});
