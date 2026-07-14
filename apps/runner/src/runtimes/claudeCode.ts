// Claude Code runtime via the official Claude Agent SDK. Requires Anthropic
// credentials at run time (NORN-027); construction and the capability matrix
// are credential-free so scheduling can reason about it.
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CodingRuntime, RuntimeRunRequest, RuntimeRunResult, RuntimeUsage } from "./types.js";

export class ClaudeCodeRuntime implements CodingRuntime {
  readonly name = "claude-code";
  readonly capabilities = {
    interrupt: true, // query.interrupt()
    suspend: false,
    resume_session: true, // options.resume with a session id
    cancel: true, // AbortController
    stop_after_current: false,
  };

  constructor(private readonly options: { model?: string; resumeSessionId?: string } = {}) {}

  async run(request: RuntimeRunRequest): Promise<RuntimeRunResult> {
    const usage: RuntimeUsage = {
      input_tokens: 0,
      output_tokens: 0,
      usage_source: "runtime_report",
    };
    try {
      const controller = new AbortController();
      request.signal?.addEventListener("abort", () => controller.abort());
      const stream = query({
        prompt: request.prompt,
        options: {
          cwd: request.worktreePath,
          abortController: controller,
          ...(this.options.model !== undefined ? { model: this.options.model } : {}),
          ...(this.options.resumeSessionId !== undefined
            ? { resume: this.options.resumeSessionId }
            : {}),
        },
      });
      let sessionId: string | undefined;
      let resultDetail = "";
      let failed = false;
      for await (const message of stream) {
        const msg = message as {
          type: string;
          session_id?: string;
          subtype?: string;
          result?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        if (msg.session_id) sessionId = msg.session_id;
        if (msg.type === "assistant" || msg.type === "system") {
          request.onLog?.(JSON.stringify(message).slice(0, 500));
        }
        if (msg.type === "result") {
          failed = msg.subtype !== "success";
          resultDetail = msg.result ?? msg.subtype ?? "";
          usage.input_tokens = msg.usage?.input_tokens ?? 0;
          usage.output_tokens = msg.usage?.output_tokens ?? 0;
        }
      }
      return {
        outcome: failed ? "failed" : "completed",
        detail: resultDetail,
        usage,
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
    } catch (error) {
      if (request.signal?.aborted) {
        return { outcome: "cancelled", detail: "cancelled by operator", usage };
      }
      return {
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
        usage,
      };
    }
  }
}
