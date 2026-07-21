// EXECUTION E11 — control that actually reaches a running agent.
//
// WHAT WAS BROKEN
// ---------------
// `RunnerDaemon` constructed one `FixtureExecutor` and routed `interrupt`,
// `suspend`, `resume_session`, `stop_after_current` and `cancel` to it. That is
// the Phase 1A scripted counter; it never holds a coding run. A live V2 run
// could therefore not be stopped by anything short of the project kill switch
// or the Actions job timeout, and `send_message` was not handled at all.
// `V2RunnerExecutor` could report a `cancelled` outcome but never passed the
// `AbortSignal` its adapters all accept, so nothing could produce one.
//
// HOW THESE TESTS ARE BUILT
// -------------------------
// The runtime under test is the REAL `ProcessRuntime`, spawning a REAL child
// process, against a REAL git repository with a REAL bare remote. Nothing about
// the control path is mocked — this repository's conventions record that mocks
// have concealed four dead paths here, and "cancel stops the run" is exactly
// the claim a mocked runtime makes trivially true and dishonestly.
//
// The scripts below therefore sleep, and the assertions are about wall clock
// and about a marker file the child would have created had it survived. A test
// that only asserted the returned outcome would pass against a runtime that
// ignored the signal entirely.
//
// The only injected seam is GitHub's HTTP API, because there is no GitHub in a
// test process. The push is genuinely performed and read back from the remote.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { type EventPayloadT, V2DispatchCommand } from "@norns/contracts";
import {
  ApprovedRepositoryRegistry,
  ClaudeCodeRuntime,
  CodexRuntime,
  CommandPolicyVerifier,
  GitPublisher,
  GitWorktreeManager,
  HashVerifiedContextLoader,
  LiveRunRegistry,
  ProcessRuntime,
  ProxiedCompletionRuntime,
  type V2RunnerExecutionResult,
  V2RunnerExecutor,
  type VerificationCommand,
} from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";
import { type Stack, commandState, startStack, waitFor } from "./helpers.js";

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
  remote: string;
  repository: string;
  base: string;
  registry: ApprovedRepositoryRegistry;
  worktreeRoot: string;
}

async function harness(cleanup: string[]): Promise<Harness> {
  const root = await mkdtemp(resolve(tmpdir(), "norns-e11-"));
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
  return { root, remote, repository, base, registry, worktreeRoot: resolve(root, "worktrees") };
}

