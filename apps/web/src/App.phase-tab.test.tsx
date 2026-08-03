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
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { App } from "./App";
import type { ProjectSummary } from "./Projects";
import { setToken } from "./auth";
import type { PhasePlanningRunDto } from "./phaseTabApi";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch, type RecordedCall } from "./test/mockFetch";
import { preloadConversationWorkspaceForTest } from "./test/preloadConversationWorkspace";

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
    execution: null,
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
          reasoning_effort: "high",
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

function workspaceMocks(project: ProjectSummary = projectAlpha): MockFetch {
  const mock = new MockFetch();
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
        {
          id: "claude-haiku-4-5-20251001",
          provider: "anthropic",
          label: "Claude Haiku 4.5",
          available: true,
          unavailable_reason: null,
        },
        {
          id: "gpt-5.6-sol",
          provider: "openai",
          label: "GPT-5.6 Sol",
          available: true,
          unavailable_reason: null,
        },
        {
          id: "gpt-5.6-terra",
          provider: "openai",
          label: "GPT-5.6 Terra",
          available: true,
          unavailable_reason: null,
        },
        {
          id: "gpt-5.6-luna",
          provider: "openai",
          label: "GPT-5.6 Luna",
          available: true,
          unavailable_reason: null,
        },
        {
          id: "deepseek-v4-pro",
          provider: "deepseek",
          label: "DeepSeek V4 Pro",
          available: true,
          unavailable_reason: null,
        },
        {
          id: "deepseek-v4-flash",
          provider: "deepseek",
          label: "DeepSeek V4 Flash",
          available: true,
          unavailable_reason: null,
        },
      ],
    },
  });
  mock.get("/api/projects", { body: [project] });
  mock.get(`/api/projects/${projectId}/graph`, { body: fullyAllocatedGraph });
  mock.get(`/api/v2/projects/${projectId}/resume`, { status: 404, body: {} });
  mock.get("/api/v2/attention", { status: 404, body: {} });
  return mock;
}

async function openPhaseTab(): Promise<UserEvent> {
  const user = userEvent.setup();
  render(<App />);
  await openProjectFromPortfolio();
  await user.click(await screen.findByRole("button", { name: "Work" }));
  await screen.findByTestId("workspace-tab-work");
  await screen.findByTestId("phase-goal");
  return user;
}

async function openProjectFromPortfolio(): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: "Show active projects" }));
  await userEvent.click(
    await screen.findByRole("button", {
      name: new RegExp(`^${projectAlpha.name}$`, "i"),
    }),
  );
}

function postCalls(mock: MockFetch, urlSuffix: string): RecordedCall[] {
  return mock.calls.filter((call) => call.method === "POST" && call.url.endsWith(urlSuffix));
}

