import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_VERIFICATION_POLICY_REF,
  autoDetectVerificationCommands,
  isHygieneOnly,
  runnerVerificationPolicies,
} from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "norns-test",
  GIT_AUTHOR_EMAIL: "test@norns.local",
  GIT_COMMITTER_NAME: "norns-test",
  GIT_COMMITTER_EMAIL: "test@norns.local",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/** Commit `files` into a fresh repo and return {repo, commit}. */
async function repoWith(
  cleanup: string[],
  files: Record<string, string>,
): Promise<{ repo: string; commit: string }> {
  const repo = await mkdtemp(resolve(tmpdir(), "norns-autodetect-"));
  cleanup.push(repo);
  await execFileAsync("git", ["init", "--initial-branch=main", repo], { env: GIT_ENV });
  for (const [path, body] of Object.entries(files)) {
    await writeFile(resolve(repo, path), body);
  }
  await execFileAsync("git", ["-C", repo, "add", "-A"], { env: GIT_ENV });
  await execFileAsync("git", ["-C", repo, "commit", "-m", "seed"], { env: GIT_ENV });
  const { stdout } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"], {
    env: GIT_ENV,
  });
  return { repo, commit: stdout.trim() };
}

describe("runner verification policy startup", () => {
  it("provides the folder onboarding policy without manual environment setup", () => {
    const commands = runnerVerificationPolicies(undefined).get(DEFAULT_VERIFICATION_POLICY_REF);
    expect(commands).toEqual([
      { name: "git-hygiene", command: ["git", "diff-tree", "--check", "--root", "HEAD"] },
    ]);
    // EXECUTION E4 — the built-in default is a whitespace lint, and the runner
    // now knows that about itself so a green badge earned by it alone can be
    // labelled as such instead of masquerading as a passing test suite.
    expect(isHygieneOnly(commands ?? [])).toBe(true);
  });

  it("accepts an explicit replacement policy map and rejects malformed commands", () => {
    // The pre-E4 bare-argv form still parses, so a deployment that configured a
    // single command before this phase keeps working untouched.
    expect(
      runnerVerificationPolicies(
        JSON.stringify({ [DEFAULT_VERIFICATION_POLICY_REF]: ["pnpm", "test"] }),
      ).get(DEFAULT_VERIFICATION_POLICY_REF),
    ).toEqual([{ name: DEFAULT_VERIFICATION_POLICY_REF, command: ["pnpm", "test"] }]);
    expect(() =>
      runnerVerificationPolicies(JSON.stringify({ [DEFAULT_VERIFICATION_POLICY_REF]: [] })),
    ).toThrow(/non-empty string array/);
  });

  it("accepts an ordered list of named commands so build, test and lint report separately", () => {
    const policies = runnerVerificationPolicies(
      JSON.stringify({
        verification: [
          { name: "build", command: ["pnpm", "run", "build"] },
          { name: "test", command: ["pnpm", "test"] },
          { name: "lint", command: ["pnpm", "exec", "biome", "check"] },
        ],
      }),
    );
    expect(policies.get("verification")).toEqual([
      { name: "build", command: ["pnpm", "run", "build"] },
      { name: "test", command: ["pnpm", "test"] },
      { name: "lint", command: ["pnpm", "exec", "biome", "check"] },
    ]);
    expect(isHygieneOnly(policies.get("verification") ?? [])).toBe(false);
    expect(() =>
      runnerVerificationPolicies(JSON.stringify({ verification: [{ name: "test" }] })),
    ).toThrow(/must be \{ name, command/);
  });
});

describe("EXEC-VERIFY-AUTODETECT: verification auto-detected from package.json", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("derives install/build/test from a committed package.json, keyed to the lockfile's package manager", async () => {
    const { repo, commit } = await repoWith(cleanup, {
      "package.json": JSON.stringify({
        scripts: { build: "tsc -p .", test: "vitest run" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    expect(await autoDetectVerificationCommands(repo, commit)).toEqual([
      { name: "install", command: ["pnpm", "install", "--frozen-lockfile"] },
      { name: "build", command: ["pnpm", "run", "build"] },
      { name: "test", command: ["pnpm", "test"] },
    ]);
  });

  it("defaults to npm ci when a package-lock is committed, npm install when none is", async () => {
    const withLock = await repoWith(cleanup, {
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "package-lock.json": "{}\n",
    });
    expect(await autoDetectVerificationCommands(withLock.repo, withLock.commit)).toEqual([
      { name: "install", command: ["npm", "ci"] },
      { name: "test", command: ["npm", "test"] },
    ]);
    const noLock = await repoWith(cleanup, {
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    });
    expect((await autoDetectVerificationCommands(noLock.repo, noLock.commit))?.[0]).toEqual({
      name: "install",
      command: ["npm", "install"],
    });
  });

  it("returns null (fails closed honestly) with no package.json or only the npm-init placeholder", async () => {
    const noPkg = await repoWith(cleanup, { "README.md": "# app\n" });
    expect(await autoDetectVerificationCommands(noPkg.repo, noPkg.commit)).toBeNull();

    const placeholder = await repoWith(cleanup, {
      "package.json": JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    });
    expect(await autoDetectVerificationCommands(placeholder.repo, placeholder.commit)).toBeNull();
  });
});
