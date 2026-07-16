// Tier-2 persistence (NORN-024): verified against pglite — a real Postgres
// engine in-process. Proves the control-plane survives a restart: state
// written by one store instance is reconstructed by a fresh instance pointed
// at the same database, with full fidelity.
import { PGlite } from "@electric-sql/pglite";
import { type EventEnvelopeT, PlanContract } from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoAllocate, overrideAssignment } from "../src/graph/allocation.js";
import { GraphSession } from "../src/graph/session.js";
import { type PgClient, PgPersistence, SnapshotFlusher } from "../src/persistence/pg.js";
import { ProjectStore } from "../src/projects/store.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";

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

  it("serializes concurrent flushes and can pause, drain, and resume", async () => {
    const persistence = new PgPersistence(client);
    await persistence.init();

    let value = 0;
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const writes: string[] = [];
    let markWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const serialized = new SnapshotFlusher(
      new PgPersistence({
        query: async (sql, params) => {
          if (sql.startsWith("INSERT")) {
            activeWrites += 1;
            maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
            markWriteStarted?.();
            await new Promise((resolve) => setTimeout(resolve, 5));
            writes.push(String(params?.[1]));
            activeWrites -= 1;
          }
          return client.query(sql, params);
        },
      }),
      "checkpoint-source",
      () => JSON.stringify({ value }),
      5,
    );

    value = 1;
    const first = serialized.flush();
    await writeStarted;
    value = 2;
    const second = serialized.flush();
    await Promise.all([first, second]);

    expect(maxActiveWrites).toBe(1);
    expect(writes).toEqual(['{"value":1}', '{"value":2}']);

    serialized.start();
    value = 3;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await serialized.pause(true);
    const writesAfterPause = writes.length;
    value = 4;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes).toHaveLength(writesAfterPause);

    serialized.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await serialized.stop();
    expect(writes.at(-1)).toBe('{"value":4}');
  });

  it("reconstructs the workflow graph (edits + allocations) across a restart", async () => {
    const persistence = new PgPersistence(client);
    await persistence.init();

    // --- instance A: edit the graph, allocate, override, then flush ---------
    const sessionA = GraphSession.demo();
    sessionA.graph.addNode({
      id: "extra",
      title: "Extra",
      complexity: "L",
      dependencies: ["contracts"],
    });
    autoAllocate(sessionA.graph, "quality");
    overrideAssignment(sessionA.graph, "contracts", { model: "claude-opus-4-8", budget_usd: 42 });
    const versionA = sessionA.graph.version;

    const flusher = new SnapshotFlusher(persistence, "graph", () =>
      JSON.stringify(sessionA.graph.snapshot()),
    );
    await flusher.flush();

    // --- instance B: fresh demo graph, restored from postgres ---------------
    const loaded = await persistence.load("graph");
    expect(loaded).not.toBeNull();
    const sessionB = GraphSession.demo();
    sessionB.graph.restoreFrom(JSON.parse(loaded as string));

    // the manual node, its dependency, the allocation, and the override all survive
    expect(sessionB.graph.node("extra")?.dependencies).toEqual(["contracts"]);
    expect(sessionB.graph.version).toBe(versionA);
    const contracts = sessionB.graph.node("contracts");
    expect(contracts?.assignment?.source).toBe("override");
    expect(contracts?.assignment?.model).toBe("claude-opus-4-8");
    expect(contracts?.assignment?.budget_usd).toBe(42);
    expect(sessionB.graph.node("api-core")?.assignment).not.toBeNull(); // auto-allocated
    // full fidelity
    expect(sessionB.graph.snapshot()).toEqual(sessionA.graph.snapshot());
  });

  it("reconstructs the whole ProjectStore (many projects, plans, allocations) across a restart", async () => {
    const persistence = new PgPersistence(client);
    await persistence.init();

    // --- instance A: two projects, one still a draft, one planned+allocated -
    const storeA = new ProjectStore();
    storeA.create({ name: "Draft only", description: "no plan yet", pmProvider: "openai" });
    const planned = storeA.create({
      name: "Health check",
      description: "Add a health-check endpoint",
      pmProvider: "anthropic",
    });
    const session = storeA.loadPlan(
      planned.id,
      PlanContract.parse({
        objective: "Add a health-check endpoint",
        modules: [
          {
            id: "foundation",
            title: "Foundation",
            description: "Foundation module",
            deliverables: ["foundation deliverable"],
            acceptance: [
              {
                id: "AC-1",
                statement: "foundation passes",
                verification_type: "command",
                verification: "pnpm test",
              },
            ],
            dependencies: [],
            estimated_complexity: "M",
            risk: "low",
            parallelization: { safe: false },
          },
        ],
      }),
    );
    autoAllocate(session.graph, "balanced");
    overrideAssignment(session.graph, "foundation", { budget_usd: 42 });

    const flusher = new SnapshotFlusher(persistence, "projects", () =>
      JSON.stringify(storeA.snapshot()),
    );
    await flusher.flush();

    // --- instance B: fresh ProjectStore, restored from postgres -------------
    const loaded = await persistence.load("projects");
    expect(loaded).not.toBeNull();
    const storeB = new ProjectStore();
    storeB.restoreFrom(JSON.parse(loaded as string));

    const listed = storeB.list();
    expect(listed).toHaveLength(2);
    const draftEntry = listed.find((p) => p.name === "Draft only");
    expect(draftEntry?.status).toBe("draft");
    expect(() => storeB.session(draftEntry?.id as string)).toThrow();

    const restoredSession = storeB.session(planned.id);
    expect(restoredSession.graph.node("foundation")?.assignment?.budget_usd).toBe(42);
    expect(restoredSession.graph.node("foundation")?.assignment?.source).toBe("override");
    expect(restoredSession.graph.snapshot()).toEqual(session.graph.snapshot());
  });

  it("restores an admin who can sign in with email and password after a restart", async () => {
    const persistence = new PgPersistence(client);
    await persistence.init();

    const usersA = new UserStore();
    usersA.createActive({
      email: "admin@example.com",
      name: "Admin",
      password: "durable-password",
      role: "admin",
    });
    const flusher = new SnapshotFlusher(persistence, "users", () =>
      JSON.stringify(usersA.snapshot()),
    );
    await flusher.flush();

    const loaded = await persistence.load("users");
    expect(loaded).not.toBeNull();
    const usersB = new UserStore();
    usersB.restoreFrom(JSON.parse(loaded as string));

    expect(usersB.hasActiveAdmin).toBe(true);
    const session = usersB.login("admin@example.com", "durable-password");
    expect(session.user).toMatchObject({ email: "admin@example.com", role: "admin" });
    expect(usersB.userForToken(session.token)?.email).toBe("admin@example.com");
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
