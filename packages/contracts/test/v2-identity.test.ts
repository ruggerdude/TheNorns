import { describe, expect, it } from "vitest";
import { V2IdentityUser, V2Invitation, V2SessionInventoryRecord } from "../src/v2/index.js";

const NOW = "2026-07-16T12:00:00.000Z";
const LATER = "2026-08-16T12:00:00.000Z";
const HASH = "a".repeat(64);

describe("V2 preservation identity contracts", () => {
  it("represents an invited legacy user without inventing a name or password", () => {
    const invited = {
      schema_version: 2,
      id: "user-invited",
      email: " Invitee@Example.com ",
      name: null,
      role: "member",
      status: "invited",
      password_hash: null,
      password_hash_scheme: null,
      password_rehashed_at: null,
      source: "legacy_snapshot",
      source_record_id: "legacy-user-invited",
      created_at: NOW,
      updated_at: NOW,
    } as const;

    const parsed = V2IdentityUser.parse(invited);
    expect(parsed.email).toBe("invitee@example.com");
    expect(parsed.name).toBeNull();
    expect(
      V2IdentityUser.safeParse({ ...invited, status: "active", password_hash: null }).success,
    ).toBe(false);
    expect(V2IdentityUser.safeParse({ ...invited, password_hash: "already-set" }).success).toBe(
      false,
    );
  });

  it("requires imported session credentials to be revoked inventory", () => {
    const session = {
      schema_version: 2,
      id: "session-legacy",
      user_id: "user-1",
      token_hash: HASH,
      token_hash_scheme: "hmac-sha256",
      token_key_id: "identity-token-key-v1",
      status: "revoked",
      created_at: NOW,
      expires_at: NOW,
      revoked_at: NOW,
      last_seen_at: null,
      revocation_reason: "legacy_cutover",
      source: "legacy_snapshot",
      source_record_id: "legacy-session-1",
    } as const;

    expect(V2SessionInventoryRecord.safeParse(session).success).toBe(true);
    expect(
      V2SessionInventoryRecord.safeParse({
        ...session,
        status: "active",
        revoked_at: null,
      }).success,
    ).toBe(false);
  });

  it("hashes and revokes imported invitation inventory", () => {
    const invitation = {
      schema_version: 2,
      id: "invitation-legacy",
      user_id: "user-invited",
      token_hash: HASH,
      token_hash_scheme: "hmac-sha256",
      token_key_id: "identity-token-key-v1",
      status: "revoked",
      created_at: NOW,
      expires_at: LATER,
      accepted_at: null,
      revoked_at: NOW,
      revocation_reason: "legacy_cutover",
      source: "legacy_snapshot",
      source_record_id: "legacy-invitation-1",
    } as const;

    expect(V2Invitation.safeParse(invitation).success).toBe(true);
    expect(
      V2Invitation.safeParse({
        ...invitation,
        status: "pending",
        revoked_at: null,
      }).success,
    ).toBe(false);
  });
});
