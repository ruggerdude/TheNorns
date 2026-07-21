// FRONT DOOR P1d: the workspace shell reorganized into a normal top-width
// page (header + Overview | Plan | Graph tab bar), replacing the graph
// canvas as the dominant panel with everything else crammed into a sidebar.
// Purely a layout change — every section moved is the same JSX/logic that
// existed before; this suite covers the new composition itself: Overview is
// the default tab, Plan/Graph are reachable and hold the right content, and
// a fresh draft project's Overview tab points at Plan.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { setToken } from "./auth";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("FRONT DOOR P1d: workspace tab bar", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("defaults to the Overview tab, which holds Project Resume and Tracking but not the graph canvas", async () => {
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
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.install();

    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: new RegExp(projectAlpha.name, "i") }),
    );

    // Overview is the default tab, and it's the one already marked "on".
    expect(await screen.findByRole("button", { name: "Overview" })).toHaveClass("on");
    expect(screen.getByTestId("project-resume")).toBeInTheDocument();
    expect(screen.getByTestId("tracking-settings")).toBeInTheDocument();
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

  it("a fresh draft project's Overview tab shows an honest empty state pointing at the Plan tab", async () => {
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
    expect(pointer).toHaveTextContent(/no plan yet/i);
    expect(pointer).toHaveTextContent(/draft the plan/i);

    await user.click(pointer);
    expect(await screen.findByRole("button", { name: "Plan" })).toHaveClass("on");
    expect(screen.getByTestId("next-phase-objective")).toBeInTheDocument();
  });

  it("Debates keeps its existing full-page-swap behavior, reachable from the tab row", async () => {
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
    // The tab bar itself isn't shown while Debates has taken over the page
    // (matches its pre-existing full-page behavior).
    expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
  });
});
