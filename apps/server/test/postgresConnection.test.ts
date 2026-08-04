import { describe, expect, it } from "vitest";
import {
  assertCurrentRuntimeSchema,
  assertRestrictedRuntimeDatabase,
  isPrivatePostgresHostname,
  postgresPoolConfig,
} from "../src/persistence/postgresConnection.js";

describe("PostgreSQL connection security", () => {
  it("classifies only exact private hostnames and validates public TLS", () => {
    expect(isPrivatePostgresHostname("localhost")).toBe(true);
    expect(isPrivatePostgresHostname("db.railway.internal")).toBe(true);
    expect(isPrivatePostgresHostname("db.railway.internal.example.com")).toBe(false);

    expect(
      postgresPoolConfig("postgresql://localhost-in-password@public.example.com/norns").ssl,
    ).toEqual({ rejectUnauthorized: true });
    expect(
      postgresPoolConfig("postgresql://user:pass@db.railway.internal/norns").ssl,
    ).toBeUndefined();
    expect(postgresPoolConfig("postgresql://user:pass@127.0.0.1:5432/norns").ssl).toBeUndefined();
  });

  it("rejects archive keys in the ordinary application environment", async () => {
    await expect(
      assertRestrictedRuntimeDatabase(
        {
          query: async () => ({ rows: [] }),
        } as never,
        { NORNS_ARCHIVE_KEY: "secret" },
      ),
    ).rejects.toMatchObject({
      code: "archive_key_in_runtime",
    });
  });

  it("rejects privileged logins and proves archive ciphertext is denied", async () => {
    let calls = 0;
    const privileged = {
      query: async () => {
        calls += 1;
        if (calls === 1) return { rows: [{ relation: "legacy_snapshot_archives" }] };
        return {
          rows: [
            {
              rolname: "owner",
              rolsuper: true,
              rolcreatedb: false,
              rolcreaterole: false,
              rolreplication: false,
              rolbypassrls: false,
              can_set_runtime_role: true,
            },
          ],
        };
      },
    };
    await expect(assertRestrictedRuntimeDatabase(privileged as never, {})).rejects.toMatchObject({
      code: "privileged_runtime_login",
    });

    calls = 0;
    const restricted = {
      query: async () => {
        calls += 1;
        if (calls === 1) return { rows: [{ relation: "legacy_snapshot_archives" }] };
        if (calls === 2) {
          return {
            rows: [
              {
                rolname: "norns_runtime",
                rolsuper: false,
                rolcreatedb: false,
                rolcreaterole: false,
                rolreplication: false,
                rolbypassrls: false,
                can_set_runtime_role: true,
              },
            ],
          };
        }
        throw Object.assign(new Error("permission denied for table legacy_snapshot_archives"), {
          code: "42501",
        });
      },
    };
    await expect(assertRestrictedRuntimeDatabase(restricted as never, {})).resolves.toBeUndefined();
  });
});

