import { spawn } from "node:child_process";
import { createHash, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import { Phase2MigrationProcessLease } from "../src/persistence/migration/migrationLock.js";
import { Phase2MigrationService } from "../src/persistence/migration/phase2MigrationService.js";
import {
  SqlPhase2RecoveryVerificationRepository,
  readPostgresDatabaseIdentity,
  verifyRestoredLegacySources,
} from "../src/persistence/migration/restoreVerification.js";
import {
  assertRestrictedRuntimeDatabase,
  postgresPoolConfig,
} from "../src/persistence/postgresConnection.js";
import { NodePgTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import {
  assertCredentialHmacKeyCoverage,
  parseCredentialHmacKeyring,
} from "../src/startup/identityRuntime.js";
import type { CredentialHmacKey } from "../src/users/credentialTokens.js";
import { IdentityAlreadyBootstrappedError } from "../src/users/identityService.js";
import { hashCurrentPassword } from "../src/users/passwords.js";
import { RelationalIdentityService } from "../src/users/relationalIdentityService.js";

const databaseUrl = process.env.V2_POSTGRES_TEST_URL;
const enabled = databaseUrl !== undefined && process.env.PHASE2_DOCKER_BACKUP_TEST === "1";
const postgresDescribe = enabled ? describe.sequential : describe.skip;

const ARCHIVE_KEY = {
  keyId: "phase2-real-postgres-archive-key",
  key: Buffer.alloc(32, 71),
};
const CREDENTIAL_KEY: CredentialHmacKey = {
  keyId: "phase2-real-postgres-credential-key",
  key: Buffer.alloc(32, 72),
};
const CURRENT_PASSWORD = "phase2-current-password";
const LEGACY_PASSWORD = "phase2-legacy-password";
const LEGACY_SESSION_TOKEN = "phase2-legacy-session-must-never-authenticate";
const LEGACY_INVITE_TOKEN = "phase2-legacy-invite-must-never-authenticate";

interface ProcessResult {
  stdout: Buffer;
  stderr: string;
}

function runProcess(executable: string, args: string[], input?: Buffer): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const errorText = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(`${executable} exited ${String(code)}: ${errorText.slice(0, 2_000)}`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: errorText });
    });
    child.stdin.end(input);
  });
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function dockerPostgresArgs(parsed: URL, command: "pg_dump" | "pg_restore"): string[] {
  const host = process.platform === "linux" ? "127.0.0.1" : "host.docker.internal";
  return [
    "run",
    "--rm",
    "-i",
    ...(process.platform === "linux" ? ["--network", "host"] : []),
    "-e",
    `PGPASSWORD=${decodeURIComponent(parsed.password)}`,
    "postgres:17-alpine",
    command,
    "--host",
    host,
    "--port",
    parsed.port || "5432",
    "--username",
    decodeURIComponent(parsed.username),
    "--dbname",
    decodeURIComponent(parsed.pathname.slice(1)),
  ];
}

