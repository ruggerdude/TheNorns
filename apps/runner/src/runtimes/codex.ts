import type { CodexReasoningEffortT } from "@norns/contracts";
// Codex runtime via the official @openai/codex-sdk (NORN-012 verified:
// run(input, {signal}) cancels the turn, resumeThread() resumes sessions,
// workingDirectory + sandboxMode are thread options).
//
// EXECUTION E9 — credential-free when a gateway is supplied. The SDK does not
// speak HTTP itself: it spawns the bundled `codex` binary with
// `--config openai_base_url=<baseUrl>` and `CODEX_API_KEY=<apiKey>` in the
// environment (verified in @openai/codex-sdk 0.144.3 dist/index.js,
// `CodexExec.run`). The binary then issues `POST <base_url>/responses`. So
// pointing Codex at Norns is exactly: pass the gateway's `/v1` base URL and
// the per-run credential, and let it speak the ordinary Responses API.
//
// Subscription mode deliberately omits the gateway SDK options and strips
// every provider environment override, leaving Codex to read only its official
// persisted ChatGPT login.
import { Codex, type CodexOptions } from "@openai/codex-sdk";
import {
  type GatewayCredentialProvider,
  type RuntimeCredentialMode,
  credentialFreeEnvironment,
} from "../modelGateway.js";
import { type LocalRuntimeAuthCapability, probeCodexSubscriptionAuth } from "../runtimeAuth.js";
import type { CodingRuntime, RuntimeRunRequest, RuntimeRunResult, RuntimeUsage } from "./types.js";

type CodexClient = Pick<Codex, "resumeThread" | "startThread">;
type CodexClientFactory = (options?: CodexOptions) => CodexClient;

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

  constructor(
    private readonly options: {
      model?: string;
      reasoningEffort?: CodexReasoningEffortT;
      resumeThreadId?: string;
      /**
       * `api` uses the Norns per-run gateway. `subscription` uses only the
       * official Codex login persisted on this machine.
       */
      credentialMode?: RuntimeCredentialMode;
      /** EXECUTION E9 — resolves the per-run gateway credential, lazily. */
      gateway?: GatewayCredentialProvider;
      /** Injectable for tests. Defaults to `process.env`. */
      baseEnv?: NodeJS.ProcessEnv;
      /** Injectable client seam for verifying SDK option propagation without spawning Codex. */
      createClient?: CodexClientFactory;
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
    try {
      const explicitCredentialMode = this.options.credentialMode;
      const credentialMode = explicitCredentialMode ?? "api";
      if (explicitCredentialMode === "api" && !this.options.gateway) {
        throw new Error("Codex API mode requires a Norns gateway");
      }
      if (credentialMode === "subscription") {
        const auth =
          this.options.subscriptionAuthProbe?.() ??
          probeCodexSubscriptionAuth(this.options.baseEnv ?? process.env);
        if (
          auth.runtime !== "codex" ||
          !auth.subscription_authenticated ||
          auth.subscription_auth_mode !== "chatgpt"
        ) {
          throw new Error("Codex ChatGPT subscription login is unavailable");
        }
      }
      // Subscription mode must never even call the mint provider. Besides
      // avoiding an unnecessary secret, that makes the billing route an
      // explicit invariant rather than a consequence of callback presence.
      const credential =
        credentialMode === "api" && this.options.gateway ? await this.options.gateway() : null;
      const createClient: CodexClientFactory =
        this.options.createClient ?? ((options) => new Codex(options));
      const runtimeEnv = credentialFreeEnvironment(this.options.baseEnv ?? process.env, {
        ...(request.humanWaitPath ? { NORNS_HUMAN_WAIT_PATH: request.humanWaitPath } : {}),
      });
      const codex = credential
        ? createClient({
            baseUrl: credential.openai_base_url,
            apiKey: credential.token,
            // `env` REPLACES the child environment in this SDK, so the real
            // provider keys are stripped rather than merely shadowed: a
            // surviving OPENAI_API_KEY would be spent outside every budget and
            // meter Norns has.
            env: runtimeEnv,
          })
        : createClient({ env: runtimeEnv });
      const threadOptions = {
        workingDirectory: request.worktreePath,
        skipGitRepoCheck: false,
        ...(this.options.model !== undefined ? { model: this.options.model } : {}),
        ...(this.options.reasoningEffort !== undefined
          ? { modelReasoningEffort: this.options.reasoningEffort }
          : {}),
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
