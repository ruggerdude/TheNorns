import { PGlite } from "@electric-sql/pglite";
import { V2StartPhaseCommand, v2DecisionPointConditionKey } from "@norns/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type V2DecisionPointInput,
  executeV2ApplicationCommand,
  upsertV2DecisionPoint,
} from "../src/persistence/v2/application.js";
import { resolveV2BudgetReservationTransaction } from "../src/persistence/v2/budget.js";
import {
  type PGliteDatabaseLike,
  PGliteTransactionRunner,
} from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runPhase1V2Migration } from "../src/persistence/v2/migrate.js";
import { reconcileV2Lifecycles } from "../src/persistence/v2/reconciliation.js";
import {
  SqlV2ApplicationTransaction,
  SqlV2DecisionPointTransaction,
  SqlV2LifecycleRepository,
  sqlV2BudgetTransactionFactory,
} from "../src/persistence/v2/sqlRepositories.js";

const NOW = "2026-07-16T12:00:00.000Z";

describe.sequential("V2 concrete SQL repositories", () => {
  let pg: PGlite;
  let runner: PGliteTransactionRunner;

  beforeAll(async () => {
    pg = new PGlite();
    runner = new PGliteTransactionRunner(pg as unknown as PGliteDatabaseLike);
    await runPhase1V2Migration(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES (
        'project-1', 'Repository integration', 'active',
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
      VALUES ('phase-1', 'project-1', 'Build the persistence foundation', 'approved');
      INSERT INTO strategy_versions (
        id, project_id, phase_id, version, status, objective, content,
        convergence, content_hash
      ) VALUES (
        'strategy-1', 'project-1', 'phase-1', 1, 'awaiting_approval',
        'Build the persistence foundation', '{}'::jsonb, 'converged', repeat('a', 64)
      );
      INSERT INTO objectives (
        id, project_id, phase_id, outcome, success_measures, status
      ) VALUES (
        'objective-1', 'project-1', 'phase-1', 'Persistence is durable',
        '["restart-safe"]'::jsonb, 'active'
      );
      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id,
        title, description, deliverables, acceptance_criteria, complexity, risk,
        required_roles, expected_outputs, environment_policy_ref,
        verification_policy_ref, state
      ) VALUES (
        'task-1', 'project-1', 'phase-1', 'objective-1', 'strategy-1',
        'Implement persistence', 'Create the relational boundary',
        '["repository"]'::jsonb, '["tests pass"]'::jsonb, 'L', 'high',
        '["backend"]'::jsonb, '["verified schema"]'::jsonb,
        'environment/default', 'verification/default', 'pending'
      );
      INSERT INTO agent_profiles (
        id, provider, runtime, model, roles, context_limit_tokens, status, cost_metadata
      ) VALUES (
        'agent-1', 'openai', 'codex', 'gpt-5', '["backend"]'::jsonb,
        200000, 'available', '{}'::jsonb
      );
      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status,
        rationale, rationale_factors, allocation_policy_ref
      ) VALUES (
        'assignment-1', 'project-1', 'phase-1', 'task-1', 'agent-1', 'active',
        'Best persistence capability', '["capability"]'::jsonb, 'assignment/default'
      );
      INSERT INTO agent_runs (
        id, project_id, phase_id, task_id, assignment_id, attempt, state,
        is_designated, repository_binding_id, expected_revision
      ) VALUES (
        'run-1', 'project-1', 'phase-1', 'task-1', 'assignment-1', 1,
        'created', true, 'binding-1', '0123456789abcdef'
      );
      INSERT INTO budget_reservations (
        id, project_id, phase_id, task_id, run_id, amount_usd,
        status, version, expires_at
      ) VALUES (
        'reservation-1', 'project-1', 'phase-1', 'task-1', 'run-1',
        20, 'active', 1, '2026-07-17T12:00:00.000Z'
      );
    `);
  }, 30_000);

  afterAll(async () => {
    if (!pg.closed) await pg.close();
  });

  it("executes and replays an application command through the production idempotency adapter", async () => {
    const command = V2StartPhaseCommand.parse({
      schema_version: 2,
      kind: "start_phase",
      command_id: "command-start-phase",
      command_family: "phase",
      actor: { actor_type: "human", actor_id: "user-1" },
      idempotency_key: "start-phase-1",
      correlation_id: "correlation-start-phase",
      causation_id: null,
      issued_at: NOW,
      project_id: "project-1",
      phase_id: "phase-1",
      expected_project_version: 1,
      expected_phase_version: 1,
    });
    let mutations = 0;
    const execute = () =>
      executeV2ApplicationCommand({
        command,
        transactionRunner: runner,
        transactionFactory: {
          bind: (sql) => new SqlV2ApplicationTransaction(sql),
        },
        now: () => new Date(NOW),
        mutate: async () => {
          mutations += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            outcome: "succeeded",
            http_status: 200,
            body: { phase_id: "phase-1" },
          };
        },
      });

    const [first, replay] = await Promise.all([execute(), execute()]);
    expect([first.kind, replay.kind].sort()).toEqual(["executed", "replayed"]);
    expect(mutations).toBe(1);
    const responses = [first, replay].flatMap((result) =>
      result.kind === "executed" || result.kind === "replayed" ? [result.response] : [],
    );
    expect(responses[0]).toEqual(responses[1]);

    const mismatch = await executeV2ApplicationCommand({
      command: V2StartPhaseCommand.parse({
        ...command,
        command_id: "command-start-phase-changed",
        expected_phase_version: 2,
      }),
      transactionRunner: runner,
      transactionFactory: {
        bind: (sql) => new SqlV2ApplicationTransaction(sql),
      },
      now: () => new Date(NOW),
      mutate: async () => {
        throw new Error("changed payload must not execute");
      },
    });
    expect(mismatch).toMatchObject({
      kind: "idempotency_conflict",
      reason: "fingerprint_mismatch",
    });
    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM audit_events WHERE audit_type='idempotency.rejected'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("creates, reuses, and supersedes DecisionPoints with durable history", async () => {
    const identity = {
      project_id: "project-1",
      scope_entity_type: "task",
      scope_entity_id: "task-1",
      reason_class: "architecture_conflict",
      source_instance_id: "conflict-1",
    } as const;
    const input = (id: string, fingerprint: string): V2DecisionPointInput => ({
      id,
      ...identity,
      phase_id: "phase-1",
      task_id: "task-1",
      condition_key: v2DecisionPointConditionKey(identity),
      condition_fingerprint: fingerprint,
      question: "Which architecture boundary should win?",
      context: "Two approved constraints conflict.",
      options: [
        {
          id: "preserve-boundary",
          label: "Preserve boundary",
          impact: "Maintains the approved architecture",
          risk: "Requires rework",
        },
      ],
      recommendation_option_id: "preserve-boundary",
      urgency: "high",
      blocking_scope: { entity_type: "task", entity_id: "task-1" },
      occurred_at: NOW,
      actor_id: "coordinator-1",
      correlation_id: "correlation-decision",
      causation_id: null,
    });
    const factory = {
      bind: (
        sql: Parameters<typeof runner.transaction>[0] extends (tx: infer T) => Promise<unknown>
          ? T
          : never,
      ) => new SqlV2DecisionPointTransaction(sql),
    };

    const created = await upsertV2DecisionPoint({
      transactionRunner: runner,
      transactionFactory: factory,
      input: input("decision-1", "a".repeat(64)),
    });
    const duplicate = await upsertV2DecisionPoint({
      transactionRunner: runner,
      transactionFactory: factory,
      input: input("decision-duplicate", "a".repeat(64)),
    });
    const changed = await upsertV2DecisionPoint({
      transactionRunner: runner,
      transactionFactory: factory,
      input: input("decision-2", "b".repeat(64)),
    });

    expect(created.kind).toBe("created");
    expect(duplicate.kind).toBe("existing");
    expect(changed).toMatchObject({
      kind: "superseded",
      superseded_decision_point_id: "decision-1",
      decision_point: { id: "decision-2", condition_revision: 2 },
    });
    await pg.query(
      `UPDATE decision_points
       SET status = 'resolved', resolved_at = $2
       WHERE id = $1`,
      ["decision-2", NOW],
    );
    const resolvedReplay = await upsertV2DecisionPoint({
      transactionRunner: runner,
      transactionFactory: factory,
      input: input("decision-must-not-reopen", "b".repeat(64)),
    });
    expect(resolvedReplay).toMatchObject({
      kind: "closed_unchanged",
      decision_point: { id: "decision-2", status: "resolved" },
    });
    const counts = await pg.query<{ points: number; events: number; audits: number }>(
      `SELECT
         (SELECT count(*)::int FROM decision_points) AS points,
         (SELECT count(*)::int FROM domain_events
           WHERE event_type = 'decision_point_opened') AS events,
         (SELECT count(*)::int FROM audit_events
           WHERE audit_type = 'decision_point.opened') AS audits`,
    );
    expect(counts.rows[0]).toEqual({ points: 2, events: 2, audits: 2 });
  });

  it("settles a reservation through the production budget adapter", async () => {
    const resolved = await resolveV2BudgetReservationTransaction({
      transactionRunner: runner,
      transactionFactory: sqlV2BudgetTransactionFactory,
      request: {
        reservation_id: "reservation-1",
        expected_version: 1,
        outcome: "partial_usage",
        attributable_usage_usd: 7.5,
        reason: "run completed below its reservation",
        actor_type: "coordinator",
        actor_id: "coordinator-1",
        correlation_id: "correlation-budget",
        causation_id: "command-run-1",
        occurred_at: NOW,
      },
    });

    expect(resolved).toMatchObject({
      status: "settled",
      settled_usd: 7.5,
      released_usd: 12.5,
      retained_usd: 0,
      version: 2,
    });
    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM domain_events WHERE stream_id = 'reservation-1'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("folds lifecycle history and quarantines a one-sided state write", async () => {
    await pg.query(`UPDATE tasks SET state = 'ready', lifecycle_version = 1 WHERE id = 'task-1'`);
    await pg.query(
      `INSERT INTO domain_events (
         event_id, stream_type, stream_id, stream_version, event_type,
         project_id, phase_id, task_id, actor_type, actor_id, correlation_id,
         occurred_at, payload
       ) VALUES (
         'event-task-ready', 'task', 'task-1', 1, 'task_state_transitioned',
         'project-1', 'phase-1', 'task-1', 'coordinator', 'coordinator-1',
         'correlation-lifecycle', $1, $2::jsonb
       )`,
      [
        NOW,
        JSON.stringify({
          kind: "task_state_transitioned",
          task_id: "task-1",
          lifecycle_version: 1,
          from: "pending",
          to: "ready",
          reason: "dependencies satisfied",
        }),
      ],
    );
    const repository = new SqlV2LifecycleRepository(pg);
    const clean = await reconcileV2Lifecycles({
      repository,
      now: () => new Date(NOW),
    });
    expect(clean.mismatches).toHaveLength(0);

    await pg.query(
      "UPDATE tasks SET state = 'in_progress', lifecycle_version = 2 WHERE id = 'task-1'",
    );
    const mismatch = await reconcileV2Lifecycles({
      repository,
      now: () => new Date("2026-07-16T12:05:00.000Z"),
    });
    expect(mismatch.mismatches).toMatchObject([
      { aggregate_kind: "task", aggregate_id: "task-1", code: "state_without_event" },
    ]);
    expect(await repository.hasOpenFinding("task", "task-1")).toBe(true);
  });
});
