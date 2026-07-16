import { createHash } from "node:crypto";
import { V2PersistenceRoute, type V2PersistenceRouteT } from "@norns/contracts";
import {
  type SanitizableLegacyUserSnapshot,
  hasReusableLegacyCredentials,
} from "../../users/legacyCredentialSanitizer.js";
import type { V2SqlExecutor } from "../v2/database.js";
import { PHASE2_REQUIRED_IDENTITY_CUTOVER_OPERATIONS } from "./cutoverEvidence.js";
import type { Phase2MigrationProcessLease } from "./migrationLock.js";
import { assertPhase2RouteTransition } from "./routePolicy.js";

interface MigrationRunRow {
  id: string;
  source_manifest_hash: string | null;
  status: string;
  details: Record<string, unknown>;
}

interface LegacySourceRow {
  source_text: string;
  updated_at: string | Date;
}

interface PersistenceRouteRow {
  scope_type: V2PersistenceRouteT["scope_type"];
  scope_key: string;
  read_mode: V2PersistenceRouteT["read_mode"];
  write_mode: V2PersistenceRouteT["write_mode"];
  migration_run_id: string | null;
  aggregate_version: number;
  changed_by_actor_type: V2PersistenceRouteT["changed_by"]["actor_type"];
  changed_by_actor_id: string | null;
  changed_at: string | Date;
  v2_writes_started_at: string | Date | null;
  rollback_window_until: string | Date | null;
}

interface RecoveryGateRow {
  checkpoint_verified_at: string | Date | null;
  checkpoint_manifest_hash: string;
  step_status: string | null;
  step_input_hash: string | null;
  step_output_hash: string | null;
  step_completed_at: string | Date | null;
}

export class Phase2CutoverAuthorizationError extends Error {
  constructor(
    readonly code:
      | "migration_not_found"
      | "migration_status_not_ready"
      | "recovery_not_verified"
      | "source_changed"
      | "identity_snapshot_not_sanitized"
      | "blocking_findings_open"
      | "human_admin_required"
      | "current_green_evidence_required"
      | "route_inconsistent",
    message: string,
  ) {
    super(message);
    this.name = "Phase2CutoverAuthorizationError";
  }
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function exactTextHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function routeFromRow(row: PersistenceRouteRow): V2PersistenceRouteT {
  return V2PersistenceRoute.parse({
    schema_version: 2,
    scope_type: row.scope_type,
    scope_key: row.scope_key,
    read_mode: row.read_mode,
    write_mode: row.write_mode,
    migration_run_id: row.migration_run_id,
    aggregate_version: Number(row.aggregate_version),
    changed_by: {
      actor_type: row.changed_by_actor_type,
      actor_id: row.changed_by_actor_id,
    },
    changed_at: iso(row.changed_at),
    v2_writes_started_at: row.v2_writes_started_at === null ? null : iso(row.v2_writes_started_at),
    rollback_window_until:
      row.rollback_window_until === null ? null : iso(row.rollback_window_until),
  });
}

async function lockIdentityRoute(sql: V2SqlExecutor): Promise<V2PersistenceRouteT | null> {
  const result = await sql.query<PersistenceRouteRow>(
    `SELECT scope_type, scope_key, read_mode, write_mode, migration_run_id,
            aggregate_version, changed_by_actor_type, changed_by_actor_id,
            changed_at, v2_writes_started_at, rollback_window_until
     FROM persistence_routes
     WHERE scope_type = 'identity' AND scope_key = '*'
     FOR UPDATE`,
  );
  return result.rows[0] ? routeFromRow(result.rows[0]) : null;
}

function expectedReplayHash(run: MigrationRunRow, sourceKey: string): string {
  const replayHashes = record(run.details.replay_source_exact_hashes);
  const expected = replayHashes[sourceKey];
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Phase2CutoverAuthorizationError(
      "source_changed",
      `migration manifest has no frozen replay hash for ${sourceKey}`,
    );
  }
  return expected;
}

function assertSanitizedUsersSnapshot(sourceText: string): void {
  let snapshot: SanitizableLegacyUserSnapshot;
  try {
    snapshot = JSON.parse(sourceText) as SanitizableLegacyUserSnapshot;
  } catch {
    throw new Phase2CutoverAuthorizationError(
      "identity_snapshot_not_sanitized",
      "final legacy users snapshot is not valid JSON",
    );
  }
  if (!Array.isArray(snapshot.users) || !Array.isArray(snapshot.sessions)) {
    throw new Phase2CutoverAuthorizationError(
      "identity_snapshot_not_sanitized",
      "final legacy users snapshot has an invalid credential shape",
    );
  }
  if (hasReusableLegacyCredentials(snapshot)) {
    throw new Phase2CutoverAuthorizationError(
      "identity_snapshot_not_sanitized",
      "final legacy users snapshot still contains reusable sessions or invitations",
    );
  }
}

