-- PHASE TAB P1: human decision workflow on durable planning runs.
--
-- Adds to planning_runs:
--   worker_providers  which implementation providers the allocation
--                     recommendation may staff ('anthropic' | 'openai' | 'both')
--   decision          the latest human decision record
--                     ({ decision, direction, staffing, decided_at })
--   revision_seed     set by a "modify" decision: { plan, direction }. The
--                     worker consumes it on the next claim and revises the
--                     prior plan under the human's direction instead of
--                     drafting from scratch.
--
-- The status CHECK gains 'approved' and 'rejected' (terminal decision
-- states); converged/cap_reached continue to serve as the awaiting-decision
-- states. The result-shape CHECK is widened accordingly: an approved or
-- rejected run keeps the result it was decided on. Constraint replacement
-- (DROP + ADD of the same-named CHECK) is additive in effect — no data is
-- modified or destroyed, and the new constraints accept every row the old
-- ones did.
--
-- No new table, so no new GRANT is required: planning_runs already carries
-- GRANT SELECT, INSERT, UPDATE TO norns_app from 0012_planning_runs.sql, and
-- these columns ride on the existing table grant.

ALTER TABLE planning_runs
  ADD COLUMN worker_providers TEXT NOT NULL DEFAULT 'both';
ALTER TABLE planning_runs
  ADD COLUMN decision JSONB;
ALTER TABLE planning_runs
  ADD COLUMN revision_seed JSONB;

ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_worker_providers_check CHECK (
    worker_providers IN ('anthropic', 'openai', 'both')
  );

ALTER TABLE planning_runs
  DROP CONSTRAINT planning_runs_status_check;
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_status_check CHECK (
    status IN (
      'queued','drafting','reviewing','revising',
      'converged','cap_reached','failed','approved','rejected'
    )
  );

ALTER TABLE planning_runs
  DROP CONSTRAINT planning_runs_result_shape_check;
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_result_shape_check CHECK (
    (status IN ('converged','cap_reached','approved','rejected')) = (result IS NOT NULL)
  );
