// Claude Code runtime via the official Claude Agent SDK.
//
// EXECUTION E9 — this runtime is credential-free when a gateway is supplied.
// Previously it required a real Anthropic key in the process environment
// (NORN-027), which an ephemeral GitHub Actions job never has and, per the
// human's decision, must never be given. It points the Claude Code subprocess
// at the Norns provider-native gateway with a short-lived, per-run credential:
// the SDK speaks the ordinary Anthropic Messages API and is entirely unaware,
// while the relay authorizes, meters and budget-checks every call and the real
// key never leaves the server.
//
// WITHOUT a gateway it behaves exactly as before, so a laptop runner with its
// own key is unaffected.
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
//
// THE TWO ARE ORTHOGONAL, AND BOTH HOLD HERE.
//
// E9's property is about WHEN the credential exists relative to the subprocess;
// E11's is about WHAT the prompt is. `query()` is the call that spawns the
// subprocess, so the rule that matters is that nothing may sit between the mint
// and that call — and nothing does. The prompt is pushed into the queue after
// the mint purely so the ordering is visible on the page rather than implied:
// the queue is inert until `query()` consumes it, so it could sit either side,
// and putting it after removes any chance a later edit inserts awaitable work
// between minting and spawning. A mint failure still throws before any
// subprocess exists, and a run cancelled before it starts never mints at all.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { type GatewayCredentialProvider, gatewayEnvironment } from "../modelGateway.js";
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
    // EXECUTION E11 — VERIFIED AGAINST @anthropic-ai/claude-agent-sdk 0.3.207:
    // `Query` exposes `streamInput(stream)` and accepts
    // `prompt: AsyncIterable<SDKUserMessage>`, so a message pushed into the
    // input queue is picked up by the running session. This is the one runtime
    // we ship that can genuinely be answered mid-flight.
    send_message: true,
  };

  constructor(
    private readonly options: {
      model?: string;
      resumeSessionId?: string;
      /**
       * EXECUTION E9 — resolves the per-run gateway credential, lazily. Absent
       * means "use whatever credentials this process already has", which is
       * the laptop case.
       */
      gateway?: GatewayCredentialProvider;
      /** Injectable for tests. Defaults to `process.env`. */
      baseEnv?: NodeJS.ProcessEnv;
    } = {},
  ) {}

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
      // A run cancelled before it began must not mint a credential at all.
      if (request.signal?.aborted) {
        return { outcome: "cancelled", detail: "cancelled by operator", usage };
      }
      // EXECUTION E9 — minted here, immediately before the subprocess starts,
      // so a credential is never held for longer than the turn that uses it.
      // A mint failure fails the run rather than silently falling through to
      // whatever key might be lying around in the environment.
      const credential = this.options.gateway ? await this.options.gateway() : null;
      const env = credential
        ? gatewayEnvironment(this.options.baseEnv ?? process.env, {
            ANTHROPIC_BASE_URL: credential.anthropic_base_url,
            // The SDK sends this as `Authorization: Bearer <token>`, which is
            // exactly what the gateway reads. ANTHROPIC_API_KEY is deliberately
            // NOT set: `gatewayEnvironment` strips it, because a surviving real
            // key would take precedence and the run would bill money nobody is
            // metering.
            ANTHROPIC_AUTH_TOKEN: credential.token,
          })
        : null;
      // The first message IS the prompt that used to be passed as a string.
      input.push(request.prompt);
      const stream = query({
        prompt: input as AsyncIterable<never>,
        options: {
          cwd: request.worktreePath,
          abortController: controller,
          ...(env !== null ? { env } : {}),
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
