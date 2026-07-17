-- Phase 7: browser-session hardening, recovery, resilience evidence,
-- progressive relational cutover, and separately authorized retirement.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS authenticated_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS client_label TEXT;
UPDATE sessions SET authenticated_at=created_at WHERE authenticated_at IS NULL;
ALTER TABLE sessions ALTER COLUMN authenticated_at SET NOT NULL,
  ALTER COLUMN authenticated_at SET DEFAULT now();

CREATE TABLE password_recovery_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL CONSTRAINT password_recovery_tokens_user_fk
    REFERENCES users (id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL,
  token_hash_scheme TEXT NOT NULL,
  token_key_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT password_recovery_status_check CHECK (status IN ('pending','consumed','revoked','expired')),
  CONSTRAINT password_recovery_consumed_check CHECK (status <> 'consumed' OR consumed_at IS NOT NULL),
  CONSTRAINT password_recovery_hash_scheme_check CHECK (token_hash_scheme='hmac-sha256')
);

CREATE TABLE security_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL CONSTRAINT security_notifications_user_fk
    REFERENCES users (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  CONSTRAINT security_notifications_kind_check CHECK (
    kind IN ('session_created','password_recovery_requested','password_changed','invite_accepted','runner_revoked')
  )
);

CREATE TABLE runner_revocations (
  runner_id TEXT PRIMARY KEY,
  revoked_through_generation INTEGER NOT NULL,
  reason TEXT NOT NULL,
  revoked_by TEXT NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT runner_revocations_generation_check CHECK (revoked_through_generation >= 0),
  CONSTRAINT runner_revocations_reason_check CHECK (length(trim(reason)) > 0)
);

CREATE TABLE resilience_drills (
  id TEXT PRIMARY KEY,
  drill_type TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  target_reference TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  recovery_time_seconds INTEGER NOT NULL,
  recovery_point_seconds INTEGER NOT NULL,
  passed BOOLEAN NOT NULL,
  evidence JSONB NOT NULL,
  recorded_by TEXT NOT NULL,
  CONSTRAINT resilience_drill_type_check CHECK (drill_type IN ('restore','chaos','load','soak','runner_fencing','audit')),
  CONSTRAINT resilience_drill_time_check CHECK (completed_at >= started_at),
  CONSTRAINT resilience_drill_objective_check CHECK (recovery_time_seconds >= 0 AND recovery_point_seconds >= 0)
);

CREATE TABLE v2_cutover_cohorts (
  id TEXT PRIMARY KEY,
  cohort_type TEXT NOT NULL,
  project_id TEXT CONSTRAINT v2_cutover_cohorts_project_fk REFERENCES projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  reconciliation_fingerprint TEXT NOT NULL,
  restore_drill_id TEXT NOT NULL CONSTRAINT v2_cutover_cohorts_restore_fk
    REFERENCES resilience_drills(id) ON DELETE RESTRICT,
  authorized_by TEXT NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT v2_cutover_cohort_type_check CHECK (cohort_type IN ('internal','selected','new_projects','remaining')),
  CONSTRAINT v2_cutover_status_check CHECK (status IN ('shadow','canary','authoritative','paused')),
  CONSTRAINT v2_cutover_fingerprint_check CHECK (reconciliation_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT v2_cutover_project_shape_check CHECK ((cohort_type='selected')=(project_id IS NOT NULL))
);

CREATE TABLE legacy_retirement_authorizations (
  id TEXT PRIMARY KEY,
  authorized_by TEXT NOT NULL CONSTRAINT legacy_retirement_authorizations_user_fk
    REFERENCES users(id) ON DELETE RESTRICT,
  authorized_at TIMESTAMPTZ NOT NULL,
  retention_window_completed BOOLEAN NOT NULL,
  restore_drill_id TEXT NOT NULL CONSTRAINT legacy_retirement_restore_fk
    REFERENCES resilience_drills(id) ON DELETE RESTRICT,
  unresolved_discrepancy_count INTEGER NOT NULL,
  scope JSONB NOT NULL,
  CONSTRAINT legacy_retirement_retention_check CHECK (retention_window_completed),
  CONSTRAINT legacy_retirement_discrepancy_check CHECK (unresolved_discrepancy_count=0)
);

CREATE FUNCTION norns_reject_phase7_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE='55000';
END;
$guard$;

CREATE TRIGGER resilience_drills_update_delete_guard BEFORE UPDATE OR DELETE ON resilience_drills
  FOR EACH ROW EXECUTE FUNCTION norns_reject_phase7_evidence_mutation();
CREATE TRIGGER resilience_drills_truncate_guard BEFORE TRUNCATE ON resilience_drills
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_phase7_evidence_mutation();
CREATE TRIGGER legacy_retirement_update_delete_guard BEFORE UPDATE OR DELETE ON legacy_retirement_authorizations
  FOR EACH ROW EXECUTE FUNCTION norns_reject_phase7_evidence_mutation();
CREATE TRIGGER legacy_retirement_truncate_guard BEFORE TRUNCATE ON legacy_retirement_authorizations
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_phase7_evidence_mutation();

GRANT SELECT, INSERT, UPDATE ON sessions, password_recovery_tokens, security_notifications TO norns_app;
GRANT SELECT, INSERT, UPDATE ON runner_revocations, v2_cutover_cohorts TO norns_app;
GRANT SELECT, INSERT ON resilience_drills, legacy_retirement_authorizations TO norns_app;
