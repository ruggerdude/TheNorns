import type { V2SqlExecutor } from "../v2/database.js";
import { canonicalSha256 } from "./canonicalJson.js";
import type { Phase2MigrationProcessLease } from "./migrationLock.js";

const ROLLBACK_EVIDENCE_TTL_MS = 5 * 60 * 1_000;
const ELIGIBLE_RUN_STATUSES = new Set(["shadowing", "ready", "cutover"]);

type RollbackScopeType = "project" | "new_projects";
type RouteWriteMode = "legacy" | "frozen";

interface MigrationRunRow {
  id: string;
  status: string;
  source_frozen_at: string | Date | null;
  rollback_window_until: string | Date | null;
  last_source_records: Record<string, unknown>;
  details: Record<string, unknown>;
}

interface PersistenceRouteRow {
  scope_type: "identity" | RollbackScopeType | "relay";
  scope_key: string;
  read_mode: "legacy" | "shadow" | "relational";
  write_mode: "legacy" | "frozen" | "relational";
  migration_run_id: string | null;
  aggregate_version: number;
  changed_at: string | Date;
  v2_writes_started_at: string | Date | null;
  rollback_window_until: string | Date | null;
}

interface EvidenceRow {
  id: string;
  migration_run_id: string;
  state_fingerprint: string;
  report_fingerprint: string;
  observed_at: string | Date;
  valid_until: string | Date;
  report: Phase2RollbackEvidence;
}

interface RecordRevisionRow {
  id: string;
  project_id: string;
  created_at: string | Date;
  updated_at: string | Date | null;
}

interface CountedEntity {
  entity_type: string;
  table: string;
  id_expression: string;
  project_expression: string;
  created_expression: string;
  updated_expression: string | null;
  list_projection: boolean;
}

const COUNTED_ENTITIES: readonly CountedEntity[] = [
  {
    entity_type: "projects",
    table: "projects",
    id_expression: "id",
    project_expression: "id",
    created_expression: "created_at",
    updated_expression: "updated_at",
    list_projection: true,
  },
  {
    entity_type: "project_planning_preferences",
    table: "project_planning_preferences",
    id_expression: "project_id",
    project_expression: "project_id",
    created_expression: "created_at",
    updated_expression: "updated_at",
    list_projection: true,
  },
  {
    entity_type: "repository_binding_candidates",
    table: "repository_binding_candidates",
    id_expression: "id",
    project_expression: "project_id",
    created_expression: "created_at",
    updated_expression: "updated_at",
    list_projection: true,
  },
  {
    entity_type: "phases",
    table: "phases",
    id_expression: "id",
    project_expression: "project_id",
    created_expression: "created_at",
    updated_expression: "updated_at",
    list_projection: true,
  },
  {
    entity_type: "strategy_versions",
    table: "strategy_versions",
    id_expression: "id",
    project_expression: "project_id",
    created_expression: "created_at",
    updated_expression: "updated_at",
    list_projection: false,
  },
  {
    entity_type: "objectives",
    table: "objectives",
    id_expression: "id",
    project_expression: "project_id",
    created_expression: "created_at",
    updated_expression: "updated_at",
    list_projection: false,
  },
  {
    entity_type: "tasks",
    table: "tasks",
    id_expression: "id",
    project_expression: "project_id",
    created_expression: "created_at",
    updated_expression: "updated_at",
    list_projection: false,
  },
  {
    entity_type: "task_dependencies",
    table: "task_dependencies",
    id_expression: "id",
    project_expression: "project_id",
    created_expression: "created_at",
    updated_expression: null,
    list_projection: false,
  },
  {
    entity_type: "agent_assignments",
    table: "agent_assignments",
    id_expression: "id",
    project_expression: "project_id",
    created_expression: "created_at",
    updated_expression: "updated_at",
    list_projection: false,
  },
  {
    entity_type: "agent_runs",
    table: "agent_runs",
    id_expression: "id",
    project_expression: "project_id",
    created_expression: "created_at",
    updated_expression: "updated_at",
    list_projection: false,
  },
  {
    entity_type: "legacy_approval_evidence",
    table: "legacy_approval_evidence",
    id_expression: "id",
    project_expression: "project_id",
    created_expression: "created_at",
    updated_expression: null,
    list_projection: false,
  },
] as const;

export interface Phase2RollbackRecordCount {
  entity_type: string;
  created_since_freeze: number;
  changed_since_freeze: number;
  hidden_by_rollback: number;
  record_revision_fingerprint: string;
}

