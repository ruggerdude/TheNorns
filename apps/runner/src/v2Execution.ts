import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

const execFileAsync = promisify(execFile);

export interface RunnerRepositoryBinding {
  repository_binding_id: string;
  repository_path: string;
}

export class ApprovedRepositoryRegistry {
  private readonly roots: string[];
  private readonly bindings = new Map<string, string>();

  constructor(approvedRoots: readonly string[]) {
    this.roots = approvedRoots.map((root) => resolve(root));
  }

  register(binding: RunnerRepositoryBinding): void {
    const path = resolve(binding.repository_path);
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
    return path;
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
    const resolved = (
      await execFileAsync("git", [
        "-C",
        input.repository_path,
        "rev-parse",
        input.expected_revision,
      ])
    ).stdout.trim();
    if (resolved !== input.expected_revision) {
      throw new Error("expected repository revision must be an exact commit SHA");
    }
    await execFileAsync("git", [
      "-C",
      input.repository_path,
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
        await execFileAsync("git", [
          "-C",
          input.repository_path,
          "worktree",
          "remove",
          "--force",
          path,
        ]);
      },
    };
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
    const repositoryPath = this.repositories.resolve(command.repository_binding_id);
    const runtimeProvider = this.runtimes.get(command.runtime);
    if (!runtimeProvider) throw new Error(`runtime ${command.runtime} is unavailable`);
    const runtime =
      typeof runtimeProvider === "function" ? runtimeProvider(command.model) : runtimeProvider;
    const prompt = await this.context.load(command.context_refs);
    const scratch = await mkdtemp(resolve(this.runner.scratch_root ?? tmpdir(), "norns-context-"));
    await writeFile(resolve(scratch, "prompt.txt"), prompt, { mode: 0o600 });
    const worktree = await this.worktrees.prepare({
      repository_path: repositoryPath,
      run_id: command.run_id,
      expected_revision: command.expected_revision,
      target_branch: command.target_branch,
    });
    emit({ kind: "run_status", run_id: command.run_id, status: "started" });
    try {
      const runtimeResult = await runtime.run({
        runId: command.run_id,
        worktreePath: worktree.path,
        prompt,
        timeoutMs: command.max_duration_seconds * 1_000,
        onLog: (chunk) => emit({ kind: "run_log", run_id: command.run_id, chunk }),
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
    } catch (error) {
      emit({ kind: "run_status", run_id: command.run_id, status: "failed" });
      emit({
        kind: "run_log",
        run_id: command.run_id,
        chunk: error instanceof Error ? error.message : String(error),
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
      await worktree.cleanup().catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
