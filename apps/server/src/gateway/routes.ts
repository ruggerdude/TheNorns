// EXECUTION E9 — the HTTP surface. Two base URLs and one mint route.
//
// WHAT AN SDK SEES.
//   Claude Code:  ANTHROPIC_BASE_URL = <origin>/api/gateway/anthropic
//                 -> POST <origin>/api/gateway/anthropic/v1/messages
//   Codex:        base_url          = <origin>/api/gateway/openai/v1
//                 -> POST <origin>/api/gateway/openai/v1/responses
// Both are shaped so the SDK's own path-joining lands on a route this file
// registers, with no rewriting on either side. The suffix after the provider
// segment IS the upstream path, forwarded as-is subject to the allowlist in
// providerGateway.ts.
//
// WHY A WILDCARD AND NOT NAMED ROUTES. A forwarder that enumerates routes in
// Fastify would 404 a path the provider added last week even when the
// allowlist would have permitted it, and the 404 would come from OUR router
// with our error shape — a lie about who refused. One wildcard means exactly
// one component decides what is forwardable, and its refusals are honest.
//
// WHY AN ENCAPSULATED PLUGIN. The gateway needs the RAW request bytes: Fastify
// would otherwise parse the JSON and the body we forwarded would be a
// re-serialization, silently reordering keys and dropping anything the parser
// normalizes. `addContentTypeParser` inside a `register` callback is scoped to
// that plugin only, so every other route on the server keeps its parsed body.
//
// WHY reply.hijack(). SSE is only useful if it arrives incrementally. Handing
// Fastify a stream re-introduces its serializer and its buffering; taking the
// raw socket means a chunk read from the provider is a chunk written to the
// agent, which is what "chunk-for-chunk" has to mean.
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  RUNNER_CONTEXT_RUNNER_ID_HEADER,
  authenticateRunnerContextRequest,
} from "../execution/index.js";
import {
  type ProxiedRunFacts,
  type ProxiedRunLookup,
  authorizeProxiedRunAccess,
} from "../runners/inferenceProxy.js";
import type { GatewayCredentialService } from "./credentials.js";
import { GATEWAY_REFUSAL_HEADER, type ProviderGateway, refusalBody } from "./providerGateway.js";
import type { GatewayProvider } from "./usage.js";

/** Mounted prefix. `<origin>${GATEWAY_ROUTE_PREFIX}/<provider>/<path…>` */
export const GATEWAY_ROUTE_PREFIX = "/api/gateway";

/** Where a runner mints a credential for the run it was dispatched. */
export const GATEWAY_CREDENTIAL_ROUTE = "/api/execution/gateway/credentials";

/** The base URL Claude Code must be given. It appends `/v1/messages`. */
export function anthropicGatewayBaseUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${GATEWAY_ROUTE_PREFIX}/anthropic`;
}

/**
 * The base URL Codex must be given.
 *
 * It ends in `/v1` because the codex binary documents base_url as "the
 * provider API root, for example https://api.openai.com/v1" and then requests
 * `<base_url>/responses`. Getting this segment wrong is a 404 that looks like
 * a Norns bug and is actually a path-joining mistake, so it lives in a
 * function both the runner and the tests call.
 */
export function openAiGatewayBaseUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${GATEWAY_ROUTE_PREFIX}/openai/v1`;
}

function isGatewayProvider(value: string): value is GatewayProvider {
  return value === "anthropic" || value === "openai";
}

export interface GatewayRouteDependencies {
  gateway: ProviderGateway;
  credentials: GatewayCredentialService;
  runs: ProxiedRunLookup;
  /** Ed25519 public key registered at pairing, or null for an unknown runner. */
  runnerPublicKey: (runnerId: string) => string | null;
  audit?: ((actor: string, action: string, detail: string) => void) | undefined;
  now?: (() => Date) | undefined;
  /** The origin the runtimes should be pointed at. */
  publicOrigin: string;
}

/**
 * Register both provider surfaces and the credential mint route.
 *
 * Called from server.ts's single "EXECUTION E9" section; everything else about
 * the gateway lives under src/gateway/.
 */
