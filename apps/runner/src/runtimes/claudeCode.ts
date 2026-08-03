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
// Subscription mode deliberately omits the gateway settings and strips every
// provider environment override, leaving Claude Code to read only its official
// persisted Claude account login.
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
import {
  type GatewayCredentialProvider,
  type RuntimeCredentialMode,
  anthropicCompatibleGatewayBaseUrl,
  credentialFreeEnvironment,
} from "../modelGateway.js";
import { type LocalRuntimeAuthCapability, probeClaudeSubscriptionAuth } from "../runtimeAuth.js";
import type { CodingRuntime, RuntimeRunRequest, RuntimeRunResult, RuntimeUsage } from "./types.js";

/**
 * A quick edit normally needs only a handful of inspect/edit/verify/commit
 * turns. Keeping a firm ceiling prevents a missing permission or a repeated
 * tool failure from replaying the full briefing indefinitely. Quick work gets
 * enough room to finish the verify-and-commit tail observed after turn 12;
 * planned work retains a larger but still explicit ceiling.
 */
export const CLAUDE_CODE_QUICK_MAX_TURNS = 18;
export const CLAUDE_CODE_PLANNED_MAX_TURNS = 25;

/**
 * This runtime has no interactive permission channel: its prompt explicitly
 * tells the agent there is no human in the loop. Pre-approve only the local
 * coding tools it needs and make every other permission request fail closed.
 *
 * Bash remains necessary for repository-native verification and git commits.
 * The runner supplies an isolated worktree as cwd, a short-lived credential,
 * a wall-clock timeout, and a dollar ceiling around this process.
 */
export const CLAUDE_CODE_AUTONOMOUS_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash",
] as const;

