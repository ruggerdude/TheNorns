import { PGlite } from "@electric-sql/pglite";
import {
  type V2ApplicationCommandT,
  type V2IdempotencyAttemptT,
  V2IdempotencyRecord,
  type V2IdempotencyRecordT,
  V2ScheduleAgentRunCommand,
  v2CommandIdForDispatchJob,
  v2DecisionPointConditionKey,
} from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type V2ApplicationTransaction,
  type V2DecisionPointInput,
  type V2DecisionPointTransaction,
  type V2DecisionPointWriteInput,
  type V2IdempotencyAuditInput,
  executeV2ApplicationCommand,
  upsertV2DecisionPoint,
  v2ExpectedVersionConflict,
} from "../src/persistence/v2/application.js";
import {
  type V2BudgetReservationRow,
  type V2BudgetResolutionRequest,
  type V2BudgetSweepRepository,
  type V2BudgetTransaction,
  type V2OrphanReservationCandidate,
  resolveV2BudgetReservationTransaction,
  sweepV2OrphanReservations,
} from "../src/persistence/v2/budget.js";
import {
  type PGliteDatabaseLike,
  PGliteTransactionRunner,
  type V2SqlExecutor,
} from "../src/persistence/v2/database.js";

interface IdempotencyRow {
  actor_id: string;
  command_family: string;
  idempotency_key: string;
  request_fingerprint: string;
  command_id: string;
  status: V2IdempotencyRecordT["status"];
  response: V2IdempotencyRecordT["response"];
  created_at: string;
  updated_at: string;
  retain_until: string;
  asynchronous_work_until: string | null;
  rollback_window_until: string | null;
}

class SqlApplicationTransaction implements V2ApplicationTransaction {
  constructor(
    readonly sql: V2SqlExecutor,
    private readonly lockAvailable = true,
  ) {}

  async tryAcquireIdempotencyLock(): Promise<boolean> {
    return this.lockAvailable;
  }

  async findIdempotency(scope: V2IdempotencyAttemptT): Promise<V2IdempotencyRecordT | null> {
    const result = await this.sql.query<IdempotencyRow>(
      `SELECT * FROM idempotency_records
       WHERE actor_id = $1 AND command_family = $2 AND idempotency_key = $3`,
      [scope.actor_id, scope.command_family, scope.idempotency_key],
    );
    const row = result.rows[0];
    return row ? V2IdempotencyRecord.parse({ schema_version: 2, ...row }) : null;
  }

