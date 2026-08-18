import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PHASE1_V2_MIGRATION_NAME = "0001_refoundation_v2";
export const PHASE1_V2_MIGRATION_URL = new URL(
  "../../../drizzle/0001_refoundation_v2.sql",
  import.meta.url,
);
export const PHASE2_PRESERVATION_MIGRATION_NAME = "0002_preservation_migration";
export const PHASE2_PRESERVATION_MIGRATION_URL = new URL(
  "../../../drizzle/0002_preservation_migration.sql",
  import.meta.url,
);
export const PHASE3_SOURCE_BINDINGS_MIGRATION_NAME = "0003_phase3_source_bindings";
export const PHASE3_SOURCE_BINDINGS_MIGRATION_URL = new URL(
  "../../../drizzle/0003_phase3_source_bindings.sql",
  import.meta.url,
);
export const PHASE5_ATTENTION_MIGRATION_NAME = "0004_phase5_attention";
export const PHASE5_ATTENTION_MIGRATION_URL = new URL(
  "../../../drizzle/0004_phase5_attention.sql",
  import.meta.url,
);
export const PHASE6_COORDINATION_MIGRATION_NAME = "0005_phase6_coordination";
export const PHASE6_COORDINATION_MIGRATION_URL = new URL(
  "../../../drizzle/0005_phase6_coordination.sql",
  import.meta.url,
);
export const PHASE7_HARDENING_MIGRATION_NAME = "0006_phase7_hardening";
export const PHASE7_HARDENING_MIGRATION_URL = new URL(
  "../../../drizzle/0006_phase7_hardening.sql",
  import.meta.url,
);
export const PHASE8_CUTOVER_COMPLETION_MIGRATION_NAME = "0007_phase8_cutover_completion";
export const PHASE8_CUTOVER_COMPLETION_MIGRATION_URL = new URL(
  "../../../drizzle/0007_phase8_cutover_completion.sql",
  import.meta.url,
);
export const WORKSPACE_CONNECTIONS_MIGRATION_NAME = "0008_workspace_connections";
export const WORKSPACE_CONNECTIONS_MIGRATION_URL = new URL(
  "../../../drizzle/0008_workspace_connections.sql",
  import.meta.url,
);
export const QC_COMMUNICATION_MIGRATION_NAME = "0009_qc_communication_decisions";
export const QC_COMMUNICATION_MIGRATION_URL = new URL(
  "../../../drizzle/0009_qc_communication_decisions.sql",
  import.meta.url,
);
export const GITHUB_APP_MANIFEST_MIGRATION_NAME = "0010_github_app_manifest";
export const GITHUB_APP_MANIFEST_MIGRATION_URL = new URL(
  "../../../drizzle/0010_github_app_manifest.sql",
  import.meta.url,
);
export const DEBATE_WORKFLOW_MIGRATION_NAME = "0011_debate_workflow";
export const DEBATE_WORKFLOW_MIGRATION_URL = new URL(
  "../../../drizzle/0011_debate_workflow.sql",
  import.meta.url,
);
export const PLANNING_RUNS_MIGRATION_NAME = "0012_planning_runs";
export const PLANNING_RUNS_MIGRATION_URL = new URL(
  "../../../drizzle/0012_planning_runs.sql",
  import.meta.url,
);
export const FRONTDOOR_PHASE_BRIDGE_MIGRATION_NAME = "0013_frontdoor_phase_bridge";
export const FRONTDOOR_PHASE_BRIDGE_MIGRATION_URL = new URL(
  "../../../drizzle/0013_frontdoor_phase_bridge.sql",
  import.meta.url,
);
// FRONT DOOR P4 (D3): image attachments + planning_runs.attachment_ids.
// Renumbered 0013 -> 0014 at integration: P3 and P4 ran in parallel and both
// claimed 0013; the bridge migration merged first.
export const ATTACHMENTS_MIGRATION_NAME = "0014_attachments";
export const ATTACHMENTS_MIGRATION_URL = new URL(
  "../../../drizzle/0014_attachments.sql",
  import.meta.url,
);
// FRONT DOOR P5: progress tracking settings. Renumbered 0014 -> 0015 at
// integration (same parallel-agent numbering collision as attachments).
export const FRONTDOOR_PROGRESS_TRACKING_MIGRATION_NAME = "0015_frontdoor_progress_tracking";
export const FRONTDOOR_PROGRESS_TRACKING_MIGRATION_URL = new URL(
  "../../../drizzle/0015_frontdoor_progress_tracking.sql",
  import.meta.url,
);

// ONBOARDING O2: binding roles (workspace vs remote), the push-credential
// strategy seam, and actor-scoped onboarding idempotency.
export const ONBOARDING_BINDINGS_MIGRATION_NAME = "0016_onboarding_bindings";
export const ONBOARDING_BINDINGS_MIGRATION_URL = new URL(
  "../../../drizzle/0016_onboarding_bindings.sql",
  import.meta.url,
);

// ONBOARDING O4: GitHub Actions execution path.
export const ACTIONS_EXECUTION_MIGRATION_NAME = "0017_actions_execution";
export const ACTIONS_EXECUTION_MIGRATION_URL = new URL(
  "../../../drizzle/0017_actions_execution.sql",
  import.meta.url,
);

// ONBOARDING O6: repository-creation intents, so an idempotent retry can be
// told apart from silently adopting a user's existing repository.
//
// THE NUMBER IS DELIBERATELY UNASSIGNED. 0016 and 0017 are taken; the PM
// assigns this one and renames the file at integration.
export const ONBOARDING_REPOSITORY_INTENTS_MIGRATION_NAME = "0018_onboarding_repository_intents";
export const ONBOARDING_REPOSITORY_INTENTS_MIGRATION_URL = new URL(
  "../../../drizzle/0018_onboarding_repository_intents.sql",
  import.meta.url,
);

// EXECUTION E1: content-addressed assembled task context (task_context_blobs +
// task_context_documents), the payload every dispatched run fetches.
//
// THE NUMBER IS DELIBERATELY UNASSIGNED. 0018 is the highest number merged when
// E1 was written; the PM assigns the real number and renames the file at
// integration.
export const TASK_CONTEXT_MIGRATION_NAME = "0019_task_context";
export const TASK_CONTEXT_MIGRATION_URL = new URL(
  "../../../drizzle/0019_task_context.sql",
  import.meta.url,
);

// EXECUTION E2: binds an assembled task-context document to the runner that
// was actually dispatched to read it (the fetch route's missing
// authorization check, on top of E1's authentication).
//
// THE NUMBER IS DELIBERATELY UNASSIGNED. 0019 is the highest number merged
// when E2 was written; the PM assigns the real number and renames the file at
// integration.
export const DISPATCH_CONTEXT_SCOPE_MIGRATION_NAME = "0020_dispatch_context_scope";
export const DISPATCH_CONTEXT_SCOPE_MIGRATION_URL = new URL(
  "../../../drizzle/0020_dispatch_context_scope.sql",
  import.meta.url,
);

// EXECUTION E9: per-run credentials for the provider-native model gateway
// (gateway_credentials). Only a sha-256 hash of each token is stored.
//
// THE NUMBER IS DELIBERATELY UNASSIGNED — the file is literally named
// `0021_gateway_credentials.sql`. 0020 is the highest number merged when E9
// was written, and three parallel agents have collided on migration numbers
// already; the PM assigns the real number and renames both the file and the
// string below at integration.
export const GATEWAY_CREDENTIALS_MIGRATION_NAME = "0021_gateway_credentials";
export const GATEWAY_CREDENTIALS_MIGRATION_URL = new URL(
  "../../../drizzle/0021_gateway_credentials.sql",
  import.meta.url,
);

