import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type DeviceBrowserDeliveryFrame,
  type DeviceBrowserSessionDelivery,
  PostgresDeviceBrowserAudienceRepository,
  ScopedDeviceBrowserDelivery,
} from "../src/devices/browserDelivery.js";

describe.sequential("scoped device browser delivery", () => {
  let database: PGlite;
  let delivery: ScopedDeviceBrowserDelivery;
  let received: Map<string, DeviceBrowserDeliveryFrame[]>;
  let sessions: DeviceBrowserSessionDelivery[];

  beforeAll(async () => {
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
        owner_user_id TEXT REFERENCES users(id),
        primary_repository_binding_id TEXT,
        status TEXT NOT NULL
      );
      CREATE TABLE project_members (
        project_id TEXT NOT NULL REFERENCES projects(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );
      CREATE TABLE repository_bindings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        binding_type TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_id TEXT,
        repository_id TEXT NOT NULL
      );
    `);
    await database.exec(
      await readFile(new URL("../drizzle/0053_device_identity_core.sql", import.meta.url), "utf8"),
    );
    await database.exec(`
      ALTER TABLE device_repository_registrations
        ADD COLUMN approved_credential_id TEXT;
      ALTER TABLE device_repository_registrations
        ADD COLUMN approved_generation BIGINT;
    `);
    await database.exec(`
      INSERT INTO users (id, role, status) VALUES
        ('device-owner', 'member', 'active'),
        ('project-owner', 'member', 'active'),
        ('project-member', 'member', 'active'),
        ('other-project-member', 'member', 'active'),
        ('admin-only', 'admin', 'active'),
        ('disabled-member', 'member', 'disabled'),
        ('disabled-device-owner', 'member', 'disabled');

      INSERT INTO projects (id, owner_user_id, status) VALUES
        ('project-1', 'project-owner', 'active'),
        ('project-2', 'other-project-member', 'active');

      INSERT INTO project_members (project_id, user_id, status) VALUES
        ('project-1', 'project-member', 'active'),
        ('project-1', 'disabled-member', 'active'),
        ('project-2', 'other-project-member', 'active');

      INSERT INTO devices (
        id, owner_user_id, display_name, location_label, os_family,
        architecture, lifecycle
      ) VALUES
        (
          'device-1', 'device-owner', 'Office Mac mini', 'Office',
          'macos', 'arm64', 'active'
        ),
        (
          'device-disabled-owner', 'disabled-device-owner', 'Dormant Mac', NULL,
          'macos', 'arm64', 'active'
        ),
        (
          'device-revoked-credential', 'device-owner', 'Fenced Mac', NULL,
          'macos', 'arm64', 'active'
        );

      INSERT INTO device_credentials (
        id, device_id, generation, public_key_spki_der,
        public_key_fingerprint
      ) VALUES
        (
          'credential-1', 'device-1', 1, decode('abcd', 'hex'),
          repeat('a', 64)
        ),
        (
          'credential-disabled-owner', 'device-disabled-owner', 1,
          decode('abce', 'hex'), repeat('b', 64)
        );
      INSERT INTO device_credentials (
        id, device_id, generation, public_key_spki_der,
        public_key_fingerprint, state, revoked_at
      ) VALUES (
        'credential-revoked', 'device-revoked-credential', 1,
        decode('abcf', 'hex'), repeat('c', 64), 'revoked', now()
      );

      INSERT INTO device_repository_registrations (
        id, device_id, workspace_id, repository_id,
        repository_display_name, state, approved_by_user_id, approved_at,
        approved_credential_id, approved_generation
      ) VALUES
        (
          'registration-1', 'device-1', 'workspace-1', 'repository-1',
          'Repository 1', 'active', 'device-owner', now(), 'credential-1', 1
        ),
        (
          'registration-2', 'device-1', 'workspace-2', 'repository-2',
          'Repository 2', 'active', 'device-owner', now(), 'credential-1', 1
        ),
        (
          'registration-disabled-owner', 'device-disabled-owner',
          'workspace-disabled-owner', 'repository-disabled-owner',
          'Disabled owner repository', 'active', 'disabled-device-owner', now(),
          'credential-disabled-owner', 1
        ),
        (
          'registration-revoked-credential', 'device-revoked-credential',
          'workspace-revoked-credential', 'repository-revoked-credential',
          'Revoked credential repository', 'active', 'device-owner', now(),
          'credential-revoked', 1
        );

      INSERT INTO project_device_repository_grants (
        id, project_id, repository_registration_id, state,
        granted_by_user_id, granted_at
      ) VALUES (
        'grant-1', 'project-1', 'registration-1', 'active',
        'device-owner', now()
      );
      INSERT INTO project_device_repository_grants (
        id, project_id, repository_registration_id, state,
        granted_by_user_id, granted_at
      ) VALUES
        (
          'grant-disabled-owner', 'project-1', 'registration-disabled-owner',
          'active', 'disabled-device-owner', now()
        ),
        (
          'grant-revoked-credential', 'project-1', 'registration-revoked-credential',
          'active', 'device-owner', now()
        );
      INSERT INTO project_device_repository_grants (
        id, project_id, repository_registration_id, state,
        granted_by_user_id, granted_at, revoked_by_user_id, revoked_at
      ) VALUES (
        'grant-revoked', 'project-1', 'registration-2', 'revoked',
        'device-owner', now(), 'device-owner', now()
      );

      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, workspace_id, repository_id,
        project_device_repository_grant_id
      ) VALUES
        (
          'target-1', 'project-1', 'local_runner', 'connected',
          'workspace-1', 'repository-1', 'grant-1'
        ),
        (
          'target-revoked', 'project-1', 'local_runner', 'connected',
          'workspace-2', 'repository-2', 'grant-revoked'
        ),
        (
          'target-disabled-owner', 'project-1', 'local_runner', 'connected',
          'workspace-disabled-owner', 'repository-disabled-owner',
          'grant-disabled-owner'
        ),
        (
          'target-revoked-credential', 'project-1', 'local_runner', 'connected',
          'workspace-revoked-credential', 'repository-revoked-credential',
          'grant-revoked-credential'
        );

      UPDATE projects
         SET primary_repository_binding_id = 'target-1'
       WHERE id = 'project-1';
    `);
    delivery = new ScopedDeviceBrowserDelivery(
      new PostgresDeviceBrowserAudienceRepository(database),
    );
  });

  beforeEach(() => {
    resetSessions();
  });

  afterAll(async () => {
    await database.close();
  });

  it("delivers connection status only to the active device owner", async () => {
    const result = await delivery.deliverOwnerAvailability(
      {
        device_id: "device-1",
        availability: "online",
        observed_at: "2026-07-29T12:00:00.000Z",
      },
      sessions,
    );

    expect(result).toEqual({
      audience_users: 1,
      delivered_sessions: 2,
      failed_sessions: 0,
    });
    expect(received.get("device-owner")).toEqual([
      {
        type: "device_status",
        audience: "owner",
        device_id: "device-1",
        availability: "online",
        observed_at: "2026-07-29T12:00:00.000Z",
      },
      {
        type: "device_status",
        audience: "owner",
        device_id: "device-1",
        availability: "online",
        observed_at: "2026-07-29T12:00:00.000Z",
      },
    ]);
    expect(received.get("project-owner")).toEqual([]);
    expect(received.get("project-member")).toEqual([]);
    expect(received.get("admin-only")).toEqual([]);
  });

  it("delivers only a strict reduced target projection to the authorized project audience", async () => {
    const result = await delivery.deliverProjectTargetStatus(
      {
        device_id: "device-1",
        project_id: "project-1",
        execution_target_id: "grant-1",
        target: projectTarget(),
      },
      sessions,
    );

    expect(result).toEqual({
      audience_users: 2,
      delivered_sessions: 2,
      failed_sessions: 0,
    });
    expect(received.get("project-owner")).toHaveLength(1);
    expect(received.get("project-member")).toHaveLength(1);
    expect(received.get("device-owner")).toEqual([]);
    expect(received.get("other-project-member")).toEqual([]);
    expect(received.get("admin-only")).toEqual([]);
    expect(received.get("disabled-member")).toEqual([]);

    const frame = received.get("project-member")?.[0];
    expect(frame).toEqual({
      type: "project_execution_target_status",
      audience: "project",
      project_id: "project-1",
      target: projectTarget(),
    });
    expect(JSON.stringify(frame)).not.toMatch(
      /fingerprint|credential|capabilities|grants|activity|task_count|repository_count/,
    );
  });

  it("fails closed for revoked grants and inconsistent target scope", async () => {
    await expect(
      delivery.deliverProjectTargetStatus(
        {
          device_id: "device-1",
          project_id: "project-1",
          execution_target_id: "grant-revoked",
          target: {
            ...projectTarget(),
            execution_target_id: "grant-revoked",
          },
        },
        sessions,
      ),
    ).resolves.toEqual({
      audience_users: 0,
      delivered_sessions: 0,
      failed_sessions: 0,
    });
    await expect(
      delivery.deliverProjectTargetStatus(
        {
          device_id: "device-1",
          project_id: "project-2",
          execution_target_id: "grant-1",
          target: projectTarget(),
        },
        sessions,
      ),
    ).resolves.toEqual({
      audience_users: 0,
      delivered_sessions: 0,
      failed_sessions: 0,
    });
    expect([...received.values()].every((frames) => frames.length === 0)).toBe(true);
  });

  it("excludes targets whose owner or current credential is inactive", async () => {
    for (const [device_id, execution_target_id] of [
      ["device-disabled-owner", "grant-disabled-owner"],
      ["device-revoked-credential", "grant-revoked-credential"],
    ] as const) {
      await expect(
        delivery.deliverProjectTargetStatus(
          {
            device_id,
            project_id: "project-1",
            execution_target_id,
            target: {
              ...projectTarget(),
              execution_target_id,
            },
          },
          sessions,
        ),
      ).resolves.toEqual({
        audience_users: 0,
        delivered_sessions: 0,
        failed_sessions: 0,
      });
    }
    expect([...received.values()].every((frames) => frames.length === 0)).toBe(true);
  });

  it("revalidates project access immediately before sending each session frame", async () => {
    let accepted = true;
    const guardedDelivery = new ScopedDeviceBrowserDelivery({
      async ownerUserId() {
        return null;
      },
      async acceptedProjectUserIds() {
        accepted = false;
        return ["project-member"];
      },
      async isAcceptedProjectUser() {
        return accepted;
      },
    });

    await expect(
      guardedDelivery.deliverProjectTargetStatus(
        {
          device_id: "device-1",
          project_id: "project-1",
          execution_target_id: "grant-1",
          target: projectTarget(),
        },
        sessions,
      ),
    ).resolves.toEqual({
      audience_users: 1,
      delivered_sessions: 0,
      failed_sessions: 0,
    });
    expect(received.get("project-member")).toEqual([]);
  });

  it("rejects owner-only metadata before resolving or delivering a project event", async () => {
    const unsafeTarget = {
      ...projectTarget(),
      public_key_fingerprint: "a".repeat(64),
      agent_version: "1.0.0",
      capabilities: ["execution"],
      grants: ["grant-1"],
      activity: { active_run_count: 1 },
    };

    await expect(
      delivery.deliverProjectTargetStatus(
        {
          device_id: "device-1",
          project_id: "project-1",
          execution_target_id: "grant-1",
          target: unsafeTarget,
        },
        sessions,
      ),
    ).rejects.toThrow();
    expect([...received.values()].every((frames) => frames.length === 0)).toBe(true);
  });

  function resetSessions(): void {
    received = new Map();
    const userIds = [
      "device-owner",
      "device-owner",
      "project-owner",
      "project-member",
      "other-project-member",
      "admin-only",
      "disabled-member",
    ];
    sessions = userIds.map((userId) => {
      const frames = received.get(userId) ?? [];
      received.set(userId, frames);
      return {
        user_id: userId,
        send: (frame: DeviceBrowserDeliveryFrame) => {
          frames.push(frame);
        },
      };
    });
  }

  function projectTarget() {
    return {
      project_id: "project-1",
      execution_target_id: "grant-1",
      name: "Office Mac mini",
      location_label: "Office",
      os_family: "macos" as const,
      status: {
        availability: "online" as const,
        compatibility: "ready" as const,
        workload: "idle" as const,
        access: "shared" as const,
      },
      last_seen_at: "2026-07-29T12:00:00.000Z",
    };
  }
});
