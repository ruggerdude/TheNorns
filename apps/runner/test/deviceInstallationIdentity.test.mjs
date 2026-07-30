import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ACTIVE_DEVICE_IDENTITY_FILENAME, ActiveDeviceIdentityStore } from "../dist/index.js";

test("server-validated active device identity persists once and never transfers in place", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "norns-active-device-test-"));
  const store = new ActiveDeviceIdentityStore(dataDir);
  const identity = {
    device_id: "device-1",
    credential_id: "credential-1",
    generation: 1,
    activated_at: "2026-07-30T12:00:00.000Z",
  };
  try {
    assert.equal(store.read(), null);
    assert.deepEqual(store.activateFromRedemption(identity), identity);
    assert.deepEqual(new ActiveDeviceIdentityStore(dataDir).read(), identity);
    assert.equal(statSync(store.filePath).mode & 0o777, 0o600);
    assert.deepEqual(store.activateFromRedemption(identity), identity);
    assert.throws(
      () =>
        store.activateFromRedemption({
          ...identity,
          device_id: "device-other",
          credential_id: "credential-other",
        }),
      /revoke and re-enroll/,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("malformed active device identity fails closed", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "norns-active-device-malformed-test-"));
  try {
    writeFileSync(
      join(dataDir, ACTIVE_DEVICE_IDENTITY_FILENAME),
      JSON.stringify({
        version: 1,
        device_id: "../not-opaque",
        credential_id: "credential-1",
        generation: -1,
        activated_at: "never",
      }),
    );
    assert.throws(() => new ActiveDeviceIdentityStore(dataDir).read(), /malformed/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
