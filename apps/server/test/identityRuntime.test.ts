import type { V2PersistenceRouteT } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import type {
  V2QueryResult,
  V2SqlExecutor,
  V2TransactionRunner,
} from "../src/persistence/v2/database.js";
import {
  type IdentityRouteDatabase,
  type IdentityRuntimeConfigurationError,
  createIdentityRuntime,
  loadDurableIdentityRoute,
  parseCredentialHmacKey,
  parseCredentialHmacKeyring,
  parseOptionalCredentialHmacKeyring,
} from "../src/startup/identityRuntime.js";
import { LegacyIdentityService } from "../src/users/legacyIdentityService.js";
import { RelationalIdentityService } from "../src/users/relationalIdentityService.js";
import { UserStore } from "../src/users/store.js";

const VALID_ENVIRONMENT = {
  NORNS_CREDENTIAL_HMAC_KEY: Buffer.alloc(32, 23).toString("base64"),
  NORNS_CREDENTIAL_HMAC_KEY_ID: "credential-key-2026-07",
};

function route(
  readMode: V2PersistenceRouteT["read_mode"],
  writeMode: V2PersistenceRouteT["write_mode"],
): V2PersistenceRouteT {
  return {
    schema_version: 2,
    scope_type: "identity",
    scope_key: "*",
    read_mode: readMode,
    write_mode: writeMode,
    migration_run_id: "migration-run-identity",
    aggregate_version: 1,
    changed_by: { actor_type: "system", actor_id: null },
    changed_at: "2026-07-16T21:00:00.000Z",
    v2_writes_started_at: writeMode === "relational" ? "2026-07-16T21:00:00.000Z" : null,
    rollback_window_until: null,
  };
}

class ScriptedRouteDatabase implements IdentityRouteDatabase {
  readonly calls: string[] = [];

  constructor(private readonly results: Record<string, unknown>[][]) {}

  async query<TRow = Record<string, unknown>>(
    sql: string,
    _params?: unknown[],
  ): Promise<{ rows: TRow[] }> {
    this.calls.push(sql);
    return { rows: (this.results.shift() ?? []) as TRow[] };
  }
}

const NOOP_TRANSACTIONS: V2TransactionRunner = {
  async transaction<T>(work: (sql: V2SqlExecutor) => Promise<T>): Promise<T> {
    return work({
      async query<TRow>(): Promise<V2QueryResult<TRow>> {
        return { rows: [] };
      },
    });
  },
};

describe("durable identity route loading", () => {
  it("treats an absent persistence_routes table as legacy without creating it", async () => {
    const database = new ScriptedRouteDatabase([[{ relation: null }]]);
    await expect(loadDurableIdentityRoute(database)).resolves.toBeNull();
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]).toContain("to_regclass");
    expect(database.calls.join(" ")).not.toMatch(/CREATE|INSERT|UPDATE/i);
  });

  it("loads and validates the durable identity route without changing it", async () => {
    const database = new ScriptedRouteDatabase([
      [{ relation: "persistence_routes" }],
      [
        {
          scope_type: "identity",
          scope_key: "*",
          read_mode: "relational",
          write_mode: "relational",
          migration_run_id: "migration-run-identity",
          aggregate_version: "3",
          changed_by_actor_type: "human",
          changed_by_actor_id: "admin-1",
          changed_at: new Date("2026-07-16T21:00:00.000Z"),
          v2_writes_started_at: new Date("2026-07-16T21:00:00.000Z"),
          rollback_window_until: null,
        },
      ],
    ]);

    await expect(loadDurableIdentityRoute(database)).resolves.toMatchObject({
      scope_type: "identity",
      read_mode: "relational",
      write_mode: "relational",
      aggregate_version: 3,
    });
    expect(database.calls).toHaveLength(2);
    expect(database.calls.join(" ")).not.toMatch(/CREATE|INSERT|UPDATE/i);
  });

  it("keeps legacy mode when the routing table exists without an identity row", async () => {
    const database = new ScriptedRouteDatabase([[{ relation: "persistence_routes" }], []]);
    await expect(loadDurableIdentityRoute(database)).resolves.toBeNull();
    expect(database.calls).toHaveLength(2);
  });
});

