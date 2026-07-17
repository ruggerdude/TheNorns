import { createHash } from "node:crypto";
import type { V2SqlExecutor, V2TransactionRunner } from "../v2/database.js";
import type { LegacyArchiveEncryptionKey } from "./archiveCrypto.js";
import { LEGACY_ARCHIVE_ALGORITHM, decryptLegacyArchive } from "./archiveCrypto.js";
import { canonicalJson, canonicalSha256 } from "./canonicalJson.js";

export class Phase2RestoreVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase2RestoreVerificationError";
  }
}

export interface LegacySourceHashEvidence {
  exact_text_hashes: Readonly<Record<string, string>>;
  semantic_hashes: Readonly<Record<string, string>>;
}

export interface RestoredLegacySourceVerification {
  source_keys: string[];
  exact_text_hashes: Record<string, string>;
  semantic_hashes: Record<string, string>;
  restored_database_identity: PostgresDatabaseIdentity;
  checked_migration_run_id: string;
  migration_run_absent: true;
  verified: true;
}

export interface PostgresDatabaseIdentity {
  system_identifier: string;
  database_oid: string;
  database_name: string;
  server_address: string | null;
  server_port: number | null;
  server_started_at: string;
}

export interface RestoredLegacySourceVerificationOptions {
  migration_run_id: string;
  live_database_identity: PostgresDatabaseIdentity;
}

export interface RecordedRecoveryVerification {
  migration_run_id: string;
  source_manifest_hash: string;
  verification_hash: string;
  restore_database_proof_hash: string;
  archive_cipher_proof_hash: string;
  verified_at: string;
  archive_count: number;
  replayed: boolean;
}

interface RestoredSourceRow {
  key: string;
  source_text: string;
}

interface RecoveryEvidenceRow {
  source_manifest_hash: string | null;
  source_snapshot_hashes: Record<string, string>;
  details: Record<string, unknown>;
  checkpoint_id: string;
  checkpoint_verified_at: string | Date | null;
  source_frozen_at: string | Date;
}

interface RecoveryArchiveRow {
  id: string;
  source_key: string;
  key_id: string;
  key_fingerprint: string;
  cipher: string;
  exact_hash: string;
  canonical_hash: string;
  ciphertext_hash: string;
  aad_hash: string;
  manifest_hash: string;
  exact_byte_size: number | string;
  canonical_byte_size: number | string;
  nonce: Uint8Array;
  auth_tag: Uint8Array;
  ciphertext: Uint8Array;
  status: string;
  verified_at: string | Date | null;
}

