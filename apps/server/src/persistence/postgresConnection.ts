import type { Pool, PoolConfig } from "pg";

const PRIVATE_POSTGRES_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export class PostgresConnectionConfigurationError extends Error {
  constructor(
    readonly code:
      | "invalid_database_url"
      | "privileged_runtime_login"
      | "runtime_role_unavailable"
      | "runtime_schema_outdated"
      | "archive_ciphertext_visible"
      | "archive_key_in_runtime",
    message: string,
  ) {
    super(message);
    this.name = "PostgresConnectionConfigurationError";
  }
}

function parsedDatabaseUrl(databaseUrl: string): URL {
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }
    return parsed;
  } catch {
    throw new PostgresConnectionConfigurationError(
      "invalid_database_url",
      "database URL must be an absolute postgres:// or postgresql:// URL",
    );
  }
}

export function isPrivatePostgresHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    PRIVATE_POSTGRES_HOSTS.has(normalized) ||
    normalized === "railway.internal" ||
    normalized.endsWith(".railway.internal")
  );
}

/**
 * Public PostgreSQL endpoints use the platform trust store and hostname
 * verification. Only exact loopback and Railway-private DNS names disable
 * TLS; credentials or query text can never affect the classification.
 */
export function postgresPoolConfig(databaseUrl: string): PoolConfig {
  const parsed = parsedDatabaseUrl(databaseUrl);
  return {
    connectionString: databaseUrl,
    ...(isPrivatePostgresHostname(parsed.hostname)
      ? {}
      : {
          ssl: {
            rejectUnauthorized: true,
          },
        }),
  };
}

interface RuntimeLoginPosture {
  rolname: string;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  can_set_runtime_role: boolean;
}

function assertArchiveKeyAbsent(environment: NodeJS.ProcessEnv): void {
  const forbidden = ["NORNS_ARCHIVE_KEY", "NORNS_ARCHIVE_KEY_ID", "NORNS_ARCHIVE_KEYRING"].filter(
    (name) => Boolean(environment[name]?.trim()),
  );
  if (forbidden.length > 0) {
    throw new PostgresConnectionConfigurationError(
      "archive_key_in_runtime",
      `ordinary application startup refuses archive key variables: ${forbidden.join(", ")}`,
    );
  }
}

interface RuntimeSchemaPosture {
  planning_mode: boolean;
  knowledge_packages: string | null;
  agent_execution_registrations: string | null;
  agent_handoffs: string | null;
  knowledge_deltas: string | null;
  agent_reasoning_effort: boolean;
  global_rule_settings: string | null;
  ai_usage_events: string | null;
  project_owner_user_id: boolean;
  project_members: string | null;
  usage_budget_policies: string | null;
  ai_usage_calibration_observations: string | null;
  shadow_read_recorded_order: boolean;
  onboarding_submissions: string | null;
  onboarding_repository_intents: string | null;
  onboarding_candidate_columns: boolean;
  conversation_domain_complete: boolean;
  conversation_stream_lifecycle: string | null;
  conversation_plan_workflow: string | null;
  conversation_execution_handoff: string | null;
  conversation_human_steering: string | null;
  conversation_mockups_dashboard: string | null;
  conversation_inference_reservations: string | null;
  conversation_plan_review_mode: boolean;
  conversation_organization: string | null;
  conversation_message_branches: string | null;
  devices: string | null;
  device_credentials: string | null;
  device_authorization_requests: string | null;
  device_repository_registrations: string | null;
  project_device_repository_grants: string | null;
  legacy_repository_binding_claims: string | null;
  device_http_request_replays: string | null;
  dispatch_context_runner_generation: boolean;
  dispatch_context_revoked_at: boolean;
  device_run_cancellations: string | null;
  device_run_cancellation_idempotency_key: boolean;
  device_revocations: string | null;
  gateway_authentication_subject: boolean;
  gateway_device_credential_id: boolean;
  device_os_version: boolean;
  device_agent_version: boolean;
  device_agent_protocol_version: boolean;
  device_agent_capabilities: boolean;
  device_last_seen_at: boolean;
  device_publication_permits: string | null;
  qc_pause_points_columns: boolean;
  work_plan_version_origin: boolean;
  qc_adjudication_columns: boolean;
  qc_last_human_message_at: boolean;
  qc_mode_provenance_columns: boolean;
  planning_live_progress_columns: boolean;
}

/**
 * Refuses to serve a build against a database that has not received the
 * additive migrations required by its runtime paths. The ordinary application
 * role intentionally cannot read the migration ledger, so compatibility is
 * proven from the exact relations and columns the build needs.
 */