describe("identity runtime selection", () => {
  it("uses the legacy adapter and legacy snapshot flusher when the route is absent", async () => {
    const users = new UserStore();
    const runtime = createIdentityRuntime({
      users,
      route: null,
      environment: {},
    });

    expect(runtime).toMatchObject({
      mode: "legacy",
      usesLegacyUserSnapshot: true,
      allowsDevelopmentSeed: true,
    });
    expect(runtime.identity).toBeInstanceOf(LegacyIdentityService);
    await runtime.identity.createActive({
      email: "admin@example.com",
      password: "admin-password",
      role: "admin",
    });
    expect(users.hasActiveAdmin).toBe(true);
  });

  it("keeps explicit legacy/legacy routing on the snapshot identity path", () => {
    const runtime = createIdentityRuntime({
      users: new UserStore(),
      route: route("legacy", "legacy"),
      // Relational secrets are irrelevant and deliberately not parsed here.
      environment: { NORNS_CREDENTIAL_HMAC_KEY: "not-base64" },
    });

    expect(runtime.mode).toBe("legacy");
    expect(runtime.usesLegacyUserSnapshot).toBe(true);
  });

  it("selects relational identity only for coherent relational/relational routing", () => {
    const runtime = createIdentityRuntime({
      users: new UserStore(),
      route: route("relational", "relational"),
      environment: VALID_ENVIRONMENT,
      transactions: NOOP_TRANSACTIONS,
    });

    expect(runtime).toMatchObject({
      mode: "relational",
      usesLegacyUserSnapshot: false,
      allowsDevelopmentSeed: false,
    });
    expect(runtime.identity).toBeInstanceOf(RelationalIdentityService);
  });

  it("fails relational selection when its runtime runner or key configuration is absent", () => {
    expect(() =>
      createIdentityRuntime({
        users: new UserStore(),
        route: route("relational", "relational"),
        environment: VALID_ENVIRONMENT,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<IdentityRuntimeConfigurationError>>({
        code: "relational_transactions_missing",
      }),
    );
    expect(() =>
      createIdentityRuntime({
        users: new UserStore(),
        route: route("relational", "relational"),
        environment: {},
        transactions: NOOP_TRANSACTIONS,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<IdentityRuntimeConfigurationError>>({
        code: "credential_key_missing",
      }),
    );
  });

  it.each([
    ["relational", "legacy"],
    ["legacy", "relational"],
    ["shadow", "relational"],
  ] as const)("fails closed for incoherent %s/%s routing", (readMode, writeMode) => {
    expect(() =>
      createIdentityRuntime({
        users: new UserStore(),
        route: route(readMode, writeMode),
        environment: VALID_ENVIRONMENT,
        transactions: NOOP_TRANSACTIONS,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<IdentityRuntimeConfigurationError>>({
        code: "identity_route_incoherent",
      }),
    );
  });

  it("fails closed rather than silently ignoring a shadow/frozen route", () => {
    expect(() =>
      createIdentityRuntime({
        users: new UserStore(),
        route: route("shadow", "frozen"),
        environment: VALID_ENVIRONMENT,
        transactions: NOOP_TRANSACTIONS,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<IdentityRuntimeConfigurationError>>({
        code: "identity_route_unsupported",
      }),
    );
  });
});

describe("relational credential-key configuration", () => {
  it("makes configured credential keys available before relational identity cutover", () => {
    const keyring = parseOptionalCredentialHmacKeyring(VALID_ENVIRONMENT);

    expect(keyring?.current.keyId).toBe(VALID_ENVIRONMENT.NORNS_CREDENTIAL_HMAC_KEY_ID);
    expect(Buffer.from(keyring?.current.key ?? [])).toEqual(Buffer.alloc(32, 23));
  });

  it("returns null only when no credential-key setting is present", () => {
    expect(parseOptionalCredentialHmacKeyring({})).toBeNull();
    expect(() =>
      parseOptionalCredentialHmacKeyring({ NORNS_CREDENTIAL_HMAC_KEY_ID: "partial" }),
    ).toThrowError(
      expect.objectContaining<Partial<IdentityRuntimeConfigurationError>>({
        code: "credential_key_missing",
      }),
    );
  });

  it("parses one canonical base64-encoded 32-byte key and a trimmed key ID", () => {
    const parsed = parseCredentialHmacKey({
      ...VALID_ENVIRONMENT,
      NORNS_CREDENTIAL_HMAC_KEY_ID: "  credential-key-2026-07  ",
    });
    expect(parsed.keyId).toBe("credential-key-2026-07");
    expect(Buffer.from(parsed.key)).toEqual(Buffer.alloc(32, 23));
  });

  it("parses verification-only keys while keeping one current issuance key", () => {
    const previous = Buffer.alloc(32, 17).toString("base64");
    const keyring = parseCredentialHmacKeyring({
      ...VALID_ENVIRONMENT,
      NORNS_CREDENTIAL_HMAC_KEYRING: JSON.stringify({
        "credential-key-previous": previous,
      }),
    });
    expect(keyring.current.keyId).toBe(VALID_ENVIRONMENT.NORNS_CREDENTIAL_HMAC_KEY_ID);
    expect(Buffer.from(keyring.byId.get("credential-key-previous")?.key ?? [])).toEqual(
      Buffer.alloc(32, 17),
    );
  });

  it.each([
    [{ NORNS_CREDENTIAL_HMAC_KEY_ID: "key-id" }, "credential_key_missing"],
    [
      { NORNS_CREDENTIAL_HMAC_KEY: VALID_ENVIRONMENT.NORNS_CREDENTIAL_HMAC_KEY },
      "credential_key_id_missing",
    ],
    [
      {
        NORNS_CREDENTIAL_HMAC_KEY: Buffer.alloc(31, 1).toString("base64"),
        NORNS_CREDENTIAL_HMAC_KEY_ID: "key-id",
      },
      "credential_key_invalid",
    ],
    [
      {
        NORNS_CREDENTIAL_HMAC_KEY: "not-base64-or-secret-material",
        NORNS_CREDENTIAL_HMAC_KEY_ID: "key-id",
      },
      "credential_key_invalid",
    ],
  ] as const)("fails closed with %s", (environment, expectedCode) => {
    expect(() => parseCredentialHmacKey(environment)).toThrowError(
      expect.objectContaining<Partial<IdentityRuntimeConfigurationError>>({
        code: expectedCode,
      }),
    );
    try {
      parseCredentialHmacKey(environment);
    } catch (error) {
      const rawKey =
        "NORNS_CREDENTIAL_HMAC_KEY" in environment
          ? environment.NORNS_CREDENTIAL_HMAC_KEY
          : "not-present";
      expect(String(error)).not.toContain(rawKey);
    }
  });
});