describe("PHASE TAB (P2)", () => {
  let mock: MockFetch;

  beforeAll(preloadConversationWorkspaceForTest);
  afterEach(() => mock.restore());

  it("appears in the workspace nav and switches to a panel with the goal form and defaults", async () => {
    setToken("present");
    mock = workspaceMocks();
    mock.install();

    const user = await openPhaseTab();

    expect(await screen.findByTestId("phase-goal")).toBeInTheDocument();
    expect(screen.getByTestId("phase-mode-quick")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("phase-quick-summary")).toHaveTextContent("no reviewer");
    expect(screen.getByTestId("phase-identity-line")).toHaveTextContent(
      "PM: Project default · Agent: Recommended model for each task · No reviewer",
    );

    await user.click(screen.getByTestId("phase-mode-planned"));
    expect(screen.getByTestId("phase-agents")).toHaveValue("both");
    expect(screen.getByTestId("phase-agents")).toHaveTextContent("DeepSeek");
    expect(screen.getByTestId("phase-rounds")).toHaveValue("2");
    expect(screen.getByTestId("phase-identity-line")).toHaveTextContent(
      "PM: Project default · Agent: Recommended model for each task · Reviewer: Automatic cross-provider",
    );
    expect(screen.getByRole("button", { name: "Work" })).toHaveClass("on");
  });

  it("keeps PM choices separate while only offering runner-enabled execution agents", async () => {
    setToken("present");
    mock = workspaceMocks();
    mock.get("/api/v2/capabilities/execution-models", {
      body: {
        ready: true,
        required_environment: ["NORNS_RUNNER_ALLOWED_MODELS"],
        models: [
          {
            id: "claude-sonnet-5",
            provider: "anthropic",
            label: "Claude Sonnet 5",
            available: false,
            unavailable_reason: "model_not_in_runner_allowlist",
          },
          {
            id: "gpt-5.6-terra",
            provider: "openai",
            label: "GPT-5.6 Terra",
            available: true,
            unavailable_reason: null,
          },
          {
            id: "deepseek-v4-flash",
            provider: "deepseek",
            label: "DeepSeek V4 Flash",
            available: true,
            unavailable_reason: null,
          },
        ],
      },
    });
    mock.install();

    const user = await openPhaseTab();
    await user.click(screen.getByTestId("phase-team-toggle"));
    const pm = screen.getByTestId("phase-pm") as HTMLSelectElement;
    const agent = screen.getByTestId("phase-agent") as HTMLSelectElement;
    await waitFor(() =>
      expect([...agent.options].map((option) => option.value)).toContain("openai:gpt-5.6-terra"),
    );
    expect([...pm.options].map((option) => option.value)).toContain("anthropic:claude-sonnet-5");
    expect([...agent.options].map((option) => option.value)).not.toContain(
      "anthropic:claude-sonnet-5",
    );
    await user.selectOptions(pm, "openai:gpt-5.6-terra");
    await user.selectOptions(agent, "openai:gpt-5.6-terra");
    expect(screen.getByTestId("phase-pm-effort")).toHaveValue("medium");
    expect(screen.getByTestId("phase-agent-effort")).toHaveValue("medium");
    await user.selectOptions(screen.getByTestId("phase-agent-effort"), "xhigh");
    expect(screen.getByTestId("phase-agent-effort")).toHaveValue("xhigh");
    expect(screen.getByTestId("phase-agent-credential")).toHaveValue("api");
    await user.selectOptions(screen.getByTestId("phase-agent-credential"), "subscription");
    await user.selectOptions(agent, "deepseek:deepseek-v4-flash");
    expect(screen.queryByTestId("phase-agent-credential")).not.toBeInTheDocument();
    expect(screen.getByText("API credential only")).toBeInTheDocument();
    await user.selectOptions(agent, "openai:gpt-5.6-terra");
    expect(screen.getByTestId("phase-agent-credential")).toHaveValue("api");
  });

  it("runs a quick change without a reviewer and honors optional PM and agent identities", async () => {
    setToken("present");
    const quickReady = makeRun({
      mode: "quick",
      status: "converged",
      round: 0,
      rounds_completed: 0,
      review_rounds_total: 0,
      transcript: [
        {
          round: 0,
          role: "pm",
          provider: "openai",
          model: "gpt-5.6-terra",
          summary: "Prepared one executable quick-change task.",
          finding_counts: null,
        },
      ],
      result: {
        plan: {
          modules: [
            {
              id: "quick-change",
              title: "Correct empty-state grammar",
              description: "Make the requested copy correction.",
            },
          ],
        },
        content_hash: "q".repeat(64),
        total_cost_usd: 0.08,
        staffing_proposal: {
          summary: "One selected agent.",
          recommendations: [
            {
              node_id: "quick-change",
              provider: "anthropic",
              model: "claude-haiku-4-5-20251001",
              worker_count: 1,
            },
          ],
        },
      },
    });
    mock = workspaceMocks();
    mock.post(runsUrl, { body: { planning_run_id: "run-1" } });
    mock.get(runUrl, { body: quickReady });
    mock.post(`${runUrl}/decision`, {
      body: {
        ...quickReady,
        status: "approved",
        decision: {
          decision: "approve",
          direction: null,
          staffing: null,
          decided_at: "2026-07-25T12:00:00.000Z",
        },
        execution: { started: true, detail: "One task dispatched." },
      },
    });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, {
      body: {
        project_id: projectId,
        phases: [
          {
            phase_id: "quick-change",
            name: "Correct empty-state grammar",
            state: "active",
            percent_complete: 0,
            est_completion: null,
            notes: "Implementation is in progress.",
          },
        ],
      },
    });
    mock.install();

    const user = await openPhaseTab();
    await user.type(screen.getByTestId("phase-goal"), "Correct the empty-state grammar");
    await user.click(screen.getByTestId("phase-team-toggle"));
    await user.selectOptions(screen.getByTestId("phase-pm"), "openai:gpt-5.6-terra");
    await user.selectOptions(
      screen.getByTestId("phase-agent"),
      "anthropic:claude-haiku-4-5-20251001",
    );
    expect(screen.getByTestId("phase-agent-credential")).toHaveValue("api");
    await user.selectOptions(screen.getByTestId("phase-agent-credential"), "subscription");
    await user.click(screen.getByTestId("phase-start"));

    expect(await screen.findByTestId("phase-execution-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("phase-decision-panel")).not.toBeInTheDocument();
    expect(postCalls(mock, "/planning-runs")[0]?.body).toEqual({
      objective: "Correct the empty-state grammar",
      attachment_ids: [],
      mode: "quick",
      review_rounds: 0,
      worker_providers: "anthropic",
      pm: { provider: "openai", model: "gpt-5.6-terra", reasoning_effort: "medium" },
      agent: {
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        credential_mode: "subscription",
      },
    });
    expect(postCalls(mock, "/decision")[0]?.body).toEqual({ decision: "approve" });
    expect(screen.getByTestId("phase-execution-team")).toHaveTextContent("Claude Haiku 4.5");
  });

  it("shows the PM's quick-change agent and Codex effort when staffing is left to AI", async () => {
    setToken("present");
    const quickReady = makeRun({
      mode: "quick",
      status: "converged",
      round: 0,
      rounds_completed: 0,
      review_rounds_total: 0,
      result: {
        plan: {
          modules: [
            {
              id: "quick-change",
              title: "Repair the import path",
              description: "Apply the focused code correction.",
            },
          ],
        },
        content_hash: "q".repeat(64),
        total_cost_usd: 0.08,
        staffing_proposal: {
          summary: "Use Codex for the focused change.",
          recommendations: [
            {
              node_id: "quick-change",
              provider: "openai",
              model: "gpt-5.6-terra",
              reasoning_effort: "high",
              worker_count: 1,
              rationale: "The isolated fix benefits from careful repository reasoning.",
            },
          ],
        },
      },
    });
    mock = workspaceMocks();
    mock.post(runsUrl, { body: { planning_run_id: "run-1" } });
    mock.get(runUrl, { body: quickReady });
    mock.post(`${runUrl}/decision`, {
      body: {
        ...quickReady,
        status: "approved",
        decision: {
          decision: "approve",
          direction: null,
          staffing: null,
          decided_at: "2026-07-25T12:00:00.000Z",
        },
        execution: { started: true, detail: "One task dispatched." },
      },
    });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, {
      body: {
        project_id: projectId,
        phases: [
          {
            phase_id: "quick-change",
            name: "Repair the import path",
            state: "active",
            percent_complete: 0,
            est_completion: null,
            notes: "Implementation is in progress.",
          },
        ],
      },
    });
    mock.install();

    const user = await openPhaseTab();
    await user.type(screen.getByTestId("phase-goal"), "Repair the import path");
    await user.click(screen.getByTestId("phase-start"));

    expect(await screen.findByTestId("phase-execution-panel")).toBeInTheDocument();
    expect(postCalls(mock, "/planning-runs")[0]?.body).toMatchObject({
      mode: "quick",
      worker_providers: "both",
    });
    expect(postCalls(mock, "/planning-runs")[0]?.body).not.toHaveProperty("agent");
    expect(screen.getByTestId("phase-execution-team")).toHaveTextContent("GPT-5.6 Terra");
    expect(screen.getByTestId("phase-execution-team")).toHaveTextContent("High effort");
  });

  it("treats a stale adoption entry hint from a project read as an ordinary Overview open", async () => {
    setToken("present");
    mock = workspaceMocks({
      ...projectAlpha,
      entry_flow: "adoption",
      onboarding_scenario: "existing_repo",
      focus_planning_run_id: "run-1",
    });
    mock.get(runUrl, { body: makeRun() });
    mock.install();

    render(<App />);
    await openProjectFromPortfolio();
    await waitFor(() => expect(screen.getByRole("button", { name: "Overview" })).toHaveClass("on"));
    expect(window.location.pathname).toBe(`/projects/${projectId}`);
    expect(screen.queryByTestId("phase-run-progress")).not.toBeInTheDocument();
  });

  it("treats a stale new-project entry hint from a project read as an ordinary Overview open", async () => {
    setToken("present");
    mock = workspaceMocks({
      ...projectAlpha,
      entry_flow: "new",
      onboarding_scenario: "new_repo",
      focus_planning_run_id: "run-1",
    });
    mock.get(runUrl, { body: convergedRun });
    mock.install();

    render(<App />);
    await openProjectFromPortfolio();
    await waitFor(() => expect(screen.getByRole("button", { name: "Overview" })).toHaveClass("on"));
    expect(window.location.pathname).toBe(`/projects/${projectId}`);
    expect(screen.queryByTestId("phase-decision-panel")).not.toBeInTheDocument();
  });

  it("prepares a new project's active planning run without overriding Overview", async () => {
    setToken("present");
    mock = workspaceMocks({ ...projectAlpha, onboarding_scenario: "new_repo" });
    mock.get(`${runsUrl}/latest`, { body: { planning_run: makeRun() } });
    mock.get(runUrl, { body: makeRun() });
    mock.install();

    render(<App />);
    await openProjectFromPortfolio();
    await waitFor(() => expect(screen.getByRole("button", { name: "Overview" })).toHaveClass("on"));
    expect(screen.queryByTestId("phase-run-progress")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(await screen.findByTestId("phase-run-progress")).toBeInTheDocument();
  });

  it("restores an approved new project whose coding kickoff still needs recovery", async () => {
    setToken("present");
    const approvedRun = makeRun({
      status: "approved",
      decision: {
        decision: "approve",
        direction: null,
        staffing: null,
        decided_at: "2026-07-25T12:00:00.000Z",
      },
    });
    mock = workspaceMocks({ ...projectAlpha, onboarding_scenario: "new_repo" });
    mock.get(`${runsUrl}/latest`, { body: { planning_run: approvedRun } });
    mock.get(runUrl, { body: approvedRun });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, {
      body: {
        project_id: projectId,
        phases: [
          {
            phase_id: "p1",
            name: "Core API",
            state: "approved",
            percent_complete: 0,
            est_completion: null,
            notes: "ready to start",
          },
        ],
      },
    });
    mock.install();

    render(<App />);
    await openProjectFromPortfolio();

    await waitFor(() => expect(screen.getByRole("button", { name: "Overview" })).toHaveClass("on"));
    expect(screen.queryByTestId("phase-retry-execution")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(await screen.findByTestId("phase-retry-execution")).toBeInTheDocument();
  });

  it("restores a quick kickoff refusal and does not mistake another active phase for its progress", async () => {
    setToken("present");
    const refusedQuickRun = makeRun({
      mode: "quick",
      objective: "Correct the empty-state grammar",
      status: "approved",
      review_rounds_total: 0,
      rounds_completed: 0,
      decision: {
        decision: "approve",
        direction: null,
        staffing: null,
        decided_at: "2026-07-25T12:00:00.000Z",
      },
      execution: {
        started: false,
        detail:
          'phase "Unrelated migration" (other-phase) is already executing; wait for it to finish',
      },
    });
    mock = workspaceMocks({ ...projectAlpha, onboarding_scenario: "new_repo" });
    mock.get(`${runsUrl}/latest`, { body: { planning_run: refusedQuickRun } });
    mock.get(runUrl, { body: refusedQuickRun });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, {
      body: {
        project_id: projectId,
        phases: [
          {
            phase_id: "other-phase",
            name: "Unrelated migration",
            state: "active",
            percent_complete: 62,
            est_completion: null,
            notes: "Migration is still running.",
          },
        ],
      },
    });
    mock.install();

    render(<App />);
    await openProjectFromPortfolio();

    await waitFor(() => expect(screen.getByRole("button", { name: "Overview" })).toHaveClass("on"));
    await userEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(await screen.findByRole("heading", { name: "Coding needs a restart" })).toBeVisible();
    expect(screen.getByTestId("phase-execution-kickoff-note")).toHaveTextContent(
      "quick change is recorded, but coding did not start",
    );
    expect(screen.getByTestId("phase-execution-kickoff-note")).toHaveTextContent(
      "Unrelated migration",
    );
    expect(await screen.findByTestId("phase-retry-execution")).toBeVisible();
    expect(screen.queryByTestId("phase-execution-row-other-phase")).not.toBeInTheDocument();
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
    await user.click(screen.getByTestId("phase-mode-planned"));
    await user.selectOptions(screen.getByTestId("phase-agents"), "anthropic");
    await user.selectOptions(screen.getByTestId("phase-rounds"), "4");
    await user.click(screen.getByTestId("phase-start"));

    await screen.findByTestId("phase-run-progress");
    const startCall = postCalls(mock, "/planning-runs")[0];
    expect(startCall?.body).toEqual({
      objective: "Ship the notification inbox",
      attachment_ids: ["att-1"],
      mode: "planned",
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
    await user.click(screen.getByTestId("phase-mode-planned"));
    await user.click(screen.getByTestId("phase-start"));

    await screen.findByTestId("phase-decision-panel");
    expect(screen.getByTestId("phase-plan-card-p1")).toHaveTextContent("Core API");
    expect(screen.getByTestId("phase-plan-card-p1")).toHaveTextContent(
      "REST surface and persistence.",
    );
    expect(screen.getByTestId("phase-plan-card-p2")).toHaveTextContent("Web UI");
    expect(screen.getByTestId("phase-agent-recommendation-p1")).toHaveTextContent(
      "Claude Sonnet 5",
    );
    expect(screen.getByTestId("phase-agent-recommendation-p2")).toHaveTextContent("GPT-5.6 Terra");
    expect(screen.getByTestId("phase-agent-recommendation-p2")).toHaveTextContent("High effort");
    // Dropdowns initialized from the recommendation.
    expect(screen.getByTestId("phase-staffing-p1")).toHaveValue("anthropic:claude-sonnet-5");
    expect(screen.getByTestId("phase-staffing-p2")).toHaveValue("openai:gpt-5.6-terra");

    await user.selectOptions(screen.getByTestId("phase-staffing-p1"), "openai:gpt-5.6-sol");
    await user.selectOptions(screen.getByTestId("phase-staffing-effort-p1"), "xhigh");
    await user.selectOptions(screen.getByTestId("phase-staffing-credential-p1"), "subscription");
    await user.selectOptions(screen.getByTestId("phase-staffing-p2"), "deepseek:deepseek-v4-flash");
    expect(screen.queryByTestId("phase-staffing-credential-p2")).not.toBeInTheDocument();
    expect(screen.getByText("API credential only")).toBeInTheDocument();
    await user.click(screen.getByTestId("phase-approve"));

    await waitFor(() => expect(postCalls(mock, "/decision")).toHaveLength(1));
    expect(postCalls(mock, "/decision")[0]?.body).toEqual({
      decision: "approve",
      staffing: [
        {
          node_id: "p1",
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoning_effort: "xhigh",
          credential_mode: "subscription",
        },
        {
          node_id: "p2",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          reasoning_effort: null,
        },
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
    // execution:null on the approve response -> neutral recovery state, no
    // false claim that coding started.
    expect(screen.getByTestId("phase-execution-kickoff-note")).toHaveTextContent(
      "Checking the current coding status",
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
    await user.click(screen.getByTestId("phase-mode-planned"));
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

  it("lets a current failed execution override a stale successful kickoff without adding a detail panel", async () => {
    setToken("present");
    mock = workspaceMocks();
    mock.post(runsUrl, { body: { planning_run_id: "run-1" } });
    mock.get(runUrl, { body: convergedRun });
    mock.post(`${runUrl}/decision`, {
      body: {
        ...convergedRun,
        status: "approved",
        decision: {
          decision: "approve",
          direction: null,
          staffing: null,
          decided_at: "2026-07-25T12:00:00.000Z",
        },
        execution: {
          started: true,
          detail: "One task was dispatched.",
        },
      },
    });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, {
      body: {
        project_id: projectId,
        phases: [
          {
            phase_id: "p1",
            name: "Core API",
            state: "failed",
            percent_complete: 0,
            est_completion: null,
            notes: "The runner command failed.",
          },
        ],
      },
    });
    mock.install();

    const user = await openPhaseTab();
    await user.type(screen.getByTestId("phase-goal"), "Ship it");
    await user.click(screen.getByTestId("phase-mode-planned"));
    await user.click(screen.getByTestId("phase-start"));
    await screen.findByTestId("phase-decision-panel");
    await user.click(screen.getByTestId("phase-approve"));

    expect(await screen.findByRole("heading", { name: "Coding stopped" })).toBeInTheDocument();
    expect(screen.getByTestId("phase-execution-kickoff-note")).toHaveTextContent(
      "Coding stopped after it started for Core API",
    );
    expect(screen.getByTestId("phase-execution-kickoff-note")).not.toHaveTextContent(
      "Execution started automatically",
    );
    expect(screen.queryByTestId("phase-retry-execution")).not.toBeInTheDocument();

    expect(screen.queryByTestId("phase-open-recovery-details")).not.toBeInTheDocument();
    expect(screen.queryByTestId("phase-task-list")).not.toBeInTheDocument();
  });

  it("lets a current blocked execution override a stale successful kickoff", async () => {
    setToken("present");
    mock = workspaceMocks();
    mock.post(runsUrl, { body: { planning_run_id: "run-1" } });
    mock.get(runUrl, { body: convergedRun });
    mock.post(`${runUrl}/decision`, {
      body: {
        ...convergedRun,
        status: "approved",
        decision: {
          decision: "approve",
          direction: null,
          staffing: null,
          decided_at: "2026-07-25T12:00:00.000Z",
        },
        execution: {
          started: true,
          detail: "One task was dispatched.",
        },
      },
    });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, {
      body: {
        project_id: projectId,
        phases: [
          {
            phase_id: "p1",
            name: "Core API",
            state: "blocked",
            percent_complete: 10,
            est_completion: null,
            notes: "A decision is required.",
          },
        ],
      },
    });
    mock.install();

    const user = await openPhaseTab();
    await user.type(screen.getByTestId("phase-goal"), "Ship it");
    await user.click(screen.getByTestId("phase-mode-planned"));
    await user.click(screen.getByTestId("phase-start"));
    await screen.findByTestId("phase-decision-panel");
    await user.click(screen.getByTestId("phase-approve"));

    expect(
      await screen.findByRole("heading", { name: "Coding needs attention" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("phase-execution-kickoff-note")).toHaveTextContent(
      "Coding is blocked for Core API",
    );
    expect(screen.getByTestId("phase-execution-kickoff-note")).not.toHaveTextContent(
      "Execution started automatically",
    );
    expect(screen.queryByTestId("phase-retry-execution")).not.toBeInTheDocument();
  });

  it("retries coding kickoff from an approved plan without asking for another approval", async () => {
    setToken("present");
    mock = workspaceMocks({
      ...projectAlpha,
      entry_flow: "adoption",
      onboarding_scenario: "existing_repo",
      focus_planning_run_id: "run-1",
    });
    mock.get(runUrl, { body: convergedRun });
    mock.post(`${runUrl}/decision`, {
      body: {
        ...convergedRun,
        status: "approved",
        decision: {
          decision: "approve",
          direction: null,
          staffing: null,
          decided_at: "2026-07-25T12:00:00.000Z",
        },
        execution: { started: false, detail: "Runner was temporarily offline." },
      },
    });
    mock.get(`/api/v2/projects/${projectId}/execution-status`, {
      body: {
        project_id: projectId,
        phases: [
          {
            phase_id: "p1",
            name: "Core API",
            state: "approved",
            percent_complete: 0,
            est_completion: null,
            notes: "ready to start",
          },
        ],
      },
    });
    mock.post(`${runUrl}/execution`, {
      body: {
        ...convergedRun,
        status: "approved",
        decision: {
          decision: "approve",
          direction: null,
          staffing: null,
          decided_at: "2026-07-25T12:00:00.000Z",
        },
        execution: { started: true, detail: "1 task dispatched." },
      },
    });
    mock.install();

    render(<App />);
    await openProjectFromPortfolio();
    await userEvent.click(screen.getByRole("button", { name: "Work" }));
    await userEvent.click(await screen.findByTestId("phase-approve"));
    await userEvent.click(await screen.findByTestId("phase-retry-execution"));

    expect(await screen.findByTestId("phase-execution-kickoff-note")).toHaveTextContent(
      "1 task dispatched",
    );
    expect(postCalls(mock, "/planning-runs/run-1/execution")).toHaveLength(1);
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
    await user.click(screen.getByTestId("phase-mode-planned"));
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
    await user.click(screen.getByTestId("phase-mode-planned"));
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