// EXECUTION E10: persists the branch, remote and pull request a run published,
// so a completed task can be clicked through to its review instead of having
// that fact live only in a `run_log` string.
//
// THE NUMBER IS DELIBERATELY UNASSIGNED — the file is literally named
// `0022_run_publication.sql`, matching E9's convention. 0020 is the highest
// number merged when E10 was written and E9 is unnumbered in parallel; the PM
// assigns the real number and renames both the file and the string below at
// integration.
export const RUN_PUBLICATION_MIGRATION_NAME = "0022_run_publication";
export const RUN_PUBLICATION_MIGRATION_URL = new URL(
  "../../../drizzle/0022_run_publication.sql",
  import.meta.url,
);

// EXECUTION E5: per-dispatch runner identity for GitHub Actions-hosted
// execution (github_actions_runs_runner_id_unique_idx) — the fix for
// concurrent Actions-hosted dispatches in one project fencing each other off.
//
// THE NUMBER IS DELIBERATELY UNASSIGNED — the file is literally named
// `0023_actions_dispatch_runner_identity.sql`, matching E9/E10's convention.
// 0020 is the highest assigned number merged when E5 was written, and E9/E10
// are unnumbered in parallel; the PM assigns the real number and renames both
// the file and the string below at integration.
export const ACTIONS_DISPATCH_RUNNER_IDENTITY_MIGRATION_NAME =
  "0023_actions_dispatch_runner_identity";
export const ACTIONS_DISPATCH_RUNNER_IDENTITY_MIGRATION_URL = new URL(
  "../../../drizzle/0023_actions_dispatch_runner_identity.sql",
  import.meta.url,
);

// EXECUTION E12 — conflict safety for concurrent tasks inside one phase. The
// number is unassigned for the same reason as every entry above it: parallel
// phases each pick the next free number and the PM renames the file and this
// string at integration.
export const PHASE_CONCURRENCY_CONFLICTS_MIGRATION_NAME = "0024_phase_concurrency_conflicts";
export const PHASE_CONCURRENCY_CONFLICTS_MIGRATION_URL = new URL(
  "../../../drizzle/0024_phase_concurrency_conflicts.sql",
  import.meta.url,
);

// PHASE TAB P1: planning-run decision workflow (worker_providers, decision,
// revision_seed columns; approved/rejected statuses). Number 0025 assigned at
// integration (0024 was the highest merged number at the time).
export const PHASE_TAB_PLANNING_DECISIONS_MIGRATION_NAME = "0025_phase_tab_planning_decisions";
export const PHASE_TAB_PLANNING_DECISIONS_MIGRATION_URL = new URL(
  "../../../drizzle/0025_phase_tab_planning_decisions.sql",
  import.meta.url,
);

export const QUICK_CHANGES_MIGRATION_NAME = "0026_quick_changes";
export const QUICK_CHANGES_MIGRATION_URL = new URL(
  "../../../drizzle/0026_quick_changes.sql",
  import.meta.url,
);

export const KNOWLEDGE_PACKAGES_MIGRATION_NAME = "0027_knowledge_packages";
export const KNOWLEDGE_PACKAGES_MIGRATION_URL = new URL(
  "../../../drizzle/0027_knowledge_packages.sql",
  import.meta.url,
);
export const CODEX_REASONING_EFFORT_MIGRATION_NAME = "0028_codex_reasoning_effort";
export const CODEX_REASONING_EFFORT_MIGRATION_URL = new URL(
  "../../../drizzle/0028_codex_reasoning_effort.sql",
  import.meta.url,
);
export const GLOBAL_RULES_MIGRATION_NAME = "0029_global_rules";
export const GLOBAL_RULES_MIGRATION_URL = new URL(
  "../../../drizzle/0029_global_rules.sql",
  import.meta.url,
);

export const AI_USAGE_TELEMETRY_MIGRATION_NAME = "0030_ai_usage_telemetry";
export const AI_USAGE_TELEMETRY_MIGRATION_URL = new URL(
  "../../../drizzle/0030_ai_usage_telemetry.sql",
  import.meta.url,
);

export const PROJECT_ACCESS_ATTRIBUTION_MIGRATION_NAME = "0031_project_access_attribution";
export const PROJECT_ACCESS_ATTRIBUTION_MIGRATION_URL = new URL(
  "../../../drizzle/0031_project_access_attribution.sql",
  import.meta.url,
);

export const USAGE_INTELLIGENCE_POLICIES_MIGRATION_NAME = "0032_usage_intelligence_policies";
export const USAGE_INTELLIGENCE_POLICIES_MIGRATION_URL = new URL(
  "../../../drizzle/0032_usage_intelligence_policies.sql",
  import.meta.url,
);

export const USAGE_CALIBRATION_ANALYTICS_MIGRATION_NAME = "0033_usage_calibration_analytics";
export const USAGE_CALIBRATION_ANALYTICS_MIGRATION_URL = new URL(
  "../../../drizzle/0033_usage_calibration_analytics.sql",
  import.meta.url,
);

export const SHADOW_EVIDENCE_ORDER_MIGRATION_NAME = "0034_shadow_evidence_order";
export const SHADOW_EVIDENCE_ORDER_MIGRATION_URL = new URL(
  "../../../drizzle/0034_shadow_evidence_order.sql",
  import.meta.url,
);

export const CONVERSATION_DOMAIN_MIGRATION_NAME = "0035_conversation_domain";
export const CONVERSATION_DOMAIN_MIGRATION_URL = new URL(
  "../../../drizzle/0035_conversation_domain.sql",
  import.meta.url,
);
export const CONVERSATION_STREAM_LIFECYCLE_MIGRATION_NAME = "0036_conversation_stream_lifecycle";
export const CONVERSATION_STREAM_LIFECYCLE_MIGRATION_URL = new URL(
  "../../../drizzle/0036_conversation_stream_lifecycle.sql",
  import.meta.url,
);
export const CONVERSATION_PLAN_WORKFLOW_MIGRATION_NAME = "0037_conversation_plan_workflow";
export const CONVERSATION_PLAN_WORKFLOW_MIGRATION_URL = new URL(
  "../../../drizzle/0037_conversation_plan_workflow.sql",
  import.meta.url,
);
export const CONVERSATION_EXECUTION_HANDOFF_MIGRATION_NAME = "0038_conversation_execution_handoff";
export const CONVERSATION_EXECUTION_HANDOFF_MIGRATION_URL = new URL(
  "../../../drizzle/0038_conversation_execution_handoff.sql",
  import.meta.url,
);
export const CONVERSATION_HUMAN_STEERING_MIGRATION_NAME = "0039_conversation_human_steering";
export const CONVERSATION_HUMAN_STEERING_MIGRATION_URL = new URL(
  "../../../drizzle/0039_conversation_human_steering.sql",
  import.meta.url,
);
export const CONVERSATION_MOCKUPS_DASHBOARD_MIGRATION_NAME = "0040_conversation_mockups_dashboard";
export const CONVERSATION_MOCKUPS_DASHBOARD_MIGRATION_URL = new URL(
  "../../../drizzle/0040_conversation_mockups_dashboard.sql",
  import.meta.url,
);
export const PHASE6_RUNTIME_DELIVERY_MIGRATION_NAME = "0041_phase6_runtime_delivery";
export const PHASE6_RUNTIME_DELIVERY_MIGRATION_URL = new URL(
  "../../../drizzle/0041_phase6_runtime_delivery.sql",
  import.meta.url,
);
export const PHASE6_ACCEPTANCE_CORRECTIONS_MIGRATION_NAME = "0042_phase6_acceptance_corrections";
export const PHASE6_ACCEPTANCE_CORRECTIONS_MIGRATION_URL = new URL(
  "../../../drizzle/0042_phase6_acceptance_corrections.sql",
  import.meta.url,
);
export const CONVERSATION_INFERENCE_BUDGET_MIGRATION_NAME = "0043_conversation_inference_budget";
export const CONVERSATION_INFERENCE_BUDGET_MIGRATION_URL = new URL(
  "../../../drizzle/0043_conversation_inference_budget.sql",
  import.meta.url,
);

export const ONBOARDING_INTENTS_UPDATE_GRANT_MIGRATION_NAME =
  "0044_onboarding_intents_update_grant";
