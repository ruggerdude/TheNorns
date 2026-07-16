import { createHash } from "node:crypto";
import type { V2SqlExecutor, V2TransactionRunner } from "../v2/database.js";
import { LegacyArchiveCryptoError, decryptLegacyArchive } from "./archiveCrypto.js";
import type { LegacySnapshotArchiveRecord } from "./archiveRepository.js";
import { canonicalJson, canonicalSha256 } from "./canonicalJson.js";
import {
  LegacyProjectStoreSnapshot,
  type LegacyProjectStoreSnapshotT,
} from "./legacyProjectSchemas.js";
import {
  Phase2IdentityCheckpointCoordinator,
  type Phase2IdentityCheckpointResult,
  Phase2SourceChangedError,
  type RunPhase2IdentityCheckpointInput,
} from "./phase2Coordinator.js";
import { type LegacyProjectImportPlan, buildLegacyProjectImportPlan } from "./projectImportPlan.js";
import {
  type ImportLegacyProjectOptions,
  type LegacyProjectImportResult,
  type LegacyProjectImportStep,
  importLegacyProject,
} from "./projectImportService.js";
import type { LegacyProjectReconciliationFinding } from "./projectReconciliation.js";
import { SqlLegacyArchiveRepository } from "./sqlArchiveRepository.js";

const PROJECT_ARCHIVE_SOURCE_KEY = "projects";
const PROJECT_STEP_PREFIX = "project_import:";

export class Phase2ProjectArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase2ProjectArchiveError";
  }
}

export class Phase2ProjectAccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase2ProjectAccountingError";
  }
}

export class Phase2ProjectStepSourceChangedError extends Error {
  constructor(readonly projectId: string) {
    super(`Phase 2 project step source changed after freeze: ${projectId}`);
    this.name = "Phase2ProjectStepSourceChangedError";
  }
}

export interface RunPhase2MigrationInput extends RunPhase2IdentityCheckpointInput {
  /**
   * Transaction-local observability/fault-injection seam. A thrown error
   * rolls back only the current project import; the top-level service records
   * that project's failed step before returning the error.
   */
  after_project_step?:
    | ((
        projectId: string,
        step: LegacyProjectImportStep,
        tx: V2SqlExecutor,
      ) => void | Promise<void>)
    | undefined;
}

export interface Phase2AccountedFinding extends LegacyProjectReconciliationFinding {
  project_id: string;
}

export interface Phase2MigrationResult {
  migration_run_id: string;
  source_bundle_hash: string;
  projects_archive: {
    archive_id: string;
    exact_hash: string;
    semantic_hash: string;
  };
  status: "shadowing";
  identity: Phase2IdentityCheckpointResult;
  counts: {
    source_projects: number;
    accounted_projects: number;
    imported_projects: number;
    replayed_projects: number;
    tasks: number;
    dependencies: number;
    assignments: number;
    findings: number;
    blocking_findings: number;
    warning_findings: number;
  };
  findings: Phase2AccountedFinding[];
  projects: LegacyProjectImportResult[];
}

interface ProjectArchiveRunRow {
  source_manifest_hash: string | null;
  source_frozen_at: string | Date;
  source_snapshot_hashes: Record<string, unknown>;
  source_counts: Record<string, unknown>;
  status: string;
  details: Record<string, unknown>;
  requested_at: string | Date;
}

interface LoadedProjectArchive {
  record: LegacySnapshotArchiveRecord;
  expected_exact_hash: string;
  expected_semantic_hash: string;
  expected_project_count: number;
}

interface StoredProjectStepRow {
  input_hash: string;
  status: "pending" | "running" | "succeeded" | "failed";
  output_hash: string | null;
  output_counts: Record<string, unknown>;
}

interface ImportedProjectLedgerRow {
  project_id: string;
  source_hash: string;
  import_hash: string;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredHash(value: unknown, description: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Phase2ProjectArchiveError(`${description} is missing or malformed`);
  }
  return value;
}

function exactTextHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function identityCounts(value: unknown): Phase2IdentityCheckpointResult["counts"] {
  const counts = object(value);
  return {
    users: Number(counts.users ?? 0),
    sessions: Number(counts.sessions ?? 0),
    invitations: Number(counts.invitations ?? 0),
    active_admins: Number(counts.active_admins ?? 0),
  };
}

