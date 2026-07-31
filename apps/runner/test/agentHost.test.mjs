import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_HOST_CSRF_HEADER,
  AGENT_HOST_LOCK_FILENAME,
  AgentHost,
  AgentHostAlreadyRunningError,
  FileAgentHostPortDiscovery,
  FileAgentHostSingleInstanceLock,
  createAgentHostNativeLaunchRequestProof,
  createAgentHostNativeLaunchResponseProof,
} from "../dist/agentHost.js";
import { InMemoryDeviceCredentialSecretStore } from "../dist/deviceCredentialSecretStore.js";
import { DeviceEnrollmentCoordinator } from "../dist/deviceEnrollment.js";
import {
  PENDING_DEVICE_CREDENTIAL_FILENAME,
  PendingDeviceCredentialStore,
} from "../dist/pendingDeviceCredential.js";
import { LocalRepositoryAccessController } from "../dist/repositoryAccess.js";
import { WorkspaceRegistry } from "../dist/workspaceRegistry.js";

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

function nativeLaunchProof(discovery) {
  const requestId = randomBytes(32).toString("base64url");
  return {
    requestId,
    body: {
      request_id: requestId,
      request_proof: createAgentHostNativeLaunchRequestProof({
        native_launch_secret: discovery.native_launch_secret,
        origin: discovery.origin,
        request_id: requestId,
      }),
    },
  };
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
  const host = new AgentHost({ dataDir, daemon: lifecycle, detectLocalTools: false });

  try {
    const started = await host.start();
    assert.equal(started.host, "127.0.0.1");
    assert.ok(started.port > 0);
    assert.equal(started.origin, `http://127.0.0.1:${started.port}`);
    assert.match(started.bootstrap_url, /^http:\/\/127\.0\.0\.1:\d+\/#bootstrap=/);

    const discovery = new FileAgentHostPortDiscovery(dataDir);
    const discoveryRecord = discovery.read();
    assert.deepEqual(discoveryRecord, {
      version: 1,
      host: started.host,
      port: started.port,
      origin: started.origin,
      native_launch_secret: discoveryRecord.native_launch_secret,
    });
    assert.match(discoveryRecord.native_launch_secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
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
    assert.match(html, />Home</);
    assert.match(html, />Security</);
    assert.match(html, />Repositories</);
    assert.match(html, />Diagnostics</);
    assert.match(html, /role="tablist"/);
    assert.match(html, /role="tab"/);
    assert.match(html, /role="tabpanel"/);
    assert.match(html, /Connect this Mac/);
    assert.doesNotMatch(html, /Authorization code/);
    assert.match(html, /Download redacted support bundle/);
    assert.doesNotMatch(html, /hostname|raw local path/i);

    const queryBootstrap = await fetch(`${started.origin}/?bootstrap=not-accepted`);
    assert.equal(queryBootstrap.status, 400);

    const javascript = await fetch(`${started.origin}/agent-host.js`);
    assert.equal(javascript.status, 200);
    const javascriptBody = await javascript.text();
    assert.match(javascriptBody, /\/api\/enrollment\/start/);
    assert.match(javascriptBody, /new URLSearchParams\(\{ code:/);
    assert.match(javascriptBody, /norns-device-approval/);
    assert.match(javascriptBody, /\/api\/daemon\/restart/);
    assert.match(javascriptBody, /\/api\/repositories\/choose/);
    assert.match(javascriptBody, /\/api\/repositories\/remove/);
    assert.match(javascriptBody, /\/api\/session/);
    assert.match(javascriptBody, /ArrowRight/);

    const stylesheet = await fetch(`${started.origin}/agent-host.css`);
    assert.equal(stylesheet.status, 200);
    const stylesheetBody = await stylesheet.text();
    assert.match(stylesheetBody, /forced-colors:active/);
    assert.match(stylesheetBody, /box-sizing:border-box/);

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
    const restartGet = await fetch(`${started.origin}/api/daemon/restart`);
    assert.equal(restartGet.status, 405);
    const nativeLaunchGet = await fetch(`${started.origin}/api/session/native-launch`);
    assert.equal(nativeLaunchGet.status, 405);
    const hostileProof = nativeLaunchProof(discoveryRecord);
    const hostileNativeLaunch = await fetch(`${started.origin}/api/session/native-launch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://malicious.example",
      },
      body: JSON.stringify(hostileProof.body),
    });
    assert.equal(hostileNativeLaunch.status, 403);
    const invalidProof = nativeLaunchProof(discoveryRecord);
    const invalidNativeLaunch = await fetch(`${started.origin}/api/session/native-launch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: started.origin,
      },
      body: JSON.stringify({ ...invalidProof.body, request_proof: "x".repeat(43) }),
    });
    assert.equal(invalidNativeLaunch.status, 401);
    const validProof = nativeLaunchProof(discoveryRecord);
    const serializedNativeLaunch = JSON.stringify(validProof.body);
    assert.doesNotMatch(serializedNativeLaunch, new RegExp(discoveryRecord.native_launch_secret));
    const nativeLaunch = await fetch(`${started.origin}/api/session/native-launch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: started.origin,
      },
      body: serializedNativeLaunch,
    });
    assert.equal(nativeLaunch.status, 200);
    const nativeLaunchBody = await nativeLaunch.json();
    assert.match(nativeLaunchBody.bootstrap_url, /^http:\/\/127\.0\.0\.1:\d+\/#bootstrap=/);
    assert.equal(
      nativeLaunchBody.response_proof,
      createAgentHostNativeLaunchResponseProof({
        native_launch_secret: discoveryRecord.native_launch_secret,
        origin: discoveryRecord.origin,
        request_id: validProof.requestId,
        bootstrap_url: nativeLaunchBody.bootstrap_url,
      }),
    );
    const replayedNativeLaunch = await fetch(`${started.origin}/api/session/native-launch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: started.origin,
      },
      body: serializedNativeLaunch,
    });
    assert.equal(replayedNativeLaunch.status, 409);
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
  const credentialStore = new PendingDeviceCredentialStore(
    dataDir,
    new InMemoryDeviceCredentialSecretStore(),
  );
  const host = new AgentHost({
    dataDir,
    daemon: lifecycle,
    credentialStore,
    detectLocalTools: false,
  });

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

    const discovery = new FileAgentHostPortDiscovery(dataDir).read();
    assert.ok(discovery);
    const reopenProof = nativeLaunchProof(discovery);
    const nativeLaunch = await fetch(`${started.origin}/api/session/native-launch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: started.origin,
      },
      body: JSON.stringify(reopenProof.body),
    });
    assert.equal(nativeLaunch.status, 200);
    const nativeLaunchBody = await nativeLaunch.json();
    assert.equal(
      nativeLaunchBody.response_proof,
      createAgentHostNativeLaunchResponseProof({
        native_launch_secret: discovery.native_launch_secret,
        origin: discovery.origin,
        request_id: reopenProof.requestId,
        bootstrap_url: nativeLaunchBody.bootstrap_url,
      }),
    );
    const reopened = await exchangeBootstrap({
      ...started,
      bootstrap_url: nativeLaunchBody.bootstrap_url,
    });
    assert.notEqual(reopened.token, session.token);

    const status = await fetch(`${started.origin}/api/status`, {
      headers: { cookie: session.cookie },
    });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      enrollment_state: "not_enrolled",
      enrollment: {
        user_code: null,
        verification_uri: null,
        expires_at: null,
        next_poll_at: null,
      },
      daemon_state: "stopped",
      credential_prepared: false,
      home: {
        device_name: "This computer",
        location_label: null,
        availability: "offline",
        compatibility: "limited",
        workload: "idle",
        start_at_login: false,
        agent_version: "0.1.0",
        recent_activity: null,
        emergency_stop: null,
      },
      security: {
        enrolled_account: null,
        public_key_fingerprint: null,
        repository_access_summary: "No repository access is configured.",
        failed_authorization_notices: [],
      },
      diagnostics: {
        connectivity: "disconnected",
        protocol_version: "Not negotiated",
        capabilities: [],
        git_version: null,
        runtimes: [],
        manual_update_guidance:
          "Install a newer signed Norns Local Agent package manually. Automatic updates are not enabled.",
        automatic_updates_enabled: false,
      },
    });

    const recoveredSession = await fetch(`${started.origin}/api/session`, {
      headers: { cookie: session.cookie },
    });
    assert.equal(recoveredSession.status, 200);
    assert.deepEqual(await recoveredSession.json(), { csrf_token: session.csrf });

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

test("native launch proofs cannot cross AgentHost process secrets", async () => {
  const dataDir = temporaryDataDir();
  const first = new AgentHost({
    dataDir,
    daemon: { start() {}, stop() {} },
    detectLocalTools: false,
  });
  let second = null;

  try {
    await first.start();
    const firstDiscovery = new FileAgentHostPortDiscovery(dataDir).read();
    assert.ok(firstDiscovery);
    await first.stop();

    second = new AgentHost({
      dataDir,
      daemon: { start() {}, stop() {} },
      detectLocalTools: false,
    });
    const secondStarted = await second.start();
    const secondDiscovery = new FileAgentHostPortDiscovery(dataDir).read();
    assert.ok(secondDiscovery);
    assert.notEqual(firstDiscovery.native_launch_secret, secondDiscovery.native_launch_secret);

    const staleRequestId = randomBytes(32).toString("base64url");
    const staleProof = createAgentHostNativeLaunchRequestProof({
      native_launch_secret: firstDiscovery.native_launch_secret,
      origin: secondDiscovery.origin,
      request_id: staleRequestId,
    });
    const stale = await fetch(`${secondStarted.origin}/api/session/native-launch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: secondStarted.origin,
      },
      body: JSON.stringify({
        request_id: staleRequestId,
        request_proof: staleProof,
      }),
    });
    assert.equal(stale.status, 401);
  } finally {
    await first.stop();
    await second?.stop();
    removeTemporaryDataDir(dataDir);
  }
});

