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
  conversation_domain_complete: boolean;
  conversation_stream_lifecycle: string | null;
  conversation_plan_workflow: string | null;
  conversation_execution_handoff: string | null;
  conversation_human_steering: string | null;
  conversation_mockups_dashboard: string | null;
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
              AS conversation_mockups_dashboard`,
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
    ...(!posture?.conversation_domain_complete ? ["conversation domain tables"] : []),
    ...(!posture?.conversation_stream_lifecycle ? ["conversation_stream_lifecycle_v1"] : []),
    ...(!posture?.conversation_plan_workflow ? ["conversation_plan_workflow_v1"] : []),
    ...(!posture?.conversation_execution_handoff ? ["conversation_execution_handoff_v1"] : []),
    ...(!posture?.conversation_human_steering ? ["conversation_human_steering_v1"] : []),
    ...(!posture?.conversation_mockups_dashboard ? ["conversation_mockups_dashboard_v1"] : []),
  ];
  if (missing.length > 0) {
    throw new PostgresConnectionConfigurationError(
      "runtime_schema_outdated",
      `database migrations are required before startup; missing: ${missing.join(", ")}`,
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
