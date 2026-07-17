import type { V2SqlExecutor, V2TransactionRunner } from "../v2/database.js";
import { canonicalSha256 } from "./canonicalJson.js";
import type { LegacyProjectImportPlan } from "./projectImportPlan.js";
import {
  type LegacyProjectImportPersistenceContext,
  SqlLegacyProjectImportRepository,
} from "./projectImportRepository.js";

export type LegacyProjectImportStep =
  | "project"
  | "repository_candidate"
  | "phase_strategy_objective"
  | "tasks"
  | "profiles_assignments"
  | "dependencies"
  | "findings"
  | "historical_approval"
  | "mappings_events"
  | "cancelled_transitions"
  | "audit"
  | "complete";

export class LegacyProjectMigrationRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyProjectMigrationRunError";
  }
}

export class LegacyProjectSourceChangedError extends Error {
  constructor(
    readonly projectId: string,
    readonly expectedSourceHash: string,
    readonly actualSourceHash: string,
  ) {
    super(
      `legacy project ${projectId} source changed after freeze: ` +
        `imported=${expectedSourceHash} candidate=${actualSourceHash}`,
    );
    this.name = "LegacyProjectSourceChangedError";
  }
}

export class LegacyProjectImportPlanChangedError extends Error {
  constructor(readonly projectId: string) {
    super(`legacy project ${projectId} import projection changed after it was persisted`);
    this.name = "LegacyProjectImportPlanChangedError";
  }
}

export interface ImportLegacyProjectOptions {
  transaction_runner: V2TransactionRunner;
  migration_run_id: string;
  source_manifest_hash: string;
  occurred_at: string;
  plan: LegacyProjectImportPlan;
  /**
   * Observability/fault-injection seam. Production callers may record progress;
   * tests use it to prove a mid-import failure rolls the entire transaction
   * back. The callback must not perform an independent database commit.
   */
  after_step?: (step: LegacyProjectImportStep, tx: V2SqlExecutor) => void | Promise<void>;
}

export interface LegacyProjectImportResult {
  status: "imported" | "replayed";
  migration_run_id: string;
  project_id: string;
  source_hash: string;
  import_hash: string;
  counts: {
    tasks: number;
    dependencies: number;
    assignments: number;
    findings: number;
  };
}

const IMPORTABLE_RUN_STATUSES = new Set([
  "archived",
  "importing",
  "reconciling",
  "shadowing",
  "ready",
]);

async function reached(
  options: ImportLegacyProjectOptions,
  step: LegacyProjectImportStep,
  tx: V2SqlExecutor,
): Promise<void> {
  await options.after_step?.(step, tx);
}

export async function importLegacyProject(
  options: ImportLegacyProjectOptions,
): Promise<LegacyProjectImportResult> {
  const importHash = canonicalSha256(options.plan);
  const resultCounts = {
    tasks: options.plan.tasks.length,
    dependencies: options.plan.task_dependencies.length,
    assignments: options.plan.agent_assignments.length,
    findings: options.plan.findings.length,
  };

  return options.transaction_runner.transaction(async (tx) => {
    const repository = new SqlLegacyProjectImportRepository(tx);
    await repository.acquireProjectLock(options.migration_run_id, options.plan.project.id);
    const run = await repository.lockMigrationRun(options.migration_run_id);
    if (run === null) {
      throw new LegacyProjectMigrationRunError(
        `migration run ${options.migration_run_id} is missing or has no frozen source time`,
      );
    }
    if (run.source_manifest_hash !== options.source_manifest_hash) {
      throw new LegacyProjectMigrationRunError(
        `migration run ${options.migration_run_id} manifest hash does not match the import request`,
      );
    }
    if (run.source_frozen_at !== options.plan.source_frozen_at) {
      throw new LegacyProjectMigrationRunError(
        `migration run ${options.migration_run_id} freeze time does not match the project plan`,
      );
    }
    if (!IMPORTABLE_RUN_STATUSES.has(run.status)) {
      throw new LegacyProjectMigrationRunError(
        `migration run ${options.migration_run_id} is ${run.status}, not importable`,
      );
    }

    const existing = await repository.existingImport(
      options.migration_run_id,
      options.plan.project.id,
    );
    if (existing !== null) {
      if (existing.source_hash !== options.plan.source_hash) {
        throw new LegacyProjectSourceChangedError(
          options.plan.project.id,
          existing.source_hash,
          options.plan.source_hash,
        );
      }
      if (existing.import_hash !== importHash) {
        throw new LegacyProjectImportPlanChangedError(options.plan.project.id);
      }
      return {
        status: "replayed",
        migration_run_id: options.migration_run_id,
        project_id: options.plan.project.id,
        source_hash: options.plan.source_hash,
        import_hash: importHash,
        counts: resultCounts,
      };
    }

    const context: LegacyProjectImportPersistenceContext = {
      migration_run_id: options.migration_run_id,
      source_manifest_hash: options.source_manifest_hash,
      occurred_at: options.occurred_at,
      import_hash: importHash,
    };

    await repository.insertProject(options.plan);
    await reached(options, "project", tx);
    await repository.insertRepositoryCandidate(options.plan, run.projects_archive_id);
    await reached(options, "repository_candidate", tx);
    await repository.insertPhaseStrategyAndObjective(options.plan);
    await reached(options, "phase_strategy_objective", tx);
    await repository.insertTasksAtLifecycleOrigin(options.plan);
    await reached(options, "tasks", tx);
    await repository.insertProfilesAndAssignments(options.plan);
    await reached(options, "profiles_assignments", tx);
    await repository.insertDependencies(options.plan);
    await reached(options, "dependencies", tx);
    await repository.insertFindings(options.plan, context);
    await reached(options, "findings", tx);
    await repository.insertHistoricalApproval(options.plan, context);
    await reached(options, "historical_approval", tx);
    await repository.insertMappingsAndImportEvents(options.plan, context);
    await reached(options, "mappings_events", tx);
    await repository.applyCancelledTaskTransitions(options.plan, context);
    await reached(options, "cancelled_transitions", tx);
    await repository.appendProjectImportAudit(options.plan, context);
    await reached(options, "audit", tx);
    await repository.completeImport(options.plan, run, context);
    await reached(options, "complete", tx);

    return {
      status: "imported",
      migration_run_id: options.migration_run_id,
      project_id: options.plan.project.id,
      source_hash: options.plan.source_hash,
      import_hash: importHash,
      counts: resultCounts,
    };
  });
}
