import { createHash, sign as edSign, randomUUID } from "node:crypto";
import {
  DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE,
  type DeviceHttpSignaturePurposeT,
  canonicalizeDeviceHttpPathAndQuery,
  legacyRunnerHttpCredentialId,
  serializeSignedDeviceHttpTranscript,
} from "@norns/contracts";
import type { V2ContentAddressedReferenceT } from "@norns/contracts";
import type { RunnerContentFetcher } from "./v2Execution.js";

/** Explicitly gated compatibility protocol for pre-device runner identities. */
export const LEGACY_RUNNER_HTTP_AUTHORIZATION_SCHEME = "Norns-Legacy-Runner";

/** Strict device HTTP authentication protocol. */
export const DEVICE_HTTP_AUTHORIZATION_SCHEME = "Norns-Device";
export const DEVICE_HTTP_DEVICE_ID_HEADER = "x-norns-device-id";
export const DEVICE_HTTP_CREDENTIAL_ID_HEADER = "x-norns-credential-id";
export const DEVICE_HTTP_GENERATION_HEADER = "x-norns-device-generation";
export const DEVICE_HTTP_TIMESTAMP_HEADER = "x-norns-timestamp";
export const DEVICE_HTTP_REQUEST_ID_HEADER = "x-norns-request-id";

export interface DeviceRunnerHttpIdentity {
  mode: "device";
  deviceId: string;
  credentialId: string;
  generation: number;
  sign(payload: string): string;
}

export interface LegacyRunnerHttpIdentity {
  mode: "legacy_runner";
  runnerId: string;
  generation: number;
  sign(payload: string): string;
}

export type RunnerContextIdentity = DeviceRunnerHttpIdentity | LegacyRunnerHttpIdentity;

export function privateKeySigner(
  runnerId: string,
  privateKeyPem: string,
  generation: number,
): LegacyRunnerHttpIdentity {
  return {
    mode: "legacy_runner",
    runnerId,
    generation,
    sign: (payload) => edSign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("base64"),
  };
}

export function devicePrivateKeySigner(input: {
  deviceId: string;
  credentialId: string;
  generation: number;
  privateKeyPem: string;
}): DeviceRunnerHttpIdentity {
  return {
    mode: "device",
    deviceId: input.deviceId,
    credentialId: input.credentialId,
    generation: input.generation,
    sign: (payload) =>
      edSign(null, Buffer.from(payload, "utf8"), input.privateKeyPem).toString("base64"),
  };
}

export interface SignedRunnerHttpRequest {
  headers: Record<string, string>;
  body_sha256: string;
  canonical_path_and_query: string;
  request_id: string;
}

function bodyBytes(body: string | Uint8Array | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  return typeof body === "string" ? Buffer.from(body, "utf8") : body;
}

/**
 * Single signing implementation for context retrieval, gateway credential
 * minting, visual-evidence upload, and future device-authenticated endpoints.
 */
export function signRunnerHttpRequest(input: {
  identity: RunnerContextIdentity;
  purpose: DeviceHttpSignaturePurposeT;
  method: string;
  url: URL;
  body?: string | Uint8Array;
  timestamp: string;
  requestId?: string;
}): SignedRunnerHttpRequest {
  const canonicalPathAndQuery = canonicalizeDeviceHttpPathAndQuery(
    `${input.url.pathname}${input.url.search}`,
  );
  const bodySha256 = createHash("sha256").update(bodyBytes(input.body)).digest("hex");
  const requestId = input.requestId ?? randomUUID();
  const identity = input.identity;
  const legacy = identity.mode === "legacy_runner";
  const deviceId = identity.mode === "legacy_runner" ? identity.runnerId : identity.deviceId;
  const credentialId =
    identity.mode === "legacy_runner"
      ? legacyRunnerHttpCredentialId(identity.runnerId, identity.generation)
      : identity.credentialId;
  const generation = identity.generation;
  const transcript = serializeSignedDeviceHttpTranscript({
    purpose: input.purpose,
    device_id: deviceId,
    credential_id: credentialId,
    generation,
    http_method: input.method.toUpperCase() as
      | "GET"
      | "HEAD"
      | "POST"
      | "PUT"
      | "PATCH"
      | "DELETE"
      | "OPTIONS",
    canonical_path_and_query: canonicalPathAndQuery,
    body_sha256: bodySha256,
    timestamp: input.timestamp,
    request_id: requestId,
  });
  const scheme = legacy
    ? LEGACY_RUNNER_HTTP_AUTHORIZATION_SCHEME
    : DEVICE_HTTP_AUTHORIZATION_SCHEME;
  return {
    headers: {
      authorization: `${scheme} ${input.identity.sign(transcript)}`,
      [DEVICE_HTTP_DEVICE_ID_HEADER]: deviceId,
      [DEVICE_HTTP_CREDENTIAL_ID_HEADER]: credentialId,
      [DEVICE_HTTP_GENERATION_HEADER]: String(generation),
      [DEVICE_HTTP_TIMESTAMP_HEADER]: input.timestamp,
      [DEVICE_HTTP_REQUEST_ID_HEADER]: requestId,
    },
    body_sha256: bodySha256,
    canonical_path_and_query: canonicalPathAndQuery,
    request_id: requestId,
  };
}

export class RunnerSignedContextFetcher implements RunnerContentFetcher {
  constructor(
    private readonly identity: RunnerContextIdentity,
    private readonly now: () => Date = () => new Date(),
    private readonly httpFetch: typeof fetch = fetch,
    private readonly newRequestId: () => string = randomUUID,
  ) {}

  async fetch(reference: V2ContentAddressedReferenceT): Promise<Uint8Array> {
    const url = new URL(reference.storage_ref);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new Error("context storage_ref must be a signed HTTPS URL");
    }
    const signed = signRunnerHttpRequest({
      identity: this.identity,
      purpose: DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE,
      method: "GET",
      url,
      timestamp: this.now().toISOString(),
      requestId: this.newRequestId(),
    });
    // A context document is at most a few hundred KiB from our own server. A
    // fetch that has not settled in a minute is lost, and without this bound
    // the run hangs forever showing "preparing the coding session" — observed
    // live: a pending fetch with no open socket and no rejection.
    const response = await this.httpFetch(url, {
      redirect: "error",
      headers: signed.headers,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`context fetch failed with ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