export const ONBOARDING_INTENTS_UPDATE_GRANT_MIGRATION_URL = new URL(
  "../../../drizzle/0044_onboarding_intents_update_grant.sql",
  import.meta.url,
);

export const GITHUB_CONNECTION_REMOVAL_MIGRATION_NAME = "0045_github_connection_removal";
export const GITHUB_CONNECTION_REMOVAL_MIGRATION_URL = new URL(
  "../../../drizzle/0045_github_connection_removal.sql",
  import.meta.url,
);

export const GITHUB_AUTHORIZATION_REMOVAL_MIGRATION_NAME = "0046_github_authorization_removal";
export const GITHUB_AUTHORIZATION_REMOVAL_MIGRATION_URL = new URL(
  "../../../drizzle/0046_github_authorization_removal.sql",
  import.meta.url,
);

export const CONVERSATION_PLAN_HANDOFF_CHOICES_MIGRATION_NAME =
  "0047_conversation_plan_handoff_choices";
export const CONVERSATION_PLAN_HANDOFF_CHOICES_MIGRATION_URL = new URL(
  "../../../drizzle/0047_conversation_plan_handoff_choices.sql",
  import.meta.url,
);

export const CONVERSATION_MODEL_SWITCHING_MIGRATION_NAME = "0048_conversation_model_switching";
export const CONVERSATION_MODEL_SWITCHING_MIGRATION_URL = new URL(
  "../../../drizzle/0048_conversation_model_switching.sql",
  import.meta.url,
);

export const QC_CONTROL_TRANSCRIPT_MIGRATION_NAME = "0049_qc_control_and_transcript";
export const QC_CONTROL_TRANSCRIPT_MIGRATION_URL = new URL(
  "../../../drizzle/0049_qc_control_and_transcript.sql",
  import.meta.url,
);

export const CONVERSATION_ORGANIZATION_MIGRATION_NAME = "0050_conversation_organization";
export const CONVERSATION_ORGANIZATION_MIGRATION_URL = new URL(
  "../../../drizzle/0050_conversation_organization.sql",
  import.meta.url,
);

export const CONVERSATION_FILE_ATTACHMENTS_MIGRATION_NAME = "0051_conversation_file_attachments";
export const CONVERSATION_FILE_ATTACHMENTS_MIGRATION_URL = new URL(
  "../../../drizzle/0051_conversation_file_attachments.sql",
  import.meta.url,
);

export const CONVERSATION_MESSAGE_BRANCHES_MIGRATION_NAME = "0052_conversation_message_branches";
export const CONVERSATION_MESSAGE_BRANCHES_MIGRATION_URL = new URL(
  "../../../drizzle/0052_conversation_message_branches.sql",
  import.meta.url,
);

export const DEVICE_IDENTITY_CORE_MIGRATION_NAME = "0053_device_identity_core";
export const DEVICE_IDENTITY_CORE_MIGRATION_URL = new URL(
  "../../../drizzle/0053_device_identity_core.sql",
  import.meta.url,
);

export const DEVICE_HTTP_REQUEST_REPLAYS_MIGRATION_NAME = "0054_device_http_request_replays";
export const DEVICE_HTTP_REQUEST_REPLAYS_MIGRATION_URL = new URL(
  "../../../drizzle/0054_device_http_request_replays.sql",
  import.meta.url,
);

export const DEVICE_CANCELLATION_TRACKING_MIGRATION_NAME = "0055_device_cancellation_tracking";
export const DEVICE_CANCELLATION_TRACKING_MIGRATION_URL = new URL(
  "../../../drizzle/0055_device_cancellation_tracking.sql",
  import.meta.url,
);

export const GATEWAY_DEVICE_AUTHORIZATION_MIGRATION_NAME = "0056_gateway_device_authorization";
export const GATEWAY_DEVICE_AUTHORIZATION_MIGRATION_URL = new URL(
  "../../../drizzle/0056_gateway_device_authorization.sql",
  import.meta.url,
);

export const DEVICE_MANAGEMENT_OBSERVATIONS_MIGRATION_NAME = "0057_device_management_observations";
export const DEVICE_MANAGEMENT_OBSERVATIONS_MIGRATION_URL = new URL(
  "../../../drizzle/0057_device_management_observations.sql",
  import.meta.url,
);

export const DEVICE_REPOSITORY_ACCESS_MIGRATION_NAME = "0058_device_repository_access";
export const DEVICE_REPOSITORY_ACCESS_MIGRATION_URL = new URL(
  "../../../drizzle/0058_device_repository_access.sql",
  import.meta.url,
);

export const PROJECT_RUN_CANCELLATION_MIGRATION_NAME = "0059_project_run_cancellation";
export const PROJECT_RUN_CANCELLATION_MIGRATION_URL = new URL(
  "../../../drizzle/0059_project_run_cancellation.sql",
  import.meta.url,
);

export const LEGACY_REPOSITORY_BINDING_CLAIMS_MIGRATION_NAME =
  "0060_legacy_repository_binding_claims";
export const LEGACY_REPOSITORY_BINDING_CLAIMS_MIGRATION_URL = new URL(
  "../../../drizzle/0060_legacy_repository_binding_claims.sql",
  import.meta.url,
);

export const DEVICE_HTTP_OPERATION_PURPOSES_MIGRATION_NAME = "0061_device_http_operation_purposes";
export const DEVICE_HTTP_OPERATION_PURPOSES_MIGRATION_URL = new URL(
  "../../../drizzle/0061_device_http_operation_purposes.sql",
  import.meta.url,
);

export const QC_MARKDOWN_ARTIFACTS_MIGRATION_NAME = "0062_qc_markdown_artifacts";
export const QC_MARKDOWN_ARTIFACTS_MIGRATION_URL = new URL(
  "../../../drizzle/0062_qc_markdown_artifacts.sql",
  import.meta.url,
);

export const BINARY_ATTACHMENTS_MIGRATION_NAME = "0063_binary_attachments";
export const BINARY_ATTACHMENTS_MIGRATION_URL = new URL(
  "../../../drizzle/0063_binary_attachments.sql",
  import.meta.url,
);

export const QC_PAUSE_POINTS_MIGRATION_NAME = "0064_qc_pause_points";
export const QC_PAUSE_POINTS_MIGRATION_URL = new URL(
  "../../../drizzle/0064_qc_pause_points.sql",
  import.meta.url,
);

export const QC_GATE_ATTENTION_TIMING_MIGRATION_NAME = "0065_qc_gate_attention_timing";
export const QC_GATE_ATTENTION_TIMING_MIGRATION_URL = new URL(
  "../../../drizzle/0065_qc_gate_attention_timing.sql",
  import.meta.url,
);

export const QC_PAUSE_RESUME_TRANSITIONS_MIGRATION_NAME = "0066_qc_pause_resume_transitions";
export const QC_PAUSE_RESUME_TRANSITIONS_MIGRATION_URL = new URL(
  "../../../drizzle/0066_qc_pause_resume_transitions.sql",
  import.meta.url,
);

export const QC_ADJUDICATION_MIGRATION_NAME = "0067_qc_adjudication";
export const QC_ADJUDICATION_MIGRATION_URL = new URL(
  "../../../drizzle/0067_qc_adjudication.sql",
  import.meta.url,
);

export const QC_GATE_A_ACCEPT_NOW_MIGRATION_NAME = "0068_qc_gate_a_accept_now";
export const QC_GATE_A_ACCEPT_NOW_MIGRATION_URL = new URL(
  "../../../drizzle/0068_qc_gate_a_accept_now.sql",
  import.meta.url,
);

export const QC_ATTENTION_INDEX_MIGRATION_NAME = "0069_qc_attention_index";
export const QC_ATTENTION_INDEX_MIGRATION_URL = new URL(
  "../../../drizzle/0069_qc_attention_index.sql",
  import.meta.url,
);

export const QC_SKIP_QC_ACCEPTS_IN_QC_MIGRATION_NAME = "0070_qc_skip_qc_accepts_in_qc";
export const QC_SKIP_QC_ACCEPTS_IN_QC_MIGRATION_URL = new URL(
  "../../../drizzle/0070_qc_skip_qc_accepts_in_qc.sql",
  import.meta.url,
);