  async insertIdempotency(record: V2IdempotencyRecordT): Promise<void> {
    await this.sql.query(
      `INSERT INTO idempotency_records (
         actor_id, command_family, idempotency_key, request_fingerprint,
         command_id, status, response, created_at, updated_at, retain_until,
         asynchronous_work_until, rollback_window_until
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
      [
        record.actor_id,
        record.command_family,
        record.idempotency_key,
        record.request_fingerprint,
        record.command_id,
        record.status,
        JSON.stringify(record.response),
        record.created_at,
        record.updated_at,
        record.retain_until,
        record.asynchronous_work_until,
        record.rollback_window_until,
      ],
    );
  }

  async commitIdempotency(
    scope: V2IdempotencyAttemptT,
    status: "committed_succeeded" | "committed_failed",
    response: NonNullable<V2IdempotencyRecordT["response"]>,
    updatedAt: string,
  ): Promise<void> {
    await this.sql.query(
      `UPDATE idempotency_records
       SET status = $4, response = $5::jsonb, updated_at = $6
       WHERE actor_id = $1 AND command_family = $2 AND idempotency_key = $3`,
      [
        scope.actor_id,
        scope.command_family,
        scope.idempotency_key,
        status,
        JSON.stringify(response),
        updatedAt,
      ],
    );
  }

  async appendIdempotencyAudit(input: V2IdempotencyAuditInput): Promise<void> {
    await this.sql.query(
      `INSERT INTO audit_events (audit_type, actor_id, outcome, summary, occurred_at)
       VALUES ('idempotency.rejected', $1, 'denied', $2, $3)`,
      [input.actor_id, input.reason, input.occurred_at],
    );
  }
}

class SqlDecisionPointTransaction implements V2DecisionPointTransaction {
  constructor(private readonly sql: V2SqlExecutor) {}

  async lockLatestDecisionPoint(conditionKey: string) {
    const result = await this.sql.query<{
      id: string;
      project_id: string;
      condition_key: string;
      condition_fingerprint: string;
      condition_revision: number;
      status: "open" | "resolved" | "dismissed" | "superseded";
      supersedes_decision_point_id: string | null;
    }>(
      `SELECT id, project_id, condition_key, condition_fingerprint, condition_revision, status,
              supersedes_decision_point_id
       FROM decision_points
       WHERE condition_key = $1
       ORDER BY condition_revision DESC
       LIMIT 1
       FOR UPDATE`,
      [conditionKey],
    );
    return result.rows[0] ?? null;
  }

  async insertDecisionPoint(input: V2DecisionPointWriteInput) {
    const result = await this.sql.query<{
      id: string;
      project_id: string;
      condition_key: string;
      condition_fingerprint: string;
      condition_revision: number;
      status: "open";
      supersedes_decision_point_id: string | null;
    }>(
      `INSERT INTO decision_points (
         id, project_id, condition_key, condition_fingerprint, condition_revision, status,
         supersedes_decision_point_id
       ) VALUES ($1,$2,$3,$4,$5,'open',$6)
       RETURNING id, project_id, condition_key, condition_fingerprint, condition_revision, status,
                 supersedes_decision_point_id`,
      [
        input.id,
        input.project_id,
        input.condition_key,
        input.condition_fingerprint,
        input.condition_revision,
        input.supersedes_decision_point_id,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("decision point insert returned no row");
    return row;
  }

  async supersedeAndInsertDecisionPoint(
    existing: Awaited<ReturnType<SqlDecisionPointTransaction["lockLatestDecisionPoint"]>> & {},
    input: V2DecisionPointWriteInput,
  ) {
    await this.sql.query("UPDATE decision_points SET status = 'superseded' WHERE id = $1", [
      existing.id,
    ]);
    return this.insertDecisionPoint(input);
  }
}

class SqlBudgetTransaction implements V2BudgetTransaction {
  constructor(private readonly sql: V2SqlExecutor) {}

  async lockReservation(reservationId: string): Promise<V2BudgetReservationRow | null> {
    const result = await this.sql.query<V2BudgetReservationRow>(
      "SELECT * FROM budget_reservations WHERE id = $1 FOR UPDATE",
      [reservationId],
    );
    return result.rows[0] ?? null;
  }

  async applyResolution(
    reservation: V2BudgetReservationRow,
    request: V2BudgetResolutionRequest,
    resolution: {
      status: V2BudgetReservationRow["status"];
      settled_usd: number;
      released_usd: number;
      retained_usd: number;
    },
  ): Promise<V2BudgetReservationRow> {
    const result = await this.sql.query<V2BudgetReservationRow>(
      `UPDATE budget_reservations
       SET status = $2, settled_usd = $3, released_usd = $4, retained_usd = $5,
           resolution_outcome = $6, version = version + 1
       WHERE id = $1 AND version = $7
       RETURNING *`,
      [
        reservation.id,
        resolution.status,
        resolution.settled_usd,
        resolution.released_usd,
        resolution.retained_usd,
        request.outcome,
        request.expected_version,
      ],
    );
    const updated = result.rows[0];
    if (!updated) throw new Error("budget reservation changed concurrently");
    await this.sql.query(
      `INSERT INTO domain_events (stream_type, stream_id, event_type, payload)
       VALUES ('budget_reservation', $1, 'budget_reservation_resolved', $2::jsonb)`,
      [
        reservation.id,
        JSON.stringify({
          outcome: request.outcome,
          settled_usd: resolution.settled_usd,
          released_usd: resolution.released_usd,
          retained_usd: resolution.retained_usd,
        }),
      ],
    );
    await this.sql.query(
      `INSERT INTO audit_events (audit_type, actor_id, outcome, summary, occurred_at)
       VALUES ('budget.resolved', $1, 'succeeded', $2, $3)`,
      [request.actor_id, request.reason, request.occurred_at],
    );
    return updated;
  }
}

class SqlBudgetSweepRepository implements V2BudgetSweepRepository {
  constructor(private readonly sql: V2SqlExecutor) {}

  async findOrphanCandidates(now: string, limit: number): Promise<V2OrphanReservationCandidate[]> {
    const result = await this.sql.query<V2OrphanReservationCandidate>(
      `SELECT id AS reservation_id, version AS expected_version,
              'expired'::text AS safe_outcome,
              'expired orphan reservation'::text AS reason,
              project_id
       FROM budget_reservations
       WHERE status = 'active' AND expires_at <= $1
       ORDER BY id
       LIMIT $2`,
      [now, limit],
    );
    return result.rows;
  }
}

let pg: PGlite;
let runner: PGliteTransactionRunner;

beforeEach(async () => {
  pg = new PGlite();
  runner = new PGliteTransactionRunner(pg as unknown as PGliteDatabaseLike);
  await pg.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL,
      lifecycle_version INTEGER NOT NULL
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      state TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL,
      lifecycle_version INTEGER NOT NULL
    );
    CREATE TABLE domain_events (
      id BIGSERIAL PRIMARY KEY,
      stream_type TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL
    );
    CREATE TABLE audit_events (
      id BIGSERIAL PRIMARY KEY,
      audit_type TEXT NOT NULL,
      actor_id TEXT,
      outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE budget_reservations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      amount_usd DOUBLE PRECISION NOT NULL,
      settled_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      released_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      retained_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      resolution_outcome TEXT,
      version INTEGER NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE commands (
      command_id TEXT PRIMARY KEY,
      dispatch_job_id TEXT NOT NULL UNIQUE,
      envelope JSONB NOT NULL
    );
    CREATE TABLE dispatch_jobs (
      job_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE idempotency_records (
      actor_id TEXT NOT NULL,
      command_family TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      command_id TEXT NOT NULL,
      status TEXT NOT NULL,
      response JSONB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      retain_until TEXT NOT NULL,
      asynchronous_work_until TEXT,
      rollback_window_until TEXT,
      PRIMARY KEY (actor_id, command_family, idempotency_key)
    );
    CREATE TABLE decision_points (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      condition_key TEXT NOT NULL,
      condition_fingerprint TEXT NOT NULL,
      condition_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      supersedes_decision_point_id TEXT
    );
    CREATE UNIQUE INDEX one_open_decision_per_condition
      ON decision_points(condition_key) WHERE status = 'open';
  `);
});

