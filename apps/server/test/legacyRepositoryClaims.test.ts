import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PostgresDeviceActionAuthorization } from "../src/devices/actionAuthorization.js";
import { LegacyRepositoryClaimService } from "../src/devices/legacyRepositoryClaims.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

describe.sequential("exact-project legacy repository claims", () => {
  let database: PGlite;
  let service: LegacyRepositoryClaimService;

  beforeEach(async () => {
    database = new PGlite();
    await database.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(database as unknown as V2MigrationDatabase);
    await database.exec(`
      INSERT INTO users (
        id,username,display_name,email,name,password_hash,password_hash_scheme,role,status
      ) VALUES
        ('owner-1','owner@example.test','Owner','owner@example.test','Owner',
         'hash','scrypt-v1','member','active'),
        ('member-1','member@example.test','Member','member@example.test','Member',
         'hash','scrypt-v1','member','active'),
        ('admin-1','admin@example.test','Admin','admin@example.test','Admin',
         'hash','scrypt-v1','admin','active');

      INSERT INTO projects (
        id,name,description,status,assignment_policy_ref,verification_policy_ref,
        budget_policy_ref,owner_user_id
      ) VALUES
        ('project-1','Project One','','active','assignment','verification','budget','owner-1'),
        ('project-2','Project Two','','active','assignment','verification','budget','owner-1');

      INSERT INTO project_members (project_id,user_id,status,added_by_user_id)
      VALUES
        ('project-1','owner-1','active','owner-1'),
        ('project-1','member-1','active','owner-1'),
        ('project-2','owner-1','active','owner-1');

      INSERT INTO repository_bindings (
        id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
        repository_display_name,granted_permissions,default_branch,observed_head,
        verification_policy_ref,repository_health,created_by_actor_type,
        created_by_actor_id,role
      ) VALUES
        ('legacy-1','project-1','local_runner','connected','runner-1','workspace-1',
         'repository-1','Project One','{}'::jsonb,'main','commit-1','verification',
         'healthy','human','owner-1','workspace'),
        ('legacy-2','project-2','local_runner','connected','runner-1','workspace-2',
         'repository-2','Project Two','{}'::jsonb,'main','commit-2','verification',
         'healthy','human','owner-1','workspace');
      UPDATE projects SET primary_repository_binding_id='legacy-1' WHERE id='project-1';
      UPDATE projects SET primary_repository_binding_id='legacy-2' WHERE id='project-2';

      INSERT INTO phases (id,project_id,objective_summary,status)
      VALUES ('phase-1','project-1','Claim safety','approved');
      INSERT INTO strategy_versions (
        id,project_id,phase_id,version,status,objective,content,convergence,content_hash
      ) VALUES (
        'strategy-1','project-1','phase-1',1,'approved','Claim safety',
        '{}'::jsonb,'converged',repeat('b',64)
      );
      INSERT INTO objectives (
        id,project_id,phase_id,outcome,success_measures,status
      ) VALUES (
        'objective-1','project-1','phase-1','Claim safely','["safe"]'::jsonb,'active'
      );
      INSERT INTO tasks (
        id,project_id,phase_id,objective_id,strategy_version_id,title,description,
        deliverables,acceptance_criteria,complexity,risk,required_roles,
        expected_outputs,environment_policy_ref,verification_policy_ref,state
      ) VALUES (
        'task-1','project-1','phase-1','objective-1','strategy-1','Claim safety',
        'Exercise live work exclusion','["test"]'::jsonb,'["safe"]'::jsonb,
        'S','low','["backend"]'::jsonb,'["test"]'::jsonb,
        'environment/default','verification/default','pending'
      );
      INSERT INTO agent_profiles (
        id,provider,runtime,model,roles,context_limit_tokens,status,cost_metadata
      ) VALUES (
        'agent-1','openai','codex','codex','["backend"]'::jsonb,128000,
        'available','{}'::jsonb
      );
      INSERT INTO agent_assignments (
        id,project_id,phase_id,task_id,agent_profile_id,status,rationale,
        rationale_factors,allocation_policy_ref
      ) VALUES (
        'assignment-1','project-1','phase-1','task-1','agent-1','active',
        'Claim safety test','["capability"]'::jsonb,'assignment/default'
      );

      INSERT INTO devices (
        id,owner_user_id,display_name,location_label,os_family,architecture,
        lifecycle,current_generation
      ) VALUES (
        'device-1','owner-1','Office Mac mini','Office','macos','arm64','active',0
      );
      INSERT INTO device_credentials (
        id,device_id,generation,public_key_spki_der,public_key_fingerprint,state
      ) VALUES (
        'credential-1','device-1',1,'\\x01',repeat('a',64),'active'
      );
      INSERT INTO device_repository_registrations (
        id,device_id,workspace_id,repository_id,repository_display_name,state,
        approved_by_user_id,approved_at,default_branch,observed_head,
        approved_credential_id,approved_generation
      ) VALUES (
        'registration-1','device-1','workspace-new','repository-new','Project One',
        'active','owner-1',now(),'main','commit-new','credential-1',1
      );
      INSERT INTO project_device_repository_grants (
        id,project_id,repository_registration_id,state,granted_by_user_id
      ) VALUES (
        'grant-1','project-1','registration-1','active','owner-1'
      );
    `);
    service = new LegacyRepositoryClaimService(new PGliteTransactionRunner(database));
  });

  afterEach(async () => {
    await database.close();
  });

  it("marks only the exact project and discovers the same open claim across request keys", async () => {
    expect(
      (
        await database.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM legacy_repository_binding_claims",
        )
      ).rows[0]?.count,
    ).toBe(0);
    const started = await service.begin({
      actor_user_id: "owner-1",
      project_id: "project-1",
      expected_project_version: 1,
      idempotency_key: "begin-1",
      now: "2026-07-30T12:00:00.000Z",
    });
    expect(started).toMatchObject({
      project_id: "project-1",
      state: "claim_required",
      repository_display_name: "Project One",
      candidate_targets: [
        {
          execution_target_id: "grant-1",
          repository_display_name: "Project One",
        },
      ],
    });

    const replayed = await service.begin({
      actor_user_id: "owner-1",
      project_id: "project-1",
      expected_project_version: 1,
      idempotency_key: "fresh-browser-key",
      now: "2026-07-30T12:01:00.000Z",
    });
    expect(replayed.claim_id).toBe(started.claim_id);
    await expect(service.getCurrent("owner-1", "project-1")).resolves.toMatchObject({
      claim_id: started.claim_id,
    });
    await expect(service.getCurrent("member-1", "project-1")).resolves.toBeNull();
    await expect(service.getCurrent("admin-1", "project-1")).resolves.toBeNull();

    const bindings = await database.query<{ id: string; status: string }>(
      "SELECT id,status FROM repository_bindings ORDER BY id",
    );
    expect(bindings.rows).toEqual([
      { id: "legacy-1", status: "legacy_claim_required" },
      { id: "legacy-2", status: "connected" },
    ]);
  });

  it("rejects beginning a claim while project work is active after acquiring the scope locks", async () => {
    await database.exec(`
      INSERT INTO agent_runs (
        id,project_id,phase_id,task_id,assignment_id,attempt,state,
        repository_binding_id,expected_revision,initiated_by_user_id,lifecycle_version
      ) VALUES (
        'run-live','project-1','phase-1','task-1','assignment-1',1,'running',
        'legacy-1','commit-1','owner-1',1
      )
    `);

    await expect(
      service.begin({
        actor_user_id: "owner-1",
        project_id: "project-1",
        expected_project_version: 1,
        idempotency_key: "begin-live-work",
        now: "2026-07-30T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "project_work_active",
    });
  });

  it("enforces the no-live-work open-claim invariant at deferred constraint time", async () => {
    await expect(
      database.exec(`
        BEGIN;
        INSERT INTO agent_runs (
          id,project_id,phase_id,task_id,assignment_id,attempt,state,
          repository_binding_id,expected_revision,initiated_by_user_id,lifecycle_version
        ) VALUES (
          'run-live','project-1','phase-1','task-1','assignment-1',1,'running',
          'legacy-1','commit-1','owner-1',1
        );
        UPDATE repository_bindings
           SET status='legacy_claim_required'
         WHERE id='legacy-1';
        INSERT INTO legacy_repository_binding_claims (
          id,project_id,legacy_binding_id,state,preclaim_status,
          created_by_user_id,begin_idempotency_key
        ) VALUES (
          'claim-invalid','project-1','legacy-1','claim_required','connected',
          'owner-1','begin-invalid'
        );
        COMMIT;
      `),
    ).rejects.toThrow(/forbidden while project work is active/);
  });

  it("atomically switches the project to the confirmed grant and retires only its old binding", async () => {
    const started = await service.begin({
      actor_user_id: "owner-1",
      project_id: "project-1",
      expected_project_version: 1,
      idempotency_key: "begin-finalize",
      now: "2026-07-30T12:00:00.000Z",
    });
    const finalized = await service.finalize({
      actor_user_id: "owner-1",
      project_id: "project-1",
      claim_id: started.claim_id,
      execution_target_id: "grant-1",
      expected_claim_version: started.claim_version,
      expected_project_version: started.project_version,
      idempotency_key: "finalize-1",
      now: "2026-07-30T12:05:00.000Z",
    });
    expect(finalized).toMatchObject({
      state: "finalized",
      finalized_execution_target_id: "grant-1",
    });

    const rows = await database.query<{
      primary_repository_binding_id: string;
      old_status: string;
      replacement_runner_id: string | null;
      replacement_grant_id: string | null;
      other_status: string;
    }>(
      `SELECT
         project.primary_repository_binding_id,
         old_binding.status AS old_status,
         replacement.runner_id AS replacement_runner_id,
         replacement.project_device_repository_grant_id AS replacement_grant_id,
         other_binding.status AS other_status
       FROM projects project
       JOIN repository_bindings old_binding ON old_binding.id='legacy-1'
       JOIN repository_bindings replacement
         ON replacement.id=project.primary_repository_binding_id
       JOIN repository_bindings other_binding ON other_binding.id='legacy-2'
      WHERE project.id='project-1'`,
    );
    expect(rows.rows[0]).toMatchObject({
      old_status: "revoked",
      replacement_runner_id: null,
      replacement_grant_id: "grant-1",
      other_status: "connected",
    });
    expect(rows.rows[0]?.primary_repository_binding_id).not.toBe("legacy-1");
    const replacementBindingId = rows.rows[0]?.primary_repository_binding_id;
    const authorization = new PostgresDeviceActionAuthorization({
      deviceDispatchEnabled: true,
    });
    await expect(
      new PGliteTransactionRunner(database).transaction(async (sql) => {
        const identity = await authorization.resolveDispatchTargetIdentity(sql, {
          runner_id: "device-1",
          generation: 1,
        });
        return authorization.assertDispatchBinding(sql, {
          ...identity,
          actor_user_id: "owner-1",
          project_id: "project-1",
          repository_binding_id: replacementBindingId ?? "",
        });
      }),
    ).resolves.toBe("device");
    expect(
      (
        await database.query<{ count: bigint }>(
          `SELECT count(*)::bigint AS count
             FROM audit_events
            WHERE project_id='project-1'
              AND audit_type LIKE 'device.legacy_repository_claim_%'`,
        )
      ).rows[0]?.count,
    ).toBe(2);
  });
});
