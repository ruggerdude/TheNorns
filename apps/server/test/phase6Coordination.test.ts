import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Phase4CompletionService } from "../src/coordinator/phase4Completion.js";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { Phase4DispatchRepository } from "../src/coordinator/phase4Dispatcher.js";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import {
  Phase6CoordinationService,
  rankPhase6AgentCandidates,
} from "../src/coordinator/phase6Coordination.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const evidence = (id: string) => ({
  artifact_id: id,
  content_hash: id.charCodeAt(0).toString(16).padStart(2, "0").repeat(32),
  media_type: "application/json",
  label: id,
});

describe.sequential("Phase 6 autonomous multi-agent coordination", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let coordinator: Phase4Coordinator;
  let coordination: Phase6CoordinationService;
  let dispatch: Phase4DispatchRepository;
  let events: Phase4EventProcessor;
  let completion: Phase4CompletionService;
  const sequence = new Map<string, number>();

  beforeEach(async () => {
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
        id, name, description, status, max_concurrent_tasks, assignment_policy_ref,
        verification_policy_ref, budget_policy_ref
      ) VALUES ('project-6','Phase Six','','active',2,'allocation-v2','verification','budget');
      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, granted_permissions, default_branch,
        observed_head, verification_policy_ref, repository_health,
        created_by_actor_type, created_by_actor_id
      ) VALUES ('binding-6','project-6','local_runner','connected','runner-openai','workspace',
        'repo','Phase Six','{}'::jsonb,'main','base-commit','verification','healthy','human','admin');
      UPDATE projects SET primary_repository_binding_id='binding-6' WHERE id='project-6';
      INSERT INTO phases (id, project_id, objective_summary, priority, status, approved_budget_usd)
      VALUES ('phase-6','project-6','Multi-provider delivery',1,'awaiting_approval',100);
      INSERT INTO strategy_versions (
        id, project_id, phase_id, version, status, objective, content,
        convergence, review_rounds, content_hash
      ) VALUES ('strategy-6','project-6','phase-6',1,'approved','Coordinate providers',
        '{}'::jsonb,'converged',1,repeat('a',64));
      UPDATE phases SET status='approved', approved_strategy_version_id='strategy-6'
        WHERE id='phase-6';
      INSERT INTO objectives (id, project_id, phase_id, outcome, success_measures, status, "order")
      VALUES ('objective-6','project-6','phase-6','Coordinated delivery','["green"]'::jsonb,'active',0);

      INSERT INTO agent_profiles (
        id, provider, runtime, model, roles, capabilities, context_limit_tokens,
        security_restrictions, status, active_workload, cost_metadata,
        max_concurrent_runs, average_latency_ms, failure_count
      ) VALUES
        ('openai-builder','openai','codex','gpt-5-codex',
         '["implementation","backend","integration","code_quality"]'::jsonb,
         '["typescript","api","integration","react"]'::jsonb,200000,'[]'::jsonb,'available',0,
         '{"billing_mode":"subscription"}'::jsonb,2,900,0),
        ('anthropic-builder','anthropic','claude','claude-sonnet-5',
         '["implementation","frontend","code_quality"]'::jsonb,
         '["typescript","react"]'::jsonb,180000,'[]'::jsonb,'available',0,
         '{"billing_mode":"api","input_usd_per_million":3,"output_usd_per_million":15}'::jsonb,2,700,0),
        ('anthropic-reviewer','anthropic','claude','claude-fable-5',
         '["architecture","testing","code_quality"]'::jsonb,
         '["typescript","api","integration"]'::jsonb,220000,'[]'::jsonb,'available',0,
         '{"billing_mode":"subscription"}'::jsonb,2,1200,0);

      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id, title, description,
        deliverables, acceptance_criteria, complexity, risk, required_roles,
        required_capabilities, required_inputs, expected_outputs,
        environment_policy_ref, verification_policy_ref, state, lifecycle_version
      ) VALUES
        ('task-api','project-6','phase-6','objective-6','strategy-6','Backend API','Build API',
         '["api"]'::jsonb,'["green"]'::jsonb,'L','high','["backend"]'::jsonb,
         '["typescript","api"]'::jsonb,'[]'::jsonb,'["src/api.ts"]'::jsonb,
         'environment','verification','pending',0),
        ('task-ui','project-6','phase-6','objective-6','strategy-6','Frontend UI','Build UI',
         '["ui"]'::jsonb,'["green"]'::jsonb,'M','medium','["frontend"]'::jsonb,
         '["typescript","react"]'::jsonb,'[]'::jsonb,'["src/ui.tsx"]'::jsonb,
         'environment','verification','pending',0),
        ('task-integrate','project-6','phase-6','objective-6','strategy-6','Integrate','Integrate work',
         '["integration"]'::jsonb,'["green"]'::jsonb,'M','critical','["integration"]'::jsonb,
         '["typescript","integration"]'::jsonb,'[]'::jsonb,'["src/integration.ts"]'::jsonb,
         'environment','verification','pending',0);
      INSERT INTO task_dependencies (id, project_id, phase_id, predecessor_task_id, successor_task_id)
      VALUES ('dep-api','project-6','phase-6','task-api','task-integrate'),
             ('dep-ui','project-6','phase-6','task-ui','task-integrate');
      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
        rationale_factors, budget_limit_usd, allocation_policy_ref
      ) VALUES
        ('assignment-api','project-6','phase-6','task-api','openai-builder','proposed','pending allocation','["capability"]'::jsonb,20,'allocation-v2'),
        ('assignment-ui','project-6','phase-6','task-ui','anthropic-builder','proposed','pending allocation','["capability"]'::jsonb,20,'allocation-v2'),
        ('assignment-integrate','project-6','phase-6','task-integrate','openai-builder','proposed','pending allocation','["capability"]'::jsonb,20,'allocation-v2');
      INSERT INTO task_coordination_constraints (
        task_id, project_id, phase_id, conflict_keys, estimated_context_tokens,
        requires_independent_review, critical_path_weight
      ) VALUES
        ('task-api','project-6','phase-6','["src/api.ts"]'::jsonb,50000,true,2),
        ('task-ui','project-6','phase-6','["src/ui.tsx"]'::jsonb,40000,true,2),
        ('task-integrate','project-6','phase-6','["src/integration.ts"]'::jsonb,60000,true,3);
    `);
    transactions = new PGliteTransactionRunner(pg);
    coordinator = new Phase4Coordinator(transactions);
    coordination = new Phase6CoordinationService(transactions);
    dispatch = new Phase4DispatchRepository(transactions);
    events = new Phase4EventProcessor(transactions);
    completion = new Phase4CompletionService(transactions);
  });

  afterEach(async () => pg.close());

  function schedule(taskId: string, assignmentId: string, runnerId: string, supersedes?: string) {
    return coordinator.schedule({
      project_id: "project-6",
      phase_id: "phase-6",
      task_id: taskId,
      assignment_id: assignmentId,
      runner_id: runnerId,
      runner_generation: 1,
      authorized_by: { actor_type: "coordinator", actor_id: "coordinator-6" },
      authorized_by_session_id: "phase6-policy",
      correlation_id: `correlation:${taskId}:${supersedes ?? "first"}`,
      causation_id: supersedes ?? null,
      context_refs: [
        {
          artifact_id: `context:${taskId}`,
          content_hash: "b".repeat(64),
          byte_size: 100,
          storage_ref: `relay://context/${taskId}`,
        },
      ],
      target_branch: `norns/${taskId}`,
      worktree_policy_ref: "worktree",
      sandbox_policy_ref: "sandbox",
      max_input_tokens: 20_000,
      max_output_tokens: 5_000,
      max_duration_seconds: 900,
      issued_at: "2026-07-16T21:00:00.000Z",
      expires_at: "2026-07-16T22:00:00.000Z",
      ...(supersedes ? { supersedes_run_id: supersedes } : {}),
    });
  }

  async function succeed(
    run: { run_id: string; dispatch_job_id: string; command_id: string },
    runnerId: string,
    taskId: string,
  ) {
    const claim = await dispatch.claim(`dispatcher:${runnerId}`, 30_000);
    expect(claim?.job_id).toBe(run.dispatch_job_id);
    await dispatch.markDelivered(
      run.dispatch_job_id,
      `dispatcher:${runnerId}`,
      "2026-07-16T21:01:00.000Z",
    );
    const next = () => {
      const value = (sequence.get(runnerId) ?? 0) + 1;
      sequence.set(runnerId, value);
      return value;
    };
    const apply = (payload: Record<string, unknown>) => {
      const event_seq = next();
      return events.apply({
        protocol: 1,
        event_seq,
        runner_id: runnerId,
        generation: 1,
        correlation_id: `runner:${run.run_id}`,
        causation_id: run.command_id,
        occurred_at: new Date(Date.UTC(2026, 6, 16, 21, 1, event_seq)).toISOString(),
        payload,
      } as never);
    };
    await apply({ kind: "run_status", run_id: run.run_id, status: "started" });
    await apply({ kind: "usage_report", run_id: run.run_id, input_tokens: 100, output_tokens: 20 });
    await apply({
      kind: "verification_result",
      node_id: taskId,
      commit_sha: "c".repeat(40),
      passed: true,
      output_digest: `green:${run.run_id}`,
    });
    await apply({ kind: "run_status", run_id: run.run_id, status: "completed" });
    await apply({
      kind: "command_ack",
      command_id: run.command_id,
      state: "succeeded",
      detail: "",
    });
  }

  async function review(
    runId: string,
    taskId: string,
    reviewer: string,
    decision: "approved" | "rework" | "escalated",
    round: string,
  ) {
    return coordination.recordReview({
      project_id: "project-6",
      phase_id: "phase-6",
      task_id: taskId,
      run_id: runId,
      reviewer_agent_profile_id: reviewer,
      decision,
      summary: `${decision} review ${round}`,
      evidence: [evidence(round)],
      created_at: "2026-07-16T21:10:00.000Z",
    });
  }

  async function complete(runId: string, taskId: string, round: string) {
    return completion.complete({
      project_id: "project-6",
      phase_id: "phase-6",
      task_id: taskId,
      run_id: runId,
      actor: { actor_type: "agent", actor_id: "integration-agent" },
      correlation_id: `complete:${taskId}`,
      review_evidence: [evidence(round)],
      integration_evidence: [evidence(`z${round}`)],
      review_summary: `Integrated ${taskId}`,
      completed_at: "2026-07-16T21:20:00.000Z",
    });
  }

  it("ranks for capability, workload, reliability, context, and cost", () => {
    const ranked = rankPhase6AgentCandidates(
      {
        required_roles: ["backend"],
        required_capabilities: ["typescript"],
        risk: "critical",
        estimated_context_tokens: 50_000,
      },
      [
        {
          id: "reliable",
          provider: "openai",
          runtime: "codex",
          model: "gpt",
          roles: ["backend"],
          capabilities: ["typescript"],
          context_limit_tokens: 100_000,
          security_restrictions: [],
          status: "available",
          active_workload: 0,
          max_concurrent_runs: 1,
          average_latency_ms: 1000,
          failure_count: 0,
          cost_metadata: { billing_mode: "subscription" },
        },
        {
          id: "unreliable",
          provider: "anthropic",
          runtime: "claude",
          model: "sonnet",
          roles: ["backend"],
          capabilities: ["typescript"],
          context_limit_tokens: 100_000,
          security_restrictions: [],
          status: "available",
          active_workload: 0,
          max_concurrent_runs: 1,
          average_latency_ms: 1000,
          failure_count: 4,
          cost_metadata: {
            billing_mode: "api",
            input_usd_per_million: 3,
            output_usd_per_million: 15,
          },
        },
      ],
    );
    expect(ranked.map((item) => item.agent_profile_id)).toEqual(["reliable", "unreliable"]);
  });

  it("executes parallel and dependent work across providers, handles rework, escalation, budget, and restart", async () => {
    const apiAllocation = await coordination.allocate("task-api", "2026-07-16T21:00:00.000Z");
    const uiAllocation = await coordination.allocate("task-ui", "2026-07-16T21:00:00.000Z");
    expect(apiAllocation.selected.agent_profile_id).toBe("openai-builder");
    expect(uiAllocation.selected.agent_profile_id).toBe("anthropic-builder");
    expect(apiAllocation.selected.reviewer_agent_profile_id).toBe("anthropic-reviewer");

    const apiRun1 = await schedule("task-api", "assignment-api", "runner-openai");
    const uiRun = await schedule("task-ui", "assignment-ui", "runner-anthropic");

    // Simulated coordinator restart: all state and provider identity comes back from PostgreSQL.
    coordination = new Phase6CoordinationService(new PGliteTransactionRunner(pg));
    const resumed = await coordination.snapshot("project-6", "phase-6", "2026-07-16T21:01:00.000Z");
    expect(resumed.active_tasks).toBe(2);
    expect(resumed.active_providers.sort()).toEqual(["anthropic", "openai"]);

    await succeed(apiRun1, "runner-openai", "task-api");
    await succeed(uiRun, "runner-anthropic", "task-ui");
    await review(apiRun1.run_id, "task-api", "anthropic-reviewer", "rework", "r");
    const apiRun2 = await schedule("task-api", "assignment-api", "runner-openai", apiRun1.run_id);
    await succeed(apiRun2, "runner-openai", "task-api");
    await review(apiRun2.run_id, "task-api", "anthropic-reviewer", "approved", "s");
    await complete(apiRun2.run_id, "task-api", "s");

    const uiReviewer = uiAllocation.selected.reviewer_agent_profile_id;
    expect(uiReviewer).toBe("openai-builder");
    if (!uiReviewer) throw new Error("UI reviewer was not allocated");
    await review(uiRun.run_id, "task-ui", uiReviewer, "approved", "t");
    await complete(uiRun.run_id, "task-ui", "t");

    const integrationAllocation = await coordination.allocate(
      "task-integrate",
      "2026-07-16T21:30:00.000Z",
    );
    const integrationRun = await schedule(
      "task-integrate",
      "assignment-integrate",
      "runner-openai",
    );
    await succeed(integrationRun, "runner-openai", "task-integrate");
    const integrationReviewer = integrationAllocation.selected.reviewer_agent_profile_id;
    if (!integrationReviewer) throw new Error("integration reviewer was not allocated");
    await review(integrationRun.run_id, "task-integrate", integrationReviewer, "escalated", "u");
    await review(integrationRun.run_id, "task-integrate", integrationReviewer, "approved", "v");
    const closed = await complete(integrationRun.run_id, "task-integrate", "v");
    expect(closed.phase_closed).toBe(true);
    expect(
      await coordination.capturePhaseMemory({
        project_id: "project-6",
        phase_id: "phase-6",
        lessons: ["Cross-provider review caught and corrected rework."],
        repository_facts: ["Backend and UI integration verified at the exact commit."],
        architecture_changes: ["Independent provider review is required for critical tasks."],
        recorded_at: "2026-07-16T21:40:00.000Z",
      }),
    ).toEqual({ recorded: 3 });

    const final = await pg.query<{
      providers: number;
      reviews: number;
      rework_runs: number;
      decisions: number;
      active_reservations: number;
      memory: number;
    }>(`SELECT
      (SELECT count(DISTINCT profile.provider)::int FROM agent_runs run
       JOIN agent_assignments assignment ON assignment.id=run.assignment_id
       JOIN agent_profiles profile ON profile.id=assignment.agent_profile_id) AS providers,
      (SELECT count(*)::int FROM agent_reviews) AS reviews,
      (SELECT count(*)::int FROM agent_runs WHERE task_id='task-api') AS rework_runs,
      (SELECT count(*)::int FROM decision_points WHERE reason_class='agent_review_escalation') AS decisions,
      (SELECT count(*)::int FROM budget_reservations WHERE status='active') AS active_reservations,
      (SELECT count(*)::int FROM project_memory_entries WHERE phase_id='phase-6') AS memory`);
    expect(final.rows[0]).toEqual({
      providers: 2,
      reviews: 5,
      rework_runs: 2,
      decisions: 1,
      active_reservations: 0,
      memory: 4,
    });
  }, 30_000);
});
