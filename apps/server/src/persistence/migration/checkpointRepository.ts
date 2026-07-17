import type { V2SqlExecutor } from "../v2/database.js";
import { canonicalSha256 } from "./canonicalJson.js";
import type { LegacyRecoveryCheckpoint } from "./snapshotCapture.js";
import { SqlLegacyArchiveRepository } from "./sqlArchiveRepository.js";

interface MigrationRunRow {
  id: string;
  migration_name: string;
  source_manifest_hash: string | null;
  source_application_commit: string | null;
  status: string;
  details: Record<string, unknown>;
}

export interface StoredPhase2MigrationRun {
  id: string;
  migration_name: string;
  source_manifest_hash: string | null;
  source_application_commit: string | null;
  status: string;
  details: Record<string, unknown>;
}

interface MigrationStepRow {
  migration_run_id: string;
  step_key: string;
  input_hash: string;
  status: string;
  output_hash: string | null;
  output_counts: Record<string, unknown>;
}

export interface StoredPhase2MigrationStep {
  migration_run_id: string;
  step_key: string;
  input_hash: string;
  status: string;
  output_hash: string | null;
  output_counts: Record<string, unknown>;
}

export class SqlPhase2CheckpointRepository {
  private readonly archives: SqlLegacyArchiveRepository;

  constructor(private readonly sql: V2SqlExecutor) {
    this.archives = new SqlLegacyArchiveRepository(sql);
  }