function projectStepKey(projectId: string): string {
  return `${PROJECT_STEP_PREFIX}${encodeURIComponent(projectId)}`;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && error.name.trim().length > 0) return error.name.slice(0, 120);
  return "project_import_failed";
}

function safeErrorSummary(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function assertUniqueProjectIds(snapshot: LegacyProjectStoreSnapshotT): void {
  const seen = new Set<string>();
  for (const project of snapshot.projects) {
    if (seen.has(project.id)) {
      throw new Phase2ProjectAccountingError(
        `legacy projects archive contains duplicate project id ${project.id}`,
      );
    }
    seen.add(project.id);
  }
}

async function replayShadowingIdentity(
  transactions: V2TransactionRunner,
  migrationRunId: string,
): Promise<Phase2IdentityCheckpointResult | null> {
  return transactions.transaction(async (sql) => {
    const run = await sql.query<{
      status: string;
      source_manifest_hash: string | null;
    }>("SELECT status, source_manifest_hash FROM migration_runs WHERE id = $1", [migrationRunId]);
    const row = run.rows[0];
    if (!row || row.status !== "shadowing") return null;
    const sourceBundleHash = requiredHash(
      row.source_manifest_hash,
      "shadowing migration source manifest hash",
    );
    const step = await sql.query<{
      input_hash: string;
      status: string;
      output_counts: Record<string, unknown>;
    }>(
      `SELECT input_hash, status, output_counts
       FROM migration_steps
       WHERE migration_run_id = $1 AND step_key = 'identity_import'`,
      [migrationRunId],
    );
    const identityStep = step.rows[0];
    if (
      !identityStep ||
      identityStep.status !== "succeeded" ||
      identityStep.input_hash !== sourceBundleHash
    ) {
      throw new Phase2ProjectAccountingError(
        "shadowing migration has no matching completed identity step",
      );
    }
    return {
      migration_run_id: migrationRunId,
      source_bundle_hash: sourceBundleHash,
      replayed: true,
      counts: identityCounts(identityStep.output_counts),
    };
  });
}

async function loadProjectArchive(
  transactions: V2TransactionRunner,
  migrationRunId: string,
  sourceBundleHash: string,
): Promise<LoadedProjectArchive> {
  return transactions.transaction(async (sql) => {
    const runResult = await sql.query<ProjectArchiveRunRow>(
      `SELECT source_manifest_hash, source_frozen_at,
              source_snapshot_hashes, source_counts, status, details,
              transaction_timestamp() AS requested_at
       FROM migration_runs
       WHERE id = $1`,
      [migrationRunId],
    );
    const run = runResult.rows[0];
    if (!run) throw new Phase2ProjectArchiveError("Phase 2 migration run disappeared");
    if (run.status !== "importing" && run.status !== "shadowing") {
      throw new Phase2ProjectArchiveError(
        `Phase 2 projects archive can only be opened while importing or shadowing, not ${run.status}`,
      );
    }
    if (run.source_manifest_hash !== sourceBundleHash) {
      throw new Phase2ProjectArchiveError(
        "Phase 2 identity result does not match the persisted source manifest",
      );
    }

    const archiveId = `legacy_archive:${migrationRunId}:${PROJECT_ARCHIVE_SOURCE_KEY}`;
    const correlationId = `phase2-project-import:${migrationRunId}`;
    const priorAccesses = await sql.query<{ count: number | string }>(
      `SELECT count(*)::int AS count
       FROM legacy_archive_access_events
       WHERE archive_id = $1 AND correlation_id = $2 AND operation = 'read'`,
      [archiveId, correlationId],
    );
    const accessOrdinal = Number(priorAccesses.rows[0]?.count ?? 0) + 1;
    const opened = await new SqlLegacyArchiveRepository(sql).findCiphertext(archiveId, {
      access_id: `archive_access:phase2-project-import:${migrationRunId}:${accessOrdinal}`,
      archive_id: archiveId,
      actor_type: "system",
      actor_id: null,
      session_id: null,
      purpose: "migration_reconciliation",
      correlation_id: correlationId,
      requested_at: iso(run.requested_at),
    });
    if (!opened.record) {
      throw new Phase2ProjectArchiveError("required projects archive was not found");
    }

    const exactHashes = object(run.details.source_exact_text_hashes);
    const semanticHashes = object(run.details.source_semantic_hashes);
    const expectedExactHash = requiredHash(exactHashes.projects, "projects exact source hash");
    const expectedSemanticHash = requiredHash(
      run.source_snapshot_hashes.projects,
      "projects semantic source hash",
    );
    const detailedSemanticHash = requiredHash(
      semanticHashes.projects,
      "projects detailed semantic source hash",
    );
    if (detailedSemanticHash !== expectedSemanticHash) {
      throw new Phase2ProjectArchiveError(
        "projects semantic source hashes disagree inside the recovery checkpoint",
      );
    }
    const expectedProjectCount = Number(object(run.source_counts.projects).projects);
    if (!Number.isSafeInteger(expectedProjectCount) || expectedProjectCount < 0) {
      throw new Phase2ProjectArchiveError("projects source count is missing or malformed");
    }
    if (recordCount(opened.record.object_counts.projects) !== expectedProjectCount) {
      throw new Phase2ProjectArchiveError(
        "projects archive count does not match the recovery checkpoint",
      );
    }

    return {
      record: opened.record,
      expected_exact_hash: expectedExactHash,
      expected_semantic_hash: expectedSemanticHash,
      expected_project_count: expectedProjectCount,
    };
  });
}

function recordCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Phase2ProjectArchiveError("projects archive count is missing or malformed");
  }
  return count;
}