test("AgentHost starts enrollment only through a CSRF-protected POST and never returns the device code", async () => {
  const dataDir = temporaryDataDir();
  const secrets = new InMemoryDeviceCredentialSecretStore();
  const credentialStore = new PendingDeviceCredentialStore(dataDir, secrets);
  let deviceCode = "";
  let userCode = "";
  const enrollment = new DeviceEnrollmentCoordinator({
    serverUrl: "https://norns.example",
    dataDir,
    credentialStore,
    secretStore: secrets,
    setTimer: (_callback, delay) => ({ delay, unref() {} }),
    clearTimer() {},
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init.body));
      deviceCode = request.device_code;
      userCode = request.user_code;
      return new Response(
        JSON.stringify({
          authorization_request_id: "deviceauth-agent-host",
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: "https://norns.example/device-authorization",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          interval_seconds: 5,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    },
  });
  const host = new AgentHost({
    dataDir,
    daemon: { start() {}, stop() {} },
    credentialStore,
    enrollment,
    detectLocalTools: false,
  });

  try {
    const started = await host.start();
    const session = await exchangeBootstrap(started);
    const getAttempt = await fetch(`${started.origin}/api/enrollment/start`, {
      headers: { cookie: session.cookie },
    });
    assert.equal(getAttempt.status, 405);

    const response = await fetch(`${started.origin}/api/enrollment/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: started.origin,
        cookie: session.cookie,
        [AGENT_HOST_CSRF_HEADER]: session.csrf,
      },
      body: "{}",
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.enrollment_state, "pending");
    assert.equal(body.user_code, userCode);
    assert.equal(body.verification_uri, "https://norns.example/device-authorization");
    assert.equal("device_code" in body, false);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(deviceCode));
  } finally {
    await host.stop();
    removeTemporaryDataDir(dataDir);
  }
});

test("AgentHost retries pending repository registration immediately after enrollment becomes active", async () => {
  const dataDir = temporaryDataDir();
  let enrollmentListener = null;
  let synchronizations = 0;
  const enrollment = {
    status: {
      state: "pending",
      user_code: "ABCD-EFGH",
      verification_uri: "https://norns.example/device-authorization",
      expires_at: "2026-07-30T12:10:00.000Z",
      next_poll_at: "2026-07-30T12:00:05.000Z",
    },
    start() {},
    stop() {},
    subscribe(listener) {
      enrollmentListener = listener;
      return () => {
        enrollmentListener = null;
      };
    },
  };
  const repositoryAccess = {
    async synchronize() {
      synchronizations += 1;
    },
  };
  const host = new AgentHost({
    dataDir,
    daemon: { start() {}, stop() {} },
    enrollment,
    repositoryAccess,
    detectLocalTools: false,
  });

  try {
    await host.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(synchronizations, 1, "startup reconciles pending local approvals");
    enrollmentListener({
      state: "active",
      user_code: null,
      verification_uri: null,
      expires_at: null,
      next_poll_at: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(synchronizations, 2, "activation retries without restarting AgentHost");
  } finally {
    await host.stop();
    removeTemporaryDataDir(dataDir);
  }
});

test("AgentHost requires an explicit local repository choice and removal preserves files", async () => {
  const dataDir = temporaryDataDir();
  const repositoryPath = join(dataDir, "selected-repository");
  mkdirSync(repositoryPath);
  execFileSync("git", ["-C", repositoryPath, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", repositoryPath, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.name", "Norns Test"]);
  writeFileSync(join(repositoryPath, "sentinel.txt"), "keep\n");
  execFileSync("git", ["-C", repositoryPath, "add", "sentinel.txt"]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-m", "initial"], {
    stdio: "ignore",
  });
  const physicalRepositoryPath = realpathSync(repositoryPath);
  let pickerCalls = 0;
  const cloudRegistrations = [];
  const registry = new WorkspaceRegistry(dataDir, async () => {
    pickerCalls += 1;
    return repositoryPath;
  });
  const access = new LocalRepositoryAccessController(dataDir, registry, {
    async register(repository) {
      cloudRegistrations.push(structuredClone(repository));
      return {
        registration_id: "registration-1",
        status: "active",
        workspace_id: repository.workspace_id,
        repository_id: repository.repository_id,
      };
    },
    async revoke(input) {
      return { registration_id: input.registration_id, status: "revoked" };
    },
  });
  const host = new AgentHost({
    dataDir,
    daemon: { start() {}, stop() {} },
    repositoryAccess: access,
    detectLocalTools: false,
  });

  try {
    const started = await host.start();
    const session = await exchangeBootstrap(started);
    const initial = await fetch(`${started.origin}/api/repositories`, {
      headers: { cookie: session.cookie },
    });
    assert.deepEqual(await initial.json(), { repositories: [], history: [] });

    const missingCsrf = await fetch(`${started.origin}/api/repositories/choose`, {
      method: "POST",
      headers: authenticatedHeaders(started, session),
      body: "{}",
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(pickerCalls, 0);

    const chosen = await fetch(`${started.origin}/api/repositories/choose`, {
      method: "POST",
      headers: authenticatedHeaders(started, session, true),
      body: "{}",
    });
    assert.equal(chosen.status, 200);
    const chosenBody = await chosen.json();
    assert.equal(chosenBody.cancelled, false);
    assert.equal(chosenBody.repository.local_path, physicalRepositoryPath);
    assert.equal(chosenBody.repository.sync_state, "active");
    assert.equal(pickerCalls, 1);
    assert.equal(cloudRegistrations.length, 1);
    assert.equal("local_path" in cloudRegistrations[0], false);
    assert.doesNotMatch(JSON.stringify(cloudRegistrations[0]), new RegExp(physicalRepositoryPath));

    const repositories = await fetch(`${started.origin}/api/repositories`, {
      headers: { cookie: session.cookie },
    });
    const repositoryBody = await repositories.json();
    assert.equal(repositoryBody.repositories[0].local_path, physicalRepositoryPath);
    assert.equal(repositoryBody.history[0].action, "approved");

    const stateChangingGet = await fetch(`${started.origin}/api/repositories/remove`);
    assert.equal(stateChangingGet.status, 405);

    const removed = await fetch(`${started.origin}/api/repositories/remove`, {
      method: "POST",
      headers: authenticatedHeaders(started, session, true),
      body: JSON.stringify({
        workspace_id: chosenBody.repository.workspace_id,
        repository_id: chosenBody.repository.repository_id,
      }),
    });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).local_access_removed, true);
    assert.equal(existsSync(join(repositoryPath, ".git")), true);
    assert.equal(readFileSync(join(repositoryPath, "sentinel.txt"), "utf8"), "keep\n");

    const support = await fetch(`${started.origin}/api/diagnostics/support`, {
      headers: { cookie: session.cookie },
    });
    assert.doesNotMatch(JSON.stringify(await support.json()), new RegExp(repositoryPath));
  } finally {
    await host.stop();
    removeTemporaryDataDir(dataDir);
  }
});

test("AgentHost reports separate local status dimensions and restarts the daemon", async () => {
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
  const credentialStore = new PendingDeviceCredentialStore(
    dataDir,
    new InMemoryDeviceCredentialSecretStore(),
  );
  const prepared = credentialStore.prepare();
  const host = new AgentHost({
    dataDir,
    daemon: lifecycle,
    credentialStore,
    detectLocalTools: false,
    localState: {
      device_name: "Office Mac mini",
      location_label: "Studio",
      enrolled_account: "owner@example.com",
      availability: "online",
      compatibility: "ready",
      workload: "busy",
      agent_version: "1.4.2",
      protocol_version: "device-wss/1",
      capabilities: ["context", "visual-evidence"],
      start_at_login: true,
      recent_activity: "Completed a Norns task 4 minutes ago.",
      repository_access_summary: "Two repositories approved for Norns.",
      failed_authorization_notices: ["A revoked project request was refused."],
      connectivity: "connected",
      git_version: "git version 2.50.1",
      runtimes: ["Codex", "Claude Code"],
    },
  });

  try {
    const started = await host.start();
    const session = await exchangeBootstrap(started);
    const initial = await fetch(`${started.origin}/api/status`, {
      headers: { cookie: session.cookie },
    });
    assert.equal(initial.status, 200);
    const initialBody = await initial.json();
    assert.equal(initialBody.home.device_name, "Office Mac mini");
    assert.equal(initialBody.home.location_label, "Studio");
    assert.equal(initialBody.home.availability, "offline");
    assert.equal(initialBody.home.compatibility, "ready");
    assert.equal(initialBody.home.workload, "busy");
    assert.equal(initialBody.security.enrolled_account, "owner@example.com");
    assert.equal(initialBody.security.public_key_fingerprint, prepared.public_key_fingerprint);
    assert.deepEqual(initialBody.diagnostics.capabilities, ["context", "visual-evidence"]);
    assert.equal("hostname" in initialBody.home, false);
    assert.equal("automatic_update_url" in initialBody.diagnostics, false);

    const support = await fetch(`${started.origin}/api/diagnostics/support`, {
      headers: { cookie: session.cookie },
    });
    assert.equal(support.status, 200);
    assert.match(support.headers.get("content-disposition") ?? "", /attachment/);
    const supportBody = await support.json();
    assert.equal(supportBody.format, "norns-agent-support-v1");
    assert.deepEqual(supportBody.redaction, {
      includes_secrets: false,
      includes_credentials: false,
      includes_raw_paths: false,
      includes_hostname: false,
      includes_account_identity: false,
    });
    assert.equal("public_key_fingerprint" in supportBody, false);
    assert.equal("enrolled_account" in supportBody, false);
    assert.equal("device_name" in supportBody, false);

    const start = await fetch(`${started.origin}/api/daemon/start`, {
      method: "POST",
      headers: authenticatedHeaders(started, session, true),
      body: "{}",
    });
    assert.equal(start.status, 200);
    assert.equal((await start.json()).home.availability, "online");

    const restart = await fetch(`${started.origin}/api/daemon/restart`, {
      method: "POST",
      headers: authenticatedHeaders(started, session, true),
      body: "{}",
    });
    assert.equal(restart.status, 200);
    assert.equal((await restart.json()).daemon_state, "running");
    assert.equal(lifecycle.starts, 2);
    assert.equal(lifecycle.stops, 1);
  } finally {
    await host.stop();
    assert.equal(lifecycle.stops, 2);
    removeTemporaryDataDir(dataDir);
  }
});

test("AgentHost emergency stop is distinct, confirmed, and leaves Control Center alive", async () => {
  const dataDir = temporaryDataDir();
  const lifecycle = {
    starts: 0,
    stops: 0,
    emergencyStops: 0,
    start() {
      this.starts += 1;
    },
    stop() {
      this.stops += 1;
    },
    async emergencyStop() {
      this.emergencyStops += 1;
      return { stop_requested: 3, process_trees_reaped: 2, unconfirmed: 1 };
    },
  };
  const host = new AgentHost({ dataDir, daemon: lifecycle, detectLocalTools: false });

  try {
    const started = await host.start();
    const session = await exchangeBootstrap(started);
    const startDaemon = await fetch(`${started.origin}/api/daemon/start`, {
      method: "POST",
      headers: authenticatedHeaders(started, session, true),
      body: "{}",
    });
    assert.equal(startDaemon.status, 200);
    const page = await fetch(started.origin);
    const html = await page.text();
    assert.match(html, /Emergency stop all Norns work/);
    assert.match(html, /same OS user/);

    const stateChangingGet = await fetch(`${started.origin}/api/emergency-stop`, {
      headers: { cookie: session.cookie },
    });
    assert.equal(stateChangingGet.status, 405);

    const missingCsrf = await fetch(`${started.origin}/api/emergency-stop`, {
      method: "POST",
      headers: authenticatedHeaders(started, session),
      body: JSON.stringify({ confirmation: "STOP ALL NORNS WORK" }),
    });
    assert.equal(missingCsrf.status, 403);

    const wrongConfirmation = await fetch(`${started.origin}/api/emergency-stop`, {
      method: "POST",
      headers: authenticatedHeaders(started, session, true),
      body: JSON.stringify({ confirmation: "stop" }),
    });
    assert.equal(wrongConfirmation.status, 400);
    assert.equal(lifecycle.emergencyStops, 0);

    const stopped = await fetch(`${started.origin}/api/emergency-stop`, {
      method: "POST",
      headers: authenticatedHeaders(started, session, true),
      body: JSON.stringify({ confirmation: "STOP ALL NORNS WORK" }),
    });
    assert.equal(stopped.status, 200);
    const stoppedBody = await stopped.json();
    assert.deepEqual(
      {
        stop_requested: stoppedBody.emergency_stop.stop_requested,
        process_trees_reaped: stoppedBody.emergency_stop.process_trees_reaped,
        unconfirmed: stoppedBody.emergency_stop.unconfirmed,
      },
      { stop_requested: 3, process_trees_reaped: 2, unconfirmed: 1 },
    );
    assert.equal(lifecycle.emergencyStops, 1);
    assert.equal(lifecycle.stops, 0);

    const status = await fetch(`${started.origin}/api/status`, {
      headers: { cookie: session.cookie },
    });
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.home.workload, "busy");
    assert.equal(statusBody.home.emergency_stop.unconfirmed, 1);
    assert.equal(statusBody.daemon_state, "running");

    // The loopback host remains available after emergency stop.
    const stillAlive = await fetch(started.origin);
    assert.equal(stillAlive.status, 200);
  } finally {
    await host.stop();
    removeTemporaryDataDir(dataDir);
  }
});

test("AgentHost redacts support fields that contain secrets, identities, or local paths", async () => {
  const dataDir = temporaryDataDir();
  const host = new AgentHost({
    dataDir,
    daemon: { start() {}, stop() {} },
    detectLocalTools: false,
    localState: {
      agent_version: "build sk-abcdefghijklmnopqrstuvwxyz /Users/alice/Norns",
      protocol_version: "device-wss/1 owner@example.com",
      capabilities: ["context", "path:/private/tmp/norns-worktree"],
      git_version: "git from C:\\Users\\alice\\bin",
      runtimes: ["Codex token=super-secret-value"],
    },
  });

  try {
    const started = await host.start();
    const session = await exchangeBootstrap(started);
    const support = await fetch(`${started.origin}/api/diagnostics/support`, {
      headers: { cookie: session.cookie },
    });
    assert.equal(support.status, 200);
    const serialized = JSON.stringify(await support.json());
    assert.doesNotMatch(
      serialized,
      /sk-abcdefghijklmnopqrstuvwxyz|\/Users\/alice|owner@example\.com|C:\\\\Users\\\\alice|super-secret-value/,
    );
    assert.match(serialized, /REDACTED/);
    assert.match(serialized, /device-wss\/1/);
  } finally {
    await host.stop();
    removeTemporaryDataDir(dataDir);
  }
});

test("AgentHost fences late daemon starts while shutting down", async () => {
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
  const host = new AgentHost({ dataDir, daemon: lifecycle, detectLocalTools: false });

  try {
    const started = await host.start();
    const session = await exchangeBootstrap(started);
    const startedDaemon = await fetch(`${started.origin}/api/daemon/start`, {
      method: "POST",
      headers: authenticatedHeaders(started, session, true),
      body: "{}",
    });
    assert.equal(startedDaemon.status, 200);

    let stoppingPromise = null;
    const lateResponse = new Promise((resolve, reject) => {
      const url = new URL(`${started.origin}/api/daemon/start`);
      const request = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            ...authenticatedHeaders(started, session, true),
            "content-length": "2",
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        },
      );
      request.once("error", reject);
      request.once("socket", (socket) => {
        const beginRequest = () => {
          request.write("{");
          setTimeout(() => {
            stoppingPromise = host.stop();
            request.end("}");
            void stoppingPromise.catch(reject);
          }, 20);
        };
        if (socket.connecting) socket.once("connect", beginRequest);
        else beginRequest();
      });
      request.flushHeaders();
    });

    assert.equal(await lateResponse, 503);
    await stoppingPromise;
    assert.equal(host.daemon, "stopped");
    assert.equal(lifecycle.starts, 1);
    assert.equal(lifecycle.stops, 1);
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
    detectLocalTools: false,
  });

  try {
    const started = await first.start();
    const second = new AgentHost({ dataDir, daemon, detectLocalTools: false });
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

  const replacement = new AgentHost({ dataDir, daemon, detectLocalTools: false });
  try {
    await replacement.start();
  } finally {
    await replacement.stop();
  }

  assert.equal(existsSync(join(dataDir, "agent-host.lock")), false);
  removeTemporaryDataDir(dataDir);
});

test("AgentHost recovers an exact dead-PID lock but never deletes malformed ownership", () => {
  const dataDir = temporaryDataDir();
  const lockPath = join(dataDir, AGENT_HOST_LOCK_FILENAME);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, "99999999\n", { encoding: "utf8", mode: 0o600 });
    const recovered = new FileAgentHostSingleInstanceLock(dataDir);
    recovered.acquire();
    recovered.release();
    assert.equal(existsSync(lockPath), false);

    writeFileSync(lockPath, "not-a-pid\n", { encoding: "utf8", mode: 0o600 });
    assert.throws(
      () => new FileAgentHostSingleInstanceLock(dataDir).acquire(),
      AgentHostAlreadyRunningError,
    );
    assert.equal(readFileSync(lockPath, "utf8"), "not-a-pid\n");
  } finally {
    removeTemporaryDataDir(dataDir);
  }
});
