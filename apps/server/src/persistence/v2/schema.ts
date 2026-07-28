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
  smallint,
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

export const serviceConnections = pgTable(
  "service_connections",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    baseUrl: text("base_url").notNull().default("https://github.com"),
    status: text("status").notNull().default("connected"),
    ownerType: text("owner_type").notNull(),
    ownerLogin: text("owner_login").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    installationId: text("installation_id"),
    repositorySelection: text("repository_selection"),
    connectedByUserId: text("connected_by_user_id").notNull(),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("service_connections_provider_installation_unique").on(
      table.provider,
      table.installationId,
    ),
    index("service_connections_provider_status_idx").on(
      table.provider,
      table.status,
      table.ownerLogin,
    ),
    check("service_connections_provider_check", sql`${table.provider} IN ('github')`),
    check(
      "service_connections_status_check",
      sql`${table.status} IN ('connected', 'action_required', 'disconnected', 'deleted')`,
    ),
    check(
      "service_connections_owner_type_check",
      sql`${table.ownerType} IN ('user', 'organization')`,
    ),
  ],
);

export const githubUserAuthorizations = pgTable(
  "github_user_authorizations",
  {
    userId: text("user_id").primaryKey(),
    githubUserId: text("github_user_id").notNull(),
    githubLogin: text("github_login").notNull(),
    accessTokenCiphertext: text("access_token_ciphertext").notNull(),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    connectedAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [],
);

export const githubAppConfigurations = pgTable(
  "github_app_configurations",
  {
    id: text("id").primaryKey(),
    keyId: text("key_id").notNull(),
    appId: text("app_id").notNull(),
    clientId: text("client_id").notNull(),
    appSlug: text("app_slug").notNull(),
    credentialsCiphertext: text("credentials_ciphertext").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [check("github_app_configurations_singleton_check", sql`${table.id} = 'primary'`)],
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
    // EXECUTION E10 adds published_branch, published_commit_sha,
    // published_remote, pull_request_url, publication_note,
    // publication_outcome and published_at to this table. They are
    // DELIBERATELY absent here: this object is the frozen 0001 surface that
    // v2Schema.test asserts against migration 0001 alone, and every prior
    // forward migration that extended a phase-1 table (0013's
    // phases.planning_run_id, 0015's projects.update_interval_seconds) left the
    // column out of Drizzle for the same reason. Every access path to those
    // columns is raw SQL.
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

export const humanDirections = pgTable(
  "human_directions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    phaseId: text("phase_id"),
    taskId: text("task_id"),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    directionTarget: text("direction_target").notNull(),
    directionText: text("direction_text").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    uniqueIndex("human_directions_actor_key_unique").on(table.actorId, table.idempotencyKey),
    index("human_directions_project_scope_idx").on(
      table.projectId,
      table.phaseId,
      table.taskId,
      table.createdAt,
    ),
    foreignKey({
      name: "human_directions_project_fk",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "human_directions_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "human_directions_task_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.phaseId, tasks.id],
    }).onDelete("restrict"),
    check(
      "human_directions_scope_shape_check",
      sql`${table.phaseId} IS NOT NULL OR ${table.taskId} IS NULL`,
    ),
    check(
      "human_directions_target_check",
      sql`${table.directionTarget} IN ('project_manager','implementation_agent','reviewer','all_agents')`,
    ),
    check("human_directions_text_check", sql`length(trim(${table.directionText})) > 0`),
    check("human_directions_hash_check", sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
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
    uniqueIndex("verification_results_visual_scope_unique").on(
      table.projectId,
      table.phaseId,
      table.taskId,
      table.runId,
      table.repositoryBindingId,
      table.commitSha,
      table.id,
    ),
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
      sql`${table.status} IN ('awaiting_enrollment', 'queued', 'leased', 'delivered', 'completed', 'dead_letter', 'cancelled')`,
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

/** Explicit project collaboration membership introduced after the frozen V2 schema. */
export const projectMembers = pgTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("active"),
    addedByUserId: text("added_by_user_id").references(() => phase2Users.id, {
      onDelete: "restrict",
    }),
    addedAt: timestamp("added_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    removedByUserId: text("removed_by_user_id").references(() => phase2Users.id, {
      onDelete: "restrict",
    }),
    removedAt: timestamp("removed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index("project_members_user_status_idx").on(table.userId, table.status, table.projectId),
    index("project_members_project_status_idx").on(table.projectId, table.status, table.userId),
    check("project_members_status_check", sql`${table.status} IN ('active', 'removed')`),
    check(
      "project_members_removal_shape_check",
      sql`(${table.status} = 'active'
          AND ${table.removedAt} IS NULL
          AND ${table.removedByUserId} IS NULL)
        OR (${table.status} = 'removed' AND ${table.removedAt} IS NOT NULL)`,
    ),
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
    serviceConnectionId: text("service_connection_id").references(() => serviceConnections.id, {
      onDelete: "restrict",
    }),
    externalRepositoryId: text("external_repository_id"),
    defaultBranch: text("default_branch"),
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
    recordedOrder: bigint("recorded_order", { mode: "number" }).generatedAlwaysAsIdentity(),
  },
  (table) => [
    index("shadow_read_comparisons_scope_time_idx").on(
      table.scopeType,
      table.scopeKey,
      table.observedAt,
    ),
    index("shadow_read_comparisons_mismatch_idx").on(table.migrationRunId, table.matched),
    uniqueIndex("shadow_read_comparisons_recorded_order_unique").on(table.recordedOrder),
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

export const attentionItemStates = pgTable(
  "attention_item_states",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    conditionClass: text("condition_class").notNull(),
    conditionFingerprint: text("condition_fingerprint").notNull(),
    disposition: text("disposition").notNull(),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true, mode: "string" }),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.itemKey] }),
    index("attention_item_states_project_user_idx").on(
      table.projectId,
      table.userId,
      table.updatedAt,
    ),
    check(
      "attention_item_states_fingerprint_check",
      sql`${table.conditionFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "attention_item_states_disposition_check",
      sql`${table.disposition} IN ('acknowledged','snoozed')`,
    ),
    check(
      "attention_item_states_snooze_check",
      sql`(${table.disposition} = 'snoozed') = (${table.snoozedUntil} IS NOT NULL)`,
    ),
  ],
);

/** Durable debate workflow overlays added by migration 0011. */
export const debates = pgTable(
  "debates",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    phaseId: text("phase_id"),
    sourceDebateId: text("source_debate_id"),
    state: text("state").notNull().default("draft"),
    title: text("title").notNull(),
    question: text("question").notNull(),
    stoppingPolicy: jsonb("stopping_policy").notNull(),
    contentHash: text("content_hash").notNull(),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id"),
    aggregateVersion: aggregateVersion(),
    createdAt: createdAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("debates_project_id_id_unique").on(table.projectId, table.id),
    index("debates_project_state_idx").on(table.projectId, table.state, table.createdAt),
    foreignKey({
      name: "debates_project_fk",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "debates_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("restrict"),
    lazyForeignKey(
      "debates_source_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.sourceDebateId],
      (): AnyPgColumn[] => [debates.projectId, debates.id],
    ).onDelete("restrict"),
    check("debates_state_check", sql`${table.state} IN ('draft','ready','archived')`),
    check("debates_content_hash_check", sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
    check("debates_aggregate_version_check", sql`${table.aggregateVersion} > 0`),
    check(
      "debates_archived_shape_check",
      sql`(${table.state} = 'archived') = (${table.archivedAt} IS NOT NULL)`,
    ),
  ],
);

export const debateActors = pgTable(
  "debate_actors",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    actorKind: text("actor_kind").notNull(),
    roleLabel: text("role_label").notNull(),
    displayName: text("display_name").notNull(),
    instructions: text("instructions").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runtime: text("runtime").notNull(),
    position: integer("position").notNull(),
    maxTurns: integer("max_turns").notNull(),
    maxInputTokens: integer("max_input_tokens").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    budgetLimitUsd: money("budget_limit_usd"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("debate_actors_debate_id_id_unique").on(table.debateId, table.id),
    uniqueIndex("debate_actors_position_unique").on(table.debateId, table.position),
    uniqueIndex("debate_actors_one_judge_unique")
      .on(table.debateId)
      .where(sql`${table.actorKind} = 'judge'`),
    uniqueIndex("debate_actors_one_synthesizer_unique")
      .on(table.debateId)
      .where(sql`${table.actorKind} = 'synthesizer'`),
    foreignKey({
      name: "debate_actors_debate_scope_fk",
      columns: [table.projectId, table.debateId],
      foreignColumns: [debates.projectId, debates.id],
    }).onDelete("cascade"),
    check(
      "debate_actors_kind_check",
      sql`${table.actorKind} IN ('participant','judge','synthesizer')`,
    ),
    check("debate_actors_position_check", sql`${table.position} >= 0`),
    check(
      "debate_actors_limits_check",
      sql`${table.maxTurns} > 0 AND ${table.maxInputTokens} > 0 AND ${table.maxOutputTokens} > 0 AND ${table.budgetLimitUsd} >= 0`,
    ),
  ],
);

export const debateContexts = pgTable(
  "debate_contexts",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    label: text("label").notNull(),
    artifactId: text("artifact_id"),
    inlineContent: text("inline_content"),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("debate_contexts_debate_ordinal_unique").on(table.debateId, table.ordinal),
    foreignKey({
      name: "debate_contexts_debate_scope_fk",
      columns: [table.projectId, table.debateId],
      foreignColumns: [debates.projectId, debates.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "debate_contexts_artifact_scope_fk",
      columns: [table.projectId, table.artifactId],
      foreignColumns: [artifacts.projectId, artifacts.id],
    }).onDelete("restrict"),
    check("debate_contexts_hash_check", sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "debate_contexts_source_check",
      sql`(${table.artifactId} IS NULL) <> (${table.inlineContent} IS NULL)`,
    ),
    check("debate_contexts_ordinal_check", sql`${table.ordinal} >= 0`),
  ],
);

export const debateRuns = pgTable(
  "debate_runs",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    attempt: integer("attempt").notNull(),
    state: text("state").notNull().default("created"),
    lifecycleVersion: integer("lifecycle_version").notNull().default(0),
    eventVersion: integer("event_version").notNull().default(0),
    cursorRoundNumber: integer("cursor_round_number").notNull().default(0),
    cursorTurnNumber: integer("cursor_turn_number").notNull().default(0),
    stopAfter: text("stop_after").notNull().default("none"),
    stopReason: text("stop_reason"),
    actorExecutionSnapshots: jsonb("actor_execution_snapshots").notNull(),
    aggregateVersion: aggregateVersion(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("debate_runs_project_debate_id_unique").on(
      table.projectId,
      table.debateId,
      table.id,
    ),
    uniqueIndex("debate_runs_attempt_unique").on(table.debateId, table.attempt),
    uniqueIndex("debate_runs_one_nonterminal_unique")
      .on(table.debateId)
      .where(sql`${table.state} NOT IN ('completed','cancelled','failed')`),
    index("debate_runs_project_state_idx").on(table.projectId, table.state, table.updatedAt),
    foreignKey({
      name: "debate_runs_debate_scope_fk",
      columns: [table.projectId, table.debateId],
      foreignColumns: [debates.projectId, debates.id],
    }).onDelete("restrict"),
    check(
      "debate_runs_state_check",
      sql`${table.state} IN ('created','queued','running','pausing','paused','finalizing','cancelling','completed','cancelled','failed')`,
    ),
    check(
      "debate_runs_lifecycle_origin_check",
      sql`${table.lifecycleVersion} > 0 OR ${table.state} = 'created'`,
    ),
    check(
      "debate_runs_cursor_check",
      sql`${table.eventVersion} >= 0 AND ${table.cursorRoundNumber} >= 0 AND ${table.cursorTurnNumber} >= 0`,
    ),
    check("debate_runs_stop_after_check", sql`${table.stopAfter} IN ('none','turn','round')`),
  ],
);

export const debateRounds = pgTable(
  "debate_rounds",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    debateRunId: text("debate_run_id").notNull(),
    roundNumber: integer("round_number").notNull(),
    state: text("state").notNull().default("pending"),
    consensusReported: boolean("consensus_reported").notNull().default(false),
    materialChange: boolean("material_change"),
    unresolvedDisagreementFingerprint: text("unresolved_disagreement_fingerprint"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("debate_rounds_run_round_unique").on(table.debateRunId, table.roundNumber),
    uniqueIndex("debate_rounds_run_id_id_unique").on(table.debateRunId, table.id),
    foreignKey({
      name: "debate_rounds_run_scope_fk",
      columns: [table.projectId, table.debateId, table.debateRunId],
      foreignColumns: [debateRuns.projectId, debateRuns.debateId, debateRuns.id],
    }).onDelete("cascade"),
    check(
      "debate_rounds_state_check",
      sql`${table.state} IN ('pending','active','completed','cancelled','failed')`,
    ),
    check("debate_rounds_number_check", sql`${table.roundNumber} > 0`),
  ],
);

export const debateTurns = pgTable(
  "debate_turns",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    debateRunId: text("debate_run_id").notNull(),
    roundId: text("round_id").notNull(),
    turnNumber: integer("turn_number").notNull(),
    actorId: text("actor_id").notNull(),
    state: text("state").notNull().default("pending"),
    designatedAttemptId: text("designated_attempt_id"),
    promptHash: text("prompt_hash").notNull(),
    outputMessageId: text("output_message_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("debate_turns_run_turn_unique").on(table.debateRunId, table.turnNumber),
    uniqueIndex("debate_turns_run_id_id_unique").on(table.debateRunId, table.id),
    foreignKey({
      name: "debate_turns_run_scope_fk",
      columns: [table.projectId, table.debateId, table.debateRunId],
      foreignColumns: [debateRuns.projectId, debateRuns.debateId, debateRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "debate_turns_round_scope_fk",
      columns: [table.debateRunId, table.roundId],
      foreignColumns: [debateRounds.debateRunId, debateRounds.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "debate_turns_actor_scope_fk",
      columns: [table.debateId, table.actorId],
      foreignColumns: [debateActors.debateId, debateActors.id],
    }).onDelete("restrict"),
    check(
      "debate_turns_state_check",
      sql`${table.state} IN ('pending','queued','leased','running','completed','failed','cancelled','expired')`,
    ),
    check("debate_turns_number_check", sql`${table.turnNumber} > 0`),
    check("debate_turns_hash_check", sql`${table.promptHash} ~ '^[a-f0-9]{64}$'`),
    lazyForeignKey(
      "debate_turns_designated_attempt_scope_fk",
      (): AnyPgColumn[] => [table.id, table.designatedAttemptId],
      (): AnyPgColumn[] => [debateTurnAttempts.turnId, debateTurnAttempts.id],
    ).onDelete("restrict"),
  ],
);

export const debateTurnAttempts = pgTable(
  "debate_turn_attempts",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    debateRunId: text("debate_run_id").notNull(),
    turnId: text("turn_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    state: text("state").notNull().default("pending"),
    isDesignated: boolean("is_designated").notNull().default(true),
    providerExecutionId: text("provider_execution_id"),
    leaseToken: text("lease_token"),
    leasedUntil: timestamp("leased_until", { withTimezone: true, mode: "string" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    failureCode: text("failure_code"),
    failureDetail: text("failure_detail"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("debate_turn_attempts_turn_attempt_unique").on(table.turnId, table.attemptNumber),
    uniqueIndex("debate_turn_attempts_turn_id_id_unique").on(table.turnId, table.id),
    uniqueIndex("debate_turn_attempts_project_run_id_unique").on(
      table.projectId,
      table.debateId,
      table.debateRunId,
      table.id,
    ),
    uniqueIndex("debate_turn_attempts_designated_unique")
      .on(table.turnId)
      .where(sql`${table.isDesignated} = true`),
    foreignKey({
      name: "debate_turn_attempts_turn_scope_fk",
      columns: [table.debateRunId, table.turnId],
      foreignColumns: [debateTurns.debateRunId, debateTurns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "debate_turn_attempts_run_scope_fk",
      columns: [table.projectId, table.debateId, table.debateRunId],
      foreignColumns: [debateRuns.projectId, debateRuns.debateId, debateRuns.id],
    }).onDelete("cascade"),
    check(
      "debate_turn_attempts_state_check",
      sql`${table.state} IN ('pending','queued','leased','running','completed','failed','cancelled','expired')`,
    ),
    check("debate_turn_attempts_number_check", sql`${table.attemptNumber} > 0`),
  ],
);

export const debateMessages = pgTable(
  "debate_messages",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    debateRunId: text("debate_run_id").notNull(),
    sequence: integer("sequence").notNull(),
    messageKind: text("message_kind").notNull(),
    actorSnapshot: jsonb("actor_snapshot"),
    turnId: text("turn_id"),
    turnAttemptId: text("turn_attempt_id"),
    supersedesMessageId: text("supersedes_message_id"),
    structuredOutput: jsonb("structured_output"),
    structuredOutputHash: text("structured_output_hash"),
    interventionKind: text("intervention_kind"),
    interventionTargetActorId: text("intervention_target_actor_id"),
    interventionApplyAt: text("intervention_apply_at"),
    interventionAppliesAfterRound: integer("intervention_applies_after_round"),
    interventionAppliesAfterTurn: integer("intervention_applies_after_turn"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("debate_messages_run_sequence_unique").on(table.debateRunId, table.sequence),
    uniqueIndex("debate_messages_run_id_id_unique").on(table.debateRunId, table.id),
    foreignKey({
      name: "debate_messages_run_scope_fk",
      columns: [table.projectId, table.debateId, table.debateRunId],
      foreignColumns: [debateRuns.projectId, debateRuns.debateId, debateRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "debate_messages_turn_scope_fk",
      columns: [table.debateRunId, table.turnId],
      foreignColumns: [debateTurns.debateRunId, debateTurns.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "debate_messages_attempt_scope_fk",
      columns: [table.turnId, table.turnAttemptId],
      foreignColumns: [debateTurnAttempts.turnId, debateTurnAttempts.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "debate_messages_supersedes_scope_fk",
      columns: [table.debateRunId, table.supersedesMessageId],
      foreignColumns: [table.debateRunId, table.id],
    }).onDelete("restrict"),
    check(
      "debate_messages_kind_check",
      sql`${table.messageKind} IN ('system','participant','judge','synthesizer','human')`,
    ),
    check("debate_messages_sequence_check", sql`${table.sequence} > 0`),
    check("debate_messages_hash_check", sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "debate_messages_structured_hash_check",
      sql`${table.structuredOutputHash} IS NULL OR ${table.structuredOutputHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "debate_messages_structured_shape_check",
      sql`(${table.structuredOutput} IS NULL) = (${table.structuredOutputHash} IS NULL)
        AND (${table.messageKind} IN ('participant','judge','synthesizer')) = (${table.structuredOutput} IS NOT NULL)`,
    ),
    check(
      "debate_messages_intervention_kind_check",
      sql`${table.interventionKind} IS NULL OR ${table.interventionKind} IN ('direction','statement')`,
    ),
    check(
      "debate_messages_intervention_apply_at_check",
      sql`${table.interventionApplyAt} IS NULL OR ${table.interventionApplyAt} IN ('next_turn','next_round')`,
    ),
    check(
      "debate_messages_intervention_boundary_check",
      sql`${table.interventionAppliesAfterRound} IS NULL OR ${table.interventionAppliesAfterRound} >= 0`,
    ),
    check(
      "debate_messages_intervention_turn_boundary_check",
      sql`${table.interventionAppliesAfterTurn} IS NULL OR ${table.interventionAppliesAfterTurn} >= 0`,
    ),
    check(
      "debate_messages_intervention_shape_check",
      sql`(${table.messageKind} = 'human') = (${table.interventionKind} IS NOT NULL)
        AND (${table.interventionKind} IS NULL) = (${table.interventionTargetActorId} IS NULL
          AND ${table.interventionApplyAt} IS NULL
          AND ${table.interventionAppliesAfterRound} IS NULL
          AND ${table.interventionAppliesAfterTurn} IS NULL)
        AND (${table.interventionKind} IS NULL OR (${table.interventionApplyAt} IS NOT NULL
          AND ${table.interventionAppliesAfterRound} IS NOT NULL
          AND ${table.interventionAppliesAfterTurn} IS NOT NULL))`,
    ),
  ],
);

