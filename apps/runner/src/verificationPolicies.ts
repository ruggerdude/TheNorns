// EXECUTION E4 — where a run's verification commands come from.
//
// Two sources, checked in this order:
//
//  1. NORNS_VERIFICATION_POLICIES_JSON — an operator-configured allowlist,
//     keyed by the dispatch command's `verification_policy_ref`. This is the
//     strongest source: a human wrote it into the deployment's environment and
//     nothing inside the repository can change it.
//
//  2. `.norns/verification.json`, read out of the GIT OBJECT STORE at the exact
//     commit under test. This exists because the project's real build/test/lint
//     commands live server-side as `project_memory_entries` prose that is
//     rendered into the agent's PROMPT and never reaches the runner as an
//     executable spec — see the E4 report. Until the dispatch command can carry
//     them structurally, a committed, reviewable manifest is the only way the
//     runner can run a project's actual test suite.
//
// If neither yields commands, verification FAILS CLOSED with a reason naming
// the missing configuration. It never falls back to something green.
//
// ON TRUSTING A FILE FROM THE REPOSITORY
// --------------------------------------
// The manifest decides what gets executed, which looks like a new trust
// boundary but is not: the runner has already run an autonomous coding agent
// with write access inside this very worktree. A repository that wanted to
// execute code on the runner never needed the manifest to do it. The manifest's
// real advantage is that, unlike the agent, it is committed, diffable, and
// reviewed in the pull request. Operators who disagree can set
// NORNS_VERIFICATION_ALLOW_REPO_MANIFEST=0 and use the allowlist alone.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_VERIFICATION_POLICY_REF = "verification-policy:default-v1";

/** Path of the in-repository manifest, relative to the repository root. */
export const REPOSITORY_VERIFICATION_MANIFEST = ".norns/verification.json";

/**
 * A single command to run, with the name a human will read in the report.
 *
 * `command` is an argv vector, never a shell string. There is no interpolation
 * anywhere in this path, so a repository containing `test: rm -rf / #` gets a
 * process named `rm -rf / #` that does not exist, rather than a shell.
 */
export interface VerificationCommand {
  readonly name: string;
  readonly command: readonly [string, ...string[]];
}

export type VerificationPolicyMap = ReadonlyMap<string, readonly VerificationCommand[]>;

/**
 * A conservative Git hygiene check, kept only for the policy ref that has
 * always named it.
 *
 * IT IS NOT A TEST SUITE, and E4 stopped letting it pretend to be one. It
 * checks for whitespace errors in the commit and nothing else. A run whose only
 * verification is this one is reported with that fact attached, so a green
 * badge cannot quietly mean "an agent committed some whitespace correctly".
 */
const DEFAULT_VERIFICATION_COMMANDS: readonly VerificationCommand[] = [
  { name: "git-hygiene", command: ["git", "diff-tree", "--check", "--root", "HEAD"] },
];

/**
 * True when the resolved commands are only the built-in hygiene check — i.e.
 * nobody has told this deployment how to actually test the project.
 */
export function isHygieneOnly(commands: readonly VerificationCommand[]): boolean {
  return commands.length === 1 && commands[0]?.name === "git-hygiene";
}

function parseCommands(policy: string, value: unknown): readonly VerificationCommand[] {
  // Legacy form: a bare argv array. Still accepted so an operator who
  // configured a single command before E4 keeps working unchanged.
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    if (value.length === 0) {
      throw new Error(`verification policy ${policy} must be a non-empty string array`);
    }
    return [{ name: policy, command: value as [string, ...string[]] }];
  }
  // Rich form: an ordered list of named commands, so a project can run build,
  // test AND lint and have each reported separately.
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new Error(`verification policy ${policy} must be a non-empty string array`);
    }
    return value.map((entry, index) => {
      const record = entry as { name?: unknown; command?: unknown };
      if (
        typeof record !== "object" ||
        record === null ||
        !Array.isArray(record.command) ||
        record.command.length === 0 ||
        !record.command.every((part) => typeof part === "string")
      ) {
        throw new Error(
          `verification policy ${policy} command ${index} must be { name, command: [string, ...] }`,
        );
      }
      return {
        name: typeof record.name === "string" && record.name ? record.name : `command-${index}`,
        command: record.command as [string, ...string[]],
      };
    });
  }
  throw new Error(`verification policy ${policy} must be a non-empty string array`);
}

export function runnerVerificationPolicies(raw: string | undefined): VerificationPolicyMap {
  const parsed =
    raw === undefined
      ? { [DEFAULT_VERIFICATION_POLICY_REF]: DEFAULT_VERIFICATION_COMMANDS }
      : JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("NORNS_VERIFICATION_POLICIES_JSON must be a JSON object");
  }
  const policies = new Map<string, readonly VerificationCommand[]>();
  for (const [policy, value] of Object.entries(parsed as Record<string, unknown>)) {
    policies.set(
      policy,
      // The built-in default is already in the target shape.
      policy === DEFAULT_VERIFICATION_POLICY_REF && value === DEFAULT_VERIFICATION_COMMANDS
        ? DEFAULT_VERIFICATION_COMMANDS
        : parseCommands(policy, value),
    );
  }
  return policies;
}

