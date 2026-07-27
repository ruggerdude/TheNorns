import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodePgTransactionRunner } from "../src/persistence/v2/database.js";
import {
  CONVERSATION_MOCKUPS_DASHBOARD_MIGRATION_NAME,
  type V2MigrationDatabase,
  runCurrentV2Migrations,
} from "../src/persistence/v2/migrate.js";

const databaseUrl = process.env.V2_POSTGRES_TEST_URL;
const postgresDescribe = databaseUrl ? describe.sequential : describe.skip;

postgresDescribe("Phase 6 real PostgreSQL acceptance", () => {
  let administrationPool: Pool;
  let applicationPool: Pool;
  let schemaName: string;

  const seedDelivery = async (id: string): Promise<void> => {
    const client = await applicationPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO project_delivery_records (
           id,project_id,repository_binding_id,environment,service,commit_sha,
           provider_id,provider_deployment_id,status,current_observation_sequence,started_at
         ) VALUES (
           $1,'phase6-pg-project','phase6-pg-binding','production','web',
           repeat('a',40),'railway',$2,'pending',1,'2026-07-27T12:00:00Z'
         )`,
        [id, `provider-${id}`],
      );
      await client.query(
        `INSERT INTO project_delivery_observations (
           id,delivery_record_id,project_id,sequence,status,source_type,source_id,
           observed_at
         ) VALUES (
           $1,$2,'phase6-pg-project',1,'pending','system','deployment-monitor',
           '2026-07-27T12:00:00Z'
         )`,
        [`${id}-observation-1`, id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  const advanceDelivery = async (
    client: PoolClient,
    deliveryId: string,
    observationId: string,
  ): Promise<void> => {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO project_delivery_observations (
           id,delivery_record_id,project_id,sequence,status,source_type,source_id,
           observed_at
         ) VALUES (
           $1,$2,'phase6-pg-project',2,'deploying','system','deployment-monitor',
           '2026-07-27T12:01:00Z'
         )`,
        [observationId, deliveryId],
      );
      await client.query(
        `UPDATE project_delivery_records
            SET status='deploying',current_observation_sequence=2,updated_at=now()
          WHERE id=$1`,
        [deliveryId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  };

  beforeAll(async () => {
    if (!databaseUrl) return;
    administrationPool = new Pool({ connectionString: databaseUrl, max: 2 });
    await administrationPool.query(`
      DO $role$
      BEGIN
        CREATE ROLE norns_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN
        NULL;
      END
      $role$;
    `);
    schemaName = `norns_phase6_${process.pid}_${Date.now()}`;
    await administrationPool.query(`CREATE SCHEMA "${schemaName}"`);
    applicationPool = new Pool({
      connectionString: databaseUrl,
      max: 6,
      options: `-c search_path=${schemaName}`,
    });
    const privilegedRunner = new NodePgTransactionRunner(applicationPool, {
      mode: "privileged",
    });
    const migrationDatabase: V2MigrationDatabase = {
      query: async <TRow = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await applicationPool.query(sql, params);
        return result.rowCount === null
          ? { rows: result.rows as TRow[] }
          : { rows: result.rows as TRow[], affectedRows: result.rowCount };
      },
      transaction: (work) => privilegedRunner.transaction(work),
    };
    await applicationPool.query(`
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    const applied = await runCurrentV2Migrations(migrationDatabase);
    expect(applied.at(-1)).toMatchObject({
      name: CONVERSATION_MOCKUPS_DASHBOARD_MIGRATION_NAME,
      applied: true,
    });
    await applicationPool.query(`
      INSERT INTO users (
        id,username,display_name,email,name,password_hash,password_hash_scheme,role,status
      ) VALUES (
        'phase6-pg-user','phase6-pg@example.test','Phase 6 PostgreSQL',
        'phase6-pg@example.test','Phase 6 PostgreSQL','hash','scrypt-v1','admin','active'
      );
      INSERT INTO projects (
        id,name,status,assignment_policy_ref,verification_policy_ref,budget_policy_ref,
        owner_user_id
      ) VALUES (
        'phase6-pg-project','Phase 6 PostgreSQL','active',
        'assignment','verification','budget','phase6-pg-user'
      );
      INSERT INTO repository_bindings (
        id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
        repository_display_name,granted_permissions,default_branch,
        verification_policy_ref,repository_health,created_by_actor_type,created_by_actor_id
      ) VALUES (
        'phase6-pg-binding','phase6-pg-project','local_runner','connected',
        'phase6-pg-runner','phase6-pg-workspace','phase6-pg-repository',
        'Phase 6 PostgreSQL','{}'::jsonb,'main','verification','healthy',
        'human','phase6-pg-user'
      );
    `);
  }, 45_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    await applicationPool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await administrationPool.end();
  });

  it("replays 0040 by checksum and exposes its exact catalog and runtime grants", async () => {
    const privilegedRunner = new NodePgTransactionRunner(applicationPool, {
      mode: "privileged",
    });
    const migrationDatabase: V2MigrationDatabase = {
      query: async <TRow = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await applicationPool.query(sql, params);
        return result.rowCount === null
          ? { rows: result.rows as TRow[] }
          : { rows: result.rows as TRow[], affectedRows: result.rowCount };
      },
      transaction: (work) => privilegedRunner.transaction(work),
    };
    const replay = await runCurrentV2Migrations(migrationDatabase);
    expect(replay.at(-1)).toMatchObject({
      name: CONVERSATION_MOCKUPS_DASHBOARD_MIGRATION_NAME,
      applied: false,
    });

    const catalog = await applicationPool.query<{
      marker: string | null;
      immutable_triggers: number;
      provider_unique: boolean;
    }>(
      `SELECT
         to_regclass('conversation_mockups_dashboard_v1')::text AS marker,
         (
           SELECT count(*)::int
             FROM pg_trigger trigger
             JOIN pg_class relation ON relation.oid=trigger.tgrelid
             JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
            WHERE NOT trigger.tgisinternal
              AND namespace.nspname=current_schema()
              AND tgname = ANY(ARRAY[
                'conversation_mockup_versions_immutable_guard',
                'conversation_mockup_decisions_immutable_guard',
                'project_delivery_observations_immutable_guard',
                'implementation_visual_evidence_immutable_guard'
              ])
         ) AS immutable_triggers,
         to_regclass('project_delivery_observations_provider_event_unique')
           IS NOT NULL AS provider_unique`,
    );
    expect(catalog.rows[0]).toEqual({
      marker: "conversation_mockups_dashboard_v1",
      immutable_triggers: 4,
      provider_unique: true,
    });

    const privileges = await applicationPool.query<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT
         has_table_privilege('norns_app','project_delivery_observations','SELECT')
           AS can_select,
         has_table_privilege('norns_app','project_delivery_observations','INSERT')
           AS can_insert,
         has_table_privilege('norns_app','project_delivery_observations','UPDATE')
           AS can_update,
         has_table_privilege('norns_app','project_delivery_observations','DELETE')
           AS can_delete`,
    );
    expect(privileges.rows[0]).toEqual({
      can_select: true,
      can_insert: true,
      can_update: false,
      can_delete: false,
    });
    const urlPolicy = await applicationPool.query<{
      public_host: boolean;
      localhost: boolean;
      short_loopback: boolean;
      integer_loopback: boolean;
      metadata_ip: boolean;
      private_ip: boolean;
      public_ipv6: boolean;
      mapped_loopback: boolean;
      link_local_ipv6: boolean;
      multicast_ipv6: boolean;
      runtime_execute: boolean;
      public_execute: boolean;
    }>(
      `SELECT
         norns_is_public_https_url('https://norns.example.test/health') AS public_host,
         norns_is_public_https_url('https://localhost/private') AS localhost,
         norns_is_public_https_url('https://127.1/private') AS short_loopback,
         norns_is_public_https_url('https://2130706433/private') AS integer_loopback,
         norns_is_public_https_url('https://169.254.169.254/latest/meta-data') AS metadata_ip,
         norns_is_public_https_url('https://10.0.0.1/health') AS private_ip,
         norns_is_public_https_url('https://[2606:4700:4700::1111]/health') AS public_ipv6,
         norns_is_public_https_url('https://[::ffff:127.0.0.1]/private') AS mapped_loopback,
         norns_is_public_https_url('https://[feb0::1]/private') AS link_local_ipv6,
         norns_is_public_https_url('https://[ff02::1]/private') AS multicast_ipv6,
         has_function_privilege(
           'norns_app','norns_is_public_https_url(text)','EXECUTE'
         ) AS runtime_execute,
         has_function_privilege(
           'public','norns_is_public_https_url(text)','EXECUTE'
         ) AS public_execute`,
    );
    expect(urlPolicy.rows[0]).toEqual({
      public_host: true,
      localhost: false,
      short_loopback: false,
      integer_loopback: false,
      metadata_ip: false,
      private_ip: false,
      public_ipv6: true,
      mapped_loopback: false,
      link_local_ipv6: false,
      multicast_ipv6: false,
      runtime_execute: true,
      public_execute: false,
    });
  }, 45_000);

  it("enforces append-only observations and immutable deployment identity", async () => {
    await seedDelivery("phase6-pg-immutable");
    await expect(
      applicationPool.query(
        `UPDATE project_delivery_observations
            SET source_id='rewritten'
          WHERE id='phase6-pg-immutable-observation-1'`,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      applicationPool.query(
        `DELETE FROM project_delivery_observations
          WHERE id='phase6-pg-immutable-observation-1'`,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      applicationPool.query(
        `UPDATE project_delivery_records
            SET commit_sha=repeat('b',40)
          WHERE id='phase6-pg-immutable'`,
      ),
    ).rejects.toThrow(/identity and exact commit are immutable/);
    await expect(
      applicationPool.query("DELETE FROM project_delivery_records WHERE id='phase6-pg-immutable'"),
    ).rejects.toThrow(/durable audit records/);
    await expect(
      applicationPool.query(
        `INSERT INTO project_delivery_observations (
           id,delivery_record_id,project_id,sequence,status,source_type,source_id,
           provider_event_id,observed_at
         ) VALUES (
           'phase6-pg-wrong-provider','phase6-pg-immutable','phase6-pg-project',
           2,'deploying','provider','vercel','provider-event-1',
           '2026-07-27T12:01:00Z'
         )`,
      ),
    ).rejects.toThrow(/out of scope, order, or lifecycle/);

    const strictDeliveryId = "phase6-pg-strict-json";
    await seedDelivery(strictDeliveryId);
    const invalidReceipt = JSON.stringify({
      schema_version: "2",
      kind: "deployment_observation",
      delivery_record_id: strictDeliveryId,
      project_id: "phase6-pg-project",
      provider_id: "railway",
      provider_deployment_id: `provider-${strictDeliveryId}`,
      commit_sha: "a".repeat(40),
      environment: "production",
      service: "web",
      sequence: "2",
      status: "succeeded",
      source_type: "provider",
      source_id: "railway",
      provider_event_id: "phase6-pg-strict-event",
      public_url: "https://norns.example.test",
      health_url: "https://norns.example.test/health",
      health_status_code: "200",
      observed_at: "2026-07-27T12:01:00.000Z",
    });
    const receiptHash = await applicationPool.query<{ hash: string }>(
      "SELECT encode(sha256(convert_to($1,'UTF8')),'hex') AS hash",
      [invalidReceipt],
    );
    const invalidReceiptHash = receiptHash.rows[0]?.hash;
    if (!invalidReceiptHash) throw new Error("PostgreSQL did not hash the invalid receipt");
    await applicationPool.query(
      `INSERT INTO artifacts (
         id,project_id,kind,label,media_type,storage_ref,content_hash,byte_size,
         provenance_actor_type,redaction_status
       ) VALUES (
         'phase6-pg-strict-receipt','phase6-pg-project','deployment_evidence',
         'Strict receipt','application/json','db://artifact/phase6-pg-strict-receipt',
         $1,octet_length(convert_to($2,'UTF8')),'system','not_required'
       )`,
      [invalidReceiptHash, invalidReceipt],
    );
    await applicationPool.query(
      `INSERT INTO artifact_blobs (
         artifact_id,project_id,content,content_hash,byte_size
       ) VALUES (
         'phase6-pg-strict-receipt','phase6-pg-project',convert_to($1,'UTF8'),$2,
         octet_length(convert_to($1,'UTF8'))
       )`,
      [invalidReceipt, invalidReceiptHash],
    );
    await expect(
      applicationPool.query(
        `INSERT INTO project_delivery_observations (
           id,delivery_record_id,project_id,sequence,status,source_type,source_id,
           provider_event_id,public_url,health_url,health_status_code,
           evidence_artifact_id,evidence_artifact_hash,observed_at
         ) VALUES (
           'phase6-pg-strict-observation',$1,'phase6-pg-project',2,'succeeded',
           'provider','railway','phase6-pg-strict-event',
           'https://norns.example.test','https://norns.example.test/health',200,
           'phase6-pg-strict-receipt',$2,'2026-07-27T12:01:00Z'
         )`,
        [strictDeliveryId, invalidReceiptHash],
      ),
    ).rejects.toThrow(/exact attributed evidence payload/);
  });

  it("serializes the projection cursor so only one concurrent observation advances", async () => {
    const deliveryId = "phase6-pg-concurrent";
    await seedDelivery(deliveryId);
    const firstClient = await applicationPool.connect();
    const secondClient = await applicationPool.connect();
    try {
      const results = await Promise.allSettled([
        advanceDelivery(firstClient, deliveryId, "phase6-pg-concurrent-observation-a"),
        advanceDelivery(secondClient, deliveryId, "phase6-pg-concurrent-observation-b"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" ? String(rejected.reason) : "").toMatch(
        /out of scope, order, or lifecycle/,
      );
    } finally {
      firstClient.release();
      secondClient.release();
    }

    const state = await applicationPool.query<{
      status: string;
      current_observation_sequence: number;
      observations: number;
    }>(
      `SELECT delivery.status,delivery.current_observation_sequence,
              count(observation.id)::int AS observations
         FROM project_delivery_records delivery
         JOIN project_delivery_observations observation
           ON observation.delivery_record_id=delivery.id
        WHERE delivery.id=$1
        GROUP BY delivery.status,delivery.current_observation_sequence`,
      [deliveryId],
    );
    expect(state.rows[0]).toEqual({
      status: "deploying",
      current_observation_sequence: 2,
      observations: 2,
    });
  });
});
