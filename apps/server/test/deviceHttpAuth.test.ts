import { createHash, generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE,
  DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE,
  DEVICE_PUBLICATION_PERMIT_CONSUME_HTTP_SIGNATURE_PURPOSE,
  DEVICE_PUBLICATION_PERMIT_ISSUE_HTTP_SIGNATURE_PURPOSE,
  DEVICE_REPOSITORY_REGISTRATION_HTTP_SIGNATURE_PURPOSE,
  DEVICE_REPOSITORY_REGISTRATION_REVOCATION_HTTP_SIGNATURE_PURPOSE,
} from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  devicePrivateKeySigner,
  privateKeySigner,
  signRunnerHttpRequest,
} from "../../runner/src/contextAuth.js";
import {
  type DeviceHttpAuthRequest,
  DeviceHttpRequestAuthenticator,
  PostgresDeviceHttpCredentialRepository,
} from "../src/execution/deviceHttpAuth.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const NOW = new Date("2026-07-29T18:00:00.000Z");
const DEVICE_ID = "device-http-1";
const CREDENTIAL_ID = "credential-http-1";

describe.sequential("device HTTP signed transcript", () => {
  let pg: PGlite;
  let repository: PostgresDeviceHttpCredentialRepository;
  let authenticator: DeviceHttpRequestAuthenticator;
  let publicKeyPem: string;
  let privateKeyPem: string;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    const pair = generateKeyPairSync("ed25519");
    publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    privateKeyPem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" });
    const fingerprint = createHash("sha256").update(publicKeyDer).digest("hex");
    await pg.query(
      `INSERT INTO users (
         id,username,display_name,email,name,password_hash,password_hash_scheme,role,status,source
       ) VALUES (
         'device-owner','owner@example.com','Owner','owner@example.com','Owner',
         'hash','scrypt-v1','member','active','native'
       )`,
    );
    await pg.query(
      `INSERT INTO devices (
         id,owner_user_id,display_name,os_family,architecture,lifecycle,current_generation
       ) VALUES ($1,'device-owner','HTTP device','linux','x86_64','active',0)`,
      [DEVICE_ID],
    );
    await pg.query(
      `INSERT INTO device_credentials (
         id,device_id,generation,public_key_spki_der,public_key_fingerprint,state
       ) VALUES ($1,$2,1,$3,$4,'active')`,
      [CREDENTIAL_ID, DEVICE_ID, publicKeyDer, fingerprint],
    );
    repository = new PostgresDeviceHttpCredentialRepository(new PGliteTransactionRunner(pg));
    authenticator = strictAuthenticator();
  }, 30_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  function strictAuthenticator(): DeviceHttpRequestAuthenticator {
    return new DeviceHttpRequestAuthenticator({
      repository,
      legacyCompatibility: { enabled: false },
      now: () => new Date(NOW),
    });
  }

  function signedRequest(input: {
    purpose?:
      | typeof DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE
      | typeof DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE
      | typeof DEVICE_REPOSITORY_REGISTRATION_HTTP_SIGNATURE_PURPOSE
      | typeof DEVICE_REPOSITORY_REGISTRATION_REVOCATION_HTTP_SIGNATURE_PURPOSE
      | typeof DEVICE_PUBLICATION_PERMIT_ISSUE_HTTP_SIGNATURE_PURPOSE
      | typeof DEVICE_PUBLICATION_PERMIT_CONSUME_HTTP_SIGNATURE_PURPOSE;
    url?: URL;
    body?: string;
    method?: string;
    requestId?: string;
    generation?: number;
    credentialId?: string;
  }): DeviceHttpAuthRequest {
    const purpose = input.purpose ?? DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE;
    const url = input.url ?? new URL("https://norns.example/api/execution/context/document-1");
    const method = input.method ?? "GET";
    const identity = devicePrivateKeySigner({
      deviceId: DEVICE_ID,
      credentialId: input.credentialId ?? CREDENTIAL_ID,
      generation: input.generation ?? 1,
      privateKeyPem,
    });
    const signed = signRunnerHttpRequest({
      identity,
      purpose,
      method,
      url,
      ...(input.body === undefined ? {} : { body: input.body }),
      timestamp: NOW.toISOString(),
      requestId: input.requestId ?? "request-http-1",
    });
    return {
      purpose,
      method,
      path_and_query: `${url.pathname}${url.search}`,
      routed_path: url.pathname,
      body_sha256: signed.body_sha256,
      headers: signed.headers,
    };
  }

  it("consumes a valid request id once and rejects it after a new verifier is constructed", async () => {
    const request = signedRequest({});
    await expect(authenticator.authenticate(request)).resolves.toMatchObject({
      ok: true,
      identity: {
        kind: "device",
        device_id: DEVICE_ID,
        credential_id: CREDENTIAL_ID,
        generation: 1,
      },
    });
    await expect(strictAuthenticator().authenticate(request)).resolves.toEqual({
      ok: false,
      reason: "replayed_request",
    });
    const stored = await pg.query<{
      request_id: string;
      purpose: string;
      device_id: string;
      credential_id: string;
      generation: number | string;
    }>(
      "SELECT request_id,purpose,device_id,credential_id,generation FROM device_http_request_replays",
    );
    expect(stored.rows[0]).toMatchObject({
      request_id: "request-http-1",
      purpose: DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE,
      device_id: DEVICE_ID,
      credential_id: CREDENTIAL_ID,
    });
    expect(Number(stored.rows[0]?.generation)).toBe(1);
  });

  it.each([
    DEVICE_REPOSITORY_REGISTRATION_HTTP_SIGNATURE_PURPOSE,
    DEVICE_REPOSITORY_REGISTRATION_REVOCATION_HTTP_SIGNATURE_PURPOSE,
    DEVICE_PUBLICATION_PERMIT_ISSUE_HTTP_SIGNATURE_PURPOSE,
    DEVICE_PUBLICATION_PERMIT_CONSUME_HTTP_SIGNATURE_PURPOSE,
  ])("persists the newer signed Local Agent purpose %s", async (purpose) => {
    const request = signedRequest({
      purpose,
      method: "POST",
      body: "{}",
      requestId: `request-${purpose.split(".").at(-2)}`,
    });
    await expect(authenticator.authenticate(request)).resolves.toMatchObject({ ok: true });
    const stored = await pg.query<{ purpose: string }>(
      "SELECT purpose FROM device_http_request_replays WHERE request_id=$1",
      [request.headers["x-norns-request-id"]],
    );
    expect(stored.rows[0]?.purpose).toBe(purpose);
  });

  it("binds the method, canonical query, exact body digest, and current generation", async () => {
    const body = JSON.stringify({ run_id: "run-http-1" });
    const url = new URL(
      "https://norns.example/api/execution/gateway/credentials?attempt=1&mode=fast",
    );
    const original = signedRequest({
      purpose: DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE,
      url,
      method: "POST",
      body,
      requestId: "request-http-body",
    });

    await expect(
      authenticator.authenticate({
        ...original,
        method: "PUT",
      }),
    ).resolves.toEqual({ ok: false, reason: "bad_signature" });
    await expect(
      authenticator.authenticate({
        ...original,
        path_and_query: "/api/execution/gateway/credentials?attempt=2&mode=fast",
      }),
    ).resolves.toEqual({ ok: false, reason: "bad_signature" });
    await expect(
      authenticator.authenticate({
        ...original,
        body_sha256: createHash("sha256")
          .update(JSON.stringify({ run_id: "run-http-2" }))
          .digest("hex"),
      }),
    ).resolves.toEqual({ ok: false, reason: "bad_signature" });

    await expect(
      authenticator.authenticate(
        signedRequest({
          purpose: DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE,
          url,
          method: "POST",
          body,
          requestId: "request-http-generation",
          generation: 2,
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "inactive_credential" });
    await expect(authenticator.authenticate(original)).resolves.toMatchObject({ ok: true });
  });

  it("accepts normalized unreserved escapes and sorted query pairs when routing selects that path", async () => {
    const canonicalUrl = new URL(
      "https://norns.example/api/execution/context/document-A?z=last&a=first",
    );
    const request = signedRequest({
      url: canonicalUrl,
      requestId: "request-http-normalized",
    });
    await expect(
      authenticator.authenticate({
        ...request,
        path_and_query: "/api/execution/context/document-%41?z=last&a=first",
        routed_path: "/api/execution/context/document-A",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it.each([
    {
      label: "different routed path",
      path_and_query: "/api/execution/context/document-1",
      routed_path: "/api/execution/context/document-2",
    },
    {
      label: "encoded dot segment changed by routing",
      path_and_query: "/api/execution/context/safe/%2e%2e/document-1",
      routed_path: "/api/execution/context/safe/../document-1",
    },
    {
      label: "duplicate decoded query name",
      path_and_query: "/api/execution/context/document-1?a=1&%61=2",
      routed_path: "/api/execution/context/document-1",
    },
    {
      label: "empty query pair",
      path_and_query: "/api/execution/context/document-1?a=1&&b=2",
      routed_path: "/api/execution/context/document-1",
    },
    {
      label: "semicolon query separator",
      path_and_query: "/api/execution/context/document-1?a=1;b=2",
      routed_path: "/api/execution/context/document-1",
    },
    {
      label: "malformed percent-encoded UTF-8",
      path_and_query: "/api/execution/context/document-1?a=%C3%28",
      routed_path: "/api/execution/context/document-1",
    },
  ])("rejects $label before signature acceptance", async ({ path_and_query, routed_path }) => {
    const request = signedRequest({
      requestId: `request-http-route-${createHash("sha256")
        .update(path_and_query)
        .digest("hex")
        .slice(0, 16)}`,
    });
    await expect(
      authenticator.authenticate({ ...request, path_and_query, routed_path }),
    ).resolves.toEqual({
      ok: false,
      reason: "malformed_credentials",
    });
  });

  it("domain-separates endpoints and rejects request-id reuse across purposes", async () => {
    const context = signedRequest({ requestId: "request-http-cross-purpose" });
    await expect(
      authenticator.authenticate({
        ...context,
        purpose: DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE,
      }),
    ).resolves.toEqual({ ok: false, reason: "bad_signature" });
    await expect(authenticator.authenticate(context)).resolves.toMatchObject({ ok: true });

    const gatewayBody = JSON.stringify({ run_id: "run-http-1" });
    const gateway = signedRequest({
      purpose: DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE,
      url: new URL("https://norns.example/api/execution/gateway/credentials"),
      method: "POST",
      body: gatewayBody,
      requestId: "request-http-cross-purpose",
    });
    await expect(authenticator.authenticate(gateway)).resolves.toEqual({
      ok: false,
      reason: "replayed_request",
    });
  });

  it("accepts legacy runner signatures only when the named compatibility gate is enabled", async () => {
    const url = new URL("https://norns.example/api/execution/context/document-1");
    const identity = privateKeySigner("legacy-runner-1", privateKeyPem, 7);
    const signed = signRunnerHttpRequest({
      identity,
      purpose: DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE,
      method: "GET",
      url,
      timestamp: NOW.toISOString(),
    });
    const request: DeviceHttpAuthRequest = {
      purpose: DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE,
      method: "GET",
      path_and_query: url.pathname,
      routed_path: url.pathname,
      body_sha256: signed.body_sha256,
      headers: signed.headers,
    };
    await expect(authenticator.authenticate(request)).resolves.toEqual({
      ok: false,
      reason: "legacy_disabled",
    });

    const compatibility = new DeviceHttpRequestAuthenticator({
      repository,
      legacyCompatibility: {
        enabled: true,
        lookupRunner: (runnerId) =>
          runnerId === "legacy-runner-1" ? { public_key_pem: publicKeyPem, generation: 7 } : null,
      },
      now: () => new Date(NOW),
    });
    await expect(compatibility.authenticate(request)).resolves.toEqual({
      ok: true,
      identity: {
        kind: "legacy_runner",
        runner_id: "legacy-runner-1",
        generation: 7,
        authorization_subject_id: "legacy-runner-1",
      },
    });
    await expect(compatibility.authenticate(request)).resolves.toEqual({
      ok: false,
      reason: "replayed_request",
    });
  });
});
