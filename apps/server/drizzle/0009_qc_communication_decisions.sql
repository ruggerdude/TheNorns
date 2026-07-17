-- Human QC communication: persist the intended recipient and direction text
-- alongside each immutable DecisionRecord. Historical records remain valid.

ALTER TABLE decision_records
  ADD COLUMN direction_target TEXT,
  ADD COLUMN direction_text TEXT,
  ADD CONSTRAINT decision_records_direction_target_check CHECK (
    direction_target IS NULL
    OR direction_target IN ('project_manager','implementation_agent','reviewer','all_agents')
  ),
  ADD CONSTRAINT decision_records_direction_pair_check CHECK (
    (direction_target IS NULL) = (direction_text IS NULL)
  ),
  ADD CONSTRAINT decision_records_direction_text_check CHECK (
    direction_text IS NULL OR length(trim(direction_text)) > 0
  );

ALTER TABLE agent_reviews
  ADD COLUMN reviewer_provider TEXT,
  ADD COLUMN reviewer_model TEXT,
  ADD COLUMN reviewer_roles JSONB;

ALTER TABLE agent_reviews DISABLE TRIGGER agent_reviews_update_delete_guard;
UPDATE agent_reviews review
SET reviewer_provider = profile.provider,
    reviewer_model = profile.model,
    reviewer_roles = profile.roles
FROM agent_profiles profile
WHERE profile.id = review.reviewer_agent_profile_id;
ALTER TABLE agent_reviews ENABLE TRIGGER agent_reviews_update_delete_guard;

ALTER TABLE agent_reviews
  ALTER COLUMN reviewer_provider SET NOT NULL,
  ALTER COLUMN reviewer_model SET NOT NULL,
  ALTER COLUMN reviewer_roles SET NOT NULL;

CREATE TABLE human_directions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  phase_id TEXT,
  task_id TEXT,
  actor_id TEXT NOT NULL CONSTRAINT human_directions_actor_fk
    REFERENCES users (id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  direction_target TEXT NOT NULL,
  direction_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT human_directions_project_fk
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT human_directions_phase_scope_fk
    FOREIGN KEY (project_id, phase_id) REFERENCES phases (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT human_directions_task_scope_fk
    FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks (project_id, phase_id, id) ON DELETE RESTRICT,
  CONSTRAINT human_directions_actor_key_unique UNIQUE (actor_id, idempotency_key),
  CONSTRAINT human_directions_scope_shape_check CHECK (phase_id IS NOT NULL OR task_id IS NULL),
  CONSTRAINT human_directions_target_check CHECK (
    direction_target IN ('project_manager','implementation_agent','reviewer','all_agents')
  ),
  CONSTRAINT human_directions_text_check CHECK (length(trim(direction_text)) > 0),
  CONSTRAINT human_directions_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX human_directions_project_scope_idx
  ON human_directions (project_id, phase_id, task_id, created_at DESC);

CREATE FUNCTION norns_reject_human_direction_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  RAISE EXCEPTION 'human_directions is append-only' USING ERRCODE = '55000';
END;
$guard$;
CREATE TRIGGER human_directions_update_delete_guard
  BEFORE UPDATE OR DELETE ON human_directions
  FOR EACH ROW EXECUTE FUNCTION norns_reject_human_direction_mutation();
CREATE TRIGGER human_directions_truncate_guard
  BEFORE TRUNCATE ON human_directions
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_human_direction_mutation();

CREATE FUNCTION norns_guard_decision_record_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF to_jsonb(NEW) - ARRAY['status','supersedes_decision_record_id','superseded_by_decision_record_id']
     IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['status','supersedes_decision_record_id','superseded_by_decision_record_id'] THEN
    RAISE EXCEPTION 'decision_records substantive fields are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER decision_records_update_guard
  BEFORE UPDATE ON decision_records
  FOR EACH ROW EXECUTE FUNCTION norns_guard_decision_record_mutation();
CREATE TRIGGER decision_records_delete_guard
  BEFORE DELETE ON decision_records
  FOR EACH ROW EXECUTE FUNCTION norns_reject_human_direction_mutation();
CREATE TRIGGER decision_records_truncate_guard
  BEFORE TRUNCATE ON decision_records
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_human_direction_mutation();

CREATE FUNCTION norns_guard_decision_point_substantive_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF to_jsonb(NEW) - ARRAY[
       'status','resolved_at','updated_at',
       'supersedes_decision_point_id','superseded_by_decision_point_id'
     ] IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY[
       'status','resolved_at','updated_at',
       'supersedes_decision_point_id','superseded_by_decision_point_id'
     ] THEN
    RAISE EXCEPTION 'decision point substantive fields are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER decision_points_substantive_update_guard
  BEFORE UPDATE ON decision_points
  FOR EACH ROW EXECUTE FUNCTION norns_guard_decision_point_substantive_mutation();

REVOKE ALL PRIVILEGES ON decision_records FROM norns_app;
GRANT SELECT, INSERT, UPDATE ON decision_records TO norns_app;
GRANT SELECT, INSERT ON human_directions TO norns_app;
