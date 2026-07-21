// Codex runtime via the official @openai/codex-sdk (NORN-012 verified:
// run(input, {signal}) cancels the turn, resumeThread() resumes sessions,
// workingDirectory + sandboxMode are thread options). Requires OpenAI
// credentials at run time (NORN-027).
import { Codex } from "@openai/codex-sdk";
import type { CodingRuntime, RuntimeRunRequest, RuntimeRunResult, RuntimeUsage } from "./types.js";

export class CodexRuntime implements CodingRuntime {
  readonly name = "codex";
  readonly capabilities = {
    interrupt: true, // AbortSignal stops the current turn
    suspend: false,
    resume_session: true, // codex.resumeThread(threadId)
    cancel: true,
    stop_after_current: false,
    // EXECUTION E11 — VERIFIED AGAINST @openai/codex-sdk 0.144.3, NOT ASSUMED.
    // `Thread` exposes exactly `run(input, {signal})` and
    // `runStreamed(input, {signal})`; there is no method that injects input
    // into a turn already in flight, and `TurnOptions` carries only
    // `outputSchema` and `signal`. Multi-turn means CONSECUTIVE turns: the next
    // turn can carry a human's answer, but the running one cannot receive it.
    // Declaring `true` here would put a control in the UI that does nothing.
    send_message: false,
  };

  constructor(private readonly options: { model?: string; resumeThreadId?: string } = {}) {}

  async run(request: RuntimeRunRequest): Promise<RuntimeRunResult> {
    const usage: RuntimeUsage = {
      input_tokens: 0,
      output_tokens: 0,
      usage_source: "runtime_report",
    };
    try {
      const codex = new Codex();
      const threadOptions = {
        workingDirectory: request.worktreePath,
        skipGitRepoCheck: false,
        ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      };
      const thread = this.options.resumeThreadId
        ? codex.resumeThread(this.options.resumeThreadId, threadOptions)
        : codex.startThread(threadOptions);
      const turn = await thread.run(request.prompt, {
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
      request.onLog?.(turn.finalResponse.slice(0, 2000));
      const threadId = (thread as { id?: string | null }).id;
      return {
        outcome: "completed",
        detail: turn.finalResponse.slice(0, 2000),
        usage,
        ...(threadId ? { sessionId: threadId } : {}),
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
