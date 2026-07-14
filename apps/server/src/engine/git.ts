// Local git repository adapter (PRD R4 §Git): isolated worktrees per
// implementation, branch naming norns/<project>/<node-id>[-w<worker>],
// integration branch management. Uses the plain git CLI (ADR-001) — the CLI
// is the contract. The runner performs pushes; workers never do.
import { execFile } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "norns",
  GIT_AUTHOR_EMAIL: "norns@localhost",
  GIT_COMMITTER_NAME: "norns",
  GIT_COMMITTER_EMAIL: "norns@localhost",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

export interface WorktreeHandle {
  path: string;
  branch: string;
}

export class LocalGitRepo {
  constructor(
    readonly repoDir: string,
    readonly projectSlug: string,
    readonly worktreesDir: string,
  ) {}

  /** Test/bootstrap helper: initialize a repo with an initial commit on main. */
  static async init(
    repoDir: string,
    projectSlug: string,
    worktreesDir: string,
  ): Promise<LocalGitRepo> {
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(worktreesDir, { recursive: true });
    await git(repoDir, ["init", "-b", "main"]);
    await run("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "init"], { env: GIT_ENV });
    return new LocalGitRepo(repoDir, projectSlug, worktreesDir);
  }

  branchFor(nodeId: string, worker?: number): string {
    const suffix = worker !== undefined ? `-w${worker}` : "";
    return `norns/${this.projectSlug}/${nodeId}${suffix}`;
  }

  integrationBranch(): string {
    return `norns/${this.projectSlug}/integration`;
  }

  async ensureIntegrationBranch(): Promise<string> {
    const branch = this.integrationBranch();
    const existing = await git(this.repoDir, ["branch", "--list", branch]);
    if (!existing) await git(this.repoDir, ["branch", branch, "main"]);
    return branch;
  }

  /** Every implementation runs in an isolated worktree on its own branch. */
  async createWorktree(nodeId: string, worker?: number): Promise<WorktreeHandle> {
    const branch = this.branchFor(nodeId, worker);
    const path = join(this.worktreesDir, branch.replaceAll("/", "__"));
    await git(this.repoDir, ["worktree", "add", "-b", branch, path, "main"]);
    // canonical path: git reports realpaths (macOS /var -> /private/var)
    return { path: realpathSync(path), branch };
  }

  async removeWorktree(handle: WorktreeHandle): Promise<void> {
    await git(this.repoDir, ["worktree", "remove", "--force", handle.path]);
  }

  async listWorktreePaths(): Promise<string[]> {
    const output = await git(this.repoDir, ["worktree", "list", "--porcelain"]);
    return output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await git(this.repoDir, ["branch", "--list", branch])) !== "";
  }

  /** Used when a failed worker retries from a fresh worktree. */
  async deleteBranch(branch: string): Promise<void> {
    await git(this.repoDir, ["branch", "-D", branch]).catch(() => undefined);
  }
}
