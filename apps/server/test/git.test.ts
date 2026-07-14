// Worktree manager against a real git repo: isolated worktrees on named
// branches, integration branch, clean removal. (PRD §Git; ADR-001: plain CLI.)
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalGitRepo } from "../src/engine/git.js";

describe("local git worktree adapter", () => {
  it("creates isolated worktrees with contract branch names and removes them", async () => {
    const base = mkdtempSync(join(tmpdir(), "norns-git-"));
    const repo = await LocalGitRepo.init(join(base, "repo"), "pilot", join(base, "trees"));

    const single = await repo.createWorktree("auth-module");
    expect(single.branch).toBe("norns/pilot/auth-module");
    expect(existsSync(single.path)).toBe(true);

    const worker = await repo.createWorktree("big-module", 2);
    expect(worker.branch).toBe("norns/pilot/big-module-w2");

    const paths = await repo.listWorktreePaths();
    expect(paths).toContain(single.path);
    expect(paths).toContain(worker.path);

    await repo.removeWorktree(single.path ? single : single);
    expect(existsSync(single.path)).toBe(false);
    // the branch survives worktree removal (work is preserved for audit)
    expect(await repo.branchExists(single.branch)).toBe(true);
  });

  it("creates the integration branch once, idempotently", async () => {
    const base = mkdtempSync(join(tmpdir(), "norns-git-"));
    const repo = await LocalGitRepo.init(join(base, "repo"), "pilot", join(base, "trees"));
    expect(await repo.ensureIntegrationBranch()).toBe("norns/pilot/integration");
    expect(await repo.ensureIntegrationBranch()).toBe("norns/pilot/integration");
    expect(await repo.branchExists("norns/pilot/integration")).toBe(true);
  });
});