export interface Phase2RollbackScopeEvidence {
  scope_type: RollbackScopeType;
  scope_key: string;
  current_read_mode: "relational";
  target_read_mode: "legacy";
  write_mode: RouteWriteMode;
  current_route_version: number;
  relational_reads_started_at: string;
  rollback_window_until: string | null;
  affected_project_ids: string[];
  record_counts: Phase2RollbackRecordCount[];
  hidden_record_count: number;
  relational_visibility_window_ms: number;
}

export interface Phase2RollbackEvidence {
  schema_version: 2;
  evidence_id: string;
  migration_run_id: string;
  source_frozen_at: string;
  legacy_source_updated_at: string;
  evidence_observed_at: string;
  evidence_valid_until: string;
  evidence_freshness_ms: number;
  legacy_freeze_age_ms: number;
  potential_data_loss_window_ms: number;
  last_legacy_project_record: Record<string, unknown> | null;
  scopes: Phase2RollbackScopeEvidence[];
  total_scope_record_impacts: number;
  identity_credential_cutover_started: false;
  identity_route_rollback_supported: false;
  state_fingerprint: string;
  report_fingerprint: string;
  requires_human_confirmation: true;
}

export interface Phase2RollbackApproval {
  approval_id: string;
  evidence_id: string;
  migration_run_id: string;
  human_actor_id: string;
  approved_at: string;
  confirmed_report_fingerprint: string;
  routes_reversed: {
    scope_type: RollbackScopeType;
    scope_key: string;
    previous_route_version: number;
    new_route_version: number;
  }[];
}

