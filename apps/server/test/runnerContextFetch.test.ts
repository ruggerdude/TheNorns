// EXECUTION E3 (for phase E1) — the runner must be able to fetch its own prompt.
//
// THE BUG: `SignedUrlContentFetcher` sent no credentials. Against an
// authenticated context route every fetch 401s, the coding agent gets an empty
// prompt, and the run is dead before it starts. E1 could not install the fix
// because apps/runner is outside its ownership; E3 owns it.
//
// These tests deliberately avoid mocking the transport. A real HTTP server
// listens on a real socket; a real Ed25519 keypair — the same one the runner
// uses for the relay handshake, loaded through the real RunnerDaemon — signs
// the real request; and the server verifies with the server's own
// `verifyRunnerSignature`, the same primitive the relay uses. Mocks have
// hidden dead paths in this codebase before; the whole point of this test is
// that bytes actually move.
import { generateKeyPairSync } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE,
  legacyRunnerHttpCredentialId,
  serializeSignedDeviceHttpTranscript,
} from "@norns/contracts";
import {
  DEVICE_HTTP_CREDENTIAL_ID_HEADER,
  DEVICE_HTTP_DEVICE_ID_HEADER,
  DEVICE_HTTP_GENERATION_HEADER,
  DEVICE_HTTP_REQUEST_ID_HEADER,
  DEVICE_HTTP_TIMESTAMP_HEADER,
  HashVerifiedContextLoader,
  LEGACY_RUNNER_HTTP_AUTHORIZATION_SCHEME,
  RunnerDaemon,
  RunnerSignedContextFetcher,
  RunnerStateFile,
  SignedUrlContentFetcher,
  privateKeySigner,
  signRunnerHttpRequest,
} from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeviceHttpRequestAuthenticator,
  EMPTY_HTTP_BODY_SHA256,
  type LegacyRunnerHttpReplayInput,
} from "../src/execution/index.js";

const SKEW_MS = 5 * 60 * 1000;
const DOCUMENT = "You are implementing TRK-014. The failing test is in apps/server/test.";

