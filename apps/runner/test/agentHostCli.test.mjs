import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEVICE_WSS_PROTOCOL_VERSION } from "@norns/contracts";
import { WebSocketServer } from "ws";
import {
  ActiveDeviceIdentityStore,
  DevelopmentFileDeviceCredentialSecretStore,
  PendingDeviceCredentialStore,
  RunnerStateFile,
  createAgentHostNativeLaunchRequestProof,
  createAgentHostNativeLaunchResponseProof,
  writeLocalAgentConfig,
} from "../dist/index.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function temporaryDataDir() {
  return mkdtempSync(join(tmpdir(), "norns-agent-host-cli-test-"));
}

function environmentWith(overrides = {}) {
  return { ...process.env, ...overrides, NORNS_SERVER: undefined };
}

function waitForBootstrapUrl(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`AgentHost CLI did not start\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 5_000);

    const finish = (callback) => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      callback();
    };
    const onStdout = (chunk) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(
        /Norns Local Agent Control Center: (http:\/\/127\.0\.0\.1:\d+\/#bootstrap=[^\s]+)/,
      );
      if (match) {
        finish(() => resolve({ bootstrapUrl: match[1], stdout }));
      }
    };
    const onStderr = (chunk) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code, signal) => {
      finish(() => {
        reject(
          new Error(
            `AgentHost CLI exited before startup (code ${String(code)}, signal ${String(signal)})\n${stderr}`,
          ),
        );
      });
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

async function waitFor(condition, label, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test("agent-host remains disabled unless its preview feature flag is explicit", () => {
  const dataDir = temporaryDataDir();
  try {
    const result = spawnSync(process.execPath, [CLI_PATH, "agent-host", "--data", dataDir], {
      encoding: "utf8",
      env: environmentWith({ NORNS_ENABLE_DEVICE_AGENT_HOST: "" }),
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /AgentHost is disabled/);
    assert.equal(existsSync(join(dataDir, "agent-host.json")), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("normal help and default CLI path retire raw and custom-URI pairing", () => {
  const dataDir = temporaryDataDir();
  try {
    const help = spawnSync(process.execPath, [CLI_PATH, "--help"], {
      encoding: "utf8",
      env: environmentWith(),
    });
    assert.equal(help.status, 0);
    assert.doesNotMatch(help.stdout, /pair-url|norns-agent:\/\/|pair <code>/);

    const pairingUri = "norns-agent://pair?server=https%3A%2F%2Fnorns.example&code=deadbeef";
    const retired = spawnSync(
      process.execPath,
      [CLI_PATH, "pair-url", pairingUri, "--data", dataDir],
      { encoding: "utf8", env: environmentWith() },
    );
    assert.equal(retired.status, 1);
    assert.match(retired.stderr, /legacy custom-URI pairing is disabled/);
    assert.doesNotMatch(retired.stderr, /deadbeef/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("agent-host starts without cloud configuration and cleans up after SIGTERM", async () => {
  const dataDir = temporaryDataDir();
  const child = spawn(process.execPath, [CLI_PATH, "agent-host", "--data", dataDir], {
    env: environmentWith({ NORNS_ENABLE_DEVICE_AGENT_HOST: "true" }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const started = await waitForBootstrapUrl(child);
    assert.match(started.bootstrapUrl, /\/#bootstrap=/);
    assert.doesNotMatch(started.bootstrapUrl, /\?bootstrap=/);

    const page = await fetch(started.bootstrapUrl);
    assert.equal(page.status, 200);
    assert.equal(page.headers.has("access-control-allow-origin"), false);

    const discovery = JSON.parse(readFileSync(join(dataDir, "agent-host.json"), "utf8"));
    assert.equal(discovery.origin, new URL(started.bootstrapUrl).origin);
    assert.equal(discovery.host, "127.0.0.1");

    child.kill("SIGTERM");
    const [code, signal] = await once(child, "exit");
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(existsSync(join(dataDir, "agent-host.json")), false);
    assert.equal(existsSync(join(dataDir, "agent-host.lock")), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("device control production flag fails closed without validated persisted identity", () => {
  const dataDir = temporaryDataDir();
  try {
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "start", "--server", "http://127.0.0.1:9", "--id", "runner-1", "--data", dataDir],
      {
        encoding: "utf8",
        env: environmentWith({ NORNS_ENABLE_DEVICE_CONTROL: "true" }),
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no server-validated active device identity/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("device control production flag rejects ambiguous values", () => {
  const dataDir = temporaryDataDir();
  try {
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, "start", "--server", "http://127.0.0.1:9", "--id", "runner-1", "--data", dataDir],
      {
        encoding: "utf8",
        env: environmentWith({ NORNS_ENABLE_DEVICE_CONTROL: "yes" }),
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be exactly "true" or "false"/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("production start and installed agent-start share AgentHost-owned device control", async () => {
  const dataDir = temporaryDataDir();
  const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const observed = [];
  relay.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "challenge",
        nonce: "legacy-challenge",
        device_auth: {
          challenge: "device-challenge",
          supported_protocol_versions: [DEVICE_WSS_PROTOCOL_VERSION],
        },
      }),
    );
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      observed.push(frame.type);
      if (frame.type === "auth") {
        socket.send(JSON.stringify({ type: "auth_ok" }));
      } else if (frame.type === "reconcile_request") {
        socket.send(
          JSON.stringify({
            type: "reconcile_response",
            body: {
              protocol: 1,
              ack_event_seq: 0,
              generation: 1,
              capabilities: [],
              resend_commands: [],
            },
          }),
        );
      } else if (frame.type === "device_auth") {
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

  const pending = new PendingDeviceCredentialStore(
    dataDir,
    new DevelopmentFileDeviceCredentialSecretStore(dataDir),
  );
  pending.prepare();
  new ActiveDeviceIdentityStore(dataDir).activateFromRedemption({
    device_id: "device-production",
    credential_id: "credential-production",
    generation: 6,
    activated_at: "2026-07-30T12:00:00.000Z",
  });
  const { privateKey } = generateKeyPairSync("ed25519");
  new RunnerStateFile(dataDir, {
    runner_id: "runner-1",
    private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    generation: 1,
  });
  writeLocalAgentConfig(dataDir, {
    version: 1,
    server: `http://127.0.0.1:${address.port}`,
    runner_id: "runner-1",
  });
  const child = spawn(
    process.execPath,
    [
      CLI_PATH,
      "start",
      "--server",
      `http://127.0.0.1:${address.port}`,
      "--id",
      "runner-1",
      "--data",
      dataDir,
    ],
    {
      env: environmentWith({
        NORNS_ENABLE_DEVICE_CONTROL: "true",
        NORNS_ENABLE_LEGACY_LOCAL_COMPATIBILITY: "true",
        NORNS_ALLOW_INSECURE_DEVICE_KEY_FILE: "true",
        NORNS_APPROVED_ROOTS_JSON: "[]",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let agentChild = null;
  try {
    await waitFor(
      () => observed.includes("auth") && observed.includes("device_auth"),
      "legacy and device authentication frames",
    );
    child.kill("SIGTERM");
    const [code, signal] = await once(child, "exit");
    assert.equal(code, 0);
    assert.equal(signal, null);

    observed.length = 0;
    agentChild = spawn(process.execPath, [CLI_PATH, "agent-start", "--data", dataDir], {
      env: environmentWith({
        NORNS_ENABLE_DEVICE_CONTROL: "true",
        NORNS_ENABLE_LEGACY_LOCAL_COMPATIBILITY: "true",
        NORNS_ALLOW_INSECURE_DEVICE_KEY_FILE: "true",
        NORNS_APPROVED_ROOTS_JSON: "[]",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitFor(
      () => existsSync(join(dataDir, "agent-host.json")),
      "AgentHost native discovery record",
    );
    const discovery = JSON.parse(readFileSync(join(dataDir, "agent-host.json"), "utf8"));
    const requestId = randomBytes(32).toString("base64url");
    const requestBody = {
      request_id: requestId,
      request_proof: createAgentHostNativeLaunchRequestProof({
        native_launch_secret: discovery.native_launch_secret,
        origin: discovery.origin,
        request_id: requestId,
      }),
    };
    assert.doesNotMatch(JSON.stringify(requestBody), new RegExp(discovery.native_launch_secret));
    const nativeLaunch = await fetch(`${discovery.origin}/api/session/native-launch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: discovery.origin,
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(nativeLaunch.status, 200);
    const started = await nativeLaunch.json();
    assert.equal(
      started.response_proof,
      createAgentHostNativeLaunchResponseProof({
        native_launch_secret: discovery.native_launch_secret,
        origin: discovery.origin,
        request_id: requestId,
        bootstrap_url: started.bootstrap_url,
      }),
    );
    await waitFor(
      () => observed.includes("auth") && observed.includes("device_auth"),
      "AgentHost-owned legacy and device authentication frames",
    );
    const page = await fetch(started.bootstrap_url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Emergency stop all Norns work/);
    agentChild.kill("SIGTERM");
    const [agentCode, agentSignal] = await once(agentChild, "exit");
    assert.equal(agentCode, 0);
    assert.equal(agentSignal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    if (agentChild && agentChild.exitCode === null && agentChild.signalCode === null) {
      agentChild.kill("SIGKILL");
      await once(agentChild, "exit");
    }
    for (const client of relay.clients) client.terminate();
    await new Promise((resolve) => relay.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
