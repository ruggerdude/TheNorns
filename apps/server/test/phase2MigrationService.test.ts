import { scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  Phase2IdentityCheckpointCoordinator,
  type RunPhase2IdentityCheckpointInput,
} from "../src/persistence/migration/phase2Coordinator.js";
import {
  Phase2MigrationService,
  type RunPhase2MigrationInput,
} from "../src/persistence/migration/phase2MigrationService.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const ARCHIVE_KEY = {
  keyId: "phase2-service-archive-key",
  key: Buffer.alloc(32, 31),
};
const WRONG_ARCHIVE_KEY = {
  keyId: "phase2-service-wrong-key",
  key: Buffer.alloc(32, 32),
};
const CREDENTIAL_KEY = {
  keyId: "phase2-service-credential-key",
  key: Buffer.alloc(32, 33),
};
const RUN_ID = "migration-phase2-service";

function fixture(name: "clean-planned" | "graph-only-node"): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/phase2/projects/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function legacyPasswordHash(password: string): string {
  const salt = Buffer.alloc(16, 34);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function usersSnapshot(): Record<string, unknown> {
  return {
    users: [
      {
        id: "user-phase2-admin",
        email: "phase2-admin@example.com",
        name: "Phase 2 Admin",
        role: "admin",
        status: "active",
        passwordHash: legacyPasswordHash("phase2-admin-password"),
        inviteToken: null,
        createdAt: "2026-07-15T17:00:00.000Z",
      },
    ],
    sessions: [],
  };
}

function relaySnapshot(): Record<string, unknown> {
  return {
    runners: {},
    commands: {},
    eventsByRunner: {},
    watermark: {},
    audit: [],
    pairings: {},
    killSwitch: false,
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
       ('relay', $3::jsonb, '2026-07-15T19:00:02.000Z')`,
    [
      JSON.stringify(usersSnapshot()),
      JSON.stringify({ projects: [fixture("clean-planned"), fixture("graph-only-node")] }),
      JSON.stringify(relaySnapshot()),
    ],
  );
  await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
  return pg;
}

function runInput(overrides: Partial<RunPhase2MigrationInput> = {}): RunPhase2MigrationInput {
  let nonce = 0;
  return {
    migration_run_id: RUN_ID,
    backup_provider: "railway",
    backup_reference: "railway-backup-phase2-service",
    application_version: "0.1.0",
    application_commit: "phase2-service-test-commit",
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

function runner(pg: PGlite): PGliteTransactionRunner {
  return new PGliteTransactionRunner(pg);
}

describe.sequential("Phase 2 resumable preservation service", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(
      databases.splice(0).map(async (database) => {
        if (!database.closed) await database.close();
      }),
    );
  });

  it("resumes a failed per-project import and enters only shadowing when all projects are accounted", async () => {
    const pg = await setup();
    databases.push(pg);
    const transactions = runner(pg);
    const service = new Phase2MigrationService(transactions);
    let injected = false;

    await expect(
      service.run(
        runInput({
          after_project_step: (projectId, step) => {
            if (!injected && projectId === "proj-graph-only" && step === "tasks") {
              injected = true;
              throw new Error("injected second-project failure");
            }
          },
        }),
      ),
    ).rejects.toThrow("injected second-project failure");

    const afterFailure = await pg.query<{
      run_status: string;
      users: number;
      imported_projects: number;
      project_rows: number;
      clean_step_status: string;
      clean_attempt: number;
      failed_step_status: string;
      failed_attempt: number;
    }>(
      `SELECT
         (SELECT status FROM migration_runs WHERE id = $1) AS run_status,
         (SELECT count(*)::int FROM users WHERE source = 'legacy_snapshot') AS users,
         (SELECT count(*)::int FROM legacy_project_imports
          WHERE migration_run_id = $1) AS imported_projects,
         (SELECT count(*)::int FROM projects) AS project_rows,
         (SELECT status FROM migration_steps
          WHERE migration_run_id = $1 AND step_key = 'project_import:proj-clean') AS clean_step_status,
         (SELECT attempt FROM migration_steps
          WHERE migration_run_id = $1 AND step_key = 'project_import:proj-clean') AS clean_attempt,
         (SELECT status FROM migration_steps
          WHERE migration_run_id = $1
            AND step_key = 'project_import:proj-graph-only') AS failed_step_status,
         (SELECT attempt FROM migration_steps
          WHERE migration_run_id = $1
            AND step_key = 'project_import:proj-graph-only') AS failed_attempt`,
      [RUN_ID],
    );
    expect(afterFailure.rows[0]).toEqual({
      run_status: "importing",
      users: 1,
      imported_projects: 1,
      project_rows: 1,
      clean_step_status: "succeeded",
      clean_attempt: 1,
      failed_step_status: "failed",
      failed_attempt: 1,
    });

    const result = await service.run(runInput());
    expect(result.status).toBe("shadowing");
    expect(result.identity.replayed).toBe(true);
    expect(result.counts).toMatchObject({
      source_projects: 2,
      accounted_projects: 2,
      imported_projects: 1,
      replayed_projects: 1,
      tasks: 3,
      dependencies: 1,
      assignments: 3,
    });
    expect(result.counts.findings).toBeGreaterThan(0);
    expect(result.findings.every((finding) => finding.project_id.length > 0)).toBe(true);

    const completedReplay = await service.run(runInput());
    expect(completedReplay).toMatchObject({
      status: "shadowing",
      identity: { replayed: true },
      counts: {
        source_projects: 2,
        accounted_projects: 2,
        imported_projects: 0,
        replayed_projects: 2,
      },
    });

    const accounted = await pg.query<{
      run_status: string;
      completed_at: Date | null;
      users: number;
      project_rows: number;
      ledgers: number;
      identity_steps: number;
      project_steps: number;
      failed_attempt: number;
      read_accesses: number;
      verification_accesses: number;
      relay_snapshot: Record<string, unknown>;
    }>(
      `SELECT
         (SELECT status FROM migration_runs WHERE id = $1) AS run_status,
         (SELECT completed_at FROM migration_runs WHERE id = $1) AS completed_at,
         (SELECT count(*)::int FROM users WHERE source = 'legacy_snapshot') AS users,
         (SELECT count(*)::int FROM projects) AS project_rows,
         (SELECT count(*)::int FROM legacy_project_imports
          WHERE migration_run_id = $1) AS ledgers,
         (SELECT count(*)::int FROM migration_steps
          WHERE migration_run_id = $1 AND step_key = 'identity_import'
            AND status = 'succeeded') AS identity_steps,
         (SELECT count(*)::int FROM migration_steps
          WHERE migration_run_id = $1 AND step_key LIKE 'project_import:%'
            AND status = 'succeeded') AS project_steps,
         (SELECT attempt FROM migration_steps
          WHERE migration_run_id = $1
            AND step_key = 'project_import:proj-graph-only') AS failed_attempt,
         (SELECT count(*)::int FROM legacy_archive_access_events
          WHERE archive_id = 'legacy_archive:migration-phase2-service:projects'
            AND operation = 'read') AS read_accesses,
         (SELECT count(*)::int FROM legacy_archive_access_events
          WHERE archive_id = 'legacy_archive:migration-phase2-service:projects'
            AND operation = 'verify' AND outcome = 'allowed') AS verification_accesses,
         (SELECT snapshot FROM norns_state WHERE key = 'relay') AS relay_snapshot`,
      [RUN_ID],
    );
    expect(accounted.rows[0]).toEqual({
      run_status: "shadowing",
      completed_at: null,
      users: 1,
      project_rows: 2,
      ledgers: 2,
      identity_steps: 1,
      project_steps: 2,
      failed_attempt: 2,
      read_accesses: 3,
      verification_accesses: 3,
      relay_snapshot: relaySnapshot(),
    });

    const ledgerIds = await pg.query<{ project_id: string }>(
      `SELECT project_id FROM legacy_project_imports
       WHERE migration_run_id = $1 ORDER BY project_id`,
      [RUN_ID],
    );
    expect(ledgerIds.rows.map((row) => row.project_id)).toEqual(["proj-clean", "proj-graph-only"]);
  }, 30_000);

  it("refuses a wrong projects archive encryption key after logging the read intent", async () => {
    const pg = await setup();
    databases.push(pg);
    const transactions = runner(pg);
    const identityInput = runInput();
    await new Phase2IdentityCheckpointCoordinator(transactions).run(
      identityInput as RunPhase2IdentityCheckpointInput,
    );

    await expect(
      new Phase2MigrationService(transactions).run(runInput({ archive_key: WRONG_ARCHIVE_KEY })),
    ).rejects.toThrow(/encryption metadata does not match the key/);

    const state = await pg.query<{
      status: string;
      projects: number;
      imports: number;
      reads: number;
      failed_verifications: number;
    }>(
      `SELECT
         (SELECT status FROM migration_runs WHERE id = $1) AS status,
         (SELECT count(*)::int FROM projects) AS projects,
         (SELECT count(*)::int FROM legacy_project_imports) AS imports,
         (SELECT count(*)::int FROM legacy_archive_access_events
          WHERE archive_id = 'legacy_archive:migration-phase2-service:projects'
            AND operation = 'read') AS reads,
         (SELECT count(*)::int FROM legacy_archive_access_events
          WHERE archive_id = 'legacy_archive:migration-phase2-service:projects'
            AND operation = 'verify' AND outcome = 'failed') AS failed_verifications`,
      [RUN_ID],
    );
    expect(state.rows[0]).toEqual({
      status: "importing",
      projects: 0,
      imports: 0,
      reads: 1,
      failed_verifications: 1,
    });
    const verification = await pg.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM legacy_archive_access_events
       WHERE archive_id = 'legacy_archive:migration-phase2-service:projects'
         AND operation = 'verify' AND outcome = 'failed'`,
    );
    expect(verification.rows[0]?.details).toEqual({
      purpose: "migration_reconciliation",
      session_present: false,
      reason_code: "archive_crypto_verification_failed",
      verification: "authenticated_archive_and_hashes",
    });
    expect(JSON.stringify(verification.rows[0]?.details)).not.toContain(WRONG_ARCHIVE_KEY.keyId);
  }, 30_000);

  it("refuses database mutation of encrypted archive payload", async () => {
    const pg = await setup();
    databases.push(pg);
    const transactions = runner(pg);
    await new Phase2IdentityCheckpointCoordinator(transactions).run(runInput());
    await expect(
      pg.query(
        `UPDATE legacy_snapshot_archives
         SET ciphertext = decode('ff', 'hex')
         WHERE id = 'legacy_archive:migration-phase2-service:projects'`,
      ),
    ).rejects.toThrow(/payload and identity are immutable/);
    const state = await pg.query<{
      status: string;
      projects: number;
      imports: number;
    }>(
      `SELECT
         (SELECT status FROM migration_runs WHERE id = $1) AS status,
         (SELECT count(*)::int FROM projects) AS projects,
         (SELECT count(*)::int FROM legacy_project_imports) AS imports`,
      [RUN_ID],
    );
    expect(state.rows[0]).toEqual({ status: "importing", projects: 0, imports: 0 });
  }, 30_000);

  it("refuses exact or semantic checkpoint hash drift before importing projects", async () => {
    const pg = await setup();
    databases.push(pg);
    const transactions = runner(pg);
    await new Phase2IdentityCheckpointCoordinator(transactions).run(runInput());
    const original = await pg.query<{
      details: Record<string, unknown>;
      source_snapshot_hashes: Record<string, unknown>;
    }>(
      `SELECT details, source_snapshot_hashes
       FROM migration_runs WHERE id = $1`,
      [RUN_ID],
    );
    const originalRow = original.rows[0];
    if (!originalRow) throw new Error("expected Phase 2 migration run");

    const exactDetails = structuredClone(originalRow.details) as {
      source_exact_text_hashes: Record<string, unknown>;
    };
    exactDetails.source_exact_text_hashes.projects = "e".repeat(64);
    await pg.query("UPDATE migration_runs SET details = $2::jsonb WHERE id = $1", [
      RUN_ID,
      JSON.stringify(exactDetails),
    ]);
    await expect(new Phase2MigrationService(transactions).run(runInput())).rejects.toThrow(
      /archive hashes do not match the recovery checkpoint/,
    );

    const semanticDetails = structuredClone(originalRow.details) as {
      source_semantic_hashes: Record<string, unknown>;
    };
    const semanticHashes = structuredClone(originalRow.source_snapshot_hashes);
    semanticDetails.source_semantic_hashes.projects = "d".repeat(64);
    semanticHashes.projects = "d".repeat(64);
    await pg.query(
      `UPDATE migration_runs
       SET details = $2::jsonb, source_snapshot_hashes = $3::jsonb
       WHERE id = $1`,
      [RUN_ID, JSON.stringify(semanticDetails), JSON.stringify(semanticHashes)],
    );
    await expect(new Phase2MigrationService(transactions).run(runInput())).rejects.toThrow(
      /archive hashes do not match the recovery checkpoint/,
    );

    const rows = await pg.query<{
      projects: number;
      imports: number;
      reads: number;
      failed_verifications: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM projects) AS projects,
         (SELECT count(*)::int FROM legacy_project_imports) AS imports,
         (SELECT count(*)::int FROM legacy_archive_access_events
          WHERE archive_id = 'legacy_archive:migration-phase2-service:projects'
            AND operation = 'read') AS reads,
         (SELECT count(*)::int FROM legacy_archive_access_events
          WHERE archive_id = 'legacy_archive:migration-phase2-service:projects'
            AND operation = 'verify' AND outcome = 'failed') AS failed_verifications`,
    );
    expect(rows.rows[0]).toEqual({
      projects: 0,
      imports: 0,
      reads: 2,
      failed_verifications: 2,
    });
  }, 30_000);
});
