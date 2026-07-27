import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type CommandEnvelopeT,
  type EventEnvelopeT,
  type EventPayloadT,
  V2DispatchCommand,
  V2_HUMAN_WAIT_CHANNEL_VERSION,
  V2_HUMAN_WAIT_INSTRUCTION,
  V2_HUMAN_WAIT_INSTRUCTION_HASH,
} from "@norns/contracts";
import {
  ApprovedRepositoryRegistry,
  type CodingRuntime,
  CommandPolicyVerifier,
  GitWorktreeManager,
  HashVerifiedContextLoader,
  RunnerDaemon,
  type RunnerPublisher,
  RunnerStateFile,
  V2RunnerExecutor,
} from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { waitFor } from "./helpers.js";

const execFileAsync = promisify(execFile);
const PROMPT = new TextEncoder().encode("Implement the checkpoint and ask only if blocked.");
const HASH = createHash("sha256").update(PROMPT).digest("hex");
const ENVELOPE = {
  schema_version: 1,
  kind: "human_wait",
  decision_point: "Deployment window",
  question: "Should the migration run before deployment?",
  compact_summary: "The migration is committed and needs a deployment-window decision.",
} as const;
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

interface RunnerHarness {
  root: string;
  repository: string;
  worktreeRoot: string;
  registry: ApprovedRepositoryRegistry;
  base: string;
}

async function runnerHarness(cleanup: string[], label: string): Promise<RunnerHarness> {
  const root = await mkdtemp(resolve(tmpdir(), `norns phase5 ${label} `));
  cleanup.push(root);
  const repository = resolve(root, "repository with spaces");
  await mkdir(repository, { recursive: true });
  await execFileAsync("git", ["init", "--initial-branch=main", repository], { env: GIT_ENV });
  await writeFile(resolve(repository, "seed.txt"), "seed\n");
  await git(repository, "add", "-A");
  await git(repository, "commit", "-m", "seed");
  const registry = new ApprovedRepositoryRegistry([root]);
  registry.register({ repository_binding_id: "binding-1", repository_path: repository });
  return {
    root,
    repository,
    worktreeRoot: resolve(root, "worktrees with spaces"),
    registry,
    base: await git(repository, "rev-parse", "HEAD"),
  };
}

function command(base: string, suffix: string, overrides: Record<string, unknown> = {}) {
  return V2DispatchCommand.parse({
    schema_version: 2,
    protocol_version: 2,
    kind: "launch_run",
    dispatch_job_id: `job-${suffix}`,
    command_id: `dispatch:job-${suffix}`,
    delivery_attempt: 1,
    idempotency_key: `dispatch:job-${suffix}`,
    correlation_id: `correlation-${suffix}`,
    causation_id: null,
    project_id: "project-1",
    phase_id: "phase-1",
    task_id: "task-1",
    assignment_id: "assignment-1",
    run_id: `run-${suffix}`,
    runner_id: "runner-1",
    runner_generation: 3,
    repository_binding_id: "binding-1",
    expected_revision: base,
    target_branch: `norns/task-${suffix}`,
    worktree_policy_ref: "worktree-default",
    runtime: "test-runtime",
    provider: "openai",
    model: "gpt-5.6-sol",
    context_refs: [
      {
        artifact_id: "prompt-1",
        content_hash: HASH,
        byte_size: PROMPT.byteLength,
        storage_ref: "relay://prompt-1",
      },
    ],
    human_wait_channel: {
      version: V2_HUMAN_WAIT_CHANNEL_VERSION,
      instruction_hash: V2_HUMAN_WAIT_INSTRUCTION_HASH,
    },
    budget_reservation_id: "reservation-1",
    max_charge_usd: 10,
    max_input_tokens: 10_000,
    max_output_tokens: 4_000,
    max_duration_seconds: 900,
    verification_policy_ref: "verification",
    sandbox_policy_ref: "sandbox-default",
    authorized_by: { actor_type: "human", actor_id: "admin-1" },
    authorized_by_session_id: "session-1",
    issued_at: "2026-07-27T12:00:00.000Z",
    expires_at: "2099-07-27T12:15:00.000Z",
    ...overrides,
  });
}

function runtime(
  writeControl: (request: Parameters<CodingRuntime["run"]>[0]) => Promise<void>,
): CodingRuntime {
  return {
    name: "test-runtime",
    capabilities: {
      interrupt: false,
      suspend: false,
      resume_session: false,
      cancel: true,
      stop_after_current: false,
      send_message: false,
    },
    run: async (request) => {
      await writeControl(request);
      return {
        outcome: "completed",
        detail: "runtime returned after writing its typed control envelope",
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          usage_source: "runtime_report",
        },
        sessionId: "provider-session-1",
      };
    },
  };
}