afterEach(async () => {
  await pg.close();
});

function scheduleCommand(overrides: Record<string, unknown> = {}): V2ApplicationCommandT {
  return V2ScheduleAgentRunCommand.parse({
    schema_version: 2,
    kind: "schedule_agent_run",
    command_id: "app-command-1",
    command_family: "task_execution",
    actor: { actor_type: "coordinator", actor_id: "coordinator-1" },
    idempotency_key: "schedule-task-1-attempt-1",
    correlation_id: "correlation-1",
    causation_id: null,
    issued_at: "2026-07-16T12:00:00.000Z",
    project_id: "project-1",
    phase_id: "phase-1",
    task_id: "task-1",
    assignment_id: "assignment-1",
    run_id: "run-1",
    expected_task_version: 1,
    expected_assignment_version: 1,
    runner_id: "runner-1",
    runner_generation: 1,
    repository_binding_id: "repository-1",
    expected_revision: "abc123",
    budget_reservation_id: "reservation-1",
    max_charge_usd: 20,
    ...overrides,
  });
}

async function seedScheduledTask(): Promise<void> {
  await pg.query(
    "INSERT INTO tasks VALUES ('task-1','assigned',1,2), ('task-rollback','assigned',1,2)",
  );
  await pg.query(
    `INSERT INTO agent_runs VALUES
      ('run-1','task-1','created',1,0),
      ('run-rollback','task-rollback','created',1,0)`,
  );
}

