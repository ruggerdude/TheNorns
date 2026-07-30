import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_HOST_CSRF_HEADER,
  AgentHost,
  AgentHostAlreadyRunningError,
  FileAgentHostPortDiscovery,
} from "../dist/agentHost.js";
import {
  PENDING_DEVICE_CREDENTIAL_FILENAME,
  PendingDeviceCredentialStore,
} from "../dist/pendingDeviceCredential.js";

function temporaryDataDir() {
  return mkdtempSync(join(tmpdir(), "norns-agent-host-test-"));
}

function removeTemporaryDataDir(dataDir) {
  rmSync(dataDir, { recursive: true, force: true });
}

function tokenFromBootstrapUrl(bootstrapUrl) {
  const value = new URLSearchParams(new URL(bootstrapUrl).hash.slice(1)).get("bootstrap");
  assert.ok(value);
  return value;
}

async function exchangeBootstrap(started) {
  const token = tokenFromBootstrapUrl(started.bootstrap_url);
  const response = await fetch(`${started.origin}/api/session/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: started.origin,
    },
    body: JSON.stringify({ bootstrap_token: token }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.has("access-control-allow-origin"), false);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\//i);
  const body = await response.json();
  assert.match(body.csrf_token, /^[A-Za-z0-9_-]{40,}$/);
  return {
    cookie: setCookie.split(";", 1)[0],
    csrf: body.csrf_token,
    token,
  };
}

function authenticatedHeaders(started, session, includeCsrf = false) {
  return {
    "content-type": "application/json",
    cookie: session.cookie,
    origin: started.origin,
    ...(includeCsrf ? { [AGENT_HOST_CSRF_HEADER]: session.csrf } : {}),
  };
}

async function requestWithHost(origin, host) {
  return await new Promise((resolve, reject) => {
    const url = new URL(origin);
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: "/",
        method: "GET",
        headers: { host },
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve({ status: response.statusCode, headers: response.headers });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("AgentHost serves only a hardened, bundled loopback UI", async () => {
  const dataDir = temporaryDataDir();
  const lifecycle = {
    starts: 0,
    stops: 0,
    start() {
      this.starts += 1;
    },
    stop() {
      this.stops += 1;
    },
  };
  const host = new AgentHost({ dataDir, daemon: lifecycle });

  try {
    const started = await host.start();
    assert.equal(started.host, "127.0.0.1");
    assert.ok(started.port > 0);
    assert.equal(started.origin, `http://127.0.0.1:${started.port}`);
    assert.match(started.bootstrap_url, /^http:\/\/127\.0\.0\.1:\d+\/#bootstrap=/);

    const discovery = new FileAgentHostPortDiscovery(dataDir);
    assert.deepEqual(discovery.read(), {
      version: 1,
      host: started.host,
      port: started.port,
      origin: started.origin,
    });
    assert.equal(statSync(discovery.filePath).mode & 0o777, 0o600);
    assert.equal(statSync(join(dataDir, "agent-host.lock")).mode & 0o777, 0o600);

    const page = await fetch(started.bootstrap_url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(page.headers.has("access-control-allow-origin"), false);
    const html = await page.text();
    assert.match(html, /<script defer src="\/agent-host\.js"><\/script>/);
    assert.doesNotMatch(html, /<script(?! defer src)/);

    const queryBootstrap = await fetch(`${started.origin}/?bootstrap=not-accepted`);
    assert.equal(queryBootstrap.status, 400);

    const javascript = await fetch(`${started.origin}/agent-host.js`);
    assert.equal(javascript.status, 200);
    assert.match(await javascript.text(), /\/api\/enrollment\/prepare/);

    const wrongHost = await requestWithHost(started.origin, `localhost:${started.port}`);
    assert.equal(wrongHost.status, 403);
    assert.equal("access-control-allow-origin" in wrongHost.headers, false);

    const wrongOrigin = await fetch(`${started.origin}/`, {
      headers: { origin: "https://malicious.example" },
    });
    assert.equal(wrongOrigin.status, 403);

    const preflight = await fetch(`${started.origin}/api/daemon/start`, {
      method: "OPTIONS",
      headers: { origin: started.origin },
    });
    assert.equal(preflight.status, 405);
    assert.equal(preflight.headers.has("access-control-allow-origin"), false);

    const stateChangingGet = await fetch(`${started.origin}/api/daemon/start`);
    assert.equal(stateChangingGet.status, 405);
    assert.equal(lifecycle.starts, 0);
  } finally {
    await host.stop();
    removeTemporaryDataDir(dataDir);
  }
});

test("AgentHost exchanges one bootstrap token for a CSRF-protected local session", async () => {
  const dataDir = temporaryDataDir();
  const lifecycle = {
    starts: 0,
    stops: 0,
    start() {
      this.starts += 1;
    },
    stop() {
      this.stops += 1;
    },
  };
  const credentialStore = new PendingDeviceCredentialStore(dataDir);
  const host = new AgentHost({ dataDir, daemon: lifecycle, credentialStore });

  try {
    const started = await host.start();
    const bootstrapWithoutOrigin = await fetch(`${started.origin}/api/session/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bootstrap_token: tokenFromBootstrapUrl(started.bootstrap_url) }),
    });
    assert.equal(bootstrapWithoutOrigin.status, 403);

    const session = await exchangeBootstrap(started);
    const replay = await fetch(`${started.origin}/api/session/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: started.origin,
      },
      body: JSON.stringify({ bootstrap_token: session.token }),
    });
    assert.equal(replay.status, 401);

    const status = await fetch(`${started.origin}/api/status`, {
      headers: { cookie: session.cookie },
    });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      enrollment_state: "not_enrolled",
      daemon_state: "stopped",
      credential_prepared: false,
    });

    const missingCsrf = await fetch(`${started.origin}/api/enrollment/prepare`, {
      method: "POST",
      headers: authenticatedHeaders(started, session),
      body: "{}",
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(credentialStore.exists(), false);

    const prepared = await fetch(`${started.origin}/api/enrollment/prepare`, {
      method: "POST",
      headers: authenticatedHeaders(started, session, true),
      body: "{}",
    });
    assert.equal(prepared.status, 200);
    const preparedBody = await prepared.json();
    assert.equal(preparedBody.enrollment_state, "credential_prepared");
    assert.equal(preparedBody.algorithm, "Ed25519");
    assert.match(preparedBody.public_key_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal("private_key_pem" in preparedBody, false);
    assert.equal(credentialStore.exists(), true);
    assert.equal(statSync(join(dataDir, PENDING_DEVICE_CREDENTIAL_FILENAME)).mode & 0o777, 0o600);

    const start = await fetch(`${started.origin}/api/daemon/start`, {
      method: "POST",
      headers: authenticatedHeaders(started, session, true),
      body: "{}",
    });
    assert.equal(start.status, 200);
    assert.equal((await start.json()).daemon_state, "running");
    assert.equal(lifecycle.starts, 1);

    const idempotentStart = await fetch(`${started.origin}/api/daemon/start`, {
      method: "POST",
      headers: authenticatedHeaders(started, session, true),
      body: "{}",
    });
    assert.equal(idempotentStart.status, 200);
    assert.equal(lifecycle.starts, 1);

    const stop = await fetch(`${started.origin}/api/daemon/stop`, {
      method: "POST",
      headers: authenticatedHeaders(started, session, true),
      body: "{}",
    });
    assert.equal(stop.status, 200);
    assert.equal((await stop.json()).daemon_state, "stopped");
    assert.equal(lifecycle.stops, 1);

    assert.doesNotMatch(
      readFileSync(join(dataDir, PENDING_DEVICE_CREDENTIAL_FILENAME), "utf8"),
      /bootstrap|csrf|norns_agent_session/,
    );
  } finally {
    await host.stop();
    removeTemporaryDataDir(dataDir);
  }
});

test("AgentHost expires bootstrap tokens and enforces one host per data directory", async () => {
  const dataDir = temporaryDataDir();
  let now = 1_000;
  const daemon = { start() {}, stop() {} };
  const first = new AgentHost({
    dataDir,
    daemon,
    now: () => now,
    bootstrapTokenTtlMs: 10,
  });

  try {
    const started = await first.start();
    const second = new AgentHost({ dataDir, daemon });
    await assert.rejects(() => second.start(), AgentHostAlreadyRunningError);

    now += 11;
    const expired = await fetch(`${started.origin}/api/session/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: started.origin,
      },
      body: JSON.stringify({ bootstrap_token: tokenFromBootstrapUrl(started.bootstrap_url) }),
    });
    assert.equal(expired.status, 410);
  } finally {
    await first.stop();
  }

  const replacement = new AgentHost({ dataDir, daemon });
  try {
    await replacement.start();
  } finally {
    await replacement.stop();
  }

  assert.equal(existsSync(join(dataDir, "agent-host.lock")), false);
  removeTemporaryDataDir(dataDir);
});
