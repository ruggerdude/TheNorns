import { PGlite } from "@electric-sql/pglite";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DispatchContextScopeRepository } from "../src/coordinator/dispatchContextScope.js";
import {
  DeviceOnlineControlBroker,
  DeviceRunCancellationService,
  registerProjectCancellationRoutes,
} from "../src/devices/index.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import {
  loadDeviceCancellationTrackingMigrationSql,
  loadProjectRunCancellationMigrationSql,
} from "../src/persistence/v2/migrate.js";

describe.sequential("Phase 5 project-run cancellation routes", () => {
  let database: PGlite;
  let app: ReturnType<typeof Fastify>;
  let service: DeviceRunCancellationService;
  let broker: DeviceOnlineControlBroker;
  let clock: Date;

  beforeEach(async () => {
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
        owner_user_id TEXT NOT NULL REFERENCES users(id),
        primary_repository_binding_id TEXT
      );
      CREATE TABLE project_members (
        project_id TEXT NOT NULL REFERENCES projects(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL,
        PRIMARY KEY (project_id,user_id)
      );
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id),
        display_name TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        current_generation BIGINT NOT NULL
      );
      CREATE TABLE device_credentials (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        generation BIGINT NOT NULL,
        state TEXT NOT NULL,
        UNIQUE (device_id,id,generation)
      );
      CREATE TABLE device_repository_registrations (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        workspace_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        state TEXT NOT NULL,
        approved_credential_id TEXT,
        approved_generation BIGINT
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
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        phase_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        repository_binding_id TEXT NOT NULL REFERENCES repository_bindings(id),
        initiated_by_user_id TEXT NOT NULL REFERENCES users(id),
        state TEXT NOT NULL,
        lifecycle_version INTEGER NOT NULL DEFAULT 0,
        aggregate_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        ,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        ,started_at TIMESTAMPTZ
        ,finished_at TIMESTAMPTZ
      );
      CREATE TABLE commands (
        command_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id),
        runner_id TEXT NOT NULL,
        runner_generation BIGINT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE dispatch_jobs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id),
        status TEXT NOT NULL,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ
      );
      CREATE TABLE gateway_credentials (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        revoked_at TIMESTAMPTZ
      );
      CREATE TABLE dispatch_context_documents (
        runner_id TEXT NOT NULL,
        runner_generation INTEGER NOT NULL,
        context_document_id TEXT NOT NULL,
        dispatch_job_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (runner_id,context_document_id)
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
      CREATE TABLE lifecycle_integrity_findings (
        id TEXT PRIMARY KEY,
        aggregate_kind TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE work_conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL
      );
      CREATE TABLE conversation_task_package_bindings (
        package_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        task_id TEXT NOT NULL
      );
      CREATE TABLE conversation_task_package_runs (
        run_id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL
      );

      INSERT INTO users (id,status) VALUES
        ('project-owner','active'),
        ('project-member','active'),
        ('device-owner','active'),
        ('admin-only','active'),
        ('other-owner','active');
      INSERT INTO projects (id,status,owner_user_id) VALUES
        ('project-1','active','project-owner'),
        ('project-2','active','other-owner');
      INSERT INTO project_members (project_id,user_id,status)
      VALUES ('project-1','project-member','active');
      INSERT INTO devices (
        id,owner_user_id,display_name,lifecycle,current_generation
      ) VALUES ('device-1','device-owner','Office Mac mini','active',1);
      INSERT INTO device_credentials (id,device_id,generation,state)
      VALUES ('credential-1','device-1',1,'active');
      INSERT INTO device_repository_registrations (
        id,device_id,workspace_id,repository_id,state,
        approved_credential_id,approved_generation
      ) VALUES (
        'registration-1','device-1','workspace-1','repository-1','active',
        'credential-1',1
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
      UPDATE projects
         SET primary_repository_binding_id='binding-1'
       WHERE id='project-1';
      INSERT INTO agent_runs (
        id,project_id,phase_id,task_id,repository_binding_id,
        initiated_by_user_id,state,created_at
      ) VALUES (
        'run-1','project-1','phase-1','task-1','binding-1',
        'project-member','running','2026-07-30T11:00:00.000Z'
      ),(
        'run-queued','project-1','phase-1','task-queued','binding-1',
        'project-member','created','2026-07-30T11:01:00.000Z'
      );
      INSERT INTO commands (
        command_id,run_id,runner_id,runner_generation,status,created_at
      ) VALUES (
        'command-1','run-1','device-1',1,'queued','2026-07-30T11:00:00.000Z'
      ),(
        'command-queued','run-queued','device-1',1,'queued',
        '2026-07-30T11:01:00.000Z'
      );
      INSERT INTO dispatch_jobs (
        id,run_id,status,lease_owner,lease_expires_at
      ) VALUES (
        'dispatch-1','run-1','leased','dispatcher-1','2026-07-30T12:10:00.000Z'
      ),(
        'dispatch-queued','run-queued','queued',NULL,NULL
      );
      INSERT INTO gateway_credentials (id,run_id)
      VALUES ('gateway-1','run-1'),('gateway-queued','run-queued');
      INSERT INTO dispatch_context_documents (
        runner_id,runner_generation,context_document_id,dispatch_job_id,run_id
      ) VALUES (
        'device-1',1,'context-1','dispatch-1','run-1'
      ),(
        'device-1',1,'context-queued','dispatch-queued','run-queued'
      );
      INSERT INTO work_conversations (id,project_id,work_item_id) VALUES
        ('conversation-1','project-1','work-1'),
        ('conversation-idle','project-1','work-2');
      INSERT INTO conversation_task_package_bindings (
        package_id,project_id,conversation_id,task_id
      ) VALUES (
        'package-1','project-1','conversation-1','task-1'
      );
      INSERT INTO conversation_task_package_runs (
        run_id,package_id,project_id,task_id
      ) VALUES (
        'run-1','package-1','project-1','task-1'
      );
    `);
    await database.exec(await loadDeviceCancellationTrackingMigrationSql());
    await database.exec(await loadProjectRunCancellationMigrationSql());

    const transactions = new PGliteTransactionRunner(database);
    broker = new DeviceOnlineControlBroker(transactions);
    service = new DeviceRunCancellationService(transactions, {
      afterRequested: ({ record }) => broker.requestCancellation(record),
    });
    clock = new Date("2026-07-30T12:00:00.000Z");
    app = Fastify();
    await registerProjectCancellationRoutes(app, {
      service,
      now: () => clock,
      requireUser: async (request, reply) => {
        const user = request.headers["x-test-user"];
        if (typeof user !== "string") {
          reply.code(401).send({ error: "unauthorized" });
          return null;
        }
        return { id: user };
      },
    });
  }, 30_000);

  afterEach(async () => {
    await app.close();
    await database.close();
  });

  it("atomically fences and audits an online owner request and replays it idempotently", async () => {
    const frames: unknown[] = [];
    const disconnect = await broker.connect({
      identity: {
        device_id: "device-1",
        owner_user_id: "device-owner",
        credential_id: "credential-1",
        generation: 1,
        protocol_version: "1",
      },
      send: (frame) => frames.push(frame),
      close: () => undefined,
    });
    expect(disconnect).toBeTypeOf("function");

    const request = {
      method: "POST" as const,
      url: "/api/projects/project-1/runs/run-1/cancel",
      headers: { "x-test-user": "project-owner" },
      payload: { reason: "Stop selected run", idempotency_key: "stop-1" },
    };
    const response = await app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      project_id: "project-1",
      run_id: "run-1",
      state: "cancellation_requested",
      cancellation_requested_at: "2026-07-30T12:00:00.000Z",
      runner_acknowledged_at: null,
      process_exited_at: null,
      unconfirmed_offline_at: null,
    });
    expect(frames).toHaveLength(1);

    clock = new Date("2026-07-30T12:05:00.000Z");
    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(response.json());
    expect(frames).toHaveLength(2);

    const state = await database.query<{
      command_status: string;
      dispatch_status: string;
      gateway_revoked: boolean;
      context_revoked: boolean;
      fenced: boolean;
      audits: number;
    }>(`
      SELECT
        (SELECT status FROM commands WHERE command_id='command-1') AS command_status,
        (SELECT status FROM dispatch_jobs WHERE id='dispatch-1') AS dispatch_status,
        (SELECT revoked_at IS NOT NULL FROM gateway_credentials WHERE id='gateway-1')
          AS gateway_revoked,
        (SELECT revoked_at IS NOT NULL FROM dispatch_context_documents
          WHERE context_document_id='context-1') AS context_revoked,
        (SELECT publication_fenced_at IS NOT NULL FROM device_run_cancellations
          WHERE run_id='run-1') AS fenced,
        (SELECT count(*)::int FROM audit_events
          WHERE audit_type='device.project_run_cancellation_requested') AS audits
    `);
    expect(state.rows[0]).toEqual({
      command_status: "cancelled",
      dispatch_status: "cancelled",
      gateway_revoked: true,
      context_revoked: true,
      fenced: true,
      audits: 1,
    });
    await expect(service.publicationAllowed("run-1")).resolves.toBe(false);

    const contextScopes = new DispatchContextScopeRepository(new PGliteTransactionRunner(database));
    const contextReference = {
      artifact_id: "context-1",
      content_hash: "a".repeat(64),
      byte_size: 10,
      storage_ref: "relay://context/context-1",
    };
    await contextScopes.recordScope(
      {
        runnerId: "device-1",
        runnerGeneration: 1,
        dispatchJobId: "dispatch-1",
        runId: "run-1",
      },
      [contextReference],
    );
    await expect(contextScopes.isAuthorized("device-1", 1, "context-1")).resolves.toBe(false);

    await database.exec(`
      INSERT INTO agent_runs (
        id,project_id,phase_id,task_id,repository_binding_id,
        initiated_by_user_id,state,created_at
      ) VALUES (
        'run-new','project-1','phase-1','task-new','binding-1',
        'project-member','created','2026-07-30T12:06:00.000Z'
      );
      INSERT INTO commands (
        command_id,run_id,runner_id,runner_generation,status,created_at
      ) VALUES (
        'command-new','run-new','device-1',1,'queued',
        '2026-07-30T12:06:00.000Z'
      );
    `);
    await contextScopes.recordScope(
      {
        runnerId: "device-1",
        runnerGeneration: 1,
        dispatchJobId: "dispatch-new",
        runId: "run-new",
      },
      [contextReference],
    );
    await expect(contextScopes.isAuthorized("device-1", 1, "context-1")).resolves.toBe(true);

    const conflict = await app.inject({
      ...request,
      payload: { reason: "Different request", idempotency_key: "stop-1" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "idempotency_conflict" });
    disconnect?.();
  });

  it("stops every active agent run in the project with one request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/runs/cancel-all",
      headers: { "x-test-user": "project-owner" },
      payload: { reason: "Stop all plan work", idempotency_key: "stop-all-1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      failed_run_ids: [],
      cancellations: expect.arrayContaining([
        expect.objectContaining({ run_id: "run-1" }),
        expect.objectContaining({ run_id: "run-queued" }),
      ]),
    });
    const cancelled = await database.query<{ run_id: string }>(
      "SELECT run_id FROM device_run_cancellations ORDER BY run_id",
    );
    expect(cancelled.rows).toEqual([{ run_id: "run-1" }, { run_id: "run-queued" }]);
  });

  it("records offline uncertainty and redelivers the durable request on reconnect", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/runs/run-1/cancel",
      headers: { "x-test-user": "project-owner" },
      payload: { reason: "Stop offline run", idempotency_key: "offline-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "unconfirmed_offline",
      unconfirmed_offline_at: "2026-07-30T12:00:00.000Z",
      runner_acknowledged_at: null,
      process_exited_at: null,
    });
    const memberStatus = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/runs/run-1/cancellation",
      headers: { "x-test-user": "project-member" },
    });
    expect(memberStatus.statusCode).toBe(200);
    expect(memberStatus.json()).toEqual(response.json());

    const frames: unknown[] = [];
    await broker.connect({
      identity: {
        device_id: "device-1",
        owner_user_id: "device-owner",
        credential_id: "credential-1",
        generation: 1,
        protocol_version: "1",
      },
      send: (frame) => frames.push(frame),
      close: () => undefined,
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "device_cancellation_request",
      run_id: "run-1",
      publication_fenced: true,
    });

    await service.acknowledge({
      run_id: "run-1",
      device_id: "device-1",
      credential_id: "credential-1",
      device_generation: 1,
      acknowledged_at: "2026-07-30T12:01:00.000Z",
    });
    let status = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/runs/run-1/cancellation",
      headers: { "x-test-user": "project-owner" },
    });
    expect(status.json()).toMatchObject({
      state: "runner_acknowledged",
      runner_acknowledged_at: "2026-07-30T12:01:00.000Z",
      process_exited_at: null,
      unconfirmed_offline_at: "2026-07-30T12:00:00.000Z",
    });

    await service.confirmProcessExited({
      run_id: "run-1",
      device_id: "device-1",
      credential_id: "credential-1",
      device_generation: 1,
      acknowledged_at: "2026-07-30T12:01:00.000Z",
      process_exited_at: "2026-07-30T12:02:00.000Z",
      process_tree_reaped: true,
    });
    status = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/runs/run-1/cancellation",
      headers: { "x-test-user": "project-owner" },
    });
    expect(status.json()).toMatchObject({
      state: "process_exited",
      runner_acknowledged_at: "2026-07-30T12:01:00.000Z",
      process_exited_at: "2026-07-30T12:02:00.000Z",
      unconfirmed_offline_at: "2026-07-30T12:00:00.000Z",
    });
    const conversation = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/conversations/conversation-1/execution",
      headers: { "x-test-user": "project-member" },
    });
    expect(conversation.statusCode).toBe(200);
    expect(conversation.json()).toMatchObject({
      presentation: "historical",
      run: {
        run_id: "run-1",
        state: "cancelled",
        can_stop: false,
        cancellation: { state: "process_exited" },
      },
    });
  });

  it("enforces project-owner stop authority without an administrator bypass", async () => {
    for (const user of ["project-member", "admin-only", "other-owner"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/project-1/runs/run-1/cancel",
        headers: { "x-test-user": user },
        payload: { reason: "Forbidden stop", idempotency_key: `stop-${user}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
    }
    const wrongProject = await app.inject({
      method: "POST",
      url: "/api/projects/project-2/runs/run-1/cancel",
      headers: { "x-test-user": "other-owner" },
      payload: { reason: "Wrong project", idempotency_key: "wrong-project" },
    });
    expect(wrongProject.statusCode).toBe(404);
  });

  it("hides cancellation state when the project is inactive", async () => {
    const cancellation = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/runs/run-1/cancel",
      headers: { "x-test-user": "project-owner" },
      payload: { reason: "Stop before archive", idempotency_key: "inactive-1" },
    });
    expect(cancellation.statusCode).toBe(200);
    await database.exec("UPDATE projects SET status='archived' WHERE id='project-1'");

    for (const user of ["project-owner", "project-member", "admin-only"]) {
      const status = await app.inject({
        method: "GET",
        url: "/api/projects/project-1/runs/run-1/cancellation",
        headers: { "x-test-user": user },
      });
      expect(status.statusCode).toBe(404);
      expect(status.json()).toEqual({ error: "not_found" });
    }
  });

  it("terminalizes queued work without fabricating runner evidence", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/runs/run-queued/cancel",
      headers: { "x-test-user": "project-owner" },
      payload: { reason: "Cancel before dispatch", idempotency_key: "queued-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "unconfirmed_offline",
      runner_acknowledged_at: null,
      process_exited_at: null,
    });
    const state = await database.query<{
      run_state: string;
      finished: boolean;
      transitions: number;
    }>(
      `SELECT
         state AS run_state,
         finished_at IS NOT NULL AS finished,
         (SELECT count(*)::int
            FROM domain_events
           WHERE stream_type='agent_run'
             AND stream_id='run-queued'
             AND payload->>'to'='cancelled') AS transitions
       FROM agent_runs
       WHERE id='run-queued'`,
    );
    expect(state.rows[0]).toEqual({
      run_state: "cancelled",
      finished: true,
      transitions: 1,
    });
  });

  it("rolls every fence back when the audited cancellation transaction cannot commit", async () => {
    await database.exec(`
      CREATE FUNCTION norns_test_reject_cancellation_audit()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        RAISE EXCEPTION 'injected audit failure';
      END
      $fn$;
      CREATE TRIGGER norns_test_reject_cancellation_audit
        BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION norns_test_reject_cancellation_audit();
    `);
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/runs/run-1/cancel",
      headers: { "x-test-user": "project-owner" },
      payload: { reason: "Must roll back", idempotency_key: "rollback-1" },
    });
    expect(response.statusCode).toBe(503);
    const state = await database.query<{
      cancellations: number;
      command_status: string;
      dispatch_status: string;
      gateway_revoked: boolean;
      context_revoked: boolean;
    }>(`
      SELECT
        (SELECT count(*)::int FROM device_run_cancellations) AS cancellations,
        (SELECT status FROM commands WHERE command_id='command-1') AS command_status,
        (SELECT status FROM dispatch_jobs WHERE id='dispatch-1') AS dispatch_status,
        (SELECT revoked_at IS NOT NULL FROM gateway_credentials WHERE id='gateway-1')
          AS gateway_revoked,
        (SELECT revoked_at IS NOT NULL FROM dispatch_context_documents
          WHERE context_document_id='context-1') AS context_revoked
    `);
    expect(state.rows[0]).toEqual({
      cancellations: 0,
      command_status: "queued",
      dispatch_status: "leased",
      gateway_revoked: false,
      context_revoked: false,
    });
  });

  it("returns privacy-reduced conversation placement to members with owner-only stop capability", async () => {
    const owner = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/conversations/conversation-1/execution",
      headers: { "x-test-user": "project-owner" },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toEqual({
      project_id: "project-1",
      conversation_id: "conversation-1",
      presentation: "active",
      target: { execution_target_id: "grant-1", name: "Office Mac mini" },
      run: {
        run_id: "run-1",
        state: "running",
        can_stop: true,
        cancellation: null,
      },
    });

    const member = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/conversations/conversation-1/execution",
      headers: { "x-test-user": "project-member" },
    });
    expect(member.statusCode).toBe(200);
    expect(member.json()).toEqual({
      ...owner.json(),
      run: { ...owner.json().run, can_stop: false },
    });
    expect(JSON.stringify(member.json())).not.toContain("device-1");
    expect(JSON.stringify(member.json())).not.toContain("repository-1");

    const idle = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/conversations/conversation-idle/execution",
      headers: { "x-test-user": "project-member" },
    });
    expect(idle.json()).toEqual({
      project_id: "project-1",
      conversation_id: "conversation-idle",
      presentation: "idle",
      target: { execution_target_id: "grant-1", name: "Office Mac mini" },
      run: null,
    });

    const admin = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/conversations/conversation-1/execution",
      headers: { "x-test-user": "admin-only" },
    });
    expect(admin.statusCode).toBe(404);

    const cancellation = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/runs/run-1/cancellation",
      headers: { "x-test-user": "project-member" },
    });
    expect(cancellation.statusCode).toBe(404);
  });
});
