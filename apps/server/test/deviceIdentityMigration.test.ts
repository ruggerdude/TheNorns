import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEVICE_CANCELLATION_TRACKING_MIGRATION_NAME,
  DEVICE_HTTP_REQUEST_REPLAYS_MIGRATION_NAME,
  DEVICE_IDENTITY_CORE_MIGRATION_NAME,
  GATEWAY_DEVICE_AUTHORIZATION_MIGRATION_NAME,
  currentV2MigrationSources,
  loadDeviceIdentityCoreMigrationSql,
  loadGatewayDeviceAuthorizationMigrationSql,
} from "../src/persistence/v2/migrate.js";

describe.sequential("device identity core migration", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE repository_bindings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        binding_type TEXT NOT NULL
      );
      INSERT INTO users (id) VALUES ('owner-1'), ('owner-2');
      INSERT INTO projects (id) VALUES ('project-1'), ('project-2');
    `);
    await database.exec(await loadDeviceIdentityCoreMigrationSql());
  });

  afterAll(async () => {
    await database.close();
  });

  it("is registered before the additive Phase 2 device migrations", async () => {
    const sources = await currentV2MigrationSources();
    expect(sources.slice(-4).map((source) => source.name)).toEqual([
      DEVICE_IDENTITY_CORE_MIGRATION_NAME,
      DEVICE_HTTP_REQUEST_REPLAYS_MIGRATION_NAME,
      DEVICE_CANCELLATION_TRACKING_MIGRATION_NAME,
      GATEWAY_DEVICE_AUTHORIZATION_MIGRATION_NAME,
    ]);
    expect(sources.at(-4)?.sql).toContain("CREATE TABLE IF NOT EXISTS devices");
  });

  it("creates the five core tables, privacy-safe columns, and runtime grants", async () => {
    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'devices',
            'device_credentials',
            'device_authorization_requests',
            'device_repository_registrations',
            'project_device_repository_grants'
          )
        ORDER BY table_name`,
    );
    expect(tables.rows).toHaveLength(5);

    const forbiddenCodeColumns = await database.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'device_authorization_requests'
          AND column_name IN ('device_code', 'user_code', 'hostname')`,
    );
    expect(forbiddenCodeColumns.rows).toEqual([]);

    const summaryColumns = await database.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'device_authorization_requests'
          AND column_name IN (
            'proposed_name',
            'os_family',
            'architecture',
            'requested_capabilities',
            'device_code_keyed_hash',
            'user_code_keyed_hash',
            'effective_poll_interval_seconds',
            'slow_down_count',
            'redeemed_device_id',
            'redeemed_credential_id',
            'redeemed_generation'
          )`,
    );
    expect(summaryColumns.rows).toHaveLength(11);

    const bindingColumns = await database.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'repository_bindings'
          AND column_name IN (
            'device_id',
            'device_repository_registration_id',
            'project_device_repository_grant_id'
          )`,
    );
    expect(bindingColumns.rows).toEqual([{ column_name: "project_device_repository_grant_id" }]);

    const privileges = await database.query<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT
         has_table_privilege('norns_app', 'devices', 'SELECT') AS can_select,
         has_table_privilege(
           'norns_app',
           'device_authorization_requests',
           'INSERT'
         ) AS can_insert,
         has_table_privilege(
           'norns_app',
           'project_device_repository_grants',
           'UPDATE'
         ) AS can_update,
         has_table_privilege('norns_app', 'device_credentials', 'DELETE')
           AS can_delete`,
    );
    expect(privileges.rows[0]).toEqual({
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: false,
    });
  });

  it("enforces owner, credential, generation, and fingerprint invariants", async () => {
    await expect(
      database.query("INSERT INTO devices (id) VALUES ('ownerless-active')"),
    ).rejects.toThrow();

    await database.exec(`
      INSERT INTO devices (id, owner_user_id)
      VALUES ('device-1', 'owner-1'), ('device-2', 'owner-2');
    `);

    const initialFence = await database.query<{ current_generation: bigint }>(
      "SELECT current_generation FROM devices WHERE id = 'device-1'",
    );
    expect(initialFence.rows[0]?.current_generation).toBe(0);

    await database.exec(`
      INSERT INTO device_credentials (
        id, device_id, generation, public_key_spki_der,
        public_key_fingerprint
      ) VALUES (
        'credential-1', 'device-1', 1, decode('abcd', 'hex'),
        repeat('a', 64)
      );
    `);

    await expect(
      database.query(`
        INSERT INTO device_credentials (
          id, device_id, generation, public_key_spki_der,
          public_key_fingerprint
        ) VALUES (
          'second-active', 'device-1', 2, decode('abce', 'hex'),
          repeat('b', 64)
        )`),
    ).rejects.toThrow();

    await database.exec(`
      UPDATE device_credentials
         SET state = 'revoked', revoked_at = now()
       WHERE id = 'credential-1';
      INSERT INTO device_credentials (
        id, device_id, generation, public_key_spki_der,
        public_key_fingerprint
      ) VALUES (
        'credential-2', 'device-1', 2, decode('abce', 'hex'),
        repeat('b', 64)
      );
    `);

    await expect(
      database.query(`
        INSERT INTO device_credentials (
          id, device_id, generation, public_key_spki_der,
          public_key_fingerprint, state, revoked_at
        ) VALUES (
          'stale-credential', 'device-1', 1, decode('abcf', 'hex'),
          repeat('c', 64), 'revoked', now()
        )`),
    ).rejects.toThrow(/generation/);

    await expect(
      database.query(`
        INSERT INTO device_credentials (
          id, device_id, generation, public_key_spki_der,
          public_key_fingerprint
        ) VALUES (
          'duplicate-key', 'device-2', 1, decode('abce', 'hex'),
          repeat('b', 64)
        )`),
    ).rejects.toThrow();
  });

  it("stores replay-safe polling and the exact idempotent redemption result", async () => {
    await database.exec(`
      INSERT INTO device_authorization_requests (
        id, public_key_spki_der, public_key_fingerprint,
        proposed_name, os_family, architecture, requested_capabilities,
        device_code_hash_version, device_code_hash_key_id,
        device_code_keyed_hash, user_code_hash_version,
        user_code_hash_key_id, user_code_keyed_hash,
        poll_interval_seconds, effective_poll_interval_seconds,
        next_poll_at, expires_at
      ) VALUES (
        'authorization-1', decode('abce', 'hex'), repeat('b', 64),
        'Office Mac mini', 'macos', 'arm64', '["execution"]'::jsonb,
        1, 'device-hmac-1', decode(repeat('11', 32), 'hex'),
        1, 'user-hmac-1', decode(repeat('22', 32), 'hex'),
        5, 5, now() + interval '5 seconds', now() + interval '10 minutes'
      );
    `);

    await expect(
      database.query(`
        INSERT INTO device_authorization_requests (
          id, public_key_spki_der, public_key_fingerprint,
          device_code_hash_version, device_code_hash_key_id,
          device_code_keyed_hash, user_code_hash_version,
          user_code_hash_key_id, user_code_keyed_hash,
          poll_interval_seconds, effective_poll_interval_seconds,
          slow_down_count, next_poll_at, expires_at
        ) VALUES (
          'invalid-slow-down', decode('abcf', 'hex'), repeat('c', 64),
          1, 'device-hmac-1', decode(repeat('33', 32), 'hex'),
          1, 'user-hmac-1', decode(repeat('44', 32), 'hex'),
          5, 9, 1, now() + interval '9 seconds',
          now() + interval '10 minutes'
        )`),
    ).rejects.toThrow();

    await database.exec(`
      UPDATE device_authorization_requests
         SET state = 'approved_pending_redemption',
             approved_by_user_id = 'owner-1',
             approved_at = now(),
             updated_at = now()
       WHERE id = 'authorization-1';

      UPDATE device_authorization_requests
         SET state = 'active',
             redeemed_at = now(),
             redeemed_device_id = 'device-1',
             redeemed_credential_id = 'credential-2',
             redeemed_generation = 2,
             redemption_result_expires_at = now() + interval '1 day',
             updated_at = now()
       WHERE id = 'authorization-1';
    `);

    const result = await database.query<{
      state: string;
      redeemed_device_id: string;
      redeemed_credential_id: string;
      redeemed_generation: bigint;
    }>(
      `SELECT state, redeemed_device_id, redeemed_credential_id,
              redeemed_generation
         FROM device_authorization_requests
        WHERE id = 'authorization-1'`,
    );
    expect(result.rows[0]).toEqual({
      state: "active",
      redeemed_device_id: "device-1",
      redeemed_credential_id: "credential-2",
      redeemed_generation: 2,
    });

    await expect(
      database.query(`
        UPDATE device_authorization_requests
           SET redeemed_credential_id = 'credential-1'
         WHERE id = 'authorization-1'`),
    ).rejects.toThrow(/terminal authorization requests are immutable/);
  });

  it("enforces registration, project-grant, and binding-chain uniqueness", async () => {
    await database.exec(`
      INSERT INTO device_repository_registrations (
        id, device_id, workspace_id, repository_id,
        repository_display_name, state, approved_by_user_id, approved_at
      ) VALUES (
        'registration-1', 'device-1', 'workspace-1', 'repository-1',
        'The Norns', 'active', 'owner-1', now()
      );

      INSERT INTO project_device_repository_grants (
        id, project_id, repository_registration_id,
        granted_by_user_id
      ) VALUES (
        'grant-1', 'project-1', 'registration-1', 'owner-1'
      );

      INSERT INTO repository_bindings (
        id, project_id, binding_type, project_device_repository_grant_id
      ) VALUES (
        'binding-1', 'project-1', 'local_runner', 'grant-1'
      );
    `);

    await expect(
      database.query(`
        INSERT INTO device_repository_registrations (
          id, device_id, workspace_id, repository_id,
          repository_display_name
        ) VALUES (
          'registration-duplicate', 'device-1', 'workspace-1',
          'repository-1', 'Duplicate'
        )`),
    ).rejects.toThrow();

    await expect(
      database.query(`
        INSERT INTO project_device_repository_grants (
          id, project_id, repository_registration_id,
          granted_by_user_id
        ) VALUES (
          'grant-duplicate', 'project-1', 'registration-1', 'owner-1'
        )`),
    ).rejects.toThrow();

    await expect(
      database.query(`
        INSERT INTO repository_bindings (
          id, project_id, binding_type, project_device_repository_grant_id
        ) VALUES (
          'binding-cross-project', 'project-2', 'local_runner', 'grant-1'
        )`),
    ).rejects.toThrow();
  });

  it("keeps historical gateway credentials legacy and enforces exact device credentials", async () => {
    const gatewayDatabase = new PGlite();
    try {
      await gatewayDatabase.exec(`
        CREATE TABLE device_credentials (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          generation BIGINT NOT NULL,
          UNIQUE (device_id,id,generation)
        );
        CREATE TABLE gateway_credentials (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL,
          runner_id TEXT NOT NULL,
          runner_generation INTEGER NOT NULL,
          issued_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ
        );
        INSERT INTO gateway_credentials (
          id,token_hash,run_id,runner_id,runner_generation,issued_at,expires_at
        ) VALUES (
          'legacy-gateway',repeat('a',64),'run-1','runner-1',1,now(),now()+interval '1 hour'
        );
      `);
      await gatewayDatabase.exec(await loadGatewayDeviceAuthorizationMigrationSql());
      const legacy = await gatewayDatabase.query<{
        authentication_subject: string;
        device_credential_id: string | null;
      }>(
        `SELECT authentication_subject,device_credential_id
           FROM gateway_credentials
          WHERE id='legacy-gateway'`,
      );
      expect(legacy.rows[0]).toEqual({
        authentication_subject: "legacy_runner",
        device_credential_id: null,
      });

      await expect(
        gatewayDatabase.query(
          `INSERT INTO gateway_credentials (
             id,token_hash,run_id,runner_id,runner_generation,
             authentication_subject,device_credential_id,issued_at,expires_at
           ) VALUES (
             'forged-device',repeat('b',64),'run-2','device-1',2,
             'device','missing-credential',now(),now()+interval '1 hour'
           )`,
        ),
      ).rejects.toThrow();

      await gatewayDatabase.exec(`
        INSERT INTO device_credentials (id,device_id,generation)
        VALUES ('credential-2','device-1',2);
        INSERT INTO gateway_credentials (
          id,token_hash,run_id,runner_id,runner_generation,
          authentication_subject,device_credential_id,issued_at,expires_at
        ) VALUES (
          'device-gateway',repeat('c',64),'run-2','device-1',2,
          'device','credential-2',now(),now()+interval '1 hour'
        );
      `);
    } finally {
      await gatewayDatabase.close();
    }
  });
});
