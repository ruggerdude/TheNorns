-- FRONT DOOR P3 (D1 strategy bridge): links a materialized phase back to the
-- planning run it was drafted from. The bridge (apps/server/src/projects/
-- strategyBridgeService.ts) consumes a converged/cap_reached planning_runs row
-- and creates a phase + a proposed StrategyVersion through the existing phase-3
-- workflow services. This column makes that bridge idempotent per planning run
-- (one run -> at most one phase) and lets the plan-review DTO recover the run's
-- rounds outcome from a phase id.
--
-- Additive only: a nullable column plus a partial unique index. Phases created
-- through the pre-existing raw create route keep planning_run_id NULL and are
-- unaffected. phases already carries norns_app table privileges from
-- 0001_refoundation_v2, which extend to the new column, so no new GRANT is
-- required.
ALTER TABLE phases
  ADD COLUMN IF NOT EXISTS planning_run_id TEXT
    REFERENCES planning_runs (id) ON DELETE SET NULL;

-- At most one phase may bind a given planning run within a project. This is the
-- database-level idempotency guarantee behind "same run submitted twice = same
-- phase": a concurrent second bridge attempt for the same run fails this index
-- and the caller resolves back to the already-bound phase.
CREATE UNIQUE INDEX IF NOT EXISTS phases_project_planning_run_unique
  ON phases (project_id, planning_run_id)
  WHERE planning_run_id IS NOT NULL;
