import type { V2SqlExecutor } from "../v2/database.js";
import type {
  LegacyArchiveAccessIntent,
  LegacyArchiveAccessResult,
  LegacyArchiveRepository,
  LegacySnapshotArchiveRecord,
} from "./archiveRepository.js";

interface ArchiveRow {
  id: string;
  migration_run_id: string;
  source_key: string;
  source_updated_at: string | Date;
  source_frozen_at: string | Date;
  storage_ref: string;
  key_id: string;
  key_fingerprint: string;
  cipher: "aes-256-gcm";
  exact_hash: string;
  canonical_hash: string;
  ciphertext_hash: string;
  aad_hash: string;
  manifest_hash: string;
  exact_byte_size: number | string;
  canonical_byte_size: number | string;
  object_counts: Record<string, number>;
  last_record: Record<string, unknown>;
  nonce: Uint8Array;
  auth_tag: Uint8Array;
  ciphertext: Uint8Array;
  status: "sealed" | "verified" | "expired";
  captured_at: string | Date;
  retention_until: string | Date;
  database_time: string | Date;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

export class SqlLegacyArchiveRepository implements LegacyArchiveRepository {
  constructor(private readonly sql: V2SqlExecutor) {}

  async insert(record: LegacySnapshotArchiveRecord): Promise<void> {
    await this.sql.query(
      `INSERT INTO archive_encryption_key_registry (
         key_id, key_fingerprint
       ) VALUES ($1,$2)
       ON CONFLICT (key_id) DO NOTHING`,
      [record.encrypted.key_id, record.encrypted.key_fingerprint],
    );
    const registeredKey = await this.sql.query<{ key_fingerprint: string }>(
      `SELECT key_fingerprint
       FROM archive_encryption_key_registry
       WHERE key_id = $1`,
      [record.encrypted.key_id],
    );
    if (registeredKey.rows[0]?.key_fingerprint !== record.encrypted.key_fingerprint) {
      throw new Error("archive key ID is already bound to different key material");
    }
    await this.sql.query(
      `INSERT INTO legacy_snapshot_archives (
         id, migration_run_id, source_key, source_updated_at, storage_ref,
         key_id, key_fingerprint, cipher, exact_hash, canonical_hash, ciphertext_hash,
         aad_hash, manifest_hash, exact_byte_size, canonical_byte_size,
         object_counts, last_record, nonce, auth_tag, ciphertext,
         status, captured_at, retention_until
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16::jsonb,$17::jsonb,$18,$19,$20,'sealed',$21,$22
       )`,
      [
        record.archive_id,
        record.migration_run_id,
        record.source_key,
        record.source_updated_at,
        record.storage_ref,
        record.encrypted.key_id,
        record.encrypted.key_fingerprint,
        record.encrypted.algorithm,
        record.exact_text_sha256,
        record.semantic_sha256,
        record.encrypted.ciphertext_sha256,
        record.encrypted.aad_sha256,
        record.manifest_hash,
        record.source_text_byte_length,
        record.semantic_canonical_byte_length,
        JSON.stringify(record.object_counts),
        JSON.stringify(record.last_included_record ?? {}),
        Buffer.from(record.encrypted.nonce_base64, "base64"),
        Buffer.from(record.encrypted.auth_tag_base64, "base64"),
        Buffer.from(record.encrypted.ciphertext_base64, "base64"),
        record.created_at,
        record.retention_expires_at,
      ],
    );

    await this.sql.query(
      `INSERT INTO legacy_archive_access_events (
         id, archive_id, actor_type, actor_id, operation, outcome,
         correlation_id, occurred_at, details, redaction_applied
       ) VALUES (
         $1,$2,'system',NULL,'write','allowed',$3,$4,$5::jsonb,true
       ) ON CONFLICT (id) DO NOTHING`,
      [
        `archive_access:write:${record.archive_id}`,
        record.archive_id,
        record.migration_run_id,
        record.created_at,
        JSON.stringify({
          purpose: "migration_checkpoint",
          source_key: record.source_key,
          storage_ref: record.storage_ref,
        }),
      ],
    );
  }

