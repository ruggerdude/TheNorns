import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { type CredentialHmacKey, credentialHmacKeyFingerprint } from "./credentialTokens.js";

async function assertActiveAdmin(sql: V2SqlExecutor, actorId: string): Promise<void> {
  const actor = await sql.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM users
       WHERE id = $1
         AND role = 'admin'
         AND status = 'active'
     ) AS present`,
    [actorId],
  );
  if (!actor.rows[0]?.present) throw new Error("credential key rotation requires an active admin");
}

export async function registerCredentialHmacKey(
  transactions: V2TransactionRunner,
  key: CredentialHmacKey,
  humanActorId: string,
): Promise<void> {
  const fingerprint = credentialHmacKeyFingerprint(key);
  await transactions.transaction(async (sql) => {
    await assertActiveAdmin(sql, humanActorId);
    await sql.query(
      `INSERT INTO credential_hmac_key_registry (
         key_id, key_fingerprint, status
       ) VALUES ($1,$2,'active')
       ON CONFLICT (key_id) DO NOTHING`,
      [key.keyId, fingerprint],
    );
    const stored = await sql.query<{ key_fingerprint: string; status: string }>(
      `SELECT key_fingerprint, status
       FROM credential_hmac_key_registry
       WHERE key_id = $1
       FOR UPDATE`,
      [key.keyId],
    );
    if (stored.rows[0]?.key_fingerprint !== fingerprint || stored.rows[0]?.status !== "active") {
      throw new Error("credential key ID is already bound to different or retired material");
    }
    await sql.query(
      `INSERT INTO audit_events (
         audit_id, audit_type, project_id, phase_id, task_id,
         actor_type, actor_id, outcome, severity, correlation_id,
         occurred_at, targets, summary, details, redaction_applied
       ) VALUES (
         $1,'identity.credential_key_registered',NULL,NULL,NULL,
         'human',$2,'succeeded','warning',$3,
         transaction_timestamp(),$4::jsonb,
         'Credential HMAC key registered',$5::jsonb,true
       ) ON CONFLICT (audit_id) DO NOTHING`,
      [
        `audit:credential-key-registered:${encodeURIComponent(key.keyId)}:${fingerprint}`,
        humanActorId,
        `credential-key:${key.keyId}`,
        JSON.stringify([{ entity_type: "credential_hmac_key", entity_id: key.keyId }]),
        JSON.stringify({ key_id: key.keyId, key_fingerprint: fingerprint }),
      ],
    );
  });
}

/**
 * Key removal is a transaction, not an environment edit: every reusable
 * credential bound to the key is terminal before the registry row retires.
 */
export async function retireCredentialHmacKey(
  transactions: V2TransactionRunner,
  keyId: string,
  humanActorId: string,
): Promise<{ revoked_sessions: number; revoked_invitations: number }> {
  return transactions.transaction(async (sql) => {
    await assertActiveAdmin(sql, humanActorId);
    const key = await sql.query<{ status: string }>(
      `SELECT status
       FROM credential_hmac_key_registry
       WHERE key_id = $1
       FOR UPDATE`,
      [keyId],
    );
    if (key.rows[0]?.status !== "active") {
      throw new Error("credential HMAC key is missing or already retired");
    }
    const sessions = await sql.query(
      `UPDATE sessions
       SET status = 'revoked',
           revoked_at = transaction_timestamp(),
           revocation_reason = 'credential_key_retired'
       WHERE token_key_id = $1 AND status = 'active'
       RETURNING id`,
      [keyId],
    );
    const invitations = await sql.query(
      `UPDATE invitations
       SET status = 'revoked',
           revoked_at = transaction_timestamp(),
           revocation_reason = 'credential_key_retired'
       WHERE token_key_id = $1 AND status = 'pending'
       RETURNING id`,
      [keyId],
    );
    await sql.query(
      `UPDATE credential_hmac_key_registry
       SET status = 'retired', retired_at = transaction_timestamp()
       WHERE key_id = $1 AND status = 'active'`,
      [keyId],
    );
    const counts = {
      revoked_sessions: sessions.rows.length,
      revoked_invitations: invitations.rows.length,
    };
    await sql.query(
      `INSERT INTO audit_events (
         audit_id, audit_type, project_id, phase_id, task_id,
         actor_type, actor_id, outcome, severity, correlation_id,
         occurred_at, targets, summary, details, redaction_applied
       ) VALUES (
         $1,'identity.credential_key_retired',NULL,NULL,NULL,
         'human',$2,'succeeded','warning',$3,
         transaction_timestamp(),$4::jsonb,
         'Credential HMAC key retired',$5::jsonb,true
       )`,
      [
        `audit:credential-key-retired:${encodeURIComponent(keyId)}`,
        humanActorId,
        `credential-key:${keyId}`,
        JSON.stringify([{ entity_type: "credential_hmac_key", entity_id: keyId }]),
        JSON.stringify({ key_id: keyId, ...counts }),
      ],
    );
    return counts;
  });
}
