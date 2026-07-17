import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createCredentialHmacKeyring,
  credentialHmacKeyFingerprint,
  hashLegacyCredentialToken,
  issueSplitCredential,
  parseSplitCredential,
  verifySplitCredential,
} from "../src/users/credentialTokens.js";
import {
  hasReusableLegacyCredentials,
  sanitizeLegacyCredentialSnapshot,
} from "../src/users/legacyCredentialSanitizer.js";
import {
  CURRENT_PASSWORD_HASH_SCHEME,
  LEGACY_PASSWORD_HASH_SCHEME,
  detectPasswordHashScheme,
  hashCurrentPassword,
  verifyAndRehashPassword,
  verifyCurrentScryptPassword,
  verifyLegacyScryptPassword,
  verifyPasswordHash,
} from "../src/users/passwords.js";

const TOKEN_KEY = {
  keyId: "credential-key-current",
  key: Buffer.alloc(32, 9),
};

function legacyPasswordHash(password: string): string {
  const salt = Buffer.alloc(16, 4);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

describe("Phase 2 split-token credential hashing", () => {
  it("returns an opaque split token while storing only a domain-separated HMAC", () => {
    const issued = issueSplitCredential("session", TOKEN_KEY, (size) => Buffer.alloc(size, size));
    const parsed = parseSplitCredential(issued.token, "session");

    expect(parsed?.id).toBe(issued.stored.id);
    expect(issued.stored.secret_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(issued.stored)).not.toContain(parsed?.secret);
    expect(verifySplitCredential(issued.token, issued.stored, TOKEN_KEY)).toBe(true);
    expect(verifySplitCredential(`${issued.token}x`, issued.stored, TOKEN_KEY)).toBe(false);
    expect(
      verifySplitCredential(issued.token, issued.stored, {
        keyId: "credential-key-next",
        key: TOKEN_KEY.key,
      }),
    ).toBe(false);
  });

  it("separates session, invitation, key, and stable-record hashing domains", () => {
    const raw = "legacy-opaque-secret";
    const session = hashLegacyCredentialToken(raw, "session", "session-1", TOKEN_KEY);
    const otherSession = hashLegacyCredentialToken(raw, "session", "session-2", TOKEN_KEY);
    const invite = hashLegacyCredentialToken(raw, "invite", "session-1", TOKEN_KEY);
    const differentKey = hashLegacyCredentialToken(raw, "session", "session-1", {
      keyId: "next",
      key: Buffer.alloc(32, 10),
    });

    expect(new Set([session, otherSession, invite, differentKey]).size).toBe(4);
    expect(session).not.toContain(raw);
  });

  it("rejects randomness sources that return the wrong lengths", () => {
    expect(() =>
      issueSplitCredential("session", TOKEN_KEY, (size) => Buffer.alloc(size - 1)),
    ).toThrow(/invalid length/);
  });

  it("binds every key ID to one fingerprint in a bounded verification keyring", () => {
    const previous = { keyId: "credential-key-previous", key: Buffer.alloc(32, 8) };
    const keyring = createCredentialHmacKeyring(TOKEN_KEY, [previous]);
    expect(keyring.current).toBe(TOKEN_KEY);
    expect(keyring.byId.get(previous.keyId)).toBe(previous);
    expect(credentialHmacKeyFingerprint(TOKEN_KEY)).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      createCredentialHmacKeyring(TOKEN_KEY, [
        { keyId: TOKEN_KEY.keyId, key: Buffer.alloc(32, 7) },
      ]),
    ).toThrow(/different key material/);
  });
});