function verificationFailureCode(error: unknown): string {
  if (error instanceof LegacyArchiveCryptoError) return "archive_crypto_verification_failed";
  if (error instanceof Phase2ProjectArchiveError) return "archive_hash_verification_failed";
  return "archive_payload_verification_failed";
}

async function recordProjectArchiveVerification(
  transactions: V2TransactionRunner,
  migrationRunId: string,
  outcome: "allowed" | "failed",
  reasonCode: string | null,
): Promise<void> {
  await transactions.transaction(async (sql) => {
    const archiveId = `legacy_archive:${migrationRunId}:${PROJECT_ARCHIVE_SOURCE_KEY}`;
    const archive = await sql.query<{ id: string }>(
      "SELECT id FROM legacy_snapshot_archives WHERE id = $1",
      [archiveId],
    );
    if (!archive.rows[0]) return;
    const correlationId = `phase2-project-import:${migrationRunId}`;
    const prior = await sql.query<{ count: number | string }>(
      `SELECT count(*)::int AS count
       FROM legacy_archive_access_events
       WHERE archive_id = $1 AND correlation_id = $2 AND operation = 'verify'`,
      [archiveId, correlationId],
    );
    const clock = await sql.query<{ occurred_at: string | Date }>(
      "SELECT transaction_timestamp() AS occurred_at",
    );
    const occurred = clock.rows[0]?.occurred_at;
    if (!occurred) throw new Error("database did not return an archive verification time");
    const occurredAt = iso(occurred);
    await new SqlLegacyArchiveRepository(sql).recordVerification({
      intent: {
        access_id: `archive_access:phase2-project-verify:${migrationRunId}:${
          Number(prior.rows[0]?.count ?? 0) + 1
        }`,
        archive_id: archiveId,
        actor_type: "system",
        actor_id: null,
        session_id: null,
        purpose: "migration_reconciliation",
        correlation_id: correlationId,
        requested_at: occurredAt,
      },
      outcome,
      completed_at: occurredAt,
      reason_code: reasonCode,
    });
  });
}

