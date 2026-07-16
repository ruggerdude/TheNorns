import {
  V2PersistenceRoute,
  type V2PersistenceRouteT,
  V2ShadowReadComparison,
  type V2ShadowReadComparisonT,
} from "@norns/contracts";
import type { V2SqlExecutor, V2TransactionRunner } from "../v2/database.js";

interface PersistenceRouteRow {
  scope_type: V2PersistenceRouteT["scope_type"];
  scope_key: string;
  read_mode: V2PersistenceRouteT["read_mode"];
  write_mode: V2PersistenceRouteT["write_mode"];
  migration_run_id: string | null;
  aggregate_version: number;
  changed_by_actor_type: V2PersistenceRouteT["changed_by"]["actor_type"];
  changed_by_actor_id: string | null;
  changed_at: string | Date;
  v2_writes_started_at: string | Date | null;
  rollback_window_until: string | Date | null;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function routeFromRow(row: PersistenceRouteRow): V2PersistenceRouteT {
  return V2PersistenceRoute.parse({
    schema_version: 2,
    scope_type: row.scope_type,
    scope_key: row.scope_key,
    read_mode: row.read_mode,
    write_mode: row.write_mode,
    migration_run_id: row.migration_run_id,
    aggregate_version: Number(row.aggregate_version),
    changed_by: {
      actor_type: row.changed_by_actor_type,
      actor_id: row.changed_by_actor_id,
    },
    changed_at: iso(row.changed_at),
    v2_writes_started_at: row.v2_writes_started_at === null ? null : iso(row.v2_writes_started_at),
    rollback_window_until:
      row.rollback_window_until === null ? null : iso(row.rollback_window_until),
  });
}

async function readRoute(
  sql: V2SqlExecutor,
  scopeType: V2PersistenceRouteT["scope_type"],
  scopeKey: string,
): Promise<V2PersistenceRouteT | null> {
  const result = await sql.query<PersistenceRouteRow>(
    `SELECT scope_type, scope_key, read_mode, write_mode, migration_run_id,
            aggregate_version, changed_by_actor_type, changed_by_actor_id,
            changed_at, v2_writes_started_at, rollback_window_until
     FROM persistence_routes
     WHERE scope_type = $1 AND scope_key = $2`,
    [scopeType, scopeKey],
  );
  const row = result.rows[0];
  return row ? routeFromRow(row) : null;
}

export class SqlPhase2ControlRepository {
  constructor(private readonly transactions: V2TransactionRunner) {}

  async findRoute(
    scopeType: V2PersistenceRouteT["scope_type"],
    scopeKey: string,
  ): Promise<V2PersistenceRouteT | null> {
    return this.transactions.transaction((sql) => readRoute(sql, scopeType, scopeKey));
  }

  async recordShadowComparison(comparison: V2ShadowReadComparisonT): Promise<void> {
    const validated = V2ShadowReadComparison.parse(comparison);
    await this.transactions.transaction(async (sql) => {
      const inserted = await sql.query<{
        source_key: string;
        source_manifest_hash: string;
        source_exact_hash: string;
        details: Record<string, unknown>;
      }>(
        `INSERT INTO shadow_read_comparisons (
           id, migration_run_id, scope_type, scope_key, operation,
           legacy_hash, relational_hash, matched, differences, observed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         RETURNING source_key, source_manifest_hash, source_exact_hash,
           (SELECT details FROM migration_runs
             WHERE id = shadow_read_comparisons.migration_run_id) AS details`,
        [
          validated.id,
          validated.migration_run_id,
          validated.scope_type,
          validated.scope_key,
          validated.operation,
          validated.legacy_hash,
          validated.relational_hash,
          validated.matched,
          JSON.stringify(validated.differences),
          validated.observed_at,
        ],
      );
      const bound = inserted.rows[0];
      const expectedHashes = bound?.details?.replay_source_exact_hashes;
      const expectedHash =
        expectedHashes !== null &&
        typeof expectedHashes === "object" &&
        !Array.isArray(expectedHashes) &&
        bound
          ? (expectedHashes as Record<string, unknown>)[bound.source_key]
          : undefined;
      if (
        !bound ||
        !/^[a-f0-9]{64}$/.test(bound.source_manifest_hash) ||
        typeof expectedHash !== "string" ||
        expectedHash !== bound.source_exact_hash
      ) {
        throw new Error(
          "shadow evidence source does not match the migration's frozen replay manifest",
        );
      }
    });
  }
}
