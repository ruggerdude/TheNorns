-- Preserve terminal QC results while allowing the visible reviewer/PM
-- conversation to continue after automated review has finished.

DO $qc_terminal_followup_chat_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0082_held_execution_kickoff'
  ) THEN
    RAISE EXCEPTION
      '0083_qc_terminal_followup_chat requires 0082_held_execution_kickoff'
      USING ERRCODE = '55000';
  END IF;
END
$qc_terminal_followup_chat_dependency$;

CREATE OR REPLACE FUNCTION norns_guard_conversation_plan_review()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  revision work_plan_versions%ROWTYPE;
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.action_id <> OLD.action_id
     OR NEW.plan_version_id <> OLD.plan_version_id
     OR NEW.planning_run_id <> OLD.planning_run_id
     OR NEW.initiated_by_user_id <> OLD.initiated_by_user_id
     OR NEW.attempt_number <> OLD.attempt_number
     OR NEW.pm_provider <> OLD.pm_provider
     OR NEW.pm_model <> OLD.pm_model
     OR NEW.reviewer_provider <> OLD.reviewer_provider
     OR NEW.reviewer_model <> OLD.reviewer_model
     OR NEW.usage_request_group_id <> OLD.usage_request_group_id
     OR NEW.seed_plan <> OLD.seed_plan
     OR NEW.plan_content_hash <> OLD.plan_content_hash
     OR NEW.context_receipt <> OLD.context_receipt
     OR NEW.context_manifest <> OLD.context_manifest
     OR NEW.context_hash <> OLD.context_hash
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'conversation plan review seed, context, and identity are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('failed', 'converged', 'cap_reached', 'cancelled') THEN
    IF to_jsonb(NEW) - ARRAY['chat_messages','markdown_artifacts','updated_at']::text[]
       <> to_jsonb(OLD) - ARRAY['chat_messages','markdown_artifacts','updated_at']::text[] THEN
      RAISE EXCEPTION 'finished reviews permit follow-up chat and Markdown artifacts only'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'cancelled'))
    OR
    (OLD.status = 'running' AND NEW.status IN (
      'converged', 'cap_reached', 'failed', 'cancelled', 'awaiting_human'
    ))
    OR
    (OLD.status = 'awaiting_human' AND NEW.status IN ('running', 'cancelled', 'failed'))
  ) THEN
    RAISE EXCEPTION 'invalid conversation plan review status transition % -> %',
      OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'cancelled') AND (
    NEW.findings <> OLD.findings
    OR NEW.dispositions <> OLD.dispositions
    OR NEW.result_plan_content_hash <> OLD.result_plan_content_hash
    OR NEW.revised_plan IS DISTINCT FROM OLD.revised_plan
    OR NEW.revised_plan_content_hash IS DISTINCT FROM OLD.revised_plan_content_hash
    OR NEW.revised_plan_version_id IS DISTINCT FROM OLD.revised_plan_version_id
  ) THEN
    RAISE EXCEPTION 'pre-review transitions cannot attach QC result or revision evidence'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IN ('failed', 'cancelled') AND (
    jsonb_array_length(NEW.findings) <> 0
    OR jsonb_array_length(NEW.dispositions) <> 0
    OR NEW.revised_plan IS NOT NULL
    OR NEW.revised_plan_content_hash IS NOT NULL
    OR NEW.revised_plan_version_id IS NOT NULL
    OR NEW.result_plan_content_hash <> NEW.plan_content_hash
  ) THEN
    RAISE EXCEPTION 'unsuccessful reviews cannot attach final QC result or revision evidence'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IN ('converged', 'cap_reached')
     AND NEW.revised_plan_version_id IS NOT NULL THEN
    SELECT * INTO revision
      FROM work_plan_versions
     WHERE id = NEW.revised_plan_version_id;
    IF revision.conversation_id <> NEW.conversation_id
       OR revision.plan <> NEW.revised_plan
       OR revision.content_hash <> NEW.revised_plan_content_hash THEN
      RAISE EXCEPTION 'review revision evidence must equal its immutable successor version'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status <> 'cancelled' AND (
    NEW.cancelled_by_user_id IS NOT NULL OR NEW.cancellation_reason IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cancellation attribution is valid only on cancelled reviews'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = OLD.status AND (
    NEW.findings <> OLD.findings
    OR NEW.dispositions <> OLD.dispositions
    OR NEW.result_plan_content_hash <> OLD.result_plan_content_hash
    OR NEW.revised_plan IS DISTINCT FROM OLD.revised_plan
    OR NEW.revised_plan_content_hash IS DISTINCT FROM OLD.revised_plan_content_hash
    OR NEW.revised_plan_version_id IS DISTINCT FROM OLD.revised_plan_version_id
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
    OR NEW.cancelled_by_user_id IS DISTINCT FROM OLD.cancelled_by_user_id
    OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason
  ) THEN
    RAISE EXCEPTION 'conversation plan review result changes only with lifecycle state'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;
