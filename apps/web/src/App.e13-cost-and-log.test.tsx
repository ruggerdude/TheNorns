// EXECUTION E13 — the human wants to see what an agent is doing and what it
// is costing WHILE it runs.
//
// 1. Live cost renders from the real (server-computed) spend/budget fields
//    and is HONEST when there is no data: a task with a run but no metered
//    usage yet must never show a fabricated $0.00, and a task with no run at
//    all must show no cost line whatsoever.
// 2. Live activity: streamed run-log output renders, and truncation (more
//    output exists than was returned) is disclosed rather than dropped
//    silently.
// 3. Polling cadence: phase-execution polling runs fast and fixed ONLY while
//    some task in the phase has an active run; otherwise it honors the
//    human's configured update_interval_seconds rather than the old
//    unconditional 5s.
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

function baseTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-2",
    title: "Verify production release",
    state: "in_progress",
    complexity: "M",
    risk: "high",
    dependencies: [],
    assignment: { provider: "openai", model: "gpt-5-codex", status: "active" },
    implementation_agent: null,
    reviewer_agent: null,
    run: {
      id: "run-2",
      state: "running",
      attempt: 1,
      verification_status: "pending",
      commit_sha: null,
      failure_detail: null,
    },
    evidence_count: 0,
    reviews: [],
    ...overrides,
  };
}

function executionPayload(
  tasks: Record<string, unknown>[],
  phaseOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    phase: {
      id: "phase-1",
      objective_summary: "Release safely",
      status: "active",
      completed_tasks: 0,
      total_tasks: tasks.length,
      ...phaseOverrides,
    },
    tasks,
  };
}

function resumeBody(updateIntervalSeconds = 300): Record<string, unknown> {
  return {
    project: {
      id: projectAlpha.id,
      name: projectAlpha.name,
      status: "active",
      aggregate_version: 2,
    },
    architecture: null,
    repositories: [],
    phases: [
      {
        id: "phase-1",
        objective_summary: "Release safely",
        status: "active",
        tasks: 1,
        completed_tasks: 0,
        blocked_tasks: 0,
      },
    ],
    attention: { open_decisions: 0, active_runs: 1, blocked_tasks: 0 },
    next_recommended_action: "Monitor active agent work",
    update_interval_seconds: updateIntervalSeconds,
  };
}

function installCommonRoutes(mock: MockFetch, updateIntervalSeconds = 300): void {
  mock.get("/api/projects", { body: [projectAlpha] });
  mock.get("/api/v2/attention", { status: 404, body: {} });
  mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
  mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, {
    body: resumeBody(updateIntervalSeconds),
  });
  // Every task in these fixtures has a `run`, so RunLog always fires; give it
  // an honest empty tail by default so it never surfaces as an unhandled
  // fetch failure in a test that isn't exercising the log itself.
  mock.get(/\/run-log(\?.*)?$/, {
    body: { run_id: "run-2", entries: [], truncated: false, total_entries: 0 },
  });
}

describe("EXECUTION E13: live cost is honest", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("shows real spend and its real budget, never a fabricated $0.00, and no line at all without a run", async () => {
    seedAuth();
    mock = new MockFetch();
    installCommonRoutes(mock);
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-1/execution`, {
      body: executionPayload(
        [
          baseTask({
            cost: {
              spend_usd: 0.27,
              input_tokens: 1800,
              output_tokens: 350,
              budget_usd: 5,
              last_usage_at: "2026-07-21T20:03:00.000Z",
            },
          }),
          baseTask({ id: "task-3", title: "Not yet scheduled", run: null, cost: undefined }),
        ],
        { spend_usd: 0.27, budget_usd: 20 },
      ),
    });
    mock.install();

    await renderAppAndOpenProject(projectAlpha.name);
    const taskCost = await screen.findByTestId("task-cost-task-2");
    expect(taskCost).toHaveTextContent("$0.27");
    expect(taskCost).toHaveTextContent("$5.00");

    // The unscheduled task has no run at all: no cost line, not a $0 one.
    expect(screen.queryByTestId("task-cost-task-3")).toBeNull();

    const phaseCost = screen.getByTestId("phase-cost");
    expect(phaseCost).toHaveTextContent("$0.27");
    expect(phaseCost).toHaveTextContent("$20.00");
  });

  it("shows 'no metered spend yet' rather than $0.00 once a run exists but nothing has been metered", async () => {
    seedAuth();
    mock = new MockFetch();
    installCommonRoutes(mock);
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-1/execution`, {
      body: executionPayload(
        [
          baseTask({
            cost: {
              spend_usd: null,
              input_tokens: null,
              output_tokens: null,
              budget_usd: 5,
              last_usage_at: null,
            },
          }),
        ],
        { spend_usd: null, budget_usd: 20 },
      ),
    });
    mock.install();

    await renderAppAndOpenProject(projectAlpha.name);
    const taskCost = await screen.findByTestId("task-cost-task-2");
    expect(taskCost).toHaveTextContent("no metered spend yet");
    expect(taskCost).toHaveTextContent("$5.00");
    expect(taskCost).not.toHaveTextContent("$0.00");

    const phaseCost = screen.getByTestId("phase-cost");
    expect(phaseCost).toHaveTextContent("no metered spend yet");
    expect(phaseCost).not.toHaveTextContent("$0.00");
  });
});

