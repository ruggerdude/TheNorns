// Phase 1B exit: a fixture graph driven through all lifecycle states with
// gates enforced, budget races handled, kill switch verified, and replay
// reconstructing identical state from the persisted log.
import { validatePlan } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import { BudgetExceededError, BudgetLedger } from "../src/engine/budget.js";
import { EngineError, KillSwitchEngagedError, WorkflowEngine } from "../src/engine/workflow.js";

const HASH = "b".repeat(64);

function fixturePlan() {
  const result = validatePlan({
    objective: "fixture graph",
    modules: [
      {
        id: "a",
        title: "A",
        description: "first",
        deliverables: ["a"],
        acceptance: [
          { id: "AC-1", statement: "works", verification_type: "command", verification: "true" },
        ],
        estimated_complexity: "S",
        risk: "low",
      },
      {
        id: "b",
        title: "B",
        description: "second",
        deliverables: ["b"],
        acceptance: [
          { id: "AC-1", statement: "works", verification_type: "command", verification: "true" },
        ],
        dependencies: ["a"],
        estimated_complexity: "M",
        risk: "low",
      },
      {
        id: "c",
        title: "C",
        description: "third",
        deliverables: ["c"],
        acceptance: [
          { id: "AC-1", statement: "works", verification_type: "command", verification: "true" },
        ],
        dependencies: ["b"],
        estimated_complexity: "M",
        risk: "medium",
      },
    ],
  });
  if (!result.ok) throw new Error("fixture plan invalid");
  return result.plan;
}

function approvedEngine(budget?: BudgetLedger): WorkflowEngine {
  const ledger = budget ?? new BudgetLedger(1000);
  for (const node of ["a", "b", "c"]) ledger.approve(node, 100);
  const engine = new WorkflowEngine({ plan: fixturePlan(), budget: ledger });
  engine.recordApproval({
    id: "ap1",
    kind: "plan",
    actor: "human",
    approved_at: new Date().toISOString(),
    content_hash: HASH,
  });
  engine.recordApproval({
    id: "ap2",
    kind: "allocation",
    actor: "human",
    approved_at: new Date().toISOString(),
    content_hash: HASH,
  });
  return engine;
}

function driveToIntegrated(engine: WorkflowEngine, node: string): void {
  engine.assign(node);
  engine.startRun(node, 10);
  engine.completeRun(node, 4);
  engine.recordVerification(node, true);
  engine.reviewerDecision(node, "approve");
  engine.integrate(node);
}

describe("workflow engine — fixture graph through all states", () => {
  it("requires plan + allocation approvals before start", () => {
    const ledger = new BudgetLedger(1000);
    ledger.approve("a", 100);
    const engine = new WorkflowEngine({ plan: fixturePlan(), budget: ledger });
    expect(() => engine.start()).toThrow(EngineError);
  });

  it("drives a -> b -> c end to end with dependency gating", () => {
    const engine = approvedEngine();
    engine.start();
    expect(engine.states()).toEqual({ a: "ready", b: "pending", c: "pending" });

    driveToIntegrated(engine, "a");
    expect(engine.stateOf("a")).toBe("integrated");
    expect(engine.stateOf("b")).toBe("ready"); // unlocked by integration
    expect(engine.stateOf("c")).toBe("pending");

    driveToIntegrated(engine, "b");
    driveToIntegrated(engine, "c");
    expect(engine.states()).toEqual({ a: "integrated", b: "integrated", c: "integrated" });
  });

  it("enforces gates: no verified without review, no run without assignment", () => {
    const engine = approvedEngine();
    engine.start();
    expect(() => engine.startRun("a", 10)).toThrow(EngineError); // ready, not assigned
    engine.assign("a");
    engine.startRun("a", 10);
    engine.completeRun("a", 2);
    expect(() => engine.reviewerDecision("a", "approve")).toThrow(EngineError); // verifying, not in_review
    engine.recordVerification("a", true);
    engine.reviewerDecision("a", "approve");
    expect(() => engine.integrate("b")).toThrow(EngineError); // b still pending
  });

  it("failed verification and reviewer rework loop back", () => {
    const engine = approvedEngine();
    engine.start();
    engine.assign("a");
    engine.startRun("a", 10);
    engine.completeRun("a", 2);
    engine.recordVerification("a", false);
    expect(engine.stateOf("a")).toBe("failed");
    engine.assign("a"); // retry
    engine.startRun("a", 10);
    engine.completeRun("a", 2);
    engine.recordVerification("a", true);
    engine.reviewerDecision("a", "rework");
    expect(engine.stateOf("a")).toBe("assigned");
  });

  it("budget exhaustion blocks the node instead of dispatching", () => {
    const engine = approvedEngine();
    engine.start();
    engine.assign("a");
    expect(() => engine.startRun("a", 500)).toThrow(BudgetExceededError); // node approved 100
    expect(engine.stateOf("a")).toBe("blocked");
    engine.resume("a");
    expect(engine.stateOf("a")).toBe("assigned"); // resumes to the interrupted state
  });

  it("project hard cap auto-engages the kill switch; dispatch refuses", () => {
    const ledger = new BudgetLedger(150); // project cap below sum of node budgets
    const engine = approvedEngine(ledger);
    engine.start();
    engine.assign("a");
    engine.startRun("a", 90);
    engine.completeRun("a", 90);
    engine.recordVerification("a", true);
    engine.reviewerDecision("a", "approve");
    engine.integrate("a");

    engine.assign("b");
    expect(() => engine.startRun("b", 90)).toThrow(BudgetExceededError); // 90 settled + 90 > 150
    expect(engine.killSwitchEngaged()).toBe(true);
    expect(engine.stateOf("b")).toBe("blocked");

    engine.resume("b");
    expect(() => engine.startRun("b", 10)).toThrow(KillSwitchEngagedError);
    engine.disengageKillSwitch(); // human action
    expect(engine.startRun("b", 10).reservationId).toBeTruthy();
  });

  it("supersession models conflict-node replacement", () => {
    const engine = approvedEngine();
    engine.start();
    engine.assign("a");
    engine.startRun("a", 10);
    engine.completeRun("a", 1);
    engine.recordVerification("a", true);
    engine.reviewerDecision("a", "approve");
    engine.block("a", "integration"); // merge conflict
    engine.supersede("a"); // conflict node replaces the original
    expect(engine.stateOf("a")).toBe("superseded");
  });

  it("replay of the persisted log reconstructs identical state", () => {
    const engine = approvedEngine();
    engine.start();
    driveToIntegrated(engine, "a");
    engine.assign("b");
    engine.startRun("b", 10);

    const persisted = JSON.parse(JSON.stringify(engine.log));
    expect(engine.replayFrom(persisted)).toEqual(engine.states());
  });
});
