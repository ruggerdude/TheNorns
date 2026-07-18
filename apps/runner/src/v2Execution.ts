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
import type { CodingRuntime, RuntimeRunResult } from "./runtimes/types.js";
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

export interface RunnerVerificationResult {
  passed: boolean;
  output: string;
}

export interface RunnerVerifier {
  verify(input: {
    worktree_path: string;
    policy_ref: string;
    expected_commit: string;
  }): Promise<RunnerVerificationResult>;
}

export class CommandPolicyVerifier implements RunnerVerifier {
  constructor(private readonly policies: ReadonlyMap<string, readonly [string, ...string[]]>) {}

  async verify(input: {
    worktree_path: string;
    policy_ref: string;
    expected_commit: string;
  }): Promise<RunnerVerificationResult> {
    const command = this.policies.get(input.policy_ref);
    if (!command) throw new Error(`verification policy ${input.policy_ref} is not approved`);
    const [file, ...args] = command;
    const result = await execFileAsync(file, args, {
      cwd: input.worktree_path,
      maxBuffer: 10 * 1024 * 1024,
    });
    const actual = (
      await execFileAsync("git", ["-C", input.worktree_path, "rev-parse", "HEAD"])
    ).stdout.trim();
    return {
      passed: actual === input.expected_commit,
      output: `${result.stdout}\n${result.stderr}`.slice(0, 100_000),
    };
  }
}

export type RunnerRuntimeProvider = CodingRuntime | ((model: string) => CodingRuntime);

export interface V2RunnerExecutionResult {
  outcome: "succeeded" | "failed" | "cancelled";
  commit_sha: string | null;
  verification_passed: boolean;
  usage: RuntimeRunResult["usage"];
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
      typeof runtimeProvider === "function" ? runtimeProvider(command.model) : runtimeProvider;
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
        };
      }
      const commit = await worktree.head();
      const verification = await this.verifier.verify({
        worktree_path: worktree.path,
        policy_ref: command.verification_policy_ref,
        expected_commit: commit,
      });
      emit({
        kind: "verification_result",
        node_id: command.task_id,
        commit_sha: commit,
        passed: verification.passed,
        output_digest: createHash("sha256").update(verification.output).digest("hex"),
      });
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
      };
    } finally {
      await worktree?.cleanup().catch(() => undefined);
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }
}
