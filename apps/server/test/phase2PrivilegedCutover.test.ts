import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlPhase2ControlRepository } from "../src/persistence/migration/controlRepository.js";
import { Phase2IdentityCutoverEvidenceRecorder } from "../src/persistence/migration/cutoverEvidence.js";
import type { Phase2MigrationProcessLease } from "../src/persistence/migration/migrationLock.js";
import {
  type Phase2CutoverAuthorizationError,
  SqlPhase2PrivilegedControlRepository,
} from "../src/persistence/migration/privilegedControlRepository.js";
import { buildShadowReadComparison } from "../src/persistence/migration/shadowRead.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const RUN_ID = "migration-phase2-cutover";
const MANIFEST_HASH = "a".repeat(64);
const ADMIN_ID = "admin-cutover";
const MEMBER_ID = "member-cutover";
const PASSWORD_HASH = `${"1".repeat(32)}:${"2".repeat(128)}`;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe.sequential("Phase 2 fenced identity cutover", () => {
  let pg: PGlite;
  let runtime: SqlPhase2ControlRepository;
  let cutover: SqlPhase2PrivilegedControlRepository;
  let evidence: Phase2IdentityCutoverEvidenceRecorder;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE ROLE norns_app NOLOGIN;
      INSERT INTO norns_state (key, snapshot, updated_at) VALUES
        ('users', jsonb_build_object(
          'users', jsonb_build_array(jsonb_build_object(
            'id', '${ADMIN_ID}', 'email', 'admin@example.com',
            'name', 'Admin', 'role', 'admin', 'status', 'active',
            'passwordHash', '${PASSWORD_HASH}', 'inviteToken', NULL,
            'createdAt', '2026-07-16T15:00:00.000Z'
          )),
          'sessions', '[]'::jsonb
        ), '2026-07-16T16:00:00.000Z'),
        ('projects', '{"projects":[]}'::jsonb, '2026-07-16T16:00:01.000Z'),
        ('relay', '{"audit":[]}'::jsonb, '2026-07-16T16:00:02.000Z');
    `);
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    const source = (
      await pg.query<{ source_text: string }>(
        "SELECT snapshot::text AS source_text FROM norns_state WHERE key = 'users'",
      )
    ).rows[0]?.source_text;
    if (!source) throw new Error("cutover test users source is missing");

    await pg.query(
      `INSERT INTO users (
         id, username, display_name, email, name, password_hash,
         password_hash_scheme, role, status, source, source_record_id,
         created_at, updated_at
       ) VALUES
         ($1,'admin@example.com','Admin','admin@example.com','Admin',$2,
          'legacy-scrypt-v0','admin','active','legacy_snapshot',$1,
          '2026-07-16T15:00:00Z','2026-07-16T15:00:00Z'),
         ($3,'member@example.com','Member','member@example.com','Member',$2,
          'legacy-scrypt-v0','member','active','native',NULL,
          '2026-07-16T15:00:00Z','2026-07-16T15:00:00Z')`,
      [ADMIN_ID, PASSWORD_HASH, MEMBER_ID],
    );
    await pg.query(
      `INSERT INTO migration_runs (
         id, migration_name, source_snapshot_hashes, source_counts,
         source_frozen_at, source_manifest_hash, source_application_version,
         source_application_commit, status, started_at, details
       ) VALUES (
         $1,'phase2-cutover','{}'::jsonb,'{}'::jsonb,
         '2026-07-16T16:00:00Z',$2,'0.1.0','candidate','shadowing',
         '2026-07-16T16:00:00Z',$3::jsonb
       )`,
      [
        RUN_ID,
        MANIFEST_HASH,
        JSON.stringify({
          replay_source_exact_hashes: { users: sha256(source) },
          sanitized_users_exact_hash: sha256(source),
        }),
      ],
    );
    await pg.query(
      `INSERT INTO recovery_checkpoints (
         id, migration_run_id, provider, backup_reference, database_time,
         wal_lsn, transaction_id, application_version, application_commit,
         source_manifest_hash, source_frozen_at, verified_at, created_at
       ) VALUES (
         'checkpoint-cutover',$1,'postgres','backup-cutover',
         '2026-07-16T16:00:00Z','0/1','1','0.1.0','candidate',$2,
         '2026-07-16T16:00:00Z','2026-07-16T17:00:00Z','2026-07-16T16:00:00Z'
       )`,
      [RUN_ID, MANIFEST_HASH],
    );
    await pg.query(
      `INSERT INTO migration_steps (
         migration_run_id, step_key, input_hash, status, attempt,
         output_hash, output_counts, started_at, completed_at, updated_at
       ) VALUES (
         $1,'recovery_restore_verification',$2,'succeeded',1,$3,'{}'::jsonb,
         '2026-07-16T17:00:00Z','2026-07-16T17:00:01Z','2026-07-16T17:00:01Z'
       )`,
      [RUN_ID, MANIFEST_HASH, "b".repeat(64)],
    );

    const transactions = new PGliteTransactionRunner(pg);
    runtime = new SqlPhase2ControlRepository(transactions);
    cutover = new SqlPhase2PrivilegedControlRepository(
      transactions as unknown as Phase2MigrationProcessLease,
    );
    evidence = new Phase2IdentityCutoverEvidenceRecorder(RUN_ID, runtime);
  }, 30_000);

  afterEach(async () => {
    await pg.close();
  });

  async function recordGreenEvidence(observedAt = "2099-12-31T23:59:59.000Z"): Promise<void> {
    await evidence.recordPublicUserProjection({
      legacy: [{ id: ADMIN_ID, role: "admin" }],
      relational: [{ role: "admin", id: ADMIN_ID }],
      observed_at: observedAt,
    });
    await evidence.recordRetainedLegacyCredentialRejection({
      satisfied: true,
      observed_at: observedAt,
    });
    await evidence.recordNormalizedSessionRestart({ satisfied: true, observed_at: observedAt });
    await evidence.recordExpiredRevokedRejection({ satisfied: true, observed_at: observedAt });
  }

  async function expectCutoverCode(code: Phase2CutoverAuthorizationError["code"]): Promise<void> {
    await expect(
      cutover.cutoverIdentity({ migration_run_id: RUN_ID, human_actor_id: ADMIN_ID }),
    ).rejects.toMatchObject({ code });
  }

  it("ignores caller time and atomically creates the forward-only relational route", async () => {
    await recordGreenEvidence();
    const route = await cutover.cutoverIdentity({
      migration_run_id: RUN_ID,
      human_actor_id: ADMIN_ID,
    });

    expect(route).toMatchObject({
      scope_type: "identity",
      scope_key: "*",
      read_mode: "relational",
      write_mode: "relational",
      changed_by: { actor_type: "human", actor_id: ADMIN_ID },
      aggregate_version: 1,
    });
    expect(Date.parse(route.changed_at)).toBeLessThan(Date.parse("2099-01-01T00:00:00Z"));
    const state = await pg.query<{
      status: string;
      completed_at: string | null;
      audit_count: number;
      operator_restart_required: boolean;
    }>(
      `SELECT run.status, run.completed_at,
              (SELECT count(*)::int FROM audit_events
               WHERE audit_type = 'persistence.identity_cutover') AS audit_count,
              (SELECT (details->>'operator_restart_required')::boolean
               FROM audit_events
               WHERE audit_type = 'persistence.identity_cutover') AS operator_restart_required
       FROM migration_runs run WHERE run.id = $1`,
      [RUN_ID],
    );
    expect(state.rows[0]).toMatchObject({
      status: "cutover",
      audit_count: 1,
      operator_restart_required: true,
    });
    expect(state.rows[0]?.completed_at).not.toBeNull();
    await expect(
      cutover.cutoverIdentity({ migration_run_id: RUN_ID, human_actor_id: ADMIN_ID }),
    ).resolves.toEqual(route);
  });

  it("refuses stale evidence after the source revision changes even when content is identical", async () => {
    await recordGreenEvidence();
    await pg.query(
      `UPDATE norns_state SET updated_at = updated_at + interval '1 second' WHERE key = 'users'`,
    );
    await expectCutoverCode("current_green_evidence_required");
  });

  it("refuses cutover when source content changes after proof collection", async () => {
    await recordGreenEvidence();
    await pg.query(
      `UPDATE norns_state
       SET snapshot = jsonb_set(
         snapshot, '{sessions}',
         '[{"token":"reusable","userId":"admin-cutover","createdAt":"2026-07-16T18:00:00Z"}]'::jsonb
       ), updated_at = updated_at + interval '1 second'
       WHERE key = 'users'`,
    );
    await expectCutoverCode("source_changed");
  });

  it("cannot use caller-fabricated provenance or a future timestamp to hide a mismatch", async () => {
    await recordGreenEvidence("2026-07-16T18:00:00Z");
    const mismatch = buildShadowReadComparison({
      migration_run_id: RUN_ID,
      scope_type: "identity",
      scope_key: "*",
      operation: "expired-revoked-rejection",
      legacy: { satisfied: true },
      relational: { satisfied: false },
      observed_at: "2099-12-31T23:59:59Z",
    });
    await pg.query(
      `INSERT INTO shadow_read_comparisons (
         id, migration_run_id, scope_type, scope_key, operation,
         legacy_hash, relational_hash, matched, differences,
         source_key, source_manifest_hash, source_exact_hash,
         source_updated_at, observed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,
                 'relay',$10,$11,'2099-01-01Z','2099-12-31Z')`,
      [
        mismatch.id,
        mismatch.migration_run_id,
        mismatch.scope_type,
        mismatch.scope_key,
        mismatch.operation,
        mismatch.legacy_hash,
        mismatch.relational_hash,
        mismatch.matched,
        JSON.stringify(mismatch.differences),
        "f".repeat(64),
        "e".repeat(64),
      ],
    );
    const stored = await pg.query<{
      source_key: string;
      source_manifest_hash: string;
      observed_at: string;
    }>(
      `SELECT source_key, source_manifest_hash, observed_at
       FROM shadow_read_comparisons
       WHERE operation = 'expired-revoked-rejection'
       ORDER BY observed_at DESC LIMIT 1`,
    );
    expect(stored.rows[0]).toMatchObject({
      source_key: "users",
      source_manifest_hash: MANIFEST_HASH,
    });
    expect(Date.parse(stored.rows[0]?.observed_at as string)).toBeLessThan(
      Date.parse("2099-01-01T00:00:00Z"),
    );
    await expectCutoverCode("current_green_evidence_required");
  });

  it("requires the succeeded restore step and verified checkpoint", async () => {
    await recordGreenEvidence();
    await pg.query(
      `UPDATE migration_steps
       SET status = 'failed', output_hash = NULL,
           error_code = 'proof_removed', error_summary = 'test',
           completed_at = transaction_timestamp()
       WHERE migration_run_id = $1
         AND step_key = 'recovery_restore_verification'`,
      [RUN_ID],
    );
    await expectCutoverCode("recovery_not_verified");
  });

  it("requires the migration to be shadowing or ready", async () => {
    await recordGreenEvidence();
    await pg.query("UPDATE migration_runs SET status = 'reconciling' WHERE id = $1", [RUN_ID]);
    await expectCutoverCode("migration_status_not_ready");
  });

  it("requires an active human administrator", async () => {
    await recordGreenEvidence();
    await expect(
      cutover.cutoverIdentity({ migration_run_id: RUN_ID, human_actor_id: MEMBER_ID }),
    ).rejects.toMatchObject({ code: "human_admin_required" });
  });

  it("refuses every open blocking reconciliation finding", async () => {
    await recordGreenEvidence();
    await pg.query(
      `INSERT INTO migration_reconciliation_findings (
         id, migration_run_id, project_id, code, severity, status,
         source_entity_type, source_entity_id, source_fingerprint,
         details, detected_at
       ) VALUES (
         'finding-cutover',$1,NULL,'source_changed_after_freeze','blocking','open',
         'legacy_snapshot','users',$2,'{}'::jsonb,transaction_timestamp()
       )`,
      [RUN_ID, "c".repeat(64)],
    );
    await expectCutoverCode("blocking_findings_open");
    const unchanged = await pg.query<{ status: string; route_count: number }>(
      `SELECT status,
              (SELECT count(*)::int FROM persistence_routes
               WHERE scope_type = 'identity' AND scope_key = '*') AS route_count
       FROM migration_runs WHERE id = $1`,
      [RUN_ID],
    );
    expect(unchanged.rows[0]).toEqual({ status: "shadowing", route_count: 0 });
  });
});
