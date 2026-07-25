import { z } from "zod";
import { V2Actor, V2EntityId, V2IsoDateTime, V2NonEmptyString, V2Sha256Hex } from "./common.js";

const schemaVersion = z.literal(2);
const semanticVersion = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
const stringList = z.array(V2NonEmptyString);

export const V2KnowledgePackageType = z.enum([
  "project",
  "architecture",
  "domain",
  "quality",
  "phase",
  "current_state",
]);
export type V2KnowledgePackageTypeT = z.infer<typeof V2KnowledgePackageType>;

export const V2KnowledgeAuthority = z.enum(["constitutional", "domain_standard", "operational"]);
export type V2KnowledgeAuthorityT = z.infer<typeof V2KnowledgeAuthority>;

export const V2KnowledgeLifecycleStatus = z.enum([
  "draft",
  "under_review",
  "approved",
  "active",
  "superseded",
  "archived",
]);
export type V2KnowledgeLifecycleStatusT = z.infer<typeof V2KnowledgeLifecycleStatus>;

export const V2KnowledgePackageContent = z
  .object({
    purpose: V2NonEmptyString,
    scope: stringList,
    out_of_scope: stringList,
    authoritative_standards: stringList,
    architecture: stringList,
    interfaces: stringList,
    dependencies: stringList,
    constraints: stringList,
    current_state: stringList,
    known_issues: stringList,
    open_decisions: stringList,
    acceptance_requirements: stringList,
    related_packages: z.array(V2EntityId),
    related_decision_records: z.array(V2EntityId),
    change_history: stringList,
  })
  .strict();
export type V2KnowledgePackageContentT = z.infer<typeof V2KnowledgePackageContent>;

export const V2KnowledgePackage = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    name: V2NonEmptyString,
    type: V2KnowledgePackageType,
    authority: V2KnowledgeAuthority,
    owner: V2NonEmptyString,
    scope_kind: z.enum(["project", "phase", "domain", "quality", "architecture"]),
    scope_id: V2EntityId,
    parent_package_id: V2EntityId.nullable(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict();
export type V2KnowledgePackageT = z.infer<typeof V2KnowledgePackage>;

export const V2KnowledgePackageVersionRef = z
  .object({
    package_id: V2EntityId,
    version_id: V2EntityId,
    name: V2NonEmptyString,
    type: V2KnowledgePackageType,
    version: semanticVersion,
    status: V2KnowledgeLifecycleStatus,
    content_hash: V2Sha256Hex,
  })
  .strict();
export type V2KnowledgePackageVersionRefT = z.infer<typeof V2KnowledgePackageVersionRef>;

export const V2KnowledgePackageVersion = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    package_id: V2EntityId,
    version: semanticVersion,
    status: V2KnowledgeLifecycleStatus,
    content: V2KnowledgePackageContent,
    content_hash: V2Sha256Hex,
    created_by: V2Actor,
    approved_by: V2Actor.nullable(),
    approved_at: V2IsoDateTime.nullable(),
    supersedes_version_id: V2EntityId.nullable(),
    superseded_by_version_id: V2EntityId.nullable(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((version, ctx) => {
    const requiresApproval = ["approved", "active", "superseded", "archived"].includes(
      version.status,
    );
    if (requiresApproval && (!version.approved_by || !version.approved_at)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approved_by"],
        message: `${version.status} knowledge requires an attributable approval`,
      });
    }
  });
export type V2KnowledgePackageVersionT = z.infer<typeof V2KnowledgePackageVersion>;

export const V2InterfaceContractContent = z
  .object({
    purpose: V2NonEmptyString,
    inputs: stringList,
    outputs: stringList,
    error_behavior: stringList,
    timing_behavior: stringList,
    state_ownership: stringList,
    cancellation_behavior: stringList,
    concurrency_behavior: stringList,
    performance_expectations: stringList,
    producing_components: stringList,
    consuming_components: stringList,
  })
  .strict();
export type V2InterfaceContractContentT = z.infer<typeof V2InterfaceContractContent>;

export const V2InterfaceContractVersionRef = z
  .object({
    contract_id: V2EntityId,
    version_id: V2EntityId,
    name: V2NonEmptyString,
    version: semanticVersion,
    status: V2KnowledgeLifecycleStatus,
    content_hash: V2Sha256Hex,
  })
  .strict();
export type V2InterfaceContractVersionRefT = z.infer<typeof V2InterfaceContractVersionRef>;

