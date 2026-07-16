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
  constructor(private readonly pool: NodePgPoolLike) {}

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
