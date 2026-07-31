import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DeviceEnrollmentCodeHasher,
  canonicalDevicePublicKey,
  enrollmentRedemptionProofPayload,
  isValidDeviceCode,
} from "../src/devices/crypto.js";
import { DeviceEnrollmentError, type DeviceEnrollmentRepository } from "../src/devices/domain.js";
import { PostgresDeviceEnrollmentRepository } from "../src/devices/repository.js";
import { DeviceEnrollmentService } from "../src/devices/service.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const INITIAL_NOW = new Date("2026-07-29T14:00:00.000Z");

function ed25519KeyPair(): {
  public_key_pem: string;
  signProof: (payload: Buffer) => string;
} {
  const pair = generateKeyPairSync("ed25519");
  return {
    public_key_pem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    signProof: (payload) => sign(null, payload, pair.privateKey).toString("base64"),
  };
}

function unusedRepository(): DeviceEnrollmentRepository {
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    createAuthorization: unused,
    lookupByHumanCode: unused,
    getDecisionCandidate: unused,
    getOwnedAuthorization: unused,
    approve: unused,
    deny: unused,
    poll: unused,
    redeem: unused,
  };
}

describe("device enrollment cryptography", () => {
  it("fingerprints canonical Ed25519 SPKI DER and rejects another key type or trailing DER", () => {
    const key = ed25519KeyPair();
    const canonical = canonicalDevicePublicKey(key.public_key_pem);
    const crlf = key.public_key_pem.replaceAll("\n", "\r\n");
    expect(canonicalDevicePublicKey(crlf).fingerprint).toBe(canonical.fingerprint);
    expect(canonical.fingerprint).toBe(
      createHash("sha256").update(canonical.canonical_spki_der).digest("hex"),
    );

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    expect(() =>
      canonicalDevicePublicKey(rsa.export({ format: "pem", type: "spki" }).toString()),
    ).toThrow("invalid device public key");

    const withTrailingByte = Buffer.concat([canonical.canonical_spki_der, Buffer.of(0)]);
    const nonCanonicalPem = `-----BEGIN PUBLIC KEY-----\n${withTrailingByte.toString(
      "base64",
    )}\n-----END PUBLIC KEY-----`;
    expect(() => canonicalDevicePublicKey(nonCanonicalPem)).toThrow("invalid device public key");
  });

  it("accepts code-free HTTPS and exact loopback-IP HTTP verification URIs only", () => {
    const codeHasher = new DeviceEnrollmentCodeHasher({
      version: 1,
      key_id: "test-key",
      secret: Buffer.alloc(32, 7),
    });
    const construct = (verificationUri: string): DeviceEnrollmentService =>
      new DeviceEnrollmentService(unusedRepository(), { codeHasher, verificationUri });

    expect(() => construct("https://norns.example/device-authorization")).not.toThrow();
    expect(() => construct("http://127.0.0.1:5173/device-authorization")).not.toThrow();
    expect(() => construct("http://[::1]:5173/device-authorization")).not.toThrow();
    expect(() => construct("http://localhost:5173/device-authorization")).toThrow();
    expect(() => construct("http://127.0.0.2:5173/device-authorization")).toThrow();
    expect(() =>
      construct("https://norns.example/device-authorization?user_code=secret"),
    ).toThrow();
    expect(() => construct("https://user:pass@norns.example/device-authorization")).toThrow();
  });
});

