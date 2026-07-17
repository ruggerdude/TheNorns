/**
 * Offline recovery-drill recorder.
 *
 * `NORNS_RESTORED_DATABASE_URL` must address a separate database restored from
 * the backup named at Phase 2 checkpoint capture. The command compares that
 * database's legacy rows with live checkpoint evidence, then stamps the live
 * checkpoint exactly once. It never changes cutover routing.
 */
import { Pool } from "pg";
import { Phase2MigrationProcessLease } from "./persistence/migration/migrationLock.js";
import {
  SqlPhase2RecoveryVerificationRepository,
  readPostgresDatabaseIdentity,
  verifyRestoredLegacySources,
} from "./persistence/migration/restoreVerification.js";
import { postgresPoolConfig } from "./persistence/postgresConnection.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`required recovery environment variable is missing: ${name}`);
  return value;
}

function archiveEncryptionKey(): { keyId: string; key: Uint8Array } {
  const encoded = requiredEnvironment("NORNS_ARCHIVE_KEY");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("NORNS_ARCHIVE_KEY must be standard base64");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== encoded) {
    throw new Error("NORNS_ARCHIVE_KEY must be canonical base64 for exactly 32 bytes");
  }
  return { keyId: requiredEnvironment("NORNS_ARCHIVE_KEY_ID"), key };
}

function poolFor(databaseUrl: string): Pool {
  return new Pool(postgresPoolConfig(databaseUrl));
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const livePool = poolFor(requiredEnvironment("NORNS_MIGRATION_DATABASE_URL"));
const restoredPool = poolFor(requiredEnvironment("NORNS_RESTORED_DATABASE_URL"));
const migrationRunId = requiredEnvironment("NORNS_PHASE2_RUN_ID");
const archiveKey = archiveEncryptionKey();
let lease: Phase2MigrationProcessLease | undefined;

try {
  lease = await Phase2MigrationProcessLease.acquire(livePool);
  const liveEvidence = await lease.transaction(async (sql) => {
    const result = await sql.query<{
      source_snapshot_hashes: Record<string, string>;
      details: Record<string, unknown>;
    }>(
      `SELECT source_snapshot_hashes, details
       FROM migration_runs
       WHERE id = $1`,
      [migrationRunId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Phase 2 migration run was not found");
    return {
      checkpoint: {
        exact_text_hashes: record(row.details.source_exact_text_hashes) as Record<string, string>,
        semantic_hashes: row.source_snapshot_hashes,
      },
      database_identity: await readPostgresDatabaseIdentity(sql),
    };
  });
  const verification = await verifyRestoredLegacySources(
    {
      query: async <TRow = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await restoredPool.query(sql, params);
        return result.rowCount === null
          ? { rows: result.rows as TRow[] }
          : { rows: result.rows as TRow[], affectedRows: result.rowCount };
      },
    },
    liveEvidence.checkpoint,
    {
      migration_run_id: migrationRunId,
      live_database_identity: liveEvidence.database_identity,
    },
  );
  const recorded = await new SqlPhase2RecoveryVerificationRepository(lease).record(
    migrationRunId,
    verification,
    archiveKey,
  );
  process.stdout.write(`${JSON.stringify(recorded)}\n`);
} catch (error) {
  const name = error instanceof Error ? error.name : "Phase2RestoreVerificationError";
  const message = error instanceof Error ? error.message : "Phase 2 restore verification failed";
  process.stderr.write(`${name}: ${message}\n`);
  process.exitCode = 1;
} finally {
  await lease?.release();
  await livePool.end();
  await restoredPool.end();
}
