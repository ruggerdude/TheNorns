// Dev entrypoint: relay + graph API on :8787, plus a self-contained DEMO
// dashboard. The demo is a hardcoded scripted walkthrough (its own engine
// driven through a few gates) that exists purely to illustrate what a fully-
// populated PM Dashboard looks like before live execution exists for real
// projects (NORN-027b). It is exposed at GET /api/demo/dashboard and is wholly
// separate from the real, user-created projects in `ProjectStore` — no real
// project's data ever flows into it, and none of its state ever flows back.
import { UsageEvent } from "@norns/contracts";
import { buildDashboard } from "./dashboard.js";
import { BudgetLedger } from "./engine/budget.js";
import { WorkflowEngine } from "./engine/workflow.js";
import { GraphSession } from "./graph/session.js";
import { PgPersistence, SnapshotFlusher } from "./persistence/pg.js";
import { ProjectStore } from "./projects/store.js";
import { buildServer } from "./server.js";
import { evaluateAuthStartup } from "./startup/authPolicy.js";
import { RelayStores } from "./stores.js";
import { UserStore } from "./users/store.js";

// The scripted demo walkthrough that drives the DEMO dashboard's example view
// (GET /api/demo/dashboard) — deliberately NOT a real project. It never enters
// `ProjectStore`, is never persisted, and is recreated fresh every boot. Do not
// wire a real project through this; real dashboards must read ProjectStore.
const demoSession = GraphSession.demo();

// Multi-project management: the sole point of entry — create, list, plan,
// and edit real projects. Empty until you create your first one.
const projects = new ProjectStore();

// Real user accounts — replaces the shared deploy token as the day-to-day
// login mechanism. Empty until the first admin is bootstrapped (or, in dev,
// auto-seeded below).
const users = new UserStore();

const isProd = process.env.NODE_ENV === "production";

// Tier-2 persistence: when DATABASE_URL is set (Railway Postgres plugin),
// hydrate relay state from the last snapshot and flush changes back durably.
// Development can still run in memory. Production identity state must never
// degrade to an empty in-memory store: doing so would make an existing admin
// disappear and incorrectly reopen first-time setup after a restart.
const databaseUrl = process.env.DATABASE_URL;
let stores = new RelayStores();
const flushers: SnapshotFlusher[] = [];
let usersFlusher: SnapshotFlusher | undefined;
let persistenceReady = false;

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

    // user accounts + live sessions
    const usersSnap = await persistence.load("users");
    if (usersSnap) users.restoreFrom(JSON.parse(usersSnap));

    usersFlusher = new SnapshotFlusher(persistence, "users", () =>
      JSON.stringify(users.snapshot()),
    );
    flushers.push(
      new SnapshotFlusher(persistence, "relay", () => stores.snapshot()),
      new SnapshotFlusher(persistence, "projects", () => JSON.stringify(projects.snapshot())),
      usersFlusher,
    );
    for (const f of flushers) f.start();
    persistenceReady = true;
    console.log(
      `postgres: relay ${relaySnap ? "restored" : "fresh"}, projects ${projectsSnap ? "restored" : "fresh"}, users ${usersSnap ? "restored" : "fresh"}`,
    );
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        void Promise.all(flushers.map((f) => f.stop())).then(() => process.exit(0));
      });
    }
  } catch (error) {
    console.error(
      `postgres persistence unavailable${isProd ? " — production startup will be refused" : " — continuing in-memory"}. reason: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    stores = new RelayStores();
    flushers.length = 0;
    usersFlusher = undefined;
    persistenceReady = false;
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

// NORNS_TOKEN's only remaining job is gating one-time first-admin bootstrap
// (POST /api/auth/bootstrap) — it is never accepted as a day-to-day session
// credential anymore. Real accounts replace that entirely.
const deployToken = process.env.NORNS_TOKEN;

if (!isProd && !users.hasActiveAdmin) {
  // Local dev convenience: skip the bootstrap ceremony so `pnpm dev` keeps
  // working out of the box, same spirit as the old default dev token.
  users.createActive({
    email: "dev@local.test",
    name: "Dev Admin",
    password: "dev-password",
    role: "admin",
  });
  console.log("dev mode: seeded dev@local.test / dev-password as the first admin");
}

const authStartup = evaluateAuthStartup({
  isProduction: isProd,
  persistenceConfigured: Boolean(databaseUrl),
  persistenceReady,
  hasActiveAdmin: users.hasActiveAdmin,
  hasDeployToken: Boolean(deployToken),
});

if (!authStartup.allowed) {
  console.error(`auth startup refused [${authStartup.code}]: ${authStartup.message}`);
  process.exit(1);
}

// Even if NORNS_TOKEN is still present in Railway, do not retain it as a
// runtime capability after a durable active admin has been restored.
const bootstrapDeployToken = authStartup.bootstrapRequired ? deployToken : undefined;

// When NORNS_WEB_DIST points at the built web app, serve it from this service.
const webDist = process.env.NORNS_WEB_DIST;

const server = await buildServer({
  stores,
  users,
  projects,
  recordUsage: (events) => ledger.push(...events),
  ...(bootstrapDeployToken !== undefined ? { deployToken: bootstrapDeployToken } : {}),
  ...(usersFlusher !== undefined ? { persistUsers: () => usersFlusher.flush() } : {}),
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
