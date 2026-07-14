// Tier-2 persistence (NORN-024): verified against pglite — a real Postgres
// engine in-process. Proves the control-plane survives a restart: state
// written by one store instance is reconstructed by a fresh instance pointed
// at the same database, with full fidelity.
import { PGlite } from "@electric-sql/pglite";
import type { EventEnvelopeT } from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PgClient, PgPersistence, SnapshotFlusher } from "../src/persistence/pg.js";
import { RelayStores } from "../src/stores.js";

let pg: PGlite;
let client: PgClient;

beforeEach(async () => {
  pg = new PGlite(); // ephemeral in-memory Postgres
  client = { query: (sql, params) => pg.query(sql, params ?? []) as ReturnType<PgClient["query"]> };
});

afterEach(async () => {
  await pg.close();
});

function event(runnerId: string, seq: number): EventEnvelopeT {
  return {
    protocol: 1,
    event_seq: seq,
    runner_id: runnerId,
    generation: 1,
    correlation_id: "corr",
    causation_id: null,
    occurred_at: "2026-07-14T00:00:00.000Z",
    payload: { kind: "heartbeat" },
  };
}

describe("Tier-2 postgres persistence", () => {
  it("reconstructs relay state across a simulated restart", async () => {
    const persistence = new PgPersistence(client);
    await persistence.init();

    // --- instance A: accrue real relay state, then flush to postgres --------
    const storeA = new RelayStores();
    storeA.registerRunner("runner-1", "pubkey-pem");
    storeA.audit("operator", "pairing.completed", "generation=1", new Date("2026-07-14T00:00:00Z"));
    storeA.ingestEvent(event("runner-1", 1));
    storeA.ingestEvent(event("runner-1", 2));
    storeA.enqueueCommand(
      {
        protocol: 1,
        command_id: "cmd-1",
        idempotency_key: "cmd-1",
        correlation_id: "corr",
        causation_id: null,
        project_id: "p",
        runner_id: "runner-1",
        generation: 1,
        issued_by_session: "operator",
        issued_at: "2026-07-14T00:00:00.000Z",
        expires_at: "2026-07-14T01:00:00.000Z",
        payload: { kind: "launch_fixture", fixture: "count:5:100" },
      },
      new Date("2026-07-14T00:00:00Z"),
    );

    const flusherA = new SnapshotFlusher(persistence, "relay", () => storeA.snapshot());
    await flusherA.flush();

    // --- instance B: brand-new process, same database -> reconstruct --------
    const loaded = await persistence.load("relay");
    expect(loaded).not.toBeNull();
    const storeB = RelayStores.restore(loaded as string);

    // every durable fact survived
    expect(storeB.runner("runner-1")?.public_key_pem).toBe("pubkey-pem");
    expect(storeB.eventWatermark("runner-1")).toBe(2);
    expect(storeB.eventsFor("runner-1")).toHaveLength(2);
    expect(storeB.command("cmd-1")?.state).toBe("queued");
    expect(storeB.auditEntries().map((a) => a.action)).toContain("pairing.completed");
    // full-fidelity: reconstructed state is deep-equal to the original.
    // (JSONB legitimately reorders object keys, so compare parsed, not bytes.)
    expect(JSON.parse(storeB.snapshot())).toEqual(JSON.parse(storeA.snapshot()));
  });

  it("load() returns null before anything is persisted", async () => {
    const persistence = new PgPersistence(client);
    await persistence.init();
    expect(await persistence.load("relay")).toBeNull();
  });

  it("flusher only writes when the snapshot actually changes", async () => {
    const persistence = new PgPersistence(client);
    await persistence.init();
    let writes = 0;
    const counting = new PgPersistence({
      query: (sql, params) => {
        if (sql.startsWith("INSERT")) writes += 1;
        return client.query(sql, params);
      },
    });
    const store = new RelayStores();
    const flusher = new SnapshotFlusher(counting, "relay", () => store.snapshot());

    await flusher.flush(); // first write (empty state)
    expect(writes).toBe(1);
    await flusher.flush(); // unchanged -> no write
    expect(writes).toBe(1);

    store.registerRunner("r", "pem"); // mutate
    await flusher.flush(); // changed -> write
    expect(writes).toBe(2);
  });

  it("upsert keeps a single row per key across many saves", async () => {
    const persistence = new PgPersistence(client);
    await persistence.init();
    await persistence.save("relay", JSON.stringify({ v: 1 }));
    await persistence.save("relay", JSON.stringify({ v: 2 }));
    const rows = await client.query("SELECT COUNT(*)::int AS n FROM norns_state WHERE key = $1", [
      "relay",
    ]);
    expect(rows.rows[0]?.n).toBe(1);
    expect(await persistence.load("relay")).toBe(JSON.stringify({ v: 2 }));
  });
});
