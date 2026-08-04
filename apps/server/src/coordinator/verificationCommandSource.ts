// EXECUTION E10 — the project's REAL verification commands, on their way to the
// runner as something executable rather than something readable.
//
// WHERE THEY LIVE. Repository ingestion records `build_command`, `test_command`
// and `lint_command` as `repository_fact` rows in `project_memory_entries`,
// stored as the prose `"<key>: <value>"`. EXECUTION E1 renders them into the
// agent's PROMPT — which is exactly right for the agent and useless to the
// runner, which does not read the prompt. `V2DispatchCommand` carried only a
// `verification_policy_ref`, so E4's runner had to fall back to a committed
// `.norns/verification.json` or fail closed. A repository without that file
// could never verify, no matter how carefully its commands had been ingested.
//
// WHAT THIS DOES. Reads those facts at dispatch time and turns each into an
// argv VECTOR, which is the only shape the runner will execute. Precedence at
// the runner is: this field, then the committed manifest, then FAIL CLOSED.
// Nothing here can produce a green run by omission — the worst case is an
// absent field, which lands on the existing fallback chain.
//
// ON NOT BUILDING A SHELL
// -----------------------
// A recorded command is arbitrary human-entered text and this module refuses to
// invent an interpreter for it. It splits on whitespace, honours single and
// double quotes, and REJECTS any command containing a shell metacharacter —
// pipes, redirects, `&&`, `;`, `$`, backticks, subshells, globs. `pnpm test`
// becomes `["pnpm","test"]`; `pnpm build && pnpm test` is rejected outright
// rather than being handed to a shell or silently truncated at the `&&` into a
// command that means something different from what the human wrote.
//
// WHAT THIS IS AND IS NOT. It guarantees that no shell ever interprets the
// text, so nothing here can expand a glob, substitute a variable, chain a
// second command, or redirect a file. It is NOT a safety review of the program
// being invoked: a fact recorded as `rm -rf /` tokenizes cleanly and would run
// `rm`. That is the same trust posture the rest of this path already holds and
// cannot escape — the runner has, by this point, executed an autonomous coding
// agent with write access in the same worktree, and these facts are
// human-reviewed project memory written during repository ingestion. Pretending
// a tokenizer is an authorization boundary would be the more dangerous claim.
//
// A rejected command is DROPPED, not substituted and not fatal: the remaining
// well-formed commands are still sent, and if none survive the field is omitted
// so the manifest fallback applies. Dispatch is never blocked by a malformed
// fact, because refusing to run a task because someone typed a pipe into a
// memory entry would be a worse failure than verifying with the commands that
// did parse.
import type { V2VerificationCommandT } from "@norns/contracts";
import {
  VERIFICATION_COMMAND_KEYS,
  tokenizeVerificationCommand,
} from "../execution/verificationPolicy.js";
import type { V2SqlExecutor } from "../persistence/v2/database.js";

interface MemoryFactRow {
  content: string;
}

/** `build_command` -> `build`. The name a human reads in the failure report. */
function commandName(key: string): string {
  return key.endsWith("_command") ? key.slice(0, -"_command".length) : key;
}

function splitFact(content: string): { key: string; value: string } {
  const index = content.indexOf(":");
  if (index <= 0) return { key: content.trim(), value: "" };
  return { key: content.slice(0, index).trim(), value: content.slice(index + 1).trim() };
}

/**
 * Split a recorded command into an argv vector, or return null when it is not
 * safely representable as one.
 *
 * Quoting is honoured because real commands contain paths and filters with
 * spaces (`pnpm exec vitest run "test/a b.test.ts"`). Everything else that a
 * shell would treat as syntax is a rejection, not an escape.
 */
export { tokenizeVerificationCommand } from "../execution/verificationPolicy.js";

export interface ProjectVerificationCommandResolution {
  commands: V2VerificationCommandT[];
  /** Full committed manifest should be resolved by the runner at the tested commit. */
  repository_manifest: boolean;
  /**
   * Facts that were recorded but could not be represented as an argv vector.
   * Surfaced rather than swallowed: "your test command was ignored" is
   * information the operator needs, and E4's whole lesson is that silently
   * dropping verification is how a green badge stops meaning anything.
   */
  rejected: { name: string; value: string }[];
}

/**
 * Read a project's ingested build/test/lint facts and return them as argv
 * vectors, in the stable order build, test, lint.
 *
 * Returns an empty command list when the project has no such facts. A separate
 * repository_manifest signal preserves the full committed manifest rather than
 * flattening and potentially dropping project-specific checks.
 */
export async function resolveProjectVerificationCommands(
  sql: V2SqlExecutor,
  projectId: string,
): Promise<ProjectVerificationCommandResolution> {
  const rows = await sql.query<MemoryFactRow>(
    `SELECT content FROM project_memory_entries
      WHERE project_id = $1 AND status = 'active' AND category = 'repository_fact'
      ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  const keys = VERIFICATION_COMMAND_KEYS as readonly string[];
  const byKey = new Map<string, string>();
  let repositoryManifest = false;
  for (const row of rows.rows) {
    const { key, value } = splitFact(row.content);
    if (key === "verification_manifest" && value === ".norns/verification.json") {
      repositoryManifest = true;
      continue;
    }
    // First writer wins per key, so a superseding ingestion that left both rows
    // active cannot make dispatch non-deterministic.
    if (keys.includes(key) && value !== "" && !byKey.has(key)) byKey.set(key, value);
  }
  const commands: V2VerificationCommandT[] = [];
  const rejected: { name: string; value: string }[] = [];
  for (const key of keys) {
    const value = byKey.get(key);
    if (value === undefined) continue;
    const argv = tokenizeVerificationCommand(value);
    if (argv === null) {
      rejected.push({ name: commandName(key), value });
      continue;
    }
    commands.push({ name: commandName(key), command: argv });
  }
  return { commands, repository_manifest: repositoryManifest, rejected };
}
