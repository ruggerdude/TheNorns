import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type EventPayloadT, V2DispatchCommand } from "@norns/contracts";
import {
  ApprovedRepositoryRegistry,
  type CodingRuntime,
  GitWorktreeManager,
  HashVerifiedContextLoader,
  type RunnerPublisher,
  RunnerStateFile,
  type RunnerVerifier,
  type RunnerWorktreeManager,
  V2RunnerExecutor,
} from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";

const COMMIT = "a".repeat(40);
// EXECUTION E4 — distinct from COMMIT. A worktree whose HEAD still equals the
// revision it started from is an EMPTY run, and the executor now refuses to
// call that a success, so a base revision equal to COMMIT would no longer
// model a run that did any work.
const BASE = "b".repeat(40);

describe("Phase 4 runner-owned execution", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("hash-verifies context, executes in an approved worktree, and emits structured evidence", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "norns-runner-test-"));
    cleanup.push(root);
    const repository = resolve(root, "repository");
    await mkdir(repository);
    const physicalRoot = await realpath(root);
    const physicalRepository = await realpath(repository);
    const registry = new ApprovedRepositoryRegistry([root]);
    registry.register({ repository_binding_id: "binding-1", repository_path: repository });
    const prompt = new TextEncoder().encode("Implement the verified task.");
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    const context = new HashVerifiedContextLoader({ fetch: async () => prompt });
    let worktreeCleaned = false;
    const worktrees: RunnerWorktreeManager = {
      prepare: async (input) => {
        expect(input.repository_path).toBe(physicalRepository);
        expect(input.expected_revision).toBe(COMMIT);
        return {
          path: resolve(root, "worktree"),
          base_revision: BASE,
          head: async () => COMMIT,
          cleanup: async () => {
            worktreeCleaned = true;
          },
        };
      },
    };
    let receivedPrompt = "";
    const runtime: CodingRuntime = {
      name: "codex",
      capabilities: {
        interrupt: true,
        suspend: false,
        resume_session: true,
        cancel: true,
        stop_after_current: true,
      },
      run: async (request) => {
        receivedPrompt = request.prompt;
        request.onLog?.(
          [
            `root=${root}`,
            `physical-root=${physicalRoot}`,
            `repository=${repository}`,
            `physical-repository=${physicalRepository}`,
            `worktree=${request.worktreePath}`,
          ].join(" "),
        );
        return {
          outcome: "completed",
          detail: "done",
          usage: {
            input_tokens: 100,
            output_tokens: 25,
            usage_source: "runtime_report",
          },
        };
      },
    };
    const verifier: RunnerVerifier = {
      verify: async (input) => {
        expect(input.expected_commit).toBe(COMMIT);
        expect(input.base_revision).toBe(BASE);
        return {
          passed: true,
          output: "all checks passed",
          command_results: [
            { name: "test", command: ["pnpm", "test"], exit_code: 0, passed: true, output: "ok" },
          ],
          reason: null,
          hygiene_only: false,
        };
      },
    };
    // EXECUTION E4 — the worktree may not be destroyed until the work is
    // durably published, so an executor without a publisher now fails the run.
    const publisher: RunnerPublisher = {
      publish: async (input) => ({
        outcome: "pushed",
        branch: input.branch,
        commit: input.commit,
        remote: "origin",
        pull_request_url: "https://github.test/pull/1",
        pull_request_note: null,
      }),
    };
    const executor = new V2RunnerExecutor(
      { id: "runner-1", generation: 3, scratch_root: root },
      registry,
      context,
      worktrees,
      new Map([["codex", runtime]]),
      verifier,
      undefined,
      publisher,
    );
    const command = V2DispatchCommand.parse({
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
      expected_revision: COMMIT,
      target_branch: "norns/task-1",
      worktree_policy_ref: "worktree-default",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5-codex",
      context_refs: [
        {
          artifact_id: "prompt-1",
          content_hash: promptHash,
          byte_size: prompt.byteLength,
          storage_ref: "relay://prompt-1",
        },
      ],
      budget_reservation_id: "reservation-1",
      max_charge_usd: 10,
      max_input_tokens: 10_000,
      max_output_tokens: 4_000,
      max_duration_seconds: 900,
      verification_policy_ref: "verification-default",
      sandbox_policy_ref: "sandbox-default",
      authorized_by: { actor_type: "human", actor_id: "admin-1" },
      authorized_by_session_id: "session-1",
      issued_at: "2026-07-16T20:00:00.000Z",
      expires_at: "2099-07-16T20:15:00.000Z",
    });
    const events: EventPayloadT[] = [];
    const successfulBuffer = new RunnerStateFile(resolve(root, "successful-runner-state"), {
      runner_id: "runner-1",
      private_key_pem: "test-only",
      generation: 3,
    });
    const result = await executor.execute(command, (event) => {
      events.push(event);
      successfulBuffer.bufferEvent({
        protocol: 1,
        event_seq: successfulBuffer.nextSeq(),
        runner_id: "runner-1",
        generation: 3,
        correlation_id: "correlation-1",
        causation_id: command.command_id,
        occurred_at: new Date().toISOString(),
        payload: event,
      });
    });
    expect(result).toMatchObject({
      outcome: "succeeded",
      commit_sha: COMMIT,
      verification_passed: true,
    });
    expect(receivedPrompt).toBe("Implement the verified task.");
    expect(worktreeCleaned).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "run_status", status: "started" }),
        expect.objectContaining({
          kind: "run_log",
          chunk: expect.stringContaining("[LOCAL_PATH]"),
        }),
        expect.objectContaining({ kind: "usage_report", input_tokens: 100 }),
        expect.objectContaining({ kind: "verification_result", passed: true, commit_sha: COMMIT }),
        expect.objectContaining({ kind: "run_status", status: "completed" }),
      ]),
    );
    for (const serialized of [
      JSON.stringify(events),
      JSON.stringify(successfulBuffer.state.buffer),
    ]) {
      expect(serialized).not.toContain(root);
      expect(serialized).not.toContain(repository);
      expect(serialized).not.toContain(physicalRoot);
      expect(serialized).not.toContain(physicalRepository);
    }

    const unapprovedLocalCommand = V2DispatchCommand.parse({
      ...command,
      dispatch_job_id: "job-unapproved-local",
      command_id: "dispatch:job-unapproved-local",
      idempotency_key: "dispatch:job-unapproved-local",
      run_id: "run-unapproved-local",
      runner_repository_id: "local:missing",
    });
    await expect(executor.execute(unapprovedLocalCommand, () => undefined)).rejects.toThrow(
      "runner repository is not approved on this runner",
    );

    // Git's native error includes the physical `-C` path. The execution
    // boundary must replace it before the event can enter the daemon buffer.
    const pathLeakEvents: EventPayloadT[] = [];
    const durableBuffer = new RunnerStateFile(resolve(root, "runner-state"), {
      runner_id: "runner-1",
      private_key_pem: "test-only",
      generation: 3,
    });
    const failingGitExecutor = new V2RunnerExecutor(
      { id: "runner-1", generation: 3, scratch_root: root },
      registry,
      context,
      new GitWorktreeManager(resolve(root, "worktrees")),
      new Map([["codex", runtime]]),
      verifier,
      undefined,
      publisher,
    );
    const failingGitCommand = V2DispatchCommand.parse({
      ...command,
      dispatch_job_id: "job-failing-git",
      command_id: "dispatch:job-failing-git",
      idempotency_key: "dispatch:job-failing-git",
      run_id: "run-failing-git",
    });
    await expect(
      failingGitExecutor.execute(failingGitCommand, (event) => {
        pathLeakEvents.push(event);
        durableBuffer.bufferEvent({
          protocol: 1,
          event_seq: durableBuffer.nextSeq(),
          runner_id: "runner-1",
          generation: 3,
          correlation_id: "correlation-failing-git",
          causation_id: failingGitCommand.command_id,
          occurred_at: new Date().toISOString(),
          payload: event,
        });
      }),
    ).resolves.toMatchObject({ outcome: "failed" });
    expect(pathLeakEvents).toContainEqual(
      expect.objectContaining({
        kind: "run_log",
        chunk: "runner execution failed; inspect the local runner diagnostics",
      }),
    );
    const serializedFailure = JSON.stringify(pathLeakEvents);
    expect(serializedFailure).not.toContain(root);
    expect(serializedFailure).not.toContain(repository);
    expect(serializedFailure).not.toContain(physicalRoot);
    expect(serializedFailure).not.toContain(physicalRepository);
    const serializedBuffer = JSON.stringify(durableBuffer.state.buffer);
    expect(serializedBuffer).not.toContain(root);
    expect(serializedBuffer).not.toContain(repository);
    expect(serializedBuffer).not.toContain(physicalRoot);
    expect(serializedBuffer).not.toContain(physicalRepository);
  });
});
