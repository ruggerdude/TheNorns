/**
 * One-off production pilot for the first relational project cohort.
 *
 * This operator command verifies the durable Phase 2 restore checkpoint,
 * records the corresponding Phase 7 restore drill, advances only the
 * new-project cohort, creates (or reuses) one normalized pilot project, and
 * creates its first proposed phase. It is replay-safe and never activates
 * existing-project or identity routes.
 */
import { Pool } from "pg";
import { Phase7OperationsService } from "./operations/phase7Operations.js";
import { postgresPoolConfig } from "./persistence/postgresConnection.js";
import { NodePgTransactionRunner } from "./persistence/v2/database.js";
import { PhaseWorkflowService } from "./projects/phaseWorkflowService.js";
import { ProjectResumeService } from "./projects/projectResumeService.js";
import { RelationalProjectReadRepository } from "./projects/relationalReadRepository.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`required Phase 8 pilot environment variable is missing: ${name}`);
  return value;
}

const runtimeDatabaseUrl = requiredEnvironment("NORNS_PILOT_DATABASE_URL");
const controlDatabaseUrl = requiredEnvironment("NORNS_PILOT_CONTROL_DATABASE_URL");
const migrationRunId = requiredEnvironment("NORNS_PHASE2_RUN_ID");
const adminId = requiredEnvironment("NORNS_PHASE2_HUMAN_ADMIN_ID");
const restoreTarget = requiredEnvironment("NORNS_PHASE8_RESTORE_TARGET");
const drillId = `phase8-restore:${migrationRunId}`;
const cohortId = `phase8-new-projects:${migrationRunId}`;
const pilotName = "The Norns Production Pilot";
const runtimePool = new Pool(postgresPoolConfig(runtimeDatabaseUrl));
const controlPool = new Pool(postgresPoolConfig(controlDatabaseUrl));
const transactions = new NodePgTransactionRunner(runtimePool, {
  mode: "runtime",
  role: "norns_app",
});
const controlTransactions = new NodePgTransactionRunner(controlPool, { mode: "privileged" });

