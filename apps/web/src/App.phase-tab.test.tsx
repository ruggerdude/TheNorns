// PHASE TAB (P2): App-level tests for the Phase workspace tab — the tab
// appears and switches; Start posts the contract body (objective,
// review_rounds, worker_providers, attachment_ids); live progress renders a
// mid-review run; the decision panel renders plan phases whose staffing
// dropdowns feed the approve payload; modify sends direction and returns to
// live progress; the execution table renders once approved. Backend is being
// built in parallel — reconciled at P3 integration: fixtures now mirror the
// REAL backend DTO shapes (apps/server/src/planning/runService.ts /
// apps/server/test/phaseTabPlanning.test.ts): staffing lives in
// result.staffing_proposal.recommendations joined to plan.modules; execution
// status is the project-scoped GET .../execution-status; modify answers 202
// with the run re-queued (status "queued", rounds_completed 0); approve
// carries `execution: { started, detail } | null`.
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
    worker_providers: "both",
    decision: null,
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

// Mirrors the backend's real PlanningRunResultDto: the plan is a PlanContract
// (modules with id/title/description), staffing lives beside it in
// staffing_proposal.recommendations (shape from
// apps/server/src/planning/allocationRecommendation.ts).
const convergedRun = makeRun({
  status: "converged",
  rounds_completed: 2,
  review_rounds_total: 2,
  result: {
    plan: {
      modules: [
        { id: "p1", title: "Core API", description: "REST surface and persistence." },
        { id: "p2", title: "Web UI", description: "Front-end for the API." },
      ],
    },
    content_hash: "a".repeat(64),
    total_cost_usd: 1.23,
    staffing_proposal: {
      summary: "Staff both modules.",
      recommendations: [
        {
          node_id: "p1",
          provider: "anthropic",
          model: "claude-sonnet-5",
          worker_count: 2,
          reviewer_model: "gpt-5.6-sol",
          budget_usd: 25,
          rationale: "Parallel-safe API work.",
        },
        {
          node_id: "p2",
          provider: "openai",
          model: "gpt-5.6-terra",
          worker_count: 1,
          reviewer_model: "claude-sonnet-5",
          budget_usd: 15,
          rationale: "Single accountable worker.",
        },
      ],
    },
  },
});

// Mirrors AttentionService.projectExecution: project-scoped, states are
// phases.status values, notes is always a string.
const executionStatus = {
  project_id: projectId,
  phases: [
    {
      phase_id: "p1",
      name: "Core API",
      state: "active",
      percent_complete: 42,
      est_completion: "2026-07-23 10:00 UTC",
      notes: "1/3 tasks complete; 1 run(s) active",
    },
    {
      phase_id: "p2",
      name: "Web UI",
      state: "proposed",
      percent_complete: 0,
      est_completion: null,
      notes: "no tasks yet",
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
    // Approve answers 200 with the run DTO plus `execution` — null means the
    // approval is recorded but execution did not auto-start (not an error).
    mock.post(`${runUrl}/decision`, {
      body: {
        ...convergedRun,
        status: "approved",
        decision: {
          decision: "approve",
          direction: null,
          staffing: [
            { node_id: "p1", provider: "openai", model: "gpt-5.6-sol" },
            { node_id: "p2", provider: "openai", model: "gpt-5.6-terra" },
          ],
          decided_at: "2026-07-22T22:00:00Z",
        },
        execution: null,
      },
    });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, { body: executionStatus });
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
    expect(table).toHaveTextContent("active");
    expect(table).toHaveTextContent("42%");
    expect(table).toHaveTextContent("1/3 tasks complete");
    expect(table).toHaveTextContent("Web UI");
    expect(table).toHaveTextContent("proposed");
    // execution:null on the approve response -> neutral note, no error.
    expect(screen.getByTestId("phase-execution-kickoff-note")).toHaveTextContent(
      "Execution has not auto-started",
    );
    expect(screen.queryByTestId("phase-execution-error")).not.toBeInTheDocument();
  });

  it("approve with execution.started renders the kickoff's success detail (PHASE TAB P4)", async () => {
    setToken("present");
    mock = workspaceMocks();
    mock.post(runsUrl, { body: { planning_run_id: "run-1" } });
    mock.get(runUrl, { body: convergedRun });
    // PHASE TAB P4: the real kickoff auto-starts execution on approve and
    // reports what it did.
    mock.post(`${runUrl}/decision`, {
      body: {
        ...convergedRun,
        status: "approved",
        decision: {
          decision: "approve",
          direction: null,
          staffing: null,
          decided_at: "2026-07-22T22:00:00Z",
        },
        execution: {
          started: true,
          detail: 'Started phase "Core API" (phase-p1): 1 task(s) dispatched.',
        },
      },
    });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, { body: executionStatus });
    mock.install();

    const user = await openPhaseTab();
    await user.type(screen.getByTestId("phase-goal"), "Ship it");
    await user.click(screen.getByTestId("phase-start"));
    await screen.findByTestId("phase-decision-panel");
    await user.click(screen.getByTestId("phase-approve"));

    await screen.findByTestId("phase-execution-table");
    const note = screen.getByTestId("phase-execution-kickoff-note");
    expect(note).toHaveTextContent("Execution started automatically");
    expect(note).toHaveTextContent('Started phase "Core API" (phase-p1): 1 task(s) dispatched.');
    expect(note).not.toHaveTextContent("Execution has not auto-started");
    expect(screen.queryByTestId("phase-execution-error")).not.toBeInTheDocument();
  });

  it("modify requires direction, sends it, and returns the panel to live progress", async () => {
    setToken("present");
    mock = workspaceMocks();
    mock.post(runsUrl, { body: { planning_run_id: "run-1" } });
    mock.get(runUrl, { body: convergedRun });
    // Modify answers 202 with the run re-queued: status back to "queued",
    // rounds_completed reset to 0, result cleared, the modify recorded.
    mock.post(`${runUrl}/decision`, {
      status: 202,
      body: makeRun({
        status: "queued",
        rounds_completed: 0,
        review_rounds_total: 2,
        result: null,
        transcript: [],
        decision: {
          decision: "modify",
          direction: "Split phase 1 into two",
          staffing: null,
          decided_at: "2026-07-22T22:00:00Z",
        },
      }),
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
