-- QCP-3A: adjudication ruling support for Gate C (see QC-PAUSE-POINTS.md,
-- "Adjudication: unresolved must-fix rebuttals" and "Mutability mid-flight").
--
-- Rulings accumulate in their own column, independent of findings/
-- dispositions. That matters because both of those get reset to empty by
-- markReviewOnlyStarted on every resume (status leaving 'awaiting_human'
-- carries no evidence, same as a fresh run) and rebuilt wholesale by
-- flattenReviewEvidence at the next pause/terminal. A ruling recorded while
-- parked would otherwise be wiped before it could be re-attached to the
-- rebuilt disposition record. forced_accept_module_ids is the durable
-- enforcement of "rule for reviewer cannot be rebutted again": it persists
-- for the life of the review, across every future round and resume.
--
-- Neither new column needs a trigger change: norns_guard_conversation_plan_
-- review()'s same-status branch (0066) only restricts a fixed list of
-- evidence/timing columns, and its 'failed'-status branch only permits
-- chat_messages/markdown_artifacts/updated_at to change — this migration
-- adds no column to either restricted set, so plain UPDATEs against them
-- while status stays 'awaiting_human' pass through untouched.

DO $qc_adjudication_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0066_qc_pause_resume_transitions'
  ) THEN
    RAISE EXCEPTION
      '0067_qc_adjudication requires 0066_qc_pause_resume_transitions'
      USING ERRCODE = '55000';
  END IF;
END
$qc_adjudication_dependency$;

ALTER TABLE conversation_plan_reviews
  ADD COLUMN adjudications JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(adjudications) = 'array'),
  ADD COLUMN forced_accept_module_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(forced_accept_module_ids) = 'array'),
  ADD COLUMN adjudication_idempotency_key TEXT
    CHECK (adjudication_idempotency_key IS NULL OR length(trim(adjudication_idempotency_key)) > 0);
