// Phase 7 multi-worker coordination (PRD R4 §Allocation, §Agent Types):
// a Module Lead splits a parallel-safe node into bounded work units (pilot
// cap 2); each worker runs in its OWN worktree on its own -w<k> branch;
// worker questions route through the lead (PM-brokered — workers never talk
// to each other); failures retry once from a fresh worktree, then escalate;
// the lead assembles worker branches into the node branch, which then goes
// through runner verification and the normal review/integration gates.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlanModuleT, VerificationResultT } from "@norns/contracts";
import type { CodingRuntime } from "@norns/runner";
import { type VerificationPlan, runVerification } from "./execution.js";
import type { LocalGitRepo } from "./git.js";
import { EngineError, type WorkflowEngine } from "./workflow.js";

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "norns-lead",
  GIT_AUTHOR_EMAIL: "lead@norns.local",
  GIT_COMMITTER_NAME: "norns-lead",
  GIT_COMMITTER_EMAIL: "lead@norns.local",
};

export interface WorkerSpec {
  worker: number; // 1-based
  prompt: string;
}

export interface ModuleLead {
  /** Bounded decomposition into independent work units. */
  split(module: PlanModuleT): WorkerSpec[];
  /** PM-routed worker question channel. */
  answer(worker: number, question: string): Promise<string>;
}

export interface MultiWorkerOptions {
  engine: WorkflowEngine;
  repo: LocalGitRepo;
  nodeId: string;
  module: PlanModuleT;
  lead: ModuleLead;
  runtimeFor: (spec: WorkerSpec) => CodingRuntime;
  maxChargeUsd: number;
  verification: VerificationPlan;
  actualUsd?: number;
  workerCap?: number; // pilot cap 2
  onEscalate?: (nodeId: string, reason: string) => void;
}

export interface MultiWorkerResult {
  outcome: "in_review" | "failed";
  branch: string;
  commit: string | null;
  workerBranches: string[];
  attempts: Record<number, number>;
  verification: VerificationResultT[];
}

interface WorkerOutcome {
  spec: WorkerSpec;
  branch: string;
  succeeded: boolean;
  attempts: number;
  detail: string;
}

async function runWorkerWithRetry(
  options: MultiWorkerOptions,
  spec: WorkerSpec,
): Promise<WorkerOutcome> {
  const branch = options.repo.branchFor(options.nodeId, spec.worker);
  let detail = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // retry starts from a FRESH worktree (PRD §Failure Handling)
    await options.repo.deleteBranch(branch);
    const worktree = await options.repo.createWorktree(options.nodeId, spec.worker);
    try {
      const result = await options.runtimeFor(spec).run({
        runId: `run_${options.nodeId}_w${spec.worker}_a${attempt}`,
        worktreePath: worktree.path,
        prompt: spec.prompt,
      });
      detail = result.detail;
      if (result.outcome === "completed") {
        return { spec, branch, succeeded: true, attempts: attempt, detail };
      }
    } finally {
      await options.repo.removeWorktree(worktree).catch(() => undefined);
    }
  }
  return { spec, branch, succeeded: false, attempts: 2, detail };
}

/** Lead assembly: merge worker branches into the node branch, in order. */
async function assemble(
  repo: LocalGitRepo,
  nodeId: string,
  workerBranches: string[],
): Promise<{ ok: true; commit: string; branch: string } | { ok: false; conflict: string[] }> {
  const worktree = await repo.createWorktree(nodeId);
  try {
    for (const branch of workerBranches) {
      try {
        await run("git", ["merge", "--no-ff", "-m", `assemble ${branch}`, branch], {
          cwd: worktree.path,
          env: GIT_ENV,
        });
      } catch {
        const { stdout } = await run("git", ["diff", "--name-only", "--diff-filter=U"], {
          cwd: worktree.path,
          env: GIT_ENV,
        });
        await run("git", ["merge", "--abort"], { cwd: worktree.path, env: GIT_ENV }).catch(
          () => undefined,
        );
        return { ok: false, conflict: stdout.trim().split("\n").filter(Boolean) };
      }
    }
    const { stdout } = await run("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      env: GIT_ENV,
    });
    return { ok: true, commit: stdout.trim(), branch: worktree.branch };
  } finally {
    await repo.removeWorktree(worktree).catch(() => undefined);
  }
}

export async function executeMultiWorkerNode(
  options: MultiWorkerOptions,
): Promise<MultiWorkerResult> {
  const cap = options.workerCap ?? 2;
  const specs = options.lead.split(options.module);
  if (specs.length === 0 || specs.length > cap) {
    throw new EngineError(
      `module lead produced ${specs.length} work units; bounded decomposition requires 1..${cap}`,
    );
  }

  const { engine, nodeId } = options;
  engine.startRun(nodeId, options.maxChargeUsd); // one node-level budget gate

  const outcomes = await Promise.all(specs.map((spec) => runWorkerWithRetry(options, spec)));
  const attempts: Record<number, number> = {};
  for (const outcome of outcomes) attempts[outcome.spec.worker] = outcome.attempts;
  const workerBranches = outcomes.map((outcome) => outcome.branch);

  const fail = (reason: string): MultiWorkerResult => {
    engine.completeRun(nodeId, options.actualUsd ?? 0);
    engine.recordVerification(nodeId, false);
    options.onEscalate?.(nodeId, reason);
    return {
      outcome: "failed",
      branch: options.repo.branchFor(nodeId),
      commit: null,
      workerBranches,
      attempts,
      verification: [],
    };
  };

  const failedWorker = outcomes.find((outcome) => !outcome.succeeded);
  if (failedWorker) {
    return fail(
      `worker ${failedWorker.spec.worker} failed after ${failedWorker.attempts} attempts: ${failedWorker.detail.slice(0, 300)}`,
    );
  }

  const assembly = await assemble(options.repo, nodeId, workerBranches);
  if (!assembly.ok) {
    return fail(`lead assembly conflict on [${assembly.conflict.join(", ")}]`);
  }

  engine.completeRun(nodeId, options.actualUsd ?? options.maxChargeUsd * 0.5);
  const verification = await runVerification(
    options.repo,
    assembly.commit,
    nodeId,
    `run_${nodeId}_assembled`,
    options.verification,
  );
  const allPassed = verification.every((entry) => entry.passed);
  engine.recordVerification(nodeId, allPassed);

  return {
    outcome: allPassed ? "in_review" : "failed",
    branch: assembly.branch,
    commit: assembly.commit,
    workerBranches,
    attempts,
    verification,
  };
}
