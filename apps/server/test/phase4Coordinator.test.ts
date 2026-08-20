import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchContextScopeRepository } from "../src/coordinator/dispatchContextScope.js";
import { Phase4CompletionService } from "../src/coordinator/phase4Completion.js";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { Phase4DispatchRepository, Phase4Dispatcher } from "../src/coordinator/phase4Dispatcher.js";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import { Phase4RecoveryActionService } from "../src/coordinator/phase4RecoveryActions.js";
import { Phase4RecoveryMonitor } from "../src/coordinator/phase4RecoveryMonitor.js";
import { PhaseLaunchService } from "../src/coordinator/phaseLaunchService.js";
import { PostgresDeviceActionAuthorization } from "../src/devices/actionAuthorization.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

describe.sequential("Phase 4 durable coordinator scheduling", () => {
  let pg: PGlite;
  let coordinator: Phase4Coordinator;

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
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES (
        'admin-1','admin@example.test','Admin','admin@example.test','Admin',
        'hash','scrypt-v1','admin','active'
      );
      INSERT INTO projects (
        id, name, description, status, assignment_policy_ref,
        verification_policy_ref, budget_policy_ref
      ) VALUES ('project-1','Project One','','active','assignment','verification','budget');
      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, granted_permissions,
        default_branch, observed_head, verification_policy_ref,
        repository_health, created_by_actor_type, created_by_actor_id
      ) VALUES ('binding-1','project-1','local_runner','connected','runner-1',
        'workspace-1','repository-1','Project One','{}'::jsonb,'main','commit-1',
        'verification','healthy','human','admin-1');
      UPDATE projects SET primary_repository_binding_id = 'binding-1' WHERE id = 'project-1';
      INSERT INTO phases (
        id, project_id, objective_summary, priority, status, approved_budget_usd,
        initiated_by_user_id
      ) VALUES (
        'phase-1','project-1','Implement vertical slice',1,'awaiting_approval',20,'admin-1'
      );
      INSERT INTO strategy_versions (
        id, project_id, phase_id, version, status, objective, content,
        convergence, review_rounds, content_hash
      ) VALUES ('strategy-1','project-1','phase-1',1,'approved','Vertical slice',
        '{}'::jsonb,'converged',1,repeat('a',64));
      UPDATE phases SET status='approved', approved_strategy_version_id='strategy-1'
        WHERE id='phase-1';
      INSERT INTO objectives (
        id, project_id, phase_id, outcome, success_measures, status, "order"
      ) VALUES ('objective-1','project-1','phase-1','One completed task',
        '["task completes"]'::jsonb,'active',0);
      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id, title,
        description, deliverables, acceptance_criteria, complexity, risk,
        required_roles, required_capabilities, required_inputs, expected_outputs,
        environment_policy_ref, verification_policy_ref, state, lifecycle_version
      ) VALUES ('task-1','project-1','phase-1','objective-1','strategy-1','Do work',
        'Complete the vertical slice','["change"]'::jsonb,'["verified"]'::jsonb,
        'M','medium','["implementation"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
        '["commit"]'::jsonb,'environment','verification','pending',0);
      INSERT INTO agent_profiles (
        id, provider, runtime, model, reasoning_effort, roles, capabilities, context_limit_tokens,
        security_restrictions, status, active_workload, cost_metadata
      ) VALUES ('agent-1','openai','codex','gpt-5-codex','high','["implementation"]'::jsonb,
        '["typescript"]'::jsonb,200000,'[]'::jsonb,'available',0,
        '{"billing_mode":"subscription"}'::jsonb);
      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
        rationale_factors, budget_limit_usd, allocation_policy_ref
      ) VALUES ('assignment-1','project-1','phase-1','task-1','agent-1','proposed',
        'Best implementation agent','["capability"]'::jsonb,10,'allocation');
    `);
    coordinator = new Phase4Coordinator(new PGliteTransactionRunner(pg));
  });

  afterEach(async () => {
    await pg.close();
  });

  function schedule(runnerId = "runner-1", scheduler = coordinator) {
    return scheduler.schedule({
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      assignment_id: "assignment-1",
      runner_id: runnerId,
      runner_generation: 3,
      authorized_by: { actor_type: "human", actor_id: "admin-1" },
      authorized_by_session_id: "session-1",
      correlation_id: "correlation-1",
      causation_id: null,
      context_refs: [
        {
          artifact_id: "prompt-1",
          content_hash: "b".repeat(64),
          byte_size: 12,
          storage_ref: "relay://artifacts/prompt-1",
        },
      ],
      target_branch: "norns/task-1",
      worktree_policy_ref: "worktree-default",
      sandbox_policy_ref: "sandbox-default",
      max_input_tokens: 10_000,
      max_output_tokens: 4_000,
      max_duration_seconds: 900,
      issued_at: "2026-07-16T20:00:00.000Z",
      expires_at: "2026-07-16T20:15:00.000Z",
    });
  }

  async function poisonPrimaryBindingWithMismatchedDeviceGrant(): Promise<void> {
    await pg.exec(`
      INSERT INTO devices (
        id,owner_user_id,display_name,os_family,architecture,lifecycle,current_generation
      ) VALUES ('device-actual','admin-1','Actual device','linux','x64','active',0);
      INSERT INTO device_credentials (
        id,device_id,generation,public_key_spki_der,public_key_fingerprint,state
      ) VALUES (
        'credential-actual','device-actual',1,'\\x01',
        repeat('d',64),'active'
      );
      INSERT INTO device_repository_registrations (
        id,device_id,workspace_id,repository_id,repository_display_name,
        state,approved_by_user_id,approved_at,default_branch,
        approved_credential_id,approved_generation
      ) VALUES (
        'registration-actual','device-actual','workspace-1','repository-1',
        'Project One','active','admin-1',now(),'main',
        'credential-actual',1
      );
      INSERT INTO project_device_repository_grants (
        id,project_id,repository_registration_id,state,granted_by_user_id
      ) VALUES (
        'grant-actual','project-1','registration-actual','active','admin-1'
      );
      ALTER TABLE repository_bindings
        DISABLE TRIGGER repository_bindings_identity_guard;
      UPDATE repository_bindings
         SET project_device_repository_grant_id='grant-actual',
             runner_id=NULL
       WHERE id='binding-1';
      ALTER TABLE repository_bindings
        ENABLE TRIGGER repository_bindings_identity_guard;
    `);
  }

  async function replacePrimaryWithDeviceBinding(deviceId: string): Promise<void> {
    await pg.query("UPDATE projects SET owner_user_id='admin-1' WHERE id='project-1'");
    await pg.query(
      `INSERT INTO devices (
         id,owner_user_id,display_name,os_family,architecture,lifecycle,current_generation
       ) VALUES ($1,'admin-1','Coordinator device','linux','x64','active',0)`,
      [deviceId],
    );
    await pg.query(
      `INSERT INTO device_credentials (
         id,device_id,generation,public_key_spki_der,public_key_fingerprint,state
       ) VALUES ('credential-device-binding',$1,3,'\\x02',$2,'active')`,
      [deviceId, "e".repeat(64)],
    );
    await pg.query(
      `INSERT INTO device_repository_registrations (
         id,device_id,workspace_id,repository_id,repository_display_name,state,
         approved_by_user_id,approved_at,default_branch,observed_head,
         approved_credential_id,approved_generation
       ) VALUES (
         'registration-device-binding',$1,'workspace-1','repository-1','Project One',
         'active','admin-1',now(),'main','commit-1','credential-device-binding',3
       )`,
      [deviceId],
    );
    await pg.exec(`
      INSERT INTO project_device_repository_grants (
        id,project_id,repository_registration_id,state,granted_by_user_id
      ) VALUES (
        'grant-device-binding','project-1','registration-device-binding','active','admin-1'
      );
      INSERT INTO repository_bindings (
        id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
        repository_display_name,granted_permissions,default_branch,observed_head,
        verification_policy_ref,repository_health,created_by_actor_type,
        created_by_actor_id,project_device_repository_grant_id
      ) VALUES (
        'binding-device','project-1','local_runner','connected',NULL,'workspace-1',
        'repository-1','Project One','{}'::jsonb,'main','commit-1','verification',
        'healthy','human','admin-1','grant-device-binding'
      );
      UPDATE projects
         SET primary_repository_binding_id='binding-device'
       WHERE id='project-1';
    `);
  }

  it("atomically assigns, reserves budget, and creates stable durable outbox records", async () => {
    const result = await schedule();

    expect(result.command.command_id).toBe(`dispatch:${result.dispatch_job_id}`);
    expect(result.command.runner_repository_id).toBe("repository-1");
    // EXEC-INTEGRATE-1: a local_runner binding integrates into its default
    // branch directly, so the dispatch carries the base to advance.
    expect(result.command.integrate_base_branch).toBe("main");
    expect(result.command.execution_mode).toBe("planned");
    expect(result.command.reasoning_effort).toBe("high");
    expect(result.command.max_charge_usd).toBe(10);
    const state = await pg.query<{
      task_state: string;
      run_state: string;
      assignment_status: string;
      reservation_status: string;
      dispatch_status: string;
      command_status: string;
      task_events: number;
    }>(
      `SELECT t.state AS task_state, run.state AS run_state,
              assignment.status AS assignment_status,
              reservation.status AS reservation_status,
              job.status AS dispatch_status, command.status AS command_status,
              (SELECT count(*)::int FROM domain_events
               WHERE stream_type='task' AND stream_id='task-1') AS task_events
       FROM tasks t
       JOIN agent_runs run ON run.id = t.designated_run_id
       JOIN agent_assignments assignment ON assignment.id = t.designated_assignment_id
       JOIN budget_reservations reservation ON reservation.run_id = run.id
       JOIN dispatch_jobs job ON job.run_id = run.id
       JOIN commands command ON command.command_id = job.command_id
       WHERE t.id = 'task-1'`,
    );
    expect(state.rows[0]).toEqual({
      task_state: "assigned",
      run_state: "created",
      assignment_status: "active",
      reservation_status: "active",
      dispatch_status: "queued",
      command_status: "queued",
      task_events: 2,
    });
  });

  it("EXEC-CANCEL-2: expires a delivered-but-never-started command past its deadline and blocks the task", async () => {
    await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const monitor = new Phase4RecoveryMonitor(transactions);

    // Before the command's own expires_at (20:15Z): nothing is stale.
    const early = await monitor.scan(new Date("2026-07-16T20:10:00.000Z"));
    expect(early.expired_dispatches).toBe(0);

    // After the deadline the created run never started, so it expires and its
    // task drops to blocked — the state the recovery panel offers retry from,
    // with no user Stop required.
    const outcome = await monitor.scan(new Date("2026-07-16T20:30:00.000Z"));
    expect(outcome.expired_dispatches).toBe(1);

    const state = await pg.query<{ run_state: string; task_state: string }>(
      `SELECT run.state AS run_state, task.state AS task_state
         FROM tasks task JOIN agent_runs run ON run.id=task.designated_run_id
        WHERE task.id='task-1'`,
    );
    expect(state.rows[0]).toEqual({ run_state: "expired", task_state: "blocked" });
  });

  it("EXEC-INTEGRATE-1: advances the binding's observed_head when the runner integrates the base branch", async () => {
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const dispatch = new Phase4DispatchRepository(transactions);
    await dispatch.claim("dispatcher-a", 30_000);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-a",
      "2026-07-16T20:01:00.000Z",
    );
    const events = new Phase4EventProcessor(transactions);
    const publish = (integration: Record<string, unknown>, seq: number) =>
      events.apply({
        protocol: 1,
        event_seq: seq,
        runner_id: "runner-1",
        generation: 3,
        correlation_id: "correlation-1",
        causation_id: scheduled.command_id,
        occurred_at: "2026-07-16T20:05:00.000Z",
        payload: {
          kind: "run_published",
          run_id: scheduled.run_id,
          outcome: "pushed",
          branch: "norns/task-1",
          commit_sha: "task-commit-abc",
          remote: "origin",
          pull_request_url: null,
          pull_request_note: null,
          ...integration,
        },
      });
    const head = async () =>
      (
        await pg.query<{ observed_head: string }>(
          "SELECT observed_head FROM repository_bindings WHERE id='binding-1'",
        )
      ).rows[0]?.observed_head;

    // A successful base advance moves observed_head — the base the next phase
    // will branch from.
    await publish(
      {
        integration_outcome: "integrated",
        integrated_base_branch: "main",
        integrated_base_commit: "integrated-commit-99",
      },
      1,
    );
    expect(await head()).toBe("integrated-commit-99");

    // A conflict never advances it — the other phase's work is not overwritten.
    await publish(
      {
        integration_outcome: "conflict",
        integrated_base_branch: "main",
        integrated_base_commit: "someone-elses-commit",
      },
      2,
    );
    expect(await head()).toBe("integrated-commit-99");
  });

  it("keeps exact runner matching for legacy local bindings under typed authorization", async () => {
    await pg.exec("UPDATE projects SET owner_user_id='admin-1' WHERE id='project-1'");
    coordinator = new Phase4Coordinator(new PGliteTransactionRunner(pg), {
      deviceAuthorization: new PostgresDeviceActionAuthorization({
        deviceDispatchEnabled: true,
      }),
    });

    await expect(schedule()).resolves.toMatchObject({
      command: {
        runner_id: "runner-1",
        repository_binding_id: "binding-1",
      },
    });
  });

  it("rejects a legacy local binding assigned to another runner", async () => {
    await pg.exec(`
      INSERT INTO repository_bindings (
        id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
        repository_display_name,granted_permissions,default_branch,observed_head,
        verification_policy_ref,repository_health,created_by_actor_type,
        created_by_actor_id
      ) VALUES (
        'binding-other','project-1','local_runner','connected','runner-other',
        'workspace-other','repository-other','Other repository','{}'::jsonb,'main',
        'commit-other','verification','healthy','human','admin-1'
      );
      UPDATE projects
         SET primary_repository_binding_id='binding-other'
       WHERE id='project-1';
    `);

    await expect(schedule()).rejects.toThrow(/belongs to a different runner/i);
  });

  it("dispatches through a typed grant-backed binding without duplicating device identity", async () => {
    await replacePrimaryWithDeviceBinding("runner-1");
    coordinator = new Phase4Coordinator(new PGliteTransactionRunner(pg), {
      deviceAuthorization: new PostgresDeviceActionAuthorization({
        deviceDispatchEnabled: true,
      }),
    });

    const scheduled = await schedule();
    expect(scheduled.command).toMatchObject({
      runner_id: "runner-1",
      repository_binding_id: "binding-device",
    });
    const binding = await pg.query<{ runner_id: string | null }>(
      "SELECT runner_id FROM repository_bindings WHERE id='binding-device'",
    );
    expect(binding.rows[0]?.runner_id).toBeNull();
  });

  it("rejects a grant-backed binding whose registration belongs to another device", async () => {
    await replacePrimaryWithDeviceBinding("runner-other");
    coordinator = new Phase4Coordinator(new PGliteTransactionRunner(pg), {
      deviceAuthorization: new PostgresDeviceActionAuthorization({
        deviceDispatchEnabled: true,
      }),
    });

    await expect(schedule()).rejects.toThrow(
      /device repository binding is not currently authorized/i,
    );
  });

  // FRONT DOOR P2b (D2): planning/staffing/approval work with no repository
  // binding at all (a folder-first local project may only have an unverified
  // repository_binding_candidates row) — but execution dispatch is the one
  // place that must still gate on a verified binding + online runner, with a
  // clear, specific error instead of the generic scheduling-conflict message.
  it("blocks execution dispatch with a clear error when the project has no verified repository binding", async () => {
    await pg.exec(
      "UPDATE projects SET primary_repository_binding_id = NULL WHERE id = 'project-1'",
    );

    await expect(schedule()).rejects.toThrow(/verified repository binding/i);
  });

  it("blocks execution dispatch when the binding exists but is not yet verified", async () => {
    await pg.exec(
      `UPDATE repository_bindings SET status = 'unverified_candidate' WHERE id = 'binding-1'`,
    );

    await expect(schedule()).rejects.toThrow(/verified repository binding/i);
  });

  it("does not send a runner-local repository identity for GitHub bindings", async () => {
    await pg.exec(
      `INSERT INTO repository_bindings (
         id, project_id, binding_type, status, runner_id, repository_id,
         repository_display_name, github_installation_id, github_owner, github_name,
         granted_permissions, default_branch, observed_head, verification_policy_ref,
         repository_health, created_by_actor_type, created_by_actor_id
       ) VALUES (
         'binding-github','project-1','github','connected','server',
         'github-repository-1','octocat/project-one','installation-1','octocat','project-one',
         '{}'::jsonb,'main','commit-1','verification','healthy','human','admin-1'
       );
       UPDATE projects SET primary_repository_binding_id='binding-github' WHERE id='project-1'`,
    );

    const result = await schedule();

    expect(result.command.repository_binding_id).toBe("binding-github");
    expect(result.command.runner_repository_id).toBeUndefined();
  });

  it("reclaims a crashed dispatcher lease and redelivers the identical command", async () => {
    const scheduled = await schedule();
    const repository = new Phase4DispatchRepository(new PGliteTransactionRunner(pg));
    const first = await repository.claim("dispatcher-a", 30_000);
    expect(first?.command.command_id).toBe(scheduled.command_id);

    await pg.query(
      "UPDATE dispatch_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [scheduled.dispatch_job_id],
    );
    const recovered = await repository.claim("dispatcher-b", 30_000);
    expect(recovered?.command.command_id).toBe(first?.command.command_id);
    expect(recovered?.attempts).toBe(2);
    await repository.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-b",
      "2026-07-16T20:01:00.000Z",
    );

    const state = await pg.query<{ job: string; command: string; run: string }>(
      `SELECT job.status AS job, command.status AS command, run.state AS run
       FROM dispatch_jobs job
       JOIN commands command ON command.command_id = job.command_id
       JOIN agent_runs run ON run.id = job.run_id
       WHERE job.id = $1`,
      [scheduled.dispatch_job_id],
    );
    expect(state.rows[0]).toEqual({ job: "delivered", command: "dispatched", run: "dispatched" });
    await expect(repository.pendingForRunner("runner-1", 3)).resolves.toEqual([scheduled.command]);
  });

  it("cancels a claimed command when a grant-backed binding reveals identity confusion", async () => {
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const unsecured = new Phase4DispatchRepository(transactions);
    const claimed = await unsecured.claim("dispatcher-a", 30_000);
    expect(claimed?.command.command_id).toBe(scheduled.command_id);

    await poisonPrimaryBindingWithMismatchedDeviceGrant();
    let delivered = false;
    const secured = new Phase4DispatchRepository(
      transactions,
      new PostgresDeviceActionAuthorization({ deviceDispatchEnabled: true }),
    );
    await expect(
      secured.deliverClaimed(
        scheduled.dispatch_job_id,
        "dispatcher-a",
        scheduled.command,
        async () => {
          delivered = true;
        },
        "2026-07-16T20:01:00.000Z",
      ),
    ).resolves.toBe("cancelled_stale");
    expect(delivered).toBe(false);
    const state = await pg.query<{ job: string; command: string }>(
      `SELECT job.status AS job,command.status AS command
         FROM dispatch_jobs job
         JOIN commands command ON command.command_id=job.command_id
        WHERE job.id=$1`,
      [scheduled.dispatch_job_id],
    );
    expect(state.rows[0]).toEqual({ job: "cancelled", command: "cancelled" });
  });

  it("never reconnect-redelivers a delivered command after its binding becomes identity-confused", async () => {
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const unsecured = new Phase4DispatchRepository(transactions);
    await unsecured.claim("dispatcher-a", 30_000);
    await unsecured.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-a",
      "2026-07-16T20:01:00.000Z",
    );
    await poisonPrimaryBindingWithMismatchedDeviceGrant();
    const secured = new Phase4DispatchRepository(
      transactions,
      new PostgresDeviceActionAuthorization({ deviceDispatchEnabled: true }),
    );
    await expect(secured.pendingForRunner("runner-1", 3)).resolves.toEqual([]);
    const state = await pg.query<{ job: string; command: string }>(
      `SELECT job.status AS job,command.status AS command
         FROM dispatch_jobs job
         JOIN commands command ON command.command_id=job.command_id
        WHERE job.id=$1`,
      [scheduled.dispatch_job_id],
    );
    expect(state.rows[0]).toEqual({ job: "cancelled", command: "cancelled" });
  });

  it("holds device authorization locks through reconnect command delivery", async () => {
    await replacePrimaryWithDeviceBinding("device-1");
    await pg.query(
      "UPDATE repository_bindings SET status='disconnected' WHERE id='binding-device'",
    );
    const transactions = new PGliteTransactionRunner(pg);
    const deviceAuthorization = new PostgresDeviceActionAuthorization({
      deviceDispatchEnabled: true,
    });
    const scheduled = await schedule(
      "device-1",
      new Phase4Coordinator(transactions, { deviceAuthorization }),
    );
    const unsecured = new Phase4DispatchRepository(transactions);
    await unsecured.claim("dispatcher-a", 30_000);
    await unsecured.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-a",
      "2026-07-16T20:01:00.000Z",
    );
    await pg.query(
      `UPDATE commands
          SET envelope=jsonb_set(envelope,'{expires_at}','"2099-01-01T00:00:00.000Z"'::jsonb)
        WHERE command_id=$1`,
      [scheduled.command_id],
    );

    const secured = new Phase4DispatchRepository(transactions, deviceAuthorization);
    let revocationCommitted = false;
    let revocation: Promise<unknown> | undefined;
    await expect(
      secured.deliverPendingForRunner("device-1", 3, new Set(), async () => {
        revocation = pg
          .query(
            `UPDATE devices
                  SET lifecycle='revoked',revoked_at=now()
                WHERE id='device-1'`,
          )
          .then(() => {
            revocationCommitted = true;
          });
        await Promise.resolve();
        expect(revocationCommitted).toBe(false);
      }),
    ).resolves.toBe(1);
    await revocation;
    expect(revocationCommitted).toBe(true);
  });

  it("does not requeue a lease that revocation cancelled after delivery failed", async () => {
    const scheduled = await schedule();
    const repository = new Phase4DispatchRepository(new PGliteTransactionRunner(pg));
    await expect(repository.claim("dispatcher-a", 30_000)).resolves.toMatchObject({
      job_id: scheduled.dispatch_job_id,
    });
    await pg.query(
      `UPDATE dispatch_jobs
          SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE id=$1`,
      [scheduled.dispatch_job_id],
    );
    await pg.query("UPDATE commands SET status='cancelled',updated_at=now() WHERE command_id=$1", [
      scheduled.command_id,
    ]);

    await expect(
      repository.retry(
        scheduled.dispatch_job_id,
        "dispatcher-a",
        "socket closed during send",
        1_000,
      ),
    ).resolves.toBeUndefined();
    const state = await pg.query<{ job: string; command: string }>(
      `SELECT job.status AS job,command.status AS command
         FROM dispatch_jobs job
         JOIN commands command ON command.command_id=job.command_id
        WHERE job.id=$1`,
      [scheduled.dispatch_job_id],
    );
    expect(state.rows[0]).toEqual({ job: "cancelled", command: "cancelled" });
  });

  it("rejects run events and command acknowledgements for a poisoned grant-backed binding", async () => {
    const scheduled = await schedule();
    await poisonPrimaryBindingWithMismatchedDeviceGrant();
    const processor = new Phase4EventProcessor(
      new PGliteTransactionRunner(pg),
      undefined,
      new PostgresDeviceActionAuthorization({ deviceDispatchEnabled: true }),
    );
    const identity = {
      subject: "legacy_runner" as const,
      runner_id: "runner-1",
      generation: 3,
    };
    await expect(
      processor.apply(
        {
          protocol: 1,
          event_seq: 1,
          runner_id: "runner-1",
          generation: 3,
          correlation_id: "correlation-1",
          causation_id: scheduled.command_id,
          occurred_at: "2026-07-16T20:01:00.000Z",
          payload: {
            kind: "run_status",
            run_id: scheduled.run_id,
            status: "started",
          },
        },
        identity,
      ),
    ).rejects.toThrow(/not currently authorized for the event run/i);
    await expect(
      processor.apply(
        {
          protocol: 1,
          event_seq: 2,
          runner_id: "runner-1",
          generation: 3,
          correlation_id: "correlation-1",
          causation_id: scheduled.command_id,
          occurred_at: "2026-07-16T20:02:00.000Z",
          payload: {
            kind: "command_ack",
            command_id: scheduled.command_id,
            state: "accepted",
            detail: "accepted after binding changed",
          },
        },
        identity,
      ),
    ).rejects.toThrow(/not currently authorized for the acknowledged command/i);
    await expect(
      processor.apply({
        protocol: 1,
        event_seq: 3,
        runner_id: "runner-1",
        generation: 3,
        correlation_id: "correlation-1",
        causation_id: scheduled.command_id,
        occurred_at: "2026-07-16T20:03:00.000Z",
        payload: {
          kind: "command_ack",
          command_id: scheduled.command_id,
          state: "accepted",
          detail: "missing authenticated identity",
        },
      }),
    ).rejects.toThrow(/authenticated transport identity is required/i);
    const state = await pg.query<{ events: number; command: string; run: string }>(
      `SELECT
         (SELECT count(*)::int FROM runner_events WHERE runner_id='runner-1') AS events,
         (SELECT status FROM commands WHERE command_id=$1) AS command,
         (SELECT state FROM agent_runs WHERE id=$2) AS run`,
      [scheduled.command_id, scheduled.run_id],
    );
    expect(state.rows[0]).toEqual({ events: 0, command: "queued", run: "created" });
  });

  it("durably applies runner events once and closes reviewed integrated work", async () => {
    await pg.query(
      "UPDATE agent_assignments SET reviewer_agent_profile_id='agent-1' WHERE id='assignment-1'",
    );
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const dispatch = new Phase4DispatchRepository(transactions);
    const claimed = await dispatch.claim("dispatcher-a", 30_000);
    expect(claimed?.command.command_id).toBe(scheduled.command_id);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-a",
      "2026-07-16T20:01:00.000Z",
    );

    const events = new Phase4EventProcessor(transactions);
    const envelope = (event_seq: number, payload: Record<string, unknown>) => ({
      protocol: 1 as const,
      event_seq,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: scheduled.command_id,
      occurred_at: `2026-07-16T20:0${event_seq}:00.000Z`,
      payload,
    });
    await events.apply(
      envelope(1, { kind: "run_status", run_id: scheduled.run_id, status: "started" }) as never,
    );
    const usage = envelope(2, {
      kind: "usage_report",
      run_id: scheduled.run_id,
      input_tokens: 100,
      output_tokens: 25,
    });
    await events.apply(usage as never);
    await expect(events.apply(usage as never)).resolves.toEqual({ duplicate: true });
    await events.apply(
      envelope(3, {
        kind: "verification_result",
        node_id: "task-1",
        commit_sha: "c".repeat(40),
        passed: true,
        output_digest: "verification-output",
      }) as never,
    );
    await events.apply(
      envelope(4, { kind: "run_status", run_id: scheduled.run_id, status: "completed" }) as never,
    );
    await events.apply(
      envelope(5, {
        kind: "command_ack",
        command_id: scheduled.command_id,
        state: "succeeded",
        detail: "",
      }) as never,
    );

    const beforeReview = await pg.query<{
      task: string;
      run: string;
      verification: string;
      reviewer_agent_profile_id: string | null;
      reviews: number;
      runner_events: number;
    }>(
      `SELECT task.state AS task, run.state AS run,
              run.verification_status AS verification,
              assignment.reviewer_agent_profile_id,
              (SELECT count(*)::int FROM agent_reviews
                WHERE run_id=run.id) AS reviews,
              (SELECT count(*)::int FROM runner_events WHERE applied_at IS NOT NULL) AS runner_events
       FROM tasks task
       JOIN agent_runs run ON run.id=task.designated_run_id
       JOIN agent_assignments assignment ON assignment.id=run.assignment_id
       WHERE task.id='task-1'`,
    );
    expect(beforeReview.rows[0]).toEqual({
      task: "in_review",
      run: "succeeded",
      verification: "passed",
      reviewer_agent_profile_id: "agent-1",
      reviews: 0,
      runner_events: 5,
    });

    const evidence = {
      artifact_id: "artifact-1",
      content_hash: "d".repeat(64),
      media_type: "application/json",
      label: "review and integration evidence",
    };
    const completion = new Phase4CompletionService(transactions);
    await expect(
      completion.complete({
        project_id: "project-1",
        phase_id: "phase-1",
        task_id: "task-1",
        run_id: scheduled.run_id,
        actor: { actor_type: "human", actor_id: "admin-1" },
        correlation_id: "correlation-1",
        review_evidence: [evidence],
        integration_evidence: [evidence],
        review_summary: "Reviewed and integrated",
        completed_at: "2026-07-16T20:06:00.000Z",
      }),
    ).resolves.toEqual({ task_completed: true, phase_closed: true });

    const closed = await pg.query<{
      task: string;
      phase: string;
      objective: string;
      assignment: string;
      reservation: string;
      memory: number;
    }>(
      `SELECT task.state AS task, phase.status AS phase, objective.status AS objective,
              assignment.status AS assignment, reservation.status AS reservation,
              (SELECT count(*)::int FROM project_memory_entries
               WHERE phase_id='phase-1' AND category='phase_completion') AS memory
       FROM tasks task
       JOIN phases phase ON phase.id=task.phase_id
       JOIN objectives objective ON objective.id=task.objective_id
       JOIN agent_assignments assignment ON assignment.id=task.designated_assignment_id
       JOIN budget_reservations reservation ON reservation.run_id=task.designated_run_id
       WHERE task.id='task-1'`,
    );
    expect(closed.rows[0]).toEqual({
      task: "completed",
      phase: "completed",
      objective: "completed",
      assignment: "completed",
      reservation: "settled",
      memory: 1,
    });
  });

  it("reconciles terminal usage from gateway events once and persists runtime stop metadata", async () => {
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const dispatch = new Phase4DispatchRepository(transactions);
    await dispatch.claim("dispatcher-usage", 30_000);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-usage",
      "2026-07-16T20:01:00.000Z",
    );
    const events = new Phase4EventProcessor(transactions);
    const envelope = (event_seq: number, payload: Record<string, unknown>) => ({
      protocol: 1 as const,
      event_seq,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-usage",
      causation_id: scheduled.command_id,
      occurred_at: `2026-07-16T20:0${event_seq}:00.000Z`,
      payload,
    });

    await events.apply(
      envelope(1, { kind: "run_status", run_id: scheduled.run_id, status: "started" }) as never,
    );
    await pg.query(
      `INSERT INTO usage_events (
         id, project_id, phase_id, task_id, run_id, provider, model,
         input_tokens, output_tokens, cost_usd, occurred_at
       ) VALUES
         ('gateway-usage-1','project-1','phase-1','task-1',$1,'anthropic','claude-sonnet-5',
          1000,200,0.15,'2026-07-16T20:01:30.000Z'),
         ('gateway-usage-2','project-1','phase-1','task-1',$1,'anthropic','claude-sonnet-5',
          800,150,0.12,'2026-07-16T20:01:45.000Z')`,
      [scheduled.run_id],
    );
    // The SDK reports only its final session turn. It is provisional and must
    // not overwrite or be added to the gateway's complete per-request ledger.
    await events.apply(
      envelope(2, {
        kind: "usage_report",
        run_id: scheduled.run_id,
        input_tokens: 25,
        output_tokens: 5,
      }) as never,
    );
    await events.apply(
      envelope(3, {
        kind: "runtime_result",
        run_id: scheduled.run_id,
        runtime: "claude-code",
        outcome: "completed",
        session_id: "claude-session-usage",
        stop_reason: "permission_denied:Edit,Bash",
        detail: "SDK permission denied for Edit, Bash",
      }) as never,
    );
    const terminal = envelope(4, {
      kind: "run_status",
      run_id: scheduled.run_id,
      status: "failed",
      failure: {
        stage: "worktree_inspection",
        code: "runner_permission_denied",
        detail: "SDK permission denied for Edit, Bash",
      },
    });
    await events.apply(terminal as never);
    await expect(events.apply(terminal as never)).resolves.toEqual({ duplicate: true });

    const rows = await pg.query<{
      usage_input_tokens: number | string;
      usage_output_tokens: number | string;
      usage_cost_usd: number | string;
      runtime_session_id: string;
      result_summary: string;
      reservation_status: string;
      resolution_outcome: string;
      settled_usd: number | string;
    }>(
      `SELECT run.usage_input_tokens, run.usage_output_tokens, run.usage_cost_usd,
              run.runtime_session_id, run.result_summary,
              reservation.status AS reservation_status,
              reservation.resolution_outcome, reservation.settled_usd
         FROM agent_runs run
         JOIN budget_reservations reservation ON reservation.run_id = run.id
        WHERE run.id = $1`,
      [scheduled.run_id],
    );
    const row = rows.rows[0];
    expect(Number(row?.usage_input_tokens)).toBe(1800);
    expect(Number(row?.usage_output_tokens)).toBe(350);
    expect(Number(row?.usage_cost_usd)).toBeCloseTo(0.27, 6);
    expect(row?.runtime_session_id).toBe("claude-session-usage");
    expect(row?.result_summary).toContain("permission_denied:Edit,Bash");
    expect(row?.reservation_status).toBe("settled");
    expect(row?.resolution_outcome).toBe("partial_usage");
    expect(Number(row?.settled_usd)).toBeCloseTo(0.27, 6);

    const canonical = await pg.query<{
      event_type: string;
      initiated_by_user_id: string | null;
    }>(
      `SELECT event_type, initiated_by_user_id
       FROM ai_usage_events
       WHERE run_id=$1
       ORDER BY sequence`,
      [scheduled.run_id],
    );
    expect(canonical.rows).toHaveLength(3);
    expect(canonical.rows.every((event) => event.initiated_by_user_id === "admin-1")).toBe(true);
  });

  it("dead-letters exhausted delivery, blocks work, and releases its reservation", async () => {
    const scheduled = await schedule();
    await pg.query("UPDATE dispatch_jobs SET attempts=4 WHERE id=$1", [scheduled.dispatch_job_id]);
    const repository = new Phase4DispatchRepository(new PGliteTransactionRunner(pg));
    const dispatcher = new Phase4Dispatcher(
      repository,
      "dispatcher-a",
      async () => {
        throw new Error("runner unavailable");
      },
      { max_attempts: 5, now: () => new Date("2026-07-16T20:10:00.000Z") },
    );
    await expect(dispatcher.tick()).resolves.toBe(false);
    const state = await pg.query<{
      job: string;
      command: string;
      run: string;
      task: string;
      reservation: string;
      outcome: string;
    }>(
      `SELECT job.status AS job, command.status AS command, run.state AS run,
              task.state AS task, reservation.status AS reservation,
              reservation.resolution_outcome AS outcome
       FROM dispatch_jobs job
       JOIN commands command ON command.command_id=job.command_id
       JOIN agent_runs run ON run.id=job.run_id
       JOIN tasks task ON task.id=job.task_id
       JOIN budget_reservations reservation ON reservation.run_id=job.run_id
       WHERE job.id=$1`,
      [scheduled.dispatch_job_id],
    );
    expect(state.rows[0]).toEqual({
      job: "dead_letter",
      command: "failed",
      run: "expired",
      task: "blocked",
      reservation: "released",
      outcome: "dead_letter",
    });
  });

  it("turns a rejected production command into durable blocked work without budget drift", async () => {
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const dispatch = new Phase4DispatchRepository(transactions);
    await dispatch.claim("dispatcher-a", 30_000);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-a",
      "2026-07-16T20:01:00.000Z",
    );
    const events = new Phase4EventProcessor(transactions);
    await events.apply({
      protocol: 1,
      event_seq: 1,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: scheduled.command_id,
      occurred_at: "2026-07-16T20:02:00.000Z",
      payload: {
        kind: "command_ack",
        command_id: scheduled.command_id,
        state: "rejected",
        detail: "runner execution is not configured",
      },
    });
    const state = await pg.query<{
      job: string;
      run: string;
      task: string;
      reservation: string;
      outcome: string;
    }>(
      `SELECT job.status AS job, run.state AS run, task.state AS task,
              reservation.status AS reservation, reservation.resolution_outcome AS outcome
       FROM dispatch_jobs job JOIN agent_runs run ON run.id=job.run_id
       JOIN tasks task ON task.id=job.task_id
       JOIN budget_reservations reservation ON reservation.run_id=job.run_id
       WHERE job.id=$1`,
      [scheduled.dispatch_job_id],
    );
    expect(state.rows[0]).toEqual({
      job: "completed",
      run: "failed",
      task: "blocked",
      reservation: "released",
      outcome: "rejected",
    });
  });

  it("converges a structured pre-start failure once from assigned without rejecting replay", async () => {
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const dispatch = new Phase4DispatchRepository(transactions);
    await dispatch.claim("dispatcher-a", 30_000);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-a",
      "2026-07-16T20:01:00.000Z",
    );
    const events = new Phase4EventProcessor(transactions);
    const failure = {
      protocol: 1 as const,
      event_seq: 1,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: scheduled.command_id,
      occurred_at: "2026-07-16T20:02:00.000Z",
      payload: {
        kind: "run_status" as const,
        run_id: scheduled.run_id,
        status: "failed" as const,
        failure: {
          stage: "scratch_prepare",
          code: "runner_scratch_prepare_failed",
          detail: "scratch parent could not be prepared",
        },
      },
    };
    await expect(events.apply(failure)).resolves.toEqual({ duplicate: false });
    await expect(events.apply(failure)).resolves.toEqual({ duplicate: true });
    await expect(
      events.apply({
        ...failure,
        event_seq: 2,
        occurred_at: "2026-07-16T20:03:00.000Z",
        payload: {
          kind: "command_ack",
          command_id: scheduled.command_id,
          state: "failed",
          detail: "runner_scratch_prepare_failed",
        },
      }),
    ).resolves.toEqual({ duplicate: false });

    const state = await pg.query<{
      task: string;
      run: string;
      failure_code: string;
      failure_detail: string;
      reservation: string;
      event_count: number;
    }>(
      `SELECT task.state AS task, run.state AS run, run.failure_code,
              run.failure_detail, reservation.status AS reservation,
              (SELECT count(*)::int FROM runner_events
                WHERE runner_id='runner-1' AND runner_generation=3) AS event_count
         FROM tasks task
         JOIN agent_runs run ON run.id=task.designated_run_id
         JOIN budget_reservations reservation ON reservation.run_id=run.id
        WHERE task.id='task-1'`,
    );
    expect(state.rows[0]).toEqual({
      task: "failed",
      run: "failed",
      failure_code: "runner_scratch_prepare_failed",
      failure_detail: "scratch_prepare: scratch parent could not be prepared",
      reservation: "released",
      event_count: 2,
    });

    const monitor = new Phase4RecoveryMonitor(transactions);
    await expect(monitor.scan(new Date("2026-07-16T20:04:00.000Z"))).resolves.toEqual({
      decision_points: 1,
      repaired_reservations: [],
      expired_dispatches: 0,
    });
    const decision = await pg.query<{ reason_class: string; status: string }>(
      "SELECT reason_class, status FROM decision_points WHERE scope_entity_id=$1",
      [scheduled.run_id],
    );
    expect(decision.rows).toEqual([{ reason_class: "failed_run", status: "open" }]);
  });

  it("raises an automatic task limit, retries as attempt N+1, and replays idempotently", async () => {
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const dispatch = new Phase4DispatchRepository(transactions);
    await dispatch.claim("dispatcher-a", 30_000);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-a",
      "2026-07-16T20:01:00.000Z",
    );
    const events = new Phase4EventProcessor(transactions);
    await events.apply({
      protocol: 1,
      event_seq: 1,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: scheduled.command_id,
      occurred_at: "2026-07-16T20:02:00.000Z",
      payload: {
        kind: "run_status",
        run_id: scheduled.run_id,
        status: "failed",
        failure: {
          stage: "worktree_prepare",
          code: "runner_worktree_prepare_failed",
          detail: "worktree preparation failed",
        },
      },
    });
    const task = await pg.query<{ aggregate_version: number }>(
      "SELECT aggregate_version FROM tasks WHERE id='task-1'",
    );
    await pg.query(
      `INSERT INTO agent_profiles (
         id, provider, runtime, model, reasoning_effort, roles, capabilities,
         context_limit_tokens, security_restrictions, status, active_workload, cost_metadata
       ) VALUES (
         'agent-2','anthropic','claude_code','claude-sonnet-5',NULL,
         '["implementation"]'::jsonb,'["typescript"]'::jsonb,200000,
         '[]'::jsonb,'available',0,'{"billing_mode":"subscription"}'::jsonb
       )`,
    );
    const phaseLaunch = new PhaseLaunchService(
      transactions,
      coordinator,
      {
        assembleForTask: async () => [
          {
            artifact_id: "retry-prompt",
            content_hash: "c".repeat(64),
            byte_size: 12,
            storage_ref: "relay://artifacts/retry-prompt",
          },
        ],
      },
      new DispatchContextScopeRepository(transactions),
      () => ({ runner_id: "runner-1", runner_generation: 3 }),
    );
    const recovery = new Phase4RecoveryActionService(transactions, phaseLaunch);
    const input = {
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      failed_run_id: scheduled.run_id,
      expected_task_version: task.rows[0]?.aggregate_version ?? 0,
      actor: { actor_type: "human" as const, actor_id: "admin-1" },
      authorized_by_session_id: "session-recovery",
      idempotency_key: "retry-task-1-once",
      correlation_id: "correlation-retry",
      causation_id: scheduled.run_id,
      issued_at: "2026-07-16T20:05:00.000Z",
      adjustment: {
        budget_limit_usd: 25,
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
    };
    const first = await recovery.retry(input);
    expect(first).toMatchObject({
      action: "retry",
      replayed: false,
      started: true,
      prior_run_id: scheduled.run_id,
      attempt: 2,
    });
    expect(first.run_id).not.toBe(scheduled.run_id);

    await expect(recovery.retry(input)).resolves.toMatchObject({
      replayed: true,
      started: true,
      run_id: first.run_id,
      attempt: 2,
    });
    const runs = await pg.query<{
      id: string;
      attempt: number;
      state: string;
      failure_code: string | null;
      failure_detail: string | null;
      is_designated: boolean;
      superseded_by_run_id: string | null;
    }>(
      `SELECT id, attempt, state, failure_code, failure_detail,
              is_designated, superseded_by_run_id
         FROM agent_runs WHERE task_id='task-1' ORDER BY attempt`,
    );
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows[0]).toMatchObject({
      id: scheduled.run_id,
      attempt: 1,
      state: "failed",
      failure_code: "runner_worktree_prepare_failed",
      failure_detail: "worktree_prepare: worktree preparation failed",
      is_designated: false,
      superseded_by_run_id: first.run_id,
    });
    expect(runs.rows[1]).toMatchObject({
      id: first.run_id,
      attempt: 2,
      state: "created",
      failure_code: null,
      failure_detail: null,
      is_designated: true,
    });
    const counts = await pg.query<{
      runs: number;
      reservations: number;
      jobs: number;
      recovery_audits: number;
      assignment_budget: string | number;
      phase_budget: string | number;
      replacement_reservation: string | number;
      replacement_agent: string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM agent_runs WHERE task_id='task-1') AS runs,
         (SELECT count(*)::int FROM budget_reservations WHERE task_id='task-1') AS reservations,
         (SELECT count(*)::int FROM dispatch_jobs WHERE task_id='task-1') AS jobs,
         (SELECT count(*)::int FROM audit_events
           WHERE audit_type='execution.recovery.applied') AS recovery_audits,
         (SELECT budget_limit_usd FROM agent_assignments
           WHERE id='assignment-1') AS assignment_budget,
         (SELECT approved_budget_usd FROM phases WHERE id='phase-1') AS phase_budget,
         (SELECT amount_usd FROM budget_reservations
           WHERE run_id=$1) AS replacement_reservation,
         (SELECT agent_profile_id FROM agent_assignments
           WHERE id='assignment-1') AS replacement_agent`,
      [first.run_id],
    );
    expect(counts.rows[0]).toMatchObject({
      runs: 2,
      reservations: 2,
      jobs: 2,
      recovery_audits: 1,
    });
    expect(Number(counts.rows[0]?.assignment_budget)).toBe(25);
    expect(Number(counts.rows[0]?.phase_budget)).toBe(25);
    expect(Number(counts.rows[0]?.replacement_reservation)).toBe(25);
    expect(counts.rows[0]?.replacement_agent).toBe("agent-2");
  });

  it("resumes the prior coding session when a retry keeps the same runner and agent", async () => {
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const dispatch = new Phase4DispatchRepository(transactions);
    await dispatch.claim("dispatcher-a", 30_000);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-a",
      "2026-07-16T20:01:00.000Z",
    );
    await pg.query("UPDATE agent_runs SET runtime_session_id=$2 WHERE id=$1", [
      scheduled.run_id,
      "coding-session-1",
    ]);
    const events = new Phase4EventProcessor(transactions);
    await events.apply({
      protocol: 1,
      event_seq: 1,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: scheduled.command_id,
      occurred_at: "2026-07-16T20:02:00.000Z",
      payload: {
        kind: "run_status",
        run_id: scheduled.run_id,
        status: "failed",
        failure: {
          stage: "runtime",
          code: "runner_runtime_unsuccessful",
          detail: "the turn limit stopped this attempt",
        },
      },
    });
    const task = await pg.query<{ aggregate_version: number }>(
      "SELECT aggregate_version FROM tasks WHERE id='task-1'",
    );
    const recovery = new Phase4RecoveryActionService(
      transactions,
      new PhaseLaunchService(
        transactions,
        coordinator,
        {
          assembleForTask: async () => [
            {
              artifact_id: "retry-prompt",
              content_hash: "c".repeat(64),
              byte_size: 12,
              storage_ref: "relay://artifacts/retry-prompt",
            },
          ],
        },
        new DispatchContextScopeRepository(transactions),
        () => ({ runner_id: "runner-1", runner_generation: 3 }),
      ),
    );
    const retried = await recovery.retry({
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      failed_run_id: scheduled.run_id,
      expected_task_version: task.rows[0]?.aggregate_version ?? 0,
      actor: { actor_type: "human", actor_id: "admin-1" },
      authorized_by_session_id: "session-recovery",
      idempotency_key: "retry-same-session-once",
      correlation_id: "correlation-retry",
      causation_id: scheduled.run_id,
      issued_at: "2026-07-16T20:05:00.000Z",
      adjustment: { budget_limit_usd: 15 },
    });
    const replacement = await pg.query<{ envelope: Record<string, unknown> }>(
      `SELECT command.envelope
         FROM dispatch_jobs job
         JOIN commands command ON command.command_id=job.command_id
        WHERE job.run_id=$1`,
      [retried.run_id],
    );
    expect(replacement.rows[0]?.envelope).toMatchObject({
      recovery: {
        previous_run_id: scheduled.run_id,
        resume_session_id: "coding-session-1",
        session_portability: "same_runner",
      },
    });
  });

  it("safely cancels a terminal failed phase and makes the project phase slot available", async () => {
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const dispatch = new Phase4DispatchRepository(transactions);
    await dispatch.claim("dispatcher-a", 30_000);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-a",
      "2026-07-16T20:01:00.000Z",
    );
    const events = new Phase4EventProcessor(transactions);
    await events.apply({
      protocol: 1,
      event_seq: 1,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: scheduled.command_id,
      occurred_at: "2026-07-16T20:02:00.000Z",
      payload: {
        kind: "run_status",
        run_id: scheduled.run_id,
        status: "failed",
        failure: {
          stage: "runtime",
          code: "runner_runtime_failed",
          detail: "runtime stopped before completing",
        },
      },
    });
    const task = await pg.query<{ aggregate_version: number }>(
      "SELECT aggregate_version FROM tasks WHERE id='task-1'",
    );
    const recovery = new Phase4RecoveryActionService(
      transactions,
      new PhaseLaunchService(
        transactions,
        coordinator,
        { assembleForTask: async () => [] },
        new DispatchContextScopeRepository(transactions),
        () => ({ runner_id: "runner-1", runner_generation: 3 }),
      ),
    );
    const input = {
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      failed_run_id: scheduled.run_id,
      expected_task_version: task.rows[0]?.aggregate_version ?? 0,
      actor: { actor_type: "human" as const, actor_id: "admin-1" },
      authorized_by_session_id: "session-recovery",
      idempotency_key: "cancel-failed-phase-once",
      correlation_id: "correlation-cancel",
      causation_id: scheduled.run_id,
      issued_at: "2026-07-16T20:05:00.000Z",
      reason: "Stop this failed phase and replan.",
    };
    await expect(recovery.cancel(input)).resolves.toMatchObject({
      action: "cancel",
      replayed: false,
      phase_status: "cancelled",
    });
    await expect(recovery.cancel(input)).resolves.toMatchObject({
      action: "cancel",
      replayed: true,
      phase_status: "cancelled",
    });
    const closed = await pg.query<{
      phase: string;
      task: string;
      assignment: string;
      objective: string;
      active_phases: number;
    }>(
      `SELECT phase.status AS phase, task.state AS task, assignment.status AS assignment,
              objective.status AS objective,
              (SELECT count(*)::int FROM phases
                WHERE project_id='project-1' AND status='active') AS active_phases
         FROM phases phase
         JOIN tasks task ON task.phase_id=phase.id
         JOIN objectives objective ON objective.id=task.objective_id
         JOIN agent_assignments assignment ON assignment.id=task.designated_assignment_id
        WHERE phase.id='phase-1' AND task.id='task-1'`,
    );
    expect(closed.rows[0]).toEqual({
      phase: "cancelled",
      task: "cancelled",
      assignment: "cancelled",
      objective: "cancelled",
      active_phases: 0,
    });
  });

  it("raises one stable DecisionPoint for stuck work", async () => {
    const scheduled = await schedule();
    const transactions = new PGliteTransactionRunner(pg);
    const dispatch = new Phase4DispatchRepository(transactions);
    await dispatch.claim("dispatcher-a", 30_000);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-a",
      "2026-07-16T20:01:00.000Z",
    );
    await pg.query("UPDATE agent_runs SET updated_at='2026-07-16T19:00:00.000Z' WHERE id=$1", [
      scheduled.run_id,
    ]);
    const monitor = new Phase4RecoveryMonitor(transactions);
    await expect(monitor.scan(new Date("2026-07-16T20:10:00.000Z"), 60_000)).resolves.toEqual({
      decision_points: 1,
      repaired_reservations: [],
      expired_dispatches: 0,
    });
    await expect(monitor.scan(new Date("2026-07-16T20:11:00.000Z"), 60_000)).resolves.toEqual({
      decision_points: 0,
      repaired_reservations: [],
      expired_dispatches: 0,
    });
    const points = await pg.query<{ count: number; status: string }>(
      `SELECT count(*)::int AS count, min(status) AS status
       FROM decision_points WHERE scope_entity_id=$1`,
      [scheduled.run_id],
    );
    expect(points.rows[0]).toEqual({ count: 1, status: "open" });

    // Reconcile state produced by an older process: the run later succeeded,
    // but its recovery point remained open. A monitor pass closes it without
    // requiring a human to decide a condition that no longer exists.
    await pg.query(
      `UPDATE agent_runs
          SET state='succeeded', updated_at='2026-07-16T20:12:00.000Z'
        WHERE id=$1`,
      [scheduled.run_id],
    );
    await expect(monitor.scan(new Date("2026-07-16T20:13:00.000Z"), 60_000)).resolves.toEqual({
      decision_points: 0,
      repaired_reservations: [],
      expired_dispatches: 0,
    });
    const reconciled = await pg.query<{ status: string; audits: number }>(
      `SELECT decision.status,
              (SELECT count(*)::int FROM audit_events
                WHERE audit_type='execution.recovery.auto_dismissed'
                  AND causation_id=$1) AS audits
         FROM decision_points decision WHERE decision.scope_entity_id=$1`,
      [scheduled.run_id],
    );
    expect(reconciled.rows[0]).toEqual({ status: "dismissed", audits: 1 });
  });
});
