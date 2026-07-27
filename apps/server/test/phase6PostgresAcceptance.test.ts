import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodePgTransactionRunner } from "../src/persistence/v2/database.js";
import {
  CONVERSATION_INFERENCE_BUDGET_MIGRATION_NAME,
  type V2MigrationDatabase,
  runCurrentV2Migrations,
} from "../src/persistence/v2/migrate.js";
import {
  Phase6ArtifactService,
  Phase6DashboardService,
  Phase6DeploymentService,
  Phase6MockupService,
} from "../src/phase6/index.js";
import { buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";

const databaseUrl = process.env.V2_POSTGRES_TEST_URL;
const postgresDescribe = databaseUrl ? describe.sequential : describe.skip;

postgresDescribe("Phase 6 real PostgreSQL acceptance", () => {
  let administrationPool: Pool;
  let applicationPool: Pool;
  let schemaName: string;
  let transactions: NodePgTransactionRunner;

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
    transactions = privilegedRunner;
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
      name: CONVERSATION_INFERENCE_BUDGET_MIGRATION_NAME,
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
      INSERT INTO projects (
        id,name,status,assignment_policy_ref,verification_policy_ref,budget_policy_ref,
        owner_user_id
      ) VALUES (
        'phase6-pg-other-project','Phase 6 Other PostgreSQL','active',
        'assignment','verification','budget','phase6-pg-user'
      );
      INSERT INTO repository_bindings (
        id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
        repository_display_name,granted_permissions,default_branch,
        verification_policy_ref,repository_health,created_by_actor_type,created_by_actor_id
      ) VALUES (
        'phase6-pg-other-binding','phase6-pg-other-project','local_runner','connected',
        'phase6-pg-other-runner','phase6-pg-other-workspace','phase6-pg-other-repository',
        'Phase 6 Other PostgreSQL','{}'::jsonb,'main','verification','healthy',
        'human','phase6-pg-user'
      );
      INSERT INTO work_items (
        id,project_id,created_by_user_id,title,objective
      ) VALUES
        ('phase6-pg-work','phase6-pg-project','phase6-pg-user',
         'Artifact acceptance','Verify exact evidence storage'),
        ('phase6-pg-other-work','phase6-pg-other-project','phase6-pg-user',
         'Other artifact acceptance','Verify project isolation');
      INSERT INTO work_conversations (
        id,project_id,work_item_id,created_by_user_id,kind,provider,model
      ) VALUES
        ('phase6-pg-conversation','phase6-pg-project','phase6-pg-work',
         'phase6-pg-user','task','openai','gpt-5.6'),
        ('phase6-pg-other-conversation','phase6-pg-other-project','phase6-pg-other-work',
         'phase6-pg-user','task','openai','gpt-5.6');
    `);
  }, 45_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    await applicationPool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await administrationPool.end();
  });

  it("replays Phase 6 migrations by checksum and exposes their exact catalog and grants", async () => {
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
      name: CONVERSATION_INFERENCE_BUDGET_MIGRATION_NAME,
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

  it("deduplicates project bytes across semantic purposes at the exact quota boundary", async () => {
    const bytes = Buffer.from('{"phase":6}', "utf8");
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const artifacts = new Phase6ArtifactService(transactions, bytes.byteLength);
    const put = (purpose: "mockup_manifest" | "visual_comparison", idempotencyKey: string) =>
      artifacts.put({
        metadata: {
          project_id: "phase6-pg-project",
          work_item_id: "phase6-pg-work",
          conversation_id: "phase6-pg-conversation",
          media_type: "application/json",
          purpose,
          content_hash: contentHash,
          byte_size: bytes.byteLength,
          idempotency_key: idempotencyKey,
        },
        content: bytes,
        label: purpose,
        provenance: { actor_type: "system", actor_id: "phase6-acceptance" },
      });

    const manifest = await put("mockup_manifest", "artifact-first");
    expect(manifest.quota).toMatchObject({
      used_bytes_before: 0,
      requested_bytes: bytes.byteLength,
      allowed: true,
    });
    const exactKeyReplay = await put("mockup_manifest", "artifact-first");
    expect(exactKeyReplay).toMatchObject({ id: manifest.id, replayed: true });
    await expect(
      artifacts.put({
        metadata: {
          project_id: "phase6-pg-project",
          work_item_id: "phase6-pg-work",
          conversation_id: "phase6-pg-conversation",
          media_type: "application/json",
          purpose: "mockup_manifest",
          content_hash: createHash("sha256")
            .update(Buffer.from('{"phase":7}', "utf8"))
            .digest("hex"),
          byte_size: Buffer.byteLength('{"phase":7}'),
          idempotency_key: "artifact-first",
        },
        content: Buffer.from('{"phase":7}', "utf8"),
        label: "mockup_manifest",
        provenance: { actor_type: "system", actor_id: "phase6-acceptance" },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const independentActor = await artifacts.put({
      metadata: {
        project_id: "phase6-pg-project",
        work_item_id: "phase6-pg-work",
        conversation_id: "phase6-pg-conversation",
        media_type: "application/json",
        purpose: "mockup_manifest",
        content_hash: contentHash,
        byte_size: bytes.byteLength,
        idempotency_key: "artifact-first",
      },
      content: bytes,
      label: "mockup_manifest",
      provenance: { actor_type: "system", actor_id: "phase6-independent-actor" },
    });
    expect(independentActor).toMatchObject({ id: manifest.id, replayed: false });
    const comparison = await put("visual_comparison", "artifact-second");
    expect(comparison.id).not.toBe(manifest.id);
    expect(comparison.quota).toMatchObject({
      used_bytes_before: bytes.byteLength,
      requested_bytes: 0,
      allowed: true,
    });
    const replay = await put("mockup_manifest", "artifact-replay");
    expect(replay.id).toBe(manifest.id);
    expect(replay.quota.requested_bytes).toBe(0);

    const stored = await applicationPool.query<{
      references: number;
      unique_bytes: number;
    }>(
      `SELECT count(*)::int AS references,
              sum(byte_size) FILTER (
                WHERE artifact_id IN (
                  SELECT min(artifact_id) FROM artifact_blobs
                   WHERE project_id='phase6-pg-project' GROUP BY content_hash
                )
              )::int AS unique_bytes
         FROM artifact_blobs
        WHERE project_id='phase6-pg-project'`,
    );
    expect(stored.rows[0]).toEqual({
      references: 2,
      unique_bytes: bytes.byteLength,
    });

    const differentBytes = Buffer.from('{"phase":7}', "utf8");
    await expect(
      artifacts.put({
        metadata: {
          project_id: "phase6-pg-project",
          work_item_id: "phase6-pg-work",
          conversation_id: "phase6-pg-conversation",
          media_type: "application/json",
          purpose: "deployment_evidence",
          content_hash: createHash("sha256").update(differentBytes).digest("hex"),
          byte_size: differentBytes.byteLength,
          idempotency_key: "artifact-over-quota",
        },
        content: differentBytes,
        label: "over quota",
        provenance: { actor_type: "system", actor_id: "phase6-acceptance" },
      }),
    ).rejects.toMatchObject({ code: "project_quota" });
    await expect(artifacts.content("phase6-pg-other-project", manifest.id)).rejects.toMatchObject({
      code: "artifact_not_found",
    });
  });

  it("replays exact deployment identities and keeps manual observation authorship distinct", async () => {
    const deployments = new Phase6DeploymentService(transactions);
    const createInput = {
      project_id: "phase6-pg-project",
      phase_id: null,
      task_id: null,
      run_id: null,
      repository_binding_id: "phase6-pg-binding",
      environment: "production",
      service: "manual-authorship",
      commit_sha: "b".repeat(40),
      provider_id: "railway",
      provider_deployment_id: "manual-authorship-1",
      started_at: "2026-07-27T13:00:00.000Z",
      source_id: "phase6-pg-user",
    };
    const created = await deployments.create(createInput);
    expect(await deployments.create(createInput)).toEqual(created);
    await expect(
      deployments.create({ ...createInput, commit_sha: "c".repeat(40) }),
    ).rejects.toMatchObject({ code: "deployment_conflict" });
    for (const changed of [
      { phase_id: "phase6-pg-phase" },
      { started_at: "2026-07-27T13:00:01.000Z" },
      { source_id: "phase6-pg-other-user" },
    ]) {
      await expect(deployments.create({ ...createInput, ...changed })).rejects.toMatchObject({
        code: "deployment_conflict",
      });
    }

    const observedAt = "2026-07-27T13:01:00.000Z";
    const evidenceBytes = Buffer.from(
      JSON.stringify({
        schema_version: 2,
        kind: "deployment_observation",
        delivery_record_id: created.id,
        project_id: createInput.project_id,
        provider_id: createInput.provider_id,
        provider_deployment_id: createInput.provider_deployment_id,
        commit_sha: createInput.commit_sha,
        environment: createInput.environment,
        service: createInput.service,
        sequence: 2,
        status: "deploying",
        source_type: "human",
        source_id: "phase6-pg-user",
        provider_event_id: null,
        public_url: null,
        health_url: null,
        health_status_code: null,
        observed_at: observedAt,
      }),
      "utf8",
    );
    const observationEvidence = (
      await new Phase6ArtifactService(transactions).put({
        metadata: {
          project_id: "phase6-pg-project",
          work_item_id: "phase6-pg-work",
          conversation_id: "phase6-pg-conversation",
          media_type: "application/json",
          purpose: "deployment_evidence",
          content_hash: createHash("sha256").update(evidenceBytes).digest("hex"),
          byte_size: evidenceBytes.byteLength,
          idempotency_key: "observation-evidence",
        },
        content: evidenceBytes,
        label: "Deployment observation evidence",
        provenance: { actor_type: "system", actor_id: "phase6-acceptance" },
      })
    ).evidence;
    const observationInput = {
      project_id: "phase6-pg-project",
      delivery_record_id: created.id,
      expected_sequence: 2,
      status: "deploying" as const,
      public_url: null,
      health_url: null,
      health_status_code: null,
      evidence: observationEvidence,
      observed_at: observedAt,
      idempotency_key: "manual-observation-1",
    };
    await expect(
      deployments.recordHumanObservation(
        {
          ...observationInput,
          evidence: { ...observationEvidence, label: "Caller supplied mismatch" },
        },
        "phase6-pg-user",
      ),
    ).rejects.toMatchObject({ code: "observation_conflict" });
    const first = await deployments.recordHumanObservation(observationInput, "phase6-pg-user");
    expect(first).toMatchObject({
      replayed: false,
      observation: {
        source_type: "human",
        source_id: "phase6-pg-user",
        provider_event_id: null,
      },
    });
    expect(
      await deployments.recordHumanObservation(observationInput, "phase6-pg-user"),
    ).toMatchObject({ replayed: true, observation: { id: first.observation.id } });
    await expect(
      deployments.recordHumanObservation(
        { ...observationInput, status: "failed" },
        "phase6-pg-user",
      ),
    ).rejects.toMatchObject({ code: "observation_conflict" });
    await expect(
      deployments.recordHumanObservation(
        { ...observationInput, observed_at: "2026-07-27T13:01:01.000Z" },
        "phase6-pg-user",
      ),
    ).rejects.toMatchObject({ code: "observation_conflict" });
    const independentObservation = await deployments.recordHumanObservation(
      {
        ...observationInput,
        expected_sequence: 3,
        evidence: null,
        observed_at: "2026-07-27T13:02:00.000Z",
      },
      "phase6-pg-other-user",
    );
    expect(independentObservation).toMatchObject({
      replayed: false,
      observation: { source_id: "phase6-pg-other-user", sequence: 3 },
    });
    await expect(
      deployments.observations("phase6-pg-other-project", created.id),
    ).rejects.toMatchObject({ code: "deployment_not_found" });
  });

  it("reports unknown budget truthfully while keeping empty authoritative sections available", async () => {
    const dashboards = new Phase6DashboardService(
      transactions,
      new Phase6MockupService(transactions),
      new Phase6DeploymentService(transactions),
      () => new Date("2026-07-27T13:30:00.000Z"),
    );
    const dashboard = await dashboards.read("phase6-pg-other-project");
    expect(dashboard.budget).toMatchObject({
      availability: "unavailable",
      source: "usage_ledger_and_approved_plan",
      reason_code: "no_authoritative_budget_source",
      retryable: false,
      data: null,
    });
    expect(dashboard.recent_verification).toEqual({
      availability: "available",
      source: "verification_results",
      observed_at: "2026-07-27T13:30:00.000Z",
      data: [],
    });
    expect(dashboard.recent_deployments).toMatchObject({
      availability: "available",
      data: [],
    });
    expect(dashboard.conversations).toMatchObject({
      availability: "available",
      data: [expect.objectContaining({ id: "phase6-pg-other-conversation" })],
    });

    await applicationPool.query(`
      INSERT INTO phases (
        id,project_id,objective_summary,priority,status,approved_budget_usd,initiated_by_user_id
      ) VALUES (
        'phase6-pg-unapproved-phase','phase6-pg-other-project','Unapproved budget',
        1,'proposed',999,'phase6-pg-user'
      );
    `);
    expect((await dashboards.read("phase6-pg-other-project")).budget).toMatchObject({
      availability: "unavailable",
      reason_code: "no_authoritative_budget_source",
      data: null,
    });

    await applicationPool.query(`
      INSERT INTO ai_usage_events (
        id,request_id,sequence,event_type,status,occurred_at,provider,model,endpoint,
        request_type,initiated_by_user_id,project_id,usage_source,confidence,
        input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
        cost_usd,cost_classification
      ) VALUES
        (
          'phase6-pg-priced-start','phase6-pg-priced-request',1,'request_started',
          'started','2026-07-27T13:19:00Z','openai','gpt-5.6','responses',
          'conversation','phase6-pg-user','phase6-pg-other-project','provider_api',1,
          NULL,NULL,NULL,NULL,NULL,'unavailable'
        ),
        (
          'phase6-pg-priced-usage','phase6-pg-priced-request',2,'usage_observed',
          'in_progress','2026-07-27T13:20:00Z','openai','gpt-5.6','responses',
          'conversation','phase6-pg-user','phase6-pg-other-project','provider_api',1,
          100,25,0,0,0.25,'actual'
        ),
        (
          'phase6-pg-unpriced-start','phase6-pg-unpriced-request',1,'request_started',
          'started','2026-07-27T13:20:30Z','openai','gpt-5.6','responses',
          'conversation','phase6-pg-user','phase6-pg-other-project','provider_api',1,
          NULL,NULL,NULL,NULL,NULL,'unavailable'
        ),
        (
          'phase6-pg-unpriced-usage','phase6-pg-unpriced-request',2,'usage_observed',
          'in_progress','2026-07-27T13:21:00Z','openai','gpt-5.6','responses',
          'conversation','phase6-pg-user','phase6-pg-other-project','provider_api',1,
          100,25,0,0,NULL,'unavailable'
        );
    `);
    expect((await dashboards.read("phase6-pg-other-project")).budget).toMatchObject({
      availability: "unavailable",
      source: "usage_ledger_and_approved_plan",
      reason_code: "incomplete_usage_pricing",
      retryable: false,
      data: null,
    });
  });

  it("authenticates provider callbacks independently of project membership and fences ownership", async () => {
    const deployments = new Phase6DeploymentService(transactions);
    const created = await deployments.create({
      project_id: "phase6-pg-project",
      phase_id: null,
      task_id: null,
      run_id: null,
      repository_binding_id: "phase6-pg-binding",
      environment: "production",
      service: "provider-auth",
      commit_sha: "d".repeat(40),
      provider_id: "railway",
      provider_deployment_id: "provider-auth-1",
      started_at: "2026-07-27T14:00:00.000Z",
      source_id: "phase6-pg-user",
    });
    const server = await buildServer({
      stores: new RelayStores(),
      users: new UserStore(),
      execution: { transactions },
      integrationEnvironment: {
        NORNS_DEPLOYMENT_PROVIDER_TOKENS_JSON: JSON.stringify({
          railway: "railway-provider-token",
          attacker: "attacker-provider-token",
        }),
      },
    });
    const payload = {
      project_id: "phase6-pg-project",
      delivery_record_id: created.id,
      expected_sequence: 2,
      status: "deploying",
      provider_id: "railway",
      provider_event_id: "railway-event-1",
      public_url: null,
      health_url: null,
      health_status_code: null,
      evidence: null,
      observed_at: "2026-07-27T14:01:00.000Z",
      idempotency_key: "provider-observation-1",
    };
    try {
      expect(
        (
          await server.app.inject({
            method: "POST",
            url: "/api/integrations/deployments/observations",
            payload,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await server.app.inject({
            method: "POST",
            url: "/api/integrations/deployments/observations",
            headers: { authorization: "Bearer wrong-token" },
            payload,
          })
        ).statusCode,
      ).toBe(401);
      const forged = await server.app.inject({
        method: "POST",
        url: "/api/integrations/deployments/observations",
        headers: { authorization: "Bearer attacker-provider-token" },
        payload: {
          ...payload,
          provider_id: "attacker",
          provider_event_id: "attacker-event-1",
          idempotency_key: "attacker-observation-1",
        },
      });
      expect(forged.statusCode).toBe(409);
      expect(forged.json()).toMatchObject({ error: "observation_conflict" });

      const accepted = await server.app.inject({
        method: "POST",
        url: "/api/integrations/deployments/observations",
        headers: { authorization: "Bearer railway-provider-token" },
        payload,
      });
      expect(accepted.statusCode).toBe(201);
      expect(accepted.json()).toMatchObject({
        replayed: false,
        observation: {
          source_type: "provider",
          source_id: "railway",
          provider_event_id: "railway-event-1",
        },
      });
      const replay = await server.app.inject({
        method: "POST",
        url: "/api/integrations/deployments/observations",
        headers: { authorization: "Bearer railway-provider-token" },
        payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ replayed: true });
    } finally {
      await server.app.close();
    }
  });

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