function stopReasonFromError(detail: string): string | undefined {
  if (/error_max_turns|maximum (?:number of )?turns|max(?:imum)? turns/i.test(detail)) {
    return "error_max_turns";
  }
  if (/error_max_budget_usd|maximum (?:cost|budget)|max(?:imum)? budget/i.test(detail)) {
    return "error_max_budget_usd";
  }
  return undefined;
}

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
      /** Provider whose Anthropic-compatible gateway endpoint this run uses. */
      provider?: "anthropic" | "deepseek";
      resumeSessionId?: string;
      /**
       * `api` uses the Norns per-run gateway. `subscription` uses only the
       * official Claude login persisted on this machine.
       */
      credentialMode?: RuntimeCredentialMode;
      /**
       * EXECUTION E9 — resolves the per-run gateway credential lazily in API
       * mode. It is intentionally ignored in subscription mode.
       */
      gateway?: GatewayCredentialProvider;
      /** Injectable for tests. Defaults to `process.env`. */
      baseEnv?: NodeJS.ProcessEnv;
      /** Injectable SDK boundary for focused policy tests. */
      queryImpl?: typeof query;
      /** Injectable local-login probe for deterministic routing tests. */
      subscriptionAuthProbe?: () => LocalRuntimeAuthCapability;
    } = {},
  ) {}

  async run(request: RuntimeRunRequest): Promise<RuntimeRunResult> {
    const usage: RuntimeUsage = {
      input_tokens: 0,
      output_tokens: 0,
      usage_source: "runtime_report",
    };
    const input = new UserMessageQueue();
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = (): void => {
      input.close();
      controller.abort();
    };
    request.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timeout =
      request.timeoutMs !== undefined && request.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            input.close();
            controller.abort();
          }, request.timeoutMs)
        : null;
    timeout?.unref?.();
    let sessionId: string | undefined;
    let observedStopReason: string | undefined;
    try {
      // A run cancelled before it began must not mint a credential at all.
      if (request.signal?.aborted) {
        return { outcome: "cancelled", detail: "cancelled by operator", usage };
      }
      // EXECUTION E9 — minted here, immediately before the subprocess starts,
      // so a credential is never held for longer than the turn that uses it.
      // A mint failure fails the run rather than silently falling through to
      // whatever key might be lying around in the environment.
      const explicitCredentialMode = this.options.credentialMode;
      const credentialMode = explicitCredentialMode ?? "api";
      if (explicitCredentialMode === "api" && !this.options.gateway) {
        throw new Error("Claude Code API mode requires a Norns gateway");
      }
      if (credentialMode === "subscription") {
        if (this.options.provider === "deepseek") {
          throw new Error("DeepSeek does not support subscription execution");
        }
        const auth =
          this.options.subscriptionAuthProbe?.() ??
          probeClaudeSubscriptionAuth(this.options.baseEnv ?? process.env);
        if (
          auth.runtime !== "claude-code" ||
          !auth.subscription_authenticated ||
          auth.subscription_auth_mode !== "claude.ai" ||
          auth.subscription_type === null
        ) {
          throw new Error("Claude subscription login is unavailable");
        }
      }
      // Never call the mint provider for subscription execution. The child
      // receives no API key, OAuth-token override, or provider base URL, so
      // Claude Code must use its official persisted local login.
      const credential =
        credentialMode === "api" && this.options.gateway ? await this.options.gateway() : null;
      const env = credential
        ? credentialFreeEnvironment(this.options.baseEnv ?? process.env, {
            ANTHROPIC_BASE_URL: anthropicCompatibleGatewayBaseUrl(
              credential,
              this.options.provider ?? "anthropic",
            ),
            // The SDK sends this as `Authorization: Bearer <token>`, which is
            // exactly what the gateway reads. ANTHROPIC_API_KEY is deliberately
            // NOT set: `gatewayEnvironment` strips it, because a surviving real
            // key would take precedence and the run would bill money nobody is
            // metering.
            ANTHROPIC_AUTH_TOKEN: credential.token,
            ...(request.humanWaitPath ? { NORNS_HUMAN_WAIT_PATH: request.humanWaitPath } : {}),
          })
        : credentialFreeEnvironment(this.options.baseEnv ?? process.env, {
            ...(request.humanWaitPath ? { NORNS_HUMAN_WAIT_PATH: request.humanWaitPath } : {}),
          });
      // The first message IS the prompt that used to be passed as a string.
      input.push(request.prompt);
      const stream = (this.options.queryImpl ?? query)({
        prompt: input as AsyncIterable<never>,
        options: {
          cwd: request.worktreePath,
          abortController: controller,
          maxTurns:
            request.executionMode === "quick"
              ? CLAUDE_CODE_QUICK_MAX_TURNS
              : CLAUDE_CODE_PLANNED_MAX_TURNS,
          ...(request.maxBudgetUsd !== undefined && request.maxBudgetUsd > 0
            ? { maxBudgetUsd: request.maxBudgetUsd }
            : {}),
          // `default` asks a person to approve edits and shell commands, but
          // this headless runtime has no permission-prompt transport. The live
          // consequence was 25 paid retries in which every write was denied.
          // `dontAsk` plus an explicit allowlist is narrower than globally
          // bypassing permission checks: these six tools run unattended and
          // every other tool request is denied.
          permissionMode: "dontAsk",
          tools: [...CLAUDE_CODE_AUTONOMOUS_TOOLS],
          allowedTools: [...CLAUDE_CODE_AUTONOMOUS_TOOLS],
          env,
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
      let resultDetail = "";
      let stopReason: string | undefined;
      let failed = false;
      for await (const message of stream) {
        const msg = message as {
          type: string;
          session_id?: string;
          subtype?: string;
          result?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
          stop_reason?: string | null;
          errors?: string[];
          permission_denials?: Array<{ tool_name?: string }>;
          tool_name?: string;
        };
        if (msg.session_id) sessionId = msg.session_id;
        if (msg.type === "system" && msg.subtype === "permission_denied" && msg.tool_name) {
          observedStopReason = `permission_denied:${msg.tool_name}`;
        }
        if (msg.type === "assistant" || msg.type === "system") {
          request.onLog?.(JSON.stringify(message).slice(0, 500));
        }
        if (msg.type === "result") {
          failed = msg.subtype !== "success";
          const deniedTools = [
            ...new Set(
              (msg.permission_denials ?? [])
                .map((denial) => denial.tool_name?.trim())
                .filter((tool): tool is string => Boolean(tool)),
            ),
          ];
          const details = [
            msg.result?.trim(),
            ...(msg.errors ?? []).map((error) => error.trim()).filter(Boolean),
            deniedTools.length > 0
              ? `SDK permission denied for ${deniedTools.join(", ")}`
              : undefined,
          ].filter((detail): detail is string => Boolean(detail));
          resultDetail = details.join("; ") || msg.subtype || "runtime stopped";
          stopReason =
            deniedTools.length > 0
              ? `permission_denied:${deniedTools.join(",")}`
              : (msg.stop_reason ?? msg.subtype ?? undefined);
          observedStopReason = stopReason;
          usage.input_tokens = msg.usage?.input_tokens ?? 0;
          usage.output_tokens = msg.usage?.output_tokens ?? 0;
          // The run is one turn. Closing the input here ends the session
          // deterministically rather than idling on an Actions clock that
          // bills wall time; a message that arrives after this is answered
          // with "the run has already ended", which is the truth.
          input.close();
        }
      }
      if (timedOut) {
        return {
          outcome: "failed",
          detail: `Claude Code execution timed out after ${request.timeoutMs}ms`,
          usage,
          ...(sessionId !== undefined ? { sessionId } : {}),
          stopReason: "timeout",
        };
      }
      if (request.signal?.aborted) {
        return {
          outcome: "cancelled",
          detail: "cancelled by operator",
          usage,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(observedStopReason !== undefined ? { stopReason: observedStopReason } : {}),
        };
      }
      return {
        outcome: failed ? "failed" : "completed",
        detail: resultDetail,
        usage,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(stopReason !== undefined ? { stopReason } : {}),
      };
    } catch (error) {
      if (timedOut) {
        return {
          outcome: "failed",
          detail: `Claude Code execution timed out after ${request.timeoutMs}ms`,
          usage,
          ...(sessionId !== undefined ? { sessionId } : {}),
          stopReason: "timeout",
        };
      }
      if (request.signal?.aborted) {
        return {
          outcome: "cancelled",
          detail: "cancelled by operator",
          usage,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(observedStopReason !== undefined ? { stopReason: observedStopReason } : {}),
        };
      }
      const detail = error instanceof Error ? error.message : String(error);
      const stopReason = observedStopReason ?? stopReasonFromError(detail);
      return {
        outcome: "failed",
        detail,
        usage,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(stopReason !== undefined ? { stopReason } : {}),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onExternalAbort);
      input.close();
    }
  }
}
