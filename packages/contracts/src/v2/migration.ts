import { z } from "zod";
import {
  V2Actor,
  V2ActorType,
  V2EntityId,
  V2IsoDateTime,
  V2NonEmptyString,
  V2Sha256Hex,
} from "./common.js";

const schemaVersion = z.literal(2);
const nullableDate = V2IsoDateTime.nullable();

export const V2MigrationRunStatus = z.enum([
  "capturing",
  "archived",
  "importing",
  "reconciling",
  "shadowing",
  "ready",
  "cutover",
  "rolled_back",
  "failed",
]);
export type V2MigrationRunStatusT = z.infer<typeof V2MigrationRunStatus>;

export const V2MigrationRun = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    migration_name: V2NonEmptyString,
    source_snapshot_hashes: z.record(V2Sha256Hex),
    source_counts: z.record(z.record(z.number().int().nonnegative())),
    source_frozen_at: nullableDate,
    source_manifest_hash: V2Sha256Hex.nullable(),
    source_application_version: V2NonEmptyString.nullable(),
    source_application_commit: V2NonEmptyString.nullable(),
    recovery_marker: z.record(z.unknown()),
    last_source_records: z.record(z.record(z.unknown()).nullable()),
    status: V2MigrationRunStatus,
    started_at: V2IsoDateTime,
    completed_at: nullableDate,
    rollback_window_until: nullableDate,
    v2_writes_started_at: nullableDate,
    error_code: z.string().trim().min(1).nullable(),
    error_summary: z.string().trim().min(1).nullable(),
    details: z.record(z.unknown()),
  })
  .strict();
export type V2MigrationRunT = z.infer<typeof V2MigrationRun>;

export const V2LegacySnapshotDescriptor = z
  .object({
    key: V2NonEmptyString,
    exact_text_hash: V2Sha256Hex,
    semantic_hash: V2Sha256Hex,
    updated_at: V2IsoDateTime,
    exact_byte_size: z.number().int().nonnegative(),
    object_counts: z.record(z.number().int().nonnegative()),
    last_record: z.record(z.unknown()).nullable(),
  })
  .strict();
export type V2LegacySnapshotDescriptorT = z.infer<typeof V2LegacySnapshotDescriptor>;

export const V2RecoveryMarker = z
  .object({
    provider: V2NonEmptyString,
    backup_reference: V2NonEmptyString,
    database_time: V2IsoDateTime,
    wal_lsn: V2NonEmptyString,
    transaction_id: V2NonEmptyString,
    application_version: V2NonEmptyString,
    application_commit: V2NonEmptyString,
  })
  .strict();
export type V2RecoveryMarkerT = z.infer<typeof V2RecoveryMarker>;

export const V2LegacySnapshotManifest = z
  .object({
    schema_version: schemaVersion,
    migration_run_id: V2EntityId,
    migration_name: V2NonEmptyString,
    source_frozen_at: V2IsoDateTime,
    manifest_hash: V2Sha256Hex,
    recovery_marker: V2RecoveryMarker,
    snapshots: z.array(V2LegacySnapshotDescriptor).min(1),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const keys = manifest.snapshots.map((snapshot) => snapshot.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snapshots"],
        message: "a recovery manifest cannot contain duplicate snapshot keys",
      });
    }
  });
export type V2LegacySnapshotManifestT = z.infer<typeof V2LegacySnapshotManifest>;

export const V2ArchiveStatus = z.enum(["sealed", "verified", "expired"]);
export const V2ArchiveCipher = z.enum(["aes-256-gcm"]);

export const V2LegacySnapshotArchive = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    migration_run_id: V2EntityId,
    source_key: V2NonEmptyString,
    source_updated_at: V2IsoDateTime,
    storage_ref: V2NonEmptyString,
    key_id: V2NonEmptyString,
    key_fingerprint: V2Sha256Hex,
    cipher: V2ArchiveCipher,
    exact_hash: V2Sha256Hex,
    canonical_hash: V2Sha256Hex,
    ciphertext_hash: V2Sha256Hex,
    aad_hash: V2Sha256Hex,
    manifest_hash: V2Sha256Hex,
    exact_byte_size: z.number().int().nonnegative(),
    canonical_byte_size: z.number().int().nonnegative(),
    object_counts: z.record(z.number().int().nonnegative()),
    last_record: z.record(z.unknown()).nullable(),
    nonce_b64: V2NonEmptyString,
    auth_tag_b64: V2NonEmptyString,
    ciphertext_b64: V2NonEmptyString,
    status: V2ArchiveStatus,
    captured_at: V2IsoDateTime,
    retention_until: V2IsoDateTime,
    verified_at: nullableDate,
  })
  .strict()
  .superRefine((archive, ctx) => {
    if (Date.parse(archive.retention_until) <= Date.parse(archive.captured_at)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retention_until"],
        message: "archive retention must extend beyond capture time",
      });
    }
    if (archive.status === "verified" && archive.verified_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verified_at"],
        message: "a verified archive requires a verification time",
      });
    }
  });
export type V2LegacySnapshotArchiveT = z.infer<typeof V2LegacySnapshotArchive>;