function decryptAndValidateProjectArchive(
  loaded: LoadedProjectArchive,
  input: RunPhase2MigrationInput,
  migrationRunId: string,
  sourceBundleHash: string,
): LegacyProjectStoreSnapshotT {
  const { record } = loaded;
  if (
    record.archive_id !== `legacy_archive:${migrationRunId}:${PROJECT_ARCHIVE_SOURCE_KEY}` ||
    record.migration_run_id !== migrationRunId ||
    record.source_key !== PROJECT_ARCHIVE_SOURCE_KEY
  ) {
    throw new Phase2ProjectArchiveError("projects archive identity does not match the migration");
  }
  if (record.manifest_hash !== sourceBundleHash) {
    throw new Phase2ProjectArchiveError("projects archive belongs to a different source manifest");
  }
  if (
    record.exact_text_sha256 !== loaded.expected_exact_hash ||
    record.semantic_sha256 !== loaded.expected_semantic_hash
  ) {
    throw new Phase2ProjectArchiveError(
      "projects archive hashes do not match the recovery checkpoint",
    );
  }

  const plaintext = decryptLegacyArchive(record.encrypted, input.archive_key, {
    archive_id: record.archive_id,
    migration_run_id: record.migration_run_id,
    source_key: record.source_key,
    exact_text_sha256: record.exact_text_sha256,
    semantic_sha256: record.semantic_sha256,
    source_frozen_at: record.source_frozen_at,
  });
  const sourceText = plaintext.toString("utf8");
  if (
    exactTextHash(sourceText) !== record.exact_text_sha256 ||
    Buffer.byteLength(sourceText, "utf8") !== record.source_text_byte_length
  ) {
    throw new Phase2ProjectArchiveError("projects archive exact-text checksum does not match");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    throw new Phase2ProjectArchiveError("projects archive plaintext is not valid JSON");
  }
  if (
    canonicalSha256(parsed) !== record.semantic_sha256 ||
    Buffer.byteLength(canonicalJson(parsed), "utf8") !== record.semantic_canonical_byte_length
  ) {
    throw new Phase2ProjectArchiveError("projects archive semantic checksum does not match");
  }

  const snapshot = LegacyProjectStoreSnapshot.parse(parsed);
  assertUniqueProjectIds(snapshot);
  if (snapshot.projects.length !== loaded.expected_project_count) {
    throw new Phase2ProjectArchiveError(
      "projects archive parsed count does not match the recovery checkpoint",
    );
  }
  return snapshot;
}

async function beginProjectStep(
  transactions: V2TransactionRunner,
  migrationRunId: string,
  projectId: string,
  inputHash: string,
  outputHash: string,
): Promise<void> {
  await transactions.transaction(async (sql) => {
    const stepKey = projectStepKey(projectId);
    const current = await sql.query<StoredProjectStepRow>(
      `SELECT input_hash, status, output_hash, output_counts
       FROM migration_steps
       WHERE migration_run_id = $1 AND step_key = $2
       FOR UPDATE`,
      [migrationRunId, stepKey],
    );
    const row = current.rows[0];
    if (!row) {
      await sql.query(
        `INSERT INTO migration_steps (
           migration_run_id, step_key, input_hash, status, attempt,
           output_counts, started_at, updated_at
         ) VALUES ($1,$2,$3,'running',1,'{}'::jsonb,
                   transaction_timestamp(),transaction_timestamp())`,
        [migrationRunId, stepKey, inputHash],
      );
      return;
    }
    if (row.input_hash !== inputHash) {
      throw new Phase2ProjectStepSourceChangedError(projectId);
    }
    if (row.status === "succeeded") {
      if (row.output_hash !== outputHash) {
        throw new Phase2ProjectAccountingError(
          `completed Phase 2 project step output changed: ${projectId}`,
        );
      }
      return;
    }
    await sql.query(
      `UPDATE migration_steps
       SET status = 'running', attempt = attempt + 1,
           output_hash = NULL, output_counts = '{}'::jsonb,
           error_code = NULL, error_summary = NULL,
           started_at = transaction_timestamp(), completed_at = NULL,
           updated_at = transaction_timestamp()
       WHERE migration_run_id = $1 AND step_key = $2`,
      [migrationRunId, stepKey],
    );
  });
}

async function completeProjectStep(
  transactions: V2TransactionRunner,
  result: LegacyProjectImportResult,
): Promise<void> {
  await transactions.transaction(async (sql) => {
    const stepKey = projectStepKey(result.project_id);
    const current = await sql.query<StoredProjectStepRow>(
      `SELECT input_hash, status, output_hash, output_counts
       FROM migration_steps
       WHERE migration_run_id = $1 AND step_key = $2
       FOR UPDATE`,
      [result.migration_run_id, stepKey],
    );
    const row = current.rows[0];
    if (!row || row.input_hash !== result.source_hash) {
      throw new Phase2ProjectAccountingError(
        `Phase 2 project step disappeared before completion: ${result.project_id}`,
      );
    }
    if (row.status === "succeeded") {
      if (
        row.output_hash !== result.import_hash ||
        canonicalSha256(row.output_counts) !== canonicalSha256(result.counts)
      ) {
        throw new Phase2ProjectAccountingError(
          `completed Phase 2 project step evidence changed: ${result.project_id}`,
        );
      }
      return;
    }
    const updated = await sql.query<{ step_key: string }>(
      `UPDATE migration_steps
       SET status = 'succeeded', output_hash = $3,
           output_counts = $4::jsonb, error_code = NULL, error_summary = NULL,
           completed_at = transaction_timestamp(), updated_at = transaction_timestamp()
       WHERE migration_run_id = $1 AND step_key = $2 AND input_hash = $5
       RETURNING step_key`,
      [
        result.migration_run_id,
        stepKey,
        result.import_hash,
        JSON.stringify(result.counts),
        result.source_hash,
      ],
    );
    if (!updated.rows[0]) {
      throw new Phase2ProjectAccountingError(
        `Phase 2 project step disappeared before completion: ${result.project_id}`,
      );
    }
  });
}