export const debateFindings = pgTable(
  "debate_findings",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    debateRunId: text("debate_run_id").notNull(),
    messageId: text("message_id").notNull(),
    findingKey: text("finding_key").notNull(),
    severity: text("severity").notNull(),
    finding: text("finding").notNull(),
    recommendation: text("recommendation").notNull(),
    disposition: text("disposition").notNull().default("open"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("debate_findings_message_key_unique").on(table.messageId, table.findingKey),
    foreignKey({
      name: "debate_findings_message_scope_fk",
      columns: [table.debateRunId, table.messageId],
      foreignColumns: [debateMessages.debateRunId, debateMessages.id],
    }).onDelete("restrict"),
    check(
      "debate_findings_severity_check",
      sql`${table.severity} IN ('must_fix','should_fix','suggestion')`,
    ),
    check(
      "debate_findings_disposition_check",
      sql`${table.disposition} IN ('open','accepted','rejected','deferred','resolved')`,
    ),
  ],
);

export const debateRevisions = pgTable(
  "debate_revisions",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    debateRunId: text("debate_run_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    revisionKind: text("revision_kind").notNull(),
    supersedesRevisionId: text("supersedes_revision_id"),
    rationale: text("rationale").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("debate_revisions_run_number_unique").on(table.debateRunId, table.revisionNumber),
    foreignKey({
      name: "debate_revisions_run_scope_fk",
      columns: [table.projectId, table.debateId, table.debateRunId],
      foreignColumns: [debateRuns.projectId, debateRuns.debateId, debateRuns.id],
    }).onDelete("cascade"),
    lazyForeignKey(
      "debate_revisions_supersedes_fk",
      (): AnyPgColumn[] => [table.supersedesRevisionId],
      (): AnyPgColumn[] => [debateRevisions.id],
    ).onDelete("restrict"),
    check(
      "debate_revisions_kind_check",
      sql`${table.revisionKind} IN ('finding_disposition','judgment','final_output','correction')`,
    ),
    check("debate_revisions_number_check", sql`${table.revisionNumber} > 0`),
  ],
);

export const debateJudgments = pgTable(
  "debate_judgments",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    debateRunId: text("debate_run_id").notNull(),
    revisionId: text("revision_id"),
    judgeActorId: text("judge_actor_id"),
    conclusion: text("conclusion").notNull(),
    rationale: text("rationale").notNull(),
    evidence: jsonb("evidence").notNull().default([]),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "debate_judgments_run_scope_fk",
      columns: [table.projectId, table.debateId, table.debateRunId],
      foreignColumns: [debateRuns.projectId, debateRuns.debateId, debateRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "debate_judgments_revision_fk",
      columns: [table.revisionId],
      foreignColumns: [debateRevisions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "debate_judgments_actor_fk",
      columns: [table.debateId, table.judgeActorId],
      foreignColumns: [debateActors.debateId, debateActors.id],
    }).onDelete("restrict"),
    check("debate_judgments_hash_check", sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
  ],
);

export const debateFinalOutputs = pgTable(
  "debate_final_outputs",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    debateRunId: text("debate_run_id").notNull(),
    revisionId: text("revision_id"),
    judgmentId: text("judgment_id"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("debate_final_outputs_one_current_run_unique")
      .on(table.debateRunId)
      .where(sql`${table.revisionId} IS NULL`),
    foreignKey({
      name: "debate_final_outputs_run_scope_fk",
      columns: [table.projectId, table.debateId, table.debateRunId],
      foreignColumns: [debateRuns.projectId, debateRuns.debateId, debateRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "debate_final_outputs_revision_fk",
      columns: [table.revisionId],
      foreignColumns: [debateRevisions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "debate_final_outputs_judgment_fk",
      columns: [table.judgmentId],
      foreignColumns: [debateJudgments.id],
    }).onDelete("restrict"),
    check("debate_final_outputs_hash_check", sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
  ],
);

export const debateJobs = pgTable(
  "debate_jobs",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    debateRunId: text("debate_run_id").notNull(),
    turnAttemptId: text("turn_attempt_id").notNull(),
    jobKind: text("job_kind").notNull(),
    state: text("state").notNull().default("queued"),
    isDesignated: boolean("is_designated").notNull().default(true),
    deliveryAttempt: integer("delivery_attempt").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
    leaseToken: text("lease_token"),
    leasedUntil: timestamp("leased_until", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("debate_jobs_attempt_kind_unique").on(table.turnAttemptId, table.jobKind),
    uniqueIndex("debate_jobs_idempotency_unique").on(table.idempotencyKey),
    uniqueIndex("debate_jobs_designated_attempt_unique")
      .on(table.turnAttemptId)
      .where(sql`${table.isDesignated} = true`),
    index("debate_jobs_claim_idx").on(table.state, table.leasedUntil, table.createdAt),
    foreignKey({
      name: "debate_jobs_attempt_fk",
      columns: [table.projectId, table.debateId, table.debateRunId, table.turnAttemptId],
      foreignColumns: [
        debateTurnAttempts.projectId,
        debateTurnAttempts.debateId,
        debateTurnAttempts.debateRunId,
        debateTurnAttempts.id,
      ],
    }).onDelete("cascade"),
    check("debate_jobs_kind_check", sql`${table.jobKind} = 'execute_turn'`),
    check(
      "debate_jobs_state_check",
      sql`${table.state} IN ('queued','leased','succeeded','failed','cancelled','dead_letter')`,
    ),
    check("debate_jobs_delivery_attempt_check", sql`${table.deliveryAttempt} > 0`),
  ],
);

export const debateReservations = pgTable(
  "debate_reservations",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    debateRunId: text("debate_run_id").notNull(),
    turnAttemptId: text("turn_attempt_id").notNull(),
    amountUsd: money("amount_usd"),
    settledUsd: money("settled_usd"),
    releasedUsd: money("released_usd"),
    retainedUsd: money("retained_usd"),
    status: text("status").notNull().default("active"),
    resolutionOutcome: text("resolution_outcome"),
    version: integer("version").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("debate_reservations_attempt_unique").on(table.turnAttemptId),
    index("debate_reservations_status_expiry_idx").on(table.status, table.expiresAt),
    foreignKey({
      name: "debate_reservations_attempt_fk",
      columns: [table.projectId, table.debateId, table.debateRunId, table.turnAttemptId],
      foreignColumns: [
        debateTurnAttempts.projectId,
        debateTurnAttempts.debateId,
        debateTurnAttempts.debateRunId,
        debateTurnAttempts.id,
      ],
    }).onDelete("cascade"),
    check(
      "debate_reservations_status_check",
      sql`${table.status} IN ('active','retained_ambiguous','settled','released')`,
    ),
    check(
      "debate_reservations_balance_check",
      sql`(${table.status} = 'active' AND ${table.settledUsd} = 0 AND ${table.releasedUsd} = 0 AND ${table.retainedUsd} = 0) OR (${table.status} <> 'active' AND ${table.settledUsd} + ${table.releasedUsd} + ${table.retainedUsd} = ${table.amountUsd})`,
    ),
  ],
);

export const debateUsageEvents = pgTable(
  "debate_usage_events",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    debateRunId: text("debate_run_id").notNull(),
    turnAttemptId: text("turn_attempt_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runtime: text("runtime").notNull(),
    pricingSnapshot: jsonb("pricing_snapshot").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costUsd: money("cost_usd"),
    latencyMs: integer("latency_ms").notNull().default(0),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    index("debate_usage_events_run_time_idx").on(table.debateRunId, table.occurredAt),
    foreignKey({
      name: "debate_usage_events_attempt_fk",
      columns: [table.projectId, table.debateId, table.debateRunId, table.turnAttemptId],
      foreignColumns: [
        debateTurnAttempts.projectId,
        debateTurnAttempts.debateId,
        debateTurnAttempts.debateRunId,
        debateTurnAttempts.id,
      ],
    }).onDelete("cascade"),
    check(
      "debate_usage_events_nonnegative_check",
      sql`${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.costUsd} >= 0 AND ${table.latencyMs} >= 0`,
    ),
    check(
      "debate_usage_events_pricing_snapshot_check",
      sql`jsonb_typeof(${table.pricingSnapshot}) = 'object'`,
    ),
  ],
);

export const debateEvents = pgTable(
  "debate_events",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    debateId: text("debate_id").notNull(),
    debateRunId: text("debate_run_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    lifecycleVersion: integer("lifecycle_version"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    payload: jsonb("payload").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    uniqueIndex("debate_events_run_sequence_unique").on(table.debateRunId, table.sequence),
    index("debate_events_project_time_idx").on(table.projectId, table.occurredAt),
    foreignKey({
      name: "debate_events_run_scope_fk",
      columns: [table.projectId, table.debateId, table.debateRunId],
      foreignColumns: [debateRuns.projectId, debateRuns.debateId, debateRuns.id],
    }).onDelete("cascade"),
    check("debate_events_sequence_check", sql`${table.sequence} > 0`),
    check(
      "debate_events_actor_check",
      sql`${table.actorType} IN ('human','coordinator','agent','runner','system','legacy')`,
    ),
  ],
);

/** Immutable, effective-dated provider/model pricing used by canonical telemetry. */
export const aiPricingProfiles = pgTable(
  "ai_pricing_profiles",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(1),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    pricingVersion: text("pricing_version").notNull(),
    currency: text("currency").notNull(),
    inputPerMillion: numeric("input_per_million", { precision: 24, scale: 9 }).notNull(),
    outputPerMillion: numeric("output_per_million", { precision: 24, scale: 9 }).notNull(),
    cacheReadPerMillion: numeric("cache_read_per_million", { precision: 24, scale: 9 }),
    cacheWritePerMillion: numeric("cache_write_per_million", { precision: 24, scale: 9 }),
    source: text("source").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "string" }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("ai_pricing_profiles_version_unique").on(
      table.provider,
      table.model,
      table.pricingVersion,
    ),
    uniqueIndex("ai_pricing_profiles_effective_from_unique").on(
      table.provider,
      table.model,
      table.effectiveFrom,
    ),
    index("ai_pricing_profiles_effective_lookup_idx").on(
      table.provider,
      table.model,
      table.effectiveFrom,
    ),
    check("ai_pricing_profiles_schema_version_check", sql`${table.schemaVersion} = 1`),
    check("ai_pricing_profiles_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      "ai_pricing_profiles_identity_check",
      sql`length(trim(${table.provider})) > 0
        AND length(trim(${table.model})) > 0
        AND length(trim(${table.pricingVersion})) > 0
        AND length(trim(${table.source})) > 0`,
    ),
    check(
      "ai_pricing_profiles_price_check",
      sql`${table.inputPerMillion} >= 0
        AND ${table.outputPerMillion} >= 0
        AND (${table.cacheReadPerMillion} IS NULL OR ${table.cacheReadPerMillion} >= 0)
        AND (${table.cacheWritePerMillion} IS NULL OR ${table.cacheWritePerMillion} >= 0)`,
    ),
    check(
      "ai_pricing_profiles_effective_range_check",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
  ],
);

/** Append-only request lifecycle ledger; adjustments are signed delta events. */
export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(1),
    requestId: text("request_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    providerRequestId: text("provider_request_id"),
    endpoint: text("endpoint").notNull(),
    requestType: text("request_type").notNull(),
    retryGroupId: text("retry_group_id"),
    retryAttempt: integer("retry_attempt").notNull().default(0),
    initiatedByUserId: text("initiated_by_user_id").references(() => phase2Users.id, {
      onDelete: "restrict",
    }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "restrict" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "restrict" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    runId: text("run_id").references(() => agentRuns.id, { onDelete: "restrict" }),
    usageSource: text("usage_source").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    pricingProfileId: text("pricing_profile_id").references(() => aiPricingProfiles.id, {
      onDelete: "restrict",
    }),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
    costUsd: numeric("cost_usd", { precision: 24, scale: 9 }),
    costClassification: text("cost_classification").notNull(),
    latencyMs: integer("latency_ms"),
    httpStatus: integer("http_status"),
    errorCode: text("error_code"),
    errorCategory: text("error_category"),
    errorMessageRedacted: text("error_message_redacted"),
    sanitizedError: jsonb("sanitized_error"),
    adjustsEventId: text("adjusts_event_id").references((): AnyPgColumn => aiUsageEvents.id, {
      onDelete: "restrict",
    }),
  },
  (table) => [
    uniqueIndex("ai_usage_events_request_sequence_unique").on(table.requestId, table.sequence),
    index("ai_usage_events_request_time_idx").on(table.requestId, table.sequence),
    index("ai_usage_events_project_time_idx").on(table.projectId, table.occurredAt),
    index("ai_usage_events_user_time_idx").on(table.initiatedByUserId, table.occurredAt),
    index("ai_usage_events_phase_time_idx").on(table.phaseId, table.occurredAt),
    index("ai_usage_events_provider_model_time_idx").on(
      table.provider,
      table.model,
      table.occurredAt,
    ),
    index("ai_usage_events_status_time_idx").on(table.status, table.occurredAt),
    index("ai_usage_events_run_source_idx")
      .on(table.runId, table.requestType)
      .where(sql`${table.runId} IS NOT NULL`),
    foreignKey({
      name: "ai_usage_events_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_usage_events_task_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.phaseId, tasks.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_usage_events_run_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId, table.runId],
      foreignColumns: [agentRuns.projectId, agentRuns.phaseId, agentRuns.taskId, agentRuns.id],
    }).onDelete("restrict"),
    check("ai_usage_events_schema_version_check", sql`${table.schemaVersion} = 1`),
    check("ai_usage_events_sequence_check", sql`${table.sequence} > 0`),
    check(
      "ai_usage_events_event_type_check",
      sql`${table.eventType} IN (
        'request_started','usage_observed','request_completed','request_failed','adjustment'
      )`,
    ),
    check(
      "ai_usage_events_status_shape_check",
      sql`(${table.eventType} = 'request_started' AND ${table.status} = 'started')
        OR (${table.eventType} = 'usage_observed' AND ${table.status} = 'in_progress')
        OR (${table.eventType} = 'request_completed' AND ${table.status} = 'succeeded')
        OR (${table.eventType} = 'request_failed' AND ${table.status} = 'failed')
        OR (${table.eventType} = 'adjustment' AND ${table.status} = 'adjusted')`,
    ),
    check(
      "ai_usage_events_identity_check",
      sql`length(trim(${table.requestId})) > 0
        AND length(trim(${table.provider})) > 0
        AND length(trim(${table.model})) > 0
        AND length(trim(${table.endpoint})) > 0
        AND length(trim(${table.requestType})) > 0
        AND (${table.providerRequestId} IS NULL OR length(trim(${table.providerRequestId})) > 0)
        AND (${table.retryGroupId} IS NULL OR length(trim(${table.retryGroupId})) > 0)`,
    ),
    check(
      "ai_usage_events_scope_shape_check",
      sql`(${table.phaseId} IS NULL OR ${table.projectId} IS NOT NULL)
        AND (${table.taskId} IS NULL OR ${table.phaseId} IS NOT NULL)
        AND (${table.runId} IS NULL OR ${table.taskId} IS NOT NULL)`,
    ),
    check(
      "ai_usage_events_retry_shape_check",
      sql`${table.retryAttempt} >= 0
        AND (${table.retryAttempt} = 0 OR ${table.retryGroupId} IS NOT NULL)`,
    ),
    check(
      "ai_usage_events_usage_source_check",
      sql`${table.usageSource} IN (
        'provider_api','runtime_report','subscription_credit','estimate',
        'backfill','manual_adjustment','unavailable'
      )`,
    ),
    check(
      "ai_usage_events_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check(
      "ai_usage_events_cost_classification_check",
      sql`${table.costClassification} IN (
        'actual','estimated','subscription_consumption','unavailable'
      )`,
    ),
    check(
      "ai_usage_events_token_shape_check",
      sql`(
          ${table.eventType} = 'usage_observed'
          AND ${table.inputTokens} IS NOT NULL AND ${table.inputTokens} >= 0
        AND ${table.outputTokens} IS NOT NULL AND ${table.outputTokens} >= 0
        AND ${table.cacheReadTokens} IS NOT NULL AND ${table.cacheReadTokens} >= 0
        AND ${table.cacheWriteTokens} IS NOT NULL AND ${table.cacheWriteTokens} >= 0
        AND ${table.cacheReadTokens} + ${table.cacheWriteTokens} <= ${table.inputTokens}
        AND ${table.adjustsEventId} IS NULL
        ) OR (
          ${table.eventType} = 'adjustment'
          AND ${table.adjustsEventId} IS NOT NULL
          AND (
            COALESCE(${table.inputTokens}, 0) <> 0
            OR COALESCE(${table.outputTokens}, 0) <> 0
            OR COALESCE(${table.cacheReadTokens}, 0) <> 0
            OR COALESCE(${table.cacheWriteTokens}, 0) <> 0
            OR COALESCE(${table.costUsd}, 0) <> 0
          )
        ) OR (
          ${table.eventType} IN ('request_started','request_completed','request_failed')
          AND ${table.inputTokens} IS NULL
          AND ${table.outputTokens} IS NULL
          AND ${table.cacheReadTokens} IS NULL
          AND ${table.cacheWriteTokens} IS NULL
          AND ${table.costUsd} IS NULL
          AND ${table.adjustsEventId} IS NULL
        )`,
    ),
    check(
      "ai_usage_events_cost_shape_check",
      sql`(
          ${table.eventType} IN ('request_started','request_completed','request_failed')
          AND ${table.costClassification} = 'unavailable'
          AND ${table.costUsd} IS NULL
        ) OR (
          ${table.eventType} IN ('usage_observed','adjustment')
          AND (
            (
              ${table.costClassification} IN ('subscription_consumption','unavailable')
              AND ${table.costUsd} IS NULL
            ) OR (
              ${table.costClassification} IN ('actual','estimated')
              AND (
                (
                  ${table.eventType} = 'usage_observed'
                  AND ${table.costUsd} IS NOT NULL
                  AND ${table.costUsd} >= 0
                )
                OR ${table.eventType} = 'adjustment'
              )
            )
          )
        )`,
    ),
    check(
      "ai_usage_events_error_shape_check",
      sql`(
          ${table.eventType} = 'request_failed'
          AND (
            ${table.errorCode} IS NOT NULL
            OR ${table.errorCategory} IS NOT NULL
            OR ${table.errorMessageRedacted} IS NOT NULL
            OR ${table.sanitizedError} IS NOT NULL
          )
        ) OR (
          ${table.eventType} <> 'request_failed'
          AND ${table.errorCode} IS NULL
          AND ${table.errorCategory} IS NULL
          AND ${table.errorMessageRedacted} IS NULL
          AND ${table.sanitizedError} IS NULL
        )`,
    ),
    check(
      "ai_usage_events_latency_http_check",
      sql`(${table.latencyMs} IS NULL OR ${table.latencyMs} >= 0)
        AND (${table.httpStatus} IS NULL OR ${table.httpStatus} BETWEEN 100 AND 599)`,
    ),
    check(
      "ai_usage_events_sanitized_error_check",
      sql`${table.sanitizedError} IS NULL OR jsonb_typeof(${table.sanitizedError}) = 'object'`,
    ),
  ],
);

/** Configurable UTC period budget over canonical request usage facts. */
export const usageBudgetPolicies = pgTable(
  "usage_budget_policies",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(1),
    scopeType: text("scope_type").notNull(),
    scopeUserId: text("scope_user_id").references(() => phase2Users.id, {
      onDelete: "restrict",
    }),
    scopeProjectId: text("scope_project_id").references(() => projects.id, {
      onDelete: "restrict",
    }),
    period: text("period").notNull(),
    provider: text("provider"),
    model: text("model"),
    limitUsd: numeric("limit_usd", { precision: 24, scale: 9 }),
    limitTokens: bigint("limit_tokens", { mode: "number" }),
    thresholdPercentages: smallint("threshold_percentages")
      .array()
      .notNull()
      .default(sql`ARRAY[50,75,90,100]::smallint[]`),
    status: text("status").notNull().default("active"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("usage_budget_policies_one_active_scope_idx")
      .on(
        table.scopeType,
        sql`COALESCE(${table.scopeUserId}, '')`,
        sql`COALESCE(${table.scopeProjectId}, '')`,
        table.period,
        sql`COALESCE(${table.provider}, '')`,
        sql`COALESCE(${table.model}, '')`,
      )
      .where(sql`${table.status} = 'active'`),
    index("usage_budget_policies_user_status_idx").on(
      table.scopeUserId,
      table.status,
      table.period,
    ),
    index("usage_budget_policies_project_status_idx").on(
      table.scopeProjectId,
      table.status,
      table.period,
    ),
    check("usage_budget_policies_schema_version_check", sql`${table.schemaVersion} = 1`),
    check(
      "usage_budget_policies_scope_type_check",
      sql`${table.scopeType} IN ('global','user','project')`,
    ),
    check(
      "usage_budget_policies_scope_shape_check",
      sql`(${table.scopeType} = 'global'
          AND ${table.scopeUserId} IS NULL
          AND ${table.scopeProjectId} IS NULL)
        OR (${table.scopeType} = 'user'
          AND ${table.scopeUserId} IS NOT NULL
          AND ${table.scopeProjectId} IS NULL)
        OR (${table.scopeType} = 'project'
          AND ${table.scopeUserId} IS NULL
          AND ${table.scopeProjectId} IS NOT NULL)`,
    ),
    check(
      "usage_budget_policies_period_check",
      sql`${table.period} IN ('daily','weekly','monthly')`,
    ),
    check(
      "usage_budget_policies_provider_check",
      sql`${table.provider} IS NULL OR length(trim(${table.provider})) > 0`,
    ),
    check(
      "usage_budget_policies_model_check",
      sql`${table.model} IS NULL OR length(trim(${table.model})) > 0`,
    ),
    check(
      "usage_budget_policies_model_scope_check",
      sql`${table.model} IS NULL OR ${table.provider} IS NOT NULL`,
    ),
    check(
      "usage_budget_policies_limit_check",
      sql`(${table.limitUsd} IS NULL OR ${table.limitUsd} > 0)
        AND (${table.limitTokens} IS NULL OR ${table.limitTokens} > 0)
        AND (${table.limitUsd} IS NOT NULL OR ${table.limitTokens} IS NOT NULL)`,
    ),
    check(
      "usage_budget_policies_thresholds_check",
      sql`norns_valid_usage_budget_thresholds(${table.thresholdPercentages})`,
    ),
    check("usage_budget_policies_status_check", sql`${table.status} IN ('active','disabled')`),
  ],
);

/** One notification-ready record per policy/period/threshold/metric crossing. */
export const usageBudgetThresholdNotifications = pgTable(
  "usage_budget_threshold_notifications",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(1),
    policyId: text("policy_id")
      .notNull()
      .references(() => usageBudgetPolicies.id, { onDelete: "restrict" }),
    periodStart: timestamp("period_start", { withTimezone: true, mode: "string" }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true, mode: "string" }).notNull(),
    thresholdPercentage: smallint("threshold_percentage").notNull(),
    metric: text("metric").notNull(),
    consumedUsd: numeric("consumed_usd", { precision: 24, scale: 9 }).notNull(),
    consumedTokens: bigint("consumed_tokens", { mode: "number" }).notNull(),
    unpricedRequests: integer("unpriced_requests").notNull().default(0),
    limitUsd: numeric("limit_usd", { precision: 24, scale: 9 }),
    limitTokens: bigint("limit_tokens", { mode: "number" }),
    deliveryStatus: text("delivery_status").notNull().default("ready"),
    createdAt: createdAt(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "string" }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("usage_budget_threshold_notifications_dedupe").on(
      table.policyId,
      table.periodStart,
      table.thresholdPercentage,
      table.metric,
    ),
    index("usage_budget_threshold_notifications_ready_idx")
      .on(table.deliveryStatus, table.createdAt)
      .where(sql`${table.deliveryStatus} = 'ready'`),
    index("usage_budget_threshold_notifications_policy_period_idx").on(
      table.policyId,
      table.periodStart,
      table.thresholdPercentage,
    ),
    check(
      "usage_budget_threshold_notifications_schema_version_check",
      sql`${table.schemaVersion} = 1`,
    ),
    check(
      "usage_budget_threshold_notifications_period_check",
      sql`${table.periodEnd} > ${table.periodStart}`,
    ),
    check(
      "usage_budget_threshold_notifications_threshold_check",
      sql`${table.thresholdPercentage} BETWEEN 1 AND 100`,
    ),
    check(
      "usage_budget_threshold_notifications_metric_check",
      sql`${table.metric} IN ('usd','tokens')`,
    ),
    check(
      "usage_budget_threshold_notifications_consumption_check",
      sql`${table.consumedUsd} >= 0
        AND ${table.consumedTokens} >= 0
        AND ${table.unpricedRequests} >= 0`,
    ),
    check(
      "usage_budget_threshold_notifications_limit_check",
      sql`(${table.metric} = 'usd' AND ${table.limitUsd} IS NOT NULL AND ${table.limitUsd} > 0)
        OR (${table.metric} = 'tokens'
          AND ${table.limitTokens} IS NOT NULL
          AND ${table.limitTokens} > 0)`,
    ),
    check(
      "usage_budget_threshold_notifications_delivery_status_check",
      sql`${table.deliveryStatus} IN ('ready','delivered','dismissed')`,
    ),
    check(
      "usage_budget_threshold_notifications_delivery_check",
      sql`(${table.deliveryStatus} = 'ready'
          AND ${table.deliveredAt} IS NULL
          AND ${table.dismissedAt} IS NULL)
        OR (${table.deliveryStatus} = 'delivered'
          AND ${table.deliveredAt} IS NOT NULL
          AND ${table.dismissedAt} IS NULL)
        OR (${table.deliveryStatus} = 'dismissed' AND ${table.dismissedAt} IS NOT NULL)`,
    ),
  ],
);