export const V2ArchiveAccessOperation = z.enum(["write", "head", "read", "verify"]);
export const V2ArchiveAccessOutcome = z.enum(["allowed", "denied", "failed"]);

export const V2ArchiveAccessEvent = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    archive_id: V2EntityId,
    actor: V2Actor,
    operation: V2ArchiveAccessOperation,
    outcome: V2ArchiveAccessOutcome,
    correlation_id: V2EntityId,
    occurred_at: V2IsoDateTime,
    details: z.record(z.unknown()),
    redaction_applied: z.boolean(),
  })
  .strict();
export type V2ArchiveAccessEventT = z.infer<typeof V2ArchiveAccessEvent>;

export const V2MigrationStepStatus = z.enum(["pending", "running", "succeeded", "failed"]);

export const V2MigrationStep = z
  .object({
    schema_version: schemaVersion,
    migration_run_id: V2EntityId,
    step_key: V2NonEmptyString,
    input_hash: V2Sha256Hex,
    status: V2MigrationStepStatus,
    attempt: z.number().int().positive(),
    output_hash: V2Sha256Hex.nullable(),
    output_counts: z.record(z.number().int().nonnegative()),
    error_code: z.string().trim().min(1).nullable(),
    error_summary: z.string().trim().min(1).nullable(),
    started_at: nullableDate,
    completed_at: nullableDate,
  })
  .strict()
  .superRefine((step, ctx) => {
    if (step.status === "running" && step.started_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["started_at"],
        message: "a running migration step requires a start time",
      });
    }
    if (step.status === "succeeded" && (step.completed_at === null || step.output_hash === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completed_at"],
        message: "a succeeded migration step requires completion time and output hash",
      });
    }
    if (step.status === "failed" && (step.completed_at === null || step.error_code === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error_code"],
        message: "a failed migration step requires completion time and error code",
      });
    }
  });
export type V2MigrationStepT = z.infer<typeof V2MigrationStep>;

export const V2LegacyProjectImportProvenance = z
  .object({
    schema_version: schemaVersion,
    migration_run_id: V2EntityId,
    project_id: V2EntityId,
    source_hash: V2Sha256Hex,
    plan_hash: V2Sha256Hex.nullable(),
    graph_hash: V2Sha256Hex.nullable(),
    approval_hash: V2Sha256Hex.nullable(),
    graph_version: z.number().int().positive().nullable(),
    source_counts: z.record(z.number().int().nonnegative()),
    import_hash: V2Sha256Hex,
    archive_id: V2EntityId.nullable(),
    imported_at: V2IsoDateTime,
  })
  .strict();
export type V2LegacyProjectImportProvenanceT = z.infer<typeof V2LegacyProjectImportProvenance>;

export const V2MigrationFindingCode = z.enum([
  "invalid_plan_payload",
  "invalid_graph_payload",
  "invalid_approval_payload",
  "plan_without_graph",
  "graph_without_plan",
  "graph_node_without_plan_module",
  "plan_module_without_graph_node",
  "shared_task_field_mismatch",
  "acceptance_criteria_unavailable",
  "acceptance_criteria_projection_mismatch",
  "dependency_edge_added_in_graph",
  "dependency_edge_removed_from_graph",
  "orphan_dependency_reference",
  "assignment_missing",
  "assignment_projection_mismatch",
  "assignment_worker_count_requires_reconciliation",
  "assignment_changed_since_approval",
  "approval_graph_version_mismatch",
  "approval_content_hash_mismatch",
  "approval_actor_unattributable",
  "source_changed_after_freeze",
  "imported_count_mismatch",
  "imported_checksum_mismatch",
  "unknown_snapshot_key",
  "nonterminal_legacy_command",
]);
export type V2MigrationFindingCodeT = z.infer<typeof V2MigrationFindingCode>;

export const V2MigrationFindingSeverity = z.enum(["blocking", "warning", "informational"]);
export const V2MigrationFindingStatus = z.enum(["open", "resolved", "accepted"]);

export const V2MigrationReconciliationFinding = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    migration_run_id: V2EntityId,
    project_id: V2EntityId.nullable(),
    code: V2MigrationFindingCode,
    severity: V2MigrationFindingSeverity,
    status: V2MigrationFindingStatus,
    source_entity_type: V2NonEmptyString,
    source_entity_id: V2NonEmptyString.nullable(),
    source_fingerprint: V2Sha256Hex,
    details: z.record(z.unknown()),
    detected_at: V2IsoDateTime,
    resolved_at: nullableDate,
    resolved_by_actor_id: V2EntityId.nullable(),
    disposition_note: z.string().trim().min(1).nullable(),
  })
  .strict()
  .superRefine((finding, ctx) => {
    const dispositionFields = [
      finding.resolved_at,
      finding.resolved_by_actor_id,
      finding.disposition_note,
    ];
    const populated = dispositionFields.filter((value) => value !== null).length;
    if (
      (finding.status === "open" && populated !== 0) ||
      (finding.status !== "open" && populated !== dispositionFields.length)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message:
          "open findings cannot carry a disposition; closed findings require human attribution",
      });
    }
  });
