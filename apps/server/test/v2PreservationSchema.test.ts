import { PGlite } from "@electric-sql/pglite";
import type { CommandEnvelopeT } from "@norns/contracts";
import { getTableName } from "drizzle-orm";
import { type PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import {
  ACTIONS_DISPATCH_RUNNER_IDENTITY_MIGRATION_NAME,
  ACTIONS_EXECUTION_MIGRATION_NAME,
  AI_USAGE_TELEMETRY_MIGRATION_NAME,
  ATTACHMENTS_MIGRATION_NAME,
  CODEX_REASONING_EFFORT_MIGRATION_NAME,
  CONVERSATION_DOMAIN_MIGRATION_NAME,
  CONVERSATION_EXECUTION_HANDOFF_MIGRATION_NAME,
  CONVERSATION_FILE_ATTACHMENTS_MIGRATION_NAME,
  CONVERSATION_HUMAN_STEERING_MIGRATION_NAME,
  CONVERSATION_INFERENCE_BUDGET_MIGRATION_NAME,
  CONVERSATION_MESSAGE_BRANCHES_MIGRATION_NAME,
  CONVERSATION_MOCKUPS_DASHBOARD_MIGRATION_NAME,
  CONVERSATION_MODEL_SWITCHING_MIGRATION_NAME,
  CONVERSATION_ORGANIZATION_MIGRATION_NAME,
  CONVERSATION_PLAN_HANDOFF_CHOICES_MIGRATION_NAME,
  CONVERSATION_PLAN_WORKFLOW_MIGRATION_NAME,
  CONVERSATION_STREAM_LIFECYCLE_MIGRATION_NAME,
  DEBATE_WORKFLOW_MIGRATION_NAME,
  DEVICE_CANCELLATION_TRACKING_MIGRATION_NAME,
  DEVICE_HTTP_REQUEST_REPLAYS_MIGRATION_NAME,
  DEVICE_IDENTITY_CORE_MIGRATION_NAME,
  DEVICE_MANAGEMENT_OBSERVATIONS_MIGRATION_NAME,
  DEVICE_REPOSITORY_ACCESS_MIGRATION_NAME,
  DISPATCH_CONTEXT_SCOPE_MIGRATION_NAME,
  FRONTDOOR_PHASE_BRIDGE_MIGRATION_NAME,
  FRONTDOOR_PROGRESS_TRACKING_MIGRATION_NAME,
  GATEWAY_CREDENTIALS_MIGRATION_NAME,
  GATEWAY_DEVICE_AUTHORIZATION_MIGRATION_NAME,
  GITHUB_APP_MANIFEST_MIGRATION_NAME,
  GITHUB_AUTHORIZATION_REMOVAL_MIGRATION_NAME,
  GITHUB_CONNECTION_REMOVAL_MIGRATION_NAME,
  GLOBAL_RULES_MIGRATION_NAME,
  KNOWLEDGE_PACKAGES_MIGRATION_NAME,
  ONBOARDING_BINDINGS_MIGRATION_NAME,
  ONBOARDING_INTENTS_UPDATE_GRANT_MIGRATION_NAME,
  ONBOARDING_REPOSITORY_INTENTS_MIGRATION_NAME,
  PHASE1_V2_MIGRATION_NAME,
  PHASE2_PRESERVATION_MIGRATION_NAME,
  PHASE3_SOURCE_BINDINGS_MIGRATION_NAME,
  PHASE5_ATTENTION_MIGRATION_NAME,
  PHASE6_ACCEPTANCE_CORRECTIONS_MIGRATION_NAME,
  PHASE6_COORDINATION_MIGRATION_NAME,
  PHASE6_RUNTIME_DELIVERY_MIGRATION_NAME,
  PHASE7_HARDENING_MIGRATION_NAME,
  PHASE8_CUTOVER_COMPLETION_MIGRATION_NAME,
  PHASE_CONCURRENCY_CONFLICTS_MIGRATION_NAME,
  PHASE_TAB_PLANNING_DECISIONS_MIGRATION_NAME,
  PLANNING_RUNS_MIGRATION_NAME,
  PROJECT_ACCESS_ATTRIBUTION_MIGRATION_NAME,
  QC_COMMUNICATION_MIGRATION_NAME,
  QC_CONTROL_TRANSCRIPT_MIGRATION_NAME,
  QC_FINDING_TRIAGE_MIGRATION_NAME,
  QC_ROUTINE_ROUND_DEFAULT_MIGRATION_NAME,
  QC_TARGETED_REVISIONS_MIGRATION_NAME,
  QUICK_CHANGES_MIGRATION_NAME,
  RUN_PUBLICATION_MIGRATION_NAME,
  SHADOW_EVIDENCE_ORDER_MIGRATION_NAME,
  TASK_CONTEXT_MIGRATION_NAME,
  USAGE_CALIBRATION_ANALYTICS_MIGRATION_NAME,
  USAGE_INTELLIGENCE_POLICIES_MIGRATION_NAME,
  type V2MigrationDatabase,
  WORKSPACE_CONNECTIONS_MIGRATION_NAME,
  currentV2MigrationSources,
  runCurrentV2Migrations,
  runPhase1V2Migration,
  runPhase2PreservationMigration,
  runV2Migrations,
} from "../src/persistence/v2/migrate.js";
import { phase2PreservationSchema } from "../src/persistence/v2/schema.js";
import {
  Phase6DashboardService,
  Phase6DeploymentService,
  Phase6MockupService,
  Phase6VisualEvidenceCollectionWorker,
  Phase6VisualEvidenceService,
  renderDeterministicMockup,
} from "../src/phase6/index.js";

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;

describe.sequential("Phase 2 forward migration dependency", () => {
  it("refuses 0040 when the exact 0039 ledger dependency is absent", async () => {
    const candidate = new PGlite();
    try {
      await candidate.exec(`
        CREATE ROLE norns_app NOLOGIN;
        CREATE TABLE norns_state (
          key TEXT PRIMARY KEY,
          snapshot JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      const sources = await currentV2MigrationSources();
      const phase6Index = sources.findIndex(
        (source) => source.name === CONVERSATION_MOCKUPS_DASHBOARD_MIGRATION_NAME,
      );
      expect(phase6Index).toBeGreaterThan(0);
      const phase6Source = sources[phase6Index];
      if (!phase6Source) throw new Error("Phase 6 migration source is missing");
      await runV2Migrations(asMigrationDatabase(candidate), sources.slice(0, phase6Index));
      await candidate.query("DELETE FROM norns_schema_migrations WHERE name=$1", [
        CONVERSATION_HUMAN_STEERING_MIGRATION_NAME,
      ]);
      await expect(runV2Migrations(asMigrationDatabase(candidate), [phase6Source])).rejects.toThrow(
        /requires 0039_conversation_human_steering/,
      );
      const marker = await candidate.query<{ marker: string | null }>(
        "SELECT to_regclass('conversation_mockups_dashboard_v1')::text AS marker",
      );
      expect(marker.rows[0]?.marker).toBeNull();
    } finally {
      await candidate.close();
    }
  }, 30_000);

  it("normalizes every schema-valid Phase 5 mockup status without inventing evidence", async () => {
    const candidate = new PGlite();
    try {
      await candidate.exec(`
        CREATE ROLE norns_app NOLOGIN;
        CREATE TABLE norns_state (
          key TEXT PRIMARY KEY,
          snapshot JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      const sources = await currentV2MigrationSources();
      const phase6Index = sources.findIndex(
        (source) => source.name === CONVERSATION_MOCKUPS_DASHBOARD_MIGRATION_NAME,
      );
      const phase6Source = sources[phase6Index];
      if (!phase6Source) throw new Error("Phase 6 migration source is missing");
      await runV2Migrations(asMigrationDatabase(candidate), sources.slice(0, phase6Index));
      await candidate.exec("SET session_replication_role='replica'");
      try {
        for (const [index, status] of [
          "queued",
          "leased",
          "rendered",
          "failed",
          "cancelled",
        ].entries()) {
          const actionId = `legacy-mockup-action-${index}`;
          const requestId = `legacy-mockup-request-${index}`;
          await candidate.query(
            `INSERT INTO conversation_actions (
               id,project_id,work_item_id,conversation_id,initiated_by_user_id,
               actor_type,actor_id,source_message_id,action_type,payload,payload_hash,
               status,interaction_class
             ) VALUES (
               $1,'legacy-project','legacy-work','legacy-conversation','legacy-user',
               'system','migration','legacy-message','create_mockup',
               $2::jsonb,repeat('a',64),'proposed','mockup_request'
             )`,
            [
              actionId,
              JSON.stringify({
                parameters: {
                  brief: `Legacy ${status}`,
                  target: "responsive",
                  task_id: null,
                  artifact_refs: [],
                },
              }),
            ],
          );
          await candidate.query(
            `INSERT INTO conversation_mockup_requests (
               id,project_id,work_item_id,conversation_id,action_id,task_id,
               brief,target,artifact_refs,status
             ) VALUES (
               $1,'legacy-project','legacy-work','legacy-conversation',$2,NULL,
               $3,'responsive','[]'::jsonb,$4
             )`,
            [requestId, actionId, `Legacy ${status}`, status],
          );
        }
      } finally {
        await candidate.exec("SET session_replication_role='origin'");
      }
      await runV2Migrations(asMigrationDatabase(candidate), [phase6Source]);
      const rows = await candidate.query<{
        id: string;
        status: string;
        attempts: number;
        last_error: string | null;
      }>(
        `SELECT id,status,attempts,last_error
           FROM conversation_mockup_requests
          ORDER BY id`,
      );
      expect(rows.rows).toEqual([
        {
          id: "legacy-mockup-request-0",
          status: "queued",
          attempts: 0,
          last_error: null,
        },
        {
          id: "legacy-mockup-request-1",
          status: "queued",
          attempts: 1,
          last_error: expect.stringContaining("legacy lease"),
        },
        {
          id: "legacy-mockup-request-2",
          status: "failed",
          attempts: 0,
          last_error: expect.stringContaining("legacy rendered claim"),
        },
        {
          id: "legacy-mockup-request-3",
          status: "failed",
          attempts: 0,
          last_error: expect.stringContaining("legacy failure"),
        },
        {
          id: "legacy-mockup-request-4",
          status: "cancelled",
          attempts: 0,
          last_error: null,
        },
      ]);
    } finally {
      await candidate.close();
    }
  }, 30_000);

  it("refuses 0002 when the frozen 0001 migration is absent", async () => {
    const candidate = new PGlite();
    try {
      await expect(runPhase2PreservationMigration(asMigrationDatabase(candidate))).rejects.toThrow(
        /requires 0001_refoundation_v2/,
      );
      const table = await candidate.query<{ invitations: string | null }>(
        "SELECT to_regclass('invitations')::text AS invitations",
      );
      expect(table.rows[0]?.invitations).toBeNull();
      const tracking = await candidate.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM norns_schema_migrations",
      );
      expect(tracking.rows[0]?.count).toBe(0);
    } finally {
      await candidate.close();
    }
  });

  it("keeps the generalized runner checksum-pinned and replay-safe", async () => {
    const candidate = new PGlite();
    try {
      const source = {
        name: "test_forward_migration",
        sql: "CREATE TABLE forward_probe (id TEXT PRIMARY KEY)",
      };
      expect(await runV2Migrations(asMigrationDatabase(candidate), [source])).toMatchObject([
        { name: source.name, applied: true },
      ]);
      expect(await runV2Migrations(asMigrationDatabase(candidate), [source])).toMatchObject([
        { name: source.name, applied: false },
      ]);
      await expect(
        runV2Migrations(asMigrationDatabase(candidate), [
          { ...source, sql: `${source.sql}; ALTER TABLE forward_probe ADD COLUMN value TEXT` },
        ]),
      ).rejects.toThrow(/checksum mismatch/);
      const columns = await candidate.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM information_schema.columns
         WHERE table_name = 'forward_probe'`,
      );
      expect(columns.rows[0]?.count).toBe(1);
    } finally {
      await candidate.close();
    }
  });

  it("applies every current migration from a clean database in order", async () => {
    const candidate = new PGlite();
    try {
      await candidate.exec("CREATE ROLE norns_app NOLOGIN");
      const sources = await currentV2MigrationSources();
      const results = await runV2Migrations(asMigrationDatabase(candidate), sources);
      expect(results).toHaveLength(sources.length);
      expect(results.every((result) => result.applied)).toBe(true);
      const tracked = await candidate.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM norns_schema_migrations",
      );
      expect(tracked.rows[0]?.count).toBe(sources.length);
    } finally {
      await candidate.close();
    }
  }, 60_000);

  it("runs a `-- norns:no-transaction` marked migration outside a transaction and tracks it", async () => {
    const candidate = new PGlite();
    try {
      const source = {
        name: "test_no_transaction_migration",
        sql: "-- norns:no-transaction\nCREATE TABLE no_transaction_probe (id TEXT PRIMARY KEY)",
      };
      expect(await runV2Migrations(asMigrationDatabase(candidate), [source])).toMatchObject([
        { name: source.name, applied: true },
      ]);
      const table = await candidate.query<{ probe: string | null }>(
        "SELECT to_regclass('no_transaction_probe')::text AS probe",
      );
      expect(table.rows[0]?.probe).toBe("no_transaction_probe");
      const tracking = await candidate.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM norns_schema_migrations WHERE name = $1",
        [source.name],
      );
      expect(tracking.rows[0]?.count).toBe(1);
    } finally {
      await candidate.close();
    }
  });

  it("rolls back an unmarked migration that fails partway and leaves no tracking row", async () => {
    const candidate = new PGlite();
    try {
      const source = {
        name: "test_failing_transactional_migration",
        sql: `
          CREATE TABLE failing_probe (id TEXT PRIMARY KEY);
          INSERT INTO table_that_does_not_exist (id) VALUES ('x');
        `,
      };
      await expect(runV2Migrations(asMigrationDatabase(candidate), [source])).rejects.toThrow();
      const table = await candidate.query<{ probe: string | null }>(
        "SELECT to_regclass('failing_probe')::text AS probe",
      );
      expect(table.rows[0]?.probe).toBeNull();
      const tracking = await candidate.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM norns_schema_migrations WHERE name = $1",
        [source.name],
      );
      expect(tracking.rows[0]?.count).toBe(0);
    } finally {
      await candidate.close();
    }
  });

  it("classifies existing password formats and revokes unkeyed normalized sessions", async () => {
    const candidate = new PGlite();
    try {
      await candidate.exec(`
        CREATE ROLE norns_app NOLOGIN;
        CREATE TABLE norns_state (
          key TEXT PRIMARY KEY,
          snapshot JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await runPhase1V2Migration(asMigrationDatabase(candidate));
      await candidate.query(
        `INSERT INTO users (
           id, username, display_name, password_hash, role, status
         ) VALUES
           ('legacy-hash-user', 'legacy@example.com', 'Legacy',
            $1, 'member', 'active'),
           ('current-hash-user', 'current@example.com', 'Current',
            $2, 'admin', 'active')`,
        [
          `${"a".repeat(32)}:${"b".repeat(128)}`,
          `scrypt$v1$16384$8$1$${"c".repeat(22)}$${"d".repeat(86)}`,
        ],
      );
      await candidate.query(
        `INSERT INTO sessions (
           id, user_id, token_hash, expires_at, last_seen_at
         ) VALUES (
           'pre-phase2-session', 'current-hash-user', $1,
           now() + interval '1 day', now()
         )`,
        ["e".repeat(64)],
      );

      await runPhase2PreservationMigration(asMigrationDatabase(candidate));

      const users = await candidate.query<{
        id: string;
        email: string;
        password_hash_scheme: string;
      }>(
        `SELECT id, email, password_hash_scheme
         FROM users
         ORDER BY id`,
      );
      expect(users.rows).toEqual([
        {
          id: "current-hash-user",
          email: "current@example.com",
          password_hash_scheme: "scrypt-v1",
        },
        {
          id: "legacy-hash-user",
          email: "legacy@example.com",
          password_hash_scheme: "legacy-scrypt-v0",
        },
      ]);
      const session = await candidate.query<{
        status: string;
        reason: string;
        revoked: boolean;
      }>(
        `SELECT status, revocation_reason AS reason, revoked_at IS NOT NULL AS revoked
         FROM sessions
         WHERE id = 'pre-phase2-session'`,
      );
      expect(session.rows[0]).toEqual({
        status: "revoked",
        reason: "phase2_unkeyed_credential_revoked",
        revoked: true,
      });
    } finally {
      await candidate.close();
    }
  });
});

describe.sequential("Phase 2 preservation schema", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO norns_state (key, snapshot) VALUES
        ('users', '{"users":[],"sessions":[]}'::jsonb),
        ('projects', '{"projects":[]}'::jsonb),
        ('relay', '{"audit":[]}'::jsonb);
    `);
    await runCurrentV2Migrations(asMigrationDatabase(pg));
  }, 30_000);

  afterAll(async () => {
    if (!pg.closed) await pg.close();
  });

  it("applies all frozen and forward migrations idempotently", async () => {
    const second = await runCurrentV2Migrations(asMigrationDatabase(pg));
    const replayed = second.map(({ name, applied }) => ({ name, applied }));
    expect(replayed).toEqual(
      expect.arrayContaining([
        { name: PHASE1_V2_MIGRATION_NAME, applied: false },
        { name: PHASE2_PRESERVATION_MIGRATION_NAME, applied: false },
        { name: PHASE3_SOURCE_BINDINGS_MIGRATION_NAME, applied: false },
        { name: PHASE5_ATTENTION_MIGRATION_NAME, applied: false },
        { name: PHASE6_COORDINATION_MIGRATION_NAME, applied: false },
        { name: PHASE7_HARDENING_MIGRATION_NAME, applied: false },
        { name: PHASE8_CUTOVER_COMPLETION_MIGRATION_NAME, applied: false },
        { name: WORKSPACE_CONNECTIONS_MIGRATION_NAME, applied: false },
        { name: QC_COMMUNICATION_MIGRATION_NAME, applied: false },
        { name: GITHUB_APP_MANIFEST_MIGRATION_NAME, applied: false },
        { name: DEBATE_WORKFLOW_MIGRATION_NAME, applied: false },
        { name: PLANNING_RUNS_MIGRATION_NAME, applied: false },
        { name: FRONTDOOR_PHASE_BRIDGE_MIGRATION_NAME, applied: false },
        { name: ATTACHMENTS_MIGRATION_NAME, applied: false },
        { name: FRONTDOOR_PROGRESS_TRACKING_MIGRATION_NAME, applied: false },
        // ONBOARDING O2. Name is still `NNNN_`; the PM assigns the number at
        // integration, which is also when this entry's position changes.
        { name: ONBOARDING_BINDINGS_MIGRATION_NAME, applied: false },
        // ONBOARDING O4 (migration number assigned by the PM at integration).
        { name: ACTIONS_EXECUTION_MIGRATION_NAME, applied: false },
        // ONBOARDING O6. Name is still `NNNN_`; the PM assigns the number at
        // integration, which is also when this entry's position changes.
        { name: ONBOARDING_REPOSITORY_INTENTS_MIGRATION_NAME, applied: false },
        // EXECUTION E1. Name is still `NNNN_`; the PM assigns the number at
        // integration, which is also when this entry's position changes.
        { name: TASK_CONTEXT_MIGRATION_NAME, applied: false },
        // EXECUTION E2. Name is still `NNNN_`; the PM assigns the number at
        // integration, which is also when this entry's position changes.
        { name: DISPATCH_CONTEXT_SCOPE_MIGRATION_NAME, applied: false },
        // EXECUTION E9 — per-run gateway credentials.
        { name: GATEWAY_CREDENTIALS_MIGRATION_NAME, applied: false },
        // EXECUTION E10. Name is still `NNNN_`; the PM assigns the number at
        // integration, which is also when this entry's position changes.
        { name: RUN_PUBLICATION_MIGRATION_NAME, applied: false },
        // EXECUTION E5. Name is still `NNNN_`; the PM assigns the number at
        // integration, which is also when this entry's position changes.
        { name: ACTIONS_DISPATCH_RUNNER_IDENTITY_MIGRATION_NAME, applied: false },
        // EXECUTION E12. Name is still `NNNN_`; the PM assigns the number at
        // integration, which is also when this entry's position changes.
        { name: PHASE_CONCURRENCY_CONFLICTS_MIGRATION_NAME, applied: false },
        // PHASE TAB P1 (number 0025 assigned at integration).
        { name: PHASE_TAB_PLANNING_DECISIONS_MIGRATION_NAME, applied: false },
        { name: QUICK_CHANGES_MIGRATION_NAME, applied: false },
        { name: KNOWLEDGE_PACKAGES_MIGRATION_NAME, applied: false },
        { name: CODEX_REASONING_EFFORT_MIGRATION_NAME, applied: false },
        { name: GLOBAL_RULES_MIGRATION_NAME, applied: false },
        { name: AI_USAGE_TELEMETRY_MIGRATION_NAME, applied: false },
        { name: PROJECT_ACCESS_ATTRIBUTION_MIGRATION_NAME, applied: false },
        { name: USAGE_INTELLIGENCE_POLICIES_MIGRATION_NAME, applied: false },
        { name: USAGE_CALIBRATION_ANALYTICS_MIGRATION_NAME, applied: false },
        { name: SHADOW_EVIDENCE_ORDER_MIGRATION_NAME, applied: false },
        { name: CONVERSATION_DOMAIN_MIGRATION_NAME, applied: false },
        { name: CONVERSATION_STREAM_LIFECYCLE_MIGRATION_NAME, applied: false },
        { name: CONVERSATION_PLAN_WORKFLOW_MIGRATION_NAME, applied: false },
        { name: CONVERSATION_EXECUTION_HANDOFF_MIGRATION_NAME, applied: false },
        { name: CONVERSATION_HUMAN_STEERING_MIGRATION_NAME, applied: false },
        { name: CONVERSATION_MOCKUPS_DASHBOARD_MIGRATION_NAME, applied: false },
        { name: PHASE6_RUNTIME_DELIVERY_MIGRATION_NAME, applied: false },
        { name: PHASE6_ACCEPTANCE_CORRECTIONS_MIGRATION_NAME, applied: false },
        { name: CONVERSATION_INFERENCE_BUDGET_MIGRATION_NAME, applied: false },
        { name: ONBOARDING_INTENTS_UPDATE_GRANT_MIGRATION_NAME, applied: false },
        { name: GITHUB_CONNECTION_REMOVAL_MIGRATION_NAME, applied: false },
        { name: GITHUB_AUTHORIZATION_REMOVAL_MIGRATION_NAME, applied: false },
        { name: CONVERSATION_PLAN_HANDOFF_CHOICES_MIGRATION_NAME, applied: false },
        { name: CONVERSATION_MODEL_SWITCHING_MIGRATION_NAME, applied: false },
        { name: QC_CONTROL_TRANSCRIPT_MIGRATION_NAME, applied: false },
        { name: CONVERSATION_ORGANIZATION_MIGRATION_NAME, applied: false },
        { name: CONVERSATION_FILE_ATTACHMENTS_MIGRATION_NAME, applied: false },
        { name: CONVERSATION_MESSAGE_BRANCHES_MIGRATION_NAME, applied: false },
        { name: DEVICE_IDENTITY_CORE_MIGRATION_NAME, applied: false },
        { name: DEVICE_HTTP_REQUEST_REPLAYS_MIGRATION_NAME, applied: false },
        { name: DEVICE_CANCELLATION_TRACKING_MIGRATION_NAME, applied: false },
        { name: GATEWAY_DEVICE_AUTHORIZATION_MIGRATION_NAME, applied: false },
        { name: DEVICE_MANAGEMENT_OBSERVATIONS_MIGRATION_NAME, applied: false },
        { name: DEVICE_REPOSITORY_ACCESS_MIGRATION_NAME, applied: false },
        { name: QC_TARGETED_REVISIONS_MIGRATION_NAME, applied: false },
        { name: QC_FINDING_TRIAGE_MIGRATION_NAME, applied: false },
        { name: QC_ROUTINE_ROUND_DEFAULT_MIGRATION_NAME, applied: false },
      ]),
    );
    const tracking = await pg.query<{ name: string }>(
      "SELECT name FROM norns_schema_migrations ORDER BY name",
    );
    expect(tracking.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        PHASE1_V2_MIGRATION_NAME,
        PHASE2_PRESERVATION_MIGRATION_NAME,
        PHASE3_SOURCE_BINDINGS_MIGRATION_NAME,
        PHASE5_ATTENTION_MIGRATION_NAME,
        PHASE6_COORDINATION_MIGRATION_NAME,
        PHASE7_HARDENING_MIGRATION_NAME,
        PHASE8_CUTOVER_COMPLETION_MIGRATION_NAME,
        WORKSPACE_CONNECTIONS_MIGRATION_NAME,
        QC_COMMUNICATION_MIGRATION_NAME,
        GITHUB_APP_MANIFEST_MIGRATION_NAME,
        DEBATE_WORKFLOW_MIGRATION_NAME,
        PLANNING_RUNS_MIGRATION_NAME,
        FRONTDOOR_PHASE_BRIDGE_MIGRATION_NAME,
        ATTACHMENTS_MIGRATION_NAME,
        FRONTDOOR_PROGRESS_TRACKING_MIGRATION_NAME,
        ONBOARDING_BINDINGS_MIGRATION_NAME,
        ACTIONS_EXECUTION_MIGRATION_NAME,
        ONBOARDING_REPOSITORY_INTENTS_MIGRATION_NAME,
        TASK_CONTEXT_MIGRATION_NAME,
        DISPATCH_CONTEXT_SCOPE_MIGRATION_NAME,
        // This query is `ORDER BY name` (alphabetical over the TEXT primary
        // key), not application/insertion order — unlike the
        // `runCurrentV2Migrations` array above. Every migration is numbered, so
        // alphabetical and numeric order coincide.
        GATEWAY_CREDENTIALS_MIGRATION_NAME,
        RUN_PUBLICATION_MIGRATION_NAME,
        ACTIONS_DISPATCH_RUNNER_IDENTITY_MIGRATION_NAME,
        PHASE_CONCURRENCY_CONFLICTS_MIGRATION_NAME,
        // Phase-tab workflow migrations remain in numeric order.
        PHASE_TAB_PLANNING_DECISIONS_MIGRATION_NAME,
        QUICK_CHANGES_MIGRATION_NAME,
        KNOWLEDGE_PACKAGES_MIGRATION_NAME,
        CODEX_REASONING_EFFORT_MIGRATION_NAME,
        GLOBAL_RULES_MIGRATION_NAME,
        AI_USAGE_TELEMETRY_MIGRATION_NAME,
        PROJECT_ACCESS_ATTRIBUTION_MIGRATION_NAME,
        USAGE_INTELLIGENCE_POLICIES_MIGRATION_NAME,
        USAGE_CALIBRATION_ANALYTICS_MIGRATION_NAME,
        SHADOW_EVIDENCE_ORDER_MIGRATION_NAME,
        CONVERSATION_DOMAIN_MIGRATION_NAME,
        CONVERSATION_STREAM_LIFECYCLE_MIGRATION_NAME,
        CONVERSATION_PLAN_WORKFLOW_MIGRATION_NAME,
        CONVERSATION_EXECUTION_HANDOFF_MIGRATION_NAME,
        CONVERSATION_HUMAN_STEERING_MIGRATION_NAME,
        CONVERSATION_MOCKUPS_DASHBOARD_MIGRATION_NAME,
        PHASE6_RUNTIME_DELIVERY_MIGRATION_NAME,
        PHASE6_ACCEPTANCE_CORRECTIONS_MIGRATION_NAME,
        CONVERSATION_INFERENCE_BUDGET_MIGRATION_NAME,
        ONBOARDING_INTENTS_UPDATE_GRANT_MIGRATION_NAME,
        GITHUB_CONNECTION_REMOVAL_MIGRATION_NAME,
        GITHUB_AUTHORIZATION_REMOVAL_MIGRATION_NAME,
        CONVERSATION_PLAN_HANDOFF_CHOICES_MIGRATION_NAME,
        CONVERSATION_MODEL_SWITCHING_MIGRATION_NAME,
        QC_CONTROL_TRANSCRIPT_MIGRATION_NAME,
        CONVERSATION_ORGANIZATION_MIGRATION_NAME,
        CONVERSATION_FILE_ATTACHMENTS_MIGRATION_NAME,
        CONVERSATION_MESSAGE_BRANCHES_MIGRATION_NAME,
        DEVICE_IDENTITY_CORE_MIGRATION_NAME,
        DEVICE_HTTP_REQUEST_REPLAYS_MIGRATION_NAME,
        DEVICE_CANCELLATION_TRACKING_MIGRATION_NAME,
        GATEWAY_DEVICE_AUTHORIZATION_MIGRATION_NAME,
        DEVICE_MANAGEMENT_OBSERVATIONS_MIGRATION_NAME,
        DEVICE_REPOSITORY_ACCESS_MIGRATION_NAME,
        QC_TARGETED_REVISIONS_MIGRATION_NAME,
        QC_FINDING_TRIAGE_MIGRATION_NAME,
        QC_ROUTINE_ROUND_DEFAULT_MIGRATION_NAME,
      ]),
    );
  });

  it("matches the Phase 2 Drizzle table and column surface", async () => {
    const tables = Object.values(phase2PreservationSchema) as PgTable[];
    const expectedNames = [...new Set(tables.map((table) => getTableName(table)))].sort();
    const actual = await pg.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'`,
    );
    expect(actual.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining(expectedNames));

    const requiredColumns = [
      ["users", "email"],
      ["users", "password_hash_scheme"],
      ["sessions", "token_hash_scheme"],
      ["sessions", "source_record_id"],
      ["migration_runs", "source_manifest_hash"],
      ["legacy_id_mappings", "source_metadata"],
      ["agent_profiles", "reasoning_effort"],
      ["global_rule_settings", "content"],
      ["conversation_plan_reviews", "revision_format"],
      ["ai_pricing_profiles", "cache_write_per_million"],
      ["ai_usage_events", "adjusts_event_id"],
      ["projects", "owner_user_id"],
      ["project_members", "removed_at"],
      ["planning_runs", "initiated_by_user_id"],
      ["usage_budget_policies", "threshold_percentages"],
      ["usage_budget_threshold_notifications", "delivery_status"],
      ["ai_provider_usage_plans", "allowance_usd_equivalent"],
      ["ai_usage_calibration_observations", "implied_max_tokens"],
      ["shadow_read_comparisons", "recorded_order"],
      ["conversation_mockup_requests", "payload_hash"],
      ["conversation_mockup_versions", "manifest_artifact_hash"],
      ["conversation_task_package_supplement_dispatch_receipts", "context_ref"],
      ["project_delivery_records", "provider_id"],
      ["project_delivery_records", "current_observation_sequence"],
      ["project_delivery_observations", "source_id"],
      ["implementation_visual_evidence", "deployment_observation_id"],
      ["implementation_visual_evidence_collections", "command_id"],
    ] as const;
    for (const [tableName, columnName] of requiredColumns) {
      const result = await pg.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = $1
           AND column_name = $2`,
        [tableName, columnName],
      );
      expect(result.rows[0]?.count, `${tableName}.${columnName}`).toBe(1);
    }

    const requiredDrizzleParity = {
      artifact_blobs: {
        checks: ["artifact_blobs_content_hash_check", "artifact_blobs_byte_size_check"],
        foreignKeys: ["artifact_blobs_project_id_artifact_id_artifacts_project_id_id_fk"],
      },
      conversation_mockup_versions: {
        checks: [
          "conversation_mockup_versions_canonical_manifest_check",
          "conversation_mockup_versions_revision_shape_check",
        ],
        foreignKeys: [
          "conversation_mockup_versions_request_scope_fk",
          "conversation_mockup_versions_manifest_scope_fk",
        ],
      },
      conversation_mockup_decisions: {
        checks: ["conversation_mockup_decisions_shape_check"],
        foreignKeys: [
          "conversation_mockup_decisions_version_scope_fk",
          "conversation_mockup_decisions_action_scope_fk",
        ],
      },
      conversation_task_package_supplements: {
        checks: [
          "conversation_task_package_supplements_canonical_check",
          "conversation_task_package_supplements_context_media_type_check",
        ],
        foreignKeys: ["conversation_task_package_supplements_package_scope_fk"],
      },
      conversation_task_package_supplement_dispatch_receipts: {
        checks: [
          "task_package_supplement_receipts_content_hash_check",
          "task_package_supplement_receipts_context_ref_check",
        ],
        foreignKeys: [
          "task_package_supplement_receipts_run_scope_fk",
          "task_package_supplement_receipts_command_scope_fk",
        ],
      },
      project_delivery_records: {
        checks: [
          "project_delivery_records_commit_sha_check",
          "project_delivery_records_success_shape_check",
          "project_delivery_records_scope_shape_check",
        ],
        foreignKeys: [
          "project_delivery_records_repository_scope_fk",
          "project_delivery_records_run_scope_fk",
        ],
      },
      project_delivery_observations: {
        checks: [
          "project_delivery_observations_provider_shape_check",
          "project_delivery_observations_success_shape_check",
        ],
        foreignKeys: ["project_delivery_observations_delivery_scope_fk"],
      },
      implementation_visual_evidence: {
        checks: [
          "implementation_visual_evidence_commit_sha_check",
          "implementation_visual_evidence_comparison_shape_check",
        ],
        foreignKeys: [
          "implementation_visual_evidence_verification_scope_fk",
          "implementation_visual_evidence_deployment_scope_fk",
          "implementation_visual_evidence_observation_scope_fk",
        ],
      },
      implementation_visual_evidence_artifacts: {
        checks: [
          "implementation_visual_evidence_artifacts_viewport_check",
          "implementation_visual_evidence_artifacts_hash_check",
        ],
        foreignKeys: ["implementation_visual_evidence_artifacts_artifact_scope_fk"],
      },
    } as const;
    for (const [tableName, expected] of Object.entries(requiredDrizzleParity)) {
      const table = tables.find((candidate) => getTableName(candidate) === tableName);
      if (!table) throw new Error(`Drizzle table ${tableName} is missing`);
      const config = getTableConfig(table);
      expect(
        config.checks.map((constraint) => constraint.name),
        `${tableName} Drizzle checks`,
      ).toEqual(expect.arrayContaining([...expected.checks]));
      expect(
        config.foreignKeys.map((constraint) => constraint.getName()),
        `${tableName} Drizzle foreign keys`,
      ).toEqual(expect.arrayContaining([...expected.foreignKeys]));
    }
  });

  it("installs the Phase 6 marker, immutable guards, and least-privilege grants", async () => {
    const marker = await pg.query<{ marker: string | null }>(
      "SELECT to_regclass('conversation_mockups_dashboard_v1')::text AS marker",
    );
    expect(marker.rows[0]?.marker).toBe("conversation_mockups_dashboard_v1");

    const expectedTriggers = [
      "artifact_blobs_immutable_guard",
      "artifact_blobs_immutable_truncate_guard",
      "artifact_blobs_scope_guard",
      "artifacts_blob_backed_immutable_guard",
      "conversation_mockup_approval_supplement_guard",
      "conversation_mockup_decisions_immutable_guard",
      "conversation_mockup_decisions_immutable_truncate_guard",
      "conversation_mockup_decisions_scope_guard",
      "conversation_mockup_requests_delete_guard",
      "conversation_mockup_requests_phase6_guard",
      "conversation_mockup_requests_truncate_guard",
      "conversation_mockup_version_artifacts_immutable_guard",
      "conversation_mockup_version_artifacts_immutable_truncate_guard",
      "conversation_mockup_version_artifacts_scope_guard",
      "conversation_mockup_versions_immutable_guard",
      "conversation_mockup_versions_immutable_truncate_guard",
      "conversation_mockup_versions_scope_guard",
      "conversation_task_package_supplements_immutable_guard",
      "conversation_task_package_supplements_immutable_truncate_guard",
      "conversation_task_package_supplements_scope_guard",
      "dispatch_jobs_mockup_supplements_guard",
      "implementation_visual_evidence_artifacts_immutable_guard",
      "implementation_visual_artifacts_immutable_truncate_guard",
      "implementation_visual_evidence_artifacts_scope_guard",
      "implementation_visual_evidence_complete_guard",
      "implementation_visual_evidence_immutable_guard",
      "implementation_visual_evidence_immutable_truncate_guard",
      "implementation_visual_evidence_scope_guard",
      "project_delivery_observations_immutable_guard",
      "project_delivery_observations_immutable_truncate_guard",
      "project_delivery_observations_scope_guard",
      "project_delivery_records_delete_guard",
      "project_delivery_records_observation_guard",
      "project_delivery_records_scope_guard",
      "project_delivery_records_truncate_guard",
      "task_package_supplement_receipts_immutable_guard",
      "task_package_supplement_receipts_truncate_guard",
      "task_package_supplement_receipts_scope_guard",
    ].sort();
    const triggers = await pg.query<{ tgname: string }>(
      `SELECT tgname
         FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname = ANY($1::text[])
        ORDER BY tgname`,
      [expectedTriggers],
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual(expectedTriggers);

    const expectedIndexes = [
      "artifact_blobs_project_hash_idx",
      "conversation_mockup_requests_scope_unique",
      "conversation_mockup_requests_worker_idx",
      "conversation_mockup_versions_root_version_unique",
      "conversation_mockup_versions_scope_unique",
      "conversation_mockup_version_artifacts_parent_artifact_unique",
      "conversation_task_packages_scope_unique",
      "conversation_task_package_supplements_package_order_unique",
      "conversation_task_package_supplements_task_mockup_unique",
      "task_package_supplement_receipts_order_unique",
      "project_delivery_records_provider_unique",
      "project_delivery_records_project_id_unique",
      "project_delivery_records_visual_scope_unique",
      "project_delivery_observations_record_sequence_unique",
      "project_delivery_observations_provider_event_unique",
      "project_delivery_observations_scope_unique",
      "verification_results_visual_scope_unique",
      "implementation_visual_evidence_run_mockup_unique",
      "implementation_visual_evidence_collections_run_mockup_unique",
      "implementation_visual_evidence_collections_worker_idx",
      "implementation_visual_evidence_artifacts_parent_artifact_unique",
    ].sort();
    const indexes = await pg.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE indexname = ANY($1::text[])
        ORDER BY indexname`,
      [expectedIndexes],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expectedIndexes);

    const constraints = await pg.query<{
      table_name: string;
      contype: string;
      definition: string;
    }>(
      `SELECT conrelid::regclass::text AS table_name,contype,
              pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid::regclass::text = ANY($1::text[])`,
      [
        [
          "conversation_mockup_requests",
          "artifact_blobs",
          "conversation_mockup_versions",
          "conversation_mockup_decisions",
          "conversation_task_package_supplements",
          "conversation_task_package_supplement_dispatch_receipts",
          "project_delivery_records",
          "project_delivery_observations",
          "implementation_visual_evidence",
          "implementation_visual_evidence_artifacts",
        ],
      ],
    );
    const catalog = constraints.rows.map((row) => ({
      ...row,
      definition: row.definition.toLowerCase().replace(/\s+/g, " "),
    }));
    const expectConstraint = (table: string, type: string, fragments: readonly string[]) => {
      expect(
        catalog.some(
          (entry) =>
            entry.table_name === table &&
            entry.contype === type &&
            fragments.every((fragment) =>
              entry.definition.includes(fragment.toLowerCase().replace(/\s+/g, " ")),
            ),
        ),
        `${table} ${type}: ${fragments.join(" | ")}`,
      ).toBe(true);
    };
    expectConstraint("artifact_blobs", "f", [
      "foreign key (project_id, artifact_id)",
      "references artifacts(project_id, id)",
    ]);
    expectConstraint("conversation_mockup_versions", "f", [
      "foreign key (project_id, work_item_id, conversation_id, request_id)",
      "references conversation_mockup_requests",
    ]);
    expectConstraint("conversation_mockup_decisions", "f", [
      "foreign key (project_id, work_item_id, conversation_id, action_id)",
      "references conversation_actions",
    ]);
    expectConstraint("conversation_task_package_supplements", "f", [
      "foreign key (project_id, work_item_id, conversation_id, base_package_id)",
      "references conversation_task_packages",
    ]);
    expectConstraint("conversation_task_package_supplement_dispatch_receipts", "f", [
      "foreign key (project_id, phase_id, task_id, run_id, command_id)",
      "references commands",
    ]);
    expectConstraint("project_delivery_records", "f", [
      "foreign key (project_id, phase_id, task_id, run_id)",
      "references agent_runs",
    ]);
    expectConstraint("project_delivery_records", "u", [
      "unique (project_id, provider_id, provider_deployment_id)",
    ]);
    expectConstraint("implementation_visual_evidence", "f", [
      "repository_binding_id, commit_sha, verification_result_id",
      "references verification_results",
    ]);
    expectConstraint("implementation_visual_evidence", "f", [
      "deployment_record_id",
      "references project_delivery_records",
    ]);
    expectConstraint("conversation_mockup_requests", "c", ["queued", "leased", "rendered"]);
    expectConstraint("conversation_mockup_requests", "c", [
      "status = 'leased'",
      "lease_owner is not null",
    ]);
    expectConstraint("conversation_task_package_supplements", "c", [
      "context_media_type = 'application/json'",
    ]);
    expectConstraint("project_delivery_records", "c", ["40", "64", "commit_sha"]);
    expectConstraint("project_delivery_records", "c", ["norns_is_public_https_url(public_url)"]);
    expectConstraint("implementation_visual_evidence", "c", ["40", "64", "commit_sha"]);
    expectConstraint("implementation_visual_evidence_artifacts", "c", [
      "desktop",
      "mobile",
      "viewport",
    ]);

    const phase6Tables = [
      "artifact_blobs",
      "conversation_mockup_versions",
      "conversation_mockup_version_artifacts",
      "conversation_mockup_decisions",
      "conversation_task_package_supplements",
      "conversation_task_package_supplement_dispatch_receipts",
      "project_delivery_records",
      "project_delivery_observations",
      "implementation_visual_evidence",
      "implementation_visual_evidence_collections",
      "implementation_visual_evidence_artifacts",
    ];
    for (const table of phase6Tables) {
      const privileges = await pg.query<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>(
        `SELECT
           has_table_privilege('norns_app',$1,'SELECT') AS can_select,
           has_table_privilege('norns_app',$1,'INSERT') AS can_insert,
           has_table_privilege('norns_app',$1,'UPDATE') AS can_update,
           has_table_privilege('norns_app',$1,'DELETE') AS can_delete`,
        [table],
      );
      expect(privileges.rows[0], table).toEqual({
        can_select: true,
        can_insert: true,
        can_update:
          table === "project_delivery_records" ||
          table === "implementation_visual_evidence_collections",
        can_delete: false,
      });
      const publicPrivileges = await pg.query<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>(
        `SELECT
           has_table_privilege('public',$1,'SELECT') AS can_select,
           has_table_privilege('public',$1,'INSERT') AS can_insert,
           has_table_privilege('public',$1,'UPDATE') AS can_update,
           has_table_privilege('public',$1,'DELETE') AS can_delete`,
        [table],
      );
      expect(publicPrivileges.rows[0], `PUBLIC ${table}`).toEqual({
        can_select: false,
        can_insert: false,
        can_update: false,
        can_delete: false,
      });
    }
  });

  it("keeps attributed deployment summaries exact, monotonic, and terminal once", async () => {
    await pg.exec(`
      INSERT INTO users (
        id,username,display_name,email,name,password_hash,password_hash_scheme,role,status
      ) VALUES (
        'phase6-delivery-user','phase6-delivery@example.test','Phase 6 Delivery',
        'phase6-delivery@example.test','Phase 6 Delivery','hash','scrypt-v1','admin','active'
      );
      INSERT INTO projects (
        id,name,status,assignment_policy_ref,verification_policy_ref,budget_policy_ref,
        owner_user_id
      ) VALUES (
        'phase6-delivery-project','Phase 6 Delivery','active',
        'assignment','verification','budget','phase6-delivery-user'
      );
      INSERT INTO repository_bindings (
        id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
        repository_display_name,granted_permissions,default_branch,
        verification_policy_ref,repository_health,created_by_actor_type,created_by_actor_id
      ) VALUES (
        'phase6-delivery-binding','phase6-delivery-project','local_runner','connected',
        'phase6-delivery-runner','phase6-delivery-workspace','phase6-delivery-repository',
        'Phase 6 Delivery','{}'::jsonb,'main','verification','healthy',
        'human','phase6-delivery-user'
      );
    `);
    await pg.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO project_delivery_records (
           id,project_id,repository_binding_id,environment,service,commit_sha,
           provider_id,provider_deployment_id,status,current_observation_sequence,started_at
         ) VALUES (
           'phase6-delivery','phase6-delivery-project','phase6-delivery-binding',
           'production','web',repeat('a',40),'railway','provider-delivery','pending',1,
           '2026-07-27T12:00:00Z'
         )`,
      );
      await tx.query(
        `INSERT INTO project_delivery_observations (
           id,delivery_record_id,project_id,sequence,status,source_type,source_id,observed_at
         ) VALUES (
           'phase6-observation-1','phase6-delivery','phase6-delivery-project',1,
           'pending','system','deployment-monitor','2026-07-27T12:00:00Z'
         )`,
      );
    });

    await expect(
      pg.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO project_delivery_records (
             id,project_id,repository_binding_id,environment,service,commit_sha,
             provider_id,provider_deployment_id,status,current_observation_sequence,
             public_url,started_at
           ) VALUES (
             'phase6-tampered-delivery','phase6-delivery-project','phase6-delivery-binding',
             'production','api',repeat('b',40),'railway','provider-tampered','pending',1,
             'https://one.example.test','2026-07-27T12:00:00Z'
           )`,
        );
        await tx.query(
          `INSERT INTO project_delivery_observations (
             id,delivery_record_id,project_id,sequence,status,source_type,source_id,
             public_url,observed_at
           ) VALUES (
             'phase6-tampered-observation','phase6-tampered-delivery',
             'phase6-delivery-project',1,'pending','system','deployment-monitor',
             'https://two.example.test','2026-07-27T12:00:00Z'
           )`,
        );
      }),
    ).rejects.toThrow(/current observation/);

    await expect(
      pg.query(
        `INSERT INTO project_delivery_observations (
           id,delivery_record_id,project_id,sequence,status,source_type,source_id,observed_at
         ) VALUES (
           'phase6-reversed-observation','phase6-delivery','phase6-delivery-project',2,
           'deploying','system','deployment-monitor','2026-07-27T11:59:59Z'
         )`,
      ),
    ).rejects.toThrow(/strictly monotonic/);

    await pg.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO project_delivery_observations (
           id,delivery_record_id,project_id,sequence,status,source_type,source_id,observed_at
         ) VALUES (
           'phase6-observation-2','phase6-delivery','phase6-delivery-project',2,
           'failed','system','deployment-monitor','2026-07-27T12:01:00Z'
         )`,
      );
      await tx.query(
        `UPDATE project_delivery_records
            SET status='failed',current_observation_sequence=2,
                completed_at='2026-07-27T12:01:00Z'
          WHERE id='phase6-delivery'`,
      );
    });
    await expect(
      pg.query(
        `INSERT INTO project_delivery_observations (
           id,delivery_record_id,project_id,sequence,status,source_type,source_id,observed_at
         ) VALUES (
           'phase6-observation-3','phase6-delivery','phase6-delivery-project',3,
           'failed','system','deployment-monitor','2026-07-27T12:02:00Z'
         )`,
      ),
    ).rejects.toThrow(/lifecycle/);
  });

  it("binds delivered visual evidence to the exact SHA and both distinct viewports", async () => {
    await pg.exec("SET session_replication_role='replica'");
    try {
      await pg.exec(`
        INSERT INTO phases (
          id,project_id,objective_summary,priority,status,initiated_by_user_id
        ) VALUES (
          'phase6-visual-phase','phase6-delivery-project','Visual evidence',1,
          'approved','phase6-delivery-user'
        );
        INSERT INTO tasks (
          id,project_id,phase_id,objective_id,strategy_version_id,title,description,
          deliverables,acceptance_criteria,complexity,risk,required_roles,
          required_capabilities,required_inputs,expected_outputs,environment_policy_ref,
          verification_policy_ref,state,lifecycle_version
        ) VALUES (
          'phase6-visual-task','phase6-delivery-project','phase6-visual-phase',
          'phase6-visual-objective','phase6-visual-strategy','Visual task','Visual task',
          '[]'::jsonb,'[]'::jsonb,'M','medium','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
          '[]'::jsonb,'environment','verification','pending',0
        );
        INSERT INTO agent_runs (
          id,project_id,phase_id,task_id,assignment_id,attempt,state,is_designated,
          repository_binding_id,expected_revision,lifecycle_version,
          published_commit_sha,publication_outcome
        ) VALUES (
          'phase6-visual-run','phase6-delivery-project','phase6-visual-phase',
          'phase6-visual-task','phase6-visual-assignment',1,'succeeded',false,
          'phase6-delivery-binding',repeat('c',40),1,repeat('c',40),'pushed'
        );
        INSERT INTO conversation_mockup_versions (
          id,root_request_id,request_id,project_id,work_item_id,conversation_id,task_id,
          created_by_action_id,version,brief,target,interaction_notes,
          manifest_artifact_id,manifest_artifact_hash,canonical_manifest,renderer_profile
        ) VALUES (
          'phase6-visual-version','phase6-visual-request','phase6-visual-request',
          'phase6-delivery-project','phase6-visual-work','phase6-visual-conversation',
          'phase6-visual-task','phase6-visual-create-action',1,'Visual brief','responsive',
          '["Interaction"]'::jsonb,'phase6-visual-manifest',
          encode(sha256(convert_to('{}','UTF8')),'hex'),'{}',
          '{"renderer":"norns-deterministic-v1"}'::jsonb
        );
        INSERT INTO conversation_mockup_decisions (
          id,project_id,work_item_id,conversation_id,mockup_version_id,action_id,
          decided_by_user_id,decision,manifest_artifact_id,manifest_artifact_hash
        ) VALUES (
          'phase6-visual-decision','phase6-delivery-project','phase6-visual-work',
          'phase6-visual-conversation','phase6-visual-version','phase6-visual-approve-action',
          'phase6-delivery-user','approved','phase6-visual-manifest',
          encode(sha256(convert_to('{}','UTF8')),'hex')
        );
        INSERT INTO conversation_task_packages (
          id,project_id,work_item_id,conversation_id,handoff_id,
          approved_plan_version_id,module_id,package,canonical_package,content_hash
        ) VALUES (
          'phase6-visual-package','phase6-delivery-project','phase6-visual-work',
          'phase6-visual-conversation','phase6-visual-handoff','phase6-visual-plan',
          'phase6-visual-module','{}'::jsonb,'{}',
          encode(sha256(convert_to('{}','UTF8')),'hex')
        );
        INSERT INTO conversation_task_package_supplements (
          id,project_id,work_item_id,conversation_id,task_id,base_package_id,ordinal,
          source_mockup_version_id,approval_decision_id,manifest_artifact_id,
          manifest_artifact_hash,supplement,canonical_supplement,content_hash,
          context_document_id,context_byte_size,context_media_type
        ) VALUES (
          'phase6-visual-supplement','phase6-delivery-project','phase6-visual-work',
          'phase6-visual-conversation','phase6-visual-task','phase6-visual-package',1,
          'phase6-visual-version','phase6-visual-decision','phase6-visual-manifest',
          encode(sha256(convert_to('{}','UTF8')),'hex'),
          '{"implementation_visual_evidence_requirement":{"approved_mockup_version_id":"phase6-visual-version"}}'::jsonb,
          '{"implementation_visual_evidence_requirement":{"approved_mockup_version_id":"phase6-visual-version"}}',
          encode(sha256(convert_to(
            '{"implementation_visual_evidence_requirement":{"approved_mockup_version_id":"phase6-visual-version"}}',
            'UTF8'
          )),'hex'),'phase6-visual-supplement-context',123,'application/json'
        );
        INSERT INTO verification_results (
          id,project_id,phase_id,task_id,run_id,repository_binding_id,commit_sha,
          verification_policy_ref,passed,command_results,evidence,produced_by_runner_id
        ) VALUES (
          'phase6-visual-verification','phase6-delivery-project','phase6-visual-phase',
          'phase6-visual-task','phase6-visual-run','phase6-delivery-binding',
          repeat('c',40),'verification',true,'[]'::jsonb,'[]'::jsonb,
          'phase6-delivery-runner'
        );
        INSERT INTO project_delivery_records (
          id,project_id,phase_id,task_id,run_id,repository_binding_id,environment,service,
          commit_sha,provider_id,provider_deployment_id,status,current_observation_sequence,
          public_url,health_url,health_status_code,evidence_artifact_id,
          evidence_artifact_hash,started_at,completed_at
        ) VALUES (
          'phase6-visual-delivery','phase6-delivery-project','phase6-visual-phase',
          'phase6-visual-task','phase6-visual-run','phase6-delivery-binding',
          'production','web',repeat('c',40),'railway','phase6-visual-provider','succeeded',1,
          'https://visual.example.test','https://visual.example.test/health',200,
          'phase6-visual-delivery-evidence',repeat('d',64),
          '2026-07-27T12:00:00Z','2026-07-27T12:01:00Z'
        );
        INSERT INTO project_delivery_observations (
          id,delivery_record_id,project_id,sequence,status,source_type,source_id,
          provider_event_id,public_url,health_url,health_status_code,evidence_artifact_id,
          evidence_artifact_hash,observed_at
        ) VALUES (
          'phase6-visual-observation','phase6-visual-delivery','phase6-delivery-project',
          1,'succeeded','provider','railway','phase6-visual-provider-event',
          'https://visual.example.test','https://visual.example.test/health',200,
          'phase6-visual-delivery-evidence',repeat('d',64),'2026-07-27T12:01:00Z'
        );
      `);
    } finally {
      await pg.exec("SET session_replication_role='origin'");
    }

    await expect(
      pg.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO implementation_visual_evidence (
             id,project_id,work_item_id,conversation_id,phase_id,task_id,run_id,
             approved_mockup_version_id,repository_binding_id,verification_result_id,
             deployment_record_id,deployment_observation_id,commit_sha,capture_profile,
             verified_at
           ) VALUES (
             'phase6-incomplete-visual','phase6-delivery-project','phase6-visual-work',
             'phase6-visual-conversation','phase6-visual-phase','phase6-visual-task',
             'phase6-visual-run','phase6-visual-version','phase6-delivery-binding',
             'phase6-visual-verification','phase6-visual-delivery',
             'phase6-visual-observation',repeat('c',40),
             '{
               "renderer":"playwright","browser_name":"chromium",
               "browser_version":"130","font_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
               "pixel_ratio":1,"network":"application_only","locale":"en-US",
               "timezone":"UTC","fixed_clock":"2026-07-27T12:01:00.000Z"
             }'::jsonb,
             '2026-07-27T12:02:00Z'
           )`,
        );
      }),
    ).rejects.toThrow(/exactly one desktop and one mobile/);

    await expect(
      pg.query(
        `INSERT INTO implementation_visual_evidence (
           id,project_id,work_item_id,conversation_id,phase_id,task_id,run_id,
           approved_mockup_version_id,repository_binding_id,verification_result_id,
           deployment_record_id,deployment_observation_id,commit_sha,capture_profile,
           verified_at
         ) VALUES (
           'phase6-wrong-sha-visual','phase6-delivery-project','phase6-visual-work',
           'phase6-visual-conversation','phase6-visual-phase','phase6-visual-task',
           'phase6-visual-run','phase6-visual-version','phase6-delivery-binding',
           'phase6-visual-verification','phase6-visual-delivery',
           'phase6-visual-observation',repeat('e',40),
           '{
             "renderer":"playwright","browser_name":"chromium",
             "browser_version":"130","font_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
             "pixel_ratio":1,"network":"application_only","locale":"en-US",
             "timezone":"UTC","fixed_clock":"2026-07-27T12:01:00.000Z"
           }'::jsonb,
           '2026-07-27T12:02:00Z'
         )`,
      ),
    ).rejects.toThrow(/exact verified deployed commit|foreign key/i);

    await pg.exec(`
      INSERT INTO artifacts (
        id,project_id,kind,label,media_type,storage_ref,content_hash,byte_size,
        provenance_actor_type,redaction_status
      ) VALUES
        (
          'phase6-visual-desktop','phase6-delivery-project','visual_evidence',
          'Delivered desktop','image/png','db://artifact/phase6-visual-desktop',
          encode(sha256(decode('89504e470d0a1a0a','hex')),'hex'),8,
          'runner','not_required'
        ),
        (
          'phase6-visual-mobile','phase6-delivery-project','visual_evidence',
          'Delivered mobile','image/png','db://artifact/phase6-visual-mobile',
          encode(sha256(decode('89504e470d0a1a0a00','hex')),'hex'),9,
          'runner','not_required'
        );
      INSERT INTO artifact_blobs (
        artifact_id,project_id,content,content_hash,byte_size
      ) VALUES
        (
          'phase6-visual-desktop','phase6-delivery-project',
          decode('89504e470d0a1a0a','hex'),
          encode(sha256(decode('89504e470d0a1a0a','hex')),'hex'),8
        ),
        (
          'phase6-visual-mobile','phase6-delivery-project',
          decode('89504e470d0a1a0a00','hex'),
          encode(sha256(decode('89504e470d0a1a0a00','hex')),'hex'),9
        );
    `);
    await pg.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO implementation_visual_evidence (
           id,project_id,work_item_id,conversation_id,phase_id,task_id,run_id,
           approved_mockup_version_id,repository_binding_id,verification_result_id,
           deployment_record_id,deployment_observation_id,commit_sha,capture_profile,
           verified_at
         ) VALUES (
           'phase6-complete-visual','phase6-delivery-project','phase6-visual-work',
           'phase6-visual-conversation','phase6-visual-phase','phase6-visual-task',
           'phase6-visual-run','phase6-visual-version','phase6-delivery-binding',
           'phase6-visual-verification','phase6-visual-delivery',
           'phase6-visual-observation',repeat('c',40),
           '{
             "renderer":"playwright","browser_name":"chromium",
             "browser_version":"130","font_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
             "pixel_ratio":1,"network":"application_only","locale":"en-US",
             "timezone":"UTC","fixed_clock":"2026-07-27T12:01:00.000Z"
           }'::jsonb,
           '2026-07-27T12:02:00Z'
         )`,
      );
      await tx.query(
        `INSERT INTO implementation_visual_evidence_artifacts (
           visual_evidence_id,project_id,viewport,artifact_id,artifact_hash,
           width,height,capture_profile
         ) VALUES
           (
             'phase6-complete-visual','phase6-delivery-project','desktop',
             'phase6-visual-desktop',
             encode(sha256(decode('89504e470d0a1a0a','hex')),'hex'),1440,1024,
             '{
               "renderer":"playwright","browser_name":"chromium",
               "browser_version":"130","font_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
               "pixel_ratio":1,"network":"application_only","locale":"en-US",
               "timezone":"UTC","fixed_clock":"2026-07-27T12:01:00.000Z"
             }'::jsonb
           ),
           (
             'phase6-complete-visual','phase6-delivery-project','mobile',
             'phase6-visual-mobile',
             encode(sha256(decode('89504e470d0a1a0a00','hex')),'hex'),390,844,
             '{
               "renderer":"playwright","browser_name":"chromium",
               "browser_version":"130","font_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
               "pixel_ratio":1,"network":"application_only","locale":"en-US",
               "timezone":"UTC","fixed_clock":"2026-07-27T12:01:00.000Z"
             }'::jsonb
           )`,
      );
    });
    const complete = await pg.query<{ screenshots: number }>(
      `SELECT count(*)::int AS screenshots
         FROM implementation_visual_evidence_artifacts
        WHERE visual_evidence_id='phase6-complete-visual'`,
    );
    expect(complete.rows[0]?.screenshots).toBe(2);
  });

  it("restart-safely delivers one fresh-run visual collection command and surfaces terminal failure", async () => {
    await pg.exec("SET session_replication_role='replica'");
    try {
      await pg.exec(`
        INSERT INTO work_items (
          id,project_id,created_by_user_id,title,objective,status,phase_id,execution_started_at
        ) VALUES
          (
            'phase6-visual-work','phase6-delivery-project','phase6-delivery-user',
            'Visual work','Deliver the first task in the shared phase',
            'executing','phase6-visual-phase','2026-07-27T12:00:00Z'
          ),
          (
            'phase6-collection-work','phase6-delivery-project','phase6-delivery-user',
            'Collection work','Collect exact delivered screenshots',
            'executing','phase6-visual-phase','2026-07-27T12:00:00Z'
          );
        INSERT INTO work_conversations (
          id,project_id,work_item_id,created_by_user_id,kind,provider,model
        ) VALUES
          (
            'phase6-visual-conversation','phase6-delivery-project',
            'phase6-visual-work','phase6-delivery-user','execution_pm','openai','gpt-5.6'
          ),
          (
            'phase6-collection-conversation','phase6-delivery-project',
            'phase6-collection-work','phase6-delivery-user','execution_pm','openai','gpt-5.6'
          );
        INSERT INTO tasks (
          id,project_id,phase_id,objective_id,strategy_version_id,title,description,
          deliverables,acceptance_criteria,complexity,risk,required_roles,
          required_capabilities,required_inputs,expected_outputs,environment_policy_ref,
          verification_policy_ref,state,lifecycle_version
        ) VALUES (
          'phase6-collection-task','phase6-delivery-project','phase6-visual-phase',
          'phase6-collection-objective','phase6-collection-strategy',
          'Collection task','Collection task','[]'::jsonb,'[]'::jsonb,'M','medium',
          '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
          'environment','verification','pending',0
        );
        UPDATE tasks
           SET state='completed',
               lifecycle_version=1,
               review_evidence='[{"kind":"verification"}]'::jsonb,
               completion_evidence='[{"kind":"delivery"}]'::jsonb,
               completed_at='2026-07-27T12:01:00Z'
         WHERE id='phase6-visual-task';
        INSERT INTO agent_runs (
          id,project_id,phase_id,task_id,assignment_id,attempt,state,is_designated,
          repository_binding_id,expected_revision,lifecycle_version,
          published_commit_sha,publication_outcome
        ) VALUES (
          'phase6-collection-run','phase6-delivery-project','phase6-visual-phase',
          'phase6-collection-task','phase6-collection-assignment',1,'succeeded',false,
          'phase6-delivery-binding',repeat('e',40),1,repeat('e',40),'pushed'
        );
        INSERT INTO conversation_mockup_versions (
          id,root_request_id,request_id,project_id,work_item_id,conversation_id,task_id,
          created_by_action_id,version,brief,target,interaction_notes,
          manifest_artifact_id,manifest_artifact_hash,canonical_manifest,renderer_profile
        ) VALUES (
          'phase6-collection-version','phase6-collection-request','phase6-collection-request',
          'phase6-delivery-project','phase6-collection-work','phase6-collection-conversation',
          'phase6-collection-task','phase6-collection-create-action',1,
          'Collect implementation screenshots','responsive','["Review both viewports"]'::jsonb,
          'phase6-collection-manifest',
          encode(sha256(convert_to('{}','UTF8')),'hex'),'{}',
          '{"renderer":"norns-deterministic-v1"}'::jsonb
        );
        INSERT INTO conversation_mockup_decisions (
          id,project_id,work_item_id,conversation_id,mockup_version_id,action_id,
          decided_by_user_id,decision,manifest_artifact_id,manifest_artifact_hash
        ) VALUES (
          'phase6-collection-decision','phase6-delivery-project','phase6-collection-work',
          'phase6-collection-conversation','phase6-collection-version',
          'phase6-collection-approve-action','phase6-delivery-user','approved',
          'phase6-collection-manifest',encode(sha256(convert_to('{}','UTF8')),'hex')
        );
        INSERT INTO conversation_task_packages (
          id,project_id,work_item_id,conversation_id,handoff_id,
          approved_plan_version_id,module_id,package,canonical_package,content_hash
        ) VALUES (
          'phase6-collection-package','phase6-delivery-project','phase6-collection-work',
          'phase6-collection-conversation','phase6-collection-handoff',
          'phase6-collection-plan','phase6-collection-module','{}'::jsonb,'{}',
          encode(sha256(convert_to('{}','UTF8')),'hex')
        );
        INSERT INTO conversation_task_package_bindings (
          package_id,project_id,work_item_id,conversation_id,handoff_id,phase_id,
          task_id,content_hash,context_document_id
        ) VALUES
          (
            'phase6-visual-package','phase6-delivery-project','phase6-visual-work',
            'phase6-visual-conversation','phase6-visual-handoff','phase6-visual-phase',
            'phase6-visual-task',encode(sha256(convert_to('{}','UTF8')),'hex'),
            'phase6-visual-context'
          ),
          (
            'phase6-collection-package','phase6-delivery-project','phase6-collection-work',
            'phase6-collection-conversation','phase6-collection-handoff','phase6-visual-phase',
            'phase6-collection-task',encode(sha256(convert_to('{}','UTF8')),'hex'),
            'phase6-collection-context'
          );
        INSERT INTO conversation_task_package_supplements (
          id,project_id,work_item_id,conversation_id,task_id,base_package_id,ordinal,
          source_mockup_version_id,approval_decision_id,manifest_artifact_id,
          manifest_artifact_hash,supplement,canonical_supplement,content_hash,
          context_document_id,context_byte_size,context_media_type
        ) VALUES (
          'phase6-collection-supplement','phase6-delivery-project','phase6-collection-work',
          'phase6-collection-conversation','phase6-collection-task',
          'phase6-collection-package',1,'phase6-collection-version',
          'phase6-collection-decision','phase6-collection-manifest',
          encode(sha256(convert_to('{}','UTF8')),'hex'),
          '{"implementation_visual_evidence_requirement":{"approved_mockup_version_id":"phase6-collection-version"}}'::jsonb,
          '{"implementation_visual_evidence_requirement":{"approved_mockup_version_id":"phase6-collection-version"}}',
          encode(sha256(convert_to(
            '{"implementation_visual_evidence_requirement":{"approved_mockup_version_id":"phase6-collection-version"}}',
            'UTF8'
          )),'hex'),'phase6-collection-supplement-context',127,'application/json'
        );
        INSERT INTO verification_results (
          id,project_id,phase_id,task_id,run_id,repository_binding_id,commit_sha,
          verification_policy_ref,passed,command_results,evidence,produced_by_runner_id
        ) VALUES (
          'phase6-collection-verification','phase6-delivery-project','phase6-visual-phase',
          'phase6-collection-task','phase6-collection-run','phase6-delivery-binding',
          repeat('e',40),'verification',true,'[]'::jsonb,'[]'::jsonb,
          'phase6-delivery-runner'
        );
        INSERT INTO project_delivery_records (
          id,project_id,phase_id,task_id,run_id,repository_binding_id,environment,service,
          commit_sha,provider_id,provider_deployment_id,status,current_observation_sequence,
          public_url,health_url,health_status_code,evidence_artifact_id,
          evidence_artifact_hash,started_at,completed_at
        ) VALUES (
          'phase6-collection-delivery','phase6-delivery-project','phase6-visual-phase',
          'phase6-collection-task','phase6-collection-run','phase6-delivery-binding',
          'production','web',repeat('e',40),'railway','phase6-collection-provider',
          'succeeded',1,'https://collection.example.test',
          'https://collection.example.test/health',200,
          'phase6-visual-delivery-evidence',repeat('d',64),
          '2026-07-27T13:00:00Z','2026-07-27T13:01:00Z'
        );
        INSERT INTO project_delivery_observations (
          id,delivery_record_id,project_id,sequence,status,source_type,source_id,
          provider_event_id,public_url,health_url,health_status_code,evidence_artifact_id,
          evidence_artifact_hash,observed_at
        ) VALUES (
          'phase6-collection-observation','phase6-collection-delivery',
          'phase6-delivery-project',1,'succeeded','provider','railway',
          'phase6-collection-provider-event','https://collection.example.test',
          'https://collection.example.test/health',200,
          'phase6-visual-delivery-evidence',repeat('d',64),'2026-07-27T13:01:00Z'
        );
      `);
    } finally {
      await pg.exec("SET session_replication_role='origin'");
    }

    const transactions = new PGliteTransactionRunner(pg);
    const delivered: CommandEnvelopeT[] = [];
    let launches = 0;
    const options = {
      prepareTarget: async () => ({
        repository_binding_id: "phase6-delivery-binding",
        runner_id: "phase6-fresh-visual-runner",
        runner_generation: 4,
      }),
      launch: async (input: {
        project_id: string;
        repository_binding_id: string;
        dispatch_job_id: string;
        run_id: string;
        runner_id: string;
        runner_generation: number;
      }) => {
        launches += 1;
        await pg.query(
          `INSERT INTO github_actions_runs (
             id,project_id,repository_binding_id,dispatch_job_id,run_id,
             runner_id,runner_generation,status
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'requested')
           ON CONFLICT(dispatch_job_id) DO NOTHING`,
          [
            `actions:${input.dispatch_job_id}`,
            input.project_id,
            input.repository_binding_id,
            input.dispatch_job_id,
            input.run_id,
            input.runner_id,
            input.runner_generation,
          ],
        );
      },
      enqueue: (command: CommandEnvelopeT) => {
        delivered.push(command);
        return true;
      },
    };
    const firstWorker = new Phase6VisualEvidenceCollectionWorker(transactions, options);
    await expect(firstWorker.tick()).resolves.toBe(true);
    const provisioned = await pg.query<{
      id: string;
      status: string;
      command_id: string;
      dispatch_job_id: string;
      last_error: string | null;
    }>(
      `SELECT id,status,command_id,dispatch_job_id,last_error
         FROM implementation_visual_evidence_collections
        WHERE run_id='phase6-collection-run'`,
    );
    if (provisioned.rows[0]?.status !== "awaiting_runner") {
      throw new Error(provisioned.rows[0]?.last_error ?? "collection provisioning failed");
    }
    expect(provisioned.rows[0]).toMatchObject({
      status: "awaiting_runner",
    });
    expect(launches).toBe(1);

    const restartedWorker = new Phase6VisualEvidenceCollectionWorker(transactions, options);
    await expect(restartedWorker.tick()).resolves.toBe(false);
    expect(launches).toBe(2);
    const actionsCount = await pg.query<{ runs: number }>(
      `SELECT count(*)::int AS runs FROM github_actions_runs
        WHERE dispatch_job_id=$1`,
      [provisioned.rows[0]?.dispatch_job_id],
    );
    expect(actionsCount.rows[0]?.runs).toBe(1);
    await pg.query(
      `UPDATE github_actions_runs
          SET status='enrolled',enrolled_at=now(),
              enrollment_secret_hash=repeat('a',64),
              enrolled_public_key_hash=repeat('b',64),
              enrolled_public_key_pem='-----BEGIN PUBLIC KEY----- test'
        WHERE dispatch_job_id=$1`,
      [provisioned.rows[0]?.dispatch_job_id],
    );
    await expect(restartedWorker.tick()).resolves.toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      command_id: provisioned.rows[0]?.command_id,
      runner_id: "phase6-fresh-visual-runner",
      generation: 4,
      payload: {
        kind: "collect_visual_evidence",
        run_id: "phase6-collection-run",
        approved_mockup_version_id: "phase6-collection-version",
        runner_repository_id: "phase6-delivery-repository",
        commit_sha: "e".repeat(40),
      },
    });
    await expect(restartedWorker.tick()).resolves.toBe(false);
    expect(delivered).toHaveLength(1);

    const command = delivered[0];
    if (!command) throw new Error("visual collection command was not delivered");
    await new Phase4EventProcessor(transactions).apply({
      protocol: 1,
      event_seq: 1,
      runner_id: command.runner_id,
      generation: command.generation,
      correlation_id: command.correlation_id,
      causation_id: command.command_id,
      occurred_at: "2026-07-27T13:02:00.000Z",
      payload: {
        kind: "command_ack",
        command_id: command.command_id,
        state: "failed",
        detail: "committed visual evidence manifest is missing",
      },
    });
    const failed = await pg.query<{
      collection_status: string;
      last_error: string;
      run_state: string;
    }>(
      `SELECT collection.status AS collection_status,collection.last_error,
              run.state AS run_state
         FROM implementation_visual_evidence_collections collection
         JOIN agent_runs run ON run.id=collection.run_id
        WHERE collection.id=$1`,
      [provisioned.rows[0]?.id],
    );
    expect(failed.rows[0]).toEqual({
      collection_status: "failed",
      last_error: "committed visual evidence manifest is missing",
      run_state: "succeeded",
    });

    const dashboard = await new Phase6DashboardService(
      transactions,
      new Phase6MockupService(transactions),
      new Phase6DeploymentService(transactions),
      () => new Date("2026-07-27T13:03:00.000Z"),
    ).read("phase6-delivery-project");
    expect(dashboard.needs_attention).toMatchObject({
      availability: "available",
      data: expect.arrayContaining([
        expect.objectContaining({
          source_type: "visual_evidence",
          source_id: provisioned.rows[0]?.id,
          severity: "high",
        }),
      ]),
    });
    expect(dashboard.active_work).toMatchObject({
      availability: "available",
      data: expect.arrayContaining([
        expect.objectContaining({
          work_item: expect.objectContaining({ id: "phase6-visual-work" }),
          conversation_id: "phase6-visual-conversation",
          deep_link: "/projects/phase6-delivery-project/work/phase6-visual-conversation",
          phase_progress: {
            phase_id: "phase6-visual-phase",
            tasks_completed: 1,
            tasks_total: 1,
            percent_complete: 100,
          },
        }),
        expect.objectContaining({
          work_item: expect.objectContaining({ id: "phase6-collection-work" }),
          conversation_id: "phase6-collection-conversation",
          deep_link: "/projects/phase6-delivery-project/work/phase6-collection-conversation",
          phase_progress: {
            phase_id: "phase6-visual-phase",
            tasks_completed: 0,
            tasks_total: 1,
            percent_complete: 0,
          },
        }),
      ]),
    });
    expect(dashboard.recent_verification).toMatchObject({
      availability: "available",
      data: expect.arrayContaining([
        expect.objectContaining({
          id: "phase6-visual-verification",
          work_item_id: "phase6-visual-work",
          conversation_id: "phase6-visual-conversation",
          deep_link: "/projects/phase6-delivery-project/work/phase6-visual-conversation",
        }),
        expect.objectContaining({
          id: "phase6-collection-verification",
          work_item_id: "phase6-collection-work",
          conversation_id: "phase6-collection-conversation",
          deep_link: "/projects/phase6-delivery-project/work/phase6-collection-conversation",
        }),
      ]),
    });
    expect(dashboard.budget).toMatchObject({
      availability: "unavailable",
      data: null,
      reason_code: "no_authoritative_budget_source",
    });
    expect(dashboard.approved_mockups).toMatchObject({
      availability: "unavailable",
      reason_code: "source_unavailable",
    });
    expect(dashboard.recent_deployments).toMatchObject({
      availability: "available",
      data: expect.arrayContaining([
        expect.objectContaining({
          deployment: expect.objectContaining({ id: "phase6-visual-delivery" }),
          work_item_id: "phase6-visual-work",
          conversation_id: "phase6-visual-conversation",
          deep_link: "/projects/phase6-delivery-project/work/phase6-visual-conversation",
        }),
        expect.objectContaining({
          deployment: expect.objectContaining({ id: "phase6-collection-delivery" }),
          work_item_id: "phase6-collection-work",
          conversation_id: "phase6-collection-conversation",
          deep_link: "/projects/phase6-delivery-project/work/phase6-collection-conversation",
        }),
      ]),
    });

    await pg.exec("SET session_replication_role='replica'");
    try {
      await pg.exec(`
        INSERT INTO conversation_mockup_versions (
          id,root_request_id,request_id,project_id,work_item_id,conversation_id,task_id,
          created_by_action_id,version,brief,target,interaction_notes,
          manifest_artifact_id,manifest_artifact_hash,canonical_manifest,renderer_profile
        ) VALUES (
          'phase6-z-success-version','phase6-z-success-request','phase6-z-success-request',
          'phase6-delivery-project','phase6-collection-work','phase6-collection-conversation',
          'phase6-collection-task','phase6-z-success-create-action',1,
          'Successful implementation comparison','responsive',
          '["Review implementation parity"]'::jsonb,'phase6-z-success-manifest',
          encode(sha256(convert_to('{}','UTF8')),'hex'),'{}',
          '{"renderer":"norns-deterministic-v1"}'::jsonb
        );
        INSERT INTO conversation_mockup_decisions (
          id,project_id,work_item_id,conversation_id,mockup_version_id,action_id,
          decided_by_user_id,decision,manifest_artifact_id,manifest_artifact_hash
        ) VALUES (
          'phase6-z-success-decision','phase6-delivery-project','phase6-collection-work',
          'phase6-collection-conversation','phase6-z-success-version',
          'phase6-z-success-approve-action','phase6-delivery-user','approved',
          'phase6-z-success-manifest',encode(sha256(convert_to('{}','UTF8')),'hex')
        );
        INSERT INTO conversation_mockup_version_artifacts (
          mockup_version_id,project_id,viewport,artifact_id,artifact_hash,
          width,height,capture_profile
        ) VALUES
          (
            'phase6-z-success-version','phase6-delivery-project','desktop',
            'phase6-visual-desktop',
            encode(sha256(decode('89504e470d0a1a0a','hex')),'hex'),1440,1024,
            '{}'::jsonb
          ),
          (
            'phase6-z-success-version','phase6-delivery-project','mobile',
            'phase6-visual-mobile',
            encode(sha256(decode('89504e470d0a1a0a00','hex')),'hex'),390,844,
            '{}'::jsonb
          );
        INSERT INTO conversation_task_package_supplements (
          id,project_id,work_item_id,conversation_id,task_id,base_package_id,ordinal,
          source_mockup_version_id,approval_decision_id,manifest_artifact_id,
          manifest_artifact_hash,supplement,canonical_supplement,content_hash,
          context_document_id,context_byte_size,context_media_type
        ) VALUES (
          'phase6-z-success-supplement','phase6-delivery-project','phase6-collection-work',
          'phase6-collection-conversation','phase6-collection-task',
          'phase6-collection-package',2,'phase6-z-success-version',
          'phase6-z-success-decision','phase6-z-success-manifest',
          encode(sha256(convert_to('{}','UTF8')),'hex'),
          '{"implementation_visual_evidence_requirement":{"approved_mockup_version_id":"phase6-z-success-version"}}'::jsonb,
          '{"implementation_visual_evidence_requirement":{"approved_mockup_version_id":"phase6-z-success-version"}}',
          encode(sha256(convert_to(
            '{"implementation_visual_evidence_requirement":{"approved_mockup_version_id":"phase6-z-success-version"}}',
            'UTF8'
          )),'hex'),'phase6-z-success-supplement-context',126,'application/json'
        );
      `);
    } finally {
      await pg.exec("SET session_replication_role='origin'");
    }
    const successOptions = {
      ...options,
      prepareTarget: async () => ({
        repository_binding_id: "phase6-delivery-binding",
        runner_id: "phase6-success-visual-runner",
        runner_generation: 5,
      }),
    };
    const successWorker = new Phase6VisualEvidenceCollectionWorker(transactions, successOptions);
    await expect(successWorker.tick()).resolves.toBe(true);
    const successCollection = await pg.query<{
      id: string;
      dispatch_job_id: string;
    }>(
      `SELECT id,dispatch_job_id
         FROM implementation_visual_evidence_collections
        WHERE approved_mockup_version_id='phase6-z-success-version'`,
    );
    await pg.query(
      `UPDATE github_actions_runs
          SET status='enrolled',enrolled_at=now(),
              enrollment_secret_hash=repeat('a',64),
              enrolled_public_key_hash=repeat('b',64),
              enrolled_public_key_pem='-----BEGIN PUBLIC KEY----- success'
        WHERE dispatch_job_id=$1`,
      [successCollection.rows[0]?.dispatch_job_id],
    );
    await expect(successWorker.tick()).resolves.toBe(true);
    expect(delivered).toHaveLength(2);
    const successCommand = delivered[1];
    if (!successCommand) throw new Error("successful visual command was not delivered");

    const implementation = renderDeterministicMockup({
      schema_version: 1,
      title: "Delivered implementation",
      summary: "The deployed implementation matches both approved fixed viewports.",
      target: "responsive",
      sections: [
        {
          heading: "Deployment",
          body: "The exact pushed and verified commit is live.",
          emphasis: "primary",
        },
      ],
      interaction_notes: ["Compare the desktop and mobile captures."],
      source_artifact_ids: [],
    });
    const evidenceInput = {
      project_id: "phase6-delivery-project",
      work_item_id: "phase6-collection-work",
      conversation_id: "phase6-collection-conversation",
      phase_id: "phase6-visual-phase",
      task_id: "phase6-collection-task",
      run_id: "phase6-collection-run",
      approved_mockup_version_id: "phase6-z-success-version",
      repository_binding_id: "phase6-delivery-binding",
      verification_result_id: "phase6-collection-verification",
      deployment_record_id: "phase6-collection-delivery",
      deployment_observation_id: "phase6-collection-observation",
      commit_sha: "e".repeat(40),
      capture_profile: {
        renderer: "playwright" as const,
        browser_name: "chromium",
        browser_version: "130",
        font_revision: "a".repeat(64),
        pixel_ratio: 1 as const,
        network: "application_only" as const,
        locale: "en-US" as const,
        timezone: "UTC" as const,
        fixed_clock: "2026-07-27T13:02:30.000Z",
      },
      verified_at: "2026-07-27T13:02:30.000Z",
      runner_id: "phase6-success-visual-runner",
      runner_generation: 5,
      desktop_png: implementation.desktop,
      mobile_png: implementation.mobile,
    };
    const visualEvidence = new Phase6VisualEvidenceService(transactions);
    const recorded = await visualEvidence.record(evidenceInput);
    expect(recorded).toMatchObject({
      run_id: "phase6-collection-run",
      approved_mockup_version_id: "phase6-z-success-version",
      commit_sha: "e".repeat(40),
      comparison_artifact: {
        media_type: "application/json",
      },
      screenshots: [
        { viewport: "desktop", width: 1440, height: 1024 },
        { viewport: "mobile", width: 390, height: 844 },
      ],
    });
    expect(await visualEvidence.record(evidenceInput)).toEqual(recorded);
    await expect(
      visualEvidence.record({
        ...evidenceInput,
        runner_generation: evidenceInput.runner_generation + 1,
      }),
    ).rejects.toMatchObject({ code: "evidence_conflict" });
    await expect(
      visualEvidence.record({
        ...evidenceInput,
        runner_id: "forged-runner",
      }),
    ).rejects.toMatchObject({ code: "evidence_conflict" });
    await expect(
      visualEvidence.record({
        ...evidenceInput,
        desktop_png: Buffer.concat([implementation.desktop, Buffer.from([0])]),
      }),
    ).rejects.toMatchObject({ code: "evidence_conflict" });
    await expect(
      visualEvidence.record({
        ...evidenceInput,
        capture_profile: {
          ...evidenceInput.capture_profile,
          browser_version: "131",
        },
      }),
    ).rejects.toMatchObject({ code: "evidence_conflict" });
    await expect(
      visualEvidence.record({
        ...evidenceInput,
        verified_at: "2026-07-27T13:02:31.000Z",
      }),
    ).rejects.toMatchObject({ code: "evidence_conflict" });

    const comparison = await pg.query<{ payload: unknown }>(
      `SELECT convert_from(blob.content,'UTF8')::jsonb AS payload
         FROM implementation_visual_evidence evidence
         JOIN artifact_blobs blob ON blob.artifact_id=evidence.comparison_artifact_id
        WHERE evidence.id=$1`,
      [recorded.id],
    );
    expect(comparison.rows[0]?.payload).toMatchObject({
      kind: "visual_comparison",
      implementation_visual_evidence_id: recorded.id,
      approved_mockup_version_id: "phase6-z-success-version",
      comparisons: [
        {
          viewport: "desktop",
          implementation_artifact_id: recorded.screenshots[0]?.artifact.artifact_id,
        },
        {
          viewport: "mobile",
          implementation_artifact_id: recorded.screenshots[1]?.artifact.artifact_id,
        },
      ],
    });
    await new Phase4EventProcessor(transactions).apply({
      protocol: 1,
      event_seq: 1,
      runner_id: successCommand.runner_id,
      generation: successCommand.generation,
      correlation_id: successCommand.correlation_id,
      causation_id: successCommand.command_id,
      occurred_at: "2026-07-27T13:02:40.000Z",
      payload: {
        kind: "command_ack",
        command_id: successCommand.command_id,
        state: "succeeded",
        detail: "",
      },
    });
    const completed = await pg.query<{
      status: string;
      evidence_id: string;
      action_status: string;
    }>(
      `SELECT collection.status,collection.evidence_id,
              actions.status AS action_status
         FROM implementation_visual_evidence_collections collection
         JOIN github_actions_runs actions
           ON actions.dispatch_job_id=collection.dispatch_job_id
        WHERE collection.id=$1`,
      [successCollection.rows[0]?.id],
    );
    expect(completed.rows[0]).toEqual({
      status: "completed",
      evidence_id: recorded.id,
      action_status: "completed",
    });
  });

  it("binds approved mockup supplements to one exact command before dispatch", async () => {
    const hash = await pg.query<{ hash: string }>(
      "SELECT encode(sha256(convert_to('{}','UTF8')),'hex') AS hash",
    );
    const contentHash = hash.rows[0]?.hash;
    if (!contentHash) throw new Error("PostgreSQL did not calculate a content hash");
    const contextRef = {
      artifact_id: "phase6-supplement-context",
      content_hash: contentHash,
      byte_size: 2,
      storage_ref:
        "https://norns.example.test/api/v2/execution/task-context/phase6-supplement-context",
    };
    await pg.exec("SET session_replication_role='replica'");
    try {
      await pg.exec(`
        INSERT INTO tasks (
          id,project_id,phase_id,objective_id,strategy_version_id,title,description,
          deliverables,acceptance_criteria,complexity,risk,required_roles,
          required_capabilities,required_inputs,expected_outputs,environment_policy_ref,
          verification_policy_ref,state,lifecycle_version
        ) VALUES (
          'phase6-supplement-task','phase6-delivery-project','phase6-visual-phase',
          'phase6-visual-objective','phase6-visual-strategy','Supplement task',
          'Supplement task','[]'::jsonb,'[]'::jsonb,'M','medium','[]'::jsonb,
          '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'environment','verification','pending',0
        );
        INSERT INTO agent_runs (
          id,project_id,phase_id,task_id,assignment_id,attempt,state,is_designated,
          repository_binding_id,expected_revision,lifecycle_version
        ) VALUES (
          'phase6-supplement-run','phase6-delivery-project','phase6-visual-phase',
          'phase6-supplement-task','phase6-supplement-assignment',1,'created',false,
          'phase6-delivery-binding',repeat('c',40),0
        );
      `);
      await pg.query(
        `INSERT INTO task_context_blobs (sha256,content)
         VALUES ($1,convert_to('{}','UTF8'))`,
        [contentHash],
      );
      await pg.query(
        `INSERT INTO task_context_documents (
           id,project_id,section,sha256,byte_size,media_type
         ) VALUES (
           'phase6-supplement-context','phase6-delivery-project','approved_mockup',
           $1,2,'application/json'
         )`,
        [contentHash],
      );
      await pg.query(
        `INSERT INTO conversation_task_packages (
           id,project_id,work_item_id,conversation_id,handoff_id,
           approved_plan_version_id,module_id,package,canonical_package,content_hash
         ) VALUES (
           'phase6-package','phase6-delivery-project','phase6-visual-work',
           'phase6-visual-conversation','phase6-handoff','phase6-plan','phase6-module',
           '{}'::jsonb,'{}',$1
         )`,
        [contentHash],
      );
      await pg.query(
        `INSERT INTO conversation_task_package_bindings (
           package_id,project_id,work_item_id,conversation_id,handoff_id,phase_id,
           task_id,content_hash,context_document_id
         ) VALUES (
           'phase6-package','phase6-delivery-project','phase6-visual-work',
           'phase6-visual-conversation','phase6-handoff','phase6-visual-phase',
           'phase6-supplement-task',$1,'phase6-supplement-context'
         )`,
        [contentHash],
      );
      await pg.query(
        `INSERT INTO conversation_task_package_supplements (
           id,project_id,work_item_id,conversation_id,task_id,base_package_id,ordinal,
           source_mockup_version_id,approval_decision_id,manifest_artifact_id,
           manifest_artifact_hash,supplement,canonical_supplement,content_hash,
           context_document_id,context_byte_size,context_media_type
         ) VALUES (
           'phase6-supplement','phase6-delivery-project','phase6-visual-work',
           'phase6-visual-conversation','phase6-supplement-task','phase6-package',1,
           'phase6-supplement-version','phase6-supplement-decision','phase6-visual-manifest',
           $2,'{}'::jsonb,'{}',$1,'phase6-supplement-context',2,'application/json'
         )`,
        [contentHash, contentHash],
      );
      await pg.query(
        `INSERT INTO commands (
           command_id,dispatch_job_id,project_id,phase_id,task_id,run_id,runner_id,
           runner_generation,kind,envelope,status,correlation_id
         ) VALUES (
           'phase6-supplement-command','phase6-supplement-job',
           'phase6-delivery-project','phase6-visual-phase','phase6-supplement-task',
           'phase6-supplement-run','phase6-delivery-runner',1,'launch_run',$1::jsonb,
           'queued','phase6-supplement-correlation'
         )`,
        [
          JSON.stringify({
            task_package_id: "phase6-package",
            task_package_supplements: [
              {
                supplement_id: "phase6-supplement",
                task_id: "phase6-supplement-task",
                base_package_id: "phase6-package",
                ordinal: 1,
                content_hash: contentHash,
                context_ref: contextRef,
              },
            ],
          }),
        ],
      );
    } finally {
      await pg.exec("SET session_replication_role='origin'");
    }

    await expect(
      pg.query(
        `INSERT INTO conversation_task_package_supplement_dispatch_receipts (
           command_id,run_id,supplement_id,project_id,phase_id,task_id,base_package_id,
           ordinal,content_hash,context_document_id,context_ref
         ) VALUES (
           'phase6-supplement-command','phase6-supplement-run','phase6-supplement',
           'phase6-delivery-project','phase6-visual-phase','phase6-supplement-task',
           'phase6-package',1,$1,'phase6-supplement-context',$2::jsonb
         )`,
        [
          contentHash,
          JSON.stringify({ ...contextRef, storage_ref: "https://tampered.example.test" }),
        ],
      ),
    ).rejects.toThrow(/does not match its command and immutable context/);

    await pg.query(
      `INSERT INTO conversation_task_package_supplement_dispatch_receipts (
         command_id,run_id,supplement_id,project_id,phase_id,task_id,base_package_id,
         ordinal,content_hash,context_document_id,context_ref
       ) VALUES (
         'phase6-supplement-command','phase6-supplement-run','phase6-supplement',
         'phase6-delivery-project','phase6-visual-phase','phase6-supplement-task',
         'phase6-package',1,$1,'phase6-supplement-context',$2::jsonb
       )`,
      [contentHash, JSON.stringify(contextRef)],
    );
    await pg.query(
      `INSERT INTO dispatch_jobs (
         id,project_id,phase_id,task_id,run_id,command_id,runner_id,status
       ) VALUES (
         'phase6-supplement-job','phase6-delivery-project','phase6-visual-phase',
         'phase6-supplement-task','phase6-supplement-run','phase6-supplement-command',
         'phase6-delivery-runner','queued'
       )`,
    );

    await expect(
      pg.query(
        `UPDATE conversation_task_package_supplement_dispatch_receipts
            SET content_hash=repeat('f',64)
          WHERE command_id='phase6-supplement-command'`,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      pg.query(
        `DELETE FROM conversation_task_package_supplement_dispatch_receipts
          WHERE command_id='phase6-supplement-command'`,
      ),
    ).rejects.toThrow(/immutable/);

    await expect(
      pg.query(
        `INSERT INTO conversation_task_package_supplements (
           id,project_id,work_item_id,conversation_id,task_id,base_package_id,ordinal,
           source_mockup_version_id,approval_decision_id,manifest_artifact_id,
           manifest_artifact_hash,supplement,canonical_supplement,content_hash,
           context_document_id,context_byte_size,context_media_type
         ) VALUES (
           'phase6-late-supplement','phase6-delivery-project','phase6-visual-work',
           'phase6-visual-conversation','phase6-supplement-task','phase6-package',2,
           'phase6-visual-version','phase6-late-decision','phase6-visual-manifest',
           $2,'{}'::jsonb,'{}',$1,'phase6-supplement-context',2,'application/json'
         )`,
        [contentHash, contentHash],
      ),
    ).rejects.toThrow(/must be frozen before a task command/);
  });

  it("represents invited/null identity and requires revoked legacy credentials", async () => {
    await pg.query(
      `INSERT INTO users (
         id, username, display_name, email, name, password_hash,
         password_hash_scheme, role, status, source, source_record_id
       ) VALUES (
         'user-invited', 'invitee@example.com', 'invitee@example.com',
         'invitee@example.com', NULL, NULL, NULL, 'member', 'invited',
         'legacy_snapshot', 'legacy-user-invited'
       )`,
    );
    await pg.query(
      `INSERT INTO sessions (
         id, user_id, token_hash, token_hash_scheme, status,
         expires_at, revoked_at, last_seen_at, revocation_reason,
         source, source_record_id
       ) VALUES (
         'session-legacy', 'user-invited', $1, 'sha256', 'revoked',
         now(), now(), NULL, 'legacy_cutover', 'legacy_snapshot', 'legacy-session'
       )`,
      ["a".repeat(64)],
    );
    await pg.query(
      `INSERT INTO invitations (
         id, user_id, token_hash, token_hash_scheme, status,
         expires_at, revoked_at, revocation_reason, source, source_record_id
       ) VALUES (
         'invitation-legacy', 'user-invited', $1, 'sha256', 'revoked',
         now() + interval '30 days', now(), 'legacy_cutover',
         'legacy_snapshot', 'legacy-invitation'
       )`,
      ["b".repeat(64)],
    );

    await expect(
      pg.query(
        `INSERT INTO sessions (
           id, user_id, token_hash, token_hash_scheme, status,
           expires_at, source
         ) VALUES (
           'session-unsafe', 'user-invited', $1, 'sha256', 'active',
           now() + interval '1 day', 'legacy_snapshot'
         )`,
        ["c".repeat(64)],
      ),
    ).rejects.toThrow();

    const identity = await pg.query<{
      name: string | null;
      password_hash: string | null;
      last_seen_at: string | null;
    }>(
      `SELECT users.name, users.password_hash, sessions.last_seen_at
       FROM users
       JOIN sessions ON sessions.user_id = users.id
       WHERE users.id = 'user-invited'`,
    );
    expect(identity.rows[0]).toMatchObject({
      name: null,
      password_hash: null,
      last_seen_at: null,
    });
  });

  it("prevents credential identity rewrites and terminal-state resurrection", async () => {
    await pg.query(
      `INSERT INTO users (
         id, username, display_name, email, name, password_hash,
         password_hash_scheme, role, status, source
       ) VALUES (
         'credential-guard-user', 'guard@example.com', 'Guard',
         'guard@example.com', 'Guard',
         $1, 'scrypt-v1', 'member', 'active', 'native'
       )`,
      [`scrypt$v1$16384$8$1$${"a".repeat(22)}$${"b".repeat(86)}`],
    );
    await pg.query(
      `INSERT INTO sessions (
         id, user_id, token_hash, token_hash_scheme, token_key_id, status,
         expires_at, source
       ) VALUES (
         'guard-session', 'credential-guard-user', $1,
         'hmac-sha256', 'credential-key-1', 'active',
         now() + interval '1 day', 'native'
       )`,
      ["c".repeat(64)],
    );
    await pg.query(
      `UPDATE sessions
       SET status = 'revoked', revoked_at = now(), revocation_reason = 'logout'
       WHERE id = 'guard-session'`,
    );
    await expect(
      pg.query(
        `UPDATE sessions
         SET status = 'active', revoked_at = NULL
         WHERE id = 'guard-session'`,
      ),
    ).rejects.toThrow(/terminal state cannot be resurrected/);
    await expect(
      pg.query(
        `UPDATE sessions
         SET token_key_id = 'credential-key-2'
         WHERE id = 'guard-session'`,
      ),
    ).rejects.toThrow(/identity and verifier are immutable/);
    await expect(
      pg.query(
        `INSERT INTO sessions (
           id, user_id, token_hash, token_hash_scheme, status,
           expires_at, source
         ) VALUES (
           'unkeyed-native-session', 'credential-guard-user', $1,
           'sha256', 'active', now() + interval '1 day', 'native'
         )`,
        ["d".repeat(64)],
      ),
    ).rejects.toThrow();

    await pg.query(
      `INSERT INTO invitations (
         id, user_id, token_hash, token_hash_scheme, token_key_id, status,
         expires_at, source
       ) VALUES (
         'guard-invitation', 'credential-guard-user', $1,
         'hmac-sha256', 'credential-key-1', 'pending',
         now() + interval '1 day', 'native'
       )`,
      ["e".repeat(64)],
    );
    await pg.query(
      `UPDATE invitations
       SET status = 'accepted', accepted_at = now()
       WHERE id = 'guard-invitation'`,
    );
    await expect(
      pg.query(
        `UPDATE invitations
         SET status = 'pending', accepted_at = NULL
         WHERE id = 'guard-invitation'`,
      ),
    ).rejects.toThrow(/terminal state cannot be resurrected/);
    await expect(
      pg.query(
        `UPDATE invitations
         SET expires_at = expires_at + interval '1 day'
         WHERE id = 'guard-invitation'`,
      ),
    ).rejects.toThrow(/identity and verifier are immutable/);
  });

  it("stores checkpoint, archive, routing, shadow, and reconciliation evidence", async () => {
    await pg.exec(`
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES (
        'project-import', 'Imported', 'initializing',
        'assignment/default', 'verification/default', 'budget/default'
      );
      INSERT INTO migration_runs (
        id, migration_name, source_snapshot_hashes, source_counts,
        source_frozen_at, source_manifest_hash, source_application_version,
        source_application_commit, status, started_at
      ) VALUES (
        'migration-run-1', 'legacy-preservation', '{}'::jsonb, '{}'::jsonb,
        now(), repeat('a', 64), '0.1.0', '0123456789abcdef',
        'capturing', now()
      );
      INSERT INTO recovery_checkpoints (
        id, migration_run_id, provider, backup_reference, database_time,
        wal_lsn, transaction_id, application_version, application_commit,
        source_manifest_hash, source_frozen_at
      ) VALUES (
        'checkpoint-1', 'migration-run-1', 'postgres', 'backup-1', now(),
        '0/16B6C50', '100', '0.1.0', '0123456789abcdef',
        repeat('a', 64), now()
      );
      INSERT INTO archive_encryption_key_registry (key_id, key_fingerprint)
      VALUES ('key-1', repeat('9', 64));
      INSERT INTO legacy_snapshot_archives (
        id, migration_run_id, source_key, source_updated_at,
        storage_ref, key_id, key_fingerprint, cipher, exact_hash, canonical_hash,
        ciphertext_hash, aad_hash, manifest_hash, exact_byte_size,
        canonical_byte_size, object_counts, last_record, nonce, auth_tag,
        ciphertext, status, captured_at, retention_until
      ) VALUES (
        'archive-1', 'migration-run-1', 'projects', now(),
        'postgres:legacy_snapshot_archives/archive-1', 'key-1', repeat('9', 64),
        'aes-256-gcm',
        repeat('a', 64), repeat('c', 64), repeat('b', 64), repeat('d', 64),
        repeat('a', 64), 1024, 1000, '{"projects":1}'::jsonb,
        '{"last_project_id":"project-import"}'::jsonb,
        decode('00112233445566778899aabb', 'hex'),
        decode('00112233445566778899aabbccddeeff', 'hex'),
        decode('deadbeef', 'hex'),
        'sealed', now(), now() + interval '90 days'
      );
      INSERT INTO legacy_snapshot_archives (
        id, migration_run_id, source_key, source_updated_at,
        storage_ref, key_id, key_fingerprint, cipher, exact_hash, canonical_hash,
        ciphertext_hash, aad_hash, manifest_hash, exact_byte_size,
        canonical_byte_size, object_counts, last_record, nonce, auth_tag,
        ciphertext, status, captured_at, retention_until
      )
      SELECT
        'archive-users', migration_run_id, 'users', source_updated_at,
        'postgres:legacy_snapshot_archives/archive-users', key_id, key_fingerprint, cipher,
        exact_hash, canonical_hash, ciphertext_hash, aad_hash, manifest_hash,
        exact_byte_size, canonical_byte_size, '{"users":1}'::jsonb, NULL,
        decode('00112233445566778899aabc', 'hex'),
        auth_tag, ciphertext, status, captured_at, retention_until
      FROM legacy_snapshot_archives WHERE id = 'archive-1';
      INSERT INTO legacy_snapshot_archives (
        id, migration_run_id, source_key, source_updated_at,
        storage_ref, key_id, key_fingerprint, cipher, exact_hash, canonical_hash,
        ciphertext_hash, aad_hash, manifest_hash, exact_byte_size,
        canonical_byte_size, object_counts, last_record, nonce, auth_tag,
        ciphertext, status, captured_at, retention_until
      )
      SELECT
        'archive-relay', migration_run_id, 'relay', source_updated_at,
        'postgres:legacy_snapshot_archives/archive-relay', key_id, key_fingerprint, cipher,
        exact_hash, canonical_hash, ciphertext_hash, aad_hash, manifest_hash,
        exact_byte_size, canonical_byte_size, '{"audit":0}'::jsonb, NULL,
        decode('00112233445566778899aabd', 'hex'),
        auth_tag, ciphertext, status, captured_at, retention_until
      FROM legacy_snapshot_archives WHERE id = 'archive-1';
      INSERT INTO project_planning_preferences (
        project_id, pm_provider, pm_model, reviewer_provider, source
      ) VALUES (
        'project-import', 'openai', NULL, 'anthropic', 'legacy_snapshot'
      );
      INSERT INTO repository_binding_candidates (
        id, project_id, source_type, source_fingerprint, display_name,
        status, archive_id, source_record_id
      ) VALUES (
        'candidate-1', 'project-import', 'local', repeat('c', 64),
        'Local repository', 'unverified', 'archive-1', 'legacy-project-import'
      );
      INSERT INTO migration_steps (
        migration_run_id, step_key, input_hash, status
      ) VALUES (
        'migration-run-1', 'project:project-import', repeat('d', 64), 'pending'
      );
      INSERT INTO legacy_id_mappings (
        migration_run_id, legacy_entity_type, legacy_id, v2_entity_type,
        v2_id, source_hash, source_metadata
      ) VALUES (
        'migration-run-1', 'project', 'legacy-project-import', 'project',
        'project-import', repeat('a', 64), '{"ordinal":0}'::jsonb
      );
      INSERT INTO legacy_project_imports (
        migration_run_id, project_id, source_hash, plan_hash, graph_hash,
        approval_hash, graph_version, source_counts, import_hash, archive_id,
        imported_at
      ) VALUES (
        'migration-run-1', 'project-import', repeat('a', 64),
        repeat('b', 64), repeat('c', 64), NULL, 2,
        '{"projects":1,"modules":1}'::jsonb, repeat('d', 64), 'archive-1', now()
      );
      INSERT INTO migration_reconciliation_findings (
        id, migration_run_id, project_id, code, severity, source_entity_type,
        source_entity_id, source_fingerprint, detected_at
      ) VALUES (
        'finding-1', 'migration-run-1', 'project-import',
        'graph_node_without_plan_module', 'blocking', 'graph_node',
        'task-1', repeat('e', 64), now()
      );
      INSERT INTO shadow_read_comparisons (
        id, migration_run_id, scope_type, scope_key, operation,
        legacy_hash, relational_hash, matched, differences, observed_at
      ) VALUES (
        'comparison-1', 'migration-run-1', 'project', 'project-import', 'graph',
        repeat('a', 64), repeat('b', 64), false, '["/nodes/task-1"]'::jsonb, now()
      );
      INSERT INTO persistence_routes (
        scope_type, scope_key, read_mode, write_mode, migration_run_id,
        changed_by_actor_type, changed_by_actor_id, changed_at
      ) VALUES (
        'project', 'project-import', 'shadow', 'legacy', 'migration-run-1',
        'human', 'user-invited', now()
      );
      INSERT INTO legacy_approval_evidence (
        id, migration_run_id, project_id, subject_entity_type, subject_entity_id,
        content_hash, graph_version, allocation_fingerprint, actor_type,
        source_actor_text,
        approved_at, current_at_import, source_hash
      ) VALUES (
        'legacy-approval-1', 'migration-run-1', 'project-import',
        'allocation', 'project-import', repeat('f', 64), 2, repeat('e', 64),
        'legacy', 'operator', now(), false, repeat('d', 64)
      );
    `);

    await expect(
      pg.query(
        `INSERT INTO persistence_routes (
           scope_type, scope_key, read_mode, write_mode, migration_run_id,
           changed_by_actor_type, changed_at
         ) VALUES (
           'identity', '*', 'relational', 'relational', 'migration-run-1',
           'system', now()
         )`,
      ),
    ).rejects.toThrow();
    await expect(
      pg.query(
        `INSERT INTO migration_reconciliation_findings (
           id, migration_run_id, code, severity, source_entity_type,
           source_fingerprint, detected_at
         ) VALUES (
           'finding-invalid', 'migration-run-1', 'made_up', 'warning',
           'snapshot', $1, now()
         )`,
        ["f".repeat(64)],
      ),
    ).rejects.toThrow();

    const counts = await pg.query<{ archives: number; findings: number; routes: number }>(
      `SELECT
         (SELECT count(*)::int FROM legacy_snapshot_archives) AS archives,
         (SELECT count(*)::int FROM migration_reconciliation_findings) AS findings,
         (SELECT count(*)::int FROM persistence_routes) AS routes`,
    );
    expect(counts.rows[0]).toEqual({ archives: 3, findings: 1, routes: 1 });
  });

  it("enforces nonce uniqueness and one-way checkpoint/archive verification", async () => {
    await pg.query(
      `UPDATE recovery_checkpoints
       SET verified_at = now()
       WHERE id = 'checkpoint-1'`,
    );
    const checkpoint = await pg.query<{ verified: boolean }>(
      `SELECT verified_at IS NOT NULL AS verified
       FROM recovery_checkpoints WHERE id = 'checkpoint-1'`,
    );
    expect(checkpoint.rows[0]?.verified).toBe(true);
    await expect(
      pg.query(
        `UPDATE recovery_checkpoints
         SET verified_at = now() + interval '1 second'
         WHERE id = 'checkpoint-1'`,
      ),
    ).rejects.toThrow(/set exactly once/);
    await expect(
      pg.query(
        `UPDATE recovery_checkpoints
         SET provider = 'rewritten'
         WHERE id = 'checkpoint-1'`,
      ),
    ).rejects.toThrow(/identity cannot change/);
    await expect(
      pg.query("DELETE FROM recovery_checkpoints WHERE id = 'checkpoint-1'"),
    ).rejects.toThrow(/append-only/);
    await expect(pg.query("TRUNCATE recovery_checkpoints")).rejects.toThrow(/append-only/);

    await pg.query(
      `UPDATE legacy_snapshot_archives
       SET status = 'verified', verified_at = now()
       WHERE id = 'archive-1'`,
    );
    const verifiedArchive = await pg.query<{
      status: string;
      verified: boolean;
      ciphertext_hex: string;
    }>(
      `SELECT status, verified_at IS NOT NULL AS verified,
              encode(ciphertext, 'hex') AS ciphertext_hex
       FROM legacy_snapshot_archives WHERE id = 'archive-1'`,
    );
    expect(verifiedArchive.rows[0]).toEqual({
      status: "verified",
      verified: true,
      ciphertext_hex: "deadbeef",
    });
    await expect(
      pg.query(
        `UPDATE legacy_snapshot_archives
         SET ciphertext = decode('ff', 'hex')
         WHERE id = 'archive-1'`,
      ),
    ).rejects.toThrow(/payload and identity are immutable/);
    await expect(
      pg.query(
        `UPDATE legacy_snapshot_archives
         SET storage_ref = 'rewritten'
         WHERE id = 'archive-1'`,
      ),
    ).rejects.toThrow(/payload and identity are immutable/);
    await expect(
      pg.query(
        `UPDATE legacy_snapshot_archives
         SET verified_at = now()
         WHERE id = 'archive-1'`,
      ),
    ).rejects.toThrow(/allows only/);
    await expect(
      pg.query(
        `UPDATE legacy_snapshot_archives
         SET status = 'sealed', verified_at = NULL
         WHERE id = 'archive-1'`,
      ),
    ).rejects.toThrow(/allows only/);

    await expect(
      pg.query(
        `INSERT INTO legacy_snapshot_archives (
           id, migration_run_id, source_key, source_updated_at,
           storage_ref, key_id, key_fingerprint, cipher, exact_hash, canonical_hash,
           ciphertext_hash, aad_hash, manifest_hash, exact_byte_size,
           canonical_byte_size, object_counts, last_record, nonce, auth_tag,
           ciphertext, status, captured_at, retention_until
         )
         SELECT
           'archive-nonce-reuse', migration_run_id, 'nonce-reuse', source_updated_at,
           'postgres:legacy_snapshot_archives/archive-nonce-reuse',
           key_id, key_fingerprint, cipher,
           exact_hash, canonical_hash, ciphertext_hash, aad_hash, manifest_hash,
           exact_byte_size, canonical_byte_size, '{}'::jsonb, NULL, nonce,
           auth_tag, ciphertext, 'sealed', captured_at, retention_until
         FROM legacy_snapshot_archives WHERE id = 'archive-1'`,
      ),
    ).rejects.toThrow(/legacy_snapshot_archives_key_nonce_unique|unique/i);

    await expect(
      pg.query(
        `UPDATE legacy_id_mappings
         SET source_hash = repeat('f', 64)
         WHERE migration_run_id = 'migration-run-1'
           AND legacy_entity_type = 'project'
           AND legacy_id = 'legacy-project-import'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pg.query(
        `DELETE FROM legacy_id_mappings
         WHERE migration_run_id = 'migration-run-1'
           AND legacy_entity_type = 'project'
           AND legacy_id = 'legacy-project-import'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(pg.query("TRUNCATE legacy_id_mappings")).rejects.toThrow(/append-only/);

    await pg.query(
      `INSERT INTO archive_encryption_key_registry (key_id, key_fingerprint)
       VALUES ('key-expiring', repeat('8', 64))`,
    );
    await pg.query(
      `INSERT INTO legacy_snapshot_archives (
         id, migration_run_id, source_key, source_updated_at,
         storage_ref, key_id, key_fingerprint, cipher, exact_hash, canonical_hash,
         ciphertext_hash, aad_hash, manifest_hash, exact_byte_size,
         canonical_byte_size, object_counts, last_record, nonce, auth_tag,
         ciphertext, status, captured_at, retention_until, verified_at
       )
       SELECT
         'archive-expiring', migration_run_id, 'expired-source', source_updated_at,
         'postgres:legacy_snapshot_archives/archive-expiring',
         'key-expiring', repeat('8', 64), cipher,
         exact_hash, canonical_hash, ciphertext_hash, aad_hash, manifest_hash,
         exact_byte_size, canonical_byte_size, '{}'::jsonb, NULL,
         decode('111122223333444455556666', 'hex'), auth_tag, ciphertext,
         'verified', now() - interval '2 days', now() - interval '1 day',
         now() - interval '2 days' + interval '1 hour'
       FROM legacy_snapshot_archives WHERE id = 'archive-1'`,
    );
    await pg.query(
      `UPDATE legacy_snapshot_archives
       SET status = 'expired'
       WHERE id = 'archive-expiring'`,
    );
    const expired = await pg.query<{ status: string; ciphertext_hex: string }>(
      `SELECT status, encode(ciphertext, 'hex') AS ciphertext_hex
       FROM legacy_snapshot_archives WHERE id = 'archive-expiring'`,
    );
    expect(expired.rows[0]).toEqual({ status: "expired", ciphertext_hex: "deadbeef" });
    await expect(pg.query("TRUNCATE legacy_snapshot_archives CASCADE")).rejects.toThrow(
      /append-only/,
    );
  });

  it("enforces archive-only project and append-only recovery privileges", async () => {
    await pg.query(
      `INSERT INTO legacy_archive_access_events (
         id, archive_id, actor_type, actor_id, operation, outcome,
         correlation_id, occurred_at
       ) VALUES (
         'archive-access-owner', 'archive-1', 'human', 'user-invited',
         'verify', 'allowed', 'correlation-1', now()
       )`,
    );
    await expect(
      pg.query(
        `UPDATE legacy_archive_access_events
         SET outcome = 'failed'
         WHERE id = 'archive-access-owner'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pg.query("DELETE FROM migration_runs WHERE id = 'migration-run-1'"),
    ).rejects.toThrow(/append-only/);
    await expect(
      pg.query("DELETE FROM legacy_snapshot_archives WHERE id = 'archive-1'"),
    ).rejects.toThrow(/append-only/);

    await pg.exec("SET ROLE norns_app");
    try {
      await expect(
        pg.query(
          `INSERT INTO legacy_archive_access_events (
             id, archive_id, actor_type, operation, outcome,
             correlation_id, occurred_at
           ) VALUES (
             'archive-access-runtime', 'archive-1', 'system',
             'head', 'allowed', 'correlation-2', now()
           )`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        pg.query(
          `UPDATE persistence_routes
           SET read_mode = 'relational'
           WHERE scope_type = 'project' AND scope_key = 'project-import'`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        pg.query(
          `INSERT INTO persistence_routes (
             scope_type, scope_key, read_mode, write_mode,
             aggregate_version, changed_by_actor_type, changed_at
           ) VALUES ('identity','*','relational','relational',1,'system',now())`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        pg.query(
          `UPDATE migration_reconciliation_findings
           SET status = 'resolved', resolved_at = now()
           WHERE id = 'finding-1'`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(pg.query("DELETE FROM projects WHERE id = 'project-import'")).rejects.toThrow(
        /permission denied/,
      );
      await expect(pg.query("DELETE FROM users WHERE id = 'user-invited'")).rejects.toThrow(
        /permission denied/,
      );
      await expect(pg.query("DELETE FROM sessions WHERE id = 'session-legacy'")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        pg.query("DELETE FROM invitations WHERE id = 'invitation-legacy'"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        pg.query("DELETE FROM repository_binding_candidates WHERE id = 'candidate-1'"),
      ).rejects.toThrow(/permission denied/);
      const metadata = await pg.query<{ source_key: string }>(
        "SELECT source_key FROM legacy_snapshot_archives WHERE id = 'archive-1'",
      );
      expect(metadata.rows[0]?.source_key).toBe("projects");
      await expect(
        pg.query("SELECT ciphertext FROM legacy_snapshot_archives WHERE id = 'archive-1'"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        pg.query("DELETE FROM migration_reconciliation_findings WHERE id = 'finding-1'"),
      ).rejects.toThrow(/permission denied|append-only/);
      await expect(
        pg.query("DELETE FROM shadow_read_comparisons WHERE id = 'comparison-1'"),
      ).rejects.toThrow(/permission denied|append-only/);
    } finally {
      await pg.exec("RESET ROLE");
    }

    const legacy = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM norns_state",
    );
    expect(legacy.rows[0]?.count).toBe(3);
  });
});
