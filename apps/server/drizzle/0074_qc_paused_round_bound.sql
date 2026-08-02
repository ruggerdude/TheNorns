-- QCP-15: enforce paused_at_round <= max_rounds in the database, not just the
-- contract. max_rounds lives on planning_runs, not conversation_plan_reviews
-- (the review reads it via a subquery — see planWorkflow.ts's reviewColumns),
-- so a CHECK constraint can't express this: Postgres CHECKs cannot reference
-- another table. A trigger can. It only looks at paused_at_round and the
-- *current* max_rounds of the linked run at write time, so raising the cap
-- (patchReview, adjudicate's raise-by-one) never makes this trigger fire —
-- neither writes conversation_plan_reviews, only planning_runs.max_rounds.
--
-- Kept separate from conversation_plan_reviews_lifecycle_guard (0049/0066/
-- 0070's norns_guard_conversation_plan_review) so this concern and that one
-- can each change without risking silently dropping the other.

DO $qc_paused_round_bound_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0073_qc_mode_provenance'
  ) THEN
    RAISE EXCEPTION
      '0074_qc_paused_round_bound requires 0073_qc_mode_provenance'
      USING ERRCODE = '55000';
  END IF;
END
$qc_paused_round_bound_dependency$;

CREATE OR REPLACE FUNCTION norns_guard_conversation_plan_review_paused_round_bound()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  run_max_rounds INTEGER;
BEGIN
  IF NEW.paused_at_round IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT max_rounds INTO run_max_rounds
    FROM planning_runs
   WHERE id = NEW.planning_run_id;

  IF run_max_rounds IS NOT NULL AND NEW.paused_at_round > run_max_rounds THEN
    RAISE EXCEPTION
      'paused_at_round (%) cannot exceed the planning run''s max_rounds (%)',
      NEW.paused_at_round, run_max_rounds
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$guard$;

CREATE CONSTRAINT TRIGGER conversation_plan_reviews_paused_round_bound_guard
  AFTER INSERT OR UPDATE ON conversation_plan_reviews
  FOR EACH ROW
  EXECUTE FUNCTION norns_guard_conversation_plan_review_paused_round_bound();
