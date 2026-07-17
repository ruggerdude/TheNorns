import { scryptSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PGliteDatabaseLike,
  PGliteTransactionRunner,
} from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import {
  registerCredentialHmacKey,
  retireCredentialHmacKey,
} from "../src/users/credentialKeyRegistry.js";
import {
  type CredentialHmacKey,
  issueSplitCredential,
  parseSplitCredential,
} from "../src/users/credentialTokens.js";
import { IdentityAlreadyBootstrappedError } from "../src/users/identityService.js";
import { LegacyIdentityService } from "../src/users/legacyIdentityService.js";
import {
  CURRENT_PASSWORD_HASH_SCHEME,
  verifyCurrentScryptPassword,
} from "../src/users/passwords.js";
import {
  RelationalIdentityService,
  type RelationalIdentityServiceOptions,
} from "../src/users/relationalIdentityService.js";
import {
  InvalidCredentialsError,
  InvalidInviteError,
  LastActiveAdminError,
  UserStore,
} from "../src/users/store.js";

const CREDENTIAL_KEY: CredentialHmacKey = {
  keyId: "identity-key-test",
  key: Buffer.alloc(32, 11),
};

function legacyPasswordHash(password: string): string {
  const salt = Buffer.alloc(16, 7);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

interface IdentityHarness {
  pg: PGlite;
  service: RelationalIdentityService;
  restart(): RelationalIdentityService;
  setNow(value: string): void;
}

async function setup(
  overrides: Pick<RelationalIdentityServiceOptions, "sessionTtlMs" | "invitationTtlMs"> = {},
): Promise<IdentityHarness> {
  const pg = new PGlite();
  await pg.exec(`
    CREATE ROLE norns_app NOLOGIN;
    CREATE TABLE norns_state (
      key TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO norns_state (key, snapshot) VALUES
      ('users', '{"users":[],"sessions":[]}'::jsonb),
      ('projects', '{"projects":[]}'::jsonb),
      ('relay', '{"audit":[]}'::jsonb);
  `);
  await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);

  let clock = new Date("2026-07-16T20:00:00.000Z");
  let randomCounter = 1;
  let idCounter = 1;
  const transactions = new PGliteTransactionRunner(pg as unknown as PGliteDatabaseLike);
  const serviceOptions: RelationalIdentityServiceOptions = {
    transactions,
    credentialKey: CREDENTIAL_KEY,
    clock: () => new Date(clock),
    newId: () => `user-test-${idCounter++}`,
    randomBytes: (size) => Buffer.alloc(size, randomCounter++),
    ...overrides,
  };
  return {
    pg,
    service: new RelationalIdentityService(serviceOptions),
    restart: () => new RelationalIdentityService(serviceOptions),
    setNow(value: string) {
      clock = new Date(value);
    },
  };
}

