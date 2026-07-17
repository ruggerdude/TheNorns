import { V2PersistenceRoute, type V2PersistenceRouteT } from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  type CredentialHmacKey,
  type CredentialHmacKeyring,
  createCredentialHmacKeyring,
  credentialHmacKeyFingerprint,
} from "../users/credentialTokens.js";
import type { IdentityService } from "../users/identityService.js";
import { LegacyIdentityService } from "../users/legacyIdentityService.js";
import {
  RelationalIdentityService,
  type RelationalIdentityServiceOptions,
} from "../users/relationalIdentityService.js";
import type { UserStore } from "../users/store.js";

export type IdentityRuntimeErrorCode =
  | "identity_route_invalid"
  | "identity_route_incoherent"
  | "identity_route_unsupported"
  | "relational_transactions_missing"
  | "credential_key_missing"
  | "credential_key_id_missing"
  | "credential_key_invalid"
  | "credential_keyring_invalid"
  | "credential_key_registry_mismatch"
  | "credential_key_unavailable";

export class IdentityRuntimeConfigurationError extends Error {
  constructor(
    readonly code: IdentityRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IdentityRuntimeConfigurationError";
  }
}

export interface IdentityRuntimeEnvironment {
  NORNS_CREDENTIAL_HMAC_KEY?: string | undefined;
  NORNS_CREDENTIAL_HMAC_KEY_ID?: string | undefined;
  NORNS_CREDENTIAL_HMAC_KEYRING?: string | undefined;
}

export interface IdentityRouteDatabase {
  query<TRow = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: TRow[] }>;
}

interface IdentityRouteRow {
  scope_type: string;
  scope_key: string;
  read_mode: string;
  write_mode: string;
  migration_run_id: string | null;
  aggregate_version: number | string;
  changed_by_actor_type: string;
  changed_by_actor_id: string | null;
  changed_at: Date | string;
  v2_writes_started_at: Date | string | null;
  rollback_window_until: Date | string | null;
}

export type IdentityRuntime =
  | {
      mode: "legacy";
      identity: IdentityService;
      route: V2PersistenceRouteT | null;
      usesLegacyUserSnapshot: true;
      allowsDevelopmentSeed: true;
    }
  | {
      mode: "relational";
      identity: IdentityService;
      route: V2PersistenceRouteT;
      usesLegacyUserSnapshot: false;
      allowsDevelopmentSeed: false;
    };

export interface CreateIdentityRuntimeInput {
  users: UserStore;
  route: V2PersistenceRouteT | null;
  environment: IdentityRuntimeEnvironment;
  transactions?: V2TransactionRunner | undefined;
  clock?: RelationalIdentityServiceOptions["clock"];
  newId?: RelationalIdentityServiceOptions["newId"];
  randomBytes?: RelationalIdentityServiceOptions["randomBytes"];
  sessionTtlMs?: number | undefined;
  invitationTtlMs?: number | undefined;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

/**
 * Reads only the already-durable control row. It neither creates the routing
 * table nor inserts/changes a route, so startup cannot accidentally activate
 * a migration state.
 */
export async function loadDurableIdentityRoute(
  database: IdentityRouteDatabase,
): Promise<V2PersistenceRouteT | null> {
  const relation = await database.query<{ relation: string | null }>(
    "SELECT to_regclass('persistence_routes')::text AS relation",
  );
  if (relation.rows[0]?.relation === null || relation.rows[0] === undefined) return null;

  let result: { rows: IdentityRouteRow[] };
  try {
    result = await database.query<IdentityRouteRow>(
      `SELECT scope_type, scope_key, read_mode, write_mode, migration_run_id,
              aggregate_version, changed_by_actor_type, changed_by_actor_id,
              changed_at, v2_writes_started_at, rollback_window_until
       FROM persistence_routes
       WHERE scope_type = 'identity' AND scope_key = '*'`,
    );
  } catch {
    throw new IdentityRuntimeConfigurationError(
      "identity_route_invalid",
      "the durable identity route exists but cannot be read",
    );
  }
  const row = result.rows[0];
  if (!row) return null;
  const parsed = V2PersistenceRoute.safeParse({
    schema_version: 2,
    scope_type: row.scope_type,
    scope_key: row.scope_key,
    read_mode: row.read_mode,
    write_mode: row.write_mode,
    migration_run_id: row.migration_run_id,
    aggregate_version: Number(row.aggregate_version),
    changed_by: {
      actor_type: row.changed_by_actor_type,
      actor_id: row.changed_by_actor_id,
    },
    changed_at: iso(row.changed_at),
    v2_writes_started_at: optionalIso(row.v2_writes_started_at),
    rollback_window_until: optionalIso(row.rollback_window_until),
  });
  if (!parsed.success) {
    throw new IdentityRuntimeConfigurationError(
      "identity_route_invalid",
      "the durable identity route failed contract validation",
    );
  }
  return parsed.data;
}

function parseCredentialKey(
  encoded: string | undefined,
  keyId: string | undefined,
): CredentialHmacKey {
  if (!encoded) {
    throw new IdentityRuntimeConfigurationError(
      "credential_key_missing",
      "NORNS_CREDENTIAL_HMAC_KEY is required for relational identity",
    );
  }
  const normalizedKeyId = keyId?.trim();
  if (!normalizedKeyId) {
    throw new IdentityRuntimeConfigurationError(
      "credential_key_id_missing",
      "NORNS_CREDENTIAL_HMAC_KEY_ID is required for relational identity",
    );
  }
  const canonicalBase64 = encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded);
  const key = canonicalBase64 ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
  if (key.byteLength !== 32 || key.toString("base64") !== encoded) {
    throw new IdentityRuntimeConfigurationError(
      "credential_key_invalid",
      "NORNS_CREDENTIAL_HMAC_KEY must be canonical base64 for exactly 32 bytes",
    );
  }
  return { keyId: normalizedKeyId, key };
}

