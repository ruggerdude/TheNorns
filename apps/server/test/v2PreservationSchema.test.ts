import { PGlite } from "@electric-sql/pglite";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEBATE_WORKFLOW_MIGRATION_NAME,
  GITHUB_APP_MANIFEST_MIGRATION_NAME,
  PHASE1_V2_MIGRATION_NAME,
  PHASE2_PRESERVATION_MIGRATION_NAME,
  PHASE3_SOURCE_BINDINGS_MIGRATION_NAME,
  PHASE5_ATTENTION_MIGRATION_NAME,
  PHASE6_COORDINATION_MIGRATION_NAME,
  PHASE7_HARDENING_MIGRATION_NAME,
  PHASE8_CUTOVER_COMPLETION_MIGRATION_NAME,
  PLANNING_RUNS_MIGRATION_NAME,
  QC_COMMUNICATION_MIGRATION_NAME,
  type V2MigrationDatabase,
  WORKSPACE_CONNECTIONS_MIGRATION_NAME,
  runCurrentV2Migrations,
  runPhase1V2Migration,
  runPhase2PreservationMigration,
  runV2Migrations,
} from "../src/persistence/v2/migrate.js";
import { phase2PreservationSchema } from "../src/persistence/v2/schema.js";

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;

describe.sequential("Phase 2 forward migration dependency", () => {
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
    expect(second).toMatchObject([
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
    ]);
    const tracking = await pg.query<{ name: string }>(
      "SELECT name FROM norns_schema_migrations ORDER BY name",
    );
    expect(tracking.rows.map((row) => row.name)).toEqual([
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
    ]);
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