async function scheduleMutation(
  tx: SqlApplicationTransaction,
  command: V2ApplicationCommandT,
  failAfterWrites = false,
) {
  if (command.kind !== "schedule_agent_run") throw new Error("unexpected command");
  const taskResult = await tx.sql.query<{
    state: string;
    aggregate_version: number;
    lifecycle_version: number;
  }>("SELECT state, aggregate_version, lifecycle_version FROM tasks WHERE id = $1 FOR UPDATE", [
    command.task_id,
  ]);
  const task = taskResult.rows[0];
  if (!task) return { outcome: "failed" as const, http_status: 404, body: { error: "not_found" } };
  if (task.aggregate_version !== command.expected_task_version) {
    await tx.sql.query(
      `INSERT INTO audit_events (audit_type, actor_id, outcome, summary, occurred_at)
       VALUES ('task.version_conflict', $1, 'denied', $2, $3)`,
      [command.actor.actor_id, command.task_id, command.issued_at],
    );
    return v2ExpectedVersionConflict({
      entity_type: "task",
      entity_id: command.task_id,
      expected_version: command.expected_task_version,
      actual_version: task.aggregate_version,
    });
  }

  const jobId = `job:${command.run_id}`;
  const runnerCommandId = v2CommandIdForDispatchJob(jobId);
  await tx.sql.query(
    `UPDATE tasks
     SET state = 'in_progress', aggregate_version = aggregate_version + 1,
         lifecycle_version = lifecycle_version + 1
     WHERE id = $1`,
    [command.task_id],
  );
  await tx.sql.query(
    `UPDATE agent_runs
     SET state = 'dispatched', aggregate_version = aggregate_version + 1,
         lifecycle_version = lifecycle_version + 1
     WHERE id = $1`,
    [command.run_id],
  );
  await tx.sql.query(
    `INSERT INTO domain_events (stream_type, stream_id, event_type, payload) VALUES
       ('task',$1,'task_state_transitioned',$2::jsonb),
       ('agent_run',$3,'agent_run_state_transitioned',$4::jsonb),
       ('dispatch_job',$5,'dispatch_command_created',$6::jsonb)`,
    [
      command.task_id,
      JSON.stringify({ from: "assigned", to: "in_progress", lifecycle_version: 3 }),
      command.run_id,
      JSON.stringify({ from: "created", to: "dispatched", lifecycle_version: 1 }),
      jobId,
      JSON.stringify({ command_id: runnerCommandId }),
    ],
  );
  await tx.sql.query(
    `INSERT INTO audit_events (audit_type, actor_id, outcome, summary, occurred_at)
     VALUES ('run.scheduled',$1,'succeeded',$2,$3)`,
    [command.actor.actor_id, command.run_id, command.issued_at],
  );
  if (command.max_charge_usd > 0) {
    await tx.sql.query(
      `INSERT INTO budget_reservations (
         id, project_id, phase_id, task_id, run_id, amount_usd, status, version, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'active',1,'2026-07-17T12:00:00.000Z')`,
      [
        command.budget_reservation_id,
        command.project_id,
        command.phase_id,
        command.task_id,
        command.run_id,
        command.max_charge_usd,
      ],
    );
  }
  await tx.sql.query(
    "INSERT INTO commands (command_id, dispatch_job_id, envelope) VALUES ($1,$2,$3::jsonb)",
    [runnerCommandId, jobId, JSON.stringify({ command_id: runnerCommandId })],
  );
  await tx.sql.query(
    "INSERT INTO dispatch_jobs (job_id, command_id, status) VALUES ($1,$2,'queued')",
    [jobId, runnerCommandId],
  );
  if (failAfterWrites) throw new Error("fault after outbox insert");
  return {
    outcome: "succeeded" as const,
    http_status: 202,
    body: {
      task_id: command.task_id,
      run_id: command.run_id,
      dispatch_job_id: jobId,
      command_id: runnerCommandId,
    },
  };
}

