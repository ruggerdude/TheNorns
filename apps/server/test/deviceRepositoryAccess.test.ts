import { generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DevicePublicationPermitError,
  DevicePublicationPermitService,
  DeviceRepositoryAccessError,
  DeviceRepositoryAccessService,
  PostgresDeviceRepositoryAccessRepository,
} from "../src/devices/index.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

describe.sequential("Phase 4 device repository access", () => {
  let database: PGlite;
  let access: DeviceRepositoryAccessService;
  let permits: DevicePublicationPermitService;
  const connected = new Set(["device-1:credential-1:1"]);
  const now = new Date("2026-07-30T12:00:00.000Z");

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await runCurrentV2Migrations(database as unknown as V2MigrationDatabase);
    await database.exec(`
      INSERT INTO users (
        id,username,display_name,email,name,password_hash,
        password_hash_scheme,role,status
      ) VALUES
        ('device-owner','device-owner@example.test','Device Owner',
         'device-owner@example.test','Device Owner','hash','scrypt-v1','member','active'),
        ('project-owner','project-owner@example.test','Project Owner',
         'project-owner@example.test','Project Owner','hash','scrypt-v1','member','active'),
        ('project-member','project-member@example.test','Project Member',
         'project-member@example.test','Project Member','hash','scrypt-v1','member','active'),
        ('admin-only','admin@example.test','Admin Only',
         'admin@example.test','Admin Only','hash','scrypt-v1','admin','active');
      INSERT INTO projects (
        id,name,description,status,assignment_policy_ref,
        verification_policy_ref,budget_policy_ref,owner_user_id
      ) VALUES (
        'project-1','Project One','','active','assignment','verification','budget',
        'project-owner'
      );
      INSERT INTO project_members (project_id,user_id,status,added_by_user_id)
      VALUES
        ('project-1','device-owner','active','project-owner'),
        ('project-1','project-member','active','project-owner');
      INSERT INTO devices (
        id,owner_user_id,display_name,os_family,architecture,lifecycle,
        current_generation,agent_version,agent_protocol_version,
        agent_capabilities,last_seen_at
      ) VALUES (
        'device-1','device-owner','Office Mac','macos','arm64','active',0,
        '1.0.0','1','[]'::jsonb,now()
      );
      INSERT INTO device_credentials (
        id,device_id,generation,public_key_spki_der,public_key_fingerprint,state
      ) VALUES (
        'credential-1','device-1',1,'\\x01',repeat('a',64),'active'
      );
    `);
    const transactions = new PGliteTransactionRunner(database);
    access = new DeviceRepositoryAccessService(
      new PostgresDeviceRepositoryAccessRepository(transactions),
      { availability: (deviceId) => (deviceId === "device-1" ? "online" : "offline") },
      ["1"],
      () => now,
    );
    const { privateKey } = generateKeyPairSync("ed25519");
    permits = new DevicePublicationPermitService(
      transactions,
      {
        isConnectedIdentity: (identity) =>
          connected.has(`${identity.device_id}:${identity.credential_id}:${identity.generation}`),
      },
      { key_id: "publication-key-1", private_key: privateKey },
      () => now,
    );
  }, 30_000);

  afterAll(async () => {
    await database.close();
  });

  it("registers idempotently with current-key proof and preserves exact uniqueness", async () => {
    const first = await access.registerRepository({
      device_id: "device-1",
      credential_id: "credential-1",
      generation: 1,
      workspace_id: "workspace-1",
      repository_id: "repository-1",
      repository_display_name: "Norns",
      default_branch: "main",
      observed_head: "a".repeat(40),
    });
    const replay = await access.registerRepository({
      device_id: "device-1",
      credential_id: "credential-1",
      generation: 1,
      workspace_id: "workspace-1",
      repository_id: "repository-1",
      repository_display_name: "Norns renamed",
      default_branch: "main",
      observed_head: "b".repeat(40),
    });
    expect(replay.registration_id).toBe(first.registration_id);
    expect(replay.repository_display_name).toBe("Norns renamed");

    const constraint = await database.query<{ convalidated: boolean }>(
      `SELECT convalidated
         FROM pg_constraint
        WHERE conname='device_repository_registrations_credential_proof_state_check'`,
    );
    expect(constraint.rows[0]?.convalidated).toBe(true);
    await expect(
      database.query(
        `INSERT INTO device_repository_registrations (
           id,device_id,workspace_id,repository_id,repository_display_name,
           state,approved_by_user_id,approved_at,default_branch
         ) VALUES (
           'invalid-active','device-1','workspace-bad','repository-bad','Bad',
           'active','device-owner',now(),'main'
         )`,
      ),
    ).rejects.toThrow(/credential_proof_state_check/);

    await database.exec(`
      INSERT INTO device_repository_registrations (
        id,device_id,workspace_id,repository_id,repository_display_name,state,default_branch
      ) VALUES (
        'pending-registration','device-1','pending-workspace','pending-repository',
        'Pending repository','pending','main'
      );
      UPDATE device_repository_registrations
         SET state='active',
             approved_by_user_id='device-owner',
             approved_at=now(),
             approved_credential_id='credential-1',
             approved_generation=1
       WHERE id='pending-registration';
      INSERT INTO project_device_repository_grants (
        id,project_id,repository_registration_id,state,granted_by_user_id
      ) VALUES (
        'terminal-grant','project-1','pending-registration','active','device-owner'
      );
      UPDATE project_device_repository_grants
         SET state='revoked',
             revoked_by_user_id='device-owner',
             revoked_at=now()
       WHERE id='terminal-grant';
    `);
    await expect(
      database.query(
        `UPDATE project_device_repository_grants
            SET state='active',revoked_by_user_id=NULL,revoked_at=NULL
          WHERE id='terminal-grant'`,
      ),
    ).rejects.toThrow(/invalid project repository grant state transition|terminal/);
  });

  it("limits owner access, creates a grant idempotently, and hides pending targets from members", async () => {
    const owner = await access.getOwnedRepositoryAccess("device-owner", "device-1");
    expect(owner.registrations.length).toBeGreaterThanOrEqual(1);
    expect(owner.registrations[0]).not.toHaveProperty("workspace_id");
    await expect(access.getOwnedRepositoryAccess("admin-only", "device-1")).rejects.toMatchObject({
      code: "authorization_denied",
    });

    const registration = owner.registrations.find(
      (candidate) => candidate.repository_id === "repository-1",
    );
    if (!registration) throw new Error("expected repository registration");
    const grant = await access.grantRepository({
      actor_user_id: "device-owner",
      project_id: "project-1",
      repository_registration_id: registration.registration_id,
    });
    const replay = await access.grantRepository({
      actor_user_id: "device-owner",
      project_id: "project-1",
      repository_registration_id: registration.registration_id,
    });
    expect(replay.grant_id).toBe(grant.grant_id);

    const ownerTargets = await access.listProjectExecutionTargets("project-owner", "project-1");
    expect(ownerTargets.execution_targets).toHaveLength(1);
    expect(ownerTargets.execution_targets[0]?.status.access).toBe("pending");
    const memberTargets = await access.listProjectExecutionTargets("project-member", "project-1");
    expect(memberTargets.execution_targets).toEqual([]);
    await expect(
      access.listProjectExecutionTargets("admin-only", "project-1"),
    ).rejects.toMatchObject({ code: "project_not_found" });
  });

  it("allows only the project owner to select, uses grant IDs, and is idempotent before CAS", async () => {
    const ownerAccess = await access.getOwnedRepositoryAccess("device-owner", "device-1");
    const grant = ownerAccess.registrations[0]?.grants[0];
    if (!grant) throw new Error("expected repository grant");
    await expect(
      access.selectProjectExecutionTarget({
        actor_user_id: "project-member",
        project_id: "project-1",
        execution_target_id: grant.grant_id,
        expected_current_execution_target_id: null,
      }),
    ).rejects.toMatchObject({ code: "authorization_denied" });

    const selected = await access.selectProjectExecutionTarget({
      actor_user_id: "project-owner",
      project_id: "project-1",
      execution_target_id: grant.grant_id,
      expected_current_execution_target_id: null,
    });
    expect(selected.selected_execution_target_id).toBe(grant.grant_id);
    expect(selected.execution_targets[0]?.status.access).toBe("shared");
    const replay = await access.selectProjectExecutionTarget({
      actor_user_id: "project-owner",
      project_id: "project-1",
      execution_target_id: grant.grant_id,
      expected_current_execution_target_id: "stale-target",
    });
    expect(replay.selected_execution_target_id).toBe(grant.grant_id);

    const secondRegistration = await access.registerRepository({
      device_id: "device-1",
      credential_id: "credential-1",
      generation: 1,
      workspace_id: "workspace-2",
      repository_id: "repository-2",
      repository_display_name: "Secondary",
      default_branch: "main",
      observed_head: "e".repeat(40),
    });
    const secondGrant = await access.grantRepository({
      actor_user_id: "device-owner",
      project_id: "project-1",
      repository_registration_id: secondRegistration.registration_id,
    });
    await expect(
      access.selectProjectExecutionTarget({
        actor_user_id: "project-owner",
        project_id: "project-1",
        execution_target_id: secondGrant.grant_id,
        expected_current_execution_target_id: null,
      }),
    ).rejects.toMatchObject({ code: "execution_target_changed" });

    const beforeConflict = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM repository_bindings WHERE project_id='project-1'",
    );
    await database.exec(`
      CREATE FUNCTION norns_test_skip_target_compare_and_swap()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        RETURN NULL;
      END;
      $fn$;
      CREATE TRIGGER norns_test_skip_target_compare_and_swap
        BEFORE UPDATE OF primary_repository_binding_id ON projects
        FOR EACH ROW EXECUTE FUNCTION norns_test_skip_target_compare_and_swap();
    `);
    try {
      await expect(
        access.selectProjectExecutionTarget({
          actor_user_id: "project-owner",
          project_id: "project-1",
          execution_target_id: secondGrant.grant_id,
          expected_current_execution_target_id: grant.grant_id,
        }),
      ).rejects.toMatchObject({ code: "execution_target_changed" });
      const afterConflict = await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM repository_bindings WHERE project_id='project-1'",
      );
      expect(afterConflict.rows[0]?.count).toBe(beforeConflict.rows[0]?.count);
    } finally {
      await database.exec(`
        DROP TRIGGER norns_test_skip_target_compare_and_swap ON projects;
        DROP FUNCTION norns_test_skip_target_compare_and_swap();
      `);
    }

    const member = await access.listProjectExecutionTargets("project-member", "project-1");
    expect(member.execution_targets.map((target) => target.execution_target_id)).toEqual([
      grant.grant_id,
    ]);
  });

  it("issues and atomically consumes one exact short-lived permit and fails closed", async () => {
    const ownerAccess = await access.getOwnedRepositoryAccess("device-owner", "device-1");
    const registration = ownerAccess.registrations[0];
    const grant = registration?.grants[0];
    if (!registration || !grant) throw new Error("expected repository grant");
    const binding = await database.query<{ id: string }>(
      `UPDATE repository_bindings binding
          SET status='connected'
        FROM projects project
       WHERE binding.id=project.primary_repository_binding_id
         AND project.id='project-1'
       RETURNING binding.id`,
    );
    const bindingId = binding.rows[0]?.id;
    if (!bindingId) throw new Error("expected primary repository binding");
    await database.exec(`
      INSERT INTO phases (
        id,project_id,objective_summary,priority,status,approved_budget_usd,
        initiated_by_user_id
      ) VALUES (
        'phase-1','project-1','Publish',1,'approved',10,'project-member'
      );
      INSERT INTO strategy_versions (
        id,project_id,phase_id,version,status,objective,content,
        convergence,review_rounds,content_hash
      ) VALUES (
        'strategy-1','project-1','phase-1',1,'approved','Publish','{}'::jsonb,
        'converged',1,repeat('c',64)
      );
      UPDATE phases SET approved_strategy_version_id='strategy-1' WHERE id='phase-1';
      INSERT INTO objectives (
        id,project_id,phase_id,outcome,success_measures,status,"order"
      ) VALUES (
        'objective-1','project-1','phase-1','Published','[]'::jsonb,'active',0
      );
      INSERT INTO tasks (
        id,project_id,phase_id,objective_id,strategy_version_id,title,description,
        deliverables,acceptance_criteria,complexity,risk,required_roles,
        required_capabilities,required_inputs,expected_outputs,
        environment_policy_ref,verification_policy_ref,state,lifecycle_version,
        initiated_by_user_id
      ) VALUES (
        'task-1','project-1','phase-1','objective-1','strategy-1','Publish','Publish',
        '[]'::jsonb,'[]'::jsonb,'S','low','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
        '[]'::jsonb,'environment','verification','in_progress',1,'project-member'
      );
      INSERT INTO agent_profiles (
        id,provider,runtime,model,reasoning_effort,roles,capabilities,
        context_limit_tokens,security_restrictions,status,active_workload,cost_metadata
      ) VALUES (
        'agent-1','openai','codex','gpt-5-codex','high','[]'::jsonb,'[]'::jsonb,
        100000,'[]'::jsonb,'busy',1,'{}'::jsonb
      );
      INSERT INTO agent_assignments (
        id,project_id,phase_id,task_id,agent_profile_id,status,rationale,
        rationale_factors,budget_limit_usd,allocation_policy_ref
      ) VALUES (
        'assignment-1','project-1','phase-1','task-1','agent-1','active','test',
        '[]'::jsonb,10,'allocation'
      );
      INSERT INTO agent_runs (
        id,project_id,phase_id,task_id,assignment_id,attempt,state,is_designated,
        repository_binding_id,expected_revision,lifecycle_version,initiated_by_user_id
      ) VALUES (
        'run-1','project-1','phase-1','task-1','assignment-1',1,'running',true,
        '${bindingId}','expected',1,'project-member'
      );
      INSERT INTO commands (
        command_id,dispatch_job_id,project_id,phase_id,task_id,run_id,runner_id,
        runner_generation,kind,envelope,status,correlation_id
      ) VALUES (
        'command-1','dispatch-1','project-1','phase-1','task-1','run-1','device-1',
        1,'launch_run','{"target_branch":"norns/task-1"}'::jsonb,'delivered','correlation-1'
      );
    `);
    const refreshedAccess = await access.getOwnedRepositoryAccess("device-owner", "device-1");
    const secondaryGrant = refreshedAccess.registrations
      .find((candidate) => candidate.repository_id === "repository-2")
      ?.grants.find((candidate) => candidate.state === "active");
    if (!secondaryGrant) throw new Error("expected secondary repository grant");
    await expect(
      access.selectProjectExecutionTarget({
        actor_user_id: "project-owner",
        project_id: "project-1",
        execution_target_id: secondaryGrant.grant_id,
        expected_current_execution_target_id: grant.grant_id,
      }),
    ).rejects.toMatchObject({ code: "project_work_active" });

    const request = {
      run_id: "run-1",
      repository_registration_id: registration.registration_id,
      project_device_repository_grant_id: grant.grant_id,
      repository_binding_id: bindingId,
      repository_id: registration.repository_id,
      branch: "norns/task-1",
      commit_sha: "d".repeat(40),
    };
    const identity = {
      device_id: "device-1",
      credential_id: "credential-1",
      generation: 1,
    };
    await expect(permits.issue(identity, { ...request, branch: "wrong" })).rejects.toMatchObject({
      code: "publication_not_authorized",
    });
    const signed = await permits.issue(identity, request);
    expect(Date.parse(signed.permit.expires_at) - Date.parse(signed.permit.issued_at)).toBe(30_000);
    const consumed = await permits.consume(identity, signed);
    expect(consumed.outcome).toBe("authorized");
    await expect(permits.consume(identity, signed)).rejects.toMatchObject({
      code: "permit_consumed",
    });

    connected.clear();
    await expect(permits.issue(identity, request)).rejects.toMatchObject({
      code: "device_offline",
    });
    connected.add("device-1:credential-1:1");
    await database.query("UPDATE agent_runs SET state='succeeded' WHERE id='run-1'");
    await expect(permits.issue(identity, request)).rejects.toMatchObject({
      code: "publication_not_authorized",
    });
  });
});
