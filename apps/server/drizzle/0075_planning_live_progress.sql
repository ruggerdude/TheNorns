-- Durable live-stage snapshots for long-running plan compilation and QC.
-- Provider-call history and latency remain canonical in ai_usage_events;
-- these compact objects are only the currently visible operation checkpoint.

DO $planning_live_progress_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0074_qc_paused_round_bound'
  ) THEN
    RAISE EXCEPTION
      '0075_planning_live_progress requires 0074_qc_paused_round_bound'
      USING ERRCODE = '55000';
  END IF;
END
$planning_live_progress_dependency$;

ALTER TABLE planning_runs
  ADD COLUMN live_progress JSONB,
  ADD CONSTRAINT planning_runs_live_progress_check CHECK (
    live_progress IS NULL
    OR (
      jsonb_typeof(live_progress) = 'object'
      AND live_progress->>'stage' IN (
        'preparing','generating','reviewing','revising','repairing','validating','saving'
      )
    )
  ),
  ADD CONSTRAINT planning_runs_live_progress_lifecycle_check CHECK (
    live_progress IS NULL
    OR status IN ('drafting','reviewing','revising')
  );

ALTER TABLE conversation_plan_proposal_attempts
  ADD COLUMN live_progress JSONB,
  ADD CONSTRAINT conversation_plan_proposals_live_progress_check CHECK (
    live_progress IS NULL
    OR (
      jsonb_typeof(live_progress) = 'object'
      AND live_progress->>'stage' IN (
        'preparing','generating','reviewing','revising','repairing','validating','saving'
      )
    )
  );

-- Proposal attempts previously allowed only pending -> terminal updates. Live
-- progress needs tightly-scoped pending -> pending checkpoints without opening
-- any request identity or result fields to mutation.
CREATE OR REPLACE FUNCTION norns_guard_conversation_plan_proposal_attempt()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.initiated_by_user_id <> OLD.initiated_by_user_id
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_fingerprint <> OLD.request_fingerprint
     OR NEW.source_message_id <> OLD.source_message_id
     OR NEW.provider <> OLD.provider
     OR NEW.model <> OLD.model
     OR NEW.usage_request_id <> OLD.usage_request_id
     OR NEW.retry_attempt <> OLD.retry_attempt
     OR NEW.context_manifest <> OLD.context_manifest
     OR NEW.context_hash <> OLD.context_hash
     OR NEW.started_at <> OLD.started_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'conversation plan proposal request identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'pending' THEN
    IF to_jsonb(NEW) - ARRAY['live_progress','updated_at']::text[]
       <> to_jsonb(OLD) - ARRAY['live_progress','updated_at']::text[] THEN
      RAISE EXCEPTION 'pending plan proposals permit live progress updates only'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'pending' OR NEW.status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'invalid conversation plan proposal lifecycle transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

UPDATE conversation_plan_proposal_attempts
   SET live_progress = jsonb_build_object(
         'stage', 'generating',
         'round', NULL,
         'attempt', 1,
         'provider', provider,
         'model', model,
         'started_at', started_at,
         'checkpoint_at', now()
       )
 WHERE status = 'pending';

ALTER TABLE conversation_plan_proposal_attempts
  ADD CONSTRAINT conversation_plan_proposals_live_progress_lifecycle_check CHECK (
    status = 'pending' OR live_progress IS NULL
  );