export const QC_ZERO_ROUNDS_MIGRATION_NAME = "0071_qc_zero_rounds";
export const QC_ZERO_ROUNDS_MIGRATION_URL = new URL(
  "../../../drizzle/0071_qc_zero_rounds.sql",
  import.meta.url,
);

export const QC_LAST_HUMAN_MESSAGE_MIGRATION_NAME = "0072_qc_last_human_message";
export const QC_LAST_HUMAN_MESSAGE_MIGRATION_URL = new URL(
  "../../../drizzle/0072_qc_last_human_message.sql",
  import.meta.url,
);

export const QC_MODE_PROVENANCE_MIGRATION_NAME = "0073_qc_mode_provenance";
export const QC_MODE_PROVENANCE_MIGRATION_URL = new URL(
  "../../../drizzle/0073_qc_mode_provenance.sql",
  import.meta.url,
);

export const QC_PAUSED_ROUND_BOUND_MIGRATION_NAME = "0074_qc_paused_round_bound";
export const QC_PAUSED_ROUND_BOUND_MIGRATION_URL = new URL(
  "../../../drizzle/0074_qc_paused_round_bound.sql",
  import.meta.url,
);

export const PLANNING_LIVE_PROGRESS_MIGRATION_NAME = "0075_planning_live_progress";
export const PLANNING_LIVE_PROGRESS_MIGRATION_URL = new URL(
  "../../../drizzle/0075_planning_live_progress.sql",
  import.meta.url,
);

export const QC_RESTART_CHECKPOINTS_MIGRATION_NAME = "0076_qc_restart_checkpoints";
export const QC_RESTART_CHECKPOINTS_MIGRATION_URL = new URL(
  "../../../drizzle/0076_qc_restart_checkpoints.sql",
  import.meta.url,
);

export const QC_TARGETED_REVISIONS_MIGRATION_NAME = "0077_qc_targeted_revisions";
export const QC_TARGETED_REVISIONS_MIGRATION_URL = new URL(
  "../../../drizzle/0077_qc_targeted_revisions.sql",
  import.meta.url,
);

export const QC_FINDING_TRIAGE_MIGRATION_NAME = "0078_qc_finding_triage";
export const QC_FINDING_TRIAGE_MIGRATION_URL = new URL(
  "../../../drizzle/0078_qc_finding_triage.sql",
  import.meta.url,
);
export const QC_ROUTINE_ROUND_DEFAULT_MIGRATION_NAME = "0079_qc_routine_round_default";
export const QC_ROUTINE_ROUND_DEFAULT_MIGRATION_URL = new URL(
  "../../../drizzle/0079_qc_routine_round_default.sql",
  import.meta.url,
);
export const DEEPSEEK_PROVIDER_MIGRATION_NAME = "0080_deepseek_provider";
export const DEEPSEEK_PROVIDER_MIGRATION_URL = new URL(
  "../../../drizzle/0080_deepseek_provider.sql",
  import.meta.url,
);
export const PROJECT_DESTROY_MIGRATION_NAME = "0081_project_destroy";
export const PROJECT_DESTROY_MIGRATION_URL = new URL(
  "../../../drizzle/0081_project_destroy.sql",
  import.meta.url,
);
export const HELD_EXECUTION_KICKOFF_MIGRATION_NAME = "0082_held_execution_kickoff";
export const HELD_EXECUTION_KICKOFF_MIGRATION_URL = new URL(
  "../../../drizzle/0082_held_execution_kickoff.sql",
  import.meta.url,
);
export const QC_TERMINAL_FOLLOWUP_CHAT_MIGRATION_NAME = "0083_qc_terminal_followup_chat";
export const QC_TERMINAL_FOLLOWUP_CHAT_MIGRATION_URL = new URL(
  "../../../drizzle/0083_qc_terminal_followup_chat.sql",
  import.meta.url,
);
export const SONNET_CACHE_PRICING_CORRECTION_MIGRATION_NAME =
  "0084_sonnet_cache_pricing_correction";
export const SONNET_CACHE_PRICING_CORRECTION_MIGRATION_URL = new URL(
  "../../../drizzle/0084_sonnet_cache_pricing_correction.sql",
  import.meta.url,
);

export interface V2MigrationQueryResult<TRow = Record<string, unknown>> {
  rows: TRow[];
  affectedRows?: number;
}

export interface V2MigrationExecutor {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<V2MigrationQueryResult<TRow>>;
  exec?(sql: string): Promise<unknown>;
}

export interface V2MigrationDatabase extends V2MigrationExecutor {
  transaction<T>(work: (tx: V2MigrationExecutor) => Promise<T>): Promise<T>;
}

export interface V2MigrationResult {
  name: string;
  checksum: string;
  applied: boolean;
}

export interface V2MigrationSource {
  name: string;
  sql: string;
}

interface AppliedMigrationRow {
  checksum: string;
}

export async function loadPhase1V2MigrationSql(): Promise<string> {
  return readFile(PHASE1_V2_MIGRATION_URL, "utf8");
}

export async function loadPhase2PreservationMigrationSql(): Promise<string> {
  return readFile(PHASE2_PRESERVATION_MIGRATION_URL, "utf8");
}

export async function loadPhase3SourceBindingsMigrationSql(): Promise<string> {
  return readFile(PHASE3_SOURCE_BINDINGS_MIGRATION_URL, "utf8");
}

export async function loadPhase5AttentionMigrationSql(): Promise<string> {
  return readFile(PHASE5_ATTENTION_MIGRATION_URL, "utf8");
}

export async function loadPhase6CoordinationMigrationSql(): Promise<string> {
  return readFile(PHASE6_COORDINATION_MIGRATION_URL, "utf8");
}

export async function loadPhase7HardeningMigrationSql(): Promise<string> {
  return readFile(PHASE7_HARDENING_MIGRATION_URL, "utf8");
}

export async function loadPhase8CutoverCompletionMigrationSql(): Promise<string> {
  return readFile(PHASE8_CUTOVER_COMPLETION_MIGRATION_URL, "utf8");
}

export async function loadWorkspaceConnectionsMigrationSql(): Promise<string> {
  return readFile(WORKSPACE_CONNECTIONS_MIGRATION_URL, "utf8");
}

export async function loadQcCommunicationMigrationSql(): Promise<string> {
  return readFile(QC_COMMUNICATION_MIGRATION_URL, "utf8");
}

export async function loadGitHubAppManifestMigrationSql(): Promise<string> {
  return readFile(GITHUB_APP_MANIFEST_MIGRATION_URL, "utf8");
}

export async function loadDebateWorkflowMigrationSql(): Promise<string> {
  return readFile(DEBATE_WORKFLOW_MIGRATION_URL, "utf8");
}

export async function loadPlanningRunsMigrationSql(): Promise<string> {
  return readFile(PLANNING_RUNS_MIGRATION_URL, "utf8");
}

export async function loadFrontDoorPhaseBridgeMigrationSql(): Promise<string> {
  return readFile(FRONTDOOR_PHASE_BRIDGE_MIGRATION_URL, "utf8");
}

export async function loadAttachmentsMigrationSql(): Promise<string> {
  return readFile(ATTACHMENTS_MIGRATION_URL, "utf8");
}

export async function loadFrontDoorProgressTrackingMigrationSql(): Promise<string> {
  return readFile(FRONTDOOR_PROGRESS_TRACKING_MIGRATION_URL, "utf8");
}

export async function loadOnboardingBindingsMigrationSql(): Promise<string> {
  return readFile(ONBOARDING_BINDINGS_MIGRATION_URL, "utf8");
}

export async function loadActionsExecutionMigrationSql(): Promise<string> {
  return readFile(ACTIONS_EXECUTION_MIGRATION_URL, "utf8");
}

export async function loadOnboardingRepositoryIntentsMigrationSql(): Promise<string> {
  return readFile(ONBOARDING_REPOSITORY_INTENTS_MIGRATION_URL, "utf8");
}