describe.sequential("PostgreSQL device enrollment", () => {
  let pg: PGlite;
  let now: Date;
  let service: DeviceEnrollmentService;
  let idSequence: number;
  let codeSequence: number;
  let humanCodes: string[];

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO users (
        id,username,display_name,email,name,password_hash,password_hash_scheme,role,status,source
      )
      VALUES
        ('owner-1','owner1@example.com','Owner One','owner1@example.com','Owner One',
         'hash','scrypt-v1','member','active','native'),
        ('owner-2','owner2@example.com','Owner Two','owner2@example.com','Owner Two',
         'hash','scrypt-v1','admin','active','native'),
        ('disabled-1','disabled@example.com','Disabled','disabled@example.com','Disabled',
         'hash','scrypt-v1','member','disabled','native');
    `);
    now = new Date(INITIAL_NOW);
    idSequence = 0;
    codeSequence = 1;
    humanCodes = ["ABCD-EFGH", "JKLM-NPQR", "STUV-WXYZ", "2345-6789"];
    service = new DeviceEnrollmentService(
      new PostgresDeviceEnrollmentRepository(new PGliteTransactionRunner(pg)),
      {
        codeHasher: new DeviceEnrollmentCodeHasher({
          version: 1,
          key_id: "test-key",
          secret: Buffer.alloc(32, 7),
        }),
        verificationUri: "https://norns.example/device-authorization",
        now: () => new Date(now),
        newId: (prefix) => `${prefix}-${++idSequence}`,
      },
    );
  }, 30_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  function persistedCodes(): { device_code: string; user_code: string } {
    return {
      device_code: Buffer.alloc(32, codeSequence++).toString("base64url"),
      user_code: humanCodes.shift() ?? "CDEF-GHJK",
    };
  }

  it("stores only keyed code hashes and returns a non-consuming approval summary", async () => {
    const key = ed25519KeyPair();
    const created = await service.createAuthorization({
      ...persistedCodes(),
      public_key_pem: key.public_key_pem,
      proposed_name: "  Office Mac mini  ",
      os_family: "macos",
      architecture: "  arm64  ",
    });

    expect(isValidDeviceCode(created.device_code)).toBe(true);
    expect(created.user_code).toBe("ABCD-EFGH");
    expect(created.verification_uri).not.toContain(created.device_code);
    expect(created.verification_uri).not.toContain(created.user_code);

    const stored = await pg.query<{
      state: string;
      proposed_name: string;
      os_family: string;
      architecture: string;
      device_code_keyed_hash: Uint8Array;
      user_code_keyed_hash: Uint8Array;
    }>("SELECT * FROM device_authorization_requests WHERE id=$1", [
      created.authorization_request_id,
    ]);
    expect(stored.rows[0]).toMatchObject({
      state: "pending",
      proposed_name: "Office Mac mini",
      os_family: "macos",
      architecture: "arm64",
    });
    expect(Buffer.from(stored.rows[0]?.device_code_keyed_hash ?? []).byteLength).toBe(32);
    expect(Buffer.from(stored.rows[0]?.user_code_keyed_hash ?? []).byteLength).toBe(32);
    expect(JSON.stringify(stored.rows[0])).not.toContain(created.device_code);
    expect(JSON.stringify(stored.rows[0])).not.toContain(created.user_code);
    expect(JSON.stringify(stored.rows[0])).not.toContain("hostname");

    const forbiddenColumns = await pg.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name='device_authorization_requests'
          AND column_name IN ('device_code','user_code','hostname')`,
    );
    expect(forbiddenColumns.rows).toEqual([]);

    const lookup = await service.lookup({ user_code: "abcd efgh" });
    expect(lookup).toMatchObject({
      authorization_request_id: created.authorization_request_id,
      proposed_name: "Office Mac mini",
      os_family: "macos",
      architecture: "arm64",
    });
    expect(lookup.authorization_context).not.toContain(created.user_code);
    const afterLookup = await pg.query<{ state: string; approved_by_user_id: string | null }>(
      "SELECT state,approved_by_user_id FROM device_authorization_requests WHERE id=$1",
      [created.authorization_request_id],
    );
    expect(afterLookup.rows[0]).toEqual({ state: "pending", approved_by_user_id: null });

    await expect(
      service.approve({
        authorization_request_id: created.authorization_request_id,
        authorization_context: Buffer.alloc(32, 9).toString("base64url"),
        owner_user_id: "owner-1",
      }),
    ).rejects.toMatchObject({
      code: "authorization_not_available",
      message: "The device authorization request is not available.",
    });
  });

  it("replays the exact initiation after a lost create response and rejects a changed tuple", async () => {
    const key = ed25519KeyPair();
    const request = {
      device_code: Buffer.alloc(32, 91).toString("base64url"),
      user_code: "ABCD-EFGH",
      public_key_pem: key.public_key_pem,
      proposed_name: "Office Mac mini",
      os_family: "macos" as const,
      architecture: "arm64",
    };
    const first = await service.createAuthorization(request);
    await expect(service.createAuthorization(request)).resolves.toEqual(first);
    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM device_authorization_requests",
        )
      ).rows[0]?.count,
    ).toBe(1);

    await expect(
      service.createAuthorization({ ...request, user_code: "JKLM-NPQR" }),
    ).rejects.toMatchObject({ code: "authorization_not_available" });
  });

  it("converges concurrent exact creates and rejects a conflicting tuple for the same fresh key", async () => {
    const exactKey = ed25519KeyPair();
    const exactRequest = {
      device_code: Buffer.alloc(32, 81).toString("base64url"),
      user_code: "ABCD-EFGH",
      public_key_pem: exactKey.public_key_pem,
      proposed_name: "Concurrent exact request",
      os_family: "macos" as const,
      architecture: "arm64",
    };
    const exact = await Promise.all([
      service.createAuthorization(exactRequest),
      service.createAuthorization(exactRequest),
    ]);
    expect(exact[1]).toEqual(exact[0]);

    const conflictingKey = ed25519KeyPair();
    const common = {
      public_key_pem: conflictingKey.public_key_pem,
      proposed_name: "Concurrent conflicting request",
      os_family: "linux" as const,
      architecture: "x86_64",
    };
    const conflicting = await Promise.allSettled([
      service.createAuthorization({
        ...common,
        device_code: Buffer.alloc(32, 82).toString("base64url"),
        user_code: "JKLM-NPQR",
      }),
      service.createAuthorization({
        ...common,
        device_code: Buffer.alloc(32, 83).toString("base64url"),
        user_code: "STUV-WXYZ",
      }),
    ]);
    expect(conflicting.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = conflicting.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "authorization_not_available" }),
    });
    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM device_authorization_requests",
        )
      ).rows[0]?.count,
    ).toBe(2);
  });

  it.each(["pending", "approved_pending_redemption"] as const)(
    "expires an unpolled %s request before reusing its persisted key",
    async (initialState) => {
      const key = ed25519KeyPair();
      const first = await service.createAuthorization({
        ...persistedCodes(),
        public_key_pem: key.public_key_pem,
        proposed_name: "Offline Mac",
        os_family: "macos",
        architecture: "arm64",
      });
      if (initialState === "approved_pending_redemption") {
        const lookup = await service.lookup({ user_code: first.user_code });
        await service.approve({
          authorization_request_id: first.authorization_request_id,
          authorization_context: lookup.authorization_context,
          owner_user_id: "owner-1",
        });
      }

      // The agent stayed offline beyond expiry. No lookup or poll transitions
      // the old row before the same persisted key starts a fresh request.
      now = new Date(now.getTime() + 10 * 60 * 1_000 + 1);
      const second = await service.createAuthorization({
        ...persistedCodes(),
        public_key_pem: key.public_key_pem,
        proposed_name: "Offline Mac",
        os_family: "macos",
        architecture: "arm64",
      });
      expect(second.authorization_request_id).not.toBe(first.authorization_request_id);

      const requests = await pg.query<{
        id: string;
        state: string;
        approved_by_user_id: string | null;
        approved_at: Date | null;
        expired_at: Date | null;
        denied_at: Date | null;
        redeemed_at: Date | null;
      }>(
        `SELECT
           id,state,approved_by_user_id,approved_at,expired_at,denied_at,redeemed_at
           FROM device_authorization_requests
          ORDER BY created_at,id`,
      );
      expect(requests.rows).toHaveLength(2);
      expect(requests.rows[0]).toMatchObject({
        id: first.authorization_request_id,
        state: "expired",
        approved_by_user_id: initialState === "approved_pending_redemption" ? "owner-1" : null,
        denied_at: null,
        redeemed_at: null,
      });
      expect(requests.rows[0]?.expired_at).not.toBeNull();
      expect(requests.rows[0]?.approved_at === null).toBe(initialState === "pending");
      expect(requests.rows[1]).toMatchObject({
        id: second.authorization_request_id,
        state: "pending",
        approved_by_user_id: null,
        approved_at: null,
        expired_at: null,
      });
      await expect(service.poll({ device_code: first.device_code })).resolves.toEqual({
        outcome: "expired_token",
      });
      await expect(service.lookup({ user_code: second.user_code })).resolves.toMatchObject({
        authorization_request_id: second.authorization_request_id,
      });
    },
  );

  it("redeems with the persisted private key and replays the exact active identity after response loss", async () => {
    const key = ed25519KeyPair();
    const changedKey = ed25519KeyPair();
    const created = await service.createAuthorization({
      ...persistedCodes(),
      public_key_pem: key.public_key_pem,
      proposed_name: "Office Mac mini",
      os_family: "macos",
      architecture: "arm64",
    });
    const lookup = await service.lookup({ user_code: created.user_code });
    await service.approve({
      authorization_request_id: lookup.authorization_request_id,
      authorization_context: lookup.authorization_context,
      owner_user_id: "owner-1",
    });

    const wrongFingerprint = canonicalDevicePublicKey(changedKey.public_key_pem).fingerprint;
    const wrongProof = enrollmentRedemptionProofPayload({
      authorization_request_id: created.authorization_request_id,
      device_code: created.device_code,
      public_key_fingerprint: wrongFingerprint,
    });
    await expect(
      service.poll({
        device_code: created.device_code,
        public_key_pem: changedKey.public_key_pem,
        proof_signature_base64: changedKey.signProof(wrongProof),
      }),
    ).resolves.toEqual({ outcome: "access_denied" });
    now = new Date(now.getTime() + 5_000);

    const fingerprint = canonicalDevicePublicKey(key.public_key_pem).fingerprint;
    const proof = enrollmentRedemptionProofPayload({
      authorization_request_id: created.authorization_request_id,
      device_code: created.device_code,
      public_key_fingerprint: fingerprint,
    });
    const redemption = {
      device_code: created.device_code,
      public_key_pem: key.public_key_pem,
      proof_signature_base64: key.signProof(proof),
    };
    const first = await service.poll(redemption);
    expect(first).toMatchObject({ outcome: "active", generation: 1 });
    await expect(
      service.status({
        authorization_request_id: created.authorization_request_id,
        owner_user_id: "owner-1",
      }),
    ).resolves.toEqual({
      authorization_request_id: created.authorization_request_id,
      state: "active",
    });

    // Treat the first success as a lost HTTP response. A same-key retry must
    // return the committed tuple, even though the service generated new
    // candidate ids and the poll interval has not elapsed.
    const replay = await service.poll(redemption);
    expect(replay).toEqual(first);

    const counts = await pg.query<{ devices: number; credentials: number }>(
      `SELECT
         (SELECT count(*)::int FROM devices) AS devices,
         (SELECT count(*)::int FROM device_credentials) AS credentials`,
    );
    expect(counts.rows[0]).toEqual({ devices: 1, credentials: 1 });

    const active = await pg.query<{
      owner_user_id: string;
      display_name: string;
      os_family: string;
      architecture: string;
      current_generation: number | string;
      credential_generation: number | string;
      credential_state: string;
    }>(
      `SELECT device.owner_user_id,device.display_name,device.os_family,device.architecture,
              device.current_generation,
              credential.generation AS credential_generation,
              credential.state AS credential_state
         FROM devices device
         JOIN device_credentials credential ON credential.device_id=device.id`,
    );
    expect(active.rows[0]).toMatchObject({
      owner_user_id: "owner-1",
      display_name: "Office Mac mini",
      os_family: "macos",
      architecture: "arm64",
      credential_state: "active",
    });
    expect(Number(active.rows[0]?.current_generation)).toBe(1);
    expect(Number(active.rows[0]?.credential_generation)).toBe(1);

    await expect(
      service.poll({
        device_code: created.device_code,
        public_key_pem: changedKey.public_key_pem,
        proof_signature_base64: changedKey.signProof(wrongProof),
      }),
    ).resolves.toEqual({ outcome: "access_denied" });
    const unchanged = await pg.query<{ devices: number; credentials: number }>(
      `SELECT
         (SELECT count(*)::int FROM devices) AS devices,
         (SELECT count(*)::int FROM device_credentials) AS credentials`,
    );
    expect(unchanged.rows[0]).toEqual({ devices: 1, credentials: 1 });

    await expect(
      service.createAuthorization({
        ...persistedCodes(),
        public_key_pem: key.public_key_pem,
        proposed_name: "Duplicate key attempt",
        os_family: "macos",
        architecture: "arm64",
      }),
    ).rejects.toMatchObject({
      code: "authorization_not_available",
      message: "The device authorization request is not available.",
    });
    const authorizationCount = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM device_authorization_requests",
    );
    expect(authorizationCount.rows[0]?.count).toBe(1);
  });

  it("implements authorization_pending, slow_down, access_denied, and expired_token", async () => {
    const first = await service.createAuthorization({
      ...persistedCodes(),
      public_key_pem: ed25519KeyPair().public_key_pem,
      proposed_name: "Linux workstation",
      os_family: "linux",
      architecture: "x86_64",
    });
    await expect(service.poll({ device_code: first.device_code })).resolves.toEqual({
      outcome: "authorization_pending",
      retry_after_seconds: 5,
    });
    await expect(service.poll({ device_code: first.device_code })).resolves.toEqual({
      outcome: "slow_down",
      retry_after_seconds: 10,
    });
    const polling = await pg.query<{
      effective_poll_interval_seconds: number;
      slow_down_count: number;
      poll_attempt_count: number | string;
    }>(
      `SELECT effective_poll_interval_seconds,slow_down_count,poll_attempt_count
         FROM device_authorization_requests WHERE id=$1`,
      [first.authorization_request_id],
    );
    expect(polling.rows[0]).toMatchObject({
      effective_poll_interval_seconds: 10,
      slow_down_count: 1,
    });
    expect(Number(polling.rows[0]?.poll_attempt_count)).toBe(2);

    const firstLookup = await service.lookup({ user_code: first.user_code });
    await service.deny({
      authorization_request_id: first.authorization_request_id,
      authorization_context: firstLookup.authorization_context,
      denied_by_user_id: "owner-1",
    });
    await expect(service.poll({ device_code: first.device_code })).resolves.toEqual({
      outcome: "access_denied",
    });
    const denial = await pg.query<{ state: string; denied_by_user_id: string }>(
      "SELECT state,denied_by_user_id FROM device_authorization_requests WHERE id=$1",
      [first.authorization_request_id],
    );
    expect(denial.rows[0]).toEqual({ state: "denied", denied_by_user_id: "owner-1" });

    const second = await service.createAuthorization({
      ...persistedCodes(),
      public_key_pem: ed25519KeyPair().public_key_pem,
      proposed_name: "Windows desktop",
      os_family: "windows",
      architecture: "x86_64",
    });
    now = new Date(now.getTime() + 10 * 60 * 1_000 + 1);
    await expect(service.poll({ device_code: second.device_code })).resolves.toEqual({
      outcome: "expired_token",
    });
    const expiry = await pg.query<{ state: string; expired_at: Date | null }>(
      "SELECT state,expired_at FROM device_authorization_requests WHERE id=$1",
      [second.authorization_request_id],
    );
    expect(expiry.rows[0]?.state).toBe("expired");
    expect(expiry.rows[0]?.expired_at).not.toBeNull();

    await expect(service.poll({ device_code: "not-a-device-code" })).resolves.toEqual({
      outcome: "access_denied",
    });
  });

  it("binds approval to one active owner and never exposes submitted codes in failures", async () => {
    const created = await service.createAuthorization({
      ...persistedCodes(),
      public_key_pem: ed25519KeyPair().public_key_pem,
      proposed_name: "Shared-looking name",
      os_family: "other",
      architecture: "unknown",
    });
    const lookup = await service.lookup({ user_code: created.user_code });
    const approved = await service.approve({
      authorization_request_id: created.authorization_request_id,
      authorization_context: lookup.authorization_context,
      owner_user_id: "owner-1",
    });
    await expect(
      service.status({
        authorization_request_id: created.authorization_request_id,
        owner_user_id: "owner-1",
      }),
    ).resolves.toEqual({
      authorization_request_id: created.authorization_request_id,
      state: "approved_pending_redemption",
    });
    await expect(
      service.status({
        authorization_request_id: created.authorization_request_id,
        owner_user_id: "owner-2",
      }),
    ).rejects.toBeInstanceOf(DeviceEnrollmentError);
    await expect(
      service.approve({
        authorization_request_id: created.authorization_request_id,
        authorization_context: lookup.authorization_context,
        owner_user_id: "owner-1",
      }),
    ).resolves.toEqual(approved);
    await expect(
      service.approve({
        authorization_request_id: created.authorization_request_id,
        authorization_context: lookup.authorization_context,
        owner_user_id: "owner-2",
      }),
    ).rejects.toBeInstanceOf(DeviceEnrollmentError);

    const stored = await pg.query<{ approved_by_user_id: string; state: string }>(
      "SELECT approved_by_user_id,state FROM device_authorization_requests WHERE id=$1",
      [created.authorization_request_id],
    );
    expect(stored.rows[0]).toEqual({
      approved_by_user_id: "owner-1",
      state: "approved_pending_redemption",
    });

    const submitted = "AAAA-AAAA";
    let failure: unknown;
    try {
      await service.lookup({ user_code: submitted });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeviceEnrollmentError);
    expect(JSON.stringify(failure)).not.toContain(submitted);
    expect(failure instanceof Error ? failure.message : "").not.toContain(submitted);
  });
});
