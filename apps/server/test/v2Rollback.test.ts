import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Phase2MigrationProcessLease } from "../src/persistence/migration/migrationLock.js";
import { SqlPhase2RollbackController } from "../src/persistence/migration/rollback.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

describe.sequential("Phase 2 controlled project-read rollback", () => {
  let pg: PGlite;
  let controller: SqlPhase2RollbackController;

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
    controller = new SqlPhase2RollbackController(
      new PGliteTransactionRunner(pg) as unknown as Phase2MigrationProcessLease,
    );
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status, source, created_at, updated_at
      ) VALUES (
        'admin-1', 'admin@example.com', 'Admin', 'admin@example.com', 'Admin',
        '${"a".repeat(32)}:${"b".repeat(128)}', 'legacy-scrypt-v0',
        'admin', 'active', 'native', now() - interval '3 hours', now() - interval '3 hours'
      );
      INSERT INTO migration_runs (
        id, migration_name, source_snapshot_hashes, source_counts,
        source_frozen_at, source_manifest_hash, source_application_version,
        source_application_commit, recovery_marker, last_source_records,
        status, started_at, rollback_window_until, details
      ) VALUES (
        'migration-phase2', 'phase2-preservation', '{}'::jsonb, '{}'::jsonb,
        now() - interval '2 hours', repeat('a', 64), '0.1.0', 'commit-phase2',
        '{}'::jsonb,
        '{"projects":{"project_id":"project-2","legacy_updated_at":"2026-07-16T20:00:00.000Z"}}'::jsonb,
        'shadowing', now() - interval '2 hours', now() + interval '1 day',
        jsonb_build_object(
          'source_updated_at',
          jsonb_build_object('projects', (now() - interval '2 hours')::text)
        )
      );
      INSERT INTO projects (
        id, name, description, status, assignment_policy_ref,
        verification_policy_ref, budget_policy_ref, created_at, updated_at
      ) VALUES
        ('project-1', 'One', '', 'initializing', 'assignment/default',
         'verification/default', 'budget/default', now() - interval '2 hours', now() - interval '2 hours'),
        ('project-2', 'Two', '', 'initializing', 'assignment/default',
         'verification/default', 'budget/default', now() - interval '2 hours', now() - interval '2 hours');
      INSERT INTO project_planning_preferences (
        project_id, pm_provider, pm_model, reviewer_provider, source, created_at, updated_at
      ) VALUES
        ('project-1', 'anthropic', NULL, 'openai', 'legacy_snapshot',
         now() - interval '2 hours', now() - interval '2 hours'),
        ('project-2', 'anthropic', NULL, 'openai', 'legacy_snapshot',
         now() - interval '2 hours', now() - interval '2 hours');
      INSERT INTO legacy_project_imports (
        migration_run_id, project_id, source_hash, source_counts,
        import_hash, imported_at
      ) VALUES
        ('migration-phase2', 'project-1', repeat('b', 64), '{}'::jsonb,
         repeat('c', 64), now() - interval '2 hours'),
        ('migration-phase2', 'project-2', repeat('d', 64), '{}'::jsonb,
         repeat('e', 64), now() - interval '2 hours');
      INSERT INTO persistence_routes (
        scope_type, scope_key, read_mode, write_mode, migration_run_id,
        aggregate_version, changed_by_actor_type, changed_by_actor_id,
        changed_at, v2_writes_started_at, rollback_window_until
      ) VALUES
        ('identity', '*', 'legacy', 'legacy', 'migration-phase2', 1,
         'system', NULL, now() - interval '2 hours', NULL, now() + interval '1 day'),
        ('new_projects', '*', 'relational', 'legacy', 'migration-phase2', 2,
         'system', NULL, now() - interval '20 minutes', NULL, now() + interval '1 day'),
        ('project', 'project-1', 'relational', 'legacy', 'migration-phase2', 3,
         'system', NULL, now() - interval '10 minutes', NULL, now() + interval '1 day');
    `);
  }, 30_000);

  afterEach(async () => {
    await pg.close();
  });

  it("derives scope, record counts, source freshness, and loss window from PostgreSQL", async () => {
    const evidence = await controller.prepare("migration-phase2");

    expect(evidence).toMatchObject({
      schema_version: 2,
      migration_run_id: "migration-phase2",
      identity_credential_cutover_started: false,
      identity_route_rollback_supported: false,
      requires_human_confirmation: true,
    });
    expect(evidence.scopes.map((scope) => `${scope.scope_type}:${scope.scope_key}`)).toEqual([
      "new_projects:*",
      "project:project-1",
    ]);
    expect(evidence.scopes[0]?.affected_project_ids).toEqual(["project-1", "project-2"]);
    expect(evidence.scopes[1]?.affected_project_ids).toEqual(["project-1"]);
    expect(evidence.scopes[0]?.record_counts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_type: "projects", hidden_by_rollback: 2 }),
        expect.objectContaining({
          entity_type: "project_planning_preferences",
          hidden_by_rollback: 2,
        }),
      ]),
    );
    expect(evidence.scopes[1]?.record_counts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_type: "projects", hidden_by_rollback: 1 }),
        expect.objectContaining({ entity_type: "tasks", hidden_by_rollback: 0 }),
      ]),
    );
    expect(evidence.legacy_freeze_age_ms).toBeGreaterThan(0);
    expect(evidence.potential_data_loss_window_ms).toBe(evidence.legacy_freeze_age_ms);
    expect(evidence.evidence_freshness_ms).toBe(5 * 60 * 1_000);
    expect(evidence.last_legacy_project_record).toEqual(
      expect.objectContaining({ project_id: "project-2" }),
    );
    expect(evidence.report_fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const stored = await pg.query<{
      state_fingerprint: string;
      report_fingerprint: string;
      report: { evidence_id: string };
    }>(
      `SELECT state_fingerprint, report_fingerprint, report
       FROM migration_rollback_evidence
       WHERE id = $1`,
      [evidence.evidence_id],
    );
    expect(stored.rows[0]).toEqual({
      state_fingerprint: evidence.state_fingerprint,
      report_fingerprint: evidence.report_fingerprint,
      report: expect.objectContaining({ evidence_id: evidence.evidence_id }),
    });
  });

  it("atomically records human approval and audit evidence with every route reversal", async () => {
    const evidence = await controller.prepare("migration-phase2");
    const approval = await controller.approveAndReverse({
      evidence_id: evidence.evidence_id,
      confirmed_report_fingerprint: evidence.report_fingerprint,
      human_actor_id: "admin-1",
    });

    expect(approval.routes_reversed).toEqual([
      {
        scope_type: "new_projects",
        scope_key: "*",
        previous_route_version: 2,
        new_route_version: 3,
      },
      {
        scope_type: "project",
        scope_key: "project-1",
        previous_route_version: 3,
        new_route_version: 4,
      },
    ]);
    const state = await pg.query<{
      scope_type: string;
      scope_key: string;
      read_mode: string;
      changed_by_actor_type: string;
      changed_by_actor_id: string;
      aggregate_version: number;
    }>(
      `SELECT scope_type, scope_key, read_mode, changed_by_actor_type,
              changed_by_actor_id, aggregate_version
       FROM persistence_routes
       WHERE scope_type IN ('project', 'new_projects')
       ORDER BY scope_type, scope_key`,
    );
    expect(state.rows).toEqual([
      {
        scope_type: "new_projects",
        scope_key: "*",
        read_mode: "legacy",
        changed_by_actor_type: "human",
        changed_by_actor_id: "admin-1",
        aggregate_version: 3,
      },
      {
        scope_type: "project",
        scope_key: "project-1",
        read_mode: "legacy",
        changed_by_actor_type: "human",
        changed_by_actor_id: "admin-1",
        aggregate_version: 4,
      },
    ]);
    const persistence = await pg.query<{
      approvals: number;
      audits: number;
      run_status: string;
    }>(`
      SELECT
        (SELECT count(*)::int FROM migration_rollback_approvals) AS approvals,
        (SELECT count(*)::int FROM audit_events
          WHERE correlation_id LIKE 'phase2-rollback:%') AS audits,
        (SELECT status FROM migration_runs WHERE id = 'migration-phase2') AS run_status
    `);
    expect(persistence.rows[0]).toEqual({ approvals: 1, audits: 3, run_status: "rolled_back" });

    await expect(
      pg.query(
        "UPDATE migration_rollback_approvals SET human_actor_id = 'different' WHERE id = $1",
        [approval.approval_id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pg.query("DELETE FROM migration_rollback_evidence WHERE id = $1", [evidence.evidence_id]),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects stale evidence and rolls back the approval transaction without changing routes", async () => {
    const evidence = await controller.prepare("migration-phase2");
    await pg.exec(`
      UPDATE projects
      SET name = 'One changed after inspection', updated_at = now()
      WHERE id = 'project-1'
    `);

    await expect(
      controller.approveAndReverse({
        evidence_id: evidence.evidence_id,
        confirmed_report_fingerprint: evidence.report_fingerprint,
        human_actor_id: "admin-1",
      }),
    ).rejects.toMatchObject({ code: "evidence_changed" });

    const state = await pg.query<{ relational_routes: number; approvals: number; audits: number }>(`
      SELECT
        (SELECT count(*)::int FROM persistence_routes
          WHERE scope_type IN ('project', 'new_projects') AND read_mode = 'relational')
          AS relational_routes,
        (SELECT count(*)::int FROM migration_rollback_approvals) AS approvals,
        (SELECT count(*)::int FROM audit_events
          WHERE correlation_id LIKE 'phase2-rollback:%') AS audits
    `);
    expect(state.rows[0]).toEqual({ relational_routes: 2, approvals: 0, audits: 0 });
  });

  it("requires an active human admin and the exact immutable report fingerprint", async () => {
    const evidence = await controller.prepare("migration-phase2");
    await expect(
      controller.approveAndReverse({
        evidence_id: evidence.evidence_id,
        confirmed_report_fingerprint: "0".repeat(64),
        human_actor_id: "admin-1",
      }),
    ).rejects.toMatchObject({ code: "fingerprint_mismatch" });
    await expect(
      controller.approveAndReverse({
        evidence_id: evidence.evidence_id,
        confirmed_report_fingerprint: evidence.report_fingerprint,
        human_actor_id: "missing-admin",
      }),
    ).rejects.toMatchObject({ code: "human_admin_required" });
  });

  it("lets the runtime read rollback records but not manufacture evidence or approval", async () => {
    const evidence = await controller.prepare("migration-phase2");
    await pg.exec("SET ROLE norns_app");
    try {
      const readable = await pg.query<{ report_fingerprint: string }>(
        "SELECT report_fingerprint FROM migration_rollback_evidence WHERE id = $1",
        [evidence.evidence_id],
      );
      expect(readable.rows[0]?.report_fingerprint).toBe(evidence.report_fingerprint);
      await expect(
        pg.query(
          `INSERT INTO migration_rollback_approvals (
             id, evidence_id, migration_run_id, human_actor_id,
             confirmed_report_fingerprint, approved_at, routes_reversed
           ) VALUES (
             'forged', $1, 'migration-phase2', 'admin-1', $2, now(),
             '[{"scope_type":"project","scope_key":"project-1"}]'::jsonb
           )`,
          [evidence.evidence_id, evidence.report_fingerprint],
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec("RESET ROLE");
    }
  });

  it("makes identity credential cutover forward-only at both service and database boundaries", async () => {
    await pg.exec(`
      UPDATE persistence_routes
      SET read_mode = 'relational', write_mode = 'relational',
          v2_writes_started_at = now(), aggregate_version = 2,
          changed_at = now()
      WHERE scope_type = 'identity' AND scope_key = '*'
    `);

    await expect(controller.prepare("migration-phase2")).rejects.toMatchObject({
      code: "credential_cutover_forward_only",
    });
    await expect(
      pg.exec(`
        UPDATE persistence_routes
        SET read_mode = 'legacy', write_mode = 'legacy',
            v2_writes_started_at = NULL, aggregate_version = 3,
            changed_at = now()
        WHERE scope_type = 'identity' AND scope_key = '*'
      `),
    ).rejects.toThrow(/forward-only/);
    await expect(
      pg.exec("DELETE FROM persistence_routes WHERE scope_type = 'identity' AND scope_key = '*'"),
    ).rejects.toThrow(/forward-only/);
    await expect(pg.exec("TRUNCATE persistence_routes")).rejects.toThrow(/append-only/);

    const identity = await pg.query<{
      read_mode: string;
      write_mode: string;
      v2_writes_started_at: string | Date | null;
    }>(
      `SELECT read_mode, write_mode, v2_writes_started_at
       FROM persistence_routes
       WHERE scope_type = 'identity' AND scope_key = '*'`,
    );
    expect(identity.rows[0]).toMatchObject({
      read_mode: "relational",
      write_mode: "relational",
    });
    expect(identity.rows[0]?.v2_writes_started_at).not.toBeNull();
  });
});