export async function loadTaskContextMigrationSql(): Promise<string> {
  return readFile(TASK_CONTEXT_MIGRATION_URL, "utf8");
}

export async function loadDispatchContextScopeMigrationSql(): Promise<string> {
  return readFile(DISPATCH_CONTEXT_SCOPE_MIGRATION_URL, "utf8");
}

export async function loadGatewayCredentialsMigrationSql(): Promise<string> {
  return readFile(GATEWAY_CREDENTIALS_MIGRATION_URL, "utf8");
}

export async function loadRunPublicationMigrationSql(): Promise<string> {
  return readFile(RUN_PUBLICATION_MIGRATION_URL, "utf8");
}

export async function loadActionsDispatchRunnerIdentityMigrationSql(): Promise<string> {
  return readFile(ACTIONS_DISPATCH_RUNNER_IDENTITY_MIGRATION_URL, "utf8");
}

export async function loadPhaseConcurrencyConflictsMigrationSql(): Promise<string> {
  return readFile(PHASE_CONCURRENCY_CONFLICTS_MIGRATION_URL, "utf8");
}

export async function loadPhaseTabPlanningDecisionsMigrationSql(): Promise<string> {
  return readFile(PHASE_TAB_PLANNING_DECISIONS_MIGRATION_URL, "utf8");
}

export async function loadQuickChangesMigrationSql(): Promise<string> {
  return readFile(QUICK_CHANGES_MIGRATION_URL, "utf8");
}

export async function loadKnowledgePackagesMigrationSql(): Promise<string> {
  return readFile(KNOWLEDGE_PACKAGES_MIGRATION_URL, "utf8");
}

export async function loadCodexReasoningEffortMigrationSql(): Promise<string> {
  return readFile(CODEX_REASONING_EFFORT_MIGRATION_URL, "utf8");
}

export async function loadGlobalRulesMigrationSql(): Promise<string> {
  return readFile(GLOBAL_RULES_MIGRATION_URL, "utf8");
}

export async function loadAiUsageTelemetryMigrationSql(): Promise<string> {
  return readFile(AI_USAGE_TELEMETRY_MIGRATION_URL, "utf8");
}

export async function loadProjectAccessAttributionMigrationSql(): Promise<string> {
  return readFile(PROJECT_ACCESS_ATTRIBUTION_MIGRATION_URL, "utf8");
}

export async function loadUsageIntelligencePoliciesMigrationSql(): Promise<string> {
  return readFile(USAGE_INTELLIGENCE_POLICIES_MIGRATION_URL, "utf8");
}

export async function loadUsageCalibrationAnalyticsMigrationSql(): Promise<string> {
  return readFile(USAGE_CALIBRATION_ANALYTICS_MIGRATION_URL, "utf8");
}

export async function loadShadowEvidenceOrderMigrationSql(): Promise<string> {
  return readFile(SHADOW_EVIDENCE_ORDER_MIGRATION_URL, "utf8");
}

export async function loadConversationDomainMigrationSql(): Promise<string> {
  return readFile(CONVERSATION_DOMAIN_MIGRATION_URL, "utf8");
}

export async function loadConversationStreamLifecycleMigrationSql(): Promise<string> {
  return readFile(CONVERSATION_STREAM_LIFECYCLE_MIGRATION_URL, "utf8");
}

export async function loadConversationPlanWorkflowMigrationSql(): Promise<string> {
  return readFile(CONVERSATION_PLAN_WORKFLOW_MIGRATION_URL, "utf8");
}

export async function loadConversationExecutionHandoffMigrationSql(): Promise<string> {
  return readFile(CONVERSATION_EXECUTION_HANDOFF_MIGRATION_URL, "utf8");
}

export async function loadConversationHumanSteeringMigrationSql(): Promise<string> {
  return readFile(CONVERSATION_HUMAN_STEERING_MIGRATION_URL, "utf8");
}

export async function loadConversationMockupsDashboardMigrationSql(): Promise<string> {
  return readFile(CONVERSATION_MOCKUPS_DASHBOARD_MIGRATION_URL, "utf8");
}

export async function loadPhase6RuntimeDeliveryMigrationSql(): Promise<string> {
  return readFile(PHASE6_RUNTIME_DELIVERY_MIGRATION_URL, "utf8");
}

export async function loadPhase6AcceptanceCorrectionsMigrationSql(): Promise<string> {
  return readFile(PHASE6_ACCEPTANCE_CORRECTIONS_MIGRATION_URL, "utf8");
}

export async function loadConversationInferenceBudgetMigrationSql(): Promise<string> {
  return readFile(CONVERSATION_INFERENCE_BUDGET_MIGRATION_URL, "utf8");
}

export async function loadOnboardingIntentsUpdateGrantMigrationSql(): Promise<string> {
  return readFile(ONBOARDING_INTENTS_UPDATE_GRANT_MIGRATION_URL, "utf8");
}

export async function loadGitHubConnectionRemovalMigrationSql(): Promise<string> {
  return readFile(GITHUB_CONNECTION_REMOVAL_MIGRATION_URL, "utf8");
}

export async function loadGitHubAuthorizationRemovalMigrationSql(): Promise<string> {
  return readFile(GITHUB_AUTHORIZATION_REMOVAL_MIGRATION_URL, "utf8");
}

export async function loadConversationPlanHandoffChoicesMigrationSql(): Promise<string> {
  return readFile(CONVERSATION_PLAN_HANDOFF_CHOICES_MIGRATION_URL, "utf8");
}

export async function loadConversationModelSwitchingMigrationSql(): Promise<string> {
  return readFile(CONVERSATION_MODEL_SWITCHING_MIGRATION_URL, "utf8");
}

export async function loadQcControlTranscriptMigrationSql(): Promise<string> {
  return readFile(QC_CONTROL_TRANSCRIPT_MIGRATION_URL, "utf8");
}

export async function loadConversationOrganizationMigrationSql(): Promise<string> {
  return readFile(CONVERSATION_ORGANIZATION_MIGRATION_URL, "utf8");
}

export async function loadConversationFileAttachmentsMigrationSql(): Promise<string> {
  return readFile(CONVERSATION_FILE_ATTACHMENTS_MIGRATION_URL, "utf8");
}

export async function loadConversationMessageBranchesMigrationSql(): Promise<string> {
  return readFile(CONVERSATION_MESSAGE_BRANCHES_MIGRATION_URL, "utf8");
}

export async function loadDeviceIdentityCoreMigrationSql(): Promise<string> {
  return readFile(DEVICE_IDENTITY_CORE_MIGRATION_URL, "utf8");
}

export async function loadDeviceHttpRequestReplaysMigrationSql(): Promise<string> {
  return readFile(DEVICE_HTTP_REQUEST_REPLAYS_MIGRATION_URL, "utf8");
}

export async function loadDeviceCancellationTrackingMigrationSql(): Promise<string> {
  return readFile(DEVICE_CANCELLATION_TRACKING_MIGRATION_URL, "utf8");
}

export async function loadGatewayDeviceAuthorizationMigrationSql(): Promise<string> {
  return readFile(GATEWAY_DEVICE_AUTHORIZATION_MIGRATION_URL, "utf8");
}

export async function loadDeviceManagementObservationsMigrationSql(): Promise<string> {
  return readFile(DEVICE_MANAGEMENT_OBSERVATIONS_MIGRATION_URL, "utf8");
}

export async function loadDeviceRepositoryAccessMigrationSql(): Promise<string> {
  return readFile(DEVICE_REPOSITORY_ACCESS_MIGRATION_URL, "utf8");
}

export async function loadProjectRunCancellationMigrationSql(): Promise<string> {
  return readFile(PROJECT_RUN_CANCELLATION_MIGRATION_URL, "utf8");
}

export async function loadLegacyRepositoryBindingClaimsMigrationSql(): Promise<string> {
  return readFile(LEGACY_REPOSITORY_BINDING_CLAIMS_MIGRATION_URL, "utf8");
}

