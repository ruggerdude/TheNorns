// Claude Code runtime via the official Claude Agent SDK. Requires Anthropic
// credentials at run time (NORN-027); construction and the capability matrix
// are credential-free so scheduling can reason about it.
//
// EXECUTION E11 — STREAMING INPUT MODE, ON PURPOSE.
//
// The prompt used to be a plain string. That is the SDK's single-shot mode, and
// its documented consequence is that the `Query` control requests — including
// `interrupt()` — are "only supported when streaming input/output is used". So
// the runtime declared `interrupt: true` while running in the one mode where
// interrupt cannot work, and there was no channel by which a human's answer
// could ever reach the session. Handing `query()` an `AsyncIterable` instead
// costs nothing on the happy path (the first message yielded is exactly the
// prompt that used to be passed as a string) and is what makes both `interrupt`
// and `send_message` real rather than advertised.
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CodingRuntime, RuntimeRunRequest, RuntimeRunResult, RuntimeUsage } from "./types.js";

type StreamedUserMessage = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: string | null;
};

/**
 * The session's input queue: an async iterable a human can push into while the
 * agent is working. Closing it is what ends the session — the SDK's streaming
 * mode keeps the turn loop alive until its input runs out.
 */
class UserMessageQueue {
  private readonly pending: StreamedUserMessage[] = [];
  private waiting: ((value: IteratorResult<StreamedUserMessage>) => void) | null = null;
  private closed = false;

  push(text: string): void {
    if (this.closed) throw new Error("the run's session is no longer accepting input");
    const message: StreamedUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting({ value: message, done: false });
      return;
    }
    this.pending.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting({ value: undefined as never, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamedUserMessage, void> {
    for (;;) {
      const next = this.pending.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const value = await new Promise<IteratorResult<StreamedUserMessage>>((resolve) => {
        this.waiting = resolve;
      });
      if (value.done) return;
      yield value.value;
    }
  }
}

export class ClaudeCodeRuntime implements CodingRuntime {
  readonly name = "claude-code";
  readonly capabilities = {
    interrupt: true, // query.interrupt() — real now that input is streamed
    suspend: false,
    resume_session: true, // options.resume with a session id
    cancel: true, // AbortController
    stop_after_current: false,
    // VERIFIED AGAINST @anthropic-ai/claude-agent-sdk 0.3.207: `Query` exposes
    // `streamInput(stream)` and accepts `prompt: AsyncIterable<SDKUserMessage>`,
    // so a message pushed into the input queue is picked up by the running
    // session. This is the one runtime we ship that can genuinely be answered
    // mid-flight.
    send_message: true,
  };

  constructor(private readonly options: { model?: string; resumeSessionId?: string } = {}) {}

  async run(request: RuntimeRunRequest): Promise<RuntimeRunResult> {
    const usage: RuntimeUsage = {
      input_tokens: 0,
      output_tokens: 0,
      usage_source: "runtime_report",
    };
    const input = new UserMessageQueue();
    try {
      const controller = new AbortController();
      request.signal?.addEventListener("abort", () => {
        // Close the input first: an aborted transport leaves the queue's
        // consumer parked on a promise that would otherwise never settle.
        input.close();
        controller.abort();
      });
      if (request.signal?.aborted) {
        return { outcome: "cancelled", detail: "cancelled by operator", usage };
      }
      input.push(request.prompt);
      const stream = query({
        prompt: input as AsyncIterable<never>,
        options: {
          cwd: request.worktreePath,
          abortController: controller,
          ...(this.options.model !== undefined ? { model: this.options.model } : {}),
          ...(this.options.resumeSessionId !== undefined
            ? { resume: this.options.resumeSessionId }
            : {}),
        },
      });
      request.onSession?.({
        sendMessage: async (message: string) => {
          if (input.isClosed) throw new Error("the run's session has already ended");
          input.push(message);
        },
        interrupt: async () => {
          await stream.interrupt();
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
          // The run is one turn. Closing the input here ends the session
          // deterministically rather than idling on an Actions clock that
          // bills wall time; a message that arrives after this is answered
          // with "the run has already ended", which is the truth.
          input.close();
        }
      }
      if (request.signal?.aborted) {
        return { outcome: "cancelled", detail: "cancelled by operator", usage };
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
    } finally {
      input.close();
    }
  }
}
