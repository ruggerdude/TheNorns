import { execFile } from "node:child_process";
// Pilot dress rehearsal: the full MVP flow on one project with deterministic
// agents — planning loop -> human approvals (strict content hashes) -> graph
// + allocation -> execution (incl. the 2-worker node) -> review gates ->
// integration -> dashboard -> human-gated merge to main. This is the
// mechanics of MVP acceptance run end to end; the live pilot re-runs it with
// real models and the chosen project (NORN-006/027).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FakeAdapter } from "@norns/adapters";
import { ProjectMemoryEntry } from "@norns/contracts";
import { ProcessRuntime } from "@norns/runner";
import { describe, expect, it } from "vitest";
import { buildDashboard } from "../src/dashboard.js";
import { BudgetExceededError, BudgetLedger } from "../src/engine/budget.js";
import { executeMultiWorkerNode } from "../src/engine/coordination.js";
import { executeNode } from "../src/engine/execution.js";
import { LocalGitRepo } from "../src/engine/git.js";
import { integrateNode } from "../src/engine/integration.js";
import { integrationHeadHash, mergeIntegrationToMain } from "../src/engine/release.js";
import { EngineError, WorkflowEngine } from "../src/engine/workflow.js";
import {
  approveAllocation,
  autoAllocate,
  costPreview,
  overrideAssignment,
} from "../src/graph/allocation.js";
import { WorkflowGraph } from "../src/graph/graph.js";
import { approvePlan, runPlanning } from "../src/planning/session.js";

const run = promisify(execFile);

const write = (file: string, content: string) =>
  `echo "${content}" > ${file} && git add -A && git commit -q -m "write ${file}"`;

function pilotPlanJson() {
  const mod = (
    id: string,
    deps: string[],
    complexity: "S" | "M" | "L" | "XL",
    parallelSafe = false,
  ) => ({
    id,
    title: `Module ${id}`,
    description: `Implements ${id}`,
    deliverables: [`${id}.txt`],
    acceptance: [
      {
        id: "AC-1",
        statement: `${id}.txt exists`,
        verification_type: "command",
        verification: `test -f ${id}.txt`,
      },
    ],
    dependencies: deps,
    estimated_complexity: complexity,
    risk: "low",
    parallelization: {
      safe: parallelSafe,
      candidate_work_units: parallelSafe ? ["part-1", "part-2"] : [],
      shared_files: [],
      integration_owner_required: true,
    },
  });
  return {
    objective: "Ship the pilot service",
    modules: [
      mod("core", [], "M"),
      mod("feature", ["core"], "XL", true), // the 2-worker node
      mod("docs", ["core"], "S"),
      mod("ship", ["feature", "docs"], "M"),
    ],
  };
}

const MEMORY = [
  ProjectMemoryEntry.parse({
    id: "mem-pilot",
    directive: "Never install dependencies automatically.",
    version: 1,
    created_by: "human",
    approved_by_human: true,
    created_at: "2026-07-14T00:00:00.000Z",
  }),
];

