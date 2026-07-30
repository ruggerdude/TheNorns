import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PostgresDeviceManagementRepository } from "../src/devices/managementRepository.js";
import { DeviceManagementService } from "../src/devices/managementService.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";

interface TestIdentity {
  id: string;
  token: string;
}

describe.sequential("owner device management and project execution targets", () => {
  let database: PGlite;
  let server: NornsServer;
  let unmountedServer: NornsServer;
  let owner: TestIdentity;
  let projectOwner: TestIdentity;
  let projectMember: TestIdentity;
  let outsider: TestIdentity;
  let adminOnly: TestIdentity;
  const revoke = vi.fn();

  beforeAll(async () => {
    const users = new UserStore();
    const createIdentity = (email: string, role: "admin" | "member" = "member"): TestIdentity => {
      const record = users.createActive({
        email,
        password: "device-management-password",
        role,
      });
      return {
        id: record.id,
        token: users.login(email, "device-management-password").token,
      };
    };
    owner = createIdentity("device-owner@example.com");
    projectOwner = createIdentity("project-owner@example.com");
    projectMember = createIdentity("project-member@example.com");
    outsider = createIdentity("outsider@example.com");
    adminOnly = createIdentity("admin-only@example.com", "admin");

    database = new PGlite();
    await database.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL
      );
      CREATE TABLE project_members (
        project_id TEXT NOT NULL REFERENCES projects(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL,
        PRIMARY KEY (project_id,user_id)
      );
      CREATE TABLE repository_bindings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        binding_type TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_id TEXT,
        repository_id TEXT NOT NULL
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
        runner_generation BIGINT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await database.exec(
      await readFile(new URL("../drizzle/0053_device_identity_core.sql", import.meta.url), "utf8"),
    );
    await database.exec(
      await readFile(
        new URL("../drizzle/0057_device_management_observations.sql", import.meta.url),
        "utf8",
      ),
    );

    for (const [identity, role] of [
      [owner, "member"],
      [projectOwner, "member"],
      [projectMember, "member"],
      [outsider, "member"],
      [adminOnly, "admin"],
    ] as const) {
      await database.query("INSERT INTO users (id,role,status) VALUES ($1,$2,'active')", [
        identity.id,
        role,
      ]);
    }
    await database.query(
      `INSERT INTO projects (id,owner_user_id,status)
       VALUES ('project-1',$1,'active'),('project-2',$2,'active')`,
      [projectOwner.id, outsider.id],
    );
    await database.query(
      `INSERT INTO project_members (project_id,user_id,status)
       VALUES ('project-1',$1,'active'),('project-1',$2,'removed')`,
      [projectMember.id, outsider.id],
    );
    await database.query(
      `INSERT INTO devices (
         id,owner_user_id,display_name,location_label,os_family,architecture,
         os_version,agent_version,agent_protocol_version,agent_capabilities,
         last_seen_at,created_at,updated_at
       ) VALUES (
         'device-1',$1,'Office Mac mini','Office','macos','arm64',
         '15.5','1.7.0','1','["execution","visual_evidence"]'::jsonb,
         '2026-07-29T12:00:00.000Z','2026-07-29T10:00:00.000Z',
         '2026-07-29T12:00:00.000Z'
       ),(
         'device-2',$2,'Private travel PC',NULL,'windows','x64',
         '11','1.7.0','1','["execution"]'::jsonb,
         '2026-07-29T11:00:00.000Z','2026-07-29T10:00:00.000Z',
         '2026-07-29T11:00:00.000Z'
       )`,
      [owner.id, outsider.id],
    );
    await database.exec(`
      INSERT INTO device_credentials (
        id,device_id,generation,public_key_spki_der,public_key_fingerprint,
        activated_at,created_at
      ) VALUES
        (
          'credential-1','device-1',1,decode('abcd','hex'),repeat('a',64),
          '2026-07-29T10:00:00.000Z','2026-07-29T10:00:00.000Z'
        ),
        (
          'credential-2','device-2',1,decode('abce','hex'),repeat('b',64),
          '2026-07-29T10:00:00.000Z','2026-07-29T10:00:00.000Z'
        );
    `);
    await database.query(
      `INSERT INTO device_repository_registrations (
         id,device_id,workspace_id,repository_id,repository_display_name,
         state,approved_by_user_id,approved_at
       ) VALUES (
         'registration-1','device-1','workspace-1','repository-1',
         'Secret repository name','active',$1,'2026-07-29T10:00:00.000Z'
       ),(
         'registration-2','device-2','workspace-2','repository-2',
         'Other private repository','active',$2,'2026-07-29T10:00:00.000Z'
       )`,
      [owner.id, outsider.id],
    );
    await database.query(
      `INSERT INTO project_device_repository_grants (
         id,project_id,repository_registration_id,state,granted_by_user_id,
         granted_at
       ) VALUES (
         'grant-1','project-1','registration-1','active',$1,
         '2026-07-29T10:00:00.000Z'
       ),(
         'grant-other','project-2','registration-2','active',$2,
         '2026-07-29T10:00:00.000Z'
       )`,
      [owner.id, outsider.id],
    );
    await database.exec(`
      INSERT INTO repository_bindings (
        id,project_id,binding_type,status,workspace_id,repository_id,
        project_device_repository_grant_id
      ) VALUES
        (
          'target-1','project-1','local_runner','connected',
          'workspace-1','repository-1','grant-1'
        ),
        (
          'target-other','project-2','local_runner','connected',
          'workspace-2','repository-2','grant-other'
        );
    `);
    await database.query(
      `INSERT INTO agent_runs (
         id,project_id,repository_binding_id,initiated_by_user_id,state
       ) VALUES
         ('run-1','project-1','target-1',$1,'running'),
         ('run-stale-generation','project-1','target-1',$1,'running')`,
      [projectMember.id],
    );
    await database.exec(`
      INSERT INTO commands (
        command_id,run_id,runner_id,runner_generation,status,created_at
      ) VALUES (
        'command-1','run-1','device-1',1,'executing',
        '2026-07-29T12:30:00.000Z'
      ),(
        'command-stale-generation','run-stale-generation','device-1',0,'queued',
        '2026-07-29T12:31:00.000Z'
      );
    `);

    revoke.mockImplementation(
      async (input: {
        device_id: string;
        revoked_by_user_id: string;
        reason: string;
        revoked_at: string;
      }) => {
        await database.query(
          `UPDATE project_device_repository_grants
              SET state='revoked',revoked_by_user_id=$2,revoked_at=$3,updated_at=$3
            WHERE repository_registration_id IN (
              SELECT id FROM device_repository_registrations WHERE device_id=$1
            ) AND state='active'`,
          [input.device_id, input.revoked_by_user_id, input.revoked_at],
        );
        await database.query(
          `UPDATE device_repository_registrations
              SET state='revoked',revoked_at=$2,updated_at=$2
            WHERE device_id=$1 AND state='active'`,
          [input.device_id, input.revoked_at],
        );
        await database.query(
          `UPDATE device_credentials
              SET state='revoked',revoked_at=$2
            WHERE device_id=$1 AND state='active'`,
          [input.device_id, input.revoked_at],
        );
        await database.query(
          `UPDATE devices
              SET lifecycle='revoked',current_generation=current_generation+1,
                  revoked_at=$2,updated_at=$2
            WHERE id=$1`,
          [input.device_id, input.revoked_at],
        );
        return {
          replayed: false,
          record: {
            device_id: input.device_id,
            revoked_by_user_id: input.revoked_by_user_id,
            previous_generation: 1,
            fenced_generation: 2,
            reason: input.reason,
            revoked_at: input.revoked_at,
            affected_run_ids: [],
          },
        };
      },
    );

    const service = new DeviceManagementService(
      new PostgresDeviceManagementRepository(new PGliteTransactionRunner(database)),
      { revoke },
      {
        now: () => new Date("2026-07-29T13:00:00.000Z"),
        presence: {
          availability: (deviceId) => (deviceId === "device-1" ? "online" : "offline"),
        },
      },
    );
    server = await buildServer({
      stores: new RelayStores(),
      users,
      deviceManagement: { service },
      clock: () => new Date("2026-07-29T13:00:00.000Z"),
    });
    unmountedServer = await buildServer({
      stores: new RelayStores(),
      users,
    });
  });

  afterAll(async () => {
    await server.app.close();
    await unmountedServer.app.close();
    await database.close();
  });

  it("keeps the management routes default-off unless explicitly supplied", async () => {
    const response = await unmountedServer.app.inject({
      method: "GET",
      url: "/api/devices",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns full device details only for devices owned by the caller", async () => {
    const response = await server.app.inject({
      method: "GET",
      url: "/api/devices",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      downloads: {
        macos: null,
        macos_release: null,
        windows: null,
      },
      devices: [
        expect.objectContaining({
          device_id: "device-1",
          owner_user_id: owner.id,
          name: "Office Mac mini",
          location_label: "Office",
          status: {
            availability: "online",
            compatibility: "ready",
            workload: "busy",
            access: "owned",
          },
          active_credential: expect.objectContaining({
            credential_id: "credential-1",
            public_key_fingerprint: "a".repeat(64),
          }),
          agent: {
            version: "1.7.0",
            protocol_version: "1",
            capabilities: ["execution", "visual_evidence"],
          },
          repository_grants: [
            {
              grant_id: "grant-1",
              project_id: "project-1",
              repository_registration_id: "registration-1",
              state: "active",
            },
          ],
          activity: {
            active_run_count: 1,
            queued_command_count: 0,
          },
        }),
      ],
    });

    for (const identity of [projectOwner, projectMember, adminOnly]) {
      const forbidden = await server.app.inject({
        method: "GET",
        url: "/api/devices/device-1",
        headers: { authorization: `Bearer ${identity.token}` },
      });
      expect(forbidden.statusCode, identity.id).toBe(404);
    }
    const adminList = await server.app.inject({
      method: "GET",
      url: "/api/devices",
      headers: { authorization: `Bearer ${adminOnly.token}` },
    });
    expect(adminList.json()).toEqual({
      devices: [],
      downloads: {
        macos: null,
        macos_release: null,
        windows: null,
      },
    });
  });

  it("lets only the owner rename the name and optional location label", async () => {
    const adminAttempt = await server.app.inject({
      method: "PATCH",
      url: "/api/devices/device-1",
      headers: { authorization: `Bearer ${adminOnly.token}` },
      payload: { name: "Admin renamed", location_label: null },
    });
    expect(adminAttempt.statusCode).toBe(404);

    const renamed = await server.app.inject({
      method: "PATCH",
      url: "/api/devices/device-1",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: "Studio Mac", location_label: "Studio" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      device_id: "device-1",
      name: "Studio Mac",
      location_label: "Studio",
    });
  });

  it("keeps project execution targets behind the independent Phase 4 gate", async () => {
    for (const identity of [projectOwner, projectMember, owner, outsider, adminOnly]) {
      const response = await server.app.inject({
        method: "GET",
        url: "/api/projects/project-1/execution-targets",
        headers: { authorization: `Bearer ${identity.token}` },
      });
      expect(response.statusCode, identity.id).toBe(404);
    }
  });

  it("lets only the owner revoke and returns a muted terminal projection", async () => {
    const adminAttempt = await server.app.inject({
      method: "POST",
      url: "/api/devices/device-1/revoke",
      headers: { authorization: `Bearer ${adminOnly.token}` },
      payload: { reason: "Admin alone has no computer authority" },
    });
    expect(adminAttempt.statusCode).toBe(404);
    expect(revoke).not.toHaveBeenCalled();

    const revoked = await server.app.inject({
      method: "POST",
      url: "/api/devices/device-1/revoke",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { reason: "Retiring this installation" },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      device_id: "device-1",
      lifecycle: "revoked",
      status: {
        availability: "offline",
        workload: "idle",
        access: "revoked",
      },
      active_credential: null,
    });
    expect(revoke).toHaveBeenCalledOnce();

    const targetAfterRevocation = await server.app.inject({
      method: "GET",
      url: "/api/projects/project-1/execution-targets",
      headers: { authorization: `Bearer ${projectMember.token}` },
    });
    expect(targetAfterRevocation.statusCode).toBe(404);
  });
});
