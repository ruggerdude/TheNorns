export interface V2QueryResult<TRow> {
  rows: TRow[];
  affectedRows?: number;
}

export interface V2SqlExecutor {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<V2QueryResult<TRow>>;
}

export interface V2TransactionRunner {
  transaction<T>(work: (tx: V2SqlExecutor) => Promise<T>): Promise<T>;
}

export interface PGliteTransactionLike {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<V2QueryResult<TRow>>;
}

export interface PGliteDatabaseLike extends V2SqlExecutor {
  transaction<T>(work: (tx: PGliteTransactionLike) => Promise<T>): Promise<T>;
}

export interface NodePgQueryResult<TRow> {
  rows: TRow[];
  rowCount: number | null;
}

export interface NodePgClientLike {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<NodePgQueryResult<TRow>>;
  release(): void;
}

export interface NodePgPoolLike {
  connect(): Promise<NodePgClientLike>;
}

export type NodePgTransactionAccess = { mode: "privileged" } | { mode: "runtime"; role: string };

function quotePostgresIdentifier(identifier: string): string {
  if (identifier.trim().length === 0) {
    throw new Error("PostgreSQL role identifier must not be empty");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Transaction adapter used by the Phase 1 PGlite verification suite.
 *
 * Production node-postgres wiring deliberately remains separate: Pool.query
 * cannot safely host BEGIN/COMMIT because successive calls may use different
 * connections. A production adapter must check out one PoolClient for the
 * whole callback.
 */
export class PGliteTransactionRunner implements V2TransactionRunner {
  constructor(private readonly database: PGliteDatabaseLike) {}

  transaction<T>(work: (tx: V2SqlExecutor) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => work(tx));
  }
}

/**
 * Production node-postgres adapter. The callback remains pinned to one
 * checked-out client for BEGIN through COMMIT/ROLLBACK; Pool.query must not be
 * substituted because successive calls may use different connections.
 */
export class NodePgTransactionRunner implements V2TransactionRunner {
  constructor(
    private readonly pool: NodePgPoolLike,
    private readonly access: NodePgTransactionAccess,
  ) {}

  async transaction<T>(work: (tx: V2SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const executor: V2SqlExecutor = {
      query: async <TRow = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await client.query<TRow>(sql, params);
        return result.rowCount === null
          ? { rows: result.rows }
          : { rows: result.rows, affectedRows: result.rowCount };
      },
    };

    try {
      await client.query("BEGIN");
      if (this.access.mode === "runtime") {
        await client.query(`SET LOCAL ROLE ${quotePostgresIdentifier(this.access.role)}`);
      }
      const result = await work(executor);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the application/transaction failure as the primary cause.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export function affectedRows(result: V2QueryResult<Record<string, unknown>>): number {
  return result.affectedRows ?? result.rows.length;
}

/** Postgres deadlock (40P01) / serialization failure (40001): safe to retry. */
export function isTransientPgError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "40P01" || code === "40001";
}

/**
 * Re-run an IDEMPOTENT operation on a transient Postgres error. A deadlock
 * between a human action and a background scanner is a scheduling accident,
 * not a conflict the human should see and re-click — Postgres already picked a
 * victim and rolled it back; the caller just needs to go again. Only for
 * operations that are safe to repeat (idempotency-keyed sagas).
 */
export async function withTransientPgRetry<T>(
  run: () => Promise<T>,
  options: { attempts?: number; backoffMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const backoffMs = options.backoffMs ?? 200;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isTransientPgError(error) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
}
