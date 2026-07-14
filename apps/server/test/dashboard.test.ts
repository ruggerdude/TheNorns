// Phase 6 exit: dashboard state provably derives from engine events (progress
// moves only on gate transitions), totals match the ledger, usage stays
// source-labeled, ETA stays experimental.
import { UsageEvent, type UsageEventT, validatePlan } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import { buildDashboard } from "../src/dashboard.js";
import { BudgetLedger } from "../src/engine/budget.js";
import { WorkflowEngine } from "../src/engine/workflow.js";
import type { AuditEntry } from "../src/stores.js";

const HASH = "e".repeat(64);

function fixture() {
  const result = validatePlan({
    objective: "dashboard fixture",
    modules: ["a", "b"].map((id, index) => ({
      id,
      title: id,
      description: id,
      deliverables: [id],
      acceptance: [
        { id: "AC-1", statement: "ok", verification_type: "command", verification: "true" },
      ],
      dependencies: index === 1 ? ["a"] : [],
      estimated_complexity: index === 1 ? "XL" : "S",
      risk: "low",
    })),
  });
  if (!result.ok) throw new Error("bad plan");
  const budget = new BudgetLedger(1000);
  budget.approve("a", 100);
  budget.approve("b", 200);
  const engine = new WorkflowEngine({ plan: result.plan, budget });
  for (const kind of ["plan", "allocation"] as const) {
    engine.recordApproval({
      id: `ap-${kind}`,
      kind,
      actor: "human",
      approved_at: new Date().toISOString(),
      content_hash: HASH,
    });
  }
  engine.start();
  return { engine, budget };
}

function usageEvent(id: string, costUsd: number, occurredAt: string, source = "provider_api") {
  return UsageEvent.parse({
    id,
    provider: "anthropic",
    model: "claude-sonnet-5",
    project_id: "proj-dash",
    node_id: "a",
    run_id: null,
    input_tokens: 1000,
    output_tokens: 500,
    estimated_cost_usd: costUsd,
    actual_cost_usd: null,
    usage_source: source,
    pricing_version: "test-1",
    occurred_at: occurredAt,
  });
}

const complexityOf = (id: string) => (id === "b" ? ("XL" as const) : ("S" as const));

function dash(
  engine: ReturnType<typeof fixture>["engine"],
  budget: ReturnType<typeof fixture>["budget"],
  ledger: UsageEventT[] = [],
  audit: AuditEntry[] = [],
) {
  return buildDashboard({ engine, budget, ledger, audit, complexityOf, graphVersion: 1 });
}

describe("phase 6 — dashboard derives from engine + ledger only", () => {
  it("progress moves only on gate transitions and reaches 100 at full integration", () => {
    const { engine, budget } = fixture();
    const initial = dash(engine, budget).progress_pct;

    // no transition -> identical output, byte for byte
    expect(JSON.stringify(dash(engine, budget))).toEqual(JSON.stringify(dash(engine, budget)));

    engine.assign("a");
    const afterAssign = dash(engine, budget).progress_pct;
    expect(afterAssign).toBeGreaterThan(initial);

    engine.startRun("a", 10);
    engine.completeRun("a", 5);
    engine.recordVerification("a", true);
    engine.reviewerDecision("a", "approve");
    engine.integrate("a");
    const afterA = dash(engine, budget);
    expect(afterA.progress_pct).toBeGreaterThan(afterAssign);
    expect(afterA.nodes.b).toBe("ready");

    engine.assign("b");
    engine.startRun("b", 20);
    engine.completeRun("b", 10);
    engine.recordVerification("b", true);
    engine.reviewerDecision("b", "approve");
    engine.integrate("b");
    expect(dash(engine, budget).progress_pct).toBe(100);
  });

  it("cost totals match the budget ledger exactly; burn rate comes from the usage ledger", () => {
    const { engine, budget } = fixture();
    engine.assign("a");
    engine.startRun("a", 40);
    engine.completeRun("a", 15); // settled 15

    const ledger = [
      usageEvent("u1", 1, "2026-07-14T10:00:00.000Z"),
      usageEvent("u2", 2, "2026-07-14T10:30:00.000Z"),
    ];
    const dto = dash(engine, budget, ledger);
    expect(dto.cost.settled_usd).toBe(budget.summary().settled_usd);
    expect(dto.cost.settled_usd).toBe(15);
    expect(dto.cost.approved_usd).toBe(300);
    expect(dto.cost.burn_rate_usd_per_hour).toBe(6); // $3 over 30 minutes
  });

  it("usage stays labeled by source — never one unlabeled aggregate", () => {
    const { engine, budget } = fixture();
    const ledger = [
      usageEvent("u1", 1, "2026-07-14T10:00:00.000Z", "provider_api"),
      usageEvent("u2", 2, "2026-07-14T10:10:00.000Z", "estimate"),
    ];
    const dto = dash(engine, budget, ledger);
    expect(Object.keys(dto.usage_by_source).sort()).toEqual(["estimate", "provider_api"]);
    expect(dto.usage_by_source.provider_api?.cost_usd).toBe(1);
    expect(dto.usage_by_source.estimate?.cost_usd).toBe(2);
  });

  it("surfaces blocked reasons from the engine log, the review queue, and the kill switch", () => {
    const { engine, budget } = fixture();
    engine.assign("a");
    engine.block("a", "runner");
    let dto = dash(engine, budget);
    expect(dto.blocked).toEqual([{ node_id: "a", reason: "runner" }]);
    expect(dto.pm_summary).toContain("1 blocked");

    engine.resume("a");
    engine.startRun("a", 10);
    engine.completeRun("a", 1);
    engine.recordVerification("a", true);
    engine.engageKillSwitch();
    dto = dash(engine, budget);
    expect(dto.review_queue).toEqual(["a"]);
    expect(dto.kill_switch).toBe(true);
    expect(dto.pm_summary).toContain("KILL SWITCH ENGAGED");
  });

  it("keeps ETA experimental and bounds the timeline", () => {
    const { engine, budget } = fixture();
    const audit: AuditEntry[] = Array.from({ length: 30 }, (_, index) => ({
      at: new Date().toISOString(),
      actor: "server",
      action: `event.${index}`,
      detail: "",
    }));
    const dto = dash(engine, budget, [], audit);
    expect(dto.eta).toEqual({ label: "experimental", value: null });
    expect(dto.timeline).toHaveLength(20);
    expect(dto.timeline[19]?.action).toBe("event.29");
  });
});
