import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PHASE1_V2_MIGRATION_NAME = "0001_refoundation_v2";
export const PHASE1_V2_MIGRATION_URL = new URL(
  "../../../drizzle/0001_refoundation_v2.sql",
  import.meta.url,
);
export const PHASE2_PRESERVATION_MIGRATION_NAME = "0002_preservation_migration";
export const PHASE2_PRESERVATION_MIGRATION_URL = new URL(
  "../../../drizzle/0002_preservation_migration.sql",
  import.meta.url,
);
export const PHASE3_SOURCE_BINDINGS_MIGRATION_NAME = "0003_phase3_source_bindings";
export const PHASE3_SOURCE_BINDINGS_MIGRATION_URL = new URL(
  "../../../drizzle/0003_phase3_source_bindings.sql",
  import.meta.url,
);
export const PHASE5_ATTENTION_MIGRATION_NAME = "0004_phase5_attention";
export const PHASE5_ATTENTION_MIGRATION_URL = new URL(
  "../../../drizzle/0004_phase5_attention.sql",
  import.meta.url,
);
export const PHASE6_COORDINATION_MIGRATION_NAME = "0005_phase6_coordination";
export const PHASE6_COORDINATION_MIGRATION_URL = new URL(
  "../../../drizzle/0005_phase6_coordination.sql",
  import.meta.url,
);
export const PHASE7_HARDENING_MIGRATION_NAME = "0006_phase7_hardening";
export const PHASE7_HARDENING_MIGRATION_URL = new URL(
  "../../../drizzle/0006_phase7_hardening.sql",
  import.meta.url,
);

export interface V2MigrationQueryResult<TRow = Record<string, unknown>> {
  rows: TRow[];
  affectedRows?: number;
}

export interface V2MigrationExecutor {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<V2MigrationQueryResult<TRow>>;
  exec?(sql: string): Promise<unknown>;
}

export interface V2MigrationDatabase extends V2MigrationExecutor {
  transaction<T>(work: (tx: V2MigrationExecutor) => Promise<T>): Promise<T>;
}

export interface V2MigrationResult {
  name: string;
  checksum: string;
  applied: boolean;
}

export interface V2MigrationSource {
  name: string;
  sql: string;
}

interface AppliedMigrationRow {
  checksum: string;
}

export async function loadPhase1V2MigrationSql(): Promise<string> {
  return readFile(PHASE1_V2_MIGRATION_URL, "utf8");
}

export async function loadPhase2PreservationMigrationSql(): Promise<string> {
  return readFile(PHASE2_PRESERVATION_MIGRATION_URL, "utf8");
}

export async function loadPhase3SourceBindingsMigrationSql(): Promise<string> {
  return readFile(PHASE3_SOURCE_BINDINGS_MIGRATION_URL, "utf8");
}

export async function loadPhase5AttentionMigrationSql(): Promise<string> {
  return readFile(PHASE5_ATTENTION_MIGRATION_URL, "utf8");
}

export async function loadPhase6CoordinationMigrationSql(): Promise<string> {
  return readFile(PHASE6_COORDINATION_MIGRATION_URL, "utf8");
}

export async function loadPhase7HardeningMigrationSql(): Promise<string> {
  return readFile(PHASE7_HARDENING_MIGRATION_URL, "utf8");
}

export function v2MigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export const phase1V2MigrationChecksum = v2MigrationChecksum;

async function executeMigrationBatch(tx: V2MigrationExecutor, sql: string): Promise<void> {
  if (tx.exec) {
    await tx.exec(sql);
    return;
  }
  await tx.query(sql);
}

/**
 * Applies an ordered forward-only migration list.
 *
 * Every migration and its tracking row commit atomically. An already-applied
 * migration is replay-safe only when its source checksum is unchanged.
 */
export async function runV2Migrations(
  database: V2MigrationDatabase,
  migrations: readonly V2MigrationSource[],
): Promise<V2MigrationResult[]> {
  await database.query(
    `CREATE TABLE IF NOT EXISTS norns_schema_migrations (
       name TEXT PRIMARY KEY,
       checksum TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const results: V2MigrationResult[] = [];
  for (const migration of migrations) {
    const checksum = v2MigrationChecksum(migration.sql);
    const result = await database.transaction(async (tx) => {
      const existing = await tx.query<AppliedMigrationRow>(
        "SELECT checksum FROM norns_schema_migrations WHERE name = $1 FOR UPDATE",
        [migration.name],
      );
      const applied = existing.rows[0];
      if (applied) {
        if (applied.checksum !== checksum) {
          throw new Error(
            `migration ${migration.name} checksum mismatch: ` +
              `database=${applied.checksum} source=${checksum}`,
          );
        }
        return {
          name: migration.name,
          checksum,
          applied: false,
        };
      }

      await executeMigrationBatch(tx, migration.sql);
      await tx.query(
        `INSERT INTO norns_schema_migrations (name, checksum)
         VALUES ($1, $2)`,
        [migration.name, checksum],
      );

      return {
        name: migration.name,
        checksum,
        applied: true,
      };
    });
    results.push(result);
  }
  return results;
}

/**
 * Backward-compatible Phase 1 wrapper used by the frozen Phase 1 evidence.
 */
export async function runPhase1V2Migration(
  database: V2MigrationDatabase,
  migrationSql?: string,
): Promise<V2MigrationResult> {
  const [result] = await runV2Migrations(database, [
    {
      name: PHASE1_V2_MIGRATION_NAME,
      sql: migrationSql ?? (await loadPhase1V2MigrationSql()),
    },
  ]);
  if (!result) throw new Error("Phase 1 migration runner produced no result");
  return result;
}

export async function runPhase2PreservationMigration(
  database: V2MigrationDatabase,
  migrationSql?: string,
): Promise<V2MigrationResult> {
  const [result] = await runV2Migrations(database, [
    {
      name: PHASE2_PRESERVATION_MIGRATION_NAME,
      sql: migrationSql ?? (await loadPhase2PreservationMigrationSql()),
    },
  ]);
  if (!result) throw new Error("Phase 2 migration runner produced no result");
  return result;
}

export async function runCurrentV2Migrations(
  database: V2MigrationDatabase,
): Promise<V2MigrationResult[]> {
  return runV2Migrations(database, [
    {
      name: PHASE1_V2_MIGRATION_NAME,
      sql: await loadPhase1V2MigrationSql(),
    },
    {
      name: PHASE2_PRESERVATION_MIGRATION_NAME,
      sql: await loadPhase2PreservationMigrationSql(),
    },
    {
      name: PHASE3_SOURCE_BINDINGS_MIGRATION_NAME,
      sql: await loadPhase3SourceBindingsMigrationSql(),
    },
    {
      name: PHASE5_ATTENTION_MIGRATION_NAME,
      sql: await loadPhase5AttentionMigrationSql(),
    },
    {
      name: PHASE6_COORDINATION_MIGRATION_NAME,
      sql: await loadPhase6CoordinationMigrationSql(),
    },
    {
      name: PHASE7_HARDENING_MIGRATION_NAME,
      sql: await loadPhase7HardeningMigrationSql(),
    },
  ]);
}
