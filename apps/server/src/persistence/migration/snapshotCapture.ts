import { createHash } from "node:crypto";
import type { LegacyArchiveEncryptionKey } from "./archiveCrypto.js";
import { encryptLegacyArchive } from "./archiveCrypto.js";
import type {
  GovernedLegacySnapshotKey,
  LegacySnapshotArchiveRecord,
  LegacySnapshotKey,
} from "./archiveRepository.js";
import { canonicalJson, canonicalSha256 } from "./canonicalJson.js";
import { analyzeLegacySnapshot, isGovernedLegacySnapshotKey } from "./legacySnapshots.js";

const REQUIRED_SNAPSHOT_KEYS = ["users", "projects", "relay"] as const;

export interface LegacySnapshotSource {
  key: LegacySnapshotKey;
  /** Exact `snapshot::text` returned by PostgreSQL. */
  source_text: string;
  updated_at: string;
}

export interface LegacyRecoveryMarker {
  provider: string;
  backup_reference: string;
  database_time: string;
  wal_lsn: string;
  transaction_id: string;
  application_version: string;
  application_commit: string;
}

export interface LegacyRecoveryCheckpointInput {
  migration_run_id: string;
  source_frozen_at: string;
  recovery_marker: LegacyRecoveryMarker;
  retention_expires_at: string;
  sources: readonly LegacySnapshotSource[];
  encryption_key: LegacyArchiveEncryptionKey;
  random_bytes?: ((size: number) => Uint8Array) | undefined;
}

export interface LegacyRecoveryCheckpointManifest {
  migration_run_id: string;
  source_frozen_at: string;
  recovery_marker: LegacyRecoveryMarker;
  retention_expires_at: string;
  /** Semantic/canonical hashes retained for the existing migration ledger. */
  source_snapshot_hashes: Record<string, string>;
  source_exact_text_hashes: Record<string, string>;
  source_semantic_hashes: Record<string, string>;
  source_counts: Record<string, Record<string, number>>;
  source_updated_at: Record<string, string>;
  last_included_records: Record<string, Record<string, unknown> | null>;
  unknown_keys: string[];
  findings: (
    | { code: "unknown_snapshot_key"; source_key: string }
    | {
        code: "nonterminal_legacy_command";
        source_key: "relay";
        command_id: string;
        state: string;
        updated_at: string;
        source_fingerprint: string;
      }
  )[];
  source_bundle_hash: string;
}

