// EXECUTION E9 — the provider-native streaming gateway. A FORWARDER.
//
// WHY THIS EXISTS. E3 built a metered completion proxy and proved a hard
// constraint with it: the agentic runtimes cannot use it. Claude Code honours
// `ANTHROPIC_BASE_URL` and then speaks the Anthropic Messages API — streaming
// SSE, tool_use blocks, many turns. Codex honours a base URL and speaks the
// OpenAI Responses API, also streaming. E3's proxy exposes exactly one
// complete-result call, so an agent using it cannot read a second file. It
// cannot write code. The human's decision was this: a provider-native gateway,
// with the keys never leaving the server and spend still metered.
//
// THE CORRECTNESS BAR IS FAITHFUL PASS-THROUGH, NOT UNDERSTANDING.
// This module does not implement the Anthropic or OpenAI APIs and must never
// start to. It:
//   * authenticates the caller against a per-run credential,
//   * strips whatever key the caller sent and injects the real provider key,
//   * forwards the request body BYTE FOR BYTE,
//   * streams the response bytes back BYTE FOR BYTE,
//   * reads token counts out of a copy of that stream, for metering.
// Unknown fields, parameters invented next month, tool definitions, beta
// headers, and model behaviours nobody here has heard of all work — precisely
// because nothing is re-serialized. Every time someone is tempted to "handle"
// a field here, that is the bug.
//
// WHAT IT REFUSES TO FORWARD, AND WHY THAT IS NOT A CONTRADICTION.
// Four things: an unresolvable credential, a run that may not spend, a model
// outside the deployment allowlist, and a run whose budget cannot cover the
// call. Those are not API semantics — they are the reasons the human agreed to
// let a CI job touch a provider key at all. A refusal is never a rewrite: the
// request is dropped whole, and the caller is told so in a form it can act on.
//
// ORDER MATTERS, AND IT IS E3'S ORDER: credential, then ownership, then
// liveness, then model, then budget, and only then the provider. The budget
// hold is taken BEFORE the request goes out and resolved after the stream
// ends, so two concurrent streams cannot each observe the same "remaining".
import {
  DEFAULT_MODEL_REGISTRY,
  type ModelEntry,
  type ProviderName,
  conservativeMaxChargeUsd,
  snapshotModelPricing,
} from "@norns/adapters";
import type { UsageEventT } from "@norns/contracts";
import { newId } from "../ids.js";
import {
  type InferenceBudget,
  type InferenceBudgetHold,
  type InferenceMeter,
  type ProxiedRunFacts,
  type ProxiedRunLookup,
  authorizeProxiedRunAccess,
} from "../runners/inferenceProxy.js";
import type { GatewayCredentialService } from "./credentials.js";
import { inspectGatewayRequest } from "./request.js";
import {
  type GatewayProvider,
  GatewayUsageTap,
  billableInputTokens,
  isEventStream,
} from "./usage.js";

// ---------------------------------------------------------------------------
// Upstream surfaces
// ---------------------------------------------------------------------------

/**
 * The upstream each surface forwards to, and the exact paths it will forward.
 *
 * THE PATH ALLOWLIST IS NOT ABOUT API SEMANTICS. It exists because the
 * injected provider key would otherwise reach any endpoint a caller cared to
 * name — including a provider's key-management, batch, or file-storage
 * surfaces, none of which are metered here and some of which outlive the run.
 * The list is the set of routes the two runtimes actually call, verified
 * against the installed clients (see `SURFACES` below), not guessed.
 */
export interface GatewaySurface {
  provider: GatewayProvider;
  origin: string;
  /** Paths, relative to the origin, that may be forwarded. Exact match. */
  paths: ReadonlySet<string>;
  /** Paths that cost money and therefore require the whole budget dance. */
  meteredPaths: ReadonlySet<string>;
  /** Turn our credential into the header shape this provider expects. */
  authHeaders(apiKey: string): Record<string, string>;
}

