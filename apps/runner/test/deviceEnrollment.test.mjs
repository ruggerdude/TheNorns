import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ACTIVE_DEVICE_IDENTITY_FILENAME,
  DEVICE_ENROLLMENT_STATE_FILENAME,
  DeviceEnrollmentCoordinator,
  InMemoryDeviceCredentialSecretStore,
  PENDING_DEVICE_CREDENTIAL_FILENAME,
  PendingDeviceCredentialStore,
} from "../dist/index.js";

function temporaryDataDir() {
  return mkdtempSync(join(tmpdir(), "norns-device-enrollment-test-"));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transcript({ authorizationRequestId, deviceCode, fingerprint }) {
  const fields = [
    ["authorization_request_id", authorizationRequestId],
    ["device_code", deviceCode],
    ["public_key_fingerprint", fingerprint],
  ];
  return `norns:device-enrollment-redemption:v1\n${fields
    .map(([name, value]) => `${name}:${Buffer.byteLength(value, "utf8")}:${value}\n`)
    .join("")}`;
}

test("enrollment persists the key first and redeems idempotently after response loss", async () => {
  const dataDir = temporaryDataDir();
  const secrets = new InMemoryDeviceCredentialSecretStore();
  const credential = new PendingDeviceCredentialStore(dataDir, secrets);
  const calls = [];
  const authorizationRequestId = "deviceauth-1";
  let committedCreateBody;
  let createAttempts = 0;
  let now = new Date("2026-07-30T12:00:00.000Z");
  const outcomes = [
    { outcome: "authorization_pending", retry_after_seconds: 5 },
    { outcome: "slow_down", retry_after_seconds: 10 },
    {
      outcome: "approved_pending_redemption",
      authorization_request_id: authorizationRequestId,
    },
    new Error("lost active response"),
    {
      outcome: "active",
      identity: { device_id: "device-1", credential_id: "devicecred-1" },
      generation: 3,
    },
  ];
  const timers = [];
  const fetcher = async (url, init) => {
    const parsedUrl = new URL(url);
    const body = JSON.parse(String(init.body));
    calls.push({ url: parsedUrl.toString(), method: init.method, body });
    assert.equal(init.method, "POST");
    assert.equal(parsedUrl.search, "");
    assert.equal(parsedUrl.hash, "");
    if (parsedUrl.pathname === "/api/device-authorizations") {
      assert.equal(credential.exists(), true, "key must exist before the first request");
      assert.match(body.device_code, /^[A-Za-z0-9_-]{43}$/);
      assert.match(
        body.user_code,
        /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/,
      );
      assert.doesNotMatch(parsedUrl.toString(), new RegExp(body.device_code));
      createAttempts += 1;
      if (createAttempts === 1) {
        committedCreateBody = structuredClone(body);
        return {
          ok: true,
          async json() {
            throw new Error(
              `server committed request before truncated response ${body.device_code}`,
            );
          },
        };
      }
      assert.deepEqual(body, committedCreateBody);
      return jsonResponse(
        {
          authorization_request_id: authorizationRequestId,
          device_code: body.device_code,
          user_code: body.user_code,
          verification_uri: "https://norns.example/device-authorization",
          expires_at: "2026-07-30T12:10:00.000Z",
          interval_seconds: 5,
        },
        201,
      );
    }
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return jsonResponse(outcome);
  };
  const coordinatorOptions = {
    serverUrl: "https://norns.example",
    dataDir,
    credentialStore: credential,
    secretStore: secrets,
    fetch: fetcher,
    now: () => now,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  };
  const coordinator = new DeviceEnrollmentCoordinator(coordinatorOptions);

  try {
    await assert.rejects(
      () => coordinator.begin({ proposed_name: "Office Mac mini" }),
      /device enrollment response was incomplete/,
    );
    const deviceCode = committedCreateBody.device_code;
    assert.equal(coordinator.status.state, "credential_prepared");
    assert.equal(secrets.size, 2, "key and device code survive a lost create response");
    assert.doesNotMatch(
      readFileSync(join(dataDir, DEVICE_ENROLLMENT_STATE_FILENAME), "utf8"),
      new RegExp(deviceCode),
    );
    coordinator.stop();

    const resumedCreate = new DeviceEnrollmentCoordinator(coordinatorOptions);
    const pending = await resumedCreate.begin({ proposed_name: "ignored after durable create" });
    assert.deepEqual(pending, {
      state: "pending",
      user_code: committedCreateBody.user_code,
      verification_uri: "https://norns.example/device-authorization",
      expires_at: "2026-07-30T12:10:00.000Z",
      next_poll_at: "2026-07-30T12:00:05.000Z",
    });
    assert.equal(secrets.size, 2, "protected key and device code must both survive restart");
    assert.doesNotMatch(
      readFileSync(join(dataDir, PENDING_DEVICE_CREDENTIAL_FILENAME), "utf8"),
      /BEGIN PRIVATE KEY/,
    );
    assert.doesNotMatch(
      readFileSync(join(dataDir, DEVICE_ENROLLMENT_STATE_FILENAME), "utf8"),
      new RegExp(deviceCode),
    );

    now = new Date("2026-07-30T12:00:05.000Z");
    assert.equal((await resumedCreate.pollNow()).state, "pending");
    now = new Date("2026-07-30T12:00:10.000Z");
    const slowed = await resumedCreate.pollNow();
    assert.equal(slowed.next_poll_at, "2026-07-30T12:00:20.000Z");

    now = new Date("2026-07-30T12:00:20.000Z");
    assert.equal((await resumedCreate.pollNow()).state, "approved_pending_redemption");
    const approvedState = readFileSync(join(dataDir, DEVICE_ENROLLMENT_STATE_FILENAME), "utf8");
    assert.doesNotMatch(approvedState, new RegExp(deviceCode));

    now = new Date("2026-07-30T12:00:21.000Z");
    await assert.rejects(
      () => resumedCreate.pollNow(),
      (error) => {
        assert.equal(error.message, "device authorization polling failed");
        assert.doesNotMatch(error.message, new RegExp(deviceCode));
        return true;
      },
    );
    const afterLoss = resumedCreate.status;
    assert.equal(afterLoss.state, "approved_pending_redemption");
    assert.equal(afterLoss.next_poll_at, "2026-07-30T12:00:41.000Z");

    resumedCreate.stop();
    const resumed = new DeviceEnrollmentCoordinator(coordinatorOptions);
    now = new Date("2026-07-30T12:00:41.000Z");
    assert.equal((await resumed.pollNow()).state, "active");
    assert.deepEqual(
      JSON.parse(readFileSync(join(dataDir, ACTIVE_DEVICE_IDENTITY_FILENAME), "utf8")),
      {
        version: 1,
        device_id: "device-1",
        credential_id: "devicecred-1",
        generation: 3,
        activated_at: "2026-07-30T12:00:41.000Z",
      },
    );
    assert.equal(secrets.size, 1, "device code is removed only after durable activation");

    const redemptionCalls = calls.filter(
      (call) => call.body.public_key_pem && call.body.proof_signature_base64,
    );
    assert.equal(redemptionCalls.length, 2);
    assert.deepEqual(redemptionCalls[1].body, redemptionCalls[0].body);
    const prepared = credential.read();
    assert.ok(prepared);
    assert.equal(
      verify(
        null,
        Buffer.from(
          transcript({
            authorizationRequestId,
            deviceCode,
            fingerprint: prepared.public_key_fingerprint,
          }),
        ),
        createPublicKey(prepared.public_key_pem),
        Buffer.from(redemptionCalls[0].body.proof_signature_base64, "base64"),
      ),
      true,
    );
    assert.ok(timers.every((timer) => timer.delay >= 0));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("polling timeouts back off durably without exposing the device code", async () => {
  const dataDir = temporaryDataDir();
  const secrets = new InMemoryDeviceCredentialSecretStore();
  const credential = new PendingDeviceCredentialStore(dataDir, secrets);
  let deviceCode = "";
  let now = new Date("2026-07-30T12:00:00.000Z");
  let created = false;
  const coordinator = new DeviceEnrollmentCoordinator({
    serverUrl: "https://norns.example",
    dataDir,
    credentialStore: credential,
    secretStore: secrets,
    now: () => now,
    requestTimeoutMs: 10,
    setTimer: (_callback, delay) => ({ delay, unref() {} }),
    clearTimer() {},
    fetch: async (url, init) => {
      if (!created) {
        created = true;
        const body = JSON.parse(String(init.body));
        deviceCode = body.device_code;
        return jsonResponse(
          {
            authorization_request_id: "deviceauth-timeout",
            device_code: body.device_code,
            user_code: body.user_code,
            verification_uri: "https://norns.example/device-authorization",
            expires_at: "2026-07-30T12:10:00.000Z",
            interval_seconds: 5,
          },
          201,
        );
      }
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new Error(`timeout carrying ${deviceCode}`)),
          { once: true },
        );
      });
    },
  });

  try {
    await coordinator.begin({ proposed_name: "This computer" });
    now = new Date("2026-07-30T12:00:05.000Z");
    await assert.rejects(
      () => coordinator.pollNow(),
      (error) => {
        assert.equal(error.message, "device authorization polling failed");
        assert.doesNotMatch(error.message, new RegExp(deviceCode));
        return true;
      },
    );
    assert.equal(coordinator.status.next_poll_at, "2026-07-30T12:00:15.000Z");
    now = new Date("2026-07-30T12:00:15.000Z");
    await assert.rejects(() => coordinator.pollNow(), /device authorization polling failed/);
    assert.equal(coordinator.status.next_poll_at, "2026-07-30T12:00:35.000Z");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

for (const [outcome, expectedState] of [
  ["access_denied", "denied"],
  ["expired_token", "expired"],
]) {
  test(`enrollment maps ${outcome} to terminal ${expectedState} and removes its device code`, async () => {
    const dataDir = temporaryDataDir();
    const secrets = new InMemoryDeviceCredentialSecretStore();
    const credential = new PendingDeviceCredentialStore(dataDir, secrets);
    let deviceCode = "";
    let request = 0;
    const coordinator = new DeviceEnrollmentCoordinator({
      serverUrl: "https://norns.example",
      dataDir,
      credentialStore: credential,
      secretStore: secrets,
      setTimer: (_callback, delay) => ({ delay, unref() {} }),
      clearTimer() {},
      fetch: async (_url, init) => {
        request += 1;
        const body = JSON.parse(String(init.body));
        if (request === 1) deviceCode = body.device_code;
        return request === 1
          ? jsonResponse(
              {
                authorization_request_id: `deviceauth-${expectedState}`,
                device_code: body.device_code,
                user_code: body.user_code,
                verification_uri: "https://norns.example/device-authorization",
                expires_at: new Date(Date.now() + 600_000).toISOString(),
                interval_seconds: 5,
              },
              201,
            )
          : jsonResponse({ outcome });
      },
    });
    try {
      await coordinator.begin({ proposed_name: "This computer" });
      assert.equal((await coordinator.pollNow()).state, expectedState);
      assert.deepEqual(coordinator.status, {
        state: expectedState,
        user_code: null,
        verification_uri: null,
        expires_at: coordinator.status.expires_at,
        next_poll_at: null,
      });
      assert.equal(secrets.size, 1);
      assert.doesNotMatch(
        readFileSync(join(dataDir, DEVICE_ENROLLMENT_STATE_FILENAME), "utf8"),
        new RegExp(deviceCode),
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}
