import { createHash, verify } from "node:crypto";
import { Transform } from "node:stream";
import {
  type DeviceHttpSignaturePurposeT,
  SignedDeviceHttpTranscript,
  canonicalizeDeviceHttpPathAndQuery,
  legacyRunnerHttpCredentialId,
  serializeSignedDeviceHttpTranscript,
} from "@norns/contracts";
import type { FastifyRequest, preParsingHookHandler } from "fastify";
import type { V2TransactionRunner } from "../persistence/v2/database.js";

export const DEVICE_HTTP_AUTH_SCHEME = "Norns-Device";
export const LEGACY_RUNNER_HTTP_AUTH_SCHEME = "Norns-Legacy-Runner";
export const DEVICE_HTTP_DEVICE_ID_HEADER = "x-norns-device-id";
export const DEVICE_HTTP_CREDENTIAL_ID_HEADER = "x-norns-credential-id";
export const DEVICE_HTTP_GENERATION_HEADER = "x-norns-device-generation";
export const DEVICE_HTTP_TIMESTAMP_HEADER = "x-norns-timestamp";
export const DEVICE_HTTP_REQUEST_ID_HEADER = "x-norns-request-id";
export const DEVICE_HTTP_MAX_SKEW_MS = 300_000;
export const EMPTY_HTTP_BODY_SHA256 = createHash("sha256").digest("hex");

const BASE64_ED25519_SIGNATURE = /^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/;
const RFC3986_PATH_SEGMENT_ASCII = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]$/;
const bodyDigests = new WeakMap<FastifyRequest, string>();

export type DeviceHttpAuthFailure =
  | "missing_credentials"
  | "malformed_credentials"
  | "stale_timestamp"
  | "inactive_credential"
  | "bad_signature"
  | "replayed_request"
  | "legacy_disabled"
  | "unknown_runner";

export type AuthenticatedRunnerHttpIdentity =
  | {
      kind: "device";
      device_id: string;
      credential_id: string;
      generation: number;
      authorization_subject_id: string;
    }
  | {
      kind: "legacy_runner";
      runner_id: string;
      generation: number;
      authorization_subject_id: string;
    };

export type DeviceHttpAuthResult =
  | { ok: true; identity: AuthenticatedRunnerHttpIdentity }
  | { ok: false; reason: DeviceHttpAuthFailure };

export interface DeviceHttpAuthRequest {
  purpose: DeviceHttpSignaturePurposeT;
  method: string;
  /**
   * Raw origin-form target received from the transport.
   */
  path_and_query: string;
  /**
   * Canonical path the application router selected, reconstructed from its
   * decoded route parameters. It intentionally excludes the query.
   */
  routed_path: string;
  body_sha256: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface ActiveDeviceHttpCredential {
  public_key_spki_der: Buffer;
}

export interface DeviceHttpReplayInput {
  request_id: string;
  device_id: string;
  credential_id: string;
  generation: number;
  purpose: DeviceHttpSignaturePurposeT;
  request_timestamp: string;
  consumed_at: string;
}

export interface LegacyRunnerHttpReplayInput {
  request_id: string;
  runner_id: string;
  credential_id: string;
  generation: number;
  purpose: DeviceHttpSignaturePurposeT;
  request_timestamp: string;
  consumed_at: string;
}

export interface DeviceHttpCredentialRepository {
  activeCredential(input: {
    device_id: string;
    credential_id: string;
    generation: number;
  }): Promise<ActiveDeviceHttpCredential | null>;
  consumeRequestId(input: DeviceHttpReplayInput): Promise<"consumed" | "replayed" | "inactive">;
  consumeLegacyRequestId(input: LegacyRunnerHttpReplayInput): Promise<"consumed" | "replayed">;
}

export type LegacyRunnerHttpCompatibility =
  | { enabled: false }
  | {
      enabled: true;
      lookupRunner: (
        runnerId: string,
      ) =>
        | { public_key_pem: string; generation: number }
        | null
        | Promise<{ public_key_pem: string; generation: number } | null>;
    };

export interface DeviceHttpAuthenticatorOptions {
  repository: DeviceHttpCredentialRepository;
  legacyCompatibility: LegacyRunnerHttpCompatibility;
  now?: () => Date;
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Reconstruct the path segment the application router handed to a handler.
 * Comparing this with the canonical raw target prevents signing one path while
 * Fastify acts on a normalized or decoded equivalent.
 */
export function routedDeviceHttpPathSegment(value: string): string {
  let encoded = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      codePoint <= 0x7f &&
      RFC3986_PATH_SEGMENT_ASCII.test(character)
    ) {
      encoded += character;
      continue;
    }
    for (const byte of Buffer.from(character, "utf8")) {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return encoded;
}

function verifiesEd25519(
  publicKey: Buffer | string,
  payload: string,
  signatureBase64: string,
): boolean {
  if (!BASE64_ED25519_SIGNATURE.test(signatureBase64)) return false;
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.byteLength !== 64 || signature.toString("base64") !== signatureBase64) {
    return false;
  }
  try {
    return verify(
      null,
      Buffer.from(payload, "utf8"),
      typeof publicKey === "string" ? publicKey : { key: publicKey, format: "der", type: "spki" },
      signature,
    );
  } catch {
    return false;
  }
}

function canonicalTargetForRoutedRequest(request: DeviceHttpAuthRequest): string {
  const canonicalPathAndQuery = canonicalizeDeviceHttpPathAndQuery(request.path_and_query);
  const canonicalRoutedPath = canonicalizeDeviceHttpPathAndQuery(request.routed_path);
  if (
    request.routed_path.includes("?") ||
    canonicalRoutedPath !== request.routed_path ||
    canonicalPathAndQuery.split("?", 1)[0] !== request.routed_path
  ) {
    throw new Error("device HTTP signature target does not match the routed application path");
  }
  return canonicalPathAndQuery;
}

export class DeviceHttpRequestAuthenticator {
  private readonly now: () => Date;

