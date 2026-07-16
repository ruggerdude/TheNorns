import { newId as defaultNewId } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import {
  CREDENTIAL_HASH_SCHEME,
  type CredentialHmacKey,
  type CredentialHmacKeyring,
  type StoredSplitCredential,
  createCredentialHmacKeyring,
  issueSplitCredential,
  parseSplitCredential,
  verifySplitCredential,
} from "./credentialTokens.js";
import type {
  CreateActiveIdentityInput,
  CreateIdentityInviteInput,
  IdentityService,
  IdentityUser,
  IdentityUserStatus,
  IdentityUserSummary,
} from "./identityService.js";
import { IdentityAlreadyBootstrappedError } from "./identityService.js";
import {
  CURRENT_PASSWORD_HASH_SCHEME,
  LEGACY_PASSWORD_HASH_SCHEME,
  type PasswordHashScheme,
  hashCurrentPassword,
  verifyAndRehashPassword,
} from "./passwords.js";
import {
  InvalidCredentialsError,
  InvalidInviteError,
  LastActiveAdminError,
  UserExistsError,
  UserNotFoundError,
  type UserRole,
} from "./store.js";

type RandomBytes = (size: number) => Uint8Array;
type Clock = () => Date;
type IdFactory = (kind: "user") => string;

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: IdentityUserStatus;
  password_hash: string | null;
  password_hash_scheme: string | null;
  created_at: Date | string;
}

interface SessionIdentityRow extends UserRow {
  session_id: string;
  token_hash: string;
  token_hash_scheme: string;
  token_key_id: string | null;
  session_status: "active" | "revoked" | "expired";
  expires_at: Date | string;
  session_source: "native" | "legacy_snapshot";
}

interface InvitationIdentityRow extends UserRow {
  invitation_id: string;
  token_hash: string;
  token_hash_scheme: string;
  token_key_id: string | null;
  invitation_status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: Date | string;
  invitation_source: "native" | "legacy_snapshot";
}

export interface RelationalIdentityServiceOptions {
  transactions: V2TransactionRunner;
  credentialKey: CredentialHmacKey;
  credentialVerificationKeys?: readonly CredentialHmacKey[] | undefined;
  clock?: Clock | undefined;
  newId?: IdFactory | undefined;
  randomBytes?: RandomBytes | undefined;
  sessionTtlMs?: number | undefined;
  invitationTtlMs?: number | undefined;
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function optionalName(name: string | undefined): string | null {
  return name?.trim() || null;
}

function iso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

function summary(row: UserRow): IdentityUserSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    created_at: iso(row.created_at),
  };
}

function identity(row: UserRow): IdentityUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    createdAt: iso(row.created_at),
  };
}

function passwordScheme(value: string | null): PasswordHashScheme | null {
  if (value === CURRENT_PASSWORD_HASH_SCHEME || value === LEGACY_PASSWORD_HASH_SCHEME) {
    return value;
  }
  return null;
}

function storedCredential(
  row: {
    id: string;
    token_hash: string;
    token_hash_scheme: string;
    token_key_id: string | null;
  },
  kind: "session" | "invite",
): StoredSplitCredential | null {
  if (row.token_hash_scheme !== CREDENTIAL_HASH_SCHEME || row.token_key_id === null) {
    return null;
  }
  return {
    id: row.id,
    kind,
    secret_hash: row.token_hash,
    hash_scheme: CREDENTIAL_HASH_SCHEME,
    key_id: row.token_key_id,
  };
}

function later(now: Date, durationMs: number): string {
  return new Date(now.getTime() + durationMs).toISOString();
}

function assertDuration(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
}

