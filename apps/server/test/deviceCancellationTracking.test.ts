import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type DeviceRunCancellationRequestOutcome,
  DeviceRunCancellationService,
} from "../src/devices/cancellation.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import {
  loadDeviceCancellationTrackingMigrationSql,
  loadProjectRunCancellationMigrationSql,
} from "../src/persistence/v2/migrate.js";

describe.sequential("device run cancellation tracking", () => {
  let database: PGlite;
  let service: DeviceRunCancellationService;
  const afterRequestedOutcomes: DeviceRunCancellationRequestOutcome[] = [];
  let cancellationStateObservedByHook: string | null = null;
  let rejectAfterRequested = false;

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
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id),
        lifecycle TEXT NOT NULL,
        current_generation BIGINT NOT NULL
      );
      CREATE TABLE device_credentials (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        generation BIGINT NOT NULL,
        state TEXT NOT NULL,
        UNIQUE (device_id, id, generation)
      );
      CREATE TABLE device_repository_registrations (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        workspace_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE project_device_repository_grants (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        repository_registration_id TEXT NOT NULL
          REFERENCES device_repository_registrations(id),
        state TEXT NOT NULL
      );
      CREATE TABLE repository_bindings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        binding_type TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_id TEXT,
        repository_id TEXT NOT NULL,
        project_device_repository_grant_id TEXT
          REFERENCES project_device_repository_grants(id)
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        phase_id TEXT NOT NULL DEFAULT 'phase-1',
        state TEXT NOT NULL DEFAULT 'assigned',
        lifecycle_version INTEGER NOT NULL DEFAULT 0,
        aggregate_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ
      );
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        phase_id TEXT NOT NULL DEFAULT 'phase-1',
        task_id TEXT NOT NULL DEFAULT 'task-1',
        repository_binding_id TEXT NOT NULL REFERENCES repository_bindings(id),
        initiated_by_user_id TEXT NOT NULL REFERENCES users(id),
        state TEXT NOT NULL DEFAULT 'running',
        lifecycle_version INTEGER NOT NULL DEFAULT 0,
        aggregate_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ
      );
      CREATE TABLE commands (
        command_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id),
        runner_id TEXT NOT NULL,
        runner_generation BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE dispatch_context_documents (
        runner_id TEXT NOT NULL,
        runner_generation INTEGER NOT NULL,
        context_document_id TEXT NOT NULL,
        dispatch_job_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (runner_id, context_document_id)
      );
      CREATE TABLE domain_events (
        event_id TEXT PRIMARY KEY,
        stream_type TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_version BIGINT NOT NULL,
        event_type TEXT NOT NULL,
        project_id TEXT NOT NULL,
        phase_id TEXT,
        task_id TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        occurred_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      );
      CREATE TABLE audit_events (
        audit_id TEXT PRIMARY KEY,
        audit_type TEXT NOT NULL,
        project_id TEXT,
        phase_id TEXT,
        task_id TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        outcome TEXT NOT NULL,
        severity TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        occurred_at TIMESTAMPTZ NOT NULL,
        targets JSONB NOT NULL,
        summary TEXT NOT NULL,
        details JSONB NOT NULL,
        redaction_applied BOOLEAN NOT NULL
      );
      CREATE TABLE lifecycle_integrity_findings (
        id TEXT PRIMARY KEY,
        aggregate_kind TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        status TEXT NOT NULL
      );

      INSERT INTO users (id,status)
      VALUES ('owner-1','active'), ('project-owner-1','active');
      INSERT INTO projects (id,status,owner_user_id)
      VALUES ('project-1','active','project-owner-1');
      INSERT INTO project_members (project_id,user_id,status)
      VALUES ('project-1','owner-1','active');
      INSERT INTO devices (id,owner_user_id,lifecycle,current_generation)
      VALUES
        ('device-1','owner-1','active',4),
        ('device-2','owner-1','active',1);
      INSERT INTO device_credentials (id, device_id, generation, state)
      VALUES
        ('credential-1', 'device-1', 4, 'active'),
        ('credential-2', 'device-2', 1, 'active');
      INSERT INTO device_repository_registrations (
        id,device_id,workspace_id,repository_id,state
      ) VALUES (
        'registration-1','device-1','workspace-1','repository-1','active'
      );
      INSERT INTO project_device_repository_grants (
        id,project_id,repository_registration_id,state
      ) VALUES ('grant-1','project-1','registration-1','active');
      INSERT INTO repository_bindings (
        id,project_id,binding_type,status,workspace_id,repository_id,
        project_device_repository_grant_id
      ) VALUES (
        'binding-1','project-1','local_runner','connected',
        'workspace-1','repository-1','grant-1'
      );
      INSERT INTO tasks (id,project_id)
      VALUES ('task-1','project-1'), ('task-never-started','project-1');
      INSERT INTO agent_runs (
        id,project_id,repository_binding_id,initiated_by_user_id
      )
      VALUES
        ('run-project-stop','project-1','binding-1','project-owner-1'),
        ('run-revocation','project-1','binding-1','project-owner-1'),
        ('run-offline','project-1','binding-1','project-owner-1'),
        ('run-mismatch','project-1','binding-1','project-owner-1'),
        ('run-hook','project-1','binding-1','project-owner-1'),
        ('run-continuation','project-1','binding-1','project-owner-1'),
        ('run-rebound','project-1','binding-1','project-owner-1'),
        ('run-never-started','project-1','binding-1','project-owner-1');
      INSERT INTO commands (
        command_id,run_id,runner_id,runner_generation,created_at
      )
      VALUES
        (
          'command-project-stop','run-project-stop','device-1',4,
          '2026-07-29T13:00:00.000Z'
        ),
        (
          'command-revocation','run-revocation','device-1',4,
          '2026-07-29T13:00:00.000Z'
        ),
        (
          'command-offline','run-offline','device-1',4,
          '2026-07-29T13:00:00.000Z'
        ),
        (
          'command-mismatch','run-mismatch','device-1',4,
          '2026-07-29T13:00:00.000Z'
        ),
        (
          'command-hook','run-hook','device-1',4,
          '2026-07-29T13:00:00.000Z'
        ),
        (
          'command-continuation-a','run-continuation','device-2',1,
          '2026-07-29T13:10:00.000Z'
        ),
        (
          'command-continuation-z','run-continuation','device-1',4,
          '2026-07-29T13:10:00.000Z'
        ),
        (
          'command-never-started','run-never-started','device-1',4,
          '2026-07-29T13:00:00.000Z'
        ),
        (
          'command-rebound-a','run-rebound','device-1',4,
          '2026-07-29T13:20:00.000Z'
        ),
        (
          'command-rebound-z','run-rebound','device-2',1,
          '2026-07-29T13:20:00.000Z'
        );
    `);
    await database.exec(await loadDeviceCancellationTrackingMigrationSql());
    await database.exec(await loadProjectRunCancellationMigrationSql());
    service = new DeviceRunCancellationService(new PGliteTransactionRunner(database), {
      afterRequested: async (outcome) => {
        afterRequestedOutcomes.push(outcome);
        const selected = await database.query<{ state: string }>(
          "SELECT state FROM device_run_cancellations WHERE run_id=$1",
          [outcome.record.run_id],
        );
        cancellationStateObservedByHook = selected.rows[0]?.state ?? null;
        if (rejectAfterRequested) throw new Error("online stop delivery unavailable");
        return undefined;
      },
    });
  });

  afterAll(async () => {
    await database.close();
  });

  it("creates a runtime-writable table without granting delete", async () => {
    const privileges = await database.query<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(`
      SELECT
        has_table_privilege('norns_app', 'device_run_cancellations', 'SELECT')
          AS can_select,
        has_table_privilege('norns_app', 'device_run_cancellations', 'INSERT')
          AS can_insert,
        has_table_privilege('norns_app', 'device_run_cancellations', 'UPDATE')
          AS can_update,
        has_table_privilege('norns_app', 'device_run_cancellations', 'DELETE')
          AS can_delete
    `);
    expect(privileges.rows[0]).toEqual({
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: false,
    });
  });

  it("delivers committed requests and authorized replays through a best-effort hook", async () => {
    rejectAfterRequested = true;
    const request = {
      run_id: "run-hook",
      device_id: "device-1",
      credential_id: "credential-1",
      device_generation: 4,
      cause: "project_stop" as const,
      requested_by_user_id: "project-owner-1",
      reason: "Stop through the online delivery hook",
      requested_at: "2026-07-29T13:25:00.000Z",
    };

    const created = await service.request(request);
    expect(created.replayed).toBe(false);
    expect(cancellationStateObservedByHook).toBe("cancellation_requested");
    expect(afterRequestedOutcomes).toEqual([created]);

    const replayed = await service.request(request);
    expect(replayed.replayed).toBe(true);
    expect(afterRequestedOutcomes).toEqual([created, replayed]);

    await expect(
      service.request({ ...request, reason: "Conflicting replacement" }),
    ).rejects.toMatchObject({ code: "cancellation_conflict" });
    expect(afterRequestedOutcomes).toHaveLength(2);
    rejectAfterRequested = false;
  });

  it("binds cancellation scope only to the authoritative continuation command", async () => {
    await expect(
      service.request({
        run_id: "run-continuation",
        device_id: "device-1",
        credential_id: "credential-1",
        device_generation: 4,
        cause: "project_stop",
        requested_by_user_id: "project-owner-1",
        reason: "Stop the continued run",
        requested_at: "2026-07-29T13:30:00.000Z",
      }),
    ).resolves.toMatchObject({
      replayed: false,
      record: { device_id: "device-1", device_generation: 4 },
    });

    const staleScope = {
      run_id: "run-rebound",
      device_id: "device-1",
      credential_id: "credential-1",
      device_generation: 4,
      cause: "project_stop" as const,
      requested_by_user_id: "project-owner-1",
      reason: "Stale device must not capture this run",
      requested_at: "2026-07-29T13:31:00.000Z",
    };
    const hookCallCount = afterRequestedOutcomes.length;
    await expect(service.request(staleScope)).rejects.toMatchObject({
      code: "device_evidence_mismatch",
    });
    expect(afterRequestedOutcomes).toHaveLength(hookCallCount);
    await expect(
      database.query(
        `INSERT INTO device_run_cancellations (
           run_id,device_id,credential_id,device_generation,cause,state,
           requested_by_user_id,reason,requested_at,updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,'cancellation_requested',$6,$7,$8,$8
         )`,
        [
          staleScope.run_id,
          staleScope.device_id,
          staleScope.credential_id,
          staleScope.device_generation,
          staleScope.cause,
          staleScope.requested_by_user_id,
          staleScope.reason,
          staleScope.requested_at,
        ],
      ),
    ).rejects.toThrow("device run cancellation evidence must match the run command identity");

    await expect(
      service.request({
        ...staleScope,
        device_id: "device-2",
        credential_id: "credential-2",
        device_generation: 1,
        reason: "Stop on the rebound device",
      }),
    ).resolves.toMatchObject({
      replayed: false,
      record: { device_id: "device-2", device_generation: 1 },
    });
  });

  it("records a project stop idempotently without inventing exit or fencing publication", async () => {
    const request = {
      run_id: "run-project-stop",
      device_id: "device-1",
      credential_id: "credential-1",
      device_generation: 4,
      cause: "project_stop" as const,
      requested_by_user_id: "project-owner-1",
      reason: "Stop this project run",
      requested_at: "2026-07-29T14:00:00.000Z",
    };

    const created = await service.request(request);
    const replay = await service.request(request);

    expect(created.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(created.record).toMatchObject({
      state: "cancellation_requested",
      runner_acknowledged_at: null,
      process_exited_at: null,
      unconfirmed_offline_at: null,
      publication_fenced_at: null,
    });
    await expect(service.publicationAllowed(request.run_id)).resolves.toBe(true);
    await expect(
      service.request({ ...request, reason: "A conflicting replacement reason" }),
    ).rejects.toMatchObject({
      code: "cancellation_conflict",
    });
  });

  it("fences revocation publication until a distinct explicit reauthorization", async () => {
    const request = await service.request({
      run_id: "run-revocation",
      device_id: "device-1",
      credential_id: "credential-1",
      device_generation: 4,
      cause: "device_revocation",
      requested_by_user_id: "owner-1",
      reason: "Device revoked",
      requested_at: "2026-07-29T14:01:00.000Z",
    });

    expect(request.record.publication_fenced_at).toBe("2026-07-29T14:01:00.000Z");
    await expect(service.publicationAllowed("run-revocation")).resolves.toBe(false);

    const reauthorized = await service.reauthorizePublication({
      run_id: "run-revocation",
      reauthorized_by_user_id: "project-owner-1",
      reauthorized_at: "2026-07-29T14:05:00.000Z",
    });
    expect(reauthorized.publication_reauthorized_by_user_id).toBe("project-owner-1");
    await expect(service.publicationAllowed("run-revocation")).resolves.toBe(true);
    await expect(
      service.reauthorizePublication({
        run_id: "run-revocation",
        reauthorized_by_user_id: "owner-1",
        reauthorized_at: "2026-07-29T14:06:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "publication_already_reauthorized",
    });
  });

  it("preserves offline uncertainty when later signed evidence acknowledges and reaps the process", async () => {
    await service.request({
      run_id: "run-offline",
      device_id: "device-1",
      credential_id: "credential-1",
      device_generation: 4,
      cause: "device_revocation",
      requested_by_user_id: "owner-1",
      reason: "Fence the offline device",
      requested_at: "2026-07-29T14:10:00.000Z",
    });
    const offline = await service.markUnconfirmedOffline({
      run_id: "run-offline",
      recorded_at: "2026-07-29T14:11:00.000Z",
    });
    expect(offline.state).toBe("unconfirmed_offline");

    const acknowledged = await service.acknowledge({
      run_id: "run-offline",
      device_id: "device-1",
      credential_id: "credential-1",
      device_generation: 4,
      acknowledged_at: "2026-07-29T14:12:00.000Z",
    });
    expect(acknowledged).toMatchObject({
      state: "runner_acknowledged",
      runner_acknowledged_at: "2026-07-29T14:12:00.000Z",
      unconfirmed_offline_at: "2026-07-29T14:11:00.000Z",
      process_exited_at: null,
    });

    const exited = await service.confirmProcessExited({
      run_id: "run-offline",
      device_id: "device-1",
      credential_id: "credential-1",
      device_generation: 4,
      acknowledged_at: "2026-07-29T14:12:00.000Z",
      process_exited_at: "2026-07-29T14:13:00.000Z",
      process_tree_reaped: true,
    });
    expect(exited).toMatchObject({
      state: "process_exited",
      process_exited_at: "2026-07-29T14:13:00.000Z",
      unconfirmed_offline_at: "2026-07-29T14:11:00.000Z",
    });
    const run = await database.query<{ state: string; finished_at: Date | string | null }>(
      "SELECT state,finished_at FROM agent_runs WHERE id='run-offline'",
    );
    expect(run.rows[0]?.state).toBe("cancelled");
    expect(run.rows[0]?.finished_at).not.toBeNull();
  });

  it("finalizes a never-started run on acknowledgement alone, since no process ever existed", async () => {
    await database.query(
      "UPDATE agent_runs SET state='dispatched', task_id='task-never-started' WHERE id='run-never-started'",
    );
    await service.request({
      run_id: "run-never-started",
      device_id: "device-1",
      credential_id: "credential-1",
      device_generation: 4,
      cause: "project_stop",
      requested_by_user_id: "owner-1",
      reason: "Stopped by the user from the Development chat.",
      requested_at: "2026-07-29T15:00:00.000Z",
    });

    const acknowledged = await service.acknowledge({
      run_id: "run-never-started",
      device_id: "device-1",
      credential_id: "credential-1",
      device_generation: 4,
      acknowledged_at: "2026-07-29T15:01:00.000Z",
    });
    expect(acknowledged.state).toBe("runner_acknowledged");

    const run = await database.query<{ state: string }>(
      "SELECT state FROM agent_runs WHERE id='run-never-started'",
    );
    expect(run.rows[0]?.state).toBe("cancelled");
    const task = await database.query<{ state: string }>(
      "SELECT state FROM tasks WHERE id='task-never-started'",
    );
    expect(task.rows[0]?.state).toBe("blocked");
  });

  it("rejects evidence from another device, credential, or generation", async () => {
    await service.request({
      run_id: "run-mismatch",
      device_id: "device-1",
      credential_id: "credential-1",
      device_generation: 4,
      cause: "emergency_stop",
      requested_by_user_id: "owner-1",
      reason: "Local emergency stop",
      requested_at: "2026-07-29T14:20:00.000Z",
    });

    await expect(
      service.acknowledge({
        run_id: "run-mismatch",
        device_id: "device-2",
        credential_id: "credential-2",
        device_generation: 1,
        acknowledged_at: "2026-07-29T14:21:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "device_evidence_mismatch",
    });
  });

  it("does not allow process-exit evidence or cancellation identity to regress", async () => {
    await expect(
      database.query(`
        UPDATE device_run_cancellations
           SET state='cancellation_requested',
               runner_acknowledged_at=NULL,
               process_exited_at=NULL
         WHERE run_id='run-offline'
      `),
    ).rejects.toThrow();
    await expect(
      database.query(`
        UPDATE device_run_cancellations
           SET device_generation=5
         WHERE run_id='run-offline'
      `),
    ).rejects.toThrow();
  });
});
