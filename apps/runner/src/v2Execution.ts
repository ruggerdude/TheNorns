import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  type CodexReasoningEffortT,
  type EventPayloadT,
  type V2ContentAddressedReferenceT,
  V2DispatchCommand,
  type V2DispatchCommandT,
} from "@norns/contracts";
import { executionPath } from "./executionPath.js";
import type { LiveRunRegistry } from "./liveRuns.js";
import { ManagedProcessTree, managedProcessDetached } from "./managedProcessTree.js";
import type { RuntimeCredentialMode } from "./modelGateway.js";
import { PublicationError, type PublicationResult, type RunnerPublisher } from "./publication.js";
import {
  type HumanWaitEnvelopeT,
  hashHumanWaitEnvelope,
  humanWaitPrompt,
  readHumanWaitEnvelope,
} from "./runtimes/humanWaitChannel.js";
import type { CodingRuntime, RuntimeRunResult, RuntimeSession } from "./runtimes/types.js";
import {
  REPOSITORY_VERIFICATION_MANIFEST,
  type VerificationCommand,
  type VerificationPolicyMap,
  isHygieneOnly,
  readRepositoryVerificationManifest,
} from "./verificationPolicies.js";
import type { WorkspaceRegistry } from "./workspaceRegistry.js";

const execFileAsync = promisify(execFile);
const LOCAL_PATH_REDACTION = "[LOCAL_PATH]";
const KNOWLEDGE_TEXT_LIMIT = 4_000;
const KNOWLEDGE_ITEM_LIMIT = 32;
const KNOWLEDGE_HEARTBEAT_INTERVAL_MS = 60_000;

function redactExactLocalPaths(value: string, paths: readonly (string | undefined)[]): string {
  let redacted = value;
  const variants = new Set<string>();
  for (const path of paths.filter((candidate): candidate is string => Boolean(candidate))) {
    variants.add(path);
    variants.add(resolve(path));
    // macOS exposes the same temporary tree through `/var` and
    // `/private/var`; runtimes may report either spelling even when the
    // registry stores only the physical one.
    if (path.startsWith("/private/")) variants.add(path.slice("/private".length));
    if (path.startsWith("/var/")) variants.add(`/private${path}`);
    try {
      variants.add(realpathSync(path));
    } catch {
      // Cleanup or a filesystem race may remove a known path; its submitted
      // and resolved spellings remain sensitive even after realpath is gone.
    }
  }
  for (const path of [...variants].sort((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(path, LOCAL_PATH_REDACTION);
  }
  return redacted;
}

function redactKnowledgeText(
  value: string,
  paths: readonly (string | undefined)[],
  fallback: string,
): string {
  const bounded = redactExactLocalPaths(value, paths)
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]")
    .replace(/\b(token|password|secret|api[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .trim()
    .slice(0, KNOWLEDGE_TEXT_LIMIT);
  return bounded || fallback;
}

function boundedKnowledgeList(values: readonly string[]): string[] {
  return values
    .map((value) => value.trim().slice(0, KNOWLEDGE_TEXT_LIMIT))
    .filter(Boolean)
    .slice(0, KNOWLEDGE_ITEM_LIMIT);
}

export interface RunnerRepositoryBinding {
  repository_binding_id: string;
  repository_path: string;
}

export class ApprovedRepositoryRegistry {
  private readonly roots: string[];
  private readonly bindings = new Map<string, string>();

  constructor(approvedRoots: readonly string[]) {
    this.roots = approvedRoots.map((root) => realpathSync(resolve(root)));
  }

  register(binding: RunnerRepositoryBinding): void {
    const submitted = resolve(binding.repository_path);
    if (lstatSync(submitted).isSymbolicLink()) {
      throw new Error("repository path must not be a symlink");
    }
    const path = realpathSync(submitted);
    if (
      !isAbsolute(path) ||
      !this.roots.some((root) => {
        const child = relative(root, path);
        return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
      })
    ) {
      throw new Error("repository path is outside runner-approved roots");
    }
    this.bindings.set(binding.repository_binding_id, path);
  }

  resolve(bindingId: string): string {
    const path = this.bindings.get(bindingId);
    if (!path) throw new Error(`repository binding ${bindingId} is not approved on this runner`);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("repository binding is no longer a safe directory");
      }
      const physical = realpathSync(path);
      if (
        physical !== path ||
        !this.roots.some((root) => {
          const child = relative(root, physical);
          return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
        })
      ) {
        throw new Error("repository binding is no longer within an approved root");
      }
      return physical;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("repository binding is")) throw error;
      throw new Error("repository binding is no longer available");
    }
  }

  sensitivePaths(bindingId: string): readonly string[] {
    const path = this.bindings.get(bindingId);
    if (!path) return [];
    return [path, ...this.roots.filter((root) => this.contains(root, path))];
  }

  private contains(root: string, path: string): boolean {
    const child = relative(root, path);
    return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
  }
}

export interface RunnerContentFetcher {
  fetch(reference: V2ContentAddressedReferenceT): Promise<Uint8Array>;
}

/**
 * @deprecated EXECUTION E3 — sends NO credentials. Against an authenticated
 * context route every fetch returns 401 and the coding agent runs with an empty
 * prompt, which is exactly the failure E3 fixed. Use
 * `RunnerSignedContextFetcher` (contextAuth.ts) instead. Retained only so a
 * caller pinned to the old export keeps compiling; nothing in the CLI uses it.
 */
export class SignedUrlContentFetcher implements RunnerContentFetcher {
  async fetch(reference: V2ContentAddressedReferenceT): Promise<Uint8Array> {
    const url = new URL(reference.storage_ref);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new Error("context storage_ref must be a signed HTTPS URL");
    }
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) throw new Error(`context fetch failed with ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export class HashVerifiedContextLoader {
  constructor(private readonly fetcher: RunnerContentFetcher) {}

  async loadBytes(reference: V2ContentAddressedReferenceT): Promise<Uint8Array> {
    const bytes = await this.fetcher.fetch(reference);
    if (bytes.byteLength !== reference.byte_size) {
      throw new Error(`context ${reference.artifact_id} byte-size mismatch`);
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== reference.content_hash) {
      throw new Error(`context ${reference.artifact_id} content hash mismatch`);
    }
    return bytes;
  }

  async load(references: readonly V2ContentAddressedReferenceT[]): Promise<string> {
    const parts: string[] = [];
    for (const reference of references) {
      const bytes = await this.loadBytes(reference);
      parts.push(new TextDecoder().decode(bytes));
    }
    return parts.join("\n\n");
  }
}

export interface PreparedWorktree {
  path: string;
  base_revision: string;
  head(): Promise<string>;
  cleanup(): Promise<void>;
}

export interface RunnerWorktreeManager {
  prepare(input: {
    repository_path: string;
    run_id: string;
    expected_revision: string;
    target_branch: string;
  }): Promise<PreparedWorktree>;
}

type RunnerExecutionStage =
  | "context_load"
  | "scratch_prepare"
  | "worktree_prepare"
  | "runtime"
  | "worktree_inspection"
  | "verification"
  | "publication";

const FAILURE_CODE_BY_STAGE: Record<RunnerExecutionStage, string> = {
  context_load: "runner_context_load_failed",
  scratch_prepare: "runner_scratch_prepare_failed",
  worktree_prepare: "runner_worktree_prepare_failed",
  runtime: "runner_runtime_failed",
  worktree_inspection: "runner_worktree_inspection_failed",
  verification: "runner_verification_failed",
  publication: "runner_publication_failed",
};

export class GitWorktreeManager implements RunnerWorktreeManager {
  constructor(private readonly worktreeRoot: string) {}

  async prepare(input: {
    repository_path: string;
    run_id: string;
    expected_revision: string;
    target_branch: string;
  }): Promise<PreparedWorktree> {
    await mkdir(this.worktreeRoot, { recursive: true });
    const safeRun = input.run_id.replaceAll(/[^A-Za-z0-9._-]/g, "_");
    const path = resolve(this.worktreeRoot, safeRun);
    const repositoryPath = this.revalidateRepository(input.repository_path);
    const resolved = (
      await execFileAsync("git", ["-C", repositoryPath, "rev-parse", input.expected_revision])
    ).stdout.trim();
    if (resolved !== input.expected_revision) {
      throw new Error("expected repository revision must be an exact commit SHA");
    }
    // Revalidate immediately before the first mutating Git operation. This
    // catches a selected directory replaced after dispatch resolution and
    // narrows the unavoidable OS-level race to the exec boundary itself.
    this.revalidateRepository(repositoryPath);
    await execFileAsync("git", [
      "-C",
      repositoryPath,
      "worktree",
      "add",
      "--detach",
      path,
      resolved,
    ]);
    // `-C`, not `-c`. The relay delivers at least once, and `git worktree
    // remove` deletes the working directory but NOT the branch ref it created,
    // so a redelivered command finds its own branch already present and `-c`
    // fails outright — which is exactly how a redelivery used to turn into an
    // opaque failed run. `-C` resets this task's own branch to the base
    // revision for a fresh attempt; the previous attempt's commits are already
    // on the remote, and the publisher converges the remote branch and the
    // pull request onto the new attempt rather than opening a second one.
    await execFileAsync("git", ["-C", path, "switch", "-C", input.target_branch]);
    return {
      path,
      base_revision: resolved,
      head: async () =>
        (await execFileAsync("git", ["-C", path, "rev-parse", "HEAD"])).stdout.trim(),
      cleanup: async () => {
        await execFileAsync("git", ["-C", repositoryPath, "worktree", "remove", "--force", path]);
      },
    };
  }

  private revalidateRepository(path: string): string {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("repository is no longer a safe directory");
      }
      const physical = realpathSync(path);
      if (physical !== path) throw new Error("repository identity changed before execution");
      return physical;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("repository ")) throw error;
      throw new Error("repository is no longer available");
    }
  }
}

