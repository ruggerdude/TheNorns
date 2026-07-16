import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PHASE2_PRESERVATION_LOCK_KEY,
  Phase2ApplicationPersistenceLease,
  Phase2MigrationProcessLease,
} from "../src/persistence/migration/migrationLock.js";

const postgresUrl = process.env.V2_POSTGRES_TEST_URL;

describe.skipIf(!postgresUrl)("Phase 2 application/migration PostgreSQL lock", () => {
  let pool: import("pg").Pool;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: postgresUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("refuses exclusive capture while the live application holds its shared lease", async () => {
    const applicationLease = await Phase2ApplicationPersistenceLease.acquire(pool);
    const migration = await pool.connect();
    try {
      await migration.query("BEGIN");
      const blocked = await migration.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
        [PHASE2_PRESERVATION_LOCK_KEY],
      );
      expect(blocked.rows[0]?.acquired).toBe(false);
      await migration.query("ROLLBACK");

      await applicationLease.release();

      await migration.query("BEGIN");
      const acquired = await migration.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
        [PHASE2_PRESERVATION_LOCK_KEY],
      );
      expect(acquired.rows[0]?.acquired).toBe(true);
      await migration.query("ROLLBACK");
    } finally {
      await applicationLease.release();
      migration.release();
    }
  });

  it("pins migration transactions under one exclusive lease and refuses app startup", async () => {
    const migrationLease = await Phase2MigrationProcessLease.acquire(pool);
    try {
      await expect(Phase2ApplicationPersistenceLease.acquire(pool)).rejects.toThrow(
        /migration is active|persistence lease/,
      );
      const firstBackend = await migrationLease.transaction(async (sql) => {
        const result = await sql.query<{ backend: number }>("SELECT pg_backend_pid() AS backend");
        return result.rows[0]?.backend;
      });
      const secondBackend = await migrationLease.transaction(async (sql) => {
        const result = await sql.query<{ backend: number }>("SELECT pg_backend_pid() AS backend");
        return result.rows[0]?.backend;
      });
      expect(firstBackend).toBeTypeOf("number");
      expect(secondBackend).toBe(firstBackend);

      await expect(
        migrationLease.transaction(async (sql) => {
          await sql.query("CREATE TEMP TABLE phase2_rollback_probe (id int)");
          throw new Error("rollback-probe");
        }),
      ).rejects.toThrow("rollback-probe");
      await migrationLease.transaction(async (sql) => {
        const result = await sql.query<{ relation: string | null }>(
          "SELECT to_regclass('pg_temp.phase2_rollback_probe')::text AS relation",
        );
        expect(result.rows[0]?.relation).toBeNull();
      });
    } finally {
      await migrationLease.release();
    }

    const applicationLease = await Phase2ApplicationPersistenceLease.acquire(pool);
    await applicationLease.release();
  });
});
