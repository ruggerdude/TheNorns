import type { LegacyArchiveCiphertext } from "./archiveCrypto.js";

export type GovernedLegacySnapshotKey = "users" | "projects" | "relay";
export type LegacySnapshotKey = string;

export type LegacyArchiveAccessPurpose =
  | "migration_reconciliation"
  | "rollback_dry_run"
  | "restore_validation"
  | "incident_recovery"
  | "retention_disposition";

export interface LegacyArchiveAccessIntent {
  access_id: string;
  archive_id: string;
  actor_type: "human" | "coordinator" | "agent" | "runner" | "system" | "legacy";
  actor_id: string | null;
  session_id: string | null;
  purpose: LegacyArchiveAccessPurpose;
  correlation_id: string;
  requested_at: string;
}

export interface LegacyArchiveAccessResult {
  intent: LegacyArchiveAccessIntent;
  outcome: "allowed" | "denied" | "failed";
  completed_at: string;
  reason_code: string | null;
}

export interface LegacySnapshotArchiveRecord {
  archive_id: string;
  migration_run_id: string;
  source_key: LegacySnapshotKey;
  source_updated_at: string;
  source_frozen_at: string;
  exact_text_sha256: string;
  semantic_sha256: string;
  source_text_byte_length: number;
  semantic_canonical_byte_length: number;
  manifest_hash: string;
  storage_ref: string;
  object_counts: Record<string, number>;
  last_included_record: Record<string, unknown> | null;
  retention_expires_at: string;
  encrypted: LegacyArchiveCiphertext;
  created_at: string;
}

/**
 * The archive repository deliberately exposes ciphertext records only. A
 * caller must separately supply an access intent and an external key before
 * decryption; neither plaintext nor encryption keys belong in this port.
 */
export interface LegacyArchiveRepository {
  insert(record: LegacySnapshotArchiveRecord): Promise<void>;
  findCiphertext(
    archiveId: string,
    intent: LegacyArchiveAccessIntent,
  ): Promise<{
    record: LegacySnapshotArchiveRecord | null;
    access: LegacyArchiveAccessResult;
  }>;
  recordAccess(result: LegacyArchiveAccessResult): Promise<void>;
  /** Records authenticated-decryption/hash verification separately from the read grant. */
  recordVerification(result: LegacyArchiveAccessResult): Promise<void>;
}
