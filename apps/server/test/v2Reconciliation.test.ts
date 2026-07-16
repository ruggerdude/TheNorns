import { PGlite } from "@electric-sql/pglite";
import {
  V2AgentRunTransitionEvent,
  type V2AgentRunTransitionEventT,
  V2TaskTransitionEvent,
  type V2TaskTransitionEventT,
} from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  V2AutomationBlockedByIntegrityError,
  type V2LifecycleFinding,
  type V2LifecycleIntegrityGuard,
  type V2LifecycleReconciliationRepository,
  type V2LifecycleRow,
  assertV2AutomationAllowed,
  reconcileV2Lifecycles,
} from "../src/persistence/v2/reconciliation.js";

class SqlLifecycleRepository
  implements V2LifecycleReconciliationRepository, V2LifecycleIntegrityGuard
{
  constructor(private readonly pg: PGlite) {}

  async listLifecycleRows(): Promise<V2LifecycleRow[]> {
    const tasks = await this.pg.query<{
      id: string;
      project_id: string;
      state: string;
      lifecycle_version: number;
    }>("SELECT id, project_id, state, lifecycle_version FROM tasks ORDER BY id");
    const runs = await this.pg.query<{
      id: string;
      project_id: string;
      task_id: string;
      state: string;
      lifecycle_version: number;
    }>("SELECT id, project_id, task_id, state, lifecycle_version FROM agent_runs ORDER BY id");
    return [
      ...tasks.rows.map(
        (row) =>
          ({
            kind: "task",
            ...row,
          }) as V2LifecycleRow,
      ),
      ...runs.rows.map(
        (row) =>
          ({
            kind: "agent_run",
            ...row,
          }) as V2LifecycleRow,
      ),
    ];
  }

  async taskEvents(taskId: string): Promise<V2TaskTransitionEventT[]> {
    const result = await this.pg.query<{ event_id: string; payload: Record<string, unknown> }>(
      `SELECT event_id, payload
       FROM domain_events
       WHERE stream_type = 'task' AND stream_id = $1
       ORDER BY stream_version`,
      [taskId],
    );
    return result.rows.map((row) =>
      V2TaskTransitionEvent.parse({
        schema_version: 2,
        event_id: row.event_id,
        task_id: taskId,
        occurred_at: "2026-07-16T12:00:00.000Z",
        ...row.payload,
      }),
    );
  }

  async agentRunEvents(runId: string): Promise<V2AgentRunTransitionEventT[]> {
    const result = await this.pg.query<{ event_id: string; task_id: string; payload: object }>(
      `SELECT event_id, task_id, payload
       FROM domain_events
       WHERE stream_type = 'agent_run' AND stream_id = $1
       ORDER BY stream_version`,
      [runId],
    );
    return result.rows.map((row) =>
      V2AgentRunTransitionEvent.parse({
        schema_version: 2,
        event_id: row.event_id,
        run_id: runId,
        task_id: row.task_id,
        occurred_at: "2026-07-16T12:00:00.000Z",
        ...row.payload,
      }),
    );
  }

  async recordFindingAndAudit(finding: V2LifecycleFinding): Promise<void> {
    await this.pg.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO lifecycle_integrity_findings (
           aggregate_kind, aggregate_id, code, details, status
         ) VALUES ($1,$2,$3,$4::jsonb,'open')
         ON CONFLICT (aggregate_kind, aggregate_id, code)
         WHERE status = 'open'
         DO UPDATE SET details = EXCLUDED.details`,
        [finding.aggregate_kind, finding.aggregate_id, finding.code, JSON.stringify(finding)],
      );
      await tx.query(
        `INSERT INTO audit_events (audit_type, aggregate_id, summary)
         VALUES ('lifecycle.reconciliation_mismatch',$1,$2)`,
        [finding.aggregate_id, finding.code],
      );
    });
  }

  async hasOpenFinding(aggregateKind: "task" | "agent_run", aggregateId: string): Promise<boolean> {
    const result = await this.pg.query<{ present: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM lifecycle_integrity_findings
         WHERE aggregate_kind = $1 AND aggregate_id = $2 AND status = 'open'
       ) AS present`,
      [aggregateKind, aggregateId],
    );
    return result.rows[0]?.present ?? false;
  }
}

let pg: PGlite;
let repository: SqlLifecycleRepository;

