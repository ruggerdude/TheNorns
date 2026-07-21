-- FRONT DOOR P5 (tracking): per-project poll cadence for the tracking
-- dashboard. Percent-complete, ETA, and burn rate are computed on demand in
-- ProjectResumeService from existing tasks/agent_runs rows (no new columns
-- needed for those) -- this migration only persists the one thing that is
-- genuinely durable project state: how often the client should poll the
-- resume endpoint.
--
-- Additive only: a NOT NULL column with a default, so existing rows and
-- callers are unaffected. projects already carries norns_app table
-- privileges from 0001_refoundation_v2, which extend to the new column, so
-- no new GRANT is required (same reasoning as 0013).
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS update_interval_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (update_interval_seconds IN (60, 300, 900));
