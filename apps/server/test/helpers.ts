import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerDaemon, RunnerStateFile } from "@norns/runner";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";

/** A real session token for a seeded test admin — real accounts replaced
 *  the old shared deploy token as the day-to-day session credential. */
export function testAdminToken(users: UserStore): string {
  users.createActive({
    email: "test-admin@example.com",
    password: "test-password-1",
    role: "admin",
  });
  return users.login("test-admin@example.com", "test-password-1").token;
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

export interface Stack {
  server: NornsServer;
  url: string;
  daemon: RunnerDaemon;
  dataDir: string;
  /** The live store the server was built over, for observing runner state
   *  directly now that the read-only HTTP runner inventory is gone. */
  stores: RelayStores;
  api: (path: string, init?: RequestInit) => Promise<Response>;
  issue: (payload: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<string>;
  stop: () => Promise<void>;
  /** The seeded test admin's live session — reuse `users` (not a fresh
   *  UserStore) when a test needs to build a second server instance (e.g.
   *  simulating a restart) that should still accept `token`. */
  users: UserStore;
  token: string;
}

export async function listen(server: NornsServer): Promise<string> {
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.app.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

export async function startStack(runnerId = "runner-1"): Promise<Stack> {
  const stores = new RelayStores();
  const users = new UserStore();
  const token = testAdminToken(users);
  const server = await buildServer({ stores, users });
  const url = await listen(server);

  const api = (path: string, init?: RequestInit) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        // content-type only with a body: Fastify 400s an empty JSON body
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });

  // POLISH P1: the pairing HTTP front door was removed with the local-runner
  // install surface. Tests mint a runner identity the same way production now
  // does at its core — an Ed25519 public key registered against the store —
  // and seed the daemon's state file with the private half. Everything after
  // that (challenge, signed auth, reconcile) runs over the real relay.
  const dataDir = mkdtempSync(join(tmpdir(), "norns-runner-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const record = stores.registerRunner(
    runnerId,
    publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  new RunnerStateFile(dataDir, {
    runner_id: runnerId,
    private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    generation: record.generation,
  });
  const daemon = new RunnerDaemon({
    serverUrl: url,
    runnerId,
    dataDir,
    heartbeatMs: 500,
    reconnectDelayMs: 100,
  });
  daemon.loadState();
  daemon.connect();
  await waitFor(() => server.connectedRunners().includes(runnerId), "runner connected");

  const issue = async (
    payload: Record<string, unknown>,
    extra?: Record<string, unknown>,
  ): Promise<string> => {
    const res = await api("/api/commands", {
      method: "POST",
      body: JSON.stringify({ runner_id: runnerId, payload, ...(extra ?? {}) }),
    });
    const body = (await res.json()) as { command_id?: string; error?: string };
    if (!body.command_id) throw new Error(`command rejected: ${body.error}`);
    return body.command_id;
  };

  return {
    server,
    url,
    daemon,
    dataDir,
    stores,
    api,
    issue,
    users,
    token,
    stop: async () => {
      daemon.stop();
      await server.app.close();
    },
  };
}

export async function commandState(stack: Stack, commandId: string): Promise<string> {
  const res = await stack.api(`/api/commands/${commandId}`);
  const body = (await res.json()) as { state: string };
  return body.state;
}