async function assertActiveHumanAdmin(sql: V2SqlExecutor, actorId: string): Promise<void> {
  if (actorId.trim().length === 0) {
    throw new Phase2CutoverAuthorizationError(
      "human_admin_required",
      "identity cutover requires an explicit human administrator",
    );
  }
  const result = await sql.query<{ authorized: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM users
       WHERE id = $1 AND role = 'admin' AND status = 'active'
     ) AS authorized`,
    [actorId],
  );
  if (result.rows[0]?.authorized !== true) {
    throw new Phase2CutoverAuthorizationError(
      "human_admin_required",
      "identity cutover actor must be an active human administrator",
    );
  }
}

async function recoveryGate(
  sql: V2SqlExecutor,
  migrationRunId: string,
  manifestHash: string,
): Promise<string> {
  const result = await sql.query<RecoveryGateRow>(
    `SELECT checkpoint.verified_at AS checkpoint_verified_at,
            checkpoint.source_manifest_hash AS checkpoint_manifest_hash,
            step.status AS step_status,
            step.input_hash AS step_input_hash,
            step.output_hash AS step_output_hash,
            step.completed_at AS step_completed_at
     FROM recovery_checkpoints checkpoint
     LEFT JOIN migration_steps step
       ON step.migration_run_id = checkpoint.migration_run_id
      AND step.step_key = 'recovery_restore_verification'
     WHERE checkpoint.migration_run_id = $1
     FOR UPDATE OF checkpoint`,
    [migrationRunId],
  );
  const gate = result.rows[0];
  if (
    !gate ||
    gate.checkpoint_verified_at === null ||
    gate.checkpoint_manifest_hash !== manifestHash ||
    gate.step_status !== "succeeded" ||
    gate.step_input_hash !== manifestHash ||
    gate.step_output_hash === null ||
    gate.step_completed_at === null
  ) {
    throw new Phase2CutoverAuthorizationError(
      "recovery_not_verified",
      "identity cutover requires a verified recovery checkpoint and successful restore drill",
    );
  }
  return new Date(
    Math.max(Date.parse(iso(gate.checkpoint_verified_at)), Date.parse(iso(gate.step_completed_at))),
  ).toISOString();
}

async function assertNoOpenBlockingFindings(
  sql: V2SqlExecutor,
  migrationRunId: string,
): Promise<void> {
  const result = await sql.query<{ blocked: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM migration_reconciliation_findings
       WHERE migration_run_id = $1
         AND severity = 'blocking'
         AND status = 'open'
     ) AS blocked`,
    [migrationRunId],
  );
  if (result.rows[0]?.blocked === true) {
    throw new Phase2CutoverAuthorizationError(
      "blocking_findings_open",
      "identity cutover is blocked by open migration reconciliation findings",
    );
  }
}

async function assertCurrentGreenIdentityEvidence(
  sql: V2SqlExecutor,
  input: {
    migration_run_id: string;
    manifest_hash: string;
    source_exact_hash: string;
    source_updated_at: string;
    evidence_not_before: string;
  },
): Promise<void> {
  const result = await sql.query<{ operation: string; matched: boolean }>(
    `SELECT operation, matched
     FROM (
       SELECT operation, matched,
              row_number() OVER (
                PARTITION BY operation
                ORDER BY observed_at DESC, id DESC
              ) AS observation_rank
       FROM shadow_read_comparisons
       WHERE migration_run_id = $1
         AND scope_type = 'identity'
         AND scope_key = '*'
         AND source_manifest_hash = $2
         AND source_key = 'users'
         AND source_exact_hash = $3
         AND source_updated_at = $4
         AND observed_at >= $5
     ) observations
     WHERE observation_rank = 1`,
    [
      input.migration_run_id,
      input.manifest_hash,
      input.source_exact_hash,
      input.source_updated_at,
      input.evidence_not_before,
    ],
  );
  const latest = new Map(result.rows.map((row) => [row.operation, row.matched]));
  if (
    !PHASE2_REQUIRED_IDENTITY_CUTOVER_OPERATIONS.every(
      (operation) => latest.get(operation) === true,
    )
  ) {
    throw new Phase2CutoverAuthorizationError(
      "current_green_evidence_required",
      "identity cutover requires every named proof to be green for the current source revision",
    );
  }
}