export const ANTHROPIC_SURFACE: GatewaySurface = {
  provider: "anthropic",
  origin: "https://api.anthropic.com",
  // VERIFIED against @anthropic-ai/claude-agent-sdk 0.3.207 / the Claude Code
  // CLI it ships: with ANTHROPIC_BASE_URL set, the CLI issues POST /v1/messages
  // (streaming and non-streaming), POST /v1/messages/count_tokens for context
  // accounting, and GET /v1/models when resolving a model alias.
  paths: new Set(["/v1/messages", "/v1/messages/count_tokens", "/v1/models"]),
  meteredPaths: new Set(["/v1/messages"]),
  // x-api-key is Anthropic's own scheme. We send the key that way and NOT as a
  // bearer token, so a misconfiguration cannot accidentally make the provider
  // key look like a Norns gateway credential to anything downstream.
  authHeaders: (apiKey) => ({ "x-api-key": apiKey }),
};

export const OPENAI_SURFACE: GatewaySurface = {
  provider: "openai",
  origin: "https://api.openai.com",
  // VERIFIED against @openai/codex-sdk 0.144.3: the SDK does not speak HTTP
  // itself. It spawns the bundled `codex` binary with
  // `--config openai_base_url=<baseUrl>` and `CODEX_API_KEY=<apiKey>` in the
  // environment (dist/index.js, CodexExec.run). The binary's own help text
  // reads "Set base_url to the provider API root, for example
  // https://api.openai.com/v1", and it issues POST <base_url>/responses. So
  // Codex's base URL must end in the `/v1` segment and the route it hits is
  // `/v1/responses`.
  paths: new Set(["/v1/responses", "/v1/models"]),
  meteredPaths: new Set(["/v1/responses"]),
  authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
};

export const SURFACES: Readonly<Record<GatewayProvider, GatewaySurface>> = {
  anthropic: ANTHROPIC_SURFACE,
  openai: OPENAI_SURFACE,
};

// ---------------------------------------------------------------------------
// Header handling
// ---------------------------------------------------------------------------

/**
 * Headers never forwarded upstream.
 *
 * A DENY list, not an allow list, and that asymmetry is the whole point of a
 * forwarder: `anthropic-beta`, `openai-beta`, `x-stainless-*`, and whatever
 * header a client ships next quarter all reach the provider untouched. Only
 * these are dropped, each for a specific reason:
 *   authorization / x-api-key  — the CALLER's credential. Replaced with ours.
 *                                A client-supplied model key is never honoured.
 *   host                       — must name the upstream, not us.
 *   content-length             — recomputed by the HTTP client.
 *   accept-encoding            — `fetch` decompresses transparently, so asking
 *                                for an encoding we then strip would corrupt.
 *   connection / transfer-encoding / upgrade / keep-alive / te / trailer /
 *   proxy-authorization / proxy-authenticate  — hop-by-hop (RFC 9110 §7.6.1).
 *   cookie                     — no provider uses one, and forwarding session
 *                                state from a CI job is pure downside.
 */
const REQUEST_HEADER_DENY = new Set([
  "authorization",
  "x-api-key",
  "host",
  "content-length",
  "accept-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
  "cookie2",
]);

/**
 * Response headers never sent back.
 *
 * `content-encoding` and `content-length` are dropped because `fetch` has
 * already decompressed the body: echoing the upstream's encoding header over
 * decompressed bytes is a guaranteed client-side parse failure, and it is the
 * classic way a "verbatim" proxy silently corrupts streams.
 */
const RESPONSE_HEADER_DENY = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "trailer",
  "te",
  "set-cookie",
  "set-cookie2",
]);

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Pull the Norns gateway credential out of whichever header the runtime used.
 *
 * Claude Code with `ANTHROPIC_AUTH_TOKEN` sends `Authorization: Bearer …`;
 * the Anthropic SDK with an api key sends `x-api-key`; Codex sends
 * `Authorization: Bearer …`. All three are accepted, because which one arrives
 * is the SDK's choice and not ours to dictate.
 */
