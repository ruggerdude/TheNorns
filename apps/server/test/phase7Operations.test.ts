import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import { Phase7OperationsService } from "../src/operations/phase7Operations.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

describe.sequential("Phase 7 resilience and cutover controls", () => {
  let pg: PGlite;
  let operations: Phase7OperationsService;

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
        password_hash_scheme, role, status, source
      ) VALUES ('admin-7','admin@example.com','Admin','admin@example.com','Admin',
                'hash','scrypt-v1','admin','active','native');
      INSERT INTO projects (
        id,name,description,status,assignment_policy_ref,verification_policy_ref,budget_policy_ref
      ) VALUES ('project-7','Existing Project','','active','assignment','verification','budget');
    `);
    operations = new Phase7OperationsService(new PGliteTransactionRunner(pg));
  });

  afterEach(async () => pg.close());

  it("records recovery objectives, fences revoked runners, promotes relational authority, and gates retirement", async () => {
    await operations.recordDrill({
      id: "restore-7",
      drill_type: "restore",
      source_revision: "backup-lsn-100",
      target_reference: "restored-database-7",
      started_at: "2026-07-16T20:00:00.000Z",
      completed_at: "2026-07-16T20:04:00.000Z",
      recovery_time_seconds: 240,
      recovery_point_seconds: 0,
      passed: true,
      evidence: [{ manifest_hash: "a".repeat(64), row_counts_match: true }],
      recorded_by: "admin-7",
    });
    for (const drillType of ["chaos", "load", "soak", "runner_fencing", "audit"] as const) {
      await operations.recordDrill({
        id: `${drillType}-7`,
        drill_type: drillType,
        source_revision: "candidate-7",
        target_reference: `test-target:${drillType}`,
        started_at: "2026-07-16T20:10:00.000Z",
        completed_at: "2026-07-16T20:12:00.000Z",
        recovery_time_seconds: 30,
        recovery_point_seconds: 0,
        passed: true,
        evidence: [{ passed: true }],
        recorded_by: "admin-7",
      });
    }

    await operations.revokeRunner({
      runner_id: "runner-7",
      revoked_through_generation: 4,
      reason: "credential rotation",
      revoked_by: "admin-7",
      revoked_at: "2026-07-16T20:15:00.000Z",
    });
    const processor = new Phase4EventProcessor(new PGliteTransactionRunner(pg));
    await expect(
      processor.apply({
        protocol: 1,
        event_seq: 1,
        runner_id: "runner-7",
        generation: 4,
        correlation_id: "correlation-7",
        causation_id: null,
        occurred_at: "2026-07-16T20:16:00.000Z",
        payload: { kind: "heartbeat" },
      }),
    ).rejects.toThrow(/generation is revoked/);
    await expect(
      processor.apply({
        protocol: 1,
        event_seq: 1,
        runner_id: "runner-7",
        generation: 5,
        correlation_id: "correlation-7",
        causation_id: null,
        occurred_at: "2026-07-16T20:17:00.000Z",
        payload: { kind: "heartbeat" },
      }),
    ).resolves.toEqual({ duplicate: false });

    const promote = async (
      id: string,
      cohort_type: "selected" | "new_projects",
      project_id: string | null,
      status: "shadow" | "canary" | "authoritative",
    ) =>
      operations.promoteCutover({
        id,
        cohort_type,
        project_id,
        status,
        reconciliation_material: { clean: true, cohort_type },
        restore_drill_id: "restore-7",
        authorized_by: "admin-7",
        authorized_at: "2026-07-16T20:20:00.000Z",
      });
    for (const status of ["shadow", "canary", "authoritative"] as const) {
      await promote("cohort-project-7", "selected", "project-7", status);
      await promote("cohort-new-7", "new_projects", null, status);
    }
    await expect(operations.assertRelationalAuthoritative()).resolves.toEqual({ projects: 1 });

    await expect(
      operations.authorizeLegacyRetirement({
        id: "retirement-7",
        authorized_by: "admin-7",
        authorized_at: "2026-07-16T20:30:00.000Z",
        retention_window_completed: false,
        restore_drill_id: "restore-7",
        scope: { snapshots: true },
      }),
    ).rejects.toThrow(/retention window/);
    await operations.authorizeLegacyRetirement({
      id: "retirement-7",
      authorized_by: "admin-7",
      authorized_at: "2026-07-16T20:30:00.000Z",
      retention_window_completed: true,
      restore_drill_id: "restore-7",
      scope: { authorization_only: true, destructive_action: false },
    });
    await expect(
      pg.query("UPDATE resilience_drills SET passed=false WHERE id='restore-7'"),
    ).rejects.toThrow(/append-only/);

    const evidence = await pg.query<{
      drills: number;
      authoritative: number;
      retirements: number;
    }>(`SELECT
      (SELECT count(*)::int FROM resilience_drills WHERE passed) AS drills,
      (SELECT count(*)::int FROM v2_cutover_cohorts WHERE status='authoritative') AS authoritative,
      (SELECT count(*)::int FROM legacy_retirement_authorizations) AS retirements`);
    expect(evidence.rows[0]).toEqual({ drills: 6, authoritative: 2, retirements: 1 });
  });
});
