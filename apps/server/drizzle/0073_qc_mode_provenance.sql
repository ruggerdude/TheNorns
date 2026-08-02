-- QCP-9: a mid-run qc_mode change flips qc_mode_source to 'in_run' but the
-- column carries no actor and no round, so ConversationQcCard could only
-- guess "changed mid-review at round N" from paused_at_round/rounds_completed
-- and could not say who at all. Add provenance, coupled to the 'in_run'
-- source exactly like paused_checkpoint/paused_at_round are coupled to
-- 'awaiting_human' (0064's conversation_plan_reviews_paused_coupling_check).

DO $qc_mode_provenance_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0072_qc_last_human_message'
  ) THEN
    RAISE EXCEPTION
      '0073_qc_mode_provenance requires 0072_qc_last_human_message'
      USING ERRCODE = '55000';
  END IF;
END
$qc_mode_provenance_dependency$;

ALTER TABLE conversation_plan_reviews
  ADD COLUMN qc_mode_changed_at_round INTEGER
    CHECK (qc_mode_changed_at_round IS NULL OR qc_mode_changed_at_round > 0),
  ADD COLUMN qc_mode_changed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;

-- Same-table columns, so (unlike paused_at_round <= max_rounds, which needs
-- planning_runs) this coupling CAN be expressed as a CHECK, not just in the
-- contract.
ALTER TABLE conversation_plan_reviews
  ADD CONSTRAINT conversation_plan_reviews_qc_mode_provenance_check CHECK (
    (qc_mode_changed_at_round IS NOT NULL) = (qc_mode_source = 'in_run')
    AND (qc_mode_changed_by_user_id IS NOT NULL) = (qc_mode_source = 'in_run')
  );