export const V2InterfaceContractVersion = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    contract_id: V2EntityId,
    name: V2NonEmptyString,
    version: semanticVersion,
    status: V2KnowledgeLifecycleStatus,
    content: V2InterfaceContractContent,
    content_hash: V2Sha256Hex,
    created_by: V2Actor,
    approved_by: V2Actor.nullable(),
    approved_at: V2IsoDateTime.nullable(),
    supersedes_version_id: V2EntityId.nullable(),
    superseded_by_version_id: V2EntityId.nullable(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict();
export type V2InterfaceContractVersionT = z.infer<typeof V2InterfaceContractVersion>;

export const V2TaskKnowledgePackage = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    version: z.number().int().positive(),
    status: z.enum(["draft", "approved", "superseded"]),
    assignment: V2NonEmptyString,
    expected_outcome: V2NonEmptyString,
    business_or_user_outcome: z.string(),
    scope: stringList,
    out_of_scope: stringList,
    deliverables: stringList.min(1),
    file_scope_declared: z.boolean(),
    permitted_files: stringList,
    restricted_files: stringList,
    required_package_ids: z.array(V2EntityId),
    required_interface_contract_ids: z.array(V2EntityId),
    required_decision_record_ids: z.array(V2EntityId),
    dependencies: z.array(V2EntityId),
    acceptance_criteria: stringList.min(1),
    required_tests: stringList,
    performance_requirements: stringList,
    accessibility_requirements: stringList,
    reporting_interval_seconds: z.number().int().positive().default(300),
    escalation_conditions: stringList,
    completion_format: V2NonEmptyString,
    branch_or_workspace: z.string(),
    token_budget: z.number().int().positive().nullable(),
    content_hash: V2Sha256Hex,
    approved_by: V2Actor.nullable(),
    approved_at: V2IsoDateTime.nullable(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((taskPackage, ctx) => {
    if (
      taskPackage.status === "approved" &&
      (!taskPackage.approved_by || !taskPackage.approved_at)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approved_by"],
        message: "an approved task package requires attributable approval",
      });
    }
  });
export type V2TaskKnowledgePackageT = z.infer<typeof V2TaskKnowledgePackage>;

export const V2ContextSourceFile = z
  .object({
    path: V2NonEmptyString,
    reason: V2NonEmptyString,
  })
  .strict();

export const V2ContextExclusion = z
  .object({
    item: V2NonEmptyString,
    reason: V2NonEmptyString,
  })
  .strict();

export const V2TaskContextManifest = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    task_package_id: V2EntityId,
    generated_by: V2Actor,
    repository_commit: V2NonEmptyString,
    included_packages: z.array(V2KnowledgePackageVersionRef),
    included_decision_records: z.array(V2EntityId),
    included_interface_contracts: z.array(V2InterfaceContractVersionRef),
    included_source_files: z.array(V2ContextSourceFile),
    included_test_files: z.array(V2ContextSourceFile),
    included_current_state: stringList,
    explicitly_excluded_context: z.array(V2ContextExclusion),
    known_context_limitations: stringList,
    unresolved_questions: stringList,
    estimated_tokens: z.number().int().nonnegative(),
    content_hash: V2Sha256Hex,
    generated_at: V2IsoDateTime,
  })
  .strict();
export type V2TaskContextManifestT = z.infer<typeof V2TaskContextManifest>;

export const V2KnowledgeDeltaChangeKind = z.enum([
  "new_standard",
  "modified_standard",
  "new_interface",
  "changed_interface",
  "new_dependency",
  "new_constraint",
  "discovered_limitation",
  "confirmed_assumption",
  "invalidated_assumption",
  "new_defect",
  "performance_finding",
  "reusable_component",
  "suggested_decision_record",
]);

export const V2KnowledgeDeltaChange = z
  .object({
    kind: V2KnowledgeDeltaChangeKind,
    summary: V2NonEmptyString,
    detail: V2NonEmptyString,
    affected_package_ids: z.array(V2EntityId),
  })
  .strict();

export const V2KnowledgeDeltaStatus = z.enum([
  "proposed",
  "accepted",
  "rejected",
  "modified",
  "deferred",
  "escalated",
]);
export type V2KnowledgeDeltaStatusT = z.infer<typeof V2KnowledgeDeltaStatus>;

export const V2KnowledgeDelta = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    run_id: V2EntityId,
    status: V2KnowledgeDeltaStatus,
    changes: z.array(V2KnowledgeDeltaChange).min(1),
    recommended_package_updates: z.array(
      z
        .object({
          package_id: V2EntityId,
          current_version: semanticVersion,
          recommended_version: semanticVersion,
        })
        .strict(),
    ),
    submitted_at: V2IsoDateTime,
    disposition_note: z.string().nullable(),
    dispositioned_by: V2Actor.nullable(),
    dispositioned_at: V2IsoDateTime.nullable(),
  })
  .strict()
  .superRefine((delta, ctx) => {
    if (
      delta.status !== "proposed" &&
      (!delta.disposition_note || !delta.dispositioned_by || !delta.dispositioned_at)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["disposition_note"],
        message: `${delta.status} deltas require an attributable disposition`,
      });
    }
  });