describe("pilot dress rehearsal — full MVP flow", () => {
  it("plan -> approvals -> graph -> allocate -> execute -> review -> integrate -> dashboard -> merge to main", async () => {
    // ---- 1. cross-provider planning loop (converges in round two) -----------
    const pm = new FakeAdapter("anthropic");
    const reviewer = new FakeAdapter("openai");
    pm.enqueue(pilotPlanJson());
    reviewer.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: "ship",
          finding: "ship lacks a release note",
          recommendation: "add docs dependency",
        },
      ],
    });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "accept", rationale: "docs added as dep" }],
      plan: pilotPlanJson(),
    });
    reviewer.enqueue({ findings: [] });

    const planning = await runPlanning({
      pm,
      reviewer,
      objective: "Ship the pilot service",
      projectId: "proj-pilot",
      memory: MEMORY,
    });
    expect(planning.status).toBe("converged");
    expect(planning.rounds).toBe(2);
    expect(pm.requests[0]?.system).toContain("Never install dependencies"); // memory in every context
    expect(reviewer.requests[0]?.system).toContain("Never install dependencies");

    // ---- 2. human plan approval (content hash of exactly what was seen) -----
    const planApproval = approvePlan(planning.finalPlan, "dhatwell");

    // ---- 3. graph + allocation + human override + allocation approval -------
    const graph = WorkflowGraph.fromPlan(planning.finalPlan);
    autoAllocate(graph, "balanced");
    overrideAssignment(graph, "docs", { budget_usd: 15 }); // human touch persists
    autoAllocate(graph, "balanced"); // re-run must not clobber the override
    expect(graph.node("docs")?.assignment?.budget_usd).toBe(15);
    const preview = costPreview(graph);
    expect(preview.unallocated).toHaveLength(0);
    const allocationApproval = approveAllocation(graph, "dhatwell");

    // ---- 4. engine start is STRICT on approval hashes ------------------------
    const budget = new BudgetLedger(2 * preview.total_usd);
    for (const node of graph.snapshot().nodes) {
      budget.approve(node.id, node.assignment?.budget_usd ?? 0);
    }
    const engine = new WorkflowEngine({ plan: planning.finalPlan, budget });
    engine.recordApproval(planApproval);
    engine.recordApproval(allocationApproval);
    expect(() =>
      engine.start({ planHash: "0".repeat(64), allocationHash: allocationApproval.content_hash }),
    ).toThrow(EngineError); // tampered plan hash refuses to start
    engine.start({
      planHash: planApproval.content_hash,
      allocationHash: allocationApproval.content_hash,
    });
    graph.attachStateLookup((id) => engine.stateOf(id));
    graph.markExecutionStarted();

    // ---- 5. execution ---------------------------------------------------------
    const base = mkdtempSync(join(tmpdir(), "norns-pilot-"));
    const repo = await LocalGitRepo.init(join(base, "repo"), "pilot", join(base, "trees"));
    const ledgerUsage = planning.usage; // planning calls already metered
    const verification = (id: string) => ({ required: [`test -f ${id}.txt`], module: [] });

    const driveSingle = async (nodeId: string, extraFile?: string) => {
      engine.assign(nodeId);
      const budgetUsd = graph.node(nodeId)?.assignment?.budget_usd ?? 10;
      const result = await executeNode({
        engine,
        repo,
        runtime: new ProcessRuntime(),
        nodeId,
        prompt: write(`${nodeId}.txt`, `content of ${nodeId}`),
        maxChargeUsd: budgetUsd,
        actualUsd: budgetUsd * 0.4,
        verification: verification(extraFile ?? nodeId),
      });
      expect(result.outcome).toBe("in_review");
      engine.reviewerDecision(nodeId, "approve");
      const integrated = await integrateNode({
        engine,
        repo,
        graph,
        nodeId,
        branch: result.branch,
      });
      expect(integrated.integrated).toBe(true);
    };

    await driveSingle("core");
    expect(engine.stateOf("feature")).toBe("ready");

    // budget gate fires before dispatch, then the human-adjusted retry succeeds
    engine.assign("docs");
    await expect(
      executeNode({
        engine,
        repo,
        runtime: new ProcessRuntime(),
        nodeId: "docs",
        prompt: write("docs.txt", "docs"),
        maxChargeUsd: 500, // docs approved at the overridden $15
        verification: verification("docs"),
      }),
    ).rejects.toThrow(BudgetExceededError);
    expect(engine.stateOf("docs")).toBe("blocked");
    engine.resume("docs");
    const docsRun = await executeNode({
      engine,
      repo,
      runtime: new ProcessRuntime(),
      nodeId: "docs",
      prompt: write("docs.txt", "docs"),
      maxChargeUsd: 10,
      actualUsd: 4,
      verification: verification("docs"),
    });
    engine.reviewerDecision("docs", "approve");
    expect(
      (await integrateNode({ engine, repo, graph, nodeId: "docs", branch: docsRun.branch }))
        .integrated,
    ).toBe(true);

    // the 2-worker node through the Module Lead
    engine.assign("feature");
    const featureModule = planning.finalPlan.modules.find((m) => m.id === "feature");
    if (!featureModule) throw new Error("missing module");
    const multi = await executeMultiWorkerNode({
      engine,
      repo,
      nodeId: "feature",
      module: featureModule,
      lead: {
        split: (module) =>
          module.parallelization.candidate_work_units.map((unit, index) => ({
            worker: index + 1,
            prompt: write(`feature-${unit}.txt`, unit),
          })),
        answer: async () => "proceed",
      },
      runtimeFor: () => new ProcessRuntime(),
      maxChargeUsd: graph.node("feature")?.assignment?.budget_usd ?? 100,
      actualUsd: 40,
      verification: {
        required: ["test -f feature-part-1.txt", "test -f feature-part-2.txt"],
        module: [],
      },
    });
    expect(multi.outcome).toBe("in_review");
    expect(multi.workerBranches).toHaveLength(2);
    engine.reviewerDecision("feature", "approve");
    expect(
      (await integrateNode({ engine, repo, graph, nodeId: "feature", branch: multi.branch }))
        .integrated,
    ).toBe(true);

    await driveSingle("ship");
    expect(engine.states()).toEqual({
      core: "integrated",
      feature: "integrated",
      docs: "integrated",
      ship: "integrated",
    });

    // ---- 6. dashboard reflects the ledger and the gates -----------------------
    const dto = buildDashboard({
      engine,
      budget,
      ledger: ledgerUsage,
      audit: [],
      complexityOf: (id) =>
        planning.finalPlan.modules.find((m) => m.id === id)?.estimated_complexity ?? "M",
      graphVersion: graph.version,
    });
    expect(dto.progress_pct).toBe(100);
    expect(dto.cost.settled_usd).toBe(budget.summary().settled_usd);
    expect(dto.eta.label).toBe("experimental");
    expect(dto.pm_summary).toContain("4/4 nodes integrated");

    // ---- 7. human-gated merge to main -----------------------------------------
    const mergeApproval = {
      id: "appr-merge",
      kind: "merge" as const,
      actor: "dhatwell",
      approved_at: new Date().toISOString(),
      content_hash: await integrationHeadHash(repo),
    };
    const release = await mergeIntegrationToMain(repo, mergeApproval);
    expect(release.commit).toMatch(/^[a-f0-9]{40}$/);

    // main actually contains every module's work — end to end, for real
    for (const file of [
      "core.txt",
      "docs.txt",
      "feature-part-1.txt",
      "feature-part-2.txt",
      "ship.txt",
    ]) {
      const { stdout } = await run("git", ["show", `main:${file}`], { cwd: repo.repoDir });
      expect(stdout.trim().length).toBeGreaterThan(0);
    }
  }, 30_000);
});
