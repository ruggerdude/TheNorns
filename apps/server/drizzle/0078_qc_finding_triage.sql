-- Human triage is the explicit handoff between the independent reviewer and
-- the planning manager. Every reviewer finding is accepted or rejected before
-- the PM is allowed to revise the plan. Decisions accumulate across rounds so
-- the audit remains intact even while live findings are cleared on resume.

DO $qc_finding_triage_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0077_qc_targeted_revisions'
  ) THEN
    RAISE EXCEPTION
      '0078_qc_finding_triage requires 0077_qc_targeted_revisions'
      USING ERRCODE = '55000';
  END IF;
END
$qc_finding_triage_dependency$;

ALTER TABLE conversation_plan_reviews
  ADD COLUMN finding_decisions JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(finding_decisions) = 'array');
