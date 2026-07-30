import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
