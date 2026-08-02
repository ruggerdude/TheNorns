/**
 * Additive-migration operator entrypoint.
 *
 * Applies any not-yet-applied forward migrations from the current build's
 * ordered list (`runCurrentV2Migrations`) against DATABASE_URL, then exits.
 * Safe properties: each migration commits atomically with its tracking row;
 * already-applied migrations are checksum-verified and skipped; a changed
 * checksum aborts rather than re-running.
 *
 * This is ONLY for additive schema changes (new tables/columns). Anything
 * involving data transformation, cutover, or archives must go through the
 * full Phase 2 ceremony in `phase2.ts` per the migration runbook.
 *
 * Usage (requires a database connection with DDL/owner privileges):
 *   On deployments where the application service holds a restricted runtime role,
 *   this script cannot be run from that service. See DEPLOY.md for the correct
 *   procedure to apply migrations in that case.
 *   node apps/server/dist/applyMigrations.js
 */
import { Pool } from "pg";
import { postgresPoolConfig } from "./persistence/postgresConnection.js";
import { NodePgTransactionRunner } from "./persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "./persistence/v2/migrate.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool(postgresPoolConfig(databaseUrl));
const privileged = new NodePgTransactionRunner(pool, { mode: "privileged" });
const database: V2MigrationDatabase = {
  query: async <TRow = Record<string, unknown>>(sql: string, params?: unknown[]) => {
    const result = await pool.query(sql, params);
    return result.rowCount === null
      ? { rows: result.rows as TRow[] }
      : { rows: result.rows as TRow[], affectedRows: result.rowCount };
  },
  transaction: (work) => privileged.transaction(work),
};

try {
  const results = await runCurrentV2Migrations(database);
  for (const r of results) {
    console.log(`${r.name}: ${r.applied ? "APPLIED" : "already applied"}`);
  }
  const appliedCount = results.filter((r) => r.applied).length;
  console.log(`done — ${appliedCount} newly applied, ${results.length - appliedCount} unchanged`);
} finally {
  await pool.end();
}