function newKeypair(): { publicPem: string; privatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/**
 * A faithful stand-in for E1's context route: it enforces exactly the scheme
 * the runner client implements, using the server's real verifier. If the two
 * halves ever disagree about the canonical payload, this fails.
 */
interface RegisteredRunner {
  publicKeyPem: string;
  generation: number;
}

function startContextServer(registry: ReadonlyMap<string, RegisteredRunner>): Promise<{
  server: Server;
  origin: string;
  attempts: { runnerId: string | undefined; status: number }[];
}> {
  const attempts: { runnerId: string | undefined; status: number }[] = [];
  const consumedRequestIds = new Set<string>();
  const authenticator = new DeviceHttpRequestAuthenticator({
    repository: {
      activeCredential: async () => null,
      consumeRequestId: async () => "inactive",
      consumeLegacyRequestId: async (input: LegacyRunnerHttpReplayInput) => {
        if (consumedRequestIds.has(input.request_id)) return "replayed";
        consumedRequestIds.add(input.request_id);
        return "consumed";
      },
    },
    legacyCompatibility: {
      enabled: true,
      lookupRunner: (runnerId) => {
        const runner = registry.get(runnerId);
        return runner
          ? {
              public_key_pem: runner.publicKeyPem,
              generation: runner.generation,
            }
          : null;
      },
    },
  });
  const server = createServer(async (req, res) => {
    const runnerId = req.headers[DEVICE_HTTP_DEVICE_ID_HEADER] as string | undefined;
    const finish = (status: number, body: string) => {
      attempts.push({ runnerId, status });
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(body);
    };
    const auth = await authenticator.authenticate({
      purpose: DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE,
      method: req.method ?? "GET",
      path_and_query: req.url ?? "/",
      routed_path: (req.url ?? "/").split("?", 1)[0] ?? "/",
      body_sha256: EMPTY_HTTP_BODY_SHA256,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    if (!auth.ok) return finish(401, "unauthorized");
    return finish(200, DOCUMENT);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve({ server, origin: `http://127.0.0.1:${address.port}`, attempts });
    });
  });
}

function reference(origin: string) {
  const bytes = Buffer.from(DOCUMENT, "utf8");
  return {
    artifact_id: "artifact:context-1",
    storage_ref: `${origin}/api/v2/runs/run-1/context/artifact:context-1`,
    content_hash: createHash("sha256").update(bytes).digest("hex"),
    byte_size: bytes.byteLength,
  };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function harness() {
  const registry = new Map<string, RegisteredRunner>();
  const { server, origin, attempts } = await startContextServer(registry);
  cleanup.push(() => server.close());
  return { registry, origin, attempts };
}

describe("the runner fetches its context document with a signed request", () => {
  it("retrieves the REAL document over HTTP using the daemon's relay keypair", async () => {
    const { registry, origin, attempts } = await harness();

    // A real runner identity, loaded through the real daemon, exactly as an
    // ephemeral Actions runner holds it after `enroll()`.
    const dataDir = mkdtempSync(join(tmpdir(), "norns-ctx-"));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const { publicPem, privatePem } = newKeypair();
    new RunnerStateFile(dataDir, {
      runner_id: "actions:project-1",
      private_key_pem: privatePem,
      generation: 7,
    });
    registry.set("actions:project-1", { publicKeyPem: publicPem, generation: 7 });
    const daemon = new RunnerDaemon({ serverUrl: origin, runnerId: "actions:project-1", dataDir });
    daemon.loadState();

    const loader = new HashVerifiedContextLoader(
      new RunnerSignedContextFetcher({
        mode: "legacy_runner",
        runnerId: "actions:project-1",
        generation: 7,
        sign: (payload) => daemon.sign(payload),
      }),
    );
    // load() also verifies size and sha256, so a 200 carrying the wrong bytes
    // would fail here too.
    const prompt = await loader.load([reference(origin)]);

    expect(prompt).toBe(DOCUMENT);
    expect(attempts).toEqual([{ runnerId: "actions:project-1", status: 200 }]);
  });

  it("REGRESSION: the old anonymous fetcher gets a 401 — this was the blocker", async () => {
    const { origin, attempts } = await harness();
    const loader = new HashVerifiedContextLoader(new SignedUrlContentFetcher());
    await expect(loader.load([reference(origin)])).rejects.toThrow(/context fetch failed with 401/);
    expect(attempts).toEqual([{ runnerId: undefined, status: 401 }]);
  });

  it("refuses a runner signing with a key the server does not hold for it", async () => {
    const { registry, origin } = await harness();
    const legitimate = newKeypair();
    const attacker = newKeypair();
    registry.set("runner-a", { publicKeyPem: legitimate.publicPem, generation: 1 });

    const loader = new HashVerifiedContextLoader(
      new RunnerSignedContextFetcher(privateKeySigner("runner-a", attacker.privatePem, 1)),
    );
    await expect(loader.load([reference(origin)])).rejects.toThrow(/failed with 401/);
  });

  it("refuses a runner id that is not registered at all", async () => {
    const { origin } = await harness();
    const { privatePem } = newKeypair();
    const loader = new HashVerifiedContextLoader(
      new RunnerSignedContextFetcher(privateKeySigner("runner-unknown", privatePem, 1)),
    );
    await expect(loader.load([reference(origin)])).rejects.toThrow(/failed with 401/);
  });

  it("bounds replay: a signature minted outside the skew window is refused", async () => {
    const { registry, origin } = await harness();
    const { publicPem, privatePem } = newKeypair();
    registry.set("runner-a", { publicKeyPem: publicPem, generation: 1 });
    const stale = new Date(Date.now() - SKEW_MS - 60_000);
    const loader = new HashVerifiedContextLoader(
      new RunnerSignedContextFetcher(privateKeySigner("runner-a", privatePem, 1), () => stale),
    );
    await expect(loader.load([reference(origin)])).rejects.toThrow(/failed with 401/);
  });

  it("binds the signature to the path, so it cannot be reused for another document", async () => {
    const { registry, origin } = await harness();
    const { publicPem, privatePem } = newKeypair();
    registry.set("runner-a", { publicKeyPem: publicPem, generation: 1 });
    const identity = privateKeySigner("runner-a", privatePem, 1);
    const issuedAt = new Date().toISOString();

    // A signature legitimately minted for document A...
    const signed = signRunnerHttpRequest({
      identity,
      purpose: DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE,
      method: "GET",
      url: new URL(`${origin}/api/v2/runs/run-1/context/artifact:A`),
      timestamp: issuedAt,
    });
    // ...presented for document B.
    const response = await fetch(`${origin}/api/v2/runs/run-1/context/artifact:B`, {
      headers: signed.headers,
    });
    expect(response.status).toBe(401);
  });

  it("is domain-separated: a bare relay-style signature is not a context credential", async () => {
    const { registry, origin } = await harness();
    const { publicPem, privatePem } = newKeypair();
    registry.set("runner-a", { publicKeyPem: publicPem, generation: 1 });
    const issuedAt = new Date().toISOString();
    // The relay handshake signs a bare nonce with no domain prefix. If the
    // context route accepted that shape, a captured relay challenge response
    // could be replayed here.
    const relayStyle = privateKeySigner("runner-a", privatePem, 1).sign(issuedAt);
    const response = await fetch(`${origin}/api/v2/runs/run-1/context/artifact:A`, {
      headers: {
        authorization: `${LEGACY_RUNNER_HTTP_AUTHORIZATION_SCHEME} ${relayStyle}`,
        [DEVICE_HTTP_DEVICE_ID_HEADER]: "runner-a",
        [DEVICE_HTTP_CREDENTIAL_ID_HEADER]: legacyRunnerHttpCredentialId("runner-a", 1),
        [DEVICE_HTTP_GENERATION_HEADER]: "1",
        [DEVICE_HTTP_TIMESTAMP_HEADER]: issuedAt,
        [DEVICE_HTTP_REQUEST_ID_HEADER]: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(response.status).toBe(401);
  });
});

describe("the canonical payload", () => {
  it("is domain-separated and binds the full request", () => {
    expect(
      serializeSignedDeviceHttpTranscript({
        purpose: DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE,
        device_id: "runner-a",
        credential_id: legacyRunnerHttpCredentialId("runner-a", 1),
        generation: 1,
        http_method: "GET",
        canonical_path_and_query: "/api/v2/runs/run-1/context/a?part=1",
        body_sha256: EMPTY_HTTP_BODY_SHA256,
        timestamp: "2026-07-21T00:00:00.000Z",
        request_id: "11111111-1111-4111-8111-111111111111",
      }),
    ).toBe(
      '{"purpose":"norns.runner-http.context-retrieval.v1","device_id":"runner-a","credential_id":"legacy-runner:runner-a:generation:1","generation":1,"http_method":"GET","canonical_path_and_query":"/api/v2/runs/run-1/context/a?part=1","body_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","timestamp":"2026-07-21T00:00:00.000Z","request_id":"11111111-1111-4111-8111-111111111111"}',
    );
  });
});
