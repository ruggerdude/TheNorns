import type { V2SqlExecutor } from "../v2/database.js";
import { PHASE2_PRESERVATION_LOCK_KEY } from "./migrationLock.js";
import type { LegacySnapshotSource } from "./snapshotCapture.js";

interface LegacySnapshotRow {
  key: string;
  source_text: string;
  updated_at: string | Date;
}

interface DatabaseRecoveryFactsRow {
  database_time: string | Date;
  wal_lsn: string;
  transaction_id: string;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export interface DatabaseRecoveryFacts {
  database_time: string;
  wal_lsn: string;
  transaction_id: string;
}

/**
 * Operates only inside the privileged, pinned Phase 2 transaction.
 * beginCapture() must be the transaction's first application call.
 */
export class SqlLegacySnapshotSourceRepository {
  constructor(private readonly sql: V2SqlExecutor) {}

  async beginCapture(): Promise<void> {
    await this.sql.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const lock = await this.sql.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
      [PHASE2_PRESERVATION_LOCK_KEY],
    );
    if (!lock.rows[0]?.acquired) {
      throw new Error("another Phase 2 preservation checkpoint is already running");
    }
  }

  async databaseRecoveryFacts(): Promise<DatabaseRecoveryFacts> {
    const result = await this.sql.query<DatabaseRecoveryFactsRow>(
      `SELECT transaction_timestamp() AS database_time,
              pg_current_wal_lsn()::text AS wal_lsn,
              txid_current()::text AS transaction_id`,
    );
    const row = result.rows[0];
    if (!row) throw new Error("database did not return recovery checkpoint facts");
    return {
      database_time: iso(row.database_time),
      wal_lsn: row.wal_lsn,
      transaction_id: row.transaction_id,
    };
  }

  async captureAllForUpdate(): Promise<LegacySnapshotSource[]> {
    const result = await this.sql.query<LegacySnapshotRow>(
      `SELECT key, snapshot::text AS source_text, updated_at
       FROM norns_state
       ORDER BY key
       FOR UPDATE`,
    );
    return result.rows.map((row) => ({
      key: row.key,
      source_text: row.source_text,
      updated_at: iso(row.updated_at),
    }));
  }

  async replaceUsersSnapshot(
    expectedSourceText: string,
    sanitizedSnapshotJson: string,
    changedAt: string,
  ): Promise<LegacySnapshotSource> {
    const result = await this.sql.query<LegacySnapshotRow>(
      `UPDATE norns_state
       SET snapshot = $1::jsonb, updated_at = $3
       WHERE key = 'users' AND snapshot::text = $2
       RETURNING key, snapshot::text AS source_text, updated_at`,
      [sanitizedSnapshotJson, expectedSourceText, changedAt],
    );
    const row = result.rows[0];
    if (!row) throw new Error("legacy users snapshot changed after the checkpoint freeze");
    return {
      key: row.key,
      source_text: row.source_text,
      updated_at: iso(row.updated_at),
    };
  }

  async currentSources(): Promise<LegacySnapshotSource[]> {
    const result = await this.sql.query<LegacySnapshotRow>(
      `SELECT key, snapshot::text AS source_text, updated_at
       FROM norns_state
       ORDER BY key`,
    );
    return result.rows.map((row) => ({
      key: row.key,
      source_text: row.source_text,
      updated_at: iso(row.updated_at),
    }));
  }
}
