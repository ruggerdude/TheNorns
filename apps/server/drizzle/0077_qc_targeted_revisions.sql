-- Pin the PM revision response format for the full lifetime of each review.
-- The default preserves the existing full-envelope workflow until rollout is
-- explicitly enabled for reviews created after deployment.

DO $qc_targeted_revisions_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0076_qc_restart_checkpoints'
  ) THEN
    RAISE EXCEPTION
      '0077_qc_targeted_revisions requires 0076_qc_restart_checkpoints'
      USING ERRCODE = '55000';
  END IF;
END
$qc_targeted_revisions_dependency$;

ALTER TABLE conversation_plan_reviews
  ADD COLUMN revision_format TEXT NOT NULL DEFAULT 'legacy_full'
    CHECK (revision_format IN (
      'legacy_full',
      'targeted_v1',
      'targeted_v1_with_fallback'
    ));