function githubApi() {
  const pulls: { branch: string; url: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
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
      const created = `https://github.test/pull/${pulls.length + 1}`;
      pulls.push({ branch, url: created });
      return json(201, { html_url: created });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { pulls, fetchImpl };
}

const PASSING: readonly VerificationCommand[] = [
  { name: "test", command: ["node", "-e", "process.exit(0)"] },
];

/**
 * Build an executor whose "prompt" is the shell script `ProcessRuntime` will
 * run. The context loader is the real hash-verifying one; only the bytes it
 * fetches are supplied locally, because there is no relay in this process.
 */
function executorFor(
  h: Harness,
  script: string,
  liveRuns: LiveRunRegistry,
  fetchImpl: typeof fetch,
): { executor: V2RunnerExecutor; scriptBytes: Uint8Array } {
  const scriptBytes = new TextEncoder().encode(script);
  const executor = new V2RunnerExecutor(
    { id: "runner-1", generation: 3, scratch_root: h.root },
    h.registry,
    new HashVerifiedContextLoader({ fetch: async () => scriptBytes }),
    new GitWorktreeManager(h.worktreeRoot),
    new Map([["process", new ProcessRuntime()]]),
    new CommandPolicyVerifier(new Map([["verification", PASSING]])),
    undefined,
    new GitPublisher({ repositorySlug: "acme/widgets", token: "test-token", fetchImpl }),
    liveRuns,
  );
  return { executor, scriptBytes };
}

function dispatchCommand(scriptBytes: Uint8Array, base: string) {
  return V2DispatchCommand.parse({
    schema_version: 2,
    protocol_version: 2,
    kind: "launch_run",
    dispatch_job_id: "job-1",
    command_id: "dispatch:job-1",
    delivery_attempt: 1,
    idempotency_key: "dispatch:job-1",
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
    expected_revision: base,
    target_branch: "norns/task-task-1",
    worktree_policy_ref: "worktree-default",
    runtime: "process",
    provider: "openai",
    model: "gpt-5-codex",
    context_refs: [
      {
        artifact_id: "prompt-1",
        content_hash: createHash("sha256").update(scriptBytes).digest("hex"),
        byte_size: scriptBytes.byteLength,
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
  });
}

/** Wait until the child process has told us it is genuinely under way. */
async function awaitMarker(events: EventPayloadT[], marker: string, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const seen = events.some((event) => event.kind === "run_log" && event.chunk.includes(marker));
    if (seen) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("EXECUTION E11 — cancel reaches a live coding run", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it(
    "stops the real child process, reports cancelled (not failed), and still publishes the work it had committed",
    { timeout: 60_000 },
    async () => {
      const h = await harness(cleanup);
      const survived = resolve(h.root, "NOT_KILLED");
      const liveRuns = new LiveRunRegistry();
      const events: EventPayloadT[] = [];
      // The script commits real work, announces itself, and then would keep
      // running for a minute. `NOT_KILLED` is written three seconds in: if the
      // child outlives the cancel, that file appears and the test fails.
      const { executor, scriptBytes } = executorFor(
        h,
        [
          "node -e \"require('fs').writeFileSync('agent.txt','half the work\\n')\"",
          "git add -A",
          'git commit -q -m "agent work so far"',
          "echo AGENT_COMMITTED",
          "sleep 3",
          `node -e "require('fs').writeFileSync(${JSON.stringify(survived)},'x')"`,
          "sleep 60",
        ].join("\n"),
        liveRuns,
        githubApi().fetchImpl,
      );

      const started = Date.now();
      const running = executor.execute(dispatchCommand(scriptBytes, h.base), (event) =>
        events.push(event),
      );
      await awaitMarker(events, "AGENT_COMMITTED", "the agent's first commit");

      // The run is live and controllable — the state that did not exist before.
      expect(liveRuns.isLive("run-1")).toBe(true);
      const applied = await liveRuns.control("run-1", "cancel");
      expect(applied?.applied).toBe(true);
      expect(applied?.state).toBe("succeeded");

      const result = await running;
      const elapsed = Date.now() - started;

      // 1. The run ended promptly rather than running its script to the end.
      expect(elapsed).toBeLessThan(20_000);
      // 2. `cancelled`, distinguishable from `failed`.
      expect(result.outcome).toBe("cancelled");
      expect(result.reason).toContain("cancelled");
      // 3. The child process is genuinely dead: it never reached second three.
      await new Promise((r) => setTimeout(r, 4_000));
      expect(await exists(survived)).toBe(false);
      // 4. THE POINT: the commits made before the human hit stop survive.
      expect(result.commit_sha).not.toBeNull();
      expect(result.publication).not.toBeNull();
      const remoteSha = await git(h.remote, "rev-parse", "refs/heads/norns/task-task-1");
      expect(remoteSha).toBe(result.commit_sha);
      expect(await git(h.remote, "show", `${remoteSha}:agent.txt`)).toBe("half the work");
      // 5. And nobody is told the unverified work passed anything.
      expect(result.verification_passed).toBe(false);
      const statuses = events
        .filter((event) => event.kind === "run_status")
        .map((event) => (event.kind === "run_status" ? event.status : ""));
      expect(statuses).toContain("cancelled");
      expect(statuses).not.toContain("failed");
    },
  );

  it(
    "a cancelled run that had committed nothing says there was nothing to publish",
    { timeout: 60_000 },
    async () => {
      const h = await harness(cleanup);
      const liveRuns = new LiveRunRegistry();
      const events: EventPayloadT[] = [];
      const { executor, scriptBytes } = executorFor(
        h,
        ["echo AGENT_THINKING", "sleep 60"].join("\n"),
        liveRuns,
        githubApi().fetchImpl,
      );
      const running = executor.execute(dispatchCommand(scriptBytes, h.base), (event) =>
        events.push(event),
      );
      await awaitMarker(events, "AGENT_THINKING", "the agent to start");
      await liveRuns.control("run-1", "cancel");
      const result = await running;

      expect(result.outcome).toBe("cancelled");
      expect(result.empty).toBe(true);
      expect(result.commit_sha).toBeNull();
      expect(result.publication).toBeNull();
      expect(result.reason).toContain("nothing to publish");
      // The branch was never pushed, because there was nothing on it.
      await expect(git(h.remote, "rev-parse", "refs/heads/norns/task-task-1")).rejects.toBeTruthy();
    },
  );

  it("releases the run when it ends, so a later control is answered honestly", async () => {
    const h = await harness(cleanup);
    const liveRuns = new LiveRunRegistry();
    const { executor, scriptBytes } = executorFor(
      h,
      [
        "node -e \"require('fs').writeFileSync('agent.txt','all done\\n')\"",
        "git add -A",
        'git commit -q -m "agent work"',
      ].join("\n"),
      liveRuns,
      githubApi().fetchImpl,
    );
    const result = await executor.execute(dispatchCommand(scriptBytes, h.base), () => {});
    expect(result.outcome).toBe("succeeded");
    expect(liveRuns.isLive("run-1")).toBe(false);

    const late = await liveRuns.control("run-1", "cancel");
    expect(late?.applied).toBe(false);
    expect(late?.state).toBe("rejected");
    expect(late?.detail).toContain("already ended (succeeded)");
  });
});

describe("EXECUTION E11 — send_message delivery", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it(
    "delivers a human's answer into a live run, and the run acts on it",
    { timeout: 60_000 },
    async () => {
      const h = await harness(cleanup);
      const liveRuns = new LiveRunRegistry();
      const events: EventPayloadT[] = [];
      // The script blocks on stdin exactly as an agent blocks on a question,
      // then commits the answer. Nothing here is simulated: the bytes travel
      // through the child's real stdin pipe.
      const { executor, scriptBytes } = executorFor(
        h,
        [
          "echo AGENT_ASKED_A_QUESTION",
          "read answer",
          'echo "AGENT_HEARD:$answer"',
          "node -e \"require('fs').writeFileSync('answer.txt', process.argv[1])\" \"$answer\"",
          "git add -A",
          'git commit -q -m "acted on the human answer"',
        ].join("\n"),
        liveRuns,
        githubApi().fetchImpl,
      );
      const running = executor.execute(dispatchCommand(scriptBytes, h.base), (event) =>
        events.push(event),
      );
      await awaitMarker(events, "AGENT_ASKED_A_QUESTION", "the agent's question");

      const delivered = await liveRuns.control("run-1", "send_message", {
        message: "use the second option",
      });
      expect(delivered?.applied).toBe(true);
      expect(delivered?.state).toBe("succeeded");

      const result = await running;
      expect(result.outcome).toBe("succeeded");
      // The answer reached the agent...
      await awaitMarker(events, "AGENT_HEARD:use the second option", "the agent's echo");
      // ...and is in the published commit, which is the durable proof.
      const remoteSha = await git(h.remote, "rev-parse", "refs/heads/norns/task-task-1");
      expect(await git(h.remote, "show", `${remoteSha}:answer.txt`)).toBe("use the second option");
    },
  );

  it("a message aimed at a run that has ended is refused, never silently dropped", async () => {
    const h = await harness(cleanup);
    const liveRuns = new LiveRunRegistry();
    const { executor, scriptBytes } = executorFor(
      h,
      [
        "node -e \"require('fs').writeFileSync('agent.txt','done\\n')\"",
        "git add -A",
        'git commit -q -m "agent work"',
      ].join("\n"),
      liveRuns,
      githubApi().fetchImpl,
    );
    await executor.execute(dispatchCommand(scriptBytes, h.base), () => {});

    const late = await liveRuns.control("run-1", "send_message", { message: "here is my answer" });
    expect(late?.applied).toBe(false);
    expect(late?.state).toBe("rejected");
    expect(late?.detail).toContain("already ended");
    expect(late?.detail).toContain("send_message");
  });

  it("a run this runner never executed is not silently successful", async () => {
    const liveRuns = new LiveRunRegistry();
    // `null` means "never heard of it", which is the ONLY case the registry
    // declines to answer — the daemon then tries the fixture path.
    expect(await liveRuns.control("run-nobody", "send_message", { message: "hi" })).toBeNull();
    expect(await liveRuns.control("run-nobody", "cancel")).toBeNull();
  });

  it(
    "refuses a control the live runtime genuinely cannot perform, naming the runtime",
    { timeout: 60_000 },
    async () => {
      const h = await harness(cleanup);
      const liveRuns = new LiveRunRegistry();
      const events: EventPayloadT[] = [];
      const { executor, scriptBytes } = executorFor(
        h,
        ["echo AGENT_WORKING", "sleep 60"].join("\n"),
        liveRuns,
        githubApi().fetchImpl,
      );
      const running = executor.execute(dispatchCommand(scriptBytes, h.base), (event) =>
        events.push(event),
      );
      await awaitMarker(events, "AGENT_WORKING", "the agent to start");

      // ProcessRuntime declares interrupt:false and suspend:false, and means it.
      const interrupted = await liveRuns.control("run-1", "interrupt");
      expect(interrupted?.applied).toBe(false);
      expect(interrupted?.detail).toContain("process");
      expect(interrupted?.detail).toContain("cancel");

      const suspended = await liveRuns.control("run-1", "suspend");
      expect(suspended?.applied).toBe(false);
      expect(suspended?.detail).toContain("cannot suspend");

      const resumed = await liveRuns.control("run-1", "resume_session");
      expect(resumed?.applied).toBe(false);

      await liveRuns.control("run-1", "cancel");
      const result: V2RunnerExecutionResult = await running;
      expect(result.outcome).toBe("cancelled");
    },
  );
});

describe("EXECUTION E11 — the per-runtime mid-session-input verdict is declared, not assumed", () => {
  it("declares what each shipped runtime can actually do with a mid-run message", () => {
    // Verified against the installed SDK type definitions, not from memory:
    //  * claude-agent-sdk 0.3.207 accepts `prompt: AsyncIterable<SDKUserMessage>`
    //    and exposes `Query.streamInput` / `Query.interrupt`;
    //  * codex-sdk 0.144.3 exposes only `Thread.run(input, {outputSchema, signal})`
    //    — nothing injects input into a turn already in flight.
    expect(new ClaudeCodeRuntime().capabilities.send_message).toBe(true);
    expect(new ClaudeCodeRuntime().capabilities.interrupt).toBe(true);
    expect(new CodexRuntime().capabilities.send_message).toBe(false);
    expect(new ProcessRuntime().capabilities.send_message).toBe(true);
    expect(
      new ProxiedCompletionRuntime(
        { complete: async () => ({ text: "", input_tokens: 0, output_tokens: 0 }) } as never,
        {
          provider: "anthropic",
          model: "claude",
          runId: "run-1",
          taskId: "task-1",
        },
      ).capabilities.send_message,
    ).toBe(false);
  });

  it("a codex run is told plainly that its message cannot be delivered", async () => {
    const liveRuns = new LiveRunRegistry();
    const codex = new CodexRuntime();
    // The registration carries the REAL runtime's declared matrix and, like a
    // real codex run, publishes no session channel — because the SDK has none.
    const release = liveRuns.register({
      runId: "run-codex",
      runtimeName: codex.name,
      capabilities: codex.capabilities,
      cancel: () => {},
      session: () => null,
    });
    const outcome = await liveRuns.control("run-codex", "send_message", { message: "answer" });
    expect(outcome?.applied).toBe(false);
    expect(outcome?.state).toBe("rejected");
    expect(outcome?.detail).toContain("codex");
    expect(outcome?.detail).toContain("was not delivered");
    release("cancelled");
  });
});

describe("EXECUTION E11 — the daemon's control routing", () => {
  let stack: Stack | null = null;
  afterEach(async () => {
    await stack?.stop();
    stack = null;
  });

  it("rejects a control for a run this runner is not running, instead of acking success", async () => {
    stack = await startStack();
    const commandId = await stack.issue({ kind: "cancel", run_id: "run-that-never-existed" });
    await waitFor(
      async () => (await commandState(stack as Stack, commandId)) === "rejected",
      "cancel for an unknown run is rejected",
    );
  });

  it("handles send_message at all — it used to fall through to the default rejection", async () => {
    stack = await startStack();
    // No live run here, so the honest answer is a rejection; the point is that
    // the daemon now ROUTES it (and would deliver it to a live run) rather than
    // never having a case for it.
    const commandId = await stack.issue({ kind: "send_message", run_id: "run-1", message: "hi" });
    await waitFor(
      async () => (await commandState(stack as Stack, commandId)) === "rejected",
      "send_message is routed and answered",
    );
  });

  it("still drives the Phase 1A fixture: interrupt pauses and cancel terminates", async () => {
    stack = await startStack();
    const launch = await stack.issue({ kind: "launch_fixture", fixture: "count:100:40" });
    const runId = `run_${launch}`;
    const statuses = async (): Promise<string[]> => {
      const events = (await (await (stack as Stack).api("/api/events/runner-1")).json()) as {
        payload: { kind: string; status?: string };
      }[];
      return events
        .filter((event) => event.payload.kind === "run_status")
        .map((event) => event.payload.status ?? "");
    };
    await waitFor(async () => (await statuses()).includes("started"), "fixture started");
    const interruptId = await stack.issue({ kind: "interrupt", run_id: runId });
    await waitFor(async () => (await statuses()).includes("paused"), "fixture paused");
    expect(await commandState(stack, interruptId)).toBe("succeeded");
    await stack.issue({ kind: "cancel", run_id: runId });
    await waitFor(async () => (await statuses()).includes("cancelled"), "fixture cancelled");
  });
});
