// EXECUTION E4 — the two data-integrity bugs, tested against real Git.
//
// Every test here drives the REAL `GitWorktreeManager`, the REAL
// `CommandPolicyVerifier` executing real child processes, and the REAL
// `GitPublisher` pushing to a real local bare repository acting as `origin`.
// No git operation is mocked. That is deliberate: this repository's own
// conventions record that mocks have concealed four dead code paths here, and
// both bugs under test are precisely the kind a mocked worktree hides — the
// pre-E4 test suite mocked `RunnerWorktreeManager` and `RunnerVerifier` and so
// asserted, green, that a run "succeeded" while nothing was ever pushed and
// verification compared a value to a copy of itself.
//
// The only injected seam is GitHub's HTTP API (`fetchImpl`), because there is
// no GitHub in a test process. The push — the half that makes the commits
// durable — is genuinely performed and genuinely asserted from the remote.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { type EventPayloadT, V2DispatchCommand } from "@norns/contracts";
import {
  ApprovedRepositoryRegistry,
  type CodingRuntime,
  CommandPolicyVerifier,
  GitPublisher,
  GitWorktreeManager,
  HashVerifiedContextLoader,
  type RunnerPublisher,
  V2RunnerExecutor,
  type VerificationCommand,
} from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "norns-test",
  GIT_AUTHOR_EMAIL: "test@norns.local",
  GIT_COMMITTER_NAME: "norns-test",
  GIT_COMMITTER_EMAIL: "test@norns.local",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { env: GIT_ENV });
  return stdout.trim();
}

interface Harness {
  root: string;
  /** Bare repository standing in for GitHub. */
  remote: string;
  /** The runner's checkout, with `origin` pointing at `remote`. */
  repository: string;
  base: string;
  registry: ApprovedRepositoryRegistry;
  worktreeRoot: string;
}

async function harness(cleanup: string[]): Promise<Harness> {
  const root = await mkdtemp(resolve(tmpdir(), "norns-e4-"));
  cleanup.push(root);
  const remote = resolve(root, "remote.git");
  const repository = resolve(root, "repository");
  await mkdir(remote, { recursive: true });
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", remote], { env: GIT_ENV });
  await execFileAsync("git", ["init", "--initial-branch=main", repository], { env: GIT_ENV });
  await git(repository, "remote", "add", "origin", remote);
  await execFileAsync("node", ["-e", "require('fs').writeFileSync('seed.txt','seed\\n')"], {
    cwd: repository,
  });
  await git(repository, "add", "-A");
  await git(repository, "commit", "-m", "seed");
  await git(repository, "push", "origin", "main");
  const base = await git(repository, "rev-parse", "HEAD");
  const registry = new ApprovedRepositoryRegistry([root]);
  registry.register({ repository_binding_id: "binding-1", repository_path: repository });
  return {
    root,
    remote,
    repository,
    base,
    registry,
    worktreeRoot: resolve(root, "worktrees"),
  };
}

/** A coding runtime that really writes a file and really commits it. */
function committingRuntime(file = "agent.txt", body = "work\n"): CodingRuntime {
  return {
    name: "codex",
    capabilities: {
      interrupt: true,
      suspend: false,
      resume_session: true,
      cancel: true,
      stop_after_current: true,
    },
    run: async (request) => {
      await execFileAsync(
        "node",
        ["-e", `require('fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(body)})`],
        { cwd: request.worktreePath },
      );
      await git(request.worktreePath, "add", "-A");
      await git(request.worktreePath, "commit", "-m", "agent work");
      return {
        outcome: "completed",
        detail: "done",
        usage: { input_tokens: 10, output_tokens: 5, usage_source: "runtime_report" },
      };
    },
  };
}

/** A coding runtime that does nothing at all — the empty run. */
const idleRuntime: CodingRuntime = {
  name: "codex",
  capabilities: {
    interrupt: true,
    suspend: false,
    resume_session: true,
    cancel: true,
    stop_after_current: true,
  },
  run: async () => ({
    outcome: "completed",
    detail: "nothing to do",
    usage: { input_tokens: 10, output_tokens: 0, usage_source: "runtime_report" },
  }),
};

/**
 * A stand-in for GitHub's pulls API that behaves like the real one for the
 * properties under test: listing by head branch, and refusing a duplicate.
 */
