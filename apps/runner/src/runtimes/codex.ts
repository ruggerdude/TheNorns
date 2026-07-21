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
// WITHOUT a gateway it behaves exactly as before (NORN-027), so a laptop
// runner with its own key is unaffected.
import { Codex } from "@openai/codex-sdk";
import { type GatewayCredentialProvider, gatewayEnvironment } from "../modelGateway.js";
import type { CodingRuntime, RuntimeRunRequest, RuntimeRunResult, RuntimeUsage } from "./types.js";

export class CodexRuntime implements CodingRuntime {
  readonly name = "codex";
  readonly capabilities = {
    interrupt: true, // AbortSignal stops the current turn
    suspend: false,
    resume_session: true, // codex.resumeThread(threadId)
    cancel: true,
    stop_after_current: false,
  };

  constructor(
    private readonly options: {
      model?: string;
      resumeThreadId?: string;
      /** EXECUTION E9 — resolves the per-run gateway credential, lazily. */
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
      // EXECUTION E9 — minted immediately before the turn, never held.
      const credential = this.options.gateway ? await this.options.gateway() : null;
      const codex = credential
        ? new Codex({
            baseUrl: credential.openai_base_url,
            apiKey: credential.token,
            // `env` REPLACES the child environment in this SDK, so the real
            // provider keys are stripped rather than merely shadowed: a
            // surviving OPENAI_API_KEY would be spent outside every budget and
            // meter Norns has.
            env: gatewayEnvironment(this.options.baseEnv ?? process.env, {}),
          })
        : new Codex();
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
