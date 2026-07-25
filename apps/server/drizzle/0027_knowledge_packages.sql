-- Knowledge-package and agent-execution operating system.
--
-- Raw conversations never enter these tables: only reviewed package versions,
-- exact task manifests, structured agent reports, and proposed knowledge
-- deltas do.

CREATE TABLE knowledge_packages (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  package_type TEXT NOT NULL
    CHECK (package_type IN ('project','architecture','domain','quality','phase','current_state')),
  authority TEXT NOT NULL
    CHECK (authority IN ('constitutional','domain_standard','operational')),
  owner_role TEXT NOT NULL CHECK (length(trim(owner_role)) > 0),
  scope_kind TEXT NOT NULL
    CHECK (scope_kind IN ('project','phase','domain','quality','architecture')),
  scope_id TEXT NOT NULL CHECK (length(trim(scope_id)) > 0),
  parent_package_id TEXT REFERENCES knowledge_packages(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, id)
);
CREATE INDEX knowledge_packages_project_type_idx
  ON knowledge_packages(project_id, package_type);

CREATE TABLE knowledge_package_versions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  version TEXT NOT NULL
    CHECK (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'),
  status TEXT NOT NULL
    CHECK (status IN ('draft','under_review','approved','active','superseded','archived')),
  content JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_by_actor_type TEXT NOT NULL
    CHECK (created_by_actor_type IN ('human','coordinator','agent','runner','system','legacy')),
  created_by_actor_id TEXT,
  approved_by_actor_type TEXT
    CHECK (approved_by_actor_type IS NULL OR approved_by_actor_type IN ('human','coordinator','agent','runner','system','legacy')),
  approved_by_actor_id TEXT,
  approved_at TIMESTAMPTZ,
  supersedes_version_id TEXT REFERENCES knowledge_package_versions(id) ON DELETE RESTRICT,
  superseded_by_version_id TEXT REFERENCES knowledge_package_versions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, package_id)
    REFERENCES knowledge_packages(project_id, id) ON DELETE CASCADE,
  UNIQUE (package_id, version),
  CONSTRAINT knowledge_package_versions_human_creator_check
    CHECK (created_by_actor_type <> 'human' OR created_by_actor_id IS NOT NULL),
  CONSTRAINT knowledge_package_versions_approval_check
    CHECK (
      status IN ('draft','under_review')
      OR (approved_by_actor_type IS NOT NULL AND approved_by_actor_id IS NOT NULL AND approved_at IS NOT NULL)
    ),
  CONSTRAINT knowledge_package_versions_supersession_shape_check
    CHECK (
      (status = 'superseded' AND superseded_by_version_id IS NOT NULL)
      OR (status <> 'superseded')
    )
);
CREATE UNIQUE INDEX knowledge_package_versions_one_active_idx
  ON knowledge_package_versions(package_id) WHERE status = 'active';
CREATE UNIQUE INDEX knowledge_package_versions_one_approved_idx
  ON knowledge_package_versions(package_id) WHERE status = 'approved';
CREATE INDEX knowledge_package_versions_project_status_idx
  ON knowledge_package_versions(project_id, status);

CREATE TABLE knowledge_package_dependencies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  package_version_id TEXT NOT NULL REFERENCES knowledge_package_versions(id) ON DELETE CASCADE,
  required_package_version_id TEXT NOT NULL REFERENCES knowledge_package_versions(id) ON DELETE RESTRICT,
  relation_kind TEXT NOT NULL
    CHECK (relation_kind IN ('mandatory','parent_domain','cross_domain')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (package_version_id, required_package_version_id),
  CHECK (package_version_id <> required_package_version_id)
);
CREATE INDEX knowledge_package_dependencies_required_idx
  ON knowledge_package_dependencies(required_package_version_id);

CREATE TABLE knowledge_interface_contracts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  owner_role TEXT NOT NULL CHECK (length(trim(owner_role)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, id)
);

