import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  ForeignKeyBuilder,
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();
const aggregateVersion = () => integer("aggregate_version").notNull().default(1);
const schemaVersion = () => integer("schema_version").notNull().default(2);
const money = (name: string) => numeric(name, { precision: 18, scale: 6 }).notNull().default("0");
const bytea = customType<{ data: Uint8Array }>({
  dataType: () => "bytea",
});
const lazyForeignKey = (
  name: string,
  columns: () => AnyPgColumn[],
  foreignColumns: () => AnyPgColumn[],
) => new ForeignKeyBuilder(() => ({ name, columns: columns(), foreignColumns: foreignColumns() }));

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    ...{
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
  },
  (table) => [
    uniqueIndex("users_username_unique").on(table.username),
    check("users_role_check", sql`${table.role} IN ('admin', 'member')`),
    check("users_status_check", sql`${table.status} IN ('active', 'disabled')`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_status_idx").on(table.userId, table.revokedAt, table.expiresAt),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull(),
    primaryRepositoryBindingId: text("primary_repository_binding_id").references(
      (): AnyPgColumn => repositoryBindings.id,
      { onDelete: "restrict" },
    ),
    currentArchitectureRevisionId: text("current_architecture_revision_id").references(
      (): AnyPgColumn => architectureRevisions.id,
      { onDelete: "restrict" },
    ),
    maxExecutingPhases: integer("max_executing_phases").notNull().default(1),
    maxConcurrentTasks: integer("max_concurrent_tasks").notNull().default(1),
    assignmentPolicyRef: text("assignment_policy_ref").notNull(),
    verificationPolicyRef: text("verification_policy_ref").notNull(),
    budgetPolicyRef: text("budget_policy_ref").notNull(),
    aggregateVersion: aggregateVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    lazyForeignKey(
      "projects_primary_repository_scope_fk",
      (): AnyPgColumn[] => [table.id, table.primaryRepositoryBindingId],
      (): AnyPgColumn[] => [repositoryBindings.projectId, repositoryBindings.id],
    ).onDelete("restrict"),
    lazyForeignKey(
      "projects_current_architecture_scope_fk",
      (): AnyPgColumn[] => [table.id, table.currentArchitectureRevisionId],
      (): AnyPgColumn[] => [architectureRevisions.projectId, architectureRevisions.id],
    ).onDelete("restrict"),
    check(
      "projects_status_check",
      sql`${table.status} IN ('initializing', 'active', 'paused', 'blocked', 'completed', 'archived')`,
    ),
    check("projects_max_executing_phases_check", sql`${table.maxExecutingPhases} > 0`),
    check("projects_max_concurrent_tasks_check", sql`${table.maxConcurrentTasks} > 0`),
  ],
);

export const repositoryBindings = pgTable(
  "repository_bindings",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    bindingType: text("binding_type").notNull(),
    status: text("status").notNull(),
    runnerId: text("runner_id").notNull(),
    workspaceId: text("workspace_id"),
    repositoryId: text("repository_id").notNull(),
    repositoryDisplayName: text("repository_display_name").notNull(),
    githubInstallationId: text("github_installation_id"),
    githubOwner: text("github_owner"),
    githubName: text("github_name"),
    grantedPermissions: jsonb("granted_permissions").notNull().default({}),
    defaultBranch: text("default_branch").notNull(),
    observedHead: text("observed_head"),
    verificationPolicyRef: text("verification_policy_ref").notNull(),
    repositoryHealth: text("repository_health").notNull().default("unknown"),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id"),
    aggregateVersion: aggregateVersion(),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true, mode: "string" }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("repository_bindings_project_id_id_unique").on(table.projectId, table.id),
    index("repository_bindings_project_status_idx").on(table.projectId, table.status),
    check(
      "repository_bindings_type_check",
      sql`${table.bindingType} IN ('local_runner', 'github')`,
    ),
    check(
      "repository_bindings_status_check",
      sql`${table.status} IN ('unverified_candidate', 'validating', 'connected', 'degraded', 'disconnected', 'revoked')`,
    ),
    check(
      "repository_bindings_health_check",
      sql`${table.repositoryHealth} IN ('unknown', 'healthy', 'degraded', 'unavailable')`,
    ),
    check(
      "repository_bindings_shape_check",
      sql`(
        (${table.bindingType} = 'local_runner' AND ${table.workspaceId} IS NOT NULL
          AND ${table.githubInstallationId} IS NULL)
        OR
        (${table.bindingType} = 'github' AND ${table.githubInstallationId} IS NOT NULL
          AND ${table.githubOwner} IS NOT NULL AND ${table.githubName} IS NOT NULL)
      )`,
    ),
  ],
);

export const phases = pgTable(
  "phases",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    objectiveSummary: text("objective_summary").notNull(),
    priority: integer("priority").notNull().default(0),
    status: text("status").notNull(),
    approvedStrategyVersionId: text("approved_strategy_version_id").references(
      (): AnyPgColumn => strategyVersions.id,
      { onDelete: "restrict" },
    ),
    approvedBudgetUsd: money("approved_budget_usd"),
    aggregateVersion: aggregateVersion(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    closureSummary: text("closure_summary"),
    closureEvidence: jsonb("closure_evidence").notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("phases_project_id_id_unique").on(table.projectId, table.id),
    index("phases_project_status_priority_idx").on(table.projectId, table.status, table.priority),
    lazyForeignKey(
      "phases_approved_strategy_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.id, table.approvedStrategyVersionId],
      (): AnyPgColumn[] => [
        strategyVersions.projectId,
        strategyVersions.phaseId,
        strategyVersions.id,
      ],
    ).onDelete("restrict"),
    check("phases_priority_check", sql`${table.priority} >= 0`),
    check(
      "phases_status_check",
      sql`${table.status} IN ('proposed', 'awaiting_approval', 'approved', 'active', 'blocked', 'completed', 'cancelled')`,
    ),
    check(
      "phases_active_strategy_check",
      sql`${table.status} <> 'active' OR ${table.approvedStrategyVersionId} IS NOT NULL`,
    ),
  ],
);