export interface VerificationCommandResult {
  name: string;
  command: readonly string[];
  exit_code: number;
  passed: boolean;
  output: string;
  process_tree_reaped: boolean;
}

export interface RunnerVerificationResult {
  passed: boolean;
  output: string;
  /** One entry per command actually executed, in execution order. */
  command_results: readonly VerificationCommandResult[];
  /**
   * Why verification failed before (or independently of) any command — an
   * unconfigured policy, an empty run, a moved HEAD. Null when the commands
   * themselves decided the outcome.
   */
  reason: string | null;
  /**
   * True when the only thing that ran was the built-in Git hygiene check. A
   * green badge on such a run means "the commit has no whitespace errors" and
   * nothing more, and the caller says so out loud.
   */
  hygiene_only: boolean;
  /** True only when every spawned verification process tree was proven empty. */
  process_tree_reaped: boolean;
}

export interface RunnerVerifier {
  verify(input: {
    worktree_path: string;
    policy_ref: string;
    expected_commit: string;
    /** The commit the worktree started at, so an empty run cannot pass. */
    base_revision: string;
    /**
     * EXECUTION E10/E11 — the project's REAL build/test/lint commands, carried
     * structurally on the dispatch command as argv vectors. Optional: a server
     * that predates E10, or a project with no ingested facts, sends nothing and
     * the resolution below is exactly what it was before.
     */
    commands?: readonly VerificationCommand[];
    /**
     * The server confirmed that repository verification is defined by the
     * committed manifest. Exact commands still win; otherwise the manifest must
     * be read at expected_commit before any runner-local policy is considered.
     */
    repository_manifest?: true;
    /**
     * Checked between verification commands and passed to the active command.
     * The executor checks it again before issuing publication authority.
     */
    signal?: AbortSignal;
  }): Promise<RunnerVerificationResult>;
}

/** Per-command wall clock. A hung test suite must not hang the runner. */
const VERIFICATION_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const VERIFICATION_OUTPUT_LIMIT = 100_000;

/**
 * EXECUTION E4 — verification that can actually fail.
 *
 * WHAT WAS WRONG
 * --------------
 * The previous implementation ran one command and then computed
 * `passed: actual === input.expected_commit`, where `expected_commit` had been
 * read from `worktree.head()` moments earlier in the same worktree. The
 * comparison was a tautology: it asked whether HEAD equalled HEAD. The
 * command's own exit status was never consulted for the verdict at all — a
 * non-zero exit rejected the promise and was swallowed by the executor's outer
 * `catch`, producing an opaque failure with no output. And the default policy
 * was `git diff-tree --check --root HEAD`, a whitespace lint, so an agent that
 * committed nothing of value "passed verification" and the UI showed a green
 * badge that meant nothing.
 *
 * WHAT IT DOES NOW
 * ----------------
 * The verdict is the conjunction of facts that can each independently be false:
 *
 *   * the run produced a commit at all (`expected_commit !== base_revision`);
 *   * the worktree is AT that commit with a clean tree before anything runs;
 *   * every resolved verification command exited zero;
 *   * HEAD is STILL at that commit afterwards, so the commands verified the
 *     work under test rather than something they rewrote underneath it.
 *
 * That last pair is what honestly preserves the exact-commit guarantee the
 * original design intended. `expected_commit` is now an assertion the verifier
 * ENFORCES against the repository, not a value it compares to a copy of itself.
 */
export class CommandPolicyVerifier implements RunnerVerifier {
  constructor(private readonly policies: VerificationPolicyMap) {}

  async verify(input: {
    worktree_path: string;
    policy_ref: string;
    expected_commit: string;
    base_revision: string;
    commands?: readonly VerificationCommand[];
    repository_manifest?: true;
    signal?: AbortSignal;
  }): Promise<RunnerVerificationResult> {
    const refuse = (reason: string): RunnerVerificationResult => ({
      passed: false,
      output: reason,
      command_results: [],
      reason,
      hygiene_only: false,
      process_tree_reaped: true,
    });

    // An agent that committed nothing has produced nothing to verify. This is
    // checked FIRST so that no policy, however permissive, can green-light it.
    if (input.expected_commit === input.base_revision) {
      return refuse("the run produced no commit, so there is nothing to verify");
    }
    const headBefore = await this.head(input.worktree_path);
    if (headBefore !== input.expected_commit) {
      return refuse(
        `worktree HEAD is ${headBefore} but the commit under test is ${input.expected_commit}`,
      );
    }
    const dirty = await this.dirtyPaths(input.worktree_path);
    if (dirty.length > 0) {
      return refuse(
        `worktree has uncommitted changes, so the commit under test is not what would be published: ${dirty.join(", ")}`,
      );
    }

    // RESOLUTION ORDER: exact dispatch commands, an explicitly signaled full
    // repository manifest, the runner policy map, then the legacy manifest
    // fallback. The explicit manifest signal must precede the built-in default
    // policy or a real test suite is silently replaced by Git hygiene.
    //
    // E10 closed E4-5 by putting the project's real commands on the dispatch
    // command, where they are the human-reviewed server-side record of how this
    // project is built. They must outrank BOTH remaining sources or the feature
    // is dead on arrival: every deployment that leaves
    // NORNS_VERIFICATION_POLICIES_JSON unset still has a populated default
    // policy map, so a map-first order would match `verification-policy:
    // default-v1` and quietly run the whitespace lint instead of the project's
    // tests — the exact "green badge that means nothing" E4 removed.
    //
    // It is safe to let a server-supplied value win here because it is an argv
    // VECTOR that reaches `execFile` with `shell: false`, and the server refuses
    // shell metacharacters before it ever leaves the coordinator. The operator's
    // local map is not bypassed so much as demoted to what it always really was
    // — the fallback for a project the server knows nothing about.
    let commands: readonly VerificationCommand[] | undefined =
      input.commands && input.commands.length > 0 ? input.commands : undefined;
    let source = "verification commands from the dispatch command";
    if (!commands && input.repository_manifest) {
      try {
        const manifest = await readRepositoryVerificationManifest(
          input.worktree_path,
          input.expected_commit,
        );
        if (!manifest) {
          return refuse(
            `dispatch requires ${REPOSITORY_VERIFICATION_MANIFEST}, but it is absent or empty at ${input.expected_commit}`,
          );
        }
        commands = manifest;
        source = `${REPOSITORY_VERIFICATION_MANIFEST} at ${input.expected_commit}`;
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error));
      }
    }
    if (!commands) {
      commands = this.policies.get(input.policy_ref);
      source = `policy ${input.policy_ref}`;
    }
    if (!commands) {
      try {
        const manifest = await readRepositoryVerificationManifest(
          input.worktree_path,
          input.expected_commit,
        );
        if (manifest) {
          commands = manifest;
          source = `${REPOSITORY_VERIFICATION_MANIFEST} at ${input.expected_commit}`;
        }
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error));
      }
    }
    if (!commands) {
      // FAIL CLOSED. The old code threw here, which the executor turned into an
      // opaque failure; and where it did not throw it returned a meaningless
      // pass. Neither told anyone what to fix.
      return refuse(
        `verification policy ${input.policy_ref} is not approved on this runner and the repository has no ${REPOSITORY_VERIFICATION_MANIFEST}; set NORNS_VERIFICATION_POLICIES_JSON or commit a verification manifest`,
      );
    }

    const results: VerificationCommandResult[] = [];
    for (const entry of commands) {
      if (input.signal?.aborted) {
        return {
          passed: false,
          output: this.render(source, results),
          command_results: results,
          reason: "verification was cancelled before all commands completed",
          hygiene_only: false,
          process_tree_reaped: results.every((result) => result.process_tree_reaped),
        };
      }
      results.push(await this.runCommand(entry, input.worktree_path, input.signal));
      if (input.signal?.aborted) {
        return {
          passed: false,
          output: this.render(source, results),
          command_results: results,
          reason: "verification was cancelled before all commands completed",
          hygiene_only: false,
          process_tree_reaped: results.every((result) => result.process_tree_reaped),
        };
      }
    }

    const headAfter = await this.head(input.worktree_path);
    if (headAfter !== input.expected_commit) {
      return {
        passed: false,
        output: this.render(source, results),
        command_results: results,
        reason: `verification commands moved HEAD from ${input.expected_commit} to ${headAfter}; the result does not describe the commit under test`,
        hygiene_only: false,
        process_tree_reaped: results.every((result) => result.process_tree_reaped),
      };
    }

    const passed = results.every((result) => result.passed);
    return {
      passed,
      output: this.render(source, results),
      command_results: results,
      reason: null,
      hygiene_only: isHygieneOnly(commands),
      process_tree_reaped: results.every((result) => result.process_tree_reaped),
    };
  }

  /**
   * Run one command and report its true result.
   *
   * A non-zero exit is DATA, not an exception: it is the single most important
   * thing verification can discover, and the previous implementation lost it by
   * letting the rejected promise escape.
   */
  private async runCommand(
    entry: VerificationCommand,
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<VerificationCommandResult> {
    const [file, ...args] = entry.command;
    return new Promise((resolve) => {
      const child = spawn(file, args, {
        cwd: worktreePath,
        detached: managedProcessDetached(),
        // No shell, ever. `entry.command` is an argv vector and stays one.
        shell: false,
        // launchd's bare PATH has no developer toolchain; without this,
        // verification dies with `spawn npm ENOENT` regardless of the work.
        env: { ...process.env, PATH: executionPath() },
      });
      const processTree = new ManagedProcessTree(child);
      let stdout = "";
      let stderr = "";
      let settled = false;
      let spawned = false;
      let terminationRequested = false;
      const finish = async (exitCode: number, fallback: string): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        const proof = await processTree.confirmReaped();
        const output = `${stdout}\n${stderr}`.trim();
        resolve({
          name: entry.name,
          command: entry.command,
          exit_code: exitCode,
          passed: exitCode === 0 && !terminationRequested,
          output: (output || fallback).slice(0, VERIFICATION_OUTPUT_LIMIT),
          process_tree_reaped: proof.process_tree_reaped,
        });
      };
      const append = (target: "stdout" | "stderr", chunk: unknown): void => {
        const value = String(chunk);
        if (target === "stdout") {
          stdout = `${stdout}${value}`.slice(-VERIFICATION_OUTPUT_LIMIT);
        } else {
          stderr = `${stderr}${value}`.slice(-VERIFICATION_OUTPUT_LIMIT);
        }
      };
      const stop = (): void => {
        terminationRequested = true;
        if (spawned) processTree.requestStop();
      };
      child.stdout?.on("data", (chunk) => append("stdout", chunk));
      child.stderr?.on("data", (chunk) => append("stderr", chunk));
      child.once("spawn", () => {
        spawned = true;
        if (terminationRequested) processTree.requestStop();
      });
      child.once("error", (error) => {
        if (!spawned) void finish(-1, error.message);
      });
      child.once("close", (code, closeSignal) => {
        void finish(
          typeof code === "number" ? code : -1,
          terminationRequested
            ? "verification command was terminated"
            : `verification command exited by signal ${closeSignal ?? "unknown"}`,
        );
      });
      const timer = setTimeout(stop, VERIFICATION_COMMAND_TIMEOUT_MS);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
    });
  }

  private async head(worktreePath: string): Promise<string> {
    return (await execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"])).stdout.trim();
  }

  private async dirtyPaths(worktreePath: string): Promise<string[]> {
    const { stdout } = await execFileAsync("git", [
      "-C",
      worktreePath,
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]);
    return stdout
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  }

  /** Human-readable transcript. Its sha256 becomes the event's output digest. */
  private render(source: string, results: readonly VerificationCommandResult[]): string {
    const lines = [`verification source: ${source}`];
    for (const result of results) {
      lines.push(
        "",
        `--- ${result.name} (${result.command.join(" ")}) -> ${
          result.passed ? "PASSED" : `FAILED (exit ${result.exit_code})`
        }`,
        result.output.trim(),
      );
    }
    return lines.join("\n").slice(0, VERIFICATION_OUTPUT_LIMIT);
  }
}

