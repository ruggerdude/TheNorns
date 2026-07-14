// Tier-2 persistence (NORN-024): durable snapshot of relay state to Postgres,
// so the control plane survives a restart / redeploy. This is the MVP shape —
// a single JSONB snapshot per state key, reconstructed on boot via the same
// snapshot()/restore() the in-memory stores already ship and test. The
// normalized Drizzle schema (ADR-001) is the scale follow-on; snapshotting is
// correct and sufficient at single-operator scale. Driver-agnostic: any client
// exposing query(sql, params) -> {rows} works (node-postgres in prod, pglite
// in tests — both are real Postgres engines).
export interface PgClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class PgPersistence {
  constructor(private readonly client: PgClient) {}

  /** Idempotent schema setup — safe to run on every boot. */
  async init(): Promise<void> {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS norns_state (
         key         TEXT PRIMARY KEY,
         snapshot    JSONB NOT NULL,
         updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
  }

  /** Upsert the latest snapshot for a state key (e.g. "relay", "graph"). */
  async save(key: string, snapshotJson: string): Promise<void> {
    await this.client.query(
      `INSERT INTO norns_state (key, snapshot, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = now()`,
      [key, snapshotJson],
    );
  }

  /** Load a state key's snapshot, or null if it has never been persisted. */
  async load(key: string): Promise<string | null> {
    const result = await this.client.query("SELECT snapshot FROM norns_state WHERE key = $1", [
      key,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    // node-postgres returns jsonb as an object; pglite likewise. Re-serialize.
    return JSON.stringify(row.snapshot);
  }
}

/**
 * Wires periodic + shutdown flushes of a snapshot-able store to Postgres.
 * Change-detected (only writes when the snapshot actually differs), so it
 * needs no hooks into the store; also flushes on shutdown so a graceful
 * redeploy loses nothing. The loss window is one flush interval on a hard
 * crash — acceptable at single-operator MVP scale, matching the shipped
 * snapshot/restore durability model.
 */
export class SnapshotFlusher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastWritten: string | null = null;

  constructor(
    private readonly persistence: PgPersistence,
    private readonly key: string,
    private readonly snapshot: () => string,
    private readonly intervalMs = 1000,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.intervalMs);
  }

  async flush(): Promise<void> {
    const current = this.snapshot();
    if (current === this.lastWritten) return;
    await this.persistence.save(this.key, current);
    this.lastWritten = current;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush(); // final durable write on shutdown
  }
}