try {
  const gate = await controlTransactions.transaction(async (sql) => {
    const result = await sql.query<{
      source_manifest_hash: string;
      checkpoint_created_at: Date | string;
      verified_at: Date | string;
      step_completed_at: Date | string;
    }>(
      `SELECT run.source_manifest_hash, checkpoint.created_at AS checkpoint_created_at,
              checkpoint.verified_at, step.completed_at AS step_completed_at
       FROM migration_runs run
       JOIN recovery_checkpoints checkpoint ON checkpoint.migration_run_id=run.id
       JOIN migration_steps step ON step.migration_run_id=run.id
         AND step.step_key='recovery_restore_verification' AND step.status='succeeded'
       WHERE run.id=$1 AND run.status IN ('shadowing','ready','cutover')
         AND checkpoint.verified_at IS NOT NULL`,
      [migrationRunId],
    );
    const row = result.rows[0];
    if (!row?.source_manifest_hash) {
      throw new Error("Phase 8 pilot requires the verified Phase 2 recovery checkpoint");
    }
    const activeAdmin = await sql.query<{ active: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM users WHERE id=$1 AND role='admin' AND status='active'
       ) AS active`,
      [adminId],
    );
    if (activeAdmin.rows[0]?.active !== true) {
      throw new Error("Phase 8 pilot requires the active human administrator");
    }
    return row;
  });

  const operations = new Phase7OperationsService(controlTransactions);
  const drillExists = await controlTransactions.transaction(async (sql) => {
    const result = await sql.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM resilience_drills WHERE id=$1) AS exists",
      [drillId],
    );
    return result.rows[0]?.exists === true;
  });
  if (!drillExists) {
    const startedAt = new Date(gate.checkpoint_created_at).toISOString();
    const completedAt = new Date(gate.step_completed_at).toISOString();
    await operations.recordDrill({
      id: drillId,
      drill_type: "restore",
      source_revision: gate.source_manifest_hash,
      target_reference: restoreTarget,
      started_at: startedAt,
      completed_at: completedAt,
      recovery_time_seconds: Math.max(
        0,
        Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1_000),
      ),
      recovery_point_seconds: 0,
      passed: true,
      evidence: [
        {
          migration_run_id: migrationRunId,
          source_manifest_hash: gate.source_manifest_hash,
          recovery_checkpoint_verified_at: new Date(gate.verified_at).toISOString(),
          recovery_step_completed_at: completedAt,
        },
      ],
      recorded_by: adminId,
    });
  }

  const status = async (): Promise<string | null> =>
    controlTransactions.transaction(async (sql) => {
      const result = await sql.query<{ status: string }>(
        "SELECT status FROM v2_cutover_cohorts WHERE id=$1",
        [cohortId],
      );
      return result.rows[0]?.status ?? null;
    });
  for (const next of ["shadow", "canary", "authoritative"] as const) {
    const current = await status();
    if (current === "authoritative") break;
    if (
      (next === "shadow" && current !== null) ||
      (next === "canary" && current !== "shadow") ||
      (next === "authoritative" && current !== "canary")
    ) {
      continue;
    }
    await operations.promoteCutover({
      id: cohortId,
      cohort_type: "new_projects",
      project_id: null,
      status: next,
      reconciliation_material: {
        migration_run_id: migrationRunId,
        source_manifest_hash: gate.source_manifest_hash,
        project_count_at_gate: 0,
      },
      restore_drill_id: drillId,
      authorized_by: adminId,
      authorized_at: new Date().toISOString(),
    });
  }
  if ((await status()) !== "authoritative") {
    throw new Error("new-project cohort did not reach authoritative state");
  }

  const relational = new RelationalProjectReadRepository(transactions, migrationRunId);
  const existingProjectId = await transactions.transaction(async (sql) => {
    const result = await sql.query<{ id: string }>(
      "SELECT id FROM projects WHERE name=$1 ORDER BY created_at, id LIMIT 1",
      [pilotName],
    );
    return result.rows[0]?.id ?? null;
  });
  const project =
    existingProjectId === null
      ? await relational.create({
          name: pilotName,
          description: "Production verification of normalized project and phase persistence.",
          pmProvider: "openai",
          pmModel: "gpt-5.6-sol",
        })
      : await relational.summary(existingProjectId);

  const phases = new PhaseWorkflowService(transactions);
  const existingPhase = await transactions.transaction(async (sql) => {
    const result = await sql.query<{ id: string }>(
      `SELECT id FROM phases
       WHERE project_id=$1 AND objective_summary=$2
       ORDER BY created_at, id LIMIT 1`,
      [project.id, "Verify the production relational execution path"],
    );
    return result.rows[0]?.id ?? null;
  });
  const phase =
    existingPhase === null
      ? await phases.create({
          schema_version: 2,
          command_id: `phase8-pilot-phase:${project.id}`,
          kind: "create_phase",
          command_family: "phase",
          actor: { actor_type: "human", actor_id: adminId },
          idempotency_key: `phase8-pilot-phase:${project.id}`,
          correlation_id: `phase8-pilot:${project.id}`,
          causation_id: null,
          issued_at: new Date().toISOString(),
          project_id: project.id,
          objective_summary: "Verify the production relational execution path",
          priority: 100,
          predecessor_phase_ids: [],
          expected_project_version: 1,
        })
      : await transactions.transaction(async (sql) => {
          const result = await sql.query<{ id: string }>("SELECT id FROM phases WHERE id=$1", [
            existingPhase,
          ]);
          if (!result.rows[0]) throw new Error("pilot phase disappeared");
          return { id: result.rows[0].id };
        });
  const resume = await new ProjectResumeService(transactions).open(project.id);

  process.stdout.write(
    `${JSON.stringify({
      migration_run_id: migrationRunId,
      restore_drill_id: drillId,
      cohort_id: cohortId,
      cohort_status: "authoritative",
      project_id: project.id,
      project_manager: `${project.pm_provider}:${project.pm_model}`,
      phase_id: phase.id,
      next_action: resume.next_recommended_action,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.name : "Phase8PilotError"}: ${
      error instanceof Error ? error.message : "Phase 8 pilot failed"
    }\n`,
  );
  process.exitCode = 1;
} finally {
  await Promise.all([runtimePool.end(), controlPool.end()]);
}
