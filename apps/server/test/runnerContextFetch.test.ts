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
  HashVerifiedContextLoader,
  RUNNER_AUTHORIZATION_SCHEME,
  RUNNER_ID_HEADER,
  RUNNER_TIMESTAMP_HEADER,
  RunnerDaemon,
  RunnerSignedContextFetcher,
  RunnerStateFile,
  SignedUrlContentFetcher,
  privateKeySigner,
  runnerContextFetchPayload,
} from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRunnerSignature } from "../src/auth.js";

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
function startContextServer(registry: ReadonlyMap<string, string>): Promise<{
  server: Server;
  origin: string;
  attempts: { runnerId: string | undefined; status: number }[];
}> {
  const attempts: { runnerId: string | undefined; status: number }[] = [];
  const server = createServer((req, res) => {
    const runnerId = req.headers[RUNNER_ID_HEADER] as string | undefined;
    const timestamp = req.headers[RUNNER_TIMESTAMP_HEADER] as string | undefined;
    const authorization = req.headers.authorization;
    const finish = (status: number, body: string) => {
      attempts.push({ runnerId, status });
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(body);
    };
    if (!runnerId || !timestamp || !authorization?.startsWith(`${RUNNER_AUTHORIZATION_SCHEME} `)) {
      return finish(401, "unauthorized");
    }
    const publicKeyPem = registry.get(runnerId);
    if (!publicKeyPem) return finish(401, "unauthorized");
    const issued = Date.parse(timestamp);
    if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > SKEW_MS) {
      return finish(401, "unauthorized");
    }
    const payload = runnerContextFetchPayload({
      method: req.method ?? "GET",
      path: new URL(req.url ?? "/", "http://127.0.0.1").pathname,
      runnerId,
      issuedAt: timestamp,
    });
    const signature = authorization.slice(`${RUNNER_AUTHORIZATION_SCHEME} `.length);
    if (!verifyRunnerSignature(publicKeyPem, payload, signature)) {
      return finish(401, "unauthorized");
    }
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
  const registry = new Map<string, string>();
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
    registry.set("actions:project-1", publicPem);
    const daemon = new RunnerDaemon({ serverUrl: origin, runnerId: "actions:project-1", dataDir });
    daemon.loadState();

    const loader = new HashVerifiedContextLoader(
      new RunnerSignedContextFetcher({
        runnerId: "actions:project-1",
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
    registry.set("runner-a", legitimate.publicPem);

    const loader = new HashVerifiedContextLoader(
      new RunnerSignedContextFetcher(privateKeySigner("runner-a", attacker.privatePem)),
    );
    await expect(loader.load([reference(origin)])).rejects.toThrow(/failed with 401/);
  });

  it("refuses a runner id that is not registered at all", async () => {
    const { origin } = await harness();
    const { privatePem } = newKeypair();
    const loader = new HashVerifiedContextLoader(
      new RunnerSignedContextFetcher(privateKeySigner("runner-unknown", privatePem)),
    );
    await expect(loader.load([reference(origin)])).rejects.toThrow(/failed with 401/);
  });

  it("bounds replay: a signature minted outside the skew window is refused", async () => {
    const { registry, origin } = await harness();
    const { publicPem, privatePem } = newKeypair();
    registry.set("runner-a", publicPem);
    const stale = new Date(Date.now() - SKEW_MS - 60_000);
    const loader = new HashVerifiedContextLoader(
      new RunnerSignedContextFetcher(privateKeySigner("runner-a", privatePem), () => stale),
    );
    await expect(loader.load([reference(origin)])).rejects.toThrow(/failed with 401/);
  });

  it("binds the signature to the path, so it cannot be reused for another document", async () => {
    const { registry, origin } = await harness();
    const { publicPem, privatePem } = newKeypair();
    registry.set("runner-a", publicPem);
    const identity = privateKeySigner("runner-a", privatePem);
    const issuedAt = new Date().toISOString();

    // A signature legitimately minted for document A...
    const signature = identity.sign(
      runnerContextFetchPayload({
        method: "GET",
        path: "/api/v2/runs/run-1/context/artifact:A",
        runnerId: "runner-a",
        issuedAt,
      }),
    );
    // ...presented for document B.
    const response = await fetch(`${origin}/api/v2/runs/run-1/context/artifact:B`, {
      headers: {
        authorization: `${RUNNER_AUTHORIZATION_SCHEME} ${signature}`,
        [RUNNER_ID_HEADER]: "runner-a",
        [RUNNER_TIMESTAMP_HEADER]: issuedAt,
      },
    });
    expect(response.status).toBe(401);
  });

  it("is domain-separated: a bare relay-style signature is not a context credential", async () => {
    const { registry, origin } = await harness();
    const { publicPem, privatePem } = newKeypair();
    registry.set("runner-a", publicPem);
    const issuedAt = new Date().toISOString();
    // The relay handshake signs a bare nonce with no domain prefix. If the
    // context route accepted that shape, a captured relay challenge response
    // could be replayed here.
    const relayStyle = privateKeySigner("runner-a", privatePem).sign(issuedAt);
    const response = await fetch(`${origin}/api/v2/runs/run-1/context/artifact:A`, {
      headers: {
        authorization: `${RUNNER_AUTHORIZATION_SCHEME} ${relayStyle}`,
        [RUNNER_ID_HEADER]: "runner-a",
        [RUNNER_TIMESTAMP_HEADER]: issuedAt,
      },
    });
    expect(response.status).toBe(401);
  });
});

describe("the canonical payload", () => {
  it("is domain-separated and field-delimited", () => {
    expect(
      runnerContextFetchPayload({
        method: "get",
        path: "/api/v2/runs/run-1/context/a",
        runnerId: "runner-a",
        issuedAt: "2026-07-21T00:00:00.000Z",
      }),
      // EXECUTION E9 — NEWLINE, not "|". This assertion previously pinned the
      // runner's own spelling, which the server has never accepted: its
      // verifier joins with "\n" and reads `x-norns-runner-timestamp`, so
      // every real context fetch 401'd. The two halves now share one canonical
      // form, asserted directly against the server's function in
      // gatewayCredentialAuth.test.ts.
    ).toBe(
      "norns:runner-context-fetch:v1\nGET\n/api/v2/runs/run-1/context/a\nrunner-a\n2026-07-21T00:00:00.000Z",
    );
  });
});