interface ArchiveProof {
  archive_id: string;
  source_key: string;
  key_id: string;
  key_fingerprint: string;
  aad_sha256: string;
  ciphertext_sha256: string;
  exact_text_sha256: string;
  semantic_sha256: string;
  plaintext_byte_length: number;
  semantic_canonical_byte_length: number;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function exactTextHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactBytesHash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortedKeys(value: Readonly<Record<string, string>>): string[] {
  return Object.keys(value).sort();
}

function assertExpectedHashShape(label: string, hashes: Readonly<Record<string, string>>): void {
  if (Object.keys(hashes).length === 0) {
    throw new Phase2RestoreVerificationError(`${label} cannot be empty`);
  }
  for (const [key, hash] of Object.entries(hashes)) {
    if (key.trim().length === 0 || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Phase2RestoreVerificationError(`${label} contains malformed evidence`);
    }
  }
}

function hashRecord(label: string, value: unknown): Record<string, string> {
  const candidate = record(value);
  if (Object.values(candidate).some((hash) => typeof hash !== "string")) {
    throw new Phase2RestoreVerificationError(`${label} contains malformed evidence`);
  }
  const hashes = candidate as Record<string, string>;
  assertExpectedHashShape(label, hashes);
  return hashes;
}

function databaseIdentityKey(identity: PostgresDatabaseIdentity): string {
  for (const value of [
    identity.system_identifier,
    identity.database_oid,
    identity.database_name,
    identity.server_started_at,
  ]) {
    if (value.trim().length === 0) {
      throw new Phase2RestoreVerificationError("PostgreSQL database identity is incomplete");
    }
  }
  if (
    (identity.server_address === null) !== (identity.server_port === null) ||
    (identity.server_port !== null && !Number.isSafeInteger(identity.server_port))
  ) {
    throw new Phase2RestoreVerificationError("PostgreSQL server identity is incomplete");
  }
  return [
    identity.system_identifier,
    identity.server_address ?? "local-socket",
    identity.server_port === null ? "local-socket" : String(identity.server_port),
    identity.server_started_at,
    identity.database_oid,
  ].join("\u0000");
}

export async function readPostgresDatabaseIdentity(
  sql: V2SqlExecutor,
): Promise<PostgresDatabaseIdentity> {
  const result = await sql.query<PostgresDatabaseIdentity>(
    `SELECT control.system_identifier::text AS system_identifier,
            database.oid::text AS database_oid,
            current_database() AS database_name,
            inet_server_addr()::text AS server_address,
            inet_server_port() AS server_port,
            pg_postmaster_start_time()::text AS server_started_at
     FROM pg_control_system() AS control
     JOIN pg_database AS database
       ON database.datname = current_database()`,
  );
  const identity = result.rows[0];
  if (!identity) {
    throw new Phase2RestoreVerificationError("PostgreSQL database identity is unavailable");
  }
  databaseIdentityKey(identity);
  return identity;
}

export function assertDistinctPostgresDatabases(
  live: PostgresDatabaseIdentity,
  restored: PostgresDatabaseIdentity,
): void {
  if (databaseIdentityKey(live) === databaseIdentityKey(restored)) {
    throw new Phase2RestoreVerificationError(
      "live and restored recovery targets are the same PostgreSQL database",
    );
  }
}

async function assertMigrationRunAbsent(
  restored: V2SqlExecutor,
  migrationRunId: string,
): Promise<void> {
  if (migrationRunId.trim().length === 0) {
    throw new Phase2RestoreVerificationError("migration run id must not be empty");
  }
  const relation = await restored.query<{ relation: string | null }>(
    "SELECT to_regclass('migration_runs')::text AS relation",
  );
  const migrationRelation = relation.rows[0];
  if (!migrationRelation) {
    throw new Phase2RestoreVerificationError(
      "restored database could not prove migration-run absence",
    );
  }
  if (migrationRelation.relation === null) return;
  const present = await restored.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM migration_runs WHERE id = $1
     ) AS present`,
    [migrationRunId],
  );
  if (present.rows[0]?.present !== false) {
    throw new Phase2RestoreVerificationError(
      "restored recovery target contains the current migration run",
    );
  }
}

/**
 * Verifies a database restored from the protected pre-cutover backup.
 *
 * The caller must connect this executor to the restored database, not the live
 * source. Comparing both `snapshot::text` and canonical JSON hashes proves the
 * restored rows match the exact PostgreSQL representation and the semantic
 * checkpoint identity recorded before transformation.
 */
export async function verifyRestoredLegacySources(
  restored: V2SqlExecutor,
  expected: LegacySourceHashEvidence,
  options: RestoredLegacySourceVerificationOptions,
): Promise<RestoredLegacySourceVerification> {
  assertExpectedHashShape("exact source hashes", expected.exact_text_hashes);
  assertExpectedHashShape("semantic source hashes", expected.semantic_hashes);
  if (
    sortedKeys(expected.exact_text_hashes).join("\u0000") !==
    sortedKeys(expected.semantic_hashes).join("\u0000")
  ) {
    throw new Phase2RestoreVerificationError(
      "exact and semantic recovery evidence cover different source keys",
    );
  }

  const restoredDatabaseIdentity = await readPostgresDatabaseIdentity(restored);
  assertDistinctPostgresDatabases(options.live_database_identity, restoredDatabaseIdentity);
  await assertMigrationRunAbsent(restored, options.migration_run_id);

  const result = await restored.query<RestoredSourceRow>(
    `SELECT key, snapshot::text AS source_text
     FROM norns_state
     ORDER BY key`,
  );
  const restoredKeys = result.rows.map((row) => row.key);
  const expectedKeys = sortedKeys(expected.exact_text_hashes);
  if (restoredKeys.join("\u0000") !== expectedKeys.join("\u0000")) {
    throw new Phase2RestoreVerificationError(
      "restored legacy source keys do not match the frozen checkpoint",
    );
  }

  const exactTextHashes: Record<string, string> = {};
  const semanticHashes: Record<string, string> = {};
  for (const row of result.rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.source_text);
    } catch {
      throw new Phase2RestoreVerificationError(
        `restored legacy source is not valid JSON: ${row.key}`,
      );
    }
    const exact = exactTextHash(row.source_text);
    const semantic = canonicalSha256(parsed);
    if (exact !== expected.exact_text_hashes[row.key]) {
      throw new Phase2RestoreVerificationError(
        `restored exact source hash does not match: ${row.key}`,
      );
    }
    if (semantic !== expected.semantic_hashes[row.key]) {
      throw new Phase2RestoreVerificationError(
        `restored semantic source hash does not match: ${row.key}`,
      );
    }
    exactTextHashes[row.key] = exact;
    semanticHashes[row.key] = semantic;
  }

  return {
    source_keys: restoredKeys,
    exact_text_hashes: exactTextHashes,
    semantic_hashes: semanticHashes,
    restored_database_identity: restoredDatabaseIdentity,
    checked_migration_run_id: options.migration_run_id,
    migration_run_absent: true,
    verified: true,
  };
}

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function positiveSafeByteCount(value: number | string, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Phase2RestoreVerificationError(`${label} is not a valid byte count`);
  }
  return count;
}

function assertArchiveSourceKeys(
  archives: readonly RecoveryArchiveRow[],
  expectedKeys: readonly string[],
): void {
  const archiveKeys = archives.map((archive) => archive.source_key).sort();
  if (archiveKeys.join("\u0000") !== [...expectedKeys].sort().join("\u0000")) {
    throw new Phase2RestoreVerificationError(
      "encrypted archive source keys do not match the frozen checkpoint",
    );
  }
}

function verifyArchive(
  archive: RecoveryArchiveRow,
  migrationRunId: string,
  sourceFrozenAt: string,
  sourceManifestHash: string,
  expectedExact: Readonly<Record<string, string>>,
  expectedSemantic: Readonly<Record<string, string>>,
  archiveKey: LegacyArchiveEncryptionKey,
): ArchiveProof {
  if (archive.cipher !== LEGACY_ARCHIVE_ALGORITHM) {
    throw new Phase2RestoreVerificationError(
      `encrypted archive uses an unsupported cipher: ${archive.source_key}`,
    );
  }
  if (
    archive.manifest_hash !== sourceManifestHash ||
    archive.exact_hash !== expectedExact[archive.source_key] ||
    archive.canonical_hash !== expectedSemantic[archive.source_key]
  ) {
    throw new Phase2RestoreVerificationError(
      `encrypted archive metadata does not match the checkpoint: ${archive.source_key}`,
    );
  }

  let plaintext: Buffer;
  try {
    plaintext = decryptLegacyArchive(
      {
        algorithm: LEGACY_ARCHIVE_ALGORITHM,
        key_id: archive.key_id,
        key_fingerprint: archive.key_fingerprint,
        nonce_base64: base64(archive.nonce),
        auth_tag_base64: base64(archive.auth_tag),
        ciphertext_base64: base64(archive.ciphertext),
        aad_sha256: archive.aad_hash,
        ciphertext_sha256: archive.ciphertext_hash,
      },
      archiveKey,
      {
        archive_id: archive.id,
        migration_run_id: migrationRunId,
        source_key: archive.source_key,
        exact_text_sha256: archive.exact_hash,
        semantic_sha256: archive.canonical_hash,
        source_frozen_at: sourceFrozenAt,
      },
    );
  } catch {
    throw new Phase2RestoreVerificationError(
      `encrypted archive authentication failed: ${archive.source_key}`,
    );
  }

  const exactByteSize = positiveSafeByteCount(
    archive.exact_byte_size,
    `encrypted archive plaintext size (${archive.source_key})`,
  );
  if (plaintext.byteLength !== exactByteSize || exactBytesHash(plaintext) !== archive.exact_hash) {
    throw new Phase2RestoreVerificationError(
      `encrypted archive plaintext does not match its exact evidence: ${archive.source_key}`,
    );
  }
  const sourceText = plaintext.toString("utf8");
  if (!Buffer.from(sourceText, "utf8").equals(plaintext)) {
    throw new Phase2RestoreVerificationError(
      `encrypted archive plaintext is not valid UTF-8: ${archive.source_key}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    throw new Phase2RestoreVerificationError(
      `encrypted archive plaintext is not valid JSON: ${archive.source_key}`,
    );
  }
  const semanticHash = canonicalSha256(parsed);
  const canonicalByteSize = Buffer.byteLength(canonicalJson(parsed), "utf8");
  if (
    semanticHash !== archive.canonical_hash ||
    canonicalByteSize !==
      positiveSafeByteCount(
        archive.canonical_byte_size,
        `encrypted archive canonical size (${archive.source_key})`,
      )
  ) {
    throw new Phase2RestoreVerificationError(
      `encrypted archive plaintext does not match its semantic evidence: ${archive.source_key}`,
    );
  }

  return {
    archive_id: archive.id,
    source_key: archive.source_key,
    key_id: archive.key_id,
    key_fingerprint: archive.key_fingerprint,
    aad_sha256: archive.aad_hash,
    ciphertext_sha256: archive.ciphertext_hash,
    exact_text_sha256: archive.exact_hash,
    semantic_sha256: archive.canonical_hash,
    plaintext_byte_length: plaintext.byteLength,
    semantic_canonical_byte_length: canonicalByteSize,
  };
}

