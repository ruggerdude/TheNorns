import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import {
  SourceBindingProjectNotFoundError,
  SourceBindingService,
} from "../src/projects/sourceBindingService.js";

describe.sequential("Phase 3 source binding", () => {
  let pg: PGlite;
  let service: SourceBindingService;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.query(
      `INSERT INTO projects (
         id, name, description, status, assignment_policy_ref,
         verification_policy_ref, budget_policy_ref
       ) VALUES ('project-1','Project One','','active','assignment-default',
                 'verification-default','budget-default')`,
    );
    service = new SourceBindingService(new PGliteTransactionRunner(pg));
  });

  afterEach(async () => {
    await pg.close();
  });

  it("creates and replay-deduplicates an opaque local-runner binding", async () => {
    const command = {
      project_id: "project-1",
      runner_id: "runner-1",
      workspace_id: "workspace-approved-7",
      repository_id: "repository-opaque-9",
      repository_display_name: "The Norns",
      default_branch: "main",
      observed_head: "abc123",
      verification_policy_ref: "verification-default",
      created_by: { actor_type: "human" as const, actor_id: "admin-1" },
    };

    const first = await service.createLocal(command);
    const replay = await service.createLocal(command);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      binding_type: "local_runner",
      status: "connected",
      repository_health: "healthy",
      workspace_id: "workspace-approved-7",
      repository_id: "repository-opaque-9",
    });
    expect(JSON.stringify(first)).not.toContain("/Users/");
    await expect(service.repositoryGraphTarget("project-1")).resolves.toEqual({
      runner_id: "runner-1",
      repository_id: "repository-opaque-9",
    });

    const counts = await pg.query<{
      bindings: number;
      audits: number;
      primary_id: string;
      audit_actor_id: string;
    }>(
      `SELECT (SELECT count(*)::int FROM repository_bindings) AS bindings,
              (SELECT count(*)::int FROM audit_events
               WHERE audit_type='repository_binding.connected') AS audits,
              (SELECT actor_id FROM audit_events
               WHERE audit_type='repository_binding.connected') AS audit_actor_id,
              primary_repository_binding_id AS primary_id
       FROM projects WHERE id = 'project-1'`,
    );
    expect(counts.rows[0]).toEqual({
      bindings: 1,
      audits: 1,
      audit_actor_id: "admin-1",
      primary_id: first.id,
    });
  });

  it("creates a GitHub identity without accepting or persisting credentials", async () => {
    const binding = await service.createGitHub({
      project_id: "project-1",
      runner_id: "runner-1",
      github_installation_id: "installation-42",
      github_repository_id: "repo-314159",
      owner: "ruggerdude",
      name: "TheNorns",
      default_branch: "main",
      observed_head: "def456",
      verification_policy_ref: "verification-default",
      granted_permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        checks: "read",
        actions: "read",
      },
      created_by: { actor_type: "human", actor_id: "admin-1" },
    });

    expect(binding).toMatchObject({
      binding_type: "github",
      github_installation_id: "installation-42",
      github_repository_id: "repo-314159",
      owner: "ruggerdude",
      name: "TheNorns",
    });
    const stored = await pg.query<Record<string, unknown>>(
      "SELECT * FROM repository_bindings WHERE id = $1",
      [binding.id],
    );
    expect(JSON.stringify(stored.rows[0])).not.toMatch(/token|private.?key/i);
  });

  it("resolves a device-backed working copy without requiring a connected legacy binding", async () => {
    await pg.exec(`
      INSERT INTO users (
        id,username,display_name,email,name,password_hash,
        password_hash_scheme,role,status
      ) VALUES (
        'device-owner','device-owner@example.test','Device Owner',
        'device-owner@example.test','Device Owner','hash','scrypt-v1','member','active'
      );
      UPDATE projects SET owner_user_id='device-owner' WHERE id='project-1';

      INSERT INTO devices (
        id,owner_user_id,display_name,os_family,architecture,lifecycle,current_generation
      ) VALUES (
        'device-graph','device-owner','Graph computer','macos','arm64','active',0
      );
      INSERT INTO device_credentials (
        id,device_id,generation,public_key_spki_der,public_key_fingerprint,state
      ) VALUES (
        'credential-graph','device-graph',1,'\\x01',repeat('a',64),'active'
      );
      INSERT INTO device_repository_registrations (
        id,device_id,workspace_id,repository_id,repository_display_name,state,
        approved_by_user_id,approved_at,default_branch,
        approved_credential_id,approved_generation
      ) VALUES (
        'registration-graph','device-graph','workspace-graph','repository-graph',
        'StrumSheetX1','active','device-owner',now(),'main','credential-graph',1
      );
      INSERT INTO project_device_repository_grants (
        id,project_id,repository_registration_id,state,granted_by_user_id,granted_at
      ) VALUES (
        'grant-graph','project-1','registration-graph','active','device-owner',now()
      );
    `);
    const remote = await service.createGitHub({
      project_id: "project-1",
      runner_id: "github-actions-project-1",
      github_installation_id: "installation-graph",
      github_repository_id: "9001",
      owner: "ruggerdude",
      name: "strumsheetx1",
      default_branch: "main",
      observed_head: "def456",
      verification_policy_ref: "verification-default",
      granted_permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        checks: "read",
        actions: "read",
      },
      created_by: { actor_type: "human", actor_id: "device-owner" },
    });
    await pg.query(
      `INSERT INTO repository_bindings (
         id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
         repository_display_name,default_branch,verification_policy_ref,
         project_device_repository_grant_id,role,created_by_actor_type,
         created_by_actor_id
       ) VALUES (
         'binding-graph','project-1','local_runner','disconnected',NULL,
         'workspace-graph','repository-graph','StrumSheetX1','main',
         'verification-default','grant-graph','workspace','human','device-owner'
       )`,
    );

    const target = await service.repositoryGraphTarget("project-1");
    expect(target).toEqual({
      runner_id: "device-graph",
      repository_id: "repository-graph",
    });
    expect(target?.runner_id).not.toBe(remote.runner_id);
    expect(JSON.stringify(target)).not.toMatch(/workspace|strumsheet|github/i);
  });

  it("rejects unknown projects and database-level identity rewrites", async () => {
    await expect(
      service.createLocal({
        project_id: "missing",
        runner_id: "runner-1",
        workspace_id: "workspace-1",
        repository_id: "repository-1",
        repository_display_name: "Missing",
        default_branch: "main",
        observed_head: "abc123",
        verification_policy_ref: "verification-default",
        created_by: { actor_type: "human", actor_id: "admin-1" },
      }),
    ).rejects.toBeInstanceOf(SourceBindingProjectNotFoundError);

    const binding = await service.createLocal({
      project_id: "project-1",
      runner_id: "runner-1",
      workspace_id: "workspace-1",
      repository_id: "repository-1",
      repository_display_name: "One",
      default_branch: "main",
      observed_head: "abc123",
      verification_policy_ref: "verification-default",
      created_by: { actor_type: "human", actor_id: "admin-1" },
    });
    await expect(
      pg.query("UPDATE repository_bindings SET repository_id = 'other' WHERE id = $1", [
        binding.id,
      ]),
    ).rejects.toThrow(/identity and provenance are immutable/);
  });
});