async function failProjectStep(
  transactions: V2TransactionRunner,
  migrationRunId: string,
  projectId: string,
  error: unknown,
): Promise<void> {
  await transactions.transaction(async (sql) => {
    await sql.query(
      `UPDATE migration_steps
       SET status = 'failed', error_code = $3, error_summary = $4,
           completed_at = transaction_timestamp(), updated_at = transaction_timestamp()
       WHERE migration_run_id = $1 AND step_key = $2 AND status <> 'succeeded'`,
      [migrationRunId, projectStepKey(projectId), safeErrorCode(error), safeErrorSummary(error)],
    );
  });
}

function aggregateResult(
  identity: Phase2IdentityCheckpointResult,
  archive: LegacySnapshotArchiveRecord,
  plans: readonly LegacyProjectImportPlan[],
  projects: LegacyProjectImportResult[],
): Omit<Phase2MigrationResult, "status"> {
  const findings = plans.flatMap((plan) =>
    plan.findings.map((finding) => ({ ...finding, project_id: plan.project.id })),
  );
  const counts = {
    source_projects: plans.length,
    accounted_projects: projects.length,
    imported_projects: projects.filter((project) => project.status === "imported").length,
    replayed_projects: projects.filter((project) => project.status === "replayed").length,
    tasks: projects.reduce((total, project) => total + project.counts.tasks, 0),
    dependencies: projects.reduce((total, project) => total + project.counts.dependencies, 0),
    assignments: projects.reduce((total, project) => total + project.counts.assignments, 0),
    findings: findings.length,
    blocking_findings: findings.filter((finding) => finding.severity === "blocking").length,
    warning_findings: findings.filter((finding) => finding.severity === "warning").length,
  };
  return {
    migration_run_id: identity.migration_run_id,
    source_bundle_hash: identity.source_bundle_hash,
    projects_archive: {
      archive_id: archive.archive_id,
      exact_hash: archive.exact_text_sha256,
      semantic_hash: archive.semantic_sha256,
    },
    identity,
    counts,
    findings,
    projects,
  };
}

