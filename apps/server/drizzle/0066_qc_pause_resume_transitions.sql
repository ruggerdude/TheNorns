-- QCP-1B: durability core for human pause gates (see QC-PAUSE-POINTS.md).
-- 0064/0065 made 'awaiting_human' a legal *value* (status CHECK, paused
-- coupling CHECK, timing CHECK), but three older guards were never taught
-- about it and would reject every real park/resume/cancel-while-parked
-- UPDATE at the database, after the round's model spend already happened:
--
-- 1. norns_guard_conversation_plan_review()'s transition matrix (last
--    rewritten in 0062, before awaiting_human existed) only allows
--    queued->{running,failed,cancelled} and running->{converged,cap_reached,
--    failed,cancelled}. Missing: running->awaiting_human (park),
--    awaiting_human->running (resume), awaiting_human->cancelled (cancel
--    while parked).
-- 2. conversation_plan_reviews_nonterminal_evidence_check (from 0037, never
--    touched since) forbids ANY non-empty findings/dispositions/revised_plan*
--    outside status IN ('converged','cap_reached'). A parked review must
--    expose exactly this evidence (that is the point of pausing), so
--    'awaiting_human' needs the same exemption.
-- 3. conversation_plan_reviews_one_active_per_version's partial unique index
--    only covers status IN ('queued','running'), so a second QC attempt could
--    be started against a plan version whose current review is merely
--    parked, not settled.
--
-- Also: planning_runs has no status for "parked, lease released" — reusing
-- an in-flight value (e.g. 'reviewing') would make reconcileOrphans() reap a
-- parked run as an orphan. Adding a dedicated value keeps the existing
-- orphan-sweep filter (status IN ('drafting','reviewing','revising')) correct
-- with no query change.

DO $qc_pause_resume_transitions_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0065_qc_gate_attention_timing'
  ) THEN
    RAISE EXCEPTION
      '0066_qc_pause_resume_transitions requires 0065_qc_gate_attention_timing'
      USING ERRCODE = '55000';
  END IF;
END
$qc_pause_resume_transitions_dependency$;

ALTER TABLE planning_runs
  DROP CONSTRAINT planning_runs_status_check;
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_status_check CHECK (
    status IN (
      'queued','drafting','reviewing','revising','awaiting_human',
      'converged','cap_reached','failed','approved','rejected','cancelled'
    )
  );

ALTER TABLE conversation_plan_reviews
  ADD COLUMN resume_idempotency_key TEXT
    CHECK (resume_idempotency_key IS NULL OR length(trim(resume_idempotency_key)) > 0);

ALTER TABLE conversation_plan_reviews
  DROP CONSTRAINT conversation_plan_reviews_nonterminal_evidence_check;
ALTER TABLE conversation_plan_reviews
  ADD CONSTRAINT conversation_plan_reviews_nonterminal_evidence_check
    CHECK (
      status IN ('converged', 'cap_reached', 'awaiting_human')
      OR (
        jsonb_array_length(findings) = 0
        AND jsonb_array_length(dispositions) = 0
        AND revised_plan IS NULL
        AND revised_plan_content_hash IS NULL
        AND revised_plan_version_id IS NULL
        AND result_plan_content_hash = plan_content_hash
      )
    );

DROP INDEX conversation_plan_reviews_one_active_per_version;
CREATE UNIQUE INDEX conversation_plan_reviews_one_active_per_version
  ON conversation_plan_reviews(plan_version_id)
  WHERE status IN ('queued', 'running', 'awaiting_human');

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

  IF OLD.status = 'failed' THEN
    IF to_jsonb(NEW) - ARRAY['chat_messages','markdown_artifacts','updated_at']::text[]
       <> to_jsonb(OLD) - ARRAY['chat_messages','markdown_artifacts','updated_at']::text[] THEN
      RAISE EXCEPTION 'failed reviews permit recovery chat and Markdown artifacts only'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('converged', 'cap_reached', 'cancelled') THEN
    RAISE EXCEPTION 'terminal conversation plan reviews are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'cancelled'))
    OR
    (OLD.status = 'running' AND NEW.status IN (
      'converged', 'cap_reached', 'failed', 'cancelled', 'awaiting_human'
    ))
    OR
    -- QCP-1B: a gate parks the review (running->awaiting_human above); resume
    -- re-enters running directly (loadReviewOnlySeed reads the paused fields
    -- before markReviewOnlyStarted nulls them in this same transition);
    -- cancel while parked is one of the four gate exits; failed covers a
    -- resumed run that cannot even get through re-claim (adapter/model
    -- resolution failure before markReviewOnlyStarted runs).
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
    -- QCP-1B: a review that paused before converging already materialized
    -- one or more "qc_interim" versions, and the terminal "qc_result" version
    -- chains from the latest of those (not always the seed) so version
    -- numbers stay unique per work item. The supersedes-the-seed-directly
    -- requirement this used to carry is dropped; the exact-plan and
    -- exact-hash match below already guarantees the claimed revision is a
    -- real, immutable, in-scope version.
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
