-- QCP-14: "zero rounds = review off" never actually worked. The default_max_rounds
-- CHECK forbade 0 at the DB layer (planning_reviewer_settings_default_max_rounds_check
-- was BETWEEN 1 AND 5), so even after the API and wizard are fixed to pass 0
-- through, a write would still fail here. Widen the floor to 0: 0 means review
-- is off, 1-5 remain the existing round cap range.

DO $qc_zero_rounds_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0070_qc_skip_qc_accepts_in_qc'
  ) THEN
    RAISE EXCEPTION
      '0071_qc_zero_rounds requires 0070_qc_skip_qc_accepts_in_qc'
      USING ERRCODE = '55000';
  END IF;
END
$qc_zero_rounds_dependency$;

ALTER TABLE planning_reviewer_settings
  DROP CONSTRAINT planning_reviewer_settings_default_max_rounds_check;

ALTER TABLE planning_reviewer_settings
  ADD CONSTRAINT planning_reviewer_settings_default_max_rounds_check CHECK (
    default_max_rounds BETWEEN 0 AND 5
  );