function pushedPublisher(calls: Array<{ worktree: string; commit: string }>): RunnerPublisher {
  return {
    publish: async (input) => {
      calls.push({ worktree: input.worktree_path, commit: input.commit });
      return {
        outcome: "pushed",
        branch: input.branch,
        commit: input.commit,
        remote: "origin",
        pull_request_url: null,
        pull_request_note: "Checkpoint branch pushed without a pull request.",
      };
    },
  };
}

function executor(
  harness: RunnerHarness,
  codingRuntime: CodingRuntime,
  publisher?: RunnerPublisher,
): V2RunnerExecutor {
  return new V2RunnerExecutor(
    { id: "runner-1", generation: 3, scratch_root: harness.root },
    harness.registry,
    new HashVerifiedContextLoader({ fetch: async () => PROMPT }),
    new GitWorktreeManager(harness.worktreeRoot),
    new Map([["test-runtime", codingRuntime]]),
    new CommandPolicyVerifier(new Map([["verification", []]])),
    undefined,
    publisher,
  );
}

function writeEnvelope(path: string): Promise<void> {
  return writeFile(path, JSON.stringify(ENVELOPE), { mode: 0o600 });
}

describe("Phase 5 runner human-wait acceptance", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("accepts the audited channel in paths with spaces, publishes before asking, and releases the worktree", async () => {
    const harness = await runnerHarness(cleanup, "spaces");
    const publications: Array<{ worktree: string; commit: string }> = [];
    const events: EventPayloadT[] = [];
    let controlPath = "";
    let receivedPrompt = "";
    const result = await executor(
      harness,
      runtime(async (request) => {
        controlPath = request.humanWaitPath ?? "";
        receivedPrompt = request.prompt;
        await writeEnvelope(controlPath);
      }),
      pushedPublisher(publications),
    ).execute(command(harness.base, "spaces"), (event) => events.push(event));

    expect(result).toMatchObject({
      outcome: "waiting_for_human",
      verification_passed: false,
      session_id: "provider-session-1",
    });
    expect(receivedPrompt).toContain(V2_HUMAN_WAIT_INSTRUCTION);
    expect(controlPath).toContain("worktrees with spaces");
    expect(publications).toHaveLength(1);
    const kinds = events.map((event) => event.kind);
    expect(kinds.indexOf("run_published")).toBeGreaterThan(-1);
    expect(kinds.indexOf("human_wait_requested")).toBeGreaterThan(kinds.indexOf("run_published"));
    expect(
      events.findIndex(
        (event) => event.kind === "run_status" && event.status === "waiting_for_human",
      ),
    ).toBeGreaterThan(kinds.indexOf("human_wait_requested"));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "human_wait_requested",
          question: ENVELOPE.question,
          ask_channel_version: V2_HUMAN_WAIT_CHANNEL_VERSION,
          ask_instruction_hash: V2_HUMAN_WAIT_INSTRUCTION_HASH,
        }),
      ]),
    );
    const publication = publications[0];
    if (!publication) throw new Error("missing checkpoint publication");
    await expect(stat(publication.worktree)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a typed wait from a legacy command that did not authorize the ask channel", async () => {
    const harness = await runnerHarness(cleanup, "legacy");
    const events: EventPayloadT[] = [];
    const result = await executor(
      harness,
      runtime(async (request) => writeEnvelope(request.humanWaitPath ?? "")),
      pushedPublisher([]),
    ).execute(command(harness.base, "legacy", { human_wait_channel: undefined }), (event) =>
      events.push(event),
    );

    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/without an audited ask channel/i);
    expect(events.some((event) => event.kind === "human_wait_requested")).toBe(false);
    expect(events.some((event) => event.kind === "run_published")).toBe(false);
  });

  it.each([
    [
      "malformed JSON",
      async (path: string) => {
        await writeFile(path, "{not-json");
      },
    ],
    [
      "an extra field",
      async (path: string) => {
        await writeFile(path, JSON.stringify({ ...ENVELOPE, hidden_reasoning: "never persist" }));
      },
    ],
    [
      "an oversized envelope",
      async (path: string) => {
        await writeFile(path, "x".repeat(32_769));
      },
    ],
    [
      "a symbolic link",
      async (path: string) => {
        const target = `${path}.target`;
        await writeEnvelope(target);
        await symlink(target, path);
      },
    ],
  ])("rejects %s without publishing or opening a wait", async (label, writer) => {
    const harness = await runnerHarness(cleanup, label.replaceAll(" ", "-"));
    const publications: Array<{ worktree: string; commit: string }> = [];
    const events: EventPayloadT[] = [];
    const result = await executor(
      harness,
      runtime(async (request) => writer(request.humanWaitPath ?? "")),
      pushedPublisher(publications),
    ).execute(command(harness.base, `invalid-${publications.length}-${label.length}`), (event) =>
      events.push(event),
    );

    expect(result.outcome).toBe("failed");
    expect(publications).toHaveLength(0);
    expect(events.some((event) => event.kind === "human_wait_requested")).toBe(false);
  });

  it("rejects dirty and untracked work instead of releasing an unresumable checkpoint", async () => {
    const harness = await runnerHarness(cleanup, "dirty");
    const publications: Array<{ worktree: string; commit: string }> = [];
    const events: EventPayloadT[] = [];
    const result = await executor(
      harness,
      runtime(async (request) => {
        await writeFile(resolve(request.worktreePath, "untracked work.txt"), "not committed\n");
        await writeEnvelope(request.humanWaitPath ?? "");
      }),
      pushedPublisher(publications),
    ).execute(command(harness.base, "dirty"), (event) => events.push(event));

    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("uncommitted path");
    expect(publications).toHaveLength(0);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "run_status",
          status: "failed",
          failure: expect.objectContaining({ code: "human_wait_checkpoint_unpublished" }),
        }),
      ]),
    );
  });

  it("rejects a tracked modified file instead of publishing a partial checkpoint", async () => {
    const harness = await runnerHarness(cleanup, "tracked-dirty");
    const publications: Array<{ worktree: string; commit: string }> = [];
    const events: EventPayloadT[] = [];
    const result = await executor(
      harness,
      runtime(async (request) => {
        await writeFile(resolve(request.worktreePath, "seed.txt"), "tracked but not committed\n");
        await writeEnvelope(request.humanWaitPath ?? "");
      }),
      pushedPublisher(publications),
    ).execute(command(harness.base, "tracked-dirty"), (event) => events.push(event));

    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("uncommitted path");
    expect(publications).toHaveLength(0);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "run_status",
          status: "failed",
          failure: expect.objectContaining({ code: "human_wait_checkpoint_unpublished" }),
        }),
      ]),
    );
  });

  it("rejects a control envelope committed into the repository", async () => {
    const harness = await runnerHarness(cleanup, "committed-control");
    const publications: Array<{ worktree: string; commit: string }> = [];
    const events: EventPayloadT[] = [];
    const result = await executor(
      harness,
      runtime(async (request) => {
        const path = request.humanWaitPath ?? "";
        await writeEnvelope(path);
        await git(request.worktreePath, "add", relative(request.worktreePath, path));
        await git(request.worktreePath, "commit", "-m", "maliciously commit control envelope");
      }),
      pushedPublisher(publications),
    ).execute(command(harness.base, "committed-control"), (event) => events.push(event));

    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("control envelope was committed");
    expect(publications).toHaveLength(0);
    expect(events.some((event) => event.kind === "human_wait_requested")).toBe(false);
  });

  it.each([
    ["no publisher", undefined],
    [
      "local-only publisher",
      {
        publish: async (input: Parameters<RunnerPublisher["publish"]>[0]) => ({
          outcome: "local_only" as const,
          branch: input.branch,
          commit: input.commit,
          remote: null,
          pull_request_url: null,
          pull_request_note: "No remote configured.",
        }),
      } satisfies RunnerPublisher,
    ],
  ])("refuses %s because a human checkpoint must survive the runner", async (label, publisher) => {
    const harness = await runnerHarness(cleanup, label.replaceAll(" ", "-"));
    const events: EventPayloadT[] = [];
    const result = await executor(
      harness,
      runtime(async (request) => writeEnvelope(request.humanWaitPath ?? "")),
      publisher,
    ).execute(command(harness.base, `publisher-${label.length}`), (event) => events.push(event));

    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/publisher|remotely pushed checkpoint/i);
    expect(events.some((event) => event.kind === "human_wait_requested")).toBe(false);
  });
});