export function extractGatewayCredential(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const authorization = firstHeader(headers, "authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  const apiKey = firstHeader(headers, "x-api-key");
  return apiKey ? apiKey.trim() : null;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type GatewayRefusalCode =
  | "unauthorized"
  | "run_not_active"
  | "invalid_request"
  | "model_unavailable"
  | "budget_exhausted"
  | "gateway_unavailable"
  | "upstream_unreachable";

/**
 * The header that makes a gateway refusal unmistakable.
 *
 * Failure honesty was an explicit requirement: an agent must be able to tell
 * "Norns refused this" from "the provider refused this". A body shape can be
 * argued with; a header we alone set cannot. Provider responses are forwarded
 * verbatim and therefore never carry it.
 */
export const GATEWAY_REFUSAL_HEADER = "x-norns-gateway-refusal";

const REFUSAL_STATUS: Readonly<Record<GatewayRefusalCode, number>> = {
  // 401 — the credential did not resolve, names another run, expired, or was
  // revoked. Deliberately indistinguishable between those cases on the wire.
  unauthorized: 401,
  // 403 — the credential is fine; the run may no longer spend.
  run_not_active: 403,
  invalid_request: 400,
  model_unavailable: 403,
  // 402 Payment Required is exact, and no SDK retries it — which is what we
  // want. A retried budget refusal is a hot loop against a wall.
  budget_exhausted: 402,
  // 503 — this deployment holds no key for the provider. A configuration
  // state, not a fault, and never a hint about which keys we do hold.
  gateway_unavailable: 503,
  upstream_unreachable: 502,
};

/**
 * Refusal body, shaped like the surface it was posted to so the caller's own
 * SDK surfaces the message rather than throwing a parse error, but with a
 * `norns_gateway_error` type that no provider will ever emit.
 */
export function refusalBody(
  provider: GatewayProvider,
  code: GatewayRefusalCode,
  message: string,
): string {
  if (provider === "anthropic") {
    return JSON.stringify({
      type: "error",
      error: { type: "norns_gateway_error", code, message },
    });
  }
  return JSON.stringify({
    error: { type: "norns_gateway_error", code, message, param: null },
  });
}

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

/** Resolves the provider key. Returns null when this deployment holds none. */
export type GatewayKeyResolver = (provider: GatewayProvider) => string | null;

export interface ProviderGatewayOptions {
  runs: ProxiedRunLookup;
  credentials: GatewayCredentialService;
  /** Same resolver the completion proxy uses; returns the raw provider key. */
  apiKey: GatewayKeyResolver;
  budget?: InferenceBudget | undefined;
  meter?: InferenceMeter | undefined;
  /** `provider/model` pairs runners may spend on. Empty means NONE. */
  allowedModels?: Iterable<string> | undefined;
  registry?: Record<string, ModelEntry> | undefined;
  audit?: ((actor: string, action: string, detail: string) => void) | undefined;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
  /** Surfaces, injectable so a test can point them at a local upstream. */
  surfaces?: Readonly<Record<GatewayProvider, GatewaySurface>> | undefined;
}

export interface GatewayForwardInput {
  provider: GatewayProvider;
  /** Upstream path, e.g. `/v1/messages`. Matched against the allowlist. */
  path: string;
  /**
   * The raw query string INCLUDING its leading `?`, or empty.
   *
   * VERIFIED, NOT ASSUMED: the Claude Code CLI issues
   * `POST <base>/v1/messages?beta=true`. A forwarder that dropped the query
   * would be silently changing the request — the exact class of bug this phase
   * exists to avoid — so it is carried separately from `path` (which is what
   * the allowlist matches) and re-appended verbatim on the way out.
   */
  query: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
  /** Aborted when the downstream client goes away. */
  signal?: AbortSignal | undefined;
}

export type GatewayResult =
  | {
      kind: "refused";
      status: number;
      code: GatewayRefusalCode;
      /** Ready-to-send JSON body. Never contains provider or key detail. */
      body: string;
      contentType: string;
    }
  | {
      kind: "forwarded";
      status: number;
      headers: Record<string, string>;
      /**
       * The upstream bytes, unmodified. Iterating drives both the response and
       * the metering tap; the iterator's `finally` settles the budget hold,
       * so an abandoned iteration still meters. The caller MUST iterate it to
       * completion or abandon it (`break`/`return`) — never drop it silently.
       */
      body: AsyncIterable<Uint8Array>;
    };

export class ProviderGateway {
  private readonly registry: Record<string, ModelEntry>;
  private readonly allowed: ReadonlySet<string>;
  private readonly surfaces: Readonly<Record<GatewayProvider, GatewaySurface>>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: ProviderGatewayOptions) {
    this.registry = options.registry ?? DEFAULT_MODEL_REGISTRY;
    this.allowed = new Set(options.allowedModels ?? []);
    this.surfaces = options.surfaces ?? SURFACES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private refuse(
    provider: GatewayProvider,
    code: GatewayRefusalCode,
    message: string,
    actor: string,
    detail: string,
  ): GatewayResult {
    this.options.audit?.(actor, "gateway.refused", `${code} ${detail}`);
    return {
      kind: "refused",
      status: REFUSAL_STATUS[code],
      code,
      body: refusalBody(provider, code, message),
      contentType: "application/json",
    };
  }

  async forward(input: GatewayForwardInput): Promise<GatewayResult> {
    const surface = this.surfaces[input.provider];
    const provider = input.provider;

    // 0. PATH. Checked before anything else so an unlisted path never even
    //    causes a database read, and so the injected key can only ever reach
    //    a route this file names.
    if (!surface.paths.has(input.path)) {
      return this.refuse(
        provider,
        "invalid_request",
        "this gateway does not forward that path",
        "gateway:anonymous",
        `path=${input.path}`,
      );
    }

    // 1. CREDENTIAL. Every failure mode — malformed, unknown, expired, revoked
    //    — returns the identical 401. A compromised job must not be able to
    //    tell "no such token" from "that token expired".
    const presented = extractGatewayCredential(input.headers);
    const resolution = await this.options.credentials.resolve(presented);
    if (!resolution.ok) {
      return this.refuse(
        provider,
        "unauthorized",
        "gateway credential is not valid",
        "gateway:anonymous",
        `credential=${resolution.reason}`,
      );
    }
    const credential = resolution.credential;
    const actor = `runner:${credential.runner_id}`;

    // 2. OWNERSHIP AND LIVENESS. Re-resolved from this server's own records on
    //    EVERY request, through E3's lookup and E3's decision function. The
    //    credential names a run; it never grants one. So a run that finished,
    //    was cancelled, was superseded, or whose runner was revoked stops
    //    working immediately — no cache, nothing to remember to invalidate.
    let run: ProxiedRunFacts | null;
    try {
      run = await this.options.runs.lookup(credential.run_id);
    } catch {
      return this.refuse(
        provider,
        "gateway_unavailable",
        "the run could not be verified",
        actor,
        `run=${credential.run_id} lookup_failed`,
      );
    }
    const access = authorizeProxiedRunAccess(
      run,
      credential.run_id,
      credential.runner_id,
      credential.runner_generation,
    );
    if (access === "unauthorized" || !run) {
      return this.refuse(
        provider,
        "unauthorized",
        "gateway credential is not valid",
        actor,
        `run=${credential.run_id} not_authorized`,
      );
    }
    if (access === "run_not_active") {
      return this.refuse(
        provider,
        "run_not_active",
        "this run is not in a state that may spend",
        actor,
        `run=${run.run_id}`,
      );
    }

    // An unmetered path (a model list, a token count) is authorized exactly
    // like a metered one but skips pricing and budget entirely: it costs
    // nothing, so holding money against it would only refuse work spuriously.
    if (!surface.meteredPaths.has(input.path)) {
      return this.send(surface, input, run, null, null, actor);
    }

    // 3. INSPECT. Read-only; see request.ts. An uninspectable body cannot be
    //    priced, and an unpriceable call is what the human decided must never
    //    reach a provider.
    const inspection = inspectGatewayRequest(provider, input.body);
    if (!inspection.ok) {
      return this.refuse(
        provider,
        "invalid_request",
        inspection.reason === "missing_model"
          ? "request does not name a model"
          : "request body is not JSON the gateway can price",
        actor,
        `run=${run.run_id} ${inspection.reason}`,
      );
    }
    const { model, maxOutputTokens, estimatedInputTokens } = inspection.request;

    // 4. MODEL. Same rule as E3: allowlisted for runners, present in the
    //    registry at the provider claimed, and priced. An API key must never
    //    make every model in the registry reachable from a CI job.
    const selection = `${provider}/${model}`;
    const entry = this.registry[model];
    if (!this.allowed.has(selection) || !entry || entry.provider !== provider) {
      return this.refuse(
        provider,
        "model_unavailable",
        "that model is not available through this gateway",
        actor,
        `run=${run.run_id} model=${selection}`,
      );
    }
    let maxChargeUsd: number;
    try {
      maxChargeUsd = conservativeMaxChargeUsd(
        snapshotModelPricing(provider as ProviderName, model, this.registry),
        { max_input_tokens: estimatedInputTokens, max_output_tokens: maxOutputTokens },
      );
    } catch {
      return this.refuse(
        provider,
        "model_unavailable",
        "that model has no usable pricing",
        actor,
        `run=${run.run_id} model=${selection} unpriced`,
      );
    }

    // 5. THE PROVIDER KEY. Resolved here and used once, below. It is never
    //    logged, never audited, never placed in a refusal body, and never
    //    returned to a caller on any path in this file.
    const apiKey = this.options.apiKey(provider);
    if (!apiKey) {
      return this.refuse(
        provider,
        "gateway_unavailable",
        "this deployment cannot serve that provider",
        actor,
        `run=${run.run_id} provider=${provider} unconfigured`,
      );
    }

    // 6. BUDGET, BEFORE THE PROVIDER. An absent budget refuses everything:
    //    there is deliberately no unmetered mode, exactly as in E3.
    const budget = this.options.budget;
    if (!budget) {
      return this.refuse(
        provider,
        "budget_exhausted",
        "no budget enforcement is configured",
        actor,
        `run=${run.run_id} no_budget`,
      );
    }
    let hold: InferenceBudgetHold | null;
    try {
      hold = await budget.reserve(run, maxChargeUsd);
    } catch {
      // A budget backend that cannot answer must never be read as "yes".
      return this.refuse(
        provider,
        "budget_exhausted",
        "the run's budget could not be verified",
        actor,
        `run=${run.run_id} budget_unavailable`,
      );
    }
    if (!hold) {
      return this.refuse(
        provider,
        "budget_exhausted",
        "the run's remaining budget cannot cover this request",
        actor,
        `run=${run.run_id} needed=${maxChargeUsd}`,
      );
    }

    return this.send(surface, input, run, hold, { model, maxChargeUsd }, actor);
  }

  /**
   * The forwarding half. From here the hold MUST be resolved on every path or
   * the held amount leaks and the run's remaining budget shrinks for good.
   */
  private async send(
    surface: GatewaySurface,
    input: GatewayForwardInput,
    run: ProxiedRunFacts,
    hold: InferenceBudgetHold | null,
    metered: { model: string; maxChargeUsd: number } | null,
    actor: string,
  ): Promise<GatewayResult> {
    const apiKey = this.options.apiKey(surface.provider);
    if (!apiKey) {
      if (hold) await hold.release();
      return this.refuse(
        surface.provider,
        "gateway_unavailable",
        "this deployment cannot serve that provider",
        actor,
        `run=${run.run_id} provider=${surface.provider} unconfigured`,
      );
    }

    // The forwarded headers: everything the caller sent except the deny list,
    // then OUR key. Built in that order so a caller can never override the
    // injected credential by sending a header we forward.
    const headers = new Headers();
    for (const [name, value] of Object.entries(input.headers)) {
      const key = name.toLowerCase();
      if (REQUEST_HEADER_DENY.has(key)) continue;
      // `x-norns-*` is our own control plane and is meaningless upstream.
      if (key.startsWith("x-norns-")) continue;
      if (value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
    }
    for (const [name, value] of Object.entries(surface.authHeaders(apiKey))) {
      headers.set(name, value);
    }

    let upstream: Response;
    try {
      upstream = await this.fetchImpl(`${surface.origin}${input.path}${input.query}`, {
        method: input.method,
        headers,
        // The bytes the caller sent. Not re-serialized, not normalized, not
        // validated against any schema. This line is the phase's thesis.
        body: input.body,
        redirect: "error",
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch {
      if (hold) await hold.release();
      // The caught error may be an undici failure whose message can name the
      // request — including headers. It is never surfaced or logged verbatim.
      return this.refuse(
        surface.provider,
        "upstream_unreachable",
        "the model provider could not be reached",
        actor,
        `run=${run.run_id} upstream_error`,
      );
    }

    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of upstream.headers) {
      if (RESPONSE_HEADER_DENY.has(name.toLowerCase())) continue;
      responseHeaders[name] = value;
    }

    const streaming = isEventStream(upstream.headers.get("content-type"));
    const tap = metered ? new GatewayUsageTap(surface.provider, streaming) : null;

    return {
      kind: "forwarded",
      status: upstream.status,
      headers: responseHeaders,
      body: this.pump(upstream, tap, hold, run, surface.provider, metered, actor),
    };
  }

  /**
   * Stream the upstream body through untouched, feeding a copy to the tap.
   *
   * THE `finally` IS THE POINT. It runs when the stream completes, when the
   * upstream dies mid-flight, and when the downstream client disconnects and
   * the consumer abandons the iterator. All three are the same accounting
   * event: whatever the tap saw is what the run is charged. A stream that dies
   * halfway consumed real tokens and must not silently cost nothing.
   */
  private async *pump(
    upstream: Response,
    tap: GatewayUsageTap | null,
    hold: InferenceBudgetHold | null,
    run: ProxiedRunFacts,
    provider: GatewayProvider,
    metered: { model: string; maxChargeUsd: number } | null,
    actor: string,
  ): AsyncGenerator<Uint8Array> {
    let truncated = true;
    try {
      const stream = upstream.body;
      if (stream) {
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              // Tap first, then yield. If yielding throws (the client went
              // away) the bytes are still accounted for.
              tap?.push(value);
              yield value;
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      truncated = false;
    } finally {
      tap?.end();
      await this.finalize(tap, hold, run, provider, metered, actor, truncated);
    }
  }

  /** Settle the hold, then meter. In that order: the settle is money. */
  private async finalize(
    tap: GatewayUsageTap | null,
    hold: InferenceBudgetHold | null,
    run: ProxiedRunFacts,
    provider: GatewayProvider,
    metered: { model: string; maxChargeUsd: number } | null,
    actor: string,
    truncated: boolean,
  ): Promise<void> {
    if (!hold || !metered || !tap) {
      await hold?.release();
      return;
    }
    if (!tap.observed) {
      // No usage in the body at all — an upstream 4xx/5xx error, or a body
      // shape we could not read. Releasing (rather than settling a guess) is
      // right for the error case and is the honest answer for the other: we
      // will not invent a charge. The risk this leaves is stated in the E9
      // report, and `audit` records every occurrence so it is measurable.
      await hold.release();
      this.options.audit?.(
        actor,
        "gateway.unmetered",
        `run=${run.run_id} model=${metered.model} truncated=${truncated}`,
      );
      return;
    }

    const usage = tap.snapshot();
    const inputTokens = billableInputTokens(usage);
    let pricing: ReturnType<typeof snapshotModelPricing>;
    try {
      pricing = snapshotModelPricing(provider as ProviderName, metered.model, this.registry);
    } catch {
      // Unreachable: pricing was proved before the request went out. Settling
      // the full hold is the fail-safe direction if it ever happens.
      await hold.settle(metered.maxChargeUsd);
      return;
    }
    const costUsd =
      Math.ceil(
        inputTokens * pricing.input_per_mtok + usage.output_tokens * pricing.output_per_mtok,
      ) / 1_000_000;

    // POST-HOC RECONCILIATION, STATED PLAINLY. The hold was a ceiling computed
    // from an ESTIMATED input-token count and the caller's DECLARED output
    // ceiling. The truth is only knowable now. We settle the truth even when
    // the truth exceeds the hold — the durable charge is the `usage_events`
    // row below, which `SqlRunReservationBudget` reads back as the run's
    // settled spend. So an over-run is self-correcting: the next request sees
    // a smaller (possibly negative) remaining figure and is refused. The
    // maximum a run can exceed its reservation by is therefore ONE request's
    // excess of true cost over its own pre-computed hold — never a runaway.
    await hold.settle(costUsd);

    const event: UsageEventT = {
      id: newId("usage"),
      provider: provider as ProviderName,
      model: metered.model,
      project_id: run.project_id,
      node_id: run.task_id,
      run_id: run.run_id,
      input_tokens: inputTokens,
      output_tokens: usage.output_tokens,
      estimated_cost_usd: costUsd,
      // The numbers came from the provider's own stream, so this is an ACTUAL
      // cost at the pricing table we snapshotted, not an estimate of tokens.
      actual_cost_usd: costUsd,
      usage_source: "provider_api",
      pricing_version: pricing.pricing_version,
      occurred_at: this.now().toISOString(),
    };
    try {
      await this.options.meter?.record(run, event);
    } catch {
      // A metering write that fails must not take the agent's response with
      // it — the bytes have already been delivered. It is audited instead.
      this.options.audit?.(
        actor,
        "gateway.meter_failed",
        `run=${run.run_id} model=${metered.model} usd=${costUsd}`,
      );
      return;
    }
    this.options.audit?.(
      actor,
      truncated || !tap.complete ? "gateway.metered_partial" : "gateway.metered",
      `${provider}/${metered.model} run=${run.run_id} in=${inputTokens} out=${usage.output_tokens} usd=${costUsd}`,
    );
  }
}
