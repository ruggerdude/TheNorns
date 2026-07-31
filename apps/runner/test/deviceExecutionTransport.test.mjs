import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEVICE_WSS_PROTOCOL_VERSION } from "@norns/contracts";
import { WebSocketServer } from "ws";
import {
  InMemoryDeviceCredentialSecretStore,
  PendingDeviceCredentialStore,
  RunnerDaemon,
  WorkspaceRegistry,
} from "../dist/index.js";

function temporaryDataDir() {
  return mkdtempSync(join(tmpdir(), "norns-device-execution-test-"));
}

async function waitFor(condition, label, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test("device execution reconciles and replays durable events without enabling legacy transport", async () => {
  const dataDir = temporaryDataDir();
  const credential = new PendingDeviceCredentialStore(
    dataDir,
    new InMemoryDeviceCredentialSecretStore(),
  );
  credential.prepare();
  const identity = {
    device_id: "device-execution-1",
    credential_id: "credential-execution-1",
    generation: 9,
  };
  const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const connections = [];
  const command = {
    protocol: 1,
    command_id: "command-device-1",
    idempotency_key: "idem-device-1",
    correlation_id: "correlation-device-1",
    causation_id: null,
    project_id: "project-device-1",
    runner_id: identity.device_id,
    generation: identity.generation,
    issued_by_session: "session-device-1",
    issued_at: "2026-07-30T12:00:00.000Z",
    expires_at: "2099-07-30T12:00:00.000Z",
    payload: { kind: "launch_fixture", fixture: "count:1:5" },
  };
  relay.on("connection", (socket) => {
    const connection = { socket, frames: [] };
    connections.push(connection);
    socket.send(
      JSON.stringify({
        type: "challenge",
        nonce: `legacy-${connections.length}`,
        device_auth: {
          challenge: `device-${connections.length}`,
          supported_protocol_versions: [DEVICE_WSS_PROTOCOL_VERSION],
        },
      }),
    );
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      connection.frames.push(frame);
      if (frame.type === "device_auth") {
        socket.send(
          JSON.stringify({
            type: "device_auth_ok",
            device_id: frame.device_id,
            generation: frame.generation,
            protocol_version: frame.protocol_version,
          }),
        );
      } else if (frame.type === "reconcile_request") {
        socket.send(
          JSON.stringify({
            type: "reconcile_response",
            body: {
              protocol: 1,
              ack_event_seq: 0,
              generation: identity.generation,
              capabilities: ["knowledge_transport"],
              resend_commands: connections.length === 1 ? [] : [command],
            },
          }),
        );
        if (connections.length === 1) {
          socket.send(JSON.stringify({ type: "command", command }));
        }
      }
    });
  });

  const daemon = new RunnerDaemon({
    serverUrl: `http://127.0.0.1:${address.port}`,
    runnerId: "runner-1",
    dataDir,
    heartbeatMs: 60_000,
    reconnectDelayMs: 30,
    deviceControl: {
      identity,
      sign: (payload) => credential.sign(payload),
      execution: true,
    },
  });

  try {
    daemon.start();
    await waitFor(
      () =>
        connections[0]?.frames.some((frame) => frame.type === "reconcile_request") &&
        connections[0]?.frames.some((frame) => frame.type === "event"),
      "device reconciliation and first durable event",
    );
    const firstReconcile = connections[0].frames.find(
      (frame) => frame.type === "reconcile_request",
    );
    assert.deepEqual(firstReconcile.body.capabilities, [
      "workspace_picker",
      "workspace_repository_inventory",
      "workspace_clone",
      "knowledge_transport",
    ]);
    assert.equal(firstReconcile.body.runner_id, identity.device_id);
    assert.equal(
      connections[0].frames.some((frame) => frame.type === "auth"),
      false,
    );
    assert.equal(
      connections[0].frames.some(
        (frame) => frame.type === "workspace_response" || frame.type === "inference_request",
      ),
      false,
    );

    connections[0].socket.terminate();
    await waitFor(
      () =>
        connections.length >= 2 &&
        connections[1].frames.some((frame) => frame.type === "reconcile_request") &&
        connections[1].frames.some((frame) => frame.type === "event"),
      "reconnected durable event replay",
    );
    const secondReconcile = connections[1].frames.find(
      (frame) => frame.type === "reconcile_request",
    );
    assert.ok(secondReconcile.body.recently_executed_command_ids.includes(command.command_id));

    const allEvents = connections.flatMap((connection) =>
      connection.frames.filter((frame) => frame.type === "event").map((frame) => frame.event),
    );
    const started = allEvents.filter(
      (event) =>
        event.payload.kind === "run_status" &&
        event.payload.status === "started" &&
        event.payload.run_id === `run_${command.command_id}`,
    );
    assert.ok(started.length >= 1);
    assert.equal(new Set(started.map((event) => event.event_seq)).size, 1);
    assert.ok(allEvents.every((event) => event.runner_id === identity.device_id));
  } finally {
    daemon.stop();
    for (const client of relay.clients) client.terminate();
    await new Promise((resolve) => relay.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cancellation-only device control sends no execution reconciliation", async () => {
  const dataDir = temporaryDataDir();
  const credential = new PendingDeviceCredentialStore(
    dataDir,
    new InMemoryDeviceCredentialSecretStore(),
  );
  credential.prepare();
  const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const frames = [];
  relay.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "challenge",
        nonce: "legacy-unused",
        device_auth: {
          challenge: "device-control-only",
          supported_protocol_versions: [DEVICE_WSS_PROTOCOL_VERSION],
        },
      }),
    );
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      frames.push(frame);
      if (frame.type === "device_auth") {
        socket.send(
          JSON.stringify({
            type: "device_auth_ok",
            device_id: frame.device_id,
            generation: frame.generation,
            protocol_version: frame.protocol_version,
          }),
        );
      }
    });
  });
  const daemon = new RunnerDaemon({
    serverUrl: `http://127.0.0.1:${address.port}`,
    runnerId: "runner-1",
    dataDir,
    deviceControl: {
      identity: {
        device_id: "device-control-only",
        credential_id: "credential-control-only",
        generation: 2,
      },
      sign: (payload) => credential.sign(payload),
    },
  });

  try {
    daemon.start();
    await waitFor(() => frames.some((frame) => frame.type === "device_auth"), "device auth");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      frames.some((frame) => frame.type === "auth"),
      false,
    );
    assert.equal(
      frames.some((frame) => frame.type === "reconcile_request"),
      false,
    );
  } finally {
    daemon.stop();
    for (const client of relay.clients) client.terminate();
    await new Promise((resolve) => relay.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an enrolled device can choose and register a workspace without enabling execution", async () => {
  const dataDir = temporaryDataDir();
  const repositoryPath = join(dataDir, "source");
  mkdirSync(repositoryPath);
  execFileSync("git", ["-C", repositoryPath, "init", "-b", "main"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.email", "test@norns.invalid"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.name", "Norns Test"]);
  writeFileSync(join(repositoryPath, "README.md"), "workspace\n");
  execFileSync("git", ["-C", repositoryPath, "add", "README.md"]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-m", "initial"]);

  const credential = new PendingDeviceCredentialStore(
    dataDir,
    new InMemoryDeviceCredentialSecretStore(),
  );
  credential.prepare();
  const identity = {
    device_id: "device-workspace-1",
    credential_id: "credential-workspace-1",
    generation: 4,
  };
  const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const frames = [];
  relay.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "challenge",
        nonce: "legacy-unused",
        device_auth: {
          challenge: "device-workspace",
          supported_protocol_versions: [DEVICE_WSS_PROTOCOL_VERSION],
        },
      }),
    );
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      frames.push(frame);
      if (frame.type === "device_auth") {
        socket.send(
          JSON.stringify({
            type: "device_auth_ok",
            device_id: frame.device_id,
            generation: frame.generation,
            protocol_version: frame.protocol_version,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "workspace_request",
            generation: identity.generation,
            request: {
              request_id: "workspace-request-1",
              operation: "choose",
            },
          }),
        );
      }
    });
  });
  const daemon = new RunnerDaemon({
    serverUrl: `http://127.0.0.1:${address.port}`,
    runnerId: "runner-unused",
    dataDir,
    workspaces: new WorkspaceRegistry(dataDir, async () => repositoryPath),
    registerWorkspace: async () => ({ registration_id: "registration-workspace-1" }),
    deviceControl: {
      identity,
      sign: (payload) => credential.sign(payload),
      capabilities: [
        "device_control",
        "repository_access",
        "workspace_picker",
        "workspace_repository_inventory",
        "workspace_clone",
      ],
    },
  });

  try {
    daemon.start();
    await waitFor(
      () => frames.some((frame) => frame.type === "workspace_response"),
      "device workspace response",
    );
    const response = frames.find((frame) => frame.type === "workspace_response");
    assert.equal(response.generation, identity.generation);
    assert.equal(response.response.status, "ok");
    assert.equal(response.response.repository_registration_id, "registration-workspace-1");
    assert.equal(
      frames.some((frame) => frame.type === "reconcile_request"),
      false,
    );
  } finally {
    daemon.stop();
    for (const client of relay.clients) client.terminate();
    await new Promise((resolve) => relay.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
