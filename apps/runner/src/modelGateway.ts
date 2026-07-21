// EXECUTION E9 (runner half) — obtaining, and holding, the gateway credential.
//
// WHAT CHANGED FOR THE RUNNER. Before this, `claude-code` and `codex` were
// registered as runtimes but could only work on a machine that already had an
// Anthropic or OpenAI key in its environment — which an ephemeral GitHub
// Actions job never does and, per the human's decision, never will. The
// runner's only credential-free runtime was `proxied-completion`, which cannot
// read a file and therefore cannot write code.
//
// WHAT IT DOES NOW. Immediately before running an agentic runtime, the runner
// asks the relay for a short-lived credential scoped to the run it was
// dispatched, using the Ed25519 identity it already holds. It hands that
// credential and the gateway's base URL to the runtime as ordinary environment
// configuration. The runtime speaks its native provider API, unchanged and
// unaware; the relay authorizes, meters, and budget-checks every call.
//
// THE CREDENTIAL NEVER TOUCHES DISK AND NEVER ENTERS THE REPOSITORY. It is
// minted in memory, passed to a child process's environment, and forgotten.
// It is not a workflow input, not a repository secret, and not written to the
// worktree — which is what makes this different from the "just use repo
// secrets" option the human rejected.
import type { RunnerContextIdentity } from "./contextAuth.js";
import {
  RUNNER_AUTHORIZATION_SCHEME,
  RUNNER_ID_HEADER,
  RUNNER_TIMESTAMP_HEADER,
  runnerContextFetchPayload,
} from "./contextAuth.js";

/** Must match the server's `GATEWAY_CREDENTIAL_ROUTE`. */
export const GATEWAY_CREDENTIAL_PATH = "/api/execution/gateway/credentials";

export interface GatewayCredential {
  token: string;
  expires_at: string;
  /** Give this to Claude Code as ANTHROPIC_BASE_URL. */
  anthropic_base_url: string;
  /** Give this to Codex as its `baseUrl`. Already ends in `/v1`. */
  openai_base_url: string;
}

export class GatewayCredentialError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayCredentialError";
  }
}

/**
 * Mints per-run gateway credentials over the runner's existing identity.
 *
 * Signing reuses `runnerContextFetchPayload` — the SAME canonical form and the
 * SAME domain separator as the context fetch. That is deliberate: one signing
 * scheme to keep correct is better than two, and the server verifies both with
 * one function. (It is also why the mismatch documented in contextAuth.ts had
 * to be fixed before this could work at all.)
 */
export class ModelGatewayClient {
  constructor(
    private readonly serverOrigin: string,
    private readonly identity: RunnerContextIdentity,
    private readonly now: () => Date = () => new Date(),
    private readonly httpFetch: typeof fetch = fetch,
  ) {}

  async mint(runId: string): Promise<GatewayCredential> {
    const url = new URL(GATEWAY_CREDENTIAL_PATH, this.serverOrigin);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      // A credential must never be requested — or delivered — in the clear.
      throw new GatewayCredentialError(0, "gateway credentials require an HTTPS relay");
    }
    const issuedAt = this.now().toISOString();
    const signature = this.identity.sign(
      runnerContextFetchPayload({
        method: "POST",
        path: url.pathname,
        runnerId: this.identity.runnerId,
        issuedAt,
      }),
    );
    const response = await this.httpFetch(url, {
      method: "POST",
      // A signature is bound to one path, so following a redirect would forward
      // a credential request to a location the runner never authorized.
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `${RUNNER_AUTHORIZATION_SCHEME} ${signature}`,
        [RUNNER_ID_HEADER]: this.identity.runnerId,
        [RUNNER_TIMESTAMP_HEADER]: issuedAt,
      },
      body: JSON.stringify({ run_id: runId }),
    });
    if (!response.ok) {
      // The status is the useful part and is safe to surface; the body may
      // carry server detail this process has no business logging.
      throw new GatewayCredentialError(
        response.status,
        `gateway credential request failed with ${response.status}`,
      );
    }
    const body = (await response.json()) as Partial<GatewayCredential>;
    if (
      typeof body.token !== "string" ||
      typeof body.expires_at !== "string" ||
      typeof body.anthropic_base_url !== "string" ||
      typeof body.openai_base_url !== "string"
    ) {
      throw new GatewayCredentialError(
        response.status,
        "gateway credential response was malformed",
      );
    }
    return {
      token: body.token,
      expires_at: body.expires_at,
      anthropic_base_url: body.anthropic_base_url,
      openai_base_url: body.openai_base_url,
    };
  }
}

/**
 * How a runtime is pointed at the gateway.
 *
 * Resolved lazily, per run, rather than at construction: a runtime object may
 * be built long before it executes, and a credential minted then would be a
 * credential sitting in memory for no reason and possibly expired by use.
 */
export type GatewayCredentialProvider = () => Promise<GatewayCredential>;

/**
 * Provider keys that must be REMOVED from a runtime's environment.
 *
 * Not hygiene — correctness. If `ANTHROPIC_API_KEY` survives into Claude
 * Code's environment it takes precedence over `ANTHROPIC_AUTH_TOKEN` in some
 * configurations, and the run would silently bill a key Norns is not metering,
 * against no budget, defeating the entire subsystem. The failure would look
 * like success, which is the worst kind.
 */
export const PROVIDER_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
] as const;

/**
 * A copy of `process.env` with every provider credential stripped, then the
 * gateway's own settings applied. Built explicitly rather than by mutation so
 * the runner's own environment is never altered.
 */
export function gatewayEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if ((PROVIDER_KEY_ENV_VARS as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}
