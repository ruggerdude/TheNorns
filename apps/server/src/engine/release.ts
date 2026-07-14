// Release gate (MVP acceptance #10): main changes ONLY via a human-approved
// merge. The approval's content hash must equal the integration branch HEAD
// the human actually reviewed — approving one state does not authorize
// merging a different one.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { ApprovalT } from "@norns/contracts";
import type { LocalGitRepo } from "./git.js";

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "norns-release",
  GIT_AUTHOR_EMAIL: "release@norns.local",
  GIT_COMMITTER_NAME: "norns-release",
  GIT_COMMITTER_EMAIL: "release@norns.local",
};

export class MergeApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeApprovalError";
  }
}

/** What the human approves: the exact integration HEAD to be merged. */
export async function integrationHeadHash(repo: LocalGitRepo): Promise<string> {
  const branch = repo.integrationBranch();
  const { stdout } = await run("git", ["rev-parse", branch], { cwd: repo.repoDir, env: GIT_ENV });
  return createHash("sha256").update(`merge:${branch}:${stdout.trim()}`).digest("hex");
}

/**
 * Merge the integration branch into main — refused without a matching human
 * merge approval. Local-repo equivalent of PR merge; the GitHub adapter
 * performs the same gate through a PR at deploy time.
 */
export async function mergeIntegrationToMain(
  repo: LocalGitRepo,
  approval: ApprovalT | null,
): Promise<{ commit: string }> {
  if (!approval || approval.kind !== "merge") {
    throw new MergeApprovalError("merging to main requires an explicit human merge approval");
  }
  const expected = await integrationHeadHash(repo);
  if (approval.content_hash !== expected) {
    throw new MergeApprovalError(
      "merge approval hash does not match the current integration HEAD — re-review required",
    );
  }
  // main lives in the primary checkout; merge there (never force-pushed)
  const { stdout: current } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repo.repoDir,
    env: GIT_ENV,
  });
  if (current.trim() !== "main") {
    await run("git", ["checkout", "main"], { cwd: repo.repoDir, env: GIT_ENV });
  }
  await run(
    "git",
    [
      "merge",
      "--no-ff",
      "-m",
      `release: merge ${repo.integrationBranch()}`,
      repo.integrationBranch(),
    ],
    { cwd: repo.repoDir, env: GIT_ENV },
  );
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: repo.repoDir, env: GIT_ENV });
  return { commit: stdout.trim() };
}
