-- Durable operational checkpoints for review-only QC. These are deliberately
-- separate from the human pause columns: paused_checkpoint is coupled to
-- awaiting_human, while an interrupted worker leaves the review running and
-- resumes it automatically after a new lease is claimed.

DO $qc_restart_checkpoints_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0075_planning_live_progress'
  ) THEN
    RAISE EXCEPTION
      '0076_qc_restart_checkpoints requires 0075_planning_live_progress'
      USING ERRCODE = '55000';
  END IF;
END
$qc_restart_checkpoints_dependency$;

ALTER TABLE planning_runs
  ADD COLUMN execution_attempt INTEGER NOT NULL DEFAULT 0
    CHECK (execution_attempt >= 0);

ALTER TABLE conversation_plan_reviews
  ADD COLUMN execution_checkpoint JSONB,
  ADD CONSTRAINT conversation_plan_reviews_execution_checkpoint_check CHECK (
    execution_checkpoint IS NULL
    OR (
      jsonb_typeof(execution_checkpoint) = 'object'
      AND execution_checkpoint->>'schema_version' = '1'
      AND execution_checkpoint->>'completed_step' IN ('review', 'revision')
      AND (execution_checkpoint->>'round') ~ '^[1-5]$'
      AND jsonb_typeof(execution_checkpoint->'reviewed_plan') = 'object'
      AND jsonb_typeof(execution_checkpoint->'current_plan') = 'object'
      AND (execution_checkpoint->>'reviewed_plan_hash') ~ '^[a-f0-9]{64}$'
      AND (execution_checkpoint->>'current_plan_hash') ~ '^[a-f0-9]{64}$'
      AND length(trim(execution_checkpoint->>'completed_request_id')) > 0
      AND jsonb_typeof(execution_checkpoint->'usage_events') = 'array'
      AND length(trim(execution_checkpoint->>'checkpointed_at')) > 0
    )
  ),
  ADD CONSTRAINT conversation_plan_reviews_execution_checkpoint_lifecycle_check CHECK (
    execution_checkpoint IS NULL OR status = 'running'
  );