  constructor(private readonly options: DeviceHttpAuthenticatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async authenticate(request: DeviceHttpAuthRequest): Promise<DeviceHttpAuthResult> {
    const authorization = header(request.headers, "authorization");
    if (!authorization) return { ok: false, reason: "missing_credentials" };
    if (authorization.startsWith(`${DEVICE_HTTP_AUTH_SCHEME} `)) {
      return this.authenticateDevice(request, authorization);
    }
    if (authorization.startsWith(`${LEGACY_RUNNER_HTTP_AUTH_SCHEME} `)) {
      return this.authenticateLegacy(request, authorization);
    }
    return { ok: false, reason: "missing_credentials" };
  }

  private async authenticateDevice(
    request: DeviceHttpAuthRequest,
    authorization: string,
  ): Promise<DeviceHttpAuthResult> {
    const deviceId = header(request.headers, DEVICE_HTTP_DEVICE_ID_HEADER);
    const credentialId = header(request.headers, DEVICE_HTTP_CREDENTIAL_ID_HEADER);
    const generationHeader = header(request.headers, DEVICE_HTTP_GENERATION_HEADER);
    const timestamp = header(request.headers, DEVICE_HTTP_TIMESTAMP_HEADER);
    const requestId = header(request.headers, DEVICE_HTTP_REQUEST_ID_HEADER);
    const signature = authorization.slice(`${DEVICE_HTTP_AUTH_SCHEME} `.length).trim();
    if (!deviceId || !credentialId || !generationHeader || !timestamp || !requestId || !signature) {
      return { ok: false, reason: "missing_credentials" };
    }
    if (!/^[1-9][0-9]*$/.test(generationHeader)) {
      return { ok: false, reason: "malformed_credentials" };
    }
    const generation = Number(generationHeader);
    if (!Number.isSafeInteger(generation)) {
      return { ok: false, reason: "malformed_credentials" };
    }
    const timestampMs = Date.parse(timestamp);
    const now = this.now();
    if (
      Number.isNaN(timestampMs) ||
      Math.abs(now.getTime() - timestampMs) > DEVICE_HTTP_MAX_SKEW_MS
    ) {
      return { ok: false, reason: "stale_timestamp" };
    }

    let canonicalPathAndQuery: string;
    try {
      canonicalPathAndQuery = canonicalTargetForRoutedRequest(request);
    } catch {
      return { ok: false, reason: "malformed_credentials" };
    }
    if (!/^[a-f0-9]{64}$/.test(request.body_sha256)) {
      return { ok: false, reason: "malformed_credentials" };
    }
    const parsed = SignedDeviceHttpTranscript.safeParse({
      purpose: request.purpose,
      device_id: deviceId,
      credential_id: credentialId,
      generation,
      http_method: request.method.toUpperCase(),
      canonical_path_and_query: canonicalPathAndQuery,
      body_sha256: request.body_sha256,
      timestamp,
      request_id: requestId,
    });
    if (!parsed.success) return { ok: false, reason: "malformed_credentials" };

    const credential = await this.options.repository.activeCredential({
      device_id: deviceId,
      credential_id: credentialId,
      generation,
    });
    if (!credential) return { ok: false, reason: "inactive_credential" };
    if (
      !verifiesEd25519(
        credential.public_key_spki_der,
        serializeSignedDeviceHttpTranscript(parsed.data),
        signature,
      )
    ) {
      return { ok: false, reason: "bad_signature" };
    }

    const consumption = await this.options.repository.consumeRequestId({
      request_id: requestId,
      device_id: deviceId,
      credential_id: credentialId,
      generation,
      purpose: request.purpose,
      request_timestamp: timestamp,
      consumed_at: now.toISOString(),
    });
    if (consumption === "inactive") return { ok: false, reason: "inactive_credential" };
    if (consumption === "replayed") return { ok: false, reason: "replayed_request" };
    return {
      ok: true,
      identity: {
        kind: "device",
        device_id: deviceId,
        credential_id: credentialId,
        generation,
        authorization_subject_id: deviceId,
      },
    };
  }

  private async authenticateLegacy(
    request: DeviceHttpAuthRequest,
    authorization: string,
  ): Promise<DeviceHttpAuthResult> {
    if (!this.options.legacyCompatibility.enabled) {
      return { ok: false, reason: "legacy_disabled" };
    }
    const runnerId = header(request.headers, DEVICE_HTTP_DEVICE_ID_HEADER);
    const credentialId = header(request.headers, DEVICE_HTTP_CREDENTIAL_ID_HEADER);
    const generationHeader = header(request.headers, DEVICE_HTTP_GENERATION_HEADER);
    const timestamp = header(request.headers, DEVICE_HTTP_TIMESTAMP_HEADER);
    const requestId = header(request.headers, DEVICE_HTTP_REQUEST_ID_HEADER);
    const signature = authorization.slice(`${LEGACY_RUNNER_HTTP_AUTH_SCHEME} `.length).trim();
    if (!runnerId || !credentialId || !generationHeader || !timestamp || !requestId || !signature) {
      return { ok: false, reason: "missing_credentials" };
    }
    if (!/^[1-9][0-9]*$/.test(generationHeader)) {
      return { ok: false, reason: "malformed_credentials" };
    }
    const generation = Number(generationHeader);
    if (
      !Number.isSafeInteger(generation) ||
      credentialId !== legacyRunnerHttpCredentialId(runnerId, generation)
    ) {
      return { ok: false, reason: "malformed_credentials" };
    }
    const timestampMs = Date.parse(timestamp);
    const now = this.now();
    if (
      Number.isNaN(timestampMs) ||
      Math.abs(now.getTime() - timestampMs) > DEVICE_HTTP_MAX_SKEW_MS
    ) {
      return { ok: false, reason: "stale_timestamp" };
    }
    let canonicalPathAndQuery: string;
    try {
      canonicalPathAndQuery = canonicalTargetForRoutedRequest(request);
    } catch {
      return { ok: false, reason: "malformed_credentials" };
    }
    const parsed = SignedDeviceHttpTranscript.safeParse({
      purpose: request.purpose,
      device_id: runnerId,
      credential_id: credentialId,
      generation,
      http_method: request.method.toUpperCase(),
      canonical_path_and_query: canonicalPathAndQuery,
      body_sha256: request.body_sha256,
      timestamp,
      request_id: requestId,
    });
    if (!parsed.success) return { ok: false, reason: "malformed_credentials" };
    const runner = await this.options.legacyCompatibility.lookupRunner(runnerId);
    if (!runner || runner.generation !== generation) {
      return { ok: false, reason: "unknown_runner" };
    }
    if (
      !verifiesEd25519(
        runner.public_key_pem,
        serializeSignedDeviceHttpTranscript(parsed.data),
        signature,
      )
    ) {
      return { ok: false, reason: "bad_signature" };
    }
    const current = await this.options.legacyCompatibility.lookupRunner(runnerId);
    if (
      !current ||
      current.generation !== generation ||
      current.public_key_pem !== runner.public_key_pem
    ) {
      return { ok: false, reason: "unknown_runner" };
    }
    const consumption = await this.options.repository.consumeLegacyRequestId({
      request_id: requestId,
      runner_id: runnerId,
      credential_id: credentialId,
      generation,
      purpose: request.purpose,
      request_timestamp: timestamp,
      consumed_at: now.toISOString(),
    });
    if (consumption === "replayed") {
      return { ok: false, reason: "replayed_request" };
    }
    return {
      ok: true,
      identity: {
        kind: "legacy_runner",
        runner_id: runnerId,
        generation,
        authorization_subject_id: runnerId,
      },
    };
  }
}

export class PostgresDeviceHttpCredentialRepository implements DeviceHttpCredentialRepository {
  constructor(private readonly transactions: V2TransactionRunner) {}

