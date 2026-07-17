import { createHash } from "node:crypto";
import type { CredentialHmacKey } from "../../users/credentialTokens.js";
import {
  credentialHmacKeyFingerprint,
  hashLegacyCredentialToken,
} from "../../users/credentialTokens.js";
import {
  hasReusableLegacyCredentials,
  sanitizeLegacyCredentialSnapshot,
} from "../../users/legacyCredentialSanitizer.js";
import { detectPasswordHashScheme } from "../../users/passwords.js";
import type { V2SqlExecutor } from "../v2/database.js";
import { canonicalSha256 } from "./canonicalJson.js";
import { type LegacyUsersSnapshot, LegacyUsersSnapshotSchema } from "./legacySnapshots.js";

interface IdentityCountRow {
  users: number | string;
  sessions: number | string;
  invitations: number | string;
  active_admins: number | string;
  unsafe_sessions: number | string;
  unsafe_invitations: number | string;
}

interface StoredUserRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  password_hash_scheme: string | null;
  role: string;
  status: string;
  source: string;
  source_record_id: string | null;
  created_at: string | Date;
}

interface StoredCredentialRow {
  id: string;
  user_id: string;
  token_hash: string;
  token_hash_scheme: string;
  token_key_id: string | null;
  status: string;
  source: string;
  source_record_id: string | null;
  revoked_at: string | Date | null;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function sessionIdentity(
  session: LegacyUsersSnapshot["sessions"][number],
  ordinal: number,
): { id: string; sourceRecordId: string } {
  const sourceRecordId = `users.sessions[${ordinal}]`;
  return {
    id: `session:legacy:${canonicalSha256({
      user_id: session.userId,
      created_at: session.createdAt,
      ordinal,
    })}`,
    sourceRecordId,
  };
}

function invitationIdentity(userId: string): { id: string; sourceRecordId: string } {
  return {
    id: `invitation:legacy:${canonicalSha256({ user_id: userId })}`,
    sourceRecordId: `users.user[${userId}].invitation`,
  };
}

function safeUserSourceHash(user: LegacyUsersSnapshot["users"][number]): string {
  return canonicalSha256({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    passwordHash: user.passwordHash,
    invitation_present: typeof user.inviteToken === "string" && user.inviteToken.length > 0,
    createdAt: user.createdAt,
  });
}

async function insertMapping(
  sql: V2SqlExecutor,
  input: {
    migrationRunId: string;
    legacyEntityType: "user" | "session" | "invitation";
    legacyId: string;
    v2EntityType: "user" | "session" | "invitation";
    v2Id: string;
    sourceHash: string;
    sourceMetadata: Record<string, unknown>;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO legacy_id_mappings (
       migration_run_id, legacy_entity_type, legacy_id,
       v2_entity_type, v2_id, source_hash, source_metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (migration_run_id, legacy_entity_type, legacy_id) DO NOTHING`,
    [
      input.migrationRunId,
      input.legacyEntityType,
      input.legacyId,
      input.v2EntityType,
      input.v2Id,
      input.sourceHash,
      JSON.stringify(input.sourceMetadata),
    ],
  );
  const stored = await sql.query<{ source_hash: string; v2_id: string }>(
    `SELECT source_hash, v2_id
     FROM legacy_id_mappings
     WHERE migration_run_id = $1
       AND legacy_entity_type = $2
       AND legacy_id = $3`,
    [input.migrationRunId, input.legacyEntityType, input.legacyId],
  );
  const row = stored.rows[0];
  if (!row || row.source_hash !== input.sourceHash || row.v2_id !== input.v2Id) {
    throw new Error(`legacy ${input.legacyEntityType} mapping changed during import`);
  }
}

export interface LegacyIdentityImportInput {
  migration_run_id: string;
  source_text: string;
  source_frozen_at: string;
  credential_key: CredentialHmacKey;
}

export interface LegacyIdentityImportResult {
  counts: {
    users: number;
    sessions: number;
    invitations: number;
    active_admins: number;
  };
  sanitized_snapshot_json: string;
  source_exact_hash: string;
}

export class SqlLegacyIdentityImporter {
  constructor(private readonly sql: V2SqlExecutor) {}

  async import(input: LegacyIdentityImportInput): Promise<LegacyIdentityImportResult> {
    let raw: unknown;
    try {
      raw = JSON.parse(input.source_text);
    } catch {
      throw new Error("legacy users snapshot is not valid JSON");
    }
    const source = LegacyUsersSnapshotSchema.parse(raw);
    const usersById = new Map(source.users.map((user) => [user.id, user]));
    if (usersById.size !== source.users.length) {
      throw new Error("legacy users snapshot contains duplicate user IDs");
    }
    const emails = new Set<string>();
    for (const user of source.users) {
      const normalizedEmail = user.email.trim().toLowerCase();
      if (emails.has(normalizedEmail)) {
        throw new Error("legacy users snapshot contains duplicate normalized emails");
      }
      emails.add(normalizedEmail);
      if (user.status === "active" && user.passwordHash === null) {
        throw new Error("legacy active user is missing a password hash");
      }
      if (user.passwordHash !== null && detectPasswordHashScheme(user.passwordHash) === null) {
        throw new Error("legacy user has an unsupported password hash");
      }
      if (user.status === "invited" && user.passwordHash !== null) {
        throw new Error("legacy invited user unexpectedly has a password hash");
      }
    }
    for (const session of source.sessions) {
      if (!usersById.has(session.userId)) {
        throw new Error("legacy session references an unknown user");
      }
    }
    const expectedActiveAdmins = source.users.filter(
      (user) => user.role === "admin" && user.status === "active" && user.passwordHash !== null,
    ).length;
    if (expectedActiveAdmins < 1) {
      throw new Error("legacy identity import would not preserve an active administrator");
    }

    const credentialKeyFingerprint = credentialHmacKeyFingerprint(input.credential_key);
    await this.sql.query(
      `INSERT INTO credential_hmac_key_registry (
         key_id, key_fingerprint, status
       ) VALUES ($1,$2,'active')
       ON CONFLICT (key_id) DO NOTHING`,
      [input.credential_key.keyId, credentialKeyFingerprint],
    );
    const registeredKey = await this.sql.query<{
      key_fingerprint: string;
      status: string;
    }>(
      `SELECT key_fingerprint, status
       FROM credential_hmac_key_registry
       WHERE key_id = $1`,
      [input.credential_key.keyId],
    );
    if (
      registeredKey.rows[0]?.key_fingerprint !== credentialKeyFingerprint ||
      registeredKey.rows[0]?.status !== "active"
    ) {
      throw new Error("credential HMAC key ID is already bound or retired");
    }

    for (const user of source.users) {
      const normalizedEmail = user.email.trim().toLowerCase();
      const passwordHashScheme =
        user.passwordHash === null ? null : detectPasswordHashScheme(user.passwordHash);
      if (user.passwordHash !== null && passwordHashScheme === null) {
        throw new Error("legacy user has an unsupported password hash");
      }
      await this.sql.query(
        `INSERT INTO users (
           id, username, display_name, email, name, password_hash,
           password_hash_scheme, password_rehashed_at, role, status,
           source, source_record_id, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,'legacy_snapshot',$1,$10,$10
         ) ON CONFLICT (id) DO NOTHING`,
        [
          user.id,
          normalizedEmail,
          user.name ?? user.email,
          normalizedEmail,
          user.name,
          user.passwordHash,
          passwordHashScheme,
          user.role,
          user.status,
          user.createdAt,
        ],
      );
      const stored = await this.sql.query<StoredUserRow>(
        `SELECT id, email, name, password_hash, password_hash_scheme,
                role, status, source, source_record_id, created_at
         FROM users WHERE id = $1`,
        [user.id],
      );
      const row = stored.rows[0];
      const expected = {
        id: user.id,
        email: normalizedEmail,
        name: user.name,
        password_hash: user.passwordHash,
        password_hash_scheme: passwordHashScheme,
        role: user.role,
        status: user.status,
        source: "legacy_snapshot",
        source_record_id: user.id,
        created_at: user.createdAt,
      };
      if (
        !row ||
        canonicalSha256({ ...row, created_at: iso(row.created_at) }) !== canonicalSha256(expected)
      ) {
        throw new Error(`V2 user identity conflicts with legacy user ${user.id}`);
      }
      await insertMapping(this.sql, {
        migrationRunId: input.migration_run_id,
        legacyEntityType: "user",
        legacyId: user.id,
        v2EntityType: "user",
        v2Id: user.id,
        sourceHash: safeUserSourceHash(user),
        sourceMetadata: { snapshot_key: "users" },
      });
    }

    for (const [ordinal, session] of source.sessions.entries()) {
      const identity = sessionIdentity(session, ordinal);
      const tokenHash = hashLegacyCredentialToken(
        session.token,
        "session",
        identity.id,
        input.credential_key,
      );
      await this.sql.query(
        `INSERT INTO sessions (
           id, user_id, token_hash, token_hash_scheme, token_key_id,
           status, created_at, expires_at, revoked_at, last_seen_at,
           revocation_reason, source, source_record_id
         ) VALUES (
           $1,$2,$3,'hmac-sha256',$4,'revoked',$5,$6,$6,NULL,
           'legacy_cutover','legacy_snapshot',$7
         ) ON CONFLICT (id) DO NOTHING`,
        [
          identity.id,
          session.userId,
          tokenHash,
          input.credential_key.keyId,
          session.createdAt,
          input.source_frozen_at,
          identity.sourceRecordId,
        ],
      );
      await this.assertStoredCredential("sessions", {
        id: identity.id,
        userId: session.userId,
        tokenHash,
        keyId: input.credential_key.keyId,
        sourceRecordId: identity.sourceRecordId,
      });
      await insertMapping(this.sql, {
        migrationRunId: input.migration_run_id,
        legacyEntityType: "session",
        legacyId: identity.sourceRecordId,
        v2EntityType: "session",
        v2Id: identity.id,
        sourceHash: canonicalSha256({
          user_id: session.userId,
          created_at: session.createdAt,
          token_hash: tokenHash,
        }),
        sourceMetadata: { snapshot_key: "users", ordinal },
      });
    }

    const invitedWithTokens = source.users.filter(
      (user) => typeof user.inviteToken === "string" && user.inviteToken.length > 0,
    );
    for (const user of invitedWithTokens) {
      const identity = invitationIdentity(user.id);
      const tokenHash = hashLegacyCredentialToken(
        user.inviteToken ?? "",
        "invite",
        identity.id,
        input.credential_key,
      );
      await this.sql.query(
        `INSERT INTO invitations (
           id, user_id, token_hash, token_hash_scheme, token_key_id,
           status, created_at, expires_at, accepted_at, revoked_at,
           revocation_reason, source, source_record_id
         ) VALUES (
           $1,$2,$3,'hmac-sha256',$4,'revoked',$5,$6,NULL,$6,
           'legacy_cutover','legacy_snapshot',$7
         ) ON CONFLICT (id) DO NOTHING`,
        [
          identity.id,
          user.id,
          tokenHash,
          input.credential_key.keyId,
          user.createdAt,
          input.source_frozen_at,
          identity.sourceRecordId,
        ],
      );
      await this.assertStoredCredential("invitations", {
        id: identity.id,
        userId: user.id,
        tokenHash,
        keyId: input.credential_key.keyId,
        sourceRecordId: identity.sourceRecordId,
      });
      await insertMapping(this.sql, {
        migrationRunId: input.migration_run_id,
        legacyEntityType: "invitation",
        legacyId: identity.sourceRecordId,
        v2EntityType: "invitation",
        v2Id: identity.id,
        sourceHash: canonicalSha256({
          user_id: user.id,
          created_at: user.createdAt,
          token_hash: tokenHash,
        }),
        sourceMetadata: { snapshot_key: "users" },
      });
    }

    const countsResult = await this.sql.query<IdentityCountRow>(
      `SELECT
         (SELECT count(*) FROM users WHERE source = 'legacy_snapshot') AS users,
         (SELECT count(*) FROM sessions WHERE source = 'legacy_snapshot') AS sessions,
         (SELECT count(*) FROM invitations WHERE source = 'legacy_snapshot') AS invitations,
         (SELECT count(*) FROM users
          WHERE source = 'legacy_snapshot' AND role = 'admin'
            AND status = 'active' AND password_hash IS NOT NULL) AS active_admins,
         (SELECT count(*) FROM sessions
          WHERE source = 'legacy_snapshot'
            AND (status <> 'revoked' OR revoked_at IS NULL)) AS unsafe_sessions,
         (SELECT count(*) FROM invitations
          WHERE source = 'legacy_snapshot'
            AND (status <> 'revoked' OR revoked_at IS NULL)) AS unsafe_invitations`,
    );
    const counts = countsResult.rows[0];
    if (!counts) throw new Error("identity import count query returned no result");
    const actual = {
      users: Number(counts.users),
      sessions: Number(counts.sessions),
      invitations: Number(counts.invitations),
      active_admins: Number(counts.active_admins),
    };
    if (
      actual.users !== source.users.length ||
      actual.sessions !== source.sessions.length ||
      actual.invitations !== invitedWithTokens.length ||
      actual.active_admins !== expectedActiveAdmins ||
      Number(counts.unsafe_sessions) !== 0 ||
      Number(counts.unsafe_invitations) !== 0
    ) {
      throw new Error("legacy identity import count or revocation reconciliation failed");
    }

    const sanitized = sanitizeLegacyCredentialSnapshot(source);
    if (hasReusableLegacyCredentials(sanitized.snapshot)) {
      throw new Error("legacy users snapshot sanitization retained a reusable credential");
    }
    return {
      counts: actual,
      sanitized_snapshot_json: JSON.stringify(sanitized.snapshot),
      source_exact_hash: createHash("sha256").update(input.source_text, "utf8").digest("hex"),
    };
  }

  private async assertStoredCredential(
    table: "sessions" | "invitations",
    expected: {
      id: string;
      userId: string;
      tokenHash: string;
      keyId: string;
      sourceRecordId: string;
    },
  ): Promise<void> {
    const result = await this.sql.query<StoredCredentialRow>(
      `SELECT id, user_id, token_hash, token_hash_scheme, token_key_id,
              status, source, source_record_id, revoked_at
       FROM ${table}
       WHERE id = $1`,
      [expected.id],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.user_id !== expected.userId ||
      row.token_hash !== expected.tokenHash ||
      row.token_hash_scheme !== "hmac-sha256" ||
      row.token_key_id !== expected.keyId ||
      row.status !== "revoked" ||
      row.source !== "legacy_snapshot" ||
      row.source_record_id !== expected.sourceRecordId ||
      row.revoked_at === null
    ) {
      throw new Error(`V2 ${table} inventory conflicts with the legacy credential`);
    }
  }
}
