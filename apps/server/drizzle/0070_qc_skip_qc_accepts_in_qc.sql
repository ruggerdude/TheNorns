-- QCP-R9: root-cause fix for Gate A "accept now". The real bug was that
-- send_plan_to_qc's boundLatestPlan() call hardcoded a 'candidate'
-- expectation even for the skip_qc (waiver) confirm path, which is
-- legitimately accepting a plan version that is still 'in_qc' because a
-- review is parked on it awaiting a human decision. That forced a
-- revert-to-candidate-then-reforward round trip, which is what required
-- 0068's trigger exception and continueWithoutQc's revert branch in the
-- first place. Both are now dead: the application code accepts the in_qc
-- version directly and never asks the trigger to permit that revert.
--
-- Restore norns_guard_work_plan_version_update() to 0049's narrower
-- exception set (in_qc -> candidate permitted only when the latest linked
-- review is 'failed' or 'cancelled'). Gate-topology knowledge
-- (paused_checkpoint = 'after_review') does not belong in a database
-- trigger; it belongs at the call site that already knows which confirm
-- path it is serving.

DO $qc_skip_qc_accepts_in_qc_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0069_qc_attention_index'
  ) THEN
    RAISE EXCEPTION
      '0070_qc_skip_qc_accepts_in_qc requires 0069_qc_attention_index'
      USING ERRCODE = '55000';
  END IF;
END
$qc_skip_qc_accepts_in_qc_dependency$;

CREATE OR REPLACE FUNCTION norns_guard_work_plan_version_update()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.version <> OLD.version
     OR NEW.plan <> OLD.plan
     OR NEW.content_hash <> OLD.content_hash
     OR NEW.supersedes_plan_version_id IS DISTINCT FROM OLD.supersedes_plan_version_id
     OR NEW.diff_from_previous IS DISTINCT FROM OLD.diff_from_previous
     OR NEW.created_by_action_id IS DISTINCT FROM OLD.created_by_action_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'plan version content, hash, lineage, and identity are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'in_qc' AND NEW.status = 'candidate' THEN
    IF EXISTS (
      SELECT 1
        FROM conversation_plan_reviews review
       WHERE review.plan_version_id = OLD.id
         AND review.status IN ('queued', 'running')
    ) OR coalesce((
      SELECT review.status
        FROM conversation_plan_reviews review
       WHERE review.plan_version_id = OLD.id
       ORDER BY review.attempt_number DESC
       LIMIT 1
    ), '') NOT IN ('failed', 'cancelled') THEN
      RAISE EXCEPTION
        'in-QC plans return to candidate only after the latest linked review failed or was cancelled'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'candidate' AND NEW.status = 'approved' AND NOT EXISTS (
    SELECT 1
      FROM conversation_plan_reviews review
     WHERE (
             review.revised_plan_version_id = OLD.id
             OR (
               review.review_mode = 'waived'
               AND review.plan_version_id = OLD.id
             )
           )
       AND review.result_plan_content_hash = OLD.content_hash
       AND review.status IN ('converged', 'cap_reached')
  ) THEN
    RAISE EXCEPTION
      'candidate approval requires exact successful QC or an attributable QC waiver'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (
      OLD.status = 'candidate'
      AND NEW.status IN (
        'in_qc', 'changes_requested', 'approved', 'rejected', 'superseded'
      )
    )
    OR (
      OLD.status = 'in_qc'
      AND NEW.status IN ('candidate', 'changes_requested', 'approved', 'rejected')
    )
    OR (OLD.status = 'changes_requested' AND NEW.status IN ('rejected', 'superseded'))
    OR (OLD.status = 'rejected' AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION 'invalid plan version status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'approved'
     AND (
       NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     ) THEN
    RAISE EXCEPTION 'approved plan attribution is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;