/**
 * Commits the restore-drill result to the live migration database.
 *
 * This is intentionally separate from `verifyRestoredLegacySources`: the
 * former runs against the restored backup, while this repository writes only
 * after those hashes have been carried back over the human-controlled
 * recovery gate. It does not advance the migration run or any cutover route.
 */
export class SqlPhase2RecoveryVerificationRepository {
  constructor(private readonly transactions: V2TransactionRunner) {}

  async record(
    migrationRunId: string,
    verification: RestoredLegacySourceVerification,
    archiveKey: LegacyArchiveEncryptionKey,
  ): Promise<RecordedRecoveryVerification> {
    return this.transactions.transaction(async (sql) => {
      const evidenceResult = await sql.query<RecoveryEvidenceRow>(
        `SELECT run.source_manifest_hash, run.source_snapshot_hashes,
                run.details, run.source_frozen_at,
                checkpoint.id AS checkpoint_id,
                checkpoint.verified_at AS checkpoint_verified_at
         FROM migration_runs run
         JOIN recovery_checkpoints checkpoint
           ON checkpoint.migration_run_id = run.id
         WHERE run.id = $1
         FOR UPDATE OF run, checkpoint`,
        [migrationRunId],
      );
      const evidence = evidenceResult.rows[0];
      if (!evidence || evidence.source_manifest_hash === null) {
        throw new Phase2RestoreVerificationError(
          "migration recovery checkpoint is missing or incomplete",
        );
      }
      const expectedExact = hashRecord(
        "checkpoint exact source hashes",
        evidence.details.source_exact_text_hashes,
      );
      const expectedSemantic = hashRecord(
        "checkpoint semantic source hashes",
        evidence.source_snapshot_hashes,
      );
      const verificationKeys = [...verification.source_keys].sort();
      if (
        verification.verified !== true ||
        verification.migration_run_absent !== true ||
        verification.checked_migration_run_id !== migrationRunId ||
        canonicalSha256(verification.exact_text_hashes) !== canonicalSha256(expectedExact) ||
        canonicalSha256(verification.semantic_hashes) !== canonicalSha256(expectedSemantic) ||
        verificationKeys.join("\u0000") !== sortedKeys(expectedSemantic).join("\u0000")
      ) {
        throw new Phase2RestoreVerificationError(
          "restore verification does not match the migration checkpoint",
        );
      }

      const liveDatabaseIdentity = await readPostgresDatabaseIdentity(sql);
      assertDistinctPostgresDatabases(
        liveDatabaseIdentity,
        verification.restored_database_identity,
      );

      const archives = await sql.query<RecoveryArchiveRow>(
        `SELECT id, source_key, key_id, key_fingerprint, cipher, exact_hash, canonical_hash,
                ciphertext_hash, aad_hash, manifest_hash, exact_byte_size,
                canonical_byte_size, nonce, auth_tag, ciphertext, status,
                verified_at
         FROM legacy_snapshot_archives
         WHERE migration_run_id = $1
         ORDER BY source_key
         FOR UPDATE`,
        [migrationRunId],
      );
      assertArchiveSourceKeys(archives.rows, verificationKeys);
      const sourceFrozenAt = iso(evidence.source_frozen_at);
      const archiveProofs = archives.rows.map((archive) =>
        verifyArchive(
          archive,
          migrationRunId,
          sourceFrozenAt,
          evidence.source_manifest_hash as string,
          expectedExact,
          expectedSemantic,
          archiveKey,
        ),
      );
      const restoreDatabaseProofHash = canonicalSha256({
        restored_database_identity: verification.restored_database_identity,
        checked_migration_run_id: verification.checked_migration_run_id,
        migration_run_absent: verification.migration_run_absent,
        source_keys: verificationKeys,
        exact_text_hashes: verification.exact_text_hashes,
        semantic_hashes: verification.semantic_hashes,
      });
      const archiveCipherProofHash = canonicalSha256({
        migration_run_id: migrationRunId,
        source_manifest_hash: evidence.source_manifest_hash,
        archives: archiveProofs,
      });

      const clock = await sql.query<{ verified_at: string | Date }>(
        "SELECT transaction_timestamp() AS verified_at",
      );
      const verifiedAtValue = clock.rows[0]?.verified_at;
      if (!verifiedAtValue) {
        throw new Phase2RestoreVerificationError(
          "database did not provide a verification timestamp",
        );
      }
      const verifiedAt = iso(verifiedAtValue);
      const replayed = evidence.checkpoint_verified_at !== null;
      const effectiveVerifiedAt =
        evidence.checkpoint_verified_at === null
          ? verifiedAt
          : iso(evidence.checkpoint_verified_at);

      if (!replayed) {
        await sql.query(
          `UPDATE recovery_checkpoints
           SET verified_at = $2
           WHERE id = $1 AND verified_at IS NULL`,
          [evidence.checkpoint_id, verifiedAt],
        );
        await sql.query(
          `UPDATE legacy_snapshot_archives
           SET status = 'verified', verified_at = $2
           WHERE migration_run_id = $1
             AND status = 'sealed'
             AND verified_at IS NULL`,
          [migrationRunId, verifiedAt],
        );
      }

      const storedArchives = await sql.query<{
        id: string;
        status: string;
        verified_at: string | Date | null;
      }>(
        `SELECT id, status, verified_at
         FROM legacy_snapshot_archives
         WHERE migration_run_id = $1
         ORDER BY id`,
        [migrationRunId],
      );
      if (
        storedArchives.rows.length !== verificationKeys.length ||
        storedArchives.rows.some(
          (archive) =>
            (archive.status !== "verified" && archive.status !== "expired") ||
            archive.verified_at === null,
        )
      ) {
        throw new Phase2RestoreVerificationError(
          "not every checkpoint archive has durable verification evidence",
        );
      }

      const verificationHash = canonicalSha256({
        migration_run_id: migrationRunId,
        source_manifest_hash: evidence.source_manifest_hash,
        restore_database_proof_hash: restoreDatabaseProofHash,
        archive_cipher_proof_hash: archiveCipherProofHash,
      });
      await sql.query(
        `INSERT INTO migration_steps (
           migration_run_id, step_key, input_hash, status, attempt,
           output_hash, output_counts, started_at, completed_at, updated_at
         ) VALUES (
           $1,'recovery_restore_verification',$2,'succeeded',1,$3,$4::jsonb,
           $5,$5,$5
         ) ON CONFLICT (migration_run_id, step_key) DO NOTHING`,
        [
          migrationRunId,
          evidence.source_manifest_hash,
          verificationHash,
          JSON.stringify({
            archives: storedArchives.rows.length,
            sources: verificationKeys.length,
            restore_database_proof_hash: restoreDatabaseProofHash,
            archive_cipher_proof_hash: archiveCipherProofHash,
          }),
          effectiveVerifiedAt,
        ],
      );
      const storedStep = await sql.query<{
        input_hash: string;
        output_hash: string | null;
        status: string;
      }>(
        `SELECT input_hash, output_hash, status
         FROM migration_steps
         WHERE migration_run_id = $1
           AND step_key = 'recovery_restore_verification'`,
        [migrationRunId],
      );
      const step = storedStep.rows[0];
      if (
        !step ||
        step.status !== "succeeded" ||
        step.input_hash !== evidence.source_manifest_hash ||
        step.output_hash !== verificationHash
      ) {
        throw new Phase2RestoreVerificationError(
          "stored restore verification evidence conflicts with this drill",
        );
      }

      for (const archive of storedArchives.rows) {
        await sql.query(
          `INSERT INTO legacy_archive_access_events (
             id, archive_id, actor_type, actor_id, operation, outcome,
             correlation_id, occurred_at, details, redaction_applied
           ) VALUES (
             $1,$2,'system',NULL,'verify','allowed',$3,$4,$5::jsonb,true
           ) ON CONFLICT (id) DO NOTHING`,
          [
            `archive_access:restore-verification:${migrationRunId}:${archive.id}`,
            archive.id,
            `phase2-restore-verification:${migrationRunId}`,
            effectiveVerifiedAt,
            JSON.stringify({
              purpose: "database_restore_validation",
              verification_hash: verificationHash,
              restore_database_proof_hash: restoreDatabaseProofHash,
              archive_cipher_proof_hash: archiveCipherProofHash,
            }),
          ],
        );
      }

      return {
        migration_run_id: migrationRunId,
        source_manifest_hash: evidence.source_manifest_hash,
        verification_hash: verificationHash,
        restore_database_proof_hash: restoreDatabaseProofHash,
        archive_cipher_proof_hash: archiveCipherProofHash,
        verified_at: effectiveVerifiedAt,
        archive_count: storedArchives.rows.length,
        replayed,
      };
    });
  }
}