/**
 * EXECUTION E3 — the factory now also receives the run it is building for.
 *
 * Additive and source-compatible: a `(model) => runtime` lambda still satisfies
 * this type, because TypeScript permits a function that ignores trailing
 * parameters. It exists because a credential-free runtime obtains its model
 * access from the relay, and the server authorizes that access against the run
 * and task — so the runtime has to know which run it is.
 */
export interface RunnerRuntimeContext {
  runId: string;
  taskId: string;
  maxOutputTokens: number;
  /** Provider selected by the dispatch; used for provider-specific gateway URLs. */
  provider?: string;
  reasoningEffort?: CodexReasoningEffortT;
  /**
   * Selected auth source. Dispatch wiring defaults an absent contract field to
   * `api` for compatibility; runtimes still receive the resolved mode.
   */
  credentialMode?: RuntimeCredentialMode;
  /**
   * The runtime session a previous attempt left behind. Recovery dispatches
   * populate this only when runner, provider, runtime, and model are unchanged,
   * so Claude/Codex can continue instead of repeating repository analysis.
   */
  resumeSessionId?: string;
}

export type RunnerRuntimeProvider =
  | CodingRuntime
  | ((model: string, context: RunnerRuntimeContext) => CodingRuntime);

export interface V2RunnerExecutionResult {
  /**
   * Stays within `CommandState` because the daemon records it directly as the
   * command's terminal state. An empty run is a `failed` outcome carrying
   * `empty: true` — it is not, and must never be, a success.
   */
  outcome: "succeeded" | "waiting_for_human" | "failed" | "cancelled";
  commit_sha: string | null;
  verification_passed: boolean;
  usage: RuntimeRunResult["usage"];
  /** True when the coding agent finished without producing a commit. */
  empty: boolean;
  /** Where the work went. Null when there was nothing to publish. */
  publication: PublicationResult | null;
  /** Why the run ended as it did, in words a human can act on. */
  reason: string | null;
  /**
   * EXECUTION E11 — the runtime session this run leaves behind, when the
   * runtime has a resumable one.
   *
   * Both agentic adapters have always reported a `sessionId` and the executor
   * has always dropped it on the floor, which is why "the agent asks, the job
   * ends, a later job resumes with prior context" had no foundation at all: the
   * one identifier that makes a faithful resume possible was discarded within
   * milliseconds of being produced, on a machine that was about to be deleted.
   * It is now returned AND emitted as a run log, so it survives in the durable
   * event stream even before a coordinator learns to store it.
   */
  session_id: string | null;
}

export class V2RunnerExecutor {
  constructor(
    private readonly runner: { id: string; generation: number; scratch_root?: string },
    private readonly repositories: ApprovedRepositoryRegistry,
    private readonly context: HashVerifiedContextLoader,
    private readonly worktrees: RunnerWorktreeManager,
    private readonly runtimes: ReadonlyMap<string, RunnerRuntimeProvider>,
    private readonly verifier: RunnerVerifier,
    private readonly workspaces?: WorkspaceRegistry,
    /**
     * EXECUTION E4. Optional only so the many existing construction sites keep
     * compiling; when it is absent the executor refuses to destroy a worktree
     * that holds unpublished commits rather than silently losing them.
     */
    private readonly publisher?: RunnerPublisher,
    /**
     * EXECUTION E11. Where a run announces that it is live and controllable.
     * Optional only so the existing construction sites keep compiling; without
     * it a run executes exactly as before and simply cannot be stopped, which
     * is the state this phase exists to end — the CLI always supplies one.
     */
    private readonly liveRuns?: LiveRunRegistry,
  ) {}

