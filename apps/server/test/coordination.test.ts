// Phase 7 exit: a 5-node graph with one 2-worker node executes end to end;
// an induced merge conflict spawns a conflict-resolution node (replacement
// semantics: edges move, original superseded, human confirmation required);
// an induced worker failure retries once from a fresh worktree then
// escalates to the PM.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PlanContractT, type PlanModuleT, validatePlan } from "@norns/contracts";
import { ProcessRuntime } from "@norns/runner";
import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../src/engine/budget.js";
import { type ModuleLead, executeMultiWorkerNode } from "../src/engine/coordination.js";
import { executeNode } from "../src/engine/execution.js";
import { LocalGitRepo } from "../src/engine/git.js";
import { HumanConfirmationRequiredError, integrateNode } from "../src/engine/integration.js";
import { WorkflowEngine } from "../src/engine/workflow.js";
import { WorkflowGraph } from "../src/graph/graph.js";

const HASH = "d".repeat(64);
const VERIFY = { required: ["git log --oneline -1"], module: [] };

// 5-node graph: base -> (left, right, big) -> release; big is the 2-worker node
function fiveNodePlan(): PlanContractT {
  const mod = (id: string, deps: string[], parallelSafe = false) => ({
    id,
    title: id,
    description: id,
    deliverables: [id],
    acceptance: [
      { id: "AC-1", statement: "ok", verification_type: "command", verification: "true" },
    ],
    dependencies: deps,
    estimated_complexity: parallelSafe ? "XL" : "M",
    risk: "low",
    parallelization: {
      safe: parallelSafe,
      candidate_work_units: parallelSafe ? ["unit-a", "unit-b"] : [],
      shared_files: [],
      integration_owner_required: true,
    },
  });
  const result = validatePlan({
    objective: "coordination fixture",
    modules: [
      mod("base", []),
      mod("left", ["base"]),
      mod("right", ["base"]),
      mod("big", ["base"], true),
      mod("release", ["left", "right", "big"]),
    ],
  });
  if (!result.ok) throw new Error("bad plan");
  return result.plan;
}

async function makeStack() {
  const base = mkdtempSync(join(tmpdir(), "norns-coord-"));
  const repo = await LocalGitRepo.init(join(base, "repo"), "pilot", join(base, "trees"));
  const budget = new BudgetLedger(10_000);
  const plan = fiveNodePlan();
  for (const mod of plan.modules) budget.approve(mod.id, 200);
  const engine = new WorkflowEngine({ plan, budget });
  const graph = WorkflowGraph.fromPlan(plan);
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
  return { repo, budget, engine, graph, plan };
}

const write = (file: string, content: string) =>
  `echo "${content}" > ${file} && git add -A && git commit -q -m "write ${file}"`;

/** Drive a single-runtime node to integrated. */
async function driveNode(
  stack: Awaited<ReturnType<typeof makeStack>>,
  nodeId: string,
  script: string,
) {
  stack.engine.assign(nodeId);
  const result = await executeNode({
    engine: stack.engine,
    repo: stack.repo,
    runtime: new ProcessRuntime(),
    nodeId,
    prompt: script,
    maxChargeUsd: 40,
    actualUsd: 10,
    verification: VERIFY,
  });
  if (result.outcome !== "in_review")
    throw new Error(`node ${nodeId} failed: ${result.runtimeDetail}`);
  stack.engine.reviewerDecision(nodeId, "approve");
  return integrateNode({
    engine: stack.engine,
    repo: stack.repo,
    graph: stack.graph,
    nodeId,
    branch: result.branch,
  });
}

function scriptedLead(questions: { asked: string[] }, prompts: Record<number, string>): ModuleLead {
  return {
    split: (module: PlanModuleT) =>
      module.parallelization.candidate_work_units.slice(0, 2).map((_, index) => ({
        worker: index + 1,
        prompt: prompts[index + 1] ?? "true",
      })),
    answer: async (worker, question) => {
      // PM-routed: the lead is the only channel workers have
      questions.asked.push(`w${worker}: ${question}`);
      return "use kebab-case file names";
    },
  };
}