export async function loadDeviceHttpOperationPurposesMigrationSql(): Promise<string> {
  return readFile(DEVICE_HTTP_OPERATION_PURPOSES_MIGRATION_URL, "utf8");
}

export async function loadQcMarkdownArtifactsMigrationSql(): Promise<string> {
  return readFile(QC_MARKDOWN_ARTIFACTS_MIGRATION_URL, "utf8");
}

export async function loadBinaryAttachmentsMigrationSql(): Promise<string> {
  return readFile(BINARY_ATTACHMENTS_MIGRATION_URL, "utf8");
}

export async function loadQcPausePointsMigrationSql(): Promise<string> {
  return readFile(QC_PAUSE_POINTS_MIGRATION_URL, "utf8");
}

export async function loadQcGateAttentionTimingMigrationSql(): Promise<string> {
  return readFile(QC_GATE_ATTENTION_TIMING_MIGRATION_URL, "utf8");
}

export async function loadQcPauseResumeTransitionsMigrationSql(): Promise<string> {
  return readFile(QC_PAUSE_RESUME_TRANSITIONS_MIGRATION_URL, "utf8");
}

export async function loadQcAdjudicationMigrationSql(): Promise<string> {
  return readFile(QC_ADJUDICATION_MIGRATION_URL, "utf8");
}

export async function loadQcGateAAcceptNowMigrationSql(): Promise<string> {
  return readFile(QC_GATE_A_ACCEPT_NOW_MIGRATION_URL, "utf8");
}

export async function loadQcAttentionIndexMigrationSql(): Promise<string> {
  return readFile(QC_ATTENTION_INDEX_MIGRATION_URL, "utf8");
}

export async function loadQcSkipQcAcceptsInQcMigrationSql(): Promise<string> {
  return readFile(QC_SKIP_QC_ACCEPTS_IN_QC_MIGRATION_URL, "utf8");
}

export async function loadQcZeroRoundsMigrationSql(): Promise<string> {
  return readFile(QC_ZERO_ROUNDS_MIGRATION_URL, "utf8");
}

export async function loadQcLastHumanMessageMigrationSql(): Promise<string> {
  return readFile(QC_LAST_HUMAN_MESSAGE_MIGRATION_URL, "utf8");
}

export async function loadQcModeProvenanceMigrationSql(): Promise<string> {
  return readFile(QC_MODE_PROVENANCE_MIGRATION_URL, "utf8");
}

export async function loadQcPausedRoundBoundMigrationSql(): Promise<string> {
  return readFile(QC_PAUSED_ROUND_BOUND_MIGRATION_URL, "utf8");
}

export async function loadPlanningLiveProgressMigrationSql(): Promise<string> {
  return readFile(PLANNING_LIVE_PROGRESS_MIGRATION_URL, "utf8");
}

export async function loadQcRestartCheckpointsMigrationSql(): Promise<string> {
  return readFile(QC_RESTART_CHECKPOINTS_MIGRATION_URL, "utf8");
}

export async function loadQcTargetedRevisionsMigrationSql(): Promise<string> {
  return readFile(QC_TARGETED_REVISIONS_MIGRATION_URL, "utf8");
}

export async function loadQcFindingTriageMigrationSql(): Promise<string> {
  return readFile(QC_FINDING_TRIAGE_MIGRATION_URL, "utf8");
}

export async function loadQcRoutineRoundDefaultMigrationSql(): Promise<string> {
  return readFile(QC_ROUTINE_ROUND_DEFAULT_MIGRATION_URL, "utf8");
}

export async function loadDeepSeekProviderMigrationSql(): Promise<string> {
  return readFile(DEEPSEEK_PROVIDER_MIGRATION_URL, "utf8");
}

export async function loadProjectDestroyMigrationSql(): Promise<string> {
  return readFile(PROJECT_DESTROY_MIGRATION_URL, "utf8");
}

export async function loadHeldExecutionKickoffMigrationSql(): Promise<string> {
  return readFile(HELD_EXECUTION_KICKOFF_MIGRATION_URL, "utf8");
}

export async function loadQcTerminalFollowupChatMigrationSql(): Promise<string> {
  return readFile(QC_TERMINAL_FOLLOWUP_CHAT_MIGRATION_URL, "utf8");
}

export async function loadSonnetCachePricingCorrectionMigrationSql(): Promise<string> {
  return readFile(SONNET_CACHE_PRICING_CORRECTION_MIGRATION_URL, "utf8");
}

export function v2MigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export const phase1V2MigrationChecksum = v2MigrationChecksum;

async function executeMigrationBatch(tx: V2MigrationExecutor, sql: string): Promise<void> {
  if (tx.exec) {
    await tx.exec(sql);
    return;
  }
  await tx.query(sql);
}

/**
 * Opt-out marker: a migration whose SQL contains a `-- norns:no-transaction`
 * comment line runs outside `database.transaction(...)`. This exists so a
 * migration can use statements Postgres forbids inside a transaction block
 * (e.g. `CREATE INDEX CONCURRENTLY`) instead of falling back to a blocking
 * non-concurrent rebuild.
 *
 * Durability trade-off: without a transaction, the DDL and the
 * `norns_schema_migrations` tracking insert are two separate commits. If the
 * migration fails partway, the schema is left changed but untracked, so a
 * retry will run the same SQL again. A marked migration must therefore be
 * written idempotently (`IF NOT EXISTS` / `CREATE INDEX CONCURRENTLY IF NOT
 * EXISTS` / etc.) so re-running it after a partial failure is safe. That
 * idempotency is the migration author's responsibility — this runner does
 * not attempt to detect or repair a partial apply.
 *
 * Do not add this marker to any existing migration file, including 0066:
 * those are already applied in production, and editing their SQL changes
 * the checksum recorded in `norns_schema_migrations`, which aborts every
 * later run with a checksum-mismatch error. The marker is for migrations
 * written after this change only.
 */
const NO_TRANSACTION_MARKER = "-- norns:no-transaction";

function isNoTransactionMigration(sql: string): boolean {
  return sql.split("\n").some((line) => line.trim() === NO_TRANSACTION_MARKER);
}

/**
 * Applies an ordered forward-only migration list.
 *
 * Every migration and its tracking row commit atomically, unless the
 * migration opts out via `NO_TRANSACTION_MARKER` (see above). An
 * already-applied migration is replay-safe only when its source checksum is
 * unchanged.
 */
