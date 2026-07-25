import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandEnvelopeT, EventEnvelopeT } from "@norns/contracts";
import { RunnerDaemon, RunnerStateFile } from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { waitFor } from "./helpers.js";

describe("runner terminal acknowledgement replay", () => {
  let daemon: RunnerDaemon | null = null;
  let server: WebSocketServer | null = null;
  let dataDir: string | null = null;

  afterEach(async () => {
    daemon?.stop();
    daemon = null;
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  it.each([
    ["replays an existing durable terminal acknowledgement", true],
    ["synthesizes a missing terminal acknowledgement from execution state", false],
  ])("%s without minting a fresh sequence across resends and reconnects", async (_, seedAck) => {
    dataDir = mkdtempSync(join(tmpdir(), "norns-terminal-ack-"));
    const { privateKey } = generateKeyPairSync("ed25519");
    const state = new RunnerStateFile(dataDir, {
      runner_id: "runner-1",
      private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      generation: 1,
    });
    const command: CommandEnvelopeT = {
      protocol: 1,
      command_id: "command-terminal",
      idempotency_key: "command-terminal",
      correlation_id: "correlation-terminal",
      causation_id: null,
      project_id: "project-1",
      runner_id: "runner-1",
      generation: 1,
      issued_by_session: "session-1",
      issued_at: "2026-07-25T12:00:00.000Z",
      expires_at: "2099-07-25T12:00:00.000Z",
      payload: { kind: "launch_fixture", fixture: "count:1:1" },
    };
    state.recordExecution(command.command_id, "failed");
    if (seedAck) {
      const terminal: EventEnvelopeT = {
        protocol: 1,
        event_seq: state.nextSeq(),
        runner_id: "runner-1",
        generation: 1,
        correlation_id: command.correlation_id,
        causation_id: command.command_id,
        occurred_at: "2026-07-25T12:00:01.000Z",
        payload: {
          kind: "command_ack",
          command_id: command.command_id,
          state: "failed",
          detail: "terminal fixture result",
        },
      };
      state.bufferEvent(terminal);
    }

    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no port");
    const received: EventEnvelopeT[] = [];
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      socket.send(JSON.stringify({ type: "challenge", nonce: `nonce-${connections}` }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as {
          type: string;
          event?: EventEnvelopeT;
        };
        if (frame.type === "auth") {
          socket.send(JSON.stringify({ type: "auth_ok" }));
          return;
        }
        if (frame.type === "reconcile_request") {
          socket.send(
            JSON.stringify({
              type: "reconcile_response",
              body: {
                protocol: 1,
                ack_event_seq: seedAck || connections === 1 ? 0 : 1,
                generation: 1,
                // A terminal command reported in recently_executed_command_ids
                // is normally excluded from this list. The duplicate seed
                // additionally proves an anomalous resend cannot mint events,
                // including after acknowledgement has pruned the buffer.
                resend_commands: seedAck || connections > 1 ? [command, command] : [],
              },
            }),
          );
          if (connections === 1) setTimeout(() => socket.close(), 25);
          return;
        }
        if (frame.type === "event" && frame.event) {
          received.push(frame.event);
          if (!seedAck && connections === 1) {
            socket.send(JSON.stringify({ type: "event_ack", ack_event_seq: 1 }));
          }
        }
      });
    });

    daemon = new RunnerDaemon({
      serverUrl: `http://127.0.0.1:${address.port}`,
      runnerId: "runner-1",
      dataDir,
      heartbeatMs: 60_000,
      reconnectDelayMs: 10,
    });
    daemon.loadState();
    daemon.connect();

    await waitFor(
      () => connections >= 2 && received.length >= (seedAck ? 2 : 1),
      "terminal event replayed",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const persisted = new RunnerStateFile(dataDir, {
      runner_id: "runner-1",
      private_key_pem: "",
      generation: 0,
    });
    expect(
      persisted.state.seq,
      JSON.stringify({
        received: received.map((event) => ({
          sequence: event.event_seq,
          payload: event.payload,
        })),
        buffer: persisted.state.buffer,
      }),
    ).toBe(1);
    expect(persisted.state.buffer).toHaveLength(seedAck ? 1 : 0);
    expect(persisted.state.terminal_acks[command.command_id]).toBe(1);
    expect(received).toHaveLength(seedAck ? 2 : 1);
    expect(new Set(received.map((event) => event.event_seq))).toEqual(new Set([1]));
    expect(
      received.every(
        (event) =>
          event.payload.kind === "command_ack" &&
          event.payload.command_id === command.command_id &&
          event.payload.state === "failed",
      ),
    ).toBe(true);
  });
});
