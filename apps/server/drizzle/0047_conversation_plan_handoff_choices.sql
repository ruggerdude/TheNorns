-- Bind explicit QC choices to the immutable conversational plan handoff.
-- A waived review is an attributable human choice and never represents a
-- model invocation; the existing reviewer identity columns remain populated
-- only to preserve the established cross-provider scope constraints.

DO $conversation_plan_handoff_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0046_github_authorization_removal'
  ) THEN
    RAISE EXCEPTION
      '0047_conversation_plan_handoff_choices requires 0046_github_authorization_removal'
      USING ERRCODE = '55000';
  END IF;
END
$conversation_plan_handoff_dependency$;

ALTER TABLE conversation_plan_reviews
  ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'qc'
  CHECK (review_mode IN ('qc', 'waived'));

CREATE INDEX conversation_plan_reviews_mode_time_idx
  ON conversation_plan_reviews(review_mode, created_at, id);

-- Approval normally requires the exact revised plan produced by QC. An
-- explicitly waived review instead binds the original immutable candidate and
-- its exact content hash.
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
    ) OR (
      SELECT review.status
        FROM conversation_plan_reviews review
       WHERE review.plan_version_id = OLD.id
       ORDER BY review.attempt_number DESC
       LIMIT 1
    ) IS DISTINCT FROM 'failed' THEN
      RAISE EXCEPTION
        'in-QC plans return to candidate only after the latest linked review failed'
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