export type V2KnowledgeDeltaT = z.infer<typeof V2KnowledgeDelta>;

export const V2AgentProgressStatus = z.enum(["working", "waiting", "blocked", "completed"]);
export const V2AgentRiskLevel = z.enum(["green", "yellow", "red"]);

export const V2AgentHeartbeat = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    run_id: V2EntityId,
    sequence: z.number().int().positive(),
    reported_at: V2IsoDateTime,
    status: V2AgentProgressStatus,
    completed_since_last_update: stringList,
    currently_working_on: stringList,
    findings: stringList,
    blockers: stringList,
    decisions_needed: stringList,
    files_changed: stringList,
    tests: V2NonEmptyString,
    estimated_remaining_work: z.enum(["small", "moderate", "significant"]),
    risk_level: V2AgentRiskLevel,
    content_hash: V2Sha256Hex,
    repeated_update_count: z.number().int().nonnegative(),
  })
  .strict();
export type V2AgentHeartbeatT = z.infer<typeof V2AgentHeartbeat>;

export const V2AgentHandoff = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    run_id: V2EntityId,
    status: z.enum(["completed", "blocked", "failed"]),
    summary: V2NonEmptyString,
    deliverables: stringList,
    files_changed: stringList,
    interfaces_used: stringList,
    interfaces_changed: stringList,
    tests_added: stringList,
    test_results: stringList,
    acceptance_criteria: z.array(
      z
        .object({
          criterion: V2NonEmptyString,
          result: z.enum(["pass", "fail", "partial"]),
          evidence: V2NonEmptyString,
        })
        .strict(),
    ),
    known_limitations: stringList,
    open_issues: stringList,
    dependencies_created: stringList,
    knowledge_delta_id: V2EntityId.nullable(),
    recommended_package_updates: stringList,
    recommended_follow_up_tasks: stringList,
    branch: V2NonEmptyString,
    commit: V2NonEmptyString,
    artifacts: stringList,
    submitted_at: V2IsoDateTime,
  })
  .strict();
export type V2AgentHandoffT = z.infer<typeof V2AgentHandoff>;

export const V2KnowledgeConflictSeverity = z.enum(["C0", "C1", "C2", "C3", "C4"]);

export const V2KnowledgeConflict = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    left_task_id: V2EntityId,
    right_task_id: V2EntityId,
    severity: V2KnowledgeConflictSeverity,
    kind: z.enum([
      "file_overlap",
      "interface_overlap",
      "package_version_mismatch",
      "acceptance_criteria_conflict",
      "branch_overlap",
      "superseded_decision",
      "dependency_cycle",
      "incomplete_contract",
      "delta_conflict",
      "duplicate_implementation",
    ]),
    summary: V2NonEmptyString,
    details: stringList,
    status: z.enum(["open", "resolved", "dismissed"]),
    detected_at: V2IsoDateTime,
    resolved_by: V2Actor.nullable(),
    resolved_at: V2IsoDateTime.nullable(),
  })
  .strict();
export type V2KnowledgeConflictT = z.infer<typeof V2KnowledgeConflict>;

export const V2CompletionGate = z
  .object({
    schema_version: schemaVersion,
    scope_type: z.enum(["task", "phase"]),
    scope_id: V2EntityId,
    passed: z.boolean(),
    evaluated_at: V2IsoDateTime,
    checks: z.array(
      z
        .object({
          id: V2NonEmptyString,
          label: V2NonEmptyString,
          passed: z.boolean(),
          evidence: stringList,
        })
        .strict(),
    ),
    blockers: stringList,
  })
  .strict();
export type V2CompletionGateT = z.infer<typeof V2CompletionGate>;

export const V2PhaseKnowledgeStatus = z
  .object({
    schema_version: schemaVersion,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    overall_status: V2AgentRiskLevel,
    completed: stringList,
    in_progress: stringList,
    blockers: stringList,
    risks: stringList,
    decisions_required: stringList,
    active_agents: z.number().int().nonnegative(),
    next_milestone: z.string(),
    missing_heartbeat_run_ids: z.array(V2EntityId),
    generated_at: V2IsoDateTime,
  })
  .strict();
export type V2PhaseKnowledgeStatusT = z.infer<typeof V2PhaseKnowledgeStatus>;
