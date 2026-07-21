// EXECUTION E3 (for phase E1) — authenticated context fetching.
//
// THE BUG THIS FIXES: `SignedUrlContentFetcher` sends no credentials. Against
// E1's context route every fetch returns 401, so the coding agent receives no
// prompt at all and the run is dead on arrival. E1 built the correct client but
// could not install it, because apps/runner is outside its ownership.
//
// THE CREDENTIAL: none is invented. The runner already holds an Ed25519 keypair
// whose public half the server registered at pairing (or at Actions
// enrollment), and which it already uses for the relay's challenge/response.
// This reuses that exact key. Nothing new is provisioned, nothing new can leak,
// and revoking a runner (which bumps its generation and, on revocation, drops
// its key) revokes context access with it.
//
// THE SIGNATURE: over a domain-separated canonical string, not over the URL.
// Domain separation (`norns:runner-context-fetch:v1`) means a signature minted
// here can never be replayed as a relay auth response, and vice versa — the
// two payload spaces cannot overlap. The timestamp bounds replay to the
// server's skew window. Nothing secret goes in the URL, so the credential does
// not end up in a proxy log or a CI transcript.
import { sign as edSign } from "node:crypto";
import type { V2ContentAddressedReferenceT } from "@norns/contracts";
import type { RunnerContentFetcher } from "./v2Execution.js";

/**
 * Domain separator. Versioned so the canonical form can change without a
 * server ever accepting an old-shaped signature as a new-shaped one.
 */
export const RUNNER_CONTEXT_FETCH_DOMAIN = "norns:runner-context-fetch:v1";

export const RUNNER_AUTHORIZATION_SCHEME = "Norns-Runner";
export const RUNNER_ID_HEADER = "x-norns-runner-id";
export const RUNNER_TIMESTAMP_HEADER = "x-norns-timestamp";

/**
 * The exact bytes signed and verified.
 *
 * `path` is the URL path ONLY (no origin, no query): the signature binds the
 * request to a resource, not to a particular host spelling, so a proxy or a
 * changed public origin does not invalidate it.
 */
export function runnerContextFetchPayload(input: {
  method: string;
  path: string;
  runnerId: string;
  issuedAt: string;
}): string {
  return [
    RUNNER_CONTEXT_FETCH_DOMAIN,
    input.method.toUpperCase(),
    input.path,
    input.runnerId,
    input.issuedAt,
  ].join("|");
}

export interface RunnerContextIdentity {
  runnerId: string;
  /**
   * Signs the canonical payload, returning base64. Deliberately a function and
   * not the PEM itself: the private key stays inside RunnerDaemon and no other
   * component ever holds a copy it could log or persist.
   */
  sign(payload: string): string;
}

/** Signs with a PEM directly — for callers that already own the key material. */
export function privateKeySigner(runnerId: string, privateKeyPem: string): RunnerContextIdentity {
  return {
    runnerId,
    sign: (payload) => edSign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("base64"),
  };
}

/**
 * Fetches content-addressed context with a signed Authorization header.
 *
 * A drop-in replacement for `SignedUrlContentFetcher`: same interface, same
 * transport rules (HTTPS except loopback, redirects refused). Redirects are
 * still refused for a sharper reason now — a signature is bound to one path,
 * so following a redirect would either fail confusingly or, if the server were
 * lenient, forward a credential to a location the runner never authorized.
 */
export class RunnerSignedContextFetcher implements RunnerContentFetcher {
  constructor(
    private readonly identity: RunnerContextIdentity,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetch(reference: V2ContentAddressedReferenceT): Promise<Uint8Array> {
    const url = new URL(reference.storage_ref);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new Error("context storage_ref must be a signed HTTPS URL");
    }
    const issuedAt = this.now().toISOString();
    const signature = this.identity.sign(
      runnerContextFetchPayload({
        method: "GET",
        path: url.pathname,
        runnerId: this.identity.runnerId,
        issuedAt,
      }),
    );
    const response = await fetch(url, {
      redirect: "error",
      headers: {
        authorization: `${RUNNER_AUTHORIZATION_SCHEME} ${signature}`,
        [RUNNER_ID_HEADER]: this.identity.runnerId,
        [RUNNER_TIMESTAMP_HEADER]: issuedAt,
      },
    });
    if (!response.ok) throw new Error(`context fetch failed with ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
