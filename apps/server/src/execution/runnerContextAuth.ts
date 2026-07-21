// EXECUTION E1: authenticating the runner on the context-fetch route.
//
// NO NEW CREDENTIAL. A runner already proves its identity to the relay with an
// Ed25519 signature over a server-issued nonce (`verifyRunnerSignature`, used
// by /ws/runner). The same keypair — the one registered at pairing — signs the
// context fetch. The only thing added here is a canonical payload to sign,
// because HTTP has no challenge round-trip: the runner signs the request line
// itself plus a timestamp, and the server rejects anything outside a narrow
// skew window.
//
// Credentials never appear in the URL. The `storage_ref` handed to the runner
// is a plain, unguessable-but-not-secret URL; the Authorization header carries
// the proof. That keeps the ref safe to persist in a dispatch command, log, or
// audit record.
import { createPrivateKey, sign as edSign } from "node:crypto";
import { verifyRunnerSignature } from "../auth.js";

export const RUNNER_CONTEXT_AUTH_SCHEME = "Norns-Runner";
export const RUNNER_CONTEXT_RUNNER_ID_HEADER = "x-norns-runner-id";
export const RUNNER_CONTEXT_TIMESTAMP_HEADER = "x-norns-runner-timestamp";
/** Replay window. Wide enough for clock drift, narrow enough to be useless. */
export const RUNNER_CONTEXT_MAX_SKEW_MS = 300_000;

const SIGNING_DOMAIN = "norns:runner-context-fetch:v1";

export interface RunnerContextSignatureInput {
  method: string;
  /** Request path only (no origin, no query) — the resource being proven for. */
  path: string;
  runnerId: string;
  /** ISO-8601 instant, echoed in the timestamp header. */
  timestamp: string;
}

/**
 * The exact bytes both sides sign/verify. Domain-separated so a signature
 * captured here can never be replayed as a relay auth nonce, and vice versa.
 */
export function runnerContextSigningPayload(input: RunnerContextSignatureInput): string {
  return [
    SIGNING_DOMAIN,
    input.method.toUpperCase(),
    input.path,
    input.runnerId,
    input.timestamp,
  ].join("\n");
}

export type RunnerContextAuthFailure =
  | "missing_credentials"
  | "unknown_runner"
  | "stale_timestamp"
  | "bad_signature";

export interface RunnerContextAuthRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

export type RunnerContextAuthResult =
  | { ok: true; runner_id: string }
  | { ok: false; reason: RunnerContextAuthFailure };

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Verify a runner-signed context fetch. `lookupPublicKey` returns the PEM
 * registered at pairing, or null for an unknown runner. A reserved-but-not-yet
 * enrolled runner carries an empty key and fails closed inside
 * `verifyRunnerSignature`.
 */
export function authenticateRunnerContextRequest(
  request: RunnerContextAuthRequest,
  lookupPublicKey: (runnerId: string) => string | null,
  nowMs: number,
): RunnerContextAuthResult {
  const authorization = header(request.headers, "authorization");
  const runnerId = header(request.headers, RUNNER_CONTEXT_RUNNER_ID_HEADER);
  const timestamp = header(request.headers, RUNNER_CONTEXT_TIMESTAMP_HEADER);
  const prefix = `${RUNNER_CONTEXT_AUTH_SCHEME} `;
  if (!authorization || !runnerId || !timestamp || !authorization.startsWith(prefix)) {
    return { ok: false, reason: "missing_credentials" };
  }
  const signature = authorization.slice(prefix.length).trim();
  if (signature.length === 0) return { ok: false, reason: "missing_credentials" };

  const issuedAt = Date.parse(timestamp);
  if (Number.isNaN(issuedAt) || Math.abs(nowMs - issuedAt) > RUNNER_CONTEXT_MAX_SKEW_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const publicKeyPem = lookupPublicKey(runnerId);
  if (publicKeyPem === null) return { ok: false, reason: "unknown_runner" };

  const payload = runnerContextSigningPayload({
    method: request.method,
    path: request.path,
    runnerId,
    timestamp,
  });
  if (!verifyRunnerSignature(publicKeyPem, payload, signature)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, runner_id: runnerId };
}

/**
 * Reference client for the wire format above. It is the exact shape of the
 * runner's `RunnerContentFetcher` (structurally, so no import from
 * `@norns/runner` is needed here) and is what a runner must use in place of
 * `SignedUrlContentFetcher` to read assembled context.
 *
 * E4/runner note: adopting this is a one-line swap at the runner's fetcher
 * construction site. It lives here so the signing and verifying halves of the
 * format cannot drift apart.
 */
export class RunnerSignedContextFetcher {
  constructor(
    private readonly runnerId: string,
    /** PKCS#8 PEM for the same Ed25519 key registered at pairing. */
    private readonly privateKeyPem: string,
    private readonly now: () => Date = () => new Date(),
    private readonly httpFetch: typeof fetch = fetch,
  ) {}

  async fetch(reference: { storage_ref: string }): Promise<Uint8Array> {
    const url = new URL(reference.storage_ref);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new Error("context storage_ref must be an HTTPS URL");
    }
    const timestamp = this.now().toISOString();
    const payload = runnerContextSigningPayload({
      method: "GET",
      path: url.pathname,
      runnerId: this.runnerId,
      timestamp,
    });
    const signature = edSign(
      null,
      Buffer.from(payload, "utf8"),
      createPrivateKey(this.privateKeyPem),
    ).toString("base64");
    const response = await this.httpFetch(url, {
      redirect: "error",
      headers: {
        authorization: `${RUNNER_CONTEXT_AUTH_SCHEME} ${signature}`,
        [RUNNER_CONTEXT_RUNNER_ID_HEADER]: this.runnerId,
        [RUNNER_CONTEXT_TIMESTAMP_HEADER]: timestamp,
      },
    });
    if (!response.ok) throw new Error(`context fetch failed with ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
