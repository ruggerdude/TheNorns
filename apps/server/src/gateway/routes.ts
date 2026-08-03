import { DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE } from "@norns/contracts";
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
  DeviceActionAuthorizationError,
  type PostgresDeviceActionAuthorization,
} from "../devices/actionAuthorization.js";
import {
  DEVICE_HTTP_DEVICE_ID_HEADER,
  type DeviceHttpAuthRequest,
  type DeviceHttpAuthResult,
  captureRunnerHttpBodySha256,
  capturedRunnerHttpBodySha256,
} from "../execution/index.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  type ProxiedRunFacts,
  type ProxiedRunLookup,
  type TransactionalProxiedRunLookup,
  authorizeProxiedRunAccess,
} from "../runners/inferenceProxy.js";
import type { GatewayCredentialService } from "./credentials.js";
import { GATEWAY_REFUSAL_HEADER, type ProviderGateway, refusalBody } from "./providerGateway.js";
import { GATEWAY_REQUEST_BODY_LIMIT_BYTES } from "./request.js";
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

/** Where an Anthropic-wire-compatible DeepSeek runtime sends Messages calls. */
export function deepSeekGatewayBaseUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${GATEWAY_ROUTE_PREFIX}/deepseek`;
}

function isGatewayProvider(value: string): value is GatewayProvider {
  return value === "anthropic" || value === "openai" || value === "deepseek";
}

export interface GatewayRouteDependencies {
  gateway: ProviderGateway;
  credentials: GatewayCredentialService;
  runs: ProxiedRunLookup;
  runnerHttpAuthentication: {
    authenticate(request: DeviceHttpAuthRequest): Promise<DeviceHttpAuthResult>;
  };
  deviceActionAuthorization?:
    | {
        service: PostgresDeviceActionAuthorization;
        transactions: V2TransactionRunner;
      }
    | undefined;
  audit?: ((actor: string, action: string, detail: string) => void) | undefined;
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
  // -- the mint route -------------------------------------------------------
  //
  // AUTH: an active device credential, or the explicitly gated legacy runner
  // compatibility identity during cutover. Both sign the same full request
  // transcript and consume a persistent one-time request id.
  //
  // The runner names a run; the server resolves that run from its own records
  // and refuses unless the authenticated runner is the one it was dispatched
  // to, at the generation it was dispatched at. A compromised job asking for a
  // credential to somebody else's run gets the same 401 as an unknown run.
  app.post(
    GATEWAY_CREDENTIAL_ROUTE,
    { preParsing: captureRunnerHttpBodySha256 },
    async (req, reply) => {
      const auth = await deps.runnerHttpAuthentication.authenticate({
        purpose: DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE,
        method: req.method,
        path_and_query: req.url,
        routed_path: GATEWAY_CREDENTIAL_ROUTE,
        body_sha256: capturedRunnerHttpBodySha256(req),
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      if (!auth.ok) {
        deps.audit?.(
          `runner:${req.headers[DEVICE_HTTP_DEVICE_ID_HEADER] ?? "unknown"}`,
          "gateway.credential_auth_failed",
          auth.reason,
        );
        return reply.code(401).send({ error: "unauthorized" });
      }
      const subjectId = auth.identity.authorization_subject_id;
      const body = (req.body ?? {}) as { run_id?: unknown };
      const runId = typeof body.run_id === "string" ? body.run_id : "";
      if (runId.length === 0) return reply.code(400).send({ error: "run_id is required" });

      if (auth.identity.kind === "device") {
        const deviceIdentity = auth.identity;
        const authorization = deps.deviceActionAuthorization;
        const lookup = deps.runs as Partial<TransactionalProxiedRunLookup>;
        if (!authorization || typeof lookup.lookupInTransaction !== "function") {
          return reply.code(503).send({ error: "device_authorization_unavailable" });
        }
        try {
          const decision = await authorization.transactions.transaction(async (sql) => {
            await authorization.service.assertRun(sql, {
              subject: "device",
              runner_id: deviceIdentity.device_id,
              generation: deviceIdentity.generation,
              credential_id: deviceIdentity.credential_id,
              run_id: runId,
            });
            const run = await lookup.lookupInTransaction?.(sql, runId);
            const access = authorizeProxiedRunAccess(
              run ?? null,
              runId,
              deviceIdentity.device_id,
              deviceIdentity.generation,
            );
            if (!run || access !== "ok") return { access } as const;
            const minted = await deps.credentials.mint(
              run,
              { subject: "device", credential_id: deviceIdentity.credential_id },
              sql,
            );
            return { access: "ok", minted } as const;
          });
          if (decision.access !== "ok" || !("minted" in decision)) {
            return reply
              .code(decision.access === "run_not_active" ? 403 : 401)
              .send({ error: decision.access });
          }
          deps.audit?.(
            `device:${deviceIdentity.device_id}`,
            "gateway.credential_minted",
            `run=${runId} expires=${decision.minted.expires_at}`,
          );
          return reply
            .header("cache-control", "no-store")
            .code(201)
            .send({
              token: decision.minted.token,
              expires_at: decision.minted.expires_at,
              anthropic_base_url: anthropicGatewayBaseUrl(deps.publicOrigin),
              openai_base_url: openAiGatewayBaseUrl(deps.publicOrigin),
              deepseek_base_url: deepSeekGatewayBaseUrl(deps.publicOrigin),
            });
        } catch (error) {
          if (error instanceof DeviceActionAuthorizationError) {
            deps.audit?.(
              `device:${deviceIdentity.device_id}`,
              "gateway.credential_refused",
              `run=${runId} ${error.code}`,
            );
            return reply.code(401).send({ error: "unauthorized" });
          }
          return reply.code(503).send({ error: "run_lookup_failed" });
        }
      }

      if (auth.identity.kind !== "legacy_runner") {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const legacyIdentity = auth.identity;
      let legacyDecision:
        | { access: ReturnType<typeof authorizeProxiedRunAccess> }
        | {
            access: "ok";
            run: ProxiedRunFacts;
            minted: Awaited<ReturnType<GatewayCredentialService["mint"]>>;
          };
      try {
        const authorization = deps.deviceActionAuthorization;
        const lookup = deps.runs as Partial<TransactionalProxiedRunLookup>;
        if (authorization) {
          if (typeof lookup.lookupInTransaction !== "function") {
            return reply.code(503).send({ error: "device_authorization_unavailable" });
          }
          legacyDecision = await authorization.transactions.transaction(async (sql) => {
            await authorization.service.assertRun(sql, {
              subject: "legacy_runner",
              runner_id: legacyIdentity.runner_id,
              generation: legacyIdentity.generation,
              run_id: runId,
            });
            const run = (await lookup.lookupInTransaction?.(sql, runId)) ?? null;
            const access = authorizeProxiedRunAccess(
              run,
              runId,
              legacyIdentity.runner_id,
              legacyIdentity.generation,
            );
            if (!run || access !== "ok") return { access };
            return {
              access: "ok",
              run,
              minted: await deps.credentials.mint(run, { subject: "legacy_runner" }, sql),
            };
          });
        } else {
          const run = await deps.runs.lookup(runId);
          const access = authorizeProxiedRunAccess(
            run,
            runId,
            legacyIdentity.runner_id,
            legacyIdentity.generation,
          );
          legacyDecision =
            !run || access !== "ok"
              ? { access }
              : {
                  access: "ok",
                  run,
                  minted: await deps.credentials.mint(run, { subject: "legacy_runner" }),
                };
        }
      } catch (error) {
        if (error instanceof DeviceActionAuthorizationError) {
          deps.audit?.(
            `runner:${subjectId}`,
            "gateway.credential_refused",
            `run=${runId} ${error.code}`,
          );
          return reply.code(401).send({ error: "unauthorized" });
        }
        return reply.code(503).send({ error: "run_lookup_failed" });
      }
      if (legacyDecision.access !== "ok" || !("minted" in legacyDecision)) {
        deps.audit?.(
          `runner:${subjectId}`,
          "gateway.credential_refused",
          `run=${runId} ${legacyDecision.access}`,
        );
        return reply
          .code(legacyDecision.access === "run_not_active" ? 403 : 401)
          .send({ error: legacyDecision.access });
      }

      const { minted } = legacyDecision;
      deps.audit?.(
        `runner:${subjectId}`,
        "gateway.credential_minted",
        `run=${legacyDecision.run.run_id} expires=${minted.expires_at}`,
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
          deepseek_base_url: deepSeekGatewayBaseUrl(deps.publicOrigin),
        });
    },
  );

  // -- the two provider surfaces -------------------------------------------
  await app.register(async (scope) => {
    // Raw bytes, for every content type, scoped to this plugin only.
    scope.removeContentTypeParser?.(["application/json"]);
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: GATEWAY_REQUEST_BODY_LIMIT_BYTES },
      (_req, body, done) => {
        done(null, body);
      },
    );

    // VERIFIED against the Claude Code CLI: before its first model call it
    // issues `HEAD <ANTHROPIC_BASE_URL>` as a reachability probe. Answering it
    // here costs nothing, touches no provider, requires no credential, and
    // reveals nothing — and without it a healthy deployment answers 404 to the
    // very first request an agent makes, which looks exactly like a broken
    // gateway to anyone reading logs.
    scope.head(`${GATEWAY_ROUTE_PREFIX}/:provider`, async (req, reply) => {
      const { provider } = req.params as { provider: string };
      return reply.code(isGatewayProvider(provider) ? 200 : 404).send();
    });

    scope.all(`${GATEWAY_ROUTE_PREFIX}/:provider/*`, async (req, reply) => {
      const { provider } = req.params as { provider: string };
      const path = `/${(req.params as Record<string, string>)["*"] ?? ""}`;
      // The query string is NOT part of the allowlist decision but IS part of
      // the request. Claude Code really sends `?beta=true`; dropping it would
      // change the call. Taken from the raw URL so it survives byte for byte.
      const queryStart = req.raw.url?.indexOf("?") ?? -1;
      const query = queryStart >= 0 ? (req.raw.url?.slice(queryStart) ?? "") : "";
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
        query,
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
