-- Let an active conversation switch models without leaving its provider
-- ecosystem. Durable visible messages remain the conversation memory; the
-- provider stays pinned so a model change cannot silently cross ecosystems.

DO $conversation_model_switching_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0047_conversation_plan_handoff_choices'
  ) THEN
    RAISE EXCEPTION
      '0048_conversation_model_switching requires 0047_conversation_plan_handoff_choices'
      USING ERRCODE = '55000';
  END IF;
END
$conversation_model_switching_dependency$;

CREATE OR REPLACE FUNCTION norns_guard_conversation_identity()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.kind <> OLD.kind
     OR NEW.provider <> OLD.provider
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'conversation identity and provider ecosystem are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.model <> OLD.model AND (
    OLD.status <> 'active'
    OR EXISTS (
      SELECT 1
        FROM conversation_turn_attempts attempt
       WHERE attempt.conversation_id = OLD.id
         AND attempt.status IN ('pending', 'streaming')
    )
    OR EXISTS (
      SELECT 1
        FROM conversation_plan_proposal_attempts proposal
       WHERE proposal.conversation_id = OLD.id
         AND proposal.status = 'pending'
    )
  ) THEN
    RAISE EXCEPTION
      'conversation model cannot change while work is active or after the conversation closes'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
