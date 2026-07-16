import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Phase4CompletionService } from "../src/coordinator/phase4Completion.js";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { Phase4DispatchRepository, Phase4Dispatcher } from "../src/coordinator/phase4Dispatcher.js";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import { Phase4RecoveryMonitor } from "../src/coordinator/phase4RecoveryMonitor.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

describe.sequential("Phase 4 durable coordinator scheduling", () => {
  let pg: PGlite;
  let coordinator: Phase4Coordinator;

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
        id, name, description, status, assignment_policy_ref,
        verification_policy_ref, budget_policy_ref
      ) VALUES ('project-1','Project One','','active','assignment','verification','budget');
      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, granted_permissions,
        default_branch, observed_head, verification_policy_ref,
        repository_health, created_by_actor_type, created_by_actor_id
      ) VALUES ('binding-1','project-1','local_runner','connected','runner-1',
        'workspace-1','repository-1','Project One','{}'::jsonb,'main','commit-1',
        'verification','healthy','human','admin-1');
      UPDATE projects SET primary_repository_binding_id = 'binding-1' WHERE id = 'project-1';
      INSERT INTO phases (
        id, project_id, objective_summary, priority, status, approved_budget_usd
      ) VALUES ('phase-1','project-1','Implement vertical slice',1,'awaiting_approval',20);
      INSERT INTO strategy_versions (
        id, project_id, phase_id, version, status, objective, content,
        convergence, review_rounds, content_hash
      ) VALUES ('strategy-1','project-1','phase-1',1,'approved','Vertical slice',
        '{}'::jsonb,'converged',1,repeat('a',64));
      UPDATE phases SET status='approved', approved_strategy_version_id='strategy-1'
        WHERE id='phase-1';
      INSERT INTO objectives (
        id, project_id, phase_id, outcome, success_measures, status, "order"
      ) VALUES ('objective-1','project-1','phase-1','One completed task',
        '["task completes"]'::jsonb,'active',0);
      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id, title,
        description, deliverables, acceptance_criteria, complexity, risk,
        required_roles, required_capabilities, required_inputs, expected_outputs,
        environment_policy_ref, verification_policy_ref, state, lifecycle_version
      ) VALUES ('task-1','project-1','phase-1','objective-1','strategy-1','Do work',
        'Complete the vertical slice','["change"]'::jsonb,'["verified"]'::jsonb,
        'M','medium','["implementation"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
        '["commit"]'::jsonb,'environment','verification','pending',0);
      INSERT INTO agent_profiles (
        id, provider, runtime, model, roles, capabilities, context_limit_tokens,
        security_restrictions, status, active_workload, cost_metadata
      ) VALUES ('agent-1','openai','codex','gpt-5-codex','["implementation"]'::jsonb,
        '["typescript"]'::jsonb,200000,'[]'::jsonb,'available',0,
        '{"billing_mode":"subscription"}'::jsonb);
      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
        rationale_factors, budget_limit_usd, allocation_policy_ref
      ) VALUES ('assignment-1','project-1','phase-1','task-1','agent-1','proposed',
        'Best implementation agent','["capability"]'::jsonb,10,'allocation');
    `);
    coordinator = new Phase4Coordinator(new PGliteTransactionRunner(pg));
  });

  afterEach(async () => {
    await pg.close();
  });

  function schedule() {
    return coordinator.schedule({
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      assignment_id: "assignment-1",
      runner_id: "runner-1",
      runner_generation: 3,
      authorized_by: { actor_type: "human", actor_id: "admin-1" },
      authorized_by_session_id: "session-1",
      correlation_id: "correlation-1",
      causation_id: null,
      context_refs: [
        {
          artifact_id: "prompt-1",
          content_hash: "b".repeat(64),
          byte_size: 12,
          storage_ref: "relay://artifacts/prompt-1",
        },
      ],
      target_branch: "norns/task-1",
      worktree_policy_ref: "worktree-default",
      sandbox_policy_ref: "sandbox-default",
      max_input_tokens: 10_000,
      max_output_tokens: 4_000,
      max_duration_seconds: 900,
      issued_at: "2026-07-16T20:00:00.000Z",
      expires_at: "2026-07-16T20:15:00.000Z",
    });
  }

  it("atomically assigns, reserves budget, and creates stable durable outbox records", async () => {
    const result = await schedule();

    expect(result.command.command_id).toBe(`dispatch:${result.dispatch_job_id}`);
    const state = await pg.query<{
      task_state: string;
      run_state: string;
      assignment_status: string;
      reservation_status: string;
      dispatch_status: string;
      command_status: string;
      task_events: number;
    }>(
      `SELECT t.state AS task_state, run.state AS run_state,
              assignment.status AS assignment_status,
              reservation.status AS reservation_status,
              job.status AS dispatch_status, command.status AS command_status,
              (SELECT count(*)::int FROM domain_events
               WHERE stream_type='task' AND stream_id='task-1') AS task_events
       FROM tasks t
       JOIN agent_runs run ON run.id = t.designated_run_id
       JOIN agent_assignments assignment ON assignment.id = t.designated_assignment_id
       JOIN budget_reservations reservation ON reservation.run_id = run.id
       JOIN dispatch_jobs job ON job.run_id = run.id
       JOIN commands command ON command.command_id = job.command_id
       WHERE t.id = 'task-1'`,
    );
    expect(state.rows[0]).toEqual({
      task_state: "assigned",
      run_state: "created",
      assignment_status: "active",
      reservation_status: "active",
      dispatch_status: "queued",
      command_status: "queued",
      task_events: 2,
    });
  });

  it("reclaims a crashed dispatcher lease and redelivers the identical command", async () => {
    const scheduled = await schedule();
    const repository = new Phase4DispatchRepository(new PGliteTransactionRunner(pg));
    const first = await repository.claim("dispatcher-a", 30_000);
    expect(first?.command.command_id).toBe(scheduled.command_id);

    await pg.query(
      "UPDATE dispatch_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [scheduled.dispatch_job_id],
    );
    const recovered = await repository.claim("dispatcher-b", 30_000);
    expect(recovered?.command.command_id).toBe(first?.command.command_id);
    expect(recovered?.attempts).toBe(2);
    await repository.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-b",
      "2026-07-16T20:01:00.000Z",
    );

    const state = await pg.query<{ job: string; command: string; run: string }>(
      `SELECT job.status AS job, command.status AS command, run.state AS run
       FROM dispatch_jobs job
       JOIN commands command ON command.command_id = job.command_id
       JOIN agent_runs run ON run.id = job.run_id
       WHERE job.id = $1`,
      [scheduled.dispatch_job_id],
    );
    expect(state.rows[0]).toEqual({ job: "delivered", command: "dispatched", run: "dispatched" });
    await expect(repository.pendingForRunner("runner-1")).resolves.toEqual([scheduled.command]);
  });

  it("durably applies runner events once and closes reviewed integrated work", async () => {
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const dispatch = new Phase4DispatchRepository(transactions);
    const claimed = await dispatch.claim("dispatcher-a", 30_000);
    expect(claimed?.command.command_id).toBe(scheduled.command_id);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-a",
      "2026-07-16T20:01:00.000Z",
    );

    const events = new Phase4EventProcessor(transactions);
    const envelope = (event_seq: number, payload: Record<string, unknown>) => ({
      protocol: 1 as const,
      event_seq,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: scheduled.command_id,
      occurred_at: `2026-07-16T20:0${event_seq}:00.000Z`,
      payload,
    });
    await events.apply(
      envelope(1, { kind: "run_status", run_id: scheduled.run_id, status: "started" }) as never,
    );
    const usage = envelope(2, {
      kind: "usage_report",
      run_id: scheduled.run_id,
      input_tokens: 100,
      output_tokens: 25,
    });
    await events.apply(usage as never);
    await expect(events.apply(usage as never)).resolves.toEqual({ duplicate: true });
    await events.apply(
      envelope(3, {
        kind: "verification_result",
        node_id: "task-1",
        commit_sha: "c".repeat(40),
        passed: true,
        output_digest: "verification-output",
      }) as never,
    );
    await events.apply(
      envelope(4, { kind: "run_status", run_id: scheduled.run_id, status: "completed" }) as never,
    );
    await events.apply(
      envelope(5, {
        kind: "command_ack",
        command_id: scheduled.command_id,
        state: "succeeded",
        detail: "",
      }) as never,
    );

    const beforeReview = await pg.query<{
      task: string;
      run: string;
      verification: string;
      runner_events: number;
    }>(
      `SELECT task.state AS task, run.state AS run,
              run.verification_status AS verification,
              (SELECT count(*)::int FROM runner_events WHERE applied_at IS NOT NULL) AS runner_events
       FROM tasks task JOIN agent_runs run ON run.id=task.designated_run_id
       WHERE task.id='task-1'`,
    );
    expect(beforeReview.rows[0]).toEqual({
      task: "in_review",
      run: "succeeded",
      verification: "passed",
      runner_events: 5,
    });

    const evidence = {
      artifact_id: "artifact-1",
      content_hash: "d".repeat(64),
      media_type: "application/json",
      label: "review and integration evidence",
    };
    const completion = new Phase4CompletionService(transactions);
    await expect(
      completion.complete({
        project_id: "project-1",
        phase_id: "phase-1",
        task_id: "task-1",
        run_id: scheduled.run_id,
        actor: { actor_type: "human", actor_id: "admin-1" },
        correlation_id: "correlation-1",
        review_evidence: [evidence],
        integration_evidence: [evidence],
        review_summary: "Reviewed and integrated",
        completed_at: "2026-07-16T20:06:00.000Z",
      }),
    ).resolves.toEqual({ task_completed: true, phase_closed: true });

    const closed = await pg.query<{
      task: string;
      phase: string;
      objective: string;
      assignment: string;
      reservation: string;
      memory: number;
    }>(
      `SELECT task.state AS task, phase.status AS phase, objective.status AS objective,
              assignment.status AS assignment, reservation.status AS reservation,
              (SELECT count(*)::int FROM project_memory_entries
               WHERE phase_id='phase-1' AND category='phase_completion') AS memory
       FROM tasks task
       JOIN phases phase ON phase.id=task.phase_id
       JOIN objectives objective ON objective.id=task.objective_id
       JOIN agent_assignments assignment ON assignment.id=task.designated_assignment_id
       JOIN budget_reservations reservation ON reservation.run_id=task.designated_run_id
       WHERE task.id='task-1'`,
    );
    expect(closed.rows[0]).toEqual({
      task: "completed",
      phase: "completed",
      objective: "completed",
      assignment: "completed",
      reservation: "settled",
      memory: 1,
    });
  });

  it("dead-letters exhausted delivery, blocks work, and releases its reservation", async () => {
    const scheduled = await schedule();
    await pg.query("UPDATE dispatch_jobs SET attempts=4 WHERE id=$1", [scheduled.dispatch_job_id]);
    const repository = new Phase4DispatchRepository(new PGliteTransactionRunner(pg));
    const dispatcher = new Phase4Dispatcher(
      repository,
      "dispatcher-a",
      async () => {
        throw new Error("runner unavailable");
      },
      { max_attempts: 5, now: () => new Date("2026-07-16T20:10:00.000Z") },
    );
    await expect(dispatcher.tick()).resolves.toBe(false);
    const state = await pg.query<{
      job: string;
      command: string;
      run: string;
      task: string;
      reservation: string;
      outcome: string;
    }>(
      `SELECT job.status AS job, command.status AS command, run.state AS run,
              task.state AS task, reservation.status AS reservation,
              reservation.resolution_outcome AS outcome
       FROM dispatch_jobs job
       JOIN commands command ON command.command_id=job.command_id
       JOIN agent_runs run ON run.id=job.run_id
       JOIN tasks task ON task.id=job.task_id
       JOIN budget_reservations reservation ON reservation.run_id=job.run_id
       WHERE job.id=$1`,
      [scheduled.dispatch_job_id],
    );
    expect(state.rows[0]).toEqual({
      job: "dead_letter",
      command: "failed",
      run: "expired",
      task: "blocked",
      reservation: "released",
      outcome: "dead_letter",
    });
  });

  it("turns a rejected production command into durable blocked work without budget drift", async () => {
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const dispatch = new Phase4DispatchRepository(transactions);
    await dispatch.claim("dispatcher-a", 30_000);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-a",
      "2026-07-16T20:01:00.000Z",
    );
    const events = new Phase4EventProcessor(transactions);
    await events.apply({
      protocol: 1,
      event_seq: 1,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: scheduled.command_id,
      occurred_at: "2026-07-16T20:02:00.000Z",
      payload: {
        kind: "command_ack",
        command_id: scheduled.command_id,
        state: "rejected",
        detail: "runner execution is not configured",
      },
    });
    const state = await pg.query<{
      job: string;
      run: string;
      task: string;
      reservation: string;
      outcome: string;
    }>(
      `SELECT job.status AS job, run.state AS run, task.state AS task,
              reservation.status AS reservation, reservation.resolution_outcome AS outcome
       FROM dispatch_jobs job JOIN agent_runs run ON run.id=job.run_id
       JOIN tasks task ON task.id=job.task_id
       JOIN budget_reservations reservation ON reservation.run_id=job.run_id
       WHERE job.id=$1`,
      [scheduled.dispatch_job_id],
    );
    expect(state.rows[0]).toEqual({
      job: "completed",
      run: "failed",
      task: "blocked",
      reservation: "released",
      outcome: "rejected",
    });
  });

  it("raises one stable DecisionPoint for stuck work", async () => {
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const dispatch = new Phase4DispatchRepository(transactions);
    await dispatch.claim("dispatcher-a", 30_000);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-a",
      "2026-07-16T20:01:00.000Z",
    );
    await pg.query("UPDATE agent_runs SET updated_at='2026-07-16T19:00:00.000Z' WHERE id=$1", [
      scheduled.run_id,
    ]);
    const monitor = new Phase4RecoveryMonitor(transactions);
    await expect(monitor.scan(new Date("2026-07-16T20:10:00.000Z"), 60_000)).resolves.toEqual({
      decision_points: 1,
      repaired_reservations: [],
    });
    await expect(monitor.scan(new Date("2026-07-16T20:11:00.000Z"), 60_000)).resolves.toEqual({
      decision_points: 0,
      repaired_reservations: [],
    });
    const points = await pg.query<{ count: number; status: string }>(
      `SELECT count(*)::int AS count, min(status) AS status
       FROM decision_points WHERE scope_entity_id=$1`,
      [scheduled.run_id],
    );
    expect(points.rows[0]).toEqual({ count: 1, status: "open" });
  });
});
