-- Phase 6: durable capability metadata, allocation decisions, conflict scopes,
-- and independent agent review/rework evidence.

ALTER TABLE agent_profiles
  ADD COLUMN IF NOT EXISTS max_concurrent_runs INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS average_latency_ms INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ,
  ADD CONSTRAINT agent_profiles_max_concurrent_runs_check CHECK (max_concurrent_runs > 0),
  ADD CONSTRAINT agent_profiles_average_latency_check CHECK (average_latency_ms >= 0),
  ADD CONSTRAINT agent_profiles_failure_count_check CHECK (failure_count >= 0);

CREATE TABLE task_coordination_constraints (
  task_id TEXT PRIMARY KEY CONSTRAINT task_coordination_constraints_task_id_tasks_id_fk
    REFERENCES tasks (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  conflict_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  estimated_context_tokens INTEGER NOT NULL DEFAULT 1,
  requires_independent_review BOOLEAN NOT NULL DEFAULT true,
  critical_path_weight INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT task_coordination_constraints_task_scope_fk
    FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks (project_id, phase_id, id) ON DELETE CASCADE,
  CONSTRAINT task_coordination_context_check CHECK (estimated_context_tokens > 0),
  CONSTRAINT task_coordination_critical_path_check CHECK (critical_path_weight >= 0)
);

CREATE TABLE agent_allocation_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  agent_profile_id TEXT NOT NULL CONSTRAINT allocation_decisions_agent_profile_fk
    REFERENCES agent_profiles (id) ON DELETE RESTRICT,
  reviewer_agent_profile_id TEXT CONSTRAINT allocation_decisions_reviewer_profile_fk
    REFERENCES agent_profiles (id) ON DELETE RESTRICT,
  score NUMERIC(12,6) NOT NULL,
  factors JSONB NOT NULL,
  alternatives JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflict_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  policy_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT allocation_decisions_assignment_scope_fk
    FOREIGN KEY (project_id, phase_id, task_id, assignment_id)
    REFERENCES agent_assignments (project_id, phase_id, task_id, id) ON DELETE RESTRICT
);
CREATE INDEX agent_allocation_decisions_task_created_idx
  ON agent_allocation_decisions (task_id, created_at DESC);

CREATE TABLE agent_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  reviewer_agent_profile_id TEXT NOT NULL CONSTRAINT agent_reviews_reviewer_profile_fk
    REFERENCES agent_profiles (id) ON DELETE RESTRICT,
  review_round INTEGER NOT NULL,
  decision TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_reviews_run_scope_fk
    FOREIGN KEY (project_id, phase_id, task_id, run_id)
    REFERENCES agent_runs (project_id, phase_id, task_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_reviews_round_check CHECK (review_round > 0),
  CONSTRAINT agent_reviews_decision_check CHECK (decision IN ('approved','rework','escalated')),
  CONSTRAINT agent_reviews_summary_check CHECK (length(trim(summary)) > 0),
  CONSTRAINT agent_reviews_run_round_unique UNIQUE (run_id, review_round)
);

CREATE FUNCTION norns_reject_phase6_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$guard$;

CREATE TRIGGER agent_allocation_decisions_update_delete_guard
  BEFORE UPDATE OR DELETE ON agent_allocation_decisions
  FOR EACH ROW EXECUTE FUNCTION norns_reject_phase6_evidence_mutation();
CREATE TRIGGER agent_allocation_decisions_truncate_guard
  BEFORE TRUNCATE ON agent_allocation_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_phase6_evidence_mutation();
CREATE TRIGGER agent_reviews_update_delete_guard
  BEFORE UPDATE OR DELETE ON agent_reviews
  FOR EACH ROW EXECUTE FUNCTION norns_reject_phase6_evidence_mutation();
CREATE TRIGGER agent_reviews_truncate_guard
  BEFORE TRUNCATE ON agent_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_phase6_evidence_mutation();

GRANT SELECT, INSERT, UPDATE ON task_coordination_constraints TO norns_app;
GRANT SELECT, INSERT ON agent_allocation_decisions, agent_reviews TO norns_app;
