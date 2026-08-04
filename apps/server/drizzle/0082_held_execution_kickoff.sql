-- Approval freezes the reviewed plan and prepares its execution handoff, but
-- agent work starts only after a separate human action releases this intent.

ALTER TABLE conversation_kickoff_intents
  DROP CONSTRAINT conversation_kickoff_intents_status_check;

ALTER TABLE conversation_kickoff_intents
  ADD CONSTRAINT conversation_kickoff_intents_status_check
  CHECK (status IN ('held','pending','leased','succeeded','refused','failed'));

ALTER TABLE conversation_kickoff_intents
  DROP CONSTRAINT conversation_kickoff_intents_lifecycle_check;

ALTER TABLE conversation_kickoff_intents
  ADD CONSTRAINT conversation_kickoff_intents_lifecycle_check CHECK (
    (
      status IN ('held','pending')
      AND lease_token IS NULL AND lease_expires_at IS NULL
      AND execution_started IS NULL AND execution_detail IS NULL
      AND phase_id IS NULL AND settled_at IS NULL
    ) OR (
      status = 'leased'
      AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND execution_started IS NULL AND execution_detail IS NULL
      AND phase_id IS NULL AND settled_at IS NULL
    ) OR (
      status IN ('succeeded','refused','failed')
      AND lease_token IS NULL AND lease_expires_at IS NULL
      AND execution_started IS NOT NULL AND execution_detail IS NOT NULL
      AND settled_at IS NOT NULL
      AND ((status = 'succeeded' AND execution_started AND phase_id IS NOT NULL)
        OR (status IN ('refused','failed') AND NOT execution_started AND phase_id IS NULL))
    )
  );

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
