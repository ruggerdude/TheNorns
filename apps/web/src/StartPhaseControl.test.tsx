// EXECUTION E2: the "Start phase" trigger. Every case here proves the honesty
// constraint from the brief — the button is never enabled unless the real
// server-side `.../start-readiness` preflight says so, and every disabled
// state surfaces the server's own human-readable reason rather than a
// generic label.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartPhaseControl } from "./StartPhaseControl";
import { MockFetch, type MockResponseInit } from "./test/mockFetch";

const READINESS_URL = "/api/v2/projects/proj-1/phases/phase-1/start-readiness";
const START_URL = "/api/v2/projects/proj-1/phases/phase-1/start";

describe("StartPhaseControl (EXECUTION E2)", () => {
  let mock: MockFetch;

  beforeEach(() => {
    mock = new MockFetch();
    mock.install();
  });

  afterEach(() => {
    mock.restore();
  });

  it("renders nothing for a phase status with no trigger (draft/proposed/completed/...)", () => {
    const { container } = render(
      <StartPhaseControl
        projectId="proj-1"
        phaseId="phase-1"
        phaseStatus="draft"
        onUnauthorized={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("is disabled with no reason shown while the readiness preflight is in flight", () => {
    mock.get(READINESS_URL, () => new Promise<MockResponseInit>(() => {})); // never resolves
    render(
      <StartPhaseControl
        projectId="proj-1"
        phaseId="phase-1"
        phaseStatus="approved"
        onUnauthorized={vi.fn()}
      />,
    );
    expect(screen.getByTestId("start-phase-button")).toBeDisabled();
    expect(screen.queryByTestId("start-phase-blocked-reason")).not.toBeInTheDocument();
  });

  it("enables the button only once the server reports the phase ready", async () => {
    mock.get(READINESS_URL, {
      body: { ready: true, schedulable_task_count: 2, blocking_code: null, blocking_reason: null },
    });
    render(
      <StartPhaseControl
        projectId="proj-1"
        phaseId="phase-1"
        phaseStatus="approved"
        onUnauthorized={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("start-phase-button")).toBeEnabled());
    expect(screen.queryByTestId("start-phase-blocked-reason")).not.toBeInTheDocument();
  });

  it.each([
    ["no_execution_binding", "Connect a runner workspace or a GitHub repository for this project."],
    [
      "installation_not_ready",
      "Grant the Norns GitHub App installation access to this repository.",
    ],
    [
      "unverified_binding",
      "Connect and verify a runner workspace (or GitHub repository) for this project.",
    ],
    ["repository_facts_missing", "Ingest the repository so its facts are recorded."],
    ["budget_exhausted", "the approved phase budget has no room left for another task."],
  ])(
    "stays disabled and shows the server's reason for %s",
    async (blockingCode, blockingReason) => {
      mock.get(READINESS_URL, {
        body: {
          ready: false,
          schedulable_task_count: 0,
          blocking_code: blockingCode,
          blocking_reason: blockingReason,
        },
      });
      render(
        <StartPhaseControl
          projectId="proj-1"
          phaseId="phase-1"
          phaseStatus="approved"
          onUnauthorized={vi.fn()}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("start-phase-blocked-reason")).toHaveTextContent(blockingReason),
      );
      expect(screen.getByTestId("start-phase-button")).toBeDisabled();
    },
  );

  it("starts the phase on click and shows the scheduled/blocked outcome", async () => {
    mock.get(READINESS_URL, {
      body: { ready: true, schedulable_task_count: 1, blocking_code: null, blocking_reason: null },
    });
    mock.post(START_URL, {
      status: 202,
      body: {
        phase_id: "phase-1",
        scheduled: [
          { task_id: "task-1", task_title: "Do work", outcome: "scheduled", run_id: "run-1" },
        ],
        blocked: [],
      },
    });
    const user = userEvent.setup();
    render(
      <StartPhaseControl
        projectId="proj-1"
        phaseId="phase-1"
        phaseStatus="approved"
        onUnauthorized={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("start-phase-button")).toBeEnabled());
    await user.click(screen.getByTestId("start-phase-button"));
    await waitFor(() =>
      expect(screen.getByTestId("start-phase-result")).toHaveTextContent("1 scheduled, 0 blocked"),
    );
    expect(mock.calls.some((call) => call.method === "POST" && call.url === START_URL)).toBe(true);

    // POLISH P3 hotfix sweep: this control originally sent
    // `content-type: application/json` with NO body — a combination Fastify
    // rejects with 400 ("Body cannot be empty when content-type is set to
    // 'application/json'") before the route handler runs, exactly the
    // production defect the sibling Analyze button shipped. Assert the REAL
    // fetch invocation shape: a body-less POST must carry no JSON
    // content-type. A mock that only checks the URL is what let this slip.
    const startCall = mock.calls.find((call) => call.method === "POST" && call.url === START_URL);
    expect(startCall?.body).toBeUndefined();
    expect(startCall?.headers["content-type"]).toBeUndefined();
  });

  it("calls onStarted after a successful start (so the caller can refresh phase state)", async () => {
    mock.get(READINESS_URL, {
      body: { ready: true, schedulable_task_count: 1, blocking_code: null, blocking_reason: null },
    });
    mock.post(START_URL, {
      status: 202,
      body: { phase_id: "phase-1", scheduled: [], blocked: [] },
    });
    const onStarted = vi.fn();
    const user = userEvent.setup();
    render(
      <StartPhaseControl
        projectId="proj-1"
        phaseId="phase-1"
        phaseStatus="approved"
        onStarted={onStarted}
        onUnauthorized={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("start-phase-button")).toBeEnabled());
    await user.click(screen.getByTestId("start-phase-button"));
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
  });

  it("surfaces the server's detail when start itself is refused (e.g. a race with another caller)", async () => {
    mock.get(READINESS_URL, {
      body: { ready: true, schedulable_task_count: 1, blocking_code: null, blocking_reason: null },
    });
    mock.post(START_URL, {
      status: 409,
      body: {
        error: "budget_exhausted",
        detail: "the approved phase budget has no room left for another task.",
      },
    });
    const user = userEvent.setup();
    render(
      <StartPhaseControl
        projectId="proj-1"
        phaseId="phase-1"
        phaseStatus="approved"
        onUnauthorized={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("start-phase-button")).toBeEnabled());
    await user.click(screen.getByTestId("start-phase-button"));
    await waitFor(() =>
      expect(screen.getByTestId("start-phase-error")).toHaveTextContent(
        "the approved phase budget has no room left for another task.",
      ),
    );
  });

  it("reports unauthorized when the readiness preflight 401s", async () => {
    mock.get(READINESS_URL, { status: 401, body: {} });
    const onUnauthorized = vi.fn();
    render(
      <StartPhaseControl
        projectId="proj-1"
        phaseId="phase-1"
        phaseStatus="approved"
        onUnauthorized={onUnauthorized}
      />,
    );
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });

  it("is eligible for an already-active phase too (idempotent re-trigger for newly ready tasks)", async () => {
    mock.get(READINESS_URL, {
      body: { ready: true, schedulable_task_count: 1, blocking_code: null, blocking_reason: null },
    });
    render(
      <StartPhaseControl
        projectId="proj-1"
        phaseId="phase-1"
        phaseStatus="active"
        onUnauthorized={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("start-phase-button")).toBeEnabled());
  });
});
