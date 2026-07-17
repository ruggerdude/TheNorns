/**
 * Offline, forward-only Phase 2 identity cutover.
 *
 * Stop every application instance before invoking this command. It acquires
 * the exclusive application persistence fence, rechecks the live source and
 * every recovery/evidence prerequisite, writes the relational identity route
 * and audit record atomically, then exits. It deliberately does not start the
 * application; the operator restarts it with the restricted runtime login.
 */
import { Pool } from "pg";
import { Phase2MigrationProcessLease } from "./persistence/migration/migrationLock.js";
import { SqlPhase2PrivilegedControlRepository } from "./persistence/migration/privilegedControlRepository.js";
import { postgresPoolConfig } from "./persistence/postgresConnection.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`required Phase 2 cutover environment variable is missing: ${name}`);
  return value;
}

const pool = new Pool(postgresPoolConfig(requiredEnvironment("NORNS_MIGRATION_DATABASE_URL")));
let lease: Phase2MigrationProcessLease | undefined;

try {
  lease = await Phase2MigrationProcessLease.acquire(pool);
  const route = await new SqlPhase2PrivilegedControlRepository(lease).cutoverIdentity({
    migration_run_id: requiredEnvironment("NORNS_PHASE2_RUN_ID"),
    human_actor_id: requiredEnvironment("NORNS_PHASE2_HUMAN_ADMIN_ID"),
  });
  process.stdout.write(
    `${JSON.stringify({
      migration_run_id: route.migration_run_id,
      identity_route: {
        read_mode: route.read_mode,
        write_mode: route.write_mode,
        aggregate_version: route.aggregate_version,
        changed_at: route.changed_at,
      },
      operator_restart_required: true,
    })}\n`,
  );
} catch (error) {
  const name = error instanceof Error ? error.name : "Phase2IdentityCutoverError";
  const message = error instanceof Error ? error.message : "Phase 2 identity cutover failed";
  process.stderr.write(`${name}: ${message}\n`);
  process.exitCode = 1;
} finally {
  await lease?.release();
  await pool.end();
}