export const phaseDependencies = pgTable(
  "phase_dependencies",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    predecessorPhaseId: text("predecessor_phase_id").notNull(),
    successorPhaseId: text("successor_phase_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("phase_dependencies_edge_unique").on(
      table.projectId,
      table.predecessorPhaseId,
      table.successorPhaseId,
    ),
    foreignKey({
      name: "phase_dependencies_predecessor_fk",
      columns: [table.projectId, table.predecessorPhaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "phase_dependencies_successor_fk",
      columns: [table.projectId, table.successorPhaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("cascade"),
    check(
      "phase_dependencies_no_self_check",
      sql`${table.predecessorPhaseId} <> ${table.successorPhaseId}`,
    ),
  ],
);

export const strategyVersions = pgTable(
  "strategy_versions",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    phaseId: text("phase_id").notNull(),
    version: integer("version").notNull(),
    aggregateVersion: aggregateVersion(),
    status: text("status").notNull(),
    objective: text("objective").notNull(),
    content: jsonb("content").notNull(),
    convergence: text("convergence").notNull(),
    reviewRounds: integer("review_rounds").notNull().default(0),
    contentHash: text("content_hash").notNull(),
    approvalId: text("approval_id").references((): AnyPgColumn => approvals.id, {
      onDelete: "restrict",
    }),
    supersedesStrategyVersionId: text("supersedes_strategy_version_id").references(
      (): AnyPgColumn => strategyVersions.id,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("strategy_versions_phase_version_unique").on(table.phaseId, table.version),
    uniqueIndex("strategy_versions_project_phase_id_unique").on(
      table.projectId,
      table.phaseId,
      table.id,
    ),
    foreignKey({
      name: "strategy_versions_phase_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("cascade"),
    lazyForeignKey(
      "strategy_versions_approval_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.phaseId, table.approvalId],
      (): AnyPgColumn[] => [approvals.projectId, approvals.phaseId, approvals.id],
    ).onDelete("restrict"),
    lazyForeignKey(
      "strategy_versions_supersedes_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.phaseId, table.supersedesStrategyVersionId],
      (): AnyPgColumn[] => [
        strategyVersions.projectId,
        strategyVersions.phaseId,
        strategyVersions.id,
      ],
    ),
    check("strategy_versions_version_check", sql`${table.version} > 0`),
    check("strategy_versions_review_rounds_check", sql`${table.reviewRounds} >= 0`),
    check(
      "strategy_versions_status_check",
      sql`${table.status} IN ('draft', 'reviewing', 'awaiting_approval', 'approved', 'rejected', 'superseded')`,
    ),
    check(
      "strategy_versions_convergence_check",
      sql`${table.convergence} IN ('pending', 'converged', 'cap_reached', 'failed')`,
    ),
    check("strategy_versions_hash_check", sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
  ],
);

export const strategyReviews = pgTable(
  "strategy_reviews",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id")
      .notNull()
      .references(() => phases.id, { onDelete: "cascade" }),
    strategyVersionId: text("strategy_version_id")
      .notNull()
      .references(() => strategyVersions.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    reviewerProvider: text("reviewer_provider").notNull(),
    reviewerModel: text("reviewer_model").notNull(),
    findings: jsonb("findings").notNull().default([]),
    status: text("status").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("strategy_reviews_version_round_unique").on(table.strategyVersionId, table.round),
    foreignKey({
      name: "strategy_reviews_strategy_scope_fk",
      columns: [table.projectId, table.phaseId, table.strategyVersionId],
      foreignColumns: [strategyVersions.projectId, strategyVersions.phaseId, strategyVersions.id],
    }).onDelete("cascade"),
    check("strategy_reviews_round_check", sql`${table.round} > 0`),
  ],
);

export const objectives = pgTable(
  "objectives",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    phaseId: text("phase_id").notNull(),
    outcome: text("outcome").notNull(),
    successMeasures: jsonb("success_measures").notNull(),
    status: text("status").notNull(),
    order: integer("order").notNull().default(0),
    completionEvidence: jsonb("completion_evidence").notNull().default([]),
    aggregateVersion: aggregateVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("objectives_project_phase_id_unique").on(table.projectId, table.phaseId, table.id),
    index("objectives_phase_order_idx").on(table.phaseId, table.order),
    foreignKey({
      name: "objectives_phase_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("cascade"),
    check(
      "objectives_status_check",
      sql`${table.status} IN ('proposed', 'active', 'completed', 'cancelled')`,
    ),
    check("objectives_order_check", sql`${table.order} >= 0`),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    phaseId: text("phase_id").notNull(),
    objectiveId: text("objective_id").notNull(),
    strategyVersionId: text("strategy_version_id")
      .notNull()
      .references(() => strategyVersions.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    deliverables: jsonb("deliverables").notNull(),
    acceptanceCriteria: jsonb("acceptance_criteria").notNull(),
    complexity: text("complexity").notNull(),
    risk: text("risk").notNull(),
    requiredRoles: jsonb("required_roles").notNull(),
    requiredCapabilities: jsonb("required_capabilities").notNull().default([]),
    requiredInputs: jsonb("required_inputs").notNull().default([]),
    expectedOutputs: jsonb("expected_outputs").notNull(),
    environmentPolicyRef: text("environment_policy_ref").notNull(),
    verificationPolicyRef: text("verification_policy_ref").notNull(),
    state: text("state").notNull(),
    designatedAssignmentId: text("designated_assignment_id").references(
      (): AnyPgColumn => agentAssignments.id,
      { onDelete: "restrict" },
    ),
    designatedRunId: text("designated_run_id").references((): AnyPgColumn => agentRuns.id, {
      onDelete: "restrict",
    }),
    reviewEvidence: jsonb("review_evidence").notNull().default([]),
    completionEvidence: jsonb("completion_evidence").notNull().default([]),
    lifecycleVersion: integer("lifecycle_version").notNull().default(0),
    aggregateVersion: aggregateVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("tasks_project_phase_id_unique").on(table.projectId, table.phaseId, table.id),
    index("tasks_phase_state_idx").on(table.phaseId, table.state),
    foreignKey({
      name: "tasks_objective_scope_fk",
      columns: [table.projectId, table.phaseId, table.objectiveId],
      foreignColumns: [objectives.projectId, objectives.phaseId, objectives.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "tasks_strategy_scope_fk",
      columns: [table.projectId, table.phaseId, table.strategyVersionId],
      foreignColumns: [strategyVersions.projectId, strategyVersions.phaseId, strategyVersions.id],
    }).onDelete("restrict"),
    lazyForeignKey(
      "tasks_designated_assignment_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.phaseId, table.id, table.designatedAssignmentId],
      (): AnyPgColumn[] => [
        agentAssignments.projectId,
        agentAssignments.phaseId,
        agentAssignments.taskId,
        agentAssignments.id,
      ],
    ).onDelete("restrict"),
    lazyForeignKey(
      "tasks_designated_run_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.phaseId, table.id, table.designatedRunId],
      (): AnyPgColumn[] => [agentRuns.projectId, agentRuns.phaseId, agentRuns.taskId, agentRuns.id],
    ).onDelete("restrict"),
    check("tasks_complexity_check", sql`${table.complexity} IN ('S', 'M', 'L', 'XL')`),
    check("tasks_risk_check", sql`${table.risk} IN ('low', 'medium', 'high', 'critical')`),
    check(
      "tasks_state_check",
      sql`${table.state} IN ('pending', 'ready', 'assigned', 'in_progress', 'verifying', 'in_review', 'completed', 'blocked', 'failed', 'cancelled')`,
    ),
    check("tasks_lifecycle_version_check", sql`${table.lifecycleVersion} >= 0`),
    check(
      "tasks_lifecycle_origin_check",
      sql`${table.lifecycleVersion} > 0 OR ${table.state} = 'pending'`,
    ),
    check(
      "tasks_completed_at_check",
      sql`${table.state} <> 'completed' OR ${table.completedAt} IS NOT NULL`,
    ),
    check(
      "tasks_completed_evidence_check",
      sql`${table.state} <> 'completed'
        OR (jsonb_array_length(${table.reviewEvidence}) > 0
          AND jsonb_array_length(${table.completionEvidence}) > 0)`,
    ),
  ],
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    phaseId: text("phase_id").notNull(),
    predecessorTaskId: text("predecessor_task_id").notNull(),
    successorTaskId: text("successor_task_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("task_dependencies_edge_unique").on(
      table.projectId,
      table.phaseId,
      table.predecessorTaskId,
      table.successorTaskId,
    ),
    foreignKey({
      name: "task_dependencies_predecessor_fk",
      columns: [table.projectId, table.phaseId, table.predecessorTaskId],
      foreignColumns: [tasks.projectId, tasks.phaseId, tasks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "task_dependencies_successor_fk",
      columns: [table.projectId, table.phaseId, table.successorTaskId],
      foreignColumns: [tasks.projectId, tasks.phaseId, tasks.id],
    }).onDelete("cascade"),
    check(
      "task_dependencies_no_self_check",
      sql`${table.predecessorTaskId} <> ${table.successorTaskId}`,
    ),
  ],
);

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    provider: text("provider").notNull(),
    runtime: text("runtime").notNull(),
    model: text("model").notNull(),
    roles: jsonb("roles").notNull(),
    capabilities: jsonb("capabilities").notNull().default([]),
    contextLimitTokens: integer("context_limit_tokens").notNull(),
    securityRestrictions: jsonb("security_restrictions").notNull().default([]),
    status: text("status").notNull(),
    activeWorkload: integer("active_workload").notNull().default(0),
    costMetadata: jsonb("cost_metadata").notNull(),
    aggregateVersion: aggregateVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "agent_profiles_status_check",
      sql`${table.status} IN ('available', 'busy', 'offline', 'disabled')`,
    ),
    check("agent_profiles_context_limit_check", sql`${table.contextLimitTokens} > 0`),
    check("agent_profiles_workload_check", sql`${table.activeWorkload} >= 0`),
  ],
);

export const agentAssignments = pgTable(
  "agent_assignments",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    phaseId: text("phase_id").notNull(),
    taskId: text("task_id").notNull(),
    agentProfileId: text("agent_profile_id")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    rationale: text("rationale").notNull(),
    rationaleFactors: jsonb("rationale_factors").notNull(),
    budgetLimitUsd: money("budget_limit_usd"),
    reviewerAgentProfileId: text("reviewer_agent_profile_id").references(() => agentProfiles.id, {
      onDelete: "restrict",
    }),
    allocationPolicyRef: text("allocation_policy_ref").notNull(),
    aggregateVersion: aggregateVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("agent_assignments_project_phase_task_id_unique").on(
      table.projectId,
      table.phaseId,
      table.taskId,
      table.id,
    ),
    index("agent_assignments_task_status_idx").on(table.taskId, table.status),
    foreignKey({
      name: "agent_assignments_task_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.phaseId, tasks.id],
    }).onDelete("cascade"),
    check(
      "agent_assignments_status_check",
      sql`${table.status} IN ('proposed', 'active', 'completed', 'cancelled', 'superseded')`,
    ),
    check("agent_assignments_rationale_check", sql`length(trim(${table.rationale})) > 0`),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    phaseId: text("phase_id").notNull(),
    taskId: text("task_id").notNull(),
    assignmentId: text("assignment_id").notNull(),
    attempt: integer("attempt").notNull(),
    state: text("state").notNull(),
    isDesignated: boolean("is_designated").notNull().default(false),
    runnerId: text("runner_id"),
    runtimeSessionId: text("runtime_session_id"),
    repositoryBindingId: text("repository_binding_id")
      .notNull()
      .references(() => repositoryBindings.id, { onDelete: "restrict" }),
    expectedRevision: text("expected_revision").notNull(),
    worktreeRef: text("worktree_ref"),
    commitSha: text("commit_sha"),
    usageInputTokens: bigint("usage_input_tokens", { mode: "number" }).notNull().default(0),
    usageOutputTokens: bigint("usage_output_tokens", { mode: "number" }).notNull().default(0),
    usageCostUsd: money("usage_cost_usd"),
    artifacts: jsonb("artifacts").notNull().default([]),
    verificationStatus: text("verification_status").notNull().default("pending"),
    resultSummary: text("result_summary"),
    failureCode: text("failure_code"),
    failureDetail: text("failure_detail"),
    supersededAt: timestamp("superseded_at", { withTimezone: true, mode: "string" }),
    supersededByRunId: text("superseded_by_run_id").references((): AnyPgColumn => agentRuns.id, {
      onDelete: "restrict",
    }),
    lifecycleVersion: integer("lifecycle_version").notNull().default(0),
    aggregateVersion: aggregateVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("agent_runs_project_phase_task_id_unique").on(
      table.projectId,
      table.phaseId,
      table.taskId,
      table.id,
    ),
    uniqueIndex("agent_runs_task_attempt_unique").on(table.taskId, table.attempt),
    uniqueIndex("agent_runs_one_designated_per_task_unique")
      .on(table.taskId)
      .where(sql`${table.isDesignated} = true AND ${table.supersededAt} IS NULL`),
    foreignKey({
      name: "agent_runs_assignment_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId, table.assignmentId],
      foreignColumns: [
        agentAssignments.projectId,
        agentAssignments.phaseId,
        agentAssignments.taskId,
        agentAssignments.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "agent_runs_repository_scope_fk",
      columns: [table.projectId, table.repositoryBindingId],
      foreignColumns: [repositoryBindings.projectId, repositoryBindings.id],
    }).onDelete("restrict"),
    lazyForeignKey(
      "agent_runs_superseded_by_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.phaseId, table.taskId, table.supersededByRunId],
      (): AnyPgColumn[] => [agentRuns.projectId, agentRuns.phaseId, agentRuns.taskId, agentRuns.id],
    ).onDelete("restrict"),
    check("agent_runs_attempt_check", sql`${table.attempt} > 0`),
    check(
      "agent_runs_state_check",
      sql`${table.state} IN ('created', 'dispatched', 'running', 'verifying', 'succeeded', 'failed', 'cancelled', 'expired')`,
    ),
    check("agent_runs_lifecycle_version_check", sql`${table.lifecycleVersion} >= 0`),
    check(
      "agent_runs_lifecycle_origin_check",
      sql`${table.lifecycleVersion} > 0 OR ${table.state} = 'created'`,
    ),
    check(
      "agent_runs_verification_status_check",
      sql`${table.verificationStatus} IN ('pending', 'passed', 'failed')`,
    ),
    check(
      "agent_runs_supersession_shape_check",
      sql`(${table.supersededAt} IS NULL) = (${table.supersededByRunId} IS NULL)`,
    ),
    check(
      "agent_runs_designated_not_superseded_check",
      sql`NOT (${table.isDesignated} AND ${table.supersededAt} IS NOT NULL)`,
    ),
  ],
);

export const decisionPoints = pgTable(
  "decision_points",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    scopeEntityType: text("scope_entity_type").notNull(),
    scopeEntityId: text("scope_entity_id").notNull(),
    reasonClass: text("reason_class").notNull(),
    sourceInstanceId: text("source_instance_id").notNull(),
    conditionKey: text("condition_key").notNull(),
    conditionFingerprint: text("condition_fingerprint").notNull(),
    conditionRevision: integer("condition_revision").notNull().default(1),
    question: text("question").notNull(),
    context: text("context").notNull(),
    options: jsonb("options").notNull(),
    recommendationOptionId: text("recommendation_option_id").notNull(),
    urgency: text("urgency").notNull(),
    blockingScope: jsonb("blocking_scope"),
    status: text("status").notNull(),
    supersedesDecisionPointId: text("supersedes_decision_point_id").references(
      (): AnyPgColumn => decisionPoints.id,
    ),
    supersededByDecisionPointId: text("superseded_by_decision_point_id").references(
      (): AnyPgColumn => decisionPoints.id,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("decision_points_project_id_id_unique").on(table.projectId, table.id),
    uniqueIndex("decision_points_project_phase_id_unique").on(
      table.projectId,
      table.phaseId,
      table.id,
    ),
    uniqueIndex("decision_points_project_condition_id_unique").on(
      table.projectId,
      table.conditionKey,
      table.id,
    ),
    uniqueIndex("decision_points_open_condition_unique")
      .on(table.conditionKey)
      .where(sql`${table.status} = 'open'`),
    index("decision_points_project_status_idx").on(table.projectId, table.status, table.urgency),
    foreignKey({
      name: "decision_points_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "decision_points_task_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.phaseId, tasks.id],
    }).onDelete("cascade"),
    lazyForeignKey(
      "decision_points_supersedes_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.conditionKey, table.supersedesDecisionPointId],
      (): AnyPgColumn[] => [
        decisionPoints.projectId,
        decisionPoints.conditionKey,
        decisionPoints.id,
      ],
    ),
    lazyForeignKey(
      "decision_points_superseded_by_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.conditionKey, table.supersededByDecisionPointId],
      (): AnyPgColumn[] => [
        decisionPoints.projectId,
        decisionPoints.conditionKey,
        decisionPoints.id,
      ],
    ),
    check(
      "decision_points_scope_shape_check",
      sql`${table.phaseId} IS NOT NULL OR ${table.taskId} IS NULL`,
    ),
    check("decision_points_hash_check", sql`${table.conditionFingerprint} ~ '^[a-f0-9]{64}$'`),
    check(
      "decision_points_status_check",
      sql`${table.status} IN ('open', 'resolved', 'dismissed', 'superseded')`,
    ),
    check(
      "decision_points_urgency_check",
      sql`${table.urgency} IN ('low', 'normal', 'high', 'critical')`,
    ),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    subjectEntityType: text("subject_entity_type").notNull(),
    subjectEntityId: text("subject_entity_id").notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }).notNull(),
    supersededByApprovalId: text("superseded_by_approval_id").references(
      (): AnyPgColumn => approvals.id,
    ),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("approvals_project_phase_id_unique").on(table.projectId, table.phaseId, table.id),
    uniqueIndex("approvals_project_id_id_unique").on(table.projectId, table.id),
    uniqueIndex("approvals_project_subject_id_unique").on(
      table.projectId,
      table.subjectEntityType,
      table.subjectEntityId,
      table.id,
    ),
    index("approvals_subject_status_idx").on(
      table.subjectEntityType,
      table.subjectEntityId,
      table.status,
    ),
    foreignKey({
      name: "approvals_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("cascade"),
    lazyForeignKey(
      "approvals_superseded_by_scope_fk",
      (): AnyPgColumn[] => [
        table.projectId,
        table.subjectEntityType,
        table.subjectEntityId,
        table.supersededByApprovalId,
      ],
      (): AnyPgColumn[] => [
        approvals.projectId,
        approvals.subjectEntityType,
        approvals.subjectEntityId,
        approvals.id,
      ],
    ),
    check("approvals_hash_check", sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
    check("approvals_status_check", sql`${table.status} IN ('active', 'superseded', 'revoked')`),
  ],
);

export const decisionRecords = pgTable(
  "decision_records",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "cascade" }),
    decisionPointId: text("decision_point_id").references(() => decisionPoints.id, {
      onDelete: "restrict",
    }),
    title: text("title").notNull(),
    rationale: text("rationale").notNull(),
    selectedOptionId: text("selected_option_id"),
    status: text("status").notNull(),
    decidedBy: text("decided_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    approvalId: text("approval_id")
      .notNull()
      .references(() => approvals.id, { onDelete: "restrict" }),
    affectedEntities: jsonb("affected_entities").notNull().default([]),
    supersedesDecisionRecordId: text("supersedes_decision_record_id").references(
      (): AnyPgColumn => decisionRecords.id,
    ),
    supersededByDecisionRecordId: text("superseded_by_decision_record_id").references(
      (): AnyPgColumn => decisionRecords.id,
    ),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("decision_records_project_id_id_unique").on(table.projectId, table.id),
    foreignKey({
      name: "decision_records_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "decision_records_decision_point_scope_fk",
      columns: [table.projectId, table.decisionPointId],
      foreignColumns: [decisionPoints.projectId, decisionPoints.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "decision_records_approval_scope_fk",
      columns: [table.projectId, table.approvalId],
      foreignColumns: [approvals.projectId, approvals.id],
    }).onDelete("restrict"),
    lazyForeignKey(
      "decision_records_supersedes_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.supersedesDecisionRecordId],
      (): AnyPgColumn[] => [decisionRecords.projectId, decisionRecords.id],
    ),
    lazyForeignKey(
      "decision_records_superseded_by_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.supersededByDecisionRecordId],
      (): AnyPgColumn[] => [decisionRecords.projectId, decisionRecords.id],
    ),
    check("decision_records_status_check", sql`${table.status} IN ('active', 'obsolete')`),
  ],
);

export const projectMemoryEntries = pgTable(
  "project_memory_entries",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    content: text("content").notNull(),
    provenance: text("provenance").notNull(),
    sourceRef: jsonb("source_ref"),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    approvedByHuman: boolean("approved_by_human").notNull().default(false),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "restrict" }),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    supersedesMemoryEntryId: text("supersedes_memory_entry_id").references(
      (): AnyPgColumn => projectMemoryEntries.id,
    ),
    supersededByMemoryEntryId: text("superseded_by_memory_entry_id").references(
      (): AnyPgColumn => projectMemoryEntries.id,
    ),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("project_memory_project_id_id_unique").on(table.projectId, table.id),
    index("project_memory_active_scope_idx").on(
      table.projectId,
      table.phaseId,
      table.taskId,
      table.status,
    ),
    foreignKey({
      name: "project_memory_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "project_memory_task_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.phaseId, tasks.id],
    }).onDelete("cascade"),
    lazyForeignKey(
      "project_memory_supersedes_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.supersedesMemoryEntryId],
      (): AnyPgColumn[] => [projectMemoryEntries.projectId, projectMemoryEntries.id],
    ),
    lazyForeignKey(
      "project_memory_superseded_by_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.supersededByMemoryEntryId],
      (): AnyPgColumn[] => [projectMemoryEntries.projectId, projectMemoryEntries.id],
    ),
    check(
      "project_memory_scope_shape_check",
      sql`${table.phaseId} IS NOT NULL OR ${table.taskId} IS NULL`,
    ),
    check(
      "project_memory_category_check",
      sql`${table.category} IN ('directive', 'constraint', 'decision', 'lesson', 'architecture', 'phase_completion', 'repository_fact')`,
    ),
    check("project_memory_status_check", sql`${table.status} IN ('active', 'obsolete')`),
    check(
      "project_memory_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check(
      "project_memory_human_approval_check",
      sql`${table.category} NOT IN ('directive', 'decision')
        OR (${table.approvedByHuman} AND ${table.approvedBy} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)`,
    ),
  ],
);

export const architectureRevisions = pgTable(
  "architecture_revisions",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    architectureArtifactId: text("architecture_artifact_id")
      .notNull()
      .references((): AnyPgColumn => artifacts.id, { onDelete: "restrict" }),
    repositoryRevision: text("repository_revision").notNull(),
    provenanceActorType: text("provenance_actor_type").notNull(),
    provenanceActorId: text("provenance_actor_id"),
    approvalId: text("approval_id").references(() => approvals.id, { onDelete: "restrict" }),
    supersedesArchitectureRevisionId: text("supersedes_architecture_revision_id").references(
      (): AnyPgColumn => architectureRevisions.id,
    ),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("architecture_revisions_project_revision_unique").on(
      table.projectId,
      table.revision,
    ),
    uniqueIndex("architecture_revisions_project_id_id_unique").on(table.projectId, table.id),
    foreignKey({
      name: "architecture_revisions_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("cascade"),
    lazyForeignKey(
      "architecture_revisions_artifact_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.architectureArtifactId],
      (): AnyPgColumn[] => [artifacts.projectId, artifacts.id],
    ).onDelete("restrict"),
    foreignKey({
      name: "architecture_revisions_approval_scope_fk",
      columns: [table.projectId, table.approvalId],
      foreignColumns: [approvals.projectId, approvals.id],
    }).onDelete("restrict"),
    lazyForeignKey(
      "architecture_revisions_supersedes_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.supersedesArchitectureRevisionId],
      (): AnyPgColumn[] => [architectureRevisions.projectId, architectureRevisions.id],
    ),
    check("architecture_revisions_revision_check", sql`${table.revision} > 0`),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => agentRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    mediaType: text("media_type").notNull(),
    storageRef: text("storage_ref").notNull(),
    contentHash: text("content_hash").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    provenanceActorType: text("provenance_actor_type").notNull(),
    provenanceActorId: text("provenance_actor_id"),
    redactionStatus: text("redaction_status").notNull(),
    retentionUntil: timestamp("retention_until", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("artifacts_content_storage_unique").on(table.contentHash, table.storageRef),
    uniqueIndex("artifacts_project_id_id_unique").on(table.projectId, table.id),
    index("artifacts_run_kind_idx").on(table.runId, table.kind),
    foreignKey({
      name: "artifacts_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "artifacts_task_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.phaseId, tasks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "artifacts_run_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId, table.runId],
      foreignColumns: [agentRuns.projectId, agentRuns.phaseId, agentRuns.taskId, agentRuns.id],
    }).onDelete("cascade"),
    check(
      "artifacts_scope_shape_check",
      sql`(${table.phaseId} IS NOT NULL OR (${table.taskId} IS NULL AND ${table.runId} IS NULL))
        AND (${table.taskId} IS NOT NULL OR ${table.runId} IS NULL)`,
    ),
    check("artifacts_hash_check", sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
    check("artifacts_byte_size_check", sql`${table.byteSize} >= 0`),
  ],
);

export const verificationResults = pgTable(
  "verification_results",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id")
      .notNull()
      .references(() => phases.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    repositoryBindingId: text("repository_binding_id")
      .notNull()
      .references(() => repositoryBindings.id, { onDelete: "restrict" }),
    commitSha: text("commit_sha").notNull(),
    verificationPolicyRef: text("verification_policy_ref").notNull(),
    passed: boolean("passed").notNull(),
    commandResults: jsonb("command_results").notNull(),
    evidence: jsonb("evidence").notNull(),
    producedByRunnerId: text("produced_by_runner_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("verification_results_run_created_idx").on(table.runId, table.createdAt),
    foreignKey({
      name: "verification_results_run_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId, table.runId],
      foreignColumns: [agentRuns.projectId, agentRuns.phaseId, agentRuns.taskId, agentRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "verification_results_repository_scope_fk",
      columns: [table.projectId, table.repositoryBindingId],
      foreignColumns: [repositoryBindings.projectId, repositoryBindings.id],
    }).onDelete("restrict"),
  ],
);

export const budgetAllocations = pgTable(
  "budget_allocations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "cascade" }),
    amountUsd: money("amount_usd"),
    spentUsd: money("spent_usd"),
    reservedUsd: money("reserved_usd"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "budget_allocations_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("cascade"),
    check(
      "budget_allocations_balance_check",
      sql`${table.spentUsd} + ${table.reservedUsd} <= ${table.amountUsd}`,
    ),
  ],
);

export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id")
      .notNull()
      .references(() => phases.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    amountUsd: money("amount_usd"),
    settledUsd: money("settled_usd"),
    releasedUsd: money("released_usd"),
    retainedUsd: money("retained_usd"),
    status: text("status").notNull(),
    resolutionOutcome: text("resolution_outcome"),
    version: integer("version").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("budget_reservations_status_expiry_idx").on(table.status, table.expiresAt),
    foreignKey({
      name: "budget_reservations_run_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId, table.runId],
      foreignColumns: [agentRuns.projectId, agentRuns.phaseId, agentRuns.taskId, agentRuns.id],
    }).onDelete("cascade"),
    check(
      "budget_reservations_status_check",
      sql`${table.status} IN ('active', 'retained_ambiguous', 'settled', 'released')`,
    ),
    check(
      "budget_reservations_balance_check",
      sql`(
        ${table.status} = 'active'
        AND ${table.settledUsd} = 0
        AND ${table.releasedUsd} = 0
        AND ${table.retainedUsd} = 0
      ) OR (
        ${table.status} <> 'active'
        AND ${table.settledUsd} + ${table.releasedUsd} + ${table.retainedUsd} = ${table.amountUsd}
      )`,
    ),
    check(
      "budget_reservations_terminal_shape_check",
      sql`(
        ${table.status} = 'active'
      ) OR (
        ${table.status} = 'retained_ambiguous'
        AND ${table.settledUsd} = 0
        AND ${table.releasedUsd} = 0
        AND ${table.retainedUsd} = ${table.amountUsd}
      ) OR (
        ${table.status} = 'settled'
        AND ${table.retainedUsd} = 0
      ) OR (
        ${table.status} = 'released'
        AND ${table.settledUsd} = 0
        AND ${table.retainedUsd} = 0
        AND ${table.releasedUsd} = ${table.amountUsd}
      )`,
    ),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => agentRuns.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costUsd: money("cost_usd"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    index("usage_events_project_time_idx").on(table.projectId, table.occurredAt),
    foreignKey({
      name: "usage_events_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "usage_events_task_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.phaseId, tasks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "usage_events_run_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId, table.runId],
      foreignColumns: [agentRuns.projectId, agentRuns.phaseId, agentRuns.taskId, agentRuns.id],
    }).onDelete("cascade"),
    check(
      "usage_events_scope_shape_check",
      sql`(${table.phaseId} IS NOT NULL OR (${table.taskId} IS NULL AND ${table.runId} IS NULL))
        AND (${table.taskId} IS NOT NULL OR ${table.runId} IS NULL)`,
    ),
  ],
);

export const commands = pgTable(
  "commands",
  {
    commandId: text("command_id").primaryKey(),
    schemaVersion: schemaVersion(),
    dispatchJobId: text("dispatch_job_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id")
      .notNull()
      .references(() => phases.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    runnerId: text("runner_id").notNull(),
    runnerGeneration: integer("runner_generation").notNull(),
    kind: text("kind").notNull(),
    envelope: jsonb("envelope").notNull(),
    status: text("status").notNull().default("queued"),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("commands_dispatch_job_unique").on(table.dispatchJobId),
    uniqueIndex("commands_project_phase_task_run_command_unique").on(
      table.projectId,
      table.phaseId,
      table.taskId,
      table.runId,
      table.commandId,
    ),
    foreignKey({
      name: "commands_run_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId, table.runId],
      foreignColumns: [agentRuns.projectId, agentRuns.phaseId, agentRuns.taskId, agentRuns.id],
    }).onDelete("cascade"),
    check("commands_runner_generation_check", sql`${table.runnerGeneration} >= 0`),
  ],
);

export const dispatchJobs = pgTable(
  "dispatch_jobs",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id")
      .notNull()
      .references(() => phases.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    commandId: text("command_id")
      .notNull()
      .references(() => commands.commandId, { onDelete: "cascade" }),
    runnerId: text("runner_id").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("dispatch_jobs_command_unique").on(table.commandId),
    index("dispatch_jobs_claim_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
    foreignKey({
      name: "dispatch_jobs_command_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId, table.runId, table.commandId],
      foreignColumns: [
        commands.projectId,
        commands.phaseId,
        commands.taskId,
        commands.runId,
        commands.commandId,
      ],
    }).onDelete("cascade"),
    check(
      "dispatch_jobs_status_check",
      sql`${table.status} IN ('queued', 'leased', 'delivered', 'completed', 'dead_letter', 'cancelled')`,
    ),
    check("dispatch_jobs_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export const runnerEvents = pgTable(
  "runner_events",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    runnerId: text("runner_id").notNull(),
    runnerGeneration: integer("runner_generation").notNull(),
    runId: text("run_id").references(() => agentRuns.id, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("runner_events_runner_generation_sequence_unique").on(
      table.runnerId,
      table.runnerGeneration,
      table.sequence,
    ),
    index("runner_events_unapplied_idx").on(table.appliedAt, table.receivedAt),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    actorId: text("actor_id").notNull(),
    commandFamily: text("command_family").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    schemaVersion: schemaVersion(),
    requestFingerprint: text("request_fingerprint").notNull(),
    commandId: text("command_id").notNull(),
    status: text("status").notNull(),
    response: jsonb("response"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    retainUntil: timestamp("retain_until", { withTimezone: true, mode: "string" }).notNull(),
    asynchronousWorkUntil: timestamp("asynchronous_work_until", {
      withTimezone: true,
      mode: "string",
    }),
    rollbackWindowUntil: timestamp("rollback_window_until", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    primaryKey({
      name: "idempotency_records_scope_pk",
      columns: [table.actorId, table.commandFamily, table.idempotencyKey],
    }),
    uniqueIndex("idempotency_records_command_unique").on(table.commandId),
    index("idempotency_records_cleanup_idx").on(table.status, table.retainUntil),
    check(
      "idempotency_records_status_check",
      sql`${table.status} IN ('in_progress', 'committed_succeeded', 'committed_failed')`,
    ),
    check("idempotency_records_hash_check", sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$'`),
    check(
      "idempotency_records_response_check",
      sql`(${table.status} = 'in_progress' AND ${table.response} IS NULL)
        OR (${table.status} <> 'in_progress' AND ${table.response} IS NOT NULL)`,
    ),
  ],
);

export const domainEvents = pgTable(
  "domain_events",
  {
    eventId: text("event_id").primaryKey(),
    streamType: text("stream_type").notNull(),
    streamId: text("stream_id").notNull(),
    streamVersion: integer("stream_version").notNull(),
    eventType: text("event_type").notNull(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "restrict" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
    payload: jsonb("payload").notNull(),
  },
  (table) => [
    uniqueIndex("domain_events_stream_version_unique").on(
      table.streamType,
      table.streamId,
      table.streamVersion,
    ),
    index("domain_events_project_time_idx").on(table.projectId, table.occurredAt),
    index("domain_events_task_time_idx").on(table.taskId, table.occurredAt),
    foreignKey({
      name: "domain_events_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "domain_events_task_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.phaseId, tasks.id],
    }).onDelete("restrict"),
    check(
      "domain_events_scope_shape_check",
      sql`${table.phaseId} IS NOT NULL OR ${table.taskId} IS NULL`,
    ),
    check("domain_events_stream_version_check", sql`${table.streamVersion} > 0`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    auditId: text("audit_id").primaryKey(),
    schemaVersion: schemaVersion(),
    auditType: text("audit_type").notNull(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "restrict" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "restrict" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    outcome: text("outcome").notNull(),
    severity: text("severity").notNull(),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
    targets: jsonb("targets").notNull().default([]),
    summary: text("summary").notNull(),
    details: jsonb("details").notNull().default({}),
    redactionApplied: boolean("redaction_applied").notNull().default(false),
  },
  (table) => [
    index("audit_events_project_time_idx").on(table.projectId, table.occurredAt),
    index("audit_events_actor_time_idx").on(table.actorId, table.occurredAt),
    foreignKey({
      name: "audit_events_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "audit_events_task_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.phaseId, tasks.id],
    }).onDelete("restrict"),
    check(
      "audit_events_scope_shape_check",
      sql`(${table.projectId} IS NOT NULL OR (${table.phaseId} IS NULL AND ${table.taskId} IS NULL))
        AND (${table.phaseId} IS NOT NULL OR ${table.taskId} IS NULL)`,
    ),
  ],
);

export const lifecycleIntegrityFindings = pgTable(
  "lifecycle_integrity_findings",
  {
    id: text("id").primaryKey(),
    aggregateKind: text("aggregate_kind").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    details: jsonb("details").notNull(),
    status: text("status").notNull().default("open"),
    detectedAt: timestamp("detected_at", { withTimezone: true, mode: "string" }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("lifecycle_integrity_findings_open_unique")
      .on(table.aggregateKind, table.aggregateId)
      .where(sql`${table.status} = 'open'`),
    check(
      "lifecycle_integrity_findings_status_check",
      sql`${table.status} IN ('open', 'resolved')`,
    ),
  ],
);

export const projectionCheckpoints = pgTable(
  "projection_checkpoints",
  {
    projectionName: text("projection_name").notNull(),
    partitionKey: text("partition_key").notNull(),
    lastEventId: text("last_event_id"),
    lastOccurredAt: timestamp("last_occurred_at", { withTimezone: true, mode: "string" }),
    version: integer("version").notNull().default(1),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "projection_checkpoints_pk",
      columns: [table.projectionName, table.partitionKey],
    }),
  ],
);

export const migrationRuns = pgTable(
  "migration_runs",
  {
    id: text("id").primaryKey(),
    migrationName: text("migration_name").notNull(),
    sourceSnapshotHashes: jsonb("source_snapshot_hashes").notNull().default({}),
    sourceCounts: jsonb("source_counts").notNull().default({}),
    sourceFrozenAt: timestamp("source_frozen_at", { withTimezone: true, mode: "string" }),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    details: jsonb("details").notNull().default({}),
  },
  (table) => [
    uniqueIndex("migration_runs_name_started_unique").on(table.migrationName, table.startedAt),
  ],
);

export const legacyIdMappings = pgTable(
  "legacy_id_mappings",
  {
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    legacyEntityType: text("legacy_entity_type").notNull(),
    legacyId: text("legacy_id").notNull(),
    v2EntityType: text("v2_entity_type").notNull(),
    v2Id: text("v2_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "legacy_id_mappings_pk",
      columns: [table.migrationRunId, table.legacyEntityType, table.legacyId],
    }),
    uniqueIndex("legacy_id_mappings_v2_unique").on(
      table.migrationRunId,
      table.v2EntityType,
      table.v2Id,
    ),
  ],
);

export const phase1V2Schema = {
  users,
  sessions,
  projects,
  repositoryBindings,
  phases,
  phaseDependencies,
  strategyVersions,
  strategyReviews,
  objectives,
  tasks,
  taskDependencies,
  agentProfiles,
  agentAssignments,
  agentRuns,
  decisionPoints,
  approvals,
  decisionRecords,
  projectMemoryEntries,
  architectureRevisions,
  artifacts,
  verificationResults,
  budgetAllocations,
  budgetReservations,
  usageEvents,
  commands,
  dispatchJobs,
  runnerEvents,
  idempotencyRecords,
  domainEvents,
  auditEvents,
  lifecycleIntegrityFindings,
  projectionCheckpoints,
  migrationRuns,
  legacyIdMappings,
};

/**
 * Phase 2 overlays for tables whose forward migration adds preservation
 * columns. The Phase 1 declarations above remain frozen so the 0001 schema
 * evidence can still compare against the exact reviewed migration.
 */
export const phase2Users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("password_hash"),
    passwordHashScheme: text("password_hash_scheme"),
    passwordRehashedAt: timestamp("password_rehashed_at", {
      withTimezone: true,
      mode: "string",
    }),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    source: text("source").notNull().default("native"),
    sourceRecordId: text("source_record_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("users_username_unique").on(table.username),
    uniqueIndex("users_email_normalized_unique").on(sql`lower(${table.email})`),
    check("users_role_check", sql`${table.role} IN ('admin', 'member')`),
    check("users_status_check", sql`${table.status} IN ('active', 'invited', 'disabled')`),
    check(
      "users_password_hash_shape_check",
      sql`(${table.passwordHash} IS NULL) = (${table.passwordHashScheme} IS NULL)`,
    ),
    check(
      "users_active_password_check",
      sql`${table.status} <> 'active' OR ${table.passwordHash} IS NOT NULL`,
    ),
    check(
      "users_invited_password_check",
      sql`${table.status} <> 'invited' OR ${table.passwordHash} IS NULL`,
    ),
    check(
      "users_password_hash_scheme_check",
      sql`${table.passwordHashScheme} IS NULL
        OR ${table.passwordHashScheme} IN ('legacy-scrypt-v0', 'scrypt-v1')`,
    ),
    check("users_email_normalized_check", sql`${table.email} = lower(btrim(${table.email}))`),
    check("users_source_check", sql`${table.source} IN ('native', 'legacy_snapshot')`),
  ],
);

export const phase2Sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    tokenHashScheme: text("token_hash_scheme").notNull().default("sha256"),
    tokenKeyId: text("token_key_id"),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }),
    revocationReason: text("revocation_reason"),
    source: text("source").notNull().default("native"),
    sourceRecordId: text("source_record_id"),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_status_idx").on(table.userId, table.revokedAt, table.expiresAt),
    check("sessions_status_check", sql`${table.status} IN ('active', 'revoked', 'expired')`),
    check(
      "sessions_token_hash_scheme_check",
      sql`${table.tokenHashScheme} IN ('sha256', 'hmac-sha256')`,
    ),
    check(
      "sessions_token_key_check",
      sql`${table.tokenHashScheme} <> 'hmac-sha256' OR ${table.tokenKeyId} IS NOT NULL`,
    ),
    check(
      "sessions_revocation_shape_check",
      sql`${table.status} <> 'revoked' OR ${table.revokedAt} IS NOT NULL`,
    ),
    check("sessions_source_check", sql`${table.source} IN ('native', 'legacy_snapshot')`),
    check(
      "sessions_legacy_revoked_check",
      sql`${table.source} <> 'legacy_snapshot' OR ${table.status} = 'revoked'`,
    ),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    tokenHashScheme: text("token_hash_scheme").notNull().default("sha256"),
    tokenKeyId: text("token_key_id"),
    status: text("status").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    revocationReason: text("revocation_reason"),
    source: text("source").notNull().default("native"),
    sourceRecordId: text("source_record_id"),
  },
  (table) => [
    uniqueIndex("invitations_token_hash_unique").on(table.tokenHash),
    index("invitations_user_status_idx").on(table.userId, table.status, table.expiresAt),
    check(
      "invitations_status_check",
      sql`${table.status} IN ('pending', 'accepted', 'revoked', 'expired')`,
    ),
    check(
      "invitations_token_hash_scheme_check",
      sql`${table.tokenHashScheme} IN ('sha256', 'hmac-sha256')`,
    ),
    check(
      "invitations_token_key_check",
      sql`${table.tokenHashScheme} <> 'hmac-sha256' OR ${table.tokenKeyId} IS NOT NULL`,
    ),
    check(
      "invitations_accepted_shape_check",
      sql`${table.status} <> 'accepted' OR ${table.acceptedAt} IS NOT NULL`,
    ),
    check(
      "invitations_revoked_shape_check",
      sql`${table.status} <> 'revoked' OR ${table.revokedAt} IS NOT NULL`,
    ),
    check("invitations_source_check", sql`${table.source} IN ('native', 'legacy_snapshot')`),
    check(
      "invitations_legacy_revoked_check",
      sql`${table.source} <> 'legacy_snapshot' OR ${table.status} = 'revoked'`,
    ),
  ],
);

export const credentialHmacKeyRegistry = pgTable(
  "credential_hmac_key_registry",
  {
    keyId: text("key_id").primaryKey(),
    keyFingerprint: text("key_fingerprint").notNull(),
    status: text("status").notNull().default("active"),
    registeredAt: createdAt(),
    retiredAt: timestamp("retired_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    check(
      "credential_hmac_key_registry_fingerprint_check",
      sql`${table.keyFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "credential_hmac_key_registry_status_check",
      sql`${table.status} IN ('active', 'retired')`,
    ),
    check(
      "credential_hmac_key_registry_retirement_shape_check",
      sql`(
        (${table.status} = 'active' AND ${table.retiredAt} IS NULL)
        OR (${table.status} = 'retired' AND ${table.retiredAt} IS NOT NULL)
      )`,
    ),
  ],
);

export const archiveEncryptionKeyRegistry = pgTable(
  "archive_encryption_key_registry",
  {
    keyId: text("key_id").primaryKey(),
    keyFingerprint: text("key_fingerprint").notNull(),
    registeredAt: createdAt(),
  },
  (table) => [
    uniqueIndex("archive_encryption_key_registry_fingerprint_unique").on(table.keyFingerprint),
    uniqueIndex("archive_encryption_key_registry_identity_unique").on(
      table.keyId,
      table.keyFingerprint,
    ),
    check(
      "archive_encryption_key_registry_fingerprint_check",
      sql`${table.keyFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const projectPlanningPreferences = pgTable(
  "project_planning_preferences",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "restrict" }),
    pmProvider: text("pm_provider").notNull(),
    pmModel: text("pm_model"),
    reviewerProvider: text("reviewer_provider").notNull(),
    source: text("source").notNull().default("native"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "project_planning_preferences_pm_provider_check",
      sql`${table.pmProvider} IN ('anthropic', 'openai')`,
    ),
    check(
      "project_planning_preferences_reviewer_provider_check",
      sql`${table.reviewerProvider} IN ('anthropic', 'openai')
        AND ${table.reviewerProvider} <> ${table.pmProvider}`,
    ),
    check(
      "project_planning_preferences_source_check",
      sql`${table.source} IN ('native', 'legacy_snapshot')`,
    ),
  ],
);

export const repositoryBindingCandidates = pgTable(
  "repository_binding_candidates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    sourceType: text("source_type").notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    displayName: text("display_name").notNull(),
    githubOwner: text("github_owner"),
    githubName: text("github_name"),
    status: text("status").notNull().default("unverified"),
    archiveId: text("archive_id").references((): AnyPgColumn => legacySnapshotArchives.id, {
      onDelete: "restrict",
    }),
    sourceRecordId: text("source_record_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("repository_binding_candidates_project_source_unique").on(
      table.projectId,
      table.sourceType,
      table.sourceFingerprint,
    ),
    index("repository_binding_candidates_project_status_idx").on(table.projectId, table.status),
    check(
      "repository_binding_candidates_source_type_check",
      sql`${table.sourceType} IN ('local', 'github')`,
    ),
    check(
      "repository_binding_candidates_status_check",
      sql`${table.status} IN ('unverified', 'promoted', 'dismissed')`,
    ),
    check(
      "repository_binding_candidates_hash_check",
      sql`${table.sourceFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const phase2MigrationRuns = pgTable(
  "migration_runs",
  {
    id: text("id").primaryKey(),
    migrationName: text("migration_name").notNull(),
    sourceSnapshotHashes: jsonb("source_snapshot_hashes").notNull().default({}),
    sourceCounts: jsonb("source_counts").notNull().default({}),
    sourceFrozenAt: timestamp("source_frozen_at", { withTimezone: true, mode: "string" }),
    sourceManifestHash: text("source_manifest_hash"),
    sourceApplicationVersion: text("source_application_version"),
    sourceApplicationCommit: text("source_application_commit"),
    recoveryMarker: jsonb("recovery_marker").notNull().default({}),
    lastSourceRecords: jsonb("last_source_records").notNull().default({}),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    rollbackWindowUntil: timestamp("rollback_window_until", {
      withTimezone: true,
      mode: "string",
    }),
    v2WritesStartedAt: timestamp("v2_writes_started_at", {
      withTimezone: true,
      mode: "string",
    }),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    details: jsonb("details").notNull().default({}),
  },
  (table) => [
    uniqueIndex("migration_runs_name_started_unique").on(table.migrationName, table.startedAt),
    uniqueIndex("migration_runs_name_manifest_unique")
      .on(table.migrationName, table.sourceManifestHash)
      .where(sql`${table.sourceManifestHash} IS NOT NULL`),
    check(
      "migration_runs_status_check",
      sql`${table.status} IN (
        'capturing', 'archived', 'importing', 'reconciling', 'shadowing',
        'ready', 'cutover', 'rolled_back', 'failed'
      )`,
    ),
    check(
      "migration_runs_manifest_hash_check",
      sql`${table.sourceManifestHash} IS NULL
        OR ${table.sourceManifestHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const recoveryCheckpoints = pgTable(
  "recovery_checkpoints",
  {
    id: text("id").primaryKey(),
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    backupReference: text("backup_reference").notNull(),
    databaseTime: timestamp("database_time", { withTimezone: true, mode: "string" }).notNull(),
    walLsn: text("wal_lsn").notNull(),
    transactionId: text("transaction_id").notNull(),
    applicationVersion: text("application_version").notNull(),
    applicationCommit: text("application_commit").notNull(),
    sourceManifestHash: text("source_manifest_hash").notNull(),
    sourceFrozenAt: timestamp("source_frozen_at", { withTimezone: true, mode: "string" }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("recovery_checkpoints_migration_run_unique").on(table.migrationRunId),
    check(
      "recovery_checkpoints_manifest_hash_check",
      sql`${table.sourceManifestHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const legacySnapshotArchives = pgTable(
  "legacy_snapshot_archives",
  {
    id: text("id").primaryKey(),
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "restrict" }),
    sourceKey: text("source_key").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    storageRef: text("storage_ref").notNull(),
    keyId: text("key_id").notNull(),
    keyFingerprint: text("key_fingerprint").notNull(),
    cipher: text("cipher").notNull(),
    exactHash: text("exact_hash").notNull(),
    canonicalHash: text("canonical_hash").notNull(),
    ciphertextHash: text("ciphertext_hash").notNull(),
    aadHash: text("aad_hash").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    exactByteSize: bigint("exact_byte_size", { mode: "number" }).notNull(),
    canonicalByteSize: bigint("canonical_byte_size", { mode: "number" }).notNull(),
    objectCounts: jsonb("object_counts").notNull().default({}),
    lastRecord: jsonb("last_record"),
    nonce: bytea("nonce").notNull(),
    authTag: bytea("auth_tag").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    status: text("status").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true, mode: "string" }).notNull(),
    retentionUntil: timestamp("retention_until", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("legacy_snapshot_archives_storage_unique").on(table.storageRef),
    uniqueIndex("legacy_snapshot_archives_run_source_unique").on(
      table.migrationRunId,
      table.sourceKey,
    ),
    uniqueIndex("legacy_snapshot_archives_key_nonce_unique").on(table.keyFingerprint, table.nonce),
    foreignKey({
      name: "legacy_snapshot_archives_key_registry_fk",
      columns: [table.keyId, table.keyFingerprint],
      foreignColumns: [
        archiveEncryptionKeyRegistry.keyId,
        archiveEncryptionKeyRegistry.keyFingerprint,
      ],
    }).onDelete("restrict"),
    check(
      "legacy_snapshot_archives_hashes_check",
      sql`${table.exactHash} ~ '^[a-f0-9]{64}$'
        AND ${table.canonicalHash} ~ '^[a-f0-9]{64}$'
        AND ${table.ciphertextHash} ~ '^[a-f0-9]{64}$'
        AND ${table.aadHash} ~ '^[a-f0-9]{64}$'
        AND ${table.manifestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check("legacy_snapshot_archives_cipher_check", sql`${table.cipher} = 'aes-256-gcm'`),
    check(
      "legacy_snapshot_archives_status_check",
      sql`${table.status} IN ('sealed', 'verified', 'expired')`,
    ),
    check(
      "legacy_snapshot_archives_verification_shape_check",
      sql`(${table.status} = 'sealed' AND ${table.verifiedAt} IS NULL)
        OR ${table.status} = 'expired'
        OR (${table.status} = 'verified' AND ${table.verifiedAt} IS NOT NULL)`,
    ),
    check(
      "legacy_snapshot_archives_size_check",
      sql`${table.exactByteSize} >= 0 AND ${table.canonicalByteSize} >= 0`,
    ),
    check(
      "legacy_snapshot_archives_retention_check",
      sql`${table.retentionUntil} > ${table.capturedAt}`,
    ),
  ],
);

export const legacyArchiveAccessEvents = pgTable(
  "legacy_archive_access_events",
  {
    id: text("id").primaryKey(),
    archiveId: text("archive_id")
      .notNull()
      .references(() => legacySnapshotArchives.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    operation: text("operation").notNull(),
    outcome: text("outcome").notNull(),
    correlationId: text("correlation_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
    details: jsonb("details").notNull().default({}),
    redactionApplied: boolean("redaction_applied").notNull().default(true),
  },
  (table) => [
    index("legacy_archive_access_archive_time_idx").on(table.archiveId, table.occurredAt),
    check(
      "legacy_archive_access_operation_check",
      sql`${table.operation} IN ('write', 'head', 'read', 'verify')`,
    ),
    check(
      "legacy_archive_access_outcome_check",
      sql`${table.outcome} IN ('allowed', 'denied', 'failed')`,
    ),
    check(
      "legacy_archive_access_human_actor_check",
      sql`${table.actorType} <> 'human' OR ${table.actorId} IS NOT NULL`,
    ),
  ],
);

export const migrationSteps = pgTable(
  "migration_steps",
  {
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "restrict" }),
    stepKey: text("step_key").notNull(),
    inputHash: text("input_hash").notNull(),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull().default(1),
    outputHash: text("output_hash"),
    outputCounts: jsonb("output_counts").notNull().default({}),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "migration_steps_pk",
      columns: [table.migrationRunId, table.stepKey],
    }),
    check("migration_steps_hash_check", sql`${table.inputHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "migration_steps_output_hash_check",
      sql`${table.outputHash} IS NULL OR ${table.outputHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "migration_steps_status_check",
      sql`${table.status} IN ('pending', 'running', 'succeeded', 'failed')`,
    ),
    check("migration_steps_attempt_check", sql`${table.attempt} > 0`),
  ],
);

export const legacyProjectImports = pgTable(
  "legacy_project_imports",
  {
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    sourceHash: text("source_hash").notNull(),
    planHash: text("plan_hash"),
    graphHash: text("graph_hash"),
    approvalHash: text("approval_hash"),
    graphVersion: integer("graph_version"),
    sourceCounts: jsonb("source_counts").notNull().default({}),
    importHash: text("import_hash").notNull(),
    archiveId: text("archive_id").references(() => legacySnapshotArchives.id, {
      onDelete: "restrict",
    }),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "legacy_project_imports_pk",
      columns: [table.migrationRunId, table.projectId],
    }),
    check(
      "legacy_project_imports_hash_check",
      sql`${table.sourceHash} ~ '^[a-f0-9]{64}$'
        AND (${table.planHash} IS NULL OR ${table.planHash} ~ '^[a-f0-9]{64}$')
        AND (${table.graphHash} IS NULL OR ${table.graphHash} ~ '^[a-f0-9]{64}$')
        AND (${table.approvalHash} IS NULL OR ${table.approvalHash} ~ '^[a-f0-9]{64}$')
        AND ${table.importHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "legacy_project_imports_graph_version_check",
      sql`${table.graphVersion} IS NULL OR ${table.graphVersion} > 0`,
    ),
  ],
);

export const phase2LegacyIdMappings = pgTable(
  "legacy_id_mappings",
  {
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    legacyEntityType: text("legacy_entity_type").notNull(),
    legacyId: text("legacy_id").notNull(),
    v2EntityType: text("v2_entity_type").notNull(),
    v2Id: text("v2_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceMetadata: jsonb("source_metadata").notNull().default({}),
    importEventId: text("import_event_id"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "legacy_id_mappings_pk",
      columns: [table.migrationRunId, table.legacyEntityType, table.legacyId],
    }),
    uniqueIndex("legacy_id_mappings_v2_unique").on(
      table.migrationRunId,
      table.v2EntityType,
      table.v2Id,
    ),
    check("legacy_id_mappings_source_hash_check", sql`${table.sourceHash} ~ '^[a-f0-9]{64}$'`),
  ],
);

export const migrationReconciliationFindings = pgTable(
  "migration_reconciliation_findings",
  {
    id: text("id").primaryKey(),
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "restrict" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("open"),
    sourceEntityType: text("source_entity_type").notNull(),
    sourceEntityId: text("source_entity_id"),
    sourceFingerprint: text("source_fingerprint").notNull(),
    details: jsonb("details").notNull().default({}),
    detectedAt: timestamp("detected_at", { withTimezone: true, mode: "string" }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    resolvedByActorId: text("resolved_by_actor_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    dispositionNote: text("disposition_note"),
  },
  (table) => [
    uniqueIndex("migration_reconciliation_findings_identity_unique").on(
      table.migrationRunId,
      table.projectId,
      table.code,
      table.sourceEntityType,
      table.sourceEntityId,
      table.sourceFingerprint,
    ),
    index("migration_reconciliation_findings_open_idx").on(
      table.migrationRunId,
      table.projectId,
      table.status,
      table.severity,
    ),
    check(
      "migration_reconciliation_findings_code_check",
      sql`${table.code} IN (
        'invalid_plan_payload',
        'invalid_graph_payload',
        'plan_without_graph',
        'graph_without_plan',
        'graph_node_without_plan_module',
        'plan_module_without_graph_node',
        'shared_task_field_mismatch',
        'acceptance_criteria_unavailable',
        'acceptance_criteria_projection_mismatch',
        'dependency_edge_added_in_graph',
        'dependency_edge_removed_from_graph',
        'orphan_dependency_reference',
        'assignment_missing',
        'assignment_projection_mismatch',
        'assignment_worker_count_requires_reconciliation',
        'assignment_changed_since_approval',
        'approval_graph_version_mismatch',
        'approval_content_hash_mismatch',
        'invalid_approval_payload',
        'approval_actor_unattributable',
        'source_changed_after_freeze',
        'imported_count_mismatch',
        'imported_checksum_mismatch',
        'unknown_snapshot_key',
        'nonterminal_legacy_command'
      )`,
    ),
    check(
      "migration_reconciliation_findings_severity_check",
      sql`${table.severity} IN ('blocking', 'warning', 'informational')`,
    ),
    check(
      "migration_reconciliation_findings_status_check",
      sql`${table.status} IN ('open', 'resolved', 'accepted')`,
    ),
    check(
      "migration_reconciliation_findings_hash_check",
      sql`${table.sourceFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const shadowReadComparisons = pgTable(
  "shadow_read_comparisons",
  {
    id: text("id").primaryKey(),
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "restrict" }),
    scopeType: text("scope_type").notNull(),
    scopeKey: text("scope_key").notNull(),
    operation: text("operation").notNull(),
    legacyHash: text("legacy_hash").notNull(),
    relationalHash: text("relational_hash").notNull(),
    matched: boolean("matched").notNull(),
    differences: jsonb("differences").notNull().default([]),
    sourceKey: text("source_key").notNull(),
    sourceManifestHash: text("source_manifest_hash").notNull(),
    sourceExactHash: text("source_exact_hash").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    index("shadow_read_comparisons_scope_time_idx").on(
      table.scopeType,
      table.scopeKey,
      table.observedAt,
    ),
    index("shadow_read_comparisons_mismatch_idx").on(table.migrationRunId, table.matched),
    index("shadow_read_comparisons_provenance_idx").on(
      table.migrationRunId,
      table.scopeType,
      table.scopeKey,
      table.sourceManifestHash,
      table.sourceKey,
      table.sourceExactHash,
      table.sourceUpdatedAt,
      table.observedAt,
    ),
    check(
      "shadow_read_comparisons_scope_check",
      sql`${table.scopeType} IN ('identity', 'project', 'new_projects', 'relay')`,
    ),
    check(
      "shadow_read_comparisons_hash_check",
      sql`${table.legacyHash} ~ '^[a-f0-9]{64}$'
        AND ${table.relationalHash} ~ '^[a-f0-9]{64}$'
        AND ${table.sourceManifestHash} ~ '^[a-f0-9]{64}$'
        AND ${table.sourceExactHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "shadow_read_comparisons_difference_check",
      sql`(${table.matched} AND jsonb_array_length(${table.differences}) = 0)
        OR (NOT ${table.matched} AND jsonb_array_length(${table.differences}) > 0)`,
    ),
  ],
);

export const persistenceRoutes = pgTable(
  "persistence_routes",
  {
    scopeType: text("scope_type").notNull(),
    scopeKey: text("scope_key").notNull(),
    readMode: text("read_mode").notNull(),
    writeMode: text("write_mode").notNull(),
    migrationRunId: text("migration_run_id").references(() => migrationRuns.id, {
      onDelete: "restrict",
    }),
    aggregateVersion: aggregateVersion(),
    changedByActorType: text("changed_by_actor_type").notNull(),
    changedByActorId: text("changed_by_actor_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    changedAt: timestamp("changed_at", { withTimezone: true, mode: "string" }).notNull(),
    v2WritesStartedAt: timestamp("v2_writes_started_at", {
      withTimezone: true,
      mode: "string",
    }),
    rollbackWindowUntil: timestamp("rollback_window_until", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    primaryKey({
      name: "persistence_routes_pk",
      columns: [table.scopeType, table.scopeKey],
    }),
    check(
      "persistence_routes_scope_check",
      sql`${table.scopeType} IN ('identity', 'project', 'new_projects', 'relay')`,
    ),
    check(
      "persistence_routes_scope_key_check",
      sql`(${table.scopeType} = 'project' AND ${table.scopeKey} <> '*')
        OR (${table.scopeType} <> 'project' AND ${table.scopeKey} = '*')`,
    ),
    check(
      "persistence_routes_read_mode_check",
      sql`${table.readMode} IN ('legacy', 'shadow', 'relational')`,
    ),
    check(
      "persistence_routes_write_mode_check",
      sql`${table.writeMode} IN ('legacy', 'frozen', 'relational')`,
    ),
    check(
      "persistence_routes_v2_write_time_check",
      sql`${table.writeMode} <> 'relational' OR ${table.v2WritesStartedAt} IS NOT NULL`,
    ),
    check(
      "persistence_routes_human_actor_check",
      sql`${table.changedByActorType} <> 'human' OR ${table.changedByActorId} IS NOT NULL`,
    ),
  ],
);

export const migrationRollbackEvidence = pgTable(
  "migration_rollback_evidence",
  {
    id: text("id").primaryKey(),
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "restrict" }),
    stateFingerprint: text("state_fingerprint").notNull(),
    reportFingerprint: text("report_fingerprint").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true, mode: "string" }).notNull(),
    report: jsonb("report").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("migration_rollback_evidence_identity_unique").on(table.id, table.migrationRunId),
    uniqueIndex("migration_rollback_evidence_report_unique").on(table.reportFingerprint),
    index("migration_rollback_evidence_run_time_idx").on(table.migrationRunId, table.observedAt),
    check(
      "migration_rollback_evidence_hash_check",
      sql`${table.stateFingerprint} ~ '^[a-f0-9]{64}$'
        AND ${table.reportFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "migration_rollback_evidence_freshness_check",
      sql`${table.validUntil} > ${table.observedAt}`,
    ),
    check(
      "migration_rollback_evidence_report_shape_check",
      sql`jsonb_typeof(${table.report}) = 'object'`,
    ),
  ],
);

export const migrationRollbackApprovals = pgTable(
  "migration_rollback_approvals",
  {
    id: text("id").primaryKey(),
    evidenceId: text("evidence_id").notNull(),
    migrationRunId: text("migration_run_id").notNull(),
    humanActorId: text("human_actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    confirmedReportFingerprint: text("confirmed_report_fingerprint").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }).notNull(),
    routesReversed: jsonb("routes_reversed").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("migration_rollback_approvals_evidence_unique").on(table.evidenceId),
    index("migration_rollback_approvals_run_time_idx").on(table.migrationRunId, table.approvedAt),
    foreignKey({
      name: "migration_rollback_approvals_evidence_run_fk",
      columns: [table.evidenceId, table.migrationRunId],
      foreignColumns: [migrationRollbackEvidence.id, migrationRollbackEvidence.migrationRunId],
    }).onDelete("restrict"),
    check(
      "migration_rollback_approvals_hash_check",
      sql`${table.confirmedReportFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "migration_rollback_approvals_routes_check",
      sql`jsonb_typeof(${table.routesReversed}) = 'array'
        AND jsonb_array_length(${table.routesReversed}) > 0`,
    ),
  ],
);

export const legacyApprovalEvidence = pgTable(
  "legacy_approval_evidence",
  {
    id: text("id").primaryKey(),
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "restrict" }),
    subjectEntityType: text("subject_entity_type").notNull(),
    subjectEntityId: text("subject_entity_id").notNull(),
    contentHash: text("content_hash").notNull(),
    graphVersion: integer("graph_version").notNull(),
    allocationFingerprint: text("allocation_fingerprint").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "restrict" }),
    sourceActorText: text("source_actor_text"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }).notNull(),
    currentAtImport: boolean("current_at_import").notNull(),
    sourceHash: text("source_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("legacy_approval_evidence_source_unique").on(
      table.migrationRunId,
      table.projectId,
      table.sourceHash,
    ),
    check(
      "legacy_approval_evidence_hash_check",
      sql`${table.contentHash} ~ '^[a-f0-9]{64}$'
        AND ${table.allocationFingerprint} ~ '^[a-f0-9]{64}$'
        AND ${table.sourceHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check("legacy_approval_evidence_graph_version_check", sql`${table.graphVersion} > 0`),
    check(
      "legacy_approval_evidence_actor_check",
      sql`(
        ${table.actorType} = 'legacy'
        AND ${table.actorId} IS NULL
        AND ${table.sourceActorText} IS NOT NULL
      ) OR (
        ${table.actorType} = 'human'
        AND ${table.actorId} IS NOT NULL
      )`,
    ),
  ],
);

export const phase2PreservationSchema = {
  archiveEncryptionKeyRegistry,
  credentialHmacKeyRegistry,
  ...phase1V2Schema,
  users: phase2Users,
  sessions: phase2Sessions,
  migrationRuns: phase2MigrationRuns,
  legacyIdMappings: phase2LegacyIdMappings,
  invitations,
  projectPlanningPreferences,
  repositoryBindingCandidates,
  recoveryCheckpoints,
  legacySnapshotArchives,
  legacyArchiveAccessEvents,
  migrationSteps,
  legacyProjectImports,
  migrationReconciliationFindings,
  shadowReadComparisons,
  persistenceRoutes,
  migrationRollbackEvidence,
  migrationRollbackApprovals,
  legacyApprovalEvidence,
};
