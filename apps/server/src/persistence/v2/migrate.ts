import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PHASE1_V2_MIGRATION_NAME = "0001_refoundation_v2";
export const PHASE1_V2_MIGRATION_URL = new URL(
  "../../../drizzle/0001_refoundation_v2.sql",
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

interface AppliedMigrationRow {
  checksum: string;
}

export async function loadPhase1V2MigrationSql(): Promise<string> {
  return readFile(PHASE1_V2_MIGRATION_URL, "utf8");
}

export function phase1V2MigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

async function executeMigrationBatch(tx: V2MigrationExecutor, sql: string): Promise<void> {
  if (tx.exec) {
    await tx.exec(sql);
    return;
  }
  await tx.query(sql);
}

/**
 * Applies the additive Phase 1 schema exactly once.
 *
 * The checksum guard refuses to treat edited SQL as the already-applied
 * migration. The V2 DDL and its tracking row commit atomically. Existing
 * `norns_state` data is outside this migration and remains untouched.
 */
export async function runPhase1V2Migration(
  database: V2MigrationDatabase,
  migrationSql?: string,
): Promise<V2MigrationResult> {
  const sql = migrationSql ?? (await loadPhase1V2MigrationSql());
  const checksum = phase1V2MigrationChecksum(sql);

  await database.query(
    `CREATE TABLE IF NOT EXISTS norns_schema_migrations (
       name TEXT PRIMARY KEY,
       checksum TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  return database.transaction(async (tx) => {
    const existing = await tx.query<AppliedMigrationRow>(
      "SELECT checksum FROM norns_schema_migrations WHERE name = $1 FOR UPDATE",
      [PHASE1_V2_MIGRATION_NAME],
    );
    const applied = existing.rows[0];
    if (applied) {
      if (applied.checksum !== checksum) {
        throw new Error(
          `migration ${PHASE1_V2_MIGRATION_NAME} checksum mismatch: ` +
            `database=${applied.checksum} source=${checksum}`,
        );
      }
      return {
        name: PHASE1_V2_MIGRATION_NAME,
        checksum,
        applied: false,
      };
    }

    await executeMigrationBatch(tx, sql);
    await tx.query(
      `INSERT INTO norns_schema_migrations (name, checksum)
       VALUES ($1, $2)`,
      [PHASE1_V2_MIGRATION_NAME, checksum],
    );

    return {
      name: PHASE1_V2_MIGRATION_NAME,
      checksum,
      applied: true,
    };
  });
}