describe("V2 transactional application boundary", () => {
  it("returns an honest retriable conflict when another transaction owns the key", async () => {
    const result = await executeV2ApplicationCommand({
      command: scheduleCommand(),
      transactionRunner: runner,
      transactionFactory: {
        bind: (sql) => new SqlApplicationTransaction(sql, false),
      },
      mutate: async () => {
        throw new Error("a lock loser must not mutate");
      },
    });
    expect(result).toEqual({
      kind: "command_in_progress",
      command_id: null,
    });
  });

  it("commits task/run state, events, audit, budget, command, and outbox atomically", async () => {
    await seedScheduledTask();
    let mutations = 0;
    const command = scheduleCommand();
    const execute = () =>
      executeV2ApplicationCommand({
        command,
        transactionRunner: runner,
        transactionFactory: { bind: (sql) => new SqlApplicationTransaction(sql) },
        now: () => new Date("2026-07-16T12:00:00.000Z"),
        mutate: async (tx, parsed) => {
          mutations += 1;
          return scheduleMutation(tx, parsed);
        },
      });

    const first = await execute();
    expect(first.kind).toBe("executed");
    expect(
      (await pg.query<{ state: string }>("SELECT state FROM tasks WHERE id='task-1'")).rows[0]
        ?.state,
    ).toBe("in_progress");
    expect(
      (await pg.query<{ state: string }>("SELECT state FROM agent_runs WHERE id='run-1'")).rows[0]
        ?.state,
    ).toBe("dispatched");
    expect((await pg.query("SELECT * FROM domain_events")).rows).toHaveLength(3);
    expect((await pg.query("SELECT * FROM audit_events")).rows).toHaveLength(1);
    expect((await pg.query("SELECT * FROM budget_reservations")).rows).toHaveLength(1);
    const job = (
      await pg.query<{ job_id: string; command_id: string }>("SELECT * FROM dispatch_jobs")
    ).rows[0];
    if (!job) throw new Error("expected one dispatch job");
    expect(job.command_id).toBe(v2CommandIdForDispatchJob(job.job_id));

    const replay = await execute();
    expect(replay.kind).toBe("replayed");
    expect(mutations).toBe(1);
    expect(replay.kind === "replayed" ? replay.response : null).toEqual(
      first.kind === "executed" ? first.response : null,
    );
  });

  it("coalesces concurrent duplicate callers into one mutation and one stored response", async () => {
    await seedScheduledTask();
    const command = scheduleCommand();
    let mutations = 0;
    const execute = () =>
      executeV2ApplicationCommand({
        command,
        transactionRunner: runner,
        transactionFactory: { bind: (sql) => new SqlApplicationTransaction(sql) },
        now: () => new Date("2026-07-16T12:00:00.000Z"),
        mutate: async (tx, parsed) => {
          mutations += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return scheduleMutation(tx, parsed);
        },
      });

    const results = await Promise.all([execute(), execute()]);
    expect(results.map((result) => result.kind).sort()).toEqual(["executed", "replayed"]);
    expect(mutations).toBe(1);
    const responses = results.flatMap((result) =>
      result.kind === "executed" || result.kind === "replayed" ? [result.response] : [],
    );
    expect(responses).toHaveLength(2);
    expect(responses[0]).toEqual(responses[1]);
    expect(
      (await pg.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM idempotency_records")).rows[0]
        ?.n,
    ).toBe(1);
    expect((await pg.query("SELECT * FROM domain_events")).rows).toHaveLength(3);
  });

  it("rolls back every write, including the idempotency claim, after a technical fault", async () => {
    await seedScheduledTask();
    const command = scheduleCommand({
      command_id: "app-command-rollback",
      idempotency_key: "rollback-key",
      task_id: "task-rollback",
      run_id: "run-rollback",
      budget_reservation_id: "reservation-rollback",
    });
    await expect(
      executeV2ApplicationCommand({
        command,
        transactionRunner: runner,
        transactionFactory: { bind: (sql) => new SqlApplicationTransaction(sql) },
        mutate: (tx, parsed) => scheduleMutation(tx, parsed, true),
      }),
    ).rejects.toThrow("fault after outbox insert");

    expect(
      (await pg.query<{ state: string }>("SELECT state FROM tasks WHERE id='task-rollback'"))
        .rows[0]?.state,
    ).toBe("assigned");
    expect((await pg.query("SELECT * FROM domain_events")).rows).toHaveLength(0);
    expect((await pg.query("SELECT * FROM budget_reservations")).rows).toHaveLength(0);
    expect((await pg.query("SELECT * FROM commands")).rows).toHaveLength(0);
    expect((await pg.query("SELECT * FROM dispatch_jobs")).rows).toHaveLength(0);
    expect((await pg.query("SELECT * FROM idempotency_records")).rows).toHaveLength(0);
  });

  it("commits and replays expected-version failures, and audits changed-payload key reuse", async () => {
    await seedScheduledTask();
    const stale = scheduleCommand({
      command_id: "stale-command",
      idempotency_key: "stale-key",
      expected_task_version: 99,
    });
    const first = await executeV2ApplicationCommand({
      command: stale,
      transactionRunner: runner,
      transactionFactory: { bind: (sql) => new SqlApplicationTransaction(sql) },
      mutate: scheduleMutation,
    });
    expect(first.kind).toBe("executed");
    expect(first.kind === "executed" ? first.response.http_status : null).toBe(409);
    const replay = await executeV2ApplicationCommand({
      command: stale,
      transactionRunner: runner,
      transactionFactory: { bind: (sql) => new SqlApplicationTransaction(sql) },
      mutate: async () => {
        throw new Error("must not rerun");
      },
    });
    expect(replay.kind).toBe("replayed");

    const mismatch = await executeV2ApplicationCommand({
      command: scheduleCommand({
        command_id: "changed-command",
        idempotency_key: "stale-key",
        expected_task_version: 98,
      }),
      transactionRunner: runner,
      transactionFactory: { bind: (sql) => new SqlApplicationTransaction(sql) },
      mutate: scheduleMutation,
    });
    expect(mismatch).toMatchObject({
      kind: "idempotency_conflict",
      reason: "fingerprint_mismatch",
    });
    expect(
      (
        await pg.query<{ n: number }>(
          "SELECT COUNT(*)::int AS n FROM audit_events WHERE audit_type='idempotency.rejected'",
        )
      ).rows[0]?.n,
    ).toBe(1);
  });
});

describe("V2 DecisionPoint dedupe", () => {
  const input = (id: string, fingerprint: string): V2DecisionPointInput => {
    const identity = {
      project_id: "project-1",
      scope_entity_type: "task",
      scope_entity_id: "task-1",
      reason_class: "merge_conflict",
      source_instance_id: "source-1",
    } as const;
    return {
      id,
      ...identity,
      phase_id: "phase-1",
      task_id: "task-1",
      condition_key: v2DecisionPointConditionKey(identity),
      condition_fingerprint: fingerprint,
      question: "How should the merge conflict be resolved?",
      context: "Two valid changes overlap.",
      options: [
        {
          id: "resolve-manually",
          label: "Resolve manually",
          impact: "Preserves both changes",
          risk: "Requires human judgment",
        },
      ],
      recommendation_option_id: "resolve-manually",
      urgency: "high",
      blocking_scope: { entity_type: "task", entity_id: "task-1" },
      occurred_at: "2026-07-16T12:00:00.000Z",
      actor_id: "coordinator-1",
      correlation_id: "correlation-1",
      causation_id: null,
    };
  };

  it("reuses the same condition revision and atomically supersedes changed material state", async () => {
    const factory = { bind: (sql: V2SqlExecutor) => new SqlDecisionPointTransaction(sql) };
    const created = await upsertV2DecisionPoint({
      transactionRunner: runner,
      transactionFactory: factory,
      input: input("decision-1", "a".repeat(64)),
    });
    expect(created.kind).toBe("created");
    const duplicate = await upsertV2DecisionPoint({
      transactionRunner: runner,
      transactionFactory: factory,
      input: input("decision-unused", "a".repeat(64)),
    });
    expect(duplicate).toMatchObject({ kind: "existing" });

    const changed = await upsertV2DecisionPoint({
      transactionRunner: runner,
      transactionFactory: factory,
      input: input("decision-2", "b".repeat(64)),
    });
    expect(changed).toMatchObject({
      kind: "superseded",
      superseded_decision_point_id: "decision-1",
    });
    const rows = await pg.query<{ id: string; status: string }>(
      "SELECT id, status FROM decision_points ORDER BY id",
    );
    expect(rows.rows).toEqual([
      { id: "decision-1", status: "superseded" },
      { id: "decision-2", status: "open" },
    ]);
  });

  it("does not resurrect a resolved condition until its material fingerprint changes", async () => {
    const factory = { bind: (sql: V2SqlExecutor) => new SqlDecisionPointTransaction(sql) };
    await upsertV2DecisionPoint({
      transactionRunner: runner,
      transactionFactory: factory,
      input: input("decision-resolved", "a".repeat(64)),
    });
    await pg.query("UPDATE decision_points SET status = 'resolved' WHERE id = 'decision-resolved'");

    const unchanged = await upsertV2DecisionPoint({
      transactionRunner: runner,
      transactionFactory: factory,
      input: input("decision-unused", "a".repeat(64)),
    });
    expect(unchanged).toMatchObject({
      kind: "closed_unchanged",
      decision_point: { id: "decision-resolved", status: "resolved" },
    });
    expect((await pg.query("SELECT * FROM decision_points")).rows).toHaveLength(1);

    const changed = await upsertV2DecisionPoint({
      transactionRunner: runner,
      transactionFactory: factory,
      input: input("decision-reopened", "b".repeat(64)),
    });
    expect(changed).toMatchObject({
      kind: "superseded",
      decision_point: { id: "decision-reopened", condition_revision: 2 },
    });
  });

  it("rolls back a crash after insertion and creates exactly one point on restart", async () => {
    let injectCrash = true;
    const crashingFactory = {
      bind: (sql: V2SqlExecutor): V2DecisionPointTransaction => {
        const delegate = new SqlDecisionPointTransaction(sql);
        return {
          lockLatestDecisionPoint: (conditionKey) => delegate.lockLatestDecisionPoint(conditionKey),
          insertDecisionPoint: async (writeInput) => {
            const point = await delegate.insertDecisionPoint(writeInput);
            if (injectCrash) {
              injectCrash = false;
              throw new Error("crash after DecisionPoint insert");
            }
            return point;
          },
          supersedeAndInsertDecisionPoint: (existing, writeInput) =>
            delegate.supersedeAndInsertDecisionPoint(existing, writeInput),
        };
      },
    };

    await expect(
      upsertV2DecisionPoint({
        transactionRunner: runner,
        transactionFactory: crashingFactory,
        input: input("decision-crash", "a".repeat(64)),
      }),
    ).rejects.toThrow("crash after DecisionPoint insert");
    expect((await pg.query("SELECT * FROM decision_points")).rows).toHaveLength(0);

    const recovered = await upsertV2DecisionPoint({
      transactionRunner: runner,
      transactionFactory: crashingFactory,
      input: input("decision-recovered", "a".repeat(64)),
    });
    expect(recovered.kind).toBe("created");
    expect((await pg.query("SELECT * FROM decision_points")).rows).toHaveLength(1);
  });
});

describe("V2 budget terminal handling and orphan sweep", () => {
  const factory = { bind: (sql: V2SqlExecutor) => new SqlBudgetTransaction(sql) };

  it("settles attributable usage, releases the remainder, and replays the same outcome", async () => {
    await pg.query(
      `INSERT INTO budget_reservations (
         id, project_id, phase_id, task_id, run_id, amount_usd, status, version, expires_at
       ) VALUES ('budget-1','project-1','phase-1','task-1','run-1',50,'active',1,
                 '2026-07-17T00:00:00.000Z')`,
    );
    const request: V2BudgetResolutionRequest = {
      reservation_id: "budget-1",
      expected_version: 1,
      outcome: "partial_usage",
      attributable_usage_usd: 18,
      reason: "provider usage received",
      actor_type: "system",
      actor_id: "system:usage",
      correlation_id: "correlation-1",
      causation_id: null,
      occurred_at: "2026-07-16T12:00:00.000Z",
    };
    const resolved = await resolveV2BudgetReservationTransaction({
      transactionRunner: runner,
      transactionFactory: factory,
      request,
    });
    expect(resolved).toMatchObject({
      status: "settled",
      settled_usd: 18,
      released_usd: 32,
      retained_usd: 0,
      resolution_outcome: "partial_usage",
    });
    const replay = await resolveV2BudgetReservationTransaction({
      transactionRunner: runner,
      transactionFactory: factory,
      request,
    });
    expect(replay.version).toBe(resolved.version);
    expect((await pg.query("SELECT * FROM domain_events")).rows).toHaveLength(1);
  });

  it("repairs an expired orphan and emits domain and audit evidence", async () => {
    await pg.query(
      `INSERT INTO budget_reservations (
         id, project_id, phase_id, task_id, run_id, amount_usd, status, version, expires_at
       ) VALUES ('budget-orphan','project-1','phase-1','task-1','run-1',30,'active',1,
                 '2026-07-15T00:00:00.000Z')`,
    );
    const result = await sweepV2OrphanReservations({
      transactionRunner: runner,
      transactionFactory: factory,
      sweepRepositoryFactory: {
        bind: (sql) => new SqlBudgetSweepRepository(sql),
      },
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });
    expect(result).toEqual({ repaired: ["budget-orphan"], raced: [] });
    expect(
      (
        await pg.query<{
          status: string;
          released_usd: number;
          resolution_outcome: string;
        }>("SELECT status, released_usd, resolution_outcome FROM budget_reservations")
      ).rows[0],
    ).toEqual({
      status: "released",
      released_usd: 30,
      resolution_outcome: "expired",
    });
    expect((await pg.query("SELECT * FROM domain_events")).rows).toHaveLength(1);
    expect((await pg.query("SELECT * FROM audit_events")).rows).toHaveLength(1);
  });
});
