import type { Pool, PoolConfig } from "pg";

const PRIVATE_POSTGRES_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export class PostgresConnectionConfigurationError extends Error {
  constructor(
    readonly code:
      | "invalid_database_url"
      | "privileged_runtime_login"
      | "runtime_role_unavailable"
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
