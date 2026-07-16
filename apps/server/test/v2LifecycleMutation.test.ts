import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PGliteDatabaseLike,
  PGliteTransactionRunner,
} from "../src/persistence/v2/database.js";
import {
  executeV2AgentRunLifecycleTransition,
  executeV2TaskLifecycleTransition,
  transitionV2TaskLifecycle,
} from "../src/persistence/v2/lifecycleMutation.js";
import { type V2MigrationDatabase, runPhase1V2Migration } from "../src/persistence/v2/migrate.js";
import { V2AutomationBlockedByIntegrityError } from "../src/persistence/v2/reconciliation.js";
import {
  SqlV2LifecycleRepository,
  sqlV2LifecycleMutationTransactionFactory,
} from "../src/persistence/v2/sqlRepositories.js";

describe.sequential("V2 production lifecycle mutation chokepoint", () => {
  let pg: PGlite;
  let runner: PGliteTransactionRunner;

  beforeEach(async () => {
    pg = new PGlite();
    runner = new PGliteTransactionRunner(pg as unknown as PGliteDatabaseLike);
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runPhase1V2Migration(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES (
        'project-1', 'Lifecycle project', 'active',
        'assignment/default', 'verification/default', 'budget/default'
      );

      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, default_branch,
        verification_policy_ref, created_by_actor_type
      ) VALUES (
        'binding-1', 'project-1', 'local_runner', 'connected', 'runner-1', 'workspace-1',
        'repository-1', 'Repository One', 'main', 'verification/default', 'human'
      );

      INSERT INTO phases (id, project_id, objective_summary, status)
      VALUES ('phase-1', 'project-1', 'Lifecycle foundation', 'approved');

      INSERT INTO strategy_versions (
        id, project_id, phase_id, version, status, objective, content,
        convergence, content_hash
      ) VALUES (
        'strategy-1', 'project-1', 'phase-1', 1, 'approved',
        'Lifecycle foundation', '{}'::jsonb, 'converged', repeat('a', 64)
      );

      INSERT INTO objectives (
        id, project_id, phase_id, outcome, success_measures, status
      ) VALUES (
        'objective-1', 'project-1', 'phase-1',
        'Lifecycle is consistent', '["consistent"]'::jsonb, 'active'
      );

      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id,
        title, description, deliverables, acceptance_criteria,
        complexity, risk, required_roles, expected_outputs,
        environment_policy_ref, verification_policy_ref, state
      ) VALUES (
        'task-1', 'project-1', 'phase-1', 'objective-1', 'strategy-1',
        'Transition safely', 'Exercise the lifecycle boundary',
        '["event"]'::jsonb, '["fold matches row"]'::jsonb,
        'M', 'medium', '["backend"]'::jsonb, '["event"]'::jsonb,
        'environment/default', 'verification/default', 'pending'
      );

      INSERT INTO agent_profiles (
        id, provider, runtime, model, roles, context_limit_tokens,
        status, cost_metadata
      ) VALUES (
        'agent-1', 'openai', 'codex', 'codex', '["backend"]'::jsonb,
        128000, 'available', '{}'::jsonb
      );

      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status,
        rationale, rationale_factors, allocation_policy_ref
      ) VALUES (
        'assignment-1', 'project-1', 'phase-1', 'task-1', 'agent-1',
        'active', 'Matches the required role', '["capability"]'::jsonb,
        'assignment/default'
      );

      INSERT INTO agent_runs (
        id, project_id, phase_id, task_id, assignment_id, attempt, state,
        is_designated, repository_binding_id, expected_revision
      ) VALUES (
        'run-1', 'project-1', 'phase-1', 'task-1', 'assignment-1',
        1, 'created', true, 'binding-1', '0123456789abcdef'
      );
    `);
  }, 30_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  it("updates Task and AgentRun rows with their event and audit in one transaction", async () => {
    const task = await executeV2TaskLifecycleTransition({
      transactionRunner: runner,
      transactionFactory: sqlV2LifecycleMutationTransactionFactory,
      input: {
        project_id: "project-1",
        phase_id: "phase-1",
        task_id: "task-1",
        expected_aggregate_version: 1,
        to: "ready",
        reason: "dependencies satisfied",
        actor_type: "coordinator",
        actor_id: "coordinator-1",
        correlation_id: "correlation-task",
        causation_id: null,
        occurred_at: "2026-07-16T14:00:00.000Z",
      },
    });
    expect(task).toMatchObject({
      state: "ready",
      lifecycle_version: 1,
      aggregate_version: 2,
    });

    const run = await executeV2AgentRunLifecycleTransition({
      transactionRunner: runner,
      transactionFactory: sqlV2LifecycleMutationTransactionFactory,
      input: {
        project_id: "project-1",
        phase_id: "phase-1",
        task_id: "task-1",
        run_id: "run-1",
        expected_aggregate_version: 1,
        to: "dispatched",
        reason: "durable outbox committed",
        actor_type: "coordinator",
        actor_id: "coordinator-1",
        correlation_id: "correlation-run",
        causation_id: "correlation-task",
        occurred_at: "2026-07-16T14:00:01.000Z",
      },
    });
    expect(run).toMatchObject({
      state: "dispatched",
      lifecycle_version: 1,
      aggregate_version: 2,
    });

    const events = await pg.query<{ stream_type: string; stream_version: number }>(
      "SELECT stream_type, stream_version FROM domain_events ORDER BY occurred_at",
    );
    expect(events.rows).toEqual([
      { stream_type: "task", stream_version: 1 },
      { stream_type: "agent_run", stream_version: 1 },
    ]);
    expect((await pg.query("SELECT * FROM audit_events")).rows).toHaveLength(2);

    const reconciliation = new SqlV2LifecycleRepository(
      pg as unknown as Parameters<typeof sqlV2LifecycleMutationTransactionFactory.bind>[0],
    );
    const taskEvents = await reconciliation.taskEvents("task-1");
    const runEvents = await reconciliation.agentRunEvents("run-1");
    expect(taskEvents).toMatchObject([{ from: "pending", to: "ready", lifecycle_version: 1 }]);
    expect(runEvents).toMatchObject([{ from: "created", to: "dispatched", lifecycle_version: 1 }]);
  });

  it("rolls back both the lifecycle row and history when the enclosing command fails", async () => {
    await expect(
      runner.transaction(async (executor) => {
        const tx = sqlV2LifecycleMutationTransactionFactory.bind(executor);
        await transitionV2TaskLifecycle(tx, {
          project_id: "project-1",
          phase_id: "phase-1",
          task_id: "task-1",
          expected_aggregate_version: 1,
          to: "ready",
          reason: "fault injection",
          actor_type: "system",
          actor_id: "test",
          correlation_id: "correlation-rollback",
          causation_id: null,
          occurred_at: "2026-07-16T14:00:00.000Z",
        });
        throw new Error("fault after lifecycle write");
      }),
    ).rejects.toThrow("fault after lifecycle write");

    const row = await pg.query<{
      state: string;
      lifecycle_version: number;
      aggregate_version: number;
    }>("SELECT state, lifecycle_version, aggregate_version FROM tasks WHERE id = 'task-1'");
    expect(row.rows[0]).toEqual({
      state: "pending",
      lifecycle_version: 0,
      aggregate_version: 1,
    });
    expect((await pg.query("SELECT * FROM domain_events")).rows).toHaveLength(0);
    expect((await pg.query("SELECT * FROM audit_events")).rows).toHaveLength(0);
  });

  it("quarantines an aggregate with an open reconciliation finding", async () => {
    await pg.query(
      `INSERT INTO lifecycle_integrity_findings (
         id, aggregate_kind, aggregate_id, project_id, code, details,
         status, detected_at
       ) VALUES (
         'finding-1', 'task', 'task-1', 'project-1', 'state_without_event',
         '{}'::jsonb, 'open', now()
       )`,
    );

    await expect(
      executeV2TaskLifecycleTransition({
        transactionRunner: runner,
        transactionFactory: sqlV2LifecycleMutationTransactionFactory,
        input: {
          project_id: "project-1",
          phase_id: "phase-1",
          task_id: "task-1",
          expected_aggregate_version: 1,
          to: "ready",
          reason: null,
          actor_type: "coordinator",
          actor_id: "coordinator-1",
          correlation_id: "correlation-quarantine",
          causation_id: null,
          occurred_at: "2026-07-16T14:00:00.000Z",
        },
      }),
    ).rejects.toBeInstanceOf(V2AutomationBlockedByIntegrityError);

    expect(
      (await pg.query<{ state: string }>("SELECT state FROM tasks WHERE id = 'task-1'")).rows[0]
        ?.state,
    ).toBe("pending");
  });
});