function githubApi() {
  const pulls: { branch: string; url: string }[] = [];
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "text/plain" } });
    if (method === "GET" && url.includes("/pulls?")) {
      const head = new URL(url).searchParams.get("head") ?? "";
      const branch = head.split(":")[1] ?? "";
      const match = pulls.find((pull) => pull.branch === branch);
      return json(200, match ? [{ html_url: match.url }] : []);
    }
    if (method === "GET") return json(200, { default_branch: "main" });
    if (method === "POST" && url.endsWith("/pulls")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { head?: string };
      const branch = body.head ?? "";
      if (pulls.some((pull) => pull.branch === branch)) {
        return json(422, { message: "A pull request already exists" });
      }
      const url_ = `https://github.test/pull/${pulls.length + 1}`;
      pulls.push({ branch, url: url_ });
      return json(201, { html_url: url_ });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { pulls, calls, fetchImpl };
}

function dispatchCommand(overrides: Record<string, unknown> = {}) {
  const jobId = (overrides.dispatch_job_id as string) ?? "job-1";
  return V2DispatchCommand.parse({
    schema_version: 2,
    protocol_version: 2,
    kind: "launch_run",
    dispatch_job_id: jobId,
    command_id: `dispatch:${jobId}`,
    delivery_attempt: 1,
    idempotency_key: `dispatch:${jobId}`,
    correlation_id: "correlation-1",
    causation_id: null,
    project_id: "project-1",
    phase_id: "phase-1",
    task_id: "task-1",
    assignment_id: "assignment-1",
    run_id: "run-1",
    runner_id: "runner-1",
    runner_generation: 3,
    repository_binding_id: "binding-1",
    expected_revision: "0".repeat(40),
    target_branch: "norns/task-task-1",
    worktree_policy_ref: "worktree-default",
    runtime: "codex",
    provider: "openai",
    model: "gpt-5-codex",
    context_refs: [
      {
        artifact_id: "prompt-1",
        content_hash: createHash("sha256").update(PROMPT).digest("hex"),
        byte_size: PROMPT.byteLength,
        storage_ref: "relay://prompt-1",
      },
    ],
    budget_reservation_id: "reservation-1",
    max_charge_usd: 10,
    max_input_tokens: 10_000,
    max_output_tokens: 4_000,
    max_duration_seconds: 900,
    verification_policy_ref: "verification",
    sandbox_policy_ref: "sandbox-default",
    authorized_by: { actor_type: "human", actor_id: "admin-1" },
    authorized_by_session_id: "session-1",
    issued_at: "2026-07-16T20:00:00.000Z",
    expires_at: "2099-07-16T20:15:00.000Z",
    ...overrides,
  });
}

const PROMPT = new TextEncoder().encode("do it");

function contextLoader(): HashVerifiedContextLoader {
  return new HashVerifiedContextLoader({ fetch: async () => PROMPT });
}

function policies(commands: readonly VerificationCommand[]) {
  return new Map([["verification", commands]]);
}

const PASSING: readonly VerificationCommand[] = [
  { name: "test", command: ["node", "-e", "process.exit(0)"] },
];
const FAILING: readonly VerificationCommand[] = [
  {
    name: "test",
    command: ["node", "-e", "console.error('2 tests failed: expected 1 to be 2'); process.exit(1)"],
  },
];

function executor(
  h: Harness,
  runtime: CodingRuntime,
  commands: readonly VerificationCommand[],
  publisher: RunnerPublisher,
): V2RunnerExecutor {
  return new V2RunnerExecutor(
    { id: "runner-1", generation: 3, scratch_root: h.root },
    h.registry,
    contextLoader(),
    new GitWorktreeManager(h.worktreeRoot),
    new Map([["codex", runtime]]),
    new CommandPolicyVerifier(policies(commands)),
    undefined,
    publisher,
  );
}