describe("EXECUTION E13: live run log", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("renders streamed output and discloses truncation rather than dropping it silently", async () => {
    seedAuth();
    mock = new MockFetch();
    installCommonRoutes(mock);
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-1/execution`, {
      body: executionPayload([baseTask()]),
    });
    mock.get(/\/run-log(\?.*)?$/, {
      body: {
        run_id: "run-2",
        entries: [
          { sequence: 199, occurred_at: "2026-07-21T20:02:00.000Z", chunk: "building...\n" },
          { sequence: 200, occurred_at: "2026-07-21T20:02:01.000Z", chunk: "running tests...\n" },
        ],
        truncated: true,
        total_entries: 450,
      },
    });
    mock.install();

    await renderAppAndOpenProject(projectAlpha.name);
    const output = await screen.findByTestId("task-run-log-output-task-2");
    expect(output).toHaveTextContent("building...");
    expect(output).toHaveTextContent("running tests...");

    const truncated = screen.getByTestId("task-run-log-truncated-task-2");
    expect(truncated).toHaveTextContent(/showing the most recent of 450 lines/i);
  });
});

describe("EXECUTION E13: phase-execution polling cadence", () => {
  let mock: MockFetch;

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    mock.restore();
    vi.useRealTimers();
  });

  it("polls fast (well under the configured interval) while a run is active", async () => {
    seedAuth();
    mock = new MockFetch();
    // A large configured interval: if this were honored while active, no
    // second call would land within 5 seconds.
    installCommonRoutes(mock, 900);
    let executionCalls = 0;
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-1/execution`, () => {
      executionCalls += 1;
      return { body: executionPayload([baseTask()]) };
    });
    mock.install();

    // Fake timers active from mount, so the interval effect's own
    // `setInterval` is one this test can advance deterministically —
    // switching timer implementations AFTER an interval is already
    // scheduled would leave that interval running on the real clock,
    // unaffected by `advanceTimersByTimeAsync`.
    await renderAppAndOpenProject(projectAlpha.name);
    await screen.findByTestId("phase-task-list");
    const callsAfterMount = executionCalls;

    await vi.advanceTimersByTimeAsync(5_001);
    await waitFor(() => expect(executionCalls).toBeGreaterThan(callsAfterMount));
  });

  it("honors the configured interval (not a hardcoded 5s) once no run is active", async () => {
    seedAuth();
    mock = new MockFetch();
    installCommonRoutes(mock, 60);
    let executionCalls = 0;
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-1/execution`, () => {
      executionCalls += 1;
      return {
        body: executionPayload([
          baseTask({
            state: "completed",
            run: {
              id: "run-2",
              state: "succeeded",
              attempt: 1,
              verification_status: "passed",
              commit_sha: "abcdef1234567890",
              failure_detail: null,
            },
          }),
        ]),
      };
    });
    mock.install();

    await renderAppAndOpenProject(projectAlpha.name);
    await screen.findByTestId("phase-task-list");
    const callsAfterMount = executionCalls;

    // Well past the old hardcoded 5s, but short of the configured 60s.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(executionCalls).toBe(callsAfterMount);

    // Now past the configured 60s.
    await vi.advanceTimersByTimeAsync(55_000);
    await waitFor(() => expect(executionCalls).toBeGreaterThan(callsAfterMount));
  });
});
