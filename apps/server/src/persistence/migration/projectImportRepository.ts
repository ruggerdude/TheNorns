import { V2DomainEvent, V2TaskTransitionEvent } from "@norns/contracts";
import type { V2SqlExecutor } from "../v2/database.js";
import { SqlV2ApplicationTransaction } from "../v2/sqlRepositories.js";
import { canonicalSha256 } from "./canonicalJson.js";
import type { LegacyImportIdMapping, LegacyProjectImportPlan } from "./projectImportPlan.js";
import type { LegacyProjectReconciliationFinding } from "./projectReconciliation.js";

export interface LegacyProjectMigrationRun {
  id: string;
  source_manifest_hash: string | null;
  source_frozen_at: string;
  projects_archive_id: string | null;
  status: string;
}

export interface ExistingLegacyProjectImport {
  source_hash: string;
  import_hash: string;
}

export interface LegacyProjectImportPersistenceContext {
  migration_run_id: string;
  source_manifest_hash: string;
  occurred_at: string;
  import_hash: string;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function deterministicId(kind: string, identity: unknown): string {
  return `${kind}:${canonicalSha256(identity)}`;
}

function cancelledTaskTransitionEventId(migrationRunId: string, taskId: string): string {
  return deterministicId("event", {
    migration_run_id: migrationRunId,
    kind: "task_state_transitioned",
    task_id: taskId,
    lifecycle_version: 1,
  });
}

function githubIdentity(location: string): { owner: string; name: string } | null {
  const match = location.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], name: match[2] };
}

function sourceDisplayName(sourceType: "local" | "github", location: string): string {
  if (sourceType === "github") {
    const github = githubIdentity(location);
    return github === null ? "Legacy GitHub repository" : `${github.owner}/${github.name}`;
  }
  const parts = location.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? "Legacy local repository";
}

function eventScope(
  mapping: LegacyImportIdMapping,
  plan: LegacyProjectImportPlan,
): {
  v2_entity_type:
    | "project"
    | "phase"
    | "strategy_version"
    | "objective"
    | "task"
    | "agent_assignment";
  phase_id: string | null;
  task_id: string | null;
} | null {
  switch (mapping.v2_entity_type) {
    case "project":
      return { v2_entity_type: "project", phase_id: null, task_id: null };
    case "phase":
      return {
        v2_entity_type: "phase",
        phase_id: plan.phase?.id ?? null,
        task_id: null,
      };
    case "strategy_version":
      return {
        v2_entity_type: "strategy_version",
        phase_id: plan.phase?.id ?? null,
        task_id: null,
      };
    case "objective":
      return {
        v2_entity_type: "objective",
        phase_id: plan.phase?.id ?? null,
        task_id: null,
      };
    case "task": {
      const task = plan.tasks.find((candidate) => candidate.id === mapping.v2_id);
      return task === undefined
        ? null
        : {
            v2_entity_type: "task",
            phase_id: task.phase_id,
            task_id: task.id,
          };
    }
    case "agent_assignment": {
      const assignment = plan.agent_assignments.find((candidate) => candidate.id === mapping.v2_id);
      return assignment === undefined
        ? null
        : {
            v2_entity_type: "agent_assignment",
            phase_id: assignment.phase_id,
            task_id: assignment.task_id,
          };
    }
    default:
      return null;
  }
}

export class SqlLegacyProjectImportRepository {
  constructor(private readonly sql: V2SqlExecutor) {}