async function writeIdentityRoute(
  sql: V2SqlExecutor,
  input: {
    current: V2PersistenceRouteT | null;
    migration_run_id: string;
    human_actor_id: string;
    changed_at: string;
  },
): Promise<V2PersistenceRouteT> {
  if (
    input.current !== null &&
    input.current.migration_run_id !== null &&
    input.current.migration_run_id !== input.migration_run_id
  ) {
    throw new Phase2CutoverAuthorizationError(
      "route_inconsistent",
      "identity route belongs to a different migration run",
    );
  }
  const next = V2PersistenceRoute.parse({
    schema_version: 2,
    scope_type: "identity",
    scope_key: "*",
    read_mode: "relational",
    write_mode: "relational",
    migration_run_id: input.migration_run_id,
    aggregate_version: (input.current?.aggregate_version ?? 0) + 1,
    changed_by: { actor_type: "human", actor_id: input.human_actor_id },
    changed_at: input.changed_at,
    v2_writes_started_at: input.current?.v2_writes_started_at ?? input.changed_at,
    rollback_window_until: null,
  });
  assertPhase2RouteTransition({ current: input.current, next, green_shadow_evidence: true });

  if (input.current === null) {
    await sql.query(
      `INSERT INTO persistence_routes (
         scope_type, scope_key, read_mode, write_mode, migration_run_id,
         aggregate_version, changed_by_actor_type, changed_by_actor_id,
         changed_at, v2_writes_started_at, rollback_window_until
       ) VALUES ('identity','*','relational','relational',$1,1,'human',$2,$3,$3,NULL)`,
      [input.migration_run_id, input.human_actor_id, input.changed_at],
    );
  } else {
    const updated = await sql.query(
      `UPDATE persistence_routes
       SET read_mode = 'relational', write_mode = 'relational',
           migration_run_id = $1, aggregate_version = $2,
           changed_by_actor_type = 'human', changed_by_actor_id = $3,
           changed_at = $4,
           v2_writes_started_at = COALESCE(v2_writes_started_at, $4),
           rollback_window_until = NULL
       WHERE scope_type = 'identity' AND scope_key = '*'
         AND aggregate_version = $5
       RETURNING scope_type`,
      [
        next.migration_run_id,
        next.aggregate_version,
        input.human_actor_id,
        input.changed_at,
        input.current.aggregate_version,
      ],
    );
    if ((updated.affectedRows ?? updated.rows.length) !== 1) {
      throw new Error("identity persistence route changed concurrently");
    }
  }
  return next;
}

async function writeCutoverAudit(
  sql: V2SqlExecutor,
  route: V2PersistenceRouteT,
  previous: V2PersistenceRouteT | null,
): Promise<void> {
  await sql.query(
    `INSERT INTO audit_events (
       audit_id, audit_type, project_id, phase_id, task_id,
       actor_type, actor_id, outcome, severity, correlation_id,
       causation_id, occurred_at, targets, summary, details,
       redaction_applied
     ) VALUES (
       $1,'persistence.identity_cutover',NULL,NULL,NULL,
       'human',$2,'succeeded','warning',$3,
       NULL,$4,$5::jsonb,$6,$7::jsonb,true
     )`,
    [
      `audit:persistence-route:identity:all:v${route.aggregate_version}`,
      route.changed_by.actor_id,
      "persistence-route:identity:*",
      route.changed_at,
      JSON.stringify([
        { entity_type: "persistence_route", entity_id: "identity:*" },
        { entity_type: "migration_run", entity_id: route.migration_run_id },
      ]),
      "Identity persistence cut over to normalized relational storage",
      JSON.stringify({
        previous_read_mode: previous?.read_mode ?? null,
        previous_write_mode: previous?.write_mode ?? null,
        read_mode: route.read_mode,
        write_mode: route.write_mode,
        migration_run_id: route.migration_run_id,
        aggregate_version: route.aggregate_version,
        operator_restart_required: true,
      }),
    ],
  );
}

/**
 * Offline, forward-only cutover authority.
 *
 * The concrete lease type is intentional: ordinary runtime transaction
 * runners cannot construct this repository. The lease holds the exclusive
 * application persistence fence for the entire transaction and until the CLI
 * exits, so no legacy snapshot writer can race the final source check.
 */
