import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import {
  readPostgresDatabaseIdentity,
  verifyRestoredLegacySources,
} from "../src/persistence/migration/restoreVerification.js";

const databaseUrl = process.env.V2_POSTGRES_TEST_URL;
const enabled = databaseUrl !== undefined && process.env.PHASE2_DOCKER_BACKUP_TEST === "1";
const postgresDescribe = enabled ? describe.sequential : describe.skip;

interface ProcessResult {
  stdout: Buffer;
  stderr: string;
}

function runProcess(executable: string, args: string[], input?: Buffer): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
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

function dockerPostgresArgs(
  parsed: URL,
  database: string,
  command: "pg_dump" | "pg_restore",
): string[] {
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
    database,
  ];
}

postgresDescribe("Phase 2 real PostgreSQL backup and restore evidence", () => {
  it("restores a pg_dump checkpoint into a separate database and matches every frozen hash", async () => {
    if (!databaseUrl) throw new Error("V2_POSTGRES_TEST_URL is required");
    const parsed = new URL(databaseUrl);
    const sourceDatabase = decodeURIComponent(parsed.pathname.slice(1));
    const suffix = `${process.pid}_${Date.now()}`;
    const schema = `phase2_backup_${suffix}`;
    const restoreDatabase = `phase2_restore_${suffix}`;
    const sourcePool = new Pool({ connectionString: databaseUrl });
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = "/postgres";
    const adminPool = new Pool({ connectionString: adminUrl.toString() });
    let restoredPool: Pool | undefined;
    try {
      await sourcePool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await sourcePool.query(`
        CREATE TABLE ${quoteIdentifier(schema)}.norns_state (
          key TEXT PRIMARY KEY,
          snapshot JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      await sourcePool.query(
        `INSERT INTO ${quoteIdentifier(schema)}.norns_state
           (key, snapshot, updated_at)
         VALUES
           ('projects', $1::jsonb, '2026-07-16T21:00:00.000Z'),
           ('relay', $2::jsonb, '2026-07-16T21:00:01.000Z'),
           ('users', $3::jsonb, '2026-07-16T21:00:02.000Z')`,
        [
          JSON.stringify({ projects: [{ id: "project-backup-proof" }] }),
          JSON.stringify({ audit: [{ action: "checkpoint" }], commands: {} }),
          JSON.stringify({ sessions: [], users: [{ id: "user-backup-proof" }] }),
        ],
      );
      const frozen = await sourcePool.query<{ key: string; source_text: string }>(
        `SELECT key, snapshot::text AS source_text
         FROM ${quoteIdentifier(schema)}.norns_state
         ORDER BY key`,
      );
      const expected = {
        exact_text_hashes: Object.fromEntries(
          frozen.rows.map((row) => [
            row.key,
            createHash("sha256").update(row.source_text, "utf8").digest("hex"),
          ]),
        ),
        semantic_hashes: Object.fromEntries(
          frozen.rows.map((row) => [row.key, canonicalSha256(JSON.parse(row.source_text))]),
        ),
      };

      const dump = await runProcess("docker", [
        ...dockerPostgresArgs(parsed, sourceDatabase, "pg_dump"),
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--schema",
        schema,
      ]);
      expect(dump.stdout.byteLength).toBeGreaterThan(0);

      await adminPool.query(`CREATE DATABASE ${quoteIdentifier(restoreDatabase)}`);
      await runProcess(
        "docker",
        [
          ...dockerPostgresArgs(parsed, restoreDatabase, "pg_restore"),
          "--exit-on-error",
          "--no-owner",
          "--no-privileges",
        ],
        dump.stdout,
      );

      const restoredUrl = new URL(databaseUrl);
      restoredUrl.pathname = `/${restoreDatabase}`;
      restoredPool = new Pool({
        connectionString: restoredUrl.toString(),
        options: `-c search_path=${schema}`,
      });
      await expect(
        verifyRestoredLegacySources(restoredPool, expected, {
          migration_run_id: `phase2-recovery-proof-${suffix}`,
          live_database_identity: await readPostgresDatabaseIdentity(sourcePool),
        }),
      ).resolves.toMatchObject({
        source_keys: ["projects", "relay", "users"],
        migration_run_absent: true,
        verified: true,
      });
    } finally {
      await restoredPool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(restoreDatabase)}`);
      await sourcePool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await sourcePool.end();
      await adminPool.end();
    }
  }, 120_000);
});