describe("Phase 5 runner wait terminal protocol", () => {
  let daemon: RunnerDaemon | null = null;
  let server: WebSocketServer | null = null;
  const cleanup: string[] = [];

  afterEach(async () => {
    daemon?.stop();
    daemon = null;
    if (server) {
      await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
      server = null;
    }
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("replays identical causal wait events after disconnect, then prunes them only after acknowledgement", async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), "norns-phase5-daemon-"));
    cleanup.push(dataDir);
    const { privateKey } = generateKeyPairSync("ed25519");
    const state = new RunnerStateFile(dataDir, {
      runner_id: "runner-1",
      private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      generation: 3,
    });
    const dispatch = command("a".repeat(40), "daemon");
    const launch: CommandEnvelopeT = {
      protocol: 1,
      command_id: dispatch.command_id,
      idempotency_key: dispatch.command_id,
      correlation_id: dispatch.correlation_id,
      causation_id: null,
      project_id: dispatch.project_id,
      runner_id: dispatch.runner_id,
      generation: dispatch.runner_generation,
      issued_by_session: "session-1",
      issued_at: "2026-07-27T12:00:00.000Z",
      expires_at: "2099-07-27T12:15:00.000Z",
      payload: {
        kind: "launch_run",
        node_id: dispatch.task_id,
        run_id: dispatch.run_id,
        prompt_ref: "relay://prompt-1",
        dispatch,
      },
    };
    const receivedByConnection: EventEnvelopeT[][] = [];
    const settled: Array<{ command_id: string; state: string }> = [];
    let connectionCount = 0;
    let firstTerminalSnapshot: EventEnvelopeT[] = [];

    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolveListening) =>
      server?.once("listening", () => resolveListening()),
    );
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test port");
    server.on("connection", (socket) => {
      connectionCount += 1;
      const connectionIndex = connectionCount - 1;
      receivedByConnection[connectionIndex] = [];
      socket.send(JSON.stringify({ type: "challenge", nonce: `phase5-nonce-${connectionCount}` }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as {
          type: string;
          event?: EventEnvelopeT;
        };
        if (frame.type === "auth") {
          socket.send(JSON.stringify({ type: "auth_ok" }));
          return;
        }
        if (frame.type === "reconcile_request") {
          socket.send(
            JSON.stringify({
              type: "reconcile_response",
              body: {
                protocol: 1,
                ack_event_seq: 0,
                generation: 3,
                resend_commands: connectionCount === 1 ? [launch] : [],
                capabilities: [],
              },
            }),
          );
          return;
        }
        if (frame.type === "event" && frame.event) {
          receivedByConnection[connectionIndex]?.push(frame.event);
          if (
            connectionCount === 1 &&
            frame.event.payload.kind === "command_ack" &&
            frame.event.payload.state === "waiting_for_human"
          ) {
            firstTerminalSnapshot = [...(receivedByConnection[0] ?? [])];
            setTimeout(() => socket.close(), 5);
          }
          if (
            connectionCount === 2 &&
            firstTerminalSnapshot.length > 0 &&
            (receivedByConnection[1]?.length ?? 0) >= firstTerminalSnapshot.length
          ) {
            socket.send(
              JSON.stringify({
                type: "event_ack",
                ack_event_seq: firstTerminalSnapshot.at(-1)?.event_seq ?? 0,
              }),
            );
          }
        }
      });
    });

    daemon = new RunnerDaemon({
      serverUrl: `http://127.0.0.1:${address.port}`,
      runnerId: "runner-1",
      dataDir,
      heartbeatMs: 60_000,
      reconnectDelayMs: 10,
      executeV2: async (receivedDispatch, emit) => {
        emit({
          kind: "run_published",
          run_id: receivedDispatch.run_id,
          outcome: "pushed",
          branch: receivedDispatch.target_branch,
          commit_sha: receivedDispatch.expected_revision,
          remote: "origin",
          pull_request_url: null,
          pull_request_note: "Checkpoint only.",
        });
        emit({
          kind: "human_wait_requested",
          run_id: receivedDispatch.run_id,
          decision_point: ENVELOPE.decision_point,
          question: ENVELOPE.question,
          question_hash: createHash("sha256").update(ENVELOPE.question).digest("hex"),
          compact_summary: ENVELOPE.compact_summary,
          compact_summary_hash: createHash("sha256").update(ENVELOPE.compact_summary).digest("hex"),
          runtime: receivedDispatch.runtime,
          session_id: null,
          ask_channel_version: V2_HUMAN_WAIT_CHANNEL_VERSION,
          ask_instruction_hash: V2_HUMAN_WAIT_INSTRUCTION_HASH,
        });
        emit({
          kind: "run_status",
          run_id: receivedDispatch.run_id,
          status: "waiting_for_human",
        });
        return "waiting_for_human";
      },
      onRunSettled: (result) => settled.push(result),
    });
    daemon.loadState();
    daemon.connect();

    await waitFor(
      () =>
        (receivedByConnection[0] ?? []).some(
          (event) =>
            event.payload.kind === "command_ack" && event.payload.state === "waiting_for_human",
        ),
      "durable human-wait terminal acknowledgement",
    );
    await waitFor(
      () =>
        connectionCount >= 2 &&
        firstTerminalSnapshot.length > 0 &&
        (receivedByConnection[1]?.length ?? 0) >= firstTerminalSnapshot.length,
      "identical buffered wait replay after reconnect",
    );

    const waitEvents = firstTerminalSnapshot.filter((event) =>
      ["run_published", "human_wait_requested", "run_status"].includes(event.payload.kind),
    );
    expect(waitEvents.map((event) => event.payload.kind)).toEqual([
      "run_published",
      "human_wait_requested",
      "run_status",
    ]);
    expect(waitEvents.every((event) => event.causation_id === dispatch.command_id)).toBe(true);
    expect(settled).toEqual([{ command_id: dispatch.command_id, state: "waiting_for_human" }]);
    expect((receivedByConnection[1] ?? []).slice(0, firstTerminalSnapshot.length)).toEqual(
      firstTerminalSnapshot,
    );
    await waitFor(() => {
      const replayed = new RunnerStateFile(dataDir, {
        runner_id: "runner-1",
        private_key_pem: "",
        generation: 0,
      });
      return replayed.state.buffer.length === 0;
    }, "server event acknowledgement pruned the replay");
    const persisted = new RunnerStateFile(dataDir, {
      runner_id: "runner-1",
      private_key_pem: "",
      generation: 0,
    });
    expect(persisted.state.buffer).toHaveLength(0);
    expect(persisted.executionState(dispatch.command_id)).toBe("waiting_for_human");
  });

  it("settles a replayed terminal launch once after daemon restart without re-executing", async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), "norns-phase5-restart-"));
    cleanup.push(dataDir);
    const { privateKey } = generateKeyPairSync("ed25519");
    const seeded = new RunnerStateFile(dataDir, {
      runner_id: "runner-1",
      private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      generation: 3,
    });
    const dispatch = command("a".repeat(40), "restart");
    seeded.recordExecution(dispatch.command_id, "waiting_for_human");
    const launch: CommandEnvelopeT = {
      protocol: 1,
      command_id: dispatch.command_id,
      idempotency_key: dispatch.command_id,
      correlation_id: dispatch.correlation_id,
      causation_id: null,
      project_id: dispatch.project_id,
      runner_id: dispatch.runner_id,
      generation: dispatch.runner_generation,
      issued_by_session: "session-1",
      issued_at: "2026-07-27T12:00:00.000Z",
      expires_at: "2099-07-27T12:15:00.000Z",
      payload: {
        kind: "launch_run",
        node_id: dispatch.task_id,
        run_id: dispatch.run_id,
        prompt_ref: "relay://prompt-1",
        dispatch,
      },
    };
    let executions = 0;
    const settled: Array<{ command_id: string; state: string }> = [];
    const received: EventEnvelopeT[] = [];
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolveListening) =>
      server?.once("listening", () => resolveListening()),
    );
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test port");
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "challenge", nonce: "phase5-restart-nonce" }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as { type: string; event?: EventEnvelopeT };
        if (frame.type === "auth") {
          socket.send(JSON.stringify({ type: "auth_ok" }));
          return;
        }
        if (frame.type === "reconcile_request") {
          socket.send(
            JSON.stringify({
              type: "reconcile_response",
              body: {
                protocol: 1,
                ack_event_seq: 0,
                generation: 3,
                resend_commands: [launch, launch],
              },
            }),
          );
          return;
        }
        if (frame.type === "event" && frame.event) received.push(frame.event);
      });
    });
    daemon = new RunnerDaemon({
      serverUrl: `http://127.0.0.1:${address.port}`,
      runnerId: "runner-1",
      dataDir,
      heartbeatMs: 60_000,
      reconnect: false,
      executeV2: async () => {
        executions += 1;
        return "failed";
      },
      onRunSettled: (result) => settled.push(result),
    });
    daemon.loadState();
    daemon.connect();

    await waitFor(() => settled.length === 1, "replayed terminal launch settlement");
    expect(executions).toBe(0);
    expect(settled).toEqual([{ command_id: dispatch.command_id, state: "waiting_for_human" }]);
    expect(
      received.filter(
        (event) =>
          event.payload.kind === "command_ack" && event.payload.state === "waiting_for_human",
      ),
    ).toHaveLength(1);
    const persisted = new RunnerStateFile(dataDir, {
      runner_id: "runner-1",
      private_key_pem: "",
      generation: 0,
    });
    expect(persisted.state.seq).toBe(1);
    expect(persisted.executionState(dispatch.command_id)).toBe("waiting_for_human");
  });
});
