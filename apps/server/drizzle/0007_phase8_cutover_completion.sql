-- Production rollout corrections for the Phase 7 cutover model.
--
-- Internal and selected cohorts identify one concrete project. The remaining
-- cohort is deliberately project-less because it promotes every active
-- project not already authoritative.

ALTER TABLE v2_cutover_cohorts
  DROP CONSTRAINT v2_cutover_project_shape_check;

ALTER TABLE v2_cutover_cohorts
  ADD CONSTRAINT v2_cutover_project_shape_check CHECK (
    (cohort_type IN ('internal','selected') AND project_id IS NOT NULL)
    OR (cohort_type IN ('new_projects','remaining') AND project_id IS NULL)
  );