describe.sequential("Phase 2 relational identity service", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(
      databases.splice(0).map(async (database) => {
        if (!database.closed) await database.close();
      }),
    );
  });

  it("serializes first-admin bootstrap inside the relational transaction", async () => {
    const harness = await setup();
    databases.push(harness.pg);
    await expect(
      harness.service.bootstrapAdmin({
        email: "bootstrap-admin@example.com",
        password: "bootstrap-password",
      }),
    ).resolves.toMatchObject({ role: "admin", status: "active" });
    await expect(
      harness.service.bootstrapAdmin({
        email: "second-admin@example.com",
        password: "second-password",
      }),
    ).rejects.toBeInstanceOf(IdentityAlreadyBootstrappedError);
  });

  it("upgrades a legacy password and creates the session in one transaction", async () => {
    const harness = await setup();
    databases.push(harness.pg);
    const legacyHash = legacyPasswordHash("old-password");
    await harness.pg.query(
      `INSERT INTO users (
         id, username, display_name, email, name, password_hash,
         password_hash_scheme, role, status, source, created_at, updated_at
       ) VALUES (
         'legacy-admin', 'admin@example.com', 'Admin', 'admin@example.com',
         'Admin', $1, 'legacy-scrypt-v0', 'admin', 'active',
         'legacy_snapshot', '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'
       )`,
      [legacyHash],
    );

    const login = await harness.service.login("  ADMIN@EXAMPLE.COM ", "old-password");
    expect(login.user).toMatchObject({
      id: "legacy-admin",
      email: "admin@example.com",
      status: "active",
    });
    expect(login.token).toMatch(/^norns_session_/);

    const result = await harness.pg.query<{
      password_hash: string;
      password_hash_scheme: string;
      password_rehashed_at: Date | null;
      sessions: number;
    }>(
      `SELECT
         u.password_hash,
         u.password_hash_scheme,
         u.password_rehashed_at,
         (SELECT count(*) FROM sessions s WHERE s.user_id = u.id)::int AS sessions
       FROM users u WHERE u.id = 'legacy-admin'`,
    );
    expect(result.rows[0]?.password_hash_scheme).toBe(CURRENT_PASSWORD_HASH_SCHEME);
    expect(result.rows[0]?.password_hash).not.toBe(legacyHash);
    expect(verifyCurrentScryptPassword("old-password", result.rows[0]?.password_hash ?? "")).toBe(
      true,
    );
    expect(result.rows[0]?.password_rehashed_at).not.toBeNull();
    expect(result.rows[0]?.sessions).toBe(1);
  });

  it("rolls back a legacy rehash when session creation cannot commit", async () => {
    const harness = await setup();
    databases.push(harness.pg);
    const legacyHash = legacyPasswordHash("old-password");
    const collidingSessionId = Buffer.alloc(16, 2).toString("base64url");
    await harness.pg.query(
      `INSERT INTO users (
         id, username, display_name, email, name, password_hash,
         password_hash_scheme, role, status, source, created_at, updated_at
       ) VALUES (
         'legacy-admin', 'admin@example.com', 'Admin', 'admin@example.com',
         'Admin', $1, 'legacy-scrypt-v0', 'admin', 'active',
         'legacy_snapshot', '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'
       )`,
      [legacyHash],
    );
    await harness.pg.query(
      `INSERT INTO sessions (
         id, user_id, token_hash, token_hash_scheme, token_key_id,
         status, created_at, expires_at, revoked_at, last_seen_at,
         revocation_reason, source
       ) VALUES (
         $1, 'legacy-admin', $2, 'hmac-sha256', $3,
         'revoked', '2026-07-15T12:00:00Z', '2027-07-15T12:00:00Z',
         '2026-07-15T12:01:00Z', NULL, 'test_collision', 'native'
       )`,
      [collidingSessionId, "0".repeat(64), CREDENTIAL_KEY.keyId],
    );

    await expect(harness.service.login("admin@example.com", "old-password")).rejects.toThrow();
    const persisted = await harness.pg.query<{
      password_hash: string;
      password_hash_scheme: string;
      sessions: number;
    }>(
      `SELECT
         u.password_hash,
         u.password_hash_scheme,
         (SELECT count(*) FROM sessions WHERE user_id = u.id)::int AS sessions
       FROM users u WHERE u.id = 'legacy-admin'`,
    );
    expect(persisted.rows[0]).toEqual({
      password_hash: legacyHash,
      password_hash_scheme: "legacy-scrypt-v0",
      sessions: 1,
    });
  });

  it("persists only a session HMAC and resolves it after a service restart", async () => {
    const harness = await setup();
    databases.push(harness.pg);
    await harness.service.createActive({
      email: "Admin@Example.com",
      name: "Admin",
      password: "current-password",
      role: "admin",
    });
    const login = await harness.service.login("admin@example.com", "current-password");
    const parsed = parseSplitCredential(login.token, "session");
    expect(parsed).not.toBeNull();

    const stored = await harness.pg.query<{
      id: string;
      token_hash: string;
      token_hash_scheme: string;
      token_key_id: string | null;
    }>(
      `SELECT id, token_hash, token_hash_scheme, token_key_id
       FROM sessions`,
    );
    expect(stored.rows[0]).toMatchObject({
      id: parsed?.id,
      token_hash_scheme: "hmac-sha256",
      token_key_id: CREDENTIAL_KEY.keyId,
    });
    expect(stored.rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.rows[0]?.token_hash).not.toContain(parsed?.secret);
    expect(JSON.stringify(stored.rows)).not.toContain(login.token);

    const restarted = harness.restart();
    await expect(restarted.userForToken(login.token)).resolves.toMatchObject({
      email: "admin@example.com",
      role: "admin",
    });
  });

  it("enforces logout and server-side expiry", async () => {
    const harness = await setup({ sessionTtlMs: 1_000 });
    databases.push(harness.pg);
    await harness.service.createActive({
      email: "admin@example.com",
      password: "current-password",
      role: "admin",
    });

    const loggedOut = await harness.service.login("admin@example.com", "current-password");
    await harness.service.logout(loggedOut.token);
    await expect(harness.service.userForToken(loggedOut.token)).resolves.toBeUndefined();

    const expiring = await harness.service.login("admin@example.com", "current-password");
    harness.setNow("2026-07-16T20:00:01.001Z");
    await expect(harness.service.userForToken(expiring.token)).resolves.toBeUndefined();
    const statuses = await harness.pg.query<{ status: string; revocation_reason: string | null }>(
      "SELECT status, revocation_reason FROM sessions ORDER BY created_at, id",
    );
    expect(statuses.rows.map((row) => row.status).sort()).toEqual(["expired", "revoked"]);
    expect(statuses.rows.some((row) => row.revocation_reason === "logout")).toBe(true);
  });

  it("accepts a native invitation once, enforces expiry, and never stores raw tokens", async () => {
    const harness = await setup({ invitationTtlMs: 1_000 });
    databases.push(harness.pg);
    const invitation = await harness.service.createInvite({
      email: " New.Member@Example.com ",
      name: "New Member",
      role: "member",
    });
    const parsed = parseSplitCredential(invitation.inviteToken, "invite");
    const stored = await harness.pg.query<{
      token_hash: string;
      token_hash_scheme: string;
      token_key_id: string;
      status: string;
    }>("SELECT token_hash, token_hash_scheme, token_key_id, status FROM invitations");
    expect(stored.rows[0]).toMatchObject({
      token_hash_scheme: "hmac-sha256",
      token_key_id: CREDENTIAL_KEY.keyId,
      status: "pending",
    });
    expect(stored.rows[0]?.token_hash).not.toContain(parsed?.secret);
    expect(JSON.stringify(stored.rows)).not.toContain(invitation.inviteToken);

    await expect(
      harness.service.acceptInvite(`${invitation.inviteToken}x`, "member-password"),
    ).rejects.toBeInstanceOf(InvalidInviteError);
    await expect(
      harness.service.acceptInvite(invitation.inviteToken, "member-password"),
    ).resolves.toMatchObject({
      email: "new.member@example.com",
      status: "active",
    });
    await expect(
      harness.service.acceptInvite(invitation.inviteToken, "another-password"),
    ).rejects.toBeInstanceOf(InvalidInviteError);
    await expect(
      harness.service.login("new.member@example.com", "member-password"),
    ).resolves.toMatchObject({ user: { status: "active" } });

    const expiring = await harness.service.createInvite({
      email: "late.member@example.com",
      role: "member",
    });
    harness.setNow("2026-07-16T20:00:01.001Z");
    await expect(
      harness.service.acceptInvite(expiring.inviteToken, "too-late"),
    ).rejects.toBeInstanceOf(InvalidInviteError);
    const expired = await harness.pg.query<{ status: string }>(
      "SELECT status FROM invitations WHERE user_id = $1",
      [expiring.summary.id],
    );
    expect(expired.rows[0]?.status).toBe("expired");
  });

  it("refuses imported revoked credentials even when their HMACs are valid", async () => {
    const harness = await setup();
    databases.push(harness.pg);
    const admin = await harness.service.createActive({
      email: "admin@example.com",
      password: "password",
      role: "admin",
    });
    let randomCounter = 40;
    const issued = issueSplitCredential("session", CREDENTIAL_KEY, (size) =>
      Buffer.alloc(size, randomCounter++),
    );
    await harness.pg.query(
      `INSERT INTO sessions (
         id, user_id, token_hash, token_hash_scheme, token_key_id,
         status, created_at, expires_at, revoked_at, last_seen_at,
         revocation_reason, source, source_record_id
       ) VALUES (
         $1, $2, $3, $4, $5,
         'revoked', '2026-07-15T00:00:00Z', '2027-07-15T00:00:00Z',
         '2026-07-16T00:00:00Z', NULL,
         'migration_cutover', 'legacy_snapshot', 'legacy-session-1'
       )`,
      [
        issued.stored.id,
        admin.id,
        issued.stored.secret_hash,
        issued.stored.hash_scheme,
        issued.stored.key_id,
      ],
    );

    await expect(harness.service.userForToken(issued.token)).resolves.toBeUndefined();
    await expect(harness.service.userForToken("legacy-opaque-session")).resolves.toBeUndefined();

    const invitedUserId = "legacy-invited-user";
    await harness.pg.query(
      `INSERT INTO users (
         id, username, display_name, email, name, password_hash,
         password_hash_scheme, role, status, source, source_record_id,
         created_at, updated_at
       ) VALUES (
         $1, 'legacy-invited@example.com', 'Legacy Invite',
         'legacy-invited@example.com', 'Legacy Invite', NULL,
         NULL, 'member', 'invited', 'legacy_snapshot', 'legacy-user-invite',
         '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z'
       )`,
      [invitedUserId],
    );
    const importedInvite = issueSplitCredential("invite", CREDENTIAL_KEY, (size) =>
      Buffer.alloc(size, randomCounter++),
    );
    await harness.pg.query(
      `INSERT INTO invitations (
         id, user_id, token_hash, token_hash_scheme, token_key_id,
         status, created_at, expires_at, accepted_at, revoked_at,
         revocation_reason, source, source_record_id
       ) VALUES (
         $1, $2, $3, $4, $5,
         'revoked', '2026-07-15T00:00:00Z', '2027-07-15T00:00:00Z',
         NULL, '2026-07-16T00:00:00Z',
         'migration_cutover', 'legacy_snapshot', 'legacy-invite-1'
       )`,
      [
        importedInvite.stored.id,
        invitedUserId,
        importedInvite.stored.secret_hash,
        importedInvite.stored.hash_scheme,
        importedInvite.stored.key_id,
      ],
    );
    await expect(
      harness.service.acceptInvite(importedInvite.token, "new-password"),
    ).rejects.toBeInstanceOf(InvalidInviteError);

    const reissued = await harness.service.createInvite({
      email: "LEGACY-INVITED@EXAMPLE.COM",
      name: "Replacement Name",
      role: "admin",
    });
    expect(reissued.summary).toMatchObject({
      id: invitedUserId,
      name: "Legacy Invite",
      role: "member",
      status: "invited",
    });
    await expect(
      harness.service.acceptInvite(reissued.inviteToken, "new-password"),
    ).resolves.toMatchObject({
      id: invitedUserId,
      status: "active",
    });
    await expect(
      harness.service.acceptInvite(importedInvite.token, "other-password"),
    ).rejects.toBeInstanceOf(InvalidInviteError);
    const invitationHistory = await harness.pg.query<{ source: string; status: string }>(
      `SELECT source, status
       FROM invitations
       WHERE user_id = $1
       ORDER BY source`,
      [invitedUserId],
    );
    expect(invitationHistory.rows).toEqual([
      { source: "legacy_snapshot", status: "revoked" },
      { source: "native", status: "accepted" },
    ]);
  });

  it("soft-disables users, revokes sessions, and preserves the last active admin", async () => {
    const harness = await setup();
    databases.push(harness.pg);
    const first = await harness.service.createActive({
      email: "first-admin@example.com",
      password: "password",
      role: "admin",
    });
    const firstSession = await harness.service.login(first.email, "password");
    await expect(harness.service.disable(first.id)).rejects.toBeInstanceOf(LastActiveAdminError);

    const second = await harness.service.createActive({
      email: "second-admin@example.com",
      password: "password",
      role: "admin",
    });
    await harness.service.disable(first.id);
    await expect(harness.service.userForToken(firstSession.token)).resolves.toBeUndefined();
    await expect(harness.service.login(first.email, "password")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    await expect(harness.service.remove(second.id)).rejects.toBeInstanceOf(LastActiveAdminError);

    const state = await harness.pg.query<{
      status: string;
      session_status: string | null;
      raw_user_count: number;
    }>(
      `SELECT
         u.status,
         (SELECT status FROM sessions WHERE user_id = u.id LIMIT 1) AS session_status,
         (SELECT count(*) FROM users WHERE id = u.id)::int AS raw_user_count
       FROM users u WHERE u.id = $1`,
      [first.id],
    );
    expect(state.rows[0]).toEqual({
      status: "disabled",
      session_status: "revoked",
      raw_user_count: 1,
    });
    await expect(harness.service.hasActiveAdmin()).resolves.toBe(true);
  });

  it("retires a key only after atomically revoking every reusable credential", async () => {
    const harness = await setup();
    databases.push(harness.pg);
    const admin = await harness.service.createActive({
      email: "key-admin@example.com",
      name: "Key Admin",
      password: "key-admin-password",
      role: "admin",
    });
    const transactions = new PGliteTransactionRunner(harness.pg as unknown as PGliteDatabaseLike);
    await registerCredentialHmacKey(transactions, CREDENTIAL_KEY, admin.id);
    const session = await harness.service.login("key-admin@example.com", "key-admin-password");
    const invitation = await harness.service.createInvite({
      email: "key-member@example.com",
      role: "member",
    });

    await expect(
      retireCredentialHmacKey(transactions, CREDENTIAL_KEY.keyId, admin.id),
    ).resolves.toEqual({ revoked_sessions: 1, revoked_invitations: 1 });
    await expect(harness.service.userForToken(session.token)).resolves.toBeUndefined();
    await expect(
      harness.service.acceptInvite(invitation.inviteToken, "member-password"),
    ).rejects.toBeInstanceOf(InvalidInviteError);
    const registry = await harness.pg.query<{ status: string; retired: boolean }>(
      `SELECT status, retired_at IS NOT NULL AS retired
       FROM credential_hmac_key_registry
       WHERE key_id = $1`,
      [CREDENTIAL_KEY.keyId],
    );
    expect(registry.rows[0]).toEqual({ status: "retired", retired: true });
    await expect(
      registerCredentialHmacKey(
        transactions,
        { keyId: CREDENTIAL_KEY.keyId, key: Buffer.alloc(32, 99) },
        admin.id,
      ),
    ).rejects.toThrow(/different or retired material/);
  });
});

describe("legacy identity adapter", () => {
  it("exposes the snapshot store through the async seam", async () => {
    const service = new LegacyIdentityService(new UserStore());
    const admin = await service.createActive({
      email: "admin@example.com",
      password: "password",
      role: "admin",
    });
    await expect(service.hasActiveAdmin()).resolves.toBe(true);
    const login = await service.login(admin.email, "password");
    await expect(service.userForToken(login.token)).resolves.toMatchObject({ id: admin.id });
    await expect(service.disable(admin.id)).rejects.toBeInstanceOf(LastActiveAdminError);
  });
});
