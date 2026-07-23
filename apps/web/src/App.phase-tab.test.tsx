// PHASE TAB (P2): App-level tests for the Phase workspace tab — the tab
// appears and switches; Start posts the contract body (objective,
// review_rounds, worker_providers, attachment_ids); live progress renders a
// mid-review run; the decision panel renders plan phases whose staffing
// dropdowns feed the approve payload; modify sends direction and returns to
// live progress; the execution table renders once approved. Backend is being
// built in parallel — these run against the CONTRACT via MockFetch; field
// drift is reconciled in phaseTabApi.ts only.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { setToken } from "./auth";
import type { PhasePlanningRunDto } from "./phaseTabApi";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch, type RecordedCall } from "./test/mockFetch";

const projectId = projectAlpha.id;
const runsUrl = `/api/v2/projects/${projectId}/planning-runs`;
const runUrl = `${runsUrl}/run-1`;

function makeRun(overrides: Partial<PhasePlanningRunDto> = {}): PhasePlanningRunDto {
  return {
    id: "run-1",
    status: "reviewing",
    round: 2,
    max_rounds: 4,
    review_rounds_total: 4,
    rounds_completed: 1,
    transcript: [
      {
        round: 1,
        role: "pm",
        provider: "anthropic",
        model: "claude-fable-5",
        summary: "Drafted a two-phase plan.",
        finding_counts: null,
      },
      {
        round: 1,
        role: "reviewer",
        provider: "openai",
        model: "gpt-5.6-sol",
        summary: "Coverage gaps in the API layer.",
        finding_counts: { must_fix: 1, should_fix: 2, suggestion: 0 },
      },
    ],
    result: null,
    error: null,
    ...overrides,
  };
}

const convergedRun = makeRun({
  status: "converged",
  rounds_completed: 2,
  review_rounds_total: 2,
  result: {
    plan: {
      phases: [
        {
          node_id: "p1",
          name: "Core API",
          description: "REST surface and persistence.",
          provider: "anthropic",
          model: "claude-sonnet-5",
          worker_count: 2,
        },
        {
          node_id: "p2",
          name: "Web UI",
          description: "Front-end for the API.",
          provider: "openai",
          model: "gpt-5.6-terra",
          worker_count: 1,
        },
      ],
    },
    content_hash: "a".repeat(64),
    total_cost_usd: 1.23,
  },
});

const executionStatus = {
  phases: [
    {
      phase_id: "p1",
      name: "Core API",
      state: "running",
      percent_complete: 42,
      est_completion: "2026-07-23 10:00 UTC",
      notes: "On track",
    },
    {
      phase_id: "p2",
      name: "Web UI",
      state: "queued",
      percent_complete: 0,
      est_completion: null,
      notes: null,
    },
  ],
};

function workspaceMocks(): MockFetch {
  const mock = new MockFetch();
  mock.get("/api/projects", { body: [projectAlpha] });
  mock.get(`/api/projects/${projectId}/graph`, { body: fullyAllocatedGraph });
  mock.get(`/api/v2/projects/${projectId}/resume`, { status: 404, body: {} });
  mock.get("/api/v2/attention", { status: 404, body: {} });
  return mock;
}

async function openPhaseTab(): Promise<UserEvent> {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: new RegExp(projectAlpha.name, "i") }));
  await user.click(await screen.findByRole("button", { name: "Phase" }));
  await screen.findByTestId("workspace-tab-phase");
  return user;
}

function postCalls(mock: MockFetch, urlSuffix: string): RecordedCall[] {
  return mock.calls.filter((call) => call.method === "POST" && call.url.endsWith(urlSuffix));
}

