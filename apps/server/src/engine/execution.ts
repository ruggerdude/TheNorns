// Phase 5 execution pipeline: worktree -> runtime run (worker commits
// locally) -> RUNNER-EXECUTED verification in a clean worktree at the exact
// commit (a worker's claim is evidence, not state) -> in_review gate, with
// budget reservation before dispatch and settlement from reported usage.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { VerificationResultT } from "@norns/contracts";
import type { CodingRuntime } from "@norns/runner";
import { newId } from "../ids.js";
import type { LocalGitRepo, WorktreeHandle } from "./git.js";
import type { WorkflowEngine } from "./workflow.js";

const run = promisify(execFile);

export interface VerificationPlan {
  /** project-level Required Verification Commands (human-approved, always run) */
  required: string[];
  /** module test_commands — ADDITIVE only */
  module: string[];
}

export interface ExecuteNodeOptions {
  engine: WorkflowEngine;
  repo: LocalGitRepo;
  runtime: CodingRuntime;
  nodeId: string;
  prompt: string;
  maxChargeUsd: number;
  verification: VerificationPlan;
  /** estimate used to settle usage; live adapters report real tokens */
  actualUsd?: number;
  onLog?: (chunk: string) => void;
}

export interface ExecuteNodeResult {
  outcome: "in_review" | "failed";
  commit: string | null;
  branch: string;
  verification: VerificationResultT[];
  runtimeDetail: string;
}

async function headOf(worktreePath: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  return stdout.trim();
}

/** Runner-side verification: fresh detached worktree at the exact commit. */
export async function runVerification(
  repo: LocalGitRepo,
  commit: string,
  nodeId: string,
  runId: string,
  plan: VerificationPlan,
): Promise<VerificationResultT[]> {
  const verifyPath = `${repo.worktreesDir}/verify-${nodeId}-${Date.now()}`;
  await run("git", ["worktree", "add", "--detach", verifyPath, commit], { cwd: repo.repoDir });
  const results: VerificationResultT[] = [];
  try {
    const commands: { command: string; kind: "required" | "module" }[] = [
      ...plan.required.map((command) => ({ command, kind: "required" as const })),
      ...plan.module.map((command) => ({ command, kind: "module" as const })),
    ];
    for (const entry of commands) {
      let passed = true;
      let output = "";
      try {
        const { stdout, stderr } = await run("sh", ["-c", entry.command], {
          cwd: verifyPath,
          timeout: 60_000,
        });
        output = stdout + stderr;
      } catch (error) {
        passed = false;
        output = error instanceof Error ? error.message : String(error);
      }
      results.push({
        id: newId("verif"),
        node_id: nodeId,
        run_id: runId,
        commit_sha: commit,
        command: entry.command,
        kind: entry.kind,
        passed,
        output_digest: createHash("sha256").update(output).digest("hex"),
        executed_at: new Date().toISOString(),
      });
    }
  } finally {
    await run("git", ["worktree", "remove", "--force", verifyPath], { cwd: repo.repoDir }).catch(
      () => undefined,
    );
  }
  return results;
}

/**
 * Drive one assigned node through running -> verifying -> in_review|failed.
 * Throws BudgetExceededError/KillSwitchEngagedError from startRun — the
 * caller decides escalation (Phase 7 coordinator adds retry + PM escalation).
 */
export async function executeNode(options: ExecuteNodeOptions): Promise<ExecuteNodeResult> {
  const { engine, repo, runtime, nodeId } = options;
  engine.startRun(nodeId, options.maxChargeUsd); // budget gate BEFORE dispatch

  let worktree: WorktreeHandle | null = null;
  try {
    worktree = await repo.createWorktree(nodeId);
    const runId = `run_${nodeId}_${Date.now()}`;
    const result = await runtime.run({
      runId,
      worktreePath: worktree.path,
      prompt: options.prompt,
      ...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
    });

    if (result.outcome !== "completed") {
      engine.completeRun(nodeId, options.actualUsd ?? 0);
      engine.recordVerification(nodeId, false);
      return {
        outcome: "failed",
        commit: null,
        branch: worktree.branch,
        verification: [],
        runtimeDetail: result.detail,
      };
    }

    const commit = await headOf(worktree.path);
    engine.completeRun(nodeId, options.actualUsd ?? options.maxChargeUsd * 0.5);

    const verification = await runVerification(repo, commit, nodeId, runId, options.verification);
    const allPassed = verification.every((entry) => entry.passed);
    engine.recordVerification(nodeId, allPassed);

    return {
      outcome: allPassed ? "in_review" : "failed",
      commit,
      branch: worktree.branch,
      verification,
      runtimeDetail: result.detail,
    };
  } finally {
    // worktree removed; the branch survives for review/integration/audit
    if (worktree) await repo.removeWorktree(worktree).catch(() => undefined);
  }
}