async function verifyAccountingAndEnterShadowing(
  transactions: V2TransactionRunner,
  result: Omit<Phase2MigrationResult, "status">,
): Promise<void> {
  await transactions.transaction(async (sql) => {
    const runResult = await sql.query<{ status: string; details: Record<string, unknown> }>(
      "SELECT status, details FROM migration_runs WHERE id = $1 FOR UPDATE",
      [result.migration_run_id],
    );
    const run = runResult.rows[0];
    if (!run || (run.status !== "importing" && run.status !== "shadowing")) {
      throw new Phase2ProjectAccountingError(
        `Phase 2 run cannot enter shadowing from ${run?.status ?? "missing"}`,
      );
    }

    const ledger = await sql.query<ImportedProjectLedgerRow>(
      `SELECT project_id, source_hash, import_hash
       FROM legacy_project_imports
       WHERE migration_run_id = $1
       ORDER BY project_id`,
      [result.migration_run_id],
    );
    const expected = [...result.projects].sort((left, right) =>
      left.project_id.localeCompare(right.project_id),
    );
    if (ledger.rows.length !== expected.length) {
      throw new Phase2ProjectAccountingError(
        "not every source project has exactly one import ledger row",
      );
    }
    for (let index = 0; index < expected.length; index += 1) {
      const actual = ledger.rows[index];
      const wanted = expected[index];
      if (
        !actual ||
        !wanted ||
        actual.project_id !== wanted.project_id ||
        actual.source_hash !== wanted.source_hash ||
        actual.import_hash !== wanted.import_hash
      ) {
        throw new Phase2ProjectAccountingError(
          "project import ledger does not exactly match the frozen projects archive",
        );
      }
    }

    const steps = await sql.query<{
      step_key: string;
      input_hash: string;
      output_hash: string | null;
      status: string;
    }>(
      `SELECT step_key, input_hash, output_hash, status
       FROM migration_steps
       WHERE migration_run_id = $1 AND step_key LIKE 'project_import:%'
       ORDER BY step_key`,
      [result.migration_run_id],
    );
    const stepByKey = new Map(steps.rows.map((step) => [step.step_key, step]));
    for (const project of expected) {
      const step = stepByKey.get(projectStepKey(project.project_id));
      if (
        !step ||
        step.status !== "succeeded" ||
        step.input_hash !== project.source_hash ||
        step.output_hash !== project.import_hash
      ) {
        throw new Phase2ProjectAccountingError(
          `project import step is not accounted: ${project.project_id}`,
        );
      }
    }
    if (stepByKey.size !== expected.length) {
      throw new Phase2ProjectAccountingError(
        "project import steps include a project absent from the frozen archive",
      );
    }

    const stableCounts = {
      source_projects: result.counts.source_projects,
      accounted_projects: result.counts.accounted_projects,
      tasks: result.counts.tasks,
      dependencies: result.counts.dependencies,
      assignments: result.counts.assignments,
      findings: result.counts.findings,
      blocking_findings: result.counts.blocking_findings,
      warning_findings: result.counts.warning_findings,
    };
    const summaryHash = canonicalSha256({
      projects_archive_semantic_hash: result.projects_archive.semantic_hash,
      projects: expected.map((project) => ({
        project_id: project.project_id,
        source_hash: project.source_hash,
        import_hash: project.import_hash,
      })),
      counts: stableCounts,
    });
    if (run.status === "importing") {
      const advanced = await sql.query<{ id: string }>(
        `UPDATE migration_runs
         SET status = 'shadowing',
             details = details || $2::jsonb
         WHERE id = $1 AND status = 'importing'
         RETURNING id`,
        [
          result.migration_run_id,
          JSON.stringify({
            project_import_summary: {
              projects_archive_id: result.projects_archive.archive_id,
              projects_archive_exact_hash: result.projects_archive.exact_hash,
              projects_archive_semantic_hash: result.projects_archive.semantic_hash,
              accounted_project_ids: expected.map((project) => project.project_id),
              counts: stableCounts,
              output_hash: summaryHash,
            },
          }),
        ],
      );
      if (!advanced.rows[0]) {
        throw new Phase2ProjectAccountingError("Phase 2 run did not enter shadowing");
      }
    } else {
      const storedSummary = object(run.details.project_import_summary);
      if (storedSummary.output_hash !== summaryHash) {
        throw new Phase2ProjectAccountingError(
          "shadowing project import summary no longer matches the frozen archive",
        );
      }
    }
  });
}

function durableFailureCode(
  error: unknown,
): "source_changed_after_freeze" | "imported_count_mismatch" | "imported_checksum_mismatch" | null {
  if (
    error instanceof Phase2SourceChangedError ||
    error instanceof Phase2ProjectStepSourceChangedError
  ) {
    return "source_changed_after_freeze";
  }
  if (error instanceof Phase2ProjectAccountingError) {
    return /count|exactly one|absent from/i.test(error.message)
      ? "imported_count_mismatch"
      : "imported_checksum_mismatch";
  }
  return null;
}

async function recordDurableMigrationFailure(
  transactions: V2TransactionRunner,
  migrationRunId: string,
  error: unknown,
): Promise<void> {
  const code = durableFailureCode(error);
  if (!code) return;
  await transactions.transaction(async (sql) => {
    const run = await sql.query<{
      source_manifest_hash: string | null;
      status: string;
    }>(
      `SELECT source_manifest_hash, status
       FROM migration_runs
       WHERE id = $1
       FOR UPDATE`,
      [migrationRunId],
    );
    const stored = run.rows[0];
    if (!stored || stored.source_manifest_hash === null) return;
    const projectId = error instanceof Phase2ProjectStepSourceChangedError ? error.projectId : null;
    const findingId = `migration_finding:${canonicalSha256({
      migration_run_id: migrationRunId,
      project_id: projectId,
      code,
      source_fingerprint: stored.source_manifest_hash,
    })}`;
    await sql.query(
      `INSERT INTO migration_reconciliation_findings (
         id, migration_run_id, project_id, code, severity, status,
         source_entity_type, source_entity_id, source_fingerprint,
         details, detected_at
       ) VALUES (
         $1,$2,$3,$4,'blocking','open',
         'migration_run',$5,$6,$7::jsonb,transaction_timestamp()
       ) ON CONFLICT (id) DO NOTHING`,
      [
        findingId,
        migrationRunId,
        projectId,
        code,
        projectId ?? migrationRunId,
        stored.source_manifest_hash,
        JSON.stringify({
          error_type: error instanceof Error ? error.name : "Phase2MigrationError",
          summary: safeErrorSummary(error),
        }),
      ],
    );
    await sql.query(
      `UPDATE migration_runs
       SET status = 'failed',
           completed_at = transaction_timestamp(),
           error_code = $2,
           error_summary = $3
       WHERE id = $1 AND status <> 'cutover'`,
      [migrationRunId, code, safeErrorSummary(error)],
    );
  });
}