  activeCredential(input: {
    device_id: string;
    credential_id: string;
    generation: number;
  }): Promise<ActiveDeviceHttpCredential | null> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{
        public_key_spki_der: Buffer | Uint8Array;
      }>(
        `SELECT credential.public_key_spki_der
           FROM devices device
           JOIN users owner
             ON owner.id=device.owner_user_id
            AND owner.status='active'
           JOIN device_credentials credential
             ON credential.device_id=device.id
            AND credential.id=$2
            AND credential.generation=$3
            AND credential.state='active'
          WHERE device.id=$1
            AND device.lifecycle='active'
            AND device.current_generation=$3`,
        [input.device_id, input.credential_id, input.generation],
      );
      const row = result.rows[0];
      return row ? { public_key_spki_der: Buffer.from(row.public_key_spki_der) } : null;
    });
  }

  consumeRequestId(input: DeviceHttpReplayInput): Promise<"consumed" | "replayed" | "inactive"> {
    return this.transactions.transaction(async (sql) => {
      const active = await sql.query<{ present: boolean }>(
        `SELECT true AS present
           FROM devices device
           JOIN users owner
             ON owner.id=device.owner_user_id
            AND owner.status='active'
           JOIN device_credentials credential
             ON credential.device_id=device.id
            AND credential.id=$2
            AND credential.generation=$3
            AND credential.state='active'
          WHERE device.id=$1
            AND device.lifecycle='active'
            AND device.current_generation=$3
          FOR UPDATE OF device,credential`,
        [input.device_id, input.credential_id, input.generation],
      );
      if (!active.rows[0]) return "inactive";
      const inserted = await sql.query<{ request_id: string }>(
        `INSERT INTO device_http_request_replays (
           request_id,identity_kind,device_id,legacy_runner_id,
           credential_id,generation,purpose,
           request_timestamp,consumed_at
         ) VALUES ($1,'device',$2,NULL,$3,$4,$5,$6,$7)
         ON CONFLICT (request_id) DO NOTHING
         RETURNING request_id`,
        [
          input.request_id,
          input.device_id,
          input.credential_id,
          input.generation,
          input.purpose,
          input.request_timestamp,
          input.consumed_at,
        ],
      );
      return inserted.rows[0] ? "consumed" : "replayed";
    });
  }

  consumeLegacyRequestId(input: LegacyRunnerHttpReplayInput): Promise<"consumed" | "replayed"> {
    return this.transactions.transaction(async (sql) => {
      const inserted = await sql.query<{ request_id: string }>(
        `INSERT INTO device_http_request_replays (
           request_id,identity_kind,device_id,legacy_runner_id,
           credential_id,generation,purpose,
           request_timestamp,consumed_at
         ) VALUES ($1,'legacy_runner',NULL,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (request_id) DO NOTHING
         RETURNING request_id`,
        [
          input.request_id,
          input.runner_id,
          input.credential_id,
          input.generation,
          input.purpose,
          input.request_timestamp,
          input.consumed_at,
        ],
      );
      return inserted.rows[0] ? "consumed" : "replayed";
    });
  }
}

/**
 * Route-level pre-parser: hashes the exact bytes Fastify subsequently parses
 * without retaining a second body copy.
 */
export const captureRunnerHttpBodySha256: preParsingHookHandler = (
  request,
  _reply,
  payload,
  done,
) => {
  const digest = createHash("sha256");
  let receivedEncodedLength = 0;
  const hashingStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedEncodedLength += chunk.byteLength;
      digest.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      bodyDigests.set(request, digest.digest("hex"));
      callback();
    },
  }) as Transform & { receivedEncodedLength: number };
  Object.defineProperty(hashingStream, "receivedEncodedLength", {
    get: () => receivedEncodedLength,
  });
  payload.on("error", (error) => hashingStream.destroy(error));
  payload.pipe(hashingStream);
  done(null, hashingStream);
};

export function capturedRunnerHttpBodySha256(request: FastifyRequest): string {
  return bodyDigests.get(request) ?? EMPTY_HTTP_BODY_SHA256;
}