  async findRunById(id: string): Promise<StoredPhase2MigrationRun | null> {
    const result = await this.sql.query<MigrationRunRow>(
      `SELECT id, migration_name, source_manifest_hash,
              source_application_commit, status, details
       FROM migration_runs
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async findRunByManifest(
    migrationName: string,
    sourceManifestHash: string,
  ): Promise<StoredPhase2MigrationRun | null> {
    const result = await this.sql.query<MigrationRunRow>(
      `SELECT id, migration_name, source_manifest_hash,
              source_application_commit, status, details
       FROM migration_runs
       WHERE migration_name = $1 AND source_manifest_hash = $2`,
      [migrationName, sourceManifestHash],
    );
    return result.rows[0] ?? null;
  }

  async findRunByName(migrationName: string): Promise<StoredPhase2MigrationRun | null> {
    const result = await this.sql.query<MigrationRunRow>(
      `SELECT id, migration_name, source_manifest_hash,
              source_application_commit, status, details
       FROM migration_runs
       WHERE migration_name = $1
       ORDER BY started_at
       LIMIT 1`,
      [migrationName],
    );
    return result.rows[0] ?? null;
  }

  async findStep(
    migrationRunId: string,
    stepKey: string,
  ): Promise<StoredPhase2MigrationStep | null> {
    const result = await this.sql.query<MigrationStepRow>(
      `SELECT migration_run_id, step_key, input_hash, status,
              output_hash, output_counts
       FROM migration_steps
       WHERE migration_run_id = $1 AND step_key = $2`,
      [migrationRunId, stepKey],
    );
    return result.rows[0] ?? null;
  }

  async insertCheckpoint(
    migrationName: string,
    checkpoint: LegacyRecoveryCheckpoint,
  ): Promise<void> {
    const { manifest } = checkpoint;
    await this.sql.query(
      `INSERT INTO migration_runs (
         id, migration_name, source_snapshot_hashes, source_counts,
         source_frozen_at, source_manifest_hash, source_application_version,
         source_application_commit, recovery_marker, last_source_records,
         status, started_at, rollback_window_until, details
       ) VALUES (
         $1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10::jsonb,
         'capturing',$5,$11,$12::jsonb
       )`,
      [
        manifest.migration_run_id,
        migrationName,
        JSON.stringify(manifest.source_snapshot_hashes),
        JSON.stringify(manifest.source_counts),
        manifest.source_frozen_at,
        manifest.source_bundle_hash,
        manifest.recovery_marker.application_version,
        manifest.recovery_marker.application_commit,
        JSON.stringify(manifest.recovery_marker),
        JSON.stringify(manifest.last_included_records),
        manifest.retention_expires_at,
        JSON.stringify({
          source_exact_text_hashes: manifest.source_exact_text_hashes,
          source_semantic_hashes: manifest.source_semantic_hashes,
          source_updated_at: manifest.source_updated_at,
          unknown_keys: manifest.unknown_keys,
        }),
      ],
    );

    await this.sql.query(
      `INSERT INTO recovery_checkpoints (
         id, migration_run_id, provider, backup_reference, database_time,
         wal_lsn, transaction_id, application_version, application_commit,
         source_manifest_hash, source_frozen_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        `recovery_checkpoint:${manifest.migration_run_id}`,
        manifest.migration_run_id,
        manifest.recovery_marker.provider,
        manifest.recovery_marker.backup_reference,
        manifest.recovery_marker.database_time,
        manifest.recovery_marker.wal_lsn,
        manifest.recovery_marker.transaction_id,
        manifest.recovery_marker.application_version,
        manifest.recovery_marker.application_commit,
        manifest.source_bundle_hash,
        manifest.source_frozen_at,
      ],
    );

    for (const archive of checkpoint.archives) await this.archives.insert(archive);

    for (const finding of manifest.findings) {
      const sourceFingerprint =
        finding.code === "unknown_snapshot_key"
          ? manifest.source_semantic_hashes[finding.source_key]
          : finding.source_fingerprint;
      if (!sourceFingerprint) throw new Error("migration finding lacks a source fingerprint");
      const identity = {
        migration_run_id: manifest.migration_run_id,
        code: finding.code,
        source_entity_id:
          finding.code === "unknown_snapshot_key" ? finding.source_key : finding.command_id,
        source_fingerprint: sourceFingerprint,
      };
      const sourceEntityType =
        finding.code === "unknown_snapshot_key" ? "legacy_snapshot" : "legacy_command";
      const sourceEntityId =
        finding.code === "unknown_snapshot_key" ? finding.source_key : finding.command_id;
      const severity = finding.code === "unknown_snapshot_key" ? "warning" : "blocking";
      const details =
        finding.code === "unknown_snapshot_key"
          ? { source_key: finding.source_key }
          : {
              source_key: finding.source_key,
              command_id: finding.command_id,
              state: finding.state,
              updated_at: finding.updated_at,
            };
      await this.sql.query(
        `INSERT INTO migration_reconciliation_findings (
           id, migration_run_id, project_id, code, severity, status,
           source_entity_type, source_entity_id, source_fingerprint,
           details, detected_at
         ) VALUES (
           $1,$2,NULL,$3,$4,'open',$5,$6,$7,$8::jsonb,$9
         ) ON CONFLICT (id) DO NOTHING`,
        [
          `migration_finding:${canonicalSha256(identity)}`,
          manifest.migration_run_id,
          finding.code,
          severity,
          sourceEntityType,
          sourceEntityId,
          sourceFingerprint,
          JSON.stringify(details),
          manifest.source_frozen_at,
        ],
      );
    }

    await this.sql.query(
      `UPDATE migration_runs
       SET status = 'importing'
       WHERE id = $1 AND status = 'capturing'`,
      [manifest.migration_run_id],
    );
  }

  async completeIdentityImport(
    migrationRunId: string,
    sourceManifestHash: string,
    completedAt: string,
    details: Record<string, unknown>,
    counts: Record<string, number>,
  ): Promise<void> {
    const outputHash = canonicalSha256({ counts, details });
    await this.sql.query(
      `INSERT INTO migration_steps (
         migration_run_id, step_key, input_hash, status, attempt,
         output_hash, output_counts, started_at, completed_at, updated_at
       ) VALUES ($1,'identity_import',$2,'succeeded',1,$3,$4::jsonb,$5,$5,$5)`,
      [migrationRunId, sourceManifestHash, outputHash, JSON.stringify(counts), completedAt],
    );

    const result = await this.sql.query<{ id: string }>(
      `UPDATE migration_runs
       SET status = 'importing',
           details = details || $2::jsonb
       WHERE id = $1 AND status = 'importing'
       RETURNING id`,
      [migrationRunId, JSON.stringify(details)],
    );
    if (!result.rows[0]) {
      throw new Error("Phase 2 migration run was not importing at identity checkpoint completion");
    }
  }
}
