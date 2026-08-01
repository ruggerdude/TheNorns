-- QCP-6: "Accept now" at Gate A ("after_review") targets
-- review.revised_plan_version_id ?? review.plan_version_id. At Gate A the PM
-- has never revised, so the target falls back to the seed plan version,
-- whose work_plan_versions.status is still 'in_qc' (pauseReviewOnly does not
-- revert it — only completeReviewOnly/cancelReview/failReviewOnly do). The
-- norns_guard_work_plan_version_update() trigger (0049, never redefined
-- since) only permits an in_qc -> candidate transition when the latest
-- linked review is 'failed' or 'cancelled', so the code-side revert this
-- fix adds to continueWithoutQc() would otherwise be rejected by the
-- database. Widen the exception to also cover a review parked at Gate A:
-- status 'awaiting_human' AND paused_checkpoint 'after_review'. Scoped to
-- that checkpoint specifically (not bare 'awaiting_human') because Gate B
-- ("after_revision") always has a revision on hand and the seed-fallback
-- never fires there — permitting a revert at that checkpoint would allow a
-- plan version to be reverted out from under a revision that genuinely
-- exists.

DO $qc_gate_a_accept_now_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0067_qc_adjudication'
  ) THEN
    RAISE EXCEPTION
      '0068_qc_gate_a_accept_now requires 0067_qc_adjudication'
      USING ERRCODE = '55000';
  END IF;
END
$qc_gate_a_accept_now_dependency$;

CREATE OR REPLACE FUNCTION norns_guard_work_plan_version_update()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  latest_review RECORD;
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
    SELECT review.status, review.paused_checkpoint
      INTO latest_review
      FROM conversation_plan_reviews review
     WHERE review.plan_version_id = OLD.id
     ORDER BY review.attempt_number DESC
     LIMIT 1;

    IF EXISTS (
      SELECT 1
        FROM conversation_plan_reviews review
       WHERE review.plan_version_id = OLD.id
         AND review.status IN ('queued', 'running')
    ) OR NOT (
      coalesce(latest_review.status, '') IN ('failed', 'cancelled')
      OR (
        latest_review.status = 'awaiting_human'
        AND latest_review.paused_checkpoint = 'after_review'
      )
    ) THEN
      RAISE EXCEPTION
        'in-QC plans return to candidate only after the latest linked review failed, was cancelled, or is parked at Gate A awaiting a human decision'
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