export async function assertCurrentRuntimeSchema(pool: Pick<Pool, "query">): Promise<void> {
  const result = await pool.query<RuntimeSchemaPosture>(
    `SELECT EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='planning_runs'
                 AND column_name='mode'
            ) AS planning_mode,
            to_regclass('public.knowledge_packages')::text AS knowledge_packages,
            to_regclass('public.agent_execution_registrations')::text
              AS agent_execution_registrations,
            to_regclass('public.agent_handoffs')::text AS agent_handoffs,
            to_regclass('public.knowledge_deltas')::text AS knowledge_deltas,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='agent_profiles'
                 AND column_name='reasoning_effort'
            ) AS agent_reasoning_effort,
            to_regclass('public.global_rule_settings')::text AS global_rule_settings,
            to_regclass('public.ai_usage_events')::text AS ai_usage_events,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='projects'
                 AND column_name='owner_user_id'
            ) AS project_owner_user_id,
            to_regclass('public.project_members')::text AS project_members,
            to_regclass('public.usage_budget_policies')::text AS usage_budget_policies,
            to_regclass('public.ai_usage_calibration_observations')::text
              AS ai_usage_calibration_observations,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='shadow_read_comparisons'
                 AND column_name='recorded_order'
            ) AS shadow_read_recorded_order,
            to_regclass('public.project_onboarding_submissions')::text
              AS onboarding_submissions,
            to_regclass('public.project_onboarding_repository_intents')::text
              AS onboarding_repository_intents,
            (
              SELECT count(*) = 6
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='repository_binding_candidates'
                 AND column_name IN (
                   'role',
                   'installation_ready',
                   'workflow_installed',
                   'service_connection_id',
                   'push_credential_strategy',
                   'remote_provisioning'
                 )
            ) AS onboarding_candidate_columns,
            (
              SELECT count(*) = 9
                FROM unnest(ARRAY[
                  'work_items',
                  'work_conversations',
                  'work_messages',
                  'work_message_attachment_refs',
                  'conversation_turn_attempts',
                  'conversation_actions',
                  'work_plan_versions',
                  'conversation_handoffs',
                  'conversation_summaries'
                ]) AS required_table(name)
               WHERE to_regclass('public.' || required_table.name) IS NOT NULL
            ) AS conversation_domain_complete,
            to_regclass('public.conversation_stream_lifecycle_v1')::text
              AS conversation_stream_lifecycle,
            to_regclass('public.conversation_plan_workflow_v1')::text
              AS conversation_plan_workflow,
            to_regclass('public.conversation_execution_handoff_v1')::text
              AS conversation_execution_handoff,
            to_regclass('public.conversation_human_steering_v1')::text
              AS conversation_human_steering,
            to_regclass('public.conversation_mockups_dashboard_v1')::text
              AS conversation_mockups_dashboard,
            to_regclass('public.conversation_inference_reservations')::text
              AS conversation_inference_reservations,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='conversation_plan_reviews'
                 AND column_name='review_mode'
            ) AS conversation_plan_review_mode,
            to_regclass('public.conversation_organization_v1')::text
              AS conversation_organization,
            to_regclass('public.conversation_message_branches_v1')::text
              AS conversation_message_branches,
            to_regclass('public.devices')::text AS devices,
            to_regclass('public.device_credentials')::text AS device_credentials,
            to_regclass('public.device_authorization_requests')::text
              AS device_authorization_requests,
            to_regclass('public.device_repository_registrations')::text
              AS device_repository_registrations,
            to_regclass('public.project_device_repository_grants')::text
              AS project_device_repository_grants,
            to_regclass('public.legacy_repository_binding_claims')::text
              AS legacy_repository_binding_claims,
            to_regclass('public.device_http_request_replays')::text
              AS device_http_request_replays,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='dispatch_context_documents'
                 AND column_name='runner_generation'
            ) AS dispatch_context_runner_generation,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='dispatch_context_documents'
                 AND column_name='revoked_at'
            ) AS dispatch_context_revoked_at,
            to_regclass('public.device_run_cancellations')::text
              AS device_run_cancellations,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='device_run_cancellations'
                 AND column_name='idempotency_key'
            ) AS device_run_cancellation_idempotency_key,
            to_regclass('public.device_revocations')::text AS device_revocations,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='gateway_credentials'
                 AND column_name='authentication_subject'
            ) AS gateway_authentication_subject,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='gateway_credentials'
                 AND column_name='device_credential_id'
            ) AS gateway_device_credential_id,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='devices'
                 AND column_name='os_version'
            ) AS device_os_version,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='devices'
                 AND column_name='agent_version'
            ) AS device_agent_version,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='devices'
                 AND column_name='agent_protocol_version'
            ) AS device_agent_protocol_version,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='devices'
                 AND column_name='agent_capabilities'
            ) AS device_agent_capabilities,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='devices'
                 AND column_name='last_seen_at'
            ) AS device_last_seen_at,
            to_regclass('public.device_publication_permits')::text
              AS device_publication_permits,
            (
              SELECT count(*) = 6
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='conversation_plan_reviews'
                 AND column_name IN (
                   'paused_checkpoint',
                   'paused_at_round',
                   'qc_mode',
                   'qc_mode_source',
                   'allow_unadjudicated_rebuttals',
                   'human_steered_rounds'
                 )
            ) AS qc_pause_points_columns,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='work_plan_versions'
                 AND column_name='origin'
            ) AS work_plan_version_origin,
            (
              SELECT count(*) = 3
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='conversation_plan_reviews'
                 AND column_name IN (
                   'adjudications',
                   'forced_accept_module_ids',
                   'adjudication_idempotency_key'
                 )
            ) AS qc_adjudication_columns,
            EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='conversation_plan_reviews'
                 AND column_name='last_human_message_at'
            ) AS qc_last_human_message_at,
            (
              SELECT count(*) = 2
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='conversation_plan_reviews'
                 AND column_name IN (
                   'qc_mode_changed_at_round',
                   'qc_mode_changed_by_user_id'
                 )
            ) AS qc_mode_provenance_columns,
            (
              SELECT count(*) = 2
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND column_name='live_progress'
                 AND table_name IN ('planning_runs', 'conversation_plan_proposal_attempts')
            ) AS planning_live_progress_columns`,
  );
  const posture = result.rows[0];
  const missing = [
    ...(!posture?.planning_mode ? ["planning_runs.mode"] : []),
    ...(!posture?.knowledge_packages ? ["knowledge_packages"] : []),
    ...(!posture?.agent_execution_registrations ? ["agent_execution_registrations"] : []),
    ...(!posture?.agent_handoffs ? ["agent_handoffs"] : []),
    ...(!posture?.knowledge_deltas ? ["knowledge_deltas"] : []),
    ...(!posture?.agent_reasoning_effort ? ["agent_profiles.reasoning_effort"] : []),
    ...(!posture?.global_rule_settings ? ["global_rule_settings"] : []),
    ...(!posture?.ai_usage_events ? ["ai_usage_events"] : []),
    ...(!posture?.project_owner_user_id ? ["projects.owner_user_id"] : []),
    ...(!posture?.project_members ? ["project_members"] : []),
    ...(!posture?.usage_budget_policies ? ["usage_budget_policies"] : []),
    ...(!posture?.ai_usage_calibration_observations ? ["ai_usage_calibration_observations"] : []),
    ...(!posture?.shadow_read_recorded_order ? ["shadow_read_comparisons.recorded_order"] : []),
    ...(!posture?.onboarding_submissions ? ["project_onboarding_submissions"] : []),
    ...(!posture?.onboarding_repository_intents ? ["project_onboarding_repository_intents"] : []),
    ...(!posture?.onboarding_candidate_columns
      ? ["repository_binding_candidates onboarding columns"]
      : []),
    ...(!posture?.conversation_domain_complete ? ["conversation domain tables"] : []),
    ...(!posture?.conversation_stream_lifecycle ? ["conversation_stream_lifecycle_v1"] : []),
    ...(!posture?.conversation_plan_workflow ? ["conversation_plan_workflow_v1"] : []),
    ...(!posture?.conversation_execution_handoff ? ["conversation_execution_handoff_v1"] : []),
    ...(!posture?.conversation_human_steering ? ["conversation_human_steering_v1"] : []),
    ...(!posture?.conversation_mockups_dashboard ? ["conversation_mockups_dashboard_v1"] : []),
    ...(!posture?.conversation_inference_reservations
      ? ["conversation_inference_reservations"]
      : []),
    ...(!posture?.conversation_plan_review_mode ? ["conversation_plan_reviews.review_mode"] : []),
    ...(!posture?.conversation_organization ? ["conversation_organization_v1"] : []),
    ...(!posture?.conversation_message_branches ? ["conversation_message_branches_v1"] : []),
    ...(!posture?.devices ? ["devices"] : []),
    ...(!posture?.device_credentials ? ["device_credentials"] : []),
    ...(!posture?.device_authorization_requests ? ["device_authorization_requests"] : []),
    ...(!posture?.device_repository_registrations ? ["device_repository_registrations"] : []),
    ...(!posture?.project_device_repository_grants ? ["project_device_repository_grants"] : []),
    ...(!posture?.legacy_repository_binding_claims ? ["legacy_repository_binding_claims"] : []),
    ...(!posture?.device_http_request_replays ? ["device_http_request_replays"] : []),
    ...(!posture?.dispatch_context_runner_generation
      ? ["dispatch_context_documents.runner_generation"]
      : []),
    ...(!posture?.dispatch_context_revoked_at ? ["dispatch_context_documents.revoked_at"] : []),
    ...(!posture?.device_run_cancellations ? ["device_run_cancellations"] : []),
    ...(!posture?.device_run_cancellation_idempotency_key
      ? ["device_run_cancellations.idempotency_key"]
      : []),
    ...(!posture?.device_revocations ? ["device_revocations"] : []),
    ...(!posture?.gateway_authentication_subject
      ? ["gateway_credentials.authentication_subject"]
      : []),
    ...(!posture?.gateway_device_credential_id ? ["gateway_credentials.device_credential_id"] : []),
    ...(!posture?.device_os_version ? ["devices.os_version"] : []),
    ...(!posture?.device_agent_version ? ["devices.agent_version"] : []),
    ...(!posture?.device_agent_protocol_version ? ["devices.agent_protocol_version"] : []),
    ...(!posture?.device_agent_capabilities ? ["devices.agent_capabilities"] : []),
    ...(!posture?.device_last_seen_at ? ["devices.last_seen_at"] : []),
    ...(!posture?.device_publication_permits ? ["device_publication_permits"] : []),
    // QC pause points (0064-0068). Every conversation detail read selects
    // work_plan_versions.origin, so a database missing these fails at the
    // first plan request rather than at startup unless it is checked here.
    ...(!posture?.qc_pause_points_columns ? ["conversation_plan_reviews QC pause columns"] : []),
    ...(!posture?.work_plan_version_origin ? ["work_plan_versions.origin"] : []),
    ...(!posture?.qc_adjudication_columns
      ? ["conversation_plan_reviews adjudication columns"]
      : []),
    // 0072/0073. The attention read model selects last_human_message_at on
    // every poll, so a database missing it degrades the portfolio to "showing
    // last known data" rather than failing anywhere obvious — which is exactly
    // how this went unnoticed once already. Fail at startup instead.
    ...(!posture?.qc_last_human_message_at
      ? ["conversation_plan_reviews.last_human_message_at"]
      : []),
    ...(!posture?.qc_mode_provenance_columns
      ? ["conversation_plan_reviews qc_mode provenance columns"]
      : []),
    ...(!posture?.planning_live_progress_columns ? ["planning live_progress columns"] : []),
  ];
  if (missing.length > 0) {
    throw new PostgresConnectionConfigurationError(
      "runtime_schema_outdated",
      `database migrations are required before startup; missing: ${missing.join(", ")}. Apply them with: node apps/server/dist/applyMigrations.js (DATABASE_URL must be set).`,
    );
  }
}

