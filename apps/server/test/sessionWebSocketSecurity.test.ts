import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { RunnerDaemon, RunnerStateFile } from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  type PGliteDatabaseLike,
  PGliteTransactionRunner,
} from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { RelationalIdentityService } from "../src/users/relationalIdentityService.js";
import { UserStore } from "../src/users/store.js";
import { type Stack, listen, startStack, waitFor } from "./helpers.js";

interface SessionSocket {
  socket: WebSocket;
  messages: Record<string, unknown>[];
}

interface CloseFrame {
  code: number;
  reason: string;
}

const sockets = new Set<WebSocket>();
let stack: Stack | null = null;
let relationalServer: NornsServer | null = null;
let relationalRunner: RunnerDaemon | null = null;
let relationalDatabase: PGlite | null = null;

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  relationalRunner?.stop();
  relationalRunner = null;
  await relationalServer?.app.close();
  relationalServer = null;
  if (relationalDatabase && !relationalDatabase.closed) await relationalDatabase.close();
  relationalDatabase = null;
  await stack?.stop();
  stack = null;
});

function sessionUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/session";
  url.search = "";
  return url.toString();
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function nextClose(socket: WebSocket): Promise<CloseFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timeout waiting for session socket close")),
      5_000,
    );
    socket.once("close", (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function connectSession(httpUrl: string, token: string): Promise<SessionSocket> {
  const socket = new WebSocket(sessionUrl(httpUrl));
  sockets.add(socket);
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (data) => {
    messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  await waitForOpen(socket);
  socket.send(JSON.stringify({ type: "auth", token }));
  await waitFor(() => messages.some((message) => message.type === "snapshot"), "session snapshot");
  return { socket, messages };
}

describe.sequential("browser session WebSocket security", () => {
  it("keeps the credential out of the URL and authenticates only from the first frame", async () => {
    stack = await startStack();
    const url = sessionUrl(stack.url);
    expect(new URL(url).search).toBe("");
    expect(url).not.toContain(stack.token);

    const session = await connectSession(stack.url, stack.token);
    expect(session.messages).toEqual([
      {
        type: "snapshot",
        runners: [{ runner_id: "runner-1", connected: true }],
      },
    ]);

    // A legacy query-string credential is deliberately ignored. A non-auth
    // first frame closes the connection without exposing a snapshot.
    const querySocket = new WebSocket(`${url}?token=${encodeURIComponent(stack.token)}`);
    sockets.add(querySocket);
    const queryMessages: unknown[] = [];
    querySocket.on("message", (data) => queryMessages.push(JSON.parse(data.toString())));
    const closed = nextClose(querySocket);
    await waitForOpen(querySocket);
    querySocket.send(JSON.stringify({ type: "observe" }));
    expect(await closed).toMatchObject({ code: 1008 });
    expect(queryMessages).toEqual([]);
  });

  it("closes the matching socket on HTTP logout before any later broadcast", async () => {
    stack = await startStack();
    const session = await connectSession(stack.url, stack.token);
    const closed = nextClose(session.socket);

    const response = await stack.api("/api/auth/logout", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await closed).toEqual({ code: 1008, reason: "session logged out" });

    const messageCount = session.messages.length;
    stack.daemon.stop();
    await waitFor(() => stack?.server.connectedRunners().length === 0, "runner disconnected");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(session.messages).toHaveLength(messageCount);
  });

  it("closes every socket for a user when the admin disable/remove route succeeds", async () => {
    stack = await startStack();
    const createdResponse = await stack.api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        email: "member@example.com",
        password: "member-password",
        role: "member",
      }),
    });
    expect(createdResponse.status).toBe(201);
    const member = (await createdResponse.json()) as { id: string };

    const loginResponse = await stack.api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "member@example.com", password: "member-password" }),
    });
    const memberToken = ((await loginResponse.json()) as { token: string }).token;
    const session = await connectSession(stack.url, memberToken);
    const secondSession = await connectSession(stack.url, memberToken);
    const closed = nextClose(session.socket);
    const secondClosed = nextClose(secondSession.socket);

    const disabled = await stack.api(`/api/admin/users/${member.id}`, { method: "DELETE" });
    expect(disabled.status).toBe(200);
    expect(await closed).toEqual({ code: 1008, reason: "account disabled" });
    expect(await secondClosed).toEqual({ code: 1008, reason: "account disabled" });

    const messageCount = session.messages.length;
    const secondMessageCount = secondSession.messages.length;
    stack.daemon.stop();
    await waitFor(() => stack?.server.connectedRunners().length === 0, "runner disconnected");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(session.messages).toHaveLength(messageCount);
    expect(secondSession.messages).toHaveLength(secondMessageCount);
  });

  it("revalidates relational sessions before broadcast and closes expired or revoked sockets", async () => {
    const pg = new PGlite();
    relationalDatabase = pg;
    await pg.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO norns_state (key, snapshot) VALUES
        ('users', '{"users":[],"sessions":[]}'::jsonb),
        ('projects', '{"projects":[]}'::jsonb),
        ('relay', '{"audit":[]}'::jsonb);
    `);
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);

    let currentTime = new Date("2026-07-16T20:00:00.000Z");
    let randomByte = 1;
    const identity = new RelationalIdentityService({
      transactions: new PGliteTransactionRunner(pg as unknown as PGliteDatabaseLike),
      credentialKey: { keyId: "ws-session-key", key: Buffer.alloc(32, 19) },
      clock: () => new Date(currentTime),
      newId: (kind) => `${kind}-ws-test`,
      randomBytes: (size) => Buffer.alloc(size, randomByte++),
      sessionTtlMs: 1_000,
    });
    await identity.createActive({
      email: "admin@example.com",
      password: "admin-password",
      role: "admin",
    });
    const expiringToken = (await identity.login("admin@example.com", "admin-password")).token;
    const revokedToken = (await identity.login("admin@example.com", "admin-password")).token;

    const relayStores = new RelayStores();
    relationalServer = await buildServer({
      stores: relayStores,
      users: new UserStore(),
      identity,
    });
    const url = await listen(relationalServer);
    // POLISH P1: the pairing HTTP front door is gone; mint the runner identity
    // by registering its public key directly and seeding the daemon's state.
    const dataDir = mkdtempSync(join(tmpdir(), "norns-ws-session-"));
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const record = relayStores.registerRunner(
      "relational-runner",
      publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    new RunnerStateFile(dataDir, {
      runner_id: "relational-runner",
      private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      generation: record.generation,
    });
    relationalRunner = new RunnerDaemon({
      serverUrl: url,
      runnerId: "relational-runner",
      dataDir,
      heartbeatMs: 500,
      reconnectDelayMs: 100,
    });
    relationalRunner.loadState();
    relationalRunner.connect();
    await waitFor(
      () => relationalServer?.connectedRunners().includes("relational-runner") === true,
      "relational runner connected",
    );

    const expiredSession = await connectSession(url, expiringToken);
    const revokedSession = await connectSession(url, revokedToken);
    const expiredClose = nextClose(expiredSession.socket);
    const revokedClose = nextClose(revokedSession.socket);

    await identity.logout(revokedToken);
    currentTime = new Date("2026-07-16T20:00:02.000Z");
    relationalRunner.stop();

    await expect(expiredClose).resolves.toMatchObject({ code: 1008 });
    await expect(revokedClose).resolves.toMatchObject({ code: 1008 });
    expect(expiredSession.messages).toHaveLength(1);
    expect(revokedSession.messages).toHaveLength(1);
  });
});
