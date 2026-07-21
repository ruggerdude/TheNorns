-- EXECUTION E10: where a run's work actually went.
--
-- THE NUMBER IS DELIBERATELY UNASSIGNED. 0020 is the highest number merged when
-- E10 was written; the PM assigns the real number and renames this file (and
-- RUN_PUBLICATION_MIGRATION_NAME in persistence/v2/migrate.ts) at integration.
--
-- WHY. EXECUTION E4 made the runner push the run's branch and open its pull
-- request, and then reported both as `run_log` TEXT. A log line is not a field:
-- nothing in the read models could link a finished task to the review a human
-- is supposed to click through to, so the branch and the PR existed but were
-- unreachable from the product. These columns are that missing link.
--
-- Strictly additive and nullable. Every existing row keeps meaning exactly what
-- it meant -- NULL here reads as "this run has not reported a publication",
-- which is the truth for every run that predates E10, not a fabricated absence.
ALTER TABLE agent_runs ADD COLUMN published_branch TEXT;
ALTER TABLE agent_runs ADD COLUMN published_commit_sha TEXT;
ALTER TABLE agent_runs ADD COLUMN published_remote TEXT;
ALTER TABLE agent_runs ADD COLUMN pull_request_url TEXT;
-- Why there is NO pull request, when a run published without one. "no PR" and
-- "the PR could not be opened" are very different facts to a human waiting on a
-- review, and E4's publisher already distinguishes them; this is where that
-- distinction survives the wire.
ALTER TABLE agent_runs ADD COLUMN publication_note TEXT;
ALTER TABLE agent_runs ADD COLUMN publication_outcome TEXT;
ALTER TABLE agent_runs ADD COLUMN published_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS agent_runs_pull_request_idx
  ON agent_runs (project_id, pull_request_url)
  WHERE pull_request_url IS NOT NULL;

-- agent_runs predates this migration, so it already carries its grants; the
-- repo convention is that every migration touching a table states them, and
-- re-granting is idempotent. Production runs under a restricted role and pglite
-- does not model that, so a missing grant is invisible in CI.
GRANT SELECT, INSERT, UPDATE ON agent_runs TO norns_app;