/**
 * Read the project's committed verification manifest AT THE EXACT COMMIT.
 *
 * `git show <commit>:<path>` reads the blob recorded in that commit's tree, not
 * whatever happens to be sitting in the working directory. That distinction is
 * the whole point: the commands that run are the ones the commit under test
 * actually contains, so an agent cannot drop a permissive manifest into the
 * working tree without committing it and having it appear in the diff a human
 * reviews.
 *
 * Returns null when the repository has no manifest — an ordinary, expected
 * situation, not an error.
 */
export async function readRepositoryVerificationManifest(
  worktreePath: string,
  commit: string,
): Promise<readonly VerificationCommand[] | null> {
  if (process.env.NORNS_VERIFICATION_ALLOW_REPO_MANIFEST === "0") return null;
  let raw: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, "show", `${commit}:${REPOSITORY_VERIFICATION_MANIFEST}`],
      { maxBuffer: 1024 * 1024 },
    );
    raw = stdout;
  } catch {
    return null; // No manifest at this commit.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${REPOSITORY_VERIFICATION_MANIFEST} at ${commit} is not valid JSON`);
  }
  const record = parsed as { commands?: unknown };
  if (typeof record !== "object" || record === null || !Array.isArray(record.commands)) {
    throw new Error(
      `${REPOSITORY_VERIFICATION_MANIFEST} must be an object with a "commands" array`,
    );
  }
  if (record.commands.length === 0) return null;
  return parseCommands(REPOSITORY_VERIFICATION_MANIFEST, record.commands);
}

/** A blob at the exact commit, or null when the path is absent there. */
async function fileAtCommit(
  worktreePath: string,
  commit: string,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, "show", `${commit}:${path}`],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * EXEC-VERIFY-AUTODETECT — the last resort BEFORE failing closed: run the
 * project's OWN declared build/test, derived from its committed `package.json`.
 *
 * This is what makes verification work for a greenfield project with no
 * ingested facts, no plan-level acceptance commands, and no committed
 * `.norns/verification.json` — the exact case that otherwise fails closed with
 * nothing to run. It is honest by construction: it runs the scripts the project
 * itself declares (the tests a human reading the repo would run), never a
 * stand-in. A project with no real build or test script (only the `npm init`
 * "no test specified" placeholder, or nothing) still returns null and falls
 * through to the fail-closed message, because inventing a green check for a
 * project that declares no verification is the dishonesty E4 removed.
 *
 * The package manager is read from the committed lockfile so the command
 * matches how the project is actually built; `npm` with no lockfile is the
 * conservative default. Set NORNS_VERIFICATION_AUTODETECT=0 to disable and rely
 * only on explicit configuration.
 */
export async function autoDetectVerificationCommands(
  worktreePath: string,
  commit: string,
): Promise<readonly VerificationCommand[] | null> {
  if (process.env.NORNS_VERIFICATION_AUTODETECT === "0") return null;
  const raw = await fileAtCommit(worktreePath, commit, "package.json");
  if (raw === null) return null;
  let pkg: { scripts?: unknown };
  try {
    pkg = JSON.parse(raw) as { scripts?: unknown };
  } catch {
    return null;
  }
  const scripts =
    pkg.scripts && typeof pkg.scripts === "object" ? (pkg.scripts as Record<string, unknown>) : {};
  const scriptValue = (name: string): string | null => {
    const value = scripts[name];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };
  const buildScript = scriptValue("build");
  const testScript = scriptValue("test");
  // The `npm init` default test is a placeholder that always exits 1; treating
  // its presence as "has tests" would fail every unconfigured project. Absence
  // of a real build AND a real test means nothing to verify -> fail closed.
  const hasTest = testScript !== null && !/no test specified/i.test(testScript);
  const hasBuild = buildScript !== null;
  if (!hasTest && !hasBuild) return null;

  const [pnpmLock, yarnLock, npmLock] = await Promise.all([
    fileAtCommit(worktreePath, commit, "pnpm-lock.yaml"),
    fileAtCommit(worktreePath, commit, "yarn.lock"),
    fileAtCommit(worktreePath, commit, "package-lock.json"),
  ]);
  let pm: "pnpm" | "yarn" | "npm";
  let install: [string, ...string[]];
  if (pnpmLock !== null) {
    pm = "pnpm";
    install = ["pnpm", "install", "--frozen-lockfile"];
  } else if (yarnLock !== null) {
    pm = "yarn";
    install = ["yarn", "install", "--frozen-lockfile"];
  } else if (npmLock !== null) {
    pm = "npm";
    install = ["npm", "ci"];
  } else {
    pm = "npm";
    install = ["npm", "install"];
  }

  const commands: VerificationCommand[] = [{ name: "install", command: install }];
  if (hasBuild) commands.push({ name: "build", command: [pm, "run", "build"] });
  if (hasTest) {
    commands.push({ name: "test", command: pm === "npm" ? ["npm", "test"] : [pm, "test"] });
  }
  return commands;
}