export class Phase2RollbackError extends Error {
  constructor(
    readonly code:
      | "migration_not_found"
      | "migration_not_rollback_eligible"
      | "credential_cutover_forward_only"
      | "no_relational_project_canary"
      | "rollback_window_expired"
      | "evidence_not_found"
      | "evidence_expired"
      | "evidence_changed"
      | "fingerprint_mismatch"
      | "human_admin_required"
      | "evidence_already_used",
    message: string,
  ) {
    super(message);
    this.name = "Phase2RollbackError";
  }
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function millisecondsBetween(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

async function databaseTime(sql: V2SqlExecutor): Promise<string> {
  const result = await sql.query<{ observed_at: string | Date }>(
    "SELECT transaction_timestamp() AS observed_at",
  );
  const observed = result.rows[0]?.observed_at;
  if (!observed) throw new Error("database did not return a rollback evidence time");
  return iso(observed);
}

async function lockMigrationRun(
  sql: V2SqlExecutor,
  migrationRunId: string,
): Promise<MigrationRunRow> {
  const result = await sql.query<MigrationRunRow>(
    `SELECT id, status, source_frozen_at, rollback_window_until,
            last_source_records, details
     FROM migration_runs
     WHERE id = $1
     FOR UPDATE`,
    [migrationRunId],
  );
  const run = result.rows[0];
  if (!run || run.source_frozen_at === null) {
    throw new Phase2RollbackError(
      "migration_not_found",
      "Phase 2 rollback migration run or freeze checkpoint was not found",
    );
  }
  if (!ELIGIBLE_RUN_STATUSES.has(run.status)) {
    throw new Phase2RollbackError(
      "migration_not_rollback_eligible",
      `migration run status ${run.status} is not eligible for a canary rollback`,
    );
  }
  return run;
}

async function lockRoutes(
  sql: V2SqlExecutor,
  migrationRunId: string,
): Promise<PersistenceRouteRow[]> {
  const result = await sql.query<PersistenceRouteRow>(
    `SELECT scope_type, scope_key, read_mode, write_mode, migration_run_id,
            aggregate_version, changed_at, v2_writes_started_at,
            rollback_window_until
     FROM persistence_routes
     WHERE migration_run_id = $1
     ORDER BY scope_type, scope_key
     FOR UPDATE`,
    [migrationRunId],
  );
  return result.rows.map((row) => ({ ...row, aggregate_version: Number(row.aggregate_version) }));
}

function assertCredentialCutoverNotStarted(routes: readonly PersistenceRouteRow[]): void {
  const identity = routes.find((route) => route.scope_type === "identity");
  if (
    identity &&
    (identity.v2_writes_started_at !== null ||
      identity.read_mode === "relational" ||
      identity.write_mode === "relational")
  ) {
    throw new Phase2RollbackError(
      "credential_cutover_forward_only",
      "identity credential cutover is forward-only; restore offline and re-run before cutover instead of reactivating legacy credentials",
    );
  }
}

function eligibleRoutes(routes: readonly PersistenceRouteRow[]): PersistenceRouteRow[] {
  const eligible = routes.filter(
    (route) =>
      (route.scope_type === "project" || route.scope_type === "new_projects") &&
      route.read_mode === "relational" &&
      route.write_mode !== "relational",
  );
  if (eligible.length === 0) {
    throw new Phase2RollbackError(
      "no_relational_project_canary",
      "no relational project or new-project read canary is active",
    );
  }
  return eligible;
}

async function importedProjectIds(sql: V2SqlExecutor, migrationRunId: string): Promise<string[]> {
  const result = await sql.query<{ project_id: string }>(
    `SELECT project_id
     FROM legacy_project_imports
     WHERE migration_run_id = $1
     ORDER BY project_id`,
    [migrationRunId],
  );
  return result.rows.map((row) => row.project_id);
}

async function countEntityRows(
  sql: V2SqlExecutor,
  entity: CountedEntity,
  projectIds: readonly string[],
  sourceFrozenAt: string,
): Promise<Phase2RollbackRecordCount> {
  if (projectIds.length === 0) {
    return {
      entity_type: entity.entity_type,
      created_since_freeze: 0,
      changed_since_freeze: 0,
      hidden_by_rollback: 0,
      record_revision_fingerprint: canonicalSha256([]),
    };
  }
  // Every interpolated identifier comes from COUNTED_ENTITIES above; no
  // caller-controlled value can become SQL syntax.
  const result = await sql.query<RecordRevisionRow>(
    `SELECT ${entity.id_expression}::text AS id,
            ${entity.project_expression}::text AS project_id,
            ${entity.created_expression} AS created_at,
            ${entity.updated_expression ?? "NULL::timestamptz"} AS updated_at
     FROM ${entity.table}
     WHERE ${entity.project_expression} = ANY($1::text[])
     ORDER BY ${entity.project_expression}, ${entity.id_expression}`,
    [projectIds],
  );
  const rows = result.rows.map((row) => ({
    id: row.id,
    project_id: row.project_id,
    created_at: iso(row.created_at),
    updated_at: row.updated_at === null ? null : iso(row.updated_at),
  }));
  return {
    entity_type: entity.entity_type,
    created_since_freeze: rows.filter(
      (row) => Date.parse(row.created_at) >= Date.parse(sourceFrozenAt),
    ).length,
    changed_since_freeze:
      entity.updated_expression === null
        ? 0
        : rows.filter(
            (row) =>
              row.updated_at !== null && Date.parse(row.updated_at) > Date.parse(sourceFrozenAt),
          ).length,
    hidden_by_rollback: rows.length,
    record_revision_fingerprint: canonicalSha256(rows),
  };
}

async function scopeEvidence(
  sql: V2SqlExecutor,
  route: PersistenceRouteRow,
  sourceFrozenAt: string,
  observedAt: string,
  allImportedProjectIds: readonly string[],
): Promise<Phase2RollbackScopeEvidence> {
  const scopeType = route.scope_type as RollbackScopeType;
  const projectIds = scopeType === "project" ? [route.scope_key] : [...allImportedProjectIds];
  const entities =
    scopeType === "new_projects"
      ? COUNTED_ENTITIES.filter((entity) => entity.list_projection)
      : COUNTED_ENTITIES;
  const recordCounts: Phase2RollbackRecordCount[] = [];
  for (const entity of entities) {
    recordCounts.push(await countEntityRows(sql, entity, projectIds, sourceFrozenAt));
  }
  return {
    scope_type: scopeType,
    scope_key: route.scope_key,
    current_read_mode: "relational",
    target_read_mode: "legacy",
    write_mode: route.write_mode as RouteWriteMode,
    current_route_version: route.aggregate_version,
    relational_reads_started_at: iso(route.changed_at),
    rollback_window_until:
      route.rollback_window_until === null ? null : iso(route.rollback_window_until),
    affected_project_ids: [...projectIds].sort(),
    record_counts: recordCounts,
    hidden_record_count: recordCounts.reduce((total, count) => total + count.hidden_by_rollback, 0),
    relational_visibility_window_ms: millisecondsBetween(iso(route.changed_at), observedAt),
  };
}

interface DerivedEvidenceBody {
  migration_run_id: string;
  source_frozen_at: string;
  legacy_source_updated_at: string;
  last_legacy_project_record: Record<string, unknown> | null;
  scopes: Phase2RollbackScopeEvidence[];
  total_scope_record_impacts: number;
  identity_credential_cutover_started: false;
  identity_route_rollback_supported: false;
}

function stateFingerprintForBody(body: DerivedEvidenceBody): string {
  return canonicalSha256({
    ...body,
    scopes: body.scopes.map(({ relational_visibility_window_ms: _elapsed, ...scope }) => scope),
  });
}

async function deriveEvidenceBody(
  sql: V2SqlExecutor,
  migrationRunId: string,
  observedAt: string,
): Promise<{ body: DerivedEvidenceBody; run: MigrationRunRow }> {
  const run = await lockMigrationRun(sql, migrationRunId);
  const routes = await lockRoutes(sql, migrationRunId);
  assertCredentialCutoverNotStarted(routes);
  const candidates = eligibleRoutes(routes);
  const runWindow = run.rollback_window_until === null ? null : iso(run.rollback_window_until);
  if (runWindow !== null && Date.parse(observedAt) > Date.parse(runWindow)) {
    throw new Phase2RollbackError(
      "rollback_window_expired",
      "the approved migration rollback window has expired",
    );
  }
  for (const route of candidates) {
    if (
      route.rollback_window_until !== null &&
      Date.parse(observedAt) > Date.parse(iso(route.rollback_window_until))
    ) {
      throw new Phase2RollbackError(
        "rollback_window_expired",
        `the rollback window expired for ${route.scope_type}:${route.scope_key}`,
      );
    }
  }

  const sourceFrozenAt = iso(run.source_frozen_at as string | Date);
  const importedIds = await importedProjectIds(sql, migrationRunId);
  const scopes: Phase2RollbackScopeEvidence[] = [];
  for (const route of candidates) {
    scopes.push(
      await scopeEvidence(sql, route, sourceFrozenAt, observedAt, importedIds),
    );
  }
  const details = object(run.details);
  const sourceUpdatedAt = object(details.source_updated_at);
  const legacySourceUpdatedAt = optionalIso(sourceUpdatedAt.projects) ?? sourceFrozenAt;
  const lastRecords = object(run.last_source_records);
  const lastProject = lastRecords.projects;
  return {
    run,
    body: {
      migration_run_id: migrationRunId,
      source_frozen_at: sourceFrozenAt,
      legacy_source_updated_at: legacySourceUpdatedAt,
      last_legacy_project_record:
        lastProject !== null && typeof lastProject === "object" && !Array.isArray(lastProject)
          ? (lastProject as Record<string, unknown>)
          : null,
      scopes,
      total_scope_record_impacts: scopes.reduce(
        (total, scope) => total + scope.hidden_record_count,
        0,
      ),
      identity_credential_cutover_started: false,
      identity_route_rollback_supported: false,
    },
  };
}

function evidenceFromBody(body: DerivedEvidenceBody, observedAt: string): Phase2RollbackEvidence {
  const validUntil = new Date(Date.parse(observedAt) + ROLLBACK_EVIDENCE_TTL_MS).toISOString();
  const stateFingerprint = stateFingerprintForBody(body);
  const reportWithoutIds = {
    schema_version: 2 as const,
    ...body,
    evidence_observed_at: observedAt,
    evidence_valid_until: validUntil,
    evidence_freshness_ms: ROLLBACK_EVIDENCE_TTL_MS,
    legacy_freeze_age_ms: millisecondsBetween(body.source_frozen_at, observedAt),
    potential_data_loss_window_ms: millisecondsBetween(body.source_frozen_at, observedAt),
    state_fingerprint: stateFingerprint,
    requires_human_confirmation: true as const,
  };
  const reportFingerprint = canonicalSha256(reportWithoutIds);
  return {
    ...reportWithoutIds,
    evidence_id: `rollback-evidence:${reportFingerprint}`,
    report_fingerprint: reportFingerprint,
  };
}

function parseEvidenceRow(row: EvidenceRow): Phase2RollbackEvidence {
  const report = row.report;
  const {
    evidence_id: _evidenceId,
    report_fingerprint: _reportFingerprint,
    ...reportWithoutIds
  } = report;
  if (
    report.evidence_id !== row.id ||
    report.migration_run_id !== row.migration_run_id ||
    report.state_fingerprint !== row.state_fingerprint ||
    report.report_fingerprint !== row.report_fingerprint ||
    canonicalSha256(reportWithoutIds) !== row.report_fingerprint
  ) {
    throw new Phase2RollbackError(
      "evidence_changed",
      "persisted rollback evidence identity does not match its report",
    );
  }
  return report;
}

/**
 * Offline, privileged Phase 2 rollback control. Reports are derived from and
 * persisted by PostgreSQL; callers provide only the migration identity, then
 * confirm the exact immutable evidence record as an authenticated human.
 */
export class SqlPhase2RollbackController {
  constructor(private readonly transactions: Phase2MigrationProcessLease) {}

  async prepare(migrationRunId: string): Promise<Phase2RollbackEvidence> {
    if (migrationRunId.trim().length === 0) {
      throw new Phase2RollbackError("migration_not_found", "migration run id is required");
    }
    return this.transactions.transaction(async (sql) => {
      const observedAt = await databaseTime(sql);
      const { body } = await deriveEvidenceBody(sql, migrationRunId, observedAt);
      const evidence = evidenceFromBody(body, observedAt);
      await sql.query(
        `INSERT INTO migration_rollback_evidence (
           id, migration_run_id, state_fingerprint, report_fingerprint,
           observed_at, valid_until, report
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          evidence.evidence_id,
          evidence.migration_run_id,
          evidence.state_fingerprint,
          evidence.report_fingerprint,
          evidence.evidence_observed_at,
          evidence.evidence_valid_until,
          JSON.stringify(evidence),
        ],
      );
      return evidence;
    });
  }

  async approveAndReverse(input: {
    evidence_id: string;
    confirmed_report_fingerprint: string;
    human_actor_id: string;
  }): Promise<Phase2RollbackApproval> {
    return this.transactions.transaction(async (sql) => {
      const observedAt = await databaseTime(sql);
      const evidenceResult = await sql.query<EvidenceRow>(
        `SELECT id, migration_run_id, state_fingerprint, report_fingerprint,
                observed_at, valid_until, report
         FROM migration_rollback_evidence
         WHERE id = $1
         FOR UPDATE`,
        [input.evidence_id],
      );
      const row = evidenceResult.rows[0];
      if (!row) {
        throw new Phase2RollbackError("evidence_not_found", "rollback evidence was not found");
      }
      const evidence = parseEvidenceRow(row);
      if (input.confirmed_report_fingerprint !== evidence.report_fingerprint) {
        throw new Phase2RollbackError(
          "fingerprint_mismatch",
          "human confirmation does not match the rollback evidence fingerprint",
        );
      }
      if (Date.parse(observedAt) > Date.parse(iso(row.valid_until))) {
        throw new Phase2RollbackError(
          "evidence_expired",
          "rollback evidence expired; prepare a fresh database-derived report",
        );
      }

      const actor = await sql.query<{ id: string }>(
        `SELECT id
         FROM users
         WHERE id = $1 AND role = 'admin' AND status = 'active'
         FOR UPDATE`,
        [input.human_actor_id],
      );
      if (!actor.rows[0]) {
        throw new Phase2RollbackError(
          "human_admin_required",
          "rollback approval requires an active human administrator",
        );
      }

      const alreadyUsed = await sql.query<{ id: string }>(
        "SELECT id FROM migration_rollback_approvals WHERE evidence_id = $1",
        [evidence.evidence_id],
      );
      if (alreadyUsed.rows[0]) {
        throw new Phase2RollbackError(
          "evidence_already_used",
          "rollback evidence already has a recorded approval",
        );
      }

      const { body } = await deriveEvidenceBody(sql, evidence.migration_run_id, observedAt);
      if (stateFingerprintForBody(body) !== evidence.state_fingerprint) {
        throw new Phase2RollbackError(
          "evidence_changed",
          "rollback scope or record revisions changed after the evidence was prepared",
        );
      }

      const routesReversed: Phase2RollbackApproval["routes_reversed"] = [];
      for (const scope of evidence.scopes) {
        const nextVersion = scope.current_route_version + 1;
        const updated = await sql.query<{ scope_key: string }>(
          `UPDATE persistence_routes
           SET read_mode = 'legacy',
               aggregate_version = $3,
               changed_by_actor_type = 'human',
               changed_by_actor_id = $4,
               changed_at = $5
           WHERE scope_type = $1
             AND scope_key = $2
             AND migration_run_id = $6
             AND read_mode = 'relational'
             AND write_mode <> 'relational'
             AND aggregate_version = $7
           RETURNING scope_key`,
          [
            scope.scope_type,
            scope.scope_key,
            nextVersion,
            input.human_actor_id,
            observedAt,
            evidence.migration_run_id,
            scope.current_route_version,
          ],
        );
        if (!updated.rows[0]) {
          throw new Phase2RollbackError(
            "evidence_changed",
            `rollback route changed concurrently: ${scope.scope_type}:${scope.scope_key}`,
          );
        }
        routesReversed.push({
          scope_type: scope.scope_type,
          scope_key: scope.scope_key,
          previous_route_version: scope.current_route_version,
          new_route_version: nextVersion,
        });
      }

      const approvalId = `rollback-approval:${canonicalSha256({
        evidence_id: evidence.evidence_id,
        human_actor_id: input.human_actor_id,
        approved_at: observedAt,
      })}`;
      await sql.query(
        `INSERT INTO migration_rollback_approvals (
           id, evidence_id, migration_run_id, human_actor_id,
           confirmed_report_fingerprint, approved_at, routes_reversed
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          approvalId,
          evidence.evidence_id,
          evidence.migration_run_id,
          input.human_actor_id,
          evidence.report_fingerprint,
          observedAt,
          JSON.stringify(routesReversed),
        ],
      );

      for (const route of routesReversed) {
        await sql.query(
          `INSERT INTO audit_events (
             audit_id, audit_type, project_id, phase_id, task_id,
             actor_type, actor_id, outcome, severity, correlation_id,
             causation_id, occurred_at, targets, summary, details,
             redaction_applied
           ) VALUES (
             $1,'persistence.route_rolled_back',$2,NULL,NULL,
             'human',$3,'succeeded','warning',$4,
             $5,$6,$7::jsonb,$8,$9::jsonb,true
           )`,
          [
            `audit:persistence-route:${route.scope_type}:${encodeURIComponent(route.scope_key)}:v${route.new_route_version}`,
            route.scope_type === "project" ? route.scope_key : null,
            input.human_actor_id,
            `phase2-rollback:${approvalId}`,
            evidence.evidence_id,
            observedAt,
            JSON.stringify([
              {
                entity_type: "persistence_route",
                entity_id: `${route.scope_type}:${route.scope_key}`,
              },
            ]),
            `Persistence read route ${route.scope_type}:${route.scope_key} reverted to legacy`,
            JSON.stringify({
              approval_id: approvalId,
              evidence_id: evidence.evidence_id,
              previous_read_mode: "relational",
              read_mode: "legacy",
              previous_route_version: route.previous_route_version,
              aggregate_version: route.new_route_version,
            }),
          ],
        );
      }

      await sql.query(
        `INSERT INTO audit_events (
           audit_id, audit_type, project_id, phase_id, task_id,
           actor_type, actor_id, outcome, severity, correlation_id,
           causation_id, occurred_at, targets, summary, details,
           redaction_applied
         ) VALUES (
           $1,'migration.rollback_approved',NULL,NULL,NULL,
           'human',$2,'succeeded','warning',$3,
           $4,$5,$6::jsonb,$7,$8::jsonb,true
         )`,
        [
          `audit:${approvalId}`,
          input.human_actor_id,
          `phase2-rollback:${approvalId}`,
          evidence.evidence_id,
          observedAt,
          JSON.stringify(
            routesReversed.map((route) => ({
              entity_type: "persistence_route",
              entity_id: `${route.scope_type}:${route.scope_key}`,
            })),
          ),
          "Human approved the Phase 2 project-read canary rollback",
          JSON.stringify({
            approval_id: approvalId,
            evidence_id: evidence.evidence_id,
            report_fingerprint: evidence.report_fingerprint,
            source_frozen_at: evidence.source_frozen_at,
            potential_data_loss_window_ms: evidence.potential_data_loss_window_ms,
            total_scope_record_impacts: evidence.total_scope_record_impacts,
            identity_route_rollback_supported: false,
          }),
        ],
      );

      await sql.query(
        `UPDATE migration_runs
         SET status = 'rolled_back', completed_at = $2
         WHERE id = $1`,
        [evidence.migration_run_id, observedAt],
      );

      return {
        approval_id: approvalId,
        evidence_id: evidence.evidence_id,
        migration_run_id: evidence.migration_run_id,
        human_actor_id: input.human_actor_id,
        approved_at: observedAt,
        confirmed_report_fingerprint: evidence.report_fingerprint,
        routes_reversed: routesReversed,
      };
    });
  }
}
