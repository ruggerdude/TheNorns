import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import { SqlPhase2CheckpointRepository } from "../src/persistence/migration/checkpointRepository.js";
import {
  Phase2RestoreVerificationError,
  SqlPhase2RecoveryVerificationRepository,
  readPostgresDatabaseIdentity,
  verifyRestoredLegacySources,
} from "../src/persistence/migration/restoreVerification.js";
import {
  type LegacyRecoveryCheckpoint,
  buildLegacyRecoveryCheckpoint,
} from "../src/persistence/migration/snapshotCapture.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const ARCHIVE_KEY = {
  keyId: "phase2-restore-key",
  key: Buffer.alloc(32, 73),
};
const MIGRATION_RUN_ID = "restore-run";
const CAPTURED_AT = "2026-07-16T20:00:00.000Z";

function exact(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface RestoredFixture {
  database: PGlite;
  sources: { key: string; source_text: string; updated_at: string }[];
  evidence: {
    exact_text_hashes: Record<string, string>;
    semantic_hashes: Record<string, string>;
  };
}

describe("Phase 2 restored legacy source verification", () => {
  const databases: PGlite[] = [];

  function database(): PGlite {
    const pg = new PGlite();
    databases.push(pg);
    return pg;
  }

  async function restoredFixture(): Promise<RestoredFixture> {
    const restored = database();
    await restored.exec(`
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL
      );
      INSERT INTO norns_state (key, snapshot) VALUES
        ('projects', '{"projects":[]}'::jsonb),
        ('relay', '{"audit":[],"commands":{}}'::jsonb),
        ('users', '{"invitations":[],"sessions":[],"users":[]}'::jsonb);
    `);
    const rows = await restored.query<{ key: string; source_text: string }>(
      "SELECT key, snapshot::text AS source_text FROM norns_state ORDER BY key",
    );
    const sources = rows.rows.map((row, index) => ({
      ...row,
      updated_at: new Date(Date.parse(CAPTURED_AT) - (index + 1) * 1_000).toISOString(),
    }));
    return {
      database: restored,
      sources,
      evidence: {
        exact_text_hashes: Object.fromEntries(
          rows.rows.map((row) => [row.key, exact(row.source_text)]),
        ),
        semantic_hashes: Object.fromEntries(
          rows.rows.map((row) => [row.key, canonicalSha256(JSON.parse(row.source_text))]),
        ),
      },
    };
  }

  function checkpoint(sources: RestoredFixture["sources"]): LegacyRecoveryCheckpoint {
    let nonce = 0;
    return buildLegacyRecoveryCheckpoint({
      migration_run_id: MIGRATION_RUN_ID,
      source_frozen_at: CAPTURED_AT,
      recovery_marker: {
        provider: "test",
        backup_reference: "backup-restore",
        database_time: CAPTURED_AT,
        wal_lsn: "0/1",
        transaction_id: "1",
        application_version: "0.1.0",
        application_commit: "test-commit",
      },
      retention_expires_at: "2026-08-16T20:00:00.000Z",
      sources,
      encryption_key: ARCHIVE_KEY,
      random_bytes: (size) => Buffer.alloc(size, ++nonce),
    });
  }

  async function liveCheckpoint(
    recoveryCheckpoint: LegacyRecoveryCheckpoint,
  ): Promise<{ database: PGlite; transactions: PGliteTransactionRunner }> {
    const live = database();
    await live.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await runCurrentV2Migrations(live as unknown as V2MigrationDatabase);
    const transactions = new PGliteTransactionRunner(live);
    await transactions.transaction((sql) =>
      new SqlPhase2CheckpointRepository(sql).insertCheckpoint("phase2_restore", recoveryCheckpoint),
    );
    return { database: live, transactions };
  }

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((pg) => pg.close()));
  });

  it("proves distinct-target identity, migration-run absence, and every restored source hash", async () => {
    const fixture = await restoredFixture();
    const live = database();
    const liveIdentity = await readPostgresDatabaseIdentity(live);

    const verification = await verifyRestoredLegacySources(fixture.database, fixture.evidence, {
      migration_run_id: MIGRATION_RUN_ID,
      live_database_identity: liveIdentity,
    });

    expect(verification).toEqual({
      source_keys: ["projects", "relay", "users"],
      exact_text_hashes: fixture.evidence.exact_text_hashes,
      semantic_hashes: fixture.evidence.semantic_hashes,
      restored_database_identity: await readPostgresDatabaseIdentity(fixture.database),
      checked_migration_run_id: MIGRATION_RUN_ID,
      migration_run_absent: true,
      verified: true,
    });
  });

  it("fails closed on missing keys or any exact/semantic mismatch", async () => {
    const fixture = await restoredFixture();
    const liveIdentity = await readPostgresDatabaseIdentity(database());

    await expect(
      verifyRestoredLegacySources(
        fixture.database,
        {
          ...fixture.evidence,
          exact_text_hashes: {
            ...fixture.evidence.exact_text_hashes,
            users: "0".repeat(64),
          },
        },
        { migration_run_id: MIGRATION_RUN_ID, live_database_identity: liveIdentity },
      ),
    ).rejects.toThrow(Phase2RestoreVerificationError);

    await expect(
      verifyRestoredLegacySources(
        fixture.database,
        {
          exact_text_hashes: {
            ...fixture.evidence.exact_text_hashes,
            graph: "1".repeat(64),
          },
          semantic_hashes: fixture.evidence.semantic_hashes,
        },
        { migration_run_id: MIGRATION_RUN_ID, live_database_identity: liveIdentity },
      ),
    ).rejects.toThrow(/different source keys/);
  });

  it("rejects the live database as its own restore target and rejects a restored current run", async () => {
    const fixture = await restoredFixture();
    const sameIdentity = await readPostgresDatabaseIdentity(fixture.database);
    await expect(
      verifyRestoredLegacySources(fixture.database, fixture.evidence, {
        migration_run_id: MIGRATION_RUN_ID,
        live_database_identity: sameIdentity,
      }),
    ).rejects.toThrow(/same PostgreSQL database/);

    const distinctLiveIdentity = await readPostgresDatabaseIdentity(database());
    await fixture.database.exec(`
      CREATE TABLE migration_runs (id TEXT PRIMARY KEY);
      INSERT INTO migration_runs (id) VALUES ('restore-run');
    `);
    await expect(
      verifyRestoredLegacySources(fixture.database, fixture.evidence, {
        migration_run_id: MIGRATION_RUN_ID,
        live_database_identity: distinctLiveIdentity,
      }),
    ).rejects.toThrow(/contains the current migration run/);
  });

  it("decrypts and validates every real archive before stamping the live checkpoint once", async () => {
    const fixture = await restoredFixture();
    const recoveryCheckpoint = checkpoint(fixture.sources);
    const live = await liveCheckpoint(recoveryCheckpoint);
    const verification = await verifyRestoredLegacySources(fixture.database, fixture.evidence, {
      migration_run_id: MIGRATION_RUN_ID,
      live_database_identity: await readPostgresDatabaseIdentity(live.database),
    });
    const repository = new SqlPhase2RecoveryVerificationRepository(live.transactions);

    await expect(
      repository.record(MIGRATION_RUN_ID, verification, {
        keyId: ARCHIVE_KEY.keyId,
        key: Buffer.alloc(32, 74),
      }),
    ).rejects.toThrow(/encrypted archive authentication failed/);
    await expect(
      live.database.query<{ verified: boolean }>(
        `SELECT verified_at IS NOT NULL AS verified
         FROM recovery_checkpoints
         WHERE migration_run_id = 'restore-run'`,
      ),
    ).resolves.toMatchObject({ rows: [{ verified: false }] });

    const first = await repository.record(MIGRATION_RUN_ID, verification, ARCHIVE_KEY);
    expect(first).toMatchObject({
      migration_run_id: MIGRATION_RUN_ID,
      source_manifest_hash: recoveryCheckpoint.manifest.source_bundle_hash,
      restore_database_proof_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      archive_cipher_proof_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      archive_count: 3,
      replayed: false,
    });
    await expect(repository.record(MIGRATION_RUN_ID, verification, ARCHIVE_KEY)).resolves.toEqual({
      ...first,
      replayed: true,
    });

    const stored = await live.database.query<{
      checkpoint_verified: boolean;
      verified_archives: number;
      verification_steps: number;
      access_events: number;
    }>(
      `SELECT
         (SELECT verified_at IS NOT NULL FROM recovery_checkpoints
          WHERE migration_run_id = 'restore-run') AS checkpoint_verified,
         (SELECT count(*)::int FROM legacy_snapshot_archives
          WHERE migration_run_id = 'restore-run'
            AND status = 'verified' AND verified_at IS NOT NULL) AS verified_archives,
         (SELECT count(*)::int FROM migration_steps
          WHERE migration_run_id = 'restore-run'
            AND step_key = 'recovery_restore_verification'
            AND status = 'succeeded') AS verification_steps,
         (SELECT count(*)::int FROM legacy_archive_access_events
          WHERE correlation_id = 'phase2-restore-verification:restore-run'
            AND operation = 'verify' AND outcome = 'allowed') AS access_events`,
    );
    expect(stored.rows[0]).toEqual({
      checkpoint_verified: true,
      verified_archives: 3,
      verification_steps: 1,
      access_events: 3,
    });
  });

  it("rolls back every verification stamp when any encrypted archive is tampered", async () => {
    const fixture = await restoredFixture();
    const recoveryCheckpoint = checkpoint(fixture.sources);
    const usersArchive = recoveryCheckpoint.archives.find(
      (archive) => archive.source_key === "users",
    );
    if (!usersArchive) throw new Error("users archive fixture disappeared");
    const ciphertext = Buffer.from(usersArchive.encrypted.ciphertext_base64, "base64");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    usersArchive.encrypted.ciphertext_base64 = ciphertext.toString("base64");

    const live = await liveCheckpoint(recoveryCheckpoint);
    const verification = await verifyRestoredLegacySources(fixture.database, fixture.evidence, {
      migration_run_id: MIGRATION_RUN_ID,
      live_database_identity: await readPostgresDatabaseIdentity(live.database),
    });
    await expect(
      new SqlPhase2RecoveryVerificationRepository(live.transactions).record(
        MIGRATION_RUN_ID,
        verification,
        ARCHIVE_KEY,
      ),
    ).rejects.toThrow(/encrypted archive authentication failed: users/);

    const stored = await live.database.query<{
      checkpoint_verified: boolean;
      verified_archives: number;
      verification_steps: number;
      verification_events: number;
    }>(
      `SELECT
         (SELECT verified_at IS NOT NULL FROM recovery_checkpoints
          WHERE migration_run_id = 'restore-run') AS checkpoint_verified,
         (SELECT count(*)::int FROM legacy_snapshot_archives
          WHERE migration_run_id = 'restore-run' AND status = 'verified') AS verified_archives,
         (SELECT count(*)::int FROM migration_steps
          WHERE migration_run_id = 'restore-run'
            AND step_key = 'recovery_restore_verification') AS verification_steps,
         (SELECT count(*)::int FROM legacy_archive_access_events
          WHERE correlation_id = 'phase2-restore-verification:restore-run'
            AND operation = 'verify') AS verification_events`,
    );
    expect(stored.rows[0]).toEqual({
      checkpoint_verified: false,
      verified_archives: 0,
      verification_steps: 0,
      verification_events: 0,
    });
  });
});
