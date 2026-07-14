// Phase 5 exit (deterministic-runtime half): a node executes end-to-end in an
// isolated worktree — runtime commits locally, the RUNNER runs verification
// in a clean worktree at the exact commit, budget is reserved before dispatch
// and settled after, failing verification blocks review, cancellation works,
// and the verified branch integrates cleanly into the integration branch.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePlan } from "@norns/contracts";
import { ProcessRuntime } from "@norns/runner";
import { describe, expect, it } from "vitest";
import { BudgetExceededError, BudgetLedger } from "../src/engine/budget.js";
import { executeNode } from "../src/engine/execution.js";
import { LocalGitRepo } from "../src/engine/git.js";
import { integrateNode } from "../src/engine/integration.js";
import { WorkflowEngine } from "../src/engine/workflow.js";

const HASH = "c".repeat(64);

function makePlan(ids: string[], deps: Record<string, string[]> = {}) {
  const result = validatePlan({
    objective: "execution fixture",
    modules: ids.map((id) => ({
      id,
      title: id,
      description: id,
      deliverables: [id],
      acceptance: [
        {
          id: "AC-1",
          statement: "file exists",
          verification_type: "command",
          verification: "true",
        },
      ],
      dependencies: deps[id] ?? [],
      estimated_complexity: "M",
      risk: "low",
    })),
  });
  if (!result.ok) throw new Error("bad fixture plan");
  return result.plan;
}

async function makeStack(ids: string[] = ["feature"]) {
  const base = mkdtempSync(join(tmpdir(), "norns-exec-"));
  const repo = await LocalGitRepo.init(join(base, "repo"), "pilot", join(base, "trees"));
  const budget = new BudgetLedger(10_000);
  for (const id of ids) budget.approve(id, 100);
  const engine = new WorkflowEngine({ plan: makePlan(ids), budget });
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
  return { repo, budget, engine };
}

// the "coding work": write a file and commit it locally in the worktree
const WORK_SCRIPT = 'echo "hello from worker" > feature.txt && git add -A && git commit -q -m work';

describe("phase 5 — single-agent execution pipeline", () => {
  it("runs a node end to end: worktree -> commit -> runner verification -> in_review -> integrated", async () => {
    const { repo, budget, engine } = await makeStack();
    engine.assign("feature");

    const result = await executeNode({
      engine,
      repo,
      runtime: new ProcessRuntime(),
      nodeId: "feature",
      prompt: WORK_SCRIPT,
      maxChargeUsd: 50,
      actualUsd: 12,
      verification: { required: ["test -f feature.txt", "grep -q hello feature.txt"], module: [] },
    });

    expect(result.outcome).toBe("in_review");
    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(engine.stateOf("feature")).toBe("in_review");

    // verification is runner-produced evidence, not a worker claim
    expect(result.verification).toHaveLength(2);
    expect(result.verification.every((v) => v.passed)).toBe(true);
    expect(result.verification.every((v) => v.kind === "required")).toBe(true);
    expect(result.verification[0]?.commit_sha).toBe(result.commit);

    // budget: reserved before dispatch, settled with actuals after
    expect(budget.settledUsd("feature")).toBe(12);
    expect(budget.activeReservationsUsd("feature")).toBe(0);

    // review gate then clean integration into the integration branch
    engine.reviewerDecision("feature", "approve");
    const integration = await integrateNode({
      engine,
      repo,
      nodeId: "feature",
      branch: result.branch,
    });
    expect(integration.integrated).toBe(true);
    expect(engine.stateOf("feature")).toBe("integrated");
    expect(await repo.branchExists("norns/pilot/integration")).toBe(true);
  });

  it("failing runner verification blocks entry to review (failed, not in_review)", async () => {
    const { engine, repo } = await makeStack();
    engine.assign("feature");
    const result = await executeNode({
      engine,
      repo,
      runtime: new ProcessRuntime(),
      nodeId: "feature",
      prompt: WORK_SCRIPT,
      maxChargeUsd: 50,
      verification: { required: ["test -f feature.txt"], module: ["test -f missing-file.txt"] },
    });
    expect(result.outcome).toBe("failed");
    expect(engine.stateOf("feature")).toBe("failed");
    const moduleCheck = result.verification.find((v) => v.kind === "module");
    expect(moduleCheck?.passed).toBe(false); // additive module command, honestly recorded
  });

  it("a runtime failure never fakes a verification pass", async () => {
    const { engine, repo } = await makeStack();
    engine.assign("feature");
    const result = await executeNode({
      engine,
      repo,
      runtime: new ProcessRuntime(),
      nodeId: "feature",
      prompt: "exit 3",
      maxChargeUsd: 50,
      verification: { required: ["true"], module: [] },
    });
    expect(result.outcome).toBe("failed");
    expect(result.commit).toBeNull();
    expect(result.verification).toHaveLength(0);
    expect(engine.stateOf("feature")).toBe("failed");
  });

  it("budget exhaustion blocks the node BEFORE any dispatch", async () => {
    const { engine, repo } = await makeStack();
    engine.assign("feature");
    await expect(
      executeNode({
        engine,
        repo,
        runtime: new ProcessRuntime(),
        nodeId: "feature",
        prompt: WORK_SCRIPT,
        maxChargeUsd: 500, // node approved at 100
        verification: { required: ["true"], module: [] },
      }),
    ).rejects.toThrow(BudgetExceededError);
    expect(engine.stateOf("feature")).toBe("blocked");
    // nothing ran: no worker branch was ever created
    expect(await repo.branchExists("norns/pilot/feature")).toBe(false);
  });

  it("cancellation maps to a cancelled outcome (remote control on real runs)", async () => {
    const runtime = new ProcessRuntime();
    const controller = new AbortController();
    const base = mkdtempSync(join(tmpdir(), "norns-cancel-"));
    const repo = await LocalGitRepo.init(join(base, "repo"), "pilot", join(base, "trees"));
    const worktree = await repo.createWorktree("cancel-me");
    const pending = runtime.run({
      runId: "run-cancel",
      worktreePath: worktree.path,
      prompt: "sleep 30",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.outcome).toBe("cancelled");
    expect(runtime.capabilities.cancel).toBe(true);
  });

  it("runtime capability matrices are published for UI mapping", async () => {
    const { ClaudeCodeRuntime, CodexRuntime } = await import("@norns/runner");
    const claude = new ClaudeCodeRuntime();
    const codex = new CodexRuntime();
    for (const runtime of [claude, codex]) {
      expect(runtime.capabilities.cancel).toBe(true);
      expect(runtime.capabilities.interrupt).toBe(true);
      expect(runtime.capabilities.resume_session).toBe(true);
      expect(runtime.capabilities.suspend).toBe(false); // never assumed
    }
  });
});
