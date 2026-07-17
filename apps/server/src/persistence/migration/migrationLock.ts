import type { V2SqlExecutor, V2TransactionRunner } from "../v2/database.js";

export const PHASE2_PRESERVATION_LOCK_KEY = "the-norns:phase2:legacy-preservation" as const;

export class Phase2PersistenceLeaseUnavailableError extends Error {
  constructor(readonly holder: "migration" | "application_or_migration") {
    super(
      holder === "migration"
        ? "Phase 2 preservation migration is active; application startup refused"
        : "live application or another Phase 2 migration holds the persistence lease",
    );
    this.name = "Phase2PersistenceLeaseUnavailableError";
  }
}

interface AdvisoryLockQueryResult<TRow> {
  rows: TRow[];
}

export interface AdvisoryLockClient {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<AdvisoryLockQueryResult<TRow>>;
  release(): void;
}

export interface AdvisoryLockPool {
  connect(): Promise<AdvisoryLockClient>;
}

/**
 * The live application holds a shared session lock for as long as it can
 * flush legacy snapshots. Phase 2 capture requests the exclusive transaction
 * form of the same key and therefore fails closed while any app instance is
 * still able to overwrite the frozen source.
 */
export class Phase2ApplicationPersistenceLease {
  private released = false;

  private constructor(private readonly client: AdvisoryLockClient) {}

  static async acquire(pool: AdvisoryLockPool): Promise<Phase2ApplicationPersistenceLease> {
    const client = await pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock_shared(hashtextextended($1, 0)) AS acquired",
        [PHASE2_PRESERVATION_LOCK_KEY],
      );
      if (!result.rows[0]?.acquired) {
        throw new Phase2PersistenceLeaseUnavailableError("migration");
      }
      return new Phase2ApplicationPersistenceLease(client);
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      await this.client.query("SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))", [
        PHASE2_PRESERVATION_LOCK_KEY,
      ]);
    } finally {
      this.client.release();
    }
  }
}

/**
 * Offline migration lease. All Phase 2 transactions can run through this
 * pinned client while its exclusive session lock prevents application startup
 * between identity sanitization, project import, and reconciliation.
 */
export class Phase2MigrationProcessLease implements V2TransactionRunner {
  private released = false;
  private transactionActive = false;

  private constructor(private readonly client: AdvisoryLockClient) {}

  static async acquire(pool: AdvisoryLockPool): Promise<Phase2MigrationProcessLease> {
    const client = await pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [PHASE2_PRESERVATION_LOCK_KEY],
      );
      if (!result.rows[0]?.acquired) {
        throw new Phase2PersistenceLeaseUnavailableError("application_or_migration");
      }
      return new Phase2MigrationProcessLease(client);
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async transaction<T>(work: (tx: V2SqlExecutor) => Promise<T>): Promise<T> {
    if (this.released) throw new Error("Phase 2 migration lease has been released");
    if (this.transactionActive) {
      throw new Error("Phase 2 migration lease does not permit nested transactions");
    }
    this.transactionActive = true;
    const executor: V2SqlExecutor = {
      query: async <TRow = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await this.client.query<TRow>(sql, params);
        return { rows: result.rows };
      },
    };
    try {
      await this.client.query("BEGIN");
      const result = await work(executor);
      await this.client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await this.client.query("ROLLBACK");
      } catch {
        // Preserve the migration failure as the primary error.
      }
      throw error;
    } finally {
      this.transactionActive = false;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    if (this.transactionActive) {
      throw new Error("cannot release the Phase 2 migration lease during a transaction");
    }
    this.released = true;
    try {
      await this.client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        PHASE2_PRESERVATION_LOCK_KEY,
      ]);
    } finally {
      this.client.release();
    }
  }
}