export type V2MigrationReconciliationFindingT = z.infer<typeof V2MigrationReconciliationFinding>;

export const V2PersistenceScopeType = z.enum(["identity", "project", "new_projects", "relay"]);
export type V2PersistenceScopeTypeT = z.infer<typeof V2PersistenceScopeType>;
export const V2PersistenceReadMode = z.enum(["legacy", "shadow", "relational"]);
export const V2PersistenceWriteMode = z.enum(["legacy", "frozen", "relational"]);

export const V2PersistenceRoute = z
  .object({
    schema_version: schemaVersion,
    scope_type: V2PersistenceScopeType,
    scope_key: V2NonEmptyString,
    read_mode: V2PersistenceReadMode,
    write_mode: V2PersistenceWriteMode,
    migration_run_id: V2EntityId.nullable(),
    aggregate_version: z.number().int().positive(),
    changed_by: V2Actor,
    changed_at: V2IsoDateTime,
    v2_writes_started_at: nullableDate,
    rollback_window_until: nullableDate,
  })
  .strict()
  .superRefine((route, ctx) => {
    if (route.scope_type === "project" && route.scope_key === "*") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope_key"],
        message: "a project persistence route requires a project ID",
      });
    }
    if (route.scope_type !== "project" && route.scope_key !== "*") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope_key"],
        message: "global persistence routes use the '*' scope key",
      });
    }
    if (route.write_mode === "relational" && route.v2_writes_started_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["v2_writes_started_at"],
        message: "a relational write route must record when V2 writes began",
      });
    }
  });
export type V2PersistenceRouteT = z.infer<typeof V2PersistenceRoute>;

export const V2ShadowReadComparison = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    migration_run_id: V2EntityId,
    scope_type: V2PersistenceScopeType,
    scope_key: V2NonEmptyString,
    operation: V2NonEmptyString,
    legacy_hash: V2Sha256Hex,
    relational_hash: V2Sha256Hex,
    matched: z.boolean(),
    differences: z.array(V2NonEmptyString),
    observed_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((comparison, ctx) => {
    if (comparison.matched && comparison.differences.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["differences"],
        message: "a matched shadow comparison cannot contain differences",
      });
    }
    if (!comparison.matched && comparison.differences.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["differences"],
        message: "a mismatched shadow comparison requires redacted differences",
      });
    }
  });
export type V2ShadowReadComparisonT = z.infer<typeof V2ShadowReadComparison>;

export const V2ProjectPlanningPreference = z
  .object({
    schema_version: schemaVersion,
    project_id: V2EntityId,
    pm_provider: z.enum(["anthropic", "openai"]),
    pm_model: V2NonEmptyString.nullable(),
    reviewer_provider: z.enum(["anthropic", "openai"]),
    source: z.enum(["native", "legacy_snapshot"]),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .refine((preference) => preference.pm_provider !== preference.reviewer_provider, {
    message: "PM and reviewer providers must remain cross-provider",
    path: ["reviewer_provider"],
  });
export type V2ProjectPlanningPreferenceT = z.infer<typeof V2ProjectPlanningPreference>;

export const V2RepositoryBindingCandidate = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    source_type: z.enum(["local", "github"]),
    source_fingerprint: V2Sha256Hex,
    display_name: V2NonEmptyString,
    github_owner: V2NonEmptyString.nullable(),
    github_name: V2NonEmptyString.nullable(),
    status: z.enum(["unverified", "promoted", "dismissed"]),
    archive_id: V2EntityId.nullable(),
    source_record_id: V2NonEmptyString.nullable(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict();
export type V2RepositoryBindingCandidateT = z.infer<typeof V2RepositoryBindingCandidate>;

export const V2HistoricalApprovalActor = z.discriminatedUnion("actor_type", [
  z
    .object({
      actor_type: z.literal("legacy"),
      actor_id: z.null(),
      source_actor_text: V2NonEmptyString,
    })
    .strict(),
  z
    .object({
      actor_type: z.literal("human"),
      actor_id: V2EntityId,
      source_actor_text: z.string().trim().min(1).nullable(),
    })
    .strict(),
]);

export const V2HistoricalApprovalEvidence = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    migration_run_id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId.nullable(),
    subject_entity_type: V2NonEmptyString,
    subject_entity_id: V2EntityId,
    content_hash: V2Sha256Hex,
    graph_version: z.number().int().positive(),
    allocation_fingerprint: V2Sha256Hex,
    actor: V2HistoricalApprovalActor,
    approved_at: V2IsoDateTime,
    current_at_import: z.boolean(),
    source_hash: V2Sha256Hex,
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2HistoricalApprovalEvidenceT = z.infer<typeof V2HistoricalApprovalEvidence>;

export const V2LegacyActorEvidence = z
  .object({
    actor_type: z.literal(V2ActorType.enum.legacy),
    actor_id: z.null(),
    actor_text: V2NonEmptyString,
  })
  .strict();
export type V2LegacyActorEvidenceT = z.infer<typeof V2LegacyActorEvidence>;
