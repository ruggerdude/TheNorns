import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  type EventPayloadT,
  type V2ContentAddressedReferenceT,
  V2DispatchCommand,
  type V2DispatchCommandT,
} from "@norns/contracts";
import { type PublicationResult, PublicationError, type RunnerPublisher } from "./publication.js";
import type { CodingRuntime, RuntimeRunResult } from "./runtimes/types.js";
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

function redactExactLocalPaths(value: string, paths: readonly (string | undefined)[]): string {
  let redacted = value;
  const variants = new Set<string>();
  for (const path of paths.filter((candidate): candidate is string => Boolean(candidate))) {
    variants.add(path);
    variants.add(resolve(path));
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

  async load(references: readonly V2ContentAddressedReferenceT[]): Promise<string> {
    const parts: string[] = [];
    for (const reference of references) {
      const bytes = await this.fetcher.fetch(reference);
      if (bytes.byteLength !== reference.byte_size) {
        throw new Error(`context ${reference.artifact_id} byte-size mismatch`);
      }
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== reference.content_hash) {
        throw new Error(`context ${reference.artifact_id} content hash mismatch`);
      }
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
    await execFileAsync("git", ["-C", path, "switch", "-c", input.target_branch]);
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
}

export interface RunnerVerifier {
  verify(input: {
    worktree_path: string;
    policy_ref: string;
    expected_commit: string;
    /** The commit the worktree started at, so an empty run cannot pass. */
    base_revision: string;
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
  }): Promise<RunnerVerificationResult> {
    const refuse = (reason: string): RunnerVerificationResult => ({
      passed: false,
      output: reason,
      command_results: [],
      reason,
      hygiene_only: false,
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

    let commands = this.policies.get(input.policy_ref);
    let source = `policy ${input.policy_ref}`;
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
      results.push(await this.runCommand(entry, input.worktree_path));
    }

    const headAfter = await this.head(input.worktree_path);
    if (headAfter !== input.expected_commit) {
      return {
        passed: false,
        output: this.render(source, results),
        command_results: results,
        reason: `verification commands moved HEAD from ${input.expected_commit} to ${headAfter}; the result does not describe the commit under test`,
        hygiene_only: false,
      };
    }

    const passed = results.every((result) => result.passed);
    return {
      passed,
      output: this.render(source, results),
      command_results: results,
      reason: null,
      hygiene_only: isHygieneOnly(commands),
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
  ): Promise<VerificationCommandResult> {
    const [file, ...args] = entry.command;
    try {
      const result = await execFileAsync(file, args, {
        cwd: worktreePath,
        maxBuffer: 10 * 1024 * 1024,
        timeout: VERIFICATION_COMMAND_TIMEOUT_MS,
        // No shell, ever. `entry.command` is an argv vector and stays one.
        shell: false,
      });
      return {
        name: entry.name,
        command: entry.command,
        exit_code: 0,
        passed: true,
        output: `${result.stdout}\n${result.stderr}`.slice(0, VERIFICATION_OUTPUT_LIMIT),
      };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
      const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
      const detail = `${stdout}\n${stderr}`.trim();
      return {
        name: entry.name,
        command: entry.command,
        // A command killed by signal, or one that could not be spawned at all,
        // has no numeric exit code. -1 records "did not exit cleanly".
        exit_code: typeof failure.code === "number" ? failure.code : -1,
        passed: false,
        output: (detail || (error instanceof Error ? error.message : String(error))).slice(
          0,
          VERIFICATION_OUTPUT_LIMIT,
        ),
      };
    }
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
  outcome: "succeeded" | "failed" | "cancelled";
  commit_sha: string | null;
  verification_passed: boolean;
  usage: RuntimeRunResult["usage"];
  /** True when the coding agent finished without producing a commit. */
  empty: boolean;
  /** Where the work went. Null when there was nothing to publish. */
  publication: PublicationResult | null;
  /** Why the run ended as it did, in words a human can act on. */
  reason: string | null;
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
  ) {}

  async execute(
    commandInput: V2DispatchCommandT,
    emit: (event: EventPayloadT) => void,
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
    const runtime =
      typeof runtimeProvider === "function"
        ? runtimeProvider(command.model, {
            runId: command.run_id,
            taskId: command.task_id,
            maxOutputTokens: command.max_output_tokens,
          })
        : runtimeProvider;
    let scratch: string | undefined;
    let worktree: PreparedWorktree | undefined;
    try {
      const prompt = await this.context.load(command.context_refs);
      scratch = await mkdtemp(resolve(this.runner.scratch_root ?? tmpdir(), "norns-context-"));
      await writeFile(resolve(scratch, "prompt.txt"), prompt, { mode: 0o600 });
      // Local workspace removal or filesystem replacement may happen while
      // context is loading. Resolve again immediately before worktree setup.
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
      emit({ kind: "run_status", run_id: command.run_id, status: "started" });
      const runtimeResult = await runtime.run({
        runId: command.run_id,
        worktreePath: worktree.path,
        prompt,
        timeoutMs: command.max_duration_seconds * 1_000,
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
      emit({
        kind: "usage_report",
        run_id: command.run_id,
        input_tokens: runtimeResult.usage.input_tokens,
        output_tokens: runtimeResult.usage.output_tokens,
      });
      if (runtimeResult.outcome !== "completed") {
        emit({
          kind: "run_status",
          run_id: command.run_id,
          status: runtimeResult.outcome === "cancelled" ? "cancelled" : "failed",
        });
        return {
          outcome: runtimeResult.outcome === "cancelled" ? "cancelled" : "failed",
          commit_sha: null,
          verification_passed: false,
          usage: runtimeResult.usage,
          empty: false,
          publication: null,
          reason: `the coding runtime ${runtimeResult.outcome}`,
        };
      }
      const commit = await worktree.head();

      // EXECUTION E4 — an empty run, reported as empty.
      //
      // The runtime saying "completed" only means the agent's process exited
      // cleanly; it says nothing about whether the agent did any work. When the
      // worktree is still sitting on the revision it started from, the agent
      // produced no commit. There is nothing to publish and nothing to verify,
      // and calling that a success is the exact dishonesty this phase exists to
      // remove.
      if (commit === worktree.base_revision) {
        const reason = "the coding agent produced no commit; the run is empty";
        emit({ kind: "run_log", run_id: command.run_id, chunk: reason });
        emit({ kind: "run_status", run_id: command.run_id, status: "failed" });
        return {
          outcome: "failed",
          commit_sha: null,
          verification_passed: false,
          usage: runtimeResult.usage,
          empty: true,
          publication: null,
          reason,
        };
      }

      const verification = await this.verifier.verify({
        worktree_path: worktree.path,
        policy_ref: command.verification_policy_ref,
        expected_commit: commit,
        base_revision: worktree.base_revision,
      });
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
      });

      // EXECUTION E4 — publish BEFORE the `finally` removes the worktree.
      //
      // Publication is attempted whether or not verification passed. Failed
      // work is still work: a human reviewing why the tests went red needs the
      // branch, and destroying it would leave them with a digest of an error
      // message. The only run whose commits are not published is the one that
      // has none.
      let publication: PublicationResult | null = null;
      try {
        if (!this.publisher) {
          throw new PublicationError(
            "this runner has no publisher configured, so the run's commits cannot be made durable",
            "construct V2RunnerExecutor with a RunnerPublisher",
          );
        }
        publication = await this.publisher.publish({
          worktree_path: worktree.path,
          branch: command.target_branch,
          commit,
          run_id: command.run_id,
          task_id: command.task_id,
          verification_passed: verification.passed,
          verification_summary: verification.reason ?? verification.output.slice(0, 4_000),
        });
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
      } catch (error) {
        // A push that did not happen is a FAILED run with a reason, never a
        // success and never a silent loss. Saying "succeeded" here would be
        // claiming durability for commits that are about to be deleted.
        const reason =
          error instanceof PublicationError
            ? `the run's work could not be published: ${error.reason}`
            : "the run's work could not be published";
        emit({ kind: "run_log", run_id: command.run_id, chunk: reason });
        emit({ kind: "run_status", run_id: command.run_id, status: "failed" });
        return {
          outcome: "failed",
          commit_sha: commit,
          verification_passed: verification.passed,
          usage: runtimeResult.usage,
          empty: false,
          publication: null,
          reason,
        };
      }

      emit({
        kind: "run_status",
        run_id: command.run_id,
        status: verification.passed ? "completed" : "failed",
      });
      return {
        outcome: verification.passed ? "succeeded" : "failed",
        commit_sha: commit,
        verification_passed: verification.passed,
        usage: runtimeResult.usage,
        empty: false,
        publication,
        reason: verification.passed ? null : (verification.reason ?? "verification failed"),
      };
    } catch {
      emit({ kind: "run_status", run_id: command.run_id, status: "failed" });
      emit({
        kind: "run_log",
        run_id: command.run_id,
        // Never serialize local exception text: child-process and filesystem
        // errors routinely contain the physical repository/worktree path.
        chunk: "runner execution failed; inspect the local runner diagnostics",
      });
      return {
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
        reason: "runner execution failed; inspect the local runner diagnostics",
      };
    } finally {
      await worktree?.cleanup().catch(() => undefined);
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }
}
