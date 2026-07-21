// EXECUTION E10 — the two things a human must be able to SEE.
//
// 1. When verification fails, WHICH command failed and what it printed. Before
//    this phase the UI had only a red badge over a sha256 digest of output that
//    was never stored anywhere.
// 2. Where the run's work went. EXECUTION E4 pushed a branch and opened a pull
//    request, then reported both as `run_log` prose, so nothing could link a
//    finished task to its review.
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

function executionPayload(
  run: Record<string, unknown>,
  failedCommands: unknown[],
): Record<string, unknown> {
  return {
    phase: {
      id: "phase-1",
      objective_summary: "Release safely",
      status: "active",
      completed_tasks: 0,
      total_tasks: 1,
    },
    tasks: [
      {
        id: "task-2",
        title: "Verify production release",
        state: "failed",
        complexity: "M",
        risk: "high",
        dependencies: [],
        assignment: { provider: "openai", model: "gpt-5-codex", status: "active" },
        implementation_agent: null,
        reviewer_agent: null,
        run,
        failed_verification_commands: failedCommands,
        evidence_count: 1,
        reviews: [],
      },
    ],
  };
}

function installCommonRoutes(mock: MockFetch): void {
  mock.get("/api/projects", { body: [projectAlpha] });
  mock.get("/api/v2/attention", { status: 404, body: {} });
  mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
  mock.get(`/api/v2/projects/${projectAlpha.id}/resume`, {
    body: {
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
    },
  });
}

describe("EXECUTION E10 workspace surfaces", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("names the failing verification command and shows its real output", async () => {
    seedAuth();
    mock = new MockFetch();
    installCommonRoutes(mock);
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-1/execution`, {
      body: executionPayload(
        {
          id: "run-2",
          state: "failed",
          attempt: 1,
          verification_status: "failed",
          commit_sha: "abcdef1234567890",
          failure_detail: null,
          published_branch: "norns/task-2",
          pull_request_url: "https://github.com/acme/repo/pull/42",
          publication_note: null,
        },
        [
          {
            name: "test",
            command: ["pnpm", "test"],
            exit_code: 1,
            output: "FAIL src/release.test.ts\n  expected rollback drill to exist",
          },
        ],
      ),
    });
    mock.install();

    await renderAppAndOpenProject(projectAlpha.name);
    expect(await screen.findByRole("heading", { name: "Release safely" })).toBeVisible();

    const failures = screen.getByTestId("task-verification-task-2");
    expect(failures).toHaveTextContent(/Verification failed: test/);
    expect(failures).toHaveTextContent("pnpm test");
    expect(failures).toHaveTextContent(/exit 1/);
    // The point of the whole seam: the human reads the ACTUAL output.
    expect(failures).toHaveTextContent(/expected rollback drill to exist/);
  });

  it("links a run to its pull request", async () => {
    seedAuth();
    mock = new MockFetch();
    installCommonRoutes(mock);
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-1/execution`, {
      body: executionPayload(
        {
          id: "run-2",
          state: "failed",
          attempt: 1,
          verification_status: "failed",
          commit_sha: "abcdef1234567890",
          failure_detail: null,
          published_branch: "norns/task-2",
          pull_request_url: "https://github.com/acme/repo/pull/42",
          publication_note: null,
        },
        [],
      ),
    });
    mock.install();

    await renderAppAndOpenProject(projectAlpha.name);
    const link = await screen.findByTestId("task-pr-task-2");
    expect(link).toHaveAttribute("href", "https://github.com/acme/repo/pull/42");
    expect(link).toHaveTextContent("View pull request");
  });

  it("explains a missing pull request rather than showing nothing", async () => {
    seedAuth();
    mock = new MockFetch();
    installCommonRoutes(mock);
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-1/execution`, {
      body: executionPayload(
        {
          id: "run-2",
          state: "failed",
          attempt: 1,
          verification_status: "failed",
          commit_sha: "abcdef1234567890",
          failure_detail: null,
          published_branch: "norns/task-2",
          pull_request_url: null,
          publication_note: "no GitHub token is configured on this runner",
        },
        [],
      ),
    });
    mock.install();

    await renderAppAndOpenProject(projectAlpha.name);
    const branch = await screen.findByTestId("task-branch-task-2");
    expect(branch).toHaveTextContent("Branch norns/task-2");
    expect(branch).toHaveTextContent(/no GitHub token is configured/);
    expect(screen.queryByTestId("task-pr-task-2")).toBeNull();
  });

  it("shows no failure panel when a legacy payload omits the field entirely", async () => {
    seedAuth();
    mock = new MockFetch();
    installCommonRoutes(mock);
    const payload = executionPayload(
      {
        id: "run-2",
        state: "succeeded",
        attempt: 1,
        verification_status: "passed",
        commit_sha: "abcdef1234567890",
        failure_detail: null,
      },
      [],
    );
    // The pre-E10 wire shape: no `failed_verification_commands` key at all.
    delete (payload.tasks as Record<string, unknown>[])[0].failed_verification_commands;
    mock.get(`/api/v2/projects/${projectAlpha.id}/phases/phase-1/execution`, { body: payload });
    mock.install();

    await renderAppAndOpenProject(projectAlpha.name);
    expect(await screen.findByRole("heading", { name: "Release safely" })).toBeVisible();
    expect(screen.queryByTestId("task-verification-task-2")).toBeNull();
    expect(screen.queryByTestId("task-pr-task-2")).toBeNull();
  });
});
