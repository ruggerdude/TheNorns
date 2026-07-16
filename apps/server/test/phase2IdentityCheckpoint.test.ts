import { scryptSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { decryptLegacyArchive } from "../src/persistence/migration/archiveCrypto.js";
import {
  Phase2IdentityCheckpointCoordinator,
  Phase2SourceChangedError,
  type RunPhase2IdentityCheckpointInput,
} from "../src/persistence/migration/phase2Coordinator.js";
import { SqlLegacyArchiveRepository } from "../src/persistence/migration/sqlArchiveRepository.js";
import {
  type PGliteDatabaseLike,
  PGliteTransactionRunner,
} from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { hashLegacyCredentialToken } from "../src/users/credentialTokens.js";
import { hashCurrentPassword } from "../src/users/passwords.js";
import { RelationalIdentityService } from "../src/users/relationalIdentityService.js";

const ARCHIVE_KEY = {
  keyId: "archive-key-test",
  key: Buffer.alloc(32, 3),
};
const CREDENTIAL_KEY = {
  keyId: "credential-key-test",
  key: Buffer.alloc(32, 4),
};
const LEGACY_SESSION_TOKEN = "legacy-session-token-that-must-be-revoked";
const LEGACY_INVITE_TOKEN = "legacy-invite-token-that-must-be-revoked";

function legacyPasswordHash(password: string): string {
  const salt = Buffer.alloc(16, 5);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function legacyUsersSnapshot(): Record<string, unknown> {
  return {
    users: [
      {
        id: "user-admin",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        status: "active",
        passwordHash: legacyPasswordHash("admin-password"),
        inviteToken: null,
        createdAt: "2026-07-15T18:00:00.000Z",
      },
      {
        id: "user-invited",
        email: "invited@example.com",
        name: null,
        role: "member",
        status: "invited",
        passwordHash: null,
        inviteToken: LEGACY_INVITE_TOKEN,
        createdAt: "2026-07-15T18:01:00.000Z",
      },
    ],
    sessions: [
      {
        token: LEGACY_SESSION_TOKEN,
        userId: "user-admin",
        createdAt: "2026-07-15T18:02:00.000Z",
      },
    ],
    futureEnvelopeField: { preserved: true },
  };
}

async function setup(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    CREATE ROLE norns_app NOLOGIN;
    CREATE TABLE norns_state (
      key TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pg.query(
    `INSERT INTO norns_state (key, snapshot, updated_at) VALUES
       ('users', $1::jsonb, '2026-07-15T19:00:00.000Z'),
       ('projects', $2::jsonb, '2026-07-15T19:00:01.000Z'),
       ('relay', $3::jsonb, '2026-07-15T19:00:02.000Z'),
       ('graph', $4::jsonb, '2026-07-15T19:00:03.000Z')`,
    [
      JSON.stringify(legacyUsersSnapshot()),
      JSON.stringify({
        projects: [
          {
            id: "project-legacy",
            name: "Legacy Project",
            description: "Preserved",
            pmProvider: "anthropic",
            createdAt: "2026-07-15T18:03:00.000Z",
            plan: null,
            graph: null,
            approval: null,
          },
        ],
      }),
      JSON.stringify({ audit: [] }),
      JSON.stringify({ version: 1, nodes: [] }),
    ],
  );
  await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
  return pg;
}

function runInput(
  overrides: Partial<RunPhase2IdentityCheckpointInput> = {},
): RunPhase2IdentityCheckpointInput {
  let nonce = 0;
  return {
    migration_run_id: "migration-phase2-identity-1",
    backup_provider: "railway",
    backup_reference: "railway-backup-2026-07-16",
    application_version: "0.1.0",
    application_commit: "0123456789abcdef",
    retention_expires_at: "2026-12-31T00:00:00.000Z",
    archive_key: ARCHIVE_KEY,
    credential_key: CREDENTIAL_KEY,
    random_bytes: (size) => {
      nonce += 1;
      return Buffer.alloc(size, nonce);
    },
    ...overrides,
  };
}

function coordinator(pg: PGlite): Phase2IdentityCheckpointCoordinator {
  return new Phase2IdentityCheckpointCoordinator(
    new PGliteTransactionRunner(pg as unknown as PGliteDatabaseLike),
  );
}

describe.sequential("Phase 2 SQL identity checkpoint", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(
      databases.splice(0).map(async (database) => {
        if (!database.closed) await database.close();
      }),
    );
  });

  it("archives every source, imports exact identities, revokes credentials, and sanitizes legacy", async () => {
    const pg = await setup();
    databases.push(pg);
    const result = await coordinator(pg).run(runInput());

    expect(result).toMatchObject({
      migration_run_id: "migration-phase2-identity-1",
      replayed: false,
      counts: { users: 2, sessions: 1, invitations: 1, active_admins: 1 },
    });
    expect(result.source_bundle_hash).toMatch(/^[a-f0-9]{64}$/);

    const checkpointState = await pg.query<{
      run_status: string;
      completed_at: Date | null;
      step_status: string;
      output_counts: Record<string, number>;
    }>(
      `SELECT run.status AS run_status, run.completed_at,
              step.status AS step_status, step.output_counts
       FROM migration_runs run
       JOIN migration_steps step ON step.migration_run_id = run.id
       WHERE run.id = $1 AND step.step_key = 'identity_import'`,
      [result.migration_run_id],
    );
    expect(checkpointState.rows[0]).toEqual({
      run_status: "importing",
      completed_at: null,
      step_status: "succeeded",
      output_counts: { users: 2, sessions: 1, invitations: 1, active_admins: 1 },
    });

    const users = await pg.query<{
      id: string;
      email: string;
      name: string | null;
      role: string;
      status: string;
      password_hash: string | null;
      password_hash_scheme: string | null;
      created_at: Date;
    }>(
      `SELECT id, email, name, role, status, password_hash,
              password_hash_scheme, created_at
       FROM users ORDER BY id`,
    );
    expect(users.rows).toMatchObject([
      {
        id: "user-admin",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        status: "active",
        password_hash: legacyPasswordHash("admin-password"),
        password_hash_scheme: "legacy-scrypt-v0",
      },
      {
        id: "user-invited",
        email: "invited@example.com",
        name: null,
        role: "member",
        status: "invited",
        password_hash: null,
        password_hash_scheme: null,
      },
    ]);

    const sessions = await pg.query<{
      id: string;
      token_hash: string;
      status: string;
      revoked_at: Date | null;
      token_key_id: string;
    }>(
      `SELECT id, token_hash, status, revoked_at, token_key_id
       FROM sessions WHERE source = 'legacy_snapshot'`,
    );
    const session = sessions.rows[0];
    expect(session).toMatchObject({
      status: "revoked",
      token_key_id: CREDENTIAL_KEY.keyId,
    });
    expect(session?.revoked_at).not.toBeNull();
    expect(session?.token_hash).not.toBe(LEGACY_SESSION_TOKEN);
    expect(session?.token_hash).toBe(
      hashLegacyCredentialToken(LEGACY_SESSION_TOKEN, "session", session?.id ?? "", CREDENTIAL_KEY),
    );
    const authenticatingSession = await pg.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM sessions
       WHERE token_hash = $1 AND status = 'active' AND revoked_at IS NULL`,
      [session?.token_hash],
    );
    expect(authenticatingSession.rows[0]?.count).toBe(0);

    const invitations = await pg.query<{
      id: string;
      token_hash: string;
      status: string;
      revoked_at: Date | null;
    }>(
      `SELECT id, token_hash, status, revoked_at
       FROM invitations WHERE source = 'legacy_snapshot'`,
    );
    expect(invitations.rows[0]).toMatchObject({ status: "revoked" });
    expect(invitations.rows[0]?.token_hash).not.toBe(LEGACY_INVITE_TOKEN);
    expect(invitations.rows[0]?.revoked_at).not.toBeNull();

    const sanitized = await pg.query<{ snapshot: Record<string, unknown> }>(
      "SELECT snapshot FROM norns_state WHERE key = 'users'",
    );
    expect(sanitized.rows[0]?.snapshot).toMatchObject({
      futureEnvelopeField: { preserved: true },
      sessions: [],
    });
    expect(JSON.stringify(sanitized.rows[0]?.snapshot)).not.toContain(LEGACY_SESSION_TOKEN);
    expect(JSON.stringify(sanitized.rows[0]?.snapshot)).not.toContain(LEGACY_INVITE_TOKEN);

    const archiveRows = await pg.query<{
      source_key: string;
      ciphertext: Uint8Array;
      exact_hash: string;
      canonical_hash: string;
    }>(
      `SELECT source_key, ciphertext, exact_hash, canonical_hash
       FROM legacy_snapshot_archives ORDER BY source_key`,
    );
    expect(archiveRows.rows.map((row) => row.source_key)).toEqual([
      "graph",
      "projects",
      "relay",
      "users",
    ]);
    expect(
      archiveRows.rows.map((row) => Buffer.from(row.ciphertext).toString("utf8")).join(""),
    ).not.toContain(LEGACY_SESSION_TOKEN);
    expect(archiveRows.rows.every((row) => /^[a-f0-9]{64}$/.test(row.exact_hash))).toBe(true);
    expect(archiveRows.rows.every((row) => /^[a-f0-9]{64}$/.test(row.canonical_hash))).toBe(true);

    const evidence = await pg.query<{ writes: number; findings: number; mappings: number }>(
      `SELECT
         (SELECT count(*) FROM legacy_archive_access_events
          WHERE operation = 'write')::int AS writes,
         (SELECT count(*) FROM migration_reconciliation_findings
          WHERE code = 'unknown_snapshot_key')::int AS findings,
         (SELECT count(*) FROM legacy_id_mappings)::int AS mappings`,
    );
    expect(evidence.rows[0]).toEqual({ writes: 4, findings: 1, mappings: 4 });

    const transactions = new PGliteTransactionRunner(pg as unknown as PGliteDatabaseLike);
    const opened = await transactions.transaction((sql) =>
      new SqlLegacyArchiveRepository(sql).findCiphertext(
        "legacy_archive:migration-phase2-identity-1:users",
        {
          access_id: "archive_access:test-read",
          archive_id: "legacy_archive:migration-phase2-identity-1:users",
          actor_type: "human",
          actor_id: "user-admin",
          session_id: "test-session",
          purpose: "restore_validation",
          correlation_id: "restore-validation-1",
          requested_at: "2026-07-16T20:00:00.000Z",
        },
      ),
    );
    expect(opened.access.outcome).toBe("allowed");
    if (!opened.record) throw new Error("expected the users archive");
    const restoredSource = decryptLegacyArchive(opened.record.encrypted, ARCHIVE_KEY, {
      archive_id: opened.record.archive_id,
      migration_run_id: opened.record.migration_run_id,
      source_key: opened.record.source_key,
      exact_text_sha256: opened.record.exact_text_sha256,
      semantic_sha256: opened.record.semantic_sha256,
      source_frozen_at: opened.record.source_frozen_at,
    }).toString("utf8");
    expect(restoredSource).toContain(LEGACY_SESSION_TOKEN);
    const readAccess = await pg.query<{
      operation: string;
      actor_id: string;
      details: { purpose: string };
    }>(
      `SELECT operation, actor_id, details
       FROM legacy_archive_access_events
       WHERE id = 'archive_access:test-read'`,
    );
    expect(readAccess.rows[0]).toEqual({
      operation: "read",
      actor_id: "user-admin",
      details: {
        purpose: "restore_validation",
        session_present: true,
        reason_code: null,
      },
    });

    await pg.exec("SET ROLE norns_app");
    try {
      await expect(
        pg.query("SELECT ciphertext FROM legacy_snapshot_archives LIMIT 1"),
      ).rejects.toThrow(/permission denied/);
      const metadata = await pg.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM legacy_snapshot_archives",
      );
      expect(metadata.rows[0]?.count).toBe(4);
    } finally {
      await pg.exec("RESET ROLE");
    }
  }, 30_000);

  it("replays the sanitized bundle once and refuses a changed source", async () => {
    const pg = await setup();
    databases.push(pg);
    const runner = coordinator(pg);
    const input = runInput();
    const first = await runner.run(input);
    const replay = await runner.run(input);
    expect(replay).toEqual({ ...first, replayed: true });

    await pg.query("UPDATE migration_runs SET status = 'shadowing' WHERE id = $1", [
      first.migration_run_id,
    ]);
    expect(await runner.run(input)).toEqual({ ...first, replayed: true });
    await expect(
      runner.run({ ...input, application_commit: "different-implementation-commit" }),
    ).rejects.toThrow(/application commit recorded at checkpoint capture/);
    await expect(
      runner.run({ ...input, migration_run_id: "migration-phase2-identity-new-lineage" }),
    ).rejects.toThrow(/already belongs to migration run/);

    const before = await pg.query<{
      runs: number;
      archives: number;
      users: number;
      sessions: number;
      steps: number;
    }>(
      `SELECT
         (SELECT count(*) FROM migration_runs)::int AS runs,
         (SELECT count(*) FROM legacy_snapshot_archives)::int AS archives,
         (SELECT count(*) FROM users)::int AS users,
         (SELECT count(*) FROM sessions)::int AS sessions,
         (SELECT count(*) FROM migration_steps
          WHERE step_key = 'identity_import' AND status = 'succeeded')::int AS steps`,
    );
    expect(before.rows[0]).toEqual({
      runs: 1,
      archives: 4,
      users: 2,
      sessions: 1,
      steps: 1,
    });

    await pg.query(
      `UPDATE norns_state
       SET snapshot = '{"projects":[]}'::jsonb, updated_at = now()
       WHERE key = 'projects'`,
    );
    await expect(runner.run(input)).rejects.toThrow(Phase2SourceChangedError);
    const after = await pg.query<{ runs: number; archives: number }>(
      `SELECT
         (SELECT count(*) FROM migration_runs)::int AS runs,
         (SELECT count(*) FROM legacy_snapshot_archives)::int AS archives`,
    );
    expect(after.rows[0]).toEqual({ runs: 1, archives: 4 });
  }, 30_000);

  it("preserves a self-describing current password scheme and can log in after import", async () => {
    const pg = await setup();
    databases.push(pg);
    const snapshot = legacyUsersSnapshot();
    const admin = (snapshot.users as Record<string, unknown>[])[0];
    if (!admin) throw new Error("identity fixture requires an administrator");
    admin.passwordHash = hashCurrentPassword("current-admin-password", (size) =>
      Buffer.alloc(size, 12),
    );
    await pg.query(
      `UPDATE norns_state
       SET snapshot = $1::jsonb
       WHERE key = 'users'`,
      [JSON.stringify(snapshot)],
    );

    await coordinator(pg).run(runInput());
    const imported = await pg.query<{ password_hash_scheme: string }>(
      "SELECT password_hash_scheme FROM users WHERE id = 'user-admin'",
    );
    expect(imported.rows[0]?.password_hash_scheme).toBe("scrypt-v1");

    const identity = new RelationalIdentityService({
      transactions: new PGliteTransactionRunner(pg as unknown as PGliteDatabaseLike),
      credentialKey: CREDENTIAL_KEY,
      randomBytes: (size) => Buffer.alloc(size, 13),
      clock: () => new Date("2026-07-16T20:30:00.000Z"),
    });
    const login = await identity.login("admin@example.com", "current-admin-password");
    expect(login.user.id).toBe("user-admin");
    await expect(identity.userForToken(login.token)).resolves.toMatchObject({
      id: "user-admin",
      role: "admin",
    });
  });

  it("rolls back checkpoint, archives, identity rows, mappings, and sanitization on fault", async () => {
    const pg = await setup();
    databases.push(pg);
    await expect(
      coordinator(pg).run(runInput({ fault_at: "after_identity_import" })),
    ).rejects.toThrow(/fault injected/);

    const rows = await pg.query<{
      runs: number;
      archives: number;
      users: number;
      sessions: number;
      invitations: number;
      mappings: number;
    }>(
      `SELECT
         (SELECT count(*) FROM migration_runs)::int AS runs,
         (SELECT count(*) FROM legacy_snapshot_archives)::int AS archives,
         (SELECT count(*) FROM users)::int AS users,
         (SELECT count(*) FROM sessions)::int AS sessions,
         (SELECT count(*) FROM invitations)::int AS invitations,
         (SELECT count(*) FROM legacy_id_mappings)::int AS mappings`,
    );
    expect(rows.rows[0]).toEqual({
      runs: 0,
      archives: 0,
      users: 0,
      sessions: 0,
      invitations: 0,
      mappings: 0,
    });
    const legacy = await pg.query<{ source_text: string }>(
      "SELECT snapshot::text AS source_text FROM norns_state WHERE key = 'users'",
    );
    expect(legacy.rows[0]?.source_text).toContain(LEGACY_SESSION_TOKEN);
    expect(legacy.rows[0]?.source_text).toContain(LEGACY_INVITE_TOKEN);
  }, 30_000);

  it("requires an externally attributable recovery marker before opening a transaction", async () => {
    const pg = await setup();
    databases.push(pg);
    await expect(coordinator(pg).run(runInput({ backup_reference: "" }))).rejects.toThrow(
      /must not be empty/,
    );
    const runs = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM migration_runs",
    );
    expect(runs.rows[0]?.count).toBe(0);
  }, 30_000);
});