/** Immutable provider plan or quota snapshot used for cycle calibration. */
export const aiProviderUsagePlans = pgTable(
  "ai_provider_usage_plans",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(1),
    provider: text("provider").notNull(),
    planName: text("plan_name").notNull(),
    allowanceUnit: text("allowance_unit").notNull(),
    allowanceAmount: numeric("allowance_amount", { precision: 30, scale: 9 }).notNull(),
    allowanceUsdEquivalent: numeric("allowance_usd_equivalent", {
      precision: 24,
      scale: 9,
    }),
    effectiveFrom: timestamp("effective_from", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true, mode: "string" }),
    source: text("source").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("ai_provider_usage_plans_provider_id_unique").on(table.id, table.provider),
    index("ai_provider_usage_plans_provider_effective_idx").on(
      table.provider,
      table.effectiveFrom,
      table.createdAt,
    ),
    check("ai_provider_usage_plans_schema_version_check", sql`${table.schemaVersion} = 1`),
    check("ai_provider_usage_plans_provider_check", sql`length(trim(${table.provider})) > 0`),
    check("ai_provider_usage_plans_name_check", sql`length(trim(${table.planName})) > 0`),
    check(
      "ai_provider_usage_plans_allowance_unit_check",
      sql`${table.allowanceUnit} IN ('tokens','requests','credits','usd_equivalent')`,
    ),
    check(
      "ai_provider_usage_plans_allowance_check",
      sql`${table.allowanceAmount} > 0
        AND (${table.allowanceUsdEquivalent} IS NULL
          OR ${table.allowanceUsdEquivalent} > 0)`,
    ),
    check(
      "ai_provider_usage_plans_effective_range_check",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check("ai_provider_usage_plans_source_check", sql`length(trim(${table.source})) > 0`),
  ],
);

/** Append-only provider reading paired with the canonical cycle-to-date facts. */
export const aiUsageCalibrationObservations = pgTable(
  "ai_usage_calibration_observations",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(1),
    planId: text("plan_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    subscriptionTier: text("subscription_tier").notNull(),
    cyclePeriod: text("cycle_period").notNull(),
    resetAt: timestamp("reset_at", { withTimezone: true, mode: "string" }).notNull(),
    cycleStart: timestamp("cycle_start", { withTimezone: true, mode: "string" }).notNull(),
    cycleEnd: timestamp("cycle_end", { withTimezone: true, mode: "string" }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
    providerReadingKind: text("provider_reading_kind").notNull(),
    providerReadingUnit: text("provider_reading_unit").notNull(),
    providerReadingValue: numeric("provider_reading_value", {
      precision: 30,
      scale: 9,
    }).notNull(),
    displayedPercentage: numeric("displayed_percentage", {
      precision: 7,
      scale: 4,
    }).notNull(),
    tokensUsedSinceReset: bigint("tokens_used_since_reset", { mode: "number" }).notNull(),
    impliedMaxTokens: numeric("implied_max_tokens", {
      precision: 30,
      scale: 9,
    }).notNull(),
    providerReadingUsdEquivalent: numeric("provider_reading_usd_equivalent", {
      precision: 24,
      scale: 9,
    }),
    canonicalRequests: integer("canonical_requests").notNull(),
    canonicalInputTokens: bigint("canonical_input_tokens", { mode: "number" }).notNull(),
    canonicalOutputTokens: bigint("canonical_output_tokens", { mode: "number" }).notNull(),
    canonicalCacheReadTokens: bigint("canonical_cache_read_tokens", {
      mode: "number",
    }).notNull(),
    canonicalCacheWriteTokens: bigint("canonical_cache_write_tokens", {
      mode: "number",
    }).notNull(),
    canonicalKnownCostUsd: numeric("canonical_known_cost_usd", {
      precision: 24,
      scale: 9,
    }),
    canonicalUnpricedRequests: integer("canonical_unpriced_requests").notNull().default(0),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    source: text("source").notNull(),
    evidenceNote: text("evidence_note"),
    recordedByUserId: text("recorded_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "ai_usage_calibration_observations_plan_fk",
      columns: [table.planId, table.provider],
      foreignColumns: [aiProviderUsagePlans.id, aiProviderUsagePlans.provider],
    }).onDelete("restrict"),
    index("ai_usage_calibration_provider_cycle_idx").on(
      table.provider,
      table.model,
      table.subscriptionTier,
      table.resetAt,
      table.observedAt,
    ),
    index("ai_usage_calibration_plan_time_idx").on(table.planId, table.observedAt),
    check(
      "ai_usage_calibration_observations_schema_version_check",
      sql`${table.schemaVersion} = 1`,
    ),
    check(
      "ai_usage_calibration_observations_provider_check",
      sql`length(trim(${table.provider})) > 0
        AND length(trim(${table.model})) > 0
        AND length(trim(${table.subscriptionTier})) > 0`,
    ),
    check(
      "ai_usage_calibration_observations_period_check",
      sql`${table.cyclePeriod} IN ('weekly','monthly')`,
    ),
    check(
      "ai_usage_calibration_observations_cycle_check",
      sql`${table.cycleEnd} > ${table.cycleStart}
        AND ${table.resetAt} = ${table.cycleStart}
        AND ${table.observedAt} >= ${table.cycleStart}
        AND ${table.observedAt} <= ${table.cycleEnd}`,
    ),
    check(
      "ai_usage_calibration_observations_reading_kind_check",
      sql`${table.providerReadingKind} IN ('used','remaining','utilization_percent')`,
    ),
    check(
      "ai_usage_calibration_observations_reading_unit_check",
      sql`${table.providerReadingUnit} IN ('tokens','requests','credits','usd_equivalent','percent')`,
    ),
    check(
      "ai_usage_calibration_observations_reading_shape_check",
      sql`${table.providerReadingValue} >= 0
        AND ${table.displayedPercentage} > 0
        AND ${table.displayedPercentage} <= 100
        AND ${table.tokensUsedSinceReset} >= 0
        AND ${table.impliedMaxTokens} >= 0
        AND (
          (${table.providerReadingKind} = 'utilization_percent'
            AND ${table.providerReadingUnit} = 'percent'
            AND ${table.providerReadingValue} <= 100)
          OR
          (${table.providerReadingKind} IN ('used','remaining')
            AND ${table.providerReadingUnit} <> 'percent')
        )`,
    ),
    check(
      "ai_usage_calibration_observations_nonnegative_check",
      sql`(${table.providerReadingUsdEquivalent} IS NULL
          OR ${table.providerReadingUsdEquivalent} >= 0)
        AND ${table.canonicalRequests} >= 0
        AND ${table.canonicalInputTokens} >= 0
        AND ${table.canonicalOutputTokens} >= 0
        AND ${table.canonicalCacheReadTokens} >= 0
        AND ${table.canonicalCacheWriteTokens} >= 0
        AND (${table.canonicalKnownCostUsd} IS NULL
          OR ${table.canonicalKnownCostUsd} >= 0)
        AND ${table.canonicalUnpricedRequests} >= 0`,
    ),
    check(
      "ai_usage_calibration_observations_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check(
      "ai_usage_calibration_observations_source_check",
      sql`${table.source} IN ('provider_api','runtime_report','manual','import')`,
    ),
    check(
      "ai_usage_calibration_observations_evidence_check",
      sql`${table.evidenceNote} IS NULL OR length(trim(${table.evidenceNote})) > 0`,
    ),
  ],
);

/** Singleton administrator-owned NORN.md applied to every future task briefing. */
export const globalRuleSettings = pgTable(
  "global_rule_settings",
  {
    id: text("id").primaryKey(),
    filename: text("filename").notNull(),
    content: text("content").notNull().default(""),
    version: integer("version").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("global_rule_settings_singleton_check", sql`${table.id} = 'global'`),
    check("global_rule_settings_filename_check", sql`${table.filename} = 'NORN.md'`),
    check("global_rule_settings_version_check", sql`${table.version} > 0`),
    check("global_rule_settings_updated_by_check", sql`length(trim(${table.updatedBy})) > 0`),
  ],
);

const conversationPlanningRuns = pgTable("planning_runs", {
  id: text("id").notNull(),
  projectId: text("project_id").notNull(),
});

const conversationAttachments = pgTable("attachments", {
  id: text("id").notNull(),
  projectId: text("project_id").notNull(),
});