beforeEach(async () => {
  pg = new PGlite();
  repository = new SqlLifecycleRepository(pg);
  await pg.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      state TEXT NOT NULL,
      lifecycle_version INTEGER NOT NULL
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      state TEXT NOT NULL,
      lifecycle_version INTEGER NOT NULL
    );
    CREATE TABLE domain_events (
      event_id TEXT PRIMARY KEY,
      stream_type TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      task_id TEXT,
      payload JSONB NOT NULL,
      UNIQUE (stream_type, stream_id, stream_version)
    );
    CREATE TABLE lifecycle_integrity_findings (
      id BIGSERIAL PRIMARY KEY,
      aggregate_kind TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      code TEXT NOT NULL,
      details JSONB NOT NULL,
      status TEXT NOT NULL
    );
    CREATE UNIQUE INDEX one_open_lifecycle_finding
      ON lifecycle_integrity_findings(aggregate_kind, aggregate_id, code)
      WHERE status = 'open';
    CREATE TABLE audit_events (
      id BIGSERIAL PRIMARY KEY,
      audit_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      summary TEXT NOT NULL
    );
  `);
});

afterEach(async () => {
  await pg.close();
});

async function insertTaskEvent(input: {
  id: string;
  taskId: string;
  streamVersion: number;
  lifecycleVersion: number;
  from: string;
  to: string;
}): Promise<void> {
  await pg.query(
    `INSERT INTO domain_events (
       event_id, stream_type, stream_id, stream_version, task_id, payload
     ) VALUES ($1,'task',$2,$3,$2,$4::jsonb)`,
    [
      input.id,
      input.taskId,
      input.streamVersion,
      JSON.stringify({
        lifecycle_version: input.lifecycleVersion,
        from: input.from,
        to: input.to,
        reason: null,
      }),
    ],
  );
}

describe("V2 lifecycle fold-and-row reconciliation", () => {
  it("passes clean initial Task and AgentRun rows", async () => {
    await pg.query("INSERT INTO tasks VALUES ('task-clean','project-1','pending',0)");
    await pg.query(
      "INSERT INTO agent_runs VALUES ('run-clean','project-1','task-clean','created',0)",
    );
    const report = await reconcileV2Lifecycles({
      repository,
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });
    expect(report).toEqual({ checked: 2, clean: 2, mismatches: [] });
  });

  it("detects state-without-event, records an audit, and blocks automation", async () => {
    await pg.query("INSERT INTO tasks VALUES ('task-state-only','project-1','ready',1)");
    const report = await reconcileV2Lifecycles({ repository });
    expect(report.mismatches).toMatchObject([
      {
        aggregate_id: "task-state-only",
        code: "state_without_event",
        folded_state: "pending",
        folded_lifecycle_version: 0,
      },
    ]);
    expect((await pg.query("SELECT * FROM audit_events")).rows).toHaveLength(1);
    await expect(
      assertV2AutomationAllowed(repository, "task", "task-state-only"),
    ).rejects.toBeInstanceOf(V2AutomationBlockedByIntegrityError);
  });

  it("detects event-without-state and preserves the folded evidence", async () => {
    await pg.query("INSERT INTO tasks VALUES ('task-event-only','project-1','pending',0)");
    await insertTaskEvent({
      id: "event-1",
      taskId: "task-event-only",
      streamVersion: 1,
      lifecycleVersion: 1,
      from: "pending",
      to: "ready",
    });
    const report = await reconcileV2Lifecycles({ repository });
    expect(report.mismatches).toMatchObject([
      {
        aggregate_id: "task-event-only",
        code: "event_without_state",
        row_state: "pending",
        folded_state: "ready",
        folded_lifecycle_version: 1,
      },
    ]);
  });

  it("detects a non-contiguous lifecycle event sequence", async () => {
    await pg.query("INSERT INTO tasks VALUES ('task-gap','project-1','pending',0)");
    await insertTaskEvent({
      id: "event-gap",
      taskId: "task-gap",
      streamVersion: 1,
      lifecycleVersion: 2,
      from: "pending",
      to: "ready",
    });
    const report = await reconcileV2Lifecycles({ repository });
    expect(report.mismatches[0]).toMatchObject({
      aggregate_id: "task-gap",
      code: "invalid_event_sequence",
      rejected_event_ids: ["event-gap"],
    });
  });
});