describe("PHASE TAB (P2)", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("appears in the workspace nav and switches to a panel with the goal form and defaults", async () => {
    setToken("present");
    mock = workspaceMocks();
    mock.install();

    await openPhaseTab();

    expect(screen.getByTestId("phase-goal")).toBeInTheDocument();
    expect(screen.getByTestId("phase-agents")).toHaveValue("both");
    expect(screen.getByTestId("phase-rounds")).toHaveValue("2");
    expect(screen.getByTestId("phase-identity-line")).toHaveTextContent(
      "PM: Claude Fable · Reviewer: ChatGPT Sol (gpt-5.6-sol)",
    );
    expect(screen.getByRole("button", { name: "Phase" })).toHaveClass("on");
  });

  it("Start posts objective, review_rounds, worker_providers, and attachment_ids; live progress renders a mid-review run", async () => {
    setToken("present");
    mock = workspaceMocks();
    mock.post(`/api/v2/projects/${projectId}/attachments`, {
      body: { id: "att-1", mime: "image/png", bytes: 4, width: 1, height: 1, purpose: "objective" },
    });
    mock.post(runsUrl, { body: { planning_run_id: "run-1" } });
    mock.get(runUrl, { body: makeRun() });
    mock.install();

    const user = await openPhaseTab();

    await user.type(screen.getByTestId("phase-goal"), "Ship the notification inbox");
    fireEvent.change(screen.getByTestId("attachment-file-input"), {
      target: {
        files: [new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" })],
      },
    });
    await screen.findByTestId("attachment-chip");
    await user.selectOptions(screen.getByTestId("phase-agents"), "anthropic");
    await user.selectOptions(screen.getByTestId("phase-rounds"), "4");
    await user.click(screen.getByTestId("phase-start"));

    await screen.findByTestId("phase-run-progress");
    const startCall = postCalls(mock, "/planning-runs")[0];
    expect(startCall?.body).toEqual({
      objective: "Ship the notification inbox",
      attachment_ids: ["att-1"],
      review_rounds: 4,
      worker_providers: "anthropic",
    });

    // Mid-review DTO: status line, rounds completed, spinner, reviewer findings.
    expect(await screen.findByTestId("phase-run-status")).toHaveTextContent(
      "Reviewing — round 2 of 4",
    );
    expect(screen.getByTestId("phase-run-rounds")).toHaveTextContent(
      "1 of 4 review rounds complete",
    );
    expect(screen.getByTestId("phase-run-findings")).toHaveTextContent(
      "Coverage gaps in the API layer.",
    );
    expect(screen.getByTestId("phase-run-findings")).toHaveTextContent("1 must fix");
  });

  it("decision panel renders plan phases; a staffing dropdown change is reflected in the approve payload; execution table renders once approved", async () => {
    setToken("present");
    mock = workspaceMocks();
    mock.post(runsUrl, { body: { planning_run_id: "run-1" } });
    mock.get(runUrl, { body: convergedRun });
    mock.post(`${runUrl}/decision`, { body: { ...convergedRun, status: "approved" } });
    mock.get(`${runUrl}/execution`, { body: executionStatus });
    mock.install();

    const user = await openPhaseTab();
    await user.type(screen.getByTestId("phase-goal"), "Ship it");
    await user.click(screen.getByTestId("phase-start"));

    await screen.findByTestId("phase-decision-panel");
    expect(screen.getByTestId("phase-plan-card-p1")).toHaveTextContent("Core API");
    expect(screen.getByTestId("phase-plan-card-p1")).toHaveTextContent(
      "REST surface and persistence.",
    );
    expect(screen.getByTestId("phase-plan-card-p2")).toHaveTextContent("Web UI");
    // Dropdowns initialized from the recommendation.
    expect(screen.getByTestId("phase-staffing-p1")).toHaveValue("anthropic:claude-sonnet-5");
    expect(screen.getByTestId("phase-staffing-p2")).toHaveValue("openai:gpt-5.6-terra");

    await user.selectOptions(screen.getByTestId("phase-staffing-p1"), "openai:gpt-5.6-sol");
    await user.click(screen.getByTestId("phase-approve"));

    await waitFor(() => expect(postCalls(mock, "/decision")).toHaveLength(1));
    expect(postCalls(mock, "/decision")[0]?.body).toEqual({
      decision: "approve",
      staffing: [
        { node_id: "p1", provider: "openai", model: "gpt-5.6-sol" },
        { node_id: "p2", provider: "openai", model: "gpt-5.6-terra" },
      ],
    });

    // Approved -> the decision panel yields to the execution status table.
    const table = await screen.findByTestId("phase-execution-table");
    expect(screen.queryByTestId("phase-decision-panel")).not.toBeInTheDocument();
    expect(table).toHaveTextContent("Core API");
    expect(table).toHaveTextContent("running");
    expect(table).toHaveTextContent("42%");
    expect(table).toHaveTextContent("On track");
    expect(table).toHaveTextContent("Web UI");
    expect(table).toHaveTextContent("queued");
  });

  it("modify requires direction, sends it, and returns the panel to live progress", async () => {
    setToken("present");
    mock = workspaceMocks();
    mock.post(runsUrl, { body: { planning_run_id: "run-1" } });
    mock.get(runUrl, { body: convergedRun });
    mock.post(`${runUrl}/decision`, {
      body: makeRun({ status: "revising", rounds_completed: 2, review_rounds_total: 4 }),
    });
    mock.install();

    const user = await openPhaseTab();
    await user.type(screen.getByTestId("phase-goal"), "Ship it");
    await user.click(screen.getByTestId("phase-start"));

    await screen.findByTestId("phase-decision-panel");
    await user.click(screen.getByTestId("phase-modify"));
    // Direction is required before Send enables.
    expect(screen.getByTestId("phase-modify-send")).toBeDisabled();
    await user.type(screen.getByTestId("phase-modify-direction"), "Split phase 1 into two");
    // From here the server reports the run as revising again (newer MockFetch
    // routes win): the component re-polls right after the decision lands.
    mock.get(runUrl, {
      body: makeRun({ status: "revising", rounds_completed: 2, review_rounds_total: 4 }),
    });
    await user.click(screen.getByTestId("phase-modify-send"));

    await waitFor(() => expect(postCalls(mock, "/decision")).toHaveLength(1));
    expect(postCalls(mock, "/decision")[0]?.body).toEqual({
      decision: "modify",
      direction: "Split phase 1 into two",
    });

    // The revising run puts the tab back into the live-progress state.
    await screen.findByTestId("phase-run-progress");
    expect(screen.queryByTestId("phase-decision-panel")).not.toBeInTheDocument();
  });

  it("reject asks for confirmation, then closes the run; a decision error surfaces the server message", async () => {
    setToken("present");
    mock = workspaceMocks();
    mock.post(runsUrl, { body: { planning_run_id: "run-1" } });
    mock.get(runUrl, { body: convergedRun });
    mock.post(`${runUrl}/decision`, {
      status: 409,
      body: { message: "Run is not awaiting a decision." },
    });
    mock.install();

    const user = await openPhaseTab();
    await user.type(screen.getByTestId("phase-goal"), "Ship it");
    await user.click(screen.getByTestId("phase-start"));
    await screen.findByTestId("phase-decision-panel");

    // First click only arms the confirmation — nothing is sent yet.
    await user.click(screen.getByTestId("phase-reject"));
    expect(postCalls(mock, "/decision")).toHaveLength(0);
    expect(screen.getByTestId("phase-reject")).toHaveTextContent("Confirm reject");

    // Confirming sends it; the 409's server message lands in the Alert.
    await user.click(screen.getByTestId("phase-reject"));
    await waitFor(() => expect(postCalls(mock, "/decision")).toHaveLength(1));
    expect(postCalls(mock, "/decision")[0]?.body).toEqual({ decision: "reject" });
    expect(await screen.findByTestId("phase-error")).toHaveTextContent(
      "Run is not awaiting a decision.",
    );
  });
});