export class SqlPhase2PrivilegedControlRepository {
  constructor(private readonly lease: Phase2MigrationProcessLease) {}

  async cutoverIdentity(input: {
    migration_run_id: string;
    human_actor_id: string;
  }): Promise<V2PersistenceRouteT> {
    return this.lease.transaction(async (sql) => {
      const runResult = await sql.query<MigrationRunRow>(
        `SELECT id, source_manifest_hash, status, details
         FROM migration_runs
         WHERE id = $1
         FOR UPDATE`,
        [input.migration_run_id],
      );
      const run = runResult.rows[0];
      if (!run || run.source_manifest_hash === null) {
        throw new Phase2CutoverAuthorizationError(
          "migration_not_found",
          "identity cutover migration run was not found or has no manifest",
        );
      }

      const currentRoute = await lockIdentityRoute(sql);
      if (run.status === "cutover") {
        if (
          currentRoute?.migration_run_id === run.id &&
          currentRoute.read_mode === "relational" &&
          currentRoute.write_mode === "relational"
        ) {
          return currentRoute;
        }
        throw new Phase2CutoverAuthorizationError(
          "route_inconsistent",
          "cutover migration status has no matching relational identity route",
        );
      }
      if (run.status !== "shadowing" && run.status !== "ready") {
        throw new Phase2CutoverAuthorizationError(
          "migration_status_not_ready",
          `identity cutover requires a shadowing or ready run, not ${run.status}`,
        );
      }
      if (
        currentRoute !== null &&
        (currentRoute.read_mode === "relational" ||
          currentRoute.write_mode === "relational" ||
          currentRoute.v2_writes_started_at !== null)
      ) {
        throw new Phase2CutoverAuthorizationError(
          "route_inconsistent",
          "identity route entered relational operation before the fenced cutover gate",
        );
      }

      await assertActiveHumanAdmin(sql, input.human_actor_id);
      const evidenceNotBefore = await recoveryGate(sql, run.id, run.source_manifest_hash);
      await assertNoOpenBlockingFindings(sql, run.id);

      const sourceResult = await sql.query<LegacySourceRow>(
        `SELECT snapshot::text AS source_text, updated_at
         FROM norns_state
         WHERE key = 'users'
         FOR UPDATE`,
      );
      const source = sourceResult.rows[0];
      const expectedHash = expectedReplayHash(run, "users");
      if (
        !source ||
        exactTextHash(source.source_text) !== expectedHash ||
        run.details.sanitized_users_exact_hash !== expectedHash
      ) {
        throw new Phase2CutoverAuthorizationError(
          "source_changed",
          "legacy users snapshot changed after the migration manifest was frozen",
        );
      }
      assertSanitizedUsersSnapshot(source.source_text);
      await assertCurrentGreenIdentityEvidence(sql, {
        migration_run_id: run.id,
        manifest_hash: run.source_manifest_hash,
        source_exact_hash: expectedHash,
        source_updated_at: iso(source.updated_at),
        evidence_not_before: evidenceNotBefore,
      });

      if (run.status === "shadowing") {
        const ready = await sql.query(
          `UPDATE migration_runs
           SET status = 'ready'
           WHERE id = $1 AND status = 'shadowing'
           RETURNING id`,
          [run.id],
        );
        if ((ready.affectedRows ?? ready.rows.length) !== 1) {
          throw new Error("migration run changed concurrently before cutover readiness");
        }
      }

      const clock = await sql.query<{ changed_at: string | Date }>(
        "SELECT transaction_timestamp() AS changed_at",
      );
      const changedAtValue = clock.rows[0]?.changed_at;
      if (!changedAtValue) throw new Error("database did not provide the cutover timestamp");
      const changedAt = iso(changedAtValue);
      const route = await writeIdentityRoute(sql, {
        current: currentRoute,
        migration_run_id: run.id,
        human_actor_id: input.human_actor_id,
        changed_at: changedAt,
      });
      await writeCutoverAudit(sql, route, currentRoute);

      const cutover = await sql.query(
        `UPDATE migration_runs
         SET status = 'cutover', completed_at = $2,
             v2_writes_started_at = COALESCE(v2_writes_started_at, $2)
         WHERE id = $1 AND status = 'ready'
         RETURNING id`,
        [run.id, changedAt],
      );
      if ((cutover.affectedRows ?? cutover.rows.length) !== 1) {
        throw new Error("migration run did not enter cutover atomically with identity routing");
      }
      return route;
    });
  }
}
