import { createHash } from "node:crypto";
import type { V2TransactionRunner } from "../persistence/v2/database.js";

export class Phase7GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase7GateError";
  }
}

export interface Phase7DrillInput {
  id: string;
  drill_type: "restore" | "chaos" | "load" | "soak" | "runner_fencing" | "audit";
  source_revision: string;
  target_reference: string;
  started_at: string;
  completed_at: string;
  recovery_time_seconds: number;
  recovery_point_seconds: number;
  passed: boolean;
  evidence: unknown[];
  recorded_by: string;
}

export class Phase7OperationsService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  revokeRunner(input: {
    runner_id: string;
    revoked_through_generation: number;
    reason: string;
    revoked_by: string;
    revoked_at: string;
  }): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO runner_revocations (
           runner_id, revoked_through_generation, reason, revoked_by, revoked_at
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (runner_id) DO UPDATE
         SET revoked_through_generation=GREATEST(
               runner_revocations.revoked_through_generation,
               EXCLUDED.revoked_through_generation
             ),
             reason=EXCLUDED.reason, revoked_by=EXCLUDED.revoked_by,
             revoked_at=EXCLUDED.revoked_at`,
        [
          input.runner_id,
          input.revoked_through_generation,
          input.reason,
          input.revoked_by,
          input.revoked_at,
        ],
      );
      await sql.query(
        `UPDATE commands SET status='cancelled', updated_at=$3
         WHERE runner_id=$1 AND runner_generation <= $2
           AND status IN ('queued','dispatched')`,
        [input.runner_id, input.revoked_through_generation, input.revoked_at],
      );
    });
  }

  recordDrill(input: Phase7DrillInput): Promise<void> {
    if (input.drill_type === "restore" && input.source_revision === input.target_reference) {
      throw new Phase7GateError("restore drills require a distinct target");
    }
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO resilience_drills (
           id, drill_type, source_revision, target_reference, started_at, completed_at,
           recovery_time_seconds, recovery_point_seconds, passed, evidence, recorded_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [
          input.id,
          input.drill_type,
          input.source_revision,
          input.target_reference,
          input.started_at,
          input.completed_at,
          input.recovery_time_seconds,
          input.recovery_point_seconds,
          input.passed,
          JSON.stringify(input.evidence),
          input.recorded_by,
        ],
      );
    });
  }

  promoteCutover(input: {
    id: string;
    cohort_type: "internal" | "selected" | "new_projects" | "remaining";
    project_id: string | null;
    status: "shadow" | "canary" | "authoritative" | "paused";
    reconciliation_material: unknown;
    restore_drill_id: string;
    authorized_by: string;
    authorized_at: string;
  }): Promise<void> {
    const projectScoped = input.cohort_type === "internal" || input.cohort_type === "selected";
    if (projectScoped !== (input.project_id !== null)) {
      throw new Phase7GateError(`${input.cohort_type} cohort has an invalid project scope`);
    }
    return this.transactions.transaction(async (sql) => {
      const drill = await sql.query<{ passed: boolean; drill_type: string }>(
        "SELECT passed, drill_type FROM resilience_drills WHERE id=$1",
        [input.restore_drill_id],
      );
      if (!drill.rows[0]?.passed || drill.rows[0].drill_type !== "restore") {
        throw new Phase7GateError("cutover requires a passed restore drill");
      }
      const open = await sql.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM migration_reconciliation_findings
         WHERE status='open' AND severity='blocking'
           AND ($1::text IS NULL OR project_id=$1)`,
        [input.project_id],
      );
      if ((open.rows[0]?.count ?? 0) > 0) {
        throw new Phase7GateError("cutover is blocked by reconciliation discrepancies");
      }
      const current = await sql.query<{ status: string }>(
        "SELECT status FROM v2_cutover_cohorts WHERE id=$1 FOR UPDATE",
        [input.id],
      );
      const allowed: Record<string, string[]> = {
        missing: ["shadow"],
        shadow: ["canary", "paused"],
        canary: ["authoritative", "paused"],
        paused: ["shadow", "canary"],
        authoritative: [],
      };
      const from = current.rows[0]?.status ?? "missing";
      if (!allowed[from]?.includes(input.status)) {
        throw new Phase7GateError(`invalid cutover transition ${from} -> ${input.status}`);
      }
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(input.reconciliation_material))
        .digest("hex");
      await sql.query(
        `INSERT INTO v2_cutover_cohorts (
           id, cohort_type, project_id, status, reconciliation_fingerprint,
           restore_drill_id, authorized_by, authorized_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,
           reconciliation_fingerprint=EXCLUDED.reconciliation_fingerprint,
           restore_drill_id=EXCLUDED.restore_drill_id,
           authorized_by=EXCLUDED.authorized_by, authorized_at=EXCLUDED.authorized_at`,
        [
          input.id,
          input.cohort_type,
          input.project_id,
          input.status,
          fingerprint,
          input.restore_drill_id,
          input.authorized_by,
          input.authorized_at,
        ],
      );
      if (input.status === "authoritative") {
        if (input.cohort_type === "remaining") {
          await sql.query(
            `INSERT INTO persistence_routes (
               scope_type, scope_key, read_mode, write_mode, migration_run_id,
               changed_by_actor_type, changed_by_actor_id, changed_at,
               v2_writes_started_at
             )
             SELECT 'project', project.id, 'relational', 'relational', NULL,
                    'human', $1, $2, $2
             FROM projects project
             WHERE project.status <> 'archived'
             ON CONFLICT (scope_type, scope_key) DO UPDATE
             SET read_mode='relational', write_mode='relational',
                 aggregate_version=persistence_routes.aggregate_version+1,
                 changed_by_actor_type='human', changed_by_actor_id=$1,
                 changed_at=$2, v2_writes_started_at=COALESCE(
                   persistence_routes.v2_writes_started_at,$2
                 )`,
            [input.authorized_by, input.authorized_at],
          );
        } else {
          const scopeType = input.cohort_type === "new_projects" ? "new_projects" : "project";
          const scopeKey = input.cohort_type === "new_projects" ? "*" : input.project_id;
          if (!scopeKey) throw new Phase7GateError("authoritative cohort has no route scope");
          await sql.query(
            `INSERT INTO persistence_routes (
               scope_type, scope_key, read_mode, write_mode, migration_run_id,
               changed_by_actor_type, changed_by_actor_id, changed_at,
               v2_writes_started_at
             ) VALUES ($1,$2,'relational','relational',NULL,'human',$3,$4,$4)
             ON CONFLICT (scope_type, scope_key) DO UPDATE
             SET read_mode='relational', write_mode='relational',
                 aggregate_version=persistence_routes.aggregate_version+1,
                 changed_by_actor_type='human', changed_by_actor_id=$3,
                 changed_at=$4, v2_writes_started_at=COALESCE(
                   persistence_routes.v2_writes_started_at,$4
                 )`,
            [scopeType, scopeKey, input.authorized_by, input.authorized_at],
          );
        }
      }
    });
  }

  assertRelationalAuthoritative(): Promise<{ projects: number }> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{ missing: number; projects: number; new_projects: number }>(
        `SELECT
          (SELECT count(*)::int FROM projects project
           WHERE project.status <> 'archived' AND NOT EXISTS (
             SELECT 1 FROM persistence_routes route
             WHERE route.scope_type='project' AND route.scope_key=project.id
               AND route.read_mode='relational' AND route.write_mode='relational'
           )) AS missing,
          (SELECT count(*)::int FROM projects WHERE status <> 'archived') AS projects,
          (SELECT count(*)::int FROM persistence_routes
           WHERE scope_type='new_projects' AND scope_key='*'
             AND read_mode='relational' AND write_mode='relational') AS new_projects`,
      );
      const row = result.rows[0] ?? { missing: 1, projects: 0, new_projects: 0 };
      if (row.missing > 0 || row.new_projects !== 1) {
        throw new Phase7GateError("relational state is not authoritative for every project");
      }
      return { projects: row.projects };
    });
  }

  authorizeLegacyRetirement(input: {
    id: string;
    authorized_by: string;
    authorized_at: string;
    retention_window_completed: boolean;
    restore_drill_id: string;
    scope: unknown;
  }): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      const admin = await sql.query<{ active: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND role='admin' AND status='active') AS active`,
        [input.authorized_by],
      );
      const drill = await sql.query<{ passed: boolean; drill_type: string }>(
        "SELECT passed, drill_type FROM resilience_drills WHERE id=$1",
        [input.restore_drill_id],
      );
      const discrepancies = await sql.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM migration_reconciliation_findings WHERE status='open'",
      );
      if (!admin.rows[0]?.active) throw new Phase7GateError("retirement requires an active admin");
      if (!input.retention_window_completed) {
        throw new Phase7GateError("retention window has not completed");
      }
      if (!drill.rows[0]?.passed || drill.rows[0].drill_type !== "restore") {
        throw new Phase7GateError("retirement requires a passed restore drill");
      }
      if ((discrepancies.rows[0]?.count ?? 0) !== 0) {
        throw new Phase7GateError("retirement requires zero open discrepancies");
      }
      await sql.query(
        `INSERT INTO legacy_retirement_authorizations (
           id, authorized_by, authorized_at, retention_window_completed,
           restore_drill_id, unresolved_discrepancy_count, scope
         ) VALUES ($1,$2,$3,true,$4,0,$5::jsonb)`,
        [
          input.id,
          input.authorized_by,
          input.authorized_at,
          input.restore_drill_id,
          JSON.stringify(input.scope),
        ],
      );
    });
  }
}
