// FRONT DOOR P1d: the workspace shell reorganized into a normal top-width
// page (header + Overview | Work | Graph | Debates | Settings), replacing the graph
// canvas as the dominant panel with everything else crammed into a sidebar.
// Purely a layout change — every section moved is the same JSX/logic that
// existed before; this suite covers the new composition itself: Overview is
// the default project dashboard, Work/Graph are reachable and hold the right
// content, and Debates remains inside the workspace shell.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { setToken } from "./auth";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("FRONT DOOR P1d: workspace tab bar", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("defaults to the Overview dashboard and history, but not the graph canvas", async () => {
    setToken("present");
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, {
      body: {
        project: {
          id: projectAlpha.id,
          name: projectAlpha.name,
          status: "active",
          aggregate_version: 1,
        },
        architecture: null,
        repositories: [],
        phases: [],
        attention: { open_decisions: 0, active_runs: 0, blocked_tasks: 0 },
        next_recommended_action: "Review open decision points",
        update_interval_seconds: 300,
      },
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/planning-runs`, {
      body: {
        planning_runs: [
          {
            id: "planning-run-old",
            mode: "planned",
            objective: "Improve the notification delivery pipeline",
            status: "approved",
            round: 2,
            max_rounds: 3,
            review_rounds_total: 3,
            rounds_completed: 2,
            worker_providers: "both",
            decision: null,
            transcript: [
              {
                round: 2,
                role: "reviewer",
                provider: "openai",
                model: "gpt-5.6-sol",
                summary: "The delivery plan is ready to execute.",
                finding_counts: null,
              },
            ],
            result: null,
            error: null,
            execution: null,
            created_at: "2026-07-20T12:00:00.000Z",
          },
        ],
      },
    });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.install();

    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: new RegExp(projectAlpha.name, "i") }),
    );

    // Overview is the default tab, and it's the one already marked "on".
    expect(await screen.findByRole("button", { name: "Overview" })).toHaveClass("on");
    expect(screen.getByTestId("overview-dashboard")).toBeInTheDocument();
    expect(screen.getByTestId("work-history")).toBeInTheDocument();
    expect(screen.getByText("Improve the notification delivery pipeline")).toBeInTheDocument();
    // The graph canvas is NOT the dominant panel anymore — it isn't even
    // mounted until the Graph tab is selected.
    expect(screen.queryByTestId("graph-canvas")).not.toBeInTheDocument();
  });

  it("shows the graph canvas (full functionality preserved) only after switching to the Graph tab", async () => {
    setToken("present");
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, { status: 404, body: {} });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.install();

    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: new RegExp(projectAlpha.name, "i") }),
    );

    expect(screen.queryByTestId("graph-canvas")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Graph" }));

    expect(await screen.findByTestId("graph-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("graph-version")).toHaveTextContent("v3");
    expect(screen.getByRole("button", { name: "Graph" })).toHaveClass("on");
  });

  it("routes new work from Overview into the Work composer without a Plan tab", async () => {
    setToken("present");
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, {
      status: 409,
      body: { error: "not_planned" },
    });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, {
      body: {
        project: {
          id: projectAlpha.id,
          name: projectAlpha.name,
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
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.install();

    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: new RegExp(projectAlpha.name, "i") }),
    );

    const pointer = await screen.findByTestId("overview-no-plan-pointer");
    expect(pointer).toHaveTextContent(/no work planned yet/i);
    expect(pointer).toHaveTextContent(/start in work/i);

    await user.click(pointer);
    expect(await screen.findByRole("button", { name: "Work" })).toHaveClass("on");
    expect(screen.getByTestId("phase-goal")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Plan" })).not.toBeInTheDocument();
  });

  it("opens a fresh quick composer from Work instead of the cancelled phase history", async () => {
    setToken("present");
    const project = {
      ...projectAlpha,
      onboarding_scenario: "new_repo" as const,
      focus_planning_run_id: "run-cancelled",
    };
    const cancelledRun = {
      id: "run-cancelled",
      mode: "quick",
      objective: "Correct the README heading",
      status: "approved",
      round: 0,
      max_rounds: 0,
      review_rounds_total: 0,
      rounds_completed: 0,
      worker_providers: "anthropic",
      decision: {
        decision: "approve",
        direction: null,
        staffing: null,
        decided_at: "2026-07-25T12:00:00.000Z",
      },
      transcript: [],
      result: {
        plan: {
          objective: "Correct the README heading",
          modules: [{ id: "phase-cancelled", title: "Correct the README heading" }],
        },
        content_hash: "c".repeat(64),
        total_cost_usd: 0.12,
        staffing_proposal: null,
      },
      error: null,
      execution: {
        started: true,
        detail: "The original quick change was dispatched.",
      },
    };
    mock = new MockFetch();
    mock.get("/api/projects", { body: [project] });
    mock.get(`/api/projects/${project.id}/graph`, { body: fullyAllocatedGraph });
    mock.get("/api/v2/capabilities/execution-models", {
      body: {
        ready: true,
        required_environment: ["NORNS_RUNNER_ALLOWED_MODELS"],
        models: [
          {
            id: "claude-sonnet-5",
            provider: "anthropic",
            label: "Claude Sonnet 5",
            available: true,
            unavailable_reason: null,
          },
        ],
      },
    });
    mock.get(`/api/v2/projects/${project.id}/planning-runs/run-cancelled`, {
      body: cancelledRun,
    });
    mock.get(`/api/v2/projects/${project.id}/resume`, {
      body: {
        project: {
          id: project.id,
          name: project.name,
          status: "active",
          aggregate_version: 3,
        },
        architecture: null,
        repositories: [],
        phases: [
          {
            id: "phase-cancelled",
            objective_summary: "Correct the README heading",
            status: "cancelled",
            tasks: 1,
            completed_tasks: 0,
            blocked_tasks: 0,
          },
        ],
        attention: { open_decisions: 0, active_runs: 0, blocked_tasks: 0 },
        next_recommended_action: "Create the next phase",
      },
    });
    mock.get(`/api/v2/projects/${project.id}/execution-status`, {
      body: {
        project_id: project.id,
        phases: [
          {
            phase_id: "phase-cancelled",
            name: "Correct the README heading",
            state: "cancelled",
            percent_complete: 0,
            est_completion: null,
            notes: "Cancelled after the failed attempt.",
          },
        ],
      },
    });
    mock.get(`/api/v2/projects/${project.id}/phases/phase-cancelled/execution`, {
      body: {
        phase: {
          id: "phase-cancelled",
          objective_summary: "Correct the README heading",
          status: "cancelled",
          planning_mode: "quick",
          completed_tasks: 0,
          total_tasks: 1,
        },
        tasks: [
          {
            id: "task-copy",
            title: "Correct the README heading",
            state: "cancelled",
            complexity: "S",
            risk: "low",
            dependencies: [],
            assignment: { provider: "anthropic", model: "claude-sonnet-5", status: "active" },
            implementation_agent: {
              profile_id: "agent-claude",
              provider: "anthropic",
              model: "claude-sonnet-5",
              roles: ["implementation"],
            },
            reviewer_agent: null,
            run: {
              id: "run-execution-2",
              state: "expired",
              attempt: 2,
              verification_status: "pending",
              commit_sha: null,
              failure_detail: "The replacement attempt expired.",
            },
            evidence_count: 0,
            reviews: [],
          },
        ],
      },
    });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.install();

    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: new RegExp(project.name, "i") }));

    expect(await screen.findByRole("heading", { name: "Coding stopped" })).toBeVisible();
    expect(screen.getByTestId("phase-new-work")).toBeVisible();

    await user.click(await screen.findByTestId("phase-start-quick"));

    expect(await screen.findByTestId("phase-goal")).toHaveValue("");
    expect(screen.getByTestId("phase-mode-quick")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: "Coding stopped" })).not.toBeInTheDocument();
  });

  it("keeps Debates inside the workspace as a subpage", async () => {
    setToken("present");
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, { status: 404, body: {} });
    mock.get(`/api/v2/projects/${projectAlpha.id}/debates`, { body: [] });
    mock.get("/api/v2/capabilities/ai-models", { body: { models: [] } });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.install();

    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: new RegExp(projectAlpha.name, "i") }),
    );
    await user.click(screen.getByRole("button", { name: "Debates" }));

    expect(await screen.findByRole("heading", { name: "Debates" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Debates" })).toHaveClass("on");
  });

  it("edits the durable project rules file from the Settings subpage", async () => {
    setToken("present");
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, { status: 404, body: {} });
    mock.get(`/api/v2/projects/${projectAlpha.id}/rules`, {
      body: { filename: "NORN.md", content: "", version: 0, updated_at: null },
    });
    mock.put(`/api/v2/projects/${projectAlpha.id}/rules`, (_url, init) => ({
      body: {
        filename: "NORN.md",
        content: (JSON.parse(String(init?.body)) as { content: string }).content,
        version: 1,
        updated_at: "2026-07-25T12:00:00.000Z",
      },
    }));
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.install();

    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: new RegExp(projectAlpha.name, "i") }),
    );
    const nav = screen.getByRole("navigation", { name: "Workspace sections" });
    await user.click(within(nav).getByRole("button", { name: "Settings" }));
    const settings = await screen.findByTestId("workspace-settings");
    expect(
      within(settings)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Timing and content", "NORN.md"]);
    await user.type(
      await screen.findByLabelText("Project rules"),
      "# Rules\n\n- Preserve API compatibility.",
    );
    await user.click(screen.getByRole("button", { name: "Save rules" }));

    await waitFor(() =>
      expect(
        mock.calls.find(
          (call) =>
            call.method === "PUT" && call.url === `/api/v2/projects/${projectAlpha.id}/rules`,
        ),
      ).toMatchObject({
        body: { content: "# Rules\n\n- Preserve API compatibility." },
      }),
    );
    expect(screen.getByText("v1")).toBeVisible();
  });
});
