// Dev entrypoint: relay + graph API + dashboard on :8787 with the demo
// project, including a demo engine driven through a few gates so the
// dashboard shows real derived state.
import { UsageEvent } from "@norns/contracts";
import { buildDashboard } from "./dashboard.js";
import { BudgetLedger } from "./engine/budget.js";
import { WorkflowEngine } from "./engine/workflow.js";
import { GraphSession } from "./graph/session.js";
import { PgPersistence, SnapshotFlusher } from "./persistence/pg.js";
import { ProjectStore } from "./projects/store.js";
import { buildServer } from "./server.js";
import { RelayStores } from "./stores.js";

// The scripted demo walkthrough that drives the PM Dashboard's example view —
// separate from the real, user-created projects below. Recreated fresh every
// boot; never persisted.
const demoSession = GraphSession.demo();

// Multi-project management: the sole point of entry — create, list, plan,
// and edit real projects. Empty until you create your first one.
const projects = new ProjectStore();

// Tier-2 persistence: when DATABASE_URL is set (Railway Postgres plugin),
// hydrate relay state from the last snapshot and flush changes back durably.
// Without it — or if the database is unreachable — the store is in-memory,
// and the site stays up rather than crash-looping. A DB problem degrades
// persistence, it does not take down the control plane.
const databaseUrl = process.env.DATABASE_URL;
let stores = new RelayStores();
const flushers: SnapshotFlusher[] = [];

if (databaseUrl) {
  try {
    const { Pool } = await import("pg");
    // Railway's private URL (…railway.internal) needs no SSL; any public
    // endpoint does. node-postgres won't attempt SSL unless told.
    const isInternal = /railway\.internal|localhost|127\.0\.0\.1/.test(databaseUrl);
    const pool = new Pool({
      connectionString: databaseUrl,
      ...(isInternal ? {} : { ssl: { rejectUnauthorized: false } }),
    });
    const persistence = new PgPersistence({
      query: (sql, params) => pool.query(sql, params as unknown[]),
    });
    await persistence.init();

    // relay state (runners, outbox, events, audit)
    const relaySnap = await persistence.load("relay");
    if (relaySnap) stores = RelayStores.restore(relaySnap);

    // your real projects: metadata, plans, graph edits, allocations
    const projectsSnap = await persistence.load("projects");
    if (projectsSnap) projects.restoreFrom(JSON.parse(projectsSnap));

    flushers.push(
      new SnapshotFlusher(persistence, "relay", () => stores.snapshot()),
      new SnapshotFlusher(persistence, "projects", () => JSON.stringify(projects.snapshot())),
    );
    for (const f of flushers) f.start();
    console.log(
      `postgres: relay ${relaySnap ? "restored" : "fresh"}, projects ${projectsSnap ? "restored" : "fresh"}`,
    );
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        void Promise.all(flushers.map((f) => f.stop())).then(() => process.exit(0));
      });
    }
  } catch (error) {
    console.error(
      `postgres persistence unavailable — continuing in-memory. reason: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    stores = new RelayStores();
    flushers.length = 0;
  }
}

// demo engine over the same plan, driven partway for a live-looking dashboard
const budget = new BudgetLedger(2000);
for (const mod of demoSession.plan.modules) budget.approve(mod.id, 150);
const engine = new WorkflowEngine({ plan: demoSession.plan, budget });
for (const kind of ["plan", "allocation"] as const) {
  engine.recordApproval({
    id: `ap-${kind}`,
    kind,
    actor: "dhatwell",
    approved_at: new Date().toISOString(),
    content_hash: "f".repeat(64),
  });
}
engine.start();
engine.assign("contracts");
engine.startRun("contracts", 30);
engine.completeRun("contracts", 11);
engine.recordVerification("contracts", true);
engine.reviewerDecision("contracts", "approve");
engine.integrate("contracts");
engine.assign("db-schema");
engine.startRun("db-schema", 25);
engine.assign("auth");
engine.block("auth", "runner");

const ledger = [
  UsageEvent.parse({
    id: "use_demo_1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    project_id: "proj-demo",
    node_id: "contracts",
    run_id: "run_demo_1",
    input_tokens: 42_000,
    output_tokens: 9_000,
    estimated_cost_usd: 0.26,
    actual_cost_usd: null,
    usage_source: "provider_api",
    pricing_version: "anthropic-2026-06",
    occurred_at: new Date(Date.now() - 30 * 60_000).toISOString(),
  }),
  UsageEvent.parse({
    id: "use_demo_2",
    provider: "openai",
    model: "openai-reasoning-default",
    project_id: "proj-demo",
    node_id: "contracts",
    run_id: "run_demo_1",
    input_tokens: 12_000,
    output_tokens: 3_000,
    estimated_cost_usd: 0.24,
    actual_cost_usd: null,
    usage_source: "estimate",
    pricing_version: "openai-config-placeholder",
    occurred_at: new Date().toISOString(),
  }),
];

const complexityOf = (nodeId: string): "S" | "M" | "L" | "XL" =>
  demoSession.plan.modules.find((mod) => mod.id === nodeId)?.estimated_complexity ?? "M";

// A public URL must not run on the default dev token. Fail loudly instead.
const isProd = process.env.NODE_ENV === "production";
const token = process.env.NORNS_TOKEN ?? (isProd ? undefined : "dev-token");
if (!token) {
  console.error("NORNS_TOKEN is required in production — set it as an environment variable.");
  process.exit(1);
}

// When NORNS_WEB_DIST points at the built web app, serve it from this service.
const webDist = process.env.NORNS_WEB_DIST;

const server = await buildServer({
  stores,
  sessionToken: token,
  projects,
  recordUsage: (events) => ledger.push(...events),
  ...(webDist !== undefined ? { webDist } : {}),
  dashboard: () =>
    buildDashboard({
      engine,
      budget,
      ledger,
      audit: stores.auditEntries(),
      complexityOf,
      graphVersion: demoSession.graph.version,
    }),
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.NORNS_HOST ?? (isProd ? "0.0.0.0" : "127.0.0.1");
await server.app.listen({ port, host });
console.log(`norns server on ${host}:${port}${webDist ? " (serving web)" : ""}`);