export async function registerGatewayRoutes(
  app: FastifyInstance,
  deps: GatewayRouteDependencies,
): Promise<void> {
  const now = deps.now ?? (() => new Date());

  // -- the mint route -------------------------------------------------------
  //
  // AUTH: the runner's EXISTING relay identity — the Ed25519 keypair
  // registered at pairing, exactly as E1's context-fetch route uses. No second
  // credential system is introduced to protect the credential system.
  //
  // The runner names a run; the server resolves that run from its own records
  // and refuses unless the authenticated runner is the one it was dispatched
  // to, at the generation it was dispatched at. A compromised job asking for a
  // credential to somebody else's run gets the same 401 as an unknown run.
  app.post(GATEWAY_CREDENTIAL_ROUTE, async (req, reply) => {
    const auth = authenticateRunnerContextRequest(
      {
        method: req.method,
        path: new URL(req.url, "http://placeholder.invalid").pathname,
        headers: req.headers as Record<string, string | string[] | undefined>,
      },
      deps.runnerPublicKey,
      now().getTime(),
    );
    if (!auth.ok) {
      deps.audit?.(
        `runner:${req.headers[RUNNER_CONTEXT_RUNNER_ID_HEADER] ?? "unknown"}`,
        "gateway.credential_auth_failed",
        auth.reason,
      );
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = (req.body ?? {}) as { run_id?: unknown };
    const runId = typeof body.run_id === "string" ? body.run_id : "";
    if (runId.length === 0) return reply.code(400).send({ error: "run_id is required" });

    let run: ProxiedRunFacts | null;
    try {
      run = await deps.runs.lookup(runId);
    } catch {
      return reply.code(503).send({ error: "run_lookup_failed" });
    }
    // The credential is fenced to whatever generation the run is CURRENTLY
    // dispatched at, so re-dispatching a run invalidates every token minted
    // for the previous attempt without anyone deleting a row.
    const access = authorizeProxiedRunAccess(
      run,
      runId,
      auth.runner_id,
      run?.runner_generation ?? -1,
    );
    if (!run || access !== "ok") {
      deps.audit?.(
        `runner:${auth.runner_id}`,
        "gateway.credential_refused",
        `run=${runId} ${access}`,
      );
      // 401 for "not yours" and 403 for "not spendable" — the second reveals
      // nothing the caller has not already proved it owns.
      return reply.code(access === "run_not_active" ? 403 : 401).send({ error: access });
    }

    const minted = await deps.credentials.mint(run);
    deps.audit?.(
      `runner:${auth.runner_id}`,
      "gateway.credential_minted",
      `run=${run.run_id} expires=${minted.expires_at}`,
    );
    return reply
      .header("cache-control", "no-store")
      .code(201)
      .send({
        // The plaintext token exists here and nowhere else, ever.
        token: minted.token,
        expires_at: minted.expires_at,
        anthropic_base_url: anthropicGatewayBaseUrl(deps.publicOrigin),
        openai_base_url: openAiGatewayBaseUrl(deps.publicOrigin),
      });
  });

  // -- the two provider surfaces -------------------------------------------
  await app.register(async (scope) => {
    // Raw bytes, for every content type, scoped to this plugin only.
    scope.removeContentTypeParser?.(["application/json"]);
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });

    scope.all(`${GATEWAY_ROUTE_PREFIX}/:provider/*`, async (req, reply) => {
      const { provider } = req.params as { provider: string };
      const path = `/${(req.params as Record<string, string>)["*"] ?? ""}`;
      if (!isGatewayProvider(provider)) {
        return reply
          .header(GATEWAY_REFUSAL_HEADER, "invalid_request")
          .type("application/json")
          .code(404)
          .send(refusalBody("anthropic", "invalid_request", "unknown gateway provider"));
      }

      // The client going away must abort the upstream request too — otherwise
      // an abandoned agent keeps generating tokens the run still pays for.
      const controller = new AbortController();
      const onClose = () => controller.abort();
      req.raw.once("aborted", onClose);
      req.raw.once("close", onClose);

      const result = await deps.gateway.forward({
        provider,
        path,
        method: req.method,
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: bodyBytes(req),
        signal: controller.signal,
      });

      if (result.kind === "refused") {
        req.raw.off("aborted", onClose);
        req.raw.off("close", onClose);
        return reply
          .header(GATEWAY_REFUSAL_HEADER, result.code)
          .type(result.contentType)
          .code(result.status)
          .send(result.body);
      }

      // Take the socket. From here Fastify does not touch these bytes.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(result.status, {
        ...result.headers,
        // SSE through an intermediary is only incremental if nothing buffers
        // it. `no-transform` and the nginx hint are the two that actually
        // matter in front of a real deployment.
        "cache-control": result.headers["cache-control"] ?? "no-store, no-transform",
        "x-accel-buffering": "no",
      });
      try {
        for await (const chunk of result.body) {
          if (raw.destroyed) break;
          raw.write(chunk);
          // Flush past any compression middleware that may be in the way.
          (raw as { flush?: () => void }).flush?.();
        }
      } catch {
        // The upstream stream failed mid-flight. The status line has already
        // gone out, so there is no honest way to signal an error except to
        // end the response — which is exactly what a truncated provider
        // stream looks like to an SDK, and what it already knows to handle.
        // Metering has already happened inside the iterator's `finally`.
      } finally {
        req.raw.off("aborted", onClose);
        req.raw.off("close", onClose);
        if (!raw.destroyed) raw.end();
      }
      return reply;
    });
  });
}

/** The buffer the scoped content-type parser produced, or an empty body. */
function bodyBytes(req: FastifyRequest): Uint8Array {
  const body = req.body;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(0);
}
