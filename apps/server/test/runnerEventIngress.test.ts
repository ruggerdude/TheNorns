import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen, testAdminToken, waitFor } from "./helpers.js";

describe.sequential("runner event ingress fencing", () => {
  let server: NornsServer;
  let stores: RelayStores;
  let url: string;
  let token: string;
  const sockets = new Set<WebSocket>();

  beforeEach(async () => {
    const users = new UserStore();
    token = testAdminToken(users);
    stores = new RelayStores();
    server = await buildServer({ stores, users });
    url = await listen(server);
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    await server.app.close();
  });

  const api = (path: string, init?: RequestInit) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
    });

  // POLISH P1: the pairing HTTP front door is gone; a runner identity is
  // minted by registering its public key directly, exactly the primitive the
  // Actions enrollment route calls after validating its token.
  function pair(runnerId: string): { generation: number; privateKey: KeyObject } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const record = stores.registerRunner(
      runnerId,
      publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    return { generation: record.generation, privateKey };
  }

  async function connect(
    runnerId: string,
    privateKey: KeyObject,
    generation: number,
    reconcile: boolean,
  ): Promise<WebSocket> {
    const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws/runner`);
    sockets.add(socket);
    let ready = false;
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { type: string; nonce?: string };
      if (frame.type === "challenge" && frame.nonce) {
        socket.send(
          JSON.stringify({
            type: "auth",
            runner_id: runnerId,
            nonce_signature: sign(null, Buffer.from(frame.nonce), privateKey).toString("base64"),
          }),
        );
      } else if (frame.type === "auth_ok") {
        if (reconcile) {
          socket.send(
            JSON.stringify({
              type: "reconcile_request",
              body: {
                protocol: 1,
                runner_id: runnerId,
                generation,
                capabilities: ["workspace_picker"],
                last_event_seq_sent: 0,
                recently_executed_command_ids: [],
              },
            }),
          );
        } else {
          ready = true;
        }
      } else if (frame.type === "reconcile_response") {
        ready = true;
      }
    });
    await waitFor(() => ready, reconcile ? "runner reconciliation" : "runner authentication");
    return socket;
  }

  function heartbeat(runnerId: string, generation: number) {
    return {
      type: "event",
      event: {
        protocol: 1,
        event_seq: 1,
        runner_id: runnerId,
        generation,
        correlation_id: "event-ingress-test",
        causation_id: null,
        occurred_at: new Date().toISOString(),
        payload: { kind: "heartbeat" },
      },
    };
  }

  async function expectRejected(socket: WebSocket, runnerId: string): Promise<void> {
    let closed = false;
    socket.once("close", () => {
      closed = true;
    });
    await waitFor(() => closed, "rejected runner socket close");
    const events = (await (await api(`/api/events/${runnerId}`)).json()) as unknown[];
    expect(events).toEqual([]);
  }

  it("rejects an event from an authenticated socket that skipped reconciliation", async () => {
    const identity = pair("runner-auth-only");
    const socket = await connect(
      "runner-auth-only",
      identity.privateKey,
      identity.generation,
      false,
    );
    const rejected = expectRejected(socket, "runner-auth-only");
    socket.send(JSON.stringify(heartbeat("runner-auth-only", identity.generation)));
    await rejected;
  });

  it("rejects a reconciled runner that submits another runner's event", async () => {
    const first = pair("runner-first");
    const second = pair("runner-second");
    const socket = await connect("runner-first", first.privateKey, first.generation, true);
    const rejected = expectRejected(socket, "runner-second");
    socket.send(JSON.stringify(heartbeat("runner-second", second.generation)));
    await rejected;
  });

  it("rejects a revoked key that learns the new generation but skips reconciliation", async () => {
    const identity = pair("runner-revoked");
    const currentGeneration = server.stores.revokeRunnerSessions("runner-revoked");
    const socket = await connect("runner-revoked", identity.privateKey, currentGeneration, false);
    const rejected = expectRejected(socket, "runner-revoked");
    socket.send(JSON.stringify(heartbeat("runner-revoked", currentGeneration)));
    await rejected;
  });
});
