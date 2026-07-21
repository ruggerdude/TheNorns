// Claude Code runtime via the official Claude Agent SDK.
//
// EXECUTION E9 — this runtime is now credential-free when a gateway is
// supplied. Previously it required a real Anthropic key in the process
// environment (NORN-027), which an ephemeral GitHub Actions job never has and,
// per the human's decision, must never be given. It now points the Claude Code
// subprocess at the Norns provider-native gateway with a short-lived, per-run
// credential: the SDK speaks the ordinary Anthropic Messages API and is
// entirely unaware, while the relay authorizes, meters and budget-checks every
// call and the real key never leaves the server.
//
// WITHOUT a gateway it behaves exactly as before, so a laptop runner with its
// own key is unaffected.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { type GatewayCredentialProvider, gatewayEnvironment } from "../modelGateway.js";
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
    try {
      const controller = new AbortController();
      request.signal?.addEventListener("abort", () => controller.abort());
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
      const stream = query({
        prompt: request.prompt,
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
