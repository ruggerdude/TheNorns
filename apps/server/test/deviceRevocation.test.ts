import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DeviceRunCancellationService } from "../src/devices/cancellation.js";
import {
  type DeviceRevocationOutcome,
  DeviceRevocationService,
} from "../src/devices/revocation.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import {
  loadDeviceCancellationTrackingMigrationSql,
  loadDeviceHttpRequestReplaysMigrationSql,
  loadDeviceIdentityCoreMigrationSql,
} from "../src/persistence/v2/migrate.js";

describe.sequential("device revocation enforcement", () => {
  let database: PGlite;
  let revocations: DeviceRevocationService;
  let cancellations: DeviceRunCancellationService;
  let afterRevokedCalls = 0;
  let afterRevokedOutcome: DeviceRevocationOutcome | null = null;
  let lifecycleObservedByHook: string | null = null;
  let rejectAfterRevoked = false;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        owner_user_id TEXT NOT NULL REFERENCES users(id)
      );
      CREATE TABLE project_members (
        project_id TEXT NOT NULL REFERENCES projects(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL
      );
      CREATE TABLE repository_bindings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        binding_type TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_id TEXT,
        repository_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        repository_binding_id TEXT NOT NULL REFERENCES repository_bindings(id),
        initiated_by_user_id TEXT NOT NULL REFERENCES users(id),
        state TEXT NOT NULL
      );
      CREATE TABLE commands (
        command_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id),
        runner_id TEXT NOT NULL,
        runner_generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE dispatch_jobs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id),
        runner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TIMESTAMPTZ,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE runner_revocations (
        runner_id TEXT PRIMARY KEY,
        revoked_through_generation INTEGER NOT NULL,
        reason TEXT NOT NULL,
        revoked_by TEXT NOT NULL,
        revoked_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE gateway_credentials (
        id TEXT PRIMARY KEY,
        runner_id TEXT NOT NULL,
        authentication_subject TEXT NOT NULL,
        revoked_at TIMESTAMPTZ
      );
      CREATE TABLE dispatch_context_documents (
        runner_id TEXT NOT NULL,
        context_document_id TEXT NOT NULL,
        dispatch_job_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        PRIMARY KEY (runner_id,context_document_id)
      );

      INSERT INTO users (id,status)
      VALUES ('device-owner','active'),('outsider','active');
      INSERT INTO projects (id,status,owner_user_id)
      VALUES ('project-1','active','device-owner');
    `);
    await database.exec(await loadDeviceIdentityCoreMigrationSql());
    await database.exec(await loadDeviceHttpRequestReplaysMigrationSql());
    await database.exec(await loadDeviceCancellationTrackingMigrationSql());
    await database.exec(`
      INSERT INTO devices (
        id,owner_user_id,display_name,os_family,architecture
      ) VALUES
        ('device-1','device-owner','Office Mac','macos','arm64'),
        ('device-2','device-owner','Travel Mac','macos','arm64');
      INSERT INTO device_credentials (
        id,device_id,generation,public_key_spki_der,public_key_fingerprint
      ) VALUES
        ('credential-1','device-1',1,decode('abcd','hex'),repeat('a',64)),
        ('credential-2','device-2',1,decode('abce','hex'),repeat('b',64));
      INSERT INTO device_repository_registrations (
        id,device_id,workspace_id,repository_id,repository_display_name,
        state,approved_by_user_id,approved_at
      ) VALUES (
        'registration-1','device-1','workspace-1','repository-1','Repository 1',
        'active','device-owner',now()
      );
      INSERT INTO project_device_repository_grants (
        id,project_id,repository_registration_id,state,granted_by_user_id
      ) VALUES (
        'grant-1','project-1','registration-1','active','device-owner'
      );
      INSERT INTO repository_bindings (
        id,project_id,binding_type,status,workspace_id,repository_id,
        project_device_repository_grant_id
      ) VALUES (
        'binding-1','project-1','local_runner','connected',
        'workspace-1','repository-1','grant-1'
      );
      INSERT INTO agent_runs (
        id,project_id,repository_binding_id,initiated_by_user_id,state
      )
      VALUES
        ('run-active','project-1','binding-1','device-owner','running'),
        ('run-already-stopping','project-1','binding-1','device-owner','running'),
        ('run-waiting','project-1','binding-1','device-owner','waiting_for_human'),
        ('run-continuation','project-1','binding-1','device-owner','running'),
        ('run-rebound','project-1','binding-1','device-owner','running');
      INSERT INTO commands (
        command_id,run_id,runner_id,runner_generation,status,created_at
      ) VALUES
        (
          'command-active','run-active','device-1',1,'executing',
          '2026-07-29T14:00:00.000Z'
        ),
        (
          'command-queued','run-already-stopping','device-1',1,'queued',
          '2026-07-29T14:00:00.000Z'
        ),
        (
          'command-waiting','run-waiting','device-1',1,'executing',
          '2026-07-29T14:00:00.000Z'
        ),
        (
          'command-continuation-a','run-continuation','device-2',1,'completed',
          '2026-07-29T14:10:00.000Z'
        ),
        (
          'command-continuation-z','run-continuation','device-1',1,'executing',
          '2026-07-29T14:10:00.000Z'
        ),
        (
          'command-rebound-a','run-rebound','device-1',1,'completed',
          '2026-07-29T14:20:00.000Z'
        ),
        (
          'command-rebound-z','run-rebound','device-2',1,'executing',
          '2026-07-29T14:20:00.000Z'
        );
      INSERT INTO dispatch_jobs (id,run_id,runner_id,status)
      VALUES ('job-queued','run-already-stopping','device-1','queued');
      INSERT INTO gateway_credentials (id,runner_id,authentication_subject)
      VALUES
        ('gateway-1','device-1','device'),
        ('gateway-legacy-collision','device-1','legacy_runner');
      INSERT INTO device_run_cancellations (
        run_id,device_id,credential_id,device_generation,cause,state,
        requested_by_user_id,reason,requested_at,updated_at
      ) VALUES (
        'run-already-stopping','device-1','credential-1',1,'project_stop',
        'cancellation_requested','device-owner','Stop this run',
        '2026-07-29T15:00:00.000Z','2026-07-29T15:00:00.000Z'
      );
    `);
    const transactions = new PGliteTransactionRunner(database);
    revocations = new DeviceRevocationService(transactions, {
      afterRevoked: async (outcome) => {
        afterRevokedCalls += 1;
        afterRevokedOutcome = outcome;
        const selected = await database.query<{ lifecycle: string }>(
          "SELECT lifecycle FROM devices WHERE id=$1",
          [outcome.record.device_id],
        );
        lifecycleObservedByHook = selected.rows[0]?.lifecycle ?? null;
        if (rejectAfterRevoked) throw new Error("transport cleanup unavailable");
      },
    });
    cancellations = new DeviceRunCancellationService(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  it("rejects a non-owner without changing device authorization", async () => {
    await expect(
      revocations.revoke({
        device_id: "device-1",
        revoked_by_user_id: "outsider",
        reason: "Not mine",
        revoked_at: "2026-07-29T15:01:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "revocation_not_authorized" });
    const device = await database.query<{ lifecycle: string; current_generation: bigint }>(
      "SELECT lifecycle,current_generation FROM devices WHERE id='device-1'",
    );
    expect(device.rows[0]).toEqual({ lifecycle: "active", current_generation: 1 });
    expect(afterRevokedCalls).toBe(0);
  });

  it("atomically fences generation, authorization, queues, credentials, and publication", async () => {
    rejectAfterRevoked = true;
    const result = await revocations.revoke({
      device_id: "device-1",
      revoked_by_user_id: "device-owner",
      reason: "Owner revoked this installation",
      revoked_at: "2026-07-29T15:02:00.000Z",
    });
    expect(result).toMatchObject({
      replayed: false,
      record: {
        device_id: "device-1",
        previous_generation: 1,
        fenced_generation: 2,
        affected_run_ids: ["run-active", "run-already-stopping", "run-continuation", "run-waiting"],
      },
    });
    expect(afterRevokedCalls).toBe(1);
    expect(afterRevokedOutcome).toEqual(result);
    expect(lifecycleObservedByHook).toBe("revoked");
    await expect(cancellations.get("run-continuation")).resolves.toMatchObject({
      cause: "device_revocation",
      device_id: "device-1",
    });
    await expect(cancellations.get("run-rebound")).resolves.toBeNull();

    const device = await database.query<{
      lifecycle: string;
      current_generation: bigint;
      revoked_at: Date;
    }>("SELECT lifecycle,current_generation,revoked_at FROM devices WHERE id='device-1'");
    expect(device.rows[0]).toMatchObject({
      lifecycle: "revoked",
      current_generation: 2,
    });
    const credential = await database.query<{ state: string }>(
      "SELECT state FROM device_credentials WHERE id='credential-1'",
    );
    expect(credential.rows[0]?.state).toBe("revoked");
    const registration = await database.query<{ state: string }>(
      "SELECT state FROM device_repository_registrations WHERE id='registration-1'",
    );
    const grant = await database.query<{ state: string }>(
      "SELECT state FROM project_device_repository_grants WHERE id='grant-1'",
    );
    const binding = await database.query<{ status: string }>(
      "SELECT status FROM repository_bindings WHERE id='binding-1'",
    );
    expect(registration.rows[0]?.state).toBe("revoked");
    expect(grant.rows[0]?.state).toBe("revoked");
    expect(binding.rows[0]?.status).toBe("revoked");

    const queue = await database.query<{ command_status: string; job_status: string }>(
      `SELECT command.status AS command_status,job.status AS job_status
         FROM commands command
         JOIN dispatch_jobs job ON job.run_id=command.run_id
        WHERE command.command_id='command-queued'`,
    );
    expect(queue.rows[0]).toEqual({
      command_status: "cancelled",
      job_status: "cancelled",
    });
    const gateway = await database.query<{ id: string; revoked_at: Date | null }>(
      `SELECT id,revoked_at
         FROM gateway_credentials
        WHERE runner_id='device-1'
        ORDER BY id`,
    );
    expect(gateway.rows).toEqual([
      { id: "gateway-1", revoked_at: expect.any(Date) },
      { id: "gateway-legacy-collision", revoked_at: null },
    ]);
    const runnerFence = await database.query<{ revoked_through_generation: number }>(
      "SELECT revoked_through_generation FROM runner_revocations WHERE runner_id='device-1'",
    );
    expect(runnerFence.rows[0]?.revoked_through_generation).toBe(2);

    await expect(cancellations.publicationAllowed("run-active")).resolves.toBe(false);
    await expect(cancellations.publicationAllowed("run-already-stopping")).resolves.toBe(false);
    await expect(cancellations.get("run-already-stopping")).resolves.toMatchObject({
      cause: "project_stop",
      state: "cancellation_requested",
      publication_fenced_at: "2026-07-29T15:02:00.000Z",
    });
  });

  it("replays the immutable revocation without advancing the fence again", async () => {
    const replay = await revocations.revoke({
      device_id: "device-1",
      revoked_by_user_id: "device-owner",
      reason: "A later duplicate request",
      revoked_at: "2026-07-29T15:03:00.000Z",
    });
    expect(replay).toMatchObject({
      replayed: true,
      record: {
        reason: "Owner revoked this installation",
        revoked_at: "2026-07-29T15:02:00.000Z",
        fenced_generation: 2,
      },
    });
    const device = await database.query<{ current_generation: bigint }>(
      "SELECT current_generation FROM devices WHERE id='device-1'",
    );
    expect(device.rows[0]?.current_generation).toBe(2);
  });

  it("keeps revocation audit records immutable", async () => {
    const privileges = await database.query<{ can_update: boolean; can_delete: boolean }>(`
      SELECT
        has_table_privilege('norns_app', 'device_revocations', 'UPDATE') AS can_update,
        has_table_privilege('norns_app', 'device_revocations', 'DELETE') AS can_delete
    `);
    expect(privileges.rows[0]).toEqual({ can_update: false, can_delete: false });
    await expect(
      database.query("UPDATE device_revocations SET reason='rewritten' WHERE device_id='device-1'"),
    ).rejects.toThrow();
    await expect(
      database.query("DELETE FROM device_revocations WHERE device_id='device-1'"),
    ).rejects.toThrow();
  });
});