export async function runV2Migrations(
  database: V2MigrationDatabase,
  migrations: readonly V2MigrationSource[],
): Promise<V2MigrationResult[]> {
  await database.query(
    `CREATE TABLE IF NOT EXISTS norns_schema_migrations (
       name TEXT PRIMARY KEY,
       checksum TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const results: V2MigrationResult[] = [];
  for (const migration of migrations) {
    const checksum = v2MigrationChecksum(migration.sql);
    const result = isNoTransactionMigration(migration.sql)
      ? await runMigrationWithoutTransaction(database, migration, checksum)
      : await runMigrationInTransaction(database, migration, checksum);
    results.push(result);
  }
  return results;
}

async function runMigrationInTransaction(
  database: V2MigrationDatabase,
  migration: V2MigrationSource,
  checksum: string,
): Promise<V2MigrationResult> {
  return database.transaction(async (tx) => {
    const existing = await tx.query<AppliedMigrationRow>(
      "SELECT checksum FROM norns_schema_migrations WHERE name = $1 FOR UPDATE",
      [migration.name],
    );
    const applied = existing.rows[0];
    if (applied) {
      assertChecksumMatches(migration.name, applied.checksum, checksum);
      return { name: migration.name, checksum, applied: false };
    }

    await executeMigrationBatch(tx, migration.sql);
    await tx.query(
      `INSERT INTO norns_schema_migrations (name, checksum)
       VALUES ($1, $2)`,
      [migration.name, checksum],
    );

    return { name: migration.name, checksum, applied: true };
  });
}

async function runMigrationWithoutTransaction(
  database: V2MigrationDatabase,
  migration: V2MigrationSource,
  checksum: string,
): Promise<V2MigrationResult> {
  const existing = await database.query<AppliedMigrationRow>(
    "SELECT checksum FROM norns_schema_migrations WHERE name = $1",
    [migration.name],
  );
  const applied = existing.rows[0];
  if (applied) {
    assertChecksumMatches(migration.name, applied.checksum, checksum);
    return { name: migration.name, checksum, applied: false };
  }

  await executeMigrationBatch(database, migration.sql);
  await database.query(
    `INSERT INTO norns_schema_migrations (name, checksum)
     VALUES ($1, $2)`,
    [migration.name, checksum],
  );

  return { name: migration.name, checksum, applied: true };
}

function assertChecksumMatches(name: string, storedChecksum: string, sourceChecksum: string): void {
  if (storedChecksum !== sourceChecksum) {
    throw new Error(
      `migration ${name} checksum mismatch: database=${storedChecksum} source=${sourceChecksum}`,
    );
  }
}

/**
 * Backward-compatible Phase 1 wrapper used by the frozen Phase 1 evidence.
 */
export async function runPhase1V2Migration(
  database: V2MigrationDatabase,
  migrationSql?: string,
): Promise<V2MigrationResult> {
  const [result] = await runV2Migrations(database, [
    {
      name: PHASE1_V2_MIGRATION_NAME,
      sql: migrationSql ?? (await loadPhase1V2MigrationSql()),
    },
  ]);
  if (!result) throw new Error("Phase 1 migration runner produced no result");
  return result;
}

export async function runPhase2PreservationMigration(
  database: V2MigrationDatabase,
  migrationSql?: string,
): Promise<V2MigrationResult> {
  const [result] = await runV2Migrations(database, [
    {
      name: PHASE2_PRESERVATION_MIGRATION_NAME,
      sql: migrationSql ?? (await loadPhase2PreservationMigrationSql()),
    },
  ]);
  if (!result) throw new Error("Phase 2 migration runner produced no result");
  return result;
}

export async function runCurrentV2Migrations(
  database: V2MigrationDatabase,
): Promise<V2MigrationResult[]> {
  return runV2Migrations(database, await currentV2MigrationSources());
}

export async function currentV2MigrationSources(): Promise<V2MigrationSource[]> {
  return [
    {
      name: PHASE1_V2_MIGRATION_NAME,
      sql: await loadPhase1V2MigrationSql(),
    },
    {
      name: PHASE2_PRESERVATION_MIGRATION_NAME,
      sql: await loadPhase2PreservationMigrationSql(),
    },
    {
      name: PHASE3_SOURCE_BINDINGS_MIGRATION_NAME,
      sql: await loadPhase3SourceBindingsMigrationSql(),
    },
    {
      name: PHASE5_ATTENTION_MIGRATION_NAME,
      sql: await loadPhase5AttentionMigrationSql(),
    },
    {
      name: PHASE6_COORDINATION_MIGRATION_NAME,
      sql: await loadPhase6CoordinationMigrationSql(),
    },
    {
      name: PHASE7_HARDENING_MIGRATION_NAME,
      sql: await loadPhase7HardeningMigrationSql(),
    },
    {
      name: PHASE8_CUTOVER_COMPLETION_MIGRATION_NAME,
      sql: await loadPhase8CutoverCompletionMigrationSql(),
    },
    {
      name: WORKSPACE_CONNECTIONS_MIGRATION_NAME,
      sql: await loadWorkspaceConnectionsMigrationSql(),
    },
    {
      name: QC_COMMUNICATION_MIGRATION_NAME,
      sql: await loadQcCommunicationMigrationSql(),
    },
    {
      name: GITHUB_APP_MANIFEST_MIGRATION_NAME,
      sql: await loadGitHubAppManifestMigrationSql(),
    },
    {
      name: DEBATE_WORKFLOW_MIGRATION_NAME,
      sql: await loadDebateWorkflowMigrationSql(),
    },
    {
      name: PLANNING_RUNS_MIGRATION_NAME,
      sql: await loadPlanningRunsMigrationSql(),
    },
    {
      name: FRONTDOOR_PHASE_BRIDGE_MIGRATION_NAME,
      sql: await loadFrontDoorPhaseBridgeMigrationSql(),
    },
    {
      name: ATTACHMENTS_MIGRATION_NAME,
      sql: await loadAttachmentsMigrationSql(),
    },
    {
      name: FRONTDOOR_PROGRESS_TRACKING_MIGRATION_NAME,
      sql: await loadFrontDoorProgressTrackingMigrationSql(),
    },
    {
      name: ONBOARDING_BINDINGS_MIGRATION_NAME,
      sql: await loadOnboardingBindingsMigrationSql(),
    },
    {
      name: ACTIONS_EXECUTION_MIGRATION_NAME,
      sql: await loadActionsExecutionMigrationSql(),
    },
    {
      name: ONBOARDING_REPOSITORY_INTENTS_MIGRATION_NAME,
      sql: await loadOnboardingRepositoryIntentsMigrationSql(),
    },
    {
      name: TASK_CONTEXT_MIGRATION_NAME,
      sql: await loadTaskContextMigrationSql(),
    },
    {
      name: DISPATCH_CONTEXT_SCOPE_MIGRATION_NAME,
      sql: await loadDispatchContextScopeMigrationSql(),
    },
    {
      name: GATEWAY_CREDENTIALS_MIGRATION_NAME,
      sql: await loadGatewayCredentialsMigrationSql(),
    },
    {
      name: RUN_PUBLICATION_MIGRATION_NAME,
      sql: await loadRunPublicationMigrationSql(),
    },
    {
      name: ACTIONS_DISPATCH_RUNNER_IDENTITY_MIGRATION_NAME,
      sql: await loadActionsDispatchRunnerIdentityMigrationSql(),
    },
    {
      name: PHASE_CONCURRENCY_CONFLICTS_MIGRATION_NAME,
      sql: await loadPhaseConcurrencyConflictsMigrationSql(),
    },
    {
      name: PHASE_TAB_PLANNING_DECISIONS_MIGRATION_NAME,
      sql: await loadPhaseTabPlanningDecisionsMigrationSql(),
    },
    {
      name: QUICK_CHANGES_MIGRATION_NAME,
      sql: await loadQuickChangesMigrationSql(),
    },
    {
      name: KNOWLEDGE_PACKAGES_MIGRATION_NAME,
      sql: await loadKnowledgePackagesMigrationSql(),
    },
    {
      name: CODEX_REASONING_EFFORT_MIGRATION_NAME,
      sql: await loadCodexReasoningEffortMigrationSql(),
    },
    {
      name: GLOBAL_RULES_MIGRATION_NAME,
      sql: await loadGlobalRulesMigrationSql(),
    },
    {
      name: AI_USAGE_TELEMETRY_MIGRATION_NAME,
      sql: await loadAiUsageTelemetryMigrationSql(),
    },
    {
      name: PROJECT_ACCESS_ATTRIBUTION_MIGRATION_NAME,
      sql: await loadProjectAccessAttributionMigrationSql(),
    },
    {
      name: USAGE_INTELLIGENCE_POLICIES_MIGRATION_NAME,
      sql: await loadUsageIntelligencePoliciesMigrationSql(),
    },
    {
      name: USAGE_CALIBRATION_ANALYTICS_MIGRATION_NAME,
      sql: await loadUsageCalibrationAnalyticsMigrationSql(),
    },
    {
      name: SHADOW_EVIDENCE_ORDER_MIGRATION_NAME,
      sql: await loadShadowEvidenceOrderMigrationSql(),
    },
    {
      name: CONVERSATION_DOMAIN_MIGRATION_NAME,
      sql: await loadConversationDomainMigrationSql(),
    },
    {
      name: CONVERSATION_STREAM_LIFECYCLE_MIGRATION_NAME,
      sql: await loadConversationStreamLifecycleMigrationSql(),
    },
    {
      name: CONVERSATION_PLAN_WORKFLOW_MIGRATION_NAME,
      sql: await loadConversationPlanWorkflowMigrationSql(),
    },
    {
      name: CONVERSATION_EXECUTION_HANDOFF_MIGRATION_NAME,
      sql: await loadConversationExecutionHandoffMigrationSql(),
    },
    {
      name: CONVERSATION_HUMAN_STEERING_MIGRATION_NAME,
      sql: await loadConversationHumanSteeringMigrationSql(),
    },
    {
      name: CONVERSATION_MOCKUPS_DASHBOARD_MIGRATION_NAME,
      sql: await loadConversationMockupsDashboardMigrationSql(),
    },
    {
      name: PHASE6_RUNTIME_DELIVERY_MIGRATION_NAME,
      sql: await loadPhase6RuntimeDeliveryMigrationSql(),
    },
    {
      name: PHASE6_ACCEPTANCE_CORRECTIONS_MIGRATION_NAME,
      sql: await loadPhase6AcceptanceCorrectionsMigrationSql(),
    },
    {
      name: CONVERSATION_INFERENCE_BUDGET_MIGRATION_NAME,
      sql: await loadConversationInferenceBudgetMigrationSql(),
    },
    {
      name: ONBOARDING_INTENTS_UPDATE_GRANT_MIGRATION_NAME,
      sql: await loadOnboardingIntentsUpdateGrantMigrationSql(),
    },
    {
      name: GITHUB_CONNECTION_REMOVAL_MIGRATION_NAME,
      sql: await loadGitHubConnectionRemovalMigrationSql(),
    },
    {
      name: GITHUB_AUTHORIZATION_REMOVAL_MIGRATION_NAME,
      sql: await loadGitHubAuthorizationRemovalMigrationSql(),
    },
    {
      name: CONVERSATION_PLAN_HANDOFF_CHOICES_MIGRATION_NAME,
      sql: await loadConversationPlanHandoffChoicesMigrationSql(),
    },
    {
      name: CONVERSATION_MODEL_SWITCHING_MIGRATION_NAME,
      sql: await loadConversationModelSwitchingMigrationSql(),
    },
    {
      name: QC_CONTROL_TRANSCRIPT_MIGRATION_NAME,
      sql: await loadQcControlTranscriptMigrationSql(),
    },
    {
      name: CONVERSATION_ORGANIZATION_MIGRATION_NAME,
      sql: await loadConversationOrganizationMigrationSql(),
    },
    {
      name: CONVERSATION_FILE_ATTACHMENTS_MIGRATION_NAME,
      sql: await loadConversationFileAttachmentsMigrationSql(),
    },
    {
      name: CONVERSATION_MESSAGE_BRANCHES_MIGRATION_NAME,
      sql: await loadConversationMessageBranchesMigrationSql(),
    },
    {
      name: DEVICE_IDENTITY_CORE_MIGRATION_NAME,
      sql: await loadDeviceIdentityCoreMigrationSql(),
    },
    {
      name: DEVICE_HTTP_REQUEST_REPLAYS_MIGRATION_NAME,
      sql: await loadDeviceHttpRequestReplaysMigrationSql(),
    },
    {
      name: DEVICE_CANCELLATION_TRACKING_MIGRATION_NAME,
      sql: await loadDeviceCancellationTrackingMigrationSql(),
    },
    {
      name: GATEWAY_DEVICE_AUTHORIZATION_MIGRATION_NAME,
      sql: await loadGatewayDeviceAuthorizationMigrationSql(),
    },
    {
      name: DEVICE_MANAGEMENT_OBSERVATIONS_MIGRATION_NAME,
      sql: await loadDeviceManagementObservationsMigrationSql(),
    },
    {
      name: DEVICE_REPOSITORY_ACCESS_MIGRATION_NAME,
      sql: await loadDeviceRepositoryAccessMigrationSql(),
    },
    {
      name: PROJECT_RUN_CANCELLATION_MIGRATION_NAME,
      sql: await loadProjectRunCancellationMigrationSql(),
    },
    {
      name: LEGACY_REPOSITORY_BINDING_CLAIMS_MIGRATION_NAME,
      sql: await loadLegacyRepositoryBindingClaimsMigrationSql(),
    },
    {
      name: DEVICE_HTTP_OPERATION_PURPOSES_MIGRATION_NAME,
      sql: await loadDeviceHttpOperationPurposesMigrationSql(),
    },
    {
      name: QC_MARKDOWN_ARTIFACTS_MIGRATION_NAME,
      sql: await loadQcMarkdownArtifactsMigrationSql(),
    },
    {
      name: BINARY_ATTACHMENTS_MIGRATION_NAME,
      sql: await loadBinaryAttachmentsMigrationSql(),
    },
    {
      name: QC_PAUSE_POINTS_MIGRATION_NAME,
      sql: await loadQcPausePointsMigrationSql(),
    },
    {
      name: QC_GATE_ATTENTION_TIMING_MIGRATION_NAME,
      sql: await loadQcGateAttentionTimingMigrationSql(),
    },
    {
      name: QC_PAUSE_RESUME_TRANSITIONS_MIGRATION_NAME,
      sql: await loadQcPauseResumeTransitionsMigrationSql(),
    },
    {
      name: QC_ADJUDICATION_MIGRATION_NAME,
      sql: await loadQcAdjudicationMigrationSql(),
    },
    {
      name: QC_GATE_A_ACCEPT_NOW_MIGRATION_NAME,
      sql: await loadQcGateAAcceptNowMigrationSql(),
    },
    {
      name: QC_ATTENTION_INDEX_MIGRATION_NAME,
      sql: await loadQcAttentionIndexMigrationSql(),
    },
    {
      name: QC_SKIP_QC_ACCEPTS_IN_QC_MIGRATION_NAME,
      sql: await loadQcSkipQcAcceptsInQcMigrationSql(),
    },
    {
      name: QC_ZERO_ROUNDS_MIGRATION_NAME,
      sql: await loadQcZeroRoundsMigrationSql(),
    },
    {
      name: QC_LAST_HUMAN_MESSAGE_MIGRATION_NAME,
      sql: await loadQcLastHumanMessageMigrationSql(),
    },
    {
      name: QC_MODE_PROVENANCE_MIGRATION_NAME,
      sql: await loadQcModeProvenanceMigrationSql(),
    },
    {
      name: QC_PAUSED_ROUND_BOUND_MIGRATION_NAME,
      sql: await loadQcPausedRoundBoundMigrationSql(),
    },
    {
      name: PLANNING_LIVE_PROGRESS_MIGRATION_NAME,
      sql: await loadPlanningLiveProgressMigrationSql(),
    },
    {
      name: QC_RESTART_CHECKPOINTS_MIGRATION_NAME,
      sql: await loadQcRestartCheckpointsMigrationSql(),
    },
    {
      name: QC_TARGETED_REVISIONS_MIGRATION_NAME,
      sql: await loadQcTargetedRevisionsMigrationSql(),
    },
    {
      name: QC_FINDING_TRIAGE_MIGRATION_NAME,
      sql: await loadQcFindingTriageMigrationSql(),
    },
    {
      name: QC_ROUTINE_ROUND_DEFAULT_MIGRATION_NAME,
      sql: await loadQcRoutineRoundDefaultMigrationSql(),
    },
    {
      name: DEEPSEEK_PROVIDER_MIGRATION_NAME,
      sql: await loadDeepSeekProviderMigrationSql(),
    },
    {
      name: PROJECT_DESTROY_MIGRATION_NAME,
      sql: await loadProjectDestroyMigrationSql(),
    },
    {
      name: HELD_EXECUTION_KICKOFF_MIGRATION_NAME,
      sql: await loadHeldExecutionKickoffMigrationSql(),
    },
    {
      name: QC_TERMINAL_FOLLOWUP_CHAT_MIGRATION_NAME,
      sql: await loadQcTerminalFollowupChatMigrationSql(),
    },
    {
      name: SONNET_CACHE_PRICING_CORRECTION_MIGRATION_NAME,
      sql: await loadSonnetCachePricingCorrectionMigrationSql(),
    },
  ];
}
