// Integration agent (PRD R4): merges verified node branches into the
// integration branch in dependency order. CLEAN MERGES ONLY — on conflict the
// node blocks, and the engine spawns a conflict-resolution node that REPLACES
// the original (outgoing edges move, original archived `superseded`).
// Integrating a conflict node that materially modified both sides requires
// explicit human confirmation. Never force-pushes, never touches main.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkflowGraph } from "../graph/graph.js";
import type { LocalGitRepo } from "./git.js";
import type { WorkflowEngine } from "./workflow.js";

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "norns-integration",
  GIT_AUTHOR_EMAIL: "integration@norns.local",
  GIT_COMMITTER_NAME: "norns-integration",
  GIT_COMMITTER_EMAIL: "integration@norns.local",
};

export type MergeResult =
  | { merged: true; commit: string }
  | { merged: false; conflict_files: string[] };

/** Attempt a clean --no-ff merge of a node branch into the integration branch. */
export async function integrateBranch(repo: LocalGitRepo, branch: string): Promise<MergeResult> {
  const integration = await repo.ensureIntegrationBranch();
  const path = `${repo.worktreesDir}/integration-${Date.now()}`;
  await run("git", ["worktree", "add", path, integration], { cwd: repo.repoDir, env: GIT_ENV });
  try {
    try {
      await run("git", ["merge", "--no-ff", "-m", `integrate ${branch}`, branch], {
        cwd: path,
        env: GIT_ENV,
      });
    } catch {
      const { stdout } = await run("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: path,
        env: GIT_ENV,
      });
      await run("git", ["merge", "--abort"], { cwd: path, env: GIT_ENV }).catch(() => undefined);
      return { merged: false, conflict_files: stdout.trim().split("\n").filter(Boolean) };
    }
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: path, env: GIT_ENV });
    return { merged: true, commit: stdout.trim() };
  } finally {
    await run("git", ["worktree", "remove", "--force", path], {
      cwd: repo.repoDir,
      env: GIT_ENV,
    }).catch(() => undefined);
  }
}

export interface ConflictNodeSpec {
  conflictNodeId: string;
  rewiredDependents: string[];
}

/**
 * Replacement semantics (PRD R4): the conflict node inherits the original's
 * dependencies, every dependent is rewired to it, and the original is
 * archived as `superseded` — preserved for audit, never deleted.
 */
export function spawnConflictNode(
  engine: WorkflowEngine,
  graph: WorkflowGraph | null,
  nodeId: string,
): ConflictNodeSpec {
  const conflictNodeId = `${nodeId}-conflict`;
  const dependencies = [...engine.dependenciesOf(nodeId)];
  engine.registerNode(conflictNodeId, dependencies);

  const rewired: string[] = [];
  for (const candidate of engine.nodeIds()) {
    if (candidate === conflictNodeId) continue;
    if (engine.dependenciesOf(candidate).includes(nodeId)) {
      engine.replaceDependency(candidate, nodeId, conflictNodeId);
      rewired.push(candidate);
    }
  }
  engine.supersede(nodeId);

  if (graph) {
    graph.addNode({ id: conflictNodeId, title: `Conflict resolution: ${nodeId}`, dependencies });
    for (const dependent of rewired) {
      graph.removeEdge(nodeId, dependent);
      graph.addEdge(conflictNodeId, dependent);
    }
  }
  return { conflictNodeId, rewiredDependents: rewired };
}

export class HumanConfirmationRequiredError extends Error {
  constructor(nodeId: string) {
    super(
      `conflict node ${nodeId} materially modified both sides: explicit human confirmation is required before integration`,
    );
    this.name = "HumanConfirmationRequiredError";
  }
}

export interface IntegrateNodeOptions {
  engine: WorkflowEngine;
  repo: LocalGitRepo;
  nodeId: string;
  branch: string;
  graph?: WorkflowGraph;
  /** conflict nodes touching both sides need this to be true */
  isConflictResolution?: boolean;
  humanConfirmed?: boolean;
  onEscalate?: (nodeId: string, reason: string) => void;
}

export type IntegrateNodeResult =
  | { integrated: true; commit: string }
  | { integrated: false; conflict: ConflictNodeSpec };

/** Full integration step for a `verified` node, with the conflict path. */
export async function integrateNode(options: IntegrateNodeOptions): Promise<IntegrateNodeResult> {
  const { engine, repo, nodeId, branch } = options;
  if (options.isConflictResolution && !options.humanConfirmed) {
    throw new HumanConfirmationRequiredError(nodeId);
  }
  const result = await integrateBranch(repo, branch);
  if (result.merged) {
    engine.integrate(nodeId);
    return { integrated: true, commit: result.commit };
  }
  engine.block(nodeId, "integration");
  options.onEscalate?.(
    nodeId,
    `merge conflict on [${result.conflict_files.join(", ")}]: conflict-resolution node spawned`,
  );
  const conflict = spawnConflictNode(engine, options.graph ?? null, nodeId);
  return { integrated: false, conflict };
}
