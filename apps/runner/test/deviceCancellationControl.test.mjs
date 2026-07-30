import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEVICE_WSS_PROTOCOL_VERSION } from "@norns/contracts";
import { WebSocketServer } from "ws";
import {
  DEVICE_CANCELLATION_JOURNAL_FILENAME,
  DeviceCancellationJournal,
  DeviceControlConnection,
  InMemoryDeviceCredentialSecretStore,
  LiveRunRegistry,
  ManagedProcessTree,
  PendingDeviceCredentialStore,
  ProcessRuntime,
  RunnerDaemon,
  RunnerStateFile,
} from "../dist/index.js";

function temporaryDataDir() {
  return mkdtempSync(join(tmpdir(), "norns-device-control-test-"));
}

function pendingCredential(dataDir) {
  return new PendingDeviceCredentialStore(dataDir, new InMemoryDeviceCredentialSecretStore());
}

async function waitFor(condition, label, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function createRelay() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connections = [];
  server.on("connection", (socket) => {
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
      }
    });
  });
  return {
    server,
    connections,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const connection of connections) connection.socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("device cancellation evidence survives response loss and replays in state order", async () => {
  const dataDir = temporaryDataDir();
  const relay = await createRelay();
  const credential = pendingCredential(dataDir);
  credential.prepare();
  const identity = {
    device_id: "device-1",
    credential_id: "credential-1",
    generation: 7,
  };
  let resolveStop;
  const stopped = new Promise((resolve) => {
    resolveStop = resolve;
  });
  let stopCalls = 0;
  const control = new DeviceControlConnection({
    serverUrl: relay.origin,
    dataDir,
    identity,
    sign: (transcript) => credential.sign(transcript),
    reconnectDelayMs: 30,
    evidenceRetryMs: 50,
    stopRun: async () => {
      stopCalls += 1;
      return await stopped;
    },
    stopAll: async () => {
      throw new Error("project stop must not stop every run");
    },
    fence: () => {
      throw new Error("valid device control must not fence");
    },
  });

  try {
    control.start();
    await waitFor(() => control.connected, "first authenticated device connection");
    const first = relay.connections[0];
    first.socket.send(
      JSON.stringify({
        type: "device_cancellation_request",
        ...identity,
        run_id: "run-1",
        cause: "project_stop",
        requested_at: "2026-07-30T12:00:00.000Z",
        publication_fenced: false,
      }),
    );
    await waitFor(
      () =>
        first.frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "runner_acknowledged",
        ),
      "first acknowledgement evidence",
    );
    assert.equal(stopCalls, 1);

    // Lose the HTTP/WSS response after local durability. Reconnect must send
    // the exact same acknowledgement rather than inventing new evidence.
    first.socket.terminate();
    await waitFor(() => relay.connections.length >= 2 && control.connected, "ack reconnect");
    const second = relay.connections[1];
    await waitFor(
      () =>
        second.frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "runner_acknowledged",
        ),
      "replayed acknowledgement",
    );
    const firstAck = first.frames.find(
      (frame) =>
        frame.type === "device_cancellation_evidence" &&
        frame.evidence_state === "runner_acknowledged",
    );
    const replayedAck = second.frames.find(
      (frame) =>
        frame.type === "device_cancellation_evidence" &&
        frame.evidence_state === "runner_acknowledged",
    );
    assert.equal(replayedAck.acknowledged_at, firstAck.acknowledged_at);
    assert.equal(replayedAck.transcript_signature, firstAck.transcript_signature);

    second.socket.send(
      JSON.stringify({
        type: "device_cancellation_evidence_ack",
        run_id: "run-1",
        evidence_state: "runner_acknowledged",
      }),
    );
    resolveStop({ target_found: true, process_tree_reaped: true });
    await waitFor(
      () =>
        second.frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "process_exited",
        ),
      "process-exit evidence",
    );

    second.socket.terminate();
    await waitFor(() => relay.connections.length >= 3 && control.connected, "exit reconnect");
    const third = relay.connections[2];
    await waitFor(
      () =>
        third.frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "process_exited",
        ),
      "replayed process-exit evidence",
    );
    assert.equal(
      third.frames.some(
        (frame) =>
          frame.type === "device_cancellation_evidence" &&
          frame.evidence_state === "runner_acknowledged",
      ),
      false,
    );
    third.socket.send(
      JSON.stringify({
        type: "device_cancellation_evidence_ack",
        run_id: "run-1",
        evidence_state: "process_exited",
      }),
    );
    await waitFor(() => control.pendingEvidence().length === 0, "journal pruning");

    const persisted = readFileSync(join(dataDir, DEVICE_CANCELLATION_JOURNAL_FILENAME), "utf8");
    assert.doesNotMatch(persisted, /PRIVATE KEY|hostname|command|output|repository|[/\\]/i);
  } finally {
    control.stop();
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("device cancellation journal rejects unbounded pending evidence", () => {
  const dataDir = temporaryDataDir();
  const identity = {
    device_id: "device-bounded",
    credential_id: "credential-bounded",
    generation: 1,
  };
  try {
    writeFileSync(
      join(dataDir, DEVICE_CANCELLATION_JOURNAL_FILENAME),
      JSON.stringify({
        version: 1,
        ...identity,
        evidence: Array.from({ length: 1_001 }, (_, index) => ({
          run_id: `run-${index}`,
          acknowledged_at: "2026-07-30T12:00:00.000Z",
          acknowledged_server_acked: false,
          process_exited_at: null,
          process_tree_reaped: false,
          process_exited_server_acked: false,
        })),
      }),
    );
    assert.throws(
      () => new DeviceCancellationJournal(dataDir, identity),
      /malformed|safe size limit/,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("unproven containment never emits process-exit evidence", async () => {
  const dataDir = temporaryDataDir();
  const relay = await createRelay();
  const credential = pendingCredential(dataDir);
  credential.prepare();
  const identity = {
    device_id: "device-2",
    credential_id: "credential-2",
    generation: 2,
  };
  const control = new DeviceControlConnection({
    serverUrl: relay.origin,
    dataDir,
    identity,
    sign: (transcript) => credential.sign(transcript),
    reconnect: false,
    evidenceRetryMs: 50,
    stopRun: async () => ({ target_found: true, process_tree_reaped: false }),
    stopAll: async () => ({ target_found: true, process_tree_reaped: false }),
    fence: () => undefined,
  });

  try {
    control.start();
    await waitFor(() => control.connected, "authenticated device connection");
    const connection = relay.connections[0];
    connection.socket.send(
      JSON.stringify({
        type: "device_cancellation_request",
        ...identity,
        run_id: "run-unconfirmed",
        cause: "project_stop",
        requested_at: "2026-07-30T12:00:00.000Z",
        publication_fenced: false,
      }),
    );
    await waitFor(
      () =>
        connection.frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "runner_acknowledged",
        ),
      "runner acknowledgement",
    );
    connection.socket.send(
      JSON.stringify({
        type: "device_cancellation_evidence_ack",
        run_id: "run-unconfirmed",
        evidence_state: "runner_acknowledged",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      connection.frames.some(
        (frame) =>
          frame.type === "device_cancellation_evidence" &&
          frame.evidence_state === "process_exited",
      ),
      false,
    );
    assert.deepEqual(control.pendingEvidence(), [
      {
        run_id: "run-unconfirmed",
        acknowledged_at: control.pendingEvidence()[0].acknowledged_at,
        acknowledged_server_acked: true,
        process_exited_at: null,
        process_tree_reaped: false,
        process_exited_server_acked: false,
      },
    ]);
  } finally {
    control.stop();
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("wrong device identity and generation fence without acknowledgement", async () => {
  const dataDir = temporaryDataDir();
  const relay = await createRelay();
  const credential = pendingCredential(dataDir);
  credential.prepare();
  const identity = {
    device_id: "device-fenced",
    credential_id: "credential-fenced",
    generation: 4,
  };
  let fences = 0;
  let stopCalls = 0;
  const control = new DeviceControlConnection({
    serverUrl: relay.origin,
    dataDir,
    identity,
    sign: (transcript) => credential.sign(transcript),
    reconnect: false,
    stopRun: async () => {
      stopCalls += 1;
      return { target_found: true, process_tree_reaped: true };
    },
    stopAll: async () => {
      stopCalls += 1;
      return { target_found: true, process_tree_reaped: true };
    },
    fence: () => {
      fences += 1;
    },
  });
  try {
    control.start();
    await waitFor(() => control.connected, "authenticated fenced test connection");
    const connection = relay.connections[0];
    connection.socket.send(
      JSON.stringify({
        type: "device_cancellation_request",
        ...identity,
        credential_id: "credential-other",
        generation: identity.generation + 1,
        run_id: "run-wrong-identity-generation",
        cause: "project_stop",
        requested_at: "2026-07-30T12:00:00.000Z",
        publication_fenced: true,
      }),
    );
    await waitFor(() => control.isFenced, "wrong-identity generation fence");
    assert.equal(fences, 1);
    assert.equal(stopCalls, 0);
    assert.equal(control.pendingEvidence().length, 0);
    assert.equal(
      connection.frames.some((frame) => frame.type === "device_cancellation_evidence"),
      false,
    );
  } finally {
    control.stop();
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("project stop fences only the selected run even when publication is fenced", async () => {
  const dataDir = temporaryDataDir();
  const relay = await createRelay();
  const credential = pendingCredential(dataDir);
  credential.prepare();
  const identity = {
    device_id: "device-project-stop",
    credential_id: "credential-project-stop",
    generation: 9,
  };
  const liveRuns = new LiveRunRegistry(200);
  const cancellations = [];
  const selectedRelease = liveRuns.register({
    runId: "run-selected",
    runtimeName: "process",
    capabilities: new ProcessRuntime().capabilities,
    cancel: (_reason, options) => {
      cancellations.push({ run_id: "run-selected", publication: options.publication });
      queueMicrotask(() => selectedRelease("cancelled", { process_tree_reaped: true }));
    },
    session: () => null,
  });
  const otherRelease = liveRuns.register({
    runId: "run-other",
    runtimeName: "process",
    capabilities: new ProcessRuntime().capabilities,
    cancel: (_reason, options) => {
      cancellations.push({ run_id: "run-other", publication: options.publication });
    },
    session: () => null,
  });
  let stopAllCalls = 0;
  const control = new DeviceControlConnection({
    serverUrl: relay.origin,
    dataDir,
    identity,
    sign: (transcript) => credential.sign(transcript),
    reconnect: false,
    stopRun: async (runId, reason, publication) => {
      const result = await liveRuns.cancelAndWait(runId, reason, { publication });
      return {
        target_found: result.found,
        process_tree_reaped: result.process_tree_reaped,
      };
    },
    stopAll: async () => {
      stopAllCalls += 1;
      return { target_found: true, process_tree_reaped: true };
    },
    fence: () => undefined,
  });
  try {
    control.start();
    await waitFor(() => control.connected, "project-stop device connection");
    relay.connections[0].socket.send(
      JSON.stringify({
        type: "device_cancellation_request",
        ...identity,
        run_id: "run-selected",
        cause: "project_stop",
        requested_at: "2026-07-30T12:00:00.000Z",
        publication_fenced: true,
      }),
    );
    await waitFor(
      () =>
        relay.connections[0].frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "runner_acknowledged",
        ),
      "selected project-stop acknowledgement",
    );
    relay.connections[0].socket.send(
      JSON.stringify({
        type: "device_cancellation_evidence_ack",
        run_id: "run-selected",
        evidence_state: "runner_acknowledged",
      }),
    );
    await waitFor(
      () =>
        relay.connections[0].frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "process_exited",
        ),
      "selected project-stop process exit",
    );
    assert.deepEqual(cancellations, [{ run_id: "run-selected", publication: "fenced" }]);
    assert.equal(stopAllCalls, 0);
    assert.equal(liveRuns.isLive("run-other"), true);
  } finally {
    otherRelease("cancelled", { process_tree_reaped: true });
    control.stop();
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a stop completed offline is journaled and replayed only after authentication", async () => {
  const dataDir = temporaryDataDir();
  const relay = await createRelay();
  const credential = pendingCredential(dataDir);
  credential.prepare();
  const identity = {
    device_id: "device-offline",
    credential_id: "credential-offline",
    generation: 3,
  };
  let resolveStop;
  const stopped = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const control = new DeviceControlConnection({
    serverUrl: relay.origin,
    dataDir,
    identity,
    sign: (transcript) => credential.sign(transcript),
    reconnect: false,
    evidenceRetryMs: 50,
    stopRun: async () => await stopped,
    stopAll: async () => await stopped,
    fence: () => undefined,
  });
  try {
    control.start();
    await waitFor(() => control.connected, "offline-stop initial connection");
    const first = relay.connections[0];
    first.socket.send(
      JSON.stringify({
        type: "device_cancellation_request",
        ...identity,
        run_id: "run-offline",
        cause: "project_stop",
        requested_at: "2026-07-30T12:00:00.000Z",
        publication_fenced: false,
      }),
    );
    await waitFor(
      () =>
        first.frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "runner_acknowledged",
        ),
      "offline-stop acknowledgement",
    );
    first.socket.terminate();
    await waitFor(() => !control.connected, "device offline");
    resolveStop({ target_found: true, process_tree_reaped: true });
    await waitFor(
      () => control.pendingEvidence()[0]?.process_exited_at !== null,
      "offline process-exit durability",
    );
    assert.equal(
      first.frames.some(
        (frame) =>
          frame.type === "device_cancellation_evidence" &&
          frame.evidence_state === "process_exited",
      ),
      false,
    );

    control.start();
    await waitFor(
      () => relay.connections.length >= 2 && control.connected,
      "offline-stop reconnect",
    );
    const second = relay.connections[1];
    await waitFor(
      () =>
        second.frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "runner_acknowledged",
        ),
      "offline acknowledgement replay",
    );
    assert.equal(
      second.frames.some(
        (frame) =>
          frame.type === "device_cancellation_evidence" &&
          frame.evidence_state === "process_exited",
      ),
      false,
    );
    second.socket.send(
      JSON.stringify({
        type: "device_cancellation_evidence_ack",
        run_id: "run-offline",
        evidence_state: "runner_acknowledged",
      }),
    );
    await waitFor(
      () =>
        second.frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "process_exited",
        ),
      "ordered offline process-exit replay",
    );
  } finally {
    control.stop();
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("late terminal proof after the confirmation timeout emits process-exit evidence", async () => {
  const dataDir = temporaryDataDir();
  const relay = await createRelay();
  const credential = pendingCredential(dataDir);
  credential.prepare();
  const identity = {
    device_id: "device-late",
    credential_id: "credential-late",
    generation: 5,
  };
  let resolveTerminal;
  const eventual = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  const control = new DeviceControlConnection({
    serverUrl: relay.origin,
    dataDir,
    identity,
    sign: (transcript) => credential.sign(transcript),
    reconnect: false,
    evidenceRetryMs: 50,
    stopRun: async () => ({
      target_found: true,
      process_tree_reaped: false,
      eventual_process_tree_reaped: eventual,
    }),
    stopAll: async () => ({
      target_found: true,
      process_tree_reaped: false,
      eventual_process_tree_reaped: eventual,
    }),
    fence: () => undefined,
  });
  try {
    control.start();
    await waitFor(() => control.connected, "late-proof connection");
    const connection = relay.connections[0];
    connection.socket.send(
      JSON.stringify({
        type: "device_cancellation_request",
        ...identity,
        run_id: "run-late",
        cause: "project_stop",
        requested_at: "2026-07-30T12:00:00.000Z",
        publication_fenced: false,
      }),
    );
    await waitFor(
      () =>
        connection.frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "runner_acknowledged",
        ),
      "late-proof acknowledgement",
    );
    connection.socket.send(
      JSON.stringify({
        type: "device_cancellation_evidence_ack",
        run_id: "run-late",
        evidence_state: "runner_acknowledged",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      connection.frames.some(
        (frame) =>
          frame.type === "device_cancellation_evidence" &&
          frame.evidence_state === "process_exited",
      ),
      false,
    );
    resolveTerminal(true);
    await waitFor(
      () =>
        connection.frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "process_exited",
        ),
      "late process-exit evidence",
    );
  } finally {
    control.stop();
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("RunnerDaemon forwards late exact-run proof after its bounded stop window", async () => {
  const dataDir = temporaryDataDir();
  const relay = await createRelay();
  const credential = pendingCredential(dataDir);
  credential.prepare();
  const identity = {
    device_id: "device-daemon-late",
    credential_id: "credential-daemon-late",
    generation: 8,
  };
  const { privateKey } = generateKeyPairSync("ed25519");
  new RunnerStateFile(dataDir, {
    runner_id: "runner-1",
    private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    generation: 1,
  });
  const daemon = new RunnerDaemon({
    serverUrl: relay.origin,
    runnerId: "runner-1",
    dataDir,
    reconnect: false,
    liveRunConfirmationTimeoutMs: 30,
    deviceControl: {
      identity,
      sign: (transcript) => credential.sign(transcript),
      reconnect: false,
      evidenceRetryMs: 50,
    },
  });
  daemon.loadState();
  const publications = [];
  const release = daemon.liveRuns.register({
    runId: "run-daemon-late",
    runtimeName: "process",
    capabilities: new ProcessRuntime().capabilities,
    cancel: (_reason, options) => {
      publications.push(options.publication);
      setTimeout(() => release("cancelled", { process_tree_reaped: true }), 100);
    },
    session: () => null,
  });
  try {
    daemon.connect();
    await waitFor(() => daemon.deviceControlConnected, "daemon device connection");
    const deviceConnection = relay.connections.find((connection) =>
      connection.frames.some((frame) => frame.type === "device_auth"),
    );
    assert.ok(deviceConnection);
    deviceConnection.socket.send(
      JSON.stringify({
        type: "device_cancellation_request",
        ...identity,
        run_id: "run-daemon-late",
        cause: "project_stop",
        requested_at: "2026-07-30T12:00:00.000Z",
        publication_fenced: false,
      }),
    );
    await waitFor(
      () =>
        deviceConnection.frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "runner_acknowledged",
        ),
      "daemon runner acknowledgement",
    );
    deviceConnection.socket.send(
      JSON.stringify({
        type: "device_cancellation_evidence_ack",
        run_id: "run-daemon-late",
        evidence_state: "runner_acknowledged",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      deviceConnection.frames.some(
        (frame) =>
          frame.type === "device_cancellation_evidence" &&
          frame.evidence_state === "process_exited",
      ),
      false,
    );
    await waitFor(
      () =>
        deviceConnection.frames.some(
          (frame) =>
            frame.type === "device_cancellation_evidence" &&
            frame.evidence_state === "process_exited",
        ),
      "daemon late process-exit evidence",
    );
    assert.deepEqual(publications, ["allow_committed"]);
  } finally {
    daemon.stop();
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("emergency-stop confirmation is bounded while late terminal facts remain available", async () => {
  const liveRuns = new LiveRunRegistry(40);
  const release = liveRuns.register({
    runId: "run-hung",
    runtimeName: "unproven-sdk",
    capabilities: {
      interrupt: false,
      suspend: false,
      resume_session: false,
      cancel: true,
      stop_after_current: false,
      send_message: false,
    },
    cancel: () => undefined,
    session: () => null,
  });
  const started = Date.now();
  const bounded = await liveRuns.cancelAllAndWait("local emergency stop");
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(
    {
      stop_requested: bounded.stop_requested,
      process_trees_reaped: bounded.process_trees_reaped,
      unconfirmed: bounded.unconfirmed,
    },
    { stop_requested: 1, process_trees_reaped: 0, unconfirmed: 1 },
  );
  assert.ok(bounded.eventual);
  release("cancelled", { process_tree_reaped: true });
  assert.deepEqual(await bounded.eventual, {
    stop_requested: 1,
    process_trees_reaped: 1,
    unconfirmed: 0,
  });
});

test("ProcessRuntime verifies Unix process-group teardown and preserves the worktree", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process-group verification");
    return;
  }
  const dataDir = temporaryDataDir();
  const marker = join(dataDir, "descendant-marker");
  const controller = new AbortController();
  try {
    const runtime = new ProcessRuntime();
    const running = runtime.run({
      runId: "run-process-tree",
      worktreePath: dataDir,
      prompt: `(sleep 0.4; printf escaped > ${JSON.stringify(marker)}) & printf started; sleep 30`,
      signal: controller.signal,
      onLog: (chunk) => {
        if (chunk.includes("started")) controller.abort();
      },
    });
    const result = await running;
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.process_tree_reaped, true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      (() => {
        try {
          readFileSync(marker);
          return true;
        } catch {
          return false;
        }
      })(),
      false,
    );
    writeFileSync(join(dataDir, "recovery-worktree"), "preserved");
    assert.equal(readFileSync(join(dataDir, "recovery-worktree"), "utf8"), "preserved");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Windows best-effort containment is explicit and never fabricates reaping proof", async () => {
  const child = new EventEmitter();
  child.pid = 1234;
  child.kill = () => true;
  const taskkill = new EventEmitter();
  const processTree = new ManagedProcessTree(child, {
    platform: "win32",
    spawnTaskkill: () => {
      queueMicrotask(() => taskkill.emit("close", 0));
      return taskkill;
    },
  });
  assert.equal(processTree.verifiedReapingSupported, false);
  processTree.requestStop();
  assert.deepEqual(await processTree.confirmReaped(), {
    containment: "windows_best_effort",
    process_tree_reaped: false,
  });
});