const currentRuntimeSchemaPosture = {
  planning_mode: true,
  knowledge_packages: "knowledge_packages",
  agent_execution_registrations: "agent_execution_registrations",
  agent_handoffs: "agent_handoffs",
  knowledge_deltas: "knowledge_deltas",
  agent_reasoning_effort: true,
  global_rule_settings: "global_rule_settings",
  ai_usage_events: "ai_usage_events",
  project_owner_user_id: true,
  project_members: "project_members",
  usage_budget_policies: "usage_budget_policies",
  ai_usage_calibration_observations: "ai_usage_calibration_observations",
  shadow_read_recorded_order: true,
  onboarding_submissions: "project_onboarding_submissions",
  onboarding_repository_intents: "project_onboarding_repository_intents",
  onboarding_candidate_columns: true,
  conversation_domain_complete: true,
  conversation_stream_lifecycle: "conversation_stream_lifecycle_v1",
  conversation_plan_workflow: "conversation_plan_workflow_v1",
  conversation_execution_handoff: "conversation_execution_handoff_v1",
  conversation_human_steering: "conversation_human_steering_v1",
  conversation_mockups_dashboard: "conversation_mockups_dashboard_v1",
  conversation_inference_reservations: "conversation_inference_reservations",
  conversation_plan_review_mode: true,
  conversation_organization: "conversation_organization_v1",
  conversation_message_branches: "conversation_message_branches_v1",
  devices: "devices",
  device_credentials: "device_credentials",
  device_authorization_requests: "device_authorization_requests",
  device_repository_registrations: "device_repository_registrations",
  project_device_repository_grants: "project_device_repository_grants",
  legacy_repository_binding_claims: "legacy_repository_binding_claims",
  device_http_request_replays: "device_http_request_replays",
  dispatch_context_runner_generation: true,
  dispatch_context_revoked_at: true,
  device_run_cancellations: "device_run_cancellations",
  device_run_cancellation_idempotency_key: true,
  device_revocations: "device_revocations",
  gateway_authentication_subject: true,
  gateway_device_credential_id: true,
  device_os_version: true,
  device_agent_version: true,
  device_agent_protocol_version: true,
  device_agent_capabilities: true,
  device_last_seen_at: true,
  device_publication_permits: "device_publication_permits",
  qc_pause_points_columns: true,
  work_plan_version_origin: true,
  qc_adjudication_columns: true,
  qc_last_human_message_at: true,
  qc_mode_provenance_columns: true,
  planning_live_progress_columns: true,
  qc_restart_checkpoint_columns: true,
  qc_revision_format_column: true,
  qc_finding_decisions_column: true,
  conversation_kickoff_status_supports_held: true,
  conversation_kickoff_lifecycle_supports_held: true,
} as const;

