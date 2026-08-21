import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { preflightRunnerExecution } from "../dist/index.js";

const exec = promisify(execFile);
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("runner preflight proves worktree, Git metadata, write access, and tools before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "norns-preflight-"));
  roots.push(root);
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  const runtimeState = join(root, "runtime-state");
  await mkdir(repository);
  await mkdir(runtimeState);
  await exec("git", ["-C", repository, "init"]);
  await exec("git", ["-C", repository, "config", "user.name", "Preflight"]);
  await exec("git", ["-C", repository, "config", "user.email", "preflight@example.test"]);
  await exec("git", ["-C", repository, "commit", "--allow-empty", "-m", "base"]);
  await exec("git", ["-C", repository, "worktree", "add", worktree, "-b", "preflight"]);

  const result = await preflightRunnerExecution({
    worktreePath: worktree,
    runtimeStateDirectory: runtimeState,
    requiredCommands: ["git"],
    path: process.env.PATH ?? "",
  });

  assert.match(result.gitCommonDirectory, /repository[/\\]\.git$/);
});

test("runner preflight rejects missing verification executables", async () => {
  const root = await mkdtemp(join(tmpdir(), "norns-preflight-missing-"));
  roots.push(root);
  const repository = join(root, "repository");
  const runtimeState = join(root, "runtime-state");
  await mkdir(repository);
  await mkdir(runtimeState);
  await exec("git", ["-C", repository, "init"]);

  await assert.rejects(
    preflightRunnerExecution({
      worktreePath: repository,
      runtimeStateDirectory: runtimeState,
      requiredCommands: ["definitely-not-a-real-norns-command"],
      path: process.env.PATH ?? "",
    }),
    /required executable is unavailable/,
  );
});
