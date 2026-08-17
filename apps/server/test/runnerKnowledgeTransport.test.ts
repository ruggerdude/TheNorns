import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import {
  ApprovedRepositoryRegistry,
  type CodingRuntime,
  HashVerifiedContextLoader,
  type RunnerPublisher,
  type RunnerVerifier,
  type RunnerWorktreeManager,
  V2RunnerExecutor,
} from "@norns/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { Phase4DispatchRepository } from "../src/coordinator/phase4Dispatcher.js";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import { KnowledgeSystemService } from "../src/knowledge/service.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const COMMIT = "c".repeat(40);
const PROMPT = new TextEncoder().encode("Implement and verify the assigned task.");
const PROMPT_HASH = createHash("sha256").update(PROMPT).digest("hex");
const execFileAsync = promisify(execFile);

describe.sequential("runner knowledge transport", () => {
  let pg: PGlite;
  let root: string;
  let repository: string;
  let transactions: PGliteTransactionRunner;
  let coordinator: Phase4Coordinator;

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), "norns-knowledge-transport-"));
    repository = resolve(root, "repository");
    await mkdir(repository);
    pg = new PGlite();
    await pg.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO projects (
        id, name, description, status, assignment_policy_ref,
        verification_policy_ref, budget_policy_ref
      ) VALUES ('project-kt','Knowledge Transport','','active','assignment','verification','budget');
      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, granted_permissions,
        default_branch, observed_head, verification_policy_ref,
        repository_health, created_by_actor_type, created_by_actor_id
      ) VALUES ('binding-kt','project-kt','local_runner','connected','runner-kt',
        'workspace-kt','repository-kt','Knowledge Transport','{}'::jsonb,'main','base-kt',
        'verification','healthy','human','admin-kt');
      UPDATE projects SET primary_repository_binding_id='binding-kt' WHERE id='project-kt';
      INSERT INTO phases (
        id, project_id, objective_summary, priority, status, approved_budget_usd
      ) VALUES ('phase-kt','project-kt','Exercise knowledge transport',1,'awaiting_approval',20);
      INSERT INTO strategy_versions (
        id, project_id, phase_id, version, status, objective, content,
        convergence, review_rounds, content_hash
      ) VALUES ('strategy-kt','project-kt','phase-kt',1,'approved','Exercise transport',
        '{}'::jsonb,'converged',1,repeat('a',64));
      UPDATE phases SET status='approved', approved_strategy_version_id='strategy-kt'
        WHERE id='phase-kt';
      INSERT INTO objectives (
        id, project_id, phase_id, outcome, success_measures, status, "order"
      ) VALUES ('objective-kt','project-kt','phase-kt','Transport durable evidence',
        '["knowledge persists"]'::jsonb,'active',0);
      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id, title,
        description, deliverables, acceptance_criteria, complexity, risk,
        required_roles, required_capabilities, required_inputs, expected_outputs,
        environment_policy_ref, verification_policy_ref, state, lifecycle_version
      ) VALUES ('task-kt','project-kt','phase-kt','objective-kt','strategy-kt','Do work',
        'Create durable evidence','["verified change"]'::jsonb,
        '["the implementation is verified"]'::jsonb,'M','medium',
        '["implementation"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["commit"]'::jsonb,
        'environment','verification','pending',0);
      INSERT INTO agent_profiles (
        id, provider, runtime, model, roles, capabilities, context_limit_tokens,
        security_restrictions, status, active_workload, cost_metadata
      ) VALUES ('agent-kt','openai','codex','gpt-5-codex','["implementation"]'::jsonb,
        '["typescript"]'::jsonb,200000,'[]'::jsonb,'available',0,'{}'::jsonb);
      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
        rationale_factors, budget_limit_usd, allocation_policy_ref
      ) VALUES ('assignment-kt','project-kt','phase-kt','task-kt','agent-kt','proposed',
        'Knowledge transport fixture','["capability"]'::jsonb,10,'allocation');
      INSERT INTO task_coordination_constraints (
        task_id, project_id, phase_id, conflict_keys, estimated_context_tokens,
        requires_independent_review, critical_path_weight, conflict_scope_declared
      ) VALUES ('task-kt','project-kt','phase-kt','[]'::jsonb,1000,false,1,true);
    `);
    transactions = new PGliteTransactionRunner(pg);
    coordinator = new Phase4Coordinator(transactions);
    const knowledge = new KnowledgeSystemService(transactions);
    const taskPackage = await knowledge.createTaskPackage({
      task_id: "task-kt",
      status: "approved",
      assignment: "Create durable execution evidence.",
      expected_outcome: "The implementation is verified.",
      business_or_user_outcome: "Operators receive a reliable handoff.",
      scope: ["Implementation"],
      out_of_scope: [],
      deliverables: ["verified change"],
      file_scope_declared: true,
      permitted_files: ["src/index.ts"],
      restricted_files: [],
      required_package_ids: [],
      required_interface_contract_ids: [],
      required_decision_record_ids: [],
      dependencies: [],
      acceptance_criteria: ["the implementation is verified"],
      required_tests: ["pnpm test"],
      performance_requirements: [],
      accessibility_requirements: [],
      reporting_interval_seconds: 60,
      escalation_conditions: ["verification failure"],
      completion_format: "Structured handoff",
      branch_or_workspace: "norns/task-kt",
      token_budget: 14_000,
      actor: { actor_type: "human", actor_id: "admin-kt" },
      created_at: "2026-07-25T12:00:00.000Z",
    });
    await pg.query(
      `INSERT INTO task_context_manifests (
         id, project_id, phase_id, task_id, task_package_id, repository_commit,
         content, content_hash, generated_by_actor_type, generated_by_actor_id,
         estimated_tokens, generated_at
       ) VALUES (
         'manifest-kt','project-kt','phase-kt','task-kt',$1,'base-kt',
         '{}'::jsonb,$2,'coordinator','coordinator-kt',100,'2026-07-25T12:01:00.000Z'
       )`,
      [taskPackage.id, "f".repeat(64)],
    );
  });

  afterEach(async () => {
    await pg.close();
    await rm(root, { recursive: true, force: true });
  });

  async function scheduledRun() {
    const scheduled = await coordinator.schedule({
      project_id: "project-kt",
      phase_id: "phase-kt",
      task_id: "task-kt",
      assignment_id: "assignment-kt",
      runner_id: "runner-kt",
      runner_generation: 3,
      authorized_by: { actor_type: "human", actor_id: "admin-kt" },
      authorized_by_session_id: "session-kt",
      correlation_id: "correlation-kt",
      causation_id: null,
      context_refs: [
        {
          artifact_id: "prompt-kt",
          content_hash: PROMPT_HASH,
          byte_size: PROMPT.byteLength,
          storage_ref: "relay://prompt-kt",
        },
      ],
      target_branch: "norns/task-kt",
      worktree_policy_ref: "worktree-default",
      sandbox_policy_ref: "sandbox-default",
      max_input_tokens: 10_000,
      max_output_tokens: 4_000,
      max_duration_seconds: 900,
      issued_at: "2026-07-25T12:02:00.000Z",
      expires_at: "2099-07-25T12:17:00.000Z",
    });
    const dispatch = new Phase4DispatchRepository(transactions);
    await dispatch.claim("dispatcher-kt", 30_000);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-kt",
      "2026-07-25T12:03:00.000Z",
    );
    return scheduled;
  }

  function executor(runtime: CodingRuntime, verificationPassed: boolean): V2RunnerExecutor {
    const registry = new ApprovedRepositoryRegistry([root]);
    registry.register({ repository_binding_id: "binding-kt", repository_path: repository });
    const worktrees: RunnerWorktreeManager = {
      prepare: async () => {
        const worktreePath = resolve(root, "worktree");
        await mkdir(worktreePath, { recursive: true });
        await execFileAsync("git", ["init", worktreePath]);
        return {
          path: worktreePath,
          base_revision: "base-kt",
          head: async () => COMMIT,
          cleanup: async () => undefined,
        };
      },
    };
    const verifier: RunnerVerifier = {
      verify: async () => ({
        passed: verificationPassed,
        output: verificationPassed ? "all checks passed" : "test failed",
        command_results: [
          {
            name: "test",
            command: ["pnpm", "test"],
            exit_code: verificationPassed ? 0 : 1,
            passed: verificationPassed,
            output: verificationPassed ? "ok" : "failure",
            process_tree_reaped: true,
          },
        ],
        reason: verificationPassed ? null : "test failed",
        hygiene_only: false,
        process_tree_reaped: true,
      }),
    };
    const publisher: RunnerPublisher = {
      publish: async (input) => ({
        outcome: "pushed",
        branch: input.branch,
        commit: input.commit,
        remote: "origin",
        pull_request_url: "https://github.test/pull/knowledge",
        pull_request_note: null,
      }),
    };
    return new V2RunnerExecutor(
      { id: "runner-kt", generation: 3, scratch_root: resolve(root, "scratch") },
      registry,
      new HashVerifiedContextLoader({ fetch: async () => PROMPT }),
      worktrees,
      new Map([["codex", runtime]]),
      verifier,
      undefined,
      publisher,
    );
  }

  async function executeAndApply(
    runtime: CodingRuntime,
    verificationPassed: boolean,
  ): Promise<{ payloads: unknown[]; duplicateResults: unknown[] }> {
    const scheduled = await scheduledRun();
    const { runner_repository_id: _runnerRepositoryId, ...runnerCommand } = scheduled.command;
    const payloads: Parameters<Phase4EventProcessor["apply"]>[0]["payload"][] = [];
    const result = await executor(runtime, verificationPassed).execute(
      runnerCommand,
      (payload) => payloads.push(payload),
      { knowledge_transport: true },
    );
    expect(result.outcome).toBe(verificationPassed ? "succeeded" : "failed");
    const processor = new Phase4EventProcessor(transactions);
    const envelopes = payloads.map((payload, index) => ({
      protocol: 1 as const,
      event_seq: index + 1,
      runner_id: "runner-kt",
      generation: 3,
      correlation_id: "correlation-kt",
      causation_id: scheduled.command_id,
      occurred_at: new Date(Date.UTC(2026, 6, 25, 12, 4, index)).toISOString(),
      payload,
    }));
    for (const envelope of envelopes) {
      await expect(processor.apply(envelope)).resolves.toEqual({ duplicate: false });
    }
    const duplicateResults = [];
    for (const envelope of envelopes) {
      duplicateResults.push(await processor.apply(envelope));
    }
    return { payloads, duplicateResults };
  }

  it("persists real runner registration, progress, delta, handoff, and completion-gate evidence once", async () => {
    const runtime: CodingRuntime = {
      name: "codex",
      capabilities: {
        interrupt: true,
        suspend: false,
        resume_session: true,
        cancel: true,
        stop_after_current: true,
        send_message: false,
      },
      run: async () => ({
        outcome: "completed",
        detail: "implementation complete",
        usage: { input_tokens: 100, output_tokens: 25, usage_source: "runtime_report" },
      }),
    };
    const { payloads, duplicateResults } = await executeAndApply(runtime, true);
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "knowledge_registration" }),
        expect.objectContaining({ kind: "knowledge_heartbeat", status: "working" }),
        expect.objectContaining({ kind: "knowledge_delta" }),
        expect.objectContaining({ kind: "knowledge_handoff", status: "completed" }),
      ]),
    );
    expect(duplicateResults).toEqual(payloads.map(() => ({ duplicate: true })));
    const persisted = await pg.query<{
      registrations: number;
      heartbeats: number;
      deltas: number;
      handoffs: number;
      gates: number;
      gate_passed: boolean;
      registration_status: string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM agent_execution_registrations) AS registrations,
         (SELECT count(*)::int FROM agent_status_heartbeats) AS heartbeats,
         (SELECT count(*)::int FROM knowledge_deltas) AS deltas,
         (SELECT count(*)::int FROM agent_handoffs) AS handoffs,
         (SELECT count(*)::int FROM knowledge_gate_evaluations) AS gates,
         (SELECT passed FROM knowledge_gate_evaluations
           WHERE task_id='task-kt' ORDER BY evaluated_at DESC LIMIT 1) AS gate_passed,
         (SELECT status FROM agent_execution_registrations
           WHERE run_id='run:task-kt:1') AS registration_status`,
    );
    expect(persisted.rows[0]).toEqual({
      registrations: 1,
      heartbeats: 3,
      deltas: 1,
      handoffs: 1,
      gates: 1,
      gate_passed: true,
      registration_status: "completed",
    });
  });

  it("persists a redacted partial handoff when the real runner fails", async () => {
    const runtime: CodingRuntime = {
      name: "codex",
      capabilities: {
        interrupt: true,
        suspend: false,
        resume_session: true,
        cancel: true,
        stop_after_current: true,
        send_message: false,
      },
      run: async () => ({
        outcome: "failed",
        detail: `runtime failed in ${repository}; token=super-secret`,
        usage: { input_tokens: 40, output_tokens: 8, usage_source: "runtime_report" },
      }),
    };
    const { payloads, duplicateResults } = await executeAndApply(runtime, false);
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "knowledge_registration" }),
        expect.objectContaining({ kind: "knowledge_handoff", status: "failed" }),
        expect.objectContaining({
          kind: "run_status",
          status: "failed",
          failure: expect.objectContaining({ code: "runner_verification_failed" }),
        }),
      ]),
    );
    expect(duplicateResults).toEqual(payloads.map(() => ({ duplicate: true })));
    const persisted = await pg.query<{
      handoff: unknown;
      registration_status: string;
      deltas: number;
      gates: number;
      gate_passed: boolean;
    }>(
      `SELECT
         (SELECT payload FROM agent_handoffs WHERE run_id='run:task-kt:1') AS handoff,
         (SELECT status FROM agent_execution_registrations
           WHERE run_id='run:task-kt:1') AS registration_status,
         (SELECT count(*)::int FROM knowledge_deltas) AS deltas,
         (SELECT count(*)::int FROM knowledge_gate_evaluations) AS gates,
         (SELECT passed FROM knowledge_gate_evaluations
           WHERE task_id='task-kt' ORDER BY evaluated_at DESC LIMIT 1) AS gate_passed`,
    );
    expect(persisted.rows[0]).toMatchObject({
      registration_status: "failed",
      deltas: 0,
      gates: 1,
      gate_passed: false,
    });
    const handoff = JSON.stringify(persisted.rows[0]?.handoff);
    expect(handoff).not.toContain(repository);
    expect(handoff).not.toContain("super-secret");
    const runtimeResult = JSON.stringify(
      payloads.find(
        (payload) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { kind?: unknown }).kind === "runtime_result",
      ),
    );
    expect(runtimeResult).toContain("[LOCAL_PATH]");
    expect(runtimeResult).toContain("token=[REDACTED]");
  });
});
