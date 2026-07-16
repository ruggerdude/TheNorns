import { createHash } from "node:crypto";
import type { CredentialHmacKey } from "../../users/credentialTokens.js";
import {
  type SanitizableLegacyUserSnapshot,
  hasReusableLegacyCredentials,
} from "../../users/legacyCredentialSanitizer.js";
import type { V2TransactionRunner } from "../v2/database.js";
import type { LegacyArchiveEncryptionKey } from "./archiveCrypto.js";
import { canonicalSha256 } from "./canonicalJson.js";
import {
  SqlPhase2CheckpointRepository,
  type StoredPhase2MigrationRun,
  type StoredPhase2MigrationStep,
} from "./checkpointRepository.js";
import { SqlLegacyIdentityImporter } from "./identityImport.js";
import { SqlLegacySnapshotSourceRepository } from "./legacySnapshotSourceRepository.js";
import { buildLegacyRecoveryCheckpoint } from "./snapshotCapture.js";

export type Phase2FaultPoint =
  | "after_checkpoint"
  | "after_identity_import"
  | "after_legacy_sanitization";

export class Phase2SourceChangedError extends Error {
  constructor() {
    super("legacy source changed after the Phase 2 checkpoint identity was established");
    this.name = "Phase2SourceChangedError";
  }
}

export interface RunPhase2IdentityCheckpointInput {
  migration_run_id: string;
  migration_name?: string | undefined;
  backup_provider: string;
  backup_reference: string;
  application_version: string;
  application_commit: string;
  retention_expires_at: string;
  archive_key: LegacyArchiveEncryptionKey;
  credential_key: CredentialHmacKey;
  random_bytes?: ((size: number) => Uint8Array) | undefined;
  fault_at?: Phase2FaultPoint | undefined;
}

export interface Phase2IdentityCheckpointResult {
  migration_run_id: string;
  source_bundle_hash: string;
  replayed: boolean;
  counts: {
    users: number;
    sessions: number;
    invitations: number;
    active_admins: number;
  };
}

function exactTextHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactHashes(
  sources: readonly { key: string; source_text: string }[],
): Record<string, string> {
  return Object.fromEntries(
    sources.map((source) => [source.key, exactTextHash(source.source_text)]),
  );
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function countsFromStep(step: StoredPhase2MigrationStep): Phase2IdentityCheckpointResult["counts"] {
  const counts = record(step.output_counts);
  return {
    users: Number(counts.users ?? 0),
    sessions: Number(counts.sessions ?? 0),
    invitations: Number(counts.invitations ?? 0),
    active_admins: Number(counts.active_admins ?? 0),
  };
}

async function completedIdentityStep(
  checkpoints: SqlPhase2CheckpointRepository,
  run: StoredPhase2MigrationRun,
): Promise<StoredPhase2MigrationStep> {
  if (run.source_manifest_hash === null) {
    throw new Error("existing Phase 2 migration run has no source manifest");
  }
  const step = await checkpoints.findStep(run.id, "identity_import");
  if (
    step === null ||
    step.status !== "succeeded" ||
    step.input_hash !== run.source_manifest_hash
  ) {
    throw new Error("existing Phase 2 migration run has no completed identity import step");
  }
  return step;
}

function assertReplaySource(
  run: StoredPhase2MigrationRun,
  currentHashes: Record<string, string>,
  applicationCommit: string,
): void {
  if (run.source_application_commit !== applicationCommit) {
    throw new Error(
      "Phase 2 replay requires the application commit recorded at checkpoint capture",
    );
  }
  const expected = record(run.details.replay_source_exact_hashes);
  if (canonicalSha256(expected) !== canonicalSha256(currentHashes)) {
    throw new Phase2SourceChangedError();
  }
}

const IDENTITY_REPLAYABLE_RUN_STATUSES = new Set([
  "importing",
  "reconciling",
  "shadowing",
  "ready",
  "cutover",
]);

function identityRunIsReplayable(run: StoredPhase2MigrationRun): boolean {
  return run.source_manifest_hash !== null && IDENTITY_REPLAYABLE_RUN_STATUSES.has(run.status);
}

function maybeFault(input: RunPhase2IdentityCheckpointInput, point: Phase2FaultPoint): void {
  if (input.fault_at === point) throw new Error(`fault injected at ${point}`);
}

export class Phase2IdentityCheckpointCoordinator {
  constructor(private readonly transactions: V2TransactionRunner) {}

  async run(input: RunPhase2IdentityCheckpointInput): Promise<Phase2IdentityCheckpointResult> {
    for (const value of [
      input.migration_run_id,
      input.backup_provider,
      input.backup_reference,
      input.application_version,
      input.application_commit,
    ]) {
      if (value.trim().length === 0) {
        throw new Error("Phase 2 recovery checkpoint identity fields must not be empty");
      }
    }
    const migrationName = input.migration_name ?? "phase2_legacy_preservation";
    return this.transactions.transaction(async (sql) => {
      const sources = new SqlLegacySnapshotSourceRepository(sql);
      await sources.beginCapture();
      const databaseFacts = await sources.databaseRecoveryFacts();
      const captured = await sources.captureAllForUpdate();
      const currentHashes = exactHashes(captured);
      const checkpoints = new SqlPhase2CheckpointRepository(sql);

      const existingRun = await checkpoints.findRunById(input.migration_run_id);
      if (existingRun) {
        if (!identityRunIsReplayable(existingRun)) {
          throw new Error("existing Phase 2 migration run is not replayable");
        }
        const sourceManifestHash = existingRun.source_manifest_hash;
        if (sourceManifestHash === null) {
          throw new Error("existing Phase 2 migration run has no source manifest");
        }
        const identityStep = await completedIdentityStep(checkpoints, existingRun);
        assertReplaySource(existingRun, currentHashes, input.application_commit);
        return {
          migration_run_id: existingRun.id,
          source_bundle_hash: sourceManifestHash,
          replayed: true,
          counts: countsFromStep(identityStep),
        };
      }

      const existingLineage = await checkpoints.findRunByName(migrationName);
      if (existingLineage) {
        throw new Error(
          `Phase 2 preservation already belongs to migration run ${existingLineage.id}; resume that run ID`,
        );
      }

      const checkpoint = buildLegacyRecoveryCheckpoint({
        migration_run_id: input.migration_run_id,
        source_frozen_at: databaseFacts.database_time,
        recovery_marker: {
          provider: input.backup_provider,
          backup_reference: input.backup_reference,
          database_time: databaseFacts.database_time,
          wal_lsn: databaseFacts.wal_lsn,
          transaction_id: databaseFacts.transaction_id,
          application_version: input.application_version,
          application_commit: input.application_commit,
        },
        retention_expires_at: input.retention_expires_at,
        sources: captured,
        encryption_key: input.archive_key,
        random_bytes: input.random_bytes,
      });

      const sameBundle = await checkpoints.findRunByManifest(
        migrationName,
        checkpoint.manifest.source_bundle_hash,
      );
      if (sameBundle) {
        if (!identityRunIsReplayable(sameBundle)) {
          throw new Error("the same legacy bundle is owned by an incomplete migration run");
        }
        const identityStep = await completedIdentityStep(checkpoints, sameBundle);
        assertReplaySource(sameBundle, currentHashes, input.application_commit);
        return {
          migration_run_id: sameBundle.id,
          source_bundle_hash: checkpoint.manifest.source_bundle_hash,
          replayed: true,
          counts: countsFromStep(identityStep),
        };
      }

      await checkpoints.insertCheckpoint(migrationName, checkpoint);
      maybeFault(input, "after_checkpoint");

      const usersSource = captured.find((source) => source.key === "users");
      if (!usersSource) throw new Error("required legacy users snapshot disappeared");
      const identity = await new SqlLegacyIdentityImporter(sql).import({
        migration_run_id: input.migration_run_id,
        source_text: usersSource.source_text,
        source_frozen_at: databaseFacts.database_time,
        credential_key: input.credential_key,
      });
      maybeFault(input, "after_identity_import");

      await sources.replaceUsersSnapshot(
        usersSource.source_text,
        identity.sanitized_snapshot_json,
        databaseFacts.database_time,
      );
      maybeFault(input, "after_legacy_sanitization");

      const replaySources = await sources.currentSources();
      const replayUsers = replaySources.find((source) => source.key === "users");
      if (!replayUsers) throw new Error("sanitized legacy users snapshot disappeared");
      const parsedReplayUsers = JSON.parse(
        replayUsers.source_text,
      ) as SanitizableLegacyUserSnapshot;
      if (hasReusableLegacyCredentials(parsedReplayUsers)) {
        throw new Error("live legacy users snapshot still contains reusable credentials");
      }
      const replaySourceHashes = exactHashes(replaySources);

      await checkpoints.completeIdentityImport(
        input.migration_run_id,
        checkpoint.manifest.source_bundle_hash,
        databaseFacts.database_time,
        {
          replay_source_exact_hashes: replaySourceHashes,
          sanitized_users_exact_hash: replaySourceHashes.users,
        },
        identity.counts,
      );

      return {
        migration_run_id: input.migration_run_id,
        source_bundle_hash: checkpoint.manifest.source_bundle_hash,
        replayed: false,
        counts: identity.counts,
      };
    });
  }
}
