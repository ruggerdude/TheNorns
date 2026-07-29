-- Human-controlled QC: attributable cancellation plus a durable, round-by-round
-- reviewer/PM exchange transcript.

DO $qc_control_transcript_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0048_conversation_model_switching'
  ) THEN
    RAISE EXCEPTION
      '0049_qc_control_and_transcript requires 0048_conversation_model_switching'
      USING ERRCODE = '55000';
  END IF;
END
$qc_control_transcript_dependency$;

ALTER TABLE conversation_plan_reviews
  ADD COLUMN round_exchanges JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(round_exchanges) = 'array'),
  ADD COLUMN cancelled_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN cancellation_reason TEXT
    CHECK (cancellation_reason IS NULL OR length(trim(cancellation_reason)) > 0);

ALTER TABLE planning_runs
  DROP CONSTRAINT planning_runs_status_check;
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_status_check CHECK (
    status IN (
      'queued','drafting','reviewing','revising',
      'converged','cap_reached','failed','approved','rejected','cancelled'
    )
  );

ALTER TABLE planning_runs
  DROP CONSTRAINT planning_runs_result_shape_check;
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_result_shape_check CHECK (
    (status IN ('converged','cap_reached','approved','rejected')) = (result IS NOT NULL)
  );

ALTER TABLE conversation_plan_reviews
  DROP CONSTRAINT conversation_plan_reviews_status_check;
ALTER TABLE conversation_plan_reviews
  ADD CONSTRAINT conversation_plan_reviews_status_check CHECK (
    status IN ('queued', 'running', 'converged', 'cap_reached', 'failed', 'cancelled')
  );

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

  IF OLD.status IN ('converged', 'cap_reached', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'terminal conversation plan reviews are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'cancelled'))
    OR
    (OLD.status = 'running' AND NEW.status IN (
      'converged', 'cap_reached', 'failed', 'cancelled'
    ))
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
       OR revision.supersedes_plan_version_id <> NEW.plan_version_id
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

CREATE INDEX conversation_plan_reviews_cancelled_by_idx
  ON conversation_plan_reviews(cancelled_by_user_id, completed_at DESC)
  WHERE status = 'cancelled';

-- Human cancellation is a terminal review outcome, but unlike approval it
-- deliberately returns the unchanged immutable plan to candidate status so it
-- can be edited, reviewed again, or rejected.
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