/** Parse a current issuance key plus a bounded verification-only keyring. */
export function parseCredentialHmacKeyring(
  environment: IdentityRuntimeEnvironment,
): CredentialHmacKeyring {
  const current = parseCredentialKey(
    environment.NORNS_CREDENTIAL_HMAC_KEY,
    environment.NORNS_CREDENTIAL_HMAC_KEY_ID,
  );
  const encodedKeyring = environment.NORNS_CREDENTIAL_HMAC_KEYRING?.trim();
  let verificationKeys: CredentialHmacKey[] = [];
  if (encodedKeyring) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(encodedKeyring);
    } catch {
      throw new IdentityRuntimeConfigurationError(
        "credential_keyring_invalid",
        "NORNS_CREDENTIAL_HMAC_KEYRING must be a JSON object of key IDs to base64 keys",
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length > 8
    ) {
      throw new IdentityRuntimeConfigurationError(
        "credential_keyring_invalid",
        "NORNS_CREDENTIAL_HMAC_KEYRING must contain at most eight key entries",
      );
    }
    verificationKeys = Object.entries(parsed).map(([id, encoded]) => {
      if (typeof encoded !== "string") {
        throw new IdentityRuntimeConfigurationError(
          "credential_keyring_invalid",
          "every credential keyring entry must be a base64 string",
        );
      }
      return parseCredentialKey(encoded, id);
    });
  }
  try {
    return createCredentialHmacKeyring(current, verificationKeys);
  } catch {
    throw new IdentityRuntimeConfigurationError(
      "credential_keyring_invalid",
      "credential key IDs must be unique and bound to one 32-byte key",
    );
  }
}

/** Backward-compatible current-key parser used by the offline importer. */
export function parseCredentialHmacKey(environment: IdentityRuntimeEnvironment): CredentialHmacKey {
  return parseCredentialHmacKeyring(environment).current;
}

export async function assertCredentialHmacKeyCoverage(
  transactions: V2TransactionRunner,
  keyring: CredentialHmacKeyring,
): Promise<void> {
  await transactions.transaction(async (sql) => {
    const live = await sql.query<{ key_id: string }>(
      `SELECT DISTINCT token_key_id AS key_id
       FROM sessions
       WHERE status = 'active' AND token_key_id IS NOT NULL
       UNION
       SELECT DISTINCT token_key_id AS key_id
       FROM invitations
       WHERE status = 'pending' AND token_key_id IS NOT NULL`,
    );
    const registered = await sql.query<{
      key_id: string;
      key_fingerprint: string;
      status: string;
    }>(
      `SELECT key_id, key_fingerprint, status
       FROM credential_hmac_key_registry`,
    );
    const registry = new Map(registered.rows.map((row) => [row.key_id, row]));
    for (const [keyId, key] of keyring.byId) {
      const row = registry.get(keyId);
      if (
        !row ||
        row.status !== "active" ||
        row.key_fingerprint !== credentialHmacKeyFingerprint(key)
      ) {
        throw new IdentityRuntimeConfigurationError(
          "credential_key_registry_mismatch",
          `credential HMAC key registry mismatch for key ID ${keyId}`,
        );
      }
    }
    for (const { key_id: keyId } of live.rows) {
      if (!keyring.byId.has(keyId)) {
        throw new IdentityRuntimeConfigurationError(
          "credential_key_unavailable",
          `a live credential requires unavailable HMAC key ID ${keyId}`,
        );
      }
    }
  });
}

export function createIdentityRuntime(input: CreateIdentityRuntimeInput): IdentityRuntime {
  const { route } = input;
  if (route === null) {
    return {
      mode: "legacy",
      identity: new LegacyIdentityService(input.users),
      route,
      usesLegacyUserSnapshot: true,
      allowsDevelopmentSeed: true,
    };
  }
  if (route.scope_type !== "identity" || route.scope_key !== "*") {
    throw new IdentityRuntimeConfigurationError(
      "identity_route_invalid",
      "the identity runtime received a route for a different scope",
    );
  }
  if (route.read_mode === "legacy" && route.write_mode === "legacy") {
    return {
      mode: "legacy",
      identity: new LegacyIdentityService(input.users),
      route,
      usesLegacyUserSnapshot: true,
      allowsDevelopmentSeed: true,
    };
  }
  if (route.read_mode === "relational" && route.write_mode === "relational") {
    if (!input.transactions) {
      throw new IdentityRuntimeConfigurationError(
        "relational_transactions_missing",
        "relational identity requires a runtime PostgreSQL transaction runner",
      );
    }
    const credentialKeys = parseCredentialHmacKeyring(input.environment);
    return {
      mode: "relational",
      identity: new RelationalIdentityService({
        transactions: input.transactions,
        credentialKey: credentialKeys.current,
        credentialVerificationKeys: [...credentialKeys.byId.values()].filter(
          (key) => key.keyId !== credentialKeys.current.keyId,
        ),
        clock: input.clock,
        newId: input.newId,
        randomBytes: input.randomBytes,
        sessionTtlMs: input.sessionTtlMs,
        invitationTtlMs: input.invitationTtlMs,
      }),
      route,
      usesLegacyUserSnapshot: false,
      allowsDevelopmentSeed: false,
    };
  }
  if (route.read_mode === "relational" || route.write_mode === "relational") {
    throw new IdentityRuntimeConfigurationError(
      "identity_route_incoherent",
      "relational identity reads and writes must be activated together",
    );
  }
  throw new IdentityRuntimeConfigurationError(
    "identity_route_unsupported",
    `identity startup does not support ${route.read_mode}/${route.write_mode} routing`,
  );
}