describe("EXECUTION E4 — a run's work is published, and verification is real", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("pushes the run's branch to the real remote, so the commits survive the worktree", async () => {
    const h = await harness(cleanup);
    const api = githubApi();
    const events: EventPayloadT[] = [];
    const result = await executor(
      h,
      committingRuntime(),
      PASSING,
      new GitPublisher({
        repositorySlug: "acme/widgets",
        token: "test-token",
        fetchImpl: api.fetchImpl,
      }),
    ).execute(dispatchCommand({ expected_revision: h.base }), (event) => events.push(event));

    expect(result.outcome).toBe("succeeded");
    expect(result.verification_passed).toBe(true);
    expect(result.empty).toBe(false);
    expect(result.publication).toMatchObject({
      outcome: "pushed",
      branch: "norns/task-task-1",
      remote: "origin",
      pull_request_url: "https://github.test/pull/1",
    });

    // THE ASSERTION THIS PHASE EXISTS FOR: ask the remote, not the runner.
    const remoteSha = await git(h.remote, "rev-parse", "refs/heads/norns/task-task-1");
    expect(remoteSha).toBe(result.commit_sha);
    expect(await git(h.remote, "cat-file", "-t", remoteSha)).toBe("commit");
    // The agent's actual file is in the pushed tree, not merely a ref.
    expect(await git(h.remote, "show", `${remoteSha}:agent.txt`)).toBe("work");
    // And it is genuinely new work, not the revision we started from.
    expect(remoteSha).not.toBe(h.base);

    // The worktree is still cleaned up — publication does not leak directories.
    await expect(stat(resolve(h.worktreeRoot, "run-1"))).rejects.toThrow();
  });

  it("does not double-publish when the relay redelivers the same command", async () => {
    const h = await harness(cleanup);
    const api = githubApi();
    const publisher = new GitPublisher({
      repositorySlug: "acme/widgets",
      token: "test-token",
      fetchImpl: api.fetchImpl,
    });
    const command = dispatchCommand({ expected_revision: h.base });

    const first = await executor(h, committingRuntime(), PASSING, publisher).execute(
      command,
      () => undefined,
    );
    expect(first.publication?.outcome).toBe("pushed");
    expect(api.pulls).toHaveLength(1);

    // At-least-once delivery: the very same command arrives again. The agent
    // reruns and produces a commit with identical content, and because the
    // branch name is derived from the task rather than generated, everything
    // converges instead of accumulating.
    const second = await executor(h, committingRuntime(), PASSING, publisher).execute(
      command,
      () => undefined,
    );
    expect(second.outcome).toBe("succeeded");
    expect(["pushed", "already_published", "republished"]).toContain(second.publication?.outcome);

    // ONE pull request, still. A second would mean a human reviewing the same
    // task twice and an integration stage with two candidate branches.
    expect(api.pulls).toHaveLength(1);
    expect(second.publication?.pull_request_url).toBe(first.publication?.pull_request_url);
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);

    // Exactly one branch on the remote, holding the redelivered commit.
    const refs = await git(h.remote, "for-each-ref", "--format=%(refname)", "refs/heads/norns/");
    expect(refs.split("\n").filter(Boolean)).toEqual(["refs/heads/norns/task-task-1"]);
    expect(await git(h.remote, "rev-parse", "refs/heads/norns/task-task-1")).toBe(
      second.commit_sha,
    );
  });

  it("reports an empty run as empty, and publishes nothing", async () => {
    const h = await harness(cleanup);
    const api = githubApi();
    const events: EventPayloadT[] = [];
    const result = await executor(
      h,
      idleRuntime,
      PASSING,
      new GitPublisher({
        repositorySlug: "acme/widgets",
        token: "test-token",
        fetchImpl: api.fetchImpl,
      }),
    ).execute(dispatchCommand({ expected_revision: h.base }), (event) => events.push(event));

    expect(result).toMatchObject({
      outcome: "failed",
      empty: true,
      commit_sha: null,
      verification_passed: false,
    });
    expect(result.reason).toContain("produced no commit");
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "run_log",
        chunk: expect.stringContaining("produced no commit"),
      }),
    );
    // An empty run must never be dressed up as a completed one.
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: "run_status", status: "completed" }),
    );
    // Nothing was pushed and no pull request was opened for a run with no work.
    expect(await git(h.remote, "for-each-ref", "--format=%(refname)", "refs/heads/norns/")).toBe(
      "",
    );
    expect(api.pulls).toHaveLength(0);
  });

  it("fails the run with a reason when the push cannot happen, rather than losing the work", async () => {
    const h = await harness(cleanup);
    // Point origin at somewhere that is not a repository. The commits are real
    // and the push is real; it simply cannot succeed.
    await git(h.repository, "remote", "set-url", "origin", resolve(h.root, "nowhere.git"));
    const events: EventPayloadT[] = [];
    const result = await executor(
      h,
      committingRuntime(),
      PASSING,
      new GitPublisher({
        repositorySlug: "acme/widgets",
        token: "t",
        fetchImpl: githubApi().fetchImpl,
      }),
    ).execute(dispatchCommand({ expected_revision: h.base }), (event) => events.push(event));

    expect(result.outcome).toBe("failed");
    expect(result.publication).toBeNull();
    expect(result.reason).toContain("could not be published");
    // Verification itself had passed — the run still fails, because a success
    // whose commits are about to be deleted is a lie.
    expect(result.verification_passed).toBe(true);
    expect(result.commit_sha).not.toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "run_log",
        chunk: expect.stringContaining("could not be published"),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: "run_status", status: "completed" }),
    );
  });

  it("fails the run when no publisher is configured at all", async () => {
    const h = await harness(cleanup);
    const result = await new V2RunnerExecutor(
      { id: "runner-1", generation: 3, scratch_root: h.root },
      h.registry,
      contextLoader(),
      new GitWorktreeManager(h.worktreeRoot),
      new Map([["codex", committingRuntime()]]),
      new CommandPolicyVerifier(policies(PASSING)),
    ).execute(dispatchCommand({ expected_revision: h.base }), () => undefined);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("could not be published");
  });

  it("reports a genuinely failing test suite as failed, with its output", async () => {
    const h = await harness(cleanup);
    const api = githubApi();
    const events: EventPayloadT[] = [];
    const result = await executor(
      h,
      committingRuntime(),
      FAILING,
      new GitPublisher({
        repositorySlug: "acme/widgets",
        token: "test-token",
        fetchImpl: api.fetchImpl,
      }),
    ).execute(dispatchCommand({ expected_revision: h.base }), (event) => events.push(event));

    expect(result.verification_passed).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "verification_result",
        passed: false,
        commit_sha: result.commit_sha,
      }),
    );
    // The real failing output reaches the human, not just a digest of it.
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "run_log",
        chunk: expect.stringContaining("expected 1 to be 2"),
      }),
    );
    // Failed work is still published: the reviewer needs the branch to see why.
    expect(result.publication?.outcome).toBe("pushed");
    expect(await git(h.remote, "rev-parse", "refs/heads/norns/task-task-1")).toBe(
      result.commit_sha,
    );
  });

  it("runs the verification commands at the exact commit under test", async () => {
    const h = await harness(cleanup);
    const witness = resolve(h.root, "witness.txt");
    const api = githubApi();
    const result = await executor(
      h,
      committingRuntime(),
      [
        {
          name: "record-head",
          // Records the HEAD the command actually observed while running.
          command: [
            "node",
            "-e",
            `require('fs').writeFileSync(${JSON.stringify(witness)}, require('child_process').execFileSync('git',['rev-parse','HEAD']).toString().trim())`,
          ],
        },
      ],
      new GitPublisher({
        repositorySlug: "acme/widgets",
        token: "test-token",
        fetchImpl: api.fetchImpl,
      }),
    ).execute(dispatchCommand({ expected_revision: h.base }), () => undefined);

    expect(result.verification_passed).toBe(true);
    const observed = (
      await execFileAsync("node", [
        "-e",
        `process.stdout.write(require('fs').readFileSync(${JSON.stringify(witness)},'utf8'))`,
      ])
    ).stdout.trim();
    // The command ran at the agent's commit — not the base revision, and not
    // some later state.
    expect(observed).toBe(result.commit_sha);
    expect(observed).not.toBe(h.base);
  });

  it("REGRESSION: the tautology cannot return — a failing command fails even though HEAD is the expected commit", async () => {
    const h = await harness(cleanup);
    // Build a real commit in a real worktree, exactly as a run would.
    const worktree = await new GitWorktreeManager(h.worktreeRoot).prepare({
      repository_path: h.registry.resolve("binding-1"),
      run_id: "run-tautology",
      expected_revision: h.base,
      target_branch: "norns/tautology",
    });
    try {
      await committingRuntime().run({
        runId: "run-tautology",
        worktreePath: worktree.path,
        prompt: "",
        timeoutMs: 60_000,
      });
      const commit = await worktree.head();

      // The pre-E4 implementation computed `passed = (rev-parse HEAD) === expected_commit`
      // where `expected_commit` had just been read from this same worktree.
      // That comparison is TRUE here — deliberately so: the worktree really is
      // at `commit`. If the verdict still came from that comparison, this would
      // pass. It must not, because the command exits non-zero.
      expect(await git(worktree.path, "rev-parse", "HEAD")).toBe(commit);

      const failed = await new CommandPolicyVerifier(policies(FAILING)).verify({
        worktree_path: worktree.path,
        policy_ref: "verification",
        expected_commit: commit,
        base_revision: h.base,
      });
      expect(failed.passed).toBe(false);
      expect(failed.output).toContain("expected 1 to be 2");
      expect(failed.command_results).toHaveLength(1);
      expect(failed.command_results[0]).toMatchObject({ name: "test", passed: false });
      expect(failed.command_results[0]?.exit_code).not.toBe(0);

      // The mirror image: the same worktree, the same HEAD-equals-expected
      // truth, a command that succeeds — now it passes. So `passed` tracks the
      // commands, which is the only thing that makes the badge mean anything.
      const passed = await new CommandPolicyVerifier(policies(PASSING)).verify({
        worktree_path: worktree.path,
        policy_ref: "verification",
        expected_commit: commit,
        base_revision: h.base,
      });
      expect(passed.passed).toBe(true);
      expect(passed.hygiene_only).toBe(false);

      // An unconfigured policy FAILS CLOSED with an actionable reason. It never
      // silently resolves to something green.
      const unconfigured = await new CommandPolicyVerifier(new Map()).verify({
        worktree_path: worktree.path,
        policy_ref: "verification",
        expected_commit: commit,
        base_revision: h.base,
      });
      expect(unconfigured.passed).toBe(false);
      expect(unconfigured.reason).toContain("is not approved on this runner");

      // A run with no commits cannot pass, whatever the policy says.
      const empty = await new CommandPolicyVerifier(policies(PASSING)).verify({
        worktree_path: worktree.path,
        policy_ref: "verification",
        expected_commit: h.base,
        base_revision: h.base,
      });
      expect(empty.passed).toBe(false);
      expect(empty.reason).toContain("no commit");

      // A commit that is NOT what the worktree holds is refused rather than
      // silently verified — the exact-commit guarantee, now enforced against
      // the repository instead of against a copy of itself.
      const mismatched = await new CommandPolicyVerifier(policies(PASSING)).verify({
        worktree_path: worktree.path,
        policy_ref: "verification",
        expected_commit: "c".repeat(40),
        base_revision: h.base,
      });
      expect(mismatched.passed).toBe(false);
      expect(mismatched.reason).toContain("but the commit under test is");
    } finally {
      await worktree.cleanup().catch(() => undefined);
    }
  });

  it("reads the project's real commands from a committed manifest at the exact commit", async () => {
    const h = await harness(cleanup);
    // The project commits its own verification manifest, which is how a real
    // project's build/test/lint commands reach the runner today.
    await mkdir(resolve(h.repository, ".norns"), { recursive: true });
    await execFileAsync(
      "node",
      [
        "-e",
        `require('fs').writeFileSync('.norns/verification.json', JSON.stringify({ commands: [{ name: 'test', command: ['node','-e','process.exit(0)'] }] }))`,
      ],
      { cwd: h.repository },
    );
    await git(h.repository, "add", "-A");
    await git(h.repository, "commit", "-m", "add verification manifest");
    const base = await git(h.repository, "rev-parse", "HEAD");

    const api = githubApi();
    const result = await new V2RunnerExecutor(
      { id: "runner-1", generation: 3, scratch_root: h.root },
      h.registry,
      contextLoader(),
      new GitWorktreeManager(h.worktreeRoot),
      new Map([["codex", committingRuntime()]]),
      // No policy configured for this ref at all: the manifest is the source.
      new CommandPolicyVerifier(new Map()),
      undefined,
      new GitPublisher({
        repositorySlug: "acme/widgets",
        token: "test-token",
        fetchImpl: api.fetchImpl,
      }),
    ).execute(dispatchCommand({ expected_revision: base }), () => undefined);

    expect(result.verification_passed).toBe(true);
    expect(result.outcome).toBe("succeeded");
  });
});
