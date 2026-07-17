-- The Norns re-foundation V2 normalized schema.
--
-- This migration is intentionally additive. The legacy `norns_state` snapshot
-- table is neither altered nor dropped so Phase 2 can migrate and reconcile
-- from a fixed source before any cutover.

-- The migration login remains privileged for schema management, while every
-- application transaction explicitly assumes this restricted runtime role.
-- Fail before creating V2 tables if deployment provisioning has not made that
-- role usable by the current login.
DO $runtime_role_preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'norns_app') THEN
    RAISE EXCEPTION
      'required runtime role norns_app does not exist; provision it before migration'
      USING ERRCODE = '42501';
  END IF;
  IF NOT pg_has_role(current_user, 'norns_app', 'SET') THEN
    RAISE EXCEPTION
      'migration login % cannot SET ROLE norns_app; grant it SET membership before migration',
      current_user
      USING ERRCODE = '42501';
  END IF;
END
$runtime_role_preflight$;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_role_check CHECK (role IN ('admin', 'member')),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL CONSTRAINT sessions_user_id_users_id_fk
    REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_unique ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_status_idx
  ON sessions (user_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  primary_repository_binding_id TEXT,
  current_architecture_revision_id TEXT,
  max_executing_phases INTEGER NOT NULL DEFAULT 1,
  max_concurrent_tasks INTEGER NOT NULL DEFAULT 1,
  assignment_policy_ref TEXT NOT NULL,
  verification_policy_ref TEXT NOT NULL,
  budget_policy_ref TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT projects_status_check
    CHECK (status IN ('initializing', 'active', 'paused', 'blocked', 'completed', 'archived')),
  CONSTRAINT projects_max_executing_phases_check CHECK (max_executing_phases > 0),
  CONSTRAINT projects_max_concurrent_tasks_check CHECK (max_concurrent_tasks > 0)
);