  async findCiphertext(
    archiveId: string,
    intent: LegacyArchiveAccessIntent,
  ): Promise<{
    record: LegacySnapshotArchiveRecord | null;
    access: LegacyArchiveAccessResult;
  }> {
    if (archiveId !== intent.archive_id) {
      await this.recordDeniedAttempt(intent, "archive_intent_mismatch");
      return {
        record: null,
        access: {
          intent,
          outcome: "denied",
          completed_at: intent.requested_at,
          reason_code: "archive_intent_mismatch",
        },
      };
    }

    const authorized =
      (intent.purpose === "migration_reconciliation" &&
        intent.actor_type === "system" &&
        intent.actor_id === null &&
        intent.session_id === null) ||
      (intent.purpose !== "migration_reconciliation" &&
        intent.actor_type === "human" &&
        intent.actor_id !== null &&
        intent.session_id !== null);
    if (!authorized) {
      await this.recordDeniedAttempt(intent, "archive_access_not_authorized");
      return {
        record: null,
        access: {
          intent,
          outcome: "denied",
          completed_at: intent.requested_at,
          reason_code: "archive_access_not_authorized",
        },
      };
    }

    const result = await this.sql.query<ArchiveRow>(
      `SELECT archive.id, archive.migration_run_id, archive.source_key,
              archive.source_updated_at, run.source_frozen_at,
              archive.storage_ref, archive.key_id, archive.key_fingerprint, archive.cipher,
              archive.exact_hash, archive.canonical_hash,
              archive.ciphertext_hash, archive.aad_hash, archive.manifest_hash,
              archive.exact_byte_size, archive.canonical_byte_size,
              archive.object_counts, archive.last_record, archive.nonce,
              archive.auth_tag, archive.ciphertext, archive.captured_at,
              archive.retention_until, archive.status,
              transaction_timestamp() AS database_time
       FROM legacy_snapshot_archives archive
       JOIN migration_runs run ON run.id = archive.migration_run_id
       WHERE archive.id = $1`,
      [archiveId],
    );
    const row = result.rows[0];
    const completedAt = row ? iso(row.database_time) : intent.requested_at;
    const readable =
      row !== undefined &&
      row.status !== "expired" &&
      new Date(row.retention_until).getTime() > new Date(row.database_time).getTime();
    const reasonCode =
      row === undefined
        ? "archive_not_found"
        : row.status === "expired"
          ? "archive_expired"
          : readable
            ? null
            : "archive_retention_elapsed";
    const access: LegacyArchiveAccessResult = {
      intent,
      outcome: readable ? "allowed" : "denied",
      completed_at: completedAt,
      reason_code: reasonCode,
    };
    if (!row) {
      await this.recordDeniedAttempt(intent, "archive_not_found");
      return { record: null, access };
    }
    if (!readable) {
      await this.recordAccess(access);
      return { record: null, access };
    }

    const record: LegacySnapshotArchiveRecord = {
      archive_id: row.id,
      migration_run_id: row.migration_run_id,
      source_key: row.source_key,
      source_updated_at: iso(row.source_updated_at),
      source_frozen_at: iso(row.source_frozen_at),
      exact_text_sha256: row.exact_hash,
      semantic_sha256: row.canonical_hash,
      source_text_byte_length: Number(row.exact_byte_size),
      semantic_canonical_byte_length: Number(row.canonical_byte_size),
      manifest_hash: row.manifest_hash,
      storage_ref: row.storage_ref,
      object_counts: row.object_counts,
      last_included_record: Object.keys(row.last_record).length === 0 ? null : row.last_record,
      retention_expires_at: iso(row.retention_until),
      encrypted: {
        algorithm: row.cipher,
        key_id: row.key_id,
        key_fingerprint: row.key_fingerprint,
        nonce_base64: base64(row.nonce),
        auth_tag_base64: base64(row.auth_tag),
        ciphertext_base64: base64(row.ciphertext),
        aad_sha256: row.aad_hash,
        ciphertext_sha256: row.ciphertext_hash,
      },
      created_at: iso(row.captured_at),
    };
    await this.recordAccess(access);
    return { record, access };
  }

  async recordAccess(result: LegacyArchiveAccessResult): Promise<void> {
    await this.recordOperation("read", result);
  }

  async recordVerification(result: LegacyArchiveAccessResult): Promise<void> {
    await this.recordOperation("verify", result);
  }

  private async recordOperation(
    operation: "read" | "verify",
    result: LegacyArchiveAccessResult,
  ): Promise<void> {
    await this.sql.query(
      `INSERT INTO legacy_archive_access_events (
         id, archive_id, actor_type, actor_id, operation, outcome,
         correlation_id, occurred_at, details, redaction_applied
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,true)
       ON CONFLICT (id) DO NOTHING`,
      [
        result.intent.access_id,
        result.intent.archive_id,
        result.intent.actor_type,
        result.intent.actor_id,
        operation,
        result.outcome,
        result.intent.correlation_id,
        result.completed_at,
        JSON.stringify({
          purpose: result.intent.purpose,
          session_present: result.intent.session_id !== null,
          reason_code: result.reason_code,
          ...(operation === "verify" ? { verification: "authenticated_archive_and_hashes" } : {}),
        }),
      ],
    );
  }

  private async recordDeniedAttempt(
    intent: LegacyArchiveAccessIntent,
    reasonCode: string,
  ): Promise<void> {
    const targetExists = await this.sql.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM legacy_snapshot_archives WHERE id = $1) AS present",
      [intent.archive_id],
    );
    if (targetExists.rows[0]?.present) {
      await this.recordAccess({
        intent,
        outcome: "denied",
        completed_at: intent.requested_at,
        reason_code: reasonCode,
      });
      return;
    }
    await this.sql.query(
      `INSERT INTO audit_events (
         audit_id, audit_type, project_id, phase_id, task_id,
         actor_type, actor_id, outcome, severity, correlation_id,
         causation_id, occurred_at, targets, summary, details,
         redaction_applied
       ) VALUES (
         $1,'legacy_archive.access_denied',NULL,NULL,NULL,
         $2,$3,'denied','warning',$4,NULL,
         transaction_timestamp(),$5::jsonb,
         'Legacy archive access denied',$6::jsonb,true
       ) ON CONFLICT (audit_id) DO NOTHING`,
      [
        `audit:${intent.access_id}`,
        intent.actor_type,
        intent.actor_id,
        intent.correlation_id,
        JSON.stringify([{ entity_type: "legacy_snapshot_archive", entity_id: "redacted" }]),
        JSON.stringify({
          purpose: intent.purpose,
          reason_code: reasonCode,
          session_present: intent.session_id !== null,
        }),
      ],
    );
  }
}