CREATE TABLE knowledge_interface_contract_versions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  version TEXT NOT NULL
    CHECK (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'),
  status TEXT NOT NULL
    CHECK (status IN ('draft','under_review','approved','active','superseded','archived')),
  content JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_by_actor_type TEXT NOT NULL
    CHECK (created_by_actor_type IN ('human','coordinator','agent','runner','system','legacy')),
  created_by_actor_id TEXT,
  approved_by_actor_type TEXT,
  approved_by_actor_id TEXT,
  approved_at TIMESTAMPTZ,
  supersedes_version_id TEXT REFERENCES knowledge_interface_contract_versions(id) ON DELETE RESTRICT,
  superseded_by_version_id TEXT REFERENCES knowledge_interface_contract_versions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, contract_id)
    REFERENCES knowledge_interface_contracts(project_id, id) ON DELETE CASCADE,
  UNIQUE (contract_id, version),
  CONSTRAINT knowledge_interface_versions_approval_check
    CHECK (
      status IN ('draft','under_review')
      OR (approved_by_actor_type IS NOT NULL AND approved_by_actor_id IS NOT NULL AND approved_at IS NOT NULL)
    )
);
CREATE UNIQUE INDEX knowledge_interface_versions_one_active_idx
  ON knowledge_interface_contract_versions(contract_id) WHERE status = 'active';
CREATE UNIQUE INDEX knowledge_interface_versions_one_approved_idx
  ON knowledge_interface_contract_versions(contract_id) WHERE status = 'approved';

CREATE TABLE task_knowledge_packages (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft','approved','superseded')),
  content JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  approved_by_actor_type TEXT,
  approved_by_actor_id TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks(project_id, phase_id, id) ON DELETE CASCADE,
  UNIQUE (task_id, version),
  CONSTRAINT task_knowledge_packages_approval_check
    CHECK (
      status <> 'approved'
      OR (approved_by_actor_type IS NOT NULL AND approved_by_actor_id IS NOT NULL AND approved_at IS NOT NULL)
    )
);
CREATE UNIQUE INDEX task_knowledge_packages_one_approved_idx
  ON task_knowledge_packages(task_id) WHERE status = 'approved';

CREATE TABLE task_context_manifests (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_package_id TEXT NOT NULL REFERENCES task_knowledge_packages(id) ON DELETE RESTRICT,
  repository_commit TEXT NOT NULL CHECK (length(trim(repository_commit)) > 0),
  content JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  generated_by_actor_type TEXT NOT NULL,
  generated_by_actor_id TEXT,
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks(project_id, phase_id, id) ON DELETE CASCADE,
  UNIQUE (task_id, content_hash)
);
CREATE INDEX task_context_manifests_task_generated_idx
  ON task_context_manifests(task_id, generated_at DESC);

CREATE TABLE agent_execution_registrations (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  context_manifest_id TEXT NOT NULL REFERENCES task_context_manifests(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  branch_or_workspace TEXT NOT NULL CHECK (length(trim(branch_or_workspace)) > 0),
  token_budget INTEGER CHECK (token_budget IS NULL OR token_budget > 0),
  status TEXT NOT NULL
    CHECK (status IN ('registered','active','waiting','blocked','completed','failed','cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks(project_id, phase_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_execution_registrations_completion_check
    CHECK ((status IN ('completed','failed','cancelled')) = (completed_at IS NOT NULL))
);
CREATE INDEX agent_execution_registrations_phase_status_idx
  ON agent_execution_registrations(phase_id, status);

CREATE TABLE agent_status_heartbeats (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_execution_registrations(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  progress_status TEXT NOT NULL CHECK (progress_status IN ('working','waiting','blocked','completed')),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('green','yellow','red')),
  payload JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  repeated_update_count INTEGER NOT NULL DEFAULT 0 CHECK (repeated_update_count >= 0),
  reported_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks(project_id, phase_id, id) ON DELETE CASCADE,
  UNIQUE (run_id, sequence)
);
CREATE INDEX agent_status_heartbeats_run_reported_idx
  ON agent_status_heartbeats(run_id, reported_at DESC);

CREATE TABLE knowledge_deltas (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL
    CHECK (status IN ('proposed','accepted','rejected','modified','deferred','escalated')),
  changes JSONB NOT NULL CHECK (jsonb_array_length(changes) > 0),
  recommended_package_updates JSONB NOT NULL DEFAULT '[]'::jsonb,
  submitted_at TIMESTAMPTZ NOT NULL,
  disposition_note TEXT,
  dispositioned_by_actor_type TEXT,
  dispositioned_by_actor_id TEXT,
  dispositioned_at TIMESTAMPTZ,
  FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks(project_id, phase_id, id) ON DELETE CASCADE,
  CONSTRAINT knowledge_deltas_disposition_check
    CHECK (
      status = 'proposed'
      OR (
        length(trim(disposition_note)) > 0
        AND dispositioned_by_actor_type IS NOT NULL
        AND dispositioned_by_actor_id IS NOT NULL
        AND dispositioned_at IS NOT NULL
      )
    )
);
CREATE INDEX knowledge_deltas_phase_status_idx ON knowledge_deltas(phase_id, status);
CREATE INDEX knowledge_deltas_task_idx ON knowledge_deltas(task_id, submitted_at DESC);

CREATE TABLE agent_handoffs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('completed','blocked','failed')),
  payload JSONB NOT NULL,
  knowledge_delta_id TEXT REFERENCES knowledge_deltas(id) ON DELETE RESTRICT,
  submitted_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks(project_id, phase_id, id) ON DELETE CASCADE,
  UNIQUE (run_id)
);

CREATE TABLE knowledge_conflicts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  left_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  right_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('C0','C1','C2','C3','C4')),
  conflict_kind TEXT NOT NULL
    CHECK (conflict_kind IN (
      'file_overlap','interface_overlap','package_version_mismatch',
      'acceptance_criteria_conflict','branch_overlap','superseded_decision',
      'dependency_cycle','incomplete_contract','delta_conflict','duplicate_implementation'
    )),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  details JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by_actor_type TEXT,
  resolved_by_actor_id TEXT,
  resolved_at TIMESTAMPTZ,
  UNIQUE (phase_id, left_task_id, right_task_id, conflict_kind),
  CHECK (left_task_id <> right_task_id),
  CONSTRAINT knowledge_conflicts_resolution_check
    CHECK (
      (status = 'open' AND resolved_by_actor_type IS NULL AND resolved_by_actor_id IS NULL AND resolved_at IS NULL)
      OR
      (status <> 'open' AND resolved_by_actor_type IS NOT NULL AND resolved_by_actor_id IS NOT NULL AND resolved_at IS NOT NULL)
    )
);
CREATE INDEX knowledge_conflicts_phase_open_idx
  ON knowledge_conflicts(phase_id, severity) WHERE status = 'open';

