import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type PGliteDatabaseLike,
  PGliteTransactionRunner,
} from "../src/persistence/v2/database.js";
import { PostgresLegacyRunnerAuthorization } from "../src/runners/legacyAuthorization.js";

describe.sequential("legacy runner project attribution", () => {
  let database: PGlite;
  let authorization: PostgresLegacyRunnerAuthorization;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        role TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        owner_user_id TEXT REFERENCES users(id)
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
        runner_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        runner_id TEXT
      );
      CREATE TABLE commands (
        command_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        run_id TEXT NOT NULL REFERENCES agent_runs(id),
        runner_id TEXT NOT NULL
      );

      INSERT INTO users (id, status, role) VALUES
        ('owner-1', 'active', 'member'),
        ('member-1', 'active', 'member'),
        ('owner-2', 'active', 'member'),
        ('admin-only', 'active', 'admin'),
        ('removed-member', 'active', 'member'),
        ('disabled-member', 'disabled', 'member');
      INSERT INTO projects (id, status, owner_user_id) VALUES
        ('project-1', 'active', 'owner-1'),
        ('project-2', 'active', 'owner-2'),
        ('project-paused', 'paused', 'owner-1');
      INSERT INTO project_members (project_id, user_id, status) VALUES
        ('project-1', 'member-1', 'active'),
        ('project-1', 'removed-member', 'removed'),
        ('project-1', 'disabled-member', 'active');
      INSERT INTO repository_bindings (
        id, project_id, binding_type, runner_id, status
      ) VALUES
        ('binding-1', 'project-1', 'local_runner', 'runner-1', 'connected'),
        ('binding-2', 'project-2', 'local_runner', 'runner-2', 'connected'),
        ('binding-disconnected', 'project-1', 'local_runner', 'runner-disconnected', 'disconnected'),
        (
          'binding-unverified', 'project-1', 'local_runner',
          'runner-unverified', 'unverified_candidate'
        ),
        ('binding-paused', 'project-paused', 'local_runner', 'runner-paused', 'connected'),
        ('binding-revoked', 'project-1', 'local_runner', 'runner-revoked', 'revoked'),
        ('github-binding', 'project-1', 'github', 'runner-github', 'connected');
      INSERT INTO agent_runs (id, project_id, runner_id) VALUES
        ('run-1', 'project-1', 'runner-1'),
        ('run-2', 'project-2', 'runner-2'),
        ('run-command-attributed', 'project-1', NULL),
        ('run-actions-safe', 'project-1', 'actions-safe'),
        ('run-shared-1', 'project-1', 'reused-runner'),
        ('run-shared-2', 'project-2', 'reused-runner');
      INSERT INTO commands (command_id, project_id, run_id, runner_id) VALUES
        ('command-1', 'project-1', 'run-1', 'runner-1'),
        ('command-2', 'project-2', 'run-2', 'runner-2'),
        (
          'command-run-attribution', 'project-1',
          'run-command-attributed', 'runner-command'
        ),
        ('command-actions-safe', 'project-1', 'run-actions-safe', 'actions-safe'),
        ('command-shared-1', 'project-1', 'run-shared-1', 'reused-runner'),
        ('command-shared-2', 'project-2', 'run-shared-2', 'reused-runner');
    `);
    authorization = new PostgresLegacyRunnerAuthorization(
      new PGliteTransactionRunner(database as unknown as PGliteDatabaseLike),
    );
  });

  afterAll(async () => {
    await database.close();
  });

  it("allows only explicit project owners and active members to use an attributed runner", async () => {
    for (const user_id of ["owner-1", "member-1"]) {
      await expect(
        authorization.canAccessProjectRunner({
          user_id,
          project_id: "project-1",
          runner_id: "runner-1",
        }),
      ).resolves.toBe(true);
    }
    for (const user_id of ["owner-2", "admin-only", "removed-member", "disabled-member"]) {
      await expect(
        authorization.canAccessProjectRunner({
          user_id,
          project_id: "project-1",
          runner_id: "runner-1",
        }),
      ).resolves.toBe(false);
    }
    await expect(
      authorization.canAccessProjectRunner({
        user_id: "owner-1",
        project_id: "project-1",
        runner_id: "runner-revoked",
      }),
    ).resolves.toBe(false);
    for (const [project_id, runner_id] of [
      ["project-1", "runner-disconnected"],
      ["project-1", "runner-unverified"],
      ["project-paused", "runner-paused"],
    ] as const) {
      await expect(
        authorization.canAccessProjectRunner({
          user_id: "owner-1",
          project_id,
          runner_id,
        }),
      ).resolves.toBe(false);
    }
  });

  it("requires exact run and command attribution", async () => {
    await expect(
      authorization.canAccessRun({
        user_id: "member-1",
        run_id: "run-1",
        runner_id: "runner-1",
      }),
    ).resolves.toBe(true);
    await expect(
      authorization.canAccessRun({
        user_id: "member-1",
        run_id: "run-1",
        runner_id: "runner-2",
      }),
    ).resolves.toBe(false);
    await expect(
      authorization.canAccessRun({
        user_id: "member-1",
        run_id: "run-command-attributed",
        runner_id: "runner-command",
      }),
    ).resolves.toBe(true);
    await expect(
      authorization.canAccessCommand({
        user_id: "member-1",
        command_id: "command-1",
        runner_id: "runner-1",
      }),
    ).resolves.toBe(true);
    await expect(
      authorization.canAccessCommand({
        user_id: "admin-only",
        command_id: "command-1",
      }),
    ).resolves.toBe(false);
  });

  it("enumerates only runners attributed to accessible projects", async () => {
    await expect(authorization.runnerIdsForUser("member-1")).resolves.toEqual(
      new Set(["actions-safe", "reused-runner", "runner-1", "runner-command"]),
    );
    await expect(authorization.runnerIdsForUser("owner-2")).resolves.toEqual(
      new Set(["reused-runner", "runner-2"]),
    );
    await expect(authorization.runnerIdsForUser("admin-only")).resolves.toEqual(new Set());
  });

  it("allows runner-wide revoke only for an exclusively accessible ephemeral identity", async () => {
    await expect(
      authorization.canRevokeRunner({ user_id: "owner-1", runner_id: "actions-safe" }),
    ).resolves.toBe(true);
    await expect(
      authorization.canRevokeRunner({ user_id: "member-1", runner_id: "actions-safe" }),
    ).resolves.toBe(true);
    await expect(
      authorization.canRevokeRunner({ user_id: "admin-only", runner_id: "actions-safe" }),
    ).resolves.toBe(false);
    await expect(
      authorization.canRevokeRunner({ user_id: "owner-1", runner_id: "runner-1" }),
    ).resolves.toBe(false);
    await expect(
      authorization.canRevokeRunner({ user_id: "owner-1", runner_id: "reused-runner" }),
    ).resolves.toBe(false);
    await expect(
      authorization.canRevokeRunner({ user_id: "owner-2", runner_id: "reused-runner" }),
    ).resolves.toBe(false);
  });
});