  async acquireProjectLock(migrationRunId: string, projectId: string): Promise<void> {
    await this.sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `legacy-project-import:${migrationRunId}:${projectId}`,
    ]);
  }

  async lockMigrationRun(migrationRunId: string): Promise<LegacyProjectMigrationRun | null> {
    const result = await this.sql.query<{
      id: string;
      source_manifest_hash: string | null;
      source_frozen_at: string | Date | null;
      projects_archive_id: string | null;
      status: string;
    }>(
      `SELECT run.id, run.source_manifest_hash, run.source_frozen_at, run.status,
              (
                SELECT archive.id
                FROM legacy_snapshot_archives archive
                WHERE archive.migration_run_id = run.id
                  AND archive.source_key = 'projects'
                ORDER BY archive.captured_at DESC, archive.id
                LIMIT 1
              ) AS projects_archive_id
       FROM migration_runs run
       WHERE run.id = $1
       FOR UPDATE OF run`,
      [migrationRunId],
    );
    const row = result.rows[0];
    if (!row || row.source_frozen_at === null) return null;
    return {
      id: row.id,
      source_manifest_hash: row.source_manifest_hash,
      source_frozen_at: iso(row.source_frozen_at),
      projects_archive_id: row.projects_archive_id,
      status: row.status,
    };
  }

  async existingImport(
    migrationRunId: string,
    projectId: string,
  ): Promise<ExistingLegacyProjectImport | null> {
    const result = await this.sql.query<ExistingLegacyProjectImport>(
      `SELECT source_hash, import_hash
       FROM legacy_project_imports
       WHERE migration_run_id = $1 AND project_id = $2
       FOR UPDATE`,
      [migrationRunId, projectId],
    );
    return result.rows[0] ?? null;
  }

  async insertProject(plan: LegacyProjectImportPlan): Promise<void> {
    await this.sql.query(
      `INSERT INTO projects (
         id, schema_version, name, description, status,
         max_executing_phases, max_concurrent_tasks, assignment_policy_ref,
         verification_policy_ref, budget_policy_ref, aggregate_version,
         created_at, updated_at
       ) VALUES ($1,2,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11)`,
      [
        plan.project.id,
        plan.project.name,
        plan.project.description,
        plan.project.status,
        plan.project.max_executing_phases,
        plan.project.max_concurrent_tasks,
        plan.project.assignment_policy_ref,
        plan.project.verification_policy_ref,
        plan.project.budget_policy_ref,
        plan.project.created_at,
        plan.project.updated_at,
      ],
    );
    await this.sql.query(
      `INSERT INTO project_planning_preferences (
         project_id, pm_provider, pm_model, reviewer_provider, source,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'legacy_snapshot',$5,$5)`,
      [
        plan.project.id,
        plan.project.pm_provider,
        plan.project.pm_model,
        plan.project.reviewer_provider,
        plan.source_frozen_at,
      ],
    );
  }

  async insertRepositoryCandidate(
    plan: LegacyProjectImportPlan,
    archiveId: string | null,
  ): Promise<void> {
    const sourceType = plan.project.source_type;
    const sourceLocation = plan.project.source_location;
    if (sourceType === null || sourceLocation === null) return;
    const fingerprint = canonicalSha256({
      source_type: sourceType,
      source_location: sourceLocation,
    });
    const github = sourceType === "github" ? githubIdentity(sourceLocation) : null;
    await this.sql.query(
      `INSERT INTO repository_binding_candidates (
         id, project_id, source_type, source_fingerprint, display_name,
         github_owner, github_name, status, archive_id, source_record_id,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'unverified',$8,$9,$10,$10)`,
      [
        deterministicId("repository-candidate", {
          project_id: plan.project.id,
          source_type: sourceType,
          source_fingerprint: fingerprint,
        }),
        plan.project.id,
        sourceType,
        fingerprint,
        sourceDisplayName(sourceType, sourceLocation),
        github?.owner ?? null,
        github?.name ?? null,
        archiveId,
        plan.project.id,
        plan.source_frozen_at,
      ],
    );
  }

  async insertPhaseStrategyAndObjective(plan: LegacyProjectImportPlan): Promise<void> {
    if (plan.phase === null) return;
    await this.sql.query(
      `INSERT INTO phases (
         id, schema_version, project_id, objective_summary, priority, status,
         approved_strategy_version_id, approved_budget_usd, aggregate_version,
         created_at, updated_at
       ) VALUES ($1,2,$2,$3,$4,$5,NULL,$6,1,$7,$8)`,
      [
        plan.phase.id,
        plan.phase.project_id,
        plan.phase.objective_summary,
        plan.phase.priority,
        plan.phase.status,
        plan.phase.approved_budget_usd,
        plan.phase.created_at,
        plan.phase.updated_at,
      ],
    );
    if (plan.strategy !== null) {
      await this.sql.query(
        `INSERT INTO strategy_versions (
           id, schema_version, project_id, phase_id, version, aggregate_version,
           status, objective, content, convergence, review_rounds, content_hash,
           approval_id, created_at, updated_at
         ) VALUES ($1,2,$2,$3,$4,1,$5,$6,$7::jsonb,$8,$9,$10,NULL,$11,$12)`,
        [
          plan.strategy.id,
          plan.strategy.project_id,
          plan.strategy.phase_id,
          plan.strategy.version,
          plan.strategy.status,
          plan.strategy.objective,
          json(plan.strategy.content),
          plan.strategy.convergence,
          plan.strategy.review_rounds,
          plan.strategy.content_hash,
          plan.strategy.created_at,
          plan.strategy.updated_at,
        ],
      );
    }
    if (plan.objective !== null) {
      await this.sql.query(
        `INSERT INTO objectives (
           id, schema_version, project_id, phase_id, outcome, success_measures,
           status, "order", completion_evidence, aggregate_version,
           created_at, updated_at
         ) VALUES ($1,2,$2,$3,$4,$5::jsonb,$6,$7,'[]'::jsonb,1,$8,$9)`,
        [
          plan.objective.id,
          plan.objective.project_id,
          plan.objective.phase_id,
          plan.objective.outcome,
          json(plan.objective.success_measures),
          plan.objective.status,
          plan.objective.order,
          plan.objective.created_at,
          plan.objective.updated_at,
        ],
      );
    }
  }

  async insertTasksAtLifecycleOrigin(plan: LegacyProjectImportPlan): Promise<void> {
    for (const task of plan.tasks) {
      await this.sql.query(
        `INSERT INTO tasks (
           id, schema_version, project_id, phase_id, objective_id,
           strategy_version_id, title, description, deliverables,
           acceptance_criteria, complexity, risk, required_roles,
           required_capabilities, required_inputs, expected_outputs,
           environment_policy_ref, verification_policy_ref, state,
           designated_assignment_id, designated_run_id, review_evidence,
           completion_evidence, lifecycle_version, aggregate_version,
           created_at, updated_at, completed_at
         ) VALUES (
           $1,2,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,
           $12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17,
           'pending',NULL,NULL,'[]'::jsonb,'[]'::jsonb,0,1,$18,$19,NULL
         )`,
        [
          task.id,
          task.project_id,
          task.phase_id,
          task.objective_id,
          task.strategy_version_id,
          task.title,
          task.description,
          json(task.deliverables),
          json(task.acceptance_criteria),
          task.complexity,
          task.risk,
          json(task.required_roles),
          json(task.required_capabilities),
          json(task.required_inputs),
          json(task.expected_outputs),
          task.environment_policy_ref,
          task.verification_policy_ref,
          plan.source_frozen_at,
          plan.source_frozen_at,
        ],
      );
    }
  }

  async insertProfilesAndAssignments(plan: LegacyProjectImportPlan): Promise<void> {
    for (const profile of plan.agent_profiles) {
      await this.sql.query(
        `INSERT INTO agent_profiles (
           id, schema_version, provider, runtime, model, roles, capabilities,
           context_limit_tokens, security_restrictions, status, active_workload,
           cost_metadata, aggregate_version, created_at, updated_at
         ) VALUES (
           $1,2,$2,$3,$4,$5::jsonb,'[]'::jsonb,$6,$7::jsonb,$8,0,
           $9::jsonb,1,$10,$10
         ) ON CONFLICT (id) DO NOTHING`,
        [
          profile.id,
          profile.provider,
          profile.runtime,
          profile.model,
          json(profile.roles),
          profile.context_limit_tokens,
          json(profile.security_restrictions),
          profile.status,
          json({
            billing_mode: "unknown",
            input_usd_per_million: null,
            output_usd_per_million: null,
          }),
          plan.source_frozen_at,
        ],
      );
    }
    for (const assignment of plan.agent_assignments) {
      await this.sql.query(
        `INSERT INTO agent_assignments (
           id, schema_version, project_id, phase_id, task_id, agent_profile_id,
           status, rationale, rationale_factors, budget_limit_usd,
           reviewer_agent_profile_id, allocation_policy_ref, aggregate_version,
           created_at, updated_at
         ) VALUES ($1,2,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,1,$12,$12)`,
        [
          assignment.id,
          assignment.project_id,
          assignment.phase_id,
          assignment.task_id,
          assignment.agent_profile_id,
          assignment.status,
          assignment.rationale,
          json(assignment.rationale_factors),
          assignment.budget_limit_usd,
          assignment.reviewer_agent_profile_id,
          assignment.allocation_policy_ref,
          plan.source_frozen_at,
        ],
      );
      await this.sql.query(
        `UPDATE tasks
         SET designated_assignment_id = $2, updated_at = $3
         WHERE id = $1 AND project_id = $4 AND phase_id = $5`,
        [
          assignment.task_id,
          assignment.id,
          plan.source_frozen_at,
          assignment.project_id,
          assignment.phase_id,
        ],
      );
    }
  }

  async insertDependencies(plan: LegacyProjectImportPlan): Promise<void> {
    for (const dependency of plan.task_dependencies) {
      await this.sql.query(
        `INSERT INTO task_dependencies (
           id, schema_version, project_id, phase_id,
           predecessor_task_id, successor_task_id, created_at
         ) VALUES ($1,2,$2,$3,$4,$5,$6)`,
        [
          dependency.id,
          dependency.project_id,
          dependency.phase_id,
          dependency.predecessor_task_id,
          dependency.successor_task_id,
          plan.source_frozen_at,
        ],
      );
    }
  }

  async insertFindings(
    plan: LegacyProjectImportPlan,
    context: LegacyProjectImportPersistenceContext,
  ): Promise<void> {
    for (const entry of plan.findings) {
      const sourceFingerprint = canonicalSha256({
        project_source_hash: plan.source_hash,
        finding: entry,
      });
      await this.sql.query(
        `INSERT INTO migration_reconciliation_findings (
           id, migration_run_id, project_id, code, severity, status,
           source_entity_type, source_entity_id, source_fingerprint,
           details, detected_at, resolved_at
         ) VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9::jsonb,$10,NULL)`,
        [
          deterministicId("migration-finding", {
            migration_run_id: context.migration_run_id,
            source_finding_id: entry.id,
          }),
          context.migration_run_id,
          plan.project.id,
          entry.code,
          entry.severity,
          entry.subject_type,
          entry.subject_id,
          sourceFingerprint,
          json({
            summary: entry.summary,
            source_finding_id: entry.id,
            ...entry.details,
          }),
          context.occurred_at,
        ],
      );
    }
  }

  async insertHistoricalApproval(
    plan: LegacyProjectImportPlan,
    context: LegacyProjectImportPersistenceContext,
  ): Promise<void> {
    const approval = plan.historical_approval;
    if (approval === null) return;
    await this.sql.query(
      `INSERT INTO legacy_approval_evidence (
         id, migration_run_id, project_id, phase_id, subject_entity_type,
         subject_entity_id, content_hash, graph_version,
         allocation_fingerprint, actor_type, actor_id, source_actor_text, approved_at,
         current_at_import, source_hash, created_at
       ) VALUES (
         $1,$2,$3,$4,'phase',$4,$5,$6,$7,'legacy',NULL,$8,$9,$10,$11,$12
       )`,
      [
        approval.id,
        context.migration_run_id,
        approval.project_id,
        approval.phase_id,
        approval.content_hash,
        approval.graph_version,
        approval.allocation_fingerprint,
        approval.source_actor_text,
        approval.approved_at,
        approval.current_at_freeze,
        approval.source_hash,
        context.occurred_at,
      ],
    );
  }

  private async insertImportEvent(
    plan: LegacyProjectImportPlan,
    mapping: LegacyImportIdMapping,
    context: LegacyProjectImportPersistenceContext,
    importBatchId: string,
    streamVersion: number,
  ): Promise<string | null> {
    const scope = eventScope(mapping, plan);
    if (scope === null) return null;
    const eventId = deterministicId("event", {
      migration_run_id: context.migration_run_id,
      import_batch_id: importBatchId,
      kind: "legacy_entity_imported",
      v2_entity_type: mapping.v2_entity_type,
      v2_id: mapping.v2_id,
    });
    const event = V2DomainEvent.parse({
      schema_version: 2,
      event_id: eventId,
      stream_type: "migration",
      stream_id: importBatchId,
      stream_version: streamVersion,
      event_type: "legacy_entity_imported",
      project_id: plan.project.id,
      phase_id: scope.phase_id,
      task_id: scope.task_id,
      actor_type: "legacy",
      actor_id: null,
      correlation_id: importBatchId,
      causation_id: null,
      occurred_at: context.occurred_at,
      payload: {
        kind: "legacy_entity_imported",
        migration_run_id: context.migration_run_id,
        import_batch_id: importBatchId,
        legacy_entity_type: mapping.legacy_entity_type,
        legacy_entity_id: mapping.legacy_id,
        v2_entity_type: scope.v2_entity_type,
        v2_entity_id: mapping.v2_id,
        source_hash: mapping.source_hash,
      },
    });
    await this.sql.query(
      `INSERT INTO domain_events (
         event_id, stream_type, stream_id, stream_version, event_type,
         schema_version, project_id, phase_id, task_id, actor_type, actor_id,
         correlation_id, causation_id, occurred_at, payload
       ) VALUES (
         $1,$2,$3,$4,$5,2,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb
       )`,
      [
        event.event_id,
        event.stream_type,
        event.stream_id,
        event.stream_version,
        event.event_type,
        event.project_id,
        event.phase_id,
        event.task_id,
        event.actor_type,
        event.actor_id,
        event.correlation_id,
        event.causation_id,
        event.occurred_at,
        json(event.payload),
      ],
    );
    return event.event_id;
  }

  async insertMappingsAndImportEvents(
    plan: LegacyProjectImportPlan,
    context: LegacyProjectImportPersistenceContext,
  ): Promise<void> {
    const importBatchId = `migration-batch:${context.migration_run_id}:project:${plan.project.id}`;
    let streamVersion = 0;
    for (const mapping of plan.id_mappings) {
      const hasImportEvent = eventScope(mapping, plan) !== null;
      if (hasImportEvent) streamVersion += 1;
      const importEventId = await this.insertImportEvent(
        plan,
        mapping,
        context,
        importBatchId,
        streamVersion,
      );
      const task = plan.tasks.find((candidate) => candidate.id === mapping.v2_id);
      const assignment = plan.agent_assignments.find((candidate) => candidate.id === mapping.v2_id);
      await this.sql.query(
        `INSERT INTO legacy_id_mappings (
           migration_run_id, legacy_entity_type, legacy_id, v2_entity_type,
           v2_id, source_hash, source_metadata, import_event_id, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [
          context.migration_run_id,
          mapping.legacy_entity_type,
          mapping.legacy_id,
          mapping.v2_entity_type,
          mapping.v2_id,
          mapping.source_hash,
          json({
            ...(task === undefined
              ? {}
              : {
                  source_kind: task.source_kind,
                  legacy_module: task.legacy_module,
                  legacy_graph_node: task.legacy_graph_node,
                  legacy_acceptance: task.legacy_acceptance,
                }),
            ...(assignment === undefined
              ? {}
              : {
                  legacy_worker_count: assignment.legacy_worker_count,
                  legacy_source: assignment.legacy_source,
                }),
          }),
          importEventId,
          context.occurred_at,
        ],
      );
    }
  }

  async applyCancelledTaskTransitions(
    plan: LegacyProjectImportPlan,
    context: LegacyProjectImportPersistenceContext,
  ): Promise<void> {
    const lifecycle = new SqlV2ApplicationTransaction(this.sql);
    for (const task of plan.tasks.filter((candidate) => candidate.state === "cancelled")) {
      const row = await lifecycle.lockTaskLifecycle(task.id);
      if (row === null) {
        throw new Error(`legacy task ${task.id} disappeared before cancellation`);
      }
      const event = V2TaskTransitionEvent.parse({
        schema_version: 2,
        event_id: cancelledTaskTransitionEventId(context.migration_run_id, task.id),
        task_id: task.id,
        lifecycle_version: 1,
        occurred_at: context.occurred_at,
        from: "pending",
        to: "cancelled",
        reason: "legacy plan module is absent from the current graph",
      });
      await lifecycle.commitTaskLifecycleTransition({
        row,
        event,
        actor: {
          actor_type: "legacy",
          actor_id: null,
          correlation_id: `migration:${context.migration_run_id}:project:${plan.project.id}`,
          causation_id: null,
          occurred_at: context.occurred_at,
        },
      });
    }
  }

  async appendProjectImportAudit(
    plan: LegacyProjectImportPlan,
    context: LegacyProjectImportPersistenceContext,
  ): Promise<void> {
    await this.sql.query(
      `INSERT INTO audit_events (
         audit_id, schema_version, audit_type, project_id, phase_id, task_id,
         actor_type, actor_id, outcome, severity, correlation_id, causation_id,
         occurred_at, targets, summary, details, redaction_applied
       ) VALUES (
         $1,2,'legacy.project_imported',$2,$3,NULL,'legacy',NULL,
         'succeeded','info',$4,NULL,$5,$6::jsonb,$7,$8::jsonb,true
       )`,
      [
        deterministicId("audit", {
          migration_run_id: context.migration_run_id,
          project_id: plan.project.id,
          kind: "legacy.project_imported",
        }),
        plan.project.id,
        plan.phase?.id ?? null,
        `migration:${context.migration_run_id}:project:${plan.project.id}`,
        context.occurred_at,
        json([{ entity_type: "project", entity_id: plan.project.id }]),
        `Legacy project ${plan.project.id} imported`,
        json({
          source_hash: plan.source_hash,
          plan_hash: plan.reconciliation.plan_hash,
          graph_hash: plan.reconciliation.graph_hash,
          approval_hash: plan.reconciliation.approval_hash,
          source_counts: plan.reconciliation.counts,
          imported_counts: {
            tasks: plan.tasks.length,
            dependencies: plan.task_dependencies.length,
            assignments: plan.agent_assignments.length,
            findings: plan.findings.length,
          },
          fresh_v2_approval_required: plan.strategy !== null,
        }),
      ],
    );
  }

  async completeImport(
    plan: LegacyProjectImportPlan,
    run: LegacyProjectMigrationRun,
    context: LegacyProjectImportPersistenceContext,
  ): Promise<void> {
    await this.sql.query(
      `INSERT INTO legacy_project_imports (
         migration_run_id, project_id, source_hash, plan_hash, graph_hash,
         approval_hash, graph_version, source_counts, import_hash,
         archive_id, imported_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
      [
        context.migration_run_id,
        plan.project.id,
        plan.source_hash,
        plan.reconciliation.plan_hash,
        plan.reconciliation.graph_hash,
        plan.reconciliation.approval_hash,
        plan.legacy_graph_version,
        json({
          ...plan.reconciliation.counts,
          imported_tasks: plan.tasks.length,
          imported_dependencies: plan.task_dependencies.length,
          imported_assignments: plan.agent_assignments.length,
          findings: plan.findings.length,
        }),
        context.import_hash,
        run.projects_archive_id,
        context.occurred_at,
      ],
    );
  }
}