describe("phase 7 — multi-agent coordination", () => {
  it("drives the 5-node graph end to end with one 2-worker node", async () => {
    const stack = await makeStack();
    const { engine } = stack;
    const questions = { asked: [] as string[] };

    await driveNode(stack, "base", write("base.txt", "base"));
    expect(engine.stateOf("left")).toBe("ready"); // dependency gate opened

    await driveNode(stack, "left", write("left.txt", "left"));
    await driveNode(stack, "right", write("right.txt", "right"));

    // the 2-worker node: workers write DISTINCT files on -w1/-w2 branches
    engine.assign("big");
    const lead = scriptedLead(questions, {
      1: write("big-a.txt", "unit a"),
      2: write("big-b.txt", "unit b"),
    });
    const bigModule = stack.plan.modules.find((m) => m.id === "big");
    if (!bigModule) throw new Error("missing module");

    // PM-routed question before work starts
    await lead.answer(2, "which naming convention?");

    const result = await executeMultiWorkerNode({
      engine,
      repo: stack.repo,
      nodeId: "big",
      module: bigModule,
      lead,
      runtimeFor: () => new ProcessRuntime(),
      maxChargeUsd: 100,
      actualUsd: 30,
      verification: { required: ["test -f big-a.txt", "test -f big-b.txt"], module: [] },
    });

    expect(result.outcome).toBe("in_review");
    expect(result.workerBranches).toEqual(["norns/pilot/big-w1", "norns/pilot/big-w2"]);
    expect(result.attempts).toEqual({ 1: 1, 2: 1 });
    expect(questions.asked).toEqual(["w2: which naming convention?"]);
    // the assembled commit contains BOTH work units (verified by the runner)
    expect(result.verification.every((v) => v.passed)).toBe(true);

    engine.reviewerDecision("big", "approve");
    const integrated = await integrateNode({
      engine,
      repo: stack.repo,
      graph: stack.graph,
      nodeId: "big",
      branch: result.branch,
    });
    expect(integrated.integrated).toBe(true);
    expect(engine.stateOf("release")).toBe("ready"); // all three deps integrated

    await driveNode(stack, "release", write("release.txt", "ship"));
    expect(engine.stateOf("release")).toBe("integrated");
  });

  it("bounded decomposition: the lead cannot exceed the pilot worker cap", async () => {
    const stack = await makeStack();
    await driveNode(stack, "base", write("base.txt", "base"));
    stack.engine.assign("big");
    const bigModule = stack.plan.modules.find((m) => m.id === "big");
    if (!bigModule) throw new Error("missing module");
    await expect(
      executeMultiWorkerNode({
        engine: stack.engine,
        repo: stack.repo,
        nodeId: "big",
        module: bigModule,
        lead: {
          split: () => [1, 2, 3].map((w) => ({ worker: w, prompt: "true" })),
          answer: async () => "",
        },
        runtimeFor: () => new ProcessRuntime(),
        maxChargeUsd: 100,
        verification: VERIFY,
      }),
    ).rejects.toThrow(/bounded decomposition/);
  });

  it("induced merge conflict spawns a conflict node: edges move, original superseded, human confirms", async () => {
    const stack = await makeStack();
    const { engine, graph } = stack;
    const escalations: string[] = [];

    await driveNode(stack, "base", write("shared.txt", "from base"));

    // left and right BOTH rewrite the same line of shared.txt
    await driveNode(stack, "left", write("shared.txt", "left version"));

    engine.assign("right");
    const rightRun = await executeNode({
      engine,
      repo: stack.repo,
      runtime: new ProcessRuntime(),
      nodeId: "right",
      prompt: write("shared.txt", "right version"),
      maxChargeUsd: 40,
      actualUsd: 10,
      verification: VERIFY,
    });
    engine.reviewerDecision("right", "approve");
    const integration = await integrateNode({
      engine,
      repo: stack.repo,
      graph,
      nodeId: "right",
      branch: rightRun.branch,
      onEscalate: (nodeId, reason) => escalations.push(`${nodeId}: ${reason}`),
    });

    // conflict path: clean merges only — no autonomous resolution
    expect(integration.integrated).toBe(false);
    if (integration.integrated) throw new Error("unreachable");
    expect(integration.conflict.conflictNodeId).toBe("right-conflict");
    expect(escalations[0]).toContain("shared.txt");

    // replacement semantics
    expect(engine.stateOf("right")).toBe("superseded");
    expect(engine.dependenciesOf("release")).toContain("right-conflict");
    expect(engine.dependenciesOf("release")).not.toContain("right");
    expect(graph.node("right-conflict")).toBeDefined();
    expect(graph.dependentsOf("right-conflict")).toContain("release");

    // resolve on a branch cut from the integration branch (both sides visible)
    engine.assign("right-conflict");
    stack.budget.approve("right-conflict", 100);
    engine.startRun("right-conflict", 20);
    const resolveTree = await stack.repo.createWorktree("resolution-work");
    await new ProcessRuntime().run({
      runId: "resolve",
      worktreePath: resolveTree.path,
      prompt:
        "git merge --no-commit norns/pilot/integration >/dev/null 2>&1 || true; " +
        'echo "merged: left+right" > shared.txt && git add -A && git commit -q -m resolve',
    });
    await stack.repo.removeWorktree(resolveTree);
    engine.completeRun("right-conflict", 5);
    engine.recordVerification("right-conflict", true);
    engine.reviewerDecision("right-conflict", "approve");

    // conflict resolution touched both sides -> integration requires the human
    await expect(
      integrateNode({
        engine,
        repo: stack.repo,
        nodeId: "right-conflict",
        branch: resolveTree.branch,
        isConflictResolution: true,
      }),
    ).rejects.toThrow(HumanConfirmationRequiredError);

    const confirmed = await integrateNode({
      engine,
      repo: stack.repo,
      nodeId: "right-conflict",
      branch: resolveTree.branch,
      isConflictResolution: true,
      humanConfirmed: true,
    });
    expect(confirmed.integrated).toBe(true);
    expect(engine.stateOf("right-conflict")).toBe("integrated");
  });

  it("induced worker failure retries once from a fresh worktree, then escalates", async () => {
    const stack = await makeStack();
    const escalations: string[] = [];
    await driveNode(stack, "base", write("base.txt", "base"));
    stack.engine.assign("big");
    const bigModule = stack.plan.modules.find((m) => m.id === "big");
    if (!bigModule) throw new Error("missing module");

    const result = await executeMultiWorkerNode({
      engine: stack.engine,
      repo: stack.repo,
      nodeId: "big",
      module: bigModule,
      lead: scriptedLead(
        { asked: [] },
        {
          1: write("big-a.txt", "fine"),
          2: "echo boom >&2; exit 1", // always fails
        },
      ),
      runtimeFor: () => new ProcessRuntime(),
      maxChargeUsd: 100,
      verification: VERIFY,
      onEscalate: (nodeId, reason) => escalations.push(`${nodeId}: ${reason}`),
    });

    expect(result.outcome).toBe("failed");
    expect(result.attempts[2]).toBe(2); // retried exactly once
    expect(stack.engine.stateOf("big")).toBe("failed");
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain("worker 2 failed after 2 attempts");
  });
});