CREATE TABLE IF NOT EXISTS repository_bindings (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT repository_bindings_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  binding_type TEXT NOT NULL,
  status TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  workspace_id TEXT,
  repository_id TEXT NOT NULL,
  repository_display_name TEXT NOT NULL,
  github_installation_id TEXT,
  github_owner TEXT,
  github_name TEXT,
  granted_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_branch TEXT NOT NULL,
  observed_head TEXT,
  verification_policy_ref TEXT NOT NULL,
  repository_health TEXT NOT NULL DEFAULT 'unknown',
  created_by_actor_type TEXT NOT NULL,
  created_by_actor_id TEXT,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  last_validated_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT repository_bindings_type_check
    CHECK (binding_type IN ('local_runner', 'github')),
  CONSTRAINT repository_bindings_status_check
    CHECK (status IN (
      'unverified_candidate', 'validating', 'connected',
      'degraded', 'disconnected', 'revoked'
    )),
  CONSTRAINT repository_bindings_health_check
    CHECK (repository_health IN ('unknown', 'healthy', 'degraded', 'unavailable')),
  CONSTRAINT repository_bindings_shape_check CHECK (
    (
      binding_type = 'local_runner'
      AND workspace_id IS NOT NULL
      AND github_installation_id IS NULL
    )
    OR
    (
      binding_type = 'github'
      AND github_installation_id IS NOT NULL
      AND github_owner IS NOT NULL
      AND github_name IS NOT NULL
    )
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS repository_bindings_project_id_id_unique
  ON repository_bindings (project_id, id);
CREATE INDEX IF NOT EXISTS repository_bindings_project_status_idx
  ON repository_bindings (project_id, status);

CREATE TABLE IF NOT EXISTS phases (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT phases_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  objective_summary TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  approved_strategy_version_id TEXT,
  approved_budget_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  closure_summary TEXT,
  closure_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT phases_priority_check CHECK (priority >= 0),
  CONSTRAINT phases_status_check
    CHECK (status IN (
      'proposed', 'awaiting_approval', 'approved', 'active',
      'blocked', 'completed', 'cancelled'
    )),
  CONSTRAINT phases_active_strategy_check
    CHECK (status <> 'active' OR approved_strategy_version_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS phases_project_id_id_unique ON phases (project_id, id);
CREATE INDEX IF NOT EXISTS phases_project_status_priority_idx
  ON phases (project_id, status, priority);

CREATE TABLE IF NOT EXISTS phase_dependencies (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT phase_dependencies_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  predecessor_phase_id TEXT NOT NULL,
  successor_phase_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT phase_dependencies_predecessor_fk
    FOREIGN KEY (project_id, predecessor_phase_id)
    REFERENCES phases (project_id, id) ON DELETE CASCADE,
  CONSTRAINT phase_dependencies_successor_fk
    FOREIGN KEY (project_id, successor_phase_id)
    REFERENCES phases (project_id, id) ON DELETE CASCADE,
  CONSTRAINT phase_dependencies_no_self_check
    CHECK (predecessor_phase_id <> successor_phase_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS phase_dependencies_edge_unique
  ON phase_dependencies (project_id, predecessor_phase_id, successor_phase_id);

CREATE TABLE IF NOT EXISTS strategy_versions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  objective TEXT NOT NULL,
  content JSONB NOT NULL,
  convergence TEXT NOT NULL,
  review_rounds INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  approval_id TEXT,
  supersedes_strategy_version_id TEXT
    CONSTRAINT strategy_versions_supersedes_strategy_version_id_strategy_versions_id_fk
    REFERENCES strategy_versions (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT strategy_versions_phase_fk
    FOREIGN KEY (project_id, phase_id)
    REFERENCES phases (project_id, id) ON DELETE CASCADE,
  CONSTRAINT strategy_versions_version_check CHECK (version > 0),
  CONSTRAINT strategy_versions_review_rounds_check CHECK (review_rounds >= 0),
  CONSTRAINT strategy_versions_status_check
    CHECK (status IN (
      'draft', 'reviewing', 'awaiting_approval',
      'approved', 'rejected', 'superseded'
    )),
  CONSTRAINT strategy_versions_convergence_check
    CHECK (convergence IN ('pending', 'converged', 'cap_reached', 'failed')),
  CONSTRAINT strategy_versions_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_versions_phase_version_unique
  ON strategy_versions (phase_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_versions_project_phase_id_unique
  ON strategy_versions (project_id, phase_id, id);

CREATE TABLE IF NOT EXISTS strategy_reviews (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT strategy_reviews_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL CONSTRAINT strategy_reviews_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE CASCADE,
  strategy_version_id TEXT NOT NULL
    CONSTRAINT strategy_reviews_strategy_version_id_strategy_versions_id_fk
    REFERENCES strategy_versions (id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  reviewer_provider TEXT NOT NULL,
  reviewer_model TEXT NOT NULL,
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT strategy_reviews_round_check CHECK (round > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_reviews_version_round_unique
  ON strategy_reviews (strategy_version_id, round);

CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  success_measures JSONB NOT NULL,
  status TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  completion_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT objectives_phase_fk
    FOREIGN KEY (project_id, phase_id)
    REFERENCES phases (project_id, id) ON DELETE CASCADE,
  CONSTRAINT objectives_status_check
    CHECK (status IN ('proposed', 'active', 'completed', 'cancelled')),
  CONSTRAINT objectives_order_check CHECK ("order" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS objectives_project_phase_id_unique
  ON objectives (project_id, phase_id, id);
CREATE INDEX IF NOT EXISTS objectives_phase_order_idx ON objectives (phase_id, "order");

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  strategy_version_id TEXT NOT NULL
    CONSTRAINT tasks_strategy_version_id_strategy_versions_id_fk
    REFERENCES strategy_versions (id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  deliverables JSONB NOT NULL,
  acceptance_criteria JSONB NOT NULL,
  complexity TEXT NOT NULL,
  risk TEXT NOT NULL,
  required_roles JSONB NOT NULL,
  required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_inputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_outputs JSONB NOT NULL,
  environment_policy_ref TEXT NOT NULL,
  verification_policy_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  designated_assignment_id TEXT,
  designated_run_id TEXT,
  review_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  completion_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  lifecycle_version INTEGER NOT NULL DEFAULT 0,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT tasks_objective_scope_fk
    FOREIGN KEY (project_id, phase_id, objective_id)
    REFERENCES objectives (project_id, phase_id, id) ON DELETE RESTRICT,
  CONSTRAINT tasks_complexity_check CHECK (complexity IN ('S', 'M', 'L', 'XL')),
  CONSTRAINT tasks_risk_check CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT tasks_state_check
    CHECK (state IN (
      'pending', 'ready', 'assigned', 'in_progress', 'verifying',
      'in_review', 'completed', 'blocked', 'failed', 'cancelled'
    )),
  CONSTRAINT tasks_lifecycle_version_check CHECK (lifecycle_version >= 0),
  CONSTRAINT tasks_lifecycle_origin_check CHECK (lifecycle_version > 0 OR state = 'pending'),
  CONSTRAINT tasks_completed_at_check CHECK (state <> 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT tasks_completed_evidence_check CHECK (
    state <> 'completed'
    OR (
      jsonb_array_length(review_evidence) > 0
      AND jsonb_array_length(completion_evidence) > 0
    )
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_project_phase_id_unique
  ON tasks (project_id, phase_id, id);
CREATE INDEX IF NOT EXISTS tasks_phase_state_idx ON tasks (phase_id, state);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  predecessor_task_id TEXT NOT NULL,
  successor_task_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_dependencies_predecessor_fk
    FOREIGN KEY (project_id, phase_id, predecessor_task_id)
    REFERENCES tasks (project_id, phase_id, id) ON DELETE CASCADE,
  CONSTRAINT task_dependencies_successor_fk
    FOREIGN KEY (project_id, phase_id, successor_task_id)
    REFERENCES tasks (project_id, phase_id, id) ON DELETE CASCADE,
  CONSTRAINT task_dependencies_no_self_check
    CHECK (predecessor_task_id <> successor_task_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS task_dependencies_edge_unique
  ON task_dependencies (project_id, phase_id, predecessor_task_id, successor_task_id);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  provider TEXT NOT NULL,
  runtime TEXT NOT NULL,
  model TEXT NOT NULL,
  roles JSONB NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  context_limit_tokens INTEGER NOT NULL,
  security_restrictions JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  active_workload INTEGER NOT NULL DEFAULT 0,
  cost_metadata JSONB NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_profiles_status_check
    CHECK (status IN ('available', 'busy', 'offline', 'disabled')),
  CONSTRAINT agent_profiles_context_limit_check CHECK (context_limit_tokens > 0),
  CONSTRAINT agent_profiles_workload_check CHECK (active_workload >= 0)
);

CREATE TABLE IF NOT EXISTS agent_assignments (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_profile_id TEXT NOT NULL
    CONSTRAINT agent_assignments_agent_profile_id_agent_profiles_id_fk
    REFERENCES agent_profiles (id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  rationale TEXT NOT NULL,
  rationale_factors JSONB NOT NULL,
  budget_limit_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  reviewer_agent_profile_id TEXT
    CONSTRAINT agent_assignments_reviewer_agent_profile_id_agent_profiles_id_fk
    REFERENCES agent_profiles (id) ON DELETE RESTRICT,
  allocation_policy_ref TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_assignments_task_scope_fk
    FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks (project_id, phase_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_assignments_status_check
    CHECK (status IN ('proposed', 'active', 'completed', 'cancelled', 'superseded')),
  CONSTRAINT agent_assignments_rationale_check CHECK (length(trim(rationale)) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_assignments_project_phase_task_id_unique
  ON agent_assignments (project_id, phase_id, task_id, id);
CREATE INDEX IF NOT EXISTS agent_assignments_task_status_idx
  ON agent_assignments (task_id, status);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  is_designated BOOLEAN NOT NULL DEFAULT false,
  runner_id TEXT,
  runtime_session_id TEXT,
  repository_binding_id TEXT NOT NULL
    CONSTRAINT agent_runs_repository_binding_id_repository_bindings_id_fk
    REFERENCES repository_bindings (id) ON DELETE RESTRICT,
  expected_revision TEXT NOT NULL,
  worktree_ref TEXT,
  commit_sha TEXT,
  usage_input_tokens BIGINT NOT NULL DEFAULT 0,
  usage_output_tokens BIGINT NOT NULL DEFAULT 0,
  usage_cost_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  result_summary TEXT,
  failure_code TEXT,
  failure_detail TEXT,
  superseded_at TIMESTAMPTZ,
  superseded_by_run_id TEXT CONSTRAINT agent_runs_superseded_by_run_id_agent_runs_id_fk
    REFERENCES agent_runs (id) ON DELETE RESTRICT,
  lifecycle_version INTEGER NOT NULL DEFAULT 0,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CONSTRAINT agent_runs_assignment_scope_fk
    FOREIGN KEY (project_id, phase_id, task_id, assignment_id)
    REFERENCES agent_assignments (project_id, phase_id, task_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_runs_attempt_check CHECK (attempt > 0),
  CONSTRAINT agent_runs_state_check
    CHECK (state IN (
      'created', 'dispatched', 'running', 'verifying',
      'succeeded', 'failed', 'cancelled', 'expired'
    )),
  CONSTRAINT agent_runs_lifecycle_version_check CHECK (lifecycle_version >= 0),
  CONSTRAINT agent_runs_lifecycle_origin_check
    CHECK (lifecycle_version > 0 OR state = 'created'),
  CONSTRAINT agent_runs_verification_status_check
    CHECK (verification_status IN ('pending', 'passed', 'failed')),
  CONSTRAINT agent_runs_supersession_shape_check
    CHECK ((superseded_at IS NULL) = (superseded_by_run_id IS NULL)),
  CONSTRAINT agent_runs_designated_not_superseded_check
    CHECK (NOT (is_designated AND superseded_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_project_phase_task_id_unique
  ON agent_runs (project_id, phase_id, task_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_task_attempt_unique
  ON agent_runs (task_id, attempt);
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_designated_per_task_unique
  ON agent_runs (task_id)
  WHERE is_designated = true AND superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS decision_points (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT decision_points_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT CONSTRAINT decision_points_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE CASCADE,
  task_id TEXT CONSTRAINT decision_points_task_id_tasks_id_fk
    REFERENCES tasks (id) ON DELETE CASCADE,
  scope_entity_type TEXT NOT NULL,
  scope_entity_id TEXT NOT NULL,
  reason_class TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  condition_key TEXT NOT NULL,
  condition_fingerprint TEXT NOT NULL,
  condition_revision INTEGER NOT NULL DEFAULT 1,
  question TEXT NOT NULL,
  context TEXT NOT NULL,
  options JSONB NOT NULL,
  recommendation_option_id TEXT NOT NULL,
  urgency TEXT NOT NULL,
  blocking_scope JSONB,
  status TEXT NOT NULL,
  supersedes_decision_point_id TEXT
    CONSTRAINT decision_points_supersedes_decision_point_id_decision_points_id_fk
    REFERENCES decision_points (id),
  superseded_by_decision_point_id TEXT
    CONSTRAINT decision_points_superseded_by_decision_point_id_decision_points_id_fk
    REFERENCES decision_points (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT decision_points_hash_check
    CHECK (condition_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT decision_points_status_check
    CHECK (status IN ('open', 'resolved', 'dismissed', 'superseded')),
  CONSTRAINT decision_points_urgency_check
    CHECK (urgency IN ('low', 'normal', 'high', 'critical')),
  CONSTRAINT decision_points_scope_shape_check
    CHECK (phase_id IS NOT NULL OR task_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS decision_points_project_id_id_unique
  ON decision_points (project_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS decision_points_project_phase_id_unique
  ON decision_points (project_id, phase_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS decision_points_project_condition_id_unique
  ON decision_points (project_id, condition_key, id);
CREATE UNIQUE INDEX IF NOT EXISTS decision_points_open_condition_unique
  ON decision_points (condition_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS decision_points_project_status_idx
  ON decision_points (project_id, status, urgency);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT approvals_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT CONSTRAINT approvals_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  subject_entity_type TEXT NOT NULL,
  subject_entity_id TEXT NOT NULL,
  actor_id TEXT NOT NULL CONSTRAINT approvals_actor_id_users_id_fk
    REFERENCES users (id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL,
  superseded_by_approval_id TEXT
    CONSTRAINT approvals_superseded_by_approval_id_approvals_id_fk
    REFERENCES approvals (id),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT approvals_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT approvals_status_check CHECK (status IN ('active', 'superseded', 'revoked'))
);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_project_phase_id_unique
  ON approvals (project_id, phase_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_project_id_id_unique
  ON approvals (project_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_project_subject_id_unique
  ON approvals (project_id, subject_entity_type, subject_entity_id, id);
CREATE INDEX IF NOT EXISTS approvals_subject_status_idx
  ON approvals (subject_entity_type, subject_entity_id, status);

CREATE TABLE IF NOT EXISTS decision_records (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT decision_records_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT CONSTRAINT decision_records_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE CASCADE,
  decision_point_id TEXT
    CONSTRAINT decision_records_decision_point_id_decision_points_id_fk
    REFERENCES decision_points (id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  selected_option_id TEXT,
  status TEXT NOT NULL,
  decided_by TEXT NOT NULL CONSTRAINT decision_records_decided_by_users_id_fk
    REFERENCES users (id) ON DELETE RESTRICT,
  approval_id TEXT NOT NULL CONSTRAINT decision_records_approval_id_approvals_id_fk
    REFERENCES approvals (id) ON DELETE RESTRICT,
  affected_entities JSONB NOT NULL DEFAULT '[]'::jsonb,
  supersedes_decision_record_id TEXT
    CONSTRAINT decision_records_supersedes_decision_record_id_decision_records_id_fk
    REFERENCES decision_records (id),
  superseded_by_decision_record_id TEXT
    CONSTRAINT decision_records_superseded_by_decision_record_id_decision_records_id_fk
    REFERENCES decision_records (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT decision_records_status_check CHECK (status IN ('active', 'obsolete'))
);
CREATE UNIQUE INDEX IF NOT EXISTS decision_records_project_id_id_unique
  ON decision_records (project_id, id);

CREATE TABLE IF NOT EXISTS project_memory_entries (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT project_memory_entries_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT CONSTRAINT project_memory_entries_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE CASCADE,
  task_id TEXT CONSTRAINT project_memory_entries_task_id_tasks_id_fk
    REFERENCES tasks (id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  provenance TEXT NOT NULL,
  source_ref JSONB,
  confidence NUMERIC(5, 4) NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  approved_by_human BOOLEAN NOT NULL DEFAULT false,
  approved_by TEXT CONSTRAINT project_memory_entries_approved_by_users_id_fk
    REFERENCES users (id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  supersedes_memory_entry_id TEXT
    CONSTRAINT project_memory_entries_supersedes_memory_entry_id_project_memory_entries_id_fk
    REFERENCES project_memory_entries (id),
  superseded_by_memory_entry_id TEXT
    CONSTRAINT project_memory_entries_superseded_by_memory_entry_id_project_memory_entries_id_fk
    REFERENCES project_memory_entries (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_memory_category_check
    CHECK (category IN (
      'directive', 'constraint', 'decision', 'lesson',
      'architecture', 'phase_completion', 'repository_fact'
    )),
  CONSTRAINT project_memory_status_check CHECK (status IN ('active', 'obsolete')),
  CONSTRAINT project_memory_confidence_check CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT project_memory_human_approval_check CHECK (
    category NOT IN ('directive', 'decision')
    OR (approved_by_human AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT project_memory_scope_shape_check
    CHECK (phase_id IS NOT NULL OR task_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS project_memory_project_id_id_unique
  ON project_memory_entries (project_id, id);
CREATE INDEX IF NOT EXISTS project_memory_active_scope_idx
  ON project_memory_entries (project_id, phase_id, task_id, status);

CREATE TABLE IF NOT EXISTS architecture_revisions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT architecture_revisions_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT CONSTRAINT architecture_revisions_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  architecture_artifact_id TEXT NOT NULL,
  repository_revision TEXT NOT NULL,
  provenance_actor_type TEXT NOT NULL,
  provenance_actor_id TEXT,
  approval_id TEXT CONSTRAINT architecture_revisions_approval_id_approvals_id_fk
    REFERENCES approvals (id) ON DELETE RESTRICT,
  supersedes_architecture_revision_id TEXT
    CONSTRAINT architecture_revisions_supersedes_architecture_revision_id_architecture_revisions_id_fk
    REFERENCES architecture_revisions (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT architecture_revisions_revision_check CHECK (revision > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS architecture_revisions_project_revision_unique
  ON architecture_revisions (project_id, revision);
CREATE UNIQUE INDEX IF NOT EXISTS architecture_revisions_project_id_id_unique
  ON architecture_revisions (project_id, id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT artifacts_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT CONSTRAINT artifacts_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE CASCADE,
  task_id TEXT CONSTRAINT artifacts_task_id_tasks_id_fk
    REFERENCES tasks (id) ON DELETE CASCADE,
  run_id TEXT CONSTRAINT artifacts_run_id_agent_runs_id_fk
    REFERENCES agent_runs (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  provenance_actor_type TEXT NOT NULL,
  provenance_actor_id TEXT,
  redaction_status TEXT NOT NULL,
  retention_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT artifacts_scope_shape_check CHECK (
    (phase_id IS NOT NULL OR (task_id IS NULL AND run_id IS NULL))
    AND (task_id IS NOT NULL OR run_id IS NULL)
  ),
  CONSTRAINT artifacts_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT artifacts_byte_size_check CHECK (byte_size >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_content_storage_unique
  ON artifacts (content_hash, storage_ref);
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_project_id_id_unique
  ON artifacts (project_id, id);
CREATE INDEX IF NOT EXISTS artifacts_run_kind_idx ON artifacts (run_id, kind);

CREATE TABLE IF NOT EXISTS verification_results (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT verification_results_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL CONSTRAINT verification_results_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE CASCADE,
  task_id TEXT NOT NULL CONSTRAINT verification_results_task_id_tasks_id_fk
    REFERENCES tasks (id) ON DELETE CASCADE,
  run_id TEXT NOT NULL CONSTRAINT verification_results_run_id_agent_runs_id_fk
    REFERENCES agent_runs (id) ON DELETE CASCADE,
  repository_binding_id TEXT NOT NULL
    CONSTRAINT verification_results_repository_binding_id_repository_bindings_id_fk
    REFERENCES repository_bindings (id) ON DELETE RESTRICT,
  commit_sha TEXT NOT NULL,
  verification_policy_ref TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  command_results JSONB NOT NULL,
  evidence JSONB NOT NULL,
  produced_by_runner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_results_run_created_idx
  ON verification_results (run_id, created_at);

CREATE TABLE IF NOT EXISTS budget_allocations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL CONSTRAINT budget_allocations_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT CONSTRAINT budget_allocations_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE CASCADE,
  amount_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  spent_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  reserved_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budget_allocations_balance_check
    CHECK (spent_usd + reserved_usd <= amount_usd)
);

CREATE TABLE IF NOT EXISTS budget_reservations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT budget_reservations_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL CONSTRAINT budget_reservations_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE CASCADE,
  task_id TEXT NOT NULL CONSTRAINT budget_reservations_task_id_tasks_id_fk
    REFERENCES tasks (id) ON DELETE CASCADE,
  run_id TEXT NOT NULL CONSTRAINT budget_reservations_run_id_agent_runs_id_fk
    REFERENCES agent_runs (id) ON DELETE CASCADE,
  amount_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  settled_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  released_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  retained_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  resolution_outcome TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budget_reservations_status_check
    CHECK (status IN ('active', 'retained_ambiguous', 'settled', 'released')),
  CONSTRAINT budget_reservations_balance_check CHECK (
    (
      status = 'active'
      AND settled_usd = 0
      AND released_usd = 0
      AND retained_usd = 0
    )
    OR
    (
      status <> 'active'
      AND settled_usd + released_usd + retained_usd = amount_usd
    )
  ),
  CONSTRAINT budget_reservations_terminal_shape_check CHECK (
    status = 'active'
    OR (
      status = 'retained_ambiguous'
      AND settled_usd = 0
      AND released_usd = 0
      AND retained_usd = amount_usd
    )
    OR (
      status = 'settled'
      AND retained_usd = 0
    )
    OR (
      status = 'released'
      AND settled_usd = 0
      AND retained_usd = 0
      AND released_usd = amount_usd
    )
  )
);
CREATE INDEX IF NOT EXISTS budget_reservations_status_expiry_idx
  ON budget_reservations (status, expires_at);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL CONSTRAINT usage_events_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT CONSTRAINT usage_events_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE CASCADE,
  task_id TEXT CONSTRAINT usage_events_task_id_tasks_id_fk
    REFERENCES tasks (id) ON DELETE CASCADE,
  run_id TEXT CONSTRAINT usage_events_run_id_agent_runs_id_fk
    REFERENCES agent_runs (id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT usage_events_scope_shape_check CHECK (
    (phase_id IS NOT NULL OR (task_id IS NULL AND run_id IS NULL))
    AND (task_id IS NOT NULL OR run_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS usage_events_project_time_idx
  ON usage_events (project_id, occurred_at);

CREATE TABLE IF NOT EXISTS commands (
  command_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  dispatch_job_id TEXT NOT NULL,
  project_id TEXT NOT NULL CONSTRAINT commands_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL CONSTRAINT commands_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE CASCADE,
  task_id TEXT NOT NULL CONSTRAINT commands_task_id_tasks_id_fk
    REFERENCES tasks (id) ON DELETE CASCADE,
  run_id TEXT NOT NULL CONSTRAINT commands_run_id_agent_runs_id_fk
    REFERENCES agent_runs (id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL,
  runner_generation INTEGER NOT NULL,
  kind TEXT NOT NULL,
  envelope JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commands_runner_generation_check CHECK (runner_generation >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS commands_dispatch_job_unique ON commands (dispatch_job_id);
CREATE UNIQUE INDEX IF NOT EXISTS commands_project_phase_task_run_command_unique
  ON commands (project_id, phase_id, task_id, run_id, command_id);

CREATE TABLE IF NOT EXISTS dispatch_jobs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT dispatch_jobs_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL CONSTRAINT dispatch_jobs_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE CASCADE,
  task_id TEXT NOT NULL CONSTRAINT dispatch_jobs_task_id_tasks_id_fk
    REFERENCES tasks (id) ON DELETE CASCADE,
  run_id TEXT NOT NULL CONSTRAINT dispatch_jobs_run_id_agent_runs_id_fk
    REFERENCES agent_runs (id) ON DELETE CASCADE,
  command_id TEXT NOT NULL CONSTRAINT dispatch_jobs_command_id_commands_command_id_fk
    REFERENCES commands (command_id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_jobs_status_check
    CHECK (status IN ('queued', 'leased', 'delivered', 'completed', 'dead_letter', 'cancelled')),
  CONSTRAINT dispatch_jobs_attempts_check CHECK (attempts >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_jobs_command_unique ON dispatch_jobs (command_id);
CREATE INDEX IF NOT EXISTS dispatch_jobs_claim_idx
  ON dispatch_jobs (status, available_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS runner_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  runner_id TEXT NOT NULL,
  runner_generation INTEGER NOT NULL,
  run_id TEXT CONSTRAINT runner_events_run_id_agent_runs_id_fk
    REFERENCES agent_runs (id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS runner_events_runner_generation_sequence_unique
  ON runner_events (runner_id, runner_generation, sequence);
CREATE INDEX IF NOT EXISTS runner_events_unapplied_idx
  ON runner_events (applied_at, received_at);

CREATE TABLE IF NOT EXISTS idempotency_records (
  actor_id TEXT NOT NULL,
  command_family TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 2,
  request_fingerprint TEXT NOT NULL,
  command_id TEXT NOT NULL,
  status TEXT NOT NULL,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL,
  asynchronous_work_until TIMESTAMPTZ,
  rollback_window_until TIMESTAMPTZ,
  CONSTRAINT idempotency_records_scope_pk
    PRIMARY KEY (actor_id, command_family, idempotency_key),
  CONSTRAINT idempotency_records_status_check
    CHECK (status IN ('in_progress', 'committed_succeeded', 'committed_failed')),
  CONSTRAINT idempotency_records_hash_check
    CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT idempotency_records_response_check CHECK (
    (status = 'in_progress' AND response IS NULL)
    OR (status <> 'in_progress' AND response IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_records_command_unique
  ON idempotency_records (command_id);
CREATE INDEX IF NOT EXISTS idempotency_records_cleanup_idx
  ON idempotency_records (status, retain_until);

CREATE TABLE IF NOT EXISTS domain_events (
  event_id TEXT PRIMARY KEY,
  stream_type TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL CONSTRAINT domain_events_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE RESTRICT,
  phase_id TEXT CONSTRAINT domain_events_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE RESTRICT,
  task_id TEXT CONSTRAINT domain_events_task_id_tasks_id_fk
    REFERENCES tasks (id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  CONSTRAINT domain_events_scope_shape_check CHECK (phase_id IS NOT NULL OR task_id IS NULL),
  CONSTRAINT domain_events_stream_version_check CHECK (stream_version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS domain_events_stream_version_unique
  ON domain_events (stream_type, stream_id, stream_version);
CREATE INDEX IF NOT EXISTS domain_events_project_time_idx
  ON domain_events (project_id, occurred_at);
CREATE INDEX IF NOT EXISTS domain_events_task_time_idx
  ON domain_events (task_id, occurred_at);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  audit_type TEXT NOT NULL,
  project_id TEXT CONSTRAINT audit_events_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE RESTRICT,
  phase_id TEXT CONSTRAINT audit_events_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE RESTRICT,
  task_id TEXT CONSTRAINT audit_events_task_id_tasks_id_fk
    REFERENCES tasks (id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  outcome TEXT NOT NULL,
  severity TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  targets JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  redaction_applied BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT audit_events_scope_shape_check CHECK (
    (project_id IS NOT NULL OR (phase_id IS NULL AND task_id IS NULL))
    AND (phase_id IS NOT NULL OR task_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS audit_events_project_time_idx
  ON audit_events (project_id, occurred_at);
CREATE INDEX IF NOT EXISTS audit_events_actor_time_idx
  ON audit_events (actor_id, occurred_at);

CREATE TABLE IF NOT EXISTS lifecycle_integrity_findings (
  id TEXT PRIMARY KEY,
  aggregate_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  project_id TEXT NOT NULL
    CONSTRAINT lifecycle_integrity_findings_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  details JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  detected_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  CONSTRAINT lifecycle_integrity_findings_status_check CHECK (status IN ('open', 'resolved'))
);
CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_integrity_findings_open_unique
  ON lifecycle_integrity_findings (aggregate_kind, aggregate_id)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS projection_checkpoints (
  projection_name TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  last_event_id TEXT,
  last_occurred_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT projection_checkpoints_pk PRIMARY KEY (projection_name, partition_key)
);

CREATE TABLE IF NOT EXISTS migration_runs (
  id TEXT PRIMARY KEY,
  migration_name TEXT NOT NULL,
  source_snapshot_hashes JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_frozen_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS migration_runs_name_started_unique
  ON migration_runs (migration_name, started_at);

CREATE TABLE IF NOT EXISTS legacy_id_mappings (
  migration_run_id TEXT NOT NULL
    CONSTRAINT legacy_id_mappings_migration_run_id_migration_runs_id_fk
    REFERENCES migration_runs (id) ON DELETE CASCADE,
  legacy_entity_type TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  v2_entity_type TEXT NOT NULL,
  v2_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT legacy_id_mappings_pk
    PRIMARY KEY (migration_run_id, legacy_entity_type, legacy_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS legacy_id_mappings_v2_unique
  ON legacy_id_mappings (migration_run_id, v2_entity_type, v2_id);

-- Circular references are added after every target table exists.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_primary_repository_binding_id_repository_bindings_id_fk'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_primary_repository_binding_id_repository_bindings_id_fk
      FOREIGN KEY (primary_repository_binding_id)
      REFERENCES repository_bindings (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_current_architecture_revision_id_architecture_revisions_id_fk'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_current_architecture_revision_id_architecture_revisions_id_fk
      FOREIGN KEY (current_architecture_revision_id)
      REFERENCES architecture_revisions (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'phases_approved_strategy_version_id_strategy_versions_id_fk'
  ) THEN
    ALTER TABLE phases
      ADD CONSTRAINT phases_approved_strategy_version_id_strategy_versions_id_fk
      FOREIGN KEY (approved_strategy_version_id)
      REFERENCES strategy_versions (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'strategy_versions_approval_id_approvals_id_fk'
  ) THEN
    ALTER TABLE strategy_versions
      ADD CONSTRAINT strategy_versions_approval_id_approvals_id_fk
      FOREIGN KEY (approval_id)
      REFERENCES approvals (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_designated_assignment_id_agent_assignments_id_fk'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_designated_assignment_id_agent_assignments_id_fk
      FOREIGN KEY (designated_assignment_id)
      REFERENCES agent_assignments (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_designated_run_id_agent_runs_id_fk'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_designated_run_id_agent_runs_id_fk
      FOREIGN KEY (designated_run_id)
      REFERENCES agent_runs (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'architecture_revisions_architecture_artifact_id_artifacts_id_fk'
  ) THEN
    ALTER TABLE architecture_revisions
      ADD CONSTRAINT architecture_revisions_architecture_artifact_id_artifacts_id_fk
      FOREIGN KEY (architecture_artifact_id)
      REFERENCES artifacts (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'strategy_reviews_strategy_scope_fk'
  ) THEN
    ALTER TABLE strategy_reviews
      ADD CONSTRAINT strategy_reviews_strategy_scope_fk
      FOREIGN KEY (project_id, phase_id, strategy_version_id)
      REFERENCES strategy_versions (project_id, phase_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_strategy_scope_fk'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_strategy_scope_fk
      FOREIGN KEY (project_id, phase_id, strategy_version_id)
      REFERENCES strategy_versions (project_id, phase_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_repository_scope_fk'
  ) THEN
    ALTER TABLE agent_runs
      ADD CONSTRAINT agent_runs_repository_scope_fk
      FOREIGN KEY (project_id, repository_binding_id)
      REFERENCES repository_bindings (project_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'decision_points_phase_scope_fk'
  ) THEN
    ALTER TABLE decision_points
      ADD CONSTRAINT decision_points_phase_scope_fk
      FOREIGN KEY (project_id, phase_id)
      REFERENCES phases (project_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'decision_points_task_scope_fk'
  ) THEN
    ALTER TABLE decision_points
      ADD CONSTRAINT decision_points_task_scope_fk
      FOREIGN KEY (project_id, phase_id, task_id)
      REFERENCES tasks (project_id, phase_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'approvals_phase_scope_fk'
  ) THEN
    ALTER TABLE approvals
      ADD CONSTRAINT approvals_phase_scope_fk
      FOREIGN KEY (project_id, phase_id)
      REFERENCES phases (project_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'decision_records_phase_scope_fk'
  ) THEN
    ALTER TABLE decision_records
      ADD CONSTRAINT decision_records_phase_scope_fk
      FOREIGN KEY (project_id, phase_id)
      REFERENCES phases (project_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_memory_phase_scope_fk'
  ) THEN
    ALTER TABLE project_memory_entries
      ADD CONSTRAINT project_memory_phase_scope_fk
      FOREIGN KEY (project_id, phase_id)
      REFERENCES phases (project_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_memory_task_scope_fk'
  ) THEN
    ALTER TABLE project_memory_entries
      ADD CONSTRAINT project_memory_task_scope_fk
      FOREIGN KEY (project_id, phase_id, task_id)
      REFERENCES tasks (project_id, phase_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'architecture_revisions_phase_scope_fk'
  ) THEN
    ALTER TABLE architecture_revisions
      ADD CONSTRAINT architecture_revisions_phase_scope_fk
      FOREIGN KEY (project_id, phase_id)
      REFERENCES phases (project_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_phase_scope_fk'
  ) THEN
    ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_phase_scope_fk
      FOREIGN KEY (project_id, phase_id)
      REFERENCES phases (project_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_task_scope_fk'
  ) THEN
    ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_task_scope_fk
      FOREIGN KEY (project_id, phase_id, task_id)
      REFERENCES tasks (project_id, phase_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_run_scope_fk'
  ) THEN
    ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_run_scope_fk
      FOREIGN KEY (project_id, phase_id, task_id, run_id)
      REFERENCES agent_runs (project_id, phase_id, task_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'verification_results_run_scope_fk'
  ) THEN
    ALTER TABLE verification_results
      ADD CONSTRAINT verification_results_run_scope_fk
      FOREIGN KEY (project_id, phase_id, task_id, run_id)
      REFERENCES agent_runs (project_id, phase_id, task_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'verification_results_repository_scope_fk'
  ) THEN
    ALTER TABLE verification_results
      ADD CONSTRAINT verification_results_repository_scope_fk
      FOREIGN KEY (project_id, repository_binding_id)
      REFERENCES repository_bindings (project_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'budget_allocations_phase_scope_fk'
  ) THEN
    ALTER TABLE budget_allocations
      ADD CONSTRAINT budget_allocations_phase_scope_fk
      FOREIGN KEY (project_id, phase_id)
      REFERENCES phases (project_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'budget_reservations_run_scope_fk'
  ) THEN
    ALTER TABLE budget_reservations
      ADD CONSTRAINT budget_reservations_run_scope_fk
      FOREIGN KEY (project_id, phase_id, task_id, run_id)
      REFERENCES agent_runs (project_id, phase_id, task_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_phase_scope_fk'
  ) THEN
    ALTER TABLE usage_events
      ADD CONSTRAINT usage_events_phase_scope_fk
      FOREIGN KEY (project_id, phase_id)
      REFERENCES phases (project_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_task_scope_fk'
  ) THEN
    ALTER TABLE usage_events
      ADD CONSTRAINT usage_events_task_scope_fk
      FOREIGN KEY (project_id, phase_id, task_id)
      REFERENCES tasks (project_id, phase_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_run_scope_fk'
  ) THEN
    ALTER TABLE usage_events
      ADD CONSTRAINT usage_events_run_scope_fk
      FOREIGN KEY (project_id, phase_id, task_id, run_id)
      REFERENCES agent_runs (project_id, phase_id, task_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'commands_run_scope_fk'
  ) THEN
    ALTER TABLE commands
      ADD CONSTRAINT commands_run_scope_fk
      FOREIGN KEY (project_id, phase_id, task_id, run_id)
      REFERENCES agent_runs (project_id, phase_id, task_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_jobs_command_scope_fk'
  ) THEN
    ALTER TABLE dispatch_jobs
      ADD CONSTRAINT dispatch_jobs_command_scope_fk
      FOREIGN KEY (project_id, phase_id, task_id, run_id, command_id)
      REFERENCES commands (project_id, phase_id, task_id, run_id, command_id)
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'domain_events_phase_scope_fk'
  ) THEN
    ALTER TABLE domain_events
      ADD CONSTRAINT domain_events_phase_scope_fk
      FOREIGN KEY (project_id, phase_id)
      REFERENCES phases (project_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'domain_events_task_scope_fk'
  ) THEN
    ALTER TABLE domain_events
      ADD CONSTRAINT domain_events_task_scope_fk
      FOREIGN KEY (project_id, phase_id, task_id)
      REFERENCES tasks (project_id, phase_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_events_phase_scope_fk'
  ) THEN
    ALTER TABLE audit_events
      ADD CONSTRAINT audit_events_phase_scope_fk
      FOREIGN KEY (project_id, phase_id)
      REFERENCES phases (project_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_events_task_scope_fk'
  ) THEN
    ALTER TABLE audit_events
      ADD CONSTRAINT audit_events_task_scope_fk
      FOREIGN KEY (project_id, phase_id, task_id)
      REFERENCES tasks (project_id, phase_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_primary_repository_scope_fk'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_primary_repository_scope_fk
      FOREIGN KEY (id, primary_repository_binding_id)
      REFERENCES repository_bindings (project_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_current_architecture_scope_fk'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_current_architecture_scope_fk
      FOREIGN KEY (id, current_architecture_revision_id)
      REFERENCES architecture_revisions (project_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'phases_approved_strategy_scope_fk'
  ) THEN
    ALTER TABLE phases
      ADD CONSTRAINT phases_approved_strategy_scope_fk
      FOREIGN KEY (project_id, id, approved_strategy_version_id)
      REFERENCES strategy_versions (project_id, phase_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'strategy_versions_approval_scope_fk'
  ) THEN
    ALTER TABLE strategy_versions
      ADD CONSTRAINT strategy_versions_approval_scope_fk
      FOREIGN KEY (project_id, phase_id, approval_id)
      REFERENCES approvals (project_id, phase_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'strategy_versions_supersedes_scope_fk'
  ) THEN
    ALTER TABLE strategy_versions
      ADD CONSTRAINT strategy_versions_supersedes_scope_fk
      FOREIGN KEY (project_id, phase_id, supersedes_strategy_version_id)
      REFERENCES strategy_versions (project_id, phase_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_designated_assignment_scope_fk'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_designated_assignment_scope_fk
      FOREIGN KEY (project_id, phase_id, id, designated_assignment_id)
      REFERENCES agent_assignments (project_id, phase_id, task_id, id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_designated_run_scope_fk'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_designated_run_scope_fk
      FOREIGN KEY (project_id, phase_id, id, designated_run_id)
      REFERENCES agent_runs (project_id, phase_id, task_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_superseded_by_scope_fk'
  ) THEN
    ALTER TABLE agent_runs
      ADD CONSTRAINT agent_runs_superseded_by_scope_fk
      FOREIGN KEY (project_id, phase_id, task_id, superseded_by_run_id)
      REFERENCES agent_runs (project_id, phase_id, task_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'decision_points_supersedes_scope_fk'
  ) THEN
    ALTER TABLE decision_points
      ADD CONSTRAINT decision_points_supersedes_scope_fk
      FOREIGN KEY (project_id, condition_key, supersedes_decision_point_id)
      REFERENCES decision_points (project_id, condition_key, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'decision_points_superseded_by_scope_fk'
  ) THEN
    ALTER TABLE decision_points
      ADD CONSTRAINT decision_points_superseded_by_scope_fk
      FOREIGN KEY (project_id, condition_key, superseded_by_decision_point_id)
      REFERENCES decision_points (project_id, condition_key, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'approvals_superseded_by_scope_fk'
  ) THEN
    ALTER TABLE approvals
      ADD CONSTRAINT approvals_superseded_by_scope_fk
      FOREIGN KEY (
        project_id, subject_entity_type, subject_entity_id, superseded_by_approval_id
      )
      REFERENCES approvals (
        project_id, subject_entity_type, subject_entity_id, id
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'decision_records_decision_point_scope_fk'
  ) THEN
    ALTER TABLE decision_records
      ADD CONSTRAINT decision_records_decision_point_scope_fk
      FOREIGN KEY (project_id, decision_point_id)
      REFERENCES decision_points (project_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'decision_records_approval_scope_fk'
  ) THEN
    ALTER TABLE decision_records
      ADD CONSTRAINT decision_records_approval_scope_fk
      FOREIGN KEY (project_id, approval_id)
      REFERENCES approvals (project_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'decision_records_supersedes_scope_fk'
  ) THEN
    ALTER TABLE decision_records
      ADD CONSTRAINT decision_records_supersedes_scope_fk
      FOREIGN KEY (project_id, supersedes_decision_record_id)
      REFERENCES decision_records (project_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'decision_records_superseded_by_scope_fk'
  ) THEN
    ALTER TABLE decision_records
      ADD CONSTRAINT decision_records_superseded_by_scope_fk
      FOREIGN KEY (project_id, superseded_by_decision_record_id)
      REFERENCES decision_records (project_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_memory_supersedes_scope_fk'
  ) THEN
    ALTER TABLE project_memory_entries
      ADD CONSTRAINT project_memory_supersedes_scope_fk
      FOREIGN KEY (project_id, supersedes_memory_entry_id)
      REFERENCES project_memory_entries (project_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_memory_superseded_by_scope_fk'
  ) THEN
    ALTER TABLE project_memory_entries
      ADD CONSTRAINT project_memory_superseded_by_scope_fk
      FOREIGN KEY (project_id, superseded_by_memory_entry_id)
      REFERENCES project_memory_entries (project_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'architecture_revisions_artifact_scope_fk'
  ) THEN
    ALTER TABLE architecture_revisions
      ADD CONSTRAINT architecture_revisions_artifact_scope_fk
      FOREIGN KEY (project_id, architecture_artifact_id)
      REFERENCES artifacts (project_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'architecture_revisions_approval_scope_fk'
  ) THEN
    ALTER TABLE architecture_revisions
      ADD CONSTRAINT architecture_revisions_approval_scope_fk
      FOREIGN KEY (project_id, approval_id)
      REFERENCES approvals (project_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'architecture_revisions_supersedes_scope_fk'
  ) THEN
    ALTER TABLE architecture_revisions
      ADD CONSTRAINT architecture_revisions_supersedes_scope_fk
      FOREIGN KEY (project_id, supersedes_architecture_revision_id)
      REFERENCES architecture_revisions (project_id, id);
  END IF;
END
$migration$;

-- A human disposition is terminal. A later material change may link a new
-- DecisionPoint revision, but it must not rewrite what the human decided.
CREATE OR REPLACE FUNCTION norns_guard_decision_point_terminal_status()
RETURNS trigger
LANGUAGE plpgsql
AS $decision_point_guard$
BEGIN
  IF OLD.status IN ('resolved', 'dismissed')
    AND NEW.status IS DISTINCT FROM OLD.status
  THEN
    RAISE EXCEPTION 'decision point % has terminal status %; transition to % is forbidden',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$decision_point_guard$;

-- Domain and audit history are append-only even when the application connects
-- with table-owner privileges (as PGlite does in verification).
CREATE OR REPLACE FUNCTION norns_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $append_only$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END
$append_only$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'decision_points_terminal_status_guard'
      AND tgrelid = 'decision_points'::regclass
  ) THEN
    CREATE TRIGGER decision_points_terminal_status_guard
      BEFORE UPDATE OF status ON decision_points
      FOR EACH ROW EXECUTE FUNCTION norns_guard_decision_point_terminal_status();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'domain_events_append_only'
      AND tgrelid = 'domain_events'::regclass
  ) THEN
    CREATE TRIGGER domain_events_append_only
      BEFORE UPDATE OR DELETE ON domain_events
      FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'audit_events_append_only'
      AND tgrelid = 'audit_events'::regclass
  ) THEN
    CREATE TRIGGER audit_events_append_only
      BEFORE UPDATE OR DELETE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'domain_events_append_only_truncate'
      AND tgrelid = 'domain_events'::regclass
  ) THEN
    CREATE TRIGGER domain_events_append_only_truncate
      BEFORE TRUNCATE ON domain_events
      FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'audit_events_append_only_truncate'
      AND tgrelid = 'audit_events'::regclass
  ) THEN
    CREATE TRIGGER audit_events_append_only_truncate
      BEFORE TRUNCATE ON audit_events
      FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation();
  END IF;
END
$migration$;

-- Provision the runtime role against the schema selected by this connection.
-- This supports isolated-schema verification and avoids silently granting the
-- wrong `public` relations when search_path is deployment-specific.
DO $production_grants$
DECLARE
  runtime_schema TEXT := current_schema();
  runtime_table TEXT;
  operational_tables TEXT[] := ARRAY[
    'users',
    'sessions',
    'projects',
    'repository_bindings',
    'phases',
    'phase_dependencies',
    'strategy_versions',
    'strategy_reviews',
    'objectives',
    'tasks',
    'task_dependencies',
    'agent_profiles',
    'agent_assignments',
    'agent_runs',
    'decision_points',
    'approvals',
    'decision_records',
    'project_memory_entries',
    'architecture_revisions',
    'artifacts',
    'verification_results',
    'budget_allocations',
    'budget_reservations',
    'usage_events',
    'commands',
    'dispatch_jobs',
    'runner_events',
    'idempotency_records',
    'lifecycle_integrity_findings',
    'projection_checkpoints',
    'migration_runs',
    'legacy_id_mappings'
  ];
BEGIN
  IF runtime_schema IS NULL THEN
    RAISE EXCEPTION 'migration search_path has no current schema'
      USING ERRCODE = '3F000';
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO norns_app', runtime_schema);

  FOREACH runtime_table IN ARRAY operational_tables LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM norns_app',
      runtime_schema,
      runtime_table
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO norns_app',
      runtime_schema,
      runtime_table
    );
  END LOOP;

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE %I.domain_events, %I.audit_events FROM PUBLIC',
    runtime_schema,
    runtime_schema
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE %I.domain_events, %I.audit_events FROM norns_app',
    runtime_schema,
    runtime_schema
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE %I.domain_events, %I.audit_events TO norns_app',
    runtime_schema,
    runtime_schema
  );
END
$production_grants$;

-- Validate the exact operation the runtime transaction adapter performs.
SET LOCAL ROLE norns_app;
RESET ROLE;