async function findUserByEmail(
  sql: V2SqlExecutor,
  email: string,
  forUpdate = false,
): Promise<UserRow | undefined> {
  const result = await sql.query<UserRow>(
    `SELECT id, email, name, role, status, password_hash,
            password_hash_scheme, created_at
     FROM users
     WHERE lower(email) = $1
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [email],
  );
  return result.rows[0];
}

/**
 * Normalized PostgreSQL identity implementation used after the Phase 2
 * cutover. All state changes use the supplied pinned transaction runner.
 * Raw credentials exist only in method return values/local variables; the
 * database stores HMAC verifiers and their key identifiers.
 */
export class RelationalIdentityService implements IdentityService {
  private readonly transactions: V2TransactionRunner;
  private readonly credentialKeys: CredentialHmacKeyring;
  private readonly clock: Clock;
  private readonly idFactory: IdFactory;
  private readonly randomBytes: RandomBytes | undefined;
  private readonly sessionTtlMs: number;
  private readonly invitationTtlMs: number;

  constructor(options: RelationalIdentityServiceOptions) {
    assertDuration("sessionTtlMs", options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS);
    assertDuration("invitationTtlMs", options.invitationTtlMs ?? DEFAULT_INVITATION_TTL_MS);
    if (options.credentialKey.keyId.trim().length === 0) {
      throw new Error("credential key id must not be empty");
    }
    if (options.credentialKey.key.byteLength !== 32) {
      throw new Error("credential HMAC keys must contain exactly 32 bytes");
    }
    this.transactions = options.transactions;
    this.credentialKeys = createCredentialHmacKeyring(
      options.credentialKey,
      options.credentialVerificationKeys,
    );
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.newId ?? ((kind) => defaultNewId(kind));
    this.randomBytes = options.randomBytes;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.invitationTtlMs = options.invitationTtlMs ?? DEFAULT_INVITATION_TTL_MS;
  }

  async hasActiveAdmin(): Promise<boolean> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM users
           WHERE role = 'admin'
             AND status = 'active'
             AND password_hash IS NOT NULL
         ) AS present`,
      );
      return result.rows[0]?.present ?? false;
    });
  }

  async bootstrapAdmin(
    input: Omit<CreateActiveIdentityInput, "role">,
  ): Promise<IdentityUserSummary> {
    const email = normalizedEmail(input.email);
    const name = optionalName(input.name);
    const now = this.clock();
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('norns:identity:first-admin-bootstrap', 0))",
      );
      const activeAdmin = await sql.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM users
           WHERE role = 'admin'
             AND status = 'active'
             AND password_hash IS NOT NULL
         ) AS present`,
      );
      if (activeAdmin.rows[0]?.present) throw new IdentityAlreadyBootstrappedError();
      if (await findUserByEmail(sql, email, true)) throw new UserExistsError(email);
      return this.insertActiveUser(sql, {
        email,
        name,
        password: input.password,
        role: "admin",
        now,
      });
    });
  }

  async userForToken(token: string): Promise<IdentityUser | undefined> {
    const parsed = parseSplitCredential(token, "session");
    if (!parsed) return undefined;
    const now = this.clock();
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<SessionIdentityRow>(
        `SELECT
           u.id, u.email, u.name, u.role, u.status, u.password_hash,
           u.password_hash_scheme, u.created_at,
           s.id AS session_id, s.token_hash, s.token_hash_scheme,
           s.token_key_id, s.status AS session_status, s.expires_at,
           s.source AS session_source
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = $1
         FOR UPDATE`,
        [parsed.id],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      if (
        row.session_source !== "native" ||
        row.session_status !== "active" ||
        row.status !== "active"
      ) {
        return undefined;
      }
      const verifier = storedCredential(
        {
          id: row.session_id,
          token_hash: row.token_hash,
          token_hash_scheme: row.token_hash_scheme,
          token_key_id: row.token_key_id,
        },
        "session",
      );
      const credentialKey = verifier ? this.credentialKeys.byId.get(verifier.key_id) : undefined;
      if (!verifier || !credentialKey || !verifySplitCredential(token, verifier, credentialKey)) {
        return undefined;
      }
      if (new Date(row.expires_at).getTime() <= now.getTime()) {
        await sql.query(
          `UPDATE sessions
           SET status = 'expired'
           WHERE id = $1 AND status = 'active'`,
          [row.session_id],
        );
        return undefined;
      }
      await sql.query("UPDATE sessions SET last_seen_at = $2 WHERE id = $1", [
        row.session_id,
        now.toISOString(),
      ]);
      return identity(row);
    });
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ token: string; user: IdentityUserSummary }> {
    const normalized = normalizedEmail(email);
    const now = this.clock();
    return this.transactions.transaction(async (sql) => {
      const row = await findUserByEmail(sql, normalized, true);
      const scheme = passwordScheme(row?.password_hash_scheme ?? null);
      if (!row || row.status !== "active" || row.password_hash === null || scheme === null) {
        throw new InvalidCredentialsError();
      }
      const verified = verifyAndRehashPassword(
        password,
        row.password_hash,
        scheme,
        this.randomBytes,
      );
      if (!verified.valid) throw new InvalidCredentialsError();

      if (verified.upgraded_hash !== null) {
        await sql.query(
          `UPDATE users
           SET password_hash = $2,
               password_hash_scheme = $3,
               password_rehashed_at = $4,
               updated_at = $4
           WHERE id = $1`,
          [row.id, verified.upgraded_hash, verified.upgraded_scheme, now.toISOString()],
        );
      }

      const issued = issueSplitCredential("session", this.credentialKeys.current, this.randomBytes);
      await sql.query(
        `INSERT INTO sessions (
           id, user_id, token_hash, token_hash_scheme, token_key_id,
           status, created_at, expires_at, revoked_at, last_seen_at,
           revocation_reason, source, source_record_id
         ) VALUES (
           $1, $2, $3, $4, $5,
           'active', $6, $7, NULL, $6,
           NULL, 'native', NULL
         )`,
        [
          issued.stored.id,
          row.id,
          issued.stored.secret_hash,
          issued.stored.hash_scheme,
          issued.stored.key_id,
          now.toISOString(),
          later(now, this.sessionTtlMs),
        ],
      );
      return { token: issued.token, user: summary(row) };
    });
  }

  async logout(token: string): Promise<void> {
    const parsed = parseSplitCredential(token, "session");
    if (!parsed) return;
    const now = this.clock().toISOString();
    await this.transactions.transaction(async (sql) => {
      const result = await sql.query<{
        id: string;
        token_hash: string;
        token_hash_scheme: string;
        token_key_id: string | null;
        status: "active" | "revoked" | "expired";
        source: "native" | "legacy_snapshot";
      }>(
        `SELECT id, token_hash, token_hash_scheme, token_key_id, status, source
         FROM sessions WHERE id = $1 FOR UPDATE`,
        [parsed.id],
      );
      const row = result.rows[0];
      if (!row || row.status !== "active" || row.source !== "native") return;
      const verifier = storedCredential(row, "session");
      const credentialKey = verifier ? this.credentialKeys.byId.get(verifier.key_id) : undefined;
      if (!verifier || !credentialKey || !verifySplitCredential(token, verifier, credentialKey)) {
        return;
      }
      await sql.query(
        `UPDATE sessions
         SET status = 'revoked', revoked_at = $2, revocation_reason = 'logout'
         WHERE id = $1 AND status = 'active'`,
        [row.id, now],
      );
    });
  }

  async list(): Promise<IdentityUserSummary[]> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<UserRow>(
        `SELECT id, email, name, role, status, password_hash,
                password_hash_scheme, created_at
         FROM users
         ORDER BY created_at, id`,
      );
      return result.rows.map(summary);
    });
  }

  async createActive(input: CreateActiveIdentityInput): Promise<IdentityUserSummary> {
    const email = normalizedEmail(input.email);
    const name = optionalName(input.name);
    const now = this.clock();
    return this.transactions.transaction(async (sql) => {
      if (await findUserByEmail(sql, email, true)) throw new UserExistsError(email);
      return this.insertActiveUser(sql, {
        email,
        name,
        password: input.password,
        role: input.role,
        now,
      });
    });
  }

  private async insertActiveUser(
    sql: V2SqlExecutor,
    input: {
      email: string;
      name: string | null;
      password: string;
      role: UserRole;
      now: Date;
    },
  ): Promise<IdentityUserSummary> {
    const row: UserRow = {
      id: this.idFactory("user"),
      email: input.email,
      name: input.name,
      role: input.role,
      status: "active",
      password_hash: hashCurrentPassword(input.password, this.randomBytes),
      password_hash_scheme: CURRENT_PASSWORD_HASH_SCHEME,
      created_at: input.now,
    };
    await sql.query(
      `INSERT INTO users (
         id, username, display_name, email, name, password_hash,
         password_hash_scheme, password_rehashed_at, role, status,
         source, source_record_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $2, $4, $5,
         $6, NULL, $7, 'active',
         'native', NULL, $8, $8
       )`,
      [
        row.id,
        row.email,
        row.name ?? row.email,
        row.name,
        row.password_hash,
        row.password_hash_scheme,
        row.role,
        input.now.toISOString(),
      ],
    );
    return summary(row);
  }

  async createInvite(
    input: CreateIdentityInviteInput,
  ): Promise<{ summary: IdentityUserSummary; inviteToken: string }> {
    const email = normalizedEmail(input.email);
    const name = optionalName(input.name);
    const now = this.clock();
    return this.transactions.transaction(async (sql) => {
      const existing = await findUserByEmail(sql, email, true);
      if (existing && existing.status !== "invited") throw new UserExistsError(email);
      const issued = issueSplitCredential("invite", this.credentialKeys.current, this.randomBytes);
      const row: UserRow =
        existing ??
        ({
          id: this.idFactory("user"),
          email,
          name,
          role: input.role,
          status: "invited",
          password_hash: null,
          password_hash_scheme: null,
          created_at: now,
        } satisfies UserRow);
      if (existing) {
        // Reissuing after migration keeps the imported identity, role, and
        // profile intact. Only the unusable credential is replaced.
        await sql.query(
          `UPDATE invitations
           SET status = 'revoked', revoked_at = $2,
               revocation_reason = 'superseded_by_reissue'
           WHERE user_id = $1 AND status = 'pending'`,
          [row.id, now.toISOString()],
        );
      } else {
        await sql.query(
          `INSERT INTO users (
             id, username, display_name, email, name, password_hash,
             password_hash_scheme, password_rehashed_at, role, status,
             source, source_record_id, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $2, $4, NULL,
             NULL, NULL, $5, 'invited',
             'native', NULL, $6, $6
           )`,
          [row.id, row.email, row.name ?? row.email, row.name, row.role, now.toISOString()],
        );
      }
      await sql.query(
        `INSERT INTO invitations (
           id, user_id, token_hash, token_hash_scheme, token_key_id,
           status, created_at, expires_at, accepted_at, revoked_at,
           revocation_reason, source, source_record_id
         ) VALUES (
           $1, $2, $3, $4, $5,
           'pending', $6, $7, NULL, NULL,
           NULL, 'native', NULL
         )`,
        [
          issued.stored.id,
          row.id,
          issued.stored.secret_hash,
          issued.stored.hash_scheme,
          issued.stored.key_id,
          now.toISOString(),
          later(now, this.invitationTtlMs),
        ],
      );
      return { summary: summary(row), inviteToken: issued.token };
    });
  }

  async acceptInvite(inviteToken: string, password: string): Promise<IdentityUserSummary> {
    const parsed = parseSplitCredential(inviteToken, "invite");
    if (!parsed) throw new InvalidInviteError();
    const now = this.clock();
    const result = await this.transactions.transaction<
      { accepted: true; user: IdentityUserSummary } | { accepted: false }
    >(async (sql) => {
      const query = await sql.query<InvitationIdentityRow>(
        `SELECT
           u.id, u.email, u.name, u.role, u.status, u.password_hash,
           u.password_hash_scheme, u.created_at,
           i.id AS invitation_id, i.token_hash, i.token_hash_scheme,
           i.token_key_id, i.status AS invitation_status, i.expires_at,
           i.source AS invitation_source
         FROM invitations i
         JOIN users u ON u.id = i.user_id
         WHERE i.id = $1
         FOR UPDATE`,
        [parsed.id],
      );
      const row = query.rows[0];
      if (
        !row ||
        row.invitation_source !== "native" ||
        row.invitation_status !== "pending" ||
        row.status !== "invited"
      ) {
        return { accepted: false };
      }
      const verifier = storedCredential(
        {
          id: row.invitation_id,
          token_hash: row.token_hash,
          token_hash_scheme: row.token_hash_scheme,
          token_key_id: row.token_key_id,
        },
        "invite",
      );
      const credentialKey = verifier ? this.credentialKeys.byId.get(verifier.key_id) : undefined;
      if (
        !verifier ||
        !credentialKey ||
        !verifySplitCredential(inviteToken, verifier, credentialKey)
      ) {
        return { accepted: false };
      }
      if (new Date(row.expires_at).getTime() <= now.getTime()) {
        await sql.query(
          `UPDATE invitations
           SET status = 'expired'
           WHERE id = $1 AND status = 'pending'`,
          [row.invitation_id],
        );
        return { accepted: false };
      }
      const passwordHash = hashCurrentPassword(password, this.randomBytes);
      await sql.query(
        `UPDATE users
         SET status = 'active', password_hash = $2,
             password_hash_scheme = $3, updated_at = $4
         WHERE id = $1 AND status = 'invited'`,
        [row.id, passwordHash, CURRENT_PASSWORD_HASH_SCHEME, now.toISOString()],
      );
      await sql.query(
        `UPDATE invitations
         SET status = 'accepted', accepted_at = $2
         WHERE id = $1 AND status = 'pending'`,
        [row.invitation_id, now.toISOString()],
      );
      return {
        accepted: true,
        user: summary({
          ...row,
          status: "active",
          password_hash: passwordHash,
          password_hash_scheme: CURRENT_PASSWORD_HASH_SCHEME,
        }),
      };
    });
    if (!result.accepted) throw new InvalidInviteError();
    return result.user;
  }

  async disable(id: string): Promise<void> {
    const now = this.clock().toISOString();
    await this.transactions.transaction(async (sql) => {
      // Lock every currently active administrator in stable order before the
      // target row. Concurrent attempts therefore cannot both retire the last
      // two administrators.
      const activeAdmins = await sql.query<{ id: string }>(
        `SELECT id
         FROM users
         WHERE role = 'admin' AND status = 'active' AND password_hash IS NOT NULL
         ORDER BY id
         FOR UPDATE`,
      );
      const userResult = await sql.query<Pick<UserRow, "id" | "role" | "status">>(
        "SELECT id, role, status FROM users WHERE id = $1 FOR UPDATE",
        [id],
      );
      const user = userResult.rows[0];
      if (!user) throw new UserNotFoundError(id);
      if (user.role === "admin" && user.status === "active" && activeAdmins.rows.length <= 1) {
        throw new LastActiveAdminError();
      }
      if (user.status === "disabled") return;

      await sql.query(
        `UPDATE users
         SET status = 'disabled', updated_at = $2
         WHERE id = $1`,
        [id, now],
      );
      await sql.query(
        `UPDATE sessions
         SET status = 'revoked', revoked_at = $2,
             revocation_reason = 'user_disabled'
         WHERE user_id = $1 AND status = 'active'`,
        [id, now],
      );
      await sql.query(
        `UPDATE invitations
         SET status = 'revoked', revoked_at = $2,
             revocation_reason = 'user_disabled'
         WHERE user_id = $1 AND status = 'pending'`,
        [id, now],
      );
    });
  }

  async remove(id: string): Promise<void> {
    await this.disable(id);
  }
}