export interface LegacyRecoveryCheckpoint {
  manifest: LegacyRecoveryCheckpointManifest;
  archives: LegacySnapshotArchiveRecord[];
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireSources(
  sources: readonly LegacySnapshotSource[],
): Map<LegacySnapshotKey, LegacySnapshotSource> {
  const byKey = new Map<LegacySnapshotKey, LegacySnapshotSource>();
  for (const source of sources) {
    if (source.key.trim().length === 0) throw new Error("legacy snapshot key must not be empty");
    if (byKey.has(source.key)) {
      throw new Error(`duplicate legacy snapshot source: ${source.key}`);
    }
    byKey.set(source.key, source);
  }
  for (const key of REQUIRED_SNAPSHOT_KEYS) {
    if (!byKey.has(key)) throw new Error(`missing legacy snapshot source: ${key}`);
  }
  return byKey;
}

export function buildLegacyRecoveryCheckpoint(
  input: LegacyRecoveryCheckpointInput,
): LegacyRecoveryCheckpoint {
  if (input.migration_run_id.trim().length === 0) {
    throw new Error("migration run id must not be empty");
  }
  const frozenAt = Date.parse(input.source_frozen_at);
  const retentionExpiresAt = Date.parse(input.retention_expires_at);
  if (
    Number.isNaN(frozenAt) ||
    Number.isNaN(retentionExpiresAt) ||
    retentionExpiresAt <= frozenAt
  ) {
    throw new Error("archive retention must extend beyond the source freeze time");
  }
  for (const value of Object.values(input.recovery_marker)) {
    if (value.trim().length === 0) throw new Error("recovery marker fields must not be empty");
  }

  const sourceByKey = requireSources(input.sources);
  const sourceSnapshotHashes: Record<string, string> = {};
  const sourceExactTextHashes: Record<string, string> = {};
  const sourceSemanticHashes: Record<string, string> = {};
  const sourceCounts: Record<string, Record<string, number>> = {};
  const sourceUpdatedAt: Record<string, string> = {};
  const lastIncludedRecords: Record<string, Record<string, unknown> | null> = {};
  const prepared: {
    key: LegacySnapshotKey;
    sourceText: string;
    sourceUpdatedAt: string;
    exactTextSha256: string;
    semanticSha256: string;
    analysis: ReturnType<typeof analyzeLegacySnapshot>;
  }[] = [];

  const orderedKeys = [
    ...REQUIRED_SNAPSHOT_KEYS,
    ...[...sourceByKey.keys()].filter((key) => !isGovernedLegacySnapshotKey(key)).sort(),
  ];
  for (const key of orderedKeys) {
    const source = sourceByKey.get(key);
    if (!source) throw new Error(`missing legacy snapshot source: ${key}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.source_text);
    } catch {
      throw new Error(`legacy snapshot source is not valid JSON: ${key}`);
    }
    const analysis = analyzeLegacySnapshot(key, parsed);
    const exactTextHash = sha256Text(source.source_text);
    const semanticHash = canonicalSha256(parsed);
    sourceSnapshotHashes[key] = semanticHash;
    sourceExactTextHashes[key] = exactTextHash;
    sourceSemanticHashes[key] = semanticHash;
    sourceCounts[key] = analysis.object_counts;
    sourceUpdatedAt[key] = source.updated_at;
    lastIncludedRecords[key] = analysis.last_included_record;
    prepared.push({
      key,
      sourceText: source.source_text,
      sourceUpdatedAt: source.updated_at,
      exactTextSha256: exactTextHash,
      semanticSha256: semanticHash,
      analysis,
    });
  }
  const unknownKeys = orderedKeys.filter((key) => !isGovernedLegacySnapshotKey(key));
  const relayAnalysis = prepared.find((source) => source.key === "relay")?.analysis;
  const nonterminalCommandFindings = (relayAnalysis?.nonterminal_commands ?? []).map((command) => ({
    code: "nonterminal_legacy_command" as const,
    source_key: "relay" as const,
    command_id: command.command_id,
    state: command.state,
    updated_at: command.updated_at,
    source_fingerprint: canonicalSha256(command),
  }));

  const manifestWithoutHash = {
    source_snapshot_hashes: sourceSnapshotHashes,
    source_exact_text_hashes: sourceExactTextHashes,
    source_semantic_hashes: sourceSemanticHashes,
    source_counts: sourceCounts,
    source_updated_at: sourceUpdatedAt,
    last_included_records: lastIncludedRecords,
    unknown_keys: unknownKeys,
    findings: [
      ...unknownKeys.map((sourceKey) => ({
        code: "unknown_snapshot_key" as const,
        source_key: sourceKey,
      })),
      ...nonterminalCommandFindings,
    ],
  };
  const sourceBundleHash = canonicalSha256(manifestWithoutHash);
  const manifest: LegacyRecoveryCheckpointManifest = {
    migration_run_id: input.migration_run_id,
    source_frozen_at: input.source_frozen_at,
    recovery_marker: input.recovery_marker,
    retention_expires_at: input.retention_expires_at,
    ...manifestWithoutHash,
    source_bundle_hash: sourceBundleHash,
  };

  const archives = prepared.map(
    ({
      key,
      sourceText,
      sourceUpdatedAt: updatedAt,
      exactTextSha256,
      semanticSha256,
      analysis,
    }) => {
      const archiveId = `legacy_archive:${input.migration_run_id}:${key}`;
      const context = {
        archive_id: archiveId,
        migration_run_id: input.migration_run_id,
        source_key: key,
        exact_text_sha256: exactTextSha256,
        semantic_sha256: semanticSha256,
        source_frozen_at: input.source_frozen_at,
      };
      const encrypted = encryptLegacyArchive(
        Buffer.from(sourceText, "utf8"),
        input.encryption_key,
        context,
        input.random_bytes,
      );
      return {
        archive_id: archiveId,
        migration_run_id: input.migration_run_id,
        source_key: key,
        source_updated_at: updatedAt,
        source_frozen_at: input.source_frozen_at,
        exact_text_sha256: exactTextSha256,
        semantic_sha256: semanticSha256,
        source_text_byte_length: Buffer.byteLength(sourceText, "utf8"),
        semantic_canonical_byte_length: Buffer.byteLength(canonicalJson(JSON.parse(sourceText))),
        manifest_hash: sourceBundleHash,
        storage_ref: `postgres:legacy_snapshot_archives:${archiveId}`,
        object_counts: analysis.object_counts,
        last_included_record: analysis.last_included_record,
        retention_expires_at: input.retention_expires_at,
        encrypted,
        created_at: input.source_frozen_at,
      } satisfies LegacySnapshotArchiveRecord;
    },
  );

  return { manifest, archives };
}
