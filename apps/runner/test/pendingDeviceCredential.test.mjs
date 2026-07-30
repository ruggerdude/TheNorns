import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DevelopmentFileDeviceCredentialSecretStore,
  InMemoryDeviceCredentialSecretStore,
  createInstalledDeviceCredentialSecretStore,
} from "../dist/deviceCredentialSecretStore.js";
import {
  PENDING_DEVICE_CREDENTIAL_FILENAME,
  PendingDeviceCredentialStore,
} from "../dist/pendingDeviceCredential.js";

function temporaryDataDir() {
  return mkdtempSync(join(tmpdir(), "norns-pending-credential-test-"));
}

test("pending credential is durably protected before enrollment can use its public key", () => {
  const dataDir = temporaryDataDir();
  const createdAt = new Date("2026-07-29T12:00:00.000Z");
  const secrets = new InMemoryDeviceCredentialSecretStore();
  const store = new PendingDeviceCredentialStore(dataDir, secrets, () => createdAt);

  try {
    assert.equal(store.read(), null);
    assert.throws(() => store.sign("before-prepare"), /has not been prepared/);

    const prepared = store.prepare();
    assert.equal(prepared.algorithm, "Ed25519");
    assert.equal(prepared.created_at, createdAt.toISOString());
    assert.match(prepared.public_key_fingerprint, /^[a-f0-9]{64}$/);
    assert.match(prepared.public_key_pem, /BEGIN PUBLIC KEY/);
    assert.equal("private_key_pem" in prepared, false);

    const path = join(dataDir, PENDING_DEVICE_CREDENTIAL_FILENAME);
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const persisted = readFileSync(path, "utf8");
    assert.doesNotMatch(persisted, /BEGIN PRIVATE KEY/);
    assert.match(persisted, /secret_reference/);
    assert.equal(secrets.size, 1);

    const payload = "norns:device-enrollment-proof:v1\nrequest-1";
    const signature = Buffer.from(store.sign(payload), "base64");
    assert.equal(
      verify(null, Buffer.from(payload), createPublicKey(prepared.public_key_pem), signature),
      true,
    );

    const reloaded = new PendingDeviceCredentialStore(dataDir, secrets);
    assert.deepEqual(reloaded.read(), prepared);
    assert.deepEqual(reloaded.prepare(), prepared);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("pending credential rejects a persisted public/private key mismatch", () => {
  const firstDir = temporaryDataDir();
  const secondDir = temporaryDataDir();
  const first = new PendingDeviceCredentialStore(
    firstDir,
    new InMemoryDeviceCredentialSecretStore(),
  );
  const second = new PendingDeviceCredentialStore(
    secondDir,
    new InMemoryDeviceCredentialSecretStore(),
  );

  try {
    first.prepare();
    second.prepare();
    const firstPath = join(firstDir, PENDING_DEVICE_CREDENTIAL_FILENAME);
    const secondPath = join(secondDir, PENDING_DEVICE_CREDENTIAL_FILENAME);
    const firstRecord = JSON.parse(readFileSync(firstPath, "utf8"));
    const secondRecord = JSON.parse(readFileSync(secondPath, "utf8"));
    firstRecord.public_key_pem = secondRecord.public_key_pem;
    writeFileSync(firstPath, JSON.stringify(firstRecord), { encoding: "utf8", mode: 0o600 });
    chmodSync(firstPath, 0o600);

    assert.throws(() => first.read(), /keypair does not match/);
  } finally {
    rmSync(firstDir, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
});

test("concurrent preparation converges and removes the losing protected secret", () => {
  const dataDir = temporaryDataDir();
  class RacingSecretStore extends InMemoryDeviceCredentialSecretStore {
    nested = null;
    raced = false;

    writeOnce(reference, secret) {
      super.writeOnce(reference, secret);
      if (!this.raced && this.nested) {
        this.raced = true;
        this.nested.prepare();
      }
    }
  }
  const secrets = new RacingSecretStore();
  const first = new PendingDeviceCredentialStore(dataDir, secrets);
  const second = new PendingDeviceCredentialStore(dataDir, secrets);
  secrets.nested = second;

  try {
    const prepared = first.prepare();
    assert.deepEqual(second.read(), prepared);
    assert.equal(secrets.size, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("installed credential storage fails closed unless an OS vault or explicit dev fallback exists", () => {
  const dataDir = temporaryDataDir();
  try {
    assert.throws(
      () =>
        createInstalledDeviceCredentialSecretStore(dataDir, {
          platform: "aix",
        }),
      /no supported OS-protected/,
    );
    const development = createInstalledDeviceCredentialSecretStore(dataDir, {
      platform: "aix",
      allowInsecureDevelopmentFile: true,
    });
    assert.ok(development instanceof DevelopmentFileDeviceCredentialSecretStore);
    assert.equal(development.protection, "development-file");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
