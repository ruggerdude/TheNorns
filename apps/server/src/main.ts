// Dev entrypoint: relay + graph API + dashboard on :8787 with the demo
// project, including a demo engine driven through a few gates so the
// dashboard shows real derived state.
import { UsageEvent } from "@norns/contracts";
import { buildDashboard } from "./dashboard.js";
import { BudgetLedger } from "./engine/budget.js";
import { WorkflowEngine } from "./engine/workflow.js";
import { GraphSession } from "./graph/session.js";
import { buildServer } from "./server.js";
import { RelayStores } from "./stores.js";

const graphSession = GraphSession.demo();
const stores = new RelayStores();

// demo engine over the same plan, driven partway for a live-looking dashboard
const budget = new BudgetLedger(2000);
for (const mod of graphSession.plan.modules) budget.approve(mod.id, 150);
const engine = new WorkflowEngine({ plan: graphSession.plan, budget });
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
  graphSession.plan.modules.find((mod) => mod.id === nodeId)?.estimated_complexity ?? "M";

const server = await buildServer({
  stores,
  sessionToken: process.env.NORNS_TOKEN ?? "dev-token",
  graphSession,
  dashboard: () =>
    buildDashboard({
      engine,
      budget,
      ledger,
      audit: stores.auditEntries(),
      complexityOf,
      graphVersion: graphSession.graph.version,
    }),
});
await server.app.listen({ port: Number(process.env.PORT ?? 8787), host: "127.0.0.1" });
console.log("norns server on http://127.0.0.1:8787");