describe("PostgreSQL runtime schema compatibility", () => {
  it("accepts the complete current runtime schema", async () => {
    const compatible = {
      query: async () => ({
        rows: [currentRuntimeSchemaPosture],
      }),
    };

    await expect(assertCurrentRuntimeSchema(compatible as never)).resolves.toBeUndefined();
  });

  it("refuses kickoff constraints that predate held execution intents", async () => {
    const oldKickoffConstraints = {
      query: async () => ({
        rows: [
          {
            ...currentRuntimeSchemaPosture,
            conversation_kickoff_status_supports_held: false,
            conversation_kickoff_lifecycle_supports_held: false,
          },
        ],
      }),
    };

    await expect(assertCurrentRuntimeSchema(oldKickoffConstraints as never)).rejects.toMatchObject({
      code: "runtime_schema_outdated",
    });
    await expect(assertCurrentRuntimeSchema(oldKickoffConstraints as never)).rejects.toThrow(
      /conversation_kickoff_intents_status_check \(must allow held\)/,
    );
    await expect(assertCurrentRuntimeSchema(oldKickoffConstraints as never)).rejects.toThrow(
      /conversation_kickoff_intents_lifecycle_check \(must allow held\)/,
    );
  });

  it("refuses to start when the QC pause-point migrations have not been applied", async () => {
    // Regression: 0064-0068 shipped without extending this posture check, so a
    // database that had every earlier migration still booted and then failed
    // mid-session with `column "origin" does not exist` on the first plan read.
    const missingQcPausePoints = {
      query: async () => ({
        rows: [
          {
            qc_pause_points_columns: false,
            work_plan_version_origin: false,
            qc_adjudication_columns: false,
          },
        ],
      }),
    };

    await expect(assertCurrentRuntimeSchema(missingQcPausePoints as never)).rejects.toMatchObject({
      code: "runtime_schema_outdated",
    });
    await expect(assertCurrentRuntimeSchema(missingQcPausePoints as never)).rejects.toThrow(
      /work_plan_versions\.origin/,
    );
    // The message must name the fix, not just the symptom.
    await expect(assertCurrentRuntimeSchema(missingQcPausePoints as never)).rejects.toThrow(
      /applyMigrations\.js/,
    );
  });

  it("fails closed with the exact missing runtime schema surfaces", async () => {
    const outdated = {
      query: async () => ({
        rows: [
          {
            planning_mode: false,
            knowledge_packages: null,
            agent_execution_registrations: "agent_execution_registrations",
            agent_handoffs: null,
            knowledge_deltas: "knowledge_deltas",
            agent_reasoning_effort: false,
            global_rule_settings: "global_rule_settings",
            ai_usage_events: null,
            project_owner_user_id: true,
            project_members: null,
            usage_budget_policies: "usage_budget_policies",
            ai_usage_calibration_observations: null,
            shadow_read_recorded_order: false,
            onboarding_submissions: "project_onboarding_submissions",
            onboarding_repository_intents: null,
            onboarding_candidate_columns: false,
            conversation_domain_complete: false,
            conversation_stream_lifecycle: null,
            conversation_plan_workflow: null,
            conversation_execution_handoff: null,
            conversation_human_steering: null,
            conversation_mockups_dashboard: null,
            conversation_inference_reservations: null,
            conversation_plan_review_mode: false,
            conversation_organization: null,
            conversation_message_branches: null,
            devices: null,
            device_credentials: null,
            device_authorization_requests: null,
            device_repository_registrations: null,
            project_device_repository_grants: null,
            legacy_repository_binding_claims: null,
            device_http_request_replays: null,
            dispatch_context_runner_generation: false,
            dispatch_context_revoked_at: false,
            device_run_cancellations: null,
            device_run_cancellation_idempotency_key: false,
            device_revocations: null,
            gateway_authentication_subject: false,
            gateway_device_credential_id: false,
            device_os_version: false,
            device_agent_version: false,
            device_agent_protocol_version: false,
            device_agent_capabilities: false,
            device_last_seen_at: false,
            device_publication_permits: null,
          },
        ],
      }),
    };

    await expect(assertCurrentRuntimeSchema(outdated as never)).rejects.toMatchObject({
      code: "runtime_schema_outdated",
      message:
        "database migrations are required before startup; missing: " +
        "planning_runs.mode, knowledge_packages, agent_handoffs, " +
        "agent_profiles.reasoning_effort, ai_usage_events, project_members, " +
        "ai_usage_calibration_observations, shadow_read_comparisons.recorded_order, " +
        "project_onboarding_repository_intents, " +
        "repository_binding_candidates onboarding columns, " +
        "conversation domain tables, conversation_stream_lifecycle_v1, " +
        "conversation_plan_workflow_v1, conversation_execution_handoff_v1, " +
        "conversation_human_steering_v1, conversation_mockups_dashboard_v1, " +
        "conversation_inference_reservations, conversation_plan_reviews.review_mode, " +
        "conversation_organization_v1, conversation_message_branches_v1, devices, " +
        "device_credentials, device_authorization_requests, " +
        "device_repository_registrations, project_device_repository_grants, " +
        "legacy_repository_binding_claims, device_http_request_replays, " +
        "dispatch_context_documents.runner_generation, " +
        "dispatch_context_documents.revoked_at, device_run_cancellations, " +
        "device_run_cancellations.idempotency_key, device_revocations, " +
        "gateway_credentials.authentication_subject, gateway_credentials.device_credential_id, " +
        "devices.os_version, devices.agent_version, devices.agent_protocol_version, " +
        "devices.agent_capabilities, devices.last_seen_at, device_publication_permits, " +
        "conversation_plan_reviews QC pause columns, work_plan_versions.origin, " +
        "conversation_plan_reviews adjudication columns, " +
        "conversation_plan_reviews.last_human_message_at, " +
        "conversation_plan_reviews qc_mode provenance columns, planning live_progress columns, " +
        "QC restart checkpoint columns, conversation_plan_reviews.revision_format, " +
        "conversation_plan_reviews.finding_decisions, " +
        "conversation_kickoff_intents_status_check (must allow held), " +
        "conversation_kickoff_intents_lifecycle_check (must allow held). " +
        "Apply them with: node apps/server/dist/applyMigrations.js (DATABASE_URL must be set).",
    });
  });

  it("fails closed on a 0035-only conversation schema without the 0036 marker", async () => {
    const phase1ConversationOnly = {
      query: async () => ({
        rows: [
          {
            planning_mode: true,
            knowledge_packages: "knowledge_packages",
            agent_execution_registrations: "agent_execution_registrations",
            agent_handoffs: "agent_handoffs",
            knowledge_deltas: "knowledge_deltas",
            agent_reasoning_effort: true,
            global_rule_settings: "global_rule_settings",
            ai_usage_events: "ai_usage_events",
            project_owner_user_id: true,
            project_members: "project_members",
            usage_budget_policies: "usage_budget_policies",
            ai_usage_calibration_observations: "ai_usage_calibration_observations",
            shadow_read_recorded_order: true,
            onboarding_submissions: "project_onboarding_submissions",
            onboarding_repository_intents: "project_onboarding_repository_intents",
            onboarding_candidate_columns: true,
            conversation_domain_complete: true,
            conversation_stream_lifecycle: null,
            conversation_plan_workflow: null,
            conversation_execution_handoff: null,
            conversation_human_steering: null,
            conversation_mockups_dashboard: null,
            conversation_inference_reservations: null,
            conversation_plan_review_mode: false,
            conversation_organization: null,
            conversation_message_branches: null,
            devices: "devices",
            device_credentials: "device_credentials",
            device_authorization_requests: "device_authorization_requests",
            device_repository_registrations: "device_repository_registrations",
            project_device_repository_grants: "project_device_repository_grants",
            legacy_repository_binding_claims: "legacy_repository_binding_claims",
            device_http_request_replays: "device_http_request_replays",
            dispatch_context_runner_generation: true,
            dispatch_context_revoked_at: true,
            device_run_cancellations: "device_run_cancellations",
            device_run_cancellation_idempotency_key: true,
            device_revocations: "device_revocations",
            gateway_authentication_subject: true,
            gateway_device_credential_id: true,
            device_os_version: true,
            device_agent_version: true,
            device_agent_protocol_version: true,
            device_agent_capabilities: true,
            device_last_seen_at: true,
            device_publication_permits: "device_publication_permits",
          },
        ],
      }),
    };

    await expect(assertCurrentRuntimeSchema(phase1ConversationOnly as never)).rejects.toMatchObject(
      {
        code: "runtime_schema_outdated",
        message:
          "database migrations are required before startup; missing: " +
          "conversation_stream_lifecycle_v1, conversation_plan_workflow_v1, " +
          "conversation_execution_handoff_v1, conversation_human_steering_v1, " +
          "conversation_mockups_dashboard_v1, conversation_inference_reservations, " +
          "conversation_plan_reviews.review_mode, conversation_organization_v1, " +
          "conversation_message_branches_v1, " +
          "conversation_plan_reviews QC pause columns, work_plan_versions.origin, " +
          "conversation_plan_reviews adjudication columns, " +
          "conversation_plan_reviews.last_human_message_at, " +
          "conversation_plan_reviews qc_mode provenance columns, planning live_progress columns, " +
          "QC restart checkpoint columns, conversation_plan_reviews.revision_format, " +
          "conversation_plan_reviews.finding_decisions, " +
          "conversation_kickoff_intents_status_check (must allow held), " +
          "conversation_kickoff_intents_lifecycle_check (must allow held). " +
          "Apply them with: node apps/server/dist/applyMigrations.js (DATABASE_URL must be set).",
      },
    );
  });

  it("fails closed with precise 0053 through 0060 device migration diagnostics", async () => {
    const preDeviceMigrations = {
      query: async () => ({
        rows: [
          {
            planning_mode: true,
            knowledge_packages: "knowledge_packages",
            agent_execution_registrations: "agent_execution_registrations",
            agent_handoffs: "agent_handoffs",
            knowledge_deltas: "knowledge_deltas",
            agent_reasoning_effort: true,
            global_rule_settings: "global_rule_settings",
            ai_usage_events: "ai_usage_events",
            project_owner_user_id: true,
            project_members: "project_members",
            usage_budget_policies: "usage_budget_policies",
            ai_usage_calibration_observations: "ai_usage_calibration_observations",
            shadow_read_recorded_order: true,
            onboarding_submissions: "project_onboarding_submissions",
            onboarding_repository_intents: "project_onboarding_repository_intents",
            onboarding_candidate_columns: true,
            conversation_domain_complete: true,
            conversation_stream_lifecycle: "conversation_stream_lifecycle_v1",
            conversation_plan_workflow: "conversation_plan_workflow_v1",
            conversation_execution_handoff: "conversation_execution_handoff_v1",
            conversation_human_steering: "conversation_human_steering_v1",
            conversation_mockups_dashboard: "conversation_mockups_dashboard_v1",
            conversation_inference_reservations: "conversation_inference_reservations",
            conversation_plan_review_mode: true,
            conversation_organization: "conversation_organization_v1",
            conversation_message_branches: "conversation_message_branches_v1",
            devices: null,
            device_credentials: null,
            device_authorization_requests: null,
            device_repository_registrations: null,
            project_device_repository_grants: null,
            legacy_repository_binding_claims: null,
            device_http_request_replays: null,
            dispatch_context_runner_generation: false,
            dispatch_context_revoked_at: false,
            device_run_cancellations: null,
            device_run_cancellation_idempotency_key: false,
            device_revocations: null,
            gateway_authentication_subject: false,
            gateway_device_credential_id: false,
            device_os_version: false,
            device_agent_version: false,
            device_agent_protocol_version: false,
            device_agent_capabilities: false,
            device_last_seen_at: false,
            device_publication_permits: null,
          },
        ],
      }),
    };

    await expect(assertCurrentRuntimeSchema(preDeviceMigrations as never)).rejects.toMatchObject({
      code: "runtime_schema_outdated",
      message:
        "database migrations are required before startup; missing: devices, " +
        "device_credentials, device_authorization_requests, " +
        "device_repository_registrations, project_device_repository_grants, " +
        "legacy_repository_binding_claims, device_http_request_replays, " +
        "dispatch_context_documents.runner_generation, " +
        "dispatch_context_documents.revoked_at, device_run_cancellations, " +
        "device_run_cancellations.idempotency_key, device_revocations, " +
        "gateway_credentials.authentication_subject, gateway_credentials.device_credential_id, " +
        "devices.os_version, devices.agent_version, devices.agent_protocol_version, " +
        "devices.agent_capabilities, devices.last_seen_at, device_publication_permits, " +
        "conversation_plan_reviews QC pause columns, work_plan_versions.origin, " +
        "conversation_plan_reviews adjudication columns, " +
        "conversation_plan_reviews.last_human_message_at, " +
        "conversation_plan_reviews qc_mode provenance columns, planning live_progress columns, " +
        "QC restart checkpoint columns, conversation_plan_reviews.revision_format, " +
        "conversation_plan_reviews.finding_decisions, " +
        "conversation_kickoff_intents_status_check (must allow held), " +
        "conversation_kickoff_intents_lifecycle_check (must allow held). " +
        "Apply them with: node apps/server/dist/applyMigrations.js (DATABASE_URL must be set).",
    });
  });

  it("fails closed when QC restart checkpoint columns are missing", async () => {
    const missingRestartCheckpoints = {
      query: async () => ({
        rows: [{ qc_restart_checkpoint_columns: false }],
      }),
    };

    await expect(
      assertCurrentRuntimeSchema(missingRestartCheckpoints as never),
    ).rejects.toMatchObject({
      code: "runtime_schema_outdated",
    });
    await expect(assertCurrentRuntimeSchema(missingRestartCheckpoints as never)).rejects.toThrow(
      /QC restart checkpoint columns/,
    );
  });

  it("fails closed when the pinned QC revision format column is missing", async () => {
    const missingRevisionFormat = {
      query: async () => ({
        rows: [
          {
            qc_restart_checkpoint_columns: true,
            qc_revision_format_column: false,
          },
        ],
      }),
    };

    await expect(assertCurrentRuntimeSchema(missingRevisionFormat as never)).rejects.toThrow(
      /conversation_plan_reviews\.revision_format/,
    );
  });

  it("fails closed when QC finding triage has not been migrated", async () => {
    const missingFindingDecisions = {
      query: async () => ({
        rows: [
          {
            qc_revision_format_column: true,
            qc_finding_decisions_column: false,
          },
        ],
      }),
    };

    await expect(assertCurrentRuntimeSchema(missingFindingDecisions as never)).rejects.toThrow(
      /conversation_plan_reviews\.finding_decisions/,
    );
  });
});