export const workItems = pgTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    status: text("status").notNull().default("planning"),
    planningRunId: text("planning_run_id"),
    phaseId: text("phase_id"),
    approvedPlanVersionId: text("approved_plan_version_id"),
    aggregateVersion: aggregateVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    executionStartedAt: timestamp("execution_started_at", {
      withTimezone: true,
      mode: "string",
    }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    foreignKey({
      name: "work_items_planning_run_scope_fk",
      columns: [table.projectId, table.planningRunId],
      foreignColumns: [conversationPlanningRuns.projectId, conversationPlanningRuns.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "work_items_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("restrict"),
    lazyForeignKey(
      "work_items_approved_plan_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.id, table.approvedPlanVersionId],
      (): AnyPgColumn[] => [
        workPlanVersions.projectId,
        workPlanVersions.workItemId,
        workPlanVersions.id,
      ],
    ).onDelete("restrict"),
    uniqueIndex("work_items_project_identity_unique").on(table.projectId, table.id),
    uniqueIndex("work_items_planning_run_unique")
      .on(table.projectId, table.planningRunId)
      .where(sql`${table.planningRunId} IS NOT NULL`),
    index("work_items_project_status_time_idx").on(
      table.projectId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index("work_items_user_time_idx").on(table.createdByUserId, table.createdAt, table.id),
    index("work_items_phase_idx")
      .on(table.projectId, table.phaseId)
      .where(sql`${table.phaseId} IS NOT NULL`),
    check("work_items_schema_version_check", sql`${table.schemaVersion} = 2`),
    check(
      "work_items_title_objective_check",
      sql`length(trim(${table.title})) > 0 AND length(trim(${table.objective})) > 0`,
    ),
    check("work_items_aggregate_version_check", sql`${table.aggregateVersion} > 0`),
    check(
      "work_items_status_check",
      sql`${table.status} IN (
        'planning','in_qc','awaiting_approval','executing','blocked','completed','cancelled'
      )`,
    ),
    check(
      "work_items_completion_shape_check",
      sql`(${table.status} = 'completed') = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "work_items_execution_shape_check",
      sql`(${table.status} NOT IN ('executing','blocked','completed')
          OR (${table.phaseId} IS NOT NULL AND ${table.executionStartedAt} IS NOT NULL))
        AND (${table.executionStartedAt} IS NULL OR ${table.phaseId} IS NOT NULL)`,
    ),
  ],
);

export const workConversations = pgTable(
  "work_conversations",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("active"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    nextMessageSequence: bigint("next_message_sequence", { mode: "number" }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    foreignKey({
      name: "work_conversations_work_item_scope_fk",
      columns: [table.projectId, table.workItemId],
      foreignColumns: [workItems.projectId, workItems.id],
    }).onDelete("restrict"),
    uniqueIndex("work_conversations_project_work_identity_unique").on(
      table.projectId,
      table.workItemId,
      table.id,
    ),
    index("work_conversations_project_time_idx").on(table.projectId, table.createdAt, table.id),
    index("work_conversations_work_item_status_idx").on(
      table.workItemId,
      table.status,
      table.kind,
      table.createdAt,
      table.id,
    ),
    index("work_conversations_user_time_idx").on(table.createdByUserId, table.createdAt, table.id),
    uniqueIndex("work_conversations_one_active_primary_kind")
      .on(table.workItemId, table.kind)
      .where(sql`${table.status} = 'active' AND ${table.kind} IN ('planning','execution_pm')`),
    check("work_conversations_schema_version_check", sql`${table.schemaVersion} = 2`),
    check(
      "work_conversations_kind_check",
      sql`${table.kind} IN ('planning','execution_pm','task')`,
    ),
    check(
      "work_conversations_status_check",
      sql`${table.status} IN ('active','archived','closed')`,
    ),
    check(
      "work_conversations_archive_shape_check",
      sql`(${table.status} = 'archived') = (${table.archivedAt} IS NOT NULL)`,
    ),
    check(
      "work_conversations_provider_model_check",
      sql`length(trim(${table.provider})) > 0 AND length(trim(${table.model})) > 0`,
    ),
    check("work_conversations_next_message_sequence_check", sql`${table.nextMessageSequence} > 0`),
  ],
);

export const workMessages = pgTable(
  "work_messages",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    initiatedByUserId: text("initiated_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    role: text("role").notNull(),
    visibilityStatus: text("visibility_status").notNull().default("complete"),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    parts: jsonb("parts").notNull(),
    clientMessageId: text("client_message_id"),
    requestFingerprint: text("request_fingerprint"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "work_messages_conversation_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId],
      foreignColumns: [
        workConversations.projectId,
        workConversations.workItemId,
        workConversations.id,
      ],
    }).onDelete("restrict"),
    uniqueIndex("work_messages_project_work_conversation_identity_unique").on(
      table.projectId,
      table.workItemId,
      table.conversationId,
      table.id,
    ),
    uniqueIndex("work_messages_sequence_unique").on(table.conversationId, table.sequence),
    uniqueIndex("work_messages_user_submission_unique")
      .on(table.conversationId, table.initiatedByUserId, table.clientMessageId)
      .where(sql`${table.role} = 'user'`),
    index("work_messages_conversation_order_idx").on(table.conversationId, table.sequence),
    index("work_messages_project_time_idx").on(table.projectId, table.createdAt, table.id),
    index("work_messages_user_time_idx").on(table.initiatedByUserId, table.createdAt, table.id),
    check("work_messages_schema_version_check", sql`${table.schemaVersion} = 2`),
    check("work_messages_role_check", sql`${table.role} IN ('user','assistant','system')`),
    check(
      "work_messages_visibility_status_check",
      sql`${table.visibilityStatus} IN ('streaming','complete','interrupted')`,
    ),
    check(
      "work_messages_parts_shape_check",
      sql`jsonb_typeof(${table.parts}) = 'array'
        AND jsonb_array_length(${table.parts}) > 0`,
    ),
    check(
      "work_messages_submission_shape_check",
      sql`(
          ${table.role} = 'user'
          AND ${table.visibilityStatus} = 'complete'
          AND ${table.actorType} = 'human'
          AND ${table.actorId} = ${table.initiatedByUserId}
          AND ${table.clientMessageId} IS NOT NULL
          AND ${table.requestFingerprint} ~ '^[a-f0-9]{64}$'
        ) OR (
          ${table.role} <> 'user'
          AND ${table.clientMessageId} IS NULL
          AND ${table.requestFingerprint} IS NULL
        )`,
    ),
    check(
      "work_messages_visibility_shape_check",
      sql`${table.visibilityStatus} <> 'streaming' OR ${table.role} = 'assistant'`,
    ),
    check(
      "work_messages_human_actor_check",
      sql`${table.actorType} <> 'human' OR ${table.actorId} IS NOT NULL`,
    ),
  ],
);

export const workMessageAttachmentRefs = pgTable(
  "work_message_attachment_refs",
  {
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    messageId: text("message_id").notNull(),
    attachmentId: text("attachment_id").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    schemaVersion: integer("schema_version").notNull().default(2),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.attachmentId] }),
    foreignKey({
      name: "work_message_attachment_refs_message_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.messageId],
      foreignColumns: [
        workMessages.projectId,
        workMessages.workItemId,
        workMessages.conversationId,
        workMessages.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "work_message_attachment_refs_attachment_scope_fk",
      columns: [table.projectId, table.attachmentId],
      foreignColumns: [conversationAttachments.projectId, conversationAttachments.id],
    }).onDelete("restrict"),
    index("work_message_attachment_refs_attachment_idx").on(
      table.projectId,
      table.attachmentId,
      table.messageId,
    ),
    index("work_message_attachment_refs_user_time_idx").on(
      table.createdByUserId,
      table.createdAt,
      table.messageId,
    ),
    check("work_message_attachment_refs_schema_version_check", sql`${table.schemaVersion} = 2`),
  ],
);

export const conversationTurnAttempts = pgTable(
  "conversation_turn_attempts",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    initiatedByUserId: text("initiated_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    triggeringMessageId: text("triggering_message_id").notNull(),
    outputMessageId: text("output_message_id"),
    attemptNumber: integer("attempt_number").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    providerRequestId: text("provider_request_id"),
    usageRequestId: text("usage_request_id").notNull(),
    providerFinishReason: text("provider_finish_reason"),
    status: text("status").notNull().default("pending"),
    contextManifest: jsonb("context_manifest").notNull(),
    contextHash: text("context_hash").notNull(),
    usageStatus: text("usage_status").notNull().default("pending"),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
    costUsd: numeric("cost_usd", { precision: 24, scale: 9 }),
    failureCode: text("failure_code"),
    failureMessageRedacted: text("failure_message_redacted"),
    sanitizedFailure: jsonb("sanitized_failure"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "conversation_turn_attempts_conversation_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId],
      foreignColumns: [
        workConversations.projectId,
        workConversations.workItemId,
        workConversations.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_turn_attempts_trigger_message_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.triggeringMessageId],
      foreignColumns: [
        workMessages.projectId,
        workMessages.workItemId,
        workMessages.conversationId,
        workMessages.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_turn_attempts_output_message_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.outputMessageId],
      foreignColumns: [
        workMessages.projectId,
        workMessages.workItemId,
        workMessages.conversationId,
        workMessages.id,
      ],
    }).onDelete("restrict"),
    uniqueIndex("conversation_turn_attempts_retry_unique").on(
      table.conversationId,
      table.triggeringMessageId,
      table.attemptNumber,
    ),
    uniqueIndex("conversation_turn_attempts_provider_request_unique")
      .on(table.provider, table.providerRequestId)
      .where(sql`${table.providerRequestId} IS NOT NULL`),
    index("conversation_turn_attempts_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
    index("conversation_turn_attempts_project_time_idx").on(
      table.projectId,
      table.createdAt,
      table.id,
    ),
    index("conversation_turn_attempts_user_time_idx").on(
      table.initiatedByUserId,
      table.createdAt,
      table.id,
    ),
    uniqueIndex("conversation_turn_attempts_usage_request_unique").on(table.usageRequestId),
    uniqueIndex("conversation_turn_attempts_id_usage_request_unique").on(
      table.id,
      table.usageRequestId,
    ),
    check("conversation_turn_attempts_schema_version_check", sql`${table.schemaVersion} = 2`),
    check(
      "conversation_turn_attempts_status_check",
      sql`${table.status} IN ('pending','streaming','succeeded','failed','cancelled')`,
    ),
    check(
      "conversation_turn_attempts_usage_status_check",
      sql`${table.usageStatus} IN ('pending','exact','unavailable')`,
    ),
    check(
      "conversation_turn_attempts_terminal_shape_check",
      sql`(${table.status} IN ('succeeded','failed','cancelled'))
        = (${table.settledAt} IS NOT NULL)`,
    ),
    check(
      "conversation_turn_attempts_actor_check",
      sql`${table.actorType} IN ('human','coordinator','agent','runner','system','legacy')
        AND (${table.actorType} <> 'human' OR ${table.actorId} IS NOT NULL)`,
    ),
    check("conversation_turn_attempts_attempt_number_check", sql`${table.attemptNumber} > 0`),
    check(
      "conversation_turn_attempts_provider_model_check",
      sql`length(trim(${table.provider})) > 0
        AND length(trim(${table.model})) > 0
        AND length(trim(${table.usageRequestId})) > 0`,
    ),
    check(
      "conversation_turn_attempts_optional_provider_fields_check",
      sql`(${table.providerRequestId} IS NULL OR length(trim(${table.providerRequestId})) > 0)
        AND (${table.providerFinishReason} IS NULL
          OR length(trim(${table.providerFinishReason})) > 0)`,
    ),
    check(
      "conversation_turn_attempts_context_shape_check",
      sql`jsonb_typeof(${table.contextManifest}) = 'object'
        AND jsonb_typeof(${table.contextManifest}->'entries') = 'array'
        AND jsonb_typeof(${table.contextManifest}->'estimated_tokens') = 'number'
        AND ${table.contextHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "conversation_turn_attempts_usage_shape_check",
      sql`(
          ${table.usageStatus} = 'exact'
          AND ${table.inputTokens} IS NOT NULL
          AND ${table.outputTokens} IS NOT NULL
          AND ${table.cacheReadTokens} IS NOT NULL
          AND ${table.cacheWriteTokens} IS NOT NULL
        ) OR (
          ${table.usageStatus} <> 'exact'
          AND ${table.inputTokens} IS NULL
          AND ${table.outputTokens} IS NULL
          AND ${table.cacheReadTokens} IS NULL
          AND ${table.cacheWriteTokens} IS NULL
          AND ${table.costUsd} IS NULL
        )`,
    ),
    check(
      "conversation_turn_attempts_token_cost_nonnegative_check",
      sql`(${table.inputTokens} IS NULL OR ${table.inputTokens} >= 0)
        AND (${table.outputTokens} IS NULL OR ${table.outputTokens} >= 0)
        AND (${table.cacheReadTokens} IS NULL OR ${table.cacheReadTokens} >= 0)
        AND (${table.cacheWriteTokens} IS NULL OR ${table.cacheWriteTokens} >= 0)
        AND (${table.costUsd} IS NULL OR ${table.costUsd} >= 0)`,
    ),
    check(
      "conversation_turn_attempts_terminal_usage_check",
      sql`${table.status} NOT IN ('succeeded','failed','cancelled')
        OR ${table.usageStatus} <> 'pending'`,
    ),
    check(
      "conversation_turn_attempts_failure_shape_check",
      sql`(
          ${table.status} = 'failed' AND ${table.failureCode} IS NOT NULL
        ) OR (
          ${table.status} <> 'failed'
          AND ${table.failureCode} IS NULL
          AND ${table.failureMessageRedacted} IS NULL
          AND ${table.sanitizedFailure} IS NULL
        )`,
    ),
    check(
      "conversation_turn_attempts_success_shape_check",
      sql`${table.status} <> 'succeeded'
        OR (${table.outputMessageId} IS NOT NULL
          AND ${table.providerFinishReason} IS NOT NULL)`,
    ),
    check(
      "conversation_turn_attempts_sanitized_failure_check",
      sql`${table.sanitizedFailure} IS NULL
        OR jsonb_typeof(${table.sanitizedFailure}) = 'object'`,
    ),
  ],
);

export const conversationInferenceReservations = pgTable(
  "conversation_inference_reservations",
  {
    reservationKey: text("reservation_key")
      .primaryKey()
      .references(() => conversationTurnAttempts.id, { onDelete: "restrict" }),
    usageRequestId: text("usage_request_id").notNull().unique(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    initiatedByUserId: text("initiated_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    maxInputTokens: bigint("max_input_tokens", { mode: "number" }).notNull(),
    maxOutputTokens: bigint("max_output_tokens", { mode: "number" }).notNull(),
    maxChargeUsd: numeric("max_charge_usd", { precision: 24, scale: 9 }).notNull(),
    actualTokens: bigint("actual_tokens", { mode: "number" }).notNull().default(0),
    actualChargeUsd: numeric("actual_charge_usd", { precision: 24, scale: 9 })
      .notNull()
      .default("0"),
    status: text("status").notNull().default("active"),
    dispatchStartedAt: timestamp("dispatch_started_at", {
      withTimezone: true,
      mode: "string",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "conversation_inference_reservations_conversation_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId],
      foreignColumns: [
        workConversations.projectId,
        workConversations.workItemId,
        workConversations.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_inference_reservations_attempt_identity_fk",
      columns: [table.reservationKey, table.usageRequestId],
      foreignColumns: [conversationTurnAttempts.id, conversationTurnAttempts.usageRequestId],
    }).onDelete("restrict"),
    index("conversation_inference_reservations_policy_hold_idx").on(
      table.status,
      table.createdAt,
      table.projectId,
      table.initiatedByUserId,
      table.provider,
      table.model,
    ),
    check(
      "conversation_inference_reservations_token_quote_check",
      sql`${table.maxInputTokens} >= 0 AND ${table.maxOutputTokens} > 0`,
    ),
    check(
      "conversation_inference_reservations_charge_check",
      sql`${table.maxChargeUsd} >= 0
        AND ${table.actualTokens} >= 0 AND ${table.actualChargeUsd} >= 0`,
    ),
    check(
      "conversation_inference_reservations_status_check",
      sql`${table.status} IN ('active','settled','released','retained_ambiguous')`,
    ),
    check(
      "conversation_inference_reservations_shape_check",
      sql`(${table.status}='active' AND ${table.resolvedAt} IS NULL
          AND ${table.actualTokens}=0 AND ${table.actualChargeUsd}=0)
        OR (${table.status}='released' AND ${table.resolvedAt} IS NOT NULL
          AND ${table.actualTokens}=0 AND ${table.actualChargeUsd}=0)
        OR (${table.status}='settled' AND ${table.resolvedAt} IS NOT NULL)
        OR (${table.status}='retained_ambiguous' AND ${table.resolvedAt} IS NOT NULL
          AND ${table.actualTokens}=${table.maxInputTokens}+${table.maxOutputTokens}
          AND ${table.actualChargeUsd}=${table.maxChargeUsd})`,
    ),
  ],
);

export const conversationActions = pgTable(
  "conversation_actions",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    initiatedByUserId: text("initiated_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    sourceMessageId: text("source_message_id").notNull(),
    actionType: text("action_type").notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").notNull().default("proposed"),
    confirmedByUserId: text("confirmed_by_user_id").references(() => phase2Users.id, {
      onDelete: "restrict",
    }),
    confirmationIdempotencyKey: text("confirmation_idempotency_key"),
    confirmationRequestFingerprint: text("confirmation_request_fingerprint"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "string" }),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }),
    failureCode: text("failure_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "conversation_actions_source_message_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.sourceMessageId],
      foreignColumns: [
        workMessages.projectId,
        workMessages.workItemId,
        workMessages.conversationId,
        workMessages.id,
      ],
    }).onDelete("restrict"),
    uniqueIndex("conversation_actions_scope_identity_unique").on(
      table.projectId,
      table.workItemId,
      table.conversationId,
      table.id,
    ),
    uniqueIndex("conversation_actions_confirmation_idempotency_unique")
      .on(table.conversationId, table.confirmedByUserId, table.confirmationIdempotencyKey)
      .where(sql`${table.confirmationIdempotencyKey} IS NOT NULL`),
    uniqueIndex("conversation_actions_one_open_plan_choice")
      .on(table.conversationId, table.initiatedByUserId, table.actionType, table.payloadHash)
      .where(sql`${table.status} = 'proposed'
        AND ${table.actionType} IN (
          'save_plan_candidate','send_plan_to_qc','request_plan_changes',
          'approve_plan','reject_plan'
        )`),
    index("conversation_actions_conversation_status_idx").on(
      table.conversationId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index("conversation_actions_project_status_idx").on(
      table.projectId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index("conversation_actions_user_time_idx").on(
      table.initiatedByUserId,
      table.createdAt,
      table.id,
    ),
    check("conversation_actions_schema_version_check", sql`${table.schemaVersion} = 2`),
    check(
      "conversation_actions_status_check",
      sql`${table.status} IN (
        'proposed','confirmed','recorded','sent','agent_acknowledged',
        'applied','rejected','failed'
      )`,
    ),
    check(
      "conversation_actions_type_check",
      sql`${table.actionType} IN (
        'save_plan_candidate','send_plan_to_qc','request_plan_changes',
        'approve_plan','reject_plan','pause_work','resume_work','redirect_agent',
        'create_mockup','approve_mockup','revise_mockup','reject_mockup'
      )`,
    ),
    check(
      "conversation_actions_actor_check",
      sql`${table.actorType} IN ('human','coordinator','agent','runner','system','legacy')
        AND (${table.actorType} <> 'human' OR ${table.actorId} IS NOT NULL)`,
    ),
    check(
      "conversation_actions_payload_shape_check",
      sql`jsonb_typeof(${table.payload}) = 'object'
        AND ${table.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "conversation_actions_confirmation_shape_check",
      sql`(
          ${table.status} IN (
            'confirmed','recorded','sent','agent_acknowledged','applied','failed'
          )
          AND ${table.confirmedByUserId} IS NOT NULL
          AND ${table.confirmationIdempotencyKey} IS NOT NULL
          AND ${table.confirmationRequestFingerprint} ~ '^[a-f0-9]{64}$'
          AND ${table.confirmedAt} IS NOT NULL
        ) OR (
          ${table.status} IN ('proposed','rejected')
          AND ${table.confirmedByUserId} IS NULL
          AND ${table.confirmationIdempotencyKey} IS NULL
          AND ${table.confirmationRequestFingerprint} IS NULL
          AND ${table.confirmedAt} IS NULL
        )`,
    ),
    check(
      "conversation_actions_failure_shape_check",
      sql`(${table.status} = 'failed') = (${table.failureCode} IS NOT NULL)`,
    ),
    check(
      "conversation_actions_delivery_shape_check",
      sql`(
          ${table.status} IN ('proposed','confirmed','rejected')
          AND ${table.recordedAt} IS NULL
          AND ${table.sentAt} IS NULL
          AND ${table.acknowledgedAt} IS NULL
          AND ${table.appliedAt} IS NULL
        ) OR (
          ${table.status} = 'recorded'
          AND ${table.recordedAt} IS NOT NULL
          AND ${table.sentAt} IS NULL
          AND ${table.acknowledgedAt} IS NULL
          AND ${table.appliedAt} IS NULL
        ) OR (
          ${table.status} = 'sent'
          AND ${table.recordedAt} IS NOT NULL
          AND ${table.sentAt} IS NOT NULL
          AND ${table.acknowledgedAt} IS NULL
          AND ${table.appliedAt} IS NULL
        ) OR (
          ${table.status} = 'agent_acknowledged'
          AND ${table.recordedAt} IS NOT NULL
          AND ${table.sentAt} IS NOT NULL
          AND ${table.acknowledgedAt} IS NOT NULL
          AND ${table.appliedAt} IS NULL
        ) OR (
          ${table.status} = 'applied'
          AND ${table.recordedAt} IS NOT NULL
          AND ${table.sentAt} IS NOT NULL
          AND ${table.acknowledgedAt} IS NOT NULL
          AND ${table.appliedAt} IS NOT NULL
        ) OR (
          ${table.status} = 'failed'
          AND ${table.appliedAt} IS NULL
          AND (${table.sentAt} IS NULL OR ${table.recordedAt} IS NOT NULL)
          AND (${table.acknowledgedAt} IS NULL OR ${table.sentAt} IS NOT NULL)
        )`,
    ),
  ],
);

export const workPlanVersions = pgTable(
  "work_plan_versions",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    plan: jsonb("plan").notNull(),
    contentHash: text("content_hash").notNull(),
    createdByActionId: text("created_by_action_id"),
    supersedesPlanVersionId: text("supersedes_plan_version_id"),
    diffFromPrevious: jsonb("diff_from_previous"),
    approvedByUserId: text("approved_by_user_id").references(() => phase2Users.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "work_plan_versions_conversation_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId],
      foreignColumns: [
        workConversations.projectId,
        workConversations.workItemId,
        workConversations.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "work_plan_versions_created_by_action_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.createdByActionId],
      foreignColumns: [
        conversationActions.projectId,
        conversationActions.workItemId,
        conversationActions.conversationId,
        conversationActions.id,
      ],
    }).onDelete("restrict"),
    uniqueIndex("work_plan_versions_version_unique").on(table.workItemId, table.version),
    uniqueIndex("work_plan_versions_one_approved_per_work_item")
      .on(table.workItemId)
      .where(sql`${table.status} = 'approved'`),
    uniqueIndex("work_plan_versions_identity_unique").on(
      table.projectId,
      table.workItemId,
      table.id,
    ),
    uniqueIndex("work_plan_versions_conversation_identity_unique").on(
      table.projectId,
      table.workItemId,
      table.conversationId,
      table.id,
    ),
    lazyForeignKey(
      "work_plan_versions_supersedes_scope_fk",
      (): AnyPgColumn[] => [table.projectId, table.workItemId, table.supersedesPlanVersionId],
      (): AnyPgColumn[] => [
        workPlanVersions.projectId,
        workPlanVersions.workItemId,
        workPlanVersions.id,
      ],
    ).onDelete("restrict"),
    index("work_plan_versions_work_item_time_idx").on(table.workItemId, table.version),
    index("work_plan_versions_project_status_idx").on(
      table.projectId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index("work_plan_versions_user_time_idx").on(table.createdByUserId, table.createdAt, table.id),
    check("work_plan_versions_schema_version_check", sql`${table.schemaVersion} = 2`),
    check(
      "work_plan_versions_status_check",
      sql`${table.status} IN (
        'candidate','in_qc','changes_requested','approved','rejected','superseded'
      )`,
    ),
    check("work_plan_versions_version_check", sql`${table.version} > 0`),
    check(
      "work_plan_versions_content_shape_check",
      sql`jsonb_typeof(${table.plan}) = 'object'
        AND ${table.contentHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "work_plan_versions_diff_shape_check",
      sql`(
          ${table.version} = 1
          AND ${table.supersedesPlanVersionId} IS NULL
          AND ${table.diffFromPrevious} IS NULL
        ) OR (
          ${table.version} > 1
          AND ${table.supersedesPlanVersionId} IS NOT NULL
          AND jsonb_typeof(${table.diffFromPrevious}) = 'object'
        )`,
    ),
    check(
      "work_plan_versions_approval_shape_check",
      sql`(
          ${table.status} = 'approved'
          AND ${table.approvedByUserId} IS NOT NULL
          AND ${table.approvedAt} IS NOT NULL
        ) OR (
          ${table.status} <> 'approved'
          AND ${table.approvedByUserId} IS NULL
          AND ${table.approvedAt} IS NULL
        )`,
    ),
  ],
);

export const conversationPlanReviews = pgTable(
  "conversation_plan_reviews",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    actionId: text("action_id").notNull(),
    planVersionId: text("plan_version_id").notNull(),
    planningRunId: text("planning_run_id").notNull(),
    initiatedByUserId: text("initiated_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    pmProvider: text("pm_provider").notNull(),
    pmModel: text("pm_model").notNull(),
    reviewerProvider: text("reviewer_provider").notNull(),
    reviewerModel: text("reviewer_model").notNull(),
    usageRequestGroupId: text("usage_request_group_id").notNull(),
    status: text("status").notNull().default("queued"),
    seedPlan: jsonb("seed_plan").notNull(),
    planContentHash: text("plan_content_hash").notNull(),
    resultPlanContentHash: text("result_plan_content_hash").notNull(),
    contextReceipt: jsonb("context_receipt").notNull(),
    contextManifest: jsonb("context_manifest").notNull(),
    contextHash: text("context_hash").notNull(),
    findings: jsonb("findings").notNull().default([]),
    dispositions: jsonb("dispositions").notNull().default([]),
    revisedPlan: jsonb("revised_plan"),
    revisedPlanContentHash: text("revised_plan_content_hash"),
    revisedPlanVersionId: text("revised_plan_version_id"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    failureCode: text("failure_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "conversation_plan_reviews_action_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.actionId],
      foreignColumns: [
        conversationActions.projectId,
        conversationActions.workItemId,
        conversationActions.conversationId,
        conversationActions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_plan_reviews_plan_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.planVersionId],
      foreignColumns: [
        workPlanVersions.projectId,
        workPlanVersions.workItemId,
        workPlanVersions.conversationId,
        workPlanVersions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_plan_reviews_run_scope_fk",
      columns: [table.projectId, table.planningRunId],
      foreignColumns: [conversationPlanningRuns.projectId, conversationPlanningRuns.id],
    }).onDelete("restrict"),
    lazyForeignKey(
      "conversation_plan_reviews_revision_scope_fk",
      (): AnyPgColumn[] => [
        table.projectId,
        table.workItemId,
        table.conversationId,
        table.revisedPlanVersionId,
      ],
      (): AnyPgColumn[] => [
        workPlanVersions.projectId,
        workPlanVersions.workItemId,
        workPlanVersions.conversationId,
        workPlanVersions.id,
      ],
    ).onDelete("restrict"),
    uniqueIndex("conversation_plan_reviews_action_unique").on(table.actionId),
    uniqueIndex("conversation_plan_reviews_run_unique").on(table.planningRunId),
    uniqueIndex("conversation_plan_reviews_attempt_unique").on(
      table.planVersionId,
      table.attemptNumber,
    ),
    uniqueIndex("conversation_plan_reviews_identity_unique").on(
      table.projectId,
      table.workItemId,
      table.conversationId,
      table.id,
    ),
    uniqueIndex("conversation_plan_reviews_one_active_per_version")
      .on(table.planVersionId)
      .where(sql`${table.status} IN ('queued','running')`),
    index("conversation_plan_reviews_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
    index("conversation_plan_reviews_work_item_status_idx").on(
      table.workItemId,
      table.status,
      table.createdAt,
      table.id,
    ),
    check("conversation_plan_reviews_schema_version_check", sql`${table.schemaVersion} = 2`),
    check("conversation_plan_reviews_attempt_check", sql`${table.attemptNumber} > 0`),
    check(
      "conversation_plan_reviews_status_check",
      sql`${table.status} IN ('queued','running','converged','cap_reached','failed')`,
    ),
    check(
      "conversation_plan_reviews_provider_policy_check",
      sql`${table.pmProvider} IN ('anthropic','openai')
        AND ${table.reviewerProvider} IN ('anthropic','openai')
        AND ${table.pmProvider} <> ${table.reviewerProvider}
        AND length(trim(${table.pmModel})) > 0
        AND length(trim(${table.reviewerModel})) > 0`,
    ),
    check(
      "conversation_plan_reviews_content_check",
      sql`jsonb_typeof(${table.seedPlan}) = 'object'
        AND jsonb_typeof(${table.contextReceipt}) = 'object'
        AND jsonb_typeof(${table.contextManifest}) = 'object'
        AND jsonb_typeof(${table.findings}) = 'array'
        AND jsonb_typeof(${table.dispositions}) = 'array'
        AND ${table.planContentHash} ~ '^[a-f0-9]{64}$'
        AND ${table.resultPlanContentHash} ~ '^[a-f0-9]{64}$'
        AND ${table.contextHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const conversationPlanActionEffects = pgTable(
  "conversation_plan_action_effects",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    actionId: text("action_id").notNull(),
    effectKind: text("effect_kind").notNull(),
    planVersionId: text("plan_version_id").notNull(),
    planReviewId: text("plan_review_id"),
    planningRunId: text("planning_run_id"),
    executionStatus: text("execution_status"),
    executionStarted: boolean("execution_started"),
    executionDetail: text("execution_detail"),
    executionConversationId: text("execution_conversation_id"),
    handoffId: text("handoff_id"),
    kickoffIntentId: text("kickoff_intent_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "conversation_plan_action_effects_action_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.actionId],
      foreignColumns: [
        conversationActions.projectId,
        conversationActions.workItemId,
        conversationActions.conversationId,
        conversationActions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_plan_action_effects_plan_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.planVersionId],
      foreignColumns: [
        workPlanVersions.projectId,
        workPlanVersions.workItemId,
        workPlanVersions.conversationId,
        workPlanVersions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_plan_action_effects_review_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.planReviewId],
      foreignColumns: [
        conversationPlanReviews.projectId,
        conversationPlanReviews.workItemId,
        conversationPlanReviews.conversationId,
        conversationPlanReviews.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_plan_action_effects_run_scope_fk",
      columns: [table.projectId, table.planningRunId],
      foreignColumns: [conversationPlanningRuns.projectId, conversationPlanningRuns.id],
    }).onDelete("restrict"),
    uniqueIndex("conversation_plan_action_effects_action_unique").on(table.actionId),
    uniqueIndex("conversation_plan_action_effects_identity_unique").on(
      table.projectId,
      table.workItemId,
      table.conversationId,
      table.id,
    ),
    index("conversation_plan_action_effects_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
    check("conversation_plan_action_effects_schema_version_check", sql`${table.schemaVersion} = 2`),
    check(
      "conversation_plan_action_effects_kind_check",
      sql`${table.effectKind} IN (
        'plan_saved','qc_started','changes_requested','plan_approved','plan_rejected'
      )`,
    ),
  ],
);

export const conversationPlanProposalAttempts = pgTable(
  "conversation_plan_proposal_attempts",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    initiatedByUserId: text("initiated_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    sourceMessageId: text("source_message_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    usageRequestId: text("usage_request_id").notNull(),
    retryAttempt: integer("retry_attempt").notNull().default(0),
    providerRequestId: text("provider_request_id"),
    usageStatus: text("usage_status").notNull().default("pending"),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
    costUsd: numeric("cost_usd", { precision: 18, scale: 6 }),
    status: text("status").notNull().default("pending"),
    contextManifest: jsonb("context_manifest").notNull(),
    contextHash: text("context_hash").notNull(),
    outputMessageId: text("output_message_id"),
    actionId: text("action_id"),
    planContentHash: text("plan_content_hash"),
    failureCode: text("failure_code"),
    failureMessageRedacted: text("failure_message_redacted"),
    sanitizedFailure: jsonb("sanitized_failure"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "conversation_plan_proposals_source_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.sourceMessageId],
      foreignColumns: [
        workMessages.projectId,
        workMessages.workItemId,
        workMessages.conversationId,
        workMessages.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_plan_proposals_output_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.outputMessageId],
      foreignColumns: [
        workMessages.projectId,
        workMessages.workItemId,
        workMessages.conversationId,
        workMessages.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_plan_proposals_action_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.actionId],
      foreignColumns: [
        conversationActions.projectId,
        conversationActions.workItemId,
        conversationActions.conversationId,
        conversationActions.id,
      ],
    }).onDelete("restrict"),
    uniqueIndex("conversation_plan_proposals_idempotency_unique").on(
      table.conversationId,
      table.initiatedByUserId,
      table.idempotencyKey,
    ),
    uniqueIndex("conversation_plan_proposals_usage_request_unique").on(table.usageRequestId),
    uniqueIndex("conversation_plan_proposals_one_pending_per_conversation")
      .on(table.conversationId)
      .where(sql`${table.status} = 'pending'`),
    index("conversation_plan_proposals_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const conversationPlanChangeProposals = pgTable(
  "conversation_plan_change_proposals",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    initiatedByUserId: text("initiated_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    planVersionId: text("plan_version_id").notNull(),
    planContentHash: text("plan_content_hash").notNull(),
    direction: text("direction").notNull(),
    directionHash: text("direction_hash").notNull(),
    messageId: text("message_id").notNull(),
    actionId: text("action_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "conversation_plan_change_proposals_plan_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.planVersionId],
      foreignColumns: [
        workPlanVersions.projectId,
        workPlanVersions.workItemId,
        workPlanVersions.conversationId,
        workPlanVersions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_plan_change_proposals_message_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.messageId],
      foreignColumns: [
        workMessages.projectId,
        workMessages.workItemId,
        workMessages.conversationId,
        workMessages.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_plan_change_proposals_action_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.actionId],
      foreignColumns: [
        conversationActions.projectId,
        conversationActions.workItemId,
        conversationActions.conversationId,
        conversationActions.id,
      ],
    }).onDelete("restrict"),
    uniqueIndex("conversation_plan_change_proposals_idempotency_unique").on(
      table.conversationId,
      table.initiatedByUserId,
      table.idempotencyKey,
    ),
    index("conversation_plan_change_proposals_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const conversationHandoffs = pgTable(
  "conversation_handoffs",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    sourceConversationId: text("source_conversation_id").notNull(),
    targetConversationId: text("target_conversation_id").notNull(),
    approvedPlanVersionId: text("approved_plan_version_id").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    package: jsonb("package").notNull(),
    canonicalPackage: text("canonical_package"),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "conversation_handoffs_source_scope_fk",
      columns: [table.projectId, table.workItemId, table.sourceConversationId],
      foreignColumns: [
        workConversations.projectId,
        workConversations.workItemId,
        workConversations.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_handoffs_approved_plan_scope_fk",
      columns: [table.projectId, table.workItemId, table.approvedPlanVersionId],
      foreignColumns: [
        workPlanVersions.projectId,
        workPlanVersions.workItemId,
        workPlanVersions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_handoffs_target_scope_fk",
      columns: [table.projectId, table.workItemId, table.targetConversationId],
      foreignColumns: [
        workConversations.projectId,
        workConversations.workItemId,
        workConversations.id,
      ],
    }).onDelete("restrict"),
    uniqueIndex("conversation_handoffs_transition_unique").on(
      table.sourceConversationId,
      table.targetConversationId,
      table.kind,
    ),
    uniqueIndex("conversation_handoffs_approved_plan_unique").on(table.approvedPlanVersionId),
    index("conversation_handoffs_work_item_time_idx").on(
      table.workItemId,
      table.createdAt,
      table.id,
    ),
    index("conversation_handoffs_project_time_idx").on(table.projectId, table.createdAt, table.id),
    index("conversation_handoffs_user_time_idx").on(
      table.createdByUserId,
      table.createdAt,
      table.id,
    ),
    check("conversation_handoffs_schema_version_check", sql`${table.schemaVersion} = 2`),
    check("conversation_handoffs_kind_check", sql`${table.kind} = 'planning_to_execution'`),
    check(
      "conversation_handoffs_distinct_conversations_check",
      sql`${table.sourceConversationId} <> ${table.targetConversationId}`,
    ),
    check(
      "conversation_handoffs_package_shape_check",
      sql`jsonb_typeof(${table.package}) = 'object'
        AND ${table.contentHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const conversationSummaries = pgTable(
  "conversation_summaries",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    fromMessageSequence: bigint("from_message_sequence", { mode: "number" }).notNull(),
    throughMessageSequence: bigint("through_message_sequence", { mode: "number" }).notNull(),
    summary: jsonb("summary").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "conversation_summaries_conversation_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId],
      foreignColumns: [
        workConversations.projectId,
        workConversations.workItemId,
        workConversations.id,
      ],
    }).onDelete("restrict"),
    uniqueIndex("conversation_summaries_version_unique").on(table.conversationId, table.version),
    index("conversation_summaries_conversation_version_idx").on(
      table.conversationId,
      table.version,
    ),
    index("conversation_summaries_project_time_idx").on(table.projectId, table.createdAt, table.id),
    index("conversation_summaries_user_time_idx").on(
      table.createdByUserId,
      table.createdAt,
      table.id,
    ),
    check("conversation_summaries_schema_version_check", sql`${table.schemaVersion} = 2`),
    check(
      "conversation_summaries_range_check",
      sql`${table.throughMessageSequence} >= ${table.fromMessageSequence}`,
    ),
    check("conversation_summaries_version_check", sql`${table.version} > 0`),
    check(
      "conversation_summaries_content_shape_check",
      sql`jsonb_typeof(${table.summary}) = 'object'
        AND ${table.contentHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const conversationKickoffIntents = pgTable(
  "conversation_kickoff_intents",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    sourceConversationId: text("source_conversation_id").notNull(),
    executionConversationId: text("execution_conversation_id").notNull(),
    actionId: text("action_id").notNull(),
    approvedPlanVersionId: text("approved_plan_version_id").notNull(),
    planReviewId: text("plan_review_id").notNull(),
    planningRunId: text("planning_run_id").notNull(),
    handoffId: text("handoff_id").notNull(),
    decidedByUserId: text("decided_by_user_id").notNull(),
    status: text("status").notNull().default("pending"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    executionStarted: boolean("execution_started"),
    executionDetail: text("execution_detail"),
    phaseId: text("phase_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("conversation_kickoff_intents_action_unique").on(table.actionId),
    uniqueIndex("conversation_kickoff_intents_handoff_unique").on(table.handoffId),
    index("conversation_kickoff_intents_dispatch_idx").on(
      table.status,
      table.leaseExpiresAt,
      table.createdAt,
      table.id,
    ),
  ],
);

export const conversationTaskPackages = pgTable(
  "conversation_task_packages",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    handoffId: text("handoff_id").notNull(),
    approvedPlanVersionId: text("approved_plan_version_id").notNull(),
    moduleId: text("module_id").notNull(),
    package: jsonb("package").notNull(),
    canonicalPackage: text("canonical_package").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("conversation_task_packages_module_unique").on(table.handoffId, table.moduleId),
    uniqueIndex("conversation_task_packages_scope_unique").on(
      table.projectId,
      table.workItemId,
      table.conversationId,
      table.id,
    ),
  ],
);

export const conversationTaskPackageBindings = pgTable(
  "conversation_task_package_bindings",
  {
    packageId: text("package_id").primaryKey(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    handoffId: text("handoff_id").notNull(),
    phaseId: text("phase_id").notNull(),
    taskId: text("task_id").notNull(),
    contentHash: text("content_hash").notNull(),
    contextDocumentId: text("context_document_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("conversation_task_package_bindings_task_unique").on(table.taskId)],
);

export const conversationTaskPackageRuns = pgTable("conversation_task_package_runs", {
  runId: text("run_id").primaryKey(),
  packageId: text("package_id").notNull(),
  projectId: text("project_id").notNull(),
  phaseId: text("phase_id").notNull(),
  taskId: text("task_id").notNull(),
  contentHash: text("content_hash").notNull(),
  contextDocumentId: text("context_document_id").notNull(),
  createdAt: createdAt(),
});

export const conversationPlanningExcerptReceipts = pgTable(
  "conversation_planning_excerpt_receipts",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    sourceConversationId: text("source_conversation_id").notNull(),
    targetConversationId: text("target_conversation_id").notNull(),
    handoffId: text("handoff_id").notNull(),
    requestedByUserId: text("requested_by_user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    sourceMessageIds: jsonb("source_message_ids").notNull(),
    sourceMessageHashes: jsonb("source_message_hashes").notNull(),
    resultMessageId: text("result_message_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("conversation_planning_excerpt_idempotency_unique").on(
      table.targetConversationId,
      table.requestedByUserId,
      table.idempotencyKey,
    ),
    uniqueIndex("conversation_planning_excerpt_result_unique").on(table.resultMessageId),
  ],
);

export const conversationCompactionReceipts = pgTable(
  "conversation_compaction_receipts",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    summaryId: text("summary_id").notNull(),
    milestone: text("milestone").notNull(),
    sourceMessageIds: jsonb("source_message_ids").notNull(),
    sourceMessageHashes: jsonb("source_message_hashes").notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("conversation_compaction_receipts_summary_unique").on(table.summaryId)],
);

/** Phase 5 forward overlays; the Phase 1/0001 declarations above remain frozen. */
export const phase5RunnerEvents = pgTable(
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
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
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
    check("runner_events_correlation_check", sql`length(trim(${table.correlationId})) > 0`),
  ],
);

export const phase5ConversationActions = pgTable(
  "conversation_actions",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(2),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    initiatedByUserId: text("initiated_by_user_id")
      .notNull()
      .references(() => phase2Users.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    sourceMessageId: text("source_message_id").notNull(),
    actionType: text("action_type").notNull(),
    interactionClass: text("interaction_class").notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").notNull().default("proposed"),
    confirmedByUserId: text("confirmed_by_user_id").references(() => phase2Users.id, {
      onDelete: "restrict",
    }),
    confirmationIdempotencyKey: text("confirmation_idempotency_key"),
    confirmationRequestFingerprint: text("confirmation_request_fingerprint"),
    proposalIdempotencyKey: text("proposal_idempotency_key"),
    proposalRequestFingerprint: text("proposal_request_fingerprint"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "string" }),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }),
    failureCode: text("failure_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "conversation_actions_source_message_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.sourceMessageId],
      foreignColumns: [
        workMessages.projectId,
        workMessages.workItemId,
        workMessages.conversationId,
        workMessages.id,
      ],
    }).onDelete("restrict"),
    uniqueIndex("conversation_actions_scope_identity_unique").on(
      table.projectId,
      table.workItemId,
      table.conversationId,
      table.id,
    ),
    uniqueIndex("conversation_actions_proposal_idempotency_unique")
      .on(table.conversationId, table.initiatedByUserId, table.proposalIdempotencyKey)
      .where(sql`${table.proposalIdempotencyKey} IS NOT NULL`),
    check(
      "conversation_actions_interaction_class_check",
      sql`${table.interactionClass} = CASE
        WHEN ${table.actionType} IN ('save_plan_candidate','request_plan_changes','propose_plan_change')
          THEN 'plan_change_proposal'
        WHEN ${table.actionType} IN (
          'send_plan_to_qc','approve_plan','reject_plan','approve_plan_change',
          'approve_mockup','reject_mockup'
        ) THEN 'approval'
        WHEN ${table.actionType} IN ('record_human_decision','answer_human_wait')
          THEN 'human_decision'
        WHEN ${table.actionType}='redirect_agent' THEN 'task_direction'
        WHEN ${table.actionType}='pause_work' THEN 'pause'
        WHEN ${table.actionType}='resume_work' THEN 'resume'
        WHEN ${table.actionType} IN ('create_mockup','revise_mockup') THEN 'mockup_request'
      END`,
    ),
  ],
);

export const conversationActionDeliveryIntents = pgTable(
  "conversation_action_delivery_intents",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    actionId: text("action_id").notNull().unique(),
    deliveryMode: text("delivery_mode").notNull(),
    targetRunId: text("target_run_id"),
    targetCommandId: text("target_command_id"),
    targetRunnerGeneration: integer("target_runner_generation"),
    status: text("status").notNull().default("queued"),
    payload: jsonb("payload").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("conversation_action_delivery_intents_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const conversationActionDeliveryEvents = pgTable(
  "conversation_action_delivery_events",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    actionId: text("action_id").notNull(),
    sequence: integer("sequence").notNull(),
    status: text("status").notNull(),
    deliveryMode: text("delivery_mode").notNull(),
    targetRunId: text("target_run_id"),
    targetCommandId: text("target_command_id"),
    receipt: jsonb("receipt").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("conversation_action_delivery_events_action_sequence_unique").on(
      table.actionId,
      table.sequence,
    ),
    index("conversation_action_delivery_events_scope_idx").on(
      table.projectId,
      table.conversationId,
      table.occurredAt,
      table.id,
    ),
  ],
);

export const runCommandUsageReceipts = pgTable(
  "run_command_usage_receipts",
  {
    commandId: text("command_id").primaryKey(),
    runId: text("run_id").notNull(),
    projectId: text("project_id").notNull(),
    phaseId: text("phase_id").notNull(),
    taskId: text("task_id").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 24, scale: 9 }).notNull().default("0"),
    activeMs: bigint("active_ms", { mode: "number" }).notNull().default(0),
    usageSource: text("usage_source").notNull().default("runner_report"),
    status: text("status").notNull().default("observing"),
    lastUsageEventId: text("last_usage_event_id"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    terminalEventId: text("terminal_event_id").unique(),
    terminalAt: timestamp("terminal_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("run_command_usage_receipts_run_idx").on(table.runId, table.status, table.commandId),
  ],
);

export const conversationExecutionPlanChangeRequests = pgTable(
  "conversation_execution_plan_change_requests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    actionId: text("action_id").notNull().unique(),
    planVersionId: text("plan_version_id").notNull(),
    planHash: text("plan_hash").notNull(),
    direction: text("direction").notNull(),
    rationale: text("rationale").notNull(),
    status: text("status").notNull().default("proposed"),
    approvedByActionId: text("approved_by_action_id").unique(),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
  },
);

export const conversationMockupRequests = pgTable(
  "conversation_mockup_requests",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    actionId: text("action_id").notNull().unique(),
    taskId: text("task_id"),
    rootRequestId: text("root_request_id").notNull(),
    sourceMockupVersionId: text("source_mockup_version_id"),
    payloadHash: text("payload_hash").notNull(),
    brief: text("brief").notNull(),
    target: text("target").notNull(),
    artifactRefs: jsonb("artifact_refs").notNull(),
    revisionDirection: text("revision_direction"),
    status: text("status").notNull().default("queued"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "string" }).notNull(),
    lastError: text("last_error"),
    renderedVersionId: text("rendered_version_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("conversation_mockup_requests_scope_unique").on(
      table.projectId,
      table.workItemId,
      table.conversationId,
      table.id,
    ),
    index("conversation_mockup_requests_worker_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "conversation_mockup_requests_action_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.actionId],
      foreignColumns: [
        conversationActions.projectId,
        conversationActions.workItemId,
        conversationActions.conversationId,
        conversationActions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_mockup_requests_task_id_tasks_id_fk",
      columns: [table.taskId],
      foreignColumns: [tasks.id],
    }).onDelete("restrict"),
    lazyForeignKey(
      "conversation_mockup_requests_source_version_fk",
      (): AnyPgColumn[] => [table.sourceMockupVersionId],
      (): AnyPgColumn[] => [conversationMockupVersions.id],
    ).onDelete("restrict"),
    lazyForeignKey(
      "conversation_mockup_requests_rendered_version_fk",
      (): AnyPgColumn[] => [table.renderedVersionId],
      (): AnyPgColumn[] => [conversationMockupVersions.id],
    ).onDelete("restrict"),
    check("conversation_mockup_requests_brief_check", sql`length(trim(${table.brief})) > 0`),
    check(
      "conversation_mockup_requests_target_check",
      sql`${table.target} IN ('desktop','mobile','responsive')`,
    ),
    check(
      "conversation_mockup_requests_artifact_refs_check",
      sql`jsonb_typeof(${table.artifactRefs})='array'`,
    ),
    check(
      "conversation_mockup_requests_status_check",
      sql`${table.status} IN ('queued','leased','rendered','failed','cancelled')`,
    ),
    check("conversation_mockup_requests_hash_check", sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`),
    check("conversation_mockup_requests_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "conversation_mockup_requests_revision_shape_check",
      sql`(
        (${table.sourceMockupVersionId} IS NULL AND ${table.rootRequestId}=${table.id}
          AND ${table.revisionDirection} IS NULL)
        OR (${table.sourceMockupVersionId} IS NOT NULL AND ${table.revisionDirection} IS NOT NULL)
      )`,
    ),
    check(
      "conversation_mockup_requests_lease_shape_check",
      sql`(
        (${table.status}='leased' AND ${table.leaseOwner} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL)
        OR (${table.status}<>'leased' AND ${table.leaseOwner} IS NULL
          AND ${table.leaseExpiresAt} IS NULL)
      )`,
    ),
    check(
      "conversation_mockup_requests_result_shape_check",
      sql`(
        (${table.status}='rendered' AND ${table.renderedVersionId} IS NOT NULL
          AND ${table.lastError} IS NULL)
        OR (${table.status}='failed' AND ${table.renderedVersionId} IS NULL
          AND ${table.lastError} IS NOT NULL)
        OR (${table.status} IN ('queued','leased','cancelled')
          AND ${table.renderedVersionId} IS NULL)
      )`,
    ),
  ],
);

/**
 * Migration 0040 is deliberately hand-authored: its composite foreign keys,
 * CHECK constraints, deferred guards, immutable triggers, and grants are the
 * runtime authority. These declarations mirror its query surface and named
 * indexes. `v2PreservationSchema.test.ts` pins the complete critical catalog;
 * this schema is never a license to replace 0040 with schema-push output.
 */
export const artifactBlobs = pgTable(
  "artifact_blobs",
  {
    artifactId: text("artifact_id")
      .primaryKey()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    projectId: text("project_id").notNull(),
    content: bytea("content").notNull(),
    contentHash: text("content_hash").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("artifact_blobs_project_hash_idx").on(table.projectId, table.contentHash),
    foreignKey({
      name: "artifact_blobs_project_id_artifact_id_artifacts_project_id_id_fk",
      columns: [table.projectId, table.artifactId],
      foreignColumns: [artifacts.projectId, artifacts.id],
    }).onDelete("restrict"),
    check("artifact_blobs_content_check", sql`octet_length(${table.content}) > 0`),
    check(
      "artifact_blobs_content_hash_check",
      sql`${table.contentHash} ~ '^[a-f0-9]{64}$'
        AND ${table.contentHash}=encode(sha256(${table.content}),'hex')`,
    ),
    check(
      "artifact_blobs_byte_size_check",
      sql`${table.byteSize} > 0 AND ${table.byteSize}=octet_length(${table.content})`,
    ),
  ],
);

export const phase6IdempotencyClaims = pgTable(
  "phase6_idempotency_claims",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    operation: text("operation").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    resourceId: text("resource_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "phase6_idempotency_claims_pkey",
      columns: [
        table.projectId,
        table.operation,
        table.actorType,
        table.actorId,
        table.idempotencyKey,
      ],
    }),
    check(
      "phase6_idempotency_claims_operation_check",
      sql`${table.operation} IN ('artifact_put','deployment_create','deployment_observation')`,
    ),
    check("phase6_idempotency_claims_actor_type_check", sql`length(trim(${table.actorType}))>0`),
    check("phase6_idempotency_claims_actor_id_check", sql`length(trim(${table.actorId}))>0`),
    check(
      "phase6_idempotency_claims_idempotency_key_check",
      sql`length(trim(${table.idempotencyKey}))>0`,
    ),
    check(
      "phase6_idempotency_claims_request_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check("phase6_idempotency_claims_resource_id_check", sql`length(trim(${table.resourceId}))>0`),
  ],
);

export const conversationMockupVersions = pgTable(
  "conversation_mockup_versions",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    rootRequestId: text("root_request_id")
      .notNull()
      .references(() => conversationMockupRequests.id, { onDelete: "restrict" }),
    requestId: text("request_id")
      .notNull()
      .unique()
      .references(() => conversationMockupRequests.id, { onDelete: "restrict" }),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    createdByActionId: text("created_by_action_id")
      .notNull()
      .unique()
      .references(() => conversationActions.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    brief: text("brief").notNull(),
    target: text("target").notNull(),
    interactionNotes: jsonb("interaction_notes").notNull(),
    manifestArtifactId: text("manifest_artifact_id")
      .notNull()
      .unique()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    manifestArtifactHash: text("manifest_artifact_hash").notNull(),
    canonicalManifest: text("canonical_manifest").notNull(),
    rendererProfile: jsonb("renderer_profile").notNull(),
    supersedesMockupVersionId: text("supersedes_mockup_version_id"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("conversation_mockup_versions_root_version_unique").on(
      table.rootRequestId,
      table.version,
    ),
    uniqueIndex("conversation_mockup_versions_project_id_unique").on(table.projectId, table.id),
    uniqueIndex("conversation_mockup_versions_scope_unique").on(
      table.projectId,
      table.workItemId,
      table.conversationId,
      table.id,
    ),
    index("conversation_mockup_versions_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "conversation_mockup_versions_request_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.requestId],
      foreignColumns: [
        conversationMockupRequests.projectId,
        conversationMockupRequests.workItemId,
        conversationMockupRequests.conversationId,
        conversationMockupRequests.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_mockup_versions_action_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.createdByActionId],
      foreignColumns: [
        conversationActions.projectId,
        conversationActions.workItemId,
        conversationActions.conversationId,
        conversationActions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_mockup_versions_manifest_scope_fk",
      columns: [table.projectId, table.manifestArtifactId],
      foreignColumns: [artifacts.projectId, artifacts.id],
    }).onDelete("restrict"),
    lazyForeignKey(
      "conversation_mockup_versions_supersedes_mockup_version_id_fk",
      (): AnyPgColumn[] => [table.supersedesMockupVersionId],
      (): AnyPgColumn[] => [conversationMockupVersions.id],
    ).onDelete("restrict"),
    check("conversation_mockup_versions_schema_version_check", sql`${table.schemaVersion}=2`),
    check("conversation_mockup_versions_version_check", sql`${table.version} > 0`),
    check("conversation_mockup_versions_brief_check", sql`length(trim(${table.brief})) > 0`),
    check(
      "conversation_mockup_versions_target_check",
      sql`${table.target} IN ('desktop','mobile','responsive')`,
    ),
    check(
      "conversation_mockup_versions_interaction_notes_check",
      sql`jsonb_typeof(${table.interactionNotes})='array'
        AND jsonb_array_length(${table.interactionNotes})>0`,
    ),
    check(
      "conversation_mockup_versions_manifest_hash_check",
      sql`${table.manifestArtifactHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "conversation_mockup_versions_renderer_profile_check",
      sql`jsonb_typeof(${table.rendererProfile})='object'`,
    ),
    check(
      "conversation_mockup_versions_canonical_manifest_check",
      sql`${table.canonicalManifest}::jsonb IS NOT NULL
        AND encode(sha256(convert_to(${table.canonicalManifest},'UTF8')),'hex')
          =${table.manifestArtifactHash}`,
    ),
    check(
      "conversation_mockup_versions_revision_shape_check",
      sql`(
        (${table.version}=1 AND ${table.supersedesMockupVersionId} IS NULL)
        OR (${table.version}>1 AND ${table.supersedesMockupVersionId} IS NOT NULL)
      )`,
    ),
  ],
);

export const conversationMockupVersionArtifacts = pgTable(
  "conversation_mockup_version_artifacts",
  {
    mockupVersionId: text("mockup_version_id")
      .notNull()
      .references(() => conversationMockupVersions.id, { onDelete: "restrict" }),
    projectId: text("project_id").notNull(),
    viewport: text("viewport").notNull(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    artifactHash: text("artifact_hash").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    captureProfile: jsonb("capture_profile").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "conversation_mockup_version_artifacts_pkey",
      columns: [table.mockupVersionId, table.viewport],
    }),
    uniqueIndex("conversation_mockup_version_artifacts_parent_artifact_unique").on(
      table.mockupVersionId,
      table.artifactId,
    ),
    foreignKey({
      name: "conversation_mockup_version_artifacts_artifact_scope_fk",
      columns: [table.projectId, table.artifactId],
      foreignColumns: [artifacts.projectId, artifacts.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_mockup_version_artifacts_version_scope_fk",
      columns: [table.projectId, table.mockupVersionId],
      foreignColumns: [conversationMockupVersions.projectId, conversationMockupVersions.id],
    }).onDelete("restrict"),
    check(
      "conversation_mockup_version_artifacts_viewport_check",
      sql`${table.viewport} IN ('desktop','mobile')`,
    ),
    check(
      "conversation_mockup_version_artifacts_hash_check",
      sql`${table.artifactHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "conversation_mockup_version_artifacts_width_check",
      sql`${table.width} > 0 AND ${table.width} <= 4096`,
    ),
    check(
      "conversation_mockup_version_artifacts_height_check",
      sql`${table.height} > 0 AND ${table.height} <= 4096`,
    ),
    check(
      "conversation_mockup_version_artifacts_capture_profile_check",
      sql`jsonb_typeof(${table.captureProfile})='object'`,
    ),
  ],
);

export const conversationMockupDecisions = pgTable(
  "conversation_mockup_decisions",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    mockupVersionId: text("mockup_version_id")
      .notNull()
      .unique()
      .references(() => conversationMockupVersions.id, { onDelete: "restrict" }),
    actionId: text("action_id")
      .notNull()
      .unique()
      .references(() => conversationActions.id, { onDelete: "restrict" }),
    decidedByUserId: text("decided_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    manifestArtifactId: text("manifest_artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    manifestArtifactHash: text("manifest_artifact_hash").notNull(),
    rationale: text("rationale"),
    direction: text("direction"),
    createdAt: createdAt(),
  },
  (table) => [
    index("conversation_mockup_decisions_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "conversation_mockup_decisions_version_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.mockupVersionId],
      foreignColumns: [
        conversationMockupVersions.projectId,
        conversationMockupVersions.workItemId,
        conversationMockupVersions.conversationId,
        conversationMockupVersions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "conversation_mockup_decisions_action_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.actionId],
      foreignColumns: [
        conversationActions.projectId,
        conversationActions.workItemId,
        conversationActions.conversationId,
        conversationActions.id,
      ],
    }).onDelete("restrict"),
    check("conversation_mockup_decisions_schema_version_check", sql`${table.schemaVersion}=2`),
    check(
      "conversation_mockup_decisions_decision_check",
      sql`${table.decision} IN ('approved','revision_requested','rejected')`,
    ),
    check(
      "conversation_mockup_decisions_manifest_hash_check",
      sql`${table.manifestArtifactHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "conversation_mockup_decisions_shape_check",
      sql`(
        (${table.decision}='approved' AND ${table.direction} IS NULL
          AND ${table.rationale} IS NULL)
        OR (${table.decision}='revision_requested' AND ${table.direction} IS NOT NULL
          AND ${table.rationale} IS NULL)
        OR (${table.decision}='rejected' AND ${table.direction} IS NULL
          AND ${table.rationale} IS NOT NULL)
      )`,
    ),
  ],
);

export const conversationTaskPackageSupplements = pgTable(
  "conversation_task_package_supplements",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    basePackageId: text("base_package_id")
      .notNull()
      .references(() => conversationTaskPackages.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    sourceMockupVersionId: text("source_mockup_version_id")
      .notNull()
      .references(() => conversationMockupVersions.id, { onDelete: "restrict" }),
    approvalDecisionId: text("approval_decision_id")
      .notNull()
      .unique()
      .references(() => conversationMockupDecisions.id, { onDelete: "restrict" }),
    manifestArtifactId: text("manifest_artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    manifestArtifactHash: text("manifest_artifact_hash").notNull(),
    supplement: jsonb("supplement").notNull(),
    canonicalSupplement: text("canonical_supplement").notNull(),
    contentHash: text("content_hash").notNull(),
    contextDocumentId: text("context_document_id").notNull(),
    contextByteSize: integer("context_byte_size").notNull(),
    contextMediaType: text("context_media_type").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("conversation_task_package_supplements_package_order_unique").on(
      table.basePackageId,
      table.ordinal,
    ),
    uniqueIndex("conversation_task_package_supplements_task_mockup_unique").on(
      table.taskId,
      table.sourceMockupVersionId,
    ),
    index("conversation_task_package_supplements_task_order_idx").on(
      table.taskId,
      table.ordinal,
      table.id,
    ),
    foreignKey({
      name: "conversation_task_package_supplements_package_scope_fk",
      columns: [table.projectId, table.workItemId, table.conversationId, table.basePackageId],
      foreignColumns: [
        conversationTaskPackages.projectId,
        conversationTaskPackages.workItemId,
        conversationTaskPackages.conversationId,
        conversationTaskPackages.id,
      ],
    }).onDelete("restrict"),
    check(
      "conversation_task_package_supplements_schema_version_check",
      sql`${table.schemaVersion}=2`,
    ),
    check("conversation_task_package_supplements_ordinal_check", sql`${table.ordinal} > 0`),
    check(
      "conversation_task_package_supplements_manifest_hash_check",
      sql`${table.manifestArtifactHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "conversation_task_package_supplements_supplement_check",
      sql`jsonb_typeof(${table.supplement})='object'`,
    ),
    check(
      "conversation_task_package_supplements_canonical_check",
      sql`${table.canonicalSupplement}::jsonb=${table.supplement}
        AND encode(sha256(convert_to(${table.canonicalSupplement},'UTF8')),'hex')
          =${table.contentHash}`,
    ),
    check(
      "conversation_task_package_supplements_content_hash_check",
      sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "conversation_task_package_supplements_context_size_check",
      sql`${table.contextByteSize} > 0`,
    ),
    check(
      "conversation_task_package_supplements_context_media_type_check",
      sql`${table.contextMediaType}='application/json'`,
    ),
  ],
);

export const conversationTaskPackageSupplementDispatchReceipts = pgTable(
  "conversation_task_package_supplement_dispatch_receipts",
  {
    commandId: text("command_id")
      .notNull()
      .references(() => commands.commandId, { onDelete: "restrict" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "restrict" }),
    supplementId: text("supplement_id")
      .notNull()
      .references(() => conversationTaskPackageSupplements.id, { onDelete: "restrict" }),
    projectId: text("project_id").notNull(),
    phaseId: text("phase_id").notNull(),
    taskId: text("task_id").notNull(),
    basePackageId: text("base_package_id")
      .notNull()
      .references(() => conversationTaskPackages.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    contentHash: text("content_hash").notNull(),
    contextDocumentId: text("context_document_id").notNull(),
    contextRef: jsonb("context_ref").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "conversation_task_package_supplement_dispatch_receipts_pkey",
      columns: [table.commandId, table.supplementId],
    }),
    uniqueIndex("task_package_supplement_receipts_order_unique").on(table.commandId, table.ordinal),
    foreignKey({
      name: "task_package_supplement_receipts_run_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId, table.runId],
      foreignColumns: [agentRuns.projectId, agentRuns.phaseId, agentRuns.taskId, agentRuns.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_package_supplement_receipts_command_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId, table.runId, table.commandId],
      foreignColumns: [
        commands.projectId,
        commands.phaseId,
        commands.taskId,
        commands.runId,
        commands.commandId,
      ],
    }).onDelete("restrict"),
    check("task_package_supplement_receipts_ordinal_check", sql`${table.ordinal} > 0`),
    check(
      "task_package_supplement_receipts_content_hash_check",
      sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "task_package_supplement_receipts_context_ref_check",
      sql`jsonb_typeof(${table.contextRef})='object'`,
    ),
  ],
);

export const projectDeliveryRecords = pgTable(
  "project_delivery_records",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "restrict" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    runId: text("run_id").references(() => agentRuns.id, { onDelete: "restrict" }),
    repositoryBindingId: text("repository_binding_id")
      .notNull()
      .references(() => repositoryBindings.id, { onDelete: "restrict" }),
    environment: text("environment").notNull(),
    service: text("service").notNull(),
    commitSha: text("commit_sha").notNull(),
    providerId: text("provider_id").notNull(),
    providerDeploymentId: text("provider_deployment_id").notNull(),
    status: text("status").notNull(),
    currentObservationSequence: integer("current_observation_sequence").notNull().default(1),
    publicUrl: text("public_url"),
    healthUrl: text("health_url"),
    healthStatusCode: integer("health_status_code"),
    evidenceArtifactId: text("evidence_artifact_id").references(() => artifacts.id, {
      onDelete: "restrict",
    }),
    evidenceArtifactHash: text("evidence_artifact_hash"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("project_delivery_records_provider_unique").on(
      table.projectId,
      table.providerId,
      table.providerDeploymentId,
    ),
    uniqueIndex("project_delivery_records_project_id_unique").on(table.projectId, table.id),
    index("project_delivery_records_project_recent_idx").on(
      table.projectId,
      table.createdAt,
      table.id,
    ),
    index("project_delivery_records_commit_idx").on(table.projectId, table.commitSha, table.status),
    uniqueIndex("project_delivery_records_visual_scope_unique").on(
      table.projectId,
      table.phaseId,
      table.taskId,
      table.runId,
      table.repositoryBindingId,
      table.commitSha,
      table.id,
    ),
    foreignKey({
      name: "project_delivery_records_repository_scope_fk",
      columns: [table.projectId, table.repositoryBindingId],
      foreignColumns: [repositoryBindings.projectId, repositoryBindings.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "project_delivery_records_phase_scope_fk",
      columns: [table.projectId, table.phaseId],
      foreignColumns: [phases.projectId, phases.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "project_delivery_records_task_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.phaseId, tasks.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "project_delivery_records_run_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId, table.runId],
      foreignColumns: [agentRuns.projectId, agentRuns.phaseId, agentRuns.taskId, agentRuns.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "project_delivery_records_evidence_scope_fk",
      columns: [table.projectId, table.evidenceArtifactId],
      foreignColumns: [artifacts.projectId, artifacts.id],
    }).onDelete("restrict"),
    check("project_delivery_records_schema_version_check", sql`${table.schemaVersion}=2`),
    check("project_delivery_records_environment_check", sql`length(trim(${table.environment}))>0`),
    check("project_delivery_records_service_check", sql`length(trim(${table.service}))>0`),
    check(
      "project_delivery_records_commit_sha_check",
      sql`${table.commitSha} ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'`,
    ),
    check("project_delivery_records_provider_id_check", sql`length(trim(${table.providerId}))>0`),
    check(
      "project_delivery_records_provider_deployment_id_check",
      sql`length(trim(${table.providerDeploymentId}))>0`,
    ),
    check(
      "project_delivery_records_status_check",
      sql`${table.status} IN ('pending','deploying','succeeded','failed')`,
    ),
    check(
      "project_delivery_records_observation_sequence_check",
      sql`${table.currentObservationSequence}>0`,
    ),
    check(
      "project_delivery_records_public_url_check",
      sql`${table.publicUrl} IS NULL OR norns_is_public_https_url(${table.publicUrl})`,
    ),
    check(
      "project_delivery_records_health_url_check",
      sql`${table.healthUrl} IS NULL OR norns_is_public_https_url(${table.healthUrl})`,
    ),
    check(
      "project_delivery_records_health_status_check",
      sql`${table.healthStatusCode} IS NULL OR ${table.healthStatusCode} BETWEEN 100 AND 599`,
    ),
    check(
      "project_delivery_records_evidence_hash_check",
      sql`${table.evidenceArtifactHash} IS NULL
        OR ${table.evidenceArtifactHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "project_delivery_records_terminal_shape_check",
      sql`(
        (${table.status} IN ('pending','deploying') AND ${table.completedAt} IS NULL)
        OR (${table.status} IN ('succeeded','failed') AND ${table.completedAt} IS NOT NULL)
      )`,
    ),
    check(
      "project_delivery_records_evidence_shape_check",
      sql`(${table.evidenceArtifactId} IS NULL)=(${table.evidenceArtifactHash} IS NULL)`,
    ),
    check(
      "project_delivery_records_success_shape_check",
      sql`${table.status}<>'succeeded' OR (
        ${table.publicUrl} IS NOT NULL AND ${table.healthUrl} IS NOT NULL
        AND ${table.healthStatusCode} BETWEEN 200 AND 399
        AND ${table.evidenceArtifactId} IS NOT NULL
        AND ${table.evidenceArtifactHash} IS NOT NULL
      )`,
    ),
    check(
      "project_delivery_records_scope_shape_check",
      sql`(
        (${table.phaseId} IS NULL AND ${table.taskId} IS NULL AND ${table.runId} IS NULL)
        OR (${table.phaseId} IS NOT NULL AND ${table.taskId} IS NULL AND ${table.runId} IS NULL)
        OR (${table.phaseId} IS NOT NULL AND ${table.taskId} IS NOT NULL)
      )`,
    ),
  ],
);

export const projectDeliveryObservations = pgTable(
  "project_delivery_observations",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    deliveryRecordId: text("delivery_record_id")
      .notNull()
      .references(() => projectDeliveryRecords.id, { onDelete: "restrict" }),
    projectId: text("project_id").notNull(),
    sequence: integer("sequence").notNull(),
    status: text("status").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    providerEventId: text("provider_event_id"),
    publicUrl: text("public_url"),
    healthUrl: text("health_url"),
    healthStatusCode: integer("health_status_code"),
    evidenceArtifactId: text("evidence_artifact_id").references(() => artifacts.id, {
      onDelete: "restrict",
    }),
    evidenceArtifactHash: text("evidence_artifact_hash"),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("project_delivery_observations_record_sequence_unique").on(
      table.deliveryRecordId,
      table.sequence,
    ),
    uniqueIndex("project_delivery_observations_provider_event_unique").on(
      table.projectId,
      table.sourceId,
      table.providerEventId,
    ),
    uniqueIndex("project_delivery_observations_scope_unique").on(
      table.projectId,
      table.deliveryRecordId,
      table.id,
    ),
    index("project_delivery_observations_record_created_idx").on(
      table.deliveryRecordId,
      table.sequence,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "project_delivery_observations_delivery_scope_fk",
      columns: [table.projectId, table.deliveryRecordId],
      foreignColumns: [projectDeliveryRecords.projectId, projectDeliveryRecords.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "project_delivery_observations_evidence_scope_fk",
      columns: [table.projectId, table.evidenceArtifactId],
      foreignColumns: [artifacts.projectId, artifacts.id],
    }).onDelete("restrict"),
    check("project_delivery_observations_schema_version_check", sql`${table.schemaVersion}=2`),
    check("project_delivery_observations_sequence_check", sql`${table.sequence}>0`),
    check(
      "project_delivery_observations_status_check",
      sql`${table.status} IN ('pending','deploying','succeeded','failed')`,
    ),
    check(
      "project_delivery_observations_source_type_check",
      sql`${table.sourceType} IN ('provider','runner','system','human')`,
    ),
    check("project_delivery_observations_source_id_check", sql`length(trim(${table.sourceId}))>0`),
    check(
      "project_delivery_observations_public_url_check",
      sql`${table.publicUrl} IS NULL OR norns_is_public_https_url(${table.publicUrl})`,
    ),
    check(
      "project_delivery_observations_health_url_check",
      sql`${table.healthUrl} IS NULL OR norns_is_public_https_url(${table.healthUrl})`,
    ),
    check(
      "project_delivery_observations_health_status_check",
      sql`${table.healthStatusCode} IS NULL OR ${table.healthStatusCode} BETWEEN 100 AND 599`,
    ),
    check(
      "project_delivery_observations_evidence_hash_check",
      sql`${table.evidenceArtifactHash} IS NULL
        OR ${table.evidenceArtifactHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "project_delivery_observations_provider_shape_check",
      sql`(${table.sourceType}='provider')=(${table.providerEventId} IS NOT NULL)`,
    ),
    check(
      "project_delivery_observations_evidence_shape_check",
      sql`(${table.evidenceArtifactId} IS NULL)=(${table.evidenceArtifactHash} IS NULL)`,
    ),
    check(
      "project_delivery_observations_success_shape_check",
      sql`${table.status}<>'succeeded' OR (
        ${table.publicUrl} IS NOT NULL AND ${table.healthUrl} IS NOT NULL
        AND ${table.healthStatusCode} BETWEEN 200 AND 399
        AND ${table.evidenceArtifactId} IS NOT NULL
        AND ${table.evidenceArtifactHash} IS NOT NULL
      )`,
    ),
  ],
);

export const implementationVisualEvidence = pgTable(
  "implementation_visual_evidence",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    phaseId: text("phase_id")
      .notNull()
      .references(() => phases.id, { onDelete: "restrict" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "restrict" }),
    approvedMockupVersionId: text("approved_mockup_version_id")
      .notNull()
      .references(() => conversationMockupVersions.id, { onDelete: "restrict" }),
    repositoryBindingId: text("repository_binding_id")
      .notNull()
      .references(() => repositoryBindings.id, { onDelete: "restrict" }),
    verificationResultId: text("verification_result_id")
      .notNull()
      .references(() => verificationResults.id, { onDelete: "restrict" }),
    deploymentRecordId: text("deployment_record_id")
      .notNull()
      .references(() => projectDeliveryRecords.id, { onDelete: "restrict" }),
    deploymentObservationId: text("deployment_observation_id")
      .notNull()
      .references(() => projectDeliveryObservations.id, { onDelete: "restrict" }),
    commitSha: text("commit_sha").notNull(),
    captureProfile: jsonb("capture_profile").notNull(),
    comparisonArtifactId: text("comparison_artifact_id")
      .unique()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    comparisonArtifactHash: text("comparison_artifact_hash"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("implementation_visual_evidence_run_mockup_unique").on(
      table.runId,
      table.approvedMockupVersionId,
    ),
    index("implementation_visual_evidence_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "implementation_visual_evidence_mockup_project_fk",
      columns: [table.projectId, table.approvedMockupVersionId],
      foreignColumns: [conversationMockupVersions.projectId, conversationMockupVersions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "implementation_visual_evidence_run_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId, table.runId],
      foreignColumns: [agentRuns.projectId, agentRuns.phaseId, agentRuns.taskId, agentRuns.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "implementation_visual_evidence_verification_scope_fk",
      columns: [
        table.projectId,
        table.phaseId,
        table.taskId,
        table.runId,
        table.repositoryBindingId,
        table.commitSha,
        table.verificationResultId,
      ],
      foreignColumns: [
        verificationResults.projectId,
        verificationResults.phaseId,
        verificationResults.taskId,
        verificationResults.runId,
        verificationResults.repositoryBindingId,
        verificationResults.commitSha,
        verificationResults.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "implementation_visual_evidence_deployment_scope_fk",
      columns: [
        table.projectId,
        table.phaseId,
        table.taskId,
        table.runId,
        table.repositoryBindingId,
        table.commitSha,
        table.deploymentRecordId,
      ],
      foreignColumns: [
        projectDeliveryRecords.projectId,
        projectDeliveryRecords.phaseId,
        projectDeliveryRecords.taskId,
        projectDeliveryRecords.runId,
        projectDeliveryRecords.repositoryBindingId,
        projectDeliveryRecords.commitSha,
        projectDeliveryRecords.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "implementation_visual_evidence_observation_scope_fk",
      columns: [table.projectId, table.deploymentRecordId, table.deploymentObservationId],
      foreignColumns: [
        projectDeliveryObservations.projectId,
        projectDeliveryObservations.deliveryRecordId,
        projectDeliveryObservations.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "implementation_visual_evidence_comparison_scope_fk",
      columns: [table.projectId, table.comparisonArtifactId],
      foreignColumns: [artifacts.projectId, artifacts.id],
    }).onDelete("restrict"),
    check("implementation_visual_evidence_schema_version_check", sql`${table.schemaVersion}=2`),
    check(
      "implementation_visual_evidence_commit_sha_check",
      sql`${table.commitSha} ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'`,
    ),
    check(
      "implementation_visual_evidence_capture_profile_check",
      sql`jsonb_typeof(${table.captureProfile})='object'`,
    ),
    check(
      "implementation_visual_evidence_comparison_hash_check",
      sql`${table.comparisonArtifactHash} IS NULL
        OR ${table.comparisonArtifactHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "implementation_visual_evidence_comparison_shape_check",
      sql`(${table.comparisonArtifactId} IS NULL)=(${table.comparisonArtifactHash} IS NULL)`,
    ),
  ],
);

export const implementationVisualEvidenceCollections = pgTable(
  "implementation_visual_evidence_collections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    phaseId: text("phase_id").notNull(),
    taskId: text("task_id").notNull(),
    runId: text("run_id").notNull(),
    approvedMockupVersionId: text("approved_mockup_version_id").notNull(),
    repositoryBindingId: text("repository_binding_id").notNull(),
    verificationResultId: text("verification_result_id").notNull(),
    deploymentRecordId: text("deployment_record_id").notNull(),
    deploymentObservationId: text("deployment_observation_id").notNull(),
    commitSha: text("commit_sha").notNull(),
    status: text("status").notNull().default("queued"),
    commandId: text("command_id")
      .unique()
      .references(() => commands.commandId, { onDelete: "restrict" }),
    dispatchJobId: text("dispatch_job_id")
      .unique()
      .references(() => dispatchJobs.id, { onDelete: "restrict" }),
    runnerId: text("runner_id"),
    runnerGeneration: integer("runner_generation"),
    evidenceId: text("evidence_id")
      .unique()
      .references(() => implementationVisualEvidence.id, { onDelete: "restrict" }),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("implementation_visual_evidence_collections_run_mockup_unique").on(
      table.runId,
      table.approvedMockupVersionId,
    ),
    index("implementation_visual_evidence_collections_worker_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "implementation_visual_evidence_collections_mockup_project_fk",
      columns: [table.projectId, table.approvedMockupVersionId],
      foreignColumns: [conversationMockupVersions.projectId, conversationMockupVersions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "implementation_visual_evidence_collections_run_scope_fk",
      columns: [table.projectId, table.phaseId, table.taskId, table.runId],
      foreignColumns: [agentRuns.projectId, agentRuns.phaseId, agentRuns.taskId, agentRuns.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "implementation_visual_evidence_collections_verification_scope_fk",
      columns: [
        table.projectId,
        table.phaseId,
        table.taskId,
        table.runId,
        table.repositoryBindingId,
        table.commitSha,
        table.verificationResultId,
      ],
      foreignColumns: [
        verificationResults.projectId,
        verificationResults.phaseId,
        verificationResults.taskId,
        verificationResults.runId,
        verificationResults.repositoryBindingId,
        verificationResults.commitSha,
        verificationResults.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "implementation_visual_evidence_collections_delivery_scope_fk",
      columns: [
        table.projectId,
        table.phaseId,
        table.taskId,
        table.runId,
        table.repositoryBindingId,
        table.commitSha,
        table.deploymentRecordId,
      ],
      foreignColumns: [
        projectDeliveryRecords.projectId,
        projectDeliveryRecords.phaseId,
        projectDeliveryRecords.taskId,
        projectDeliveryRecords.runId,
        projectDeliveryRecords.repositoryBindingId,
        projectDeliveryRecords.commitSha,
        projectDeliveryRecords.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "implementation_visual_evidence_collections_observation_scope_fk",
      columns: [table.projectId, table.deploymentRecordId, table.deploymentObservationId],
      foreignColumns: [
        projectDeliveryObservations.projectId,
        projectDeliveryObservations.deliveryRecordId,
        projectDeliveryObservations.id,
      ],
    }).onDelete("restrict"),
    check(
      "implementation_visual_evidence_collections_commit_sha_check",
      sql`${table.commitSha} ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'`,
    ),
    check(
      "implementation_visual_evidence_collections_status_check",
      sql`${table.status} IN ('queued','leased','awaiting_runner','delivered','completed','failed')`,
    ),
    check(
      "implementation_visual_evidence_collections_generation_check",
      sql`${table.runnerGeneration} IS NULL OR ${table.runnerGeneration}>=0`,
    ),
    check("implementation_visual_evidence_collections_attempts_check", sql`${table.attempts}>=0`),
    check(
      "implementation_visual_evidence_collections_shape_check",
      sql`(
        (${table.status} IN ('queued','leased') AND ${table.commandId} IS NULL
          AND ${table.dispatchJobId} IS NULL AND ${table.runnerId} IS NULL
          AND ${table.runnerGeneration} IS NULL)
        OR (${table.status} IN ('awaiting_runner','delivered')
          AND ${table.commandId} IS NOT NULL AND ${table.dispatchJobId} IS NOT NULL
          AND ${table.runnerId} IS NOT NULL AND ${table.runnerGeneration} IS NOT NULL)
        OR (${table.status}='completed' AND ${table.commandId} IS NOT NULL
          AND ${table.dispatchJobId} IS NOT NULL AND ${table.runnerId} IS NOT NULL
          AND ${table.runnerGeneration} IS NOT NULL AND ${table.evidenceId} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL)
        OR (${table.status}='failed' AND ${table.lastError} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL)
      )`,
    ),
    check(
      "implementation_visual_evidence_collections_lease_shape_check",
      sql`(${table.status}='leased' AND ${table.leaseOwner} IS NOT NULL
        AND ${table.leaseExpiresAt} IS NOT NULL)
        OR (${table.status}<>'leased' AND ${table.leaseOwner} IS NULL
          AND ${table.leaseExpiresAt} IS NULL)`,
    ),
  ],
);

export const implementationVisualEvidenceArtifacts = pgTable(
  "implementation_visual_evidence_artifacts",
  {
    visualEvidenceId: text("visual_evidence_id")
      .notNull()
      .references(() => implementationVisualEvidence.id, { onDelete: "restrict" }),
    projectId: text("project_id").notNull(),
    viewport: text("viewport").notNull(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    artifactHash: text("artifact_hash").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    captureProfile: jsonb("capture_profile").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "implementation_visual_evidence_artifacts_pkey",
      columns: [table.visualEvidenceId, table.viewport],
    }),
    uniqueIndex("implementation_visual_evidence_artifacts_parent_artifact_unique").on(
      table.visualEvidenceId,
      table.artifactId,
    ),
    foreignKey({
      name: "implementation_visual_evidence_artifacts_artifact_scope_fk",
      columns: [table.projectId, table.artifactId],
      foreignColumns: [artifacts.projectId, artifacts.id],
    }).onDelete("restrict"),
    check(
      "implementation_visual_evidence_artifacts_viewport_check",
      sql`${table.viewport} IN ('desktop','mobile')`,
    ),
    check(
      "implementation_visual_evidence_artifacts_hash_check",
      sql`${table.artifactHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "implementation_visual_evidence_artifacts_width_check",
      sql`${table.width} > 0 AND ${table.width} <= 4096`,
    ),
    check(
      "implementation_visual_evidence_artifacts_height_check",
      sql`${table.height} > 0 AND ${table.height} <= 4096`,
    ),
    check(
      "implementation_visual_evidence_artifacts_capture_profile_check",
      sql`jsonb_typeof(${table.captureProfile})='object'`,
    ),
  ],
);

export const conversationActionCheckpointContexts = pgTable(
  "conversation_action_checkpoint_contexts",
  {
    actionId: text("action_id").primaryKey(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    taskId: text("task_id").notNull(),
    contextDocumentId: text("context_document_id").notNull(),
    contextHash: text("context_hash").notNull(),
    status: text("status").notNull().default("prepared"),
    commandId: text("command_id"),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("conversation_action_checkpoint_contexts_document_idx").on(
      table.contextDocumentId,
      table.status,
      table.taskId,
    ),
  ],
);

export const conversationPauseCheckpoints = pgTable(
  "conversation_pause_checkpoints",
  {
    pauseActionId: text("pause_action_id").primaryKey(),
    resumeActionId: text("resume_action_id").unique(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    phaseId: text("phase_id").notNull(),
    taskId: text("task_id").notNull(),
    runId: text("run_id").notNull(),
    sourceCommandId: text("source_command_id").notNull(),
    budgetReservationId: text("budget_reservation_id").notNull(),
    publishedBranch: text("published_branch").notNull(),
    publishedCommitSha: text("published_commit_sha").notNull(),
    publishedRemote: text("published_remote").notNull(),
    rootContextRefs: jsonb("root_context_refs").notNull(),
    contextHash: text("context_hash").notNull(),
    resumeContextRef: jsonb("resume_context_ref"),
    resumeCommandId: text("resume_command_id").unique(),
    resumeJobId: text("resume_job_id").unique(),
    runnerId: text("runner_id"),
    runnerGeneration: integer("runner_generation"),
    enrollmentSecretHash: text("enrollment_secret_hash"),
    status: text("status").notNull().default("paused"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "string" }).notNull(),
    lastError: text("last_error"),
    pausedAt: timestamp("paused_at", { withTimezone: true, mode: "string" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    resumedAt: timestamp("resumed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("conversation_pause_checkpoints_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const humanWaits = pgTable(
  "human_waits",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    phaseId: text("phase_id").notNull(),
    taskId: text("task_id").notNull(),
    sourceRunId: text("source_run_id").notNull(),
    sourceEventId: text("source_event_id").notNull().unique(),
    sourceCommandId: text("source_command_id").notNull(),
    messageId: text("message_id").notNull().unique(),
    decisionPointId: text("decision_point_id").notNull().unique(),
    decisionPoint: text("decision_point").notNull(),
    question: text("question").notNull(),
    questionHash: text("question_hash").notNull(),
    publishedBranch: text("published_branch").notNull(),
    publishedCommitSha: text("published_commit_sha").notNull(),
    publishedRemote: text("published_remote").notNull(),
    runtimeId: text("runtime_id").notNull(),
    runtimeSessionId: text("runtime_session_id"),
    sessionPortability: text("session_portability").notNull().default("transcript_only"),
    sessionPortabilityEvidence: text("session_portability_evidence"),
    askChannelVersion: integer("ask_channel_version").notNull(),
    askInstructionHash: text("ask_instruction_hash").notNull(),
    contextManifest: jsonb("context_manifest").notNull(),
    canonicalContextManifest: text("canonical_context_manifest").notNull(),
    rootContextRefs: jsonb("root_context_refs").notNull(),
    contextHash: text("context_hash").notNull(),
    taskPackageHash: text("task_package_hash"),
    compactSummary: text("compact_summary").notNull(),
    compactSummaryHash: text("compact_summary_hash").notNull(),
    budgetReservationId: text("budget_reservation_id").notNull(),
    rootRunId: text("root_run_id").notNull(),
    status: text("status").notNull().default("awaiting_human"),
    version: integer("version").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true, mode: "string" }),
    resumedAt: timestamp("resumed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("human_waits_one_open_per_run")
      .on(table.sourceRunId)
      .where(sql`${table.status} IN ('awaiting_human','answered','continuation_queued')`),
    index("human_waits_scope_status_idx").on(
      table.projectId,
      table.conversationId,
      table.status,
      table.expiresAt,
    ),
  ],
);

export const humanWaitAnswers = pgTable("human_wait_answers", {
  id: text("id").primaryKey(),
  schemaVersion: schemaVersion(),
  waitId: text("wait_id").notNull().unique(),
  projectId: text("project_id").notNull(),
  answeredByUserId: text("answered_by_user_id").notNull(),
  actionId: text("action_id").notNull().unique(),
  decisionRecordId: text("decision_record_id").notNull().unique(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  answer: text("answer").notNull(),
  rationale: text("rationale"),
  answerReceiptHash: text("answer_receipt_hash").notNull(),
  canonicalAnswerReceipt: text("canonical_answer_receipt").notNull(),
  createdAt: createdAt(),
});

export const humanWaitContinuations = pgTable(
  "human_wait_continuations",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    waitId: text("wait_id").notNull().unique(),
    answerId: text("answer_id").notNull().unique(),
    rootRunId: text("root_run_id").notNull(),
    rootCommandId: text("root_command_id").notNull(),
    resumeCommandId: text("resume_command_id").notNull().unique(),
    resumeJobId: text("resume_job_id").notNull().unique(),
    budgetReservationId: text("budget_reservation_id").notNull(),
    savedCommitSha: text("saved_commit_sha").notNull(),
    contextHash: text("context_hash").notNull(),
    answerReceiptHash: text("answer_receipt_hash").notNull(),
    replayContextRef: jsonb("replay_context_ref").notNull(),
    canonicalReplayContextRef: text("canonical_replay_context_ref").notNull(),
    runnerId: text("runner_id"),
    runnerGeneration: integer("runner_generation"),
    enrollmentSecretHash: text("enrollment_secret_hash"),
    deliveryReceiptHash: text("delivery_receipt_hash"),
    status: text("status").notNull().default("queued"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("human_wait_continuations_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const conversationPmUpdateGlobalSettings = pgTable(
  "conversation_pm_update_global_settings",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    updateIntervalSeconds: integer("update_interval_seconds").notNull().default(300),
    contentLevel: text("content_level").notNull().default("standard"),
    updatedAt: updatedAt(),
  },
);

export const conversationPmUpdateProjectSettings = pgTable(
  "conversation_pm_update_project_settings",
  {
    projectId: text("project_id").primaryKey(),
    updateIntervalSeconds: integer("update_interval_seconds"),
    contentLevel: text("content_level"),
    updatedByUserId: text("updated_by_user_id").notNull(),
    updatedAt: updatedAt(),
  },
);

export const conversationPmUpdates = pgTable(
  "conversation_pm_updates",
  {
    id: text("id").primaryKey(),
    schemaVersion: schemaVersion(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    messageId: text("message_id").notNull().unique(),
    transitionSequence: bigint("transition_sequence", { mode: "number" }).notNull(),
    stateHash: text("state_hash").notNull(),
    status: text("status").notNull(),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("conversation_pm_updates_conversation_transition_unique").on(
      table.conversationId,
      table.transitionSequence,
    ),
  ],
);

export const conversationPmUpdateCursors = pgTable(
  "conversation_pm_update_cursors",
  {
    conversationId: text("conversation_id").primaryKey(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true, mode: "string" }),
    nextDueAt: timestamp("next_due_at", { withTimezone: true, mode: "string" }).notNull(),
    lastStateHash: text("last_state_hash"),
    evaluationCount: bigint("evaluation_count", { mode: "number" }).notNull().default(0),
    transitionCount: bigint("transition_count", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("conversation_pm_update_cursors_due_idx").on(table.nextDueAt, table.conversationId),
  ],
);

export const conversationDomainSchema = {
  workItems,
  workConversations,
  workMessages,
  workMessageAttachmentRefs,
  conversationTurnAttempts,
  conversationActions: phase5ConversationActions,
  workPlanVersions,
  conversationPlanReviews,
  conversationPlanActionEffects,
  conversationPlanProposalAttempts,
  conversationPlanChangeProposals,
  conversationHandoffs,
  conversationSummaries,
  conversationKickoffIntents,
  conversationTaskPackages,
  conversationTaskPackageBindings,
  conversationTaskPackageRuns,
  conversationPlanningExcerptReceipts,
  conversationCompactionReceipts,
  conversationActionDeliveryIntents,
  conversationActionDeliveryEvents,
  runCommandUsageReceipts,
  conversationExecutionPlanChangeRequests,
  conversationMockupRequests,
  artifactBlobs,
  phase6IdempotencyClaims,
  conversationMockupVersions,
  conversationMockupVersionArtifacts,
  conversationMockupDecisions,
  conversationTaskPackageSupplements,
  conversationTaskPackageSupplementDispatchReceipts,
  projectDeliveryRecords,
  projectDeliveryObservations,
  implementationVisualEvidence,
  implementationVisualEvidenceCollections,
  implementationVisualEvidenceArtifacts,
  conversationActionCheckpointContexts,
  conversationPauseCheckpoints,
  humanWaits,
  humanWaitAnswers,
  humanWaitContinuations,
  conversationPmUpdateGlobalSettings,
  conversationPmUpdateProjectSettings,
  conversationPmUpdates,
  conversationPmUpdateCursors,
};

export const phase2PreservationSchema = {
  archiveEncryptionKeyRegistry,
  credentialHmacKeyRegistry,
  ...phase1V2Schema,
  runnerEvents: phase5RunnerEvents,
  users: phase2Users,
  sessions: phase2Sessions,
  migrationRuns: phase2MigrationRuns,
  legacyIdMappings: phase2LegacyIdMappings,
  invitations,
  projectPlanningPreferences,
  repositoryBindingCandidates,
  serviceConnections,
  githubUserAuthorizations,
  humanDirections,
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
  attentionItemStates,
  debates,
  debateActors,
  debateContexts,
  debateRuns,
  debateRounds,
  debateTurns,
  debateTurnAttempts,
  debateMessages,
  debateFindings,
  debateRevisions,
  debateJudgments,
  debateFinalOutputs,
  debateJobs,
  debateReservations,
  debateUsageEvents,
  debateEvents,
  projectMembers,
  aiPricingProfiles,
  aiUsageEvents,
  usageBudgetPolicies,
  usageBudgetThresholdNotifications,
  aiProviderUsagePlans,
  aiUsageCalibrationObservations,
  globalRuleSettings,
  ...conversationDomainSchema,
};