function databaseUrlFor(base: string, database: string, role: string, password: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${database}`;
  parsed.username = role;
  parsed.password = password;
  return parsed.toString();
}

function adminDatabaseUrl(base: string): string {
  const parsed = new URL(base);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

function legacyPasswordHash(password: string): string {
  const salt = Buffer.alloc(16, 73);
  const hash = scryptSync(password, salt, 64, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function cleanProjectFixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./fixtures/phase2/projects/clean-planned.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function legacySnapshots(): Record<"projects" | "relay" | "users", unknown> {
  return {
    users: {
      users: [
        {
          id: "phase2-current-admin",
          email: "Current.Admin@Example.com",
          name: "Current Admin",
          role: "admin",
          status: "active",
          passwordHash: hashCurrentPassword(CURRENT_PASSWORD, () => Buffer.alloc(16, 74)),
          inviteToken: null,
          createdAt: "2026-07-15T17:00:00.000Z",
        },
        {
          id: "phase2-legacy-member",
          email: "legacy.member@example.com",
          name: "Legacy Member",
          role: "member",
          status: "active",
          passwordHash: legacyPasswordHash(LEGACY_PASSWORD),
          inviteToken: null,
          createdAt: "2026-07-15T17:01:00.000Z",
        },
        {
          id: "phase2-invited-member",
          email: "invited.member@example.com",
          name: null,
          role: "member",
          status: "invited",
          passwordHash: null,
          inviteToken: LEGACY_INVITE_TOKEN,
          createdAt: "2026-07-15T17:02:00.000Z",
        },
      ],
      sessions: [
        {
          token: LEGACY_SESSION_TOKEN,
          userId: "phase2-current-admin",
          createdAt: "2026-07-15T17:03:00.000Z",
        },
      ],
    },
    projects: { projects: [cleanProjectFixture()] },
    relay: {
      runners: {},
      commands: {},
      eventsByRunner: {},
      watermark: {},
      audit: [],
      pairings: {},
      killSwitch: false,
    },
  };
}

function migrationDatabase(pool: Pool): V2MigrationDatabase {
  const transactions = new NodePgTransactionRunner(pool, { mode: "privileged" });
  return {
    query: async <TRow = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return result.rowCount === null
        ? { rows: result.rows as TRow[] }
        : { rows: result.rows as TRow[], affectedRows: result.rowCount };
    },
    transaction: (work) => transactions.transaction(work),
  };
}

async function expectPostgresError(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(work).rejects.toThrow(pattern);
}

postgresDescribe("Phase 2 production-shaped PostgreSQL exit checkpoint", () => {
  it("proves preservation, relational identity, runtime boundaries, and a decrypted restore drill", async () => {
    if (!databaseUrl) throw new Error("V2_POSTGRES_TEST_URL is required");
    const suffix = `${process.pid}_${Date.now()}`;
    const migrationRole = `norns_migration_${suffix}`;
    const runtimeRole = `norns_runtime_${suffix}`;
    const sourceDatabase = `norns_phase2_source_${suffix}`;
    const bootstrapDatabase = `norns_phase2_bootstrap_${suffix}`;
    const restoreDatabase = `norns_phase2_restore_${suffix}`;
    const migrationPassword = `migration_${suffix}_password`;
    const runtimePassword = `runtime_${suffix}_password`;
    const adminPool = new Pool(postgresPoolConfig(adminDatabaseUrl(databaseUrl)));
    let migrationPool: Pool | undefined;
    let runtimePoolOne: Pool | undefined;
    let runtimeRestartPool: Pool | undefined;
    let bootstrapMigrationPool: Pool | undefined;
    let bootstrapRuntimePoolOne: Pool | undefined;
    let bootstrapRuntimePoolTwo: Pool | undefined;
    let restoredPool: Pool | undefined;

    try {
      // norns_app is a deployment-level role shared by every isolated test
      // database. The duplicate-object handler makes provisioning race-safe.
      await adminPool.query(`
          DO $role$
          BEGIN
            CREATE ROLE norns_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
              NOREPLICATION NOBYPASSRLS;
          EXCEPTION WHEN duplicate_object THEN
            NULL;
          END
          $role$;
        `);
      const runtimePosture = await adminPool.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                  rolreplication, rolbypassrls
           FROM pg_roles WHERE rolname = 'norns_app'`,
      );
      expect(runtimePosture.rows[0]).toEqual({
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      });

      await adminPool.query(
        `CREATE ROLE ${quoteIdentifier(migrationRole)} LOGIN PASSWORD '${migrationPassword}'
             NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await adminPool.query(
        `CREATE ROLE ${quoteIdentifier(runtimeRole)} LOGIN PASSWORD '${runtimePassword}'
             NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await adminPool.query(`GRANT norns_app TO ${quoteIdentifier(migrationRole)}`);
      await adminPool.query(`GRANT norns_app TO ${quoteIdentifier(runtimeRole)}`);
      await adminPool.query(
        `CREATE DATABASE ${quoteIdentifier(sourceDatabase)} OWNER ${quoteIdentifier(migrationRole)} TEMPLATE template0`,
      );

      const migrationUrl = databaseUrlFor(
        databaseUrl,
        sourceDatabase,
        migrationRole,
        migrationPassword,
      );
      const runtimeUrl = databaseUrlFor(databaseUrl, sourceDatabase, runtimeRole, runtimePassword);
      migrationPool = new Pool(postgresPoolConfig(migrationUrl));
      runtimePoolOne = new Pool({ ...postgresPoolConfig(runtimeUrl), max: 1 });

      const migrationIdentity = await migrationPool.query<{
        session_user: string;
        owns_database: boolean;
        can_set_runtime_role: boolean;
      }>(
        `SELECT session_user,
                  pg_get_userbyid(database.datdba) = session_user AS owns_database,
                  pg_has_role(session_user, 'norns_app', 'SET') AS can_set_runtime_role
           FROM pg_database AS database
           WHERE database.datname = current_database()`,
      );
      expect(migrationIdentity.rows[0]).toEqual({
        session_user: migrationRole,
        owns_database: true,
        can_set_runtime_role: true,
      });

      await migrationPool.query(`
          CREATE TABLE norns_state (
            key TEXT PRIMARY KEY,
            snapshot JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
      const snapshots = legacySnapshots();
      await migrationPool.query(
        `INSERT INTO norns_state (key, snapshot, updated_at) VALUES
             ('users', $1::jsonb, '2026-07-15T19:00:00.000Z'),
             ('projects', $2::jsonb, '2026-07-15T19:00:01.000Z'),
             ('relay', $3::jsonb, '2026-07-15T19:00:02.000Z')`,
        [
          JSON.stringify(snapshots.users),
          JSON.stringify(snapshots.projects),
          JSON.stringify(snapshots.relay),
        ],
      );
      await expect(runCurrentV2Migrations(migrationDatabase(migrationPool))).resolves.toEqual([
        expect.objectContaining({ name: "0001_refoundation_v2", applied: true }),
        expect.objectContaining({ name: "0002_preservation_migration", applied: true }),
      ]);

      await adminPool.query(
        `CREATE DATABASE ${quoteIdentifier(bootstrapDatabase)} OWNER ${quoteIdentifier(migrationRole)} TEMPLATE template0`,
      );
      const bootstrapMigrationUrl = databaseUrlFor(
        databaseUrl,
        bootstrapDatabase,
        migrationRole,
        migrationPassword,
      );
      const bootstrapRuntimeUrl = databaseUrlFor(
        databaseUrl,
        bootstrapDatabase,
        runtimeRole,
        runtimePassword,
      );
      bootstrapMigrationPool = new Pool(postgresPoolConfig(bootstrapMigrationUrl));
      bootstrapRuntimePoolOne = new Pool({
        ...postgresPoolConfig(bootstrapRuntimeUrl),
        max: 1,
      });
      bootstrapRuntimePoolTwo = new Pool({
        ...postgresPoolConfig(bootstrapRuntimeUrl),
        max: 1,
      });
      await runCurrentV2Migrations(migrationDatabase(bootstrapMigrationPool));

      const bootstrapRunnerOne = new NodePgTransactionRunner(bootstrapRuntimePoolOne, {
        mode: "runtime",
        role: "norns_app",
      });
      const bootstrapRunnerTwo = new NodePgTransactionRunner(bootstrapRuntimePoolTwo, {
        mode: "runtime",
        role: "norns_app",
      });
      const backendOne = await bootstrapRuntimePoolOne.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const backendTwo = await bootstrapRuntimePoolTwo.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      expect(backendOne.rows[0]?.pid).not.toBe(backendTwo.rows[0]?.pid);

      const bootstrapOne = new RelationalIdentityService({
        transactions: bootstrapRunnerOne,
        credentialKey: CREDENTIAL_KEY,
        newId: () => "bootstrap-admin-one",
      });
      const bootstrapTwo = new RelationalIdentityService({
        transactions: bootstrapRunnerTwo,
        credentialKey: CREDENTIAL_KEY,
        newId: () => "bootstrap-admin-two",
      });
      const bootstrap = await Promise.allSettled([
        bootstrapOne.bootstrapAdmin({
          email: "bootstrap.one@example.com",
          password: "bootstrap-one-password",
        }),
        bootstrapTwo.bootstrapAdmin({
          email: "bootstrap.two@example.com",
          password: "bootstrap-two-password",
        }),
      ]);
      expect(bootstrap.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejectedBootstrap = bootstrap.find((result) => result.status === "rejected");
      expect(
        rejectedBootstrap?.status === "rejected" ? rejectedBootstrap.reason : undefined,
      ).toBeInstanceOf(IdentityAlreadyBootstrappedError);
      expect(
        (
          await bootstrapMigrationPool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM users",
          )
        ).rows[0]?.count,
      ).toBe(1);
      await bootstrapRuntimePoolTwo.end();
      bootstrapRuntimePoolTwo = undefined;
      await bootstrapRuntimePoolOne.end();
      bootstrapRuntimePoolOne = undefined;
      await bootstrapMigrationPool.end();
      bootstrapMigrationPool = undefined;
      await adminPool.query(`DROP DATABASE ${quoteIdentifier(bootstrapDatabase)}`);

      const runtimeRunnerOne = new NodePgTransactionRunner(runtimePoolOne, {
        mode: "runtime",
        role: "norns_app",
      });

      const frozenRows = await migrationPool.query<{ key: string; source_text: string }>(
        "SELECT key, snapshot::text AS source_text FROM norns_state ORDER BY key",
      );
      const expectedRecovery = {
        exact_text_hashes: Object.fromEntries(
          frozenRows.rows.map((row) => [
            row.key,
            createHash("sha256").update(row.source_text, "utf8").digest("hex"),
          ]),
        ),
        semantic_hashes: Object.fromEntries(
          frozenRows.rows.map((row) => [row.key, canonicalSha256(JSON.parse(row.source_text))]),
        ),
      };

      const parsedMigrationUrl = new URL(migrationUrl);
      const dump = await runProcess("docker", [
        ...dockerPostgresArgs(parsedMigrationUrl, "pg_dump"),
        "--format=custom",
        "--no-owner",
        "--no-privileges",
      ]);
      expect(dump.stdout.byteLength).toBeGreaterThan(0);

      let nonce = 0;
      const migrationLease = await Phase2MigrationProcessLease.acquire(migrationPool);
      let migrationResult: Awaited<ReturnType<Phase2MigrationService["run"]>>;
      try {
        migrationResult = await new Phase2MigrationService(migrationLease).run({
          migration_run_id: `phase2-real-postgres-${suffix}`,
          backup_provider: "postgres-custom-dump",
          backup_reference: `phase2-real-postgres-dump-${suffix}`,
          application_version: "0.1.0",
          application_commit: "phase2-real-postgres-test-commit",
          retention_expires_at: "2027-07-16T00:00:00.000Z",
          archive_key: ARCHIVE_KEY,
          credential_key: CREDENTIAL_KEY,
          random_bytes: (size) => Buffer.alloc(size, ++nonce),
        });
      } finally {
        await migrationLease.release();
      }
      expect(migrationResult).toMatchObject({
        status: "shadowing",
        counts: { source_projects: 1, accounted_projects: 1 },
        identity: {
          counts: { users: 3, sessions: 1, invitations: 1, active_admins: 1 },
        },
      });

      const keyringEnvironment = {
        NORNS_CREDENTIAL_HMAC_KEY: Buffer.from(CREDENTIAL_KEY.key).toString("base64"),
        NORNS_CREDENTIAL_HMAC_KEY_ID: CREDENTIAL_KEY.keyId,
      };
      const keyring = parseCredentialHmacKeyring(keyringEnvironment);
      await expect(
        assertCredentialHmacKeyCoverage(runtimeRunnerOne, keyring),
      ).resolves.toBeUndefined();

      let randomCounter = 90;
      const identityOptions = {
        transactions: runtimeRunnerOne,
        credentialKey: CREDENTIAL_KEY,
        randomBytes: (size: number) => Buffer.alloc(size, ++randomCounter),
        newId: () => `phase2-native-user-${randomCounter}`,
      };
      const identity = new RelationalIdentityService(identityOptions);
      const currentLogin = await identity.login(" current.admin@example.com ", CURRENT_PASSWORD);
      const legacyLogin = await identity.login("legacy.member@example.com", LEGACY_PASSWORD);
      expect(currentLogin.user.id).toBe("phase2-current-admin");
      expect(legacyLogin.user.id).toBe("phase2-legacy-member");
      const upgraded = await migrationPool.query<{ password_hash_scheme: string }>(
        "SELECT password_hash_scheme FROM users WHERE id = 'phase2-legacy-member'",
      );
      expect(upgraded.rows[0]?.password_hash_scheme).toBe("scrypt-v1");

      runtimeRestartPool = new Pool({ ...postgresPoolConfig(runtimeUrl), max: 1 });
      const restartedIdentity = new RelationalIdentityService({
        ...identityOptions,
        transactions: new NodePgTransactionRunner(runtimeRestartPool, {
          mode: "runtime",
          role: "norns_app",
        }),
      });
      await expect(restartedIdentity.userForToken(currentLogin.token)).resolves.toMatchObject({
        id: "phase2-current-admin",
      });
      await expect(restartedIdentity.userForToken(legacyLogin.token)).resolves.toMatchObject({
        id: "phase2-legacy-member",
      });
      await expect(restartedIdentity.userForToken(LEGACY_SESSION_TOKEN)).resolves.toBeUndefined();
      await expect(
        restartedIdentity.acceptInvite(LEGACY_INVITE_TOKEN, "must-not-work"),
      ).rejects.toThrow();
      await expect(
        assertCredentialHmacKeyCoverage(runtimeRunnerOne, keyring),
      ).resolves.toBeUndefined();

      await identity.logout(currentLogin.token);
      const revokedSession = await migrationPool.query<{ id: string }>(
        `SELECT id FROM sessions
           WHERE user_id = 'phase2-current-admin' AND status = 'revoked' AND source = 'native'`,
      );
      await expectPostgresError(
        runtimeRunnerOne.transaction((sql) =>
          sql.query("UPDATE sessions SET status = 'active', revoked_at = NULL WHERE id = $1", [
            revokedSession.rows[0]?.id,
          ]),
        ),
        /terminal state cannot be resurrected/,
      );
      await expectPostgresError(
        runtimeRunnerOne.transaction((sql) =>
          sql.query(
            `UPDATE sessions SET token_hash = $1
               WHERE user_id = 'phase2-legacy-member' AND status = 'active'`,
            ["f".repeat(64)],
          ),
        ),
        /credential identity and verifier are immutable/,
      );

      const invited = await identity.createInvite({
        email: "phase2.native.invite@example.com",
        role: "member",
      });
      await identity.acceptInvite(invited.inviteToken, "accepted-password");
      await expectPostgresError(
        runtimeRunnerOne.transaction((sql) =>
          sql.query(
            `UPDATE invitations
               SET status = 'pending', accepted_at = NULL
               WHERE user_id = $1`,
            [invited.summary.id],
          ),
        ),
        /terminal state cannot be resurrected/,
      );

      // This is the exact pool construction and startup boundary used by
      // main.ts. Direct pool reads inherit norns_app; application commands
      // still SET LOCAL ROLE norns_app through NodePgTransactionRunner.
      await expect(assertRestrictedRuntimeDatabase(runtimePoolOne, {})).resolves.toBeUndefined();
      const ordinaryPosture = await runtimePoolOne.query<{
        session_user: string;
        current_user: string;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT session_user, current_user, role.rolsuper, role.rolcreatedb,
                  role.rolcreaterole, role.rolreplication, role.rolbypassrls
           FROM pg_roles AS role WHERE role.rolname = session_user`,
      );
      expect(ordinaryPosture.rows[0]).toEqual({
        session_user: runtimeRole,
        current_user: runtimeRole,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      });
      expect(
        (await runtimePoolOne.query("SELECT key FROM norns_state ORDER BY key")).rows,
      ).toHaveLength(3);
      expect(
        (
          await runtimePoolOne.query(
            "UPDATE norns_state SET updated_at = updated_at WHERE key = 'relay' RETURNING key",
          )
        ).rows[0],
      ).toEqual({ key: "relay" });
      await expectPostgresError(
        runtimePoolOne.query("SELECT ciphertext FROM legacy_snapshot_archives LIMIT 0"),
        /permission denied/,
      );
      await expectPostgresError(
        runtimePoolOne.query(
          "UPDATE persistence_routes SET aggregate_version = aggregate_version WHERE false",
        ),
        /permission denied/,
      );
      await expectPostgresError(
        runtimePoolOne.query(
          "ALTER TABLE sessions DISABLE TRIGGER sessions_credential_update_guard",
        ),
        /must be owner|permission denied/,
      );
      await expectPostgresError(
        runtimePoolOne.query(`SET ROLE ${quoteIdentifier(migrationRole)}`),
        /permission denied/,
      );

      await adminPool.query(
        `CREATE DATABASE ${quoteIdentifier(restoreDatabase)} OWNER ${quoteIdentifier(migrationRole)} TEMPLATE template0`,
      );
      const restoredUrl = databaseUrlFor(
        databaseUrl,
        restoreDatabase,
        migrationRole,
        migrationPassword,
      );
      const parsedRestoredUrl = new URL(restoredUrl);
      await runProcess(
        "docker",
        [
          ...dockerPostgresArgs(parsedRestoredUrl, "pg_restore"),
          "--exit-on-error",
          "--no-owner",
          "--no-privileges",
        ],
        dump.stdout,
      );
      restoredPool = new Pool(postgresPoolConfig(restoredUrl));
      const restoredVerification = await verifyRestoredLegacySources(
        restoredPool,
        expectedRecovery,
        {
          migration_run_id: migrationResult.migration_run_id,
          live_database_identity: await readPostgresDatabaseIdentity(migrationPool),
        },
      );
      expect(restoredVerification).toMatchObject({
        source_keys: ["projects", "relay", "users"],
        checked_migration_run_id: migrationResult.migration_run_id,
        migration_run_absent: true,
        verified: true,
      });

      const recoveryLease = await Phase2MigrationProcessLease.acquire(migrationPool);
      let recordedRecovery: Awaited<ReturnType<SqlPhase2RecoveryVerificationRepository["record"]>>;
      try {
        recordedRecovery = await new SqlPhase2RecoveryVerificationRepository(recoveryLease).record(
          migrationResult.migration_run_id,
          restoredVerification,
          ARCHIVE_KEY,
        );
      } finally {
        await recoveryLease.release();
      }
      expect(recordedRecovery).toMatchObject({
        migration_run_id: migrationResult.migration_run_id,
        archive_count: 3,
        replayed: false,
      });
      expect(recordedRecovery.verification_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(recordedRecovery.restore_database_proof_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(recordedRecovery.archive_cipher_proof_hash).toMatch(/^[a-f0-9]{64}$/);

      const durableRecovery = await migrationPool.query<{
        checkpoint_verified: boolean;
        verified_archives: number;
        recovery_step_status: string;
        archive_verification_events: number;
      }>(
        `SELECT
             (SELECT verified_at IS NOT NULL FROM recovery_checkpoints
              WHERE migration_run_id = $1) AS checkpoint_verified,
             (SELECT count(*)::int FROM legacy_snapshot_archives
              WHERE migration_run_id = $1 AND status = 'verified'
                AND verified_at IS NOT NULL) AS verified_archives,
             (SELECT status FROM migration_steps
              WHERE migration_run_id = $1
                AND step_key = 'recovery_restore_verification') AS recovery_step_status,
             (SELECT count(*)::int FROM legacy_archive_access_events
              WHERE correlation_id = $2 AND operation = 'verify'
                AND outcome = 'allowed') AS archive_verification_events`,
        [
          migrationResult.migration_run_id,
          `phase2-restore-verification:${migrationResult.migration_run_id}`,
        ],
      );
      expect(durableRecovery.rows[0]).toEqual({
        checkpoint_verified: true,
        verified_archives: 3,
        recovery_step_status: "succeeded",
        archive_verification_events: 3,
      });

      // FOLLOW-UP(PHASE2-FENCED-CUTOVER): once the independent cutover
      // implementation is frozen, continue this same database through the
      // exclusive-fence prerequisite checks and relational route write.
      // Until then this test deliberately stops at the recovery checkpoint.
    } finally {
      await restoredPool?.end();
      await bootstrapRuntimePoolTwo?.end();
      await bootstrapRuntimePoolOne?.end();
      await bootstrapMigrationPool?.end();
      await runtimeRestartPool?.end();
      await runtimePoolOne?.end();
      await migrationPool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(restoreDatabase)}`);
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(sourceDatabase)}`);
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(bootstrapDatabase)}`);
      await adminPool.query(
        `DROP ROLE IF EXISTS ${quoteIdentifier(runtimeRole)}, ${quoteIdentifier(migrationRole)}`,
      );
      await adminPool.end();
    }
  }, 180_000);
});
