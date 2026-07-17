import { PGlite } from "@electric-sql/pglite";
import { getTableName } from "drizzle-orm";
import { type PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PHASE1_V2_MIGRATION_NAME,
  type V2MigrationDatabase,
  runPhase1V2Migration,
} from "../src/persistence/v2/migrate.js";
import { phase1V2Schema } from "../src/persistence/v2/schema.js";

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;
const postgresIdentifier = (name: string): string => name.slice(0, 63);

describe.sequential("Phase 1 V2 runtime-role migration preflight", () => {
  it("refuses to apply when norns_app has not been provisioned", async () => {
    const candidate = new PGlite();
    try {
      await expect(runPhase1V2Migration(asMigrationDatabase(candidate))).rejects.toThrow(
        /required runtime role norns_app does not exist/,
      );
      const tables = await candidate.query<{ projects: string | null }>(
        "SELECT to_regclass('projects')::text AS projects",
      );
      expect(tables.rows[0]?.projects).toBeNull();
    } finally {
      await candidate.close();
    }
  });

  it("refuses to apply when the migration login cannot assume norns_app", async () => {
    const candidate = new PGlite();
    await candidate.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE ROLE migration_actor NOLOGIN;
      GRANT USAGE, CREATE ON SCHEMA public TO migration_actor;
      SET ROLE migration_actor;
    `);
    try {
      await expect(runPhase1V2Migration(asMigrationDatabase(candidate))).rejects.toThrow(
        /cannot SET ROLE norns_app/,
      );
      const tables = await candidate.query<{ projects: string | null }>(
        "SELECT to_regclass('projects')::text AS projects",
      );
      expect(tables.rows[0]?.projects).toBeNull();
    } finally {
      await candidate.exec("RESET ROLE");
      await candidate.close();
    }
  });
});

describe.sequential("Phase 1 V2 normalized schema", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE ROLE norns_app NOLOGIN;

      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO norns_state (key, snapshot)
      VALUES ('projects', '{"legacy":true,"projectIds":["legacy-project"]}'::jsonb);
    `);

    await runPhase1V2Migration(asMigrationDatabase(pg));
    await pg.exec(`
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES (
        'project-main', 'Main project', 'active',
        'assignment/default', 'verification/default', 'budget/default'
      );

      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, default_branch,
        verification_policy_ref, created_by_actor_type
      ) VALUES (
        'binding-main', 'project-main', 'local_runner', 'connected', 'runner-1', 'workspace-1',
        'repository-1', 'Repository One', 'main',
        'verification/default', 'human'
      );

      INSERT INTO phases (id, project_id, objective_summary, status)
      VALUES
        ('phase-a', 'project-main', 'First phase', 'approved'),
        ('phase-b', 'project-main', 'Second phase', 'approved');

      INSERT INTO strategy_versions (
        id, project_id, phase_id, version, status, objective, content,
        convergence, content_hash
      ) VALUES
        (
          'strategy-a', 'project-main', 'phase-a', 1, 'approved', 'First phase',
          '{}'::jsonb, 'converged', repeat('a', 64)
        ),
        (
          'strategy-b', 'project-main', 'phase-b', 1, 'approved', 'Second phase',
          '{}'::jsonb, 'converged', repeat('b', 64)
        );

      INSERT INTO objectives (
        id, project_id, phase_id, outcome, success_measures, status
      ) VALUES
        ('objective-a', 'project-main', 'phase-a', 'Outcome A', '["A"]'::jsonb, 'active'),
        ('objective-b', 'project-main', 'phase-b', 'Outcome B', '["B"]'::jsonb, 'active');

      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id,
        title, description, deliverables, acceptance_criteria,
        complexity, risk, required_roles, expected_outputs,
        environment_policy_ref, verification_policy_ref, state, lifecycle_version
      ) VALUES
        (
          'task-a', 'project-main', 'phase-a', 'objective-a', 'strategy-a',
          'Task A', 'First task', '["artifact"]'::jsonb, '["green"]'::jsonb,
          'M', 'medium', '["implementation"]'::jsonb, '["commit"]'::jsonb,
          'environment/default', 'verification/default', 'ready', 1
        ),
        (
          'task-b', 'project-main', 'phase-b', 'objective-b', 'strategy-b',
          'Task B', 'Second task', '["artifact"]'::jsonb, '["green"]'::jsonb,
          'M', 'medium', '["implementation"]'::jsonb, '["commit"]'::jsonb,
          'environment/default', 'verification/default', 'ready', 1
        );

      INSERT INTO agent_profiles (
        id, provider, runtime, model, roles, context_limit_tokens,
        status, cost_metadata
      ) VALUES (
        'agent-1', 'openai', 'codex', 'codex', '["implementation"]'::jsonb,
        128000, 'available', '{}'::jsonb
      );

      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status,
        rationale, rationale_factors, allocation_policy_ref
      ) VALUES (
        'assignment-1', 'project-main', 'phase-a', 'task-a', 'agent-1', 'active',
        'Best available implementation agent', '["capability"]'::jsonb,
        'assignment/default'
      );

      INSERT INTO agent_runs (
        id, project_id, phase_id, task_id, assignment_id, attempt, state,
        is_designated, repository_binding_id, expected_revision
      ) VALUES (
        'run-1', 'project-main', 'phase-a', 'task-a', 'assignment-1', 1, 'created',
        true, 'binding-main', '0123456789abcdef'
      );

      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES (
        'project-other', 'Other project', 'active',
        'assignment/default', 'verification/default', 'budget/default'
      );

      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, default_branch,
        verification_policy_ref, created_by_actor_type
      ) VALUES (
        'binding-other', 'project-other', 'local_runner', 'connected', 'runner-2', 'workspace-2',
        'repository-2', 'Repository Two', 'main',
        'verification/default', 'human'
      );

      INSERT INTO phases (id, project_id, objective_summary, status)
      VALUES ('phase-other', 'project-other', 'Other phase', 'approved');

      INSERT INTO strategy_versions (
        id, project_id, phase_id, version, status, objective, content,
        convergence, content_hash
      ) VALUES (
        'strategy-other', 'project-other', 'phase-other', 1, 'approved', 'Other phase',
        '{}'::jsonb, 'converged', repeat('d', 64)
      );

      INSERT INTO objectives (
        id, project_id, phase_id, outcome, success_measures, status
      ) VALUES (
        'objective-other', 'project-other', 'phase-other',
        'Other outcome', '["other"]'::jsonb, 'active'
      );

      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id,
        title, description, deliverables, acceptance_criteria,
        complexity, risk, required_roles, expected_outputs,
        environment_policy_ref, verification_policy_ref, state, lifecycle_version
      ) VALUES (
        'task-other', 'project-other', 'phase-other', 'objective-other', 'strategy-other',
        'Other task', 'Other project task', '["artifact"]'::jsonb, '["green"]'::jsonb,
        'M', 'medium', '["implementation"]'::jsonb, '["commit"]'::jsonb,
        'environment/default', 'verification/default', 'ready', 1
      );

      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status,
        rationale, rationale_factors, allocation_policy_ref
      ) VALUES (
        'assignment-other', 'project-other', 'phase-other', 'task-other', 'agent-1', 'active',
        'Best available implementation agent', '["capability"]'::jsonb,
        'assignment/default'
      );

      INSERT INTO agent_runs (
        id, project_id, phase_id, task_id, assignment_id, attempt, state,
        is_designated, repository_binding_id, expected_revision
      ) VALUES (
        'run-other', 'project-other', 'phase-other', 'task-other', 'assignment-other',
        1, 'created', true, 'binding-other', 'fedcba9876543210'
      );
    `);
  }, 30_000);

  afterAll(async () => {
    if (!pg.closed) await pg.close();
  });

  it("applies every Drizzle table, named constraint, and index idempotently", async () => {
    const schemaTables = Object.values(phase1V2Schema) as PgTable[];
    const expectedTableNames = schemaTables.map((table) => getTableName(table)).sort();
    const tableRows = await pg.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'`,
    );
    const actualTableNames = tableRows.rows.map((row) => row.table_name);
    expect(actualTableNames).toEqual(expect.arrayContaining(expectedTableNames));

    const columnRows = await pg.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'`,
    );
    for (const table of schemaTables) {
      const tableName = getTableName(table);
      const actualColumns = columnRows.rows
        .filter((row) => row.table_name === tableName)
        .map((row) => row.column_name);
      const expectedColumns = getTableConfig(table).columns.map((column) => column.name);
      expect(actualColumns, `${tableName} columns`).toEqual(
        expect.arrayContaining(expectedColumns),
      );
    }

    const expectedIndexes = schemaTables.flatMap((table) =>
      getTableConfig(table).indexes.map((index) => index.config.name),
    );
    const indexRows = await pg.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
    );
    const actualIndexes = indexRows.rows.map((row) => row.indexname);
    expect(actualIndexes).toEqual(expect.arrayContaining(expectedIndexes));

    const expectedConstraints = schemaTables
      .flatMap((table) => {
        const config = getTableConfig(table);
        return [
          ...config.checks.map((constraint) => constraint.name),
          ...config.foreignKeys.map((constraint) => constraint.getName()),
          ...config.primaryKeys.map((constraint) => constraint.getName()),
          ...config.uniqueConstraints
            .map((constraint) => constraint.getName())
            .filter((name): name is string => name !== undefined),
        ];
      })
      .map(postgresIdentifier);
    const constraintRows = await pg.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace`,
    );
    const actualConstraints = constraintRows.rows.map((row) => row.conname);
    expect(actualConstraints).toEqual(expect.arrayContaining(expectedConstraints));

    const primaryKeyRows = await pg.query<{ table_name: string }>(
      `SELECT relation.relname AS table_name
       FROM pg_constraint AS catalog_constraint
       JOIN pg_class AS relation ON relation.oid = catalog_constraint.conrelid
       WHERE catalog_constraint.contype = 'p'
         AND relation.relnamespace = 'public'::regnamespace`,
    );
    const primaryKeyTables = primaryKeyRows.rows.map((row) => row.table_name);
    expect(primaryKeyTables).toEqual(expect.arrayContaining(expectedTableNames));

    const secondRun = await runPhase1V2Migration(asMigrationDatabase(pg));
    expect(secondRun).toMatchObject({
      name: PHASE1_V2_MIGRATION_NAME,
      applied: false,
    });
    const tracking = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM norns_schema_migrations",
    );
    expect(tracking.rows[0]?.count).toBe(1);
  });

  it("preserves the legacy snapshot table and its exact JSON data", async () => {
    const result = await pg.query<{ snapshot: { legacy: boolean; projectIds: string[] } }>(
      "SELECT snapshot FROM norns_state WHERE key = 'projects'",
    );
    expect(result.rows[0]?.snapshot).toEqual({
      legacy: true,
      projectIds: ["legacy-project"],
    });
  });

  it("rejects a TaskDependency that crosses phase scope", async () => {
    await expect(
      pg.query(
        `INSERT INTO task_dependencies (
           id, project_id, phase_id, predecessor_task_id, successor_task_id
         ) VALUES ('cross-phase', 'project-main', 'phase-a', 'task-a', 'task-b')`,
      ),
    ).rejects.toThrow();

    const result = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM task_dependencies WHERE id = 'cross-phase'",
    );
    expect(result.rows[0]?.count).toBe(0);
  });

  it("rejects cross-project repository, run, and command relationships", async () => {
    await expect(
      pg.query(
        `UPDATE projects
         SET primary_repository_binding_id = 'binding-other'
         WHERE id = 'project-main'`,
      ),
    ).rejects.toThrow();

    await expect(
      pg.query(
        `UPDATE phases
         SET approved_strategy_version_id = 'strategy-other'
         WHERE id = 'phase-a'`,
      ),
    ).rejects.toThrow();

    await expect(
      pg.query(
        `UPDATE tasks
         SET designated_run_id = 'run-other'
         WHERE id = 'task-a'`,
      ),
    ).rejects.toThrow();

    await expect(
      pg.query(
        `INSERT INTO agent_runs (
           id, project_id, phase_id, task_id, assignment_id, attempt, state,
           repository_binding_id, expected_revision
         ) VALUES (
           'run-cross-project', 'project-main', 'phase-a', 'task-a', 'assignment-1',
           2, 'created', 'binding-other', '0123456789abcdef'
         )`,
      ),
    ).rejects.toThrow();

    await expect(
      pg.query(
        `INSERT INTO verification_results (
           id, project_id, phase_id, task_id, run_id, repository_binding_id,
           commit_sha, verification_policy_ref, passed, command_results,
           evidence, produced_by_runner_id
         ) VALUES (
           'verification-cross-project', 'project-main', 'phase-a', 'task-a',
           'run-1', 'binding-other', '0123456789abcdef', 'verification/default',
           true, '[]'::jsonb, '[]'::jsonb, 'runner-1'
         )`,
      ),
    ).rejects.toThrow();

    await expect(
      pg.query(
        `INSERT INTO commands (
           command_id, dispatch_job_id, project_id, phase_id, task_id, run_id,
           runner_id, runner_generation, kind, envelope, correlation_id
         ) VALUES (
           'dispatch:cross-run', 'job-cross-run', 'project-main', 'phase-a', 'task-a',
           'run-other', 'runner-1', 1, 'launch_run', '{}'::jsonb, 'correlation-cross'
         )`,
      ),
    ).rejects.toThrow();

    await expect(
      pg.query(
        `INSERT INTO decision_points (
           id, project_id, phase_id, task_id, scope_entity_type, scope_entity_id,
           reason_class, source_instance_id, condition_key, condition_fingerprint,
           question, context, options, recommendation_option_id, urgency, status
         ) VALUES (
           'decision-cross-project', 'project-main', NULL, 'task-other', 'task',
           'task-other', 'repository_conflict', 'conflict-cross',
           'task:task-other:repository_conflict', $1,
           'Choose a resolution', 'Cross-project scope must fail',
           '[{"id":"resolve","label":"Resolve"}]'::jsonb, 'resolve', 'high', 'open'
         )`,
        ["e".repeat(64)],
      ),
    ).rejects.toThrow();

    await pg.query(
      `INSERT INTO commands (
         command_id, dispatch_job_id, project_id, phase_id, task_id, run_id,
         runner_id, runner_generation, kind, envelope, correlation_id
       ) VALUES (
         'dispatch:job-other', 'job-other', 'project-other', 'phase-other',
         'task-other', 'run-other', 'runner-2', 1, 'launch_run', '{}'::jsonb,
         'correlation-other'
       )`,
    );

    await expect(
      pg.query(
        `INSERT INTO dispatch_jobs (
           id, project_id, phase_id, task_id, run_id, command_id, runner_id
         ) VALUES (
           'job-cross-command', 'project-main', 'phase-a', 'task-a', 'run-1',
           'dispatch:job-other', 'runner-1'
         )`,
      ),
    ).rejects.toThrow();
  });

  it("requires review and completion evidence before completing a task", async () => {
    await expect(
      pg.query(
        `UPDATE tasks
         SET state = 'completed', completed_at = now()
         WHERE id = 'task-b'`,
      ),
    ).rejects.toThrow();

    await pg.query(
      `UPDATE tasks
       SET state = 'completed',
           completed_at = now(),
           review_evidence = '["review:passed"]'::jsonb,
           completion_evidence = '["verification:green"]'::jsonb
       WHERE id = 'task-b'`,
    );
    const result = await pg.query<{ state: string }>("SELECT state FROM tasks WHERE id = 'task-b'");
    expect(result.rows[0]?.state).toBe("completed");
  });

  it("pins lifecycle version zero to the published origin states", async () => {
    await expect(
      pg.query(
        `UPDATE tasks
         SET lifecycle_version = 0
         WHERE id = 'task-a'`,
      ),
    ).rejects.toThrow();

    await expect(
      pg.query(
        `UPDATE agent_runs
         SET state = 'running'
         WHERE id = 'run-1'`,
      ),
    ).rejects.toThrow();

    await expect(
      pg.query(
        `UPDATE agent_runs
         SET lifecycle_version = -1
         WHERE id = 'run-1'`,
      ),
    ).rejects.toThrow();

    const task = await pg.query<{ lifecycle_version: number; state: string }>(
      "SELECT lifecycle_version, state FROM tasks WHERE id = 'task-a'",
    );
    const run = await pg.query<{ lifecycle_version: number; state: string }>(
      "SELECT lifecycle_version, state FROM agent_runs WHERE id = 'run-1'",
    );
    expect(task.rows[0]).toEqual({ lifecycle_version: 1, state: "ready" });
    expect(run.rows[0]).toEqual({ lifecycle_version: 0, state: "created" });
  });

  it("allows only one open DecisionPoint for a stable condition key", async () => {
    const insert = (id: string, status: string) =>
      pg.query(
        `INSERT INTO decision_points (
           id, project_id, phase_id, task_id, scope_entity_type, scope_entity_id,
           reason_class, source_instance_id, condition_key, condition_fingerprint,
           question, context, options, recommendation_option_id, urgency, status
         ) VALUES (
           $1, 'project-main', 'phase-a', 'task-a', 'task', 'task-a',
           'repository_conflict', 'conflict-1', 'task:task-a:repository_conflict',
           $2, 'Choose a resolution', 'The branch cannot merge cleanly',
           '[{"id":"resolve","label":"Resolve"}]'::jsonb, 'resolve', 'high', $3
         )`,
        [id, "c".repeat(64), status],
      );

    await insert("decision-1", "open");
    await expect(insert("decision-duplicate", "open")).rejects.toThrow();
    await insert("decision-history", "resolved");

    const result = await pg.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM decision_points
       WHERE condition_key = 'task:task-a:repository_conflict' AND status = 'open'`,
    );
    expect(result.rows[0]?.count).toBe(1);
  });

  it("preserves resolved and dismissed DecisionPoint dispositions across supersession", async () => {
    const insert = (
      id: string,
      conditionKey: string,
      status: "open" | "resolved" | "dismissed",
      revision: number,
      supersedes: string | null = null,
    ) =>
      pg.query(
        `INSERT INTO decision_points (
           id, project_id, phase_id, task_id, scope_entity_type, scope_entity_id,
           reason_class, source_instance_id, condition_key, condition_fingerprint,
           condition_revision, question, context, options, recommendation_option_id,
           urgency, status, supersedes_decision_point_id, resolved_at
         ) VALUES (
           $1, 'project-main', 'phase-a', 'task-a', 'task', 'task-a',
           'architecture_choice', $2, $3, $4, $5,
           'Choose a resolution', 'The material condition changed',
           '[{"id":"resolve","label":"Resolve"}]'::jsonb, 'resolve', 'high', $6, $7,
           CASE WHEN $6 = 'open' THEN NULL ELSE now() END
         )`,
        [
          id,
          `${conditionKey}:${revision}`,
          conditionKey,
          "f".repeat(64),
          revision,
          status,
          supersedes,
        ],
      );

    await insert("decision-resolved", "task:task-a:architecture_choice", "resolved", 1);
    await insert(
      "decision-resolved-revision",
      "task:task-a:architecture_choice",
      "open",
      2,
      "decision-resolved",
    );
    await pg.query(
      `UPDATE decision_points
       SET superseded_by_decision_point_id = 'decision-resolved-revision'
       WHERE id = 'decision-resolved'`,
    );

    await expect(
      pg.query(
        `UPDATE decision_points
         SET status = 'superseded'
         WHERE id = 'decision-resolved'`,
      ),
    ).rejects.toThrow(/terminal status resolved/);

    await insert("decision-dismissed", "task:task-a:architecture_dismissed", "dismissed", 1);
    await expect(
      pg.query(
        `UPDATE decision_points
         SET status = 'superseded'
         WHERE id = 'decision-dismissed'`,
      ),
    ).rejects.toThrow(/terminal status dismissed/);

    const result = await pg.query<{
      id: string;
      status: string;
      superseded_by_decision_point_id: string | null;
    }>(
      `SELECT id, status, superseded_by_decision_point_id
       FROM decision_points
       WHERE id IN ('decision-resolved', 'decision-dismissed')
       ORDER BY id`,
    );
    expect(result.rows).toEqual([
      {
        id: "decision-dismissed",
        status: "dismissed",
        superseded_by_decision_point_id: null,
      },
      {
        id: "decision-resolved",
        status: "resolved",
        superseded_by_decision_point_id: "decision-resolved-revision",
      },
    ]);
  });

  it("pins one stable command identity to one dispatch job", async () => {
    await pg.query(
      `INSERT INTO commands (
         command_id, dispatch_job_id, project_id, phase_id, task_id, run_id,
         runner_id, runner_generation, kind, envelope, correlation_id
       ) VALUES (
         'dispatch:job-1', 'job-1', 'project-main', 'phase-a', 'task-a', 'run-1',
         'runner-1', 1, 'launch_run', '{}'::jsonb, 'correlation-1'
       )`,
    );
    await pg.query(
      `INSERT INTO dispatch_jobs (
         id, project_id, phase_id, task_id, run_id, command_id, runner_id
       ) VALUES (
         'job-1', 'project-main', 'phase-a', 'task-a', 'run-1',
         'dispatch:job-1', 'runner-1'
       )`,
    );

    await expect(
      pg.query(
        `INSERT INTO commands (
           command_id, dispatch_job_id, project_id, phase_id, task_id, run_id,
           runner_id, runner_generation, kind, envelope, correlation_id
         ) VALUES (
           'dispatch:job-1-redelivery', 'job-1', 'project-main', 'phase-a',
           'task-a', 'run-1', 'runner-1', 1, 'launch_run', '{}'::jsonb, 'correlation-1'
         )`,
      ),
    ).rejects.toThrow();

    await expect(
      pg.query(
        `INSERT INTO dispatch_jobs (
           id, project_id, phase_id, task_id, run_id, command_id, runner_id
         ) VALUES (
           'job-1-redelivery', 'project-main', 'phase-a', 'task-a', 'run-1',
           'dispatch:job-1', 'runner-1'
         )`,
      ),
    ).rejects.toThrow();

    const result = await pg.query<{ command_id: string; dispatch_job_id: string; job_id: string }>(
      `SELECT commands.command_id, commands.dispatch_job_id, dispatch_jobs.id AS job_id
       FROM commands
       JOIN dispatch_jobs ON dispatch_jobs.command_id = commands.command_id
       WHERE commands.command_id = 'dispatch:job-1'`,
    );
    expect(result.rows).toEqual([
      {
        command_id: "dispatch:job-1",
        dispatch_job_id: "job-1",
        job_id: "job-1",
      },
    ]);
  });

  it("enforces append-only domain and audit history", async () => {
    await pg.query(
      `INSERT INTO domain_events (
         event_id, stream_type, stream_id, stream_version, event_type,
         project_id, phase_id, task_id, actor_type, actor_id,
         correlation_id, occurred_at, payload
       ) VALUES (
         'event-1', 'task', 'task-a', 1, 'TaskReadied',
         'project-main', 'phase-a', 'task-a', 'system', 'coordinator',
         'correlation-1', now(), '{}'::jsonb
       )`,
    );
    await pg.query(
      `INSERT INTO audit_events (
         audit_id, audit_type, project_id, phase_id, task_id, actor_type,
         actor_id, outcome, severity, correlation_id, occurred_at, summary
       ) VALUES (
         'audit-1', 'task.readied', 'project-main', 'phase-a', 'task-a', 'system',
         'coordinator', 'succeeded', 'info', 'correlation-1', now(), 'Task became ready'
       )`,
    );

    await expect(
      pg.query("UPDATE domain_events SET event_type = 'Changed' WHERE event_id = 'event-1'"),
    ).rejects.toThrow(/append-only/);
    await expect(pg.query("DELETE FROM audit_events WHERE audit_id = 'audit-1'")).rejects.toThrow(
      /append-only/,
    );

    await pg.query(
      `INSERT INTO projects (
         id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
       ) VALUES (
         'project-history-only', 'History only', 'active',
         'assignment/default', 'verification/default', 'budget/default'
       )`,
    );
    await pg.query(
      `INSERT INTO domain_events (
         event_id, stream_type, stream_id, stream_version, event_type,
         project_id, actor_type, actor_id, correlation_id, occurred_at, payload
       ) VALUES (
         'event-history-only', 'project', 'project-history-only', 1, 'ProjectCreated',
         'project-history-only', 'system', 'coordinator', 'correlation-history',
         now(), '{}'::jsonb
       )`,
    );
    await expect(
      pg.query("DELETE FROM projects WHERE id = 'project-history-only'"),
    ).rejects.toThrow(/domain_events_project_id_projects_id_fk/);

    await expect(pg.query("TRUNCATE domain_events")).rejects.toThrow(/append-only/);
    await expect(pg.query("TRUNCATE projects CASCADE")).rejects.toThrow(/append-only/);

    const retained = await pg.query<{ domain_count: number; audit_count: number }>(
      `SELECT
         (SELECT count(*)::int FROM domain_events WHERE event_id = 'event-1') AS domain_count,
         (SELECT count(*)::int FROM audit_events WHERE audit_id = 'audit-1') AS audit_count`,
    );
    expect(retained.rows[0]).toEqual({ domain_count: 1, audit_count: 1 });
  });

  it("uses restrictive history foreign keys and an INSERT/SELECT-only runtime role", async () => {
    const deleteActions = await pg.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype
       FROM pg_constraint
       WHERE conrelid IN ('domain_events'::regclass, 'audit_events'::regclass)
         AND contype = 'f'`,
    );
    expect(deleteActions.rows.length).toBeGreaterThan(0);
    expect(deleteActions.rows.every((row) => row.confdeltype === "r")).toBe(true);

    const historyTables = new Set(["domain_events", "audit_events"]);
    const schemaTables = Object.values(phase1V2Schema) as PgTable[];
    for (const table of schemaTables) {
      const tableName = getTableName(table);
      const grants = await pg.query<{
        can_delete: boolean;
        can_insert: boolean;
        can_select: boolean;
        can_truncate: boolean;
        can_update: boolean;
      }>(
        `SELECT
           has_table_privilege('norns_app', $1, 'SELECT') AS can_select,
           has_table_privilege('norns_app', $1, 'INSERT') AS can_insert,
           has_table_privilege('norns_app', $1, 'UPDATE') AS can_update,
           has_table_privilege('norns_app', $1, 'DELETE') AS can_delete,
           has_table_privilege('norns_app', $1, 'TRUNCATE') AS can_truncate`,
        [tableName],
      );
      expect(grants.rows[0], `${tableName} runtime grants`).toEqual({
        can_select: true,
        can_insert: true,
        can_update: !historyTables.has(tableName),
        can_delete: !historyTables.has(tableName),
        can_truncate: false,
      });
    }

    const privileges = await pg.query<{
      audit_can_delete: boolean;
      audit_can_insert: boolean;
      audit_can_select: boolean;
      audit_can_truncate: boolean;
      audit_can_update: boolean;
      can_delete: boolean;
      can_insert: boolean;
      can_select: boolean;
      can_truncate: boolean;
      can_update: boolean;
      projects_can_delete: boolean;
      projects_can_insert: boolean;
      projects_can_select: boolean;
      projects_can_truncate: boolean;
      projects_can_update: boolean;
    }>(
      `SELECT
         has_table_privilege('norns_app', 'domain_events', 'SELECT') AS can_select,
         has_table_privilege('norns_app', 'domain_events', 'INSERT') AS can_insert,
         has_table_privilege('norns_app', 'domain_events', 'UPDATE') AS can_update,
         has_table_privilege('norns_app', 'domain_events', 'DELETE') AS can_delete,
         has_table_privilege('norns_app', 'domain_events', 'TRUNCATE') AS can_truncate,
         has_table_privilege('norns_app', 'audit_events', 'SELECT') AS audit_can_select,
         has_table_privilege('norns_app', 'audit_events', 'INSERT') AS audit_can_insert,
         has_table_privilege('norns_app', 'audit_events', 'UPDATE') AS audit_can_update,
         has_table_privilege('norns_app', 'audit_events', 'DELETE') AS audit_can_delete,
         has_table_privilege('norns_app', 'audit_events', 'TRUNCATE') AS audit_can_truncate,
         has_table_privilege('norns_app', 'projects', 'SELECT') AS projects_can_select,
         has_table_privilege('norns_app', 'projects', 'INSERT') AS projects_can_insert,
         has_table_privilege('norns_app', 'projects', 'UPDATE') AS projects_can_update,
         has_table_privilege('norns_app', 'projects', 'DELETE') AS projects_can_delete,
         has_table_privilege('norns_app', 'projects', 'TRUNCATE') AS projects_can_truncate`,
    );
    expect(privileges.rows[0]).toEqual({
      can_select: true,
      can_insert: true,
      can_update: false,
      can_delete: false,
      can_truncate: false,
      audit_can_select: true,
      audit_can_insert: true,
      audit_can_update: false,
      audit_can_delete: false,
      audit_can_truncate: false,
      projects_can_select: true,
      projects_can_insert: true,
      projects_can_update: true,
      projects_can_delete: true,
      projects_can_truncate: false,
    });

    await pg.exec("SET ROLE norns_app");
    try {
      const project = await pg.query<{ name: string }>(
        "SELECT name FROM projects WHERE id = 'project-main'",
      );
      expect(project.rows[0]?.name).toBe("Main project");
      await pg.query(
        `INSERT INTO projection_checkpoints (
           projection_name, partition_key, version
         ) VALUES ('runtime-role', 'project-main', 1)`,
      );
      await pg.query(
        `UPDATE projection_checkpoints
         SET version = version + 1
         WHERE projection_name = 'runtime-role' AND partition_key = 'project-main'`,
      );
      await pg.query(
        `INSERT INTO domain_events (
           event_id, stream_type, stream_id, stream_version, event_type,
           project_id, phase_id, task_id, actor_type, actor_id,
           correlation_id, occurred_at, payload
         ) VALUES (
           'event-runtime-role', 'task', 'task-a', 2, 'TaskAssigned',
           'project-main', 'phase-a', 'task-a', 'system', 'coordinator',
           'correlation-role', now(), '{}'::jsonb
         )`,
      );
      await pg.query(
        `INSERT INTO audit_events (
           audit_id, audit_type, project_id, phase_id, task_id, actor_type,
           actor_id, outcome, severity, correlation_id, occurred_at, summary
         ) VALUES (
           'audit-runtime-role', 'task.assigned', 'project-main', 'phase-a', 'task-a',
           'system', 'coordinator', 'succeeded', 'info', 'correlation-role',
           now(), 'Task became assigned'
         )`,
      );
      const selected = await pg.query<{ count: number }>(
        `SELECT
           (SELECT count(*)::int
            FROM domain_events
            WHERE event_id = 'event-runtime-role')
           + (SELECT count(*)::int
              FROM audit_events
              WHERE audit_id = 'audit-runtime-role') AS count`,
      );
      expect(selected.rows[0]?.count).toBe(2);
      await expect(
        pg.query(
          "UPDATE domain_events SET event_type = 'Changed' WHERE event_id = 'event-runtime-role'",
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        pg.query("DELETE FROM domain_events WHERE event_id = 'event-runtime-role'"),
      ).rejects.toThrow(/permission denied/);
      await expect(pg.query("TRUNCATE domain_events")).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec("RESET ROLE");
    }
  });

  it("backs up and restores legacy and normalized rows together", async () => {
    const dump = await pg.dumpDataDir();
    const restored = new PGlite({ loadDataDir: dump });
    try {
      await restored.waitReady;
      const legacy = await restored.query<{ snapshot: { legacy: boolean } }>(
        "SELECT snapshot FROM norns_state WHERE key = 'projects'",
      );
      const normalized = await restored.query<{ name: string }>(
        "SELECT name FROM projects WHERE id = 'project-main'",
      );
      const migration = await restored.query<{ checksum: string }>(
        "SELECT checksum FROM norns_schema_migrations WHERE name = $1",
        [PHASE1_V2_MIGRATION_NAME],
      );

      expect(legacy.rows[0]?.snapshot.legacy).toBe(true);
      expect(normalized.rows[0]?.name).toBe("Main project");
      expect(migration.rows[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await restored.close();
    }
  }, 30_000);
});