CREATE TABLE knowledge_gate_evaluations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id TEXT REFERENCES phases(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('task','phase')),
  scope_id TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  payload JSONB NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (scope_type = 'task' AND task_id = scope_id AND phase_id IS NOT NULL)
    OR
    (scope_type = 'phase' AND phase_id = scope_id AND task_id IS NULL)
  )
);
CREATE INDEX knowledge_gate_evaluations_scope_idx
  ON knowledge_gate_evaluations(scope_type, scope_id, evaluated_at DESC);

CREATE TABLE knowledge_audit_log (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id TEXT REFERENCES phases(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL CHECK (length(trim(action)) > 0),
  subject_type TEXT NOT NULL CHECK (length(trim(subject_type)) > 0),
  subject_id TEXT NOT NULL CHECK (length(trim(subject_id)) > 0),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_audit_log_project_time_idx
  ON knowledge_audit_log(project_id, occurred_at DESC);

REVOKE ALL PRIVILEGES ON
  knowledge_packages,
  knowledge_package_versions,
  knowledge_package_dependencies,
  knowledge_interface_contracts,
  knowledge_interface_contract_versions,
  task_knowledge_packages,
  task_context_manifests,
  agent_execution_registrations,
  agent_status_heartbeats,
  knowledge_deltas,
  agent_handoffs,
  knowledge_conflicts,
  knowledge_gate_evaluations,
  knowledge_audit_log
FROM PUBLIC;

REVOKE ALL PRIVILEGES ON
  knowledge_packages,
  knowledge_package_versions,
  knowledge_package_dependencies,
  knowledge_interface_contracts,
  knowledge_interface_contract_versions,
  task_knowledge_packages,
  task_context_manifests,
  agent_execution_registrations,
  agent_status_heartbeats,
  knowledge_deltas,
  agent_handoffs,
  knowledge_conflicts,
  knowledge_gate_evaluations,
  knowledge_audit_log
FROM norns_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  knowledge_packages,
  knowledge_package_versions,
  knowledge_package_dependencies,
  knowledge_interface_contracts,
  knowledge_interface_contract_versions,
  task_knowledge_packages,
  agent_execution_registrations,
  knowledge_deltas,
  knowledge_conflicts
TO norns_app;

-- These records are evidence, not mutable state. The runtime may append and
-- read them but cannot rewrite or delete history.
GRANT SELECT, INSERT ON
  task_context_manifests,
  agent_status_heartbeats,
  agent_handoffs,
  knowledge_gate_evaluations,
  knowledge_audit_log
TO norns_app;

GRANT USAGE, SELECT ON SEQUENCE knowledge_audit_log_id_seq TO norns_app;
