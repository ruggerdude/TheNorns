import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type EventPayloadT, V2DispatchCommand } from "@norns/contracts";
import {
  ApprovedRepositoryRegistry,
  type CodingRuntime,
  HashVerifiedContextLoader,
  type RunnerVerifier,
  type RunnerWorktreeManager,
  V2RunnerExecutor,
} from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";

const COMMIT = "a".repeat(40);

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
    const registry = new ApprovedRepositoryRegistry([root]);
    registry.register({ repository_binding_id: "binding-1", repository_path: repository });
    const prompt = new TextEncoder().encode("Implement the verified task.");
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    const context = new HashVerifiedContextLoader({ fetch: async () => prompt });
    let worktreeCleaned = false;
    const worktrees: RunnerWorktreeManager = {
      prepare: async (input) => {
        expect(input.repository_path).toBe(repository);
        expect(input.expected_revision).toBe(COMMIT);
        return {
          path: resolve(root, "worktree"),
          base_revision: COMMIT,
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
        request.onLog?.("implemented task");
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
        return { passed: true, output: "all checks passed" };
      },
    };
    const executor = new V2RunnerExecutor(
      { id: "runner-1", generation: 3, scratch_root: root },
      registry,
      context,
      worktrees,
      new Map([["codex", runtime]]),
      verifier,
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
    const result = await executor.execute(command, (event) => events.push(event));
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
        expect.objectContaining({ kind: "run_log", chunk: "implemented task" }),
        expect.objectContaining({ kind: "usage_report", input_tokens: 100 }),
        expect.objectContaining({ kind: "verification_result", passed: true, commit_sha: COMMIT }),
        expect.objectContaining({ kind: "run_status", status: "completed" }),
      ]),
    );
  });
});