  async execute(
    commandInput: V2DispatchCommandT,
    emit: (event: EventPayloadT) => void,
    capabilities: { knowledge_transport: boolean } = { knowledge_transport: false },
  ): Promise<V2RunnerExecutionResult> {
    const command = V2DispatchCommand.parse(commandInput);
    if (
      command.runner_id !== this.runner.id ||
      command.runner_generation !== this.runner.generation
    ) {
      throw new Error("dispatch command is fenced from this runner generation");
    }
    if (Date.parse(command.expires_at) <= Date.now()) throw new Error("dispatch command expired");
    // A runner-issued repository id is authoritative for a folder selected
    // through the local registry. Never fall back to a static binding when an
    // explicit local identity is missing or expired on this runner.
    const resolveRepositoryPath = (): string => {
      if (command.runner_repository_id) {
        const path = this.workspaces?.repositoryPath(command.runner_repository_id);
        if (!path) throw new Error("runner repository is not approved on this runner");
        return path;
      }
      return this.repositories.resolve(command.repository_binding_id);
    };
    const repositoryPath = resolveRepositoryPath();
    const registeredSensitivePaths = command.runner_repository_id
      ? (this.workspaces?.sensitivePaths(command.runner_repository_id) ?? [])
      : this.repositories.sensitivePaths(command.repository_binding_id);
    const runtimeProvider = this.runtimes.get(command.runtime);
    if (!runtimeProvider) throw new Error(`runtime ${command.runtime} is unavailable`);
    // `credential_mode` is an additive dispatch field. The cast keeps this
    // runner compatible while the shared command contract rolls out; once the
    // field is present there, its schema supplies the same validation.
    const requestedCredentialMode = (command as { credential_mode?: unknown }).credential_mode;
    const credentialMode: RuntimeCredentialMode =
      requestedCredentialMode === undefined || requestedCredentialMode === "api"
        ? "api"
        : requestedCredentialMode === "subscription"
          ? "subscription"
          : (() => {
              throw new Error("dispatch credential_mode is unsupported");
            })();
    const resumeSessionId =
      command.continuation?.resume_session_id ?? command.recovery?.resume_session_id;
    const runtime =
      typeof runtimeProvider === "function"
        ? runtimeProvider(command.model, {
            runId: command.run_id,
            taskId: command.task_id,
            maxOutputTokens: command.max_output_tokens,
            provider: command.provider,
            credentialMode,
            ...(command.reasoning_effort ? { reasoningEffort: command.reasoning_effort } : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
          })
        : runtimeProvider;
    let scratch: string | undefined;
    let runtimeStateDirectory: string | undefined;
    let worktree: PreparedWorktree | undefined;
    let stage: RunnerExecutionStage = "context_load";

    // EXECUTION E11 — the run becomes controllable HERE, before any expensive
    // work starts, not just once the model call is in flight. A human who hits
    // cancel while a large context document is still downloading must not be
    // told the run "is not live yet"; the signal is checked at each stage
    // boundary below so the abort is honoured wherever it lands.
    const controller = new AbortController();
    // Project cancellation may preserve already-committed work by publishing
    // it. Device/generation fencing is a separate, stronger signal that aborts
    // publication itself and can be delivered after project cancellation.
    const publicationFence = new AbortController();
    let cancelReason: string | null = null;
    let cancellationPublication: "allow_committed" | "fenced" = "allow_committed";
    const publicationIsFenced = (): boolean => cancellationPublication === "fenced";
    /**
     * EXECUTION E11 — the resumable session this run leaves behind.
     *
     * Declared out here, before anything can return, because the value is only
     * useful if EVERY exit carries it: the run a human most wants to resume is
     * the one that was cancelled or timed out, not the one that succeeded.
     */
    let sessionId: string | null = null;
    let session: RuntimeSession | null = null;
    let settled: V2RunnerExecutionResult["outcome"] = "failed";
    let removeRuntimeState = false;
    // Starts true because no managed process exists before a runtime or
    // verification command is spawned. Every spawned boundary may only turn
    // this false; process-exit evidence consumes the final conjunction.
    let processTreeReaped = true;
    let preserveWorktree = false;
    let knowledgeHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let knowledgeTerminalEmitted = false;
    let knowledgeCommit = command.expected_revision;
    let knowledgeFiles: string[] = [];
    let knowledgeTestResults: string[] = [];
    let knowledgeArtifacts: string[] = [];
    const sensitivePaths = (): (string | undefined)[] => [
      ...registeredSensitivePaths,
      repositoryPath,
      worktree?.path,
      scratch,
      this.runner.scratch_root,
    ];
    const knowledgeText = (value: string, fallback: string): string =>
      redactKnowledgeText(value, sensitivePaths(), fallback);
    const emitKnowledgeHeartbeat = (input: {
      status: "working" | "waiting" | "blocked" | "completed";
      completed: string[];
      current: string[];
      findings?: string[];
      blockers?: string[];
      tests?: string;
      remaining: "small" | "moderate" | "significant";
      risk: "green" | "yellow" | "red";
    }): void => {
      if (!capabilities.knowledge_transport) return;
      emit({
        kind: "knowledge_heartbeat",
        run_id: command.run_id,
        status: input.status,
        completed_since_last_update: boundedKnowledgeList(input.completed),
        currently_working_on: boundedKnowledgeList(input.current),
        findings: boundedKnowledgeList(input.findings ?? []),
        blockers: boundedKnowledgeList(input.blockers ?? []),
        decisions_needed: [],
        files_changed: boundedKnowledgeList(knowledgeFiles),
        tests: knowledgeText(input.tests ?? "Verification has not run yet.", "No test report."),
        estimated_remaining_work: input.remaining,
        risk_level: input.risk,
      });
    };
    const stopKnowledgeHeartbeats = (): void => {
      if (knowledgeHeartbeatTimer) clearInterval(knowledgeHeartbeatTimer);
      knowledgeHeartbeatTimer = null;
    };
    const startKnowledgeHeartbeats = (): void => {
      if (!capabilities.knowledge_transport) return;
      emitKnowledgeHeartbeat({
        status: "working",
        completed: ["Context and isolated worktree prepared."],
        current: ["Coding runtime is executing the assigned task."],
        remaining: "significant",
        risk: "green",
      });
      knowledgeHeartbeatTimer = setInterval(() => {
        emitKnowledgeHeartbeat({
          status: "working",
          completed: [],
          current: ["Coding runtime is still executing the assigned task."],
          remaining: "moderate",
          risk: "green",
        });
      }, KNOWLEDGE_HEARTBEAT_INTERVAL_MS);
      knowledgeHeartbeatTimer.unref?.();
    };
    const emitKnowledgeHandoff = (
      status: "completed" | "blocked" | "failed",
      summary: string,
      limitations: string[],
      issues: string[],
    ): void => {
      if (!capabilities.knowledge_transport || knowledgeTerminalEmitted) return;
      stopKnowledgeHeartbeats();
      knowledgeTerminalEmitted = true;
      emit({
        kind: "knowledge_handoff",
        run_id: command.run_id,
        status,
        summary: knowledgeText(summary, `Runner ended with status ${status}.`),
        deliverables:
          status === "completed"
            ? boundedKnowledgeList([`Verified commit ${knowledgeCommit}`])
            : [],
        files_changed: boundedKnowledgeList(knowledgeFiles),
        interfaces_used: [],
        interfaces_changed: [],
        tests_added: [],
        test_results: boundedKnowledgeList(knowledgeTestResults),
        acceptance_criteria: [],
        known_limitations: boundedKnowledgeList(
          limitations.map((item) => knowledgeText(item, "Unspecified limitation.")),
        ),
        open_issues: boundedKnowledgeList(
          issues.map((item) => knowledgeText(item, "Unspecified issue.")),
        ),
        dependencies_created: [],
        recommended_package_updates: [],
        recommended_follow_up_tasks: [],
        branch: command.target_branch,
        commit: knowledgeCommit,
        artifacts: boundedKnowledgeList(knowledgeArtifacts),
      });
    };
    const release = this.liveRuns?.register({
      runId: command.run_id,
      runtimeName: runtime.name,
      capabilities: runtime.capabilities,
      cancel: (reason, options) => {
        // Publication authority is monotonic: a device/generation fence always
        // dominates an earlier project stop, including after the signal fired.
        if (options.publication === "fenced") {
          cancellationPublication = "fenced";
          publicationFence.abort();
        }
        if (controller.signal.aborted) return;
        cancelReason = reason;
        controller.abort();
      },
      session: () => session,
    });
    /** Records the terminal outcome so a later control command can explain it. */
    const finish = (result: V2RunnerExecutionResult): V2RunnerExecutionResult => {
      settled = result.outcome;
      removeRuntimeState = result.outcome === "succeeded";
      return result;
    };
    /** The cancelled result, shaped once so every early exit agrees. */
    const cancelledBefore = (stage: string): V2RunnerExecutionResult => {
      const reason = `${cancelReason ?? "the run was cancelled"} while ${stage}; no commit had been made, so there was nothing to publish`;
      emitKnowledgeHandoff("blocked", reason, [reason], []);
      emit({ kind: "run_log", run_id: command.run_id, chunk: reason });
      emit({ kind: "run_status", run_id: command.run_id, status: "cancelled" });
      return finish({
        outcome: "cancelled",
        commit_sha: null,
        verification_passed: false,
        usage: { input_tokens: 0, output_tokens: 0, usage_source: "unavailable" },
        empty: true,
        publication: null,
        session_id: sessionId,
        reason,
      });
    };
    /**
     * Cancellation after worktree preparation preserves all local evidence.
     * Project cancellation may publish work that was already committed;
     * generation/device fencing is monotonic and never may.
     */
    const cancelledWithWorktree = async (
      usage: RuntimeRunResult["usage"],
    ): Promise<V2RunnerExecutionResult> => {
      const currentWorktree = worktree;
      if (!currentWorktree) return cancelledBefore("preparing the worktree");
      preserveWorktree = true;
      const commit = await currentWorktree.head();
      const produced = commit !== currentWorktree.base_revision;
      knowledgeCommit = produced ? commit : command.expected_revision;
      const stopped = cancelReason ?? "the run was cancelled";
      const sensitive = [
        ...registeredSensitivePaths,
        repositoryPath,
        currentWorktree.path,
        scratch,
        this.runner.scratch_root,
      ];
      const dirty = await this.uncommittedPaths(currentWorktree.path);
      knowledgeFiles = boundedKnowledgeList(dirty);
      if (dirty.length > 0) {
        emit({
          kind: "run_log",
          run_id: command.run_id,
          chunk: `${stopped}: ${dirty.length} uncommitted path(s) in the worktree were NOT published, because the agent never committed them`,
        });
      }

      let publication: PublicationResult | null = null;
      let reason = `${stopped}; no commit had been made, so there was nothing to publish`;
      if (produced && !publicationIsFenced()) {
        try {
          if (!this.publisher) {
            throw new PublicationError(
              "this runner has no publisher configured, so the cancelled run's commits cannot be made durable",
              "construct V2RunnerExecutor with a RunnerPublisher",
            );
          }
          // Last local authority check before publication. A later device fence
          // can still escalate an already-fired project cancellation because
          // cancellationPublication is monotonic.
          if (publicationIsFenced()) {
            reason = `${stopped}; committed work remains in the managed worktree, but publication is fenced`;
          } else {
            publication = await this.publisher.publish({
              worktree_path: currentWorktree.path,
              branch: command.target_branch,
              commit,
              run_id: command.run_id,
              task_id: command.task_id,
              verification_passed: false,
              verification_summary:
                "the run was cancelled before verification, so this work is UNVERIFIED",
              signal: publicationFence.signal,
            });
            if (publicationIsFenced()) {
              publication = null;
              reason = `${stopped}; committed work remains in the managed worktree, but publication is fenced`;
            } else {
              reason = `${stopped}; the work committed before cancellation was published to ${publication.branch}`;
              knowledgeArtifacts = boundedKnowledgeList([
                `branch:${publication.branch}`,
                `commit:${publication.commit}`,
                ...(publication.pull_request_url ? [publication.pull_request_url] : []),
              ]);
              emit({
                kind: "run_log",
                run_id: command.run_id,
                chunk: redactExactLocalPaths(
                  [
                    `published ${publication.outcome} after cancellation: branch ${publication.branch} at ${publication.commit}`,
                    publication.remote ? `remote: ${publication.remote}` : null,
                    publication.pull_request_url
                      ? `pull request: ${publication.pull_request_url}`
                      : publication.pull_request_note,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  sensitive,
                ),
              });
              emit(this.publishedEvent(command.run_id, publication));
            }
          }
        } catch (error) {
          reason = publicationIsFenced()
            ? `${stopped}; committed work remains in the managed worktree, but publication is fenced`
            : `${stopped}, but the work committed before cancellation could NOT be published: ${
                error instanceof PublicationError ? error.reason : "publication failed"
              }`;
          emit({ kind: "run_log", run_id: command.run_id, chunk: reason });
        }
      } else if (produced) {
        reason = `${stopped}; committed work remains in the managed worktree, but publication is fenced`;
        emit({ kind: "run_log", run_id: command.run_id, chunk: reason });
      }
      emitKnowledgeHandoff(
        "blocked",
        reason,
        ["Run cancelled before verification."],
        [
          ...(dirty.length > 0
            ? [`${dirty.length} uncommitted path(s) could not be published.`]
            : []),
        ],
      );
      emit({ kind: "run_log", run_id: command.run_id, chunk: reason });
      emit({ kind: "run_status", run_id: command.run_id, status: "cancelled" });
      return finish({
        outcome: "cancelled",
        commit_sha: produced ? commit : null,
        verification_passed: false,
        usage,
        empty: !produced,
        publication,
        session_id: sessionId,
        reason,
      });
    };
    const emitFailure = (
      failureStage: RunnerExecutionStage,
      code: string,
      detail: string,
    ): void => {
      const safeDetail = redactExactLocalPaths(detail, [
        ...registeredSensitivePaths,
        repositoryPath,
        worktree?.path,
        scratch,
        this.runner.scratch_root,
      ]).slice(0, 4_000);
      emitKnowledgeHandoff("failed", safeDetail, [safeDetail], [`${code} during ${failureStage}`]);
      emit({
        kind: "run_status",
        run_id: command.run_id,
        status: "failed",
        failure: { stage: failureStage, code, detail: safeDetail },
      });
      emit({
        kind: "run_log",
        run_id: command.run_id,
        chunk: `runner failure [${code}] during ${failureStage}: ${safeDetail}`,
      });
    };

    if (capabilities.knowledge_transport) {
      const tokenBudget = command.max_input_tokens + command.max_output_tokens;
      emit({
        kind: "knowledge_registration",
        run_id: command.run_id,
        provider: command.provider.slice(0, 200),
        model: command.model.slice(0, 500),
        branch_or_workspace: command.target_branch.slice(0, 500),
        token_budget: tokenBudget > 0 ? tokenBudget : null,
      });
    }

    try {
      // Stage breadcrumbs: without these the dispatched run shows "0 readable
      // updates" until the runtime starts, and a hang in these stages is
      // indistinguishable from a dead agent.
      emit({
        kind: "run_log",
        run_id: command.run_id,
        chunk: `Loading task context (${command.context_refs.length} document(s), ${command.input_files.length} input file(s))…`,
      });
      let prompt = await this.context.load(command.context_refs);
      const approvedInputFiles = await Promise.all(
        command.input_files.map(async (input) => ({
          ...input,
          bytes: await this.context.loadBytes(input.context_ref),
        })),
      );
      if (controller.signal.aborted) return cancelledBefore("loading context");
      emit({
        kind: "run_log",
        run_id: command.run_id,
        chunk: "Task context loaded. Preparing the isolated worktree…",
      });
      stage = "scratch_prepare";
      const scratchRoot = resolve(this.runner.scratch_root ?? tmpdir());
      await mkdir(scratchRoot, { recursive: true });
      scratch = await mkdtemp(resolve(scratchRoot, "norns-context-"));
      let approvedInputDirectory: string | undefined;
      if (approvedInputFiles.length > 0) {
        const stagedInputDirectory = resolve(scratch, "approved-inputs");
        approvedInputDirectory = stagedInputDirectory;
        await mkdir(stagedInputDirectory, { recursive: true, mode: 0o700 });
        for (const input of approvedInputFiles) {
          await writeFile(resolve(stagedInputDirectory, input.filename), input.bytes, {
            mode: 0o600,
          });
        }
        prompt = [
          prompt,
          "## APPROVED INPUT FILES",
          "The following user-approved files are staged read-only outside the repository. Use these exact paths; do not search the rest of this computer for replacements:",
          ...approvedInputFiles.map(
            (input) => `- ${input.filename}: ${resolve(stagedInputDirectory, input.filename)}`,
          ),
          "Do not commit these staged source files unless the task explicitly requires them as repository fixtures.",
        ].join("\n\n");
      }
      runtimeStateDirectory = resolve(
        scratchRoot,
        "runtime-state",
        createHash("sha256").update(command.task_id).digest("hex"),
      );
      await mkdir(runtimeStateDirectory, { recursive: true, mode: 0o700 });
      await writeFile(resolve(scratch, "prompt.txt"), prompt, { mode: 0o600 });
      // Local workspace removal or filesystem replacement may happen while
      // context is loading. Resolve again immediately before worktree setup.
      stage = "worktree_prepare";
      const currentRepositoryPath = resolveRepositoryPath();
      if (currentRepositoryPath !== repositoryPath) {
        throw new Error("runner repository identity changed before execution");
      }
      worktree = await this.worktrees.prepare({
        repository_path: currentRepositoryPath,
        run_id: command.run_id,
        expected_revision: command.expected_revision,
        target_branch: command.target_branch,
      });
      if (controller.signal.aborted) return cancelledBefore("preparing the worktree");
      emit({ kind: "run_status", run_id: command.run_id, status: "started" });
      if (command.continuation) {
        emit({
          kind: "continuation_context_applied",
          run_id: command.run_id,
          wait_id: command.continuation.wait_id,
          root_command_id: command.continuation.root_command_id,
          context_hash: command.continuation.context_hash,
          replay_context_hash: command.continuation.replay_context_ref.content_hash,
        });
      }
      startKnowledgeHeartbeats();
      stage = "runtime";
      const humanWaitDirectoryName = `.norns-control-${randomUUID()}`;
      const humanWaitDirectory = resolve(worktree.path, humanWaitDirectoryName);
      await mkdir(humanWaitDirectory);
      const humanWaitPath = resolve(humanWaitDirectory, "human-wait.json");
      const processProofBeforeRuntime = processTreeReaped;
      // If the adapter throws after spawning but before returning a proof, the
      // result must remain unconfirmed.
      processTreeReaped = false;
      const fullTaskPrompt = command.human_wait_channel
        ? `${prompt}\n\n${humanWaitPrompt()}\n\nWork efficiently: inspect only the files needed, begin making concrete changes early, then verify and commit. Do not spend repeated turns restating or replanning the approved task.`
        : `${prompt}\n\nWork efficiently: inspect only the files needed, begin making concrete changes early, then verify and commit. Do not spend repeated turns restating or replanning the approved task.`;
      const runtimePrompt = command.recovery
        ? [
            "Continue the previous coding session for this same approved task.",
            "The approved scope and task package are unchanged; do not repeat repository discovery or planning already completed in the prior session.",
            "Inspect the current worktree, continue implementation from the prior session, run the required verification, and commit the result.",
            command.human_wait_channel ? humanWaitPrompt() : "",
          ]
            .filter(Boolean)
            .join("\n\n")
        : fullTaskPrompt;
      const resumeFallbackPrompt = command.recovery
        ? [
            "The previous coding session is unavailable. Begin a fresh coding session for the same approved task using the complete task package below.",
            "Inspect the current worktree, implement the approved scope, run the required verification, and commit the result.",
            fullTaskPrompt,
          ].join("\n\n")
        : fullTaskPrompt;
      let runtimeResult = await runtime.run({
        runId: command.run_id,
        worktreePath: worktree.path,
        prompt: runtimePrompt,
        ...(resumeSessionId ? { resumeFallbackPrompt } : {}),
        additionalReadDirectories: approvedInputDirectory ? [approvedInputDirectory] : [],
        runtimeStateDirectory,
        humanWaitPath,
        timeoutMs: command.max_duration_seconds * 1_000,
        executionMode: command.execution_mode ?? "planned",
        ...(command.max_charge_usd > 0 ? { maxBudgetUsd: command.max_charge_usd } : {}),
        // EXECUTION E11 — THE line that was missing. Every adapter accepted a
        // signal and none was ever handed one, so `cancelled` was a result the
        // executor could report and nothing could produce.
        signal: controller.signal,
        onSession: (live) => {
          session = live;
        },
        onLog: (chunk) =>
          emit({
            kind: "run_log",
            run_id: command.run_id,
            chunk: redactExactLocalPaths(chunk, [
              ...registeredSensitivePaths,
              repositoryPath,
              worktree?.path,
              scratch,
              this.runner.scratch_root,
            ]),
          }),
      });
      processTreeReaped = processProofBeforeRuntime && runtimeResult.process_tree_reaped === true;
      let humanWaitEnvelope: HumanWaitEnvelopeT | null;
      try {
        humanWaitEnvelope = await readHumanWaitEnvelope(humanWaitPath);
        if (humanWaitEnvelope) {
          try {
            await execFileAsync("git", [
              "-C",
              worktree.path,
              "cat-file",
              "-e",
              `HEAD:${humanWaitDirectoryName}/human-wait.json`,
            ]);
            throw new Error("human wait control envelope was committed into the repository");
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "human wait control envelope was committed into the repository"
            ) {
              throw error;
            }
          }
        }
      } finally {
        await rm(humanWaitDirectory, { recursive: true, force: true });
      }
      if (humanWaitEnvelope) {
        if (!command.human_wait_channel) {
          throw new Error(
            "runtime produced a human wait envelope for a command without an audited ask channel",
          );
        }
        runtimeResult = {
          outcome: "waiting_for_human",
          detail: humanWaitEnvelope.compact_summary,
          usage: runtimeResult.usage,
          ...(runtimeResult.process_tree_reaped !== undefined
            ? { process_tree_reaped: runtimeResult.process_tree_reaped }
            : {}),
          ...(runtimeResult.sessionId ? { sessionId: runtimeResult.sessionId } : {}),
          stopReason: "waiting_for_human",
          humanWait: hashHumanWaitEnvelope(humanWaitEnvelope),
        };
      }
      // Cancellation may arrive after the runtime has resolved but before the
      // executor has inspected its result. Normalize that race into the same
      // cancellation path instead of allowing a stale "completed" result to
      // proceed to verification or publication.
      if (controller.signal.aborted && runtimeResult.outcome !== "cancelled") {
        runtimeResult = {
          outcome: "cancelled",
          detail: cancelReason ?? "the run was cancelled after the runtime returned",
          usage: runtimeResult.usage,
          ...(runtimeResult.process_tree_reaped !== undefined
            ? { process_tree_reaped: runtimeResult.process_tree_reaped }
            : {}),
          ...(runtimeResult.sessionId ? { sessionId: runtimeResult.sessionId } : {}),
          stopReason: "cancelled",
        };
      }
      if (runtimeResult.sessionId) {
        sessionId = runtimeResult.sessionId;
        // Emitted as a run log because that is the only durable channel a
        // runner has today: no event payload, dispatch field, or column exists
        // to carry a session id (routed to the PM). On an ephemeral Actions
        // runner this line is the ONLY thing that outlives the machine.
        // A session id is an opaque local identifier, not a credential — the
        // provider still requires its own authentication to use one.
        emit({
          kind: "run_log",
          run_id: command.run_id,
          chunk: `runtime session id (resumable): ${sessionId}`,
        });
      }
      emit({
        kind: "usage_report",
        run_id: command.run_id,
        input_tokens: runtimeResult.usage.input_tokens,
        output_tokens: runtimeResult.usage.output_tokens,
      });
      emit({
        kind: "runtime_result",
        run_id: command.run_id,
        runtime: runtime.name,
        outcome: runtimeResult.outcome,
        session_id: runtimeResult.sessionId ?? null,
        stop_reason: runtimeResult.stopReason?.trim().slice(0, 500) || null,
        detail: knowledgeText(runtimeResult.detail, "Runtime finished."),
      });
      emitKnowledgeHeartbeat({
        status: "working",
        completed: ["Coding runtime finished."],
        current: ["Inspecting the resulting worktree and preparing verification."],
        findings: runtimeResult.detail
          ? [knowledgeText(runtimeResult.detail, "Runtime finished.")]
          : [],
        remaining: "moderate",
        risk: runtimeResult.outcome === "completed" ? "green" : "red",
      });
      if (controller.signal.aborted && runtimeResult.outcome !== "cancelled") {
        return await cancelledWithWorktree(runtimeResult.usage);
      }
      if (runtimeResult.outcome === "waiting_for_human") {
        if (!command.human_wait_channel) {
          const reason = "the source command did not authorize a versioned human-wait channel";
          emitFailure("runtime", "human_wait_channel_unauthorized", reason);
          return finish({
            outcome: "failed",
            commit_sha: null,
            verification_passed: false,
            usage: runtimeResult.usage,
            empty: false,
            publication: null,
            session_id: sessionId,
            reason,
          });
        }
        const request = runtimeResult.humanWait;
        const questionHash = request
          ? createHash("sha256").update(request.question).digest("hex")
          : null;
        const summaryHash = request
          ? createHash("sha256").update(request.compactSummary).digest("hex")
          : null;
        if (
          !request ||
          questionHash !== request.questionHash ||
          summaryHash !== request.compactSummaryHash
        ) {
          const reason =
            "the runtime requested human input without a valid typed question/visible-summary receipt";
          emitFailure("runtime", "human_wait_receipt_invalid", reason);
          return finish({
            outcome: "failed",
            commit_sha: null,
            verification_passed: false,
            usage: runtimeResult.usage,
            empty: false,
            publication: null,
            session_id: sessionId,
            reason,
          });
        }
        const dirty = await this.allUncommittedPaths(worktree.path);
        if (controller.signal.aborted) {
          return await cancelledWithWorktree(runtimeResult.usage);
        }
        // EXEC-WAIT-1 — a run that asks for human input mid-task routinely has
        // uncommitted work: the model paused to ask, not to commit. Checkpoint
        // it exactly as the verification path does, so the wait rests on a
        // resumable pushed commit instead of failing the run and discarding the
        // work. The published checkpoint below is what makes an ephemeral
        // worktree resumable — the reason the old code refused rather than lose
        // it, now satisfied by committing instead of refusing.
        let commit = await worktree.head();
        if (dirty.length > 0) {
          commit = await this.checkpointUncommittedChanges(worktree.path, command.task_id);
          emit({
            kind: "run_log",
            run_id: command.run_id,
            chunk: `human input was requested with ${dirty.length} uncommitted path(s); the runner checkpointed them at commit ${commit} so the wait resumes exactly`,
          });
        }
        if (controller.signal.aborted) {
          return await cancelledWithWorktree(runtimeResult.usage);
        }
        let publication: PublicationResult;
        try {
          if (!this.publisher) {
            throw new PublicationError(
              "this runner has no publisher configured for a resumable human checkpoint",
              "construct V2RunnerExecutor with a RunnerPublisher",
            );
          }
          if (controller.signal.aborted) {
            return await cancelledWithWorktree(runtimeResult.usage);
          }
          publication = await this.publisher.publish({
            worktree_path: worktree.path,
            branch: command.target_branch,
            commit,
            run_id: command.run_id,
            task_id: command.task_id,
            verification_passed: false,
            verification_summary: "waiting for a human decision; checkpoint is not yet verified",
            signal: publicationFence.signal,
          });
          if (controller.signal.aborted && publicationIsFenced()) {
            return await cancelledWithWorktree(runtimeResult.usage);
          }
          if (publication.outcome === "local_only" || publication.remote === null) {
            throw new PublicationError(
              "a human wait requires a remotely pushed checkpoint",
              "local-only branches cannot survive an ephemeral runner",
            );
          }
        } catch (error) {
          if (controller.signal.aborted) {
            return await cancelledWithWorktree(runtimeResult.usage);
          }
          const reason =
            error instanceof PublicationError
              ? error.reason
              : "the human-wait checkpoint could not be published";
          emitFailure("publication", "human_wait_checkpoint_unpublished", reason);
          return finish({
            outcome: "failed",
            commit_sha: commit,
            verification_passed: false,
            usage: runtimeResult.usage,
            empty: commit === worktree.base_revision,
            publication: null,
            session_id: sessionId,
            reason,
          });
        }
        // Ordering is part of the protocol: the coordinator may open a wait
        // only after it has durably applied this exact pushed publication.
        emit(this.publishedEvent(command.run_id, publication));
        emit({
          kind: "human_wait_requested",
          run_id: command.run_id,
          decision_point: request.decisionPoint,
          question: request.question,
          question_hash: request.questionHash,
          compact_summary: request.compactSummary,
          compact_summary_hash: request.compactSummaryHash,
          runtime: runtime.name,
          session_id: runtimeResult.sessionId ?? null,
          ask_channel_version: command.human_wait_channel.version,
          ask_instruction_hash: command.human_wait_channel.instruction_hash,
        });
        emitKnowledgeHandoff(
          "blocked",
          request.compactSummary,
          ["Execution is paused at a remotely published checkpoint."],
          [request.question],
        );
        emit({ kind: "run_status", run_id: command.run_id, status: "waiting_for_human" });
        return finish({
          outcome: "waiting_for_human",
          commit_sha: commit,
          verification_passed: false,
          usage: runtimeResult.usage,
          empty: commit === worktree.base_revision,
          publication,
          session_id: sessionId,
          reason: request.question,
        });
      }
      // EXECUTION E11 — A CANCELLED RUN IS NOT A FAILED RUN, AND ITS WORK IS
      // NOT FORFEIT.
      //
      // The old code collapsed both non-completed outcomes into one branch that
      // returned `publication: null` and then let the `finally` delete the
      // worktree. Applied to a real cancellation that is a data-destroying
      // punishment for using the stop button: an agent may have spent forty
      // minutes and made six good commits before a human decided the seventh
      // was going the wrong way, and on the ephemeral Actions runner those
      // commits exist nowhere else.
      //
      // So cancellation publishes. The justification is the same one E4 already
      // settled for FAILING runs — "failed work is still work", and the only
      // run whose commits are not published is the one that has none — and it
      // applies with more force here, because a cancellation is a HUMAN
      // decision about direction, not a verdict on the code. The branch and its
      // PR are inert until someone merges them; discarding them is
      // irreversible, keeping them is not. The asymmetry decides it.
      //
      // Verification is deliberately NOT run. A human who just asked the run to
      // stop must not then wait on (and pay for) a thirty-minute test suite,
      // and a green badge on a half-finished change would assert something
      // nobody checked. The publication is marked unverified and says why.
      if (runtimeResult.outcome === "cancelled") {
        return await cancelledWithWorktree(runtimeResult.usage);
      }
      stage = "worktree_inspection";
      const uncommitted = await this.allUncommittedPaths(worktree.path);
      let commit = await worktree.head();
      if (uncommitted.length > 0) {
        commit = await this.checkpointUncommittedChanges(worktree.path, command.task_id);
        emit({
          kind: "run_log",
          run_id: command.run_id,
          chunk: `the coding runtime left ${uncommitted.length} uncommitted path(s); the runner checkpointed them at commit ${commit} before independent verification`,
        });
      }
      knowledgeCommit = commit;
      knowledgeFiles = boundedKnowledgeList(
        await this.changedPaths(worktree.path, worktree.base_revision, commit),
      );
      if (controller.signal.aborted) {
        return await cancelledWithWorktree(runtimeResult.usage);
      }

      // EXECUTION E4 — an empty run, reported as empty.
      //
      // The runtime saying "completed" only means the agent's process exited
      // cleanly; it says nothing about whether the agent did any work. When the
      // worktree is still sitting on the revision it started from, the agent
      // produced no commit. There is nothing to publish and nothing to verify,
      // and calling that a success is the exact dishonesty this phase exists to
      // remove.
      if (commit === worktree.base_revision) {
        const permissionDenied = runtimeResult.stopReason?.startsWith("permission_denied");
        const runtimeStopped = runtimeResult.outcome !== "completed";
        const reason = permissionDenied
          ? `the coding agent produced no commit because ${runtimeResult.detail}`
          : runtimeStopped
            ? `the coding runtime ${runtimeResult.outcome} before producing a commit: ${runtimeResult.detail}`
            : "the coding agent produced no commit; the run is empty";
        emitFailure(
          runtimeStopped ? "runtime" : "worktree_inspection",
          permissionDenied
            ? "runner_permission_denied"
            : runtimeStopped
              ? "runner_runtime_unsuccessful"
              : "runner_empty_result",
          reason,
        );
        return finish({
          outcome: "failed",
          commit_sha: null,
          verification_passed: false,
          usage: runtimeResult.usage,
          empty: true,
          publication: null,
          session_id: sessionId,
          reason,
        });
      }
      if (runtimeResult.outcome !== "completed") {
        emit({
          kind: "run_log",
          run_id: command.run_id,
          chunk: `the coding runtime stopped (${runtimeResult.stopReason ?? runtimeResult.outcome}) after producing commit ${commit}; running independent verification before deciding whether to publish it`,
        });
      }

      // The contract types `command` as `string[]` with a runtime `.min(1)`;
      // the runner's own type is a non-empty tuple, because `execFile` needs a
      // file argument that provably exists. Narrow here rather than casting: a
      // vector that somehow arrived empty is dropped, not spawned with
      // `undefined` as the program name.
      const dispatchVerificationCommands = command.verification_commands
        ?.map((entry) => {
          const [file, ...args] = entry.command;
          return file ? { name: entry.name, command: [file, ...args] as const } : null;
        })
        .filter((entry): entry is VerificationCommand => entry !== null);
      if (controller.signal.aborted) {
        return await cancelledWithWorktree(runtimeResult.usage);
      }
      stage = "verification";
      const processProofBeforeVerification = processTreeReaped;
      processTreeReaped = false;
      const verification = await this.verifier.verify({
        worktree_path: worktree.path,
        policy_ref: command.verification_policy_ref,
        expected_commit: commit,
        base_revision: worktree.base_revision,
        // EXECUTION E11 — E10 put the project's real commands on the dispatch
        // command and the runner ignored them, so the field it added was inert
        // and every project without a committed manifest still failed closed.
        // Length-checked, not just presence-checked. An EMPTY command list
        // would make `results.every(...)` vacuously true and hand back a green
        // badge for running nothing at all — precisely the dishonesty E4
        // removed. Empty falls through to the next source and, failing that,
        // fails closed.
        ...(dispatchVerificationCommands && dispatchVerificationCommands.length > 0
          ? { commands: dispatchVerificationCommands }
          : {}),
        ...(command.repository_verification_manifest !== undefined
          ? { repository_manifest: true as const }
          : {}),
        signal: controller.signal,
      });
      processTreeReaped = processProofBeforeVerification && verification.process_tree_reaped;
      if (controller.signal.aborted) {
        return await cancelledWithWorktree(runtimeResult.usage);
      }
      // The failing output is the single most useful thing a human can be
      // handed, and the event contract carries only a digest of it. Stream the
      // real text as run logs so the failure is diagnosable from the UI.
      if (!verification.passed) {
        emit({
          kind: "run_log",
          run_id: command.run_id,
          chunk: redactExactLocalPaths(`verification failed:\n${verification.output}`, [
            ...registeredSensitivePaths,
            repositoryPath,
            worktree?.path,
            scratch,
            this.runner.scratch_root,
          ]),
        });
      } else if (verification.hygiene_only) {
        // Never let a green badge overstate itself.
        emit({
          kind: "run_log",
          run_id: command.run_id,
          chunk: `verification passed, but only the built-in Git hygiene check ran — this project has no verification commands configured. Set NORNS_VERIFICATION_POLICIES_JSON or commit ${REPOSITORY_VERIFICATION_MANIFEST}.`,
        });
      }
      emit({
        kind: "verification_result",
        node_id: command.task_id,
        commit_sha: commit,
        passed: verification.passed,
        output_digest: createHash("sha256").update(verification.output).digest("hex"),
        // EXECUTION E11 — the results the executor has always had and never
        // sent. Without them `phase4EventProcessor` wrote `'[]'::jsonb` and a
        // failed verification reached a human as a red badge over a sha256
        // digest of text nobody kept.
        command_results: verification.command_results.map((result) => ({
          name: result.name,
          command: [...result.command],
          exit_code: result.exit_code,
          passed: result.passed,
          output: result.output,
        })),
      });
      knowledgeTestResults = boundedKnowledgeList(
        verification.command_results.map(
          (result) =>
            `${result.passed ? "pass" : "fail"}: ${result.name} (${result.command.join(" ")})`,
        ),
      );
      // `emit` is synchronous and may process a just-delivered generation
      // fence. Check again after the verification event and immediately before
      // any publication operation.
      if (controller.signal.aborted) {
        return await cancelledWithWorktree(runtimeResult.usage);
      }

      // EXECUTION E4 — publish BEFORE the `finally` removes the worktree.
      //
      // Publication is attempted whether or not verification passed. Failed
      // work is still work: a human reviewing why the tests went red needs the
      // branch, and destroying it would leave them with a digest of an error
      // message. The only run whose commits are not published is the one that
      // has none.
      let publication: PublicationResult | null = null;
      try {
        stage = "publication";
        if (!this.publisher) {
          throw new PublicationError(
            "this runner has no publisher configured, so the run's commits cannot be made durable",
            "construct V2RunnerExecutor with a RunnerPublisher",
          );
        }
        if (controller.signal.aborted) {
          return await cancelledWithWorktree(runtimeResult.usage);
        }
        publication = await this.publisher.publish({
          worktree_path: worktree.path,
          branch: command.target_branch,
          commit,
          run_id: command.run_id,
          task_id: command.task_id,
          verification_passed: verification.passed,
          verification_summary: verification.reason ?? verification.output.slice(0, 4_000),
          signal: publicationFence.signal,
        });
        if (controller.signal.aborted && publicationIsFenced()) {
          return await cancelledWithWorktree(runtimeResult.usage);
        }
        emit({
          kind: "run_log",
          run_id: command.run_id,
          chunk: redactExactLocalPaths(
            [
              `published ${publication.outcome}: branch ${publication.branch} at ${publication.commit}`,
              publication.remote ? `remote: ${publication.remote}` : null,
              publication.pull_request_url
                ? `pull request: ${publication.pull_request_url}`
                : publication.pull_request_note,
            ]
              .filter(Boolean)
              .join("\n"),
            [
              ...registeredSensitivePaths,
              repositoryPath,
              worktree?.path,
              scratch,
              this.runner.scratch_root,
            ],
          ),
        });
        knowledgeArtifacts = boundedKnowledgeList([
          `branch:${publication.branch}`,
          `commit:${publication.commit}`,
          ...(publication.remote ? [`remote:${publication.remote}`] : []),
          ...(publication.pull_request_url ? [publication.pull_request_url] : []),
        ]);
        emit(this.publishedEvent(command.run_id, publication));
      } catch (error) {
        if (controller.signal.aborted) {
          return await cancelledWithWorktree(runtimeResult.usage);
        }
        // A push that did not happen is a FAILED run with a reason, never a
        // success and never a silent loss. Saying "succeeded" here would be
        // claiming durability for commits that are about to be deleted.
        const reason =
          error instanceof PublicationError
            ? `the run's work could not be published: ${error.reason}`
            : "the run's work could not be published";
        emitFailure("publication", "runner_publication_failed", reason);
        return finish({
          outcome: "failed",
          commit_sha: commit,
          verification_passed: verification.passed,
          usage: runtimeResult.usage,
          empty: false,
          publication: null,
          session_id: sessionId,
          reason,
        });
      }

      if (verification.passed) {
        if (capabilities.knowledge_transport) {
          emit({
            kind: "knowledge_delta",
            run_id: command.run_id,
            changes: [
              {
                kind: "confirmed_assumption",
                summary: "Verified task implementation completed",
                detail: knowledgeText(
                  `Runner verification passed for commit ${commit}${
                    knowledgeFiles.length > 0 ? ` after changing ${knowledgeFiles.join(", ")}` : ""
                  }.`,
                  `Runner verification passed for commit ${commit}.`,
                ),
                affected_package_ids: [],
              },
            ],
            recommended_package_updates: [],
          });
        }
        emitKnowledgeHeartbeat({
          status: "completed",
          completed: [
            runtimeResult.outcome === "completed"
              ? "Coding runtime completed."
              : `Coding runtime stopped after producing commit ${commit}; the runner recovered it.`,
            "Verification passed.",
            "Work was published.",
          ],
          current: [],
          tests: knowledgeTestResults.join("; ") || "Runner verification passed.",
          remaining: "small",
          risk: "green",
        });
        emitKnowledgeHandoff(
          "completed",
          `Verified implementation published at commit ${commit}.`,
          [
            ...(runtimeResult.outcome !== "completed"
              ? [
                  `The coding runtime stopped (${runtimeResult.stopReason ?? runtimeResult.outcome}) after committing; the runner independently verified and published the commit.`,
                ]
              : []),
            ...(verification.hygiene_only
              ? ["Only the built-in Git hygiene verification policy ran."]
              : []),
          ],
          [],
        );
        emit({ kind: "run_status", run_id: command.run_id, status: "completed" });
      } else {
        emitFailure(
          "verification",
          "runner_verification_failed",
          verification.reason ?? "verification failed",
        );
      }
      return finish({
        outcome: verification.passed ? "succeeded" : "failed",
        commit_sha: commit,
        verification_passed: verification.passed,
        usage: runtimeResult.usage,
        empty: false,
        publication,
        session_id: sessionId,
        reason: verification.passed ? null : (verification.reason ?? "verification failed"),
      });
    } catch (error) {
      // EXECUTION E11 — an abort mid-stage typically surfaces as a thrown
      // error (a killed child process, a rejected fetch). Reporting that as
      // `failed` would tell a human their cancellation broke the run.
      if (controller.signal.aborted) {
        return worktree
          ? await cancelledWithWorktree({
              input_tokens: 0,
              output_tokens: 0,
              usage_source: "unavailable",
            })
          : cancelledBefore("the run was in progress");
      }
      const code = FAILURE_CODE_BY_STAGE[stage];
      const rawDetail = error instanceof Error ? error.message : String(error);
      const detail = rawDetail.trim() || "runner execution failed without diagnostic detail";
      emitFailure(stage, code, detail);
      return finish({
        outcome: "failed",
        commit_sha: null,
        verification_passed: false,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          usage_source: "unavailable",
        },
        empty: false,
        publication: null,
        session_id: sessionId,
        reason: `${code}: ${redactExactLocalPaths(detail, [
          ...registeredSensitivePaths,
          repositoryPath,
          worktree?.path,
          scratch,
          this.runner.scratch_root,
        ])}`,
      });
    } finally {
      stopKnowledgeHeartbeats();
      // Deregister before cleanup or recovery handoff: from this moment a
      // control aimed at this run is answered with "already ended (<outcome>)"
      // rather than being applied to a process that no longer exists.
      release?.(settled, { process_tree_reaped: processTreeReaped });
      // Cancellation preserves the managed worktree for local diagnosis and
      // recovery. In particular, generation fencing must stop the process tree
      // without destroying evidence or publishing through a revoked device.
      if (!controller.signal.aborted && !preserveWorktree) {
        await worktree?.cleanup().catch(() => undefined);
      }
      if (scratch) await rm(scratch, { recursive: true, force: true });
      if (runtimeStateDirectory && removeRuntimeState) {
        await rm(runtimeStateDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * EXECUTION E11 — the structural half of "where the run's work went".
   *
   * E4 published the branch and opened the pull request, then reported it as
   * `run_log` PROSE; E10 added the durable columns and the `run_published`
   * event to carry it, and nothing emitted one, so the columns stayed null and
   * the UI could not link a task to its review.
   *
   * The `outcome` enum on the wire is narrower than the runner's own: the
   * contract has `pushed | local_only`, while publication distinguishes
   * `pushed`, `already_published` and `republished`. All three mean the same
   * load-bearing thing — the commits are on the remote at this commit — so they
   * collapse to `pushed`, and the finer distinction stays in the run log rather
   * than being invented into a field that cannot hold it (routed as E11-11).
   */
  private publishedEvent(
    runId: string,
    publication: PublicationResult,
  ): Extract<EventPayloadT, { kind: "run_published" }> {
    return {
      kind: "run_published",
      run_id: runId,
      outcome: publication.outcome === "local_only" ? "local_only" : "pushed",
      branch: publication.branch,
      commit_sha: publication.commit,
      remote: publication.remote,
      pull_request_url: publication.pull_request_url,
      pull_request_note: publication.pull_request_note,
    };
  }

  /** Paths the agent changed but never committed. Cannot be published. */
  private async uncommittedPaths(worktreePath: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync("git", [
        "-C",
        worktreePath,
        "status",
        "--porcelain",
        "--untracked-files=no",
      ]);
      return stdout
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** A human wait must preserve even untracked files before the runner exits. */
  private async allUncommittedPaths(worktreePath: string): Promise<string[]> {
    const { stdout } = await execFileAsync("git", [
      "-C",
      worktreePath,
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    return stdout
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  }

  /**
   * A coding runtime can complete the implementation yet stop at the remote
   * delivery boundary (for example, because `main` is checked out in the base
   * clone or remote credentials are intentionally absent). The isolated
   * worktree is already the runner's task-scoped trust boundary, so checkpoint
   * every visible change locally before verification instead of deleting
   * tested work merely because the model omitted `git commit`.
   */
  private async checkpointUncommittedChanges(
    worktreePath: string,
    taskId: string,
  ): Promise<string> {
    await execFileAsync("git", ["-C", worktreePath, "add", "--all"]);
    await execFileAsync("git", [
      "-C",
      worktreePath,
      "-c",
      "user.name=Norns Runner",
      "-c",
      "user.email=runner@norns.local",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--no-verify",
      "-m",
      `Checkpoint task changes for ${taskId}`,
    ]);
    return (await execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"])).stdout.trim();
  }

  /** Repository-relative committed paths are useful evidence and reveal no local root. */
  private async changedPaths(
    worktreePath: string,
    baseRevision: string,
    commit: string,
  ): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync("git", [
        "-C",
        worktreePath,
        "diff",
        "--name-only",
        "--no-renames",
        `${baseRevision}..${commit}`,
      ]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