/**
 * Proves the actual login used by the ordinary application is not the
 * migration/table-owner login. This runs before any snapshot is loaded.
 */
export async function assertRestrictedRuntimeDatabase(
  pool: Pick<Pool, "query">,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  assertArchiveKeyAbsent(environment);

  const phase2 = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('legacy_snapshot_archives')::text AS relation",
  );
  if (phase2.rows[0]?.relation === null || phase2.rows[0] === undefined) {
    return;
  }

  const posture = await pool.query<RuntimeLoginPosture>(
    `SELECT role.rolname,
            role.rolsuper,
            role.rolcreatedb,
            role.rolcreaterole,
            role.rolreplication,
            role.rolbypassrls,
            pg_has_role(session_user, 'norns_app', 'SET') AS can_set_runtime_role
     FROM pg_roles AS role
     WHERE role.rolname = session_user`,
  );
  const login = posture.rows[0];
  if (!login) {
    throw new PostgresConnectionConfigurationError(
      "privileged_runtime_login",
      "ordinary application database login posture could not be established",
    );
  }
  if (
    login.rolsuper ||
    login.rolcreatedb ||
    login.rolcreaterole ||
    login.rolreplication ||
    login.rolbypassrls
  ) {
    throw new PostgresConnectionConfigurationError(
      "privileged_runtime_login",
      `ordinary application database login ${login.rolname} has privileged role attributes`,
    );
  }
  if (!login.can_set_runtime_role) {
    throw new PostgresConnectionConfigurationError(
      "runtime_role_unavailable",
      `ordinary application database login ${login.rolname} cannot assume norns_app`,
    );
  }

  try {
    await pool.query("SELECT ciphertext FROM legacy_snapshot_archives LIMIT 0");
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "42501" || /permission denied/i.test(String(error))) return;
    throw error;
  }
  throw new PostgresConnectionConfigurationError(
    "archive_ciphertext_visible",
    "ordinary application database login can read encrypted archive ciphertext",
  );
}
