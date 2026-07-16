import { V2StartPhaseCommand } from "@norns/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeV2ApplicationCommand } from "../src/persistence/v2/application.js";
import { NodePgTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runPhase1V2Migration } from "../src/persistence/v2/migrate.js";
import { SqlV2ApplicationTransaction } from "../src/persistence/v2/sqlRepositories.js";

const databaseUrl = process.env.V2_POSTGRES_TEST_URL;
const postgresDescribe = databaseUrl ? describe.sequential : describe.skip;

postgresDescribe("V2 real PostgreSQL concurrency evidence", () => {
  let administrationPool: Pool;
  let applicationPool: Pool;
  let privilegedRunner: NodePgTransactionRunner;
  let runtimeRunner: NodePgTransactionRunner;
  let databaseUser: string;
  let runtimeRoleMembershipAdded = false;
  let schemaName: string;

  beforeAll(async () => {
    if (!databaseUrl) return;
    administrationPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const identity = await administrationPool.query<{ current_user: string }>(
      "SELECT current_user",
    );
    databaseUser = identity.rows[0]?.current_user ?? "";
    // norns_app is a deployment-level role shared by all isolated real-PG
    // suites. Provision it race-safely and leave it in place for peer files.
    await administrationPool.query(`
      DO $role$
      BEGIN
        CREATE ROLE norns_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN
        NULL;
      END
      $role$;
    `);
    const membership = await administrationPool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM pg_auth_members AS membership
         JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
         JOIN pg_roles AS member_role ON member_role.oid = membership.member
         WHERE granted_role.rolname = 'norns_app'
           AND member_role.rolname = current_user
       ) AS exists`,
    );
    runtimeRoleMembershipAdded = !membership.rows[0]?.exists;
    if (runtimeRoleMembershipAdded) {
      await administrationPool.query(`GRANT norns_app TO "${databaseUser.replaceAll('"', '""')}"`);
    }

    schemaName = `norns_v2_${process.pid}_${Date.now()}`;
    await administrationPool.query(`CREATE SCHEMA ${schemaName}`);
    applicationPool = new Pool({
      connectionString: databaseUrl,
      max: 6,
      options: `-c search_path=${schemaName}`,
    });
    privilegedRunner = new NodePgTransactionRunner(applicationPool, { mode: "privileged" });
    runtimeRunner = new NodePgTransactionRunner(applicationPool, {
      mode: "runtime",
      role: "norns_app",
    });
    const migrationDatabase: V2MigrationDatabase = {
      query: async <TRow = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await applicationPool.query(sql, params);
        return result.rowCount === null
          ? { rows: result.rows as TRow[] }
          : { rows: result.rows as TRow[], affectedRows: result.rowCount };
      },
      transaction: (work) => privilegedRunner.transaction(work),
    };
    await runPhase1V2Migration(migrationDatabase);
    await applicationPool.query(`
      INSERT INTO projection_checkpoints (
        projection_name, partition_key, version
      ) VALUES ('concurrency-probe', 'shared', 1);
    `);
  }, 30_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    await applicationPool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    if (runtimeRoleMembershipAdded) {
      await administrationPool.query(
        `REVOKE norns_app FROM "${databaseUser.replaceAll('"', '""')}"`,
      );
    }
    await administrationPool.end();
  });

  it("uses the isolated current schema and the restricted runtime role operationally", async () => {
    const identity = await runtimeRunner.transaction((tx) =>
      tx.query<{ current_schema: string; current_user: string }>(
        "SELECT current_schema(), current_user",
      ),
    );
    expect(identity.rows[0]).toEqual({
      current_schema: schemaName,
      current_user: "norns_app",
    });

    const schemaPrivilege = await administrationPool.query<{ allowed: boolean }>(
      "SELECT has_schema_privilege('norns_app', $1, 'USAGE') AS allowed",
      [schemaName],
    );
    expect(schemaPrivilege.rows[0]?.allowed).toBe(true);

    await runtimeRunner.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO projects (
           id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
         ) VALUES (
           'runtime-project', 'Runtime project', 'active',
           'assignment/default', 'verification/default', 'budget/default'
         )`,
      );
      await tx.query(
        `UPDATE projects
         SET description = 'updated through norns_app'
         WHERE id = 'runtime-project'`,
      );
      await tx.query(
        `INSERT INTO domain_events (
           event_id, stream_type, stream_id, stream_version, event_type,
           project_id, actor_type, actor_id, correlation_id, occurred_at, payload
         ) VALUES (
           'runtime-domain-event', 'project', 'runtime-project', 1, 'ProjectCreated',
           'runtime-project', 'system', 'coordinator', 'runtime-role-proof',
           now(), '{}'::jsonb
         )`,
      );
      await tx.query(
        `INSERT INTO audit_events (
           audit_id, audit_type, project_id, actor_type, actor_id, outcome,
           severity, correlation_id, occurred_at, summary
         ) VALUES (
           'runtime-audit-event', 'project.created', 'runtime-project', 'system',
           'coordinator', 'succeeded', 'info', 'runtime-role-proof', now(),
           'Runtime role inserted immutable history'
         )`,
      );
    });

    const project = await applicationPool.query<{ description: string }>(
      "SELECT description FROM projects WHERE id = 'runtime-project'",
    );
    expect(project.rows[0]?.description).toBe("updated through norns_app");

    await expect(
      runtimeRunner.transaction((tx) =>
        tx.query(
          `UPDATE domain_events
           SET event_type = 'Changed'
           WHERE event_id = 'runtime-domain-event'`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtimeRunner.transaction((tx) =>
        tx.query("DELETE FROM audit_events WHERE audit_id = 'runtime-audit-event'"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtimeRunner.transaction((tx) => tx.query("TRUNCATE domain_events")),
    ).rejects.toThrow(/permission denied/);
  });

  it("returns command_in_progress across two real connections and later replays one result", async () => {
    const command = V2StartPhaseCommand.parse({
      schema_version: 2,
      kind: "start_phase",
      command_id: "command-real-concurrency",
      command_family: "phase",
      actor: { actor_type: "human", actor_id: "user-1" },
      idempotency_key: "real-concurrency-key",
      correlation_id: "correlation-real-concurrency",
      causation_id: null,
      issued_at: "2026-07-16T18:30:00.000Z",
      project_id: "project-1",
      phase_id: "phase-1",
      expected_project_version: 1,
      expected_phase_version: 1,
    });

    let mutations = 0;
    let releaseMutation = (): void => {};
    let markMutationEntered = (): void => {};
    const mutationEntered = new Promise<void>((resolve) => {
      markMutationEntered = resolve;
    });
    const mutationRelease = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const execute = () =>
      executeV2ApplicationCommand({
        command,
        transactionRunner: runtimeRunner,
        transactionFactory: {
          bind: (sql) => new SqlV2ApplicationTransaction(sql),
        },
        mutate: async () => {
          mutations += 1;
          markMutationEntered();
          await mutationRelease;
          return {
            outcome: "succeeded" as const,
            http_status: 200,
            body: { phase_id: "phase-1" },
          };
        },
      });

    const firstPromise = execute();
    await mutationEntered;
    const concurrent = await execute();
    expect(concurrent).toEqual({
      kind: "command_in_progress",
      command_id: null,
    });

    releaseMutation();
    const first = await firstPromise;
    expect(first.kind).toBe("executed");
    expect(mutations).toBe(1);

    const retry = await execute();
    expect(retry.kind).toBe("replayed");
    expect(mutations).toBe(1);
    expect(retry.kind === "replayed" && first.kind === "executed" ? retry.response : null).toEqual(
      first.kind === "executed" ? first.response : null,
    );
  });

  it("uses real BEGIN/COMMIT/ROLLBACK and blocks FOR UPDATE across connections", async () => {
    let firstBackendPid = 0;
    let secondBackendPid = 0;
    let releaseFirst = (): void => {};
    let markLocked = (): void => {};
    let markSecondStarted = (): void => {};
    const firstLocked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runtimeRunner.transaction(async (tx) => {
      const identity = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      firstBackendPid = identity.rows[0]?.pid ?? 0;
      await tx.query(
        `SELECT version
         FROM projection_checkpoints
         WHERE projection_name = 'concurrency-probe' AND partition_key = 'shared'
         FOR UPDATE`,
      );
      markLocked();
      await firstRelease;
      await tx.query(
        `UPDATE projection_checkpoints
         SET version = version + 1
         WHERE projection_name = 'concurrency-probe' AND partition_key = 'shared'`,
      );
    });
    await firstLocked;

    const second = runtimeRunner.transaction(async (tx) => {
      const identity = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      secondBackendPid = identity.rows[0]?.pid ?? 0;
      markSecondStarted();
      await tx.query(
        `SELECT version
         FROM projection_checkpoints
         WHERE projection_name = 'concurrency-probe' AND partition_key = 'shared'
         FOR UPDATE`,
      );
      await tx.query(
        `UPDATE projection_checkpoints
         SET version = version + 1
         WHERE projection_name = 'concurrency-probe' AND partition_key = 'shared'`,
      );
    });
    await secondStarted;

    let waiting:
      | {
          blockers: number[];
          wait_event: string | null;
          wait_event_type: string | null;
        }
      | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const activity = await administrationPool.query<{
        blockers: number[];
        wait_event: string | null;
        wait_event_type: string | null;
      }>(
        `SELECT pg_blocking_pids(pid) AS blockers, wait_event, wait_event_type
         FROM pg_stat_activity
         WHERE pid = $1`,
        [secondBackendPid],
      );
      const observed = activity.rows[0];
      if (observed?.wait_event_type === "Lock" && observed.blockers.length > 0) {
        waiting = observed;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waiting).toMatchObject({
      wait_event_type: "Lock",
    });
    expect(waiting?.blockers).toContain(firstBackendPid);
    expect(waiting?.wait_event).toMatch(/transactionid|tuple/);

    releaseFirst();
    await Promise.all([first, second]);

    const committed = await applicationPool.query<{ version: number }>(
      `SELECT version
       FROM projection_checkpoints
       WHERE projection_name = 'concurrency-probe' AND partition_key = 'shared'`,
    );
    expect(committed.rows[0]?.version).toBe(3);

    await expect(
      runtimeRunner.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO projection_checkpoints (
             projection_name, partition_key, version
           ) VALUES ('rollback-probe', 'shared', 1)`,
        );
        throw new Error("rollback probe");
      }),
    ).rejects.toThrow("rollback probe");
    const rolledBack = await applicationPool.query<{ present: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM projection_checkpoints
         WHERE projection_name = 'rollback-probe' AND partition_key = 'shared'
       ) AS present`,
    );
    expect(rolledBack.rows[0]?.present).toBe(false);
  });
});
