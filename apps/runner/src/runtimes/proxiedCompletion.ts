// EXECUTION E3 — a coding runtime that gets its model access from the Norns
// relay instead of from provider credentials in its own environment.
//
// READ THIS BEFORE ASSUMING IT REPLACES claude-code OR codex. IT DOES NOT.
//
// What the proxy can serve is bounded by `LlmAdapter`, which exposes exactly
// `complete()` and `completeStructured()`: one prompt in, one finished text
// out. No tool calls, no file reads, no multi-turn loop. A runtime built on
// that can therefore produce TEXT — a plan, a review, an analysis, a patch
// written out in full — but it cannot iteratively explore a repository the way
// Claude Code and Codex do, because there is no channel over which the model
// could ask to read a file and receive the answer.
//
// So this runtime is deliberately narrow and honest about it: it performs one
// proxied completion for the run and records the result as the run's output. It
// is the credential-free path, and it is the path that proves the proxy works
// end to end — real authorization, real metering, real budget enforcement —
// with a real runtime rather than a mock. It is NOT a drop-in for the agentic
// runtimes, and the E3 report says so plainly rather than implying otherwise.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { InferenceProxyError, type RelayInferenceClient } from "../inferenceClient.js";
import type { CodingRuntime, RuntimeRunRequest, RuntimeRunResult, RuntimeUsage } from "./types.js";

/** Where the completion is written inside the worktree. */
export const PROXIED_COMPLETION_OUTPUT = "NORNS_OUTPUT.md";

export interface ProxiedCompletionRuntimeOptions {
  provider: "anthropic" | "openai";
  model: string;
  /** The run and task this runtime is executing, for server-side authorization. */
  runId: string;
  taskId: string;
  maxTokens?: number;
  system?: string;
}

export class ProxiedCompletionRuntime implements CodingRuntime {
  readonly name = "proxied-completion";
  readonly capabilities = {
    // One request/response with no resumable session: the honest matrix is
    // that only cancellation is meaningful.
    interrupt: false,
    suspend: false,
    resume_session: false,
    cancel: true,
    stop_after_current: false,
  };

  constructor(
    private readonly client: RelayInferenceClient,
    private readonly options: ProxiedCompletionRuntimeOptions,
  ) {}

  async run(request: RuntimeRunRequest): Promise<RuntimeRunResult> {
    // `provider_api` is the correct provenance: the numbers come from the
    // provider's own response, forwarded by the server that made the call.
    // Claiming `runtime_report` here would misattribute the source in the
    // usage ledger, and the ledger deliberately never merges sources.
    const usage: RuntimeUsage = {
      input_tokens: 0,
      output_tokens: 0,
      usage_source: "provider_api",
    };
    if (request.signal?.aborted) {
      return { outcome: "cancelled", detail: "cancelled by operator", usage };
    }
    try {
      const completion = await this.client.complete({
        run_id: this.options.runId,
        task_id: this.options.taskId,
        provider: this.options.provider,
        model: this.options.model,
        prompt: request.prompt,
        max_tokens: this.options.maxTokens ?? 8_000,
        ...(this.options.system !== undefined ? { system: this.options.system } : {}),
      });
      usage.input_tokens = completion.input_tokens;
      usage.output_tokens = completion.output_tokens;
      if (request.signal?.aborted) {
        return { outcome: "cancelled", detail: "cancelled by operator", usage };
      }
      await writeFile(resolve(request.worktreePath, PROXIED_COMPLETION_OUTPUT), completion.text, {
        mode: 0o600,
      });
      request.onLog?.(completion.text.slice(0, 2_000));
      return { outcome: "completed", detail: completion.text.slice(0, 2_000), usage };
    } catch (error) {
      if (request.signal?.aborted) {
        return { outcome: "cancelled", detail: "cancelled by operator", usage };
      }
      if (error instanceof InferenceProxyError) {
        // The typed code is the useful part and is safe to surface: it is a
        // category, never provider or credential detail. A budget refusal in
        // particular must be legible in the run log, not buried as a generic
        // failure — that is the whole reason the human chose the proxy.
        return { outcome: "failed", detail: `inference ${error.code}: ${error.message}`, usage };
      }
      return {
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
        usage,
      };
    }
  }
}
