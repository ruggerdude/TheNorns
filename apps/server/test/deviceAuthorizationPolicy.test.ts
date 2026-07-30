import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresDeviceAuthorizationPolicy } from "../src/devices/policy.js";

describe.sequential("action-specific device authorization policy", () => {
  let database: PGlite;
  let policy: PostgresDeviceAuthorizationPolicy;

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
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        repository_binding_id TEXT NOT NULL REFERENCES repository_bindings(id),
        initiated_by_user_id TEXT NOT NULL REFERENCES users(id),
        state TEXT NOT NULL DEFAULT 'running'
      );
      CREATE TABLE commands (
        command_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id),
        runner_id TEXT NOT NULL,
        runner_generation BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    const migration = await readFile(
      new URL("../drizzle/0053_device_identity_core.sql", import.meta.url),
      "utf8",
    );
    await database.exec(migration);
    await database.exec(`
      ALTER TABLE device_repository_registrations
        ADD COLUMN default_branch TEXT,
        ADD COLUMN approved_credential_id TEXT,
        ADD COLUMN approved_generation BIGINT;

      INSERT INTO users (id, role, status) VALUES
        ('device-owner', 'member', 'active'),
        ('project-owner', 'member', 'active'),
        ('project-member', 'member', 'active'),
        ('outsider', 'member', 'active'),
        ('admin-only', 'admin', 'active'),
        ('disabled-owner', 'member', 'disabled');

      INSERT INTO projects (id, owner_user_id, status) VALUES
        ('project-1', 'project-owner', 'active'),
        ('project-2', 'outsider', 'active'),
        ('project-device-owner', 'device-owner', 'active');

      INSERT INTO project_members (project_id, user_id, status) VALUES
        ('project-1', 'project-member', 'active'),
        ('project-1', 'outsider', 'removed');

      INSERT INTO devices (
        id, owner_user_id, display_name, os_family, architecture, lifecycle,
        revoked_at
      ) VALUES
        (
          'device-1', 'device-owner', 'Office Mac', 'macos', 'arm64',
          'active', NULL
        ),
        (
          'device-disabled-owner', 'disabled-owner', 'Dormant PC', 'windows',
          'x64', 'active', NULL
        ),
        (
          'device-revoked', 'device-owner', 'Old Mac', 'macos', 'arm64',
          'revoked', now()
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

      INSERT INTO device_repository_registrations (
        id, device_id, workspace_id, repository_id,
        repository_display_name, state, approved_by_user_id, approved_at,
        default_branch, approved_credential_id, approved_generation
      ) VALUES
        (
          'registration-1', 'device-1', 'workspace-1', 'repository-1',
          'Repository 1', 'active', 'device-owner', now(),
          'main', 'credential-1', 1
        ),
        (
          'registration-2', 'device-1', 'workspace-2', 'repository-2',
          'Repository 2', 'active', 'device-owner', now(),
          'main', 'credential-1', 1
        );

      INSERT INTO project_device_repository_grants (
        id, project_id, repository_registration_id, state,
        granted_by_user_id, granted_at
      ) VALUES
        (
          'grant-1', 'project-1', 'registration-1', 'active',
          'device-owner', now()
        );
      INSERT INTO project_device_repository_grants (
        id, project_id, repository_registration_id, state,
        granted_by_user_id, granted_at, revoked_by_user_id, revoked_at
      ) VALUES
        (
          'grant-revoked', 'project-1', 'registration-2', 'revoked',
          'device-owner', now(), 'device-owner', now()
        );

      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, workspace_id, repository_id,
        project_device_repository_grant_id
      ) VALUES
        (
          'binding-1', 'project-1', 'local_runner', 'connected',
          'workspace-1', 'repository-1', 'grant-1'
        ),
        (
          'binding-mismatch', 'project-1', 'local_runner', 'connected',
          'workspace-1', 'other-repository', 'grant-1'
        ),
        (
          'binding-revoked-grant', 'project-1', 'local_runner', 'connected',
          'workspace-2', 'repository-2', 'grant-revoked'
        );

      INSERT INTO agent_runs (
        id, project_id, repository_binding_id, initiated_by_user_id
      ) VALUES
        ('run-1', 'project-1', 'binding-1', 'project-member'),
        ('run-mismatch', 'project-1', 'binding-mismatch', 'project-member'),
        (
          'run-revoked-grant', 'project-1', 'binding-revoked-grant',
          'project-member'
        ),
        (
          'run-original-unauthorized', 'project-1', 'binding-1',
          'outsider'
        ),
        ('run-rebound', 'project-1', 'binding-1', 'project-member'),
        ('run-stale-generation', 'project-1', 'binding-1', 'project-member');

      INSERT INTO commands (
        command_id, run_id, runner_id, runner_generation, created_at
      ) VALUES
        (
          'command-1-a', 'run-1', 'historical-device', 1,
          '2026-07-29T12:00:00.000Z'
        ),
        (
          'command-1-z', 'run-1', 'device-1', 1,
          '2026-07-29T12:00:00.000Z'
        ),
        (
          'command-mismatch', 'run-mismatch', 'device-1', 1,
          '2026-07-29T12:00:00.000Z'
        ),
        (
          'command-revoked-grant', 'run-revoked-grant', 'device-1', 1,
          '2026-07-29T12:00:00.000Z'
        ),
        (
          'command-original-unauthorized', 'run-original-unauthorized',
          'device-1', 1, '2026-07-29T12:00:00.000Z'
        ),
        (
          'command-rebound-a', 'run-rebound', 'device-1', 1,
          '2026-07-29T12:10:00.000Z'
        ),
        (
          'command-rebound-z', 'run-rebound', 'other-device', 1,
          '2026-07-29T12:10:00.000Z'
        ),
        (
          'command-stale-generation', 'run-stale-generation', 'device-1', 0,
          '2026-07-29T12:20:00.000Z'
        );
    `);
    policy = new PostgresDeviceAuthorizationPolicy(database);
  });

  afterAll(async () => {
    await database.close();
  });

  it("limits owned-device view, management, and emergency stop to the owner", async () => {
    await expect(
      policy.canViewOwnedDevice({
        actor_user_id: "device-owner",
        device_id: "device-revoked",
      }),
    ).resolves.toMatchObject({ action: "canViewOwnedDevice", allowed: true });
    await expect(
      policy.canManageDevice({
        actor_user_id: "device-owner",
        device_id: "device-1",
      }),
    ).resolves.toMatchObject({ action: "canManageDevice", allowed: true });
    await expect(
      policy.canEmergencyStopDevice({
        actor_user_id: "device-owner",
        device_id: "device-1",
      }),
    ).resolves.toMatchObject({ action: "canEmergencyStopDevice", allowed: true });

    for (const actor_user_id of ["project-owner", "project-member", "admin-only"]) {
      await expect(
        policy.canViewOwnedDevice({ actor_user_id, device_id: "device-1" }),
      ).resolves.toMatchObject({
        action: "canViewOwnedDevice",
        allowed: false,
        reason_code: "authorization_denied",
      });
      await expect(
        policy.canManageDevice({ actor_user_id, device_id: "device-1" }),
      ).resolves.toMatchObject({ action: "canManageDevice", allowed: false });
      await expect(
        policy.canEmergencyStopDevice({ actor_user_id, device_id: "device-1" }),
      ).resolves.toMatchObject({ action: "canEmergencyStopDevice", allowed: false });
    }
  });

  it("requires both active device ownership and active target-project access to grant", async () => {
    await expect(
      policy.canGrantRepository({
        actor_user_id: "device-owner",
        project_id: "project-device-owner",
        repository_registration_id: "registration-1",
      }),
    ).resolves.toMatchObject({ action: "canGrantRepository", allowed: true });

    for (const actor_user_id of ["project-owner", "project-member", "admin-only"]) {
      await expect(
        policy.canGrantRepository({
          actor_user_id,
          project_id: "project-1",
          repository_registration_id: "registration-1",
        }),
      ).resolves.toMatchObject({ action: "canGrantRepository", allowed: false });
    }

    await expect(
      policy.canGrantRepository({
        actor_user_id: "device-owner",
        project_id: "project-1",
        repository_registration_id: "registration-1",
      }),
    ).resolves.toMatchObject({
      action: "canGrantRepository",
      allowed: false,
      reason_code: "authorization_denied",
    });
  });

  it("lets only the project owner accept an immutable active grant-backed binding", async () => {
    await expect(
      policy.canAcceptProjectTarget({
        actor_user_id: "project-owner",
        project_id: "project-1",
        execution_target_id: "grant-1",
      }),
    ).resolves.toMatchObject({ action: "canAcceptProjectTarget", allowed: true });

    for (const actor_user_id of ["device-owner", "project-member", "admin-only"]) {
      await expect(
        policy.canAcceptProjectTarget({
          actor_user_id,
          project_id: "project-1",
          execution_target_id: "grant-1",
        }),
      ).resolves.toMatchObject({ action: "canAcceptProjectTarget", allowed: false });
    }
    for (const execution_target_id of ["binding-1", "binding-mismatch", "grant-revoked"]) {
      await expect(
        policy.canAcceptProjectTarget({
          actor_user_id: "project-owner",
          project_id: "project-1",
          execution_target_id,
        }),
      ).resolves.toMatchObject({ action: "canAcceptProjectTarget", allowed: false });
    }
  });

  it("requires active project access and the exact active repository chain to dispatch", async () => {
    for (const actor_user_id of ["project-owner", "project-member"]) {
      await expect(
        policy.canDispatch({
          actor_user_id,
          project_id: "project-1",
          execution_target_id: "binding-1",
          run_id: "run-1",
        }),
      ).resolves.toMatchObject({ action: "canDispatch", allowed: true });
    }

    for (const actor_user_id of ["device-owner", "outsider", "admin-only"]) {
      await expect(
        policy.canDispatch({
          actor_user_id,
          project_id: "project-1",
          execution_target_id: "binding-1",
          run_id: "run-1",
        }),
      ).resolves.toMatchObject({
        action: "canDispatch",
        allowed: false,
        reason_code: "authorization_denied",
      });
    }

    for (const [execution_target_id, run_id] of [
      ["binding-mismatch", "run-mismatch"],
      ["binding-revoked-grant", "run-revoked-grant"],
    ] as const) {
      await expect(
        policy.canDispatch({
          actor_user_id: "project-owner",
          project_id: "project-1",
          execution_target_id,
          run_id,
        }),
      ).resolves.toMatchObject({ action: "canDispatch", allowed: false });
    }
  });

  it("requires the latest command device generation and the original actor's current access", async () => {
    for (const run_id of ["run-original-unauthorized", "run-rebound", "run-stale-generation"]) {
      await expect(
        policy.canDispatch({
          actor_user_id: "project-owner",
          project_id: "project-1",
          execution_target_id: "binding-1",
          run_id,
        }),
      ).resolves.toMatchObject({
        action: "canDispatch",
        allowed: false,
        reason_code: "authorization_denied",
      });
    }
  });

  it("authorizes project stop only for the project owner on a live run", async () => {
    await expect(
      policy.canStopProjectRun({
        actor_user_id: "project-owner",
        project_id: "project-1",
        run_id: "run-revoked-grant",
      }),
    ).resolves.toMatchObject({ action: "canStopProjectRun", allowed: true });

    for (const actor_user_id of ["project-member", "device-owner", "outsider", "admin-only"]) {
      await expect(
        policy.canStopProjectRun({
          actor_user_id,
          project_id: "project-1",
          run_id: "run-1",
        }),
      ).resolves.toMatchObject({ action: "canStopProjectRun", allowed: false });
    }
  });

  it("gives an administrator no implicit authority for any device action", async () => {
    const decisions = await Promise.all([
      policy.canViewOwnedDevice({
        actor_user_id: "admin-only",
        device_id: "device-1",
      }),
      policy.canManageDevice({
        actor_user_id: "admin-only",
        device_id: "device-1",
      }),
      policy.canGrantRepository({
        actor_user_id: "admin-only",
        project_id: "project-1",
        repository_registration_id: "registration-1",
      }),
      policy.canAcceptProjectTarget({
        actor_user_id: "admin-only",
        project_id: "project-1",
        execution_target_id: "grant-1",
      }),
      policy.canDispatch({
        actor_user_id: "admin-only",
        project_id: "project-1",
        execution_target_id: "binding-1",
        run_id: "run-1",
      }),
      policy.canStopProjectRun({
        actor_user_id: "admin-only",
        project_id: "project-1",
        run_id: "run-1",
      }),
      policy.canEmergencyStopDevice({
        actor_user_id: "admin-only",
        device_id: "device-1",
      }),
    ]);

    expect(decisions.map((decision) => decision.action)).toEqual([
      "canViewOwnedDevice",
      "canManageDevice",
      "canGrantRepository",
      "canAcceptProjectTarget",
      "canDispatch",
      "canStopProjectRun",
      "canEmergencyStopDevice",
    ]);
    expect(decisions.every((decision) => !decision.allowed)).toBe(true);
  });

  it("fails closed for missing identities and inconsistent scope", async () => {
    await expect(
      policy.canDispatch({
        actor_user_id: "",
        project_id: "project-1",
        execution_target_id: "binding-1",
        run_id: "run-1",
      }),
    ).resolves.toMatchObject({ action: "canDispatch", allowed: false });
    await expect(
      policy.canDispatch({
        actor_user_id: "project-owner",
        project_id: "project-2",
        execution_target_id: "binding-1",
        run_id: "run-1",
      }),
    ).resolves.toMatchObject({ action: "canDispatch", allowed: false });
    await expect(
      policy.canViewOwnedDevice({
        actor_user_id: "disabled-owner",
        device_id: "device-disabled-owner",
      }),
    ).resolves.toMatchObject({ action: "canViewOwnedDevice", allowed: false });
  });
});