/**
 * Resumable Phase 2 preservation orchestration. The supplied transaction
 * runner is expected to be the production Phase2MigrationProcessLease so the
 * application cannot restart between checkpointing and shadow-read handoff.
 * This service deliberately stops at `shadowing`; it cannot activate V2
 * writes, mark the run ready/cutover, delete legacy state, or import relay.
 */
export class Phase2MigrationService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  async run(input: RunPhase2MigrationInput): Promise<Phase2MigrationResult> {
    try {
      return await this.runPreservation(input);
    } catch (error) {
      await recordDurableMigrationFailure(this.transactions, input.migration_run_id, error).catch(
        () => undefined,
      );
      throw error;
    }
  }

  private async runPreservation(input: RunPhase2MigrationInput): Promise<Phase2MigrationResult> {
    const identity =
      (await replayShadowingIdentity(this.transactions, input.migration_run_id)) ??
      (await new Phase2IdentityCheckpointCoordinator(this.transactions).run(input));
    let loadedArchive: LoadedProjectArchive;
    let snapshot: LegacyProjectStoreSnapshotT;
    try {
      loadedArchive = await loadProjectArchive(
        this.transactions,
        identity.migration_run_id,
        identity.source_bundle_hash,
      );
      snapshot = decryptAndValidateProjectArchive(
        loadedArchive,
        input,
        identity.migration_run_id,
        identity.source_bundle_hash,
      );
      await recordProjectArchiveVerification(
        this.transactions,
        identity.migration_run_id,
        "allowed",
        null,
      );
    } catch (error) {
      try {
        await recordProjectArchiveVerification(
          this.transactions,
          identity.migration_run_id,
          "failed",
          verificationFailureCode(error),
        );
      } catch {
        // Preserve the archive failure as primary. A missing archive cannot
        // satisfy the access-event foreign key; every existing archive still
        // receives a redacted failed-verification event.
      }
      throw error;
    }
    const plans = [...snapshot.projects]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((project) =>
        buildLegacyProjectImportPlan(project, {
          source_frozen_at: loadedArchive.record.source_frozen_at,
        }),
      );

    const projects: LegacyProjectImportResult[] = [];
    for (const plan of plans) {
      const outputHash = canonicalSha256(plan);
      await beginProjectStep(
        this.transactions,
        identity.migration_run_id,
        plan.project.id,
        plan.source_hash,
        outputHash,
      );
      let imported: LegacyProjectImportResult;
      try {
        const options: ImportLegacyProjectOptions = {
          transaction_runner: this.transactions,
          migration_run_id: identity.migration_run_id,
          source_manifest_hash: identity.source_bundle_hash,
          occurred_at: loadedArchive.record.source_frozen_at,
          plan,
          ...(input.after_project_step === undefined
            ? {}
            : {
                after_step: (step: LegacyProjectImportStep, tx: V2SqlExecutor) =>
                  input.after_project_step?.(plan.project.id, step, tx),
              }),
        };
        imported = await importLegacyProject(options);
        await completeProjectStep(this.transactions, imported);
      } catch (error) {
        try {
          await failProjectStep(
            this.transactions,
            identity.migration_run_id,
            plan.project.id,
            error,
          );
        } catch {
          // Preserve the import failure as the primary cause. A remaining
          // running step is resumable and will have its attempt incremented.
        }
        throw error;
      }
      projects.push(imported);
    }

    const accounted = aggregateResult(identity, loadedArchive.record, plans, projects);
    await verifyAccountingAndEnterShadowing(this.transactions, accounted);
    return { ...accounted, status: "shadowing" };
  }
}
