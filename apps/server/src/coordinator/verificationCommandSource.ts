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
// A rejected command is DROPPED, not substituted and not fatal: the remaining
// well-formed commands are still sent, and if none survive the field is omitted
// so the manifest fallback applies. Dispatch is never blocked by a malformed
// fact, because refusing to run a task because someone typed a pipe into a
// memory entry would be a worse failure than verifying with the commands that
// did parse.
import type { V2VerificationCommandT } from "@norns/contracts";
import { VERIFICATION_COMMAND_KEYS } from "../execution/index.js";
import type { V2SqlExecutor } from "../persistence/v2/database.js";

/** Characters that only mean anything to a shell. Their presence is a refusal. */
const SHELL_METACHARACTERS = /[|&;<>()$`\\"'*?[\]{}~\n\r]/;

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
export function tokenizeVerificationCommand(value: string): [string, ...string[]] | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of trimmed) {
    if (quote) {
      if (character === quote) {
        quote = null;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === " " || character === "\t") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    // Outside quotes, anything a shell would interpret is refused rather than
    // guessed at. Note this runs on the UNQUOTED remainder only, so a quoted
    // argument containing a `*` is fine — it is a literal, which is what the
    // runner's shell-free execFile will pass through.
    if (SHELL_METACHARACTERS.test(character)) return null;
    current += character;
    started = true;
  }
  if (quote) return null; // Unterminated quote: the intent is not knowable.
  if (started) tokens.push(current);
  const [file, ...args] = tokens;
  if (!file) return null;
  return [file, ...args];
}

export interface ProjectVerificationCommandResolution {
  commands: V2VerificationCommandT[];
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
 * Returns an empty list when the project has no such facts — an ordinary
 * situation for a project that was never ingested, and the point at which the
 * runner's committed-manifest fallback takes over.
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
  for (const row of rows.rows) {
    const { key, value } = splitFact(row.content);
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
  return { commands, rejected };
}
