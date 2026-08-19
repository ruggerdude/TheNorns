-- A failed QC review must not dead-end work that already succeeded. When a
-- round produced a PM revision before the run died (server restart, truncated
-- round), failReviewOnly now materializes that plan as a candidate version and
-- points at it from here.
--
-- This is deliberately a separate column rather than a relaxation of
-- conversation_plan_reviews_nonterminal_evidence_check /
-- _revision_shape_check / the immutability trigger: revised_plan* means "the
-- exact successful QC result, approvable as-is", and approve_plan plus the
-- execution-handoff trigger both key off that meaning. A salvage is not that
-- — it is the last good intermediate, offered to the human as a starting
-- point. Keeping the two apart leaves every existing invariant intact.

DO $qc_salvaged_plan_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0084_sonnet_cache_pricing_correction'
  ) THEN
    RAISE EXCEPTION
      '0085_qc_salvaged_plan requires 0084_sonnet_cache_pricing_correction'
      USING ERRCODE = '55000';
  END IF;
END
$qc_salvaged_plan_dependency$;

ALTER TABLE conversation_plan_reviews
  ADD COLUMN salvaged_plan_version_id TEXT,
  ADD CONSTRAINT conversation_plan_reviews_salvage_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id, salvaged_plan_version_id)
    REFERENCES work_plan_versions(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT conversation_plan_reviews_salvage_shape_check CHECK (
    salvaged_plan_version_id IS NULL
    OR (status = 'failed' AND salvaged_plan_version_id <> plan_version_id)
  );
