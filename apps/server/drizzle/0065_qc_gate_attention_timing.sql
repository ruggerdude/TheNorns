-- QCP-2A: attention wiring for paused QC reviews needs conversation_plan_reviews
-- rows to actually be able to reach 'awaiting_human'. The status value and its
-- paused_checkpoint/paused_at_round columns landed in 0064_qc_pause_points, but
-- the row-shape timing check was last rewritten in 0049_qc_control_and_transcript
-- (before awaiting_human existed) and has no branch for it: every attempt to
-- persist a paused review currently violates
-- conversation_plan_reviews_timing_check. This adds exactly that branch,
-- mirroring the non-terminal shape already used for 'running' and the
-- validTiming rule in packages/contracts/src/v2/conversation.ts (started_at
-- set, completed_at null, no failure/cancellation attribution).

DO $qc_gate_attention_timing_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0064_qc_pause_points'
  ) THEN
    RAISE EXCEPTION
      '0065_qc_gate_attention_timing requires 0064_qc_pause_points'
      USING ERRCODE = '55000';
  END IF;
END
$qc_gate_attention_timing_dependency$;

ALTER TABLE conversation_plan_reviews
  DROP CONSTRAINT conversation_plan_reviews_timing_check;
ALTER TABLE conversation_plan_reviews
  ADD CONSTRAINT conversation_plan_reviews_timing_check CHECK (
    (
      status = 'queued'
      AND started_at IS NULL
      AND completed_at IS NULL
      AND failure_code IS NULL
      AND cancelled_by_user_id IS NULL
      AND cancellation_reason IS NULL
    )
    OR (
      status = 'running'
      AND started_at IS NOT NULL
      AND completed_at IS NULL
      AND failure_code IS NULL
      AND cancelled_by_user_id IS NULL
      AND cancellation_reason IS NULL
    )
    OR (
      status = 'awaiting_human'
      AND started_at IS NOT NULL
      AND completed_at IS NULL
      AND failure_code IS NULL
      AND cancelled_by_user_id IS NULL
      AND cancellation_reason IS NULL
    )
    OR (
      status IN ('converged', 'cap_reached')
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND failure_code IS NULL
      AND cancelled_by_user_id IS NULL
      AND cancellation_reason IS NULL
    )
    OR (
      status = 'failed'
      AND completed_at IS NOT NULL
      AND failure_code IS NOT NULL
      AND cancelled_by_user_id IS NULL
      AND cancellation_reason IS NULL
    )
    OR (
      status = 'cancelled'
      AND completed_at IS NOT NULL
      AND failure_code IS NULL
      AND cancelled_by_user_id IS NOT NULL
      AND cancellation_reason IS NOT NULL
    )
  );
