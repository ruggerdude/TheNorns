/**
 * Explicit, offline Phase 2 migration entrypoint.
 *
 * This command never runs during ordinary application startup. The operator
 * must first create a protected database backup, stop every application
 * instance, provision the reviewed `norns_app` role, and supply the recovery
 * and encryption environment variables below.
 */
import { Pool } from "pg";
import { Phase2MigrationProcessLease } from "./persistence/migration/migrationLock.js";
import { Phase2MigrationService } from "./persistence/migration/phase2MigrationService.js";
import { postgresPoolConfig } from "./persistence/postgresConnection.js";
import { NodePgTransactionRunner } from "./persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "./persistence/v2/migrate.js";
import { parseCredentialHmacKey } from "./startup/identityRuntime.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`required Phase 2 environment variable is missing: ${name}`);
  return value;
}

function encryptionKey(
  valueName: string,
  keyIdName: string,
): {
  keyId: string;
  key: Uint8Array;
} {
  const encoded = requiredEnvironment(valueName);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error(`${valueName} must be standard base64`);
  }
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== encoded) {
    throw new Error(`${valueName} must be canonical base64 for exactly 32 bytes`);
  }
  return { keyId: requiredEnvironment(keyIdName), key };
}

const databaseUrl = requiredEnvironment("NORNS_MIGRATION_DATABASE_URL");
const pool = new Pool(postgresPoolConfig(databaseUrl));
let lease: Phase2MigrationProcessLease | undefined;

try {
  lease = await Phase2MigrationProcessLease.acquire(pool);
  const privilegedTransactions = new NodePgTransactionRunner(pool, { mode: "privileged" });
  const migrationDatabase: V2MigrationDatabase = {
    query: async <TRow = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return result.rowCount === null
        ? { rows: result.rows as TRow[] }
        : { rows: result.rows as TRow[], affectedRows: result.rowCount };
    },
    transaction: (work) => privilegedTransactions.transaction(work),
  };
  await runCurrentV2Migrations(migrationDatabase);

  const result = await new Phase2MigrationService(lease).run({
    migration_run_id: requiredEnvironment("NORNS_PHASE2_RUN_ID"),
    backup_provider: process.env.NORNS_PHASE2_BACKUP_PROVIDER?.trim() || "railway",
    backup_reference: requiredEnvironment("NORNS_PHASE2_BACKUP_REFERENCE"),
    application_version: process.env.npm_package_version?.trim() || "0.1.0",
    application_commit:
      process.env.NORNS_APPLICATION_COMMIT?.trim() ||
      process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
      requiredEnvironment("NORNS_APPLICATION_COMMIT"),
    retention_expires_at: requiredEnvironment("NORNS_ARCHIVE_RETENTION_UNTIL"),
    archive_key: encryptionKey("NORNS_ARCHIVE_KEY", "NORNS_ARCHIVE_KEY_ID"),
    credential_key: parseCredentialHmacKey(process.env),
  });

  process.stdout.write(
    `${JSON.stringify({
      migration_run_id: result.migration_run_id,
      status: result.status,
      source_bundle_hash: result.source_bundle_hash,
      projects_archive: result.projects_archive,
      counts: result.counts,
    })}\n`,
  );
} catch (error) {
  const name = error instanceof Error ? error.name : "Phase2MigrationError";
  const message = error instanceof Error ? error.message : "Phase 2 migration failed";
  process.stderr.write(`${name}: ${message}\n`);
  process.exitCode = 1;
} finally {
  await lease?.release();
  await pool.end();
}