describe("Phase 2 password compatibility and rehash", () => {
  it("verifies the exact legacy scrypt format and upgrades only after valid login", () => {
    const legacy = legacyPasswordHash("correct-password");
    expect(verifyLegacyScryptPassword("correct-password", legacy)).toBe(true);
    expect(verifyLegacyScryptPassword("wrong-password", legacy)).toBe(false);
    expect(verifyPasswordHash("correct-password", legacy, LEGACY_PASSWORD_HASH_SCHEME)).toEqual({
      valid: true,
      needs_rehash: true,
    });

    const upgraded = verifyAndRehashPassword(
      "correct-password",
      legacy,
      LEGACY_PASSWORD_HASH_SCHEME,
      (size) => Buffer.alloc(size, 6),
    );
    expect(upgraded.valid).toBe(true);
    expect(upgraded.upgraded_scheme).toBe(CURRENT_PASSWORD_HASH_SCHEME);
    expect(upgraded.upgraded_hash).not.toBeNull();
    expect(verifyCurrentScryptPassword("correct-password", upgraded.upgraded_hash ?? "")).toBe(
      true,
    );

    const rejected = verifyAndRehashPassword("wrong-password", legacy, LEGACY_PASSWORD_HASH_SCHEME);
    expect(rejected).toEqual({
      valid: false,
      upgraded_hash: null,
      upgraded_scheme: LEGACY_PASSWORD_HASH_SCHEME,
    });
  });

  it("uses a self-describing current hash that does not need another upgrade", () => {
    const current = hashCurrentPassword("current-password", (size) => Buffer.alloc(size, 8));
    expect(current).toMatch(/^scrypt\$v1\$16384\$8\$1\$/);
    expect(detectPasswordHashScheme(current)).toBe(CURRENT_PASSWORD_HASH_SCHEME);
    expect(detectPasswordHashScheme(legacyPasswordHash("legacy-password"))).toBe(
      LEGACY_PASSWORD_HASH_SCHEME,
    );
    expect(detectPasswordHashScheme("malformed")).toBeNull();
    expect(verifyCurrentScryptPassword("current-password", current)).toBe(true);
    expect(verifyPasswordHash("current-password", current, CURRENT_PASSWORD_HASH_SCHEME)).toEqual({
      valid: true,
      needs_rehash: false,
    });
  });
});

describe("Phase 2 legacy credential sanitization", () => {
  it("removes every reusable token without mutating or losing identity material", () => {
    const source = {
      snapshotVersion: 1,
      users: [
        {
          id: "user-admin",
          email: "admin@example.com",
          name: "Admin",
          role: "admin",
          status: "active",
          passwordHash: "preserved-password-hash",
          inviteToken: null,
          createdAt: "2026-07-16T19:00:00.000Z",
          futureField: { preserved: true },
        },
        {
          id: "user-invited",
          email: "invited@example.com",
          name: null,
          role: "member",
          status: "invited",
          passwordHash: null,
          inviteToken: "plaintext-invite",
          createdAt: "2026-07-16T19:01:00.000Z",
        },
      ],
      sessions: [
        {
          token: "plaintext-session",
          userId: "user-admin",
          createdAt: "2026-07-16T19:02:00.000Z",
        },
      ],
    };
    const original = structuredClone(source);

    expect(hasReusableLegacyCredentials(source)).toBe(true);
    const result = sanitizeLegacyCredentialSnapshot(source);

    expect(source).toEqual(original);
    expect(result.revoked_session_count).toBe(1);
    expect(result.revoked_invitation_count).toBe(1);
    expect(result.snapshot.sessions).toEqual([]);
    expect(result.snapshot.users.map((user) => user.inviteToken)).toEqual([null, null]);
    expect(result.snapshot.users[0]).toMatchObject({
      id: "user-admin",
      email: "admin@example.com",
      passwordHash: "preserved-password-hash",
      futureField: { preserved: true },
    });
    expect(result.snapshot.snapshotVersion).toBe(1);
    expect(hasReusableLegacyCredentials(result.snapshot)).toBe(false);
    expect(JSON.stringify(result.snapshot)).not.toContain("plaintext-session");
    expect(JSON.stringify(result.snapshot)).not.toContain("plaintext-invite");
  });
});
