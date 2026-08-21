-- Global and project Ponytail defaults, plus the exact mode pinned when a
-- held execution handoff is released to development.

DO $ponytail_settings_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM norns_schema_migrations WHERE name = '0088_work_item_workflow'
  ) THEN
    RAISE EXCEPTION '0089_ponytail_settings requires 0088_work_item_workflow'
      USING ERRCODE = '55000';
  END IF;
END
$ponytail_settings_dependency$;

ALTER TABLE global_rule_settings
  ADD COLUMN ponytail_mode TEXT NOT NULL DEFAULT 'full';

ALTER TABLE global_rule_settings
  ADD CONSTRAINT global_rule_settings_ponytail_mode_check
  CHECK (ponytail_mode IN ('off','lite','full','ultra'));

ALTER TABLE planning_reviewer_settings
  ADD COLUMN ponytail_mode TEXT;

ALTER TABLE planning_reviewer_settings
  ADD CONSTRAINT planning_reviewer_settings_ponytail_mode_check
  CHECK (ponytail_mode IS NULL OR ponytail_mode IN ('off','lite','full','ultra'));

ALTER TABLE conversation_kickoff_intents
  ADD COLUMN ponytail_mode TEXT NOT NULL DEFAULT 'full';

ALTER TABLE conversation_kickoff_intents
  ADD CONSTRAINT conversation_kickoff_intents_ponytail_mode_check
  CHECK (ponytail_mode IN ('off','lite','full','ultra'));

CREATE OR REPLACE FUNCTION norns_guard_kickoff_intent_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.source_conversation_id <> OLD.source_conversation_id
     OR NEW.execution_conversation_id <> OLD.execution_conversation_id
     OR NEW.action_id <> OLD.action_id
     OR NEW.approved_plan_version_id <> OLD.approved_plan_version_id
     OR NEW.plan_review_id <> OLD.plan_review_id
     OR NEW.planning_run_id <> OLD.planning_run_id
     OR NEW.handoff_id <> OLD.handoff_id
     OR NEW.decided_by_user_id <> OLD.decided_by_user_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kickoff intent identity and approval scope are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('succeeded','refused','failed') THEN
    RAISE EXCEPTION 'settled kickoff intents are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.ponytail_mode <> OLD.ponytail_mode
     AND NOT (OLD.status='held' AND NEW.status='pending') THEN
    RAISE EXCEPTION 'ponytail mode can change only when development is released'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status='held' AND NEW.status='pending')
    OR (OLD.status='pending' AND NEW.status='leased')
    OR (OLD.status='leased' AND NEW.status IN ('pending','succeeded','refused','failed'))
  ) THEN
    RAISE EXCEPTION 'invalid kickoff intent transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
